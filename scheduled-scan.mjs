#!/usr/bin/env node
/**
 * scheduled-scan.mjs — Recurring Playwright scanner for career-ops.
 *
 * Runs hourly (or on any schedule) via launchd. Checks Greenhouse APIs +
 * Ashby boards for new AI PM / DevRel / Platform roles, verifies liveness,
 * dedups against scan-history.tsv + pipeline.md, and sends a Telegram
 * notification only when new qualifying jobs are found.
 *
 * User preferences baked in:
 * - Skip xAI (user preference)
 * - Skip Director / Head / VP titles (too senior — target PM / Senior PM)
 * - Only notify on new jobs; silent when nothing found
 *
 * Appends new jobs to:
 *   data/scan-history.tsv   (TSV, one row per URL)
 *   data/pipeline.md        (markdown checkbox under "## Pendientes")
 *
 * Writes log to:
 *   logs/scheduled-scan.log
 */

import { chromium } from "playwright";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "fs";
import { spawnSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import * as yaml from "js-yaml";
import { changedetection } from "./infra-config.mjs";
import { captureResponseDuringNavigation, parseWorkdayPostedOn } from "./scheduled-scan-core.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
process.chdir(__dirname);

// --- Logging ---
const LOG_DIR = join(__dirname, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const LOG_PATH = join(LOG_DIR, "scheduled-scan.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(LOG_PATH, line + "\n"); } catch {}
}

// --- Dedup sources ---
const HISTORY_PATH = join(__dirname, "data", "scan-history.tsv");
const PIPELINE_PATH = join(__dirname, "data", "pipeline.md");
const PORTALS_PATH = join(__dirname, "portals.yml");
const PROFILE_PATH = join(__dirname, "config", "profile.yml");

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(HISTORY_PATH)) {
    for (const line of readFileSync(HISTORY_PATH, "utf-8").split("\n")) {
      const url = line.split("\t")[0];
      if (url && url.startsWith("http")) seen.add(url);
    }
  }
  if (existsSync(PIPELINE_PATH)) {
    const raw = readFileSync(PIPELINE_PATH, "utf-8");
    for (const m of raw.matchAll(/https?:\/\/[^\s|]+/g)) {
      seen.add(m[0]);
    }
  }
  return seen;
}

// --- Filters ---
// REQUIRED: title must contain at least one of these specific role phrases.
// Topic words like "AI" / "ML" alone are NOT enough — the role itself must match.
const ROLE_KEYWORDS = [
  "Product Manager","Technical PM","Product Marketing","Product Strategy",
  "Solutions Architect",
  "Strategic Partnerships","Partnerships","Partner Manager","Partnerships Manager",
  "Technical Account Manager","Technical Program Manager",
  "Business Development","Go-to-Market","GTM",
  "Program Manager",
];

function readYaml(path) {
  if (!existsSync(path)) return {};
  try {
    return yaml.load(readFileSync(path, "utf-8")) || {};
  } catch (e) {
    log(`WARN: could not read ${path}: ${e.message}`);
    return {};
  }
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter(Boolean);
}

