import { createServer } from 'http';
import { readFile, writeFile, readdir, stat, rename } from 'fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, extname, resolve as resolvePath, sep } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, createHmac, timingSafeEqual } from 'crypto';
import yaml from 'js-yaml';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const PUBLIC_DIR = resolvePath(join(__dirname, 'public'));
const REPORTS_DIR = resolvePath(join(ROOT, 'reports'));
const PORT = 3000;
const HOST = '0.0.0.0'; // bind to all interfaces so LAN devices can connect
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

// --- Auth setup ---
// Password: read from env var, or web/.password file, or generate on first run.
// Session secret: web/.session-secret, auto-generated if missing.
function loadOrInit(file, generate, onCreate) {
  const p = join(__dirname, file);
  if (existsSync(p)) return readFileSync(p, 'utf-8').trim();
  const v = generate();
  writeFileSync(p, v, { mode: 0o600 });
  if (onCreate) onCreate(v);
  return v;
}

const SESSION_SECRET = loadOrInit('.session-secret', () => randomBytes(32).toString('hex'));

const PASSWORD = process.env.CAREER_OPS_PASSWORD || loadOrInit('.password', () => {
  const words = ['amber', 'harbor', 'cedar', 'meadow', 'river', 'willow', 'cobalt', 'saffron'];
  return words[Math.floor(Math.random() * words.length)] + '-' + randomBytes(2).toString('hex');
}, (pwd) => {
  console.log(`\n  🔐  First-run password: ${pwd}`);
  console.log(`      Saved to web/.password — change by editing that file\n`);
});

function signSession(exp) {
  return createHmac('sha256', SESSION_SECRET).update(`s.${exp}`).digest('hex');
}

function issueCookie() {
  const exp = Date.now() + SESSION_TTL_MS;
  const sig = signSession(exp);
  return `sess=${exp}.${sig}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
}

function verifyCookie(header) {
  if (!header) return false;
  const match = header.match(/(?:^|;\s*)sess=(\d+)\.([a-f0-9]+)/);
  if (!match) return false;
  const exp = parseInt(match[1], 10);
  const sig = match[2];
  if (!Number.isFinite(exp) || exp < Date.now()) return false;
  const expected = signSession(exp);
  if (sig.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
}

// LAN = RFC1918 ranges + loopback. Everything else is treated as untrusted
// (public internet, VPN-hopped, etc.) and must authenticate.
function isLan(ip) {
  if (!ip) return false;
  const clean = String(ip).replace(/^::ffff:/, '');
  if (clean === '127.0.0.1' || clean === '::1' || clean === 'localhost') return true;
  if (/^10\./.test(clean)) return true;
  if (/^192\.168\./.test(clean)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(clean)) return true;
  // IPv6 unique local (fc00::/7) and link-local (fe80::/10)
  if (/^(fc|fd|fe8|fe9|fea|feb)/i.test(clean)) return true;
  return false;
}

// Simple in-process file lock. Note: this coordinates only within this server
// process — CLI scripts writing the same files concurrently could still race.
// Mitigation: atomicWrite() + brief windows; CLI authors know when they're
// running batch ops and shouldn't run them while the web UI is in active use.
const locks = new Map();
async function withLock(file, fn) {
  while (locks.has(file)) await locks.get(file);
  let resolve;
  locks.set(file, new Promise(r => { resolve = r; }));
  try { return await fn(); }
  finally { locks.delete(file); resolve(); }
}

// Atomic write: tmp file then rename. Prevents partial writes during a crash
// or concurrent read.
async function atomicWrite(target, content) {
  const tmp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, target);
}

// Liveness cache — maps URL → { verified_at, live, status, reason, ... }.
// Written by /api/pipeline/verify (this process) AND by web/auto-verify.mjs
// (separate launchd-triggered process). To stay in sync with an external
// writer, reload from disk whenever the file mtime changes.
const LIVENESS_FILE = join(__dirname, '.liveness.json');
let livenessCache = null;
let livenessMtime = 0;

async function loadLiveness() {
  try {
    const s = await stat(LIVENESS_FILE);
    const mtimeMs = s.mtimeMs || s.mtime?.getTime() || 0;
    // Cache hit: file hasn't changed since last load
    if (livenessCache && mtimeMs === livenessMtime) return livenessCache;
    livenessCache = JSON.parse(await readFile(LIVENESS_FILE, 'utf-8'));
    livenessMtime = mtimeMs;
  } catch {
    if (!livenessCache) livenessCache = {};
  }
  return livenessCache;
}
async function saveLiveness() {
  if (!livenessCache) return;
  return withLock('liveness', async () => {
    await atomicWrite(LIVENESS_FILE, JSON.stringify(livenessCache, null, 0));
    // Refresh our mtime tracker so we don't spuriously re-read our own write
    try {
      const s = await stat(LIVENESS_FILE);
      livenessMtime = s.mtimeMs || s.mtime?.getTime() || 0;
    } catch {}
  });
}

// --- Parsers ---

function splitRow(line) {
  // Markdown table row starts and ends with `|`. Strip leading/trailing pipe,
  // then split on unescaped `|` only (so `\|` inside a cell survives). Preserves
  // empty cells. Finally, unescape the pipe in each cell.
  const trimmed = line.trim();
  const inner = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  // Negative lookbehind: split only on `|` not preceded by `\`.
  return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

function parseApplicationsTable(md) {
  const lines = md.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const headers = splitRow(lines[0]);
  return lines.slice(2).map(line => {
    const cells = splitRow(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] || ''; });
    return obj;
  }).filter(r => r['#']);
}

function escapePipe(str) {
  return (str || '').replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function parsePipeline(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (.+?) \| (.+?) \| (.+)$/);
    if (m) {
      items.push({
        checked: m[1] === 'x',
        url: m[2].trim(),
        company: m[3].trim(),
        role: m[4].trim(),
      });
    }
  }
  return items;
}

function parseTsv(tsv) {
  const lines = tsv.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const cells = line.split('\t');
    const obj = {};
    headers.forEach((h, i) => { obj[h] = cells[i] || ''; });
    return obj;
  });
}

function parseScanLog(log) {
  const entries = [];
  for (const line of log.split('\n')) {
    const m = line.match(/^\[(.+?)\] (.+)$/);
    if (m) entries.push({ timestamp: m[1], message: m[2] });
  }
  return entries;
}

function serializeApplicationsTable(apps) {
  const header = '# Applications Tracker\n\n| # | Date | Company | Role | Score | Status | PDF | Report | Notes |\n|---|------|---------|------|-------|--------|-----|--------|-------|';
  const rows = apps.map(a =>
    `| ${escapePipe(a['#'])} | ${escapePipe(a['Date'])} | ${escapePipe(a['Company'])} | ${escapePipe(a['Role'])} | ${escapePipe(a['Score'])} | ${escapePipe(a['Status'])} | ${escapePipe(a['PDF'])} | ${a['Report']} | ${escapePipe(a['Notes'])} |`
  );
  return header + '\n' + rows.join('\n') + '\n';
}

// --- API Handlers ---

const routes = {};

function route(method, path, handler) {
  routes[`${method} ${path}`] = handler;
}

// Applications
route('GET', '/api/applications', async () => {
  const md = await readFile(join(ROOT, 'data/applications.md'), 'utf-8');
  return parseApplicationsTable(md);
});

route('PUT', '/api/applications/:id', async (req, params) => {
  return withLock('applications.md', async () => {
    const md = await readFile(join(ROOT, 'data/applications.md'), 'utf-8');
    const apps = parseApplicationsTable(md);
    const idx = apps.findIndex(a => a['#'] === params.id);
    if (idx === -1) throw { status: 404, message: 'Not found' };
    const body = await readBody(req);
    const updates = JSON.parse(body);
    // Only allow updating Status and Notes
    if (updates.Status) apps[idx]['Status'] = updates.Status;
    if (updates.Notes !== undefined) apps[idx]['Notes'] = updates.Notes;
    await atomicWrite(join(ROOT, 'data/applications.md'), serializeApplicationsTable(apps));
    return apps[idx];
  });
});

// Pipeline
route('GET', '/api/pipeline', async () => {
  const md = await readFile(join(ROOT, 'data/pipeline.md'), 'utf-8');
  return parsePipeline(md);
});

// Scan history
route('GET', '/api/scan-history', async () => {
  const tsv = await readFile(join(ROOT, 'data/scan-history.tsv'), 'utf-8');
  return parseTsv(tsv);
});

// Reports list
route('GET', '/api/reports', async () => {
  const files = await readdir(join(ROOT, 'reports'));
  const reports = files.filter(f => f.endsWith('.md')).sort().reverse();
  return reports.map(f => ({
    filename: f,
    path: `reports/${f}`,
  }));
});

// Single report
route('GET', '/api/reports/:filename', async (req, params) => {
  // Strict whitelist: only report filenames (NNN-slug-YYYY-MM-DD.md pattern)
  const safe = decodeURIComponent(params.filename);
  if (!/^[a-zA-Z0-9._-]+\.md$/.test(safe) || safe.includes('..')) {
    throw { status: 400, message: 'Invalid filename' };
  }
  const target = resolvePath(join(REPORTS_DIR, safe));
  // Defense in depth: ensure resolved path stays inside reports/
  if (!target.startsWith(REPORTS_DIR + sep)) {
    throw { status: 400, message: 'Invalid path' };
  }
  const content = await readFile(target, 'utf-8');
  return { filename: safe, content };
});

// Download a generated PDF from output/
const OUTPUT_DIR = resolvePath(join(ROOT, 'output'));
route('GET', '/api/output/:filename', async (req, params, res) => {
  const safe = decodeURIComponent(params.filename);
  if (!/^[a-zA-Z0-9._-]+\.pdf$/.test(safe) || safe.includes('..')) {
    throw { status: 400, message: 'Invalid filename' };
  }
  const target = resolvePath(join(OUTPUT_DIR, safe));
  if (!target.startsWith(OUTPUT_DIR + sep)) {
    throw { status: 400, message: 'Invalid path' };
  }
  const buf = await readFile(target);
  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${safe}"`,
    'Content-Length': buf.length,
  });
  res.end(buf);
});

