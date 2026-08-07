import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { DiscoveredRepository, RegisteredRepository, RepositoryGroupSnapshot, RepositorySnapshot } from "../domain/repository";
import { GitRepositoryReader } from "../infrastructure/git/git-repository-reader";

const STORAGE_KEY = "agentHub.repositories.v1";
const IGNORED_DIRECTORIES = new Set([".git", ".vscode-test", "node_modules", "dist", "out", "build", "coverage", "artifacts", ".next"]);

export class RepositoryManager implements vscode.Disposable {
  private repositories: RegisteredRepository[];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly gitWatchers = new Map<string, vscode.FileSystemWatcher>();
  private refreshTimer?: NodeJS.Timeout;
  public readonly onDidChange = this.changeEmitter.event;

  public constructor(private readonly state: vscode.Memento, private readonly reader: GitRepositoryReader) {
    const stored = state.get<unknown>(STORAGE_KEY, []);
    this.repositories = Array.isArray(stored) ? stored.filter(isRegisteredRepository) : [];
  }

  public list(): readonly RegisteredRepository[] { return this.repositories; }
  public get(id: string): RegisteredRepository | undefined { return this.repositories.find((repository) => repository.id === id); }

  public async register(candidatePath: string): Promise<RegisteredRepository> {
    const rootPath = path.resolve(candidatePath);
    if (!(await fs.stat(rootPath)).isDirectory()) throw new Error("フォルダを選択してください。");
    const existing = this.repositories.find((repository) => samePath(repository.rootPath, rootPath));
    if (existing) return existing;
    const repository = { id: Buffer.from(rootPath.toLocaleLowerCase()).toString("base64url"), name: path.basename(rootPath), rootPath, registeredAt: Date.now() };
    this.repositories = [...this.repositories, repository];
    await this.persist();
    return repository;
  }

  public async remove(id: string): Promise<void> {
    this.repositories = this.repositories.filter((repository) => repository.id !== id);
    this.disposeGroupWatchers(id);
    await this.persist();
  }

  public dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const watcher of this.gitWatchers.values()) watcher.dispose();
    this.gitWatchers.clear();
    this.changeEmitter.dispose();
  }

  public async snapshot(repository: DiscoveredRepository): Promise<RepositorySnapshot> {
    const openInWorkspace = (vscode.workspace.workspaceFolders ?? []).some((folder) => isInside(repository.rootPath, folder.uri.fsPath));
    try {
      const [branch, files] = await Promise.all([this.reader.readBranch(repository.rootPath), this.reader.readChanges(repository.rootPath)]);
      return { ...repository, openInWorkspace, branch, files, additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0), deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0) };
    } catch (error) {
      return { ...repository, openInWorkspace, files: [], additions: 0, deletions: 0, error: errorMessage(error) };
    }
  }

  public async groupSnapshot(group: RegisteredRepository): Promise<RepositoryGroupSnapshot> {
    try {
      const repositories = await discoverGitRoots(group.rootPath);
      await this.ensureGitWatchers(group.id, repositories);
      const snapshots = await Promise.all(repositories.map((rootPath) => this.snapshot({
        id: `${group.id}:${Buffer.from(rootPath.toLocaleLowerCase()).toString("base64url")}`,
        name: path.basename(rootPath), rootPath, relativePath: path.relative(group.rootPath, rootPath) || ".",
      })));
      return { ...group, repositories: snapshots, files: snapshots.reduce((sum, item) => sum + item.files.length, 0), additions: snapshots.reduce((sum, item) => sum + item.additions, 0), deletions: snapshots.reduce((sum, item) => sum + item.deletions, 0) };
    } catch (error) {
      return { ...group, repositories: [], files: 0, additions: 0, deletions: 0, error: errorMessage(error) };
    }
  }

  public async groupSnapshots(): Promise<RepositoryGroupSnapshot[]> { return Promise.all(this.repositories.map((group) => this.groupSnapshot(group))); }
  private async persist(): Promise<void> { await this.state.update(STORAGE_KEY, this.repositories); }

  private async ensureGitWatchers(groupId: string, repositoryRoots: string[]): Promise<void> {
    const desired = new Set<string>();
    await Promise.all(repositoryRoots.map(async (rootPath) => {
      const gitDirectory = await this.reader.resolveGitDirectory(rootPath);
      const key = `${groupId}:${gitDirectory.toLocaleLowerCase()}`;
      desired.add(key);
      if (this.gitWatchers.has(key)) return;
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(gitDirectory, "{HEAD,packed-refs,refs/**}"));
      const notify = (): void => this.scheduleChange();
      watcher.onDidCreate(notify);
      watcher.onDidChange(notify);
      watcher.onDidDelete(notify);
      this.gitWatchers.set(key, watcher);
    }));
    for (const [key, watcher] of this.gitWatchers) {
      if (key.startsWith(`${groupId}:`) && !desired.has(key)) { watcher.dispose(); this.gitWatchers.delete(key); }
    }
  }

  private disposeGroupWatchers(groupId: string): void {
    for (const [key, watcher] of this.gitWatchers) {
      if (key.startsWith(`${groupId}:`)) { watcher.dispose(); this.gitWatchers.delete(key); }
    }
  }

  private scheduleChange(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => { this.refreshTimer = undefined; this.changeEmitter.fire(); }, 350);
  }
}

async function discoverGitRoots(rootPath: string): Promise<string[]> {
  const roots: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (await exists(path.join(directory, ".git"))) { roots.push(directory); return; }
    if (depth >= 6) return;
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRECTORIES.has(entry.name)).map((entry) => visit(path.join(directory, entry.name), depth + 1)));
  };
  await visit(rootPath, 0);
  return roots.sort((left, right) => left.localeCompare(right));
}

async function exists(candidatePath: string): Promise<boolean> { try { await fs.access(candidatePath); return true; } catch { return false; } }
function isRegisteredRepository(value: unknown): value is RegisteredRepository { if (!value || typeof value !== "object" || Array.isArray(value)) return false; const candidate = value as Partial<RegisteredRepository>; return typeof candidate.id === "string" && typeof candidate.name === "string" && typeof candidate.rootPath === "string" && typeof candidate.registeredAt === "number"; }
function samePath(left: string, right: string): boolean { return path.resolve(left).toLocaleLowerCase() === path.resolve(right).toLocaleLowerCase(); }
function isInside(candidate: string, root: string): boolean { const relative = path.relative(path.resolve(root), path.resolve(candidate)); return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
