import * as vscode from "vscode";
import { SessionRepository } from "../../application/ports";
import { PersistedSession } from "../../domain/session";

const STORAGE_KEY = "agentHub.sessions.v1";

export class VsCodeSessionRepository implements SessionRepository {
  public constructor(private readonly state: vscode.Memento) {}

  public async load(): Promise<PersistedSession[]> {
    const value = this.state.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(value)) return [];
    return value.filter(isPersistedSession);
  }

  public async save(sessions: PersistedSession[]): Promise<void> {
    await this.state.update(STORAGE_KEY, sessions);
  }
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedSession>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.threadId === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.cwd === "string" &&
    typeof candidate.status === "string" &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}
