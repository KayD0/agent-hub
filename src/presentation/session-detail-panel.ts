import * as path from "node:path";
import * as vscode from "vscode";
import { RepositoryManager } from "../application/repository-manager";
import { isWorktreeRepository } from "../application/repository-visibility";
import { SessionChange, SessionManager } from "../application/session-manager";
import { conflictResolutionInstruction, worktreeCommitInstruction } from "../application/worktree-session";
import { ManagedSession, SessionActivity } from "../domain/session";
import { WorktreeMergeManager } from "../infrastructure/git/worktree-merge-manager";
import { renderMarkdown } from "./markdown-renderer";
import { parsePastedImages } from "../infrastructure/filesystem/image-input-store";
import { SessionImageInputCoordinator } from "./session-image-input-coordinator";
import { PromptTemplateStore } from "../infrastructure/vscode/prompt-template-store";

const UPDATE_DELAY_MS = 80;
const URGENT_STATUSES = new Set(["waiting_for_approval", "waiting_for_input", "completed", "failed", "interrupted"]);

interface PanelState {
  panel: vscode.WebviewPanel;
  renderCache: DetailRenderCache;
  lastSnapshot?: string;
  lastStatus?: string;
  timer?: NodeJS.Timeout;
  dirty: boolean;
}

interface DetailRenderCache {
  activityHtml: WeakMap<SessionActivity, string>;
  objectKeys: WeakMap<object, string>;
  nextKey: number;
}

interface MergeCandidate {
  id: string;
  name: string;
  rootPath: string;
  branch: string;
  baseBranch: string;
  mergeStatus: "base" | "merged" | "unmerged" | "unknown";
  dirty: boolean;
  inUse: boolean;
  conflict?: boolean;
}

