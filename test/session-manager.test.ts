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
  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async startThread(): Promise<{ threadId: string }> { return { threadId: "thread-1" }; }
  public async resumeThread(): Promise<void> {}
  public async startTurn(): Promise<{ turnId?: string }> { return { turnId: "turn-1" }; }
  public async steerTurn(): Promise<void> {}
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

test("turn completion updates status", async () => {
  const gateway = new FakeGateway();
  const manager = new SessionManager(gateway, new MemoryRepository());
  await manager.initialize();
  const session = await manager.createSession("C:\\work", "Finish task");
  gateway.emitEvent({ method: "turn/completed", params: { threadId: session.threadId, turn: { id: "turn-1", status: "completed" } } });
  assert.equal(manager.get(session.id)?.status, "completed");
  assert.equal(manager.get(session.id)?.unread, true);
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