// Scanner log
route('GET', '/api/scanner/log', async () => {
  try {
    const log = await readFile(join(ROOT, 'logs/scheduled-scan.log'), 'utf-8');
    return parseScanLog(log);
  } catch { return []; }
});

// Scanner status (launchd interval)
route('GET', '/api/scanner/status', async () => {
  let interval = 10800;
  try {
    const plist = await readFile(
      join(process.env.HOME, 'Library/LaunchAgents/com.rohan.career-ops-scan.plist'), 'utf-8'
    );
    const m = plist.match(/<key>StartInterval<\/key>\s*<integer>(\d+)<\/integer>/);
    if (m) interval = parseInt(m[1], 10);
  } catch {}

  let lastScan = null;
  try {
    const log = await readFile(join(ROOT, 'logs/scheduled-scan.log'), 'utf-8');
    const lines = parseScanLog(log);
    const completeLine = [...lines].reverse().find(l => l.message.includes('Scan complete'));
    if (completeLine) lastScan = completeLine.timestamp;
  } catch {}

  return { interval, lastScan };
});

// Trigger scan (execFile, no shell — no injection surface)
// Mutex prevents overlapping scans from clobbering scan-history.tsv and pipeline.md
let scanInFlight = false;
route('POST', '/api/scanner/run', async () => {
  if (scanInFlight) return { success: false, error: 'scan already running' };
  scanInFlight = true;
  try {
    const { execFile } = await import('child_process');
    return await new Promise(resolve => {
      execFile('node', ['scheduled-scan.mjs'], { cwd: ROOT, timeout: 600000 }, (err, stdout, stderr) => {
        if (err) resolve({ success: false, error: stderr || err.message });
        else resolve({ success: true, output: stdout });
      });
    });
  } finally {
    scanInFlight = false;
  }
});

// GET the cached liveness map so the pipeline view can show "last seen".
route('GET', '/api/liveness', async () => await loadLiveness());

// GET the per-URL fit-score cache populated by fit-score.mjs (Qwen-backed).
route('GET', '/api/fit-scores', async () => {
  const p = join(ROOT, 'data/fit-scores.json');
  try { return JSON.parse(await readFile(p, 'utf-8')); }
  catch { return {}; }
});

// Clusters — semantic groups of live pending fit>=3.5 URLs.
route('GET', '/api/clusters', async () => {
  const p = join(ROOT, 'data/clusters.json');
  try { return JSON.parse(await readFile(p, 'utf-8')); }
  catch { return { clusters: [], generatedAt: null }; }
});

// Gap analysis — full cache and per-hash lookup.
route('GET', '/api/gap-analysis', async () => {
  const p = join(ROOT, 'data/gap-analysis.json');
  try { return JSON.parse(await readFile(p, 'utf-8')); }
  catch { return {}; }
});

