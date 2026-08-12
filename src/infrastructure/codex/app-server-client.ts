import { ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { AppServerEvent, AppServerRequest, CodexGateway } from "../../application/ports";
import { AccountSnapshot, LoginStartResult } from "../../domain/authentication";
import { decodeRpcMessage } from "./jsonl-protocol";

type RequestId = number;

interface PendingRpc {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

export class AppServerClient implements CodexGateway {
  private process?: ChildProcessWithoutNullStreams;
  private lineReader?: readline.Interface;
  private nextRequestId: RequestId = 1;
  private readonly pending = new Map<RequestId, PendingRpc>();
  private readonly events = new EventEmitter();
  private stopping = false;

  public constructor(
    private readonly codexPath: string | undefined | (() => string | undefined),
    private readonly log: (message: string) => void,
    private readonly commandArgs: readonly string[] = [],
    private readonly requestTimeoutMs = 30_000,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  public async start(): Promise<void> {
    if (this.process) return;
    this.stopping = false;
    const command = resolveCodexCommand(typeof this.codexPath === "function" ? this.codexPath() : this.codexPath);
    const child = spawn(command.file, [...command.args, ...this.commandArgs, "app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: this.environment,
    });
    this.process = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.log(`[app-server] ${chunk.trimEnd()}`));
    child.on("error", (error) => this.handleProcessFailure(child, `app-serverを起動できません: ${error.message}`));
    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      const reason = `app-serverが終了しました (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.cleanupProcess(child);
      this.rejectAll(new Error(reason));
      if (!this.stopping) this.events.emit("exit", reason);
    });
    this.lineReader = readline.createInterface({ input: child.stdout });
    this.lineReader.on("line", (line) => this.handleLine(line));
    try {
      await this.waitForSpawn(child);
      await this.request("initialize", {
        clientInfo: { name: "agenthub_vscode", title: "AgentHub for Codex", version: "0.1.0" },
      });
      this.notify("initialized", {});
      this.log("Codex app-serverへ接続しました。");
    } catch (error) {
      this.cleanupProcess(child);
      if (!child.killed) child.kill();
      this.rejectAll(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    this.rejectAll(new Error("AgentHubを終了しています。"));
    const child = this.process;
    if (child) this.cleanupProcess(child);
    if (!child || child.killed) return;
    child.stdin.end();
    child.kill();
  }

  public async startThread(cwd: string): Promise<{ threadId: string }> {
    const result = asObject(await this.request("thread/start", { cwd }));
    const thread = asObject(result.thread);
    const threadId = asString(thread.id);
    if (!threadId) throw new Error("thread/start応答にThread IDがありません。");
    return { threadId };
  }

  public async resumeThread(threadId: string): Promise<void> {
    await this.request("thread/resume", { threadId });
  }

  public async startTurn(threadId: string, text: string): Promise<{ turnId?: string }> {
    const result = asObject(await this.request("turn/start", {
      threadId,
      input: [{ type: "text", text }],
    }));
    const turn = asObject(result.turn);
    return { turnId: asString(turn.id) };
  }

  public async steerTurn(threadId: string, turnId: string, text: string): Promise<void> {
    await this.request("turn/steer", {
      threadId,
      input: [{ type: "text", text }],
      expectedTurnId: turnId,
    });
  }

  public async interruptTurn(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId });
  }

  public async readAccount(refreshToken = false): Promise<AccountSnapshot> {
    const result = asObject(await this.request("account/read", { refreshToken }));
    const accountValue = result.account;
    const account = accountValue === null ? null : asObject(accountValue);
    const type = asString(account?.type);
    return {
      account: type ? {
        type,
        email: asString(account?.email),
        planType: asString(account?.planType),
      } : null,
      requiresOpenaiAuth: result.requiresOpenaiAuth === true,
    };
  }

  public async startLogin(type: "chatgpt" | "chatgptDeviceCode"): Promise<LoginStartResult> {
    const params = type === "chatgpt"
      ? { type, useHostedLoginSuccessPage: true, appBrand: "codex" }
      : { type };
    const result = asObject(await this.request("account/login/start", params));
    const loginId = asString(result.loginId);
    if (!loginId) throw new Error("認証開始応答にLogin IDがありません。");
    if (type === "chatgpt") {
      const authUrl = asString(result.authUrl);
      if (!authUrl) throw new Error("ブラウザ認証URLが返されませんでした。");
      return { type, loginId, authUrl };
    }
    const verificationUrl = asString(result.verificationUrl);
    const userCode = asString(result.userCode);
    if (!verificationUrl || !userCode) throw new Error("デバイスコード認証情報が返されませんでした。");
    return { type, loginId, verificationUrl, userCode };
  }

  public async cancelLogin(loginId: string): Promise<void> {
    await this.request("account/login/cancel", { loginId });
  }

  public async logout(): Promise<void> {
    await this.request("account/logout", {});
  }

  public respond(requestId: string | number, result: unknown): void {
    this.write({ id: requestId, result });
  }

  public onEvent(listener: (event: AppServerEvent) => void): { dispose(): void } {
    this.events.on("event", listener);
    return { dispose: () => this.events.off("event", listener) };
  }

  public onRequest(listener: (request: AppServerRequest) => void): { dispose(): void } {
    this.events.on("request", listener);
    return { dispose: () => this.events.off("request", listener) };
  }

  public onExit(listener: (reason: string) => void): { dispose(): void } {
    this.events.on("exit", listener);
    return { dispose: () => this.events.off("exit", listener) };
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}が${this.requestTimeoutMs}ミリ秒以内に応答しませんでした。`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      this.write({ id, method, params });
    });
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.write({ method, params });
  }

  private write(message: RpcMessage): void {
    const child = this.process;
    if (!child || child.stdin.destroyed) throw new Error("app-serverへ接続されていません。");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcMessage;
    try {
      message = decodeRpcMessage(line);
    } catch {
      this.log(`[protocol] JSONとして解析できない行を受信しました: ${line.slice(0, 500)}`);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.events.emit("request", {
        id: message.id,
        method: message.method,
        params: message.params ?? {},
      } satisfies AppServerRequest);
      return;
    }
    if (message.method) {
      this.events.emit("event", {
        method: message.method,
        params: message.params ?? {},
      } satisfies AppServerEvent);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? "app-server request failed"));
      else pending.resolve(message.result);
    }
  }

  private waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
    return new Promise((resolve, reject) => {
      if (child.pid) {
        resolve();
        return;
      }
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  private handleProcessFailure(child: ChildProcessWithoutNullStreams, reason: string): void {
    if (this.process !== child) return;
    this.cleanupProcess(child);
    this.rejectAll(new Error(reason));
    if (!this.stopping) this.events.emit("exit", reason);
  }

  private cleanupProcess(child: ChildProcessWithoutNullStreams): void {
    if (this.process === child) this.process = undefined;
    this.lineReader?.close();
    this.lineReader = undefined;
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export interface SpawnCommand {
  file: string;
  args: string[];
}

interface CommandResolutionOptions {
  platform?: NodeJS.Platform;
  pathValue?: string;
  comSpec?: string;
  existsSync?: (candidate: string) => boolean;
}

export function resolveCodexCommand(configuredPath?: string, options: CommandResolutionOptions = {}): SpawnCommand {
  const platform = options.platform ?? process.platform;
  const existsSync = options.existsSync ?? fs.existsSync;
  const explicit = configuredPath?.trim();
  const resolved = explicit
    ? resolveExplicitExecutable(explicit, platform, options.pathValue ?? process.env.PATH, existsSync)
    : findExecutableOnPath("codex", platform, options.pathValue ?? process.env.PATH, existsSync);
  if (!resolved) {
    const target = explicit ? `設定された実行ファイル「${explicit}」` : "PATH上のcodexコマンド";
    throw new Error(`Codex CLIが見つかりません（${target}）。Codex CLIをPATHから実行可能にするか、VS Code設定 agentHub.codexPath に実行ファイルを指定してください。`);
  }
  if (platform !== "win32") return { file: resolved, args: [] };

  const extension = path.win32.extname(resolved).toLocaleLowerCase();
  if (extension === ".cmd" || extension === ".bat") {
    return {
      file: options.comSpec || process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", resolved],
    };
  }
  return { file: resolved, args: [] };
}

function resolveExplicitExecutable(command: string, platform: NodeJS.Platform, pathValue: string | undefined, existsSync: (candidate: string) => boolean): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  if (pathApi.isAbsolute(command) || command.includes("/") || command.includes("\\")) return existsSync(command) ? command : undefined;
  return findExecutableOnPath(command, platform, pathValue, existsSync);
}

function findExecutableOnPath(command: string, platform: NodeJS.Platform, pathValue: string | undefined, existsSync: (candidate: string) => boolean): string | undefined {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const extensions = platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""];
  const pathDirectories = (pathValue ?? "").split(delimiter).map((value) => value.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const extension of extensions) {
    for (const directory of pathDirectories) {
      const candidate = pathApi.join(directory, pathApi.extname(command) ? command : `${command}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
