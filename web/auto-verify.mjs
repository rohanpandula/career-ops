#!/usr/bin/env node
// web/auto-verify.mjs — standalone liveness checker for the scheduled scanner.
//
// Reads data/pipeline.md + web/.liveness.json, decides which URLs are
// stale (never verified OR verified >AGE_HOURS ago), runs Playwright on
// them, and writes results back to web/.liveness.json.
//
// Intended to be called by scheduled-scan.mjs at the end of each 3h tick,
// so the dashboard always shows fresh liveness without a manual click.
//
// Can also be invoked directly:
//   node web/auto-verify.mjs
//   node web/auto-verify.mjs --max 50       # cap per run
//   node web/auto-verify.mjs --age 6        # re-check URLs older than 6h

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { browserless, flaresolverrUrl } from '../infra-config.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const LIVENESS_FILE = join(__dirname, '.liveness.json');

const args = process.argv.slice(2);
function argVal(name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}
const MAX_PER_RUN = parseInt(argVal('max', '80'), 10);
const AGE_HOURS = parseFloat(argVal('age', '6'));
const PARALLEL = 6;
// Browserless / FlareSolverr endpoints from config/profile.yml (gitignored) or
// env — never hardcoded in this public-fork file. `${ws_url}?token=${token}`.
const _bl = browserless();
const BROWSERLESS_WS = _bl.wsUrl ? `${_bl.wsUrl}?token=${_bl.token}` : '';
const FLARESOLVERR_URL = flaresolverrUrl();

async function flaresolvCookies(targetUrl) {
  try {
    const resp = await fetch(FLARESOLVERR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: targetUrl, maxTimeout: 45000 }),
      signal: AbortSignal.timeout(55000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const sol = data?.solution;
    if (!sol || sol.status === 403) return null;
    return {
      cookies: (sol.cookies || []).map(c => ({
        name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
        expires: typeof c.expires === 'number' ? c.expires : -1,
        httpOnly: !!c.httpOnly, secure: !!c.secure,
        sameSite: c.sameSite === 'None' ? 'None' : (c.sameSite === 'Strict' ? 'Strict' : 'Lax'),
      })),
      userAgent: sol.userAgent,
    };
  } catch { return null; }
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] auto-verify: ${msg}`);
}

// --- Parse pipeline.md (duplicated from web/server.mjs to keep this script
// dependency-free) ---
function parsePipeline(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (.+?) \| (.+?) \| (.+)$/);
    if (m && m[1] === ' ') {
      items.push({ url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
    }
  }
  return items;
}

async function loadLiveness() {
  if (!existsSync(LIVENESS_FILE)) return {};
  try { return JSON.parse(await readFile(LIVENESS_FILE, 'utf-8')); }
  catch { return {}; }
}

async function saveLiveness(cache) {
  const tmp = `${LIVENESS_FILE}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 0));
  await rename(tmp, LIVENESS_FILE);
}

