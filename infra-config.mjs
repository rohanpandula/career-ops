#!/usr/bin/env node
/**
 * infra-config.mjs — Loads LAN / self-hosted service config (URLs + tokens)
 * from config/profile.yml (gitignored) with environment-variable overrides.
 *
 * NO secrets live in this file. It only knows WHERE to look. The actual tokens
 * and private hostnames live in config/profile.yml under `infra:` — which is
 * gitignored — so cloning this public repo never leaks credentials. Every
 * consumer degrades gracefully when a value is absent (skips the feature).
 *
 * Example config/profile.yml block:
 *
 *   infra:
 *     qwen_url: http://host:11434/api/generate
 *     changedetection:
 *       api_url: http://host:5000/api/v1
 *       api_key: "..."
 *     browserless:
 *       http_url: http://host:3012
 *       ws_url:   ws://host:3012/playwright/chromium
 *       token:    "..."
 *     flaresolverr_url: http://host:8191/v1
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

const ROOT = dirname(fileURLToPath(import.meta.url));

let _cache;
function profile() {
  if (_cache !== undefined) return _cache;
  const p = join(ROOT, 'config', 'profile.yml');
  try {
    _cache = existsSync(p) ? (yaml.load(readFileSync(p, 'utf-8')) || {}) : {};
  } catch {
    _cache = {};
  }
  return _cache;
}

/** Raw `infra:` block from profile.yml ({} if absent). */
export function infra() {
  return profile().infra || {};
}

/** Local Qwen generate endpoint (env QWEN_URL wins). '' if unset. */
export function qwenUrl() {
  return process.env.QWEN_URL || infra().qwen_url || '';
}


/** Mixlayer credentials shared by enrichment scripts (env MIXLAYER_* win).
 *  Key/base come from scorer.mixlayer in config/profile.yml — the same block
 *  fit-score uses — but NOT its model: fit-score's scoring model is its own
 *  choice, while enrichment defaults to Mixlayer's free model below. */
export function mixlayer() {
  const m = (profile().scorer || {}).mixlayer || {};
  return {
    apiKey: process.env.MIXLAYER_API_KEY || m.api_key || '',
    baseUrl: (process.env.MIXLAYER_BASE_URL || m.base_url || 'https://models.mixlayer.ai/v1').replace(/\/+$/, ''),
  };
}

export const MIXLAYER_FREE_MODEL = 'qwen/qwen3.5-4b-free';
const QWEN_FALLBACK_MODEL = 'qwen3:14b-16k';

function enrichModel() {
  return process.env.MIXLAYER_ENRICH_MODEL || MIXLAYER_FREE_MODEL;
}

/** { provider, model, description } for startup log lines. */
export function llmProvider() {
  if (mixlayer().apiKey) {
    return { provider: 'mixlayer', model: enrichModel(), description: `${enrichModel()} via Mixlayer` };
  }
  return { provider: 'qwen', model: QWEN_FALLBACK_MODEL, description: `${QWEN_FALLBACK_MODEL} via local Qwen` };
}

/** One prompt in, text out. Mixlayer free model when a key is configured,
 *  local Qwen otherwise. Each caller's prompt states its own output format. */
export async function llmText(prompt, timeoutMs = 120_000) {
  const ml = mixlayer();
  if (ml.apiKey) {
    const r = await fetch(`${ml.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ml.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: enrichModel(),
        messages: [
          { role: 'system', content: '/no_think\nFollow the user instructions exactly. Output only the requested content, no reasoning, no preamble.' },
          { role: 'user', content: `${prompt}\n\n/no_think` },
        ],
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 2000,
        stream: false,
        // Official Mixlayer switches — the free qwen3.5-4b otherwise burns the
        // whole token budget on visible reasoning and never answers.
        reasoning_effort: 'none',
        thinking: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) {
      const text = await r.text().catch(() => '');
      throw new Error(`mixlayer HTTP ${r.status}${text ? `: ${text.slice(0, 160)}` : ''}`);
    }
    const d = await r.json();
    const msg = d.choices?.[0]?.message || {};
    // Some Mixlayer qwen variants answer in reasoning_content despite /no_think.
    return msg.content || msg.reasoning_content || d.choices?.[0]?.text || '';
  }
  const url = qwenUrl();
  if (!url) throw new Error('no LLM configured: set scorer.mixlayer.api_key or infra.qwen_url in config/profile.yml');
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: QWEN_FALLBACK_MODEL, prompt, stream: false, think: false, keep_alive: '5m' }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`qwen HTTP ${r.status}`);
  return (await r.json()).response || '';
}

/** changedetection.io { apiUrl, apiKey } (env CD_API_URL / CD_API_KEY win). */
export function changedetection() {
  const cd = infra().changedetection || {};
  return {
    apiUrl: process.env.CD_API_URL || cd.api_url || '',
    apiKey: process.env.CD_API_KEY || cd.api_key || '',
  };
}

/** Browserless { httpUrl, wsUrl, token } (env BROWSERLESS_* win). */
export function browserless() {
  const b = infra().browserless || {};
  return {
    httpUrl: process.env.BROWSERLESS_HTTP_URL || b.http_url || '',
    wsUrl: process.env.BROWSERLESS_WS_URL || b.ws_url || '',
    token: process.env.BROWSERLESS_TOKEN || b.token || '',
  };
}

/** Add a Browserless token without duplicating or corrupting query params. */
export function tokenizedUrl(endpoint, token) {
  if (!endpoint) return '';
  try {
    const url = new URL(endpoint);
    if (token) url.searchParams.set('token', token);
    return url.href;
  } catch {
    return '';
  }
}

/** Browserless HTTP action endpoint, e.g. browserlessHttpUrl('content'). */
export function browserlessHttpUrl(action = 'content') {
  const config = browserless();
  if (!config.httpUrl) return '';
  try {
    const base = new URL(config.httpUrl);
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${String(action).replace(/^\//, '')}`;
    return tokenizedUrl(base.href, config.token);
  } catch {
    return '';
  }
}

/** Configured Browserless Playwright websocket URL with its token. */
export function browserlessWsUrl() {
  const config = browserless();
  return tokenizedUrl(config.wsUrl, config.token);
}

/** FlareSolverr endpoint (env FLARESOLVERR_URL wins). '' if unset. */
export function flaresolverrUrl() {
  return process.env.FLARESOLVERR_URL || infra().flaresolverr_url || '';
}
