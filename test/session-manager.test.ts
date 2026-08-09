import assert from "node:assert/strict";
import test from "node:test";
import { AppServerEvent, AppServerRequest, CodexGateway, SessionRepository } from "../src/application/ports";
import { SessionManager } from "../src/application/session-manager";
import { PersistedSession, SessionStatus, attentionForStatus, isAttentionLevel, isSessionStatus } from "../src/domain/session";

class MemoryRepository implements SessionRepository {
  public value: PersistedSession[] = [];
  public async load(): Promise<PersistedSession[]> { return this.value; }
  public async save(sessions: PersistedSession[]): Promise<void> { this.value = sessions; }
}

class FakeGateway implements CodexGateway {
  private eventListener?: (event: AppServerEvent) => void;
  private requestListener?: (request: AppServerRequest) => void;
  private exitListener?: (reason: string) => void;
  public readonly responses: Array<{ id: string | number; result: unknown }> = [];
  public readonly steers: Array<{ threadId: string; turnId: string; text: string }> = [];
  public readonly turns: Array<{ threadId: string; text: string }> = [];
  public starts = 0;
  public resumes = 0;
  public async start(): Promise<void> { this.starts += 1; }
  public async stop(): Promise<void> {}
  public async startThread(): Promise<{ threadId: string }> { return { threadId: "thread-1" }; }
  public async resumeThread(): Promise<void> { this.resumes += 1; }
  public async startTurn(threadId: string, text: string): Promise<{ turnId?: string }> {
    this.turns.push({ threadId, text });
    return { turnId: `turn-${this.turns.length}` };
  }
  public async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    this.steers.push({ threadId, turnId, text });
  }
  public async interruptTurn(): Promise<void> {}
  public async readAccount() { return { account: null, requiresOpenaiAuth: true }; }
  public async startLogin(type: "chatgpt" | "chatgptDeviceCode") {
    return type === "chatgpt"
      ? { type, loginId: "login-1", authUrl: "https://example.com/login" } as const
      : { type, loginId: "login-1", verificationUrl: "https://example.com/device", userCode: "ABCD-1234" } as const;
  }
  public async cancelLogin(): Promise<void> {}
  public async logout(): Promise<void> {}
  public respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  public onEvent(listener: (event: AppServerEvent) => void): { dispose(): void } { this.eventListener = listener; return { dispose() {} }; }
  public onRequest(listener: (request: AppServerRequest) => void): { dispose(): void } { this.requestListener = listener; return { dispose() {} }; }
  public onExit(listener: (reason: string) => void): { dispose(): void } { this.exitListener = listener; return { dispose() {} }; }
  public emitEvent(event: AppServerEvent): void { this.eventListener?.(event); }
  public emitRequest(request: AppServerRequest): void { this.requestListener?.(request); }
  public emitExit(reason: string): void { this.exitListener?.(reason); }
}

class RetryGateway extends FakeGateway {
  public override async start(): Promise<void> {
    this.starts += 1;
    if (this.starts === 1) throw new Error("spawn failed");
  }
}

function persistedSession(id: string, title: string, updatedAt: number, status: SessionStatus = "completed"): PersistedSession {
  return {
    id,
    threadId: id,
    title,
    cwd: `C:\\work\\${title}`,
    status,
    attention: attentionForStatus(status),
    unread: false,
    startedAt: updatedAt,
    updatedAt,
  };
}

test("attention level follows session status", () => {
  assert.equal(attentionForStatus("running"), "none");
  assert.equal(attentionForStatus("waiting_for_approval"), "action_required");
  assert.equal(attentionForStatus("failed"), "error");
  assert.equal(attentionForStatus("completed"), "informational");
});

test("persisted status and attention guards reject unknown values", () => {
  assert.equal(isSessionStatus("waiting_for_input"), true);
  assert.equal(isSessionStatus("unknown"), false);
  assert.equal(isAttentionLevel("action_required"), true);
  assert.equal(isAttentionLevel("warning"), false);
});

