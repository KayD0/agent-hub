import assert from "node:assert/strict";
import test from "node:test";
import { renderMarkdown } from "../src/presentation/markdown-renderer";

test("renders common Markdown used in Codex results", () => {
  const html = renderMarkdown("## 結果\n\n- one\n- two\n\n`code`");

  assert.match(html, /<h2>結果<\/h2>/);
  assert.match(html, /<li>one<\/li>/);
  assert.match(html, /<code>code<\/code>/);
});

test("does not render raw HTML or unsafe links", () => {
  const html = renderMarkdown('<script>alert("xss")</script>\n\n[危険](javascript:alert(1))');

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /href="javascript:/);
});
