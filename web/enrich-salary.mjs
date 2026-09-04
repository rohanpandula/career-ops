#!/usr/bin/env node
// web/enrich-salary.mjs — salary enrichment via ATS APIs.
//
// For pipeline URLs whose host maps to a known ATS (Ashby, Lever, Greenhouse),
// fetch the board's posting API, match by title or job ID, and write
// salary/jobTitle/location into web/.liveness.json.
//
// Much more reliable than regex on rendered HTML — these APIs return
// structured compensation data (tier summaries, min/max) directly.
//
// Usage:
//   node web/enrich-salary.mjs
//
// Safe to run repeatedly — idempotent; skips entries that already have salary.

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { browserlessHttpUrl } from '../infra-config.mjs';
import { runPool, WORKDAY_URL_RE, workdayApiUrl, workdaySalary } from './enrich-salary-core.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = join(__dirname, '..');
const LIVENESS_FILE = join(__dirname, '.liveness.json');
const PIPELINE_FILE = join(ROOT, 'data/pipeline.md');

// Map of host -> ATS provider + board slug.
// Board slug is the path segment used by the ATS API.
const ASHBY_BOARDS = {
  'openai.com': 'openai',
  'jobs.ashbyhq.com': null, // parse slug from URL path
};
const LEVER_BOARDS = {
  'spotify': 'spotify',
  'palantir': 'palantir',
  'mistral': 'mistral',
};
const GREENHOUSE_BOARDS = {
  'anthropic': 'anthropic',
  'databricks': 'databricks',
  'epicgames': 'epicgames',
  'roblox': 'roblox',
  'scaleai': 'scaleai',
  'deepmind': 'deepmind',
};

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] enrich-salary: ${msg}`);
}

function slugify(s) {
  return String(s || '').toLowerCase()
    .replace(/[—–]/g, '-')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function parsePipeline(md) {
  const items = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (.+?) \| (.+?) \| (.+)$/);
    if (m) items.push({ url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
  }
  return items;
}

async function loadLiveness() {
  if (!existsSync(LIVENESS_FILE)) return {};
  return JSON.parse(await readFile(LIVENESS_FILE, 'utf-8'));
}

async function saveLiveness(cache) {
  await writeFile(LIVENESS_FILE, JSON.stringify(cache, null, 0));
}

// --- Ashby ---------------------------------------------------------------

async function fetchAshbyBoard(slug) {
  const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`ashby ${slug}: ${r.status}`);
  const d = await r.json();
  return d.jobs || [];
}

// Slugify an OpenAI URL: /careers/gtm-onboarding-lead-san-francisco/ → gtm-onboarding-lead-san-francisco
function ashbyOpenAiMatchKey(url) {
  const m = url.match(/openai\.com\/careers\/([^/?#]+)/);
  if (!m) return null;
  return m[1].replace(/\/+$/, '');
}

function ashbyJobsToIndex(jobs) {
  // Index by title slug + URL-suffix variants. OpenAI public URL
  // shape is `{slugified-title}-{location-slug}/`.
  const idx = {};
  for (const j of jobs) {
    const tslug = slugify(j.title);
    idx[tslug] = j;
    // Also index by title + primary location suffix — matches openai.com URLs
    const loc = j.location || j.address?.postalAddress?.addressLocality || '';
    if (loc) {
      const locSlug = slugify(loc).replace(/,.*$/, '');
      idx[`${tslug}-${locSlug}`] = j;
    }
    // Ashby UUID in URL: jobs.ashbyhq.com/openai/{uuid}
    if (j.id) idx[j.id] = j;
  }
  return idx;
}

// --- Lever ---------------------------------------------------------------

async function fetchLeverBoard(slug) {
  const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=500`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`lever ${slug}: ${r.status}`);
  return r.json();
}

function leverSalary(j) {
  if (j.salaryDescription?.text) return j.salaryDescription.text.slice(0, 80);
  const r = j.salaryRange;
  if (r && r.min && r.max) {
    const sym = r.currency === 'USD' ? '$' : (r.currency ? `${r.currency} ` : '$');
    const fmt = (n) => n >= 1000 ? `${sym}${Math.round(n / 1000)}K` : `${sym}${n}`;
    return `${fmt(r.min)}–${fmt(r.max)}`;
  }
  return null;
}

