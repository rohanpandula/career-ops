#!/usr/bin/env node

/**
 * cluster-roles.mjs — Cluster live pending pipeline URLs with fit>=3.5
 * into 6-10 semantic clusters using local Qwen.
 *
 * Strategy: hierarchical.
 *   1. Group input by company.
 *   2. Companies with >=12 items get sub-clustered by Qwen (product/org lines).
 *   3. Companies with 3-11 items become their own cluster, named by Qwen.
 *   4. Tail (<3-item companies) pooled and named together.
 *   5. Merge smallest clusters if total count exceeds 10.
 *
 * Cache: data/clusters.json
 *
 * Usage:
 *   node cluster-roles.mjs
 *   node cluster-roles.mjs --redo       # ignore cache
 *   node cluster-roles.mjs --min 3.5    # override fit floor
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const PIPE = 'data/pipeline.md';
const LIVE = 'web/.liveness.json';
const FIT  = 'data/fit-scores.json';
const OUT  = 'data/clusters.json';
const QWEN_URL = 'http://10.0.0.3:11434/api/generate';
const MODEL = 'hf.co/bartowski/cerebras_Qwen3-Coder-REAP-25B-A3B-GGUF:Q4_K_M';

const args = process.argv.slice(2);
const REDO = args.includes('--redo');
function parseFlag(name, dflt) {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  return args[i + 1] ?? dflt;
}
const MIN = parseFloat(parseFlag('--min', '3.5'));
const SUB_SPLIT_AT = 15;  // split companies of >= this many items
const MAX_CLUSTERS = 10;
const MIN_CLUSTERS = 6;
const MAX_PER_CLUSTER = 25;

function log(m) { console.log(`[${new Date().toISOString()}] cluster-roles: ${m}`); }

function parsePipeline(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+) \| ([^|]+) \| (.+)$/);
    if (m) out.push({ checked: m[1] === 'x', url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
  }
  return out;
}

async function qwen(prompt, timeoutMs = 120_000) {
  const r = await fetch(QWEN_URL, {
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
  const candidate = fence ? fence[1] : text;
  for (let i = 0; i < candidate.length; i++) {
    if (candidate[i] !== '{') continue;
    let depth = 0;
    for (let j = i; j < candidate.length; j++) {
      if (candidate[j] === '{') depth++;
      else if (candidate[j] === '}') { depth--; if (depth === 0) { try { return JSON.parse(candidate.slice(i, j + 1)); } catch {} break; } }
    }
  }
  return null;
}

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }

// Split one big company's postings into 2-4 sub-clusters by product/org line.
async function subSplit(company, items) {
  const n = items.length;
  const targetK = Math.max(2, Math.min(4, Math.ceil(n / 18)));
  const list = items.map((j, i) => `${i}. ${j.title}${j.location ? ` — ${j.location}` : ''}`).join('\n');
  const prompt = `Split these ${n} ${company} job postings into ${targetK} semantic sub-clusters by PRODUCT/ORG LINE (e.g. "Google Cloud AI PM", "Google YouTube partnerships", "Google DeepMind research", "Google Ads platform PM"; "Amazon AWS AI/ML PM", "Amazon Alexa & devices PM", "Amazon Advertising PM").

HARD REQUIREMENTS:
- Exactly ${targetK} sub-clusters.
- Every index 0..${n - 1} appears in EXACTLY ONE sub-cluster.
- Each sub-cluster has at least 2 items.
- Each sub-cluster name STARTS WITH "${company}" and names a specific product line or slice.
- Sub-cluster names MUST be distinguishable — no generic "Product Manager" or "Engineering".

POSTINGS:
${list}

Return ONLY JSON: {"sub": [{"name":"${company} ...","indices":[...]}, ...]}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await qwen(prompt);
      const parsed = extractJson(resp);
      if (!parsed?.sub || !Array.isArray(parsed.sub) || parsed.sub.length < 2) continue;
      // Dedupe + validate
      const seen = new Set();
      const clean = [];
      let hadBadShape = false;
      for (const sub of parsed.sub) {
        if (!sub?.name || !Array.isArray(sub.indices)) { hadBadShape = true; break; }
        const kept = [];
        for (const idx of sub.indices) {
          if (!Number.isInteger(idx) || idx < 0 || idx >= n || seen.has(idx)) continue;
          seen.add(idx);
          kept.push(idx);
        }
        if (kept.length) clean.push({ name: String(sub.name).trim(), indices: kept });
      }
      if (hadBadShape || clean.length < 2) continue;

      // Auto-heal: assign missing indices to the best-fit cluster by token overlap with cluster name.
      const missing = [];
      for (let i = 0; i < n; i++) if (!seen.has(i)) missing.push(i);
      if (missing.length) {
        log(`  subSplit ${company}: auto-healed ${missing.length} missing indices`);
        const score = (idx, clusterName) => {
          const name = clusterName.toLowerCase();
          const title = items[idx].title.toLowerCase();
          let s = 0;
          for (const tok of name.split(/[^a-z0-9]+/).filter(t => t.length > 2)) if (title.includes(tok)) s++;
          return s;
        };
        for (const idx of missing) {
          let best = 0, bestS = -1;
          for (let c = 0; c < clean.length; c++) {
            const s = score(idx, clean[c].name);
            if (s > bestS || (s === bestS && clean[c].indices.length < clean[best].indices.length)) { best = c; bestS = s; }
          }
          clean[best].indices.push(idx);
        }
      }
      // Every sub must still have ≥2
      if (clean.every(s => s.indices.length >= 2)) {
        return clean.map(s => ({ name: s.name, items: s.indices.map(i => items[i]) }));
      }
    } catch (e) {
      log(`  subSplit ${company} attempt ${attempt} error: ${e.message}`);
    }
  }
  // Fallback: title-prefix groups
  log(`  subSplit ${company} failed — splitting by title keyword`);
  const buckets = new Map();
  for (const it of items) {
    const key = (it.title.match(/(Cloud|Ads|Play|Search|YouTube|Chrome|Android|AI|ML|DeepMind|Partnerships|AWS|Alexa|Advertising|Prime|Logistics|Kindle|Devices)/i)?.[1] || 'Other');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(it);
  }
  // Merge tail into biggest
  const list2 = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  while (list2.length > targetK) {
    const [, small] = list2.pop();
    list2[0][1].push(...small);
  }
  return list2.map(([k, arr]) => ({ name: `${company} ${k === 'Other' ? 'other' : k} roles`, items: arr }));
}

// Name a single-company cluster.
async function nameCluster(company, items) {
  if (items.length === 0) return `${company} roles`;
  const titles = items.map(i => `- ${i.title}`).slice(0, 20).join('\n');
  const prompt = `Give ONE short (3-8 word) specific cluster name for these ${items.length} ${company} job postings. The name must START with "${company}" and name the product/domain theme.

Examples of good names: "Anthropic applied AI + solutions", "Databricks lakehouse & GenAI PM", "NVIDIA CUDA inference platform SA"
Examples of bad names: "${company} Product Manager", "${company} roles", "${company} AI"

POSTINGS:
${titles}

Return ONLY the name as plain text, no quotes, no JSON.`;
  try {
    const resp = await qwen(prompt, 60_000);
    let name = resp.trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '').replace(/^(name|answer|output)\s*[:=]\s*/i, '').trim();
    // Strip any leading/trailing markdown
    name = name.replace(/^\*+|\*+$/g, '').trim();
    if (!name || name.length > 80) return `${company} roles`;
    if (!name.toLowerCase().includes(company.toLowerCase().split(/\s+/)[0])) {
      name = `${company} — ${name}`;
    }
    return name;
  } catch {
    return `${company} roles`;
  }
}

