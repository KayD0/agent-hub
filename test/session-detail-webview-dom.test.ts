import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { JSDOM } from "jsdom";

interface PostedMessage { type: string; text?: string; decision?: string }
interface DetailItem { key: string; html: string }

function detail(overrides: Record<string, unknown> = {}) {
  return { id: "one", title: "Session one", status: "running", currentActivity: "処理中", cwd: "C:\\work", canInterrupt: true, attentionHtml: "", activities: [] as DetailItem[], audits: [] as DetailItem[], ...overrides };
}

async function createWebview() {
  const posted: PostedMessage[] = [];
  const dom = new JSDOM(`<!doctype html><body><header><h1 id="title"></h1><button id="interrupt"></button><span id="status"></span><span id="current-activity"></span><p id="cwd"></p></header><div id="attention"></div><form id="message-form"><textarea id="message"></textarea><button type="submit">送信</button></form><div role="tablist"><button id="activity-tab" role="tab" data-tab="activity" aria-controls="activity-panel"></button><button id="audit-tab" role="tab" data-tab="audit" aria-controls="audit-panel"></button></div><section id="activity-panel"><p class="empty"></p></section><section id="audit-panel"><table><tbody></tbody></table><p class="empty"></p></section></body>`, { runScripts: "outside-only", url: "https://agenthub.test/", pretendToBeVisual: true });
  let state: unknown;
  Object.defineProperty(dom.window, "acquireVsCodeApi", { value: () => ({ postMessage: (message: PostedMessage) => posted.push(message), getState: () => state, setState: (value: unknown) => { state = value; } }) });
  dom.window.eval(await readFile(path.resolve("media/session-detail.js"), "utf8"));
  return { dom, posted };
}

function update(dom: JSDOM, session: ReturnType<typeof detail>) {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "sessionDetail", session } }));
}

test("detail updates preserve input, focus, selection, tab, scroll, and existing activity nodes", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: "ready" }]));
  update(dom, detail({ activities: [{ key: "a", html: "<strong>first</strong>" }] }));
  const document = dom.window.document;
  const first = document.querySelector('[data-key="a"]');
  const input = document.querySelector<HTMLTextAreaElement>("#message")!;
  input.value = "にほん"; input.focus(); input.setSelectionRange(2, 3);
  document.querySelector<HTMLElement>("#audit-tab")!.click();
  Object.defineProperty(dom.window, "scrollY", { value: 240, writable: true });

  update(dom, detail({ status: "waiting_for_approval", attentionHtml: '<section><button data-decision="accept">許可</button></section>', activities: [{ key: "b", html: "second" }, { key: "a", html: "<strong>first</strong>" }] }));

  assert.equal(document.querySelector('[data-key="a"]'), first);
  assert.equal(input.value, "にほん"); assert.equal(input.selectionStart, 2); assert.equal(input.selectionEnd, 3); assert.equal(document.activeElement, input);
  assert.equal(document.querySelector("#audit-tab")?.getAttribute("aria-selected"), "true");
  assert.equal(dom.window.scrollY, 240);
  document.querySelector<HTMLElement>("[data-decision=accept]")!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "approval", decision: "accept" }));
});

test("detail reconciliation safely handles 500 activities within a measurable budget", async (context) => {
  const { dom } = await createWebview(); context.after(() => dom.window.close());
  const activities = Array.from({ length: 500 }, (_, index) => ({ key: String(index), html: `<div>activity ${index}</div>` }));
  const started = performance.now();
  update(dom, detail({ activities }));
  const elapsed = performance.now() - started;
  assert.equal(dom.window.document.querySelectorAll("#activity-panel article").length, 500);
  assert.ok(elapsed < 2_000, `500 activity reconciliation took ${elapsed.toFixed(1)}ms`);
});

test("detail send contract preserves IME composition", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  const input = dom.window.document.querySelector<HTMLTextAreaElement>("#message")!;
  input.value = "日本語";
  input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
  assert.equal(posted.length, 1);
  input.closest("form")!.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "send", text: "日本語" }));
});
