import * as vscode from "vscode";
import { SessionManager } from "../application/session-manager";
import { renderMarkdown } from "./markdown-renderer";

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
      ? `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>${escapeHtml(pending.command ?? pending.description ?? "内容を確認してください")}</p><p class="policy-reason"><strong>Codex承認:</strong> ${escapeHtml(pending.policyReason)}</p><div class="actions"><button data-decision="accept">今回のみ許可</button>${pending.allowForSession ? '<button data-decision="acceptForSession">このセッションで許可</button>' : ""}<button class="secondary" data-decision="decline">拒否</button></div></section>`
      : pending?.kind === "input"
        ? `<section class="attention"><h2>${escapeHtml(pending.title)}</h2><p>回答はサイドバーのセッション項目を展開するか、コマンドから入力してください。</p></section>`
        : "";
    const activities = session.activities.slice().reverse().map((activity) => {
      const detail = activity.detail
        ? activity.kind === "message"
          ? `<div class="markdown">${renderMarkdown(activity.detail)}</div>`
          : `<pre>${escapeHtml(activity.detail)}</pre>`
        : "";
      return `<article><div class="activity-head"><strong>${escapeHtml(activity.title)}</strong><time>${new Date(activity.timestamp).toLocaleTimeString()}</time></div>${detail}</article>`;
    }).join("");
    const interruptHtml = ["starting", "running", "waiting_for_input"].includes(session.status)
      ? '<button type="button" id="interrupt" class="secondary">中断</button>'
      : "";
    const auditHtml = session.approvalAudit.slice().reverse().map((entry) =>
      `<tr><td>${new Date(entry.timestamp).toLocaleString()}</td><td>${escapeHtml(auditDecisionLabel(entry.decision))}</td><td>${escapeHtml(entry.subject ?? "-")}</td><td>${escapeHtml(entry.reason)}</td><td>${escapeHtml(entry.matchedRule ?? "-")}</td></tr>`,
    ).join("");
    const activityPanelHtml = activities || "<p>アクティビティはまだありません。</p>";
    const auditPanelHtml = auditHtml
      ? `<div class="audit-wrap"><table class="audit"><thead><tr><th>日時</th><th>判断</th><th>対象</th><th>理由</th><th>ルール</th></tr></thead><tbody>${auditHtml}</tbody></table></div>`
      : "<p>承認履歴はまだありません。</p>";
    panel.webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:20px;max-width:980px;margin:auto}header{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:12px}.header-title{display:flex;align-items:center;justify-content:space-between;gap:12px}.header-title h1{margin-right:auto}.meta{color:var(--vscode-descriptionForeground);word-break:break-all}.status{display:inline-block;padding:3px 8px;border-radius:12px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.attention{border:1px solid var(--vscode-inputValidation-warningBorder);background:var(--vscode-inputValidation-warningBackground);padding:12px;margin:16px 0}.policy-reason{color:var(--vscode-descriptionForeground)}.actions{display:flex;gap:8px;flex-wrap:wrap}button{border:0;padding:7px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button:hover{background:var(--vscode-button-hoverBackground)}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.message-popover{position:relative;display:inline-block;margin:18px 0}.message-toggle{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.message-form{display:none;position:absolute;z-index:20;top:50%;left:calc(100% + 8px);width:min(520px,calc(100vw - 80px));gap:8px;margin:0;padding:10px;border:1px solid var(--vscode-widget-border,var(--vscode-panel-border));border-radius:4px;background:var(--vscode-editorHoverWidget-background,var(--vscode-editor-background));box-shadow:0 2px 8px var(--vscode-widget-shadow);transform:translateY(-50%)}.message-form::before{content:"";position:absolute;top:0;right:100%;bottom:0;width:9px}.message-popover:hover .message-form,.message-popover:focus-within .message-form{display:flex}.message-form textarea{min-width:0;flex:1;min-height:72px;resize:vertical;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border);padding:8px}.message-form button{align-self:flex-end}.tabs{display:flex;gap:2px;margin-top:4px;border-bottom:1px solid var(--vscode-panel-border)}button.tab{position:relative;padding:8px 14px;color:var(--vscode-foreground);background:transparent}button.tab:hover{background:var(--vscode-toolbar-hoverBackground)}button.tab[aria-selected="true"]{font-weight:600}button.tab[aria-selected="true"]::after{content:"";position:absolute;right:8px;bottom:-1px;left:8px;height:2px;background:var(--vscode-focusBorder)}button.tab:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-2px}.tabpanel{padding-top:8px}.tabpanel[hidden]{display:none}article{border-bottom:1px solid var(--vscode-panel-border);padding:10px 0}.activity-head{display:flex;justify-content:space-between;gap:12px}time{color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;word-break:break-word;background:var(--vscode-textCodeBlock-background);padding:10px;overflow:auto}.audit-wrap{overflow:auto}.audit{border-collapse:collapse;width:100%;font-size:.9em}.audit th,.audit td{border:1px solid var(--vscode-panel-border);padding:6px;text-align:left;vertical-align:top}.markdown{line-height:1.55;overflow-wrap:anywhere}.markdown>:first-child{margin-top:10px}.markdown>:last-child{margin-bottom:0}.markdown h1,.markdown h2,.markdown h3{margin:18px 0 8px}.markdown h1{font-size:1.45em}.markdown h2{font-size:1.25em}.markdown h3{font-size:1.1em}.markdown p,.markdown ul,.markdown ol,.markdown blockquote{margin:8px 0}.markdown blockquote{padding-left:12px;border-left:3px solid var(--vscode-textBlockQuote-border);color:var(--vscode-descriptionForeground)}.markdown code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}.markdown pre code{padding:0;background:transparent}.markdown a{color:var(--vscode-textLink-foreground)}.markdown table{border-collapse:collapse;max-width:100%;display:block;overflow:auto}.markdown th,.markdown td{padding:5px 8px;border:1px solid var(--vscode-panel-border)}@media(max-width:700px){.message-form{position:fixed;top:auto;right:16px;bottom:16px;left:16px;width:auto;transform:none}}</style></head><body><header><div class="header-title"><h1>${escapeHtml(session.title)}</h1>${interruptHtml}</div><p><span class="status">${escapeHtml(session.status)}</span> ${escapeHtml(session.currentActivity ?? "")}</p><p class="meta">${escapeHtml(session.cwd)}</p></header>${approvalHtml}<div class="message-popover"><button class="message-toggle" type="button" aria-haspopup="dialog">追加入力</button><form class="message-form" id="message-form" role="dialog" aria-label="Codexへの追加入力"><textarea id="message" aria-label="入力内容" placeholder="Codexへ追加入力...（Enterで送信、Shift+Enterで改行）"></textarea><button type="submit">送信</button></form></div><div class="tabs" role="tablist" aria-label="セッション詳細"><button class="tab" id="activity-tab" role="tab" aria-selected="true" aria-controls="activity-panel" data-tab="activity">アクティビティ</button><button class="tab" id="audit-tab" role="tab" aria-selected="false" aria-controls="audit-panel" data-tab="audit" tabindex="-1">監査ログ</button></div><section class="tabpanel" id="activity-panel" role="tabpanel" aria-labelledby="activity-tab">${activityPanelHtml}</section><section class="tabpanel" id="audit-panel" role="tabpanel" aria-labelledby="audit-tab" hidden>${auditPanelHtml}</section><script nonce="${nonce}">const vscode=acquireVsCodeApi();const tabs=[...document.querySelectorAll('[role="tab"]')];function activateTab(name,focus=false){for(const tab of tabs){const selected=tab.dataset.tab===name;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;document.getElementById(tab.getAttribute('aria-controls')).hidden=!selected;if(selected&&focus)tab.focus()}vscode.setState({...vscode.getState(),detailTab:name})}for(const tab of tabs){tab.addEventListener('click',()=>activateTab(tab.dataset.tab));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const current=tabs.indexOf(tab);const next=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(current+1)%tabs.length:(current-1+tabs.length)%tabs.length;activateTab(tabs[next].dataset.tab,true)})}activateTab(vscode.getState()?.detailTab==='audit'?'audit':'activity');const messageForm=document.getElementById('message-form');const messageInput=document.getElementById('message');messageForm.addEventListener('submit',e=>{e.preventDefault();if(messageInput.value.trim()){vscode.postMessage({type:'send',text:messageInput.value});messageInput.value='';}});messageInput.addEventListener('keydown',event=>{if(event.key!=='Enter'||event.shiftKey||event.isComposing||event.keyCode===229)return;event.preventDefault();messageForm.requestSubmit();});document.getElementById('interrupt')?.addEventListener('click',()=>vscode.postMessage({type:'interrupt'}));document.querySelectorAll('[data-decision]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'approval',decision:button.dataset.decision})));</script></body></html>`;
    panel.webview.html = panel.webview.html.replace("</style>", ".message-popover{display:block;margin:18px 0}.message-toggle{display:none}.message-form,.message-popover:hover .message-form,.message-popover:focus-within .message-form{display:flex;position:static;width:auto;margin:0;padding:0;border:0;background:transparent;box-shadow:none;transform:none}.message-form::before{display:none}</style>");
  }
}

function auditDecisionLabel(decision: "auto_approved" | "accepted" | "accepted_for_session" | "declined"): string {
  if (decision === "auto_approved") return "自動承認";
  if (decision === "accepted") return "今回のみ許可";
  if (decision === "accepted_for_session") return "セッションで許可";
  return "拒否";
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