export class SessionDetailPanel implements vscode.Disposable {
  private readonly panels = new Map<string, PanelState>();
  private readonly mergingSessions = new Set<string>();
  private readonly subscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly repositories: RepositoryManager,
    private readonly worktreeMerges: WorktreeMergeManager,
    private readonly openRepositoryChanges: (groupId: string, repositoryId: string) => Promise<void>,
    private readonly extensionUri: vscode.Uri,
    private readonly imageInputs: SessionImageInputCoordinator,
    private readonly promptTemplates: PromptTemplateStore,
    private readonly onError: (error: unknown) => void,
  ) {
    this.subscription = manager.onDidChange((change) => this.refreshChanged(change));
  }

  public show(sessionId: string): void {
    const existing = this.panels.get(sessionId);
    if (existing) {
      existing.panel.reveal();
      this.postUpdate(sessionId, existing, true);
      return;
    }
    const session = this.manager.get(sessionId);
    if (!session) throw new Error("セッションが見つかりません。");
    this.manager.markRead(sessionId);
    const panel = vscode.window.createWebviewPanel(
      "agentHub.sessionDetail", `AgentHub: ${session.title}`, vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    const state: PanelState = { panel, renderCache: { activityHtml: new WeakMap(), objectKeys: new WeakMap(), nextKey: 1 }, dirty: true };
    this.panels.set(sessionId, state);
    panel.onDidDispose(() => { if (state.timer) clearTimeout(state.timer); this.panels.delete(sessionId); });
    panel.onDidChangeViewState(() => { if (panel.visible && state.dirty) this.postUpdate(sessionId, state, true); });
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(sessionId, state, message));
    panel.webview.html = renderShell(panel.webview, this.extensionUri);
  }

  public dispose(): void {
    this.subscription.dispose();
    for (const state of this.panels.values()) { if (state.timer) clearTimeout(state.timer); state.panel.dispose(); }
    this.panels.clear();
  }

  private async handleMessage(sessionId: string, state: PanelState, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; text?: unknown; images?: unknown; decision?: unknown; candidateId?: unknown; candidateIds?: unknown; templateId?: unknown; url?: unknown };
    if (message.type === "ready") { this.postUpdate(sessionId, state, true); await this.refreshMergeQueue(sessionId, state); return; }
    try {
      if (message.type === "send" && typeof message.text === "string") {
        const images = parsePastedImages(message.images);
        if (!images || (!message.text.trim() && !images.length)) return;
        await this.imageInputs.sendMessage(sessionId, message.text.trim(), images);
      }
      else if (message.type === "saveTemplate" && typeof message.text === "string") {
        if (typeof message.templateId === "string") {
          const overwritten = await this.promptTemplates.overwrite(message.templateId, message.text);
          if (overwritten) {
            this.postUpdate(sessionId, state, true);
            void state.panel.webview.postMessage({ type: "templateSelected", templateId: overwritten.id });
            void vscode.window.showInformationMessage(`テンプレート「${overwritten.name}」を上書きしました。`);
            return;
          }
        }
        const category = await vscode.window.showInputBox({ title: "テンプレートを保存", prompt: "カテゴリ", placeHolder: "例: デザイン、レビュー、調査", ignoreFocusOut: true });
        if (category === undefined) return;
        const name = await vscode.window.showInputBox({ title: "テンプレートを保存", prompt: "テンプレート名", placeHolder: "例: Figmaデザイン調査", ignoreFocusOut: true });
        if (name === undefined) return;
        const template = await this.promptTemplates.save(category, name, message.text);
        this.postUpdate(sessionId, state, true);
        void state.panel.webview.postMessage({ type: "templateSelected", templateId: template.id });
        void vscode.window.showInformationMessage(`テンプレート「${template.name}」を保存しました。`);
      }
      else if (message.type === "deleteTemplate" && typeof message.templateId === "string") {
        const template = this.promptTemplates.list().find((item) => item.id === message.templateId);
        if (!template) return;
        const answer = await vscode.window.showWarningMessage(`テンプレート「${template.name}」を削除しますか？`, { modal: true }, "削除");
        if (answer !== "削除") return;
        await this.promptTemplates.remove(template.id);
        this.postUpdate(sessionId, state, true);
      }
      else if (message.type === "renameTemplate" && typeof message.templateId === "string") {
        const template = this.promptTemplates.list().find((item) => item.id === message.templateId && !item.builtIn);
        if (!template) return;
        const category = await vscode.window.showInputBox({ title: "テンプレート名を変更", prompt: "カテゴリ", value: template.category, ignoreFocusOut: true });
        if (category === undefined) return;
        const name = await vscode.window.showInputBox({ title: "テンプレート名を変更", prompt: "テンプレート名", value: template.name, ignoreFocusOut: true });
        if (name === undefined) return;
        const renamed = await this.promptTemplates.rename(template.id, category, name);
        if (!renamed) return;
        this.postUpdate(sessionId, state, true);
        void state.panel.webview.postMessage({ type: "templateSelected", templateId: renamed.id });
      }
      else if (message.type === "interrupt") await this.manager.interrupt(sessionId);
      else if (message.type === "copyLink" && typeof message.url === "string" && message.url.length > 0 && message.url.length <= 8192) {
        await vscode.env.clipboard.writeText(message.url);
      }
      else if (message.type === "approval" && isDecision(message.decision)) this.manager.resolveApproval(sessionId, message.decision);
      else if (message.type === "refreshMergeQueue") await this.refreshMergeQueue(sessionId, state);
      else if (message.type === "openWorktreeChanges" && typeof message.candidateId === "string") {
        const group = this.groupForSession(sessionId);
        const candidate = (await this.mergeCandidates(sessionId)).find((item) => item.id === message.candidateId);
        if (!group || !candidate) throw new Error("対象worktreeを再確認できませんでした。");
        await this.openRepositoryChanges(group.id, candidate.id);
      }
      else if (message.type === "commitWorktree" && typeof message.candidateId === "string") {
        await this.requestWorktreeCommits(sessionId, state, [message.candidateId]);
      }
      else if (message.type === "commitWorktrees" && Array.isArray(message.candidateIds)) {
        await this.requestWorktreeCommits(sessionId, state, message.candidateIds);
      }
      else if (message.type === "resolveConflict" && typeof message.candidateId === "string") {
        const candidate = (await this.mergeCandidates(sessionId)).find((item) => item.id === message.candidateId);
        if (!candidate || candidate.conflict !== true) throw new Error("競合対象を再確認できませんでした。");
        await this.manager.sendMessage(sessionId, conflictResolutionInstruction(candidate, candidate.baseBranch));
        void state.panel.webview.postMessage({ type: "mergeQueueComplete" });
        void vscode.window.showInformationMessage(`${candidate.branch}の競合解決を現在のセッションへ依頼しました。`);
      }
      else if (message.type === "removeWorktrees" && Array.isArray(message.candidateIds)) {
        if (this.mergingSessions.has(sessionId)) throw new Error("このセッションのworktree操作は処理中です。");
        const group = this.groupForSession(sessionId);
        if (!group) throw new Error("登録フォルダを再確認できませんでした。");
        const ids = [...new Set(message.candidateIds.filter((id): id is string => typeof id === "string"))];
        const candidates = await this.mergeCandidates(sessionId);
        const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id)).filter((candidate): candidate is MergeCandidate => Boolean(candidate));
        if (!selected.length || selected.length !== ids.length || selected.some((candidate) => candidate.dirty || candidate.inUse || candidate.mergeStatus !== "merged")) throw new Error("削除対象の安全条件を再確認できませんでした。");
        const details = selected.map((candidate, index) => `${index + 1}. ${candidate.branch}`).join("\n");
        const answer = await vscode.window.showWarningMessage(`次のマージ済みworktreeを削除します。ブランチは削除しません。\n\n${details}`, { modal: true }, "worktreeを削除");
        if (answer !== "worktreeを削除") { void state.panel.webview.postMessage({ type: "mergeQueueComplete" }); return; }
        this.mergingSessions.add(sessionId);
        try {
          for (const candidate of selected) await this.worktreeMerges.remove(candidate.rootPath, candidate.branch, group.rootPath, candidate.baseBranch);
          void vscode.window.showInformationMessage(`${selected.length}件のworktreeを削除しました。`);
          await this.refreshMergeQueue(sessionId, state);
        } finally {
          this.mergingSessions.delete(sessionId);
          void state.panel.webview.postMessage({ type: "mergeQueueComplete" });
        }
      }
      else if (message.type === "mergeQueue" && Array.isArray(message.candidateIds)) {
        if (this.mergingSessions.has(sessionId)) throw new Error("このセッションのマージキューは処理中です。");
        this.mergingSessions.add(sessionId);
        try {
        const ids = [...new Set(message.candidateIds.filter((id): id is string => typeof id === "string"))];
        const candidates = await this.mergeCandidates(sessionId);
        const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id)).filter((candidate): candidate is MergeCandidate => Boolean(candidate));
        if (!selected.length || selected.length !== ids.length) throw new Error("マージ対象を再確認できませんでした。");
        const details = selected.map((candidate, index) => `${index + 1}. ${candidate.branch} → ${candidate.baseBranch}`).join("\n");
        const answer = await vscode.window.showWarningMessage(`次のブランチを表示順でマージします。pushとworktree削除は行いません。\n\n${details}`, { modal: true }, "順番にマージ");
        if (answer !== "順番にマージ") return;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "マージキューを処理しています" }, async (progress) => {
          for (const candidate of selected) {
            progress.report({ message: candidate.branch });
            await this.worktreeMerges.merge(candidate.rootPath, candidate.branch, candidate.baseBranch);
          }
        });
        void vscode.window.showInformationMessage(`${selected.length}件のブランチをマージしました。`);
        await this.refreshMergeQueue(sessionId, state);
        } finally {
          this.mergingSessions.delete(sessionId);
          void state.panel.webview.postMessage({ type: "mergeQueueComplete" });
        }
      }
    } catch (error) { void state.panel.webview.postMessage({ type: "mergeQueueComplete" }); this.onError(error); }
  }

  private async refreshMergeQueue(sessionId: string, state: PanelState): Promise<void> {
    const candidates = await this.mergeCandidates(sessionId);
    void state.panel.webview.postMessage({ type: "mergeQueue", candidates });
  }

  private async requestWorktreeCommits(sessionId: string, state: PanelState, values: unknown[]): Promise<void> {
    const ids = [...new Set(values.filter((id): id is string => typeof id === "string"))];
    const candidates = await this.mergeCandidates(sessionId);
    const selected = ids.map((id) => candidates.find((candidate) => candidate.id === id)).filter((candidate): candidate is MergeCandidate => Boolean(candidate));
    if (!selected.length || selected.length !== ids.length || selected.some((candidate) => !candidate.dirty)) throw new Error("未コミット差分の対象を再確認できませんでした。");
    await this.manager.sendMessage(sessionId, worktreeCommitInstruction(selected));
    void state.panel.webview.postMessage({ type: "mergeQueueComplete" });
    void vscode.window.showInformationMessage(`${selected.length}件のコミット作業を現在のセッションへ依頼しました。`);
  }

  private async mergeCandidates(sessionId: string): Promise<MergeCandidate[]> {
    const session = this.manager.get(sessionId);
    if (!session) return [];
    const group = this.groupForSession(sessionId);
    if (!group) return [];
    const snapshot = await this.repositories.groupSnapshot(group);
    return Promise.all(snapshot.repositories.filter((repository) => isWorktreeRepository(group.rootPath, repository.rootPath) && repository.branch).map(async (repository) => {
      const baseBranch = repository.baseBranch ?? "develop";
      const dirty = repository.files.length > 0;
      const conflict = !dirty && repository.mergeStatus === "unmerged"
        ? await this.worktreeMerges.hasMergeConflict(repository.rootPath, repository.branch!, baseBranch).catch(() => undefined)
        : false;
      return {
        id: repository.id,
        name: repository.name,
        rootPath: repository.rootPath,
        branch: repository.branch!,
        baseBranch,
        mergeStatus: repository.mergeStatus,
        dirty,
        inUse: this.manager.list().some((candidate) => isActive(candidate.status) && samePath(candidate.cwd, repository.rootPath)),
        conflict,
      };
    }));
  }

  private groupForSession(sessionId: string) {
    const session = this.manager.get(sessionId);
    if (!session) return undefined;
    return this.repositories.list().filter((candidate) => isInside(session.cwd, candidate.rootPath)).sort((left, right) => right.rootPath.length - left.rootPath.length)[0];
  }

  private refreshChanged(change: SessionChange): void {
    for (const [sessionId, state] of this.panels) {
      if (change.sessionId && change.sessionId !== sessionId) continue;
      const session = this.manager.get(sessionId);
      if (!session) { state.panel.dispose(); continue; }
      const urgent = session.status !== state.lastStatus && URGENT_STATUSES.has(session.status);
      if (!state.panel.visible) { state.dirty = true; continue; }
      if (urgent) { if (state.timer) clearTimeout(state.timer); state.timer = undefined; this.postUpdate(sessionId, state); continue; }
      if (!state.timer) state.timer = setTimeout(() => { state.timer = undefined; this.postUpdate(sessionId, state); }, UPDATE_DELAY_MS);
    }
  }

  private postUpdate(sessionId: string, state: PanelState, force = false): void {
    const session = this.manager.get(sessionId);
    if (!session) { state.panel.dispose(); return; }
    const snapshot = detailSnapshot(session, state.renderCache, this.promptTemplates.list());
    const serialized = JSON.stringify(snapshot);
    state.dirty = false;
    state.lastStatus = session.status;
    state.panel.title = `AgentHub: ${session.title}`;
    if (!force && serialized === state.lastSnapshot) return;
    state.lastSnapshot = serialized;
    void state.panel.webview.postMessage({ type: "sessionDetail", session: snapshot });
  }
}

