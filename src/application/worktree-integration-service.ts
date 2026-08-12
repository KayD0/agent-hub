import * as path from "node:path";
import { RegisteredRepository } from "../domain/repository";
import { WorktreeMergeManager } from "../infrastructure/git/worktree-merge-manager";
import { RepositoryManager } from "./repository-manager";
import { isWorktreeRepository } from "./repository-visibility";
import { SessionManager } from "./session-manager";

export interface WorktreeIntegrationCandidate {
  id: string;
  name: string;
  rootPath: string;
  branch: string;
  baseBranch: string;
  mergeStatus: "base" | "merged" | "unmerged" | "unknown";
  dirty: boolean;
  inUse: boolean;
  conflict?: boolean;
}

export class WorktreeIntegrationService {
  public constructor(private readonly repositories: RepositoryManager, private readonly sessions: SessionManager, private readonly merges: WorktreeMergeManager) {}

  public async candidates(group: RegisteredRepository): Promise<WorktreeIntegrationCandidate[]> {
    const snapshot = await this.repositories.groupSnapshot(group);
    return Promise.all(snapshot.repositories.filter((repository) => isWorktreeRepository(group.rootPath, repository.rootPath) && repository.branch).map(async (repository) => {
      const baseBranch = repository.baseBranch ?? "develop";
      const dirty = repository.files.length > 0;
      const conflict = !dirty && repository.mergeStatus === "unmerged"
        ? await this.merges.hasMergeConflict(repository.rootPath, repository.branch!, baseBranch).catch(() => undefined)
        : false;
      return { id: repository.id, name: repository.name, rootPath: repository.rootPath, branch: repository.branch!, baseBranch, mergeStatus: repository.mergeStatus, dirty, conflict,
        inUse: this.sessions.list().some((session) => isActive(session.status) && samePath(session.cwd, repository.rootPath)) };
    }));
  }

  public async merge(group: RegisteredRepository, ids: readonly string[]): Promise<number> {
    const selected = await this.select(group, ids);
    if (selected.some((item) => item.dirty || item.conflict || item.mergeStatus !== "unmerged" || item.baseBranch !== "develop")) throw new Error("マージ対象の安全条件を再確認できませんでした。");
    for (const item of selected) await this.merges.merge(item.rootPath, item.branch, item.baseBranch);
    return selected.length;
  }

  public async remove(group: RegisteredRepository, ids: readonly string[]): Promise<number> {
    const selected = await this.select(group, ids);
    if (selected.some((item) => item.dirty || item.inUse || item.mergeStatus !== "merged" || item.baseBranch !== "develop")) throw new Error("削除対象の安全条件を再確認できませんでした。");
    for (const item of selected) await this.merges.remove(item.rootPath, item.branch, group.rootPath, item.baseBranch);
    return selected.length;
  }

  private async select(group: RegisteredRepository, values: readonly string[]): Promise<WorktreeIntegrationCandidate[]> {
    const ids = [...new Set(values)];
    const candidates = await this.candidates(group);
    const selected = ids.map((id) => candidates.find((item) => item.id === id)).filter((item): item is WorktreeIntegrationCandidate => Boolean(item));
    if (!selected.length || selected.length !== ids.length) throw new Error("対象worktreeを再確認できませんでした。");
    return selected;
  }
}

function samePath(left: string, right: string): boolean { return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase(); }
function isActive(status: string): boolean { return ["starting", "running", "waiting_for_approval", "waiting_for_input"].includes(status); }
