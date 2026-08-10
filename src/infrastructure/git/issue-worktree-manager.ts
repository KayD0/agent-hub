import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface IssueWorktree {
  rootPath: string;
  branch: string;
  reused: boolean;
}

export class IssueWorktreeManager {
  private readonly pending = new Map<string, Promise<IssueWorktree>>();

  public prepare(groupRootPath: string, repositoryRootPath: string, issueNumber: number, issueTitle: string): Promise<IssueWorktree> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) throw new Error("Issue番号が不正です。");
    const key = `${path.resolve(repositoryRootPath).toLocaleLowerCase()}#${issueNumber}`;
    const active = this.pending.get(key);
    if (active) return active;
    const operation = this.prepareCore(groupRootPath, repositoryRootPath, issueNumber, issueTitle)
      .finally(() => this.pending.delete(key));
    this.pending.set(key, operation);
    return operation;
  }

  private async prepareCore(groupRootPath: string, repositoryRootPath: string, issueNumber: number, issueTitle: string): Promise<IssueWorktree> {
    const groupRoot = path.resolve(groupRootPath);
    const repositoryRoot = path.resolve((await this.git(repositoryRootPath, ["rev-parse", "--show-toplevel"])).trim());
    if (!isInside(repositoryRoot, groupRoot)) throw new Error("Issueのリポジトリが登録フォルダの外にあります。");

    const worktreesRoot = path.join(groupRoot, ".worktrees");
    const repositoryKey = samePath(groupRoot, repositoryRoot) ? "" : `${safePathSegment(path.basename(repositoryRoot))}-`;
    const targetPath = path.join(worktreesRoot, `${repositoryKey}issue-${issueNumber}`);
    if (!isInside(targetPath, worktreesRoot)) throw new Error("worktreeの作成先が登録フォルダの外にあります。");
    let branch = `issue/${issueNumber}-${branchSlug(issueTitle)}`;

    const targetStat = await fs.stat(targetPath).catch(() => undefined);
    if (targetStat) {
      if (!targetStat.isDirectory()) throw new Error(`worktreeの作成先がディレクトリではありません: ${targetPath}`);
      branch = await this.assertReusable(repositoryRoot, targetPath, issueNumber);
      return { rootPath: targetPath, branch, reused: true };
    }

    await fs.mkdir(worktreesRoot, { recursive: true });
    const remoteDevelop = await this.gitSucceeds(repositoryRoot, ["show-ref", "--verify", "--quiet", "refs/remotes/origin/develop"]);
    if (remoteDevelop) await this.git(repositoryRoot, ["fetch", "--quiet", "origin", "develop"]);
    const base = remoteDevelop ? "origin/develop" : "develop";
    if (!remoteDevelop && !(await this.gitSucceeds(repositoryRoot, ["show-ref", "--verify", "--quiet", "refs/heads/develop"]))) {
      throw new Error("基準ブランチdevelopが見つかりません。");
    }
    const matchingBranches = (await this.git(repositoryRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/issue/${issueNumber}-*`]))
      .split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
    if (matchingBranches.length > 1) throw new Error(`Issue #${issueNumber}に対応するブランチが複数あります: ${matchingBranches.join(", ")}`);
    if (matchingBranches[0]) branch = matchingBranches[0];
    const branchExists = await this.gitSucceeds(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (branchExists) await this.git(repositoryRoot, ["worktree", "add", "--quiet", targetPath, branch]);
    else await this.git(repositoryRoot, ["worktree", "add", "--quiet", "-b", branch, targetPath, base]);
    return { rootPath: targetPath, branch, reused: false };
  }

  private async assertReusable(repositoryRoot: string, targetPath: string, issueNumber: number): Promise<string> {
    const targetRoot = path.resolve((await this.git(targetPath, ["rev-parse", "--show-toplevel"])).trim());
    if (!samePath(targetRoot, targetPath)) throw new Error(`既存ディレクトリはworktreeのルートではありません: ${targetPath}`);
    const [repositoryCommon, targetCommon, branch] = await Promise.all([
      this.commonDirectory(repositoryRoot),
      this.commonDirectory(targetPath),
      this.git(targetPath, ["branch", "--show-current"]),
    ]);
    if (!samePath(repositoryCommon, targetCommon)) throw new Error(`既存worktreeは別のリポジトリに属しています: ${targetPath}`);
    const actualBranch = branch.trim();
    if (!actualBranch.startsWith(`issue/${issueNumber}-`)) throw new Error(`既存worktreeのブランチがIssue #${issueNumber}に対応していません: ${actualBranch || "detached HEAD"}`);
    return actualBranch;
  }

  private async commonDirectory(cwd: string): Promise<string> {
    const value = (await this.git(cwd, ["rev-parse", "--git-common-dir"])).trim();
    return path.resolve(cwd, value);
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    try { await this.git(cwd, args); return true; } catch { return false; }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    try {
      const result = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 60_000, windowsHide: true });
      return result.stdout;
    } catch (error) {
      const detail = error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string" ? error.stderr.trim() : "";
      throw new Error(detail || `git ${args.join(" ")} に失敗しました。`);
    }
  }
}

function branchSlug(value: string): string {
  const slug = value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/g, "");
  return slug || "task";
}

function safePathSegment(value: string): string {
  return value.normalize("NFKC").replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^-+|-+$/g, "") || "repository";
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase();
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
