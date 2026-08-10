export type RepositoryChangeKind = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface RegisteredRepository {
  id: string;
  name: string;
  rootPath: string;
  registeredAt: number;
}

export interface DiscoveredRepository {
  id: string;
  name: string;
  rootPath: string;
  relativePath: string;
}

export interface RepositoryFileChange {
  path: string;
  originalPath?: string;
  kind: RepositoryChangeKind;
  additions?: number;
  deletions?: number;
  binary: boolean;
}

export interface RepositorySnapshot extends DiscoveredRepository {
  openInWorkspace: boolean;
  branch?: string;
  baseBranch?: string;
  baseBranchCandidates: string[];
  mergeStatus: "base" | "merged" | "unmerged" | "unknown";
  files: RepositoryFileChange[];
  additions: number;
  deletions: number;
  error?: string;
}

export interface RepositoryGroupSnapshot extends RegisteredRepository {
  repositories: RepositorySnapshot[];
  files: number;
  additions: number;
  deletions: number;
  error?: string;
}

export interface RepositoryTreeEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

export interface RepositoryCommit {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  authoredAt: string;
  references: string[];
}