route('GET', '/api/gap-analysis/:urlHash', async (req, params) => {
  const hash = String(params.urlHash || '').trim();
  if (!/^[a-f0-9]{6,16}$/i.test(hash)) throw { status: 400, message: 'bad hash' };
  const p = join(ROOT, 'data/gap-analysis.json');
  try {
    const cache = JSON.parse(await readFile(p, 'utf-8'));
    for (const [url, v] of Object.entries(cache)) {
      if (v?.hash === hash) return { url, ...v };
    }
    throw { status: 404, message: 'not analyzed yet' };
  } catch (e) {
    if (e.status) throw e;
    throw { status: 404, message: 'no gap analysis cache' };
  }
});

// --- Settings (portals.yml + profile.yml) ---
// UI-editable subset. We preserve unknown YAML keys + formatting by only
// touching the fields we care about.
// Cross-reference each tracked company with what scheduled-scan.mjs actually
// polls. A company in portals.yml is only "live-scanned" if it also appears
// in one of the scanner's hard lists — greenhouse APIs, Ashby boards, or
// ChangeDetection.io watches on the Unraid box. Everything else is legacy
// websearch (not currently used by scheduled-scan).
async function buildScannerSourceIndex() {
  const scanSrc = await readFile(join(ROOT, 'scheduled-scan.mjs'), 'utf-8').catch(() => '');
  const extract = (startMarker) => {
    const i = scanSrc.indexOf(startMarker);
    if (i === -1) return [];
    const end = scanSrc.indexOf('];', i);
    if (end === -1) return [];
    const block = scanSrc.slice(i, end);
    return [...block.matchAll(/\["([^"]+)"/g)].map(m => m[1]);
  };
  const gh = new Set(extract('const GREENHOUSE_APIS'));
  const ashby = new Set(extract('const ASHBY_BOARDS'));
  const cd = new Set(extract('const CD_WATCHES'));
  return { gh, ashby, cd };
}

function classifyCompany(name, portalsMethod, idx) {
  // Priority: hard-coded scanner lists override portals.yml's scan_method
  if (idx.gh.has(name))    return { source: 'greenhouse', label: 'Greenhouse API',          detail: 'Direct JSON — fast, reliable' };
  if (idx.ashby.has(name)) return { source: 'ashby',      label: 'Ashby',                   detail: 'Local Playwright' };
  if (idx.cd.has(name))    return { source: 'cd',         label: 'ChangeDetection.io',      detail: 'Unraid browserless SPA renderer' };
  // Not in any scheduled-scan list. portals.yml says "websearch" but that path
  // isn't run by the 3h scheduler — it's only used by manual `/career-ops scan`.
  if (portalsMethod === 'websearch' || portalsMethod === 'api') {
    return { source: 'legacy', label: 'WebSearch (manual only)', detail: 'Not polled by the 3h auto-scanner' };
  }
  return { source: 'unknown', label: portalsMethod || 'unknown', detail: '' };
}

route('GET', '/api/settings', async () => {
  const portalsRaw = await readFile(join(ROOT, 'portals.yml'), 'utf-8');
  const profileRaw = await readFile(join(ROOT, 'config/profile.yml'), 'utf-8');
  const portals = yaml.load(portalsRaw) || {};
  const profile = yaml.load(profileRaw) || {};
  const idx = await buildScannerSourceIndex();
  return {
    title_filter: portals.title_filter || { positive: [], negative: [] },
    tracked_companies: (portals.tracked_companies || []).map(c => {
      const cls = classifyCompany(c.name, c.scan_method, idx);
      return {
        name: c.name,
        careers_url: c.careers_url,
        scan_method: c.scan_method,
        enabled: c.enabled !== false,
        notes: c.notes || '',
        source: cls.source,
        source_label: cls.label,
        source_detail: cls.detail,
      };
    }),
    profile: {
      compensation: profile.compensation || {},
      location: profile.location || {},
      target_roles: profile.target_roles || {},
    },
  };
});

route('PUT', '/api/settings', async (req) => {
  return withLock('settings', async () => {
    const body = await readBody(req);
    const updates = JSON.parse(body || '{}');

    // Update portals.yml
    if (updates.title_filter || updates.tracked_companies) {
      const raw = await readFile(join(ROOT, 'portals.yml'), 'utf-8');
      const portals = yaml.load(raw) || {};
      if (updates.title_filter) {
        portals.title_filter = portals.title_filter || {};
        if (Array.isArray(updates.title_filter.positive)) portals.title_filter.positive = updates.title_filter.positive;
        if (Array.isArray(updates.title_filter.negative)) portals.title_filter.negative = updates.title_filter.negative;
      }
      if (Array.isArray(updates.tracked_companies)) {
        // Merge by name — update `enabled` only, preserve other fields
        const byName = new Map(updates.tracked_companies.map(c => [c.name, c]));
        portals.tracked_companies = (portals.tracked_companies || []).map(c => {
          const u = byName.get(c.name);
          if (u && typeof u.enabled === 'boolean') return { ...c, enabled: u.enabled };
          return c;
        });
      }
      await atomicWrite(join(ROOT, 'portals.yml'),
        yaml.dump(portals, { lineWidth: 120, noRefs: true, quotingType: '"' }));
    }

    // Update profile.yml compensation + location
    if (updates.profile) {
      const raw = await readFile(join(ROOT, 'config/profile.yml'), 'utf-8');
      const profile = yaml.load(raw) || {};
      if (updates.profile.compensation) {
        profile.compensation = { ...(profile.compensation || {}), ...updates.profile.compensation };
      }
      if (updates.profile.location) {
        profile.location = { ...(profile.location || {}), ...updates.profile.location };
      }
      await atomicWrite(join(ROOT, 'config/profile.yml'),
        yaml.dump(profile, { lineWidth: 120, noRefs: true, quotingType: '"' }));
    }

    return { ok: true };
  });
});

// Pipeline liveness — verifies URLs still host a real job posting.
// Streams NDJSON (one JSON per line) as each URL finishes, so the UI
// updates live instead of waiting for the whole batch.
// Uses Playwright per CLAUDE.md ("NEVER trust WebFetch to verify if an offer
// is still active"). Falls back to browserless (http://10.0.0.100:3012) if
// the local browser cannot launch.
let verifyInFlight = false;
const LIVENESS_PARALLEL = 8;  // pages checked simultaneously
const LIVENESS_BATCH = 40;    // queue drain size per announce cycle
// Playwright connect requires the /playwright/chromium path on browserless v2.
const BROWSERLESS_HOST = '10.0.0.100:3012';
const BROWSERLESS_TOKEN = '2BR6DgQzZL8md4Bk5rewy3K9k';
const BROWSERLESS_WS = `ws://${BROWSERLESS_HOST}/playwright/chromium?token=${BROWSERLESS_TOKEN}`;

// FlareSolverr — bypasses Cloudflare WAF/challenge by solving the JS challenge
// and handing us the resulting `cf_clearance` cookies. We then run Playwright
// with those cookies so SPAs hydrate normally behind CF.
const FLARESOLVERR_URL = 'http://10.0.0.36:8191/v1';

async function flaresolvCookies(targetUrl) {
  try {
    const resp = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        cmd: 'request.get',
        url: targetUrl,
        maxTimeout: 45000,
      }),
      signal: AbortSignal.timeout(55000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const sol = data?.solution;
    if (!sol || sol.status === 403) return null;
    return {
      cookies: (sol.cookies || []).map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path || '/',
        expires: typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: !!c.httpOnly,
        secure: !!c.secure,
        sameSite: c.sameSite === 'None' ? 'None' : (c.sameSite === 'Strict' ? 'Strict' : 'Lax'),
      })),
      userAgent: sol.userAgent,
    };
  } catch {
    return null;
  }
}

