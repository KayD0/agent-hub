import * as vscode from "vscode";
import { SessionChange, SessionManager } from "../application/session-manager";
import { ManagedSession, SessionActivity } from "../domain/session";
import { renderMarkdown } from "./markdown-renderer";

const UPDATE_DELAY_MS = 80;
const URGENT_STATUSES = new Set(["waiting_for_approval", "waiting_for_input", "completed", "failed", "interrupted"]);

interface PanelState {
  panel: vscode.WebviewPanel;
  activityHtml: WeakMap<SessionActivity, string>;
  lastSnapshot?: string;
  lastStatus?: string;
  timer?: NodeJS.Timeout;
  dirty: boolean;
}

export class SessionDetailPanel implements vscode.Disposable {
  private readonly panels = new Map<string, PanelState>();
  private readonly subscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly extensionUri: vscode.Uri,
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
    const state: PanelState = { panel, activityHtml: new WeakMap(), dirty: true };
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
    const message = value as { type?: unknown; text?: unknown; decision?: unknown };
    if (message.type === "ready") { this.postUpdate(sessionId, state, true); return; }
    try {
      if (message.type === "send" && typeof message.text === "string" && message.text.trim()) await this.manager.sendMessage(sessionId, message.text.trim());
      else if (message.type === "interrupt") await this.manager.interrupt(sessionId);
      else if (message.type === "approval" && isDecision(message.decision)) this.manager.resolveApproval(sessionId, message.decision);
    } catch (error) { this.onError(error); }
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
    const snapshot = detailSnapshot(session, state.activityHtml);
    const serialized = JSON.stringify(snapshot);
    state.dirty = false;
    state.lastStatus = session.status;
    state.panel.title = `AgentHub: ${session.title}`;
    if (!force && serialized === state.lastSnapshot) return;
    state.lastSnapshot = serialized;
    void state.panel.webview.postMessage({ type: "sessionDetail", session: snapshot });
  }
}

export function detailSnapshot(session: ManagedSession, cache = new WeakMap<SessionActivity, string>()) {
  return {
    id: session.id, title: session.title, status: session.status, currentActivity: session.currentActivity ?? "", cwd: session.cwd,
    canInterrupt: ["starting", "running", "waiting_for_input"].includes(session.status),
    attentionHtml: renderAttention(session),
    activities: session.activities.slice().reverse().map((activity, reverseIndex) => ({
      key: `${activity.timestamp}-${session.activities.length - reverseIndex - 1}`,
      html: cachedActivityHtml(activity, cache),
    })),
    audits: session.approvalAudit.slice().reverse().map((entry, reverseIndex) => ({
      key: `${entry.timestamp}-${session.approvalAudit.length - reverseIndex - 1}`,
      html: `<td>${escapeHtml(new Date(entry.timestamp).toLocaleString())}</td><td>${escapeHtml(auditDecisionLabel(entry.decision))}</td><td>${escapeHtml(entry.subject ?? "-")}</td><td>${escapeHtml(entry.reason)}</td><td>${escapeHtml(entry.matchedRule ?? "-")}</td>`,
    })),
  };
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
  if (pending?.kind === "approval") return `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>${escapeHtml(pending.command ?? pending.description ?? "内容を確認してください")}</p><p class="policy-reason"><strong>ポリシー判定:</strong> ${escapeHtml(pending.policyReason)}</p><div class="actions"><button data-decision="accept">今回のみ許可</button>${pending.allowForSession ? '<button data-decision="acceptForSession">このセッションで許可</button>' : ""}<button class="secondary" data-decision="decline">拒否</button></div></section>`;
  if (pending?.kind === "input") return `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>回答はサイドバーのセッション項目を展開するか、コマンドから入力してください。</p></section>`;
  return "";
}

