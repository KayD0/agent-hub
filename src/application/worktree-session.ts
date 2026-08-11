export interface WorktreeCommitTarget { rootPath: string; branch: string }

export function worktreeCommitInstruction(targets: readonly WorktreeCommitTarget[]): string {
  const list = targets.map((target, index) => `${index + 1}. ${target.branch}\n   ${target.rootPath}`).join("\n");
  return `次のworktreeの未コミット差分を表示順に処理してください。\n\n${list}\n\n各worktreeの未コミット差分を確認し、不要なファイルを含めず、変更内容に必要なテストまたは検証を行い、適切な日本語のコミットメッセージで個別にコミットしてください。一つでも判断不能または失敗した場合は、以降を推測で進めず状況を報告してください。push、マージ、worktree削除は行わないでください。`;
}

export function conflictResolutionInstruction(target: WorktreeCommitTarget, targetBranch = "develop"): string {
  return `worktree（${target.rootPath}、ブランチ: ${target.branch}）を${targetBranch}へマージする際に競合が検出されました。${targetBranch}をこのIssue worktreeへ取り込み、競合している双方の変更意図を確認して適切に解決してください。解決後に必要なテストまたは検証を行い、競合解消を日本語のコミットメッセージでコミットしてください。判断できない競合は推測で解決せず、作業を止めて状況を報告してください。push、${targetBranch}へのマージ、worktree削除は行わないでください。`;
}