// Extract location + salary + job title from a live job page.
// Strategy: JSON-LD schema.org JobPosting first (standardized + reliable),
// regex fallback on visible body text for salary when JSON-LD omits it.
async function extractJobMeta(page, visibleText) {
  const out = {};

  // 1. JSON-LD — most modern ATS (Greenhouse, Lever, Workday, Ashby, Cisco,
  //    Apple) emit this for SEO / rich results. It's by far the best source.
  const jsonLd = await page.evaluate(() => {
    const results = [];
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(el.textContent);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          const types = Array.isArray(item['@type']) ? item['@type'] : [item['@type']];
          if (types.includes('JobPosting')) results.push(item);
        }
      } catch {}
    }
    return results;
  }).catch(() => []);

  if (jsonLd.length) {
    const j = jsonLd[0];
    if (j.title) out.jobTitle = String(j.title).slice(0, 120);

    // Location: can be jobLocation (single) or array. Can be nested under
    // address.addressLocality/addressRegion or just a string.
    const locs = Array.isArray(j.jobLocation) ? j.jobLocation : (j.jobLocation ? [j.jobLocation] : []);
    const locStrings = locs.map(l => {
      if (typeof l === 'string') return l;
      const addr = l?.address || l;
      if (!addr) return null;
      if (typeof addr === 'string') return addr;
      const city = addr.addressLocality;
      const region = addr.addressRegion;
      const country = addr.addressCountry?.name || addr.addressCountry;
      return [city, region, country].filter(Boolean).join(', ');
    }).filter(Boolean);

    // Also check jobLocationType for remote signals
    if (j.jobLocationType === 'TELECOMMUTE' || j.applicantLocationRequirements) {
      if (locStrings.length === 0) locStrings.push('Remote');
    }
    if (locStrings.length) out.location = [...new Set(locStrings)].join(' / ').slice(0, 120);

    // Salary: baseSalary.value can be a number, a range object, or a string
    const bs = j.baseSalary;
    if (bs) {
      const v = bs.value;
      const currency = bs.currency || bs.currencyCode || (typeof v === 'object' ? v?.currency : '') || 'USD';
      const unit = typeof v === 'object' ? v?.unitText : null;
      if (typeof v === 'number') {
        out.salary = formatSalary(v, null, currency, unit);
      } else if (typeof v === 'object' && v) {
        const min = v.minValue ?? v.value;
        const max = v.maxValue;
        out.salary = formatSalary(min, max, currency, unit);
      } else if (typeof v === 'string') {
        out.salary = v.slice(0, 60);
      }
    }
    if (j.employmentType) out.employmentType = Array.isArray(j.employmentType) ? j.employmentType.join(', ') : j.employmentType;
  }

  // 2. Regex fallback on visible text if salary is still missing.
  if (!out.salary && visibleText) {
    // Match common salary range patterns in the first 4000 chars (above-the-fold)
    const scan = visibleText.slice(0, 4000);
    // $120,000 - $155,000 / yr  OR  $120K - $155K  OR  $120K-$155K
    const m = scan.match(
      /\$\s?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)\s?(?:[-–—to]+|\sto\s)\s?\$?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)/
    );
    if (m) out.salary = `$${m[1].replace(/\s/g, '')}–$${m[2].replace(/\s/g, '')}`;
  }

  return out;
}

function formatSalary(min, max, currency = 'USD', unit = null) {
  const sym = currency === 'USD' ? '$' : (currency + ' ');
  const fmt = (n) => {
    if (n == null) return '';
    const num = Number(n);
    if (!isFinite(num)) return '';
    return num >= 1000 ? `${sym}${Math.round(num / 1000)}K` : `${sym}${num}`;
  };
  const a = fmt(min);
  const b = fmt(max);
  const body = b && b !== a ? `${a}–${b}` : a;
  const suffix = unit && /hour|day|week|month/i.test(unit) ? ` / ${unit.toLowerCase()}` : '';
  return body + suffix;
}

async function acquireBrowser(chromium, writer) {
  // Try local chromium first
  try {
    const browser = await chromium.launch({ headless: true });
    writer({ type: 'engine', via: 'local-playwright' });
    return { browser, via: 'local' };
  } catch (localErr) {
    writer({ type: 'engine', via: 'browserless-fallback', reason: localErr.message.slice(0, 80) });
  }

  // Fall back to browserless over websocket
  try {
    const browser = await chromium.connect(BROWSERLESS_WS, { timeout: 10000 });
    writer({ type: 'engine', via: 'browserless', endpoint: BROWSERLESS_HOST });
    return { browser, via: 'browserless' };
  } catch (remoteErr) {
    throw new Error(`local and browserless both unreachable: ${remoteErr.message}`);
  }
}

