import { EventEmitter } from "node:events";
import { AuthenticationState, LoginStartResult } from "../domain/authentication";
import { AppServerEvent, CodexGateway } from "./ports";

export class AuthenticationManager {
  private readonly events = new EventEmitter();
  private state: AuthenticationState = { status: "checking" };
  private listenerRegistered = false;

  public constructor(private readonly gateway: CodexGateway) {}

  public async initialize(): Promise<void> {
    if (!this.listenerRegistered) {
      this.gateway.onEvent((event) => this.handleEvent(event));
      this.listenerRegistered = true;
    }
    this.setState({ status: "checking" });
    try {
      await this.gateway.start();
      await this.refresh();
    } catch (error) {
      this.setState({ status: "error", error: errorMessage(error) });
      throw error;
    }
  }

  public getState(): AuthenticationState {
    return { ...this.state };
  }

  public isAuthenticated(): boolean {
    return this.state.status === "authenticated";
  }

  public onDidChange(listener: () => void): { dispose(): void } {
    this.events.on("change", listener);
    return { dispose: () => this.events.off("change", listener) };
  }

  public async refresh(): Promise<void> {
    const result = await this.gateway.readAccount(false);
    if (result.account) {
      this.setState({
        status: "authenticated",
        authMode: result.account.type,
        email: result.account.email,
        planType: result.account.planType,
      });
      return;
    }
    if (!result.requiresOpenaiAuth) {
      this.setState({ status: "authenticated", authMode: "external" });
      return;
    }
    this.setState({ status: "unauthenticated" });
  }

  public async startBrowserLogin(): Promise<LoginStartResult & { type: "chatgpt" }> {
    return this.startLogin("chatgpt");
  }

  public async startDeviceCodeLogin(): Promise<LoginStartResult & { type: "chatgptDeviceCode" }> {
    return this.startLogin("chatgptDeviceCode");
  }

  public async cancelLogin(): Promise<void> {
    const loginId = this.state.loginId;
    if (!loginId) return;
    await this.gateway.cancelLogin(loginId);
    this.setState({ status: "unauthenticated" });
  }

  public async logout(): Promise<void> {
    await this.gateway.logout();
    this.setState({ status: "unauthenticated" });
  }

  private async startLogin<T extends "chatgpt" | "chatgptDeviceCode">(
    type: T,
  ): Promise<Extract<LoginStartResult, { type: T }>> {
    if (this.state.loginId) await this.gateway.cancelLogin(this.state.loginId);
    this.setState({ status: "logging_in" });
    try {
      const result = await this.gateway.startLogin(type);
      if (result.type !== type) throw new Error("app-serverから予期しない認証方式が返されました。");
      this.setState({
        status: "logging_in",
        loginId: result.loginId,
        verificationUrl: result.type === "chatgptDeviceCode" ? result.verificationUrl : undefined,
        userCode: result.type === "chatgptDeviceCode" ? result.userCode : undefined,
      });
      return result as Extract<LoginStartResult, { type: T }>;
    } catch (error) {
      this.setState({ status: "error", error: errorMessage(error) });
      throw error;
    }
  }

  private handleEvent(event: AppServerEvent): void {
    if (event.method === "account/updated") {
      const authMode = optionalString(event.params.authMode);
      const planType = optionalString(event.params.planType);
      if (authMode) this.setState({ status: "authenticated", authMode, planType });
      else this.setState({ status: "unauthenticated" });
      return;
    }
    if (event.method !== "account/login/completed") return;
    const loginId = optionalString(event.params.loginId);
    if (this.state.loginId && loginId && loginId !== this.state.loginId) return;
    if (event.params.success === true) {
      void this.refresh().catch((error) => this.setState({ status: "error", error: errorMessage(error) }));
      return;
    }
    this.setState({
      status: "error",
      error: optionalString(event.params.error) ?? "ログインに失敗しました。デバイスコード認証をお試しください。",
    });
  }

  private setState(state: AuthenticationState): void {
    this.state = state;
    this.events.emit("change");
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
