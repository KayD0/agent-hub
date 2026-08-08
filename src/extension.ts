import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { AuthenticationManager } from "./application/authentication-manager";
import { SessionManager } from "./application/session-manager";
import { RepositoryManager } from "./application/repository-manager";
import { AutoApprovalPolicy } from "./domain/approval-policy";
import { AppServerClient } from "./infrastructure/codex/app-server-client";
import { GitRepositoryReader } from "./infrastructure/git/git-repository-reader";
import { RepositoryFileReader } from "./infrastructure/filesystem/repository-file-reader";
import { VsCodeSessionRepository } from "./infrastructure/vscode/session-store";
import { FileLogger } from "./infrastructure/vscode/file-logger";
import { SessionDetailPanel } from "./presentation/session-detail-panel";
import { SessionWebviewProvider } from "./presentation/session-webview-provider";
import { RepositoryDiffPanel } from "./presentation/repository-diff-panel";
import { RepositoryWebviewProvider } from "./presentation/repository-webview-provider";
import { GitHubIssueClient } from "./infrastructure/github/github-issue-client";
import { GitHubIssuesPanel } from "./presentation/github-issues-panel";
import { collectEnvironmentDiagnostics } from "./infrastructure/system/environment-diagnostics";
import { redactSensitive } from "./infrastructure/vscode/file-logger";

