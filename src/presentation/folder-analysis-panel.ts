import * as vscode from "vscode";
import { SessionManager } from "../application/session-manager";
import { CompetitiveAnalysisFocus, FolderAnalysisCandidate, FolderAnalysisDepth, FolderAnalysisKind, FolderAnalysisScope, parseFolderAnalysisResult } from "../domain/folder-analysis";
import { RegisteredRepository } from "../domain/repository";

interface AnalysisRun {
  group: RegisteredRepository;
  sessionId: string;
  scope: FolderAnalysisScope;
  depth: FolderAnalysisDepth;
  kind: FolderAnalysisKind;
  competitiveFocus?: CompetitiveAnalysisFocus;
}

export class FolderAnalysisPanel implements vscode.Disposable {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly runs = new Map<string, AnalysisRun>();
  private readonly subscription: { dispose(): void };

  public constructor(
    private readonly sessions: SessionManager,
    private readonly createIssues: (group: RegisteredRepository, candidates: readonly FolderAnalysisCandidate[]) => Promise<readonly string[]>,
    private readonly onError: (error: unknown) => void,
  ) {
    this.subscription = sessions.onDidChange((change) => {
      if (!change.sessionId) return;
      for (const [groupId, run] of this.runs) if (run.sessionId === change.sessionId) this.render(groupId);
    });
  }

  public show(group: RegisteredRepository, sessionId: string, scope: FolderAnalysisScope, depth: FolderAnalysisDepth, kind: FolderAnalysisKind = "issues", competitiveFocus?: CompetitiveAnalysisFocus): void {
    let panel = this.panels.get(group.id);
    if (!panel) {
      panel = vscode.window.createWebviewPanel("agentHub.folderAnalysis", `${kind === "competitive" ? "競合分析" : "課題分析"}: ${group.name}`, vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
      this.panels.set(group.id, panel);
      panel.onDidDispose(() => { this.panels.delete(group.id); this.runs.delete(group.id); });
      panel.webview.onDidReceiveMessage((message: unknown) => void this.handleMessage(group.id, message));
    } else panel.reveal();
    panel.title = `${kind === "competitive" ? "競合分析" : "課題分析"}: ${group.name}`;
    this.runs.set(group.id, { group, sessionId, scope, depth, kind, competitiveFocus });
    this.render(group.id);
  }

  public showSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    const origin = session?.origin?.kind === "folder_analysis" ? session.origin : undefined;
    if (!session || !origin) throw new Error("課題分析セッションが見つかりません。");
    this.show({
      id: origin.repositoryGroupId,
      name: origin.repositoryName,
      rootPath: origin.rootPath,
      registeredAt: session.startedAt,
    }, session.id, origin.scope ?? "all", origin.depth ?? "standard", origin.analysisKind ?? "issues", origin.competitiveFocus);
  }

  public dispose(): void {
    this.subscription.dispose();
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
    this.runs.clear();
  }

  private render(groupId: string): void {
    const panel = this.panels.get(groupId);
    const run = this.runs.get(groupId);
    if (!panel || !run) return;
    const session = this.sessions.get(run.sessionId);
    panel.webview.html = renderHtml(run, session?.status ?? "failed", session?.currentActivity, session?.finalResult);
  }

  private async handleMessage(groupId: string, value: unknown): Promise<void> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const message = value as { type?: unknown; indexes?: unknown };
    if (message.type !== "createIssues" || !Array.isArray(message.indexes)) return;
    try {
      const run = this.runs.get(groupId);
      const session = run ? this.sessions.get(run.sessionId) : undefined;
      const result = session?.finalResult ? parseFolderAnalysisResult(session.finalResult) : undefined;
      if (!run || !result) throw new Error("Issue化できる分析結果が見つかりません。");
      const indexes = [...new Set(message.indexes.filter((item): item is number => Number.isInteger(item) && Number(item) >= 0))];
      const candidates = indexes.flatMap((index) => result.candidates[index] ? [result.candidates[index]] : []);
      if (!candidates.length) throw new Error("Issue化する課題を選択してください。");
      const urls = await this.createIssues(run.group, candidates);
      if (urls.length) void vscode.window.showInformationMessage(`${urls.length}件のIssueを作成しました。`);
    } catch (error) { this.onError(error); }
  }
}

