import * as path from "node:path";
import * as vscode from "vscode";
import { SessionManager } from "../application/session-manager";
import { ManagedSession, SessionStatus } from "../domain/session";

type TreeNode = GroupNode | SessionNode | ChoiceNode;

interface GroupNode {
  type: "group";
  key: string;
  label: string;
  sessions: ManagedSession[];
  icon: string;
}

export interface SessionNode {
  type: "session";
  sessionId: string;
}

export interface ChoiceNode {
  type: "choice";
  sessionId: string;
  questionId: string;
  label: string;
  description: string;
}

const groups: Array<{ key: string; label: string; statuses: SessionStatus[]; icon: string }> = [
  { key: "action", label: "要対応", statuses: ["waiting_for_approval", "waiting_for_input"], icon: "bell-dot" },
  { key: "failed", label: "失敗・切断", statuses: ["failed", "disconnected"], icon: "error" },
  { key: "running", label: "実行中", statuses: ["starting", "running"], icon: "sync~spin" },
  { key: "completed", label: "完了", statuses: ["completed"], icon: "pass-filled" },
  { key: "interrupted", label: "中断", statuses: ["interrupted"], icon: "debug-pause" },
];

export class SessionTreeProvider implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined | void>();
  public readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: { dispose(): void };

  public constructor(private readonly manager: SessionManager) {
    this.subscription = manager.onDidChange(() => this.refresh());
  }

  public refresh(): void {
    this.emitter.fire();
  }

  public getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.type === "group") {
      const item = new vscode.TreeItem(
        `${element.label} (${element.sessions.length})`,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.iconPath = new vscode.ThemeIcon(element.icon);
      return item;
    }
    if (element.type === "choice") {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.description = element.description;
      item.iconPath = new vscode.ThemeIcon("check");
      item.command = { command: "agentHub.answerInput", title: "この回答を送信", arguments: [element] };
      item.contextValue = "agentHub.choice";
      return item;
    }

    const session = this.manager.get(element.sessionId);
    if (!session) return new vscode.TreeItem("不明なセッション");
    const hasChoices = session.pendingInteraction?.kind === "input";
    const item = new vscode.TreeItem(
      session.title,
      hasChoices ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
    );
    item.description = `${path.basename(session.cwd)} · ${statusLabel(session.status)}`;
    item.tooltip = new vscode.MarkdownString([
      `**${escapeMarkdown(session.title)}**`,
      "",
      `状態: ${statusLabel(session.status)}`,
      `フォルダ: \`${escapeMarkdown(session.cwd)}\``,
      session.currentActivity ? `現在: ${escapeMarkdown(session.currentActivity)}` : "",
    ].filter(Boolean).join("\n\n"));
    item.iconPath = iconForStatus(session.status);
    item.contextValue = contextForStatus(session.status);
    item.command = { command: "agentHub.openSession", title: "セッション詳細を開く", arguments: [element] };
    return item;
  }

  public getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      const sessions = this.manager.list();
      return groups.flatMap((group) => {
        const matching = sessions.filter((session) => group.statuses.includes(session.status));
        return matching.length ? [{ type: "group", ...group, sessions: matching } satisfies GroupNode] : [];
      });
    }
    if (element.type === "group") {
      return element.sessions.map((session) => ({ type: "session", sessionId: session.id }));
    }
    if (element.type === "session") {
      const pending = this.manager.get(element.sessionId)?.pendingInteraction;
      if (!pending || pending.kind !== "input") return [];
      return pending.questions.flatMap((question) =>
        (question.options ?? []).map((option) => ({
          type: "choice",
          sessionId: element.sessionId,
          questionId: question.id,
          label: option.label,
          description: option.description,
        } satisfies ChoiceNode)),
      );
    }
    return [];
  }

  public dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}

function statusLabel(status: SessionStatus): string {
  const labels: Record<SessionStatus, string> = {
    starting: "開始中",
    running: "実行中",
    waiting_for_approval: "承認待ち",
    waiting_for_input: "入力待ち",
    completed: "完了",
    failed: "失敗",
    interrupted: "中断",
    disconnected: "切断",
  };
  return labels[status];
}

function iconForStatus(status: SessionStatus): vscode.ThemeIcon {
  if (status === "waiting_for_approval" || status === "waiting_for_input") return new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("list.warningForeground"));
  if (status === "failed" || status === "disconnected") return new vscode.ThemeIcon("error", new vscode.ThemeColor("list.errorForeground"));
  if (status === "completed") return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
  if (status === "interrupted") return new vscode.ThemeIcon("debug-pause");
  return new vscode.ThemeIcon("sync~spin");
}

function contextForStatus(status: SessionStatus): string {
  if (status === "waiting_for_approval") return "agentHub.approval";
  if (status === "running" || status === "starting" || status === "waiting_for_input") return "agentHub.running";
  return `agentHub.${status}`;
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_{}\[\]()#+\-.!]/g, "\\$&");
}
