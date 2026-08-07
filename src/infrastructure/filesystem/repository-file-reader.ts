import * as fs from "node:fs/promises";
import * as path from "node:path";
import { RepositoryTreeEntry } from "../../domain/repository";

const IGNORED_DIRECTORIES = new Set([".git", ".vscode-test", "node_modules", "dist", "out", "build", "coverage", "artifacts", ".next"]);

export class RepositoryFileReader {
  public async readDirectory(rootPath: string, relativePath = ""): Promise<RepositoryTreeEntry[]> {
    const directory = await resolveInside(rootPath, relativePath);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.isSymbolicLink() && !(entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)))
      .map((entry) => ({
        name: entry.name,
        path: toPortablePath(path.join(relativePath, entry.name)),
        kind: entry.isDirectory() ? "directory" as const : "file" as const,
      }))
      .sort((left, right) => left.kind === right.kind ? left.name.localeCompare(right.name) : left.kind === "directory" ? -1 : 1);
  }

  public async resolveFile(rootPath: string, relativePath: string): Promise<string> {
    const candidate = await resolveInside(rootPath, relativePath);
    if (!(await fs.stat(candidate)).isFile()) throw new Error("ファイルを選択してください。");
    return candidate;
  }
}

async function resolveInside(rootPath: string, relativePath: string): Promise<string> {
  const root = await fs.realpath(rootPath);
  const candidate = await fs.realpath(path.resolve(rootPath, relativePath));
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("登録フォルダ外のファイルは開けません。");
  return candidate;
}

function toPortablePath(value: string): string { return value.replace(/\\/g, "/"); }