test("manual reconnect restarts the gateway and restores persisted threads", async () => {
  const repository = new MemoryRepository();
  repository.value = [persistedSession("session-1", "Session", 1)];
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, repository);
  await manager.initialize();

  await manager.reconnect();

  assert.equal(gateway.starts, 2);
  assert.equal(gateway.resumes, 2);
});

test("restoring sessions preserves terminal states and interrupts active work", async () => {
  const repository = new MemoryRepository();
  repository.value = [
    persistedSession("ready", "Ready", 1, "ready"),
    persistedSession("completed", "Completed", 2, "completed"),
    persistedSession("failed", "Failed", 3, "failed"),
    persistedSession("running", "Running", 4, "running"),
    persistedSession("waiting", "Waiting", 5, "waiting_for_input"),
    persistedSession("disconnected", "Disconnected", 6, "disconnected"),
  ];
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, repository);

  await manager.initialize();

  assert.equal(gateway.resumes, 6);
  assert.deepEqual(manager.list().map(({ status }) => status), [
    "ready", "completed", "failed", "interrupted", "interrupted", "disconnected",
  ]);
  assert.equal(manager.get("failed")?.attention, "error");
  assert.match(manager.get("running")?.currentActivity ?? "", /中断/);
});

test("restoring a session preserves its final result", async () => {
  const repository = new MemoryRepository();
  repository.value = [{
    ...persistedSession("completed", "Completed", 1, "completed"),
    finalResult: "Implemented the requested change and all tests passed.",
  }];
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, repository);

  await manager.initialize();

  assert.equal(manager.get("completed")?.finalResult, "Implemented the requested change and all tests passed.");
  assert.equal(repository.value[0]?.finalResult, "Implemented the requested change and all tests passed.");
});

test("restoring a session preserves its last instruction", async () => {
  const repository = new MemoryRepository();
  repository.value = [{
    ...persistedSession("completed", "Completed", 1, "completed"),
    lastInstruction: "Keep the card compact",
  }];
  const manager = new SessionManager(new FakeGateway(), repository);

  await manager.initialize();

  assert.equal(manager.get("completed")?.lastInstruction, "Keep the card compact");
  assert.equal(repository.value[0]?.lastInstruction, "Keep the card compact");
});

test("approval request moves session to action required and resolves once", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Run tests");

  gateway.emitRequest({
    id: 42,
    method: "item/commandExecution/requestApproval",
    params: { threadId: session.threadId, turnId: "turn-1", itemId: "item-1", command: "npm test" },
  });

  assert.equal(manager.get(session.id)?.status, "waiting_for_approval");
  assert.equal(manager.get(session.id)?.attention, "action_required");
  manager.resolveApproval(session.id, "accept");
  assert.deepEqual(gateway.responses, [{ id: 42, result: { decision: "accept" } }]);
  assert.throws(() => manager.resolveApproval(session.id, "accept"));
});

test("auto mode approves supported requests for the current session", async () => {
  const gateway = new FakeGateway();
  const repository = new MemoryRepository();
  const manager = new SessionManager(gateway, repository, undefined, { allowedCommands: ["npm test"], allowedPaths: [] });
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Run tests");
  manager.setAutoApprove(session.id, true);

  gateway.emitRequest({
    id: 43,
    method: "item/commandExecution/requestApproval",
    params: { threadId: session.threadId, command: "npm test" },
  });

  assert.deepEqual(gateway.responses, [{ id: 43, result: { decision: "acceptForSession" } }]);
  assert.equal(manager.get(session.id)?.pendingInteraction, undefined);
  assert.equal(manager.get(session.id)?.status, "running");
  assert.deepEqual(manager.get(session.id)?.approvalAudit[0], {
    timestamp: manager.get(session.id)?.approvalAudit[0]?.timestamp,
    operation: "command",
    subject: "npm test",
    decision: "auto_approved",
    reason: "登録済みコマンドと完全一致しました",
    matchedRule: "command:npm test",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repository.value[0]?.approvalAudit?.[0]?.decision, "auto_approved");
});

test("auto mode keeps unmatched commands pending for manual review", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository(), undefined, { allowedCommands: ["npm test"], allowedPaths: [] });
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Publish");
  manager.setAutoApprove(session.id, true);

  gateway.emitRequest({
    id: 47,
    method: "item/commandExecution/requestApproval",
    params: { threadId: session.threadId, command: "git push origin main" },
  });

  assert.deepEqual(gateway.responses, []);
  assert.equal(manager.get(session.id)?.status, "waiting_for_approval");
  const pending = manager.get(session.id)?.pendingInteraction;
  assert.equal(pending?.kind, "approval");
  if (pending?.kind === "approval") assert.match(pending.policyReason, /一致しません/);
});

