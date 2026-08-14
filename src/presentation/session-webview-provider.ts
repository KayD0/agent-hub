import * as path from "node:path";
import * as vscode from "vscode";
import { AuthenticationManager } from "../application/authentication-manager";
import { SessionManager } from "../application/session-manager";
import { shouldRefreshSessionList } from "../application/session-list-refresh";
import { AuthenticationState } from "../domain/authentication";
import { ManagedSession } from "../domain/session";
import { isStringArray, parseAnswers } from "./webview-messages";
import { ImageInputStore, parsePastedImages } from "../infrastructure/filesystem/image-input-store";

type SessionViewModel = Pick<ManagedSession, "id" | "title" | "status" | "currentActivity" | "finalResult" | "lastInstruction" | "origin" | "relatedIssues" | "autoApprove" | "unrestrictedAutoApprove" | "pendingInteraction"> & { repositoryGroupIds: string[] };
type RepositoryGroupFilter = { id: string; name: string; rootPath: string };

interface WebviewMessage {
  type?: unknown;
  sessionId?: unknown;
  text?: unknown;
  decision?: unknown;
  answers?: unknown;
  sessionIds?: unknown;
  enabled?: unknown;
  images?: unknown;
}

export class SessionWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private static readonly repositoryFilterKey = "agentHub.repositoryGroupFilterIds";
  private view?: vscode.WebviewView;
  private lastSnapshot?: string;
  private readonly selectedRepositoryGroupIds: Set<string>;
  private readonly subscription: { dispose(): void };
  private readonly authSubscription: { dispose(): void };

  public constructor(
    private readonly manager: SessionManager,
    private readonly authentication: AuthenticationManager,
    private readonly openSession: (sessionId: string) => void,
    private readonly openAnalysisResult: (sessionId: string) => void,
    private readonly listRepositoryGroups: () => readonly RepositoryGroupFilter[],
    private readonly state: vscode.Memento,
    private readonly extensionUri: vscode.Uri,
    private readonly imageInputs: ImageInputStore,
    private readonly showError: (error: unknown) => void,
  ) {
    this.selectedRepositoryGroupIds = new Set(state.get<string[]>(SessionWebviewProvider.repositoryFilterKey, []));
    this.subscription = manager.onDidChange((change) => {
      if (shouldRefreshSessionList(change)) this.refresh();
    });
    this.authSubscription = authentication.onDidChange(() => this.refresh());
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.lastSnapshot = undefined;
    this.updateAuthenticationChrome();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")],
    };
    view.webview.onDidReceiveMessage((message: WebviewMessage) => void this.handleMessage(message));
    view.onDidChangeVisibility(() => { if (view.visible) this.refresh(); });
    view.onDidDispose(() => { this.view = undefined; });
    view.webview.html = renderHtml(view.webview, this.extensionUri);
  }

  public refresh(force = false): void {
    this.updateAuthenticationChrome();
    const groups = this.listRepositoryGroups();
    for (const id of this.selectedRepositoryGroupIds) {
      if (!groups.some((group) => group.id === id)) this.selectedRepositoryGroupIds.delete(id);
    }
    this.updateTitleContexts(groups.length > 0);
    const message = {
      type: "sessions",
      sessions: this.snapshot(),
      authentication: this.authentication.getState(),
      repositoryGroupFilterIds: [...this.selectedRepositoryGroupIds],
    };
    const serialized = JSON.stringify(message);
    if (!force && serialized === this.lastSnapshot) return;
    this.lastSnapshot = serialized;
    void this.view?.webview.postMessage(message);
  }

  public async selectRepositoryGroups(): Promise<void> {
    const groups = this.listRepositoryGroups();
    const selected = await vscode.window.showQuickPick(groups.map((group) => ({
      label: group.name,
      description: group.rootPath,
      id: group.id,
      picked: this.selectedRepositoryGroupIds.has(group.id),
    })), {
      canPickMany: true,
      placeHolder: "表示するフォルダを選択（未選択ですべて表示）",
      title: "Codex Sessionsのフォルダフィルター",
    });
    if (!selected) return;
    this.selectedRepositoryGroupIds.clear();
    for (const item of selected) this.selectedRepositoryGroupIds.add(item.id);
    await this.state.update(SessionWebviewProvider.repositoryFilterKey, [...this.selectedRepositoryGroupIds]);
    this.refresh(true);
  }

  public dispose(): void {
    this.subscription.dispose();
    this.authSubscription.dispose();
  }

  public setAllAutoApprove(enabled: boolean): void {
    this.manager.setAllAutoApprove(enabled);
    this.updateTitleContexts(this.listRepositoryGroups().length > 0);
  }

  public async setAllUnrestrictedAutoApprove(enabled: boolean): Promise<void> {
    if (enabled) {
      const answer = await vscode.window.showWarningMessage(
        "すべての既存セッションで無制限Autoを有効にします。削除・外部送信・セッション外のファイル変更を含むすべての承認要求が、安全ポリシーなしで自動承認されます。",
        { modal: true },
        "すべて無制限Autoにする",
      );
      if (answer !== "すべて無制限Autoにする") return;
    }
    this.manager.setAllUnrestrictedAutoApprove(enabled);
    this.updateTitleContexts(this.listRepositoryGroups().length > 0);
  }

  private updateAuthenticationChrome(): void {
    const state = this.authentication.getState();
    if (this.view) this.view.description = authenticationDescription(state);
    void vscode.commands.executeCommand("setContext", "agentHub.authenticationStatus", state.status);
  }

  private updateTitleContexts(hasRepositoryGroups: boolean): void {
    const sessions = this.manager.list();
    const allAutoEnabled = sessions.length > 0 && sessions.every((session) => session.autoApprove);
    const allUnrestrictedAutoEnabled = sessions.length > 0 && sessions.every((session) => session.unrestrictedAutoApprove);
    void vscode.commands.executeCommand("setContext", "agentHub.hasRepositoryGroups", hasRepositoryGroups);
    void vscode.commands.executeCommand("setContext", "agentHub.repositoryFilterActive", this.selectedRepositoryGroupIds.size > 0);
    void vscode.commands.executeCommand("setContext", "agentHub.bulkAutoEnabled", allAutoEnabled);
    void vscode.commands.executeCommand("setContext", "agentHub.bulkUnrestrictedAutoEnabled", allUnrestrictedAutoEnabled);
  }

  private snapshot(): SessionViewModel[] {
    const groups = this.listRepositoryGroups();
    return this.manager.list().map(({ id, title, status, currentActivity, finalResult, lastInstruction, origin, relatedIssues, autoApprove, unrestrictedAutoApprove, pendingInteraction, cwd }) => ({
      id,
      title,
      status,
      currentActivity: status === "starting" || status === "running" ? "処理中" : currentActivity,
      finalResult,
      lastInstruction,
      origin,
      relatedIssues,
      autoApprove,
      unrestrictedAutoApprove,
      pendingInteraction,
      repositoryGroupIds: groups.filter((group) => isInside(cwd, group.rootPath)).map((group) => group.id),
    }));
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    const sessionId = typeof message.sessionId === "string" ? message.sessionId : undefined;
    if (message.type === "ready") { this.refresh(true); return; }
    if (message.type === "reorder" && isStringArray(message.sessionIds)) {
      try { await this.manager.reorder(message.sessionIds); } catch (error) { this.showError(error); }
      return;
    }
    if (message.type === "bulkApprove") {
      const approvals = this.manager.list().filter((session) => session.pendingInteraction?.kind === "approval");
      const safe = approvals.filter((session) => session.pendingInteraction?.kind === "approval" && session.pendingInteraction.matchedRule);
      if (!safe.length) return;
      const details = safe.slice(0, 8).map((session) => {
        const pending = session.pendingInteraction;
        const subject = pending?.kind === "approval" ? pending.command ?? pending.targetPath ?? pending.description ?? pending.title : "";
        return `・${session.title}: ${subject}`;
      }).join("\n");
      const omitted = safe.length > 8 ? `\nほか${safe.length - 8}件` : "";
      const answer = await vscode.window.showWarningMessage(
        `安全ポリシーに一致する${safe.length}件を今回のみ承認します。\n\n${details}${omitted}`,
        { modal: true },
        `${safe.length}件を承認`,
      );
      if (answer !== `${safe.length}件を承認`) return;
      const candidates = safe.flatMap((session) => session.pendingInteraction?.kind === "approval"
        ? [{ sessionId: session.id, requestId: session.pendingInteraction.requestId }]
        : []);
      const result = this.manager.resolveSafePendingApprovals(candidates);
      void vscode.window.showInformationMessage(`${result.approved}件を承認しました${result.skipped ? `（${result.skipped}件は個別確認が必要です）` : ""}。`);
      return;
    }
    if (!sessionId) return;
    try {
      if (message.type === "send" && typeof message.text === "string") {
        const images = parsePastedImages(message.images);
        if (!images || (!message.text.trim() && !images.length)) return;
        const paths = await this.imageInputs.save(images);
        try { await this.manager.sendMessage(sessionId, message.text.trim(), paths); }
        finally { await this.imageInputs.remove(paths); }
      }
      else if (message.type === "autoApprove" && typeof message.enabled === "boolean") this.manager.setAutoApprove(sessionId, message.enabled);
      else if (message.type === "unrestrictedAutoApprove" && typeof message.enabled === "boolean") {
        if (!message.enabled) this.manager.setUnrestrictedAutoApprove(sessionId, false);
        else {
          const answer = await vscode.window.showWarningMessage(
            "無制限Autoを有効にすると、削除・外部送信・セッション外のファイル変更を含むすべての承認要求を安全ポリシーなしで自動承認します。",
            { modal: true },
            "無制限Autoを有効化",
          );
          if (answer === "無制限Autoを有効化") this.manager.setUnrestrictedAutoApprove(sessionId, true);
          else this.refresh(true);
        }
      }
      else if (message.type === "open") { this.manager.markRead(sessionId); this.openSession(sessionId); }
      else if (message.type === "openAnalysisResult") this.openAnalysisResult(sessionId);
      else if (message.type === "interrupt") await this.manager.interrupt(sessionId);
      else if (message.type === "remove") await this.manager.remove(sessionId);
      else if (message.type === "approval" && isDecision(message.decision)) this.manager.resolveApproval(sessionId, message.decision);
      else if (message.type === "answer") { const answers = parseAnswers(message.answers); if (answers) this.manager.resolveInput(sessionId, answers); }
    } catch (error) { this.showError(error); }
  }
}

function isDecision(value: unknown): value is "accept" | "acceptForSession" | "decline" {
  return value === "accept" || value === "acceptForSession" || value === "decline";
}

function authenticationDescription(state: AuthenticationState): string | undefined {
  if (state.status === "authenticated") return undefined;
  if (state.status === "logging_in") return "ログイン中";
  if (state.status === "checking") return "認証確認中";
  if (state.status === "error") return "認証エラー";
  return "未ログイン";
}

function renderHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "session-webview.css"));
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "session-webview.js"));
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
</head>
<body><main id="sessions" aria-live="polite"></main><script src="${scriptUri}"></script></body>
</html>`;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
