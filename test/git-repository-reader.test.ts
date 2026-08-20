import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { GitRepositoryReader, parseCommitFiles, parseGitHistory, parseNumstat, parsePorcelainStatus } from "../src/infrastructure/git/git-repository-reader";
import { IssueWorktreeManager } from "../src/infrastructure/git/issue-worktree-manager";
import { WorktreeMergeManager, parseWorktreeList } from "../src/infrastructure/git/worktree-merge-manager";

const execFileAsync = promisify(execFile);

test("parses modified, added, deleted, and untracked porcelain records", () => {
  assert.deepEqual(parsePorcelainStatus(" M src/a.ts\0A  src/new.ts\0 D docs/old.md\0?? notes.txt\0"), [
    { path: "src/a.ts", kind: "modified", binary: false },
    { path: "src/new.ts", kind: "added", binary: false },
    { path: "docs/old.md", kind: "deleted", binary: false },
    { path: "notes.txt", kind: "untracked", binary: false },
  ]);
});

test("parses rename records without treating the original path as another file", () => {
  assert.deepEqual(parsePorcelainStatus("R  src/new.ts\0src/old.ts\0"), [
    { path: "src/new.ts", originalPath: "src/old.ts", kind: "renamed", binary: false },
  ]);
});

test("parses text and binary numstat", () => {
  const stats = parseNumstat("12\t3\tsrc/a.ts\n-\t-\tmedia/logo.png\n");
  assert.deepEqual(stats.get("src/a.ts"), { additions: 12, deletions: 3, binary: false });
  assert.deepEqual(stats.get("media/logo.png"), { additions: undefined, deletions: undefined, binary: true });
});

test("parses git history with references and unicode subjects", () => {
  const history = parseGitHistory(["abcdef", "abc1234", "山田 太郎", "2026-08-09T12:34:56+09:00", "HEAD -> develop, tag: v1.0.0", "履歴タブを追加", ""].join("\0"));
  assert.deepEqual(history, [{
    hash: "abcdef",
    shortHash: "abc1234",
    author: "山田 太郎",
    authoredAt: "2026-08-09T12:34:56+09:00",
    subject: "履歴タブを追加",
    references: ["HEAD -> develop", "tag: v1.0.0"],
  }]);
});

test("parses commit file statuses including renames", () => {
  assert.deepEqual(parseCommitFiles(["M", "src/a.ts", "A", "src/new.ts", "D", "old.txt", "R100", "before.ts", "after.ts", ""].join("\0")), [
    { path: "src/a.ts", kind: "modified", binary: false },
    { path: "src/new.ts", kind: "added", binary: false },
    { path: "old.txt", kind: "deleted", binary: false },
    { path: "after.ts", originalPath: "before.ts", kind: "renamed", binary: false },
  ]);
});

test("commit file reads reject values that are not full commit hashes", async () => {
  const reader = new GitRepositoryReader();
  await assert.rejects(() => reader.readCommitFiles(process.cwd(), "HEAD; rm -rf ."), /コミットIDの形式が不正/);
  await assert.rejects(() => reader.readCommitFileDiff(process.cwd(), "HEAD; rm -rf .", "README.md"), /コミットIDの形式が不正/);
  await assert.rejects(() => reader.readCommitFileDiff(process.cwd(), "a".repeat(40), ""), /ファイルパスが指定されていません/);
});