let manager: SessionManager | undefined;
let logger: FileLogger | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel("AgentHub");
  context.subscriptions.push(output);
  logger = new FileLogger(context.logUri, output);
  context.subscriptions.push(logger);
  await logger.initialize();
  const readCodexPath = () => vscode.workspace.getConfiguration("agentHub").get<string>("codexPath")?.trim() || undefined;
  const codexPath = readCodexPath();
  const codexArgs = vscode.workspace.getConfiguration("agentHub").get<string[]>("codexArgs", []);
  const autoApprovalPolicy = readAutoApprovalPolicy();
  await logger.info("Extension activation started", { codexPath: codexPath ?? "PATH:codex" });
  const gateway = new AppServerClient(readCodexPath, (message) => void logger?.info("Codex app-server event", summarizeAppServerLog(message)), codexArgs);
  const authentication = new AuthenticationManager(gateway);
  const gitReader = new GitRepositoryReader();
  const repositoryManager = new RepositoryManager(context.globalState, gitReader);
  const repositoryDiffPanel = new RepositoryDiffPanel(repositoryManager, gitReader, new RepositoryFileReader(), showError);
  const githubIssuesPanel = new GitHubIssuesPanel(repositoryManager, new GitHubIssueClient(), async (issue, groupId) => {
    if (!authentication.isAuthenticated()) {
      const action = await vscode.window.showWarningMessage("Codexへのログインが必要です。", "ログイン");
      if (action) await vscode.commands.executeCommand("agentHub.login");
      return;
    }
    const group = repositoryManager.get(groupId);
    if (!group) throw new Error("登録済みフォルダが見つかりません。");
    const sessions = manager!.list().filter((session) => isInside(session.cwd, group.rootPath));
    const choices: Array<vscode.QuickPickItem & { sessionId?: string }> = [
      { label: "$(add) 新しいセッションを開始", description: issue.repository.rootPath },
      ...sessions.map((session) => ({
        label: `$(comment-discussion) ${session.title}`,
        description: `${session.status} · ${session.cwd}`,
        sessionId: session.id,
      })),
    ];
    const selected = await vscode.window.showQuickPick(choices, {
      title: `Issue ${issue.repository.slug}#${issue.number} を渡すセッション`,
      placeHolder: "新しいセッション、または既存セッションを選択",
    });
    if (!selected) return;
    const prompt = issuePrompt(issue);
    if (!selected.sessionId) {
      const session = await startSession(context, manager!, vscode.Uri.file(issue.repository.rootPath), prompt);
      if (session) detailPanel.show(session.id);
      return;
    }
    const target = manager!.get(selected.sessionId);
    if (!target) throw new Error("選択したセッションが見つかりません。");
    if (!samePath(target.cwd, issue.repository.rootPath)) {
      const answer = await vscode.window.showWarningMessage(
        `Issueのリポジトリとセッションの作業フォルダが異なります。\nIssue: ${issue.repository.rootPath}\nSession: ${target.cwd}`,
        { modal: true },
        "このセッションへ渡す",
      );
      if (answer !== "このセッションへ渡す") return;
    }
    await manager!.attachGitHubIssue(selected.sessionId, {
      repository: issue.repository.slug,
      number: issue.number,
      title: issue.title,
      url: issue.url,
      worktree: target.cwd,
    }, prompt);
    void vscode.window.showInformationMessage(`Issue ${issue.repository.slug}#${issue.number} を「${target.title}」へ渡しました。`);
    detailPanel.show(target.id);
  }, showError);
  manager = new SessionManager(gateway, new VsCodeSessionRepository(context.globalState), undefined, autoApprovalPolicy);
  const detailPanel = new SessionDetailPanel(manager, context.extensionUri, showError);
  const sessionsView = new SessionWebviewProvider(manager, authentication, (sessionId) => detailPanel.show(sessionId), () => repositoryManager.list(), context.workspaceState, context.extensionUri, showError);
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
  const openGroupTerminal = async (repositoryId: string): Promise<void> => {
    const group = repositoryManager.get(repositoryId);
    if (!group) throw new Error("登録済みフォルダが見つかりません。");
    const terminal = vscode.window.createTerminal({ name: `AgentHub: ${group.name}`, cwd: group.rootPath });
    terminal.show();
  };
  repositoriesView = new RepositoryWebviewProvider(repositoryManager, (repositoryId) => repositoryDiffPanel.show(repositoryId), (repositoryId) => githubIssuesPanel.show(repositoryId), openGroupTerminal, createGroupSession, showError);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("agentHub.sessions", sessionsView),
    vscode.window.registerWebviewViewProvider("agentHub.repositories", repositoriesView),
    sessionsView,
    detailPanel,
    repositoryDiffPanel,
    githubIssuesPanel,
    repositoryManager,
    { dispose: () => void manager?.dispose() },
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("agentHub.startSession", async (selectedFolder?: vscode.Uri) => {
      if (!authentication.isAuthenticated()) {
        const action = await vscode.window.showWarningMessage("Codexへのログインが必要です。", "ログイン");
        if (action) await vscode.commands.executeCommand("agentHub.login");
        return;
      }
      const session = await startSession(context, manager!, selectedFolder);
      if (session) detailPanel.show(session.id);
      return session;
    }),
    vscode.commands.registerCommand("agentHub.login", () => startBrowserLogin(authentication)),
    vscode.commands.registerCommand("agentHub.loginDeviceCode", () => startDeviceCodeLogin(authentication)),
    vscode.commands.registerCommand("agentHub.cancelLogin", () => authentication.cancelLogin()),
    vscode.commands.registerCommand("agentHub.logout", () => authentication.logout()),
    vscode.commands.registerCommand("agentHub.refresh", () => sessionsView.refresh(true)),
    vscode.commands.registerCommand("agentHub.filterSessionsByRepository", () => sessionsView.selectRepositoryGroups()),
    vscode.commands.registerCommand("agentHub.enableBulkAuto", () => sessionsView.setAllAutoApprove(true)),
    vscode.commands.registerCommand("agentHub.disableBulkAuto", () => sessionsView.setAllAutoApprove(false)),
    vscode.commands.registerCommand("agentHub.openSession", (node: { sessionId: string }) => detailPanel.show(node.sessionId)),
    vscode.commands.registerCommand("agentHub.addRepository", (candidate?: vscode.Uri) => addRepository(candidate)),
    vscode.commands.registerCommand("agentHub.openRepositoryChanges", (repositoryId?: string) => repositoryId ? repositoryDiffPanel.show(repositoryId) : repositoriesView.refresh()),
    vscode.commands.registerCommand("agentHub.openRepositoryIssues", (repositoryId?: string) => repositoryId ? githubIssuesPanel.show(repositoryId) : repositoriesView.refresh()),
    vscode.commands.registerCommand("agentHub.refreshRepositories", () => repositoriesView.refresh()),
    vscode.commands.registerCommand("agentHub.removeRepository", async (repositoryId: string) => { await repositoryManager.remove(repositoryId); await repositoriesView.refresh(); }),
    vscode.commands.registerCommand("agentHub.openSetup", () => showSetup(context, authentication, output)),
    vscode.commands.registerCommand("agentHub.redetectEnvironment", () => showSetup(context, authentication, output)),
    vscode.commands.registerCommand("agentHub.showLogs", () => output.show(true)),
    vscode.commands.registerCommand("agentHub.exportDiagnostics", () => exportDiagnostics(context, authentication)),
    vscode.commands.registerCommand("agentHub.githubLogin", () => { const terminal = vscode.window.createTerminal({ name: "GitHub CLI Login" }); terminal.show(); terminal.sendText("gh auth login", true); }),
  );

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration("agentHub.codexPath")) return;
    await logger?.info("Codex path changed; reconnecting");
    await manager?.reconnect().catch(showError);
    await authentication.initialize().catch(showError);
  }));

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

  if (!context.globalState.get<boolean>("agentHub.setupPromptDismissed.v1", false)) void promptForSetup(context, authentication, output);
}

