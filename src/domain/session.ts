export type SessionStatus =
  | "ready"
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "interrupted"
  | "disconnected";

export type AttentionLevel = "none" | "informational" | "action_required" | "error";

const SESSION_STATUSES: readonly SessionStatus[] = [
  "ready", "starting", "running", "waiting_for_approval", "waiting_for_input",
  "completed", "failed", "interrupted", "disconnected",
];

const ATTENTION_LEVELS: readonly AttentionLevel[] = ["none", "informational", "action_required", "error"];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && SESSION_STATUSES.includes(value as SessionStatus);
}

export function isAttentionLevel(value: unknown): value is AttentionLevel {
  return typeof value === "string" && ATTENTION_LEVELS.includes(value as AttentionLevel);
}

export interface InputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  isMultiSelect: boolean;
  options: Array<{ label: string; description: string }> | null;
}

export type PendingInteraction =
  | {
      kind: "approval";
      requestId: string | number;
      method: string;
      title: string;
      description?: string;
      command?: string;
      allowForSession: boolean;
    }
  | {
      kind: "input";
      requestId: string | number;
      method: string;
      title: string;
      questions: InputQuestion[];
    };

export interface SessionActivity {
  timestamp: number;
  kind: "message" | "command" | "file" | "tool" | "system" | "error";
  title: string;
  detail?: string;
}

export interface ManagedSession {
  id: string;
  threadId: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  attention: AttentionLevel;
  currentActivity?: string;
  finalResult?: string;
  autoApprove: boolean;
  currentTurnId?: string;
  pendingInteraction?: PendingInteraction;
  unread: boolean;
  startedAt: number;
  updatedAt: number;
  activities: SessionActivity[];
}

export interface PersistedSession {
  id: string;
  threadId: string;
  title: string;
  cwd: string;
  status: SessionStatus;
  attention: AttentionLevel;
  currentActivity?: string;
  finalResult?: string;
  unread: boolean;
  startedAt: number;
  updatedAt: number;
}

export function attentionForStatus(status: SessionStatus): AttentionLevel {
  if (status === "waiting_for_approval" || status === "waiting_for_input") {
    return "action_required";
  }
  if (status === "failed" || status === "disconnected") {
    return "error";
  }
  if (status === "completed" || status === "interrupted") {
    return "informational";
  }
  return "none";
}

export function toPersistedSession(session: ManagedSession): PersistedSession {
  const { activities: _activities, autoApprove: _autoApprove, pendingInteraction: _pending, currentTurnId: _turn, ...persisted } = session;
  return persisted;
}
