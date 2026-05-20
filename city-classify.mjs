#!/usr/bin/env node

/**
 * city-classify.mjs — Classify every unique location string in the liveness
 * cache into US city buckets via local Qwen. Writes `cityBuckets: [...]`
 * back into each liveness entry so the web dashboard can filter without
 * brittle regex.
 *
 * Bucket keys match web/public/app.js CITY_BUCKETS:
 *   remote, la, bay, nyc, seattle, boston, austin, chicago, denver,
 *   dc, atlanta, miami, portland, other-us, intl
 *
 * Usage:
 *   node city-classify.mjs            # classify unclassified entries
 *   node city-classify.mjs --redo     # reclassify everything
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { qwenUrl } from './infra-config.mjs';

const LIVE = 'web/.liveness.json';
// Local Qwen endpoint from config/profile.yml (gitignored) or env QWEN_URL.
const QWEN = qwenUrl();
const MODEL = 'qwen3:14b-16k';
const PARALLEL = 6;
const REDO = process.argv.includes('--redo');

const BUCKETS = {
  remote:   'Remote / work from home / no specific location',
  la:       'Los Angeles metro (LA, Culver City, Santa Monica, Playa Vista, Venice, Burbank, Glendale, Pasadena)',
  bay:      'SF Bay Area (SF, Oakland, Berkeley, Palo Alto, Mountain View, Sunnyvale, San Jose, Cupertino, Menlo Park, Fremont, Santa Clara, San Bruno, Redwood City, Emeryville)',
  nyc:      'NYC metro (Manhattan, Brooklyn, Queens, New York)',
  seattle:  'Seattle metro (Seattle, Bellevue, Redmond, Kirkland)',
  boston:   'Boston metro (Boston, Cambridge MA, Somerville)',
  austin:   'Austin, TX',
  chicago:  'Chicago, IL',
  denver:   'Denver / Boulder, CO',
  dc:       'DC metro (Washington DC, Arlington, McLean, Reston VA)',
  atlanta:  'Atlanta, GA',
  miami:    'Miami / Fort Lauderdale, FL',
  portland: 'Portland, OR',
  'other-us':'Any OTHER US location (e.g. Dallas, Houston, Phoenix, Minneapolis, Nashville, Raleigh, Philadelphia) that is NOT one of the specific buckets above',
  intl:     'Explicitly non-US (London, Paris, Tokyo, Bengaluru, etc.)',
};

const PROMPT_HEAD = `You are a US-city classifier for job postings. Given a location string (often a semicolon-separated list of cities), return a JSON array of bucket keys the location matches. A single job can match multiple buckets (e.g. a "SF; NYC" posting returns ["bay","nyc"]).

RULES:
- Use the specific city bucket when the city is named, NOT "other-us".
- "other-us" is ONLY for US locations that don't match any specific bucket above.
- "intl" ONLY when the location is explicitly non-US with NO US component.
- If a location has both US and non-US parts (e.g. "London; SF"), include only the US buckets — the US coverage is what matters to the user.
- Unknown / empty / ambiguous → return [].

BUCKET DEFINITIONS:
${Object.entries(BUCKETS).map(([k, v]) => `- "${k}": ${v}`).join('\n')}

EXAMPLES:
Location: "Los Angeles, CA, USA; Mountain View, CA, USA; New York, NY, USA; San Francisco, CA, USA"
Output: ["la","bay","nyc"]

Location: "Sunnyvale, CA, USA; Kirkland, WA, USA; San Francisco, CA, USA"
Output: ["bay","seattle"]

Location: "Culver City, California, United States"
Output: ["la"]

Location: "Dallas, TX"
Output: ["other-us"]

Location: "London, UK"
Output: ["intl"]

Location: "London; San Francisco"
Output: ["bay"]

Location: "Remote"
Output: ["remote"]

Location: "Bellevue, Washington, USA"
Output: ["seattle"]

Location: ""
Output: []

NOW CLASSIFY:`;

function buildPrompt(loc) {
  return `${PROMPT_HEAD}\nLocation: ${JSON.stringify(loc)}\nReturn ONLY a JSON array of bucket keys on one line.`;
}

async function qwen(prompt) {
  const r = await fetch(QWEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, think: false, keep_alive: '5m' }),
    signal: AbortSignal.timeout(60_000),
  });
  const d = await r.json();
  return d.response || '';
}

const VALID = new Set(Object.keys(BUCKETS));
function parse(text) {
  const m = text.match(/\[[^\]]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const filtered = arr.filter(x => typeof x === 'string' && VALID.has(x));
    return filtered;
  } catch { return null; }
}

function log(m) { console.log(`[${new Date().toISOString()}] city-classify: ${m}`); }

async function main() {
  if (!existsSync(LIVE)) { log(`no ${LIVE}`); process.exit(1); }
  const cache = JSON.parse(await readFile(LIVE, 'utf-8'));

  // Collect unique location strings that need classification
  const byLoc = new Map(); // location string → [urls]
  for (const [url, v] of Object.entries(cache)) {
    if (!v) continue;
    if (!REDO && Array.isArray(v.cityBuckets)) continue;
    const loc = (v.location || '').trim();
    if (!byLoc.has(loc)) byLoc.set(loc, []);
    byLoc.get(loc).push(url);
  }

  const unique = [...byLoc.keys()];
  if (!unique.length) { log('nothing to classify'); return; }
  log(`classifying ${unique.length} unique locations covering ${[...byLoc.values()].reduce((a, b) => a + b.length, 0)} URLs`);

  const classified = {}; // location → buckets[]
  const queue = [...unique];
  let ok = 0, fail = 0;
  async function worker() {
    while (queue.length) {
      const loc = queue.shift();
      if (!loc) { classified[loc] = []; ok++; continue; }
      try {
        const resp = await qwen(buildPrompt(loc));
        const buckets = parse(resp);
        if (buckets != null) {
          classified[loc] = buckets;
          ok++;
        } else {
          classified[loc] = [];
          fail++;
        }
      } catch (e) {
        classified[loc] = [];
        fail++;
      }
      if ((ok + fail) % 10 === 0) log(`progress ${ok + fail}/${unique.length} (ok=${ok} fail=${fail})`);
    }
  }
  await Promise.all(Array.from({ length: PARALLEL }, worker));

  // Write cityBuckets back onto each URL entry
  for (const [loc, urls] of byLoc.entries()) {
    const buckets = classified[loc] || [];
    for (const url of urls) cache[url].cityBuckets = buckets;
  }

  await writeFile(LIVE, JSON.stringify(cache, null, 0));
  log(`done: ${ok} classified, ${fail} failed. Wrote cityBuckets on ${[...byLoc.values()].reduce((a,b)=>a+b.length,0)} URLs.`);

  // Sanity distribution
  const dist = {};
  for (const v of Object.values(cache)) for (const b of (v?.cityBuckets || [])) dist[b] = (dist[b] || 0) + 1;
  log('distribution: ' + Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}:${n}`).join(' '));
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