export function detailSnapshot(session: ManagedSession, cache: DetailRenderCache = { activityHtml: new WeakMap(), objectKeys: new WeakMap(), nextKey: 1 }, promptTemplates: ReturnType<PromptTemplateStore["list"]> = []) {
  return {
    id: session.id, title: session.title, status: session.status, currentActivity: session.currentActivity ?? "", cwd: session.cwd,
    canInterrupt: ["starting", "running", "waiting_for_input"].includes(session.status),
    promptTemplates,
    attentionHtml: renderAttention(session),
    activities: session.activities.slice().reverse().map((activity) => ({
      key: objectKey(activity, cache, "activity"),
      html: cachedActivityHtml(activity, cache.activityHtml),
    })),
    audits: session.approvalAudit.slice().reverse().map((entry) => ({
      key: objectKey(entry, cache, "audit"),
      html: `<td>${escapeHtml(new Date(entry.timestamp).toLocaleString())}</td><td>${escapeHtml(auditDecisionLabel(entry.decision))}</td><td>${escapeHtml(entry.subject ?? "-")}</td><td>${escapeHtml(entry.reason)}</td><td>${escapeHtml(entry.matchedRule ?? "-")}</td>`,
    })),
  };
}

function objectKey(value: object, cache: DetailRenderCache, prefix: string): string {
  const existing = cache.objectKeys.get(value);
  if (existing) return existing;
  const key = `${prefix}-${cache.nextKey++}`;
  cache.objectKeys.set(value, key);
  return key;
}