// Name a mixed (tail) cluster.
async function nameTailCluster(items) {
  const titles = items.map(i => `- [${i.company}] ${i.title}`).slice(0, 25).join('\n');
  const prompt = `Give ONE short (3-8 word) specific cluster name for this mixed bag of ${items.length} job postings from different companies. The name should describe what they share (role family, industry slice, or seniority). No company names.

Examples of good names: "Small-AI-startup PM & DevRel", "Gaming & XR partnerships", "Developer platform solutions architects"
Examples of bad names: "Other roles", "Various companies", "Miscellaneous"

POSTINGS:
${titles}

Return ONLY the name as plain text, no quotes, no JSON.`;
  try {
    const resp = await qwen(prompt, 60_000);
    let name = resp.trim().split('\n')[0].replace(/^["'`]|["'`]$/g, '').replace(/^(name|answer|output)\s*[:=]\s*/i, '').trim();
    name = name.replace(/^\*+|\*+$/g, '').trim();
    if (!name || name.length > 80) return 'Other roles (small-count companies)';
    return name;
  } catch {
    return 'Other roles (small-count companies)';
  }
}

async function main() {
  if (!existsSync(PIPE)) { log(`no ${PIPE}`); process.exit(1); }
  if (!existsSync(LIVE)) { log(`no ${LIVE}`); process.exit(1); }
  if (!existsSync(FIT)) { log(`no ${FIT}`); process.exit(1); }

  const pipeline = parsePipeline(await readFile(PIPE, 'utf-8'));
  const liveness = JSON.parse(await readFile(LIVE, 'utf-8'));
  const fit = JSON.parse(await readFile(FIT, 'utf-8'));

  const items = [];
  for (const p of pipeline) {
    if (p.checked) continue;
    const l = liveness[p.url];
    if (!l || l.live !== true) continue;
    const f = fit[p.url];
    if (!f || typeof f.score !== 'number' || f.score < MIN) continue;
    items.push({ url: p.url, company: p.company, title: l.jobTitle || p.role, location: l.location || '', score: f.score });
  }
  if (!items.length) { log('no candidates'); return; }
  log(`clustering ${items.length} URLs (fit>=${MIN})`);

  // Cache check
  if (!REDO && existsSync(OUT)) {
    const cached = JSON.parse(await readFile(OUT, 'utf-8'));
    if (cached?.generatedFor === items.length && Date.now() - new Date(cached.generatedAt).getTime() < 24 * 3600 * 1000) {
      log(`cache fresh (${cached.clusters.length} clusters, ${cached.generatedFor} items) — pass --redo to recluster`);
      return;
    }
  }

  // 1. Group by company
  const byCo = new Map();
  for (const it of items) {
    if (!byCo.has(it.company)) byCo.set(it.company, []);
    byCo.get(it.company).push(it);
  }
  const sorted = [...byCo.entries()].sort((a, b) => b[1].length - a[1].length);
  log(`companies: ${sorted.length}, top: ${sorted.slice(0, 5).map(([c, l]) => `${c}(${l.length})`).join(', ')}`);

  // 2. Build clusters
  const clusters = []; // { name, items }
  const tailItems = [];
  for (const [co, arr] of sorted) {
    if (arr.length >= SUB_SPLIT_AT) {
      log(`sub-splitting ${co} (${arr.length} items)`);
      const subs = await subSplit(co, arr);
      // Re-name each sub-cluster so the name reflects the actual contents
      // post-auto-heal (Qwen's initial label may not match the final item set).
      for (const s of subs) {
        const renamed = await nameCluster(co, s.items);
        clusters.push({ name: renamed, items: s.items });
      }
    } else if (arr.length >= 3) {
      const name = await nameCluster(co, arr);
      clusters.push({ name, items: arr });
    } else {
      tailItems.push(...arr);
    }
  }

  // 3. Handle tail
  if (tailItems.length >= 3) {
    if (tailItems.length <= 25) {
      const name = await nameTailCluster(tailItems);
      clusters.push({ name, items: tailItems });
    } else {
      // Split tail into chunks ≤25
      const chunks = [];
      for (let i = 0; i < tailItems.length; i += 20) chunks.push(tailItems.slice(i, i + 20));
      for (let i = 0; i < chunks.length; i++) {
        const name = await nameTailCluster(chunks[i]);
        clusters.push({ name: chunks.length > 1 ? `${name} (${i + 1})` : name, items: chunks[i] });
      }
    }
  } else if (tailItems.length) {
    // <3 tail items: merge into smallest existing cluster
    clusters.sort((a, b) => a.items.length - b.items.length);
    if (clusters.length) clusters[0].items.push(...tailItems);
  }

  // 4. Enforce ≤MAX_CLUSTERS by merging. Prefer to merge clusters that share
  // a company prefix (e.g. two Amazon clusters); otherwise merge smallest-pair.
  while (clusters.length > MAX_CLUSTERS) {
    clusters.sort((a, b) => a.items.length - b.items.length);
    // Find two smallest that share a company prefix
    let ai = 0, bi = 1;
    outer: for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const ap = clusters[i].items[0]?.company || '';
        const bp = clusters[j].items[0]?.company || '';
        if (ap && ap === bp && clusters[i].items.length + clusters[j].items.length <= MAX_PER_CLUSTER) {
          ai = i; bi = j; break outer;
        }
      }
    }
    const a = clusters[ai];
    const b = clusters[bi];
    clusters.splice(Math.max(ai, bi), 1);
    clusters.splice(Math.min(ai, bi), 1);
    const ap = a.items[0]?.company;
    const bp = b.items[0]?.company;
    const mergedItems = [...a.items, ...b.items];
    // Re-name the merged cluster so the label matches the combined set
    const mergedName = (ap && ap === bp)
      ? await nameCluster(ap, mergedItems)
      : await nameTailCluster(mergedItems);
    clusters.push({ name: mergedName, items: mergedItems });
  }

  // 5. Split any cluster > 25 by title alpha order
  for (let i = 0; i < clusters.length; i++) {
    if (clusters[i].items.length > 25) {
      const c = clusters[i];
      const sorted = [...c.items].sort((a, b) => a.title.localeCompare(b.title));
      const half = Math.ceil(sorted.length / 2);
      clusters[i] = { name: `${c.name} (A-M)`, items: sorted.slice(0, half) };
      clusters.push({ name: `${c.name} (N-Z)`, items: sorted.slice(half) });
    }
  }

  // 6. If under MIN_CLUSTERS, leave as-is (rare — means fewer than ~15 scored items).
  if (clusters.length < MIN_CLUSTERS) log(`warning: only ${clusters.length} clusters (min target ${MIN_CLUSTERS})`);

  // Enrich & persist
  const enriched = clusters
    .sort((a, b) => b.items.length - a.items.length)
    .map((c, i) => ({
      id: `c${i + 1}-${slug(c.name)}`,
      name: c.name,
      count: c.items.length,
      urls: c.items.map(it => it.url),
      sampleTitles: c.items.slice(0, 3).map(it => `${it.company} — ${it.title}`),
    }));

  const payload = {
    generatedAt: new Date().toISOString(),
    generatedFor: items.length,
    minScore: MIN,
    clusters: enriched,
  };
  await writeFile(OUT, JSON.stringify(payload, null, 2));
  log(`wrote ${OUT}: ${enriched.length} clusters covering ${items.length} URLs`);
  for (const c of enriched) log(`  - ${c.name} (${c.count})`);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
