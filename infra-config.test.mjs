import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenizedUrl } from './infra-config.mjs';

test('tokenizedUrl adds and replaces tokens without corrupting query parameters', () => {
  assert.equal(
    tokenizedUrl('ws://browser.example/playwright/chromium?headless=true', 'new token'),
    'ws://browser.example/playwright/chromium?headless=true&token=new+token',
  );
  assert.equal(
    tokenizedUrl('https://browser.example/content?token=old', 'new'),
    'https://browser.example/content?token=new',
  );
});

test('tokenizedUrl rejects malformed or missing endpoints', () => {
  assert.equal(tokenizedUrl('', 'secret'), '');
  assert.equal(tokenizedUrl('not a URL', 'secret'), '');
});
