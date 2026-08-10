import * as vscode from "vscode";
import { RepositoryManager } from "../application/repository-manager";
import { RepositoryGroupSnapshot } from "../domain/repository";

export class RepositoryWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  public constructor(
    private readonly manager: RepositoryManager,
    private readonly openRepository: (repositoryId: string) => Promise<void>,
    private readonly openIssues: (repositoryId: string) => Promise<void>,
    private readonly openTerminal: (repositoryId: string) => Promise<void>,
    private readonly createSession: (repositoryId: string) => Promise<void>,
    private readonly analyzeRepository: (repositoryId: string) => Promise<void>,
    private readonly removeRepository: (repositoryId: string) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}
  public resolveWebviewView(view: vscode.WebviewView): void { this.view = view; view.webview.options = { enableScripts: true }; view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message)); view.onDidDispose(() => { this.view = undefined; }); void this.refresh(); }
  public async refresh(): Promise<void> { if (this.view) this.view.webview.html = renderHtml(await this.manager.groupSnapshots()); }
  private async handleMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; repositoryId?: unknown };
    try {
      if (typeof message.repositoryId === "string" && message.type === "open") await this.openRepository(message.repositoryId);
      else if (typeof message.repositoryId === "string" && message.type === "openIssues") await this.openIssues(message.repositoryId);
      else if (typeof message.repositoryId === "string" && message.type === "openTerminal") await this.openTerminal(message.repositoryId);
      else if (typeof message.repositoryId === "string" && message.type === "createSession") await this.createSession(message.repositoryId);
      else if (typeof message.repositoryId === "string" && message.type === "analyze") await this.analyzeRepository(message.repositoryId);
      else if (typeof message.repositoryId === "string" && message.type === "remove") await this.removeRepository(message.repositoryId);
    } catch (error) { this.onError(error); }
  }
}

function renderHtml(groups: RepositoryGroupSnapshot[]): string {
  const nonce = randomNonce();
  const cards = groups.map((group) => {
    const stateClass = group.error ? "has-error" : group.files > 0 ? "has-changes" : "clean";
    const stateLabel = group.error ? "取得エラー" : group.files > 0 ? "変更あり" : "変更なし";
    return `<article class="${stateClass}" title="${stateLabel}"><div class="group-row"><button class="group" data-open="${group.id}" aria-label="${escapeHtml(group.name)}配下の差分を開く（${stateLabel}）"><strong>${escapeHtml(group.name)}</strong><span title="${escapeHtml(group.rootPath)}">${escapeHtml(group.rootPath)}</span></button><button class="remove" data-remove="${group.id}" aria-label="${escapeHtml(group.name)}の登録を解除">×</button></div><div class="card-actions"><button data-issues="${group.id}" aria-label="${escapeHtml(group.name)}配下のIssueを開く">Issues</button><button data-analyze="${group.id}" aria-label="${escapeHtml(group.name)}の分析を開始">分析</button><button class="icon-action terminal-action" data-terminal="${group.id}" aria-label="${escapeHtml(group.name)}フォルダでターミナルを開く" title="ターミナルを開く"><span aria-hidden="true">&gt;_</span></button><button class="icon-action session-action" data-create-session="${group.id}" aria-label="${escapeHtml(group.name)}フォルダでセッションを作成" title="セッションを作成"><svg aria-hidden="true" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2.5h9a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3.5 3v-3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/><path d="M8 4.5v4M6 6.5h4"/></svg></button></div></article>`;
  }).join("");
  const content = cards ? `<main class="groups">${cards}</main>` : '<p class="empty">登録済みフォルダはありません。</p>';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">*{box-sizing:border-box}body{padding:8px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}.groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}article{display:flex;min-width:0;flex-direction:column;border:1px solid var(--vscode-panel-border);font-size:12px}article.has-changes{border-color:var(--vscode-inputValidation-warningBorder,var(--vscode-charts-yellow));border-left-width:3px;background:var(--vscode-list-inactiveSelectionBackground)}article.has-error{border-color:var(--vscode-inputValidation-errorBorder,var(--vscode-errorForeground));border-left-width:3px}.group-row{display:flex;flex:1}.group{min-width:0;flex:1;padding:8px;text-align:left;border:0;color:var(--vscode-foreground);background:transparent;font:inherit}.group:hover,.group:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.group strong,.group span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group span{margin-top:3px;color:var(--vscode-descriptionForeground);font-size:11px}.remove{flex:none;width:28px;border:0;color:var(--vscode-foreground);background:transparent;font:inherit}.remove:hover{background:var(--vscode-toolbar-hoverBackground)}.card-actions{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.35fr) 32px 32px;border-top:1px solid var(--vscode-panel-border)}.card-actions button{min-width:0;padding:6px 8px;border:0;overflow:hidden;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground);text-align:left;text-overflow:ellipsis;white-space:nowrap;font:inherit}.card-actions .icon-action{display:grid;padding:0;place-items:center}.terminal-action span{font-family:var(--vscode-editor-font-family),monospace;font-size:11px;font-weight:700}.session-action svg{width:16px;height:16px;stroke-width:1.25}.card-actions button+button{border-left:1px solid var(--vscode-panel-border)}.card-actions button:hover{background:var(--vscode-button-secondaryHoverBackground)}.card-actions button:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.empty{padding:8px;color:var(--vscode-descriptionForeground);font-size:11px}@media(max-width:420px){.groups{grid-template-columns:1fr}}</style></head><body>${content}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'open',repositoryId:button.dataset.open})));document.querySelectorAll('[data-issues]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'openIssues',repositoryId:button.dataset.issues})));document.querySelectorAll('[data-analyze]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'analyze',repositoryId:button.dataset.analyze})));document.querySelectorAll('[data-terminal]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'openTerminal',repositoryId:button.dataset.terminal})));document.querySelectorAll('[data-create-session]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'createSession',repositoryId:button.dataset.createSession})));document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'remove',repositoryId:button.dataset.remove})));</script></body></html>`;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