route('POST', '/api/pipeline/verify', async (req, _params, res) => {
  if (verifyInFlight) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'verification already running' }));
    return;
  }
  verifyInFlight = true;

  let body = '';
  try { body = await readBody(req); } catch {}
  let urls = [];
  try { urls = JSON.parse(body || '{}').urls || []; } catch {}

  if (!Array.isArray(urls) || urls.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'provide urls: string[]' }));
    verifyInFlight = false;
    return;
  }

  // Deduplicate while preserving order. No upstream cap — caller decides
  // how many to throw in. The internal batching below keeps memory bounded
  // by walking the queue in LIVENESS_BATCH chunks.
  urls = [...new Set(urls.filter(u => typeof u === 'string' && /^https?:\/\//.test(u)))];

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  const write = (obj) => res.write(JSON.stringify(obj) + '\n');

  const { chromium } = await import('playwright');
  let browser, via;
  try {
    ({ browser, via } = await acquireBrowser(chromium, write));
  } catch (e) {
    write({ type: 'error', error: e.message });
    res.end();
    verifyInFlight = false;
    return;
  }

  write({ type: 'start', total: urls.length, batchSize: LIVENESS_BATCH, parallel: LIVENESS_PARALLEL });

  const queue = [...urls];
  let done = 0;

  async function check(url, isRetry = false) {
    const page = await browser.newPage();
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      const status = resp?.status() ?? 0;

      // Cloudflare WAF block → retry once via FlareSolverr to get cf_clearance
      // cookies, then reload in Playwright so the SPA hydrates normally.
      if (status === 403 && !isRetry) {
        await page.close().catch(() => {});
        const flare = await flaresolvCookies(url);
        if (flare?.cookies?.length) {
          const ctx = await browser.newContext({ userAgent: flare.userAgent });
          await ctx.addCookies(flare.cookies).catch(() => {});
          const retryPage = await ctx.newPage();
          try {
            const r2 = await retryPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            const s2 = r2?.status() ?? 0;
            if (s2 >= 200 && s2 < 400) {
              try { await retryPage.waitForLoadState('networkidle', { timeout: 3500 }); } catch {}
              await retryPage.waitForTimeout(600);
              const text2 = (await retryPage.textContent('body').catch(() => '')) || '';
              const visibleText2 = (await retryPage.evaluate(() => document.body?.innerText || '').catch(() => '')) || '';
              const title2 = (await retryPage.title().catch(() => '')) || '';
              if (visibleText2.trim().length >= 500) {
                const meta2 = await extractJobMeta(retryPage, visibleText2).catch(() => ({}));
                await ctx.close().catch(() => {});
                return { url, live: true, status: s2, reason: null, via: 'flaresolverr', ...meta2 };
              }
            }
          } catch {}
          await ctx.close().catch(() => {});
        }
        // FlareSolverr didn't give us a usable clearance. Mark transient so we
        // don't overwrite prior state.
        return { url, live: null, transient: true, status: 403, reason: 'cloudflare (flaresolverr retry failed)' };
      }
      try {
        await page.waitForLoadState('networkidle', { timeout: 3500 });
      } catch { /* intentional */ }
      await page.waitForTimeout(600);

      // --- Redirect soft-404 detection ---
      // Many ATS (Cisco, Workday, some Greenhouse tenants) silently redirect
      // removed job URLs to a generic careers/search landing page. HTTP is
      // still 200 and the content is real, but it's NOT the job. Detect by
      // checking that the requested URL's job identifier (numeric ID or
      // UUID) survives to the final URL. If not, it was redirected away.
      const finalUrl = page.url();
      const idMatch = url.match(/\/([a-f0-9]{8}-[a-f0-9-]{27,}|\d{5,})(?:[\/?#]|$)/);
      if (idMatch) {
        const jobId = idMatch[1];
        if (!finalUrl.includes(jobId)) {
          return { url, live: false, status, reason: `redirected away (${new URL(finalUrl).hostname}${new URL(finalUrl).pathname.slice(0, 30)})` };
        }
      }
      // textContent includes inline <script> bodies — useful for catching
      // markers, misleading for length checks. innerText via evaluate gives
      // us the actually-visible text (what the user would see).
      const text = (await page.textContent('body').catch(() => '')) || '';
      const visibleText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')) || '';
      const title = (await page.title().catch(() => '')) || '';

      // HTTP-level signals are authoritative for real closures (404)
      if (status === 404) return { url, live: false, status, reason: '404' };

      // Transient / bot-block / upstream-flaky status codes: we cannot tell
      // if the job is actually closed. Return `transient: true` so the caller
      // preserves the previous cached state rather than overwriting it.
      // Cloudflare WAF commonly returns 403 to headless browsers even when
      // the URL is perfectly live; same for 429, 502, 503, 504.
      if (status === 403 || status === 429 || (status >= 500 && status <= 599)) {
        return { url, live: null, transient: true, status, reason: `transient http ${status}` };
      }
      if (status === 0) {
        return { url, live: null, transient: true, status: 0, reason: 'network error / timeout' };
      }

      const low = text.toLowerCase();
      const lowTitle = title.toLowerCase();

      // TITLE check: SPAs that soft-404 typically set the <title> to a
      // not-found variant. Match common patterns explicitly.
      const titleClosed =
        /^page not found/i.test(title) ||
        /no job details found/i.test(title) ||
        /job not found/i.test(title) ||
        /requisition not found/i.test(title) ||
        (/(position|role|job) (is )?(no longer|unavailable|closed|expired|filled)/i.test(title));

      // STRONG body markers — unambiguous, not FAQ boilerplate. Scan the
      // ENTIRE body (Apple's SPA buries the message at offset ~40k behind
      // their nav menu). These phrases only appear on error states, never
      // in a live posting's footer or related-jobs carousel.
      const strongClosedMarkers = [
        // Explicit role/position/job existence statements
        'this role does not exist',
        'this position does not exist',
        'this job does not exist',
        'this role is no longer available',
        'this position is no longer available',
        'this job is no longer available',
        'this posting is no longer available',
        'this role has been filled',
        'this position has been filled',
        'this job has been filled',
        'this job posting has expired',
        'this job posting has been removed',
        'this requisition has been closed',
        'role does not exist or is no longer',
        'position does not exist or is no longer',
        // Generic "not found" pages
        'job requisition was not found',
        'the page you requested was not found',
        // Ashby (Cartesia, LangChain, Cohere, Modal, Pinecone, OpenAI Ashby)
        'the job you requested was not found',
        'job you requested was not found',
        // Greenhouse / Lever / Workday variants
        'this job is no longer posted',
        'this job post is no longer available',
        'we could not find the job you are looking for',
        "couldn't find the page",
        'oops, we can\'t find that page',
        // Apple's marketing jobs page
        'sorry, this role does not exist',
      ];
      const hasStrongClosed = strongClosedMarkers.some(m => low.includes(m));

      // Length check on VISIBLE text (not textContent, which includes inline
      // JS). Ashby error pages have ~3000 chars textContent but only ~150
      // chars visible. Raising cutoff to 500 catches these.
      const visibleLen = visibleText.trim().length;
      const tooShort = visibleLen < 500;

      // Cheap extra signal: a short visible page that mentions "not found"
      // or "no longer" anywhere is almost certainly an error page even if
      // the exact phrase isn't in our strong list.
      const shortWithHint =
        visibleLen < 800 &&
        /(not found|no longer|does not exist|unavailable|has expired)/i.test(visibleText);

      if (titleClosed)     return { url, live: false, status, reason: `closed title: ${title.slice(0, 50)}` };
      if (hasStrongClosed) return { url, live: false, status, reason: 'closed marker in body' };
      if (tooShort)        return { url, live: false, status, reason: `empty page (${visibleLen} visible chars)` };
      if (shortWithHint)   return { url, live: false, status, reason: 'short page + not-found hint' };

      // Extract metadata (location, salary, job title) from the live page.
      // Prefer JSON-LD schema.org JobPosting (standardized, most ATS set it).
      // Fall back to regex on visible text.
      const meta = await extractJobMeta(page, visibleText).catch(() => ({}));

      return { url, live: true, status, reason: null, ...meta };
    } catch (e) {
      // Network errors, timeouts, nav aborts — all transient. Don't overwrite
      // cached state with "dead" based on a bad network moment.
      return { url, live: null, transient: true, status: 0, reason: e.message.slice(0, 60) };
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Batched queue drain: walk the full queue in chunks of LIVENESS_BATCH.
  // Each chunk runs LIVENESS_PARALLEL pages concurrently. Between chunks,
  // announce the batch boundary so the UI can show "checking batch 2/7".
  const total = queue.length;
  const batchCount = Math.ceil(total / LIVENESS_BATCH);
  let batchIdx = 0;

  const cache = await loadLiveness();

  // Ensure headers and first bytes flush immediately — no waiting for a
  // buffer to fill before the client sees the first event.
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  // Debounced disk saves so we don't write .liveness.json once per URL
  // (which would thrash on 242-URL runs) but still persist much faster than
  // per-batch. Coalesces bursts into a single write every ~500ms.
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(async () => {
      saveTimer = null;
      await saveLiveness().catch(() => {});
    }, 500);
  };

  async function drainBatch(urlsInBatch) {
    const localQueue = [...urlsInBatch];
    const worker = async () => {
      while (localQueue.length) {
        const u = localQueue.shift();
        const result = await check(u);
        done++;
        // Persist (in-memory) immediately. The GET /api/liveness endpoint
        // reads the cache, so UIs polling mid-run see each URL's state the
        // instant its check resolves.
        const prev = cache[u] || {};
        if (result.transient) {
          // Transient failure (CF block after retry, timeout, 5xx). Don't
          // overwrite prior live/dead state — just emit the result so the UI
          // sees the transient message, but keep the cache stable.
          write({ type: 'result', done, ...result, last_seen: prev.last_seen });
        } else {
          cache[u] = {
            verified_at: new Date().toISOString(),
            last_seen: result.live ? new Date().toISOString() : prev.last_seen || null,
            live: result.live,
            status: result.status,
            reason: result.reason,
            // Metadata: keep newest scrape; preserve prior value if this run
            // didn't scrape it (e.g. URL is dead or no JSON-LD on page).
            location:       result.location       ?? prev.location       ?? null,
            salary:         result.salary         ?? prev.salary         ?? null,
            jobTitle:       result.jobTitle       ?? prev.jobTitle       ?? null,
            employmentType: result.employmentType ?? prev.employmentType ?? null,
          };
          write({ type: 'result', done, ...result, last_seen: cache[u].last_seen });
          scheduleSave();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIVENESS_PARALLEL, urlsInBatch.length) }, worker));
  }

  try {
    for (let offset = 0; offset < total; offset += LIVENESS_BATCH) {
      batchIdx++;
      const chunk = queue.slice(offset, offset + LIVENESS_BATCH);
      write({ type: 'batch', index: batchIdx, of: batchCount, size: chunk.length });
      await drainBatch(chunk);
    }
    // Final flush — wait for any pending debounced save to complete
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    await saveLiveness();
    write({ type: 'done', total: done, via });
  } catch (e) {
    await saveLiveness().catch(() => {});
    write({ type: 'error', error: e.message });
  } finally {
    await browser.close().catch(() => {});
    res.end();
    verifyInFlight = false;
  }
});

// Generate a tailored CV + evaluation report for a single URL.
// Spawns `claude -p` with the same batch-prompt.md system prompt the CLI
// batch runner uses. Streams stdout lines as NDJSON events. Result: a new
// report in reports/, a tailored PDF in output/, and a TSV line in
// batch/tracker-additions/ that merge-tracker.mjs folds into applications.md.
const cvGenInFlight = new Set();

route('POST', '/api/pipeline/generate-cv', async (req, _params, res) => {
  const body = await readBody(req).catch(() => '');
  let payload;
  try { payload = JSON.parse(body || '{}'); }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }
  const { url, company, role } = payload;
  if (!url || !/^https?:\/\//.test(url)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'url required' }));
    return;
  }
  if (cvGenInFlight.has(url)) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'generation already running for this URL' }));
    return;
  }
  cvGenInFlight.add(url);

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const emit = (obj) => res.write(JSON.stringify(obj) + '\n');

  try {
    // Reserve the next report number by scanning reports/ for the highest
    // existing NNN-*.md and adding 1. Not perfect against concurrent CLI
    // batch runs — but the cvGenInFlight mutex handles same-URL races.
    const files = await readdir(join(ROOT, 'reports'));
    let maxNum = 0;
    for (const f of files) {
      const m = f.match(/^(\d{3})-/);
      if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10));
    }
    const reportNum = String(maxNum + 1).padStart(3, '0');
    const date = new Date().toISOString().slice(0, 10);
    const jobId = `web-${Date.now()}`;
    const jdFile = `/tmp/web-jd-${jobId}.txt`;

    // Load and resolve the batch system prompt
    const promptTemplate = await readFile(join(ROOT, 'batch/batch-prompt.md'), 'utf-8');
    const resolved = promptTemplate
      .replace(/\{\{URL\}\}/g, url)
      .replace(/\{\{JD_FILE\}\}/g, jdFile)
      .replace(/\{\{REPORT_NUM\}\}/g, reportNum)
      .replace(/\{\{DATE\}\}/g, date)
      .replace(/\{\{ID\}\}/g, jobId);

    const resolvedPath = join(ROOT, `batch/.resolved-web-${jobId}.md`);
    await writeFile(resolvedPath, resolved);
    // Seed an empty JD file so the prompt's "read {{JD_FILE}}" step doesn't
    // error; Claude will WebFetch from the URL when the file is empty.
    await writeFile(jdFile, '');

    emit({ type: 'start', url, reportNum, company, role });
    emit({ type: 'log', line: `Reserved report ${reportNum} for ${company || 'unknown'} — ${role || 'unknown role'}` });
    emit({ type: 'log', line: `Running claude -p (3–6 min typical). You can leave this tab — generation continues on the server.` });

    const userPrompt = `Procesa esta oferta de empleo. Ejecuta el pipeline completo: evaluación + report .md + PDF + tracker line. URL: ${url} JD file: ${jdFile} Report number: ${reportNum} Date: ${date} Batch ID: ${jobId}`;

    const { spawn } = await import('child_process');
    const proc = spawn('claude', [
      '-p',
      '--dangerously-skip-permissions',
      '--append-system-prompt-file', resolvedPath,
      userPrompt,
    ], { cwd: ROOT });

    // Stream output line-by-line
    let buf = '';
    const flush = (chunk, isErr = false) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line.trim()) emit({ type: isErr ? 'stderr' : 'log', line: line.slice(0, 500) });
      }
    };
    proc.stdout.on('data', d => flush(d.toString('utf8')));
    proc.stderr.on('data', d => flush(d.toString('utf8'), true));

    const exitCode = await new Promise(resolve => proc.on('close', resolve));
    if (buf.trim()) emit({ type: 'log', line: buf.trim().slice(0, 500) });

    // Cleanup temp files
    const { unlink } = await import('fs/promises');
    await unlink(resolvedPath).catch(() => {});
    await unlink(jdFile).catch(() => {});

    if (exitCode !== 0) {
      emit({ type: 'error', error: `claude -p exited with code ${exitCode}`, reportNum });
      res.end();
      return;
    }

    // Look up the resulting report + PDF
    const reportMatch = (await readdir(join(ROOT, 'reports'))).find(f => f.startsWith(`${reportNum}-`));
    const pdfMatch = (await readdir(join(ROOT, 'output')).catch(() => []))
      .find(f => f.startsWith(`${reportNum}-`) && f.endsWith('.pdf'));

    // Merge the TSV tracker addition so applications.md gets updated
    try {
      const { execFile } = await import('child_process');
      await new Promise((resolve) => {
        execFile('node', ['merge-tracker.mjs'], { cwd: ROOT, timeout: 30000 }, (err, stdout) => {
          if (stdout) emit({ type: 'log', line: stdout.trim().slice(0, 300) });
          resolve();
        });
      });
    } catch (e) {
      emit({ type: 'log', line: `merge-tracker warning: ${e.message}` });
    }

    emit({
      type: 'done',
      reportNum,
      report: reportMatch || null,
      pdf: pdfMatch || null,
    });
  } catch (e) {
    emit({ type: 'error', error: e.message });
  } finally {
    cvGenInFlight.delete(url);
    res.end();
  }
});

