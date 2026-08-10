import * as path from "node:path";

export function isWorktreeRepository(groupRootPath: string, repositoryRootPath: string): boolean {
  const relative = path.relative(path.resolve(groupRootPath), path.resolve(repositoryRootPath));
  if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) return false;
  return relative.split(path.sep).includes(".worktrees");
}
