import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { JSDOM } from "jsdom";

interface PostedMessage { type: string; text?: string; decision?: string; candidateId?: string; candidateIds?: string[]; templateId?: string; url?: string }
interface DetailItem { key: string; html: string }

function detail(overrides: Record<string, unknown> = {}) {
  return { id: "one", title: "Session one", status: "running", currentActivity: "処理中", cwd: "C:\\work", canInterrupt: true, attentionHtml: "", activities: [] as DetailItem[], audits: [] as DetailItem[], ...overrides };
}

async function createWebview() {
  const posted: PostedMessage[] = [];
  const dom = new JSDOM(`<!doctype html><body><header><h1 id="title"></h1><button id="interrupt"></button><span id="status"></span><span id="current-activity"></span><p id="cwd"></p></header><div id="attention"></div><form id="message-form"><textarea id="message"></textarea><button type="submit">送信</button></form><div role="tablist"><button id="activity-tab" role="tab" data-tab="activity" aria-controls="activity-panel"></button><button id="audit-tab" role="tab" data-tab="audit" aria-controls="audit-panel"></button></div><section id="activity-panel"><p class="empty"></p></section><section id="audit-panel"><table><tbody></tbody></table><p class="empty"></p></section></body>`, { runScripts: "outside-only", url: "https://agenthub.test/", pretendToBeVisual: true });
  let state: unknown;
  Object.defineProperty(dom.window, "acquireVsCodeApi", { value: () => ({ postMessage: (message: PostedMessage) => posted.push(message), getState: () => state, setState: (value: unknown) => { state = value; } }) });
  Object.defineProperty(dom.window, "createImageBitmap", { value: async () => ({ width: 100, height: 80, close() {} }) });
  dom.window.HTMLCanvasElement.prototype.getContext = (() => ({ drawImage() {} })) as unknown as typeof dom.window.HTMLCanvasElement.prototype.getContext;
  dom.window.eval(await readFile(path.resolve("media/session-detail.js"), "utf8"));
  return { dom, posted };
}

test("detail image paste shows a removable thumbnail and sends the image", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  const input = dom.window.document.querySelector<HTMLTextAreaElement>("#message")!;
  const file = new dom.window.File(["png"], "shot.png", { type: "image/png" });
  const paste = new dom.window.Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(paste, "clipboardData", { value: { items: [{ kind: "file", type: file.type, getAsFile: () => file }] } });
  input.dispatchEvent(paste);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(dom.window.document.querySelectorAll("#message-images canvas").length, 1);
  assert.equal(dom.window.document.querySelectorAll("#message-images button").length, 1);
  input.closest("form")!.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  assert.equal((posted.at(-1) as PostedMessage & { images?: unknown[] }).images?.length, 1);
});

test("detail accepts a dropped PDF and sends it as an attachment", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  const form = dom.window.document.querySelector<HTMLFormElement>("#message-form")!;
  const file = new dom.window.File(["%PDF-1.7"], "spec.pdf", { type: "application/pdf" });
  const drop = new dom.window.Event("drop", { bubbles: true, cancelable: true });
  Object.defineProperty(drop, "dataTransfer", { value: { files: [file] } });
  form.dispatchEvent(drop);
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(dom.window.document.querySelector("#message-images .pdf-attachment")?.textContent, "PDF spec.pdf");
  form.dispatchEvent(new dom.window.SubmitEvent("submit", { bubbles: true, cancelable: true }));
  const attachment = (posted.at(-1) as PostedMessage & { images?: Array<{ mimeType: string; name?: string }> }).images?.[0];
  assert.deepEqual(attachment && { mimeType: attachment.mimeType, name: attachment.name }, { mimeType: "application/pdf", name: "spec.pdf" });
});

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

test("Codex result links include a copy action", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  update(dom, detail({ activities: [{ key: "link", html: '<div class="markdown"><p><a href="https://example.com/download?id=1">ダウンロード</a></p></div>' }] }));

  const button = dom.window.document.querySelector<HTMLButtonElement>(".copy-link")!;
  assert.equal(button.textContent, "コピー");
  assert.equal(button.getAttribute("aria-label"), "リンク「ダウンロード」をコピー");
  button.click();

  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "copyLink", url: "https://example.com/download?id=1" }));
  assert.equal(button.textContent, "コピー済み");
});

