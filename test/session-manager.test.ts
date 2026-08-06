import assert from "node:assert/strict";
import test from "node:test";
import { AppServerEvent, AppServerRequest, CodexGateway, SessionRepository } from "../src/application/ports";
import { SessionManager } from "../src/application/session-manager";
import { PersistedSession, attentionForStatus } from "../src/domain/session";

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
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async startThread(): Promise<{ threadId: string }> { return { threadId: "thread-1" }; }
  public async resumeThread(): Promise<void> {}
  public async startTurn(threadId: string, text: string): Promise<{ turnId?: string }> {
    this.turns.push({ threadId, text });
    return { turnId: `turn-${this.turns.length}` };
  }
  public async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    this.steers.push({ threadId, turnId, text });
  }
  public async interruptTurn(): Promise<void> {}
  public respond(id: string | number, result: unknown): void { this.responses.push({ id, result }); }
  public onEvent(listener: (event: AppServerEvent) => void): { dispose(): void } { this.eventListener = listener; return { dispose() {} }; }
  public onRequest(listener: (request: AppServerRequest) => void): { dispose(): void } { this.requestListener = listener; return { dispose() {} }; }
  public onExit(listener: (reason: string) => void): { dispose(): void } { this.exitListener = listener; return { dispose() {} }; }
  public emitEvent(event: AppServerEvent): void { this.eventListener?.(event); }
  public emitRequest(request: AppServerRequest): void { this.requestListener?.(request); }
  public emitExit(reason: string): void { this.exitListener?.(reason); }
}

class RetryGateway extends FakeGateway {
  public starts = 0;
  public override async start(): Promise<void> {
    this.starts += 1;
    if (this.starts === 1) throw new Error("spawn failed");
  }
}

function persistedSession(id: string, title: string, updatedAt: number): PersistedSession {
  return {
    id,
    threadId: id,
    title,
    cwd: `C:\\work\\${title}`,
    status: "completed",
    attention: "informational",
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
  const manager = new SessionManager(gateway, new MemoryRepository());
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

test("turn completion updates status", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Finish task");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(manager.get(session.id)?.status, "completed");
  assert.equal(manager.get(session.id)?.unread, true);
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

test("session creation retries initialization after app-server startup failure", async () => {
  const gateway = new RetryGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await assert.rejects(manager.initialize(), /spawn failed/);

  const session = await manager.createSession("C:\\work", "Retry task");

  assert.equal(gateway.starts, 2);
  assert.equal(session.threadId, "thread-1");
});
