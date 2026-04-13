#!/usr/bin/env node

/**
 * find-duplicates.mjs — Detect near-duplicate pipeline URLs (same role posted
 * at multiple URLs — e.g. Ashby + direct domain + greenhouse jid proxy).
 *
 * Strategy:
 *   1. Group live URLs by company.
 *   2. For each within-company pair, compute a cheap title-token Jaccard.
 *      Only candidate pairs (>=0.4) are sent to Qwen.
 *   3. Qwen returns {same: bool, confidence: 0-1, reason: "..."} per pair.
 *   4. Conservative: only pairs marked same with confidence>=0.7 are kept.
 *   5. Build canonical/duplicates groups via union-find.
 *
 * Output: data/dedupe.json
 *   [{ canonical: <url>, duplicates: [<url>, ...], reason: "..." }, ...]
 *
 * Cache (data/dedupe-cache.json): per-pair verdicts, idempotent.
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { createHash } from 'crypto';

const PIPE = 'data/pipeline.md';
const LIVE = 'web/.liveness.json';
const FIT  = 'data/fit-scores.json';
const OUT  = 'data/dedupe.json';
const CACHE = 'data/dedupe-cache.json';
const QWEN = 'http://10.0.0.3:11434/api/generate';
const MODEL = 'hf.co/bartowski/cerebras_Qwen3-Coder-REAP-25B-A3B-GGUF:Q4_K_M';
const PARALLEL = 6;

const args = process.argv.slice(2);
const REDO = args.includes('--redo');
const JACCARD_MIN = 0.5;
const CONFIDENCE_MIN = 0.85;
// URLs that are search-result anchors (not real job pages) are noisy and
// produce false-positive duplicates. Skip them entirely.
function isAnchorUrl(url) {
  if (/google\.com\/about\/careers\/applications\/jobs\/results\/?\?/.test(url)) return true;
  if (/amazon\.jobs\/en\/search\b/.test(url)) return true;
  return false;
}

function log(m) { console.log(`[${new Date().toISOString()}] find-duplicates: ${m}`); }

function parsePipeline(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+) \| ([^|]+) \| (.+)$/);
    if (m) out.push({ checked: m[1] === 'x', url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
  }
  return out;
}

function tokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .split(/\s+/)
      .filter(t => t.length >= 3 && !STOP.has(t))
  );
}

const STOP = new Set([
  'and', 'the', 'for', 'with', 'manager', 'senior', 'principal', 'staff', 'lead',
  'sr', 'product', 'engineer', 'engineering', 'team', 'group', 'remote', 'usa',
  'tech', 'technical', 'iii', 'ii', 'amazon', 'google',
]);

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union ? inter / union : 0;
}

function pairKey(u1, u2) {
  return [u1, u2].sort().join('||');
}
function pairHash(key) {
  return createHash('sha1').update(key).digest('hex').slice(0, 12);
}

async function qwen(prompt, timeoutMs = 60_000) {
  const r = await fetch(QWEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, keep_alive: -1 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`qwen HTTP ${r.status}`);
  return (await r.json()).response || '';
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

function buildPrompt(a, b) {
  return `You are a STRICT, CONSERVATIVE duplicate detector for job postings at the SAME company. The default answer is same=false. Only mark same=true when the two URLs almost certainly point to the SAME job opening (one canonical role mirrored across ATS systems or accidentally cross-posted), not just two roles in the same family.

REQUIRE for same=true:
- Same product/team/scope (not just same product line at different layers)
- Same seniority level (Senior ≠ Staff ≠ Principal ≠ Director)
- Same job function (PM ≠ TPM ≠ Engineer ≠ Solutions Architect)
- Title differences must be cosmetic (trailing whitespace, "(Remote)" suffix, "I/II" level, location appended)
- Different ATS host but same job ID semantics, OR identical title at one company

DEFAULT TO same=false WHEN:
- Titles share keywords but describe different products, teams, or surfaces (e.g. "PM, Cloud Run" vs "PM, Cloud SQL" — different products)
- Two roles in the same product line at different seniorities (e.g. "Senior PM, X" vs "Staff PM, X")
- Two roles in different geographic regions but appear to be DIFFERENT headcounts (e.g. Anthropic Paris and Anthropic Munich research scientist roles — these are separate openings)
- One role is a search-result anchor / fragment URL — these are not real job pages
- Either title is a JD bullet ("5+ years of product management") rather than a real role name

POSTING A:
  url:   ${a.url}
  title: ${a.title}
  loc:   ${a.location || 'unknown'}

POSTING B:
  url:   ${b.url}
  title: ${b.title}
  loc:   ${b.location || 'unknown'}

Return ONLY JSON: {"same": <bool>, "confidence": <0..1>, "reason": "<one short sentence>"}
Confidence < 0.85 means we WILL NOT trust same=true. Be honest about confidence.`;
}

async function classify(a, b) {
  try {
    const resp = await qwen(buildPrompt(a, b));
    const parsed = extractJson(resp);
    if (!parsed) return { same: false, confidence: 0, reason: 'parse error' };
    const same = parsed.same === true;
    const conf = Math.max(0, Math.min(1, parseFloat(parsed.confidence ?? 0)));
    const reason = String(parsed.reason || '').slice(0, 160);
    return { same, confidence: conf, reason };
  } catch (e) {
    return { same: false, confidence: 0, reason: `err: ${e.message}` };
  }
}

class UnionFind {
  constructor() { this.parent = new Map(); }
  find(x) {
    if (!this.parent.has(x)) { this.parent.set(x, x); return x; }
    let r = this.parent.get(x);
    while (r !== this.parent.get(r)) r = this.parent.get(r);
    let cur = x;
    while (cur !== r) { const nxt = this.parent.get(cur); this.parent.set(cur, r); cur = nxt; }
    return r;
  }
  union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

async function main() {
  const pipeline = parsePipeline(await readFile(PIPE, 'utf-8'));
  const liveness = JSON.parse(await readFile(LIVE, 'utf-8'));
  const fit = existsSync(FIT) ? JSON.parse(await readFile(FIT, 'utf-8')) : {};

  const cache = !REDO && existsSync(CACHE) ? JSON.parse(await readFile(CACHE, 'utf-8')) : {};

  const items = [];
  for (const p of pipeline) {
    if (p.checked) continue;
    if (isAnchorUrl(p.url)) continue; // skip noisy search-result fragments
    const l = liveness[p.url];
    if (!l || l.live !== true) continue;
    const title = (l.jobTitle || p.role || '').trim();
    // Reject "titles" that look like JD bullets (e.g. "5+ years of...")
    if (/^\*?\s*\d+\+\s*years/i.test(title)) continue;
    if (/^\*\s*Experience/i.test(title)) continue;
    items.push({ url: p.url, company: p.company, title, location: l.location || '', score: fit[p.url]?.score ?? null });
  }

  log(`scanning ${items.length} live URLs`);

  // Group by company
  const byCo = new Map();
  for (const it of items) {
    if (!byCo.has(it.company)) byCo.set(it.company, []);
    byCo.get(it.company).push(it);
  }

  // Build candidate pairs by token Jaccard >= JACCARD_MIN
  const pairs = [];
  for (const [co, arr] of byCo.entries()) {
    if (arr.length < 2) continue;
    const tokensFor = arr.map(it => tokens(it.title));
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const j_score = jaccard(tokensFor[i], tokensFor[j]);
        if (j_score >= JACCARD_MIN) {
          pairs.push({ a: arr[i], b: arr[j], jaccard: +j_score.toFixed(2), key: pairKey(arr[i].url, arr[j].url) });
        }
      }
    }
  }
  log(`${pairs.length} candidate pairs after Jaccard>=${JACCARD_MIN}`);

  // Run Qwen on uncached pairs
  const queue = pairs.filter(p => REDO || !cache[p.key]);
  log(`${queue.length} pairs need Qwen verdict (cache hits: ${pairs.length - queue.length})`);

  let done = 0, same = 0, diff = 0;
  let flushTimer = null;
  const flush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => { flushTimer = null; await writeFile(CACHE, JSON.stringify(cache, null, 2)); }, 2000);
  };

  const local = [...queue];
  async function worker() {
    while (local.length) {
      const p = local.shift();
      const v = await classify(p.a, p.b);
      cache[p.key] = { ...v, jaccard: p.jaccard, a: { url: p.a.url, title: p.a.title }, b: { url: p.b.url, title: p.b.title }, classifiedAt: new Date().toISOString() };
      if (v.same && v.confidence >= CONFIDENCE_MIN) same++; else diff++;
      done++;
      if (done % 10 === 0) log(`progress ${done}/${queue.length} (same=${same} diff=${diff})`);
      flush();
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (flushTimer) clearTimeout(flushTimer);
  await writeFile(CACHE, JSON.stringify(cache, null, 2));

  // Build groups via union-find on confident-same pairs
  const uf = new UnionFind();
  for (const p of pairs) {
    const v = cache[p.key];
    if (v?.same && v.confidence >= CONFIDENCE_MIN) uf.union(p.a.url, p.b.url);
  }

  // Collect groups
  const groups = new Map();
  for (const p of pairs) {
    const v = cache[p.key];
    if (!(v?.same && v.confidence >= CONFIDENCE_MIN)) continue;
    for (const url of [p.a.url, p.b.url]) {
      const root = uf.find(url);
      if (!groups.has(root)) groups.set(root, new Set());
      groups.get(root).add(url);
    }
  }

  // Conservative: if a group has >=4 URLs, require that EVERY pair within
  // the group was confidently classified as same. This guards against
  // chained false positives (A=B and B=C wrongly merging A with C).
  for (const [root, set] of [...groups.entries()]) {
    if (set.size < 4) continue;
    const urls = [...set];
    let allConfirmed = true;
    for (let i = 0; i < urls.length && allConfirmed; i++) {
      for (let j = i + 1; j < urls.length; j++) {
        const v = cache[pairKey(urls[i], urls[j])];
        if (!(v?.same && v.confidence >= CONFIDENCE_MIN)) { allConfirmed = false; break; }
      }
    }
    if (!allConfirmed) {
      log(`  pruning group of ${urls.length} (transitive closure incomplete) — likely false-positive cascade`);
      groups.delete(root);
    }
  }

  // Pick canonical: prefer the URL whose host is the company's own domain over a job-board mirror.
  // Heuristic: shortest path, then non-greenhouse/lever/ashby host.
  function canonicalScore(url) {
    let s = 0;
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workday|myworkday/i.test(url)) s += 3;
    if (/job-boards/.test(url)) s += 1;
    s += url.length / 200; // prefer shorter
    return s;
  }

  const out = [];
  for (const set of groups.values()) {
    const urls = [...set];
    urls.sort((a, b) => canonicalScore(a) - canonicalScore(b));
    const canonical = urls[0];
    const duplicates = urls.slice(1);
    // Aggregate reason from the first pair that linked them
    const reasons = pairs
      .filter(p => set.has(p.a.url) && set.has(p.b.url) && cache[p.key]?.same && cache[p.key]?.confidence >= CONFIDENCE_MIN)
      .map(p => cache[p.key].reason)
      .slice(0, 1);
    out.push({ canonical, duplicates, count: urls.length, reason: reasons[0] || 'qwen judgment' });
  }

  await writeFile(OUT, JSON.stringify(out, null, 2));
  log(`wrote ${OUT}: ${out.length} dup-groups covering ${out.reduce((a, g) => a + g.duplicates.length + 1, 0)} URLs`);
  for (const g of out.slice(0, 10)) log(`  - ${g.canonical} <- ${g.duplicates.length} dup(s)`);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
