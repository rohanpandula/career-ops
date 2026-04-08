#!/usr/bin/env node
/**
 * notify-telegram.mjs — Send career-ops notifications to Telegram.
 *
 * Usage:
 *   node notify-telegram.mjs scan    "Found 4 new offers: Anthropic DevRel, ..."
 *   node notify-telegram.mjs eval    "Anthropic DevRel scored 4.3/5 — strong fit"
 *   node notify-telegram.mjs status  "Applied to 3 roles today"
 *   node notify-telegram.mjs digest  (reads data/applications.md and sends summary)
 *   node notify-telegram.mjs test    "Test message"
 *
 * Environment / Config:
 *   Reads Telegram credentials from (in priority order):
 *   1. TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars
 *   2. config/profile.yml → notifications.telegram.bot_token / chat_id
 *   3. Fallback: ~/remote_monitor_nanokvm.sh (legacy cd-job-alerts source)
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import https from "https";

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Credential resolution ---

function loadProfileYml() {
  const profilePath = join(__dirname, "config", "profile.yml");
  if (!existsSync(profilePath)) return {};
  const raw = readFileSync(profilePath, "utf-8");
  // Minimal YAML parser for flat-ish keys — avoids adding a dependency
  const result = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s+(bot_token|chat_id|enabled|min_score):\s*"?([^"#\n]+)"?\s*$/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}

function loadLegacyCredentials() {
  const src = join("/Users/rohan", "remote_monitor_nanokvm.sh");
  if (!existsSync(src)) return {};
  const raw = readFileSync(src, "utf-8");
  const tokenMatch = raw.match(/^TELEGRAM_BOT_TOKEN="([^"]+)"/m);
  const chatMatch = raw.match(/^CHAT_ID="([^"]+)"/m);
  return {
    bot_token: tokenMatch?.[1] || "",
    chat_id: chatMatch?.[1] || "",
  };
}

function resolveCredentials() {
  // 1. Environment variables
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return {
      bot_token: process.env.TELEGRAM_BOT_TOKEN,
      chat_id: process.env.TELEGRAM_CHAT_ID,
    };
  }

  // 2. config/profile.yml
  const profile = loadProfileYml();
  if (profile.bot_token && profile.chat_id) {
    return { bot_token: profile.bot_token, chat_id: profile.chat_id };
  }

  // 3. Legacy fallback
  const legacy = loadLegacyCredentials();
  if (legacy.bot_token && legacy.chat_id) {
    return legacy;
  }

  return null;
}

// --- Telegram API ---

function sendTelegram(botToken, chatId, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });

    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${botToken}/sendMessage`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Telegram API ${res.statusCode}: ${body}`));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

// --- Message formatting ---

const ICONS = {
  scan: "\u{1F50D}",    // 🔍
  eval: "\u{1F4CB}",    // 📋
  status: "\u{1F4AC}",  // 💬
  digest: "\u{1F4CA}",  // 📊
  test: "\u{1F6A7}",    // 🚧
};

function formatMessage(type, text) {
  const icon = ICONS[type] || "\u{1F4BC}";
  const header = {
    scan: "New Offers Found",
    eval: "Evaluation Complete",
    status: "Status Update",
    digest: "Pipeline Digest",
    test: "Test",
  }[type] || "Career-Ops";

  return `${icon} <b>career-ops — ${header}</b>\n\n${text}`;
}

// --- Digest builder ---

function buildDigest() {
  const trackerPath = join(__dirname, "data", "applications.md");
  if (!existsSync(trackerPath)) return "No applications tracked yet.";

  const raw = readFileSync(trackerPath, "utf-8");
  const lines = raw.split("\n").filter((l) => l.startsWith("|") && !l.startsWith("| #") && !l.startsWith("|--"));

  if (lines.length === 0) return "No applications tracked yet.";

  const statusCounts = {};
  for (const line of lines) {
    const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
    if (cols.length >= 6) {
      const status = cols[5] || "Unknown";
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
  }

  const parts = [`<b>${lines.length}</b> total applications\n`];
  for (const [status, count] of Object.entries(statusCounts).sort((a, b) => b[1] - a[1])) {
    parts.push(`  ${status}: <b>${count}</b>`);
  }

  return parts.join("\n");
}

// --- Main ---

async function main() {
  const [type = "test", ...rest] = process.argv.slice(2);
  let text = rest.join(" ");

  if (type === "digest") {
    text = buildDigest();
  }

  if (!text) {
    console.error("Usage: node notify-telegram.mjs <scan|eval|status|digest|test> <message>");
    process.exit(1);
  }

  const creds = resolveCredentials();
  if (!creds) {
    console.error(
      "No Telegram credentials found. Set them in:\n" +
      "  1. TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID env vars, or\n" +
      "  2. config/profile.yml under notifications.telegram"
    );
    process.exit(1);
  }

  const message = formatMessage(type, text);

  try {
    await sendTelegram(creds.bot_token, creds.chat_id, message);
    console.log(`Sent ${type} notification to Telegram.`);
  } catch (err) {
    console.error(`Failed to send: ${err.message}`);
    process.exit(1);
  }
}

main();
