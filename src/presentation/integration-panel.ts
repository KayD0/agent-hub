import * as vscode from "vscode";
import { WorktreeIntegrationCandidate, WorktreeIntegrationService } from "../application/worktree-integration-service";
import { conflictResolutionInstruction, selectAvailableWorktreeSession, worktreeCommitInstruction } from "../application/worktree-session";
import { RepositoryManager } from "../application/repository-manager";
import { SessionManager } from "../application/session-manager";

export class IntegrationPanel implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private groupId?: string;
  private busy = false;
  public constructor(private readonly repositories: RepositoryManager, private readonly sessions: SessionManager, private readonly integration: WorktreeIntegrationService,
    private readonly openChanges: (groupId: string, repositoryId: string) => Promise<void>, private readonly onError: (error: unknown) => void) {}

  public async show(groupId: string): Promise<void> {
    const group = this.repositories.get(groupId); if (!group) throw new Error("登録フォルダが見つかりません。");
    this.groupId = groupId;
    if (!this.panel) {
      this.panel = vscode.window.createWebviewPanel("agentHub.integration", "AgentHub: 統合管理", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panel.onDidDispose(() => { this.panel = undefined; this.groupId = undefined; });
      this.panel.webview.onDidReceiveMessage((message) => void this.handle(message));
      this.panel.webview.html = renderHtml();
    } else this.panel.reveal();
    this.panel.title = `統合管理: ${group.name}`;
    await this.refresh();
  }

  public dispose(): void { this.panel?.dispose(); }

  private async handle(value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value) || !this.groupId || !this.panel) return;
    const message = value as { type?: unknown; candidateId?: unknown; candidateIds?: unknown };
    try {
      if (message.type === "refresh") await this.refresh();
      else if (message.type === "changes" && typeof message.candidateId === "string") await this.openChanges(this.groupId, message.candidateId);
      else if ((message.type === "commit" || message.type === "resolve") && typeof message.candidateId === "string") await this.requestSession(message.type, [message.candidateId]);
      else if (message.type === "commitMany" && Array.isArray(message.candidateIds)) await this.requestSession("commit", message.candidateIds.filter((id): id is string => typeof id === "string"));
      else if ((message.type === "merge" || message.type === "remove") && Array.isArray(message.candidateIds)) await this.runGit(message.type, message.candidateIds.filter((id): id is string => typeof id === "string"));
    } catch (error) { this.onError(error); } finally { this.busy = false; void this.panel?.webview.postMessage({ type: "complete" }); }
  }

  private async requestSession(kind: "commit" | "resolve", ids: string[]): Promise<void> {
    const group = this.repositories.get(this.groupId!); if (!group) throw new Error("登録フォルダが見つかりません。");
    const candidates = await this.integration.candidates(group);
    const selected = ids.map((id) => candidates.find((item) => item.id === id)).filter((item): item is WorktreeIntegrationCandidate => Boolean(item));
    if (!selected.length || selected.length !== ids.length) throw new Error("対象worktreeを再確認できませんでした。");
    if (kind === "commit" && selected.some((item) => !item.dirty)) throw new Error("未コミット差分を再確認できませんでした。");
    if (kind === "resolve" && (selected.length !== 1 || selected[0].conflict !== true)) throw new Error("競合状態を再確認できませんでした。");
    const assigned = new Set<string>();
    let created = 0;
    for (const candidate of selected) {
      const session = selectAvailableWorktreeSession(this.sessions.list(), group.rootPath, candidate.rootPath, assigned);
      const instruction = kind === "commit" ? worktreeCommitInstruction([candidate]) : conflictResolutionInstruction(candidate, candidate.baseBranch);
      if (session) { assigned.add(session.id); await this.sessions.sendMessage(session.id, instruction); }
      else { const newSession = await this.sessions.createSession(candidate.rootPath, instruction); assigned.add(newSession.id); created += 1; }
    }
    void vscode.window.showInformationMessage(`${selected.length}件の${kind === "commit" ? "コミット" : "競合解決"}作業を自動割当しました${created ? `（新規セッション${created}件）` : ""}。`);
  }

  private async runGit(kind: "merge" | "remove", ids: string[]): Promise<void> {
    if (this.busy) throw new Error("統合作業は処理中です。");
    const group = this.repositories.get(this.groupId!); if (!group) throw new Error("登録フォルダが見つかりません。");
    const answer = await vscode.window.showWarningMessage(`${ids.length}件を${kind === "merge" ? "developへマージ" : "削除"}します。`, { modal: true }, kind === "merge" ? "順番にマージ" : "worktreeを削除");
    if (!answer) return;
    this.busy = true;
    const count = kind === "merge" ? await this.integration.merge(group, ids) : await this.integration.remove(group, ids);
    void vscode.window.showInformationMessage(`${count}件の${kind === "merge" ? "マージ" : "削除"}が完了しました。`);
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    const group = this.groupId ? this.repositories.get(this.groupId) : undefined; if (!group || !this.panel) return;
    void this.panel.webview.postMessage({ type: "state", group: { name: group.name, rootPath: group.rootPath }, candidates: await this.integration.candidates(group) });
  }
}