test("lists selectable branches and detects whether the current branch is merged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-merge-status-"));
  try {
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await execFileAsync("git", ["switch", "-c", "feature/test"], { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: root });
    await execFileAsync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"], { cwd: root });
    await execFileAsync("git", ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], { cwd: root });
    const reader = new GitRepositoryReader();

    assert.deepEqual(await reader.readBranches(root), ["develop", "feature/test", "origin/main"]);
    assert.equal(await reader.readDefaultBranch(root, await reader.readBranches(root)), "develop");
    assert.equal(await reader.readDefaultBranch(root, ["origin/main"]), "origin/main");
    assert.equal(await reader.isMergedInto(root, "feature/test", "develop"), false);
    await execFileAsync("git", ["switch", "develop"], { cwd: root });
    await execFileAsync("git", ["merge", "--ff-only", "feature/test"], { cwd: root });
    assert.equal(await reader.isMergedInto(root, "feature/test", "develop"), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("reads local changes without an origin remote", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-local-only-repository-"));
  try {
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "changed\n");
    const reader = new GitRepositoryReader();

    await assert.rejects(() => execFileAsync("git", ["remote", "get-url", "origin"], { cwd: root }));
    assert.equal(await reader.readBranch(root), "develop");
    assert.deepEqual(await reader.readBranches(root), ["develop"]);
    assert.deepEqual(await reader.readChanges(root), [{ path: "README.md", kind: "modified", binary: false, additions: 1, deletions: 1 }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("renders an untracked file as an inline unified diff", async () => {
  const reader = new GitRepositoryReader();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-inline-diff-"));
  try {
    await fs.writeFile(path.join(root, "new.txt"), "first\nsecond\n");
    const diff = await reader.readDiff(root, { path: "new.txt", kind: "untracked", binary: false });
    assert.match(diff, /--- \/dev\/null/);
    assert.match(diff, /@@ -0,0 \+1,2 @@/);
    assert.match(diff, /\+first\n\+second/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("creates and safely reuses an issue worktree from develop", async () => {
  const groupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-issue-worktree-"));
  const repositoryRoot = path.join(groupRoot, "app");
  try {
    await fs.mkdir(repositoryRoot);
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: repositoryRoot });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: repositoryRoot });
    await fs.writeFile(path.join(repositoryRoot, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repositoryRoot });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryRoot });
    const manager = new IssueWorktreeManager();

    const created = await manager.prepare(groupRoot, repositoryRoot, 34, "Issue起点の開発をworktreeで分離する");
    const reused = await manager.prepare(groupRoot, repositoryRoot, 34, "変更後のIssueタイトル");

    assert.equal(created.rootPath, path.join(groupRoot, ".worktrees", "app-issue-34"));
    assert.equal(created.branch, "issue/34-issue起点の開発をworktreeで分離する");
    assert.equal(created.reused, false);
    assert.deepEqual(reused, { ...created, reused: true });
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], { cwd: created.rootPath, encoding: "utf8" });
    assert.equal(stdout.trim(), created.branch);
  } finally {
    await fs.rm(groupRoot, { recursive: true, force: true });
  }
});

test("does not reuse an unrelated directory as an issue worktree", async () => {
  const groupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-issue-worktree-conflict-"));
  const repositoryRoot = path.join(groupRoot, "app");
  try {
    await fs.mkdir(repositoryRoot);
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: repositoryRoot });
    await fs.mkdir(path.join(groupRoot, ".worktrees", "app-issue-35"), { recursive: true });

    await assert.rejects(
      () => new IssueWorktreeManager().prepare(groupRoot, repositoryRoot, 35, "Conflict"),
      /git|リポジトリ|worktree/i,
    );
  } finally {
    await fs.rm(groupRoot, { recursive: true, force: true });
  }
});

