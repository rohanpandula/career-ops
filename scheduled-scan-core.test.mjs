import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  captureResponseDuringNavigation,
  parseWorkdayPostedOn,
} from './scheduled-scan-core.mjs';

test('parseWorkdayPostedOn handles current, old, and unknown values', () => {
  assert.equal(parseWorkdayPostedOn('Posted Today'), 0);
  assert.equal(parseWorkdayPostedOn('Posted Yesterday'), 1);
  assert.equal(parseWorkdayPostedOn('Posted 30+ Days Ago'), 30);
  assert.equal(parseWorkdayPostedOn('Recently posted'), null);
});

test('captureResponseDuringNavigation arms capture before navigation', async () => {
  const calls = [];
  const response = { json: async () => ({ ok: true }) };
  const page = {
    waitForResponse() { calls.push('wait'); return Promise.resolve(response); },
    goto() { calls.push('goto'); return Promise.resolve(); },
  };
  assert.equal(await captureResponseDuringNavigation(page, () => true, {}, 'https://example.com', {}), response);
  assert.deepEqual(calls, ['wait', 'goto']);
});

test('captureResponseDuringNavigation observes both failures', async () => {
  const page = {
    waitForResponse() { return Promise.reject(new Error('capture failed')); },
    goto() { return Promise.reject(new Error('navigation failed')); },
  };
  await assert.rejects(
    captureResponseDuringNavigation(page, () => true, {}, 'https://example.com', {}),
    /capture failed|navigation failed/,
  );
});
