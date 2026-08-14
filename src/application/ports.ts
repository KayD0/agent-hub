import { PersistedSession } from "../domain/session";
import { AccountSnapshot, LoginStartResult } from "../domain/authentication";
import { CodexInput } from "../domain/codex-input";

export interface AppServerEvent {
  method: string;
  params: Record<string, unknown>;
}

export interface AppServerRequest extends AppServerEvent {
  id: string | number;
}

export interface CodexGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
  startThread(cwd: string): Promise<{ threadId: string }>;
  resumeThread(threadId: string): Promise<void>;
  startTurn(threadId: string, input: readonly CodexInput[]): Promise<{ turnId?: string }>;
  steerTurn(threadId: string, turnId: string, input: readonly CodexInput[]): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  readAccount(refreshToken?: boolean): Promise<AccountSnapshot>;
  startLogin(type: "chatgpt" | "chatgptDeviceCode"): Promise<LoginStartResult>;
  cancelLogin(loginId: string): Promise<void>;
  logout(): Promise<void>;
  respond(requestId: string | number, result: unknown): void;
  onEvent(listener: (event: AppServerEvent) => void): { dispose(): void };
  onRequest(listener: (request: AppServerRequest) => void): { dispose(): void };
  onExit(listener: (reason: string) => void): { dispose(): void };
}

export interface SessionRepository {
  load(): Promise<PersistedSession[]>;
  save(sessions: PersistedSession[]): Promise<void>;
}
