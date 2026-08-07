import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { AuthenticationManager } from "./application/authentication-manager";
import { SessionManager } from "./application/session-manager";
import { RepositoryManager } from "./application/repository-manager";
import { AutoApprovalPolicy } from "./domain/approval-policy";
import { AppServerClient } from "./infrastructure/codex/app-server-client";
import { GitRepositoryReader } from "./infrastructure/git/git-repository-reader";
import { VsCodeSessionRepository } from "./infrastructure/vscode/session-store";
import { FileLogger } from "./infrastructure/vscode/file-logger";
import { SessionDetailPanel } from "./presentation/session-detail-panel";
import { SessionWebviewProvider } from "./presentation/session-webview-provider";
import { RepositoryDiffPanel } from "./presentation/repository-diff-panel";
import { RepositoryWebviewProvider } from "./presentation/repository-webview-provider";

let manager: SessionManager | undefined;
let logger: FileLogger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("AgentHub");
  context.subscriptions.push(output);
  logger = new FileLogger(context.extensionUri, output);
  context.subscriptions.push(logger);
  await logger.initialize();
  const codexPath = vscode.workspace.getConfiguration("agentHub").get<string>("codexPath", "codex");
  const codexArgs = vscode.workspace.getConfiguration("agentHub").get<string[]>("codexArgs", []);
  const autoApprovalPolicy = readAutoApprovalPolicy();
  await logger.info("Extension activation started", { codexPath });
  const gateway = new AppServerClient(codexPath, (message) => void logger?.info("Codex app-server", { message }), codexArgs);
  const authentication = new AuthenticationManager(gateway);
  const gitReader = new GitRepositoryReader();
  const repositoryManager = new RepositoryManager(context.globalState, gitReader);
  const repositoryDiffPanel = new RepositoryDiffPanel(repositoryManager, gitReader, showError);
  manager = new SessionManager(gateway, new VsCodeSessionRepository(context.globalState), undefined, autoApprovalPolicy);
  const detailPanel = new SessionDetailPanel(manager, context.extensionUri, showError);
  const sessionsView = new SessionWebviewProvider(manager, authentication, (sessionId) => detailPanel.show(sessionId), () => repositoryManager.list(), showError);
  let repositoriesView: RepositoryWebviewProvider;
  const addRepository = async (candidate?: vscode.Uri): Promise<string | undefined> => {
    const selected = candidate ? [candidate] : await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "フォルダを登録" });
    if (!selected?.[0]) return undefined;
    const repository = await repositoryManager.register(selected[0].fsPath);
    await repositoriesView.refresh();
    await repositoryDiffPanel.show(repository.id);
    return repository.id;
  };
  const createGroupSession = async (repositoryId: string): Promise<void> => {
    if (!authentication.isAuthenticated()) {
      const action = await vscode.window.showWarningMessage("Codexへのログインが必要です。", "ログイン");
      if (action) await vscode.commands.executeCommand("agentHub.login");
      return;
    }
    const group = repositoryManager.get(repositoryId);
    if (!group) throw new Error("登録済みフォルダが見つかりません。");
    const session = await startSession(context, manager!, vscode.Uri.file(group.rootPath));
    if (session) detailPanel.show(session.id);
  };
  repositoriesView = new RepositoryWebviewProvider(repositoryManager, (repositoryId) => repositoryDiffPanel.show(repositoryId), createGroupSession, showError);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentHub.sessions", sessionsView),
    vscode.window.registerWebviewViewProvider("agentHub.repositories", repositoriesView),
    sessionsView,
    detailPanel,
    repositoryDiffPanel,
    repositoryManager,
    { dispose: () => void manager?.dispose() },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentHub.startSession", async () => {
      if (!authentication.isAuthenticated()) {
        const action = await vscode.window.showWarningMessage("Codexへのログインが必要です。", "ログイン");
        if (action) await vscode.commands.executeCommand("agentHub.login");
        return;
      }
      const session = await startSession(context, manager!);
      if (session) detailPanel.show(session.id);
    }),
    vscode.commands.registerCommand("agentHub.login", () => startBrowserLogin(authentication)),
    vscode.commands.registerCommand("agentHub.loginDeviceCode", () => startDeviceCodeLogin(authentication)),
    vscode.commands.registerCommand("agentHub.logout", () => authentication.logout()),
    vscode.commands.registerCommand("agentHub.refresh", () => sessionsView.refresh(true)),
    vscode.commands.registerCommand("agentHub.openSession", (node: { sessionId: string }) => detailPanel.show(node.sessionId)),
    vscode.commands.registerCommand("agentHub.addRepository", (candidate?: vscode.Uri) => addRepository(candidate)),
    vscode.commands.registerCommand("agentHub.openRepositoryChanges", (repositoryId?: string) => repositoryId ? repositoryDiffPanel.show(repositoryId) : repositoriesView.refresh()),
    vscode.commands.registerCommand("agentHub.refreshRepositories", () => repositoriesView.refresh()),
    vscode.commands.registerCommand("agentHub.removeRepository", async (repositoryId: string) => { await repositoryManager.remove(repositoryId); await repositoriesView.refresh(); }),
  );

  context.subscriptions.push(repositoryManager.onDidChange(() => {
    sessionsView.refresh(true);
    void Promise.all([repositoriesView.refresh(), repositoryDiffPanel.refresh()]).catch(showError);
  }));

  const changeSubscription = manager.onDidChange(() => void notifyForChanges(manager!));
  context.subscriptions.push(changeSubscription);

  try {
    await logger.info("Authentication initialization started");
    await authentication.initialize();
    await logger.info("Authentication initialization completed", authentication.getState());
    await logger.info("Session manager initialization started");
    await manager.initialize();
    await logger.info("Session manager initialization completed");
  } catch (error) {
    await logger.error("Session manager initialization failed", error);
    output.show(true);
    showError(error);
  }
}

