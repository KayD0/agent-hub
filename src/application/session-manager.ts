import { EventEmitter } from "node:events";
import {
  InputQuestion,
  ManagedSession,
  PersistedSession,
  RelatedGitHubIssue,
  SessionActivity,
  SessionStatus,
  attentionForStatus,
  toPersistedSession,
} from "../domain/session";
import {
  AutoApprovalPolicy,
  EMPTY_AUTO_APPROVAL_POLICY,
  evaluateAutoApproval,
} from "../domain/approval-policy";
import { AppServerEvent, AppServerRequest, CodexGateway, SessionRepository } from "./ports";

const MAX_ACTIVITIES = 500;
const MAX_APPROVAL_AUDIT_ENTRIES = 200;
const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000];

export interface SessionChange {
  sessionId?: string;
  kind: "state" | "delta" | "collection";
}

export class SessionManager {
  private readonly sessions = new Map<string, ManagedSession>();
  private readonly events = new EventEmitter();
  private started = false;
  private listenersRegistered = false;
  private initializing?: Promise<void>;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectAttempt = 0;
  private disposed = false;
  private readonly interruptedByExit = new Set<string>();

  public constructor(
    private readonly gateway: CodexGateway,
    private readonly repository: SessionRepository,
    private readonly reconnectDelaysMs: readonly number[] = RECONNECT_DELAYS_MS,
    private readonly autoApprovalPolicy: AutoApprovalPolicy = EMPTY_AUTO_APPROVAL_POLICY,
  ) {}