// ChangeDetection.io watches
route('GET', '/api/scanner/cd-watches', async () => {
  try {
    const resp = await fetch('http://10.0.0.100:5000/api/v1/watch?tag=career-ops', {
      headers: { 'x-api-key': '881f09d4fec93a1ea3a9abb012263736' },
    });
    return await resp.json();
  } catch (e) {
    return { error: 'ChangeDetection.io unreachable', detail: e.message };
  }
});

// Profile
route('GET', '/api/profile', async () => {
  const content = await readFile(join(ROOT, 'config/profile.yml'), 'utf-8');
  return yaml.load(content);
});

// States
route('GET', '/api/states', async () => {
  const content = await readFile(join(ROOT, 'templates/states.yml'), 'utf-8');
  return yaml.load(content);
});

// Stats (computed)
route('GET', '/api/stats', async () => {
  const md = await readFile(join(ROOT, 'data/applications.md'), 'utf-8');
  const apps = parseApplicationsTable(md);
  const pipeline = parsePipeline(
    await readFile(join(ROOT, 'data/pipeline.md'), 'utf-8')
  );
  const liveness = await loadLiveness();

  const statusCounts = {};
  const scoreDist = { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 };
  let totalScore = 0;
  let scored = 0;

  for (const app of apps) {
    const status = (app.Status || '').toLowerCase();
    statusCounts[status] = (statusCounts[status] || 0) + 1;
    const scoreMatch = (app.Score || '').match(/([\d.]+)\/5/);
    if (scoreMatch) {
      const s = parseFloat(scoreMatch[1]);
      totalScore += s;
      scored++;
      const bucket = Math.min(5, Math.max(1, Math.round(s)));
      scoreDist[bucket]++;
    }
  }

  // Pipeline-wide aggregates — pending items only
  const pending = pipeline.filter(p => !p.checked);
  const companyCounts = {};
  let live = 0, dead = 0, unverified = 0, withSalary = 0;
  for (const p of pending) {
    companyCounts[p.company] = (companyCounts[p.company] || 0) + 1;
    const l = liveness[p.url];
    if (!l) unverified++;
    else if (l.live === true) live++;
    else if (l.live === false) dead++;
    else unverified++;
    if (l?.salary) withSalary++;
  }
  const byCompany = Object.entries(companyCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([company, count]) => ({ company, count }));

  return {
    total: apps.length,
    pending: pending.length,
    pipelineTotal: pipeline.length,
    pipelineLive: live,
    pipelineDead: dead,
    pipelineUnverified: unverified,
    pipelineWithSalary: withSalary,
    byCompany,
    statusCounts,
    scoreDist,
    avgScore: scored > 0 ? (totalScore / scored).toFixed(1) : null,
    applications: apps,
  };
});

