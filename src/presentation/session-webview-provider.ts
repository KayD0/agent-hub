import * as path from "node:path";
import * as vscode from "vscode";
import { AuthenticationManager } from "../application/authentication-manager";
import { SessionManager } from "../application/session-manager";
import { AuthenticationState } from "../domain/authentication";
import { ManagedSession } from "../domain/session";
import { isStringArray, parseAnswers } from "./webview-messages";

type SessionViewModel = Pick<ManagedSession, "id" | "title" | "status" | "currentActivity" | "finalResult" | "lastInstruction" | "relatedIssues" | "pendingInteraction"> & { repositoryGroupIds: string[] };
type RepositoryGroupFilter = { id: string; name: string; rootPath: string };

interface WebviewMessage {
  type?: unknown;
  sessionId?: unknown;
  text?: unknown;
  decision?: unknown;
  answers?: unknown;
  sessionIds?: unknown;
  enabled?: unknown;
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
    private readonly listRepositoryGroups: () => readonly RepositoryGroupFilter[],
    private readonly state: vscode.Memento,
    private readonly extensionUri: vscode.Uri,
    private readonly showError: (error: unknown) => void,
  ) {
    this.selectedRepositoryGroupIds = new Set(state.get<string[]>(SessionWebviewProvider.repositoryFilterKey, []));
    this.subscription = manager.onDidChange(() => this.refresh());
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

  private updateAuthenticationChrome(): void {
    const state = this.authentication.getState();
    if (this.view) this.view.description = authenticationDescription(state);
    void vscode.commands.executeCommand("setContext", "agentHub.authenticationStatus", state.status);
  }

  private updateTitleContexts(hasRepositoryGroups: boolean): void {
    void vscode.commands.executeCommand("setContext", "agentHub.hasRepositoryGroups", hasRepositoryGroups);
    void vscode.commands.executeCommand("setContext", "agentHub.repositoryFilterActive", this.selectedRepositoryGroupIds.size > 0);
  }

  private snapshot(): SessionViewModel[] {
    const groups = this.listRepositoryGroups();
    return this.manager.list().map(({ id, title, status, currentActivity, finalResult, lastInstruction, relatedIssues, pendingInteraction, cwd }) => ({
      id,
      title,
      status,
      currentActivity: status === "starting" || status === "running" ? "処理中" : currentActivity,
      finalResult,
      lastInstruction,
      relatedIssues,
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
    if (!sessionId) return;
    try {
      if (message.type === "send" && typeof message.text === "string" && message.text.trim()) await this.manager.sendMessage(sessionId, message.text.trim());
      else if (message.type === "open") { this.manager.markRead(sessionId); this.openSession(sessionId); }
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
