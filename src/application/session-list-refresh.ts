import type { SessionChange } from "./session-manager";

export function shouldRefreshSessionList(change: SessionChange): boolean {
  return change.kind !== "delta";
}
