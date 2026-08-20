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
  unrestrictedAutoApprove: false,
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

test("folder analysis sessions show their folder and can reopen the analysis result", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("analysis", { origin: {
    kind: "folder_analysis",
    repositoryGroupId: "app",
    repositoryName: "agent-hub",
    rootPath: "C:\\work\\agent-hub",
  } })]);

  const origin = dom.window.document.querySelector<HTMLElement>(".session-origin")!;
  assert.equal(origin.hidden, false);
  assert.equal(origin.textContent, "課題分析 · agent-hub");
  assert.equal(origin.title, "C:\\work\\agent-hub");
  const reopen = dom.window.document.querySelector<HTMLButtonElement>(".analysis-result-toggle")!;
  assert.equal(reopen.hidden, false);
  reopen.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "openAnalysisResult", sessionId: "analysis" }));
});

test("normal sessions do not show the analysis result action", async (context) => {
  const { dom } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("normal")]);
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>(".analysis-result-toggle")?.hidden, true);
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

test("session Auto toggle posts the stable approval contract", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one")]);
  const checkbox = dom.window.document.querySelector<HTMLInputElement>(".auto-control input")!;
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "autoApprove", sessionId: "one", enabled: true }));
  update(dom, [session("one", { autoApprove: true })]);
  assert.equal(dom.window.document.querySelector<HTMLInputElement>(".auto-control input")?.checked, true);
});

test("session unrestricted Auto toggle posts a separate approval contract", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one")]);
  const checkbox = dom.window.document.querySelector<HTMLInputElement>(".unrestricted-auto-control input")!;
  assert.equal(checkbox.checked, false);
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "unrestrictedAutoApprove", sessionId: "one", enabled: true }));
  update(dom, [session("one", { unrestrictedAutoApprove: true })]);
  assert.equal(dom.window.document.querySelector<HTMLInputElement>(".unrestricted-auto-control input")?.checked, true);
  assert.equal(dom.window.document.querySelector<HTMLElement>(".session")?.dataset.unrestrictedAuto, "true");
});

test("safe bulk approval appears only for matching approval requests", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [
    session("safe", { status: "waiting_for_approval", pendingInteraction: { kind: "approval", matchedRule: "command:npm test" } }),
    session("manual", { status: "waiting_for_approval", pendingInteraction: { kind: "approval" } }),
    session("input", { status: "waiting_for_input", pendingInteraction: { kind: "input", questions: [] } }),
  ]);

  const banner = dom.window.document.querySelector<HTMLElement>(".approval-banner")!;
  assert.equal(banner.hidden, false);
  assert.equal(banner.querySelector(".approval-banner-summary")?.textContent, "承認待ち 2件・一括承認対象 1件");
  const approve = banner.querySelector<HTMLButtonElement>(".bulk-approve")!;
  assert.equal(approve.textContent, "安全に一括承認 (1)");
  approve.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "bulkApprove" }));

  update(dom, [session("manual", { status: "waiting_for_approval", pendingInteraction: { kind: "approval" } })]);
  assert.equal(banner.hidden, false);
  assert.equal(approve.hidden, true);
  update(dom, [session("input", { status: "waiting_for_input", pendingInteraction: { kind: "input", questions: [] } })]);
  assert.equal(banner.hidden, true);
});

test("running session places interrupt before Auto", async (context) => {
  const { dom } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one", { status: "running" })]);

  const actions = [...dom.window.document.querySelector(".header-actions")!.children];
  assert.deepEqual(actions.map((node) => node.className), ["secondary header-action", "auto-control", "auto-control unrestricted-auto-control"]);
  assert.equal(actions.map((node) => node.textContent?.trim()).join("|"), "中断|Auto|無制限Auto");
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

test("Escape interrupts the focused running session", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one"), session("two")]);
  const firstInput = dom.window.document.querySelector<HTMLTextAreaElement>('[data-session-id="one"] textarea')!;

  firstInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "interrupt", sessionId: "one" }));

  update(dom, [session("one", { status: "completed" }), session("two")]);
  const count = posted.length;
  firstInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  firstInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
  assert.equal(posted.length, count);
});

test("card image paste shows only a paperclip count and sends the image", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one")]);
  const input = dom.window.document.querySelector<HTMLTextAreaElement>('[data-session-id="one"] textarea')!;
  const file = new dom.window.File(["png"], "shot.png", { type: "image/png" });
  const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] } });
  input.dispatchEvent(paste);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const attachments = dom.window.document.querySelector<HTMLElement>(".card-attachments")!;
  assert.equal(attachments.hidden, false);
  assert.equal(attachments.textContent, "📎 1");
  assert.equal(dom.window.document.querySelector(".card-input-form img,.card-input-form canvas"), null);
  input.closest("form")!.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  assert.equal(posted.at(-1)?.type, "send");
  assert.equal((posted.at(-1) as PostedMessage & { images?: unknown[] }).images?.length, 1);
});

test("card input accepts a dropped PDF", async (context) => {
  const { dom, posted } = await createWebview();
  context.after(() => dom.window.close());
  update(dom, [session("one")]);
  const form = dom.window.document.querySelector<HTMLFormElement>('[data-session-id="one"] .card-input-form')!;
  const file = new dom.window.File(["%PDF-1.7"], "spec.pdf", { type: "application/pdf" });
  const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
  form.dispatchEvent(drop);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(form.querySelector<HTMLElement>(".card-attachments")!.textContent, "📎 1");
  form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  const attachment = (posted.at(-1) as PostedMessage & { images?: Array<{ mimeType: string; name?: string }> }).images?.[0];
  assert.deepEqual(attachment && { mimeType: attachment.mimeType, name: attachment.name }, { mimeType: "application/pdf", name: "spec.pdf" });
});
