import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('./', import.meta.url);

test('runtime entry points contain no embedded private endpoints or credentials', async () => {
  const files = [
    'web/server.mjs', 'gap-analysis.mjs', 'cluster-roles.mjs',
    'find-duplicates.mjs', 'fit-score.mjs', 'infer-taste.mjs',
    'weekly-digest.mjs',
  ];
  for (const file of files) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.doesNotMatch(source, /https?:\/\/(?:10|127)\.\d+\.\d+\.\d+/i, file);
    assert.doesNotMatch(source, /(?:api[_-]?key|token)\s*[:=]\s*['"][^'"]{12,}/i, file);
  }
});

test('agent workers never bypass permission checks', async () => {
  for (const file of ['web/server.mjs', 'batch/batch-runner.sh']) {
    const source = await readFile(new URL(file, ROOT), 'utf8');
    assert.doesNotMatch(source, /--dangerously-skip-permissions|--permission-mode["'\s,]+bypassPermissions/, file);
  }
});