test("bulk auto mode updates every existing session", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const first = await manager.createSession("C:\\work\\first");
  const second = await manager.createSession("C:\\work\\second");

  manager.setAllAutoApprove(true);
  assert.equal(manager.get(first.id)?.autoApprove, true);
  assert.equal(manager.get(second.id)?.autoApprove, true);

  manager.setAllAutoApprove(false);
  assert.equal(manager.get(first.id)?.autoApprove, false);
  assert.equal(manager.get(second.id)?.autoApprove, false);
});

test("auto mode audits the matched command inside a PowerShell wrapper", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository(), undefined, { allowedCommands: ["git status"], allowedPaths: [] });
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Inspect repository");
  manager.setAutoApprove(session.id, true);

  gateway.emitRequest({
    id: 48,
    method: "item/commandExecution/requestApproval",
    params: { threadId: session.threadId, command: 'pwsh -NoProfile -Command "git status"' },
  });

  assert.deepEqual(gateway.responses, [{ id: 48, result: { decision: "acceptForSession" } }]);
  const audit = manager.get(session.id)?.approvalAudit[0];
  assert.equal(audit?.subject, "git status");
  assert.equal(audit?.matchedRule, "command:git status");
  assert.match(audit?.reason ?? "", /git status/);
});

test("auto mode does not answer user input requests", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Ask first");
  manager.setAutoApprove(session.id, true);

  gateway.emitRequest({
    id: 44,
    method: "item/tool/requestUserInput",
    params: { threadId: session.threadId, questions: [{ id: "confirm", question: "Continue?" }] },
  });

  assert.deepEqual(gateway.responses, []);
  assert.equal(manager.get(session.id)?.status, "waiting_for_input");
});

test("user input request accepts all question answers in one response", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Ask first");

  gateway.emitRequest({
    id: 45,
    method: "item/tool/requestUserInput",
    params: {
      threadId: session.threadId,
      questions: [
        { id: "scope", header: "Scope", question: "Choose scopes", isMultiSelect: true, options: [{ label: "UI" }, { label: "API" }] },
        { id: "note", question: "Add a note", isOther: true, isSecret: true },
      ],
    },
  });

  const pending = manager.get(session.id)?.pendingInteraction;
  assert.equal(pending?.kind, "input");
  if (pending?.kind === "input") {
    assert.equal(pending.questions[0]?.isMultiSelect, true);
    assert.equal(pending.questions[1]?.isSecret, true);
  }
  manager.resolveInput(session.id, { scope: ["UI", "API"], note: ["private"] });
  assert.deepEqual(gateway.responses, [{ id: 45, result: { answers: { scope: { answers: ["UI", "API"] }, note: { answers: ["private"] } } } }]);
});

