import * as path from "node:path";

export function deepestContainingRoot(candidatePath: string, roots: readonly string[]): string | undefined {
  return roots.filter((rootPath) => isInside(candidatePath, rootPath)).sort((left, right) => path.resolve(right).length - path.resolve(left).length)[0];
}

export function managedWorktreeRoot(candidatePath: string, groupRootPath?: string): string | undefined {
  if (!groupRootPath || !isInside(candidatePath, groupRootPath)) return undefined;
  const relative = path.relative(groupRootPath, candidatePath);
  const segments = relative.split(path.sep);
  const marker = segments.indexOf(".worktrees");
  if (marker < 0 || !segments[marker + 1]) return undefined;
  return path.join(groupRootPath, ...segments.slice(0, marker + 2));
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
