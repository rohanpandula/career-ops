#!/usr/bin/env node

/**
 * infer-taste.mjs — Look at applications.md history (applied / rejected /
 * discarded / unmoved) plus current pipeline (high-fit unapplied) and
 * propose edits to modes/_profile.md that capture the user's taste.
 *
 * Output: data/taste-proposal.md (NOT auto-applied).
 * Apply via: POST /api/taste/accept (writes to modes/_profile.md after
 * archiving the previous version).
 *
 * Usage:
 *   node infer-taste.mjs
 *   node infer-taste.mjs --redo
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const APPS = 'data/applications.md';
const PIPE = 'data/pipeline.md';
const FIT  = 'data/fit-scores.json';
const LIVE = 'web/.liveness.json';
const PROFILE = 'modes/_profile.md';
const OUT  = 'data/taste-proposal.md';

const QWEN = 'http://10.0.0.3:11434/api/generate';
const MODEL = 'hf.co/bartowski/cerebras_Qwen3-Coder-REAP-25B-A3B-GGUF:Q4_K_M';

const args = process.argv.slice(2);
const REDO = args.includes('--redo');

function log(m) { console.log(`[${new Date().toISOString()}] infer-taste: ${m}`); }

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

async function qwen(prompt, timeoutMs = 120_000) {
  const r = await fetch(QWEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt, stream: false, keep_alive: -1 }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`qwen HTTP ${r.status}`);
  return (await r.json()).response || '';
}

function bucket(apps) {
  const out = { applied: [], rejected: [], interview: [], offer: [], discarded: [], skip: [], evaluated: [] };
  for (const a of apps) {
    const s = (a.Status || '').toLowerCase().trim();
    if (out[s]) out[s].push(a);
  }
  return out;
}

function buildPrompt(applied, rejected, discarded, skipped, highFitUnapplied, profile) {
  const fmtApp = a => `- [${a.Date}] ${a.Company} — ${a.Role} (${a.Score})${a.Notes ? ` | notes: ${a.Notes.slice(0, 200)}` : ''}`;
  const fmtFit = a => `- ${a.company} — ${a.title} (${a.score.toFixed(1)}/5)${a.reason ? ` — ${a.reason.slice(0, 120)}` : ''}`;

  return `You are a taste-inference assistant. Look at the user's job-application history and propose SPECIFIC, EVIDENCE-BACKED additions to their profile (modes/_profile.md). The profile is what the system uses to score, prioritize, and frame applications.

CRITICAL RULES:
1. Cite SPECIFIC evidence from the lists below. Format: "(evidence: Applied to Apple Agentic Commerce 2026-04-07, score 4.5)". A claim with no citation is rejected.
2. Do NOT propose edits that override or contradict any existing user-stated hard preferences (target roles, comp range, location policy, exclusion lists).
3. Only propose ADDITIONS or refinements — keep existing structure.
4. If evidence is weak (fewer than 2 supporting data points), say so explicitly: "(weak evidence — only 1 datum)".
5. Output ONLY a markdown patch in unified-diff-ish prose form (additions clearly labeled), not a raw diff. The user will read your prose and decide.

EVIDENCE — APPLIED (${applied.length}):
${applied.map(fmtApp).join('\n') || '(none)'}

EVIDENCE — REJECTED BY COMPANY (${rejected.length}):
${rejected.map(fmtApp).join('\n') || '(none)'}

EVIDENCE — DISCARDED BY USER (${discarded.length}):
${discarded.map(fmtApp).join('\n') || '(none)'}

EVIDENCE — MARKED SKIP (${skipped.length}):
${skipped.map(fmtApp).join('\n') || '(none)'}

CONTEXT — high-fit (≥4.5) roles user has NOT applied to (${highFitUnapplied.length}, sample):
${highFitUnapplied.slice(0, 15).map(fmtFit).join('\n') || '(none)'}

CURRENT PROFILE (modes/_profile.md):
"""
${profile.slice(0, 4000)}
"""

PROPOSE EDITS as markdown sections in this exact format:

## Proposal summary
2-3 bullets describing the patterns you noticed.

## Section: <name of profile section to edit>
Current state: <quote 1-2 lines from current profile>
Proposed addition: <2-4 lines of new text to add>
Evidence: <list specific datapoints you cited>

(Repeat the "## Section: …" block for each proposed edit. Maximum 3 sections.)

## Patterns I will NOT act on
- List any tempting patterns you considered but rejected because evidence was thin or it would override an existing preference.

If applied count is 0, return only "## Proposal summary\nInsufficient signal: 0 applications recorded. No edits proposed." and stop.

Return ONLY the markdown body, no preamble, no fences.`;
}

function validate(text, applied) {
  const issues = [];
  if (!text.includes('## Proposal summary')) issues.push('missing "Proposal summary"');
  // Each "Proposed addition" should have an "Evidence" line
  const sections = text.split(/^## Section:/m);
  for (let i = 1; i < sections.length; i++) {
    if (!/Evidence:/i.test(sections[i])) issues.push(`section ${i} missing Evidence line`);
  }
  // If applied > 0, must cite at least one applied company name in evidence
  if (applied.length > 0 && sections.length > 1) {
    const cited = applied.some(a => text.includes(a.Company));
    if (!cited) issues.push('no applied-company name appears in proposed text');
  }
  return issues;
}

async function main() {
  if (!REDO && existsSync(OUT)) {
    log(`exists: ${OUT} — pass --redo to regenerate`);
    return;
  }

  const apps = parseApps(await readFile(APPS, 'utf-8'));
  const pipeline = parsePipeline(await readFile(PIPE, 'utf-8'));
  const fit = JSON.parse(await readFile(FIT, 'utf-8'));
  const live = JSON.parse(await readFile(LIVE, 'utf-8'));
  const profile = await readFile(PROFILE, 'utf-8');

  const buckets = bucket(apps);

  const highFitUnapplied = [];
  const appliedUrls = new Set(); // (we don't track URL on apps, so this is a no-op)
  for (const p of pipeline) {
    if (p.checked) continue;
    if (live[p.url]?.live !== true) continue;
    const f = fit[p.url];
    if (!f || typeof f.score !== 'number' || f.score < 4.5) continue;
    highFitUnapplied.push({
      company: p.company,
      title: live[p.url]?.jobTitle || p.role,
      score: f.score,
      reason: f.reason || '',
    });
  }
  highFitUnapplied.sort((a, b) => b.score - a.score);

  log(`evidence: ${buckets.applied.length} applied, ${buckets.rejected.length} rejected, ${buckets.discarded.length} discarded, ${buckets.skip.length} skipped, ${highFitUnapplied.length} high-fit unapplied`);

  let proposal = '';
  let issues = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const prompt = attempt === 1
      ? buildPrompt(buckets.applied, buckets.rejected, buckets.discarded, buckets.skip, highFitUnapplied, profile)
      : buildPrompt(buckets.applied, buckets.rejected, buckets.discarded, buckets.skip, highFitUnapplied, profile)
        + `\n\nPREVIOUS ATTEMPT had issues: ${issues.join('; ')}. Fix them.`;
    try {
      proposal = (await qwen(prompt)).trim().replace(/^```\w*\n?|```$/g, '').trim();
      issues = validate(proposal, buckets.applied);
      if (!issues.length) break;
      log(`attempt ${attempt}: ${issues.join(' / ')}`);
    } catch (e) {
      log(`attempt ${attempt} failed: ${e.message}`);
    }
  }

  const header = `<!-- Generated ${new Date().toISOString()} by infer-taste.mjs.
This is a PROPOSAL — review carefully. Apply via the Settings page
"Accept proposed taste edits" button, or POST /api/taste/accept.
Reject by deleting this file or pressing Reject. -->

# Taste inference proposal

`;
  const summary = `

---

## Inputs summary
- Applications recorded: ${apps.length} (${buckets.applied.length} applied, ${buckets.interview.length} interview, ${buckets.offer.length} offer, ${buckets.rejected.length} rejected, ${buckets.discarded.length} discarded, ${buckets.skip.length} skipped)
- High-fit (≥4.5) unapplied roles: ${highFitUnapplied.length}
${issues.length ? `\n_Validator flagged: ${issues.join('; ')}_\n` : ''}`;
  await writeFile(OUT, header + proposal + summary);
  log(`wrote ${OUT} (${proposal.length} chars proposal)`);
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
