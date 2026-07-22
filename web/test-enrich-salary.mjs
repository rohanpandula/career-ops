import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPool, workdayApiUrl, workdaySalary } from './enrich-salary-core.mjs';

test('Workday public URLs map to the matching CXS API endpoint', () => {
  assert.equal(
    workdayApiUrl('https://unitytech.wd1.myworkdayjobs.com/en-US/Unity/job/Remote/Role_R123'),
    'https://unitytech.wd1.myworkdayjobs.com/wday/cxs/unitytech/Unity/job/Remote/Role_R123',
  );
  assert.equal(workdayApiUrl('https://example.com/job/123'), null);
});

test('Workday compensation is extracted from description HTML', () => {
  assert.equal(
    workdaySalary({ jobDescription: '<p>The range is $180,000 to $220,000 annually.</p>' }),
    '$180,000–$220,000',
  );
  assert.equal(workdaySalary({ jobDescription: '<p>Competitive pay</p>' }), null);
});

test('runPool bounds concurrent requests', async () => {
  let active = 0;
  let peak = 0;
  await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
  });
  assert.equal(peak, 2);
});
