import * as vscode from "vscode";
import { RepositoryManager } from "../application/repository-manager";
import { RepositoryCommit, RepositoryFileChange, RepositorySnapshot, RepositoryTreeEntry } from "../domain/repository";
import { RepositoryFileReader } from "../infrastructure/filesystem/repository-file-reader";
import { GitRepositoryReader } from "../infrastructure/git/git-repository-reader";

export class RepositoryDiffPanel implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly selectedPaths = new Map<string, string>();
  private readonly selectedCommits = new Map<string, string>();
  private readonly selectedCommitFiles = new Map<string, string>();

  public constructor(
    private readonly manager: RepositoryManager,
    private readonly reader: GitRepositoryReader,
    private readonly files: RepositoryFileReader,
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
        this.selectedCommits.delete(repositoryId);
        this.selectedCommitFiles.delete(repositoryId);
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
    this.selectedCommits.clear();
    this.selectedCommitFiles.clear();
  }

  public async refresh(): Promise<void> {
    await Promise.all([...this.panels].map(([repositoryId, panel]) => this.render(repositoryId, panel)));
  }

  private async handleMessage(repositoryId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; path?: unknown; commit?: unknown };
    try {
      if (message.type === "refresh") {
        const panel = this.panels.get(repositoryId);
        if (panel) await this.render(repositoryId, panel);
      } else if (message.type === "selectDiff" && typeof message.path === "string") {
        this.selectedPaths.set(repositoryId, message.path);
        this.selectedCommits.delete(repositoryId);
        this.selectedCommitFiles.delete(repositoryId);
        const panel = this.panels.get(repositoryId);
        if (panel) await this.render(repositoryId, panel);
      } else if (message.type === "selectCommit" && typeof message.commit === "string") {
        this.selectedCommits.set(repositoryId, message.commit);
        this.selectedCommitFiles.delete(repositoryId);
        const panel = this.panels.get(repositoryId);
        if (panel) await this.render(repositoryId, panel);
      } else if (message.type === "selectCommitFile" && typeof message.commit === "string" && typeof message.path === "string") {
        this.selectedCommits.set(repositoryId, message.commit);
        this.selectedCommitFiles.set(repositoryId, message.path);
        const panel = this.panels.get(repositoryId);
        if (panel) await this.render(repositoryId, panel);
      } else if (message.type === "expandDirectory" && typeof message.path === "string") {
        const repository = this.manager.get(repositoryId);
        const panel = this.panels.get(repositoryId);
        if (repository && panel) {
          const entries = await this.files.readDirectory(repository.rootPath, message.path);
          await panel.webview.postMessage({ type: "directoryEntries", path: message.path, entries });
        }
      } else if (message.type === "openFile" && typeof message.path === "string") {
        const repository = this.manager.get(repositoryId);
        if (repository) await vscode.window.showTextDocument(vscode.Uri.file(await this.files.resolveFile(repository.rootPath, message.path)));
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
    const treeEntries = await this.files.readDirectory(repository.rootPath);
    const histories = await Promise.all(snapshot.repositories.map(async (item) => {
      try { return { repository: item, commits: await this.reader.readHistory(item.rootPath, 20) }; }
      catch (error) { return { repository: item, commits: [] as RepositoryCommit[], error: error instanceof Error ? error.message : String(error) }; }
    }));
    const commitEntries = histories.flatMap((history) => history.commits.map((commit) => ({ repository: history.repository, commit, key: `${history.repository.id}::${commit.hash}` })));
    const selectedCommit = commitEntries.find((entry) => entry.key === this.selectedCommits.get(repositoryId));
    if (!selectedCommit) this.selectedCommits.delete(repositoryId);
    const commitFiles = selectedCommit ? await this.reader.readCommitFiles(selectedCommit.repository.rootPath, selectedCommit.commit.hash).catch(() => [] as RepositoryFileChange[]) : [] as RepositoryFileChange[];
    const selectedCommitFile = commitFiles.find((file) => file.path === this.selectedCommitFiles.get(repositoryId));
    if (!selectedCommitFile) this.selectedCommitFiles.delete(repositoryId);
    const commitDiff = selectedCommit && selectedCommitFile ? await this.reader.readCommitFileDiff(selectedCommit.repository.rootPath, selectedCommit.commit.hash, selectedCommitFile.path).catch((error: unknown) => `差分を取得できませんでした。\n${error instanceof Error ? error.message : String(error)}`) : "";
    const nonce = randomNonce();
    const changes = snapshot.repositories.map((item) => repositoryRows(item, selected?.key)).join("");
    const changeList = snapshot.error
      ? `<section class="state error"><p>${escapeHtml(snapshot.error)}</p></section>`
      : changes || '<p class="empty-list">変更ファイルはありません。</p>';
    const historyList = histories.length ? histories.map((item) => historyRows(item, selectedCommit?.key, commitFiles, selectedCommitFile?.path)).join("") : '<p class="empty-list">Gitリポジトリがありません。</p>';
    const main = selectedCommit && selectedCommitFile
      ? `<div class="diff-title"><span class="repo-label">${escapeHtml(selectedCommit.repository.name)}</span><span class="kind">${kindLabel(selectedCommitFile.kind)}</span><span title="${escapeHtml(selectedCommitFile.path)}">${escapeHtml(selectedCommitFile.path)}</span></div>${renderDiff(commitDiff, "選択コミットファイルの差分")}`
      : selectedCommit
      ? '<section class="state"><h2>ファイルを選択してください</h2><p>選択したコミットの配下に変更ファイルを表示しています。</p></section>'
      : selected
      ? `<div class="diff-title"><span class="repo-label">${escapeHtml(selected.repository.name)}</span><span class="kind">${kindLabel(selected.file.kind)}</span><span title="${escapeHtml(selected.file.path)}">${escapeHtml(selected.file.path)}</span></div>${renderDiff(diff)}`
      : '<section class="state"><h2>変更はありません</h2><p>「ファイル」からフォルダの内容を確認できます。</p></section>';
    const state = `<div class="layout"><nav aria-label="フォルダ内容"><div class="nav-tabs" role="tablist"><button class="nav-tab" data-tab="changes" role="tab">変更 <span>${entries.length}</span></button><button class="nav-tab" data-tab="files" role="tab">ファイル</button><button class="nav-tab" data-tab="history" role="tab">履歴</button></div><div class="nav-panel" data-panel="changes">${changeList}</div><div class="nav-panel" data-panel="files"><div class="tree" data-directory="">${renderTreeEntries(treeEntries)}</div></div><div class="nav-panel" data-panel="history">${historyList}</div></nav><div id="pane-resizer" class="pane-resizer" role="separator" aria-label="ファイル一覧と差分表示の幅を調整" aria-orientation="vertical" aria-valuemin="8" aria-valuemax="70" aria-valuenow="18" tabindex="0"></div><main aria-live="polite">${main}</main></div>`;
    panel.webview.html = `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);overflow:hidden}header{display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid var(--vscode-panel-border)}header div{min-width:0;flex:1}h1{margin:0;font-size:18px}header p{margin:4px 0 0;color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.badge{flex:none;padding:3px 8px;border:1px solid var(--vscode-panel-border);border-radius:10px;font-size:11px}.actions{display:flex;gap:6px}button{border:0;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}button.secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.layout{display:grid;grid-template-columns:minmax(260px,32%) minmax(0,1fr);height:calc(100vh - 75px)}nav,main{min-height:0;overflow:auto}nav{border-right:1px solid var(--vscode-panel-border)}.nav-tabs{position:sticky;top:0;z-index:4;display:flex;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}.nav-tab{flex:1;padding:7px 10px;color:var(--vscode-descriptionForeground);background:transparent}.nav-tab[aria-selected="true"]{color:var(--vscode-foreground);box-shadow:inset 0 -2px var(--vscode-focusBorder)}.nav-tab span{font-size:10px}.nav-panel{display:none}.nav-panel.active{display:block}.empty-list{padding:10px 12px;color:var(--vscode-descriptionForeground);font-size:12px}.repo-heading{position:sticky;top:29px;z-index:1;padding:7px 12px;background:var(--vscode-sideBarSectionHeader-background);border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.repo-heading span{margin-left:6px;color:var(--vscode-descriptionForeground);font-size:11px;font-weight:400}.file{display:grid;grid-template-columns:24px minmax(0,1fr) auto;gap:6px;width:100%;padding:3px 12px 3px 20px;text-align:left;color:var(--vscode-foreground);background:transparent;border-bottom:1px solid var(--vscode-panel-border)}.file:hover{background:var(--vscode-list-hoverBackground)}.file:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.file[aria-selected="true"]{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}.file-path{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}.tree{padding:4px 0;font-size:12px}.tree-row{display:flex;width:100%;align-items:center;gap:5px;padding:3px 10px;text-align:left;color:var(--vscode-foreground);background:transparent}.tree-row:hover,.tree-row:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.tree-row span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tree-icon{flex:none;width:12px;color:var(--vscode-descriptionForeground)}.tree-children{margin-left:14px}.tree-children[hidden]{display:none}.stat{color:var(--vscode-descriptionForeground);font-size:11px}.kind{font-weight:700;color:var(--vscode-gitDecoration-modifiedResourceForeground)}.diff-title{position:sticky;top:0;z-index:1;display:flex;gap:9px;padding:10px 14px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border);font-weight:600}.repo-label{padding-right:9px;border-right:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground)}.diff{min-width:max-content;margin:0;padding:8px 0;font:var(--vscode-editor-font-size)/var(--vscode-editor-line-height) var(--vscode-editor-font-family);tab-size:4}.line{display:block;min-height:var(--vscode-editor-line-height);padding:0 14px;white-space:pre}.add{background:var(--vscode-diffEditor-insertedTextBackground)}.delete{background:var(--vscode-diffEditor-removedTextBackground)}.hunk{color:var(--vscode-editorInfo-foreground);background:var(--vscode-diffEditor-unchangedRegionBackground)}.meta{color:var(--vscode-descriptionForeground)}.state{margin:24px;padding:20px;border:1px solid var(--vscode-panel-border)}.error{border-color:var(--vscode-inputValidation-errorBorder)}@media(max-width:700px){body{overflow:auto}.layout{grid-template-columns:1fr;height:auto}nav{max-height:38vh;border-right:0}main{min-height:50vh;border-top:1px solid var(--vscode-panel-border)}}</style></head><body><header><div><h1>${escapeHtml(repository.name)}</h1><p title="${escapeHtml(repository.rootPath)}">${escapeHtml(repository.rootPath)}</p></div><span class="badge">${snapshot.repositories.length}リポジトリ</span><div class="actions"><button id="refresh" class="secondary">更新</button></div></header>${state}<script nonce="${nonce}">const vscode=acquireVsCodeApi();document.getElementById('refresh').addEventListener('click',()=>vscode.postMessage({type:'refresh'}));document.querySelectorAll('[data-path]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'selectDiff',path:button.dataset.path})));document.querySelectorAll('[data-commit]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'selectCommit',commit:button.dataset.commit})));</script></body></html>`;
    panel.webview.html = panel.webview.html
      .replace(
        ".layout{display:grid;grid-template-columns:minmax(260px,32%) minmax(0,1fr);height:calc(100vh - 75px)}nav,main{min-height:0;overflow:auto}nav{border-right:1px solid var(--vscode-panel-border)}",
        ".layout{--file-pane-width:18%;display:grid;grid-template-columns:minmax(112px,var(--file-pane-width)) 5px minmax(0,1fr);height:calc(100vh - 75px)}nav,main{min-height:0;overflow:auto}.pane-resizer{position:relative;z-index:3;background:var(--vscode-panel-border);cursor:col-resize;touch-action:none}.pane-resizer::after{content:\"\";position:absolute;inset:0 -3px}.pane-resizer:hover,.pane-resizer:focus-visible,.pane-resizer.dragging{background:var(--vscode-focusBorder);outline:none}body.resizing{cursor:col-resize;user-select:none}nav{border-right:0}",
      )
      .replace(
        "@media(max-width:700px){body{overflow:auto}.layout{grid-template-columns:1fr;height:auto}nav{max-height:38vh;border-right:0}",
        "@media(max-width:700px){body{overflow:auto}.layout{grid-template-columns:1fr;height:auto}.pane-resizer{display:none}nav{max-height:38vh;border-right:0}",
      )
      .replace("</style>", `${changedFileStyle()}${historyStyle()}</style>`)
      .replace("</script>", `${changedFileScript()}${commitFileScript()}${paneResizerScript()}${fileBrowserScript()}</script>`);
  }
}

