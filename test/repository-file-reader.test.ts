import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RepositoryFileReader } from "../src/infrastructure/filesystem/repository-file-reader";

test("lists directories before files and ignores generated directories", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-files-"));
  try {
    await fs.mkdir(path.join(root, "src"));
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "README.md"), "readme");
    const entries = await new RepositoryFileReader().readDirectory(root);
    assert.deepEqual(entries, [
      { name: "src", path: "src", kind: "directory" },
      { name: "README.md", path: "README.md", kind: "file" },
    ]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects files outside the registered folder", async () => {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-files-"));
  const root = path.join(parent, "root");
  try {
    await fs.mkdir(root);
    await fs.writeFile(path.join(parent, "outside.txt"), "outside");
    await assert.rejects(() => new RepositoryFileReader().resolveFile(root, "../outside.txt"), /登録フォルダ外/);
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
});
