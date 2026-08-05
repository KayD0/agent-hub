import * as vscode from "vscode";
import { SessionManager } from "../application/session-manager";

export class SessionDetailPanel implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly subscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly extensionUri: vscode.Uri,
    private readonly onError: (error: unknown) => void,
  ) {
    this.subscription = manager.onDidChange(() => this.refreshAll());
  }

  public show(sessionId: string): void {
    const existing = this.panels.get(sessionId);
    if (existing) {
      existing.reveal();
      this.render(sessionId, existing);
      return;
    }
    const session = this.manager.get(sessionId);
    if (!session) throw new Error("セッションが見つかりません。");
    this.manager.markRead(sessionId);
    const panel = vscode.window.createWebviewPanel(
      "agentHub.sessionDetail",
      `AgentHub: ${session.title}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [this.extensionUri] },
    );
    this.panels.set(sessionId, panel);
    panel.onDidDispose(() => this.panels.delete(sessionId));
    panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(sessionId, message));
    this.render(sessionId, panel);
  }

  public dispose(): void {
    this.subscription.dispose();
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }

  private async handleMessage(sessionId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; text?: unknown; decision?: unknown };
    try {
      if (message.type === "send" && typeof message.text === "string" && message.text.trim()) {
        await this.manager.sendMessage(sessionId, message.text.trim());
      } else if (message.type === "interrupt") {
        await this.manager.interrupt(sessionId);
      } else if (message.type === "approval" && isDecision(message.decision)) {
        this.manager.resolveApproval(sessionId, message.decision);
      }
    } catch (error) {
      this.onError(error);
    }
  }

  private refreshAll(): void {
    for (const [sessionId, panel] of this.panels) this.render(sessionId, panel);
  }

  private render(sessionId: string, panel: vscode.WebviewPanel): void {
    const session = this.manager.get(sessionId);
    if (!session) {
      panel.dispose();
      return;
    }
    const nonce = randomNonce();
    const pending = session.pendingInteraction;
    const approvalHtml = pending?.kind === "approval"
      ? `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>${escapeHtml(pending.command ?? pending.description ?? "内容を確認してください")}</p><div class="actions"><button data-decision="accept">今回のみ許可</button>${pending.allowForSession ? '<button data-decision="acceptForSession">このセッションで許可</button>' : ""}<button class="secondary" data-decision="decline">拒否</button></div></section>`
      : pending?.kind === "input"
        ? `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>回答はサイドバーのセッション項目を展開するか、コマンドから入力してください。</p></section>`
        : "";
    const activities = session.activities.slice().reverse().map((activity) =>
      `<article><div class="activity-head"><strong>${escapeHtml(activity.title)}</strong><time>${new Date(activity.timestamp).toLocaleTimeString()}</time></div>${activity.detail ? `<pre>${escapeHtml(activity.detail)}</pre>` : ""}</article>`,
    ).join("");
    const interruptHtml = ["starting", "running", "waiting_for_input"].includes(session.status)
      ? '<button type="button" id="interrupt" class="secondary">中断</button>'
      : "";
    panel.webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:980px;margin:auto}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px}.header-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.header-title h1{margin-right:auto}.meta{color:var(--vscode-descriptionForeground);word-break:break-all}.status{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.attention{border:1px solid var(--vscode-inputValidation-warningBorder);background:var(--vscode-inputValidation-warningBackground);padding:12px;margin:16px 0}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}form{display:flex;gap:8px;margin:18px 0}textarea{flex:1;min-height:60px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px}article{border-bottom:1px solid var(--vscode-panel-border);padding:10px 0}.activity-head{display:flex;justify-content:space-between;gap:12px}time{color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:10px}</style></head><body><header><div class="header-title"><h1>${escapeHtml(session.title)}</h1>${interruptHtml}</div><p><span class="status">${escapeHtml(session.status)}</span> ${escapeHtml(session.currentActivity ?? "")}</p><p class="meta">${escapeHtml(session.cwd)}</p></header>${approvalHtml}<form id="message-form"><textarea id="message" aria-label="Codexへの追加入力" placeholder="Codexへ追加入力..."></textarea><button type="submit">送信</button></form><h2>アクティビティ</h2>${activities || "<p>アクティビティはまだありません。</p>"}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('message-form').addEventListener('submit',e=>{e.preventDefault();const input=document.getElementById('message');if(input.value.trim()){vscode.postMessage({type:'send',text:input.value});input.value='';}});document.getElementById('interrupt')?.addEventListener('click',()=>vscode.postMessage({type:'interrupt'}));document.querySelectorAll('[data-decision]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'approval',decision:button.dataset.decision})));</script></body></html>`;
  }
}

function isDecision(value: unknown): value is "accept" | "acceptForSession" | "decline" {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function randomNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}
