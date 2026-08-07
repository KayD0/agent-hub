import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import { RepositoryFileChange } from "../../domain/repository";

const execFileAsync = promisify(execFile);

export class GitRepositoryReader {
  public async resolveRoot(candidatePath: string): Promise<string> {
    const output = await this.git(candidatePath, ["rev-parse", "--show-toplevel"]);
    return path.resolve(output.trim());
  }

  public async readBranch(rootPath: string): Promise<string | undefined> {
    const output = await this.git(rootPath, ["branch", "--show-current"]);
    return output.trim() || undefined;
  }

  public async readChanges(rootPath: string): Promise<RepositoryFileChange[]> {
    const [statusOutput, numstatOutput] = await Promise.all([
      this.git(rootPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
      this.git(rootPath, ["diff", "--numstat", "HEAD", "--"]),
    ]);
    const changes = applyNumstat(parsePorcelainStatus(statusOutput), parseNumstat(numstatOutput));
    return Promise.all(changes.map(async (change) => {
      if (change.kind !== "untracked") return change;
      const content = await fs.readFile(assertInside(rootPath, change.path));
      const binary = content.includes(0);
      return { ...change, binary, additions: binary ? undefined : countLines(content.toString("utf8")), deletions: binary ? undefined : 0 };
    }));
  }

  public async readHeadFile(rootPath: string, relativePath: string): Promise<string> {
    assertInside(rootPath, relativePath);
    return this.git(rootPath, ["show", `HEAD:${toGitPath(relativePath)}`]);
  }

  public async readWorkingFile(rootPath: string, relativePath: string): Promise<string> {
    const absolutePath = assertInside(rootPath, relativePath);
    return fs.readFile(absolutePath, "utf8");
  }

  public async readDiff(rootPath: string, change: RepositoryFileChange): Promise<string> {
    assertInside(rootPath, change.path);
    if (change.binary) return "バイナリファイルの差分は表示できません。";
    if (change.kind === "untracked") {
      const content = await this.readWorkingFile(rootPath, change.path);
      const lines = content.split(/\r?\n/);
      if (lines.at(-1) === "") lines.pop();
      return [
        `diff --git a/${toGitPath(change.path)} b/${toGitPath(change.path)}`,
        "new file mode 100644",
        "--- /dev/null",
        `+++ b/${toGitPath(change.path)}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join("\n");
    }
    return this.git(rootPath, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--", change.originalPath ?? change.path, change.path]);
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      timeout: 20_000,
      windowsHide: true,
    });
    return result.stdout;
  }
}

export function parsePorcelainStatus(output: string): RepositoryFileChange[] {
  const records = output.split("\0");
  const changes: RepositoryFileChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;
    const code = record.slice(0, 2);
    const filePath = record.slice(3);
    if (code.includes("R") || code.includes("C")) {
      const originalPath = records[++index];
      changes.push({ path: filePath, originalPath, kind: "renamed", binary: false });
      continue;
    }
    const kind = code === "??" ? "untracked" : code.includes("D") ? "deleted" : code.includes("A") ? "added" : "modified";
    changes.push({ path: filePath, kind, binary: false });
  }
  return changes;
}

export function parseNumstat(output: string): Map<string, { additions?: number; deletions?: number; binary: boolean }> {
  const result = new Map<string, { additions?: number; deletions?: number; binary: boolean }>();
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const filePath = pathParts.join("\t");
    if (!filePath) continue;
    const binary = added === "-" || deleted === "-";
    result.set(filePath, {
      additions: binary ? undefined : Number(added),
      deletions: binary ? undefined : Number(deleted),
      binary,
    });
  }
  return result;
}

function applyNumstat(changes: RepositoryFileChange[], stats: Map<string, { additions?: number; deletions?: number; binary: boolean }>): RepositoryFileChange[] {
  return changes.map((change) => ({ ...change, ...(stats.get(change.path) ?? {}) }));
}

function assertInside(rootPath: string, relativePath: string): string {
  const root = path.resolve(rootPath);
  const candidate = path.resolve(root, relativePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("リポジトリ外のファイルは開けません。");
  return candidate;
}

function toGitPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function countLines(value: string): number {
  if (!value) return 0;
  return value.split(/\r?\n/).length - (value.endsWith("\n") ? 1 : 0);
}
