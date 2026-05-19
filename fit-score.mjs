#!/usr/bin/env node

/**
 * fit-score.mjs — Per-URL fit scoring.
 *
 * For each live pending pipeline URL without a cached fit score, sends
 * {title, company, location, user-profile-summary} to the configured scorer
 * and records a 1-5 score + one-line rationale.
 *
 * Writes to data/fit-scores.json (idempotent — skips already-scored URLs).
 *
 * Usage:
 *   node fit-score.mjs              # score all unscored live URLs
 *   node fit-score.mjs --max 30     # cap per run
 *   node fit-score.mjs --redo       # re-score everything (ignore cache)
 */

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import yaml from 'js-yaml';

const PIPE = 'data/pipeline.md';
const LIVE_PATH = 'web/.liveness.json';
const FIT_PATH = 'data/fit-scores.json';
const PROFILE = 'config/profile.yml';
const DEFAULT_QWEN_URL = 'http://10.0.0.34:11434/api/generate';
const DEFAULT_QWEN_MODEL = 'qwen3:14b-16k';
const DEFAULT_MIXLAYER_BASE_URL = 'https://models.mixlayer.ai/v1';
const DEFAULT_MIXLAYER_MODEL = 'qwen/qwen3.5-122b-a10b';
// parallel=3 keeps API contention low so each request finishes inside the
// per-request budget; the 397b/35b models can spend 60-150s on reasoning + JSON.
const PARALLEL = Math.max(1, parseInt(process.env.FIT_SCORE_PARALLEL || '3', 10) || 3);

const args = process.argv.slice(2);
const MAX = parseInt(args[args.indexOf('--max') + 1] || '500', 10);
const REDO = args.includes('--redo');

function log(m) { console.log(`[${new Date().toISOString()}] fit-score: ${m}`); }

function parsePipeline(md) {
  const out = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^- \[([ x])\] (\S+) \| ([^|]+) \| (.+)$/);
    if (m) out.push({ checked: m[1] === 'x', url: m[2].trim(), company: m[3].trim(), role: m[4].trim() });
  }
  return out;
}

function normalizeBaseUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function loadScorerSettings(profile) {
  const cfg = profile?.scorer || {};
  const mixlayer = cfg.mixlayer || {};
  const qwen = cfg.qwen || {};
  const hasMixlayerKey = Boolean(process.env.MIXLAYER_API_KEY || mixlayer.api_key);
  const provider = String(process.env.SCORER_PROVIDER || cfg.provider || (hasMixlayerKey ? 'mixlayer' : 'qwen')).toLowerCase();

  return {
    provider,
    mixlayerApiKey: process.env.MIXLAYER_API_KEY || mixlayer.api_key || '',
    mixlayerBaseUrl: normalizeBaseUrl(process.env.MIXLAYER_BASE_URL || mixlayer.base_url || DEFAULT_MIXLAYER_BASE_URL),
    mixlayerModel: process.env.MIXLAYER_MODEL || mixlayer.model || DEFAULT_MIXLAYER_MODEL,
    qwenUrl: process.env.QWEN_URL || qwen.url || DEFAULT_QWEN_URL,
    qwenModel: process.env.QWEN_MODEL || qwen.model || DEFAULT_QWEN_MODEL,
  };
}

function scorerLabel(settings) {
  if (settings.provider === 'mixlayer') return `${settings.mixlayerModel} via Mixlayer`;
  return `${settings.qwenModel} via Qwen`;
}

async function qwen(prompt, settings) {
  const body = JSON.stringify({ model: settings.qwenModel, prompt, stream: false, think: false, keep_alive: '5m' });
  const r = await fetch(settings.qwenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(90_000),
  });
  if (!r.ok) throw new Error(`qwen HTTP ${r.status}`);
  const d = await r.json();
  return d.response || '';
}