  public initialize(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.initializing) return this.initializing;
    this.initializing = this.initializeCore().finally(() => { this.initializing = undefined; });
    return this.initializing;
  }

  private async initializeCore(): Promise<void> {
    this.disposed = false;
    for (const persisted of await this.repository.load()) {
      this.sessions.set(persisted.id, this.fromPersisted(persisted));
    }
    if (!this.listenersRegistered) {
      this.gateway.onEvent((event) => this.handleEvent(event));
      this.gateway.onRequest((request) => this.handleRequest(request));
      this.gateway.onExit((reason) => this.handleExit(reason));
      this.listenersRegistered = true;
    }
    try {
      await this.gateway.start();
      await this.restoreThreads();
      this.started = true;
      this.reconnectAttempt = 0;
      if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.emitChange();
    } catch (error) {
      this.started = false;
      throw error;
    }
  }

  public async dispose(): Promise<void> {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.gateway.stop();
  }

  public async reconnect(): Promise<void> {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    await this.gateway.stop();
    this.started = false;
    await this.initialize();
  }

  public onDidChange(listener: (change: SessionChange) => void): { dispose(): void } {
    this.events.on("change", listener);
    return { dispose: () => this.events.off("change", listener) };
  }

  public list(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  public async reorder(sessionIds: string[]): Promise<void> {
    if (sessionIds.length !== this.sessions.size || new Set(sessionIds).size !== sessionIds.length) {
      throw new Error("セッションの並び順が不正です。");
    }
    const ordered = sessionIds.map((sessionId) => this.requireSession(sessionId));
    this.sessions.clear();
    for (const session of ordered) this.sessions.set(session.id, session);
    this.emitChange();
    await this.persist();
  }

  public get(sessionId: string): ManagedSession | undefined {
    return this.sessions.get(sessionId);
  }

  public findByThreadId(threadId: string): ManagedSession | undefined {
    return this.sessions.get(threadId);
  }

  public async createSession(cwd: string, prompt?: string): Promise<ManagedSession> {
    await this.initialize();
    const { threadId } = await this.gateway.startThread(cwd);
    const now = Date.now();
    const session: ManagedSession = {
      id: threadId,
      threadId,
      title: prompt ? titleFromPrompt(prompt) : titleFromPath(cwd),
      cwd,
      status: prompt ? "starting" : "ready",
      attention: "none",
      currentActivity: prompt ? "ターンを開始しています" : "指示を入力できます",
      lastInstruction: prompt?.trim() || undefined,
      relatedIssues: [],
      autoApprove: false,
      approvalAudit: [],
      unread: false,
      startedAt: now,
      updatedAt: now,
      activities: [],
    };
    this.sessions.set(session.id, session);
    this.appendActivity(session, "system", "セッションを開始", cwd);
    this.emitChange(session.id);
    await this.persist();
    if (!prompt) return session;
    try {
      const result = await this.gateway.startTurn(threadId, prompt);
      session.currentTurnId = result.turnId;
      this.setStatus(session, "running", "Codexが処理中です");
      return session;
    } catch (error) {
      this.setStatus(session, "failed", errorMessage(error));
      throw error;
    }
  }

  public async steer(sessionId: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.currentTurnId) throw new Error("実行中のターンがありません。");
    await this.gateway.steerTurn(session.threadId, session.currentTurnId, text);
    session.lastInstruction = text;
    this.appendActivity(session, "message", "追加入力", text);
    this.setStatus(session, "running", "追加入力を処理中です");
  }

  public async sendMessage(sessionId: string, text: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (session.currentTurnId) {
      await this.steer(sessionId, text);
      return;
    }

    session.lastInstruction = text;
    this.appendActivity(session, "message", "追加指示", text);
    this.setStatus(session, "starting", "新しいターンを開始しています");
    try {
      const result = await this.gateway.startTurn(session.threadId, text);
      session.currentTurnId = result.turnId;
      this.setStatus(session, "running", "Codexが処理中です");
    } catch (error) {
      this.setStatus(session, "failed", errorMessage(error));
      throw error;
    }
  }

  public async interrupt(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    if (!session.currentTurnId) throw new Error("実行中のターンがありません。");
    await this.gateway.interruptTurn(session.threadId, session.currentTurnId);
    this.setStatus(session, "interrupted", "利用者が処理を中断しました");
  }

  public async attachFolderAnalysisOrigin(
    sessionId: string,
    repositoryGroupId: string,
    repositoryName: string,
    rootPath: string,
    scope?: "changes" | "important" | "all",
    depth?: "quick" | "standard" | "deep",
  ): Promise<void> {
    const session = this.requireSession(sessionId);
    session.origin = { kind: "folder_analysis", repositoryGroupId, repositoryName, rootPath, scope, depth };
    session.title = `課題分析: ${repositoryName}`;
    this.appendActivity(session, "system", `登録フォルダ「${repositoryName}」の課題分析`, rootPath);
    session.updatedAt = Date.now();
    this.emitChange(session.id);
    await this.persist();
  }

  public resolveApproval(sessionId: string, decision: "accept" | "acceptForSession" | "decline"): void {
    const session = this.requireSession(sessionId);
    const pending = session.pendingInteraction;
    if (!pending || pending.kind !== "approval") throw new Error("解決可能な承認要求がありません。");
    if (decision === "acceptForSession" && !pending.allowForSession) {
      throw new Error("この要求はセッション単位の許可に対応していません。");
    }
    this.gateway.respond(pending.requestId, { decision });
    this.appendApprovalAudit(session, {
      timestamp: Date.now(),
      operation: pending.method === "item/commandExecution/requestApproval" ? "command" : "file_change",
      subject: pending.command ?? pending.targetPath ?? pending.description,
      decision: decision === "accept" ? "accepted" : decision === "acceptForSession" ? "accepted_for_session" : "declined",
      reason: pending.policyReason,
      matchedRule: pending.matchedRule,
    });
    this.appendActivity(session, "system", `承認応答: ${decision}`, pending.title);
    session.pendingInteraction = undefined;
    this.setStatus(session, "running", "承認結果をCodexへ送信しました");
  }

  public setAutoApprove(sessionId: string, enabled: boolean): void {
    const session = this.requireSession(sessionId);
    session.autoApprove = enabled;
    this.appendActivity(session, "system", enabled ? "Auto承認を有効化" : "Auto承認を無効化");
    if (enabled && session.pendingInteraction?.kind === "approval") {
      const pending = session.pendingInteraction;
      if (pending.matchedRule) {
        this.resolveAutoApproval(session, pending);
        return;
      }
    }
    this.emitChange(session.id);
  }

  public async attachGitHubIssue(sessionId: string, issue: Omit<RelatedGitHubIssue, "linkedAt">, instruction: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.sendMessage(sessionId, instruction);
    const linked: RelatedGitHubIssue = { ...issue, linkedAt: Date.now() };
    const existing = session.relatedIssues.findIndex((candidate) => candidate.repository === issue.repository && candidate.number === issue.number);
    if (existing >= 0) session.relatedIssues[existing] = linked;
    else session.relatedIssues.push(linked);
    this.appendActivity(session, "system", `GitHub Issue ${issue.repository}#${issue.number} を関連付け`, issue.url);
    this.emitChange(session.id);
    await this.persist();
  }

  public setAllAutoApprove(enabled: boolean): void {
    for (const session of this.sessions.values()) this.setAutoApprove(session.id, enabled);
  }

  public resolveInput(sessionId: string, answers: Record<string, string[]>): void {
    const session = this.requireSession(sessionId);
    const pending = session.pendingInteraction;
    if (!pending || pending.kind !== "input") throw new Error("解決可能な入力要求がありません。");
    const expectedIds = new Set(pending.questions.map(({ id }) => id));
    const providedIds = Object.keys(answers);
    if (providedIds.length !== expectedIds.size || providedIds.some((id) => !expectedIds.has(id))) {
      throw new Error("すべての質問へ回答してください。");
    }
    for (const question of pending.questions) {
      const values = answers[question.id];
      if (!values?.length || values.some((value) => typeof value !== "string" || !value.trim())) {
        throw new Error("空の回答は送信できません。");
      }
      if (!question.isMultiSelect && values.length !== 1) {
        throw new Error("単一選択の質問には1件だけ回答してください。");
      }
    }
    const response = Object.fromEntries(
      Object.entries(answers).map(([key, values]) => [key, { answers: values }]),
    );
    this.gateway.respond(pending.requestId, { answers: response });
    this.appendActivity(session, "system", "ユーザー入力を送信", pending.title);
    session.pendingInteraction = undefined;
    this.setStatus(session, "running", "入力結果をCodexへ送信しました");
  }

  public async remove(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.emitChange(sessionId, "collection");
    await this.persist();
  }

  public markRead(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.unread) return;
    session.unread = false;
    this.emitChange(session.id);
    void this.persist();
  }

  private async restoreThreads(): Promise<void> {
    for (const session of this.sessions.values()) {
      const restoredStatus = this.interruptedByExit.has(session.id) ? "interrupted" : statusAfterResume(session.status);
      session.pendingInteraction = undefined;
      session.status = "disconnected";
      session.attention = attentionForStatus("disconnected");
      session.currentActivity = "セッション状態を復元中です";
      try {
        await this.gateway.resumeThread(session.threadId);
        session.status = restoredStatus;
        session.attention = attentionForStatus(session.status);
        session.currentActivity = activityAfterResume(restoredStatus);
      } catch (error) {
        session.currentActivity = `復元できません: ${errorMessage(error)}`;
      } finally {
        this.interruptedByExit.delete(session.id);
      }
    }
    await this.persist();
  }

  private handleRequest(request: AppServerRequest): void {
    const params = request.params;
    const threadId = stringValue(params.threadId);
    if (!threadId) {
      this.gateway.respond(request.id, { decision: "decline" });
      return;
    }
    const session = this.findByThreadId(threadId);
    if (!session) {
      this.gateway.respond(request.id, { decision: "decline" });
      return;
    }

    if (request.method === "item/commandExecution/requestApproval") {
      const command = optionalString(params.command);
      const reason = optionalString(params.reason);
      const policyResult = evaluateAutoApproval(this.autoApprovalPolicy, {
        operation: "command",
        sessionRoot: session.cwd,
        command,
      });
      session.pendingInteraction = {
        kind: "approval",
        requestId: request.id,
        method: request.method,
        title: "コマンド実行の承認",
        description: reason,
        command,
        policyReason: policyResult.reason,
        matchedRule: policyResult.matchedRule,
        allowForSession: true,
      };
      this.appendActivity(session, "command", "承認待ち", command ?? reason);
      if (session.autoApprove && policyResult.autoApprove) {
        this.resolveAutoApproval(session, session.pendingInteraction, policyResult.matchedCommand);
        return;
      }
      this.setStatus(session, "waiting_for_approval", command ?? reason ?? "コマンド実行の承認が必要です");
      return;
    }

    if (request.method === "item/fileChange/requestApproval") {
      const reason = optionalString(params.reason);
      const grantRoot = optionalString(params.grantRoot);
      const policyResult = evaluateAutoApproval(this.autoApprovalPolicy, {
        operation: "file_change",
        sessionRoot: session.cwd,
        targetPath: grantRoot,
      });
      session.pendingInteraction = {
        kind: "approval",
        requestId: request.id,
        method: request.method,
        title: "ファイル変更の承認",
        description: reason ?? grantRoot,
        targetPath: grantRoot,
        policyReason: policyResult.reason,
        matchedRule: policyResult.matchedRule,
        allowForSession: true,
      };
      this.appendActivity(session, "file", "承認待ち", reason ?? grantRoot);
      if (session.autoApprove && policyResult.autoApprove) {
        this.resolveAutoApproval(session, session.pendingInteraction);
        return;
      }
      this.setStatus(session, "waiting_for_approval", reason ?? "ファイル変更の承認が必要です");
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      const questions = parseQuestions(params.questions);
      session.pendingInteraction = {
        kind: "input",
        requestId: request.id,
        method: request.method,
        title: questions[0]?.header || "Codexからの質問",
        questions,
      };
      this.appendActivity(session, "system", "入力待ち", questions[0]?.question);
      this.setStatus(session, "waiting_for_input", questions[0]?.question ?? "入力が必要です");
      return;
    }

    this.gateway.respond(request.id, { decision: "decline" });
    this.appendActivity(session, "error", `未対応の要求を拒否: ${request.method}`);
  }

  private handleEvent(event: AppServerEvent): void {
    const threadId = stringValue(event.params.threadId);
    if (!threadId) return;
    const session = this.findByThreadId(threadId);
    if (!session) return;

    switch (event.method) {
      case "turn/started": {
        const turn = objectValue(event.params.turn);
        session.currentTurnId = optionalString(turn?.id);
        this.setStatus(session, "running", "Codexが処理中です");
        break;
      }
      case "item/started":
        this.handleItem(session, event.params.item, false);
        break;
      case "item/completed":
        this.handleItem(session, event.params.item, true);
        break;
      case "item/agentMessage/delta": {
        const delta = optionalString(event.params.delta);
        if (delta) session.currentActivity = compact(delta, 120);
        session.updatedAt = Date.now();
        this.emitChange(session.id, "delta");
        break;
      }
      case "turn/completed": {
        const turn = objectValue(event.params.turn);
        const status = optionalString(turn?.status);
        session.currentTurnId = undefined;
        if (status === "failed") this.setStatus(session, "failed", "ターンが失敗しました");
        else if (status === "interrupted") this.setStatus(session, "interrupted", "ターンが中断されました");
        else this.setStatus(session, "completed", "ターンが完了しました");
        session.unread = true;
        break;
      }
      case "error":
        this.appendActivity(session, "error", "Codexエラー", JSON.stringify(event.params));
        this.setStatus(session, "failed", "Codexでエラーが発生しました");
        break;
      case "serverRequest/resolved":
        if (session.pendingInteraction) {
          session.pendingInteraction = undefined;
          this.setStatus(session, "running", "要求が解決されました");
        }
        break;
      default:
        break;
    }
  }

  private handleItem(session: ManagedSession, value: unknown, completed: boolean): void {
    const item = objectValue(value);
    if (!item) return;
    const type = optionalString(item.type) ?? "item";
    if (type === "reasoning" || type === "userMessage") return;
    if (type === "agentMessage") {
      const text = optionalString(item.text) ?? "";
      this.appendActivity(session, "message", completed ? "Codex" : "メッセージ生成中", text);
      if (completed && text.trim()) session.finalResult = text.trim();
      session.currentActivity = compact(text || "メッセージを生成中です", 120);
    } else if (type === "commandExecution") {
      const command = readCommand(item.command);
      this.appendActivity(session, "command", completed ? "コマンド完了" : "コマンド実行中", command);
      session.currentActivity = compact(command || "コマンドを実行中です", 120);
    } else if (type === "fileChange") {
      this.appendActivity(session, "file", completed ? "ファイル変更完了" : "ファイルを変更中");
      session.currentActivity = completed ? "ファイル変更が完了しました" : "ファイルを変更中です";
    } else {
      this.appendActivity(session, "tool", completed ? `${type} 完了` : `${type} 実行中`);
      session.currentActivity = completed ? `${type}が完了しました` : `${type}を実行中です`;
    }
    session.updatedAt = Date.now();
    this.emitChange(session.id);
  }

  private handleExit(reason: string): void {
    this.started = false;
    for (const session of this.sessions.values()) {
      if (session.status === "running" || session.status === "starting" || session.status.startsWith("waiting_")) {
        this.interruptedByExit.add(session.id);
        session.pendingInteraction = undefined;
        session.status = "disconnected";
        session.attention = attentionForStatus("disconnected");
        session.currentActivity = reason;
        session.unread = true;
      }
    }
    this.emitChange();
    void this.persist();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer || this.reconnectAttempt >= this.reconnectDelaysMs.length) return;
    const delay = this.reconnectDelaysMs[this.reconnectAttempt++];
    for (const session of this.sessions.values()) {
      if (session.status === "disconnected") session.currentActivity = `${delay / 1_000}秒後に再接続します`;
    }
    this.emitChange();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.initialize().catch(() => this.scheduleReconnect());
    }, delay);
  }

  private setStatus(session: ManagedSession, status: SessionStatus, activity: string): void {
    session.status = status;
    session.attention = attentionForStatus(status);
    session.currentActivity = compact(activity, 160);
    session.updatedAt = Date.now();
    this.emitChange(session.id);
    void this.persist();
  }

  private appendActivity(
    session: ManagedSession,
    kind: SessionActivity["kind"],
    title: string,
    detail?: string,
  ): void {
    session.activities.push({ timestamp: Date.now(), kind, title, detail });
    if (session.activities.length > MAX_ACTIVITIES) session.activities.splice(0, session.activities.length - MAX_ACTIVITIES);
  }

  private resolveAutoApproval(
    session: ManagedSession,
    pending: Extract<NonNullable<ManagedSession["pendingInteraction"]>, { kind: "approval" }>,
    matchedCommand?: string,
  ): void {
    this.gateway.respond(pending.requestId, { decision: pending.allowForSession ? "acceptForSession" : "accept" });
    this.appendApprovalAudit(session, {
      timestamp: Date.now(),
      operation: pending.method === "item/commandExecution/requestApproval" ? "command" : "file_change",
      subject: matchedCommand ?? pending.command ?? pending.targetPath ?? pending.description,
      decision: "auto_approved",
      reason: pending.policyReason,
      matchedRule: pending.matchedRule,
    });
    this.appendActivity(session, "system", "ポリシーにより自動承認", pending.matchedRule);
    session.pendingInteraction = undefined;
    this.setStatus(session, "running", "Auto承認ポリシーを適用しました");
  }

  private appendApprovalAudit(session: ManagedSession, entry: ManagedSession["approvalAudit"][number]): void {
    session.approvalAudit.push(entry);
    if (session.approvalAudit.length > MAX_APPROVAL_AUDIT_ENTRIES) {
      session.approvalAudit.splice(0, session.approvalAudit.length - MAX_APPROVAL_AUDIT_ENTRIES);
    }
  }

  private requireSession(sessionId: string): ManagedSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("セッションが見つかりません。");
    return session;
  }

  private fromPersisted(persisted: PersistedSession): ManagedSession {
    return {
      ...persisted,
      autoApprove: false,
      approvalAudit: persisted.approvalAudit ?? [],
      relatedIssues: persisted.relatedIssues ?? [],
      pendingInteraction: undefined,
      currentTurnId: undefined,
      activities: [],
    };
  }

  private emitChange(sessionId?: string, kind: SessionChange["kind"] = sessionId ? "state" : "collection"): void {
    this.events.emit("change", { sessionId, kind } satisfies SessionChange);
  }

  private async persist(): Promise<void> {
    await this.repository.save(this.list().map(toPersistedSession));
  }
}