function cachedActivityHtml(activity: SessionActivity, cache: WeakMap<SessionActivity, string>): string {
  const cached = cache.get(activity);
  if (cached) return cached;
  const detail = activity.detail ? activity.kind === "message" ? `<div class="markdown">${renderMarkdown(activity.detail)}</div>` : `<pre>${escapeHtml(activity.detail)}</pre>` : "";
  const html = `<div class="activity-head"><strong>${escapeHtml(activity.title)}</strong><time>${escapeHtml(new Date(activity.timestamp).toLocaleTimeString())}</time></div>${detail}`;
  cache.set(activity, html);
  return html;
}

function renderAttention(session: ManagedSession): string {
  const pending = session.pendingInteraction;
  if (pending?.kind === "approval") return `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>${escapeHtml(pending.command ?? pending.description ?? "内容を確認してください")}</p><p class="policy-reason"><strong>Codex承認:</strong> ${escapeHtml(pending.policyReason)}</p><div class="actions"><button data-decision="accept">今回のみ許可</button>${pending.allowForSession ? '<button data-decision="acceptForSession">このセッションで許可</button>' : ""}<button class="secondary" data-decision="decline">拒否</button></div></section>`;
  if (pending?.kind === "input") return `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>回答はサイドバーのセッション項目を展開するか、コマンドから入力してください。</p></section>`;
  return "";
}