async function mixlayer(prompt, settings) {
  if (!settings.mixlayerApiKey) {
    throw new Error('missing MIXLAYER_API_KEY or config/profile.yml scorer.mixlayer.api_key');
  }

  const body = JSON.stringify({
    model: settings.mixlayerModel,
    messages: [
      { role: 'system', content: '/no_think\nYou output only compact JSON. Do not reason. Do not explain.' },
      { role: 'user', content: `${prompt}\n\n/no_think` },
    ],
    temperature: 0.2,
    top_p: 0.8,
    // 397b model insists on thinking even with /no_think; need headroom for
    // reasoning + final JSON. Truncation here causes empty content and
    // parseScore falls back to misreading "Thinking Process: 1." as score=1.
    max_tokens: parseInt(process.env.MIXLAYER_MAX_TOKENS || '2000', 10),
    stream: false,
    chat_template_kwargs: { enable_thinking: false },
  });

  const r = await fetch(`${settings.mixlayerBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${settings.mixlayerApiKey}`,
      'Content-Type': 'application/json',
    },
    body,
    // 397b-a17b can spend 100+s on reasoning + JSON output; 90s was too tight
    // and caused ~50% timeout rate under parallel=5.
    signal: AbortSignal.timeout(180_000),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`mixlayer HTTP ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
  }

  const d = await r.json();
  const msg = d.choices?.[0]?.message || {};
  // Some Mixlayer qwen variants put output in `reasoning_content` instead of
  // `content` despite /no_think — fall back so we can still parse a score.
  return msg.content || msg.reasoning_content || d.choices?.[0]?.text || '';
}

async function scorePrompt(prompt, settings) {
  if (settings.provider === 'mixlayer') return mixlayer(prompt, settings);
  if (settings.provider === 'qwen') return qwen(prompt, settings);
  throw new Error(`unknown scorer provider: ${settings.provider}`);
}

function parseScore(text) {
  // Expect JSON: { "score": X.X, "reason": "..." }
  // Prefer the LAST JSON match — reasoning models often emit examples first
  // and the real answer last.
  const matches = [...text.matchAll(/\{[^{}]*"score"[^{}]*\}/g)];
  for (const m of matches.reverse()) {
    try {
      const j = JSON.parse(m[0]);
      const s = parseFloat(j.score);
      if (isFinite(s) && s >= 0 && s <= 5) return { score: +s.toFixed(1), reason: String(j.reason || '').slice(0, 200) };
    } catch {}
  }
  // Tolerant fallback: model sometimes hits max_tokens mid-answer and emits
  // `{"score": 4.0, "reason": "Secondary…` without a closing brace. Salvage
  // the score (anchored to the field name — safer than any-number heuristic)
  // and capture whatever reason text follows.
  const scoreM = text.match(/"score"\s*:\s*([1-5](?:\.\d)?)/);
  if (scoreM) {
    const s = parseFloat(scoreM[1]);
    const reasonM = text.match(/"reason"\s*:\s*"([^"]{0,200})/);
    return { score: +s.toFixed(1), reason: (reasonM?.[1] || 'truncated').slice(0, 200) };
  }
  return null;
}

function buildProfileSummary(profile) {
  const p = profile || {};
  const primaries = (p.target_roles?.primary || []).join(', ');
  const secondaries = (p.target_roles?.secondary || []).join(', ');
  const headline = p.narrative?.headline || '';
  const loc = p.location?.city || p.location?.base || 'Los Angeles, CA (PST)';
  const specialties = (p.domain_specialties || []).map((s) => s.name).join(', ');
  return `
Headline: ${headline || 'AI platform / partnerships operator who ships regulated production AI systems solo, builds 0-to-1 partner ecosystems, and flexes across PM / Strategist / SA / DevRel framings.'}
PRIMARY targets (score 4.5-5.0 when matched): ${primaries || 'Forward Deployed Product Manager / Strategist, Founding PM, Strategic Partnerships Lead (AI/Platforms/Healthcare), Technical Product Manager / Technical Product Strategist, Senior Solutions Architect (AI labs / regulated verticals), Developer Strategy / Developer Relations Lead, Healthcare AI / Clinical AI Product Manager'}.
SECONDARY targets (score 3.5-4.5 when matched): ${secondaries || 'Technology Strategist (consultative, C-suite advisory), Product Partnerships and Strategy (hybrid), Product Marketing Manager (AI/Developer/Platform), Business Development Lead (AI partnerships), Growth Partnerships Lead, App Ecosystem / Storefront BD, Solutions Engineer (AI / regulated)'}.
Based in: ${loc}. US citizen, no sponsorship needed.
Comp preference: $200K+ base ideal; will apply below for standout products. Principal IC titles are IN SCOPE (Principal PM, Principal Strategist, Principal SA — NOT Director).
Product areas user loves: agentic AI products, developer platforms, AR/VR hardware, motion/gaming, AI infrastructure, healthcare/clinical AI, regulated/compliant AI, GCP-native systems.
Product areas user tolerates: cloud/data platforms, broader ML tooling at top-tier AI companies.
Domain specialty boosts (apply +0.2-0.3 within an archetype match): ${specialties || 'Healthcare/Clinical/Biomedical AI, Regulated/Compliance AI (HIPAA/GDPR/GxP), GCP-native/Vertex AI, Agentic AI/LLM Ops/AI Infrastructure, XR/AR/VR, Forward Deployed/0-to-1 solo build'}.
Differentiator evidence: cx-mono (CollectiveX Health) — solo contractor, 3,968 commits across 5.5 weeks, 15 apps, ~283K LoC, GCP-native, GDPR Art.9 + HIPAA-adjacent, multi-LLM routing, biomedical RAG. This is FDPM / Founding PM / Founding SA evidence — quote it when scoring those archetypes.
`.trim();
}

