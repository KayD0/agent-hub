import assert from "node:assert/strict";
import test from "node:test";
import { AuthenticationManager } from "../src/application/authentication-manager";
import { AppServerEvent, AppServerRequest, CodexGateway } from "../src/application/ports";
import { AccountSnapshot, LoginStartResult } from "../src/domain/authentication";

class FakeAuthGateway implements CodexGateway {
  public account: AccountSnapshot = { account: null, requiresOpenaiAuth: true };
  public cancelled: string[] = [];
  public logoutCount = 0;
  private eventListeners: Array<(event: AppServerEvent) => void> = [];

  public async start(): Promise<void> {}
  public async stop(): Promise<void> {}
  public async startThread(): Promise<{ threadId: string }> { return { threadId: "thread-1" }; }
  public async resumeThread(): Promise<void> {}
  public async startTurn(): Promise<{ turnId?: string }> { return {}; }
  public async steerTurn(): Promise<void> {}
  public async interruptTurn(): Promise<void> {}
  public async readAccount(): Promise<AccountSnapshot> { return this.account; }
  public async startLogin(type: "chatgpt" | "chatgptDeviceCode"): Promise<LoginStartResult> {
    return type === "chatgpt"
      ? { type, loginId: "browser-login", authUrl: "https://example.com/login" }
      : { type, loginId: "device-login", verificationUrl: "https://example.com/device", userCode: "ABCD-1234" };
  }
  public async cancelLogin(loginId: string): Promise<void> { this.cancelled.push(loginId); }
  public async logout(): Promise<void> { this.logoutCount += 1; }
  public respond(): void {}
  public onEvent(listener: (event: AppServerEvent) => void): { dispose(): void } {
    this.eventListeners.push(listener);
    return { dispose: () => { this.eventListeners = this.eventListeners.filter((item) => item !== listener); } };
  }
  public onRequest(_listener: (request: AppServerRequest) => void): { dispose(): void } { return { dispose() {} }; }
  public onExit(_listener: (reason: string) => void): { dispose(): void } { return { dispose() {} }; }
  public emit(event: AppServerEvent): void { for (const listener of this.eventListeners) listener(event); }
}

test("initialization reports an unauthenticated account", async () => {
  const gateway = new FakeAuthGateway();
  const manager = new AuthenticationManager(gateway);

  await manager.initialize();

  assert.deepEqual(manager.getState(), { status: "unauthenticated" });
  assert.equal(manager.isAuthenticated(), false);
});

test("initialization exposes the current ChatGPT account", async () => {
  const gateway = new FakeAuthGateway();
  gateway.account = {
    account: { type: "chatgpt", email: "user@example.com", planType: "plus" },
    requiresOpenaiAuth: true,
  };
  const manager = new AuthenticationManager(gateway);

  await manager.initialize();

  assert.deepEqual(manager.getState(), {
    status: "authenticated",
    authMode: "chatgpt",
    email: "user@example.com",
    planType: "plus",
  });
});

test("browser login can fall back to a device-code login", async () => {
  const gateway = new FakeAuthGateway();
  const manager = new AuthenticationManager(gateway);
  await manager.initialize();

  const browser = await manager.startBrowserLogin();
  const device = await manager.startDeviceCodeLogin();

  assert.equal(browser.authUrl, "https://example.com/login");
  assert.deepEqual(gateway.cancelled, ["browser-login"]);
  assert.equal(device.userCode, "ABCD-1234");
  assert.deepEqual(manager.getState(), {
    status: "logging_in",
    loginId: "device-login",
    verificationUrl: "https://example.com/device",
    userCode: "ABCD-1234",
  });
});

test("login completion refreshes the authenticated account", async () => {
  const gateway = new FakeAuthGateway();
  const manager = new AuthenticationManager(gateway);
  await manager.initialize();
  await manager.startBrowserLogin();
  gateway.account = { account: { type: "chatgpt", planType: "pro" }, requiresOpenaiAuth: true };

  gateway.emit({ method: "account/login/completed", params: { loginId: "browser-login", success: true } });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(manager.getState(), { status: "authenticated", authMode: "chatgpt", email: undefined, planType: "pro" });
});

test("failed browser login exposes the device-code fallback", async () => {
  const gateway = new FakeAuthGateway();
  const manager = new AuthenticationManager(gateway);
  await manager.initialize();
  await manager.startBrowserLogin();

  gateway.emit({ method: "account/login/completed", params: { loginId: "browser-login", success: false, error: "callback failed" } });

  assert.deepEqual(manager.getState(), { status: "error", error: "callback failed" });
});

test("logout clears the local authentication state", async () => {
  const gateway = new FakeAuthGateway();
  gateway.account = { account: { type: "chatgpt" }, requiresOpenaiAuth: true };
  const manager = new AuthenticationManager(gateway);
  await manager.initialize();

  await manager.logout();

  assert.equal(gateway.logoutCount, 1);
  assert.deepEqual(manager.getState(), { status: "unauthenticated" });
});
