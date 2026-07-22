import { test } from "node:test";
import assert from "node:assert/strict";
import {
  escapeAttr,
  escapeHtml,
  markdownToHtml,
  processInline,
  safeHttpUrl,
} from "./public/render-utils.mjs";

test("HTML and attribute escaping neutralize executable markup", () => {
  assert.equal(escapeHtml('<img src=x onerror="boom">'), '&lt;img src=x onerror="boom"&gt;');
  assert.equal(escapeAttr('x&y" onmouseover="boom'), 'x&amp;y&quot; onmouseover=&quot;boom');
});

test("markdown escapes raw HTML", () => {
  const html = markdownToHtml('# Report\n<script>globalThis.pwned = true</script>');
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;/i);
});

test("markdown rejects executable link schemes", () => {
  const html = processInline('[click](javascript:alert(1))');
  assert.doesNotMatch(html, /href=/i);
  assert.doesNotMatch(html, /javascript:/i);
  assert.match(html, /click/);
});

test("markdown preserves safe HTTPS and relative links", () => {
  assert.match(processInline('[site](https://example.com/a?b=1&c=2)'), /href="https:\/\/example\.com\/a\?b=1&amp;c=2"/);
  assert.match(processInline('[report](../reports/001-example.md)'), /href="\.\.\/reports\/001-example\.md"/);
});

test("safeHttpUrl accepts only HTTP(S)", () => {
  assert.equal(safeHttpUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,boom'), null);
});

test("each markdown table gets its own header row", () => {
  const html = markdownToHtml("| A |\n|---|\n| 1 |\n\n| B |\n|---|\n| 2 |");
  assert.equal((html.match(/<th>/g) || []).length, 2);
  assert.equal((html.match(/<td>/g) || []).length, 2);
});