const HARD_RULES = `
HARD FILTERS — apply BEFORE scoring. Each is deterministic; do not soften them:

1. Seniority cap. If the title starts with or contains: "Director", "Head of", "Head," (as prefix word), "VP", "Vice President", "Chief", "Group Director", "Principal Director" → score = 1.0, reason = "Seniority cap exceeded — target is IC, not director-level".
   IC titles that are IN SCOPE (do NOT cap these):
   - "Principal Product Manager" / "Principal PM" / "Principal Product Strategist" — Principal IC is in scope at Amazon/Google/Microsoft/Apple.
   - "Principal Solutions Architect" / "Principal Strategist" — IC architect/strategist roles are in scope.
   - "Staff Product Manager" / "Staff PM" — IC, in scope.
   - "Lead Product Manager" / "Lead AI PM" / "Lead Strategist" — IC, in scope.
   - "Senior Lead", "Group Product Manager" without "Director" — IC, in scope.

2. Excluded companies. If company name (case-insensitive) equals "xAI", "xai", "X AI", or "Meta" → score = 1.0, reason = "Excluded company".

3. Explicitly-unwanted role flavors — cap at score = 2.0:
   - Ads / Advertising / Monetization / Programmatic PM
   - Observability / Eval Platform / ML Ops Platform PM / AI Remediation
   - Pure Community Manager / Social Media Manager / Documentation Lead / Content Strategist
   - Engineering Program Manager (EPM) — ops-for-engineering, wrong fit
   - Ops-only program manager with no product element (e.g. "Broadcast Operations Manager", "Supply Planning Manager")

4. Engineer titles. Any of: Software Engineer, Frontend/Backend/Fullstack Engineer, ML Engineer, Research Engineer, Data Engineer, Research Scientist, Applied Scientist, SWE, SDE, Firmware, Embedded, SRE, DevOps Engineer, QA Engineer, Systems Engineer → score = 1.5, reason = "Engineer title — wrong function".
   EXPLICITLY NOT engineers — these are target roles, do NOT apply this filter to:
   - "Solutions Architect" (any variant, even "Senior SA", "Pre-Sales SA", "Principal SA") — primary target archetype.
   - "Solutions Engineer" (Pre-Sales / Customer-facing SE — partner-facing technical role) — secondary target.
   - "Developer Advocate" / "AI Developer Advocate" / "Staff Developer Advocate" — primary target (DevRel).
   - "Forward Deployed Software Engineer" / "Forward Deployed Engineer" IS engineer (cap 1.5).
   - "Forward Deployed Product Manager" / "Forward Deployed Product" / "Forward Deployed Strategist" is NOT — primary target (5.0 dream-fit).
   - "Founding Product Manager" / "Founding PM" / "Founding Product" / "Founder in Residence" — primary target.
   - Any "Product Manager" variant (Technical PM, Principal PM, Staff PM, Lead PM, Group PM) — PM is the primary target.

5. Location. ONLY penalize when location is EXPLICITLY non-US with NO mention of remote/US-eligible:
   - "London, UK" alone → score ≤ 2.0
   - "Paris" alone → score ≤ 2.0
   - "San Francisco; London" → NO penalty (includes US)
   - "Remote" with no geo → NO penalty
   - Missing / unknown location → NO penalty

DO NOT apply a comp-minimum filter. User will apply to sub-$200K roles for standout products.
DO NOT invent salary data. If salary field is empty, treat as "not posted", not "below minimum".
`.trim();