async function promptForSetup(context: vscode.ExtensionContext, authentication: AuthenticationManager, output: vscode.OutputChannel): Promise<void> {
  const action = await vscode.window.showInformationMessage("AgentHubの利用環境を確認しますか？", "セットアップを開く", "今後表示しない");
  if (action === "セットアップを開く") await showSetup(context, authentication, output);
  if (action === "今後表示しない") await context.globalState.update("agentHub.setupPromptDismissed.v1", true);
}

async function showSetup(context: vscode.ExtensionContext, authentication: AuthenticationManager, output: vscode.OutputChannel): Promise<void> {
  const diagnostics = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "AgentHub: 環境を診断中" }, () => collectDiagnostics(context, authentication));
  type SetupItem = vscode.QuickPickItem & { action?: string };
  const icon = (status: string) => status === "ready" ? "$(pass-filled)" : status === "error" ? "$(error)" : "$(warning)";
  const selected = await vscode.window.showQuickPick<SetupItem>([
    { label: `${icon(diagnostics.codex.status)} ${diagnostics.codex.label}`, description: diagnostics.codex.detail, action: diagnostics.codex.status === "ready" ? undefined : "codex" },
    { label: `${icon(diagnostics.codexAuthentication.status)} ${diagnostics.codexAuthentication.label}`, description: diagnostics.codexAuthentication.detail, action: diagnostics.codexAuthentication.status === "ready" ? undefined : "login" },
    { label: `${icon(diagnostics.github.status)} ${diagnostics.github.label}`, description: diagnostics.github.detail, action: diagnostics.github.status === "ready" ? undefined : "github" },
    { label: "$(refresh) 再診断", action: "retry" },
    { label: "$(settings-gear) Codex CLIパス設定を開く", action: "settings" },
    { label: "$(output) AgentHubログを表示", action: "logs" },
    { label: "$(export) 安全な診断情報をエクスポート", action: "export" },
  ], { title: "AgentHub セットアップ・診断", placeHolder: "状態を確認するか、復旧操作を選択してください" });
  if (!selected?.action) return;
  if (selected.action === "retry") return showSetup(context, authentication, output);
  if (selected.action === "settings" || selected.action === "codex") return void vscode.commands.executeCommand("workbench.action.openSettings", "agentHub.codexPath");
  if (selected.action === "login") return void vscode.commands.executeCommand("agentHub.login");
  if (selected.action === "github") return void vscode.commands.executeCommand("agentHub.githubLogin");
  if (selected.action === "logs") return output.show(true);
  if (selected.action === "export") await exportDiagnostics(context, authentication);
}

async function collectDiagnostics(context: vscode.ExtensionContext, authentication: AuthenticationManager) {
  return collectEnvironmentDiagnostics({
    configuredCodexPath: vscode.workspace.getConfiguration("agentHub").get<string>("codexPath")?.trim() || undefined,
    authentication: authentication.getState(), extensionVersion: String(context.extension.packageJSON.version ?? "unknown"), vscodeVersion: vscode.version,
  });
}

async function exportDiagnostics(context: vscode.ExtensionContext, authentication: AuthenticationManager): Promise<void> {
  const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(`agenthub-diagnostics-${Date.now()}.json`), filters: { JSON: ["json"] }, saveLabel: "診断情報を保存" });
  if (!destination) return;
  const payload = redactSensitive({ diagnostics: await collectDiagnostics(context, authentication), recentLogs: await logger?.readRecent() });
  await vscode.workspace.fs.writeFile(destination, Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, "utf8"));
  void vscode.window.showInformationMessage("AgentHubの診断情報を保存しました。");
}

function summarizeAppServerLog(message: string): Record<string, unknown> {
  const category = message.startsWith("[app-server]") ? "stderr" : message.startsWith("[protocol]") ? "protocol" : "lifecycle";
  return { category, message: category === "lifecycle" ? message : "詳細は安全のため省略しました" };
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
  initialPrompt?: string,
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
      () => sessionManager.createSession(folder.fsPath, initialPrompt),
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

function issuePrompt(issue: import("./domain/github-issue").GitHubIssue): string {
  const issueBody = issue.body.length > 20_000 ? `${issue.body.slice(0, 20_000)}\n\n（本文は20,000文字で省略されました）` : issue.body;
  return `GitHub Issue ${issue.repository.slug}#${issue.number} に対応してください。\n\nタイトル: ${issue.title}\nURL: ${issue.url}\n\n本文:\n${issueBody || "（本文なし）"}`;
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
