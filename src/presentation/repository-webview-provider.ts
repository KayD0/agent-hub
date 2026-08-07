import * as vscode from "vscode";
import { RepositoryManager } from "../application/repository-manager";
import { RepositoryGroupSnapshot } from "../domain/repository";

export class RepositoryWebviewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  public constructor(private readonly manager: RepositoryManager, private readonly addRepository: () => Promise<void>, private readonly openRepository: (repositoryId: string) => Promise<void>, private readonly onError: (error: unknown) => void) {}
  public resolveWebviewView(view: vscode.WebviewView): void { this.view = view; view.webview.options = { enableScripts: true }; view.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(message)); view.onDidDispose(() => { this.view = undefined; }); void this.refresh(); }
  public async refresh(): Promise<void> { if (this.view) this.view.webview.html = renderHtml(await this.manager.groupSnapshots()); }
  private async handleMessage(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; repositoryId?: unknown };
    try {
      if (message.type === "add") await this.addRepository();
      else if (message.type === "refresh") await this.refresh();
      else if (typeof message.repositoryId === "string" && message.type === "open") await this.openRepository(message.repositoryId);
      else if (typeof message.repositoryId === "string" && message.type === "remove") { await this.manager.remove(message.repositoryId); await this.refresh(); }
    } catch (error) { this.onError(error); }
  }
}

function renderHtml(groups: RepositoryGroupSnapshot[]): string {
  const nonce = randomNonce();
  const cards = groups.map((group) => {
    const children = group.repositories.map((repository) => `<li><span class="repo-name" title="${escapeHtml(repository.relativePath)}">${escapeHtml(repository.name)}</span><span>${repository.error ? "取得エラー" : `${repository.files.length}件の変更`}</span></li>`).join("");
    return `<article><div class="group-row"><button class="group" data-open="${group.id}" aria-label="${escapeHtml(group.name)}配下の差分を開く"><strong>${escapeHtml(group.name)}</strong><span title="${escapeHtml(group.rootPath)}">${escapeHtml(group.rootPath)}</span><span>${group.error ? "取得エラー" : `${group.repositories.length}リポジトリ・${group.files}件の変更`}</span></button><button class="remove" data-remove="${group.id}" aria-label="${escapeHtml(group.name)}の登録を解除">×</button></div>${children ? `<ul>${children}</ul>` : '<p class="no-repo">Gitリポジトリが見つかりません</p>'}</article>`;
  }).join("");
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">*{box-sizing:border-box}body{padding:8px;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font-family:var(--vscode-font-family);font-size:var(--vscode-font-size)}header{display:flex;gap:6px;margin-bottom:8px}header button{flex:1;border:0;padding:6px;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}article{border:1px solid var(--vscode-panel-border);margin-bottom:8px}.group-row{display:flex}.group{min-width:0;flex:1;padding:8px;text-align:left;border:0;color:var(--vscode-foreground);background:transparent}.group:hover,.group:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.group strong,.group span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group span{margin-top:3px;color:var(--vscode-descriptionForeground);font-size:11px}.remove{flex:none;width:28px;border:0;color:var(--vscode-foreground);background:transparent}.remove:hover{background:var(--vscode-toolbar-hoverBackground)}ul{list-style:none;margin:0;padding:3px 8px 7px 22px;border-top:1px solid var(--vscode-panel-border)}li{position:relative;display:flex;gap:6px;justify-content:space-between;padding:4px 0;color:var(--vscode-descriptionForeground);font-size:11px}li::before{content:'└';position:absolute;right:calc(100% + 4px)}.repo-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--vscode-foreground)}.empty,.no-repo{padding:8px;color:var(--vscode-descriptionForeground);font-size:11px}.no-repo{margin:0;border-top:1px solid var(--vscode-panel-border)}</style></head><body><header><button id="add">＋ フォルダを登録</button><button id="refresh" title="更新">↻</button></header>${cards || '<p class="empty">登録済みフォルダはありません。</p>'}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('add').addEventListener('click',()=>vscode.postMessage({type:'add'}));document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'open',repositoryId:button.dataset.open})));document.querySelectorAll('[data-remove]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'remove',repositoryId:button.dataset.remove})));</script></body></html>`;
}
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