function titleFromPrompt(prompt: string): string {
  return compact(prompt.split(/\r?\n/, 1)[0].trim() || "新しいCodexセッション", 48);
}

function statusAfterResume(status: SessionStatus): SessionStatus {
  if (status === "ready" || status === "completed" || status === "failed" || status === "interrupted" || status === "disconnected") {
    return status;
  }
  return "interrupted";
}

function activityAfterResume(status: SessionStatus): string {
  if (status === "ready") return "指示を入力できます";
  if (status === "completed") return "完了済みのセッションを復元しました";
  if (status === "failed") return "失敗したセッションを復元しました";
  if (status === "disconnected") return "切断状態のセッションを復元しました";
  return "接続を復元しました。以前の処理は中断されています";
}

function titleFromPath(cwd: string): string {
  const normalized = cwd.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || "新しいCodexセッション";
}

function compact(value: string, length: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= length ? normalized : `${normalized.slice(0, length - 1)}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseQuestions(value: unknown): InputQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate) => {
    const question = objectValue(candidate);
    if (!question) return [];
    const id = stringValue(question.id);
    if (!id) return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidateOption) => {
          const option = objectValue(candidateOption);
          const label = option && stringValue(option.label);
          return label ? [{ label, description: optionalString(option.description) ?? "" }] : [];
        })
      : null;
    return [{
      id,
      header: optionalString(question.header) ?? "質問",
      question: optionalString(question.question) ?? "回答してください",
      isOther: question.isOther === true,
      isSecret: question.isSecret === true,
      isMultiSelect: question.isMultiSelect === true || question.multiSelect === true,
      options,
    }];
  });
}

function readCommand(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === "string").join(" ");
  return undefined;
}
