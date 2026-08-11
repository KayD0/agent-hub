import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface WorktreeMergeResult {
  sourceBranch: string;
  targetBranch: string;
  targetPath: string;
  alreadyMerged: boolean;
}

interface WorktreeEntry { path: string; branch?: string }

export class WorktreeMergeManager {
  public async remove(sourcePath: string, expectedSourceBranch: string, groupRootPath: string, targetBranch = "develop"): Promise<void> {
    const managedRoot = path.resolve(groupRootPath, ".worktrees");
    const relative = path.relative(managedRoot, path.resolve(sourcePath));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("管理対象外のworktreeは削除できません。");
    await this.assertBranch(sourcePath, expectedSourceBranch);
    await this.assertClean(sourcePath, "削除対象", false);
    const worktrees = parseWorktreeList(await this.git(sourcePath, ["worktree", "list", "--porcelain"]));
    const source = worktrees.find((entry) => samePath(entry.path, sourcePath) && entry.branch === expectedSourceBranch);
    const target = worktrees.find((entry) => entry.branch === targetBranch);
    if (!source || !target) throw new Error("worktreeと基準ブランチの関係を確認できませんでした。");
    if (!(await this.isAncestor(sourcePath, expectedSourceBranch, targetBranch))) throw new Error(`${expectedSourceBranch}は${targetBranch}へマージされていません。`);
    await this.git(target.path, ["worktree", "remove", sourcePath]);
  }

  public async merge(sourcePath: string, expectedSourceBranch: string, targetBranch = "develop"): Promise<WorktreeMergeResult> {
    const sourceBranch = await this.assertBranch(sourcePath, expectedSourceBranch);
    if (sourceBranch === targetBranch) throw new Error("基準ブランチ自身はマージできません。");
    const worktrees = parseWorktreeList(await this.git(sourcePath, ["worktree", "list", "--porcelain"]));
    const target = worktrees.find((entry) => entry.branch === targetBranch);
    if (!target) throw new Error(`${targetBranch}をチェックアウトしたworktreeが見つかりません。`);
    await this.assertClean(sourcePath, "マージ元", false);
    await this.assertClean(target.path, "マージ先", true);
    if (await this.isAncestor(sourcePath, sourceBranch, targetBranch)) {
      return { sourceBranch, targetBranch, targetPath: target.path, alreadyMerged: true };
    }
    await this.git(sourcePath, ["merge-tree", "--write-tree", targetBranch, sourceBranch], "競合があるためマージできません。");
    try {
      await this.git(target.path, ["merge", "--no-ff", sourceBranch, "-m", `Merge branch '${sourceBranch}' into ${targetBranch}`]);
    } catch (error) {
      if (await this.gitSucceeds(target.path, ["rev-parse", "--quiet", "--verify", "MERGE_HEAD"])) {
        await this.git(target.path, ["merge", "--abort"]).catch(() => undefined);
      }
      throw error;
    }
    return { sourceBranch, targetBranch, targetPath: target.path, alreadyMerged: false };
  }

  private async assertBranch(sourcePath: string, expectedSourceBranch: string): Promise<string> {
    const sourceBranch = (await this.git(sourcePath, ["branch", "--show-current"])).trim();
    if (!sourceBranch || sourceBranch !== expectedSourceBranch) throw new Error(`worktreeのブランチが変更されています: ${sourceBranch || "detached HEAD"}`);
    return sourceBranch;
  }

  private async assertClean(cwd: string, label: string, ignoreManagedWorktrees: boolean): Promise<void> {
    const trackedDirty = !(await this.gitSucceeds(cwd, ["diff", "--quiet"])) || !(await this.gitSucceeds(cwd, ["diff", "--cached", "--quiet"]));
    const untracked = (await this.git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]))
      .split("\0").filter(Boolean).filter((file) => !ignoreManagedWorktrees || !(file === ".worktrees" || file.startsWith(".worktrees/")));
    if (trackedDirty || untracked.length) throw new Error(`${label}に未コミット差分があります。`);
  }

  private async isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
    return this.gitSucceeds(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    try { await this.git(cwd, args); return true; } catch { return false; }
  }

  private async git(cwd: string, args: string[], fallback?: string): Promise<string> {
    try {
      const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true });
      return result.stdout;
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(fallback ?? (detail || `git ${args.join(" ")} に失敗しました。`));
    }
  }
}

function samePath(left: string, right: string): boolean { return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase(); }

export function parseWorktreeList(value: string): WorktreeEntry[] {
  return value.trim().split(/\r?\n\r?\n/).filter(Boolean).flatMap((block) => {
    const lines = block.split(/\r?\n/);
    const worktree = lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length);
    if (!worktree) return [];
    const branchRef = lines.find((line) => line.startsWith("branch "))?.slice("branch ".length);
    return [{ path: worktree, branch: branchRef?.startsWith("refs/heads/") ? branchRef.slice("refs/heads/".length) : undefined }];
  });
}