// --- Page check — mirrors the logic in web/server.mjs /api/pipeline/verify
async function check(browser, url, isRetry = false) {
  const page = await browser.newPage();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const status = resp?.status() ?? 0;

    // Cloudflare WAF → retry once via FlareSolverr
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
            const visibleText2 = (await retryPage.evaluate(() => document.body?.innerText || '').catch(() => '')) || '';
            if (visibleText2.trim().length >= 500) {
              const meta2 = await extractJobMeta(retryPage, visibleText2).catch(() => ({}));
              await ctx.close().catch(() => {});
              return { live: true, status: s2, reason: null, ...meta2 };
            }
          }
        } catch {}
        await ctx.close().catch(() => {});
      }
      return { live: null, transient: true, status: 403, reason: 'cloudflare (flaresolverr retry failed)' };
    }

    if (status === 404) return { live: false, status, reason: '404' };
    if (status === 429 || (status >= 500 && status <= 599)) {
      return { live: null, transient: true, status, reason: `transient http ${status}` };
    }
    if (status === 0) {
      return { live: null, transient: true, status: 0, reason: 'network error / timeout' };
    }

    try { await page.waitForLoadState('networkidle', { timeout: 3500 }); } catch {}
    await page.waitForTimeout(600);

    // Redirect soft-404: if the job ID from the original URL didn't survive
    // to the final URL, the ATS silently bounced us to a landing page.
    const finalUrl = page.url();
    const idMatch = url.match(/\/([a-f0-9]{8}-[a-f0-9-]{27,}|\d{5,})(?:[\/?#]|$)/);
    if (idMatch && !finalUrl.includes(idMatch[1])) {
      return { live: false, status, reason: `redirected away (${new URL(finalUrl).hostname})` };
    }
    const text = (await page.textContent('body').catch(() => '')) || '';
    const visibleText = (await page.evaluate(() => document.body?.innerText || '').catch(() => '')) || '';
    const title = (await page.title().catch(() => '')) || '';

    // Status triage handled above (404/403/429/5xx/0).

    const low = text.toLowerCase();
    const titleClosed =
      /^page not found/i.test(title) ||
      /no job details found/i.test(title) ||
      /job not found/i.test(title) ||
      /requisition not found/i.test(title) ||
      /(position|role|job) (is )?(no longer|unavailable|closed|expired|filled)/i.test(title);

    const strongClosedMarkers = [
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
      'job requisition was not found',
      'the page you requested was not found',
      // Ashby (Cartesia, LangChain, Cohere, Modal, Pinecone, OpenAI Ashby)
      'the job you requested was not found',
      'job you requested was not found',
      'this job is no longer posted',
      'this job post is no longer available',
      'we could not find the job you are looking for',
      "couldn't find the page",
      "oops, we can't find that page",
      'sorry, this role does not exist',
    ];
    const hasStrongClosed = strongClosedMarkers.some(m => low.includes(m));

    const visibleLen = visibleText.trim().length;
    const tooShort = visibleLen < 500;
    const shortWithHint =
      visibleLen < 800 &&
      /(not found|no longer|does not exist|unavailable|has expired)/i.test(visibleText);

    if (titleClosed)     return { live: false, status, reason: `closed title: ${title.slice(0, 50)}` };
    if (hasStrongClosed) return { live: false, status, reason: 'closed marker in body' };
    if (tooShort)        return { live: false, status, reason: `empty page (${visibleLen} visible chars)` };
    if (shortWithHint)   return { live: false, status, reason: 'short page + not-found hint' };
    if (googleRequestedTitleMissing(url, visibleText)) {
      return { live: false, status, reason: 'google fallback page missing requested title' };
    }

    const meta = await extractJobMeta(page, visibleText).catch(() => ({}));
    return { live: true, status, reason: null, ...meta };
  } catch (e) {
    return { live: null, transient: true, status: 0, reason: e.message.slice(0, 60) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractJobMeta(page, visibleText) {
  const out = {};
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
    const locs = Array.isArray(j.jobLocation) ? j.jobLocation : (j.jobLocation ? [j.jobLocation] : []);
    const locStrings = locs.map(l => {
      if (typeof l === 'string') return l;
      const addr = l?.address || l;
      if (!addr) return null;
      if (typeof addr === 'string') return addr;
      return [addr.addressLocality, addr.addressRegion, addr.addressCountry?.name || addr.addressCountry].filter(Boolean).join(', ');
    }).filter(Boolean);
    if (j.jobLocationType === 'TELECOMMUTE' || j.applicantLocationRequirements) {
      if (locStrings.length === 0) locStrings.push('Remote');
    }
    if (locStrings.length) out.location = [...new Set(locStrings)].join(' / ').slice(0, 120);

    const bs = j.baseSalary;
    if (bs) {
      const v = bs.value;
      const currency = bs.currency || bs.currencyCode || (typeof v === 'object' ? v?.currency : '') || 'USD';
      const unit = typeof v === 'object' ? v?.unitText : null;
      if (typeof v === 'number') out.salary = formatSalary(v, null, currency, unit);
      else if (typeof v === 'object' && v) out.salary = formatSalary(v.minValue ?? v.value, v.maxValue, currency, unit);
      else if (typeof v === 'string') out.salary = v.slice(0, 60);
    }
    if (j.employmentType) out.employmentType = Array.isArray(j.employmentType) ? j.employmentType.join(', ') : j.employmentType;
  }

  if (!out.salary && visibleText) {
    const scan = visibleText.slice(0, 4000);
    const m = scan.match(/\$\s?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)\s?(?:[-–—to]+|\sto\s)\s?\$?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)/);
    if (m) out.salary = `$${m[1].replace(/\s/g, '')}–$${m[2].replace(/\s/g, '')}`;
  }
  return out;
}

function normalizeJobTitleMatchText(value) {
  return String(value || '')
    .replace(/&amp;/gi, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function expectedGoogleTitleFromUrl(targetUrl) {
  try {
    const u = new URL(targetUrl);
    if (u.hostname !== 'www.google.com') return '';
    if (!u.pathname.includes('/about/careers/applications/jobs/results')) return '';

    const detail = decodeURIComponent(u.pathname.split('/jobs/results/')[1] || '').replace(/\/$/, '');
    const detailMatch = detail.match(/^\d+-(.+)$/);
    if (detailMatch) return detailMatch[1].replace(/-/g, ' ');

    const hash = decodeURIComponent(u.hash || '').replace(/^#+/, '').replace(/^-+/, '');
    if (hash) return hash.replace(/-/g, ' ');
  } catch {}
  return '';
}

function googleRequestedTitleMissing(targetUrl, visibleText) {
  const expected = normalizeJobTitleMatchText(expectedGoogleTitleFromUrl(targetUrl));
  if (!expected) return false;
  return !normalizeJobTitleMatchText(visibleText).includes(expected);
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

async function acquireBrowser(chromium) {
  try {
    const b = await chromium.launch({ headless: true });
    log('engine: local playwright');
    return { browser: b, via: 'local' };
  } catch (e) {
    log(`local chromium failed (${e.message.slice(0, 60)}), trying browserless`);
    const b = await chromium.connect(BROWSERLESS_WS, { timeout: 10000 });
    log('engine: browserless');
    return { browser: b, via: 'browserless' };
  }
}

async function main() {
  const pipelinePath = join(ROOT, 'data/pipeline.md');
  if (!existsSync(pipelinePath)) { log('no pipeline.md'); return; }

  const items = parsePipeline(await readFile(pipelinePath, 'utf-8'));
  if (items.length === 0) { log('pipeline is empty'); return; }

  const cache = await loadLiveness();
  const staleMs = AGE_HOURS * 3600 * 1000;
  const now = Date.now();

  // Prioritize: never-verified URLs first, then oldest-verified.
  const candidates = items
    .map(i => ({ ...i, verifiedAt: cache[i.url]?.verified_at ? new Date(cache[i.url].verified_at).getTime() : 0 }))
    .filter(i => {
      if (!i.verifiedAt) return true;
      return (now - i.verifiedAt) > staleMs;
    })
    .sort((a, b) => a.verifiedAt - b.verifiedAt)
    .slice(0, MAX_PER_RUN);

  if (candidates.length === 0) {
    log(`nothing stale (all ${items.length} URLs verified within ${AGE_HOURS}h)`);
    return;
  }

  log(`${candidates.length} URLs to verify (of ${items.length} total pending)`);

  const { chromium } = await import('playwright');
  const { browser, via } = await acquireBrowser(chromium);

  let done = 0, live = 0, dead = 0, skipped = 0;
  const queue = [...candidates];
  let flushTimer = null;
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await saveLiveness(cache).catch(e => log(`save failed: ${e.message}`));
    }, 500);
  };

  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      const r = await check(browser, item.url);
      done++;
      if (r.transient) {
        // Skipped — don't overwrite prior state. Count separately so the
        // log is accurate.
        skipped++;
      } else if (r.live) {
        live++;
        const prev = cache[item.url] || {};
        cache[item.url] = {
          verified_at: new Date().toISOString(),
          last_seen: new Date().toISOString(),
          live: true,
          status: r.status,
          reason: r.reason,
          location:       r.location       ?? prev.location       ?? null,
          salary:         r.salary         ?? prev.salary         ?? null,
          jobTitle:       r.jobTitle       ?? prev.jobTitle       ?? null,
          employmentType: r.employmentType ?? prev.employmentType ?? null,
        };
        scheduleFlush();
      } else {
        dead++;
        const prev = cache[item.url] || {};
        cache[item.url] = {
          verified_at: new Date().toISOString(),
          last_seen: prev.last_seen || null,
          live: false,
          status: r.status,
          reason: r.reason,
          location:       prev.location       ?? null,
          salary:         prev.salary         ?? null,
          jobTitle:       prev.jobTitle       ?? null,
          employmentType: prev.employmentType ?? null,
        };
        scheduleFlush();
      }
      if (done % 10 === 0) log(`progress ${done}/${candidates.length} (${live} live, ${dead} dead, ${skipped} skipped)`);
    }
  };

  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  await saveLiveness(cache);
  await browser.close().catch(() => {});

  log(`done: ${done} checked, ${live} live, ${dead} dead, ${skipped} skipped (transient), engine=${via}`);
}

main().catch(e => {
  console.error('auto-verify failed:', e);
  process.exit(1);
});
