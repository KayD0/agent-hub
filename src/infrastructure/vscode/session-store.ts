import * as vscode from "vscode";
import { SessionRepository } from "../../application/ports";
import { isAttentionLevel, isSessionStatus, PersistedSession } from "../../domain/session";

const STORAGE_KEY = "agentHub.sessions.v2";
const LEGACY_STORAGE_KEY = "agentHub.sessions.v1";

interface PersistedSessionEnvelope {
  version: 2;
  sessions: PersistedSession[];
}

export class VsCodeSessionRepository implements SessionRepository {
  public constructor(private readonly state: vscode.Memento) {}

  public async load(): Promise<PersistedSession[]> {
    const current = this.state.get<unknown>(STORAGE_KEY);
    if (isPersistedSessionEnvelope(current)) return current.sessions.filter(isPersistedSession);

    const legacy = this.state.get<unknown>(LEGACY_STORAGE_KEY, []);
    if (!Array.isArray(legacy)) return [];
    const sessions = legacy.filter(isPersistedSession);
    if (sessions.length > 0) await this.save(sessions);
    return sessions;
  }

  public async save(sessions: PersistedSession[]): Promise<void> {
    const envelope: PersistedSessionEnvelope = { version: 2, sessions };
    await this.state.update(STORAGE_KEY, envelope);
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
    (candidate.lastInstruction === undefined || typeof candidate.lastInstruction === "string") &&
    (candidate.relatedIssues === undefined || (Array.isArray(candidate.relatedIssues) && candidate.relatedIssues.every(isRelatedIssue))) &&
    isSessionStatus(candidate.status) &&
    isAttentionLevel(candidate.attention) &&
    typeof candidate.startedAt === "number" &&
    typeof candidate.updatedAt === "number"
  );
}

function isRelatedIssue(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.repository === "string" && typeof candidate.number === "number" &&
    typeof candidate.title === "string" && typeof candidate.url === "string" && typeof candidate.linkedAt === "number" &&
    (candidate.branch === undefined || typeof candidate.branch === "string") &&
    (candidate.worktree === undefined || typeof candidate.worktree === "string");
}

function isPersistedSessionEnvelope(value: unknown): value is PersistedSessionEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<PersistedSessionEnvelope>;
  return candidate.version === 2 && Array.isArray(candidate.sessions);
}
