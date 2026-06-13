#!/usr/bin/env node
// portal-health.mjs
//
// Detects scan portals that have gone silent (0 successful fetches in N days)
// and optionally invokes the Claude CLI to investigate + propose a fix.
//
// "Successful fetch" = log line like "Anthropic (Greenhouse): 427 total, ..."
// where the totals number is > 0. A portal that consistently logs "0 links
// scanned" or "ERROR" or "HTTP 4xx/5xx" is treated as broken, even if it once
// returned hits before. This is the bug profile that hid the Ashby breakage
// for ~weeks (LangChain/Cohere/Pinecone/Modal silently returned 0 links every
// run because the SPA scraper had stopped working).
//
// Usage:
//   node portal-health.mjs           # report only
//   node portal-health.mjs --fix     # also invoke `claude -p` per silent portal
//
// Designed to be wired into scheduled-scan.mjs as a once-per-day check.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SILENCE_DAYS = 7;
const LOG_FILE = "logs/scheduled-scan.log";
const HEALTH_DIR = "data/portal-health";
const STATE_FILE = path.join(HEALTH_DIR, "state.json");
// launchd-spawned processes have a restricted PATH that doesn't include
// ~/.local/bin where claude usually lives, so resolve to an absolute path
// when possible. Override with $CLAUDE_BIN.
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [
    `${process.env.HOME || "/Users/rohan"}/.local/bin/claude`,
    "/usr/local/bin/claude",
    "/opt/homebrew/bin/claude",
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch {}
  }
  return "claude"; // fall through to PATH
}
const CLAUDE_BIN = resolveClaudeBin();
// Don't re-invoke claude for the same portal within this many hours.
const CLAUDE_THROTTLE_HOURS = 24;

function log(msg) {
  console.log(`[portal-health] ${msg}`);
}