const RUBRIC = `
SCORING (applies only after hard filters pass):

5.0 — Dream fit. PRIMARY archetype + AI-forward / regulated-AI company + US-based or remote.
      Special triggers that lock in 5.0:
      - "Forward Deployed Product Manager / Strategist" at Anthropic/OpenAI/Cohere/Mistral/Scale AI/Together/Modal → 5.0 (cx-mono is the textbook FDPM evidence).
      - "Founding PM / Founding Product / Founder in Residence" at any AI-native Series A/B → 5.0.
      - "Healthcare/Clinical/Biomedical AI Product Manager" at any AI-native or regulated-AI co (Hippocratic, Tempus, Ambience, Verily, Anthropic Health, OpenAI Health, Doximity, Iodine) → 5.0.
      - "Senior/Principal Solutions Architect" at AI labs / regulated verticals (Anthropic Public Sector, OpenAI Enterprise, Vertex AI Health) → 5.0.
      - "Strategic Partnerships Lead, AI" at any AI-native co → 5.0.
4.5 — Strong primary archetype + AI-forward co + minor gap (e.g., on-site outside LA/SF/NY, or unposted comp).
4.0 — PRIMARY archetype with ONE meaningful gap (location, less-exciting product area), OR SECONDARY archetype at an AI-forward company.
3.5 — SECONDARY archetype at top-tier AI co with no gaps, or PRIMARY archetype at a B-tier company.
3.0 — Acceptable. Target archetype at a less-exciting company.
2.0 — Tangential or soft-excluded (ads/observability/community/EPM).
1.0-1.5 — Hard filter fired (Director/VP/Head/Chief/engineer/excluded company).

DOMAIN SPECIALTY BOOSTS (within an archetype match, +0.2-0.3, max score 5.0):
- Healthcare / Clinical / Biomedical / regulated-AI domain: +0.3 (cx-mono evidence)
- HIPAA / GDPR / Compliance / GxP context: +0.3
- GCP-native / Vertex AI / Google Cloud product surface: +0.2
- Agentic AI / LLM Ops / AI Infrastructure product surface: +0.2
- XR / AR / VR / Spatial Computing: +0.2
- 0-to-1 / Founding / Forward Deployed motion mentioned in JD: +0.2

KEY: Most scores cluster at 3.5-4.5 (these passed the scanner's keyword filter). A 2 or lower signals an EXPLICIT miss. Use 5.0 only for the special triggers above or when JD language matches the candidate's headline almost verbatim. Do NOT over-use 2.
`.trim();