function renderShell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "session-detail.js"));
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' ${webview.cspSource};"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:980px;margin:auto}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px}.header-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.header-title h1{margin-right:auto}.meta{color:var(--vscode-descriptionForeground);word-break:break-all}.status{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.attention{border:1px solid var(--vscode-inputValidation-warningBorder);background:var(--vscode-inputValidation-warningBackground);padding:12px;margin:16px 0}.policy-reason{color:var(--vscode-descriptionForeground)}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.message-form{display:flex;gap:8px;margin:18px 0}.message-form textarea{min-width:0;flex:1;min-height:72px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px}.message-form button{align-self:flex-end}.tabs{display:flex;gap:2px;margin-top:4px;border-bottom:1px solid var(--vscode-panel-border)}button.tab{position:relative;padding:8px 14px;color:var(--vscode-foreground);background:transparent}button.tab[aria-selected="true"]{font-weight:600}button.tab[aria-selected="true"]::after{content:"";position:absolute;right:8px;bottom:-1px;left:8px;height:2px;background:var(--vscode-focusBorder)}.tabpanel{padding-top:8px}.tabpanel[hidden]{display:none}article{border-bottom:1px solid var(--vscode-panel-border);padding:10px 0}.activity-head{display:flex;justify-content:space-between;gap:12px}time{color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:10px;overflow:auto}.audit-wrap{overflow:auto}.audit{border-collapse:collapse;width:100%;font-size:.9em}.audit th,.audit td{border:1px solid var(--vscode-panel-border);padding:6px;text-align:left;vertical-align:top}.markdown{line-height:1.55;overflow-wrap:anywhere}.markdown>:first-child{margin-top:10px}.markdown>:last-child{margin-bottom:0}.markdown h1,.markdown h2,.markdown h3{margin:18px 0 8px}.markdown h1{font-size:1.45em}.markdown h2{font-size:1.25em}.markdown h3{font-size:1.1em}.markdown p,.markdown ul,.markdown ol,.markdown blockquote{margin:8px 0}.markdown blockquote{padding-left:12px;border-left:3px solid var(--vscode-textBlockQuote-border);color:var(--vscode-descriptionForeground)}.markdown code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}.markdown pre code{padding:0;background:transparent}.markdown a{color:var(--vscode-textLink-foreground)}.markdown table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}.markdown th,.markdown td{padding:5px 8px;border:1px solid var(--vscode-panel-border)}</style></head><body><header><div class="header-title"><h1 id="title"></h1><button type="button" id="interrupt" class="secondary" hidden>中断</button></div><p><span class="status" id="status"></span> <span id="current-activity"></span></p><p class="meta" id="cwd"></p></header><div id="attention"></div><form class="message-form" id="message-form"><textarea id="message" aria-label="入力内容" placeholder="Codexへ追加入力...（Enterで送信、Shift+Enterで改行）"></textarea><button type="submit">送信</button></form><div class="tabs" role="tablist"><button class="tab" id="activity-tab" role="tab" aria-selected="true" aria-controls="activity-panel" data-tab="activity">アクティビティ</button><button class="tab" id="audit-tab" role="tab" aria-selected="false" aria-controls="audit-panel" data-tab="audit" tabindex="-1">監査ログ</button></div><section class="tabpanel" id="activity-panel" role="tabpanel"><p class="empty">アクティビティはまだありません。</p></section><section class="tabpanel" id="audit-panel" role="tabpanel" hidden><div class="audit-wrap"><table class="audit"><thead><tr><th>日時</th><th>判断</th><th>対象</th><th>理由</th><th>ルール</th></tr></thead><tbody></tbody></table><p class="empty">承認履歴はまだありません。</p></div></section><script nonce="${nonce}" src="${scriptUri}"></script></body></html>`;
}

function auditDecisionLabel(decision: "auto_approved" | "accepted" | "accepted_for_session" | "declined"): string { return decision === "auto_approved" ? "自動承認" : decision === "accepted" ? "今回のみ許可" : decision === "accepted_for_session" ? "セッションで許可" : "拒否"; }
function isDecision(value: unknown): value is "accept" | "acceptForSession" | "decline" { return value === "accept" || value === "acceptForSession" || value === "decline"; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
