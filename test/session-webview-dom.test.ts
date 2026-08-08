import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";
import { JSDOM } from "jsdom";

interface PostedMessage { type: string; sessionId?: string; text?: string }

const session = (id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  title: `Session ${id}`,
  status: "running",
  currentActivity: "処理中",
  autoApprove: false,
  repositoryGroupIds: ["app"],
  ...overrides,
});

async function createWebview(): Promise<{ dom: JSDOM; posted: PostedMessage[] }> {
  const posted: PostedMessage[] = [];
  const dom = new JSDOM("<!doctype html><main id=\"sessions\"></main>", {
    runScripts: "outside-only",
    url: "https://agenthub.test/",
    pretendToBeVisual: true,
  });
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({ postMessage: (message: PostedMessage) => posted.push(message) }),
  });
  const script = await readFile(path.resolve("media/session-webview.js"), "utf8");
  dom.window.eval(script);
  return { dom, posted };
}

function update(dom: JSDOM, sessions: Record<string, unknown>[], filter: string[] = []): void {
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: {
    type: "sessions",
    sessions,
    authentication: { status: "authenticated" },
    repositoryGroupFilterIds: filter,
  } }));
}

test("session updates reuse cards and preserve composing textarea state", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: "ready" }]));
  update(dom, [session("one"), session("two")]);
  const document = dom.window.document;
  const firstCard = document.querySelector<HTMLElement>('[data-session-id="one"]')!;
  const secondCard = document.querySelector<HTMLElement>('[data-session-id="two"]')!;
  const textarea = firstCard.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.value = "にほん";
  textarea.focus();
  textarea.setSelectionRange(2, 3);
  textarea.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));

  update(dom, [session("one", { status: "waiting_for_approval" }), session("two", { title: "Updated" })]);

  assert.equal(document.querySelector('[data-session-id="one"]'), firstCard);
  assert.equal(document.querySelector('[data-session-id="two"]'), secondCard);
  assert.equal(firstCard.querySelector("textarea"), textarea);
  assert.equal(textarea.value, "にほん");
  assert.equal(textarea.selectionStart, 2);
  assert.equal(textarea.selectionEnd, 3);
  assert.equal(document.activeElement, textarea);
  assert.equal(firstCard.dataset.status, "waiting_for_approval");
  assert.equal(secondCard.querySelector(".title")?.textContent, "Updated");
});

test("session reconciliation adds, orders, filters, and removes individual cards", async (context) => {
  const { dom } = await createWebview();
  context.after(() => dom.window.close());
  const document = dom.window.document;
  update(dom, [session("one"), session("two")]);
  const firstCard = document.querySelector('[data-session-id="one"]');
  update(dom, [session("two"), session("one"), session("three")]);
  assert.deepEqual([...document.querySelectorAll<HTMLElement>(".session")].map((card) => card.dataset.sessionId), ["two", "one", "three"]);
  assert.equal(document.querySelector('[data-session-id="one"]'), firstCard);

  update(dom, [session("one"), session("two", { status: "waiting_for_approval" })], ["other"]);
  assert.deepEqual([...document.querySelectorAll<HTMLElement>(".session")].map((card) => card.dataset.sessionId), ["two"]);
  assert.equal(document.querySelector('[data-session-id="one"]'), null);
});

test("session content is rendered as text and only one popover opens", async (context) => {
  const { dom } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one", { title: "<img src=x onerror=alert(1)>", finalResult: "done" })]);
  const document = dom.window.document;
  const card = document.querySelector<HTMLElement>('[data-session-id="one"]')!;
  assert.equal(card.querySelector(".title")?.textContent, "<img src=x onerror=alert(1)>");
  assert.equal(card.querySelector("img"), null);

  const result = card.querySelector<HTMLElement>(".result-popover")!;
  const input = card.querySelector<HTMLElement>(".card-input-popover")!;
  result.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(result.classList.contains("is-open"), true);
  input.dispatchEvent(new dom.window.MouseEvent("mouseenter"));
  assert.equal(result.classList.contains("is-open"), false);
  assert.equal(input.classList.contains("is-open"), true);
  assert.equal(document.querySelectorAll(".is-open").length, 1);
});

test("additional input posts the stable session contract", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one")]);
  const textarea = dom.window.document.querySelector<HTMLTextAreaElement>("textarea")!;
  textarea.value = "追加指示";
  textarea.closest("form")!.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "send", sessionId: "one", text: "追加指示" }));
  assert.equal(textarea.value, "");
});

test("session details open from the card without a dedicated button", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one")]);
  const card = dom.window.document.querySelector<HTMLElement>('[data-session-id="one"]')!;
  assert.equal(card.querySelector(".card-open"), null);

  card.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "open", sessionId: "one" }));

  const messageCount = posted.length;
  card.querySelector("textarea")!.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  assert.equal(posted.length, messageCount);

  card.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "open", sessionId: "one" }));
});