function cleanJobTitle(title) {
  return String(title || "")
    .replace(/^\s*(?:[-*+]|\u2022)+\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function loadScannerPrefs() {
  const portals = readYaml(PORTALS_PATH);
  const profile = readYaml(PROFILE_PATH);
  return {
    titleNegatives: stringList(portals.title_filter?.negative),
    locationNegatives: stringList(profile.scanner?.exclude_locations),
  };
}

const SCANNER_PREFS = loadScannerPrefs();

const BASE_NEGATIVE_KEYWORDS = [
  "Junior","Intern","New Grad","Entry Level",
  ".NET","Java ","iOS Developer","Android Developer","PHP","Ruby",
  "Embedded","Firmware","FPGA","ASIC",
  "Blockchain","Web3","Crypto","COBOL","Mainframe",
  // User targets PM / DevRel / Partnerships, NOT individual-contributor SWE roles
  "Software Engineer","Software Developer","Staff Engineer","Senior Engineer",
  "Frontend Engineer","Backend Engineer","Full Stack","Fullstack",
  "Engineering Manager","Research Engineer","Security Engineer",
  "Data Engineer","Data Scientist","Research Scientist","Applied Scientist",
  "Applied AI Engineer","SRE","DevOps Engineer","QA Engineer","Test Engineer",
  "Systems Engineer","Infrastructure Engineer","Network Engineer",
];

const NEGATIVE_KEYWORDS = uniqueStrings([
  ...BASE_NEGATIVE_KEYWORDS,
  ...SCANNER_PREFS.titleNegatives,
]);

const EXCLUDED_LOCATION_KEYWORDS = uniqueStrings(SCANNER_PREFS.locationNegatives);

// --- US-eligibility ---
// A pure substring blocklist wrongly drops multi-region postings that ARE
// US-eligible (e.g. "London, UK; New York, NY; San Francisco, CA"). Mirror
// city-classify.mjs: if ANY segment carries a concrete US signal, the role is
// US-eligible regardless of foreign segments. Only when no US signal exists do
// we apply the foreign blocklist. Bare "Remote" with no geo is treated as
// unknown→pass (don't penalize missing data), but "Remote, United Kingdom"
// still fails because "remote" alone is NOT a US signal.
const US_CITY_SIGNALS = [
  "san francisco", "new york", "los angeles", "seattle", "boston", "austin",
  "chicago", "cupertino", "sunnyvale", "mountain view", "palo alto", "san jose",
  "santa clara", "menlo park", "redwood city", "san bruno", "culver city",
  "santa monica", "bellevue", "redmond", "kirkland", "cambridge", "washington dc",
  "arlington", "mclean", "reston", "atlanta", "denver", "boulder", "miami",
  "portland", "dallas", "houston", "phoenix", "minneapolis", "nashville",
  "raleigh", "philadelphia", "san diego", "pittsburgh", "san antonio",
  "salt lake city", "detroit", "new jersey", "brooklyn", "manhattan",
];
const US_COUNTRY_SIGNALS = [
  "united states", "usa", "u.s.a", "u.s.", "us-remote",
  "remote - us", "remote, us", "remote (us", "remote-us",
];
const US_STATE_CODES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY",
];
// Match `, NY` / `; CA` / `/ TX` / ` WA` where the code is a standalone token
// (uppercase, not followed by another letter). The negative lookahead is what
// stops ", CA" from matching "Canada" or ", OR" from matching "Oregon-City".
const US_STATE_RE = new RegExp(`(?:,|;|/|\\s)\\s*(?:${US_STATE_CODES.join("|")})(?![A-Za-z])`);

function hasUsSignal(location) {
  const lower = location.toLowerCase();
  if (US_COUNTRY_SIGNALS.some((s) => lower.includes(s))) return true;
  if (US_CITY_SIGNALS.some((s) => lower.includes(s))) return true;
  return US_STATE_RE.test(location); // original case — state codes are uppercase
}

function isUsEligibleLocation(location) {
  if (!location || !location.trim()) return true;     // unknown → pass
  if (hasUsSignal(location)) return true;             // any US part → pass
  const lower = location.toLowerCase();
  return !EXCLUDED_LOCATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

// Freshness window: only notify on jobs updated in the last N hours.
// Prevents flooding on first run (which would otherwise verify 600+ stale listings).
const FRESHNESS_HOURS = 48;

// User preference: skip senior-ceiling titles — target PM / Senior PM level
const SENIORITY_CAP_KEYWORDS = [
  "Director","Head of","Head,","VP","Vice President",
  "Chief","Principal Director","Group Director",
];

// User preference: never surface xAI
const EXCLUDED_COMPANIES = ["xAI","xai"];

function matchesFilter(title, company, location = "") {
  const cleanTitle = cleanJobTitle(title);
  if (!cleanTitle) return false;
  const lower = cleanTitle.toLowerCase();
  const hasRole = ROLE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
  const hasNegative = NEGATIVE_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
  // US-eligibility on the location field (multi-region aware). Separately,
  // still block a foreign location embedded in the TITLE itself (e.g.
  // "Solutions Architect, London") since those carry no separate location.
  const locationOk = isUsEligibleLocation(location);
  const titleHasExcludedLoc = EXCLUDED_LOCATION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
  const capsOut = SENIORITY_CAP_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
  const excludedCo = EXCLUDED_COMPANIES.some((c) => company && company.toLowerCase() === c.toLowerCase());
  return hasRole && !hasNegative && locationOk && !titleHasExcludedLoc && !capsOut && !excludedCo;
}

// --- Scan sources ---
// Unity was removed here: it migrated off Greenhouse to Workday. The `unity3d`
// board now returns HTTP 404 {"status":404,"error":"Job not found"}. It is
// served by fetchWorkdayBoards() below (WORKDAY_BOARDS).
const GREENHOUSE_APIS = [
  ["Anthropic",  "https://boards-api.greenhouse.io/v1/boards/anthropic/jobs"],
  ["Databricks", "https://boards-api.greenhouse.io/v1/boards/databricks/jobs"],
  ["Epic Games", "https://boards-api.greenhouse.io/v1/boards/epicgames/jobs"],
  ["Roblox",     "https://boards-api.greenhouse.io/v1/boards/roblox/jobs"],
  ["Scale AI",   "https://boards-api.greenhouse.io/v1/boards/scaleai/jobs"],
  ["DeepMind",   "https://boards-api.greenhouse.io/v1/boards/deepmind/jobs"],
  ["Oura",       "https://boards-api.greenhouse.io/v1/boards/oura/jobs"],
  ["Peloton",    "https://boards-api.greenhouse.io/v1/boards/peloton/jobs"],
];

// Ashby slugs — public posting API. The HTML at jobs.ashbyhq.com/{slug} is a
// React SPA whose anchors do not match a[href*="/ashbyhq.com/"], so the old
// Playwright scraper silently returned 0 links for every board.
const ASHBY_BOARDS = [
  ["LangChain", "langchain"],
  ["Cohere",    "cohere"],
  ["Pinecone",  "pinecone"],
  ["Modal",     "modal"],
  ["OpenAI",    "openai"],
  ["Snowflake", "snowflake"],
  // Mistral emptied its `mistral` Lever board (HTTP 200 + `[]`, not a 404) and
  // moved to Ashby on/before 2026-07-18. Slug is the literal domain "mistral.ai"
  // — the dot is part of the board name, not a typo.
  ["Mistral AI", "mistral.ai"],
];

// --- ChangeDetection.io as data source (SPA sites rendered by Unraid box) ---
// changedetection.io credentials come from config/profile.yml (gitignored) or
// env (CD_API_URL / CD_API_KEY) — never hardcoded in this public-fork file.
const { apiUrl: CD_API, apiKey: CD_KEY } = changedetection();
// Watches to read snapshots from. These are rendered by changedetection.io's browser backend.
// We just read the latest snapshot text, parse job titles, and apply our own filters.
const CD_WATCHES = [
  // Apple now uses Playwright anchor extraction (APPLE_SEARCHES below).
  // Google now uses direct HTML parsing (GOOGLE_SEARCHES below) — server-rendered
  // anchors with aria-label titles. No CD snapshot needed.
  // Snap now uses its public API (SNAP_QUERIES below) for real Workday URLs.
  // Amazon now uses the public search.json API (AMAZON_QUERIES below) for real
  // per-job URLs (/en/jobs/{id}/{slug}) instead of synthetic search-page fragments.
  // Spotify, Palantir, Mistral now use the Lever public API (LEVER_BOARDS below) —
  // gives real per-job hostedUrl values instead of synthetic #slug fragments.
];

// --- Amazon public search API ---
// Returns structured job postings with real /en/jobs/{id}/{slug} paths.
const AMAZON_QUERIES = [
  { label: "AI PM", base_query: "AI product manager" },
];

async function fetchAmazonJobs(seen, candidates) {
  const freshnessCutoff = Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000;
  for (const q of AMAZON_QUERIES) {
    try {
      const url = `https://www.amazon.jobs/en/search.json?base_query=${encodeURIComponent(q.base_query)}&country%5B%5D=USA&result_limit=50&sort=recent`;
      // amazon.jobs started serving content-encoding: zstd (2026-08); undici's zstd
      // decoder truncates the body at the first flush, so pin to gzip/br.
      const resp = await fetch(url, { headers: { "accept-encoding": "gzip, deflate, br" }, signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { log(`  Amazon (API): HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      const jobs = data.jobs || [];
      let freshCount = 0;
      for (const j of jobs) {
        const title = cleanJobTitle(j.title || "");
        const jobUrl = j.job_path ? `https://www.amazon.jobs${j.job_path}` : "";
        const location = j.normalized_location || j.location || "";
        const posted = j.posted_date ? new Date(j.posted_date).getTime() : 0;
        if (!jobUrl || seen.has(jobUrl)) continue;
        if (!posted || posted < freshnessCutoff) continue;
        // Amazon's country filter is loose — post-filter to US only.
        if (!/USA|United States/i.test(location)) continue;
        if (matchesFilter(title, "Amazon", location)) {
          candidates.push({ company: "Amazon", title, url: jobUrl, location, source: "Amazon API" });
          seen.add(jobUrl);
          freshCount++;
        }
      }
      log(`  Amazon (API "${q.label}"): ${jobs.length} total, ${freshCount} fresh matches`);
    } catch (e) {
      log(`  ERROR Amazon (API "${q.label}"): ${e.message.substring(0, 80)}`);
    }
  }
}

// --- Lever public API ---
// Returns structured postings with real hostedUrl values, unlike the CD text-snapshot
// approach which could only produce synthetic index-page URLs.
const LEVER_BOARDS = [
  ["Spotify",    "spotify"],
  ["Palantir",   "palantir"],
  // Mistral AI moved to Ashby 2026-07-18 — see ASHBY_BOARDS ("mistral.ai").
];

async function fetchLeverBoards(seen, candidates) {
  const freshnessCutoff = Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000;
  // 30s timeout: Mistral's Lever response is ~4.3 MB JSON and intermittently
  // exceeded a 15s budget under load (mirrors the Ashby/OpenAI fix in e06b6d7).
  for (const [company, slug] of LEVER_BOARDS) {
    try {
      const resp = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) { log(`  ERROR ${company} (Lever): HTTP ${resp.status}`); continue; }
      const jobs = await resp.json();
      let freshCount = 0;
      for (const job of jobs) {
        const title = cleanJobTitle(job.text || "");
        const url = job.hostedUrl || "";
        const location = job.categories?.location || "";
        const createdAt = job.createdAt || 0;
        if (!url || seen.has(url)) continue;
        if (!createdAt || createdAt < freshnessCutoff) continue;
        if (matchesFilter(title, company, location)) {
          candidates.push({ company, title, url, location, source: "Lever API" });
          seen.add(url);
          freshCount++;
        }
      }
      log(`  ${company} (Lever): ${jobs.length} total, ${freshCount} fresh matches`);
    } catch (e) {
      log(`  ERROR ${company} (Lever): ${e.message.substring(0, 80)}`);
    }
  }
}

// --- Snap public API ---
// Elasticsearch-backed careers.snap.com/api/jobs returns structured hits with
// real Workday absolute_urls. No posting timestamp in the payload, so we rely
// on the `seen` dedup set for freshness (first run ingests; later runs diff).
const SNAP_QUERIES = [
  { label: "LA",       location: "Los Angeles" },
  { label: "Bay Area", location: "Palo Alto"   },
];

async function fetchSnapJobs(seen, candidates) {
  for (const q of SNAP_QUERIES) {
    try {
      const url = `https://careers.snap.com/api/jobs?location=${encodeURIComponent(q.location)}&limit=100`;
      const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!resp.ok) { log(`  Snap (API): HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      const hits = data.body || [];
      let matchCount = 0;
      for (const h of hits) {
        const s = h._source || {};
        const title = cleanJobTitle(s.title || "");
        const jobUrl = s.absolute_url || "";
        const loc = s.offices?.[0]?.location || s.primary_location || "";
        if (!jobUrl || seen.has(jobUrl)) continue;
        if (matchesFilter(title, "Snap", loc)) {
          candidates.push({ company: "Snap", title, url: jobUrl, location: loc, source: "Snap API" });
          seen.add(jobUrl);
          matchCount++;
        }
      }
      log(`  Snap (API "${q.label}"): ${hits.length} total, ${matchCount} role matches`);
    } catch (e) {
      log(`  ERROR Snap API: ${e.message.substring(0, 80)}`);
    }
  }
}

// --- Workday public CXS API ---
// Unity migrated off Greenhouse (the `unity3d` board 404s) to Workday. Workday
// exposes a public JSON search endpoint per tenant/site — no auth, no Playwright:
//   POST /wday/cxs/{tenant}/{site}/jobs  {appliedFacets:{}, limit, offset, searchText}
// Job URLs are built from `externalPath` against /en-US/{site}.
const WORKDAY_BOARDS = [
  // [company, tenant, site]
  ["Unity", "unitytech", "Unity"],
];

// Workday reports freshness as prose ("Posted Today" / "Posted Yesterday" /
// "Posted 5 Days Ago" / "Posted 30+ Days Ago"), never a timestamp. Parse it to a
// day count so the FRESHNESS_HOURS window still applies. Unlike Snap (which has
// no date at all and leans on `seen`), Unity's board is brand-new to the dedup
// set, so without this every stale match would flood on the first run.
// Returns null when unparseable — caller treats null as "unknown", not "fresh".

async function fetchWorkdayBoards(seen, candidates) {
  const freshnessDays = FRESHNESS_HOURS / 24;
  for (const [company, tenant, site] of WORKDAY_BOARDS) {
    try {
      const endpoint = `https://${tenant}.wd1.myworkdayjobs.com/wday/cxs/${tenant}/${site}/jobs`;
      const origin = `https://${tenant}.wd1.myworkdayjobs.com/en-US/${site}`;
      let total = 0;
      let freshCount = 0;
      // Workday hard-caps `limit` at 20, so page until exhausted (guard at 500).
      for (let offset = 0; offset < 500; offset += 20) {
        // Workday throws sporadic transient 503s (~1 in 50 runs) that clear
        // within seconds; without a retry a single failed page zeroes the run.
        let resp;
        for (let attempt = 0; ; attempt++) {
          resp = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" }),
            signal: AbortSignal.timeout(30000),
          });
          if (resp.ok || resp.status < 500 || attempt >= 2) break;
          log(`  RETRY ${company} (Workday): HTTP ${resp.status} at offset ${offset}, attempt ${attempt + 1}/3`);
          await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        }
        if (!resp.ok) { log(`  ERROR ${company} (Workday): HTTP ${resp.status}`); break; }
        const data = await resp.json();
        if (!Array.isArray(data.jobPostings)) {
          log(`  ERROR ${company} (Workday): no jobPostings array — tenant/site may be invalid`);
          break;
        }
        const postings = data.jobPostings;
        total += postings.length;
        for (const job of postings) {
          const title = cleanJobTitle(job.title || "");
          const path = job.externalPath || "";
          const location = job.locationsText || "";
          if (!path) continue;
          const url = origin + path;
          if (seen.has(url)) continue;
          const ageDays = parseWorkdayPostedOn(job.postedOn);
          if (ageDays === null || ageDays > freshnessDays) continue; // stale/unknown — skip
          if (matchesFilter(title, company, location)) {
            candidates.push({ company, title, url, location, source: "Workday API" });
            seen.add(url);
            freshCount++;
          }
        }
        if (postings.length < 20) break; // last page
        if (offset === 480 && Number(data.total) > 500) {
          log(`  WARN ${company} (Workday): ${data.total} postings exceeds the 500-item scan cap`);
        }
      }
      log(`  ${company} (Workday): ${total} total, ${freshCount} fresh matches`);
    } catch (e) {
      log(`  ERROR ${company} (Workday): ${e.message.substring(0, 80)}`);
    }
  }
}

// --- Google careers (HTML parsing) ---
// google.com/about/careers server-renders results with anchor hrefs and an
// `aria-label="Learn more about <TITLE>"` attribute on each card. No Playwright
// required — just regex on the HTML.
const GOOGLE_SEARCHES = [
  { label: "Bay Area PM",       location: "Bay Area",    q: "product manager" },
  { label: "Bay Area Partner",  location: "Bay Area",    q: "partnerships" },
  { label: "Bay Area Solutions",location: "Bay Area",    q: "solutions architect" },
  { label: "LA PM",             location: "Los Angeles", q: "product manager" },
  { label: "LA Partner",        location: "Los Angeles", q: "partnerships" },
];

async function fetchGoogleJobs(seen, candidates) {
  for (const q of GOOGLE_SEARCHES) {
    try {
      const url = `https://www.google.com/about/careers/applications/jobs/results?location=${encodeURIComponent(q.location)}&q=${encodeURIComponent(q.q)}&sort_by=date`;
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) { log(`  Google (HTML "${q.label}"): HTTP ${resp.status}`); continue; }
      const html = await resp.text();
      // Extract each anchor: href="jobs/results/{ID}-{slug}..." aria-label="Learn more about {TITLE}"
      const re = /href="(jobs\/results\/\d+-[a-z0-9-]+[^"]*)"[^>]*aria-label="Learn more about ([^"]+)"/g;
      const seenHere = new Set();
      let matchCount = 0;
      let m;
      while ((m = re.exec(html))) {
        const path = m[1].split('?')[0].replace(/&amp;/g, '&');
        const fullUrl = `https://www.google.com/about/careers/applications/${path}`;
        if (seenHere.has(fullUrl)) continue;
        seenHere.add(fullUrl);
        if (seen.has(fullUrl)) continue;
        const title = cleanJobTitle(m[2].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'));
        if (matchesFilter(title, "Google", q.location)) {
          candidates.push({ company: "Google", title, url: fullUrl, location: q.location, source: `Google HTML (${q.label})` });
          seen.add(fullUrl);
          matchCount++;
        }
      }
      log(`  Google (HTML "${q.label}"): ${seenHere.size} jobs, ${matchCount} role matches`);
    } catch (e) {
      log(`  ERROR Google HTML "${q.label}": ${e.message.substring(0, 80)}`);
    }
  }
}

// --- Apple (Playwright anchor extraction) ---
// Apple's public API is locked (401). Instead we render the search page and
// scrape real /en-us/details/{id}/{slug} anchor hrefs.
const APPLE_SEARCHES = [
  { label: "LA",       url: "https://jobs.apple.com/en-us/search?location=los-angeles-metro-area-LAMETRO&sort=newest" },
  { label: "Bay Area", url: "https://jobs.apple.com/en-us/search?location=san-francisco-bay-area-SFMETRO&sort=newest" },
];

// Apple posts the same role to multiple regions with URL pattern
// /details/{job_id}-{region_suffix}/{slug} — e.g., 200662035-0670 (LA) and
// 200662035-0836 (Bay Area) are the same role. Extract the job_id so we
// dedup across LA + Bay Area searches AND across runs (against scan-history).
function appleJobId(url) {
  const m = url.match(/jobs\.apple\.com\/[^/]+\/details\/(\d+)-/);
  return m ? m[1] : null;
}

async function fetchAppleJobs(browser, seen, candidates) {
  // Pre-build a job-id dedup set from the historical seen URLs so a role
  // already added under one region suffix is skipped when the other region's
  // search surfaces it.
  const appleSeenIds = new Set();
  for (const url of seen) {
    const id = appleJobId(url);
    if (id) appleSeenIds.add(id);
  }

  for (const q of APPLE_SEARCHES) {
    let page;
    try {
      page = await browser.newPage();
      await page.goto(q.url, { waitUntil: "networkidle", timeout: 25000 });
      await page.waitForTimeout(2000);
      const links = await page
        .evaluate(() => {
          const out = [];
          // Only select job title links in H3 tags within job-title-link containers
          // This filters out "See full role description" and "Where we're hiring" links
          for (const a of document.querySelectorAll('h3 > a[href*="/en-us/details/"]')) {
            const href = a.href;
            const title = (a.textContent || "").replace(/\s+/g, " ").trim();
            if (title.length >= 5 && title.length <= 160) out.push({ href, title });
          }
          return out;
        })
        .catch(() => []);
      let matchCount = 0;
      for (const { href, title } of links) {
        const clean = cleanJobTitle(title);
        if (!href || seen.has(href)) continue;
        const id = appleJobId(href);
        if (id && appleSeenIds.has(id)) continue;
        if (matchesFilter(clean, "Apple")) {
          candidates.push({ company: "Apple", title: clean, url: href, source: `Apple Playwright (${q.label})` });
          seen.add(href);
          if (id) appleSeenIds.add(id);
          matchCount++;
        }
      }
      log(`  Apple (PW "${q.label}"): ${links.length} links, ${matchCount} role matches`);
    } catch (e) {
      log(`  ERROR Apple PW "${q.label}": ${e.message.substring(0, 80)}`);
    } finally {
      await page?.close().catch(() => {});
    }
  }
}

// --- Meta (Playwright + GraphQL response capture) ---
// Meta's careers page renders job cards from a private GraphQL query and does
// not expose useful anchors in the initial HTML. Capture the same anonymous
// response the official page uses. The page is sorted newest-first so the first
// page works as an incremental feed; historical URLs in `seen` provide dedup.
async function fetchMetaJobs(browser, seen, candidates) {
  const page = await browser.newPage();
  try {
    const response = await captureResponseDuringNavigation(
      page,
      (response) => {
        if (!response.url().includes("/graphql")) return false;
        const postData = response.request().postData() || "";
        return postData.includes("CareersJobSearchResultsV2DataQuery");
      },
      { timeout: 30000 },
      "https://www.metacareers.com/jobsearch/?sort_by_new=true",
      {
      waitUntil: "domcontentloaded",
      timeout: 30000,
      },
    );
    const data = await response.json();
    const jobs = data?.data?.job_search_with_featured_jobs_v2?.all_jobs || [];
    let matchCount = 0;
    for (const job of jobs) {
      const title = cleanJobTitle(job.title || "");
      const id = String(job.id || "").trim();
      const location = Array.isArray(job.locations) ? job.locations.join("; ") : "";
      if (!id) continue;
      const url = `https://www.metacareers.com/jobs/${id}/`;
      if (seen.has(url)) continue;
      if (matchesFilter(title, "Meta", location)) {
        candidates.push({ company: "Meta", title, url, location, source: "Meta GraphQL" });
        seen.add(url);
        matchCount++;
      }
    }
    log(`  Meta (GraphQL): ${jobs.length} newest jobs, ${matchCount} role matches`);
  } catch (e) {
    log(`  ERROR Meta GraphQL: ${e.message.substring(0, 80)}`);
  } finally {
    await page.close().catch(() => {});
  }
}

async function fetchCDSnapshots(seen, candidates) {
  for (const [company, uuid, sourceUrl] of CD_WATCHES) {
    try {
      const resp = await fetch(`${CD_API}/watch/${uuid}/history/latest`, {
        headers: { "x-api-key": CD_KEY },
        signal: AbortSignal.timeout(10000),
      });
      if (!resp.ok) { log(`  ${company} (CD): HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      // Each line in the snapshot is potentially a job title (changedetection extracts via CSS selectors)
      const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 8 && l.length < 120);
      let matchCount = 0;
      for (const rawTitle of lines) {
        const title = cleanJobTitle(rawTitle);
        // Skip lines that are clearly not job titles
        if (/^\d+$/.test(title) || title.startsWith("Filter") || title.startsWith("Clear") || title.startsWith("Refine")) continue;
        // Reject requirement/qualification bullets scraped from the same page.
        // These look like job titles but are really descriptions of the role, not its name.
        if (/^\*/.test(title)) continue;                                    // "* Bullet text"
        if (/^\d+\+?\s*(years?|months?)\b/i.test(title)) continue;          // "5+ years ..."
        if (/\byears? of\b/i.test(title)) continue;                         // "... years of X"
        if (/^Experience\s+(as|with|in|leading|building|developing)\b/i.test(title)) continue;
        if (/^(Bachelor|Master|MBA|PhD|Degree\b)/i.test(title)) continue;
        if (/^(Proficiency|Knowledge|Understanding|Familiarity|Ability)\s+(with|in|of)\b/i.test(title)) continue;
        if (!matchesFilter(title, company)) continue;
        // Build a synthetic URL from the source URL + title slug (for dedup)
        const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 60);
        const dedupKey = `${sourceUrl}#${slug}`;
        if (seen.has(dedupKey)) continue;
        candidates.push({ company, title, url: dedupKey, source: `ChangeDetection (${company})` });
        seen.add(dedupKey);
        matchCount++;
      }
      log(`  ${company} (CD): ${lines.length} lines, ${matchCount} role matches`);
    } catch (e) {
      log(`  ERROR ${company} CD: ${e.message.substring(0, 60)}`);
    }
  }
}

// --- Main scan ---
async function runScan() {
  const seen = loadSeenUrls();
  log(`Starting scan — ${seen.size} URLs in dedup set`);

  const browser = await chromium.launch({ headless: true });
  const candidates = [];
  const freshnessCutoff = Date.now() - FRESHNESS_HOURS * 60 * 60 * 1000;

  // Greenhouse APIs — use first_published (initial post date) not updated_at (which is
  // touched on every reindex and is useless for freshness detection).
  for (const [company, apiUrl] of GREENHOUSE_APIS) {
    try {
      const apiUrlWithContent = apiUrl + (apiUrl.includes("?") ? "&" : "?") + "content=true";
      // Plain fetch, not Playwright: boards-api.greenhouse.io is a pure JSON API
      // and needs no JS to render (mirrors the Ashby fix in f574b34). Driving it
      // through page.goto was the source of the recurring
      // "page.goto: Timeout 15000ms exceeded" failures.
      const resp = await fetch(apiUrlWithContent, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) { log(`  ERROR ${company} (Greenhouse): HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      // A dead/renamed board slug returns 200-shaped JSON without a `jobs` array
      // (or a 404 body). `data.jobs || []` silently degraded that to "0 total",
      // so a board could be broken for weeks while still logging a clean run.
      // Treat a missing jobs array as a hard error instead.
      if (!Array.isArray(data.jobs)) {
        log(`  ERROR ${company} (Greenhouse): no jobs array — board slug may be dead/renamed`);
        continue;
      }
      const jobs = data.jobs;
      let freshCount = 0;
      for (const job of jobs) {
        const title = cleanJobTitle(job.title || "");
        const url = job.absolute_url || "";
        const location = job.location?.name || "";
        const firstPublished = job.first_published ? new Date(job.first_published).getTime() : 0;
        if (!url || seen.has(url)) continue;
        if (!firstPublished || firstPublished < freshnessCutoff) continue; // stale — skip
        if (matchesFilter(title, company, location)) {
          candidates.push({ company, title, url, location, source: "Greenhouse API" });
          seen.add(url);
          freshCount++;
        }
      }
      log(`  ${company} (Greenhouse): ${jobs.length} total, ${freshCount} fresh matches`);
    } catch (e) {
      log(`  ERROR ${company} Greenhouse: ${e.message.substring(0, 80)}`);
    }
  }

  // Ashby boards via public posting API — uses publishedAt for freshness.
  // 30s timeout: OpenAI's 661-job response is ~2-3 MB JSON and exceeded a 15s
  // budget under load.
  for (const [company, slug] of ASHBY_BOARDS) {
    try {
      const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${slug}?includeCompensation=true`;
      const resp = await fetch(apiUrl, { signal: AbortSignal.timeout(30000) });
      if (!resp.ok) { log(`  ERROR ${company} (Ashby): HTTP ${resp.status}`); continue; }
      const data = await resp.json();
      const jobs = data.jobs || [];
      let freshCount = 0;
      for (const job of jobs) {
        if (job.isListed === false) continue;
        const title = cleanJobTitle(job.title || "");
        const url = job.jobUrl || job.applyUrl || "";
        const location = job.location || "";
        const firstPublished = job.publishedAt ? new Date(job.publishedAt).getTime() : 0;
        if (!url || seen.has(url)) continue;
        if (!firstPublished || firstPublished < freshnessCutoff) continue;
        if (matchesFilter(title, company, location)) {
          candidates.push({ company, title, url, location, source: "Ashby API" });
          seen.add(url);
          freshCount++;
        }
      }
      log(`  ${company} (Ashby): ${jobs.length} total, ${freshCount} fresh matches`);
    } catch (e) {
      log(`  ERROR ${company} (Ashby): ${e.message.substring(0, 80)}`);
    }
  }

  // Workday public CXS API (Unity) — replaces the dead unity3d Greenhouse board.
  await fetchWorkdayBoards(seen, candidates);

  // Lever public API (Spotify, Palantir, Mistral) — real per-job hostedUrl values.
  await fetchLeverBoards(seen, candidates);

  // Amazon public search API — real /en/jobs/{id}/{slug} URLs.
  await fetchAmazonJobs(seen, candidates);

  // Snap public API — real Workday URLs.
  await fetchSnapJobs(seen, candidates);

  // Apple via Playwright anchor extraction — real /en-us/details/{id}/{slug} URLs.
  await fetchAppleJobs(browser, seen, candidates);

  // Meta official careers GraphQL response — newest page, real job-detail URLs.
  await fetchMetaJobs(browser, seen, candidates);

  // Google careers via server-rendered HTML — real /jobs/results/{id}-{slug} URLs.
  await fetchGoogleJobs(seen, candidates);

  // ChangeDetection.io snapshots — CD_WATCHES is now empty (all sources migrated
  // to direct APIs / Playwright / HTML). Kept for future SPA additions.
  await fetchCDSnapshots(seen, candidates);

  log(`Raw candidates after title filter: ${candidates.length}`);

  // Safety cap: wider net (20+ sources) generates 50-70 on first seed run.
  // Genuine filter leaks produce 300+. Cap at 100 to allow seeding while catching leaks.
  const MAX_CANDIDATES = 100;
  if (candidates.length > MAX_CANDIDATES) {
    log(`ABORT: ${candidates.length} candidates exceeds safety cap (${MAX_CANDIDATES}). Filter likely too loose — not persisting or notifying.`);
    await browser.close();
    return [];
  }

  // Verify liveness (skip CD-sourced jobs — already rendered by changedetection.io's browser)
  const verified = [];
  for (const job of candidates) {
    if (job.source.startsWith("ChangeDetection")) {
      verified.push({ ...job, location: "-" });
      continue;
    }
    let page;
    try {
      page = await browser.newPage();
      await page.goto(job.url, { waitUntil: "domcontentloaded", timeout: 12000 });
      await page.waitForTimeout(1500);
      const text = await page.innerText("body").catch(() => "");
      const lower = text.toLowerCase();
      const closed =
        lower.includes("no longer open") ||
        lower.includes("no longer available") ||
        lower.includes("job not found") ||
        lower.includes("page not found") ||
        lower.includes("oh snap");
      const hasApply = lower.includes("apply");
      if (!closed && hasApply) {
        // Tighter location regex. The previous version greedily captured up
        // to 30 chars after the city name, which on Apple Maps pages produced
        // garbage like "San Francisco, review the description". Now we only
        // accept an optional ", {Capitalized region}" suffix — lowercase
        // prose ("review the …") fails to match and the city stands alone.
        const CITY_RE = /\b(Remote(?:\s*-\s*[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)?|Cupertino|Sunnyvale|Santa Clara|San Francisco|San Jose|Palo Alto|Mountain View|Bay Area|Los Angeles|Culver City|Austin|Seattle|New York|Boston|London|Paris|Tokyo|Munich|Singapore)(?:,\s+(?:[A-Z]{2,3}|United States|United Kingdom|California|Washington|Texas|Massachusetts|New York))?\b/i;
        const locMatch = text.match(CITY_RE);
        const loc = locMatch ? locMatch[0].trim() : (job.location || "-");
        verified.push({ ...job, location: loc });
      }
    } catch {
      // skip failures silently
    } finally {
      await page?.close().catch(() => {});
    }
  }

  await browser.close();
  log(`Verified active: ${verified.length}`);
  return verified;
}

// --- Write new jobs to dedup sources ---
function persistNewJobs(jobs) {
  if (jobs.length === 0) return;

  const today = new Date().toISOString().slice(0, 10);

  // Append to scan-history.tsv
  const historyRows = jobs
    .map((j) => `${j.url}\t${today}\t${j.source}\t${j.title}\t${j.company}\tadded`)
    .join("\n") + "\n";
  appendFileSync(HISTORY_PATH, historyRows);

  // Append to pipeline.md under "## Pendientes"
  const pipelineLines = jobs
    .map((j) => `- [ ] ${j.url} | ${j.company} | ${j.title}`)
    .join("\n") + "\n";

  const raw = readFileSync(PIPELINE_PATH, "utf-8");
  const idx = raw.indexOf("## Procesadas");
  if (idx === -1) {
    // Fallback: append at end of Pendientes section
    writeFileSync(PIPELINE_PATH, raw.trimEnd() + "\n" + pipelineLines);
  } else {
    const before = raw.slice(0, idx).trimEnd() + "\n" + pipelineLines + "\n";
    const after = raw.slice(idx);
    writeFileSync(PIPELINE_PATH, before + after);
  }

  log(`Persisted ${jobs.length} new jobs to scan-history.tsv + pipeline.md`);
}

// --- Telegram notification ---
// Enriches each job with fit score + scraped location/salary and renders
// card-style HTML: title is the link, metadata on a second line.
function escapeTgHtml(s = "") {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function loadJsonSafe(p) {
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return {}; }
}

function fitBadge(score) {
  if (score == null) return "⚪";
  if (score >= 4.0) return "🟢";
  if (score >= 3.0) return "🟡";
  return "🔴";
}

function formatScanMessage(jobs) {
  const fitScores = loadJsonSafe(join(__dirname, "data/fit-scores.json"));
  const liveness  = loadJsonSafe(join(__dirname, "web/.liveness.json"));
  const cards = jobs.slice(0, 10).map((j) => {
    const fit = fitScores[j.url]?.score;
    const live = liveness[j.url] || {};
    const loc  = live.location || j.location || "—";
    const sal  = live.salary || "—";
    const fitText = fit != null ? `Fit ${fit.toFixed(1)}` : "Fit —";
    const meta = [
      escapeTgHtml(j.company),
      fitText,
      escapeTgHtml(loc),
      escapeTgHtml(sal),
    ].join(" · ");
    return `${fitBadge(fit)} <a href="${escapeTgHtml(j.url)}">${escapeTgHtml(j.title)}</a>\n   ${meta}`;
  });
  const extra = jobs.length > 10 ? `\n\n…and ${jobs.length - 10} more` : "";
  return `${jobs.length} new role${jobs.length === 1 ? "" : "s"} matching your filter:\n\n${cards.join("\n\n")}${extra}\n\nRun /career-ops pipeline to evaluate.`;
}

// Read Telegram notification preferences from profile.yml.
// Roles below min_score are skipped, but `notify_unscored` can keep alerts
// flowing when the local fit scorer is temporarily offline.
function telegramPrefs() {
  try {
    const p = yaml.load(readFileSync(PROFILE_PATH, "utf-8"));
    const tg = p?.notifications?.telegram || {};
    const minScore = typeof tg.min_score === "number"
      ? tg.min_score
      : (typeof tg.notify_on?.min_score === "number" ? tg.notify_on.min_score : 4.0);
    const notifyUnscored = tg.notify_unscored === true || tg.notify_on?.notify_unscored === true;
    return { minScore, notifyUnscored };
  } catch {
    return { minScore: 4.0, notifyUnscored: false };
  }
}

function notifyTelegram(jobs) {
  if (jobs.length === 0) {
    log("No new jobs — silent (no notification)");
    return;
  }

  const fitScores = loadJsonSafe(join(__dirname, "data/fit-scores.json"));
  const liveness  = loadJsonSafe(join(__dirname, "web/.liveness.json"));
  const { minScore, notifyUnscored } = telegramPrefs();

  // Belt-and-suspenders location filter: the scan-time filter checks the
  // location known upfront, but post-verification can pick up a location that
  // wasn't visible then. Use the same US-eligibility helper so multi-region
  // roles ("London; New York, NY") survive and only pure-foreign ones drop.
  const locationFilter = (j) => {
    const text = `${j.location || ""} ${liveness[j.url]?.location || ""}`;
    return isUsEligibleLocation(text);
  };
  const usEligible = jobs.filter(locationFilter);
  const droppedLocation = jobs.length - usEligible.length;
  if (droppedLocation > 0) {
    log(`Location filter dropped ${droppedLocation} non-US jobs from Telegram push`);
  }

  const passed = usEligible.filter((j) => {
    const s = fitScores[j.url]?.score;
    if (typeof s === "number") return s >= minScore;
    return notifyUnscored;
  });
  const filteredOut = usEligible.length - passed.length;
  const unscoredIncluded = passed.filter((j) => typeof fitScores[j.url]?.score !== "number").length;

  if (passed.length === 0) {
    const reason = notifyUnscored
      ? `all below min_score ${minScore}`
      : `all below min_score ${minScore} or unscored`;
    log(`No notification — ${usEligible.length} US-eligible jobs ${reason}`);
    return;
  }

  const msg = formatScanMessage(passed);
  const result = spawnSync("node", [join(__dirname, "notify-telegram.mjs"), "scan", msg], {
    encoding: "utf-8",
  });

  if (result.status === 0) {
    log(`Telegram sent: ${passed.length} jobs (${filteredOut} filtered below ${minScore}, ${unscoredIncluded} unscored included)`);
  } else {
    log(`Telegram FAILED: ${result.stderr || result.stdout}`);
  }
}

// --- Run ---
try {
  const verified = await runScan();
  persistNewJobs(verified);
  log(`Scan complete`);

  // Auto-verify pipeline liveness — non-fatal. Re-checks URLs that are
  // stale (>6h) so the web dashboard stays fresh without a manual click.
  log(`Running auto-verify on pipeline URLs...`);
  const verifyResult = spawnSync(
    "node",
    [join(__dirname, "web/auto-verify.mjs"), "--max", "60", "--age", "6"],
    { encoding: "utf-8", timeout: 600000 },
  );
  if (verifyResult.stdout) {
    for (const line of verifyResult.stdout.split("\n")) {
      if (line.trim()) log(`  ${line.replace(/^\[[^\]]+\]\s*/, '')}`);
    }
  }
  if (verifyResult.status !== 0 && verifyResult.stderr) {
    log(`auto-verify warning: ${verifyResult.stderr.slice(0, 200)}`);
  }

  // Salary enrichment via ATS APIs (Ashby/Lever/Greenhouse) + Browserless
  // (Google/Apple). Much more reliable than regex on rendered SPAs.
  log(`Running salary enrichment...`);
  const enrichResult = spawnSync(
    "node",
    [join(__dirname, "web/enrich-salary.mjs")],
    { encoding: "utf-8", timeout: 600000 },
  );
  if (enrichResult.stdout) {
    for (const line of enrichResult.stdout.split("\n")) {
      if (line.trim()) log(`  ${line.replace(/^\[[^\]]+\]\s*/, '')}`);
    }
  }
  if (enrichResult.status !== 0 && enrichResult.stderr) {
    log(`enrich-salary warning: ${enrichResult.stderr.slice(0, 200)}`);
  }

  // Qwen city classification — writes cityBuckets onto liveness entries so
  // the dashboard's city filter doesn't rely on brittle regex.
  log(`Running city classifier...`);
  const cityResult = spawnSync(
    "node",
    [join(__dirname, "city-classify.mjs")],
    { encoding: "utf-8", timeout: 600000 },
  );
  if (cityResult.stdout) {
    for (const line of cityResult.stdout.split("\n")) {
      if (line.trim()) log(`  ${line.replace(/^\[[^\]]+\]\s*/, '')}`);
    }
  }

  // Qwen per-URL fit scoring against config/profile.yml.
  log(`Running fit scorer...`);
  const fitResult = spawnSync(
    "node",
    [join(__dirname, "fit-score.mjs")],
    { encoding: "utf-8", timeout: 900000 },
  );
  if (fitResult.stdout) {
    for (const line of fitResult.stdout.split("\n")) {
      if (line.trim()) log(`  ${line.replace(/^\[[^\]]+\]\s*/, '')}`);
    }
  }

  // Portal health watchdog — flags portals with 0 successful runs in last 7
  // days and (with --fix) invokes `claude -p` to investigate. The script has
  // its own 24h throttle per portal so re-running every scan is cheap unless
  // something is genuinely broken.
  log(`Running portal health watchdog...`);
  const healthResult = spawnSync(
    "node",
    [join(__dirname, "portal-health.mjs"), "--fix"],
    { encoding: "utf-8", timeout: 1800000 }, // 30min budget for claude CLI
  );
  if (healthResult.stdout) {
    for (const line of healthResult.stdout.split("\n")) {
      if (line.trim()) log(`  ${line.replace(/^\[portal-health\]\s*/, '')}`);
    }
  }
  if (healthResult.status !== 0 && healthResult.stderr) {
    log(`portal-health warning: ${healthResult.stderr.slice(0, 200)}`);
  }

  // Send Telegram notification LAST — so fit-score / salary / location enrichment
  // has finished and the message can include all fields.
  notifyTelegram(verified);
} catch (err) {
  log(`FATAL: ${err.message}`);
  process.exit(1);
}
