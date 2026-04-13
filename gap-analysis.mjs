#!/usr/bin/env node

/**
 * gap-analysis.mjs — For each live pending URL with fit>=4.0, render the JD
 * via Unraid Browserless, then ask local Qwen to compare the JD against
 * cv.md + modes/_profile.md and return:
 *   {matches: [...], gaps: [...], must_explain: [...]}
 *
 * Cache: data/gap-analysis.json keyed by URL.
 *
 * Usage:
 *   node gap-analysis.mjs
 *   node gap-analysis.mjs --max 30
 *   node gap-analysis.mjs --redo
 *   node gap-analysis.mjs --min 4.0
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

const PIPE = 'data/pipeline.md';
const LIVE = 'web/.liveness.json';
const FIT  = 'data/fit-scores.json';
const OUT  = 'data/gap-analysis.json';
const CV   = 'cv.md';
const PROFILE = 'modes/_profile.md';

const QWEN = 'http://10.0.0.3:11434/api/generate';
const MODEL = 'hf.co/bartowski/cerebras_Qwen3-Coder-REAP-25B-A3B-GGUF:Q4_K_M';
const BROWSERLESS = 'http://10.0.0.100:3012/content?token=2BR6DgQzZL8md4Bk5rewy3K9k';
const PARALLEL = 4;

const args = process.argv.slice(2);
const REDO = args.includes('--redo');
function flag(name, dflt) { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; }
const MAX = parseInt(flag('--max', '500'), 10);
const MIN = parseFloat(flag('--min', '4.0'));

function log(m) { console.log(`[${new Date().toISOString()}] gap-analysis: ${m}`); }
function urlHash(url) { return createHash('sha1').update(url).digest('hex').slice(0, 12); }

function parsePipeline(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+) \| ([^|]+) \| (.+)$/);
    if (m) out.push({ checked: m[1] === 'x', url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
  }
  return out;
}

async function fetchJobText(url) {
  // First attempt: networkidle2 (waits for low network activity).
  // Many ATSes (Workday, Greenhouse SPA) need extra time post-load to hydrate.
  for (const opts of [
    { waitUntil: 'networkidle2', timeout: 25_000 },
    { waitUntil: 'networkidle0', timeout: 35_000 },
  ]) {
    try {
      const r = await fetch(BROWSERLESS, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, gotoOptions: opts, waitForTimeout: 1500 }),
        signal: AbortSignal.timeout(opts.timeout + 15_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      const text = htmlToText(html);
      if (text && text.length >= 400) return text;
    } catch (e) {
      // try next strategy
    }
  }
  throw new Error('all fetch strategies returned <400 chars');
}

function htmlToText(html) {
  // Drop scripts/styles/svg/header/footer first
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ');
  // Newlines around block elements
  s = s.replace(/<\/(p|div|li|h[1-6]|ul|ol|tr|td|th|section|article|main)>/gi, '\n')
       .replace(/<br\s*\/?>/gi, '\n');
  // Strip tags
  s = s.replace(/<[^>]+>/g, ' ');
  // HTML entities (basic)
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"');
  // Collapse whitespace
  s = s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

async function qwen(prompt, timeoutMs = 120_000) {
  const r = await fetch(QWEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, keep_alive: -1 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`qwen HTTP ${r.status}`);
  const d = await r.json();
  return d.response || '';
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const cand = fence ? fence[1] : text;
  for (let i = 0; i < cand.length; i++) {
    if (cand[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < cand.length; j++) {
      if (cand[j] === '{') depth++;
      else if (cand[j] === '}') { depth--; if (depth === 0) { try { return JSON.parse(cand.slice(i, j + 1)); } catch {} break; } }
    }
  }
  return null;
}

function buildPrompt(cv, profile, job) {
  // Trim JD to focus prompt on responsibilities + qualifications
  let jd = job.text || '';
  if (jd.length > 6000) jd = jd.slice(0, 6000);

  return `You compare a job description against a candidate's CV and profile, then return a strict JSON gap analysis.

CANDIDATE CV (markdown):
"""
${cv.slice(0, 3500)}
"""

CANDIDATE PROFILE NOTES (preferences, archetypes, no-go's):
"""
${profile.slice(0, 2000)}
"""

JOB DESCRIPTION (extracted text from the posting):
Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'unknown'}
"""
${jd}
"""

ANALYSIS RULES — read carefully:
1. \`matches\`: SPECIFIC technologies, frameworks, products, or domains required by the JD AND demonstrably present in the CV. CONCRETE NOUNS ONLY (e.g. "Kubernetes", "RAG pipelines", "BigQuery", "Stripe payments", "developer SDKs", "AR/VR hardware"). FORBIDDEN: any item containing "leadership", "execution", "mindset", "thinker", "thinking", "go-to-market", "customer impact", "commercialization", "strategy", "ownership", or any role title (Manager, Engineer, Director, Lead, Architect). If CV doesn't actually show it, do not include it.
2. \`gaps\`: SPECIFIC required-or-strongly-preferred skills the JD asks for that are NOT present in the CV. Same constraint — concrete technologies/products/domains only. Do NOT list role titles like "Senior Product Manager" as gaps; the job title is implied.
3. \`must_explain\`: 1-4 items written as full short sentences in the form "no formal X, but did Y at company/scale". Cite the closest analogue from the CV. Skip if there's a perfect match.
4. Each item in \`matches\` and \`gaps\` must be 1-6 words. NO sentences. NO hedging language ("possibly", "may have").
5. If the JD text is too short / a 404 / a Cloudflare block / a login wall, set \`error\` and return empty arrays.

OUTPUT FORMAT — return ONLY a single JSON object, no prose, no fences:
{"matches": ["...", "..."], "gaps": ["...", "..."], "must_explain": ["...", "..."], "error": null}

If something blocks analysis, return:
{"matches": [], "gaps": [], "must_explain": [], "error": "<short reason>"}`;
}

const SOFT_SKILLS = new Set([
  'leadership', 'communication', 'collaboration', 'ownership', 'teamwork',
  'strategic thinking', 'problem solving', 'problem-solving', 'critical thinking',
  'time management', 'creativity', 'adaptability', 'mentorship', 'mentoring',
  'cross-functional', 'cross functional', 'interpersonal', 'analytical thinking',
  'execution', 'attention to detail', 'project management', 'strong written',
  'people management', 'thought leadership', 'sales leadership', 'product leadership',
  'data-driven execution', 'customer impact', 'global enterprise', 'cross-functional gtm',
  'ai commercialization', 'ai go-to-market', 'go-to-market', 'gtm strategy',
  'customer engagement', 'product manager', 'senior product manager',
  'staff product manager', 'principal product manager', 'product management',
]);
// Reject anything that looks like a job-title rather than a skill.
const TITLE_LIKE = /\b(manager|director|engineer|lead|head|architect|specialist|analyst|coordinator)\b/i;
// Vague-phrase rejector — anything that ends in one of these tokens is jargon,
// not a concrete skill. Catches "data-driven mindset", "ai-native thinker",
// "technical aptitude", "executive storytelling", "growth mindset", etc.
const VAGUE_TAILS = /\b(mindset|thinker|thinking|aptitude|storytelling|articulation|fluency|excellence|acumen|savvy|orientation|sensibility)\b/i;

function sanitize(arr, allowMustExplain = false) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => String(x || '').trim())
    .filter(x => x.length > 0 && x.length < (allowMustExplain ? 160 : 80))
    .filter(x => !SOFT_SKILLS.has(x.toLowerCase()))
    .filter(x => !VAGUE_TAILS.test(x))
    .filter(x => allowMustExplain || !TITLE_LIKE.test(x))
    .slice(0, 12);
}

function validate(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: false, reason: 'not object' };
  if (parsed.error) return { ok: true, value: { matches: [], gaps: [], must_explain: [], error: String(parsed.error).slice(0, 120) } };
  const matches = sanitize(parsed.matches);
  const gaps = sanitize(parsed.gaps);
  const must_explain = sanitize(parsed.must_explain, true);
  if (!matches.length && !gaps.length) return { ok: false, reason: 'empty matches+gaps' };
  return { ok: true, value: { matches, gaps, must_explain, error: null } };
}

async function analyze(job, cv, profile) {
  // Strip soft-skill responses; if Qwen returns mostly soft skills, retry once with a sterner prompt.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? buildPrompt(cv, profile, job)
      : buildPrompt(cv, profile, job) + '\n\nPREVIOUS ATTEMPT was filtered out as too generic. Be SPECIFIC — name technologies, frameworks, domains, products. NO soft skills.';
    try {
      const resp = await qwen(prompt);
      const parsed = extractJson(resp);
      const v = validate(parsed);
      if (v.ok) return v.value;
    } catch (e) {
      if (attempt === 2) return { matches: [], gaps: [], must_explain: [], error: `qwen: ${e.message}` };
    }
  }
  return { matches: [], gaps: [], must_explain: [], error: 'no usable JSON after 2 attempts' };
}

async function main() {
  const pipeline = parsePipeline(await readFile(PIPE, 'utf-8'));
  const liveness = JSON.parse(await readFile(LIVE, 'utf-8'));
  const fit = JSON.parse(await readFile(FIT, 'utf-8'));
  const cv = await readFile(CV, 'utf-8');
  const profile = existsSync(PROFILE) ? await readFile(PROFILE, 'utf-8') : '';

  const cache = existsSync(OUT) ? JSON.parse(await readFile(OUT, 'utf-8')) : {};

  const targets = [];
  for (const p of pipeline) {
    if (p.checked) continue;
    const l = liveness[p.url];
    if (!l || l.live !== true) continue;
    const f = fit[p.url];
    if (!f || typeof f.score !== 'number' || f.score < MIN) continue;
    if (!REDO && cache[p.url]?.matches) continue;
    targets.push({ url: p.url, company: p.company, title: l.jobTitle || p.role, location: l.location || '' });
    if (targets.length >= MAX) break;
  }

  if (!targets.length) { log('nothing to analyze'); return; }
  log(`analyzing ${targets.length} URLs (fit>=${MIN}, parallel=${PARALLEL})`);

  let done = 0, ok = 0, fetchFail = 0, qwenFail = 0;
  let flushTimer = null;
  const flush = async () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await writeFile(OUT, JSON.stringify(cache, null, 2));
    }, 2000);
  };

  const queue = [...targets];
  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      let text = '';
      try {
        text = await fetchJobText(job.url);
      } catch (e) {
        cache[job.url] = { matches: [], gaps: [], must_explain: [], error: `fetch: ${e.message}`, hash: urlHash(job.url), analyzedAt: new Date().toISOString() };
        fetchFail++; done++;
        flush();
        continue;
      }
      if (!text || text.length < 200) {
        cache[job.url] = { matches: [], gaps: [], must_explain: [], error: 'JD text too short', hash: urlHash(job.url), analyzedAt: new Date().toISOString() };
        fetchFail++; done++;
        flush();
        continue;
      }
      const result = await analyze({ ...job, text }, cv, profile);
      cache[job.url] = { ...result, hash: urlHash(job.url), title: job.title, company: job.company, analyzedAt: new Date().toISOString() };
      if (result.error) qwenFail++; else ok++;
      done++;
      if (done % 5 === 0) log(`progress ${done}/${targets.length} (ok=${ok} fetchFail=${fetchFail} qwenFail=${qwenFail})`);
      flush();
    }
  }

  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (flushTimer) clearTimeout(flushTimer);
  await writeFile(OUT, JSON.stringify(cache, null, 2));
  log(`done: ${ok} ok, ${fetchFail} fetch failed, ${qwenFail} qwen failed`);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