// --- Greenhouse ----------------------------------------------------------

async function fetchGreenhouseBoard(slug) {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`greenhouse ${slug}: ${r.status}`);
  const d = await r.json();
  return d.jobs || [];
}

function greenhouseSalary(j) {
  if (!j.content) return null;
  // Greenhouse wraps published comp in <div class="pay-range"> — parse that
  // structure first since it's authoritative and survives regardless of where
  // in the content it sits.
  // Anthropic et al. double-encode the content (tags as &lt;/&gt;/&quot;);
  // decode entities in two passes so both shapes work.
  const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  const raw = decode(decode(j.content));
  const prM = raw.match(/<div class="pay-range">\s*<span[^>]*>([^<]+)<\/span>\s*<span[^>]*>[^<]*<\/span>\s*<span[^>]*>([^<]+)<\/span>/i);
  if (prM) {
    // Only keep USD/CAD-style ranges ($); skip GBP/EUR
    const min = prM[1].trim();
    const max = prM[2].trim();
    if (/\$/.test(min) || /USD/i.test(max)) {
      return `${min}–${max}`.replace(/\s*USD\s*/g, '').replace(/\s+/g, '');
    }
    return null; // non-USD, skip
  }
  // Fallback: regex across visible text (strip tags → then match $X – $Y)
  const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 12000);
  const m = text.match(/\$\s?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)\s?(?:[-–—to]+|\sto\s|\s?and\s?)\s?\$?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)/);
  if (m) return `$${m[1].replace(/\s/g, '')}–$${m[2].replace(/\s/g, '')}`;
  return null;
}

// --- Workday (public CXS API) --------------------------------------------
// Unity migrated off Greenhouse to Workday. Workday serves the same posting
// JSON that renders the page, so no browser is needed — the CXS endpoint is
// derived from the public URL by swapping the locale segment for wday/cxs:
//   public: https://{tenant}.wd{N}.myworkdayjobs.com/en-US/{site}/job/{path}
//   api:    https://{tenant}.wd{N}.myworkdayjobs.com/wday/cxs/{tenant}/{site}/job/{path}
async function fetchWorkdayJob(url) {
  const api = workdayApiUrl(url);
  if (!api) return null;
  const r = await fetch(api, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`workday: ${r.status}`);
  const d = await r.json();
  return d.jobPostingInfo || null;
}

// --- Main ----------------------------------------------------------------