test("user input validation keeps the request pending", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Ask first");
  gateway.emitRequest({
    id: 46,
    method: "item/tool/requestUserInput",
    params: { threadId: session.threadId, questions: [{ id: "confirm", question: "Continue?", options: [{ label: "Yes" }] }] },
  });

  assert.throws(() => manager.resolveInput(session.id, {}), /すべての質問/);
  assert.throws(() => manager.resolveInput(session.id, { confirm: [] }), /空の回答/);
  assert.equal(manager.get(session.id)?.status, "waiting_for_input");
  assert.deepEqual(gateway.responses, []);
});

test("turn completion updates status", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Finish task");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(manager.get(session.id)?.status, "completed");
  assert.equal(manager.get(session.id)?.unread, true);
});

test("high-frequency deltas identify the changed session", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  const changes: Array<{ sessionId?: string; kind: string }> = [];
  manager.onDidChange((change) => changes.push(change));
  await manager.createSession("C:\\work\\app");

  gateway.emitEvent({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: "生成中" } });

  assert.deepEqual(changes.at(-1), { sessionId: "thread-1", kind: "delta" });
});

test("creating a session without a prompt leaves it ready without starting a turn", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();

  const session = await manager.createSession("C:\\work\\agent-link");

  assert.equal(session.title, "agent-link");
  assert.equal(session.status, "ready");
  assert.equal(session.currentTurnId, undefined);
  assert.deepEqual(gateway.turns, []);
});

test("sending the first message starts a turn for a ready session", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work\\agent-link");

  await manager.sendMessage(session.id, "Inspect the project");

  assert.deepEqual(gateway.turns, [{ threadId: "thread-1", text: "Inspect the project" }]);
  assert.equal(manager.get(session.id)?.status, "running");
  assert.equal(manager.get(session.id)?.currentTurnId, "turn-1");
  assert.equal(manager.get(session.id)?.lastInstruction, "Inspect the project");
});

test("completed agent message is retained as the final result", async () => {
  const gateway = new FakeGateway();
  const repository = new MemoryRepository();
  const manager = new SessionManager(gateway, repository);
  const session = await manager.createSession("C:\\work", "Do work");

  gateway.emitEvent({
    method: "item/completed",
    params: { threadId: session.threadId, item: { type: "agentMessage", text: "Finished successfully." } },
  });
  gateway.emitEvent({
    method: "turn/completed",
    params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } },
  });

  assert.equal(manager.get(session.id)?.finalResult, "Finished successfully.");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(repository.value[0]?.finalResult, "Finished successfully.");
});

test("reasoning and user message items are hidden from user-facing activity", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  const session = await manager.createSession("C:\\work", "Do work");
  const activityCount = session.activities.length;
  const currentActivity = session.currentActivity;

  for (const type of ["reasoning", "userMessage"]) {
    gateway.emitEvent({ method: "item/started", params: { threadId: session.threadId, item: { type } } });
    gateway.emitEvent({ method: "item/completed", params: { threadId: session.threadId, item: { type } } });
  }

  assert.equal(session.activities.length, activityCount);
  assert.equal(session.currentActivity, currentActivity);
});

test("session order remains stable and can be persisted after reordering", async () => {
  const repository = new MemoryRepository();
  repository.value = [persistedSession("thread-1", "First", 1), persistedSession("thread-2", "Second", 2)];
  const manager = new SessionManager(new FakeGateway(), repository);
  await manager.initialize();

  assert.deepEqual(manager.list().map(({ id }) => id), ["thread-1", "thread-2"]);

  await manager.reorder(["thread-2", "thread-1"]);

  assert.deepEqual(manager.list().map(({ id }) => id), ["thread-2", "thread-1"]);
  assert.deepEqual(repository.value.map(({ id }) => id), ["thread-2", "thread-1"]);
  await assert.rejects(manager.reorder(["thread-1"]), /並び順が不正/);
});

test("steering includes the active turn id", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Run tests");

  await manager.steer(session.id, "Focus on failing tests");

  assert.deepEqual(gateway.steers, [{
    threadId: "thread-1",
    turnId: "turn-1",
    text: "Focus on failing tests",
  }]);
});