test("clicking a local result link reveals the file in its folder", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  update(dom, detail({ activities: [{ key: "file", html: '<div class="markdown"><a href="C:/exports/Setup.exe">Setup</a></div>' }] }));

  const link = dom.window.document.querySelector<HTMLAnchorElement>(".markdown a")!;
  assert.equal(link.title, "クリックして保存先フォルダを開く");
  const click = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
  link.dispatchEvent(click);

  assert.equal(click.defaultPrevented, true);
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "revealLocalFile", url: "C:/exports/Setup.exe" }));
});

test("Escape interrupts only an interruptible detail session", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  update(dom, detail({ canInterrupt: true }));

  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "interrupt" }));

  update(dom, detail({ status: "completed", canInterrupt: false }));
  const count = posted.length;
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  dom.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", isComposing: true, bubbles: true, cancelable: true }));
  assert.equal(posted.length, count);
});

test("message templates are grouped, inserted, saved, and custom templates can be deleted", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  update(dom, detail({ promptTemplates: [
    { id: "builtin:design", category: "デザイン", name: "調査", text: "Figmaを調査", builtIn: true },
    { id: "custom:review", category: "レビュー", name: "確認", text: "差分を確認", builtIn: false },
  ] }));
  const document = dom.window.document;
  const select = document.querySelector<HTMLSelectElement>("#prompt-template")!;
  assert.deepEqual([...select.querySelectorAll("optgroup")].map((group) => group.label), ["デザイン", "レビュー"]);
  select.value = "custom:review";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(document.querySelector<HTMLTextAreaElement>("#message")!.value, "差分を確認");
  assert.equal(document.querySelector<HTMLButtonElement>("#delete-template")!.disabled, false);
  assert.equal(document.querySelector<HTMLButtonElement>("#rename-template")!.disabled, false);
  document.querySelector<HTMLButtonElement>("#rename-template")!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "renameTemplate", templateId: "custom:review" }));
  document.querySelector<HTMLButtonElement>("#save-template")!.click();
  assert.equal(document.querySelector<HTMLButtonElement>("#save-template")!.textContent, "上書き保存");
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "saveTemplate", text: "差分を確認", templateId: "custom:review" }));
  document.querySelector<HTMLButtonElement>("#delete-template")!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "deleteTemplate", templateId: "custom:review" }));
  select.value = "builtin:design";
  select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(document.querySelector<HTMLButtonElement>("#delete-template")!.disabled, false);
  assert.equal(document.querySelector<HTMLButtonElement>("#rename-template")!.disabled, true);
  assert.equal(document.querySelector<HTMLButtonElement>("#save-template")!.textContent, "現在の本文を保存");
});

