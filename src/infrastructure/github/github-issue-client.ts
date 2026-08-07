import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubIssue, GitHubRepositoryRef } from "../../domain/github-issue";

const execFileAsync = promisify(execFile);

export class GitHubIssueClient {
  public async assertReady(): Promise<void> {
    try {
      await execFileAsync("gh", ["auth", "status", "--hostname", "github.com"], { encoding: "utf8", windowsHide: true });
    } catch (error) {
      throw new Error(githubIssueError(errorMessage(error)));
    }
  }

  public async repository(rootPath: string): Promise<GitHubRepositoryRef> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], { cwd: rootPath, encoding: "utf8", windowsHide: true }));
    } catch {
      throw new Error("originリモートが設定されていません。");
    }
    const parsed = parseGitHubRemote(stdout.trim());
    if (!parsed) throw new Error("originはGitHub.comのリポジトリではありません。");
    return { ...parsed, rootPath };
  }

  public async listOpenIssues(repository: GitHubRepositoryRef): Promise<GitHubIssue[]> {
    try {
      const { stdout } = await execFileAsync("gh", ["issue", "list", "--repo", repository.slug, "--state", "open", "--limit", "100", "--json", "number,title,body,url,labels,assignees,updatedAt"], { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      return parseIssueList(stdout, repository);
    } catch (error) {
      const message = errorMessage(error);
      throw new Error(githubIssueError(message));
    }
  }
}

export function parseGitHubRemote(value: string): Pick<GitHubRepositoryRef, "owner" | "name" | "slug"> | undefined {
  const match = value.trim().match(/^(?:https?:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (!match) return undefined;
  const owner = match[1];
  const name = match[2];
  return { owner, name, slug: `${owner}/${name}` };
}

export function parseIssueList(value: string, repository: GitHubRepositoryRef): GitHubIssue[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new Error("gh issue listの応答形式が不正です。");
  return parsed.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("Issueの応答形式が不正です。");
    const issue = item as Record<string, unknown>;
    if (typeof issue.number !== "number" || typeof issue.title !== "string" || typeof issue.url !== "string" || typeof issue.updatedAt !== "string") throw new Error("Issueの必須項目が不足しています。");
    return {
      number: issue.number,
      title: issue.title,
      body: typeof issue.body === "string" ? issue.body : "",
      url: issue.url,
      updatedAt: issue.updatedAt,
      labels: names(issue.labels),
      assignees: logins(issue.assignees),
      repository,
    };
  });
}

export function githubIssueError(message: string): string {
  if (/not recognized|not found|ENOENT/i.test(message)) return "GitHub CLI（gh）が見つかりません。ghをインストールしてください。";
  if (/auth|login|authentication|HTTP 401/i.test(message)) return "GitHub CLIの認証が必要です。gh auth loginを実行してください。";
  return `Issueを取得できません: ${message}`;
}

function names(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => item && typeof item === "object" && typeof (item as { name?: unknown }).name === "string" ? [(item as { name: string }).name] : []) : []; }
function logins(value: unknown): string[] { return Array.isArray(value) ? value.flatMap((item) => item && typeof item === "object" && typeof (item as { login?: unknown }).login === "string" ? [(item as { login: string }).login] : []) : []; }
function errorMessage(error: unknown): string { if (error instanceof Error) return `${error.message}${"stderr" in error && typeof error.stderr === "string" ? ` ${error.stderr}` : ""}`.trim(); return String(error); }
