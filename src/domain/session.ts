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

export interface InputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
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
  unread: boolean;
  startedAt: number;
  updatedAt: number;
}

export const statusRank: Record<SessionStatus, number> = {
  waiting_for_approval: 0,
  waiting_for_input: 0,
  failed: 1,
  disconnected: 2,
  ready: 3,
  starting: 4,
  running: 4,
  completed: 5,
  interrupted: 6,
};

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
  const { activities: _activities, pendingInteraction: _pending, currentTurnId: _turn, ...persisted } = session;
  return persisted;
}