function renderHtml(run: AnalysisRun, status: string, activity?: string, finalResult?: string): string {
  const nonce = randomNonce();
  const parsed = finalResult ? parseFolderAnalysisResult(finalResult) : undefined;
  const terminal = status === "completed" || status === "failed" || status === "interrupted";
  let content: string;
  if (!terminal) {
    content = `<div class="state loading"><span class="spinner" aria-hidden="true"></span><div><h2>Codexが分析しています</h2><p>${escapeHtml(activity || "対象ファイルを確認しています")}</p></div></div>`;
  } else if (status !== "completed") {
    content = `<div class="state error"><h2>分析を完了できませんでした</h2><p>${escapeHtml(activity || status)}</p></div>`;
  } else if (!parsed) {
    content = `<div class="state error"><h2>課題候補を解析できませんでした</h2><p>セッションの最終結果は下で確認できます。</p></div><pre class="raw">${escapeHtml(finalResult || "最終結果がありません。")}</pre>`;
  } else if (!parsed.candidates.length) {
    content = `<div class="state empty"><h2>課題候補はありません</h2><p>${escapeHtml(parsed.summary || "指定した条件では課題が見つかりませんでした。")}</p></div>`;
  } else {
    const candidates = parsed.candidates.map((candidate, index) => `<label class="candidate"><input type="checkbox" data-candidate="${index}"><span class="candidate-body"><span class="candidate-heading"><strong>${escapeHtml(candidate.title)}</strong><span class="priority ${candidate.priority}">${priorityLabel(candidate.priority)}</span></span><span class="description">${escapeHtml(candidate.description)}</span><span class="evidence-title">進むべき方向性</span><span class="description">${escapeHtml(candidate.direction)}</span><span class="evidence-title">根拠</span><ul>${candidate.evidence.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></span></label>`).join("");
    content = `<section class="summary"><h2>分析結果</h2><p>${escapeHtml(parsed.summary)}</p></section><div class="selection"><span id="selected-count">0件選択</span><button id="select-all" class="secondary">すべて選択</button><button id="clear" class="secondary">クリア</button><button id="create-issues">選択項目をIssue化</button></div><div class="candidates">${candidates}</div>`;
  }
  const scope = run.kind === "competitive"
    ? { positioning: "ポジショニング", features: "機能", pricing: "料金", all: "総合" }[run.competitiveFocus ?? "all"]
    : { changes: "変更差分", important: "主要ファイル", all: "フォルダ全体" }[run.scope];
  const depth = { quick: "軽量", standard: "標準", deep: "詳細" }[run.depth];
  const analysisLabel = run.kind === "competitive" ? "競合分析" : "課題分析";
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">*{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family)}header{position:sticky;top:0;z-index:2;padding:14px 18px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}h1,h2{margin:0}h1{font-size:18px}header p{margin:4px 0 0;color:var(--vscode-descriptionForeground)}main{display:grid;gap:14px;padding:16px;max-width:960px}.state,.summary{padding:16px;border:1px solid var(--vscode-panel-border);border-radius:4px}.state h2,.summary h2{font-size:14px}.state p,.summary p{margin:8px 0 0;color:var(--vscode-descriptionForeground)}.loading{display:flex;align-items:center;gap:12px}.spinner{width:18px;height:18px;border:2px solid var(--vscode-panel-border);border-top-color:var(--vscode-progressBar-background);border-radius:50%;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.error{border-color:var(--vscode-inputValidation-errorBorder)}.selection{position:sticky;top:76px;z-index:1;display:flex;align-items:center;gap:8px;padding:8px;border:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background)}.selection span{flex:1}.selection button{border:0;padding:6px 10px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);cursor:pointer}.selection .secondary{color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}.candidates{display:grid;gap:8px}.candidate{display:grid;grid-template-columns:auto minmax(0,1fr);gap:10px;padding:12px;border:1px solid var(--vscode-panel-border);border-radius:4px;cursor:pointer}.candidate:hover{background:var(--vscode-list-hoverBackground)}.candidate:focus-within{outline:1px solid var(--vscode-focusBorder)}.candidate input{margin-top:3px}.candidate-body,.description,.evidence-title{display:block}.candidate-heading{display:flex;align-items:center;gap:8px}.candidate-heading strong{flex:1}.priority{padding:2px 6px;border:1px solid var(--vscode-panel-border);border-radius:9px;font-size:11px}.priority.high{color:var(--vscode-errorForeground)}.priority.medium{color:var(--vscode-editorWarning-foreground)}.description{margin-top:6px}.evidence-title{margin-top:10px;color:var(--vscode-descriptionForeground);font-size:11px}ul{margin:4px 0 0;padding-left:20px;color:var(--vscode-descriptionForeground)}.raw{padding:12px;border:1px solid var(--vscode-panel-border);white-space:pre-wrap;word-break:break-word}@media(max-width:600px){main{padding:10px}.selection{top:92px;flex-wrap:wrap}.selection span{flex-basis:100%}}</style></head><body><header><h1>${escapeHtml(run.group.name)} の${analysisLabel}</h1><p>${escapeHtml(scope)}・${escapeHtml(depth)}・${escapeHtml(run.group.rootPath)}</p></header><main>${content}</main><script nonce="${nonce}">const vscode=acquireVsCodeApi();const boxes=[...document.querySelectorAll('[data-candidate]')];const count=document.getElementById('selected-count');const update=()=>{if(count)count.textContent=boxes.filter(box=>box.checked).length+'件選択';};boxes.forEach(box=>box.addEventListener('change',update));document.getElementById('select-all')?.addEventListener('click',()=>{boxes.forEach(box=>box.checked=true);update();});document.getElementById('clear')?.addEventListener('click',()=>{boxes.forEach(box=>box.checked=false);update();});document.getElementById('create-issues')?.addEventListener('click',()=>vscode.postMessage({type:'createIssues',indexes:boxes.filter(box=>box.checked).map(box=>Number(box.dataset.candidate))}));</script></body></html>`;
}

function priorityLabel(priority: "high" | "medium" | "low"): string { return priority === "high" ? "高" : priority === "medium" ? "中" : "低"; }
function escapeHtml(value: string): string { return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!); }
function randomNonce(): string { const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join(""); }