const FEW_SHOT = `
EXAMPLES:

Input: Company=Google, Title="Director, Product Activation", Location="Mountain View, CA"
Output: {"score": 1.0, "reason": "Seniority cap exceeded — Director."}

Input: Company=Google, Title="Senior Product Manager, Agent and ML Infrastructure", Location="San Francisco; Sunnyvale"
Output: {"score": 4.8, "reason": "Primary archetype, multi-city US, agentic AI product area."}

Input: Company=Meta, Title="Product Manager, Reality Labs"
Output: {"score": 1.0, "reason": "Excluded company (user left Meta)."}

Input: Company=Amazon, Title="Principal Product Manager, Kernels — Annapurna Labs", Location="Cupertino"
Output: {"score": 4.5, "reason": "Primary archetype, Amazon Principal PM is IC not Director, deep AI/ML product area."}

Input: Company=Datadog, Title="Senior Product Manager, Observability Platform"
Output: {"score": 2.0, "reason": "Primary archetype but observability platform is explicit no-go."}

Input: Company=Anthropic, Title="Forward Deployed Engineer, Applied AI"
Output: {"score": 1.5, "reason": "Engineer title — wrong function."}

Input: Company=Spotify, Title="Senior PM — ML/Subscriptions Growth", Location="London"
Output: {"score": 2.0, "reason": "Primary archetype but London-only, no remote-US."}

Input: Company=Nex, Title="Manager, Strategic Partnerships and AI Operations", Location="San Jose"
Output: {"score": 4.5, "reason": "Secondary archetype, partnerships+AI in one seat is rare, motion-gaming product aligns with XR background."}

Input: Company=Anthropic, Title="Senior Product Manager, Education Labs", Location="SF; New York"
Output: {"score": 4.0, "reason": "Primary archetype at top-tier AI co, multi-city US, 0-to-1 product space."}

Input: Company=Google, Title="Strategic Partnerships Development Manager, Gaming Publishers, YouTube", Location="Los Angeles"
Output: {"score": 4.0, "reason": "Secondary archetype at Google, LA, gaming fits user's XR active-play background."}

Input: Company=OpenAI, Title="Product Marketing Manager, Platform", Location="Remote - US"
Output: {"score": 4.0, "reason": "Secondary archetype for developer platform at OpenAI, remote-US."}

Input: Company=Snap, Title="AI Community Program Manager", Location="Los Angeles"
Output: {"score": 2.0, "reason": "Community Manager flavor — user does not want content/community DevRel."}

Input: Company=Unity, Title="Director, Product Marketing AI"
Output: {"score": 1.0, "reason": "Seniority cap exceeded (Director)."}

Input: Company=Anthropic, Title="Forward Deployed Product Manager", Location="San Francisco; New York"
Output: {"score": 5.0, "reason": "Special trigger: FDPM at AI lab — cx-mono is textbook FDPM evidence (5-week solo regulated AI build)."}

Input: Company=OpenAI, Title="Forward Deployed Engineer, Healthcare", Location="San Francisco"
Output: {"score": 1.5, "reason": "Engineer title — wrong function. (Healthcare context noted but role is FDE not FDPM.)"}

Input: Company=Hippocratic AI, Title="Founding Product Manager, Clinical Workflows", Location="Remote - US"
Output: {"score": 5.0, "reason": "Founding PM at regulated-AI co + healthcare domain boost — exact cx-mono evidence match."}

Input: Company=Tempus, Title="Senior Product Manager, Clinical AI Platform", Location="Chicago"
Output: {"score": 4.8, "reason": "Senior PM + clinical AI + healthcare domain boost (+0.3) on a strong PM archetype baseline."}

Input: Company=Doximity, Title="Principal Product Manager, AI Tools", Location="San Francisco"
Output: {"score": 4.8, "reason": "Principal PM IC (in scope) + healthcare domain + AI tooling product."}

Input: Company=Anthropic, Title="Senior Solutions Architect, Public Sector", Location="Washington, DC; Remote - US"
Output: {"score": 4.8, "reason": "Primary SA archetype at AI lab + regulated-vertical boost — fits cx-mono compliance work."}

Input: Company=Pinecone, Title="Staff Developer Advocate", Location="San Francisco"
Output: {"score": 4.5, "reason": "Primary DevRel archetype at AI infra co; SXSW/Unity Unite keynote evidence supports."}

Input: Company=LangChain, Title="Founding Solutions Architect", Location="New York"
Output: {"score": 4.8, "reason": "Founding SA at agentic AI infra co — cx-mono multi-LLM routing evidence is a direct fit."}

Input: Company=Anthropic, Title="Strategic Partnerships Manager, Cloud", Location="San Francisco; Seattle"
Output: {"score": 5.0, "reason": "Special trigger: Strategic Partnerships at AI lab — Disney/Amazon/Mercedes-Benz precedent is the exact pattern."}

Input: Company=Modal, Title="Solutions Architect", Location="San Francisco; New York"
Output: {"score": 4.5, "reason": "Primary SA archetype at AI infra co + agentic-AI domain boost; cx-mono multi-LLM routing fits."}

Input: Company=Amazon, Title="Principal Product Manager - Tech, Alexa Connections"
Output: {"score": 4.5, "reason": "Principal PM IC (in scope) at AI-forward co; Alexa Connections is developer-platform/AI surface."}

Input: Company=Google, Title="Group Product Manager, Generative AI, Google Cloud", Location="Mountain View"
Output: {"score": 4.7, "reason": "Group PM (IC, not Director) at AI-forward co + GenAI + Google Cloud (GCP-native boost +0.2)."}
`.trim();

function buildPrompt(profileSummary, job) {
  return `You are a hard-nosed career-fit scorer. You score job postings against a candidate profile, return a JSON score 1.0-5.0, and you do NOT hedge. Most postings score 3 or 4; a 2 or lower means an explicit miss the user wants to triage out.

CANDIDATE PROFILE:
${profileSummary}

${HARD_RULES}

${RUBRIC}

${FEW_SHOT}

NOW SCORE THIS JOB:

Company: ${job.company}
Title: ${job.title}
Location: ${job.location || 'unknown'}
Salary: ${job.salary || 'not posted'}

Return ONLY a single JSON object on one line: {"score": X.X, "reason": "one concise sentence citing which rule fired"}`;
}