function repositoryRows(repository: RepositorySnapshot, selectedKey: string | undefined): string {
  const rows = repository.files.map((file) => fileRow(repository, file, `${repository.id}::${file.path}` === selectedKey)).join("");
  return rows ? `<section><div class="repo-heading">${escapeHtml(repository.name)}<span>${escapeHtml(repository.relativePath)}・${repository.branch ? escapeHtml(repository.branch) : "detached"}</span></div>${rows}</section>` : "";
}

function historyRows(value: { repository: RepositorySnapshot; commits: RepositoryCommit[]; error?: string }, selectedKey?: string, selectedFiles: RepositoryFileChange[] = [], selectedFile?: string): string {
  const heading = `<summary class="repo-heading">${escapeHtml(value.repository.name)}<span>${escapeHtml(value.repository.relativePath)}・${value.repository.branch ? escapeHtml(value.repository.branch) : "detached"}</span></summary>`;
  if (value.error) return `<details class="history-repository" data-history-repository="${escapeHtml(value.repository.id)}" open>${heading}<p class="empty-list error-text">履歴を取得できませんでした: ${escapeHtml(value.error)}</p></details>`;
  if (!value.commits.length) return `<details class="history-repository" data-history-repository="${escapeHtml(value.repository.id)}" open>${heading}<p class="empty-list">コミット履歴はありません。</p></details>`;
  return `<details class="history-repository" data-history-repository="${escapeHtml(value.repository.id)}" open>${heading}${value.commits.map((commit) => {
    const key = `${value.repository.id}::${commit.hash}`;
    const files = key === selectedKey ? `<div class="commit-files">${selectedFiles.length ? selectedFiles.map((file) => `<button class="file commit-file" data-commit-file="${escapeHtml(file.path)}" data-commit-key="${escapeHtml(key)}" aria-selected="${file.path === selectedFile}" title="${escapeHtml(file.path)}"><span class="kind">${kindLabel(file.kind)}</span><span class="file-path">${escapeHtml(file.path)}</span></button>`).join("") : '<p class="empty-list">変更ファイルはありません。</p>'}</div>` : "";
    return `<button class="commit" data-commit="${escapeHtml(key)}" aria-expanded="${key === selectedKey}" aria-selected="${key === selectedKey}" title="${escapeHtml(commit.subject)}" aria-label="${escapeHtml(value.repository.name)}のコミット「${escapeHtml(commit.subject)}」のファイル一覧を表示">${escapeHtml(commit.subject)}</button>${files}`;
  }).join("")}</details>`;
}