test("steering rejects a session without an active turn", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Finish task");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } } });

  await assert.rejects(manager.steer(session.id, "More work"), /実行中のターンがありません/);
  assert.deepEqual(gateway.steers, []);
});

test("sending a message starts a new turn after the previous turn completed", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Finish task");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } } });

  await manager.sendMessage(session.id, "More work");

  assert.deepEqual(gateway.turns, [
    { threadId: "thread-1", text: "Finish task" },
    { threadId: "thread-1", text: "More work" },
  ]);
  assert.equal(manager.get(session.id)?.currentTurnId, "turn-2");
  assert.equal(manager.get(session.id)?.status, "running");
  assert.deepEqual(gateway.steers, []);
});

test("sending a message steers the active turn", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Run tests");

  await manager.sendMessage(session.id, "Focus on failures");

  assert.deepEqual(gateway.steers, [{
    threadId: "thread-1",
    turnId: "turn-1",
    text: "Focus on failures",
  }]);
  assert.equal(gateway.turns.length, 1);
  assert.equal(manager.get(session.id)?.lastInstruction, "Focus on failures");
});

test("attaching an issue steers an active session and persists the relationship", async () => {
  const gateway = new FakeGateway();
  const repository = new MemoryRepository();
  const manager = new SessionManager(gateway, repository);
  const session = await manager.createSession("C:\\work", "Run tests");

  await manager.attachGitHubIssue(session.id, {
    repository: "KayD0/agent-hub",
    number: 18,
    title: "Issue integration",
    url: "https://github.com/KayD0/agent-hub/issues/18",
    worktree: "C:\\work",
  }, "Handle issue #18");

  assert.equal(gateway.steers.at(-1)?.text, "Handle issue #18");
  assert.equal(manager.get(session.id)?.relatedIssues[0]?.number, 18);
  assert.equal(repository.value[0]?.relatedIssues?.[0]?.repository, "KayD0/agent-hub");
});

test("attaching an issue starts a new turn for an idle session without duplicating the relationship", async () => {
  const gateway = new FakeGateway();
  const repository = new MemoryRepository();
  const manager = new SessionManager(gateway, repository);
  const session = await manager.createSession("C:\\work", "Finish task");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } } });
  const issue = {
    repository: "KayD0/agent-hub",
    number: 18,
    title: "Issue integration",
    url: "https://github.com/KayD0/agent-hub/issues/18",
  };

  await manager.attachGitHubIssue(session.id, issue, "First pass");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-2", status: "completed" } } });
  await manager.attachGitHubIssue(session.id, { ...issue, title: "Updated title" }, "Second pass");

  assert.equal(gateway.turns.at(-1)?.text, "Second pass");
  assert.equal(manager.get(session.id)?.relatedIssues.length, 1);
  assert.equal(manager.get(session.id)?.relatedIssues[0]?.title, "Updated title");
});

test("app-server exit disconnects active sessions without approving pending request", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Dangerous task");
  gateway.emitRequest({ id: 7, method: "item/fileChange/requestApproval", params: { threadId: session.threadId } });
  gateway.emitExit("connection lost");
  assert.equal(manager.get(session.id)?.status, "disconnected");
  assert.equal(manager.get(session.id)?.pendingInteraction, undefined);
  assert.equal(gateway.responses.length, 0);
});

test("app-server exit reconnects and restores sessions", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository(), [0]);
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Keep working");

  gateway.emitExit("connection lost");
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(gateway.starts, 2);
  assert.ok(gateway.resumes >= 1);
  assert.notEqual(manager.get(session.id)?.status, "disconnected");
  await manager.dispose();
});

test("session creation retries initialization after app-server startup failure", async () => {
  const gateway = new RetryGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await assert.rejects(manager.initialize(), /spawn failed/);

  const session = await manager.createSession("C:\\work", "Retry task");

  assert.equal(gateway.starts, 2);
  assert.equal(session.threadId, "thread-1");
});