// Time-series aggregates for dashboard charts
route('GET', '/api/stats/timeseries', async () => {
  const tsv = await readFile(join(ROOT, 'data/scan-history.tsv'), 'utf-8');
  const history = parseTsv(tsv);
  const liveness = await loadLiveness();
  const pipeline = parsePipeline(
    await readFile(join(ROOT, 'data/pipeline.md'), 'utf-8')
  );
  const pendingUrls = new Set(pipeline.filter(p => !p.checked).map(p => p.url));

  // Discoveries per day (from scan-history.first_seen) + cumulative pending total
  const perDay = {};
  for (const row of history) {
    const d = row.first_seen;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    perDay[d] = perDay[d] || { date: d, discovered: 0, stillPending: 0 };
    perDay[d].discovered++;
    if (pendingUrls.has(row.url)) perDay[d].stillPending++;
  }
  const discoveries = Object.values(perDay).sort((a, b) => a.date.localeCompare(b.date));
  // Add running cumulative pending count
  let runningTotal = 0;
  for (const d of discoveries) {
    runningTotal += d.stillPending;
    d.cumulativePending = runningTotal;
  }

  // Live vs dead per company — top 15 by pipeline presence
  const byCo = {};
  for (const p of pipeline.filter(p => !p.checked)) {
    const co = p.company;
    byCo[co] = byCo[co] || { company: co, live: 0, dead: 0, unverified: 0, withSalary: 0 };
    const l = liveness[p.url];
    if (!l) byCo[co].unverified++;
    else if (l.live === true) byCo[co].live++;
    else if (l.live === false) byCo[co].dead++;
    else byCo[co].unverified++;
    if (l?.salary) byCo[co].withSalary++;
  }
  const companyStatus = Object.values(byCo)
    .sort((a, b) => (b.live + b.dead + b.unverified) - (a.live + a.dead + a.unverified))
    .slice(0, 15);

  // Applications activity by week (bucketed Monday-start)
  const appsMd = await readFile(join(ROOT, 'data/applications.md'), 'utf-8');
  const apps = parseApplicationsTable(appsMd);
  const byWeek = {};
  for (const a of apps) {
    if (!a.Date || !/^\d{4}-\d{2}-\d{2}$/.test(a.Date)) continue;
    const dt = new Date(a.Date + 'T00:00:00Z');
    const dow = dt.getUTCDay();
    const mon = new Date(dt.getTime() - ((dow + 6) % 7) * 86400000);
    const wk = mon.toISOString().slice(0, 10);
    byWeek[wk] = byWeek[wk] || { week: wk, applied: 0, interview: 0, offer: 0, rejected: 0 };
    const s = (a.Status || '').toLowerCase();
    if (s === 'applied') byWeek[wk].applied++;
    else if (s === 'interview') byWeek[wk].interview++;
    else if (s === 'offer') byWeek[wk].offer++;
    else if (s === 'rejected') byWeek[wk].rejected++;
  }
  const applications = Object.values(byWeek).sort((a, b) => a.week.localeCompare(b.week));

  return { discoveries, companyStatus, applications };
});