function fileRow(repository: RepositorySnapshot, file: RepositoryFileChange, selected: boolean): string {
  const stat = file.binary ? "binary" : `+${file.additions ?? 0} −${file.deletions ?? 0}`;
  const key = `${repository.id}::${file.path}`;
  const repositoryPath = repository.relativePath === "." ? "" : `${repository.relativePath.replace(/\\/g, "/")}/`;
  const openPath = `${repositoryPath}${file.path}`;
  return `<div class="file" data-path="${escapeHtml(key)}" role="button" tabindex="0" aria-selected="${selected}" aria-label="${escapeHtml(repository.name)}の${escapeHtml(file.path)}の差分を表示"><span class="kind">${kindLabel(file.kind)}</span><button class="file-path" data-open-file="${escapeHtml(openPath)}" title="${escapeHtml(file.path)}" aria-label="${escapeHtml(file.path)}をエディターで開く">${escapeHtml(file.path)}</button><span class="stat">${stat}</span></div>`;
}

function changedFileStyle(): string {
  return `.file{cursor:pointer}.file-path{min-width:0;padding:0;overflow:hidden;text-align:left;text-overflow:ellipsis;white-space:nowrap;color:inherit;background:transparent;font:inherit;font-size:12px}.file-path:hover{text-decoration:underline}.file-path:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}`;
}