async function main() {
  const md = await readFile(PIPELINE_FILE, 'utf-8');
  const items = parsePipeline(md);
  const cache = await loadLiveness();

  // Group URLs by ATS board
  const ashbyBuckets = {}; // slug -> [items]
  const leverBuckets = {};
  const greenhouseBuckets = {};
  const workdayItems = [];

  for (const it of items) {
    if (cache[it.url]?.salary) continue; // already have salary
    const url = it.url;

    // Ashby
    if (url.includes('openai.com/careers/')) {
      (ashbyBuckets.openai ??= []).push(it);
      continue;
    }
    const ashbyM = url.match(/jobs\.ashbyhq\.com\/([^/]+)\//);
    if (ashbyM) {
      (ashbyBuckets[ashbyM[1]] ??= []).push(it);
      continue;
    }

    // Lever — dynamic: any board slug works
    const leverM = url.match(/jobs\.lever\.co\/([^/]+)\//);
    if (leverM) {
      (leverBuckets[leverM[1]] ??= []).push(it);
      continue;
    }

    // Greenhouse — dynamic: any board slug works
    const ghM = url.match(/(?:job-boards|boards)\.greenhouse\.io\/([^/]+)/);
    if (ghM) {
      (greenhouseBuckets[ghM[1]] ??= []).push(it);
      continue;
    }

    // Workday — per-job CXS fetch (no board-wide listing carries descriptions).
    if (WORKDAY_URL_RE.test(url)) {
      workdayItems.push(it);
      continue;
    }

    // Legacy unity.com/careers/positions/{id} URLs fall through unrouted: Unity
    // migrated to Workday and the `unity3d` Greenhouse board now 404s, so there
    // is nothing left to enrich them against.

    // Greenhouse-proxied hosts (company domain, but backed by Greenhouse board)
    if (url.match(/databricks\.com\/.*[?&]gh_jid=\d+/)) {
      (greenhouseBuckets.databricks ??= []).push(it);
      continue;
    }
    if (url.match(/epicgames\.com\/.*jobs\/\d+/)) {
      (greenhouseBuckets.epicgames ??= []).push(it);
      continue;
    }
    if (url.match(/careers\.roblox\.com\/jobs\/\d+/)) {
      (greenhouseBuckets.roblox ??= []).push(it);
      continue;
    }
  }

  let enriched = 0;

  // Ashby
  for (const [slug, bucket] of Object.entries(ashbyBuckets)) {
    try {
      log(`ashby/${slug}: fetching (${bucket.length} items to enrich)`);
      const jobs = await fetchAshbyBoard(slug);
      const idx = ashbyJobsToIndex(jobs);
      for (const it of bucket) {
        let matched = null;
        // jobs.ashbyhq.com/{slug}/{uuid}
        const uuidM = it.url.match(/ashbyhq\.com\/[^/]+\/([a-f0-9-]{36})/);
        if (uuidM) matched = idx[uuidM[1]];
        // openai.com/careers/{slug}
        if (!matched && it.url.includes('openai.com')) {
          const key = ashbyOpenAiMatchKey(it.url);
          if (key) {
            matched = idx[key];
            if (!matched) {
              // Drop location suffix progressively
              const parts = key.split('-');
              for (let cut = 1; cut <= 4 && !matched; cut++) {
                matched = idx[parts.slice(0, -cut).join('-')];
              }
            }
          }
        }
        if (matched) {
          const salary = matched.compensation?.compensationTierSummary || null;
          const prev = cache[it.url] || {};
          cache[it.url] = {
            ...prev,
            verified_at: prev.verified_at || new Date().toISOString(),
            live: prev.live ?? true,
            salary: salary || prev.salary || null,
            jobTitle: matched.title || prev.jobTitle || null,
            location: matched.location || prev.location || null,
            employmentType: matched.employmentType || prev.employmentType || null,
          };
          if (salary) enriched++;
        }
      }
    } catch (e) {
      log(`ashby/${slug} failed: ${e.message}`);
    }
  }

  // Lever
  for (const [slug, bucket] of Object.entries(leverBuckets)) {
    try {
      log(`lever/${slug}: fetching (${bucket.length} items to enrich)`);
      const jobs = await fetchLeverBoard(slug);
      const byId = {};
      for (const j of jobs) byId[j.id] = j;
      for (const it of bucket) {
        const idM = it.url.match(/lever\.co\/[^/]+\/([a-f0-9-]{36})/);
        if (!idM) continue;
        const j = byId[idM[1]];
        if (!j) continue;
        const salary = leverSalary(j);
        const prev = cache[it.url] || {};
        cache[it.url] = {
          ...prev,
          verified_at: prev.verified_at || new Date().toISOString(),
          live: prev.live ?? true,
          salary: salary || prev.salary || null,
          jobTitle: j.text || prev.jobTitle || null,
          location: j.categories?.location || prev.location || null,
        };
        if (salary) enriched++;
      }
    } catch (e) {
      log(`lever/${slug} failed: ${e.message}`);
    }
  }

  // Greenhouse
  for (const [slug, bucket] of Object.entries(greenhouseBuckets)) {
    try {
      log(`greenhouse/${slug}: fetching (${bucket.length} items to enrich)`);
      const jobs = await fetchGreenhouseBoard(slug);
      const byId = {};
      for (const j of jobs) byId[String(j.id)] = j;
      for (const it of bucket) {
        // Extract Greenhouse ID from multiple URL shapes:
        //   /jobs/{id}          (greenhouse.io, roblox, epicgames)
        //   /positions/{id}     (unity.com)
        //   ?gh_jid={id}        (databricks)
        const idM = it.url.match(/[?&]gh_jid=(\d+)/)
          || it.url.match(/\/(?:jobs|positions)\/(\d+)/);
        if (!idM) continue;
        const j = byId[idM[1]];
        if (!j) continue;
        const salary = greenhouseSalary(j);
        const prev = cache[it.url] || {};
        cache[it.url] = {
          ...prev,
          verified_at: prev.verified_at || new Date().toISOString(),
          live: prev.live ?? true,
          salary: salary || prev.salary || null,
          jobTitle: j.title || prev.jobTitle || null,
          location: j.location?.name || prev.location || null,
        };
        if (salary) enriched++;
      }
    } catch (e) {
      log(`greenhouse/${slug} failed: ${e.message}`);
    }
  }

  // Workday — one fetch per job (the board listing has no descriptions).
  if (workdayItems.length) {
    log(`workday: fetching (${workdayItems.length} items to enrich)`);
    await runPool(workdayItems, 6, async (it) => {
      try {
        const j = await fetchWorkdayJob(it.url);
        if (!j) return;
        const salary = workdaySalary(j);
        const prev = cache[it.url] || {};
        cache[it.url] = {
          ...prev,
          verified_at: prev.verified_at || new Date().toISOString(),
          live: prev.live ?? true,
          salary: salary || prev.salary || null,
          jobTitle: j.title || prev.jobTitle || null,
          location: j.location || prev.location || null,
        };
        if (salary) enriched++;
      } catch (e) {
        log(`workday failed: ${e.message}`);
      }
    });
  }

  // --- Browserless-rendered hosts (Google, Apple) --------------------------
  // Endpoint + token from config/profile.yml (gitignored) or env — not hardcoded.
  const BROWSERLESS_CONTENT = browserlessHttpUrl('content');
  const BR_PARALLEL = 6;

  async function renderPage(url) {
    if (!BROWSERLESS_CONTENT) return null;
    try {
      const r = await fetch(BROWSERLESS_CONTENT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, waitForTimeout: 5000 }),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return null;
      return await r.text();
    } catch { return null; }
  }

  function extractGoogleSalary(html) {
    // "US base salary range for this full-time position is $100,000-$141,000"
    const m = html.match(/base salary[^.<]{0,80}?\$(\d{2,3}[,.]?\d{3})\s*[-–—to]+\s*\$?(\d{2,3}[,.]?\d{3})/i);
    if (m) return `$${m[1].replace(/\s/g, '')}–$${m[2].replace(/\s/g, '')}`;
    return null;
  }

  function extractAppleSalary(html) {
    // "base pay range for this role is between $193,000 and $290,100"
    const m = html.match(/base pay range[^.<]{0,80}?\$(\d{2,3}[,.]?\d{3})\s*(?:and|[-–—to]+)\s*\$?(\d{2,3}[,.]?\d{3})/i);
    if (m) return `$${m[1].replace(/\s/g, '')}–$${m[2].replace(/\s/g, '')}`;
    // Generic fallback: any "$X – $Y" within first 8000 chars of body
    const body = html.slice(0, 20000);
    const m2 = body.match(/\$\s?(\d{2,3}[,.]?\d{3})\s*(?:and|[-–—to]+)\s*\$?(\d{2,3}[,.]?\d{3})/);
    if (m2) return `$${m2[1].replace(/\s/g, '')}–$${m2[2].replace(/\s/g, '')}`;
    return null;
  }

  function extractSnapSalary(html) {
    const m = html.match(/base salary range for this position is \$([\d,]+)\s*[-–—to]+\s*\$?([\d,]+)/i);
    if (m) return `$${m[1]}–$${m[2]}`;
    return null;
  }

  function extractDatadogSalary(html) {
    // "<div class="content-pay-transparency">…<span>$X</span>…<span>$Y USD</span>"
    const m = html.match(/content-pay-transparency[\s\S]{0,400}?\$(\d{2,3}[,.]?\d{3})[\s\S]{0,80}?\$(\d{2,3}[,.]?\d{3})/i);
    if (m) return `$${m[1]}–$${m[2]} USD`;
    return null;
  }

  // --- Amazon (JSON search endpoint, no render needed) --------------------

  async function enrichAmazon() {
    const targets = items.filter(it => {
      if (cache[it.url]?.salary) return false;
      return it.url.includes('amazon.jobs/en/jobs/');
    });
    if (!targets.length) return;
    log(`amazon: ${targets.length} to enrich via search.json`);
    let found = 0;
    for (const it of targets) {
      const idM = it.url.match(/\/jobs\/(\d+)/);
      if (!idM) continue;
      try {
        const r = await fetch(`https://www.amazon.jobs/en/search.json?base_query=${idM[1]}&result_limit=1`, {
          // amazon.jobs serves zstd since 2026-08; undici's zstd decoder truncates,
          // so pin accept-encoding to gzip/br.
          headers: { 'User-Agent': 'Mozilla/5.0', 'accept-encoding': 'gzip, deflate, br' },
          signal: AbortSignal.timeout(15000),
        });
        const d = await r.json();
        const j = d.jobs?.[0];
        if (!j || String(j.id_icims) !== idM[1]) continue;
        const text = [j.description, j.basic_qualifications, j.preferred_qualifications]
          .filter(Boolean).join(' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
        // Format 1 (corporate):  "151,200.00 - 204,600.00 USD annually"
        // Format 2 (AWS):        "Salary Range $153,600/year to $207,800/year"
        let m = text.match(/(\d{2,3}[,.]?\d{3})(?:\.\d{2})?\s*[-–]\s*(\d{2,3}[,.]?\d{3})(?:\.\d{2})?\s*USD\s*annually/i)
          || text.match(/Salary Range\s*\$(\d{2,3}[,.]?\d{3})\s*\/year\s*to\s*\$(\d{2,3}[,.]?\d{3})\s*\/year/i);
        if (!m) continue;
        const salary = `$${m[1].replace(/\s/g, '')}–$${m[2].replace(/\s/g, '')}`;
        const prev = cache[it.url] || {};
        cache[it.url] = {
          ...prev,
          verified_at: new Date().toISOString(),
          live: true,
          status: 200,
          reason: null,
          salary,
          jobTitle: j.title || prev.jobTitle || null,
          location: j.normalized_location || prev.location || null,
        };
        found++;
        enriched++;
      } catch {}
    }
    log(`  amazon: done — ${found}/${targets.length} enriched`);
    await saveLiveness(cache);
  }

  async function enrichBrowserless(host, extractor) {
    const targets = items.filter(it => {
      if (cache[it.url]?.salary) return false;
      return it.url.includes(host);
    });
    if (!targets.length) return;
    log(`${host}: ${targets.length} pages to render via browserless`);
    const queue = [...targets];
    let found = 0, checked = 0;
    const worker = async () => {
      while (queue.length) {
        const it = queue.shift();
        const html = await renderPage(it.url);
        checked++;
        if (!html) continue;
        const salary = extractor(html);
        if (!salary) continue;
        const prev = cache[it.url] || {};
        // If we successfully extracted salary from Browserless-rendered HTML,
        // the page is definitively live. Override any prior "dead" verdict
        // from auto-verify (which may have falsely marked Apple/Google SPAs
        // dead because headless Playwright couldn't hydrate them).
        cache[it.url] = {
          ...prev,
          verified_at: new Date().toISOString(),
          live: true,
          status: 200,
          reason: null,
          salary,
        };
        found++;
        enriched++;
        if (checked % 10 === 0) log(`  ${host}: ${checked}/${targets.length} checked, ${found} found`);
      }
    };
    await Promise.all(Array.from({ length: BR_PARALLEL }, worker));
    log(`  ${host}: done — ${found}/${targets.length} enriched`);
    await saveLiveness(cache); // flush between hosts
  }

  await enrichBrowserless('google.com/about/careers', extractGoogleSalary);
  await enrichBrowserless('jobs.apple.com', extractAppleSalary);
  await enrichBrowserless('careers.snap.com', extractSnapSalary);
  await enrichBrowserless('careers.datadoghq.com', extractDatadogSalary);
  await enrichAmazon();

  await saveLiveness(cache);
  log(`done: ${enriched} URLs newly enriched with salary`);
}

main().catch(e => {
  console.error('enrich-salary fatal:', e);
  process.exit(1);
});
