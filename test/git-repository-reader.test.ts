import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GitRepositoryReader, parseCommitFiles, parseGitHistory, parseNumstat, parsePorcelainStatus } from "../src/infrastructure/git/git-repository-reader";

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
