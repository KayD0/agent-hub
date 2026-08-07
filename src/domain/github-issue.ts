export interface GitHubRepositoryRef {
  owner: string;
  name: string;
  slug: string;
  rootPath: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  assignees: string[];
  updatedAt: string;
  repository: GitHubRepositoryRef;
}

export interface GitHubIssueRepositoryResult {
  repositoryName: string;
  issues: GitHubIssue[];
  error?: string;
}

