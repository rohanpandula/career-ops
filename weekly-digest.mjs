#!/usr/bin/env node

/**
 * weekly-digest.mjs — Generate a markdown digest summarizing the past 7 days.
 *
 * Numbers are computed deterministically from scan-history.tsv,
 * applications.md, fit-scores.json, and web/.liveness.json.
 * Narrative + recommended action come from local Qwen given the numbers.
 *
 * Cache: data/digest/YYYY-MM-DD.md (Monday of that week, ISO).
 *
 * Usage:
 *   node weekly-digest.mjs           # this week's Monday
 *   node weekly-digest.mjs --redo    # overwrite if already exists
 *   node weekly-digest.mjs --week 2026-04-06   # specific Monday
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname } from 'path';

const APPS = 'data/applications.md';
const PIPE = 'data/pipeline.md';
const SCAN = 'data/scan-history.tsv';
const FIT  = 'data/fit-scores.json';
const LIVE = 'web/.liveness.json';
const OUTDIR = 'data/digest';

const QWEN = 'http://10.0.0.3:11434/api/generate';
const MODEL = 'hf.co/bartowski/cerebras_Qwen3-Coder-REAP-25B-A3B-GGUF:Q4_K_M';

const args = process.argv.slice(2);
const REDO = args.includes('--redo');
function flag(name, dflt) { const i = args.indexOf(name); return i === -1 ? dflt : args[i + 1]; }

function log(m) { console.log(`[${new Date().toISOString()}] weekly-digest: ${m}`); }

function ymd(d) { return d.toISOString().slice(0, 10); }
function mondayOf(date) {
  const d = new Date(date.getTime());
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const offset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + offset);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}
function addDays(d, n) { const o = new Date(d); o.setUTCDate(o.getUTCDate() + n); return o; }

function parseTsv(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const head = lines[0].split('\t');
  return lines.slice(1).map(l => {
    const c = l.split('\t');
    const o = {}; head.forEach((h, i) => o[h] = c[i] || ''); return o;
  });
}

function parseApps(md) {
  const lines = md.split('\n').filter(l => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const headers = lines[0].split('|').slice(1, -1).map(s => s.trim());
  return lines.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(s => s.trim());
    const o = {}; headers.forEach((h, i) => o[h] = cells[i] || ''); return o;
  }).filter(r => r['#']);
}

function parsePipeline(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+) \| ([^|]+) \| (.+)$/);
    if (m) out.push({ checked: m[1] === 'x', url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
  }
  return out;
}

async function qwen(prompt, timeoutMs = 90_000) {
  const r = await fetch(QWEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, keep_alive: -1 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`qwen HTTP ${r.status}`);
  return (await r.json()).response || '';
}

function aggregate(scan, apps, pipeline, fit, live, weekStart, weekEnd) {
  // Numeric facts
  const newUrls = scan.filter(r => r.first_seen >= ymd(weekStart) && r.first_seen <= ymd(weekEnd));
  const newLiveUrls = newUrls.filter(r => live[r.url]?.live === true);

  // Top 5 NEW 4+ fits this week (live + fit>=4 + first_seen this week)
  const top4 = [];
  for (const r of newLiveUrls) {
    const f = fit[r.url];
    if (!f || typeof f.score !== 'number' || f.score < 4) continue;
    const title = (live[r.url]?.jobTitle || r.title || '').trim();
    // Skip JD-bullet "titles" and search-result anchor URLs that produce noise
    if (/^\*?\s*\d+\+\s*years/i.test(title)) continue;
    if (/^\*\s*Experience/i.test(title)) continue;
    if (!title) continue;
    if (/google\.com\/about\/careers\/applications\/jobs\/results\/?\?/.test(r.url)) continue;
    if (/amazon\.jobs\/en\/search\b/.test(r.url)) continue;
    top4.push({ url: r.url, company: r.company || '', title, score: f.score, reason: f.reason || '' });
  }
  top4.sort((a, b) => b.score - a.score);
  const top5 = top4.slice(0, 5);

  // Apps quiet >7 days: applied/responded but not interview/offer/rejected, last update > 7d ago
  const today = new Date();
  const quiet = [];
  const moving = [];
  for (const a of apps) {
    const status = (a.Status || '').toLowerCase();
    const dateStr = a.Date || '';
    if (!dateStr) continue;
    const dt = new Date(dateStr + 'T00:00:00Z');
    const ageDays = (today - dt) / (1000 * 60 * 60 * 24);
    if (status === 'applied' && ageDays > 7) {
      quiet.push({ company: a.Company, role: a.Role, date: a.Date, ageDays: Math.round(ageDays) });
    }
    if (status === 'responded' || status === 'interview' || status === 'offer') {
      moving.push({ company: a.Company, role: a.Role, status: a.Status, date: a.Date });
    }
  }

  // Pipeline overall snapshot
  const pendingLive = pipeline.filter(p => !p.checked && live[p.url]?.live === true).length;
  const pendingFit4 = pipeline.filter(p => !p.checked && live[p.url]?.live === true && fit[p.url]?.score >= 4).length;
  const pendingFit45 = pipeline.filter(p => !p.checked && live[p.url]?.live === true && fit[p.url]?.score >= 4.5).length;

  return {
    week: { start: ymd(weekStart), end: ymd(weekEnd) },
    new_urls_total: newUrls.length,
    new_urls_live: newLiveUrls.length,
    top5_new_fit4_plus: top5,
    quiet_applications: quiet,
    moving_applications: moving,
    pipeline_snapshot: {
      pending_live: pendingLive,
      pending_fit_4_plus: pendingFit4,
      pending_fit_4_5_plus: pendingFit45,
    },
  };
}

function buildPrompt(facts) {
  return `You are writing a short weekly job-search digest narrative for the user. The numbers below are the ground truth — DO NOT contradict, inflate, or fabricate them. Reference roles by company + title. Keep the whole narrative under 350 words.

HARD CONSTRAINTS (do not violate):
- NEVER mention Meta, xAI, or X AI as a recommendation. The user has hard-excluded these companies.
- DO NOT recommend Director / Head / VP / Chief level roles. The user targets PM / Senior PM IC level.
- DO NOT invent roles, companies, or numbers not in the ground truth below.

WEEK: ${facts.week.start} → ${facts.week.end}

GROUND-TRUTH FACTS:
- New URLs scanned this week: ${facts.new_urls_total} (${facts.new_urls_live} confirmed live)
- Pipeline snapshot: ${facts.pipeline_snapshot.pending_live} live pending, ${facts.pipeline_snapshot.pending_fit_4_plus} with fit≥4, ${facts.pipeline_snapshot.pending_fit_4_5_plus} with fit≥4.5
- Top-5 new fit≥4 this week:
${facts.top5_new_fit4_plus.length
  ? facts.top5_new_fit4_plus.map(t => `  - ${t.company} — ${t.title} (${t.score.toFixed(1)}/5): ${t.reason}`).join('\n')
  : '  (none)'}
- Applications quiet >7 days (status=Applied):
${facts.quiet_applications.length
  ? facts.quiet_applications.map(q => `  - ${q.company} — ${q.role} (applied ${q.date}, ${q.ageDays}d ago)`).join('\n')
  : '  (none)'}
- Applications moving forward (Responded / Interview / Offer):
${facts.moving_applications.length
  ? facts.moving_applications.map(m => `  - ${m.company} — ${m.role} (${m.status}, ${m.date})`).join('\n')
  : '  (none)'}

WRITE EXACTLY THESE SECTIONS as plain markdown:

## TL;DR
One sentence summarizing pipeline health and the single most important thing this week.

## New this week
2-3 sentences on volume + standout new role(s). Reference at least one specific company+title from the top-5 list.

## Quiet applications
If quiet list is non-empty, name each one and suggest a follow-up touch (e.g. "ping recruiter", "ask warm intro"). If empty, write "None — all recent applications still inside the 7-day window."

## Moving forward
Note any responded/interview/offer items by company+title. If empty, write "Nothing in active interview yet."

## One recommended action
ONE concrete action for the upcoming week. Pick from THIS list ONLY:
- A specific top-5 role (apply / triage / evaluate by Friday)
- One specific quiet-application company (re-engage)
- One specific moving-forward company (prep for next stage)
- If all three lists are empty: "Triage the {N} fit≥4 backlog — pick the 3 strongest and apply this week."
Be specific — name a company or category, not "consider applying more". E.g. "Apply to Snowflake Senior PM Applied AI before Friday — fit 4.5, JD asks for agentic AI which CollectiveX directly demonstrates."

Return ONLY the markdown body. No preamble. No fenced code blocks. Total under 350 words.`;
}

function postValidate(text, facts) {
  // Light defensive check: ensure all numbers Qwen cites match facts.
  // We just append a quiet integrity tag if narrative omits the headline numbers.
  const issues = [];
  if (!text.includes(`${facts.new_urls_total}`) && facts.new_urls_total > 0) {
    issues.push('narrative did not reference total new URLs');
  }
  if (facts.top5_new_fit4_plus.length && !facts.top5_new_fit4_plus.some(t => text.includes(t.company))) {
    issues.push('narrative did not reference any top-5 company');
  }
  return issues;
}

async function main() {
  const today = new Date();
  const weekArg = flag('--week', null);
  const monday = weekArg ? mondayOf(new Date(weekArg + 'T00:00:00Z')) : mondayOf(today);
  const sunday = addDays(monday, 6);
  const outPath = `${OUTDIR}/${ymd(monday)}.md`;

  if (!REDO && existsSync(outPath)) {
    log(`exists: ${outPath} — pass --redo to regenerate`);
    return;
  }

  await mkdir(dirname(outPath), { recursive: true });

  const scan = parseTsv(await readFile(SCAN, 'utf-8'));
  const apps = parseApps(await readFile(APPS, 'utf-8'));
  const pipeline = parsePipeline(await readFile(PIPE, 'utf-8'));
  const fit = JSON.parse(await readFile(FIT, 'utf-8'));
  const live = JSON.parse(await readFile(LIVE, 'utf-8'));

  const facts = aggregate(scan, apps, pipeline, fit, live, monday, sunday);
  log(`week ${facts.week.start}..${facts.week.end}: ${facts.new_urls_total} new URLs, ${facts.top5_new_fit4_plus.length} top fits, ${facts.quiet_applications.length} quiet apps, ${facts.moving_applications.length} moving apps`);

  let narrative = '';
  let issues = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1 ? buildPrompt(facts)
      : buildPrompt(facts) + `\n\nPREVIOUS ATTEMPT had issues: ${issues.join('; ')}. Fix them.`;
    try {
      narrative = (await qwen(prompt)).trim();
      // Strip any accidental code fences
      narrative = narrative.replace(/^```\w*\n?|```$/g, '').trim();
      issues = postValidate(narrative, facts);
      if (issues.length === 0 || facts.top5_new_fit4_plus.length === 0) break;
      log(`attempt ${attempt}: ${issues.join(' / ')}`);
    } catch (e) {
      log(`attempt ${attempt} failed: ${e.message}`);
    }
  }

  // Compose final markdown
  const header = `# Weekly digest — ${facts.week.start} → ${facts.week.end}

_Generated ${new Date().toISOString()} by weekly-digest.mjs_

`;
  const factsBlock = `

---

## Numbers (deterministic)

| metric | value |
|---|---:|
| New URLs scanned | ${facts.new_urls_total} |
| New URLs confirmed live | ${facts.new_urls_live} |
| Pending live pipeline | ${facts.pipeline_snapshot.pending_live} |
| Pending fit ≥ 4 | ${facts.pipeline_snapshot.pending_fit_4_plus} |
| Pending fit ≥ 4.5 | ${facts.pipeline_snapshot.pending_fit_4_5_plus} |
| Applications quiet > 7d | ${facts.quiet_applications.length} |
| Applications moving forward | ${facts.moving_applications.length} |

### Top-5 new fit ≥ 4 this week
${facts.top5_new_fit4_plus.length
  ? facts.top5_new_fit4_plus.map((t, i) => `${i + 1}. **${t.company}** — ${t.title} (${t.score.toFixed(1)}/5)\n   ${t.url}`).join('\n')
  : '_None._'}

${issues.length ? `\n_Note: narrative validator flagged: ${issues.join('; ')}_\n` : ''}`;

  const finalMd = header + narrative + factsBlock;
  await writeFile(outPath, finalMd);
  log(`wrote ${outPath} (${finalMd.length} chars)`);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