async function main() {
  if (!existsSync(PIPE)) { log(`no ${PIPE}`); process.exit(1); }
  if (!existsSync(LIVE_PATH)) { log(`no ${LIVE_PATH}`); process.exit(1); }

  const pipeline = parsePipeline(await readFile(PIPE, 'utf-8'));
  const liveness = JSON.parse(await readFile(LIVE_PATH, 'utf-8'));
  const cache = existsSync(FIT_PATH) ? JSON.parse(await readFile(FIT_PATH, 'utf-8')) : {};
  const profile = existsSync(PROFILE)
    ? yaml.load(await readFile(PROFILE, 'utf-8'))
    : {};
  const profileSummary = buildProfileSummary(profile);
  const scorerSettings = loadScorerSettings(profile);
  if (scorerSettings.provider === 'mixlayer' && !scorerSettings.mixlayerApiKey) {
    log('missing MIXLAYER_API_KEY or config/profile.yml scorer.mixlayer.api_key');
    process.exit(1);
  }

  const pending = pipeline.filter(p => !p.checked);
  const targets = [];
  for (const p of pending) {
    const l = liveness[p.url] || {};
    // Previously skipped any URL where liveness.live !== true. That hid jobs
    // from the Telegram push as "Fit —" whenever auto-verify produced a false-
    // negative (Apple pages occasionally trip the "closed marker in body"
    // heuristic). Score every pending URL — the model call is cheap and the
    // user wants the score regardless of the liveness probe verdict.
    if (!REDO && cache[p.url]?.score != null) continue;
    targets.push({
      url: p.url,
      company: p.company,
      title: l.jobTitle || p.role,
      location: l.location || '',
      salary: l.salary || '',
    });
    if (targets.length >= MAX) break;
  }

  if (!targets.length) { log('nothing to score'); return; }
  log(`scoring ${targets.length} URLs via ${scorerLabel(scorerSettings)} (parallel=${PARALLEL})`);

  const queue = [...targets];
  let done = 0, ok = 0, fail = 0;
  let flushTimer = null;
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(async () => {
      flushTimer = null;
      await writeFile(FIT_PATH, JSON.stringify(cache, null, 2));
    }, 2000);
  };

  async function worker() {
    while (queue.length) {
      const job = queue.shift();
      const prompt = buildPrompt(profileSummary, job);
      try {
        const resp = await scorePrompt(prompt, scorerSettings);
        const parsed = parseScore(resp);
        if (parsed) {
          cache[job.url] = {
            ...parsed,
            scoredAt: new Date().toISOString(),
            title: job.title,
            company: job.company,
            provider: scorerSettings.provider,
            model: scorerSettings.provider === 'mixlayer' ? scorerSettings.mixlayerModel : scorerSettings.qwenModel,
          };
          ok++;
        } else {
          cache[job.url] = { score: null, reason: `unparseable: ${resp.slice(0, 80)}`, scoredAt: new Date().toISOString() };
          fail++;
        }
      } catch (e) {
        fail++;
        cache[job.url] = { score: null, reason: `err: ${e.message}`, scoredAt: new Date().toISOString() };
      }
      done++;
      if (done % 10 === 0) log(`progress ${done}/${targets.length} (ok=${ok} fail=${fail})`);
      scheduleFlush();
    }
  }

  await Promise.all(Array.from({ length: PARALLEL }, worker));
  if (flushTimer) clearTimeout(flushTimer);
  await writeFile(FIT_PATH, JSON.stringify(cache, null, 2));

  // Summary
  const dist = { '5': 0, '4': 0, '3': 0, '2': 0, '1': 0 };
  for (const v of Object.values(cache)) {
    if (v?.score == null) continue;
    const bucket = Math.min(5, Math.max(1, Math.round(v.score)));
    dist[bucket]++;
  }
  log(`done: ${ok} scored, ${fail} failed. Distribution (rounded): ` +
    Object.entries(dist).reverse().map(([k,v])=>`${k}:${v}`).join(' '));
}

main().catch(e => { console.error('fatal:', e); process.exit(1); });
