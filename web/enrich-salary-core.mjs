export const WORKDAY_URL_RE =
  /^https?:\/\/([^.]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([^/]+)\/job\/(.+)$/;

export function workdayApiUrl(url) {
  const match = String(url || '').match(WORKDAY_URL_RE);
  if (!match) return null;
  const [, tenant, wd, site, path] = match;
  return `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}/job/${path}`;
}

export function workdaySalary(job) {
  if (!job?.jobDescription) return null;
  const text = job.jobDescription.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 12000);
  const match = text.match(/\$\s?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)\s?(?:[-–—to]+|\sto\s)\s?\$?(\d{2,3}(?:[,.]\d{3})?(?:\s?[Kk])?)/);
  return match ? `$${match[1].replace(/\s/g, '')}–$${match[2].replace(/\s/g, '')}` : null;
}

export async function runPool(items, concurrency, worker) {
  const queue = [...items];
  const count = Math.min(Math.max(1, concurrency), queue.length);
  await Promise.all(Array.from({ length: count }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  }));
}