test("merges a clean issue worktree into develop with a merge commit", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-worktree-merge-"));
  const worktree = path.join(root, ".worktrees", "issue-39");
  try {
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", "issue/39-merge-queue", worktree, "develop"], { cwd: root });
    await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: worktree });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: worktree });

    const manager = new WorktreeMergeManager();
    assert.equal(await manager.hasMergeConflict(worktree, "issue/39-merge-queue"), false);
    const result = await manager.merge(worktree, "issue/39-merge-queue");

    assert.equal(path.resolve(result.targetPath), path.resolve(root));
    assert.equal(result.alreadyMerged, false);
    assert.equal((await fs.readFile(path.join(root, "feature.txt"), "utf8")).replace(/\r\n/g, "\n"), "feature\n");
    const { stdout } = await execFileAsync("git", ["rev-list", "--parents", "-n", "1", "HEAD"], { cwd: root, encoding: "utf8" });
    assert.equal(stdout.trim().split(/\s+/).length, 3);
    assert.equal((await new WorktreeMergeManager().merge(worktree, "issue/39-merge-queue")).alreadyMerged, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("detects a merge conflict without changing either worktree", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-worktree-conflict-"));
  const worktree = path.join(root, ".worktrees", "issue-44");
  try {
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: root });
    await fs.writeFile(path.join(root, "shared.txt"), "base\n");
    await execFileAsync("git", ["add", "shared.txt"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", "issue/44-conflict", worktree, "develop"], { cwd: root });
    await fs.writeFile(path.join(worktree, "shared.txt"), "issue\n");
    await execFileAsync("git", ["commit", "-am", "issue change"], { cwd: worktree });
    await fs.writeFile(path.join(root, "shared.txt"), "develop\n");
    await execFileAsync("git", ["commit", "-am", "develop change"], { cwd: root });

    assert.equal(await new WorktreeMergeManager().hasMergeConflict(worktree, "issue/44-conflict"), true);
    const rootStatus = (await execFileAsync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).stdout.split(/\r?\n/).filter((line) => line && !line.endsWith(".worktrees/"));
    assert.deepEqual(rootStatus, []);
    assert.equal((await execFileAsync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" })).stdout, "");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("worktree merge refuses an uncommitted source", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-worktree-merge-dirty-"));
  const worktree = path.join(root, "issue");
  try {
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await execFileAsync("git", ["worktree", "add", "-b", "issue/dirty", worktree, "develop"], { cwd: root });
    await fs.writeFile(path.join(worktree, "dirty.txt"), "dirty\n");
    await assert.rejects(() => new WorktreeMergeManager().merge(worktree, "issue/dirty"), /未コミット差分/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("parses worktree porcelain branches", () => {
  assert.deepEqual(parseWorktreeList("worktree C:/repo\nHEAD abc\nbranch refs/heads/develop\n\nworktree C:/repo/issue\nHEAD def\nbranch refs/heads/issue/39\n"), [
    { path: "C:/repo", branch: "develop" },
    { path: "C:/repo/issue", branch: "issue/39" },
  ]);
});

test("removes only clean worktrees already merged into develop", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-worktree-remove-"));
  const worktree = path.join(root, ".worktrees", "issue-40");
  try {
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "initial\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: root });
    await fs.mkdir(path.dirname(worktree), { recursive: true });
    await execFileAsync("git", ["worktree", "add", "-b", "issue/40-cleanup", worktree, "develop"], { cwd: root });
    await fs.writeFile(path.join(worktree, "feature.txt"), "feature\n");
    await execFileAsync("git", ["add", "feature.txt"], { cwd: worktree });
    await execFileAsync("git", ["commit", "-m", "feature"], { cwd: worktree });
    const manager = new WorktreeMergeManager();

    await assert.rejects(() => manager.remove(worktree, "issue/40-cleanup", root), /マージされていません/);
    await manager.merge(worktree, "issue/40-cleanup");
    await fs.writeFile(path.join(worktree, "dirty.txt"), "dirty\n");
    await assert.rejects(() => manager.remove(worktree, "issue/40-cleanup", root), /未コミット差分/);
    await fs.rm(path.join(worktree, "dirty.txt"));
    await manager.remove(worktree, "issue/40-cleanup", root);
    await assert.rejects(() => fs.access(worktree));
    assert.equal((await execFileAsync("git", ["branch", "--list", "issue/40-cleanup"], { cwd: root, encoding: "utf8" })).stdout.trim(), "issue/40-cleanup");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
