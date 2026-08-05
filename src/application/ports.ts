import { PersistedSession } from "../domain/session";

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
  startTurn(threadId: string, text: string): Promise<{ turnId?: string }>;
  steerTurn(threadId: string, turnId: string, text: string): Promise<void>;
  interruptTurn(threadId: string, turnId: string): Promise<void>;
  respond(requestId: string | number, result: unknown): void;
  onEvent(listener: (event: AppServerEvent) => void): { dispose(): void };
  onRequest(listener: (request: AppServerRequest) => void): { dispose(): void };
  onExit(listener: (reason: string) => void): { dispose(): void };
}

export interface SessionRepository {
  load(): Promise<PersistedSession[]>;
  save(sessions: PersistedSession[]): Promise<void>;
}
