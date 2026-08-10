import assert from "node:assert/strict";
import * as path from "node:path";
import test from "node:test";
import { isWorktreeRepository } from "../src/application/repository-visibility";
import { githubIssueError, parseGitHubRemote, parseIssueList } from "../src/infrastructure/github/github-issue-client";

test("identifies only repositories below the managed worktrees directory", () => {
  const group = path.resolve("work", "group");
  const worktree = path.join(group, ".worktrees", "app-issue-36");
  assert.equal(isWorktreeRepository(group, worktree), true);
  assert.equal(isWorktreeRepository(group, path.join(group, ".worktrees-old", "app")), false);
  assert.equal(isWorktreeRepository(worktree, worktree), false);
  assert.equal(isWorktreeRepository(group, path.join(group, "app")), false);
});

test("parses GitHub HTTPS and SSH remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://github.com/KayD0/agent-hub.git"), { owner: "KayD0", name: "agent-hub", slug: "KayD0/agent-hub" });
  assert.deepEqual(parseGitHubRemote("git@github.com:KayD0/agent-hub.git"), { owner: "KayD0", name: "agent-hub", slug: "KayD0/agent-hub" });
  assert.deepEqual(parseGitHubRemote("ssh://git@github.com/KayD0/agent-hub"), { owner: "KayD0", name: "agent-hub", slug: "KayD0/agent-hub" });
  assert.equal(parseGitHubRemote("https://gitlab.com/team/project.git"), undefined);
});

test("parses gh issue list output without trusting optional fields", () => {
  const repository = { owner: "KayD0", name: "agent-hub", slug: "KayD0/agent-hub", rootPath: "C:\\work" };
  const issues = parseIssueList(JSON.stringify([{ number: 18, title: "Issue integration", body: "Details", url: "https://github.com/KayD0/agent-hub/issues/18", updatedAt: "2026-08-08T00:00:00Z", labels: [{ name: "feature" }], assignees: [{ login: "octocat" }] }]), repository);
  assert.deepEqual(issues[0], { number: 18, title: "Issue integration", body: "Details", url: "https://github.com/KayD0/agent-hub/issues/18", updatedAt: "2026-08-08T00:00:00Z", labels: ["feature"], assignees: ["octocat"], repository });
});

test("rejects malformed gh issue output", () => {
  const repository = { owner: "owner", name: "repo", slug: "owner/repo", rootPath: "C:\\work" };
  assert.throws(() => parseIssueList("{}", repository), /応答形式/);
  assert.throws(() => parseIssueList('[{"number":1}]', repository), /必須項目/);
});

test("distinguishes missing gh and missing authentication", () => {
  assert.match(githubIssueError("spawn gh ENOENT"), /見つかりません/);
  assert.match(githubIssueError("To get started with GitHub CLI, please run: gh auth login"), /認証が必要/);
  assert.match(githubIssueError("network unavailable"), /取得できません/);
});