test("session detail does not render repository integration controls", async (context) => {
  const { dom, posted } = await createWebview(); context.after(() => dom.window.close());
  assert.equal(dom.window.document.querySelector("#merge-tab"), null);
  assert.equal(dom.window.document.querySelector("#worktree-tab"), null);
  assert.equal(JSON.stringify(posted), JSON.stringify([{ type: "ready" }]));
  return;
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "mergeQueue", candidates: [
    { id: "safe", branch: "issue/39", baseBranch: "develop", rootPath: "C:\\work\\.worktrees\\issue-39", mergeStatus: "unmerged", dirty: false },
    { id: "dirty", branch: "issue/40", baseBranch: "develop", rootPath: "C:\\work\\.worktrees\\issue-40", mergeStatus: "unmerged", dirty: true },
    { id: "merged", branch: "issue/38", baseBranch: "develop", rootPath: "C:\\work\\.worktrees\\issue-38", mergeStatus: "merged", dirty: false, inUse: false },
    { id: "conflict", branch: "issue/44", baseBranch: "develop", rootPath: "C:\\work\\.worktrees\\issue-44", mergeStatus: "unmerged", dirty: false, conflict: true },
  ] } }));
  const safe = dom.window.document.querySelector<HTMLInputElement>('[data-merge-candidate="safe"]')!;
  const dirty = dom.window.document.querySelector<HTMLButtonElement>('[data-commit-worktree="dirty"]')!.closest("article")!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.equal(safe.disabled, false); assert.equal(dirty.disabled, false);
  assert.equal(safe.closest("article")?.parentElement?.id, "merge-candidates");
  assert.equal(dom.window.document.querySelector('[data-cleanup-candidate="merged"]')?.closest("article")?.parentElement?.id, "merged-worktrees");
  assert.equal(dom.window.document.querySelector("#worktree-tab")?.textContent, "ワークツリー");
  safe.click();
  const runMerge = dom.window.document.querySelector<HTMLButtonElement>("#run-merge")!;
  runMerge.click();
  runMerge.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "mergeQueue", candidateIds: ["safe"] }));
  assert.equal(posted.filter((message) => message.type === "mergeQueue").length, 1);
  assert.equal(runMerge.disabled, true);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "mergeQueueComplete" } }));
  assert.equal(runMerge.disabled, false);
  const cleanup = dom.window.document.querySelector<HTMLInputElement>('[data-cleanup-candidate="merged"]')!;
  cleanup.click();
  dom.window.document.querySelector<HTMLButtonElement>("#remove-worktrees")!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "removeWorktrees", candidateIds: ["merged"] }));
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "mergeQueueComplete" } }));
  dom.window.document.querySelector<HTMLButtonElement>('[data-open-changes="dirty"]')!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "openWorktreeChanges", candidateId: "dirty" }));
  dom.window.document.querySelector<HTMLButtonElement>('[data-commit-worktree="dirty"]')!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "commitWorktree", candidateId: "dirty" }));
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "mergeQueueComplete" } }));
  dirty.click();
  dom.window.document.querySelector<HTMLButtonElement>("#run-commit")!.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "commitWorktrees", candidateIds: ["dirty"] }));
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>('[data-commit-worktree="dirty"]')!.textContent, "コミット依頼");
  const dirtyRow = dom.window.document.querySelector<HTMLButtonElement>('[data-commit-worktree="dirty"]')!.closest("article")!;
  assert.equal(dirtyRow.querySelector(".merge-path")?.textContent, "C:\\…\\.worktrees\\issue-40");
  assert.equal(dirtyRow.children.length, 1);
  assert.equal(dirtyRow.querySelector(".merge-summary")?.lastElementChild?.classList.contains("merge-actions"), true);
  assert.equal(dom.window.document.querySelector('[data-commit-worktree="merged"]'), null);
  const conflict = dom.window.document.querySelector<HTMLButtonElement>('[data-resolve-conflict="conflict"]')!;
  assert.equal(conflict.textContent, "競合解決を依頼");
  assert.equal(conflict.closest("article")!.querySelector('[data-merge-candidate="conflict"]'), null);
  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "mergeQueueComplete" } }));
  conflict.click();
  assert.equal(JSON.stringify(posted.at(-1)), JSON.stringify({ type: "resolveConflict", candidateId: "conflict" }));
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#refresh-merge")!.textContent, "更新");
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#run-commit")!.textContent, "選択分をコミット");
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#run-merge")!.textContent, "選択分をマージ");
  assert.equal(dom.window.document.querySelector<HTMLButtonElement>("#remove-worktrees")!.textContent, "選択分を削除");

  dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { type: "mergeQueue", candidates: [
    { id: "safe", branch: "issue/39", baseBranch: "develop", rootPath: "C:\\work\\.worktrees\\issue-39", mergeStatus: "merged", dirty: false, inUse: false },
  ] } }));
  assert.equal(dom.window.document.querySelector('[data-cleanup-candidate="safe"]')?.closest("article")?.parentElement?.id, "merged-worktrees");
  assert.equal(dom.window.document.querySelector("#merge-candidates .empty")?.textContent, "マージ前のworktreeはありません。");
});
