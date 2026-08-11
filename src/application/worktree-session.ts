import * as path from "node:path";
import { ManagedSession } from "../domain/session";

export function findWorktreeSession(sessions: readonly ManagedSession[], worktreePath: string, currentSessionId: string): ManagedSession | undefined {
  const matches = sessions.filter((session) => samePath(session.cwd, worktreePath));
  return matches.find((session) => session.id === currentSessionId)
    ?? matches.find((session) => isActive(session.status))
    ?? matches[0];
}

export function worktreeCommitInstruction(rootPath: string, branch: string): string {
  return `現在のworktree（${rootPath}、ブランチ: ${branch}）の未コミット差分を確認してください。不要なファイルを含めず、変更内容に必要なテストまたは検証を行い、適切な日本語のコミットメッセージでコミットしてください。push、マージ、worktree削除は行わないでください。`;
}

function samePath(left: string, right: string): boolean { return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase(); }
function isActive(status: ManagedSession["status"]): boolean { return ["starting", "running", "waiting_for_approval", "waiting_for_input"].includes(status); }