async function startBrowserLogin(authentication: AuthenticationManager): Promise<void> {
  try {
    const login = await authentication.startBrowserLogin();
    const opened = await vscode.env.openExternal(vscode.Uri.parse(login.authUrl));
    if (!opened) await startDeviceCodeLogin(authentication);
  } catch (error) {
    showError(error);
  }
}

async function startDeviceCodeLogin(authentication: AuthenticationManager): Promise<void> {
  try {
    const login = await authentication.startDeviceCodeLogin();
    await vscode.env.clipboard.writeText(login.userCode);
    await vscode.env.openExternal(vscode.Uri.parse(login.verificationUrl));
    void vscode.window.showInformationMessage(`Codex認証コード ${login.userCode} をクリップボードへコピーしました。`);
  } catch (error) {
    showError(error);
  }
}

export async function deactivate(): Promise<void> {
  await manager?.dispose();
  manager = undefined;
}

async function startSession(
  context: vscode.ExtensionContext,
  sessionManager: SessionManager,
  selectedFolder?: vscode.Uri,
): Promise<ReturnType<SessionManager["get"]>> {
  await logger?.info("Start session command invoked");
  try {
    if (!selectedFolder) await logger?.info("Opening folder selector");
    const folder = selectedFolder ?? await selectFolder(context);
    if (!folder) {
      await logger?.info("Start session cancelled at folder selector");
      return;
    }
    await logger?.info("Folder selected", { cwd: folder.fsPath });
    await logger?.info("Session creation started", { cwd: folder.fsPath });
    const session = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Codexセッションを開始しています" },
      () => sessionManager.createSession(folder.fsPath),
    );
    await logger?.info("Session creation completed", { cwd: folder.fsPath });
    await rememberFolder(context, folder);
    return session;
  } catch (error) {
    await logger?.error("Start session failed", error);
    showError(error);
    return undefined;
  }
}

async function selectFolder(context: vscode.ExtensionContext): Promise<vscode.Uri | undefined> {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const recentPaths = context.globalState.get<string[]>("agentHub.recentFolders", []);
  const items: Array<vscode.QuickPickItem & { uri?: vscode.Uri; browse?: boolean }> = [
    ...workspaceFolders.map((folder) => ({ label: `$(folder) ${folder.name}`, description: folder.uri.fsPath, uri: folder.uri })),
    ...recentPaths
      .filter((recent) => !workspaceFolders.some((folder) => samePath(folder.uri.fsPath, recent)))
      .map((recent) => ({ label: `$(history) ${path.basename(recent)}`, description: recent, uri: vscode.Uri.file(recent) })),
    { label: "$(folder-opened) 別のフォルダを参照...", browse: true },
  ];
  const selected = await vscode.window.showQuickPick(items, { title: "Codexセッションを開始するフォルダ", placeHolder: "作業フォルダを選択" });
  if (!selected) return undefined;
  let uri = selected.uri;
  if (selected.browse) {
    const picked = await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, openLabel: "このフォルダで開始" });
    uri = picked?.[0];
  }
  if (!uri) return undefined;
  const stat = await fs.stat(uri.fsPath);
  if (!stat.isDirectory()) throw new Error("選択したパスはフォルダではありません。");
  const outsideWorkspace = !workspaceFolders.some((folder) => isInside(uri!.fsPath, folder.uri.fsPath));
  if (outsideWorkspace) {
    const answer = await vscode.window.showWarningMessage(
      `現在のワークスペース外でCodexを開始します。\n${uri.fsPath}`,
      { modal: true },
      "このセッションで許可",
    );
    if (answer !== "このセッションで許可") return undefined;
  }
  return uri;
}

async function rememberFolder(context: vscode.ExtensionContext, uri: vscode.Uri): Promise<void> {
  const current = context.globalState.get<string[]>("agentHub.recentFolders", []);
  const updated = [uri.fsPath, ...current.filter((item) => !samePath(item, uri.fsPath))].slice(0, 10);
  await context.globalState.update("agentHub.recentFolders", updated);
}

const notified = new Map<string, string>();
async function notifyForChanges(sessionManager: SessionManager): Promise<void> {
  const config = vscode.workspace.getConfiguration("agentHub");
  for (const session of sessionManager.list()) {
    const fingerprint = `${session.status}:${session.updatedAt}`;
    if (notified.get(session.id) === fingerprint) continue;
    notified.set(session.id, fingerprint);
    if ((session.status === "waiting_for_approval" || session.status === "waiting_for_input") && config.get("notifyOnActionRequired", true)) {
      const action = await vscode.window.showWarningMessage(`AgentHub: ${session.title} は${session.status === "waiting_for_approval" ? "承認" : "入力"}待ちです`, "詳細を開く");
      if (action) await vscode.commands.executeCommand("agentHub.openSession", { type: "session", sessionId: session.id });
    } else if (session.status === "completed" && config.get("notifyOnComplete", true)) {
      void vscode.window.showInformationMessage(`AgentHub: ${session.title} が完了しました`);
    } else if ((session.status === "failed" || session.status === "disconnected") && config.get("notifyOnFailure", true)) {
      void vscode.window.showErrorMessage(`AgentHub: ${session.title} で問題が発生しました`);
    }
  }
}

function showError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`AgentHub: ${message}`);
}

function readAutoApprovalPolicy(): AutoApprovalPolicy {
  const config = vscode.workspace.getConfiguration("agentHub.autoApprove");
  return {
    allowedCommands: config.get<string[]>("allowedCommands", []),
    allowedPaths: config.get<string[]>("allowedPaths", []),
  };
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
