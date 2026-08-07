import * as vscode from "vscode";
import { RepositoryManager } from "../application/repository-manager";
import { RepositoryFileChange, RepositorySnapshot } from "../domain/repository";
import { GitRepositoryReader } from "../infrastructure/git/git-repository-reader";

export class RepositoryDiffPanel implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly selectedPaths = new Map<string, string>();

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly reader: GitRepositoryReader,
    private readonly onError: (error: unknown) => void,
  ) {}

  public async show(repositoryId: string): Promise<void> {
    const repository = this.manager.get(repositoryId);
    if (!repository) throw new Error("登録済みリポジトリが見つかりません。");
    let panel = this.panels.get(repositoryId);
    if (!panel) {
      panel = vscode.window.createWebviewPanel("agentHub.repositoryDiff", `Changes: ${repository.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panels.set(repositoryId, panel);
      panel.onDidDispose(() => {
        this.panels.delete(repositoryId);
        this.selectedPaths.delete(repositoryId);
      });
      panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(repositoryId, message));
    } else {
      panel.reveal();
    }
    await this.render(repositoryId, panel);
  }

  public dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
    this.selectedPaths.clear();
  }

  private async handleMessage(repositoryId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; path?: unknown };
    try {
      if (message.type === "refresh") {
        const panel = this.panels.get(repositoryId);
        if (panel) await this.render(repositoryId, panel);
      } else if (message.type === "openWindow") {
        const repository = this.manager.get(repositoryId);
        if (repository) await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(repository.rootPath), { forceNewWindow: true });
      } else if (message.type === "selectDiff" && typeof message.path === "string") {
        this.selectedPaths.set(repositoryId, message.path);
        const panel = this.panels.get(repositoryId);
        if (panel) await this.render(repositoryId, panel);
      }
    } catch (error) { this.onError(error); }
  }

  private async render(repositoryId: string, panel: vscode.WebviewPanel): Promise<void> {
    const repository = this.manager.get(repositoryId);
    if (!repository) { panel.dispose(); return; }
    const snapshot = await this.manager.groupSnapshot(repository);
    const entries = snapshot.repositories.flatMap((item) => item.files.map((file) => ({ repository: item, file, key: `${item.id}::${file.path}` })));
    const selected = entries.find((entry) => entry.key === this.selectedPaths.get(repositoryId)) ?? entries[0];
    if (selected) this.selectedPaths.set(repositoryId, selected.key);
    else this.selectedPaths.delete(repositoryId);
    const diff = selected ? await this.reader.readDiff(selected.repository.rootPath, selected.file).catch((error: unknown) => `差分を取得できませんでした。\n${error instanceof Error ? error.message : String(error)}`) : "";
    const nonce = randomNonce();
    const files = snapshot.repositories.map((item) => repositoryRows(item, selected?.key)).join("");
    const state = snapshot.error
      ? `<section class="state error"><h2>差分を取得できません</h2><p>${escapeHtml(snapshot.error)}</p></section>`
      : snapshot.repositories.length === 0
        ? '<section class="state"><h2>Gitリポジトリが見つかりません</h2><p>登録フォルダの配下にあるGitリポジトリを検出できませんでした。</p></section>'
        : entries.length === 0
          ? '<section class="state"><h2>変更はありません</h2><p>配下のすべてのリポジトリでHEADとWorking Treeが一致しています。</p></section>'
          : `<div class="layout"><nav aria-label="変更ファイル"><div class="nav-title">${snapshot.repositories.length}リポジトリ・変更ファイル ${entries.length}</div>${files}</nav><main aria-live="polite"><div class="diff-title"><span class="repo-label">${escapeHtml(selected!.repository.name)}</span><span class="kind">${kindLabel(selected!.file.kind)}</span><span title="${escapeHtml(selected!.file.path)}">${escapeHtml(selected!.file.path)}</span></div>${renderDiff(diff)}</main></div>`;
    panel.webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);overflow:hidden}header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--vscode-panel-border)}header div{min-width:0;flex:1}h1{margin:0;font-size:18px}header p{margin:4px 0 0;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{flex:none;padding:3px 8px;border:1px solid var(--vscode-panel-border);border-radius:10px;font-size:11px}.actions{display:flex;gap:6px}button{border:0;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.layout{display:grid;grid-template-columns:minmax(260px,32%) minmax(0,1fr);height:calc(100vh - 75px)}nav,main{min-height:0;overflow:auto}nav{border-right:1px solid var(--vscode-panel-border)}.nav-title{position:sticky;top:0;z-index:2;padding:10px 12px;color:var(--vscode-descriptionForeground);background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.repo-heading{position:sticky;top:35px;z-index:1;padding:7px 12px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.repo-heading span{margin-left:6px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:400}.file{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:6px;width:100%;padding:8px 12px 8px 20px;text-align:left;color:var(--vscode-foreground);background:transparent;border-bottom:1px solid var(--vscode-panel-border)}.file:hover{background:var(--vscode-list-hoverBackground)}.file:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.file[aria-selected="true"]{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}.file-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.stat{color:var(--vscode-descriptionForeground);font-size:11px}.kind{font-weight:700;color:var(--vscode-gitDecoration-modifiedResourceForeground)}.diff-title{position:sticky;top:0;z-index:1;display:flex;gap:9px;padding:10px 14px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.repo-label{padding-right:9px;border-right:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}.diff{min-width:max-content;margin:0;padding:8px 0;font:var(--vscode-editor-font-size)/var(--vscode-editor-line-height) var(--vscode-editor-font-family);tab-size:4}.line{display:block;min-height:var(--vscode-editor-line-height);padding:0 14px;white-space:pre}.add{background:var(--vscode-diffEditor-insertedTextBackground)}.delete{background:var(--vscode-diffEditor-removedTextBackground)}.hunk{color:var(--vscode-editorInfo-foreground);background:var(--vscode-diffEditor-unchangedRegionBackground)}.meta{color:var(--vscode-descriptionForeground)}.state{margin:24px;padding:20px;border:1px solid var(--vscode-panel-border)}.error{border-color:var(--vscode-inputValidation-errorBorder)}@media(max-width:700px){body{overflow:auto}.layout{grid-template-columns:1fr;height:auto}nav{max-height:38vh;border-right:0}main{min-height:50vh;border-top:1px solid var(--vscode-panel-border)}}</style></head><body><header><div><h1>${escapeHtml(repository.name)}</h1><p title="${escapeHtml(repository.rootPath)}">${escapeHtml(repository.rootPath)}</p></div><span class="badge">${snapshot.repositories.length}リポジトリ</span><div class="actions"><button id="refresh" class="secondary">更新</button><button id="open-window">新しいウィンドウで開く</button></div></header>${state}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.getElementById('open-window').addEventListener('click',()=>vscode.postMessage({type:'openWindow'}));document.querySelectorAll('[data-path]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'selectDiff',path:button.dataset.path})));</script></body></html>`;
  }
}

function repositoryRows(repository: RepositorySnapshot, selectedKey: string | undefined): string {
  const rows = repository.files.map((file) => fileRow(repository, file, `${repository.id}::${file.path}` === selectedKey)).join("");
  return `<section><div class="repo-heading">${escapeHtml(repository.name)}<span>${escapeHtml(repository.relativePath)}・${repository.branch ? escapeHtml(repository.branch) : "detached"}</span></div>${rows || '<div class="state">変更なし</div>'}</section>`;
}

function fileRow(repository: RepositorySnapshot, file: RepositoryFileChange, selected: boolean): string {
  const stat = file.binary ? "binary" : `+${file.additions ?? 0} −${file.deletions ?? 0}`;
  const key = `${repository.id}::${file.path}`;
  return `<button class="file" data-path="${escapeHtml(key)}" aria-selected="${selected}" aria-label="${escapeHtml(repository.name)}の${escapeHtml(file.path)}の差分を表示"><span class="kind">${kindLabel(file.kind)}</span><span class="file-path" title="${escapeHtml(file.path)}">${escapeHtml(file.path)}</span><span class="stat">${stat}</span></button>`;
}

function renderDiff(value: string): string {
  const lines = value ? value.split("\n") : ["差分はありません。"];
  return `<pre class="diff" aria-label="選択ファイルの差分">${lines.map((line) => `<span class="line ${lineClass(line)}">${escapeHtml(line)}\n</span>`).join("")}</pre>`;
}

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "delete";
  if (line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) return "meta";
  return "";
}

function kindLabel(kind: RepositoryFileChange["kind"]): string {
  return ({ added: "A", modified: "M", deleted: "D", renamed: "R", untracked: "U" } as const)[kind];
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