function renderShell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "session-detail.js"));
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource};"><style nonce="${nonce}">
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:980px;margin:auto}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px}.header-title{display:flex;align-items:center;gap:12px}.header-title h1{margin-right:auto}.meta{color:var(--vscode-descriptionForeground);word-break:break-all}.status{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.attention{border:1px solid var(--vscode-inputValidation-warningBorder);background:var(--vscode-inputValidation-warningBackground);padding:12px;margin:16px 0}.policy-reason,time{color:var(--vscode-descriptionForeground)}.actions,.template-toolbar,.message-form{display:flex;gap:8px}.actions{flex-wrap:wrap}button{border:0;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{cursor:default;opacity:.55}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.template-toolbar{align-items:center;margin-top:18px}.template-toolbar select{min-width:0;flex:1;padding:7px;background:var(--vscode-dropdown-background);color:var(--vscode-dropdown-foreground);border:1px solid var(--vscode-dropdown-border)}.message-form{margin:8px 0 18px}.message-form textarea{min-width:0;flex:1;min-height:72px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px}.message-form button{align-self:flex-end}.tabs{display:flex;gap:2px;margin-top:4px;border-bottom:1px solid var(--vscode-panel-border)}button.tab{position:relative;padding:8px 14px;color:var(--vscode-foreground);background:transparent}button.tab[aria-selected="true"]{font-weight:600}button.tab[aria-selected="true"]::after{content:"";position:absolute;right:8px;bottom:-1px;left:8px;height:2px;background:var(--vscode-focusBorder)}.tabpanel{padding-top:8px}.tabpanel[hidden]{display:none}article{border-bottom:1px solid var(--vscode-panel-border);padding:10px 0}.activity-head{display:flex;justify-content:space-between;gap:12px}pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:10px;overflow:auto}.audit-wrap{overflow:auto}.audit{border-collapse:collapse;width:100%;font-size:.9em}.audit th,.audit td{border:1px solid var(--vscode-panel-border);padding:6px;text-align:left;vertical-align:top}.markdown{line-height:1.55;overflow-wrap:anywhere}.markdown>:first-child{margin-top:10px}.markdown>:last-child{margin-bottom:0}.markdown h1,.markdown h2,.markdown h3{margin:18px 0 8px}.markdown h1{font-size:1.45em}.markdown h2{font-size:1.25em}.markdown h3{font-size:1.1em}.markdown p,.markdown ul,.markdown ol,.markdown blockquote{margin:8px 0}.markdown blockquote{padding-left:12px;border-left:3px solid var(--vscode-textBlockQuote-border);color:var(--vscode-descriptionForeground)}.markdown code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}.markdown pre code{padding:0;background:transparent}.markdown a{color:var(--vscode-textLink-foreground)}.markdown .copy-link{margin-left:5px;padding:1px 5px;border:1px solid var(--vscode-button-border,transparent);border-radius:3px;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);font-size:.8em;vertical-align:baseline}.markdown .copy-link:hover{background:var(--vscode-button-secondaryHoverBackground)}.markdown table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}.markdown th,.markdown td{padding:5px 8px;border:1px solid var(--vscode-panel-border)}
  </style></head><body><header><div class="header-title"><h1 id="title"></h1><button type="button" id="interrupt" class="secondary" title="処理を中断 (Esc)" hidden>中断</button></div><p><span class="status" id="status"></span> <span id="current-activity"></span></p><p class="meta" id="cwd"></p></header><div id="attention"></div><div class="template-toolbar"><select id="prompt-template" aria-label="メッセージテンプレート"><option value="">テンプレートを選択...</option></select><button type="button" id="save-template" class="secondary">現在の本文を保存</button><button type="button" id="delete-template" class="secondary" disabled>削除</button></div><form class="message-form" id="message-form"><textarea id="message" aria-label="入力内容" placeholder="Codexへ追加入力...（Enterで送信、Shift+Enterで改行、Escで中断）"></textarea><button type="submit">送信</button></form><div class="tabs" role="tablist"><button class="tab" id="activity-tab" role="tab" aria-selected="true" aria-controls="activity-panel" data-tab="activity">アクティビティ</button><button class="tab" id="audit-tab" role="tab" aria-selected="false" aria-controls="audit-panel" data-tab="audit" tabindex="-1">監査ログ</button></div><section class="tabpanel" id="activity-panel" role="tabpanel"><p class="empty">アクティビティはまだありません。</p></section><section class="tabpanel" id="audit-panel" role="tabpanel" hidden><div class="audit-wrap"><table class="audit"><thead><tr><th>日時</th><th>判断</th><th>対象</th><th>理由</th><th>ルール</th></tr></thead><tbody></tbody></table><p class="empty">承認履歴はまだありません。</p></div></section><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

function auditDecisionLabel(decision: "auto_approved" | "accepted" | "accepted_for_session" | "declined"): string { return decision === "auto_approved" ? "自動承認" : decision === "accepted" ? "今回のみ許可" : decision === "accepted_for_session" ? "セッションで許可" : "拒否"; }
function isDecision(value: unknown): value is "accept" | "acceptForSession" | "decline" { return value === "accept" || value === "acceptForSession" || value === "decline"; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
function isInside(candidate: string, root: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function samePath(left: string, right: string): boolean { return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase(); }
function isActive(status: ManagedSession["status"]): boolean { return ["starting", "running", "waiting_for_approval", "waiting_for_input"].includes(status); }
