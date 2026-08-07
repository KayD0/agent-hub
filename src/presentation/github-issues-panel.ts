import * as vscode from "vscode";
import { RepositoryManager } from "../application/repository-manager";
import { GitHubIssue, GitHubIssueRepositoryResult } from "../domain/github-issue";
import { GitHubIssueClient } from "../infrastructure/github/github-issue-client";

export class GitHubIssuesPanel implements vscode.Disposable {
  private static readonly MIN_REFRESH_INTERVAL_MS = 2_000;
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly issues = new Map<string, GitHubIssue>();
  private readonly renders = new Map<string, Promise<void>>();
  private readonly lastRenderedAt = new Map<string, number>();

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly client: GitHubIssueClient,
    private readonly startIssueSession: (issue: GitHubIssue) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  public async show(groupId: string): Promise<void> {
    const group = this.manager.get(groupId);
    if (!group) throw new Error("登録済みフォルダが見つかりません。");
    let panel = this.panels.get(groupId);
    if (!panel) {
      panel = vscode.window.createWebviewPanel("agentHub.githubIssues", `Issues: ${group.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      panel.webview.html = renderLoading(group.name);
      this.panels.set(groupId, panel);
      panel.onDidDispose(() => this.panels.delete(groupId));
      panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(groupId, message));
    } else panel.reveal();
    await this.renderOnce(groupId, panel);
  }

  public dispose(): void { for (const panel of this.panels.values()) panel.dispose(); this.panels.clear(); this.issues.clear(); this.renders.clear(); this.lastRenderedAt.clear(); }

  private async handleMessage(groupId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; issueKey?: unknown };
    try {
      if (message.type === "refresh") {
        const panel = this.panels.get(groupId);
        if (panel) await this.renderOnce(groupId, panel);
      } else if (message.type === "startIssue" && typeof message.issueKey === "string") {
        const issue = this.issues.get(`${groupId}:${message.issueKey}`);
        if (issue) await this.startIssueSession(issue);
      } else if (message.type === "openIssue" && typeof message.issueKey === "string") {
        const issue = this.issues.get(`${groupId}:${message.issueKey}`);
        if (issue) await vscode.env.openExternal(vscode.Uri.parse(issue.url));
      }
    } catch (error) { this.onError(error); }
  }

  private async renderOnce(groupId: string, panel: vscode.WebviewPanel): Promise<void> {
    const active = this.renders.get(groupId);
    if (active) return active;
    if (Date.now() - (this.lastRenderedAt.get(groupId) ?? 0) < GitHubIssuesPanel.MIN_REFRESH_INTERVAL_MS) return;
    const render = this.render(groupId, panel).finally(() => {
      this.renders.delete(groupId);
      this.lastRenderedAt.set(groupId, Date.now());
    });
    this.renders.set(groupId, render);
    return render;
  }

  private async render(groupId: string, panel: vscode.WebviewPanel): Promise<void> {
    const group = this.manager.get(groupId);
    if (!group) { panel.dispose(); return; }
    const snapshot = await this.manager.groupSnapshot(group);
    for (const key of [...this.issues.keys()]) if (key.startsWith(`${groupId}:`)) this.issues.delete(key);
    const repositories = await Promise.all(snapshot.repositories.map(async (repository) => {
      try {
        const ref = await this.client.repository(repository.rootPath);
        return { repositoryName: repository.name, ref };
      } catch (error) {
        return { repositoryName: repository.name, issues: [], error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const githubRepositories = repositories.filter((item): item is { repositoryName: string; ref: GitHubIssue["repository"] } => "ref" in item);
    let readinessError: string | undefined;
    if (githubRepositories.length) {
      try { await this.client.assertReady(); }
      catch (error) { readinessError = error instanceof Error ? error.message : String(error); }
    }
    const fetched = await Promise.all(githubRepositories.map(async ({ repositoryName, ref }): Promise<GitHubIssueRepositoryResult> => {
      if (readinessError) return { repositoryName, issues: [], error: readinessError };
      try {
        const issues = await this.client.listOpenIssues(ref);
        for (const issue of issues) this.issues.set(`${groupId}:${issueKey(issue)}`, issue);
        return { repositoryName, issues };
      } catch (error) {
        return { repositoryName, issues: [], error: error instanceof Error ? error.message : String(error) };
      }
    }));
    const fetchedByName = new Map(fetched.map((result) => [result.repositoryName, result]));
    const results: GitHubIssueRepositoryResult[] = repositories.map((item) => "ref" in item ? fetchedByName.get(item.repositoryName)! : item);
    panel.webview.html = renderHtml(group.name, group.rootPath, results);
  }
}

function renderLoading(groupName: string): string {
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><p>GitHub Issuesを取得しています: ${escapeHtml(groupName)}</p></body></html>`;
}

function renderHtml(groupName: string, rootPath: string, results: GitHubIssueRepositoryResult[]): string {
  const nonce = randomNonce();
  const issueCount = results.reduce((sum, result) => sum + result.issues.length, 0);
  const sections = results.map((result) => {
    const content = result.error
      ? `<p class="message error">${escapeHtml(result.error)}</p>`
      : result.issues.length
        ? result.issues.map(renderIssue).join("")
        : '<p class="message">Open Issueはありません。</p>';
    return `<section><h2>${escapeHtml(result.repositoryName)}</h2>${content}</section>`;
  }).join("");
  const content = results.length ? sections : '<p class="message">Gitリポジトリが見つかりません。</p>';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}header{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}header div{min-width:0;flex:1}h1{margin:0;font-size:18px}header p{margin:4px 0 0;overflow:hidden;color:var(--vscode-descriptionForeground);text-overflow:ellipsis;white-space:nowrap}button{border:0;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}main{display:grid;gap:18px;padding:16px}h2{margin:0 0 8px;font-size:14px}.issue{margin-bottom:8px;border:1px solid var(--vscode-panel-border);border-radius:4px}.issue summary{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:8px;padding:10px;cursor:pointer}.issue summary:hover,.issue summary:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.number{color:var(--vscode-descriptionForeground)}.title{font-weight:600}.updated{color:var(--vscode-descriptionForeground);font-size:11px}.meta{display:flex;flex-wrap:wrap;gap:6px;padding:0 10px 8px;color:var(--vscode-descriptionForeground);font-size:11px}.label{padding:2px 6px;border:1px solid var(--vscode-panel-border);border-radius:9px}.body{margin:0;padding:10px;border-top:1px solid var(--vscode-panel-border);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}.actions{display:flex;gap:6px;padding:10px;border-top:1px solid var(--vscode-panel-border)}.message{padding:10px;border:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}.error{border-color:var(--vscode-inputValidation-errorBorder);color:var(--vscode-errorForeground)}@media(max-width:600px){.issue summary{grid-template-columns:auto minmax(0,1fr)}.updated{grid-column:2}}</style></head><body><header><div><h1>${escapeHtml(groupName)} Issues</h1><p title="${escapeHtml(rootPath)}">Open ${issueCount}件・${escapeHtml(rootPath)}</p></div><button id="refresh" class="secondary">更新</button></header><main>${content}</main><script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.querySelectorAll('[data-start]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'startIssue',issueKey:button.dataset.start})));document.querySelectorAll('[data-open]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'openIssue',issueKey:button.dataset.open})));</script></body></html>`;
}

function renderIssue(issue: GitHubIssue): string {
  const key = issueKey(issue);
  const labels = issue.labels.map((label) => `<span class="label">${escapeHtml(label)}</span>`).join("");
  const assignees = issue.assignees.length ? `<span>担当: ${escapeHtml(issue.assignees.join(", "))}</span>` : "";
  return `<details class="issue"><summary><span class="number">#${issue.number}</span><span class="title">${escapeHtml(issue.title)}</span><time class="updated" datetime="${escapeHtml(issue.updatedAt)}">${escapeHtml(formatDate(issue.updatedAt))}</time></summary><div class="meta">${labels}${assignees}</div><pre class="body">${escapeHtml(issue.body || "本文はありません。")}</pre><div class="actions"><button data-start="${escapeHtml(key)}">このIssueからセッションを開始</button><button class="secondary" data-open="${escapeHtml(key)}">GitHubで開く</button></div></details>`;
}

function issueKey(issue: GitHubIssue): string { return `${issue.repository.slug}#${issue.number}`; }
function formatDate(value: string): string { const date = new Date(value); return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP"); }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
