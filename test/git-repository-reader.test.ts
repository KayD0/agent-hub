import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { GitRepositoryReader, parseNumstat, parsePorcelainStatus } from "../src/infrastructure/git/git-repository-reader";

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