function loadLogLines() {
  if (!fs.existsSync(LOG_FILE)) {
    log(`WARN: ${LOG_FILE} does not exist — nothing to analyze`);
    return [];
  }
  return fs.readFileSync(LOG_FILE, "utf8").split("\n");
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return { lastFixInvocation: {} };
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { lastFixInvocation: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(HEALTH_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Match patterns like:
//   [2026-05-07T15:38:48.424Z]   Anthropic (Greenhouse): 427 total, 0 fresh matches
//   [2026-05-07T15:39:22.885Z]   Apple (PW "LA"): 20 links, 1 role matches
//   [2026-05-07T15:43:30.831Z]   Pinecone (Ashby): 6 total, 0 fresh matches
//   [2026-05-07T15:38:57.377Z]   LangChain (Ashby): 0 links scanned     ← BROKEN signal
//   [2026-05-07T15:38:48.424Z]   ERROR LangChain Ashby: ...             ← legacy format (no parens)
//   [2026-05-07T15:38:48.424Z]   ERROR LangChain (Ashby): ...           ← new format (parens)
//   [2026-05-07T15:38:48.424Z]   Pinecone (Ashby): HTTP 404
const HIT_RE = /^\[([0-9T:.Z-]+)\]\s+(\S[^:(]*)\s*\(([^)]+)\):\s*(.+)$/;
const ERR_RE = /^\[([0-9T:.Z-]+)\]\s+ERROR\s+(\S[^:]+):\s*(.+)$/;

// scheduled-scan.mjs writes ERROR lines in two shapes:
//   "ERROR Snowflake Ashby: ..."     (legacy — space-separated)
//   "ERROR Snowflake (Ashby): ..."   (new — parens)
// Successful lines are always parens. Normalize both ERR shapes into the
// parens form so the counts merge under one key per portal.
//
// Source-token list lets multi-word company names ("Mistral AI Lever",
// "Hugging Face Greenhouse") split on the *last* known source token rather
// than first whitespace. Without this, "Mistral AI Lever" normalized to
// "Mistral (AI Lever)" while successes logged as "Mistral AI (Lever)" — two
// buckets, watchdog reported a silent portal that was actually healthy.
const SOURCE_TOKENS = [
  "Greenhouse", "Ashby", "Lever", "Workday", "SmartRecruiters",
  "API", "Algolia",
];
function normalizeErrIdent(ident) {
  ident = ident.trim();
  if (/\(/.test(ident)) return ident; // already parenthesized
  // Try the source-token list first — handles multi-word companies.
  for (const tok of SOURCE_TOKENS) {
    const re = new RegExp(`^(.+?)\\s+(${tok})$`);
    const sm = ident.match(re);
    if (sm) return `${sm[1]} (${sm[2]})`;
  }
  // Fallback: split on first whitespace.
  //   "Apple PW \"LA\"" → "Apple (PW \"LA\")"
  //   "Snowflake Ashby" → "Snowflake (Ashby)"
  const m = ident.match(/^(\S+)\s+(.+)$/);
  return m ? `${m[1]} (${m[2]})` : ident;
}

function classify(detail) {
  const d = detail.trim();
  // 0-link / 0-total signals = broken
  if (/^0 links scanned/.test(d)) return "broken";
  if (/^HTTP\s*[45]\d\d/i.test(d)) return "broken";
  if (/^0 total/i.test(d)) return "broken";
  if (/^0 links/i.test(d) && !/role matches/.test(d)) return "broken";
  // "X total, ..." or "X links, ..." with X>0 = working (regardless of fresh count)
  const m = d.match(/^(\d+)\s+(total|links|jobs)\b/i);
  if (m && parseInt(m[1], 10) > 0) return "working";
  return "unknown";
}

function parseLog(lines, sinceMs) {
  // Map of "Company (Source)" → { working: count, broken: count, lastSeen: timestamp }
  const stats = {};
  for (const line of lines) {
    let m = line.match(HIT_RE);
    if (m) {
      const [, ts, company, source, detail] = m;
      const t = Date.parse(ts);
      if (!t || t < sinceMs) continue;
      const key = `${company.trim()} (${source.trim()})`;
      if (!stats[key]) stats[key] = { working: 0, broken: 0, lastSeen: ts, lastWorking: null };
      const cls = classify(detail);
      if (cls === "working") {
        stats[key].working++;
        stats[key].lastWorking = ts;
      } else if (cls === "broken") {
        stats[key].broken++;
      }
      if (ts > stats[key].lastSeen) stats[key].lastSeen = ts;
      continue;
    }
    m = line.match(ERR_RE);
    if (m) {
      const [, ts, ident, detail] = m;
      const t = Date.parse(ts);
      if (!t || t < sinceMs) continue;
      const key = normalizeErrIdent(ident);
      if (!stats[key]) stats[key] = { working: 0, broken: 0, lastSeen: ts, lastWorking: null, errorMsg: detail };
      stats[key].broken++;
      stats[key].errorMsg = detail;
      if (ts > stats[key].lastSeen) stats[key].lastSeen = ts;
    }
  }
  return stats;
}

function findSilent(stats) {
  // Silent = had at least one run in the window AND zero successful runs.
  return Object.entries(stats)
    .filter(([_, s]) => s.working === 0 && s.broken > 0)
    .map(([portal, s]) => ({ portal, ...s }))
    .sort((a, b) => b.broken - a.broken);
}

function buildClaudePrompt(portal, stats) {
  return `You are diagnosing a broken scan portal in the career-ops repo at ${process.cwd()}.

Portal: ${portal}
Window: last ${SILENCE_DAYS} days
Failed runs: ${stats.broken}
Successful runs: ${stats.working}
Last seen in log: ${stats.lastSeen}
${stats.errorMsg ? `Last error: ${stats.errorMsg}\n` : ""}
Your job:
1. Read scheduled-scan.mjs to find the adapter responsible for this portal (search for the company name).
2. Read the last ~50 lines of logs/scheduled-scan.log mentioning this portal to confirm the failure mode.
3. Test the underlying endpoint directly with curl/fetch to determine if it's a server-side change (URL moved, slug changed, schema changed) or a parser bug.
4. If you can identify a fix, apply it via Edit. Use the existing Ashby-fix pattern (commit f574b34 area) as a reference: prefer JSON APIs over Playwright SPA scraping when possible.
5. Write a summary to data/portal-health/${portal.replace(/[^a-z0-9]/gi, "-").toLowerCase()}-fix-${new Date().toISOString().slice(0, 10)}.md including: root cause, the diff you applied, how to verify, any open questions.

Hard constraints:
- DO NOT run \`node scheduled-scan.mjs\` (it takes minutes and writes to scan-history.tsv).
- DO NOT run any git commit / git push / merge command.
- DO NOT modify .env, config/profile.yml, cv.md, or anything in the User Layer per CLAUDE.md.
- If you cannot find a fix in <15 turns, document what you tried in the summary file and exit cleanly.`;
}

async function invokeClaude(portal, stats) {
  const prompt = buildClaudePrompt(portal, stats);
  log(`Invoking Claude CLI for ${portal}...`);
  return new Promise((resolve) => {
    const child = spawn(
      CLAUDE_BIN,
      [
        "-p", prompt,
        "--allowed-tools", "Read,Edit,Bash,Grep,Glob,Write,WebFetch",
        "--max-turns", "20",
      ],
      { stdio: "inherit" }
    );
    child.on("close", (code) => {
      log(`Claude CLI exited with code ${code} for ${portal}`);
      resolve(code);
    });
    child.on("error", (err) => {
      log(`Claude CLI error for ${portal}: ${err.message}`);
      resolve(1);
    });
  });
}

async function main() {
  const wantFix = process.argv.includes("--fix");
  fs.mkdirSync(HEALTH_DIR, { recursive: true });

  const since = Date.now() - SILENCE_DAYS * 24 * 3600 * 1000;
  const lines = loadLogLines();
  const stats = parseLog(lines, since);
  const silent = findSilent(stats);

  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(HEALTH_DIR, `report-${today}.json`);
  fs.writeFileSync(
    reportPath,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), windowDays: SILENCE_DAYS, silent, allStats: stats },
      null,
      2
    )
  );

  if (silent.length === 0) {
    log(`OK: all observed portals had at least one successful run in last ${SILENCE_DAYS} days`);
    return 0;
  }

  log(`FAIL: ${silent.length} portal(s) silent for ${SILENCE_DAYS}+ days:`);
  for (const s of silent) {
    log(`  - ${s.portal}: ${s.broken} failed, ${s.working} working, last seen ${s.lastSeen}${s.errorMsg ? ` (${s.errorMsg.slice(0, 60)})` : ""}`);
  }
  log(`Wrote report → ${reportPath}`);

  if (!wantFix) {
    log(`Run with --fix to invoke 'claude -p' to investigate each silent portal.`);
    return 0;
  }

  const state = loadState();
  state.lastFixInvocation = state.lastFixInvocation || {};
  const throttleMs = CLAUDE_THROTTLE_HOURS * 3600 * 1000;
  const now = Date.now();

  for (const s of silent) {
    const last = state.lastFixInvocation[s.portal];
    if (last && now - last < throttleMs) {
      log(`Skipping ${s.portal} — Claude CLI was invoked ${Math.round((now - last) / 3600000)}h ago (throttle: ${CLAUDE_THROTTLE_HOURS}h)`);
      continue;
    }
    state.lastFixInvocation[s.portal] = now;
    saveState(state);
    await invokeClaude(s.portal, s);
  }
  return 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(e);
  process.exit(1);
});