function historyStyle(): string {
  return `.history-repository>.repo-heading{cursor:pointer;list-style:none}.history-repository>.repo-heading::-webkit-details-marker{display:none}.history-repository>.repo-heading::before{display:inline-block;width:14px;content:"›";transition:transform .12s ease}.history-repository[open]>.repo-heading::before{transform:rotate(90deg)}.history-repository>.repo-heading:hover,.history-repository>.repo-heading:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.commit{display:block;width:100%;padding:7px 12px;overflow:hidden;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-foreground);background:transparent;text-align:left;text-overflow:ellipsis;white-space:nowrap;font:inherit;font-size:12px}.commit:hover,.commit:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.commit[aria-selected="true"]{font-weight:600;background:var(--vscode-list-inactiveSelectionBackground)}.commit-files{padding-left:12px;background:var(--vscode-sideBar-background)}.commit-files .commit-file{grid-template-columns:24px minmax(0,1fr);padding:3px 12px 3px 20px;font-size:12px}.commit-files .commit-file[aria-selected="true"]{color:var(--vscode-list-activeSelectionForeground);background:var(--vscode-list-activeSelectionBackground)}.error-text{color:var(--vscode-errorForeground)}`;
}

function changedFileScript(): string {
  return `
document.querySelectorAll('[data-path]').forEach(row=>row.addEventListener('keydown',event=>{
  if(event.target===row&&(event.key==='Enter'||event.key===' ')){event.preventDefault();vscode.postMessage({type:'selectDiff',path:row.dataset.path});}
}));
document.querySelectorAll('[data-open-file]').forEach(button=>button.addEventListener('click',event=>{
  event.stopPropagation();
  vscode.postMessage({type:'openFile',path:button.dataset.openFile});
}));`;
}