function renderHtml(): string {
  const nonce = Math.random().toString(36).slice(2);
  return `<!doctype html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'nonce-${nonce}';script-src 'nonce-${nonce}'"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;padding:16px;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}header{display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--vscode-panel-border)}header div{min-width:0;flex:1}h1{margin:0;font-size:18px}header p{overflow:hidden;margin:3px 0 10px;color:var(--vscode-descriptionForeground);text-overflow:ellipsis;white-space:nowrap}.tabs{display:flex;gap:2px;margin:12px 0;border-bottom:1px solid var(--vscode-panel-border)}.tab{padding:6px 10px;color:var(--vscode-foreground);background:transparent}.tab.active{box-shadow:inset 0 -2px var(--vscode-focusBorder)}button{border:0;padding:4px 7px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.toolbar{display:flex;gap:5px;margin-bottom:8px}.list{border-top:1px solid var(--vscode-panel-border)}article{display:flex;align-items:center;gap:6px;min-width:0;padding:6px 4px;border-bottom:1px solid var(--vscode-panel-border)}article label{display:flex;min-width:0;flex:1;align-items:center;gap:6px}strong{flex:none}.path{min-width:0;overflow:hidden;color:var(--vscode-descriptionForeground);text-overflow:ellipsis;white-space:nowrap}.badge{flex:none;padding:1px 5px;border:1px solid currentColor;border-radius:8px;font-size:10px}.danger{color:var(--vscode-errorForeground)}.actions{display:flex;flex:none;gap:3px;margin-left:auto}.actions button{padding:1px;font-size:11px;white-space:nowrap}.empty{color:var(--vscode-descriptionForeground)}</style></head><body><header><div><h1 id="name">統合管理</h1><p id="root"></p></div><button id="refresh">更新</button></header><nav class="tabs"><button class="tab active" data-tab="queue">マージキュー</button><button class="tab" data-tab="conflict">競合</button><button class="tab" data-tab="worktree">ワークツリー</button></nav><div class="toolbar"><button id="commit-many">選択分をコミット依頼</button><button id="merge">選択分をマージ</button><button id="remove">選択分を削除</button></div><main class="list" id="list"></main><script nonce="${nonce}">const vscode=acquireVsCodeApi();let candidates=[],tab='queue',busy=false;const q=s=>document.querySelector(s);const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));function visible(c){return tab==='worktree'?c.mergeStatus==='merged':tab==='conflict'?c.conflict===true:c.mergeStatus!=='merged'}function state(c){return c.dirty?'未コミット':c.conflict?'競合あり':c.mergeStatus==='merged'?(c.inUse?'使用中':'マージ済み'):c.mergeStatus==='unmerged'?'マージ可能':'判定不能'}function draw(){const list=candidates.filter(visible);q('#list').innerHTML=list.length?list.map(c=>'<article><label><input type="checkbox" data-id="'+esc(c.id)+'"><strong>'+esc(c.branch)+' → '+esc(c.baseBranch)+'</strong><span class="path" title="'+esc(c.rootPath)+'">'+esc(c.rootPath)+'</span><span class="badge '+(c.conflict?'danger':'')+'">'+state(c)+'</span></label><div class="actions"><button data-changes="'+esc(c.id)+'">差分</button>'+(c.dirty?'<button data-commit="'+esc(c.id)+'">コミット依頼</button>':'')+(c.conflict?'<button data-resolve="'+esc(c.id)+'">競合解決</button>':'')+'</div></article>').join(''):'<p class="empty">対象はありません。</p>'}function ids(){return [...document.querySelectorAll('[data-id]:checked')].map(x=>x.dataset.id)}q('#refresh').onclick=()=>vscode.postMessage({type:'refresh'});q('#commit-many').onclick=()=>vscode.postMessage({type:'commitMany',candidateIds:ids()});q('#merge').onclick=()=>vscode.postMessage({type:'merge',candidateIds:ids()});q('#remove').onclick=()=>vscode.postMessage({type:'remove',candidateIds:ids()});document.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{tab=b.dataset.tab;document.querySelectorAll('[data-tab]').forEach(x=>x.classList.toggle('active',x===b));draw()});q('#list').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.changes)vscode.postMessage({type:'changes',candidateId:b.dataset.changes});if(b.dataset.commit)vscode.postMessage({type:'commit',candidateId:b.dataset.commit});if(b.dataset.resolve)vscode.postMessage({type:'resolve',candidateId:b.dataset.resolve})};addEventListener('message',e=>{if(e.data.type==='state'){candidates=e.data.candidates;q('#name').textContent=e.data.group.name+' — 統合管理';q('#root').textContent=e.data.group.rootPath;draw()}});</script></body></html>`;
}
