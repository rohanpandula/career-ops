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
import yaml from 'js-yaml';

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

/** FlareSolverr endpoint (env FLARESOLVERR_URL wins). '' if unset. */
export function flaresolverrUrl() {
  return process.env.FLARESOLVERR_URL || infra().flaresolverr_url || '';
}