function renderTreeEntries(entries: RepositoryTreeEntry[]): string {
  return entries.length ? entries.map((entry) => entry.kind === "directory"
    ? `<div class="tree-node"><button class="tree-row" data-directory-button="${escapeHtml(entry.path)}" aria-expanded="false"><span class="tree-icon">›</span><span title="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span></button><div class="tree-children" data-directory="${escapeHtml(entry.path)}" hidden></div></div>`
    : `<button class="tree-row" data-file="${escapeHtml(entry.path)}"><span class="tree-icon">·</span><span title="${escapeHtml(entry.path)}">${escapeHtml(entry.name)}</span></button>`).join("") : '<p class="empty-list">ファイルはありません。</p>';
}

function renderDiff(value: string, label = "選択ファイルの差分"): string {
  const lines = value ? value.split("\n") : ["差分はありません。"];
  return `<pre class="diff" aria-label="${escapeHtml(label)}">${lines.map((line) => `<span class="line ${lineClass(line)}">${escapeHtml(line)}\n</span>`).join("")}</pre>`;
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

function commitFileScript(): string {
  return `
document.querySelectorAll('[data-commit-file]').forEach(button=>button.addEventListener('click',()=>{
  vscode.postMessage({type:'selectCommitFile',commit:button.dataset.commitKey,path:button.dataset.commitFile});
}));
const historyRepositories=[...document.querySelectorAll('[data-history-repository]')];
const collapsedHistoryRepositories=new Set(vscode.getState()?.collapsedHistoryRepositories||[]);
historyRepositories.forEach(repository=>{
  repository.open=!collapsedHistoryRepositories.has(repository.dataset.historyRepository);
  repository.addEventListener('toggle',()=>{
    if(repository.open)collapsedHistoryRepositories.delete(repository.dataset.historyRepository);
    else collapsedHistoryRepositories.add(repository.dataset.historyRepository);
    vscode.setState({...vscode.getState(),collapsedHistoryRepositories:[...collapsedHistoryRepositories]});
  });
});`;
}

function paneResizerScript(): string {
  return `
const layout=document.querySelector('.layout');
const resizer=document.getElementById('pane-resizer');
if(layout&&resizer){
  const clamp=value=>Math.min(70,Math.max(8,value));
  const applyWidth=value=>{
    const width=clamp(value);
    layout.style.setProperty('--file-pane-width',width+'%');
    resizer.setAttribute('aria-valuenow',String(Math.round(width)));
    vscode.setState({...vscode.getState(),filePaneWidth:width});
  };
  const savedWidth=Number(vscode.getState()?.filePaneWidth);
  applyWidth(Number.isFinite(savedWidth)?savedWidth:18);
  resizer.addEventListener('pointerdown',event=>{
    if(event.button!==0)return;
    resizer.setPointerCapture(event.pointerId);
    resizer.classList.add('dragging');
    document.body.classList.add('resizing');
    resizer.focus();
  });
  resizer.addEventListener('pointermove',event=>{
    if(!resizer.hasPointerCapture(event.pointerId))return;
    const bounds=layout.getBoundingClientRect();
    applyWidth((event.clientX-bounds.left)/bounds.width*100);
  });
  const finishResize=event=>{
    if(resizer.hasPointerCapture(event.pointerId))resizer.releasePointerCapture(event.pointerId);
    resizer.classList.remove('dragging');
    document.body.classList.remove('resizing');
  };
  resizer.addEventListener('pointerup',finishResize);
  resizer.addEventListener('pointercancel',finishResize);
  resizer.addEventListener('dblclick',()=>applyWidth(18));
  resizer.addEventListener('keydown',event=>{
      const current=Number(resizer.getAttribute('aria-valuenow'))||18;
    if(event.key==='ArrowLeft'){event.preventDefault();applyWidth(current-2);}
    else if(event.key==='ArrowRight'){event.preventDefault();applyWidth(current+2);}
    else if(event.key==='Home'){event.preventDefault();applyWidth(8);}
    else if(event.key==='End'){event.preventDefault();applyWidth(70);}
  });
}`;
}

function fileBrowserScript(): string {
  return `
const setActiveTab=tab=>{
  document.querySelectorAll('[data-tab]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.tab===tab)));
  document.querySelectorAll('[data-panel]').forEach(panel=>panel.classList.toggle('active',panel.dataset.panel===tab));
  vscode.setState({...vscode.getState(),repositoryPanelTab:tab});
};
document.querySelectorAll('[data-tab]').forEach(button=>button.addEventListener('click',()=>setActiveTab(button.dataset.tab)));
const savedTab=vscode.getState()?.repositoryPanelTab;
setActiveTab(savedTab==='files'||savedTab==='history'?savedTab:'changes');
const attachTreeHandlers=root=>{
  root.querySelectorAll('[data-file]').forEach(button=>button.addEventListener('click',()=>vscode.postMessage({type:'openFile',path:button.dataset.file})));
  root.querySelectorAll('[data-directory-button]').forEach(button=>button.addEventListener('click',()=>{
    const path=button.dataset.directoryButton;
    const children=button.parentElement.querySelector(':scope > [data-directory]');
    const opening=children.hidden;
    children.hidden=!opening;
    button.setAttribute('aria-expanded',String(opening));
    button.querySelector('.tree-icon').textContent=opening?'⌄':'›';
    if(opening&&!children.dataset.loaded){children.dataset.loaded='loading';vscode.postMessage({type:'expandDirectory',path})}
  }));
};
attachTreeHandlers(document);
window.addEventListener('message',event=>{
  if(event.data?.type!=='directoryEntries')return;
  const container=[...document.querySelectorAll('[data-directory]')].find(node=>node.dataset.directory===event.data.path);
  if(!container)return;
  container.replaceChildren();
  for(const entry of event.data.entries||[]){
    if(entry.kind==='directory'){
      const node=document.createElement('div');node.className='tree-node';
      const button=document.createElement('button');button.className='tree-row';button.dataset.directoryButton=entry.path;button.setAttribute('aria-expanded','false');
      const icon=document.createElement('span');icon.className='tree-icon';icon.textContent='›';const label=document.createElement('span');label.textContent=entry.name;label.title=entry.path;button.append(icon,label);
      const children=document.createElement('div');children.className='tree-children';children.dataset.directory=entry.path;children.hidden=true;node.append(button,children);container.append(node);
    }else{
      const button=document.createElement('button');button.className='tree-row';button.dataset.file=entry.path;
      const icon=document.createElement('span');icon.className='tree-icon';icon.textContent='·';const label=document.createElement('span');label.textContent=entry.name;label.title=entry.path;button.append(icon,label);container.append(button);
    }
  }
  container.dataset.loaded='true';attachTreeHandlers(container);
});`;
}

function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