// CSV export
route('GET', '/api/applications/csv', async () => {
  const md = await readFile(join(ROOT, 'data/applications.md'), 'utf-8');
  const apps = parseApplicationsTable(md);
  const headers = ['#', 'Date', 'Company', 'Role', 'Score', 'Status', 'PDF', 'Report', 'Notes'];
  const csv = [headers.join(','),
    ...apps.map(a => headers.map(h => `"${(a[h] || '').replace(/"/g, '""')}"`).join(','))
  ].join('\n');
  return { __raw: true, contentType: 'text/csv', body: csv, filename: 'applications.csv' };
});

// --- Server ---

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

function matchRoute(method, url) {
  const pathname = url.split('?')[0];
  for (const [key, handler] of Object.entries(routes)) {
    const [rMethod, rPath] = key.split(' ');
    if (rMethod !== method) continue;

    const rParts = rPath.split('/');
    const uParts = pathname.split('/');
    if (rParts.length !== uParts.length) continue;

    const params = {};
    let match = true;
    for (let i = 0; i < rParts.length; i++) {
      if (rParts[i].startsWith(':')) {
        params[rParts[i].slice(1)] = uParts[i];
      } else if (rParts[i] !== uParts[i]) {
        match = false;
        break;
      }
    }
    if (match) return { handler, params };
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = req.url;
  const method = req.method;
  const remote = req.socket.remoteAddress;
  const lan = isLan(remote);
  const authed = lan || verifyCookie(req.headers.cookie);

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- Login endpoints (unauthenticated) ---
  if (url === '/api/login' && method === 'POST') {
    try {
      const body = await readBody(req);
      const { password } = JSON.parse(body || '{}');
      const a = Buffer.from(password || '', 'utf-8');
      const b = Buffer.from(PASSWORD, 'utf-8');
      const ok = a.length === b.length && timingSafeEqual(a, b);
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'wrong password' }));
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Set-Cookie': issueCookie(),
      });
      res.end(JSON.stringify({ ok: true }));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'bad request' }));
    }
    return;
  }

  if (url === '/api/logout' && method === 'POST') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Set-Cookie': 'sess=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
    });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url === '/api/auth-status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ authed, lan }));
    return;
  }

  // Login page is always reachable
  if (url === '/login' || url === '/login.html') {
    try {
      const html = await readFile(join(PUBLIC_DIR, 'login.html'));
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch {
      res.writeHead(404); res.end('login page missing');
    }
    return;
  }

  // --- Auth gate ---
  if (!authed) {
    if (url.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'auth required' }));
      return;
    }
    // Allow only the login page's own static assets without auth
    if (url === '/style.css' || url === '/favicon.ico') {
      // fall through to static handler
    } else {
      res.writeHead(302, { Location: '/login' });
      res.end();
      return;
    }
  }

  // Same-origin CORS. No wildcard — session cookie auth requires we lock this
  // down or a rogue site could ride the user's session (CSRF).
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin && host && origin.endsWith(`//${host}`)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }

  // API routes. Handlers receive (req, params, res) — if they write to res
  // directly they should return undefined; otherwise we JSON-stringify the
  // return value.
  const matched = matchRoute(method, url);
  if (matched) {
    try {
      const result = await matched.handler(req, matched.params, res);
      if (res.writableEnded) return;
      if (result && result.__raw) {
        res.writeHead(200, {
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="${result.filename}"`,
        });
        res.end(result.body);
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      }
    } catch (e) {
      if (!res.writableEnded) {
        const status = e.status || 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Internal error' }));
      }
    }
    return;
  }

  // Static files — resolve + ensure path is contained within PUBLIC_DIR.
  // Blocks `/../server.mjs`, `/../../data/applications.md`, etc.
  let filePath = url.split('?')[0];
  try { filePath = decodeURIComponent(filePath); } catch {}
  if (filePath === '/') filePath = '/index.html';
  const fullPath = resolvePath(join(PUBLIC_DIR, filePath));
  if (fullPath !== PUBLIC_DIR && !fullPath.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(400);
    res.end('Bad path');
    return;
  }

  try {
    const s = await stat(fullPath);
    if (s.isFile()) {
      const ext = extname(fullPath);
      const mime = MIME[ext] || 'application/octet-stream';
      const content = await readFile(fullPath);
      res.writeHead(200, { 'Content-Type': mime });
      res.end(content);
      return;
    }
  } catch {}

  // SPA fallback
  try {
    const html = await readFile(join(__dirname, 'public/index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, HOST, async () => {
  const os = await import('os');
  const ifaces = os.networkInterfaces();
  const lanIps = [];
  for (const list of Object.values(ifaces)) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal && isLan(i.address)) {
        lanIps.push(i.address);
      }
    }
  }
  console.log(`\ncareer-ops dashboard`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const ip of lanIps) {
    console.log(`  LAN:     http://${ip}:${PORT}  (no password on this network)`);
  }
  console.log('');
});
