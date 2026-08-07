import * as path from "node:path";

export type ApprovalOperation = "command" | "file_change";

export interface AutoApprovalPolicy {
  allowedCommands: readonly string[];
  allowedPaths: readonly string[];
}

export interface ApprovalCandidate {
  operation: ApprovalOperation;
  sessionRoot: string;
  command?: string;
  targetPath?: string;
}

export interface ApprovalPolicyResult {
  autoApprove: boolean;
  reason: string;
  matchedRule?: string;
}

const ALWAYS_CONFIRM_COMMANDS: readonly RegExp[] = [
  /(^|\s)(rm\s+-[^\s]*r|remove-item\b[^\r\n]*(?:-recurse|-force)|del\s+\/s)(\s|$)/i,
  /(^|\s)(curl|wget|invoke-webrequest|invoke-restmethod)(\s|$)/i,
];

export const EMPTY_AUTO_APPROVAL_POLICY: AutoApprovalPolicy = {
  allowedCommands: [],
  allowedPaths: [],
};

export function evaluateAutoApproval(
  policy: AutoApprovalPolicy,
  candidate: ApprovalCandidate,
): ApprovalPolicyResult {
  if (candidate.operation === "command") return evaluateCommand(policy, candidate.command);
  return evaluateFileChange(policy, candidate.sessionRoot, candidate.targetPath);
}

function evaluateCommand(policy: AutoApprovalPolicy, command: string | undefined): ApprovalPolicyResult {
  const normalized = command?.trim();
  if (!normalized) return { autoApprove: false, reason: "コマンド内容を確認できないため手動確認が必要です" };
  const wrapped = unwrapPowerShellGitCommand(normalized);
  if (wrapped.recognized && !wrapped.command) {
    return { autoApprove: false, reason: "PowerShell内の単一Gitコマンドを安全に確認できないため手動確認が必要です" };
  }
  const commandsToInspect = wrapped.command ? [normalized, wrapped.command] : [normalized];
  if (commandsToInspect.some((value) => ALWAYS_CONFIRM_COMMANDS.some((pattern) => pattern.test(value)))) {
    return { autoApprove: false, reason: "削除または外部通信を含むため手動確認が必要です" };
  }
  const effectiveCommand = wrapped.command ?? normalized;
  const matched = policy.allowedCommands.find((rule) => rule.trim() === effectiveCommand);
  return matched
    ? { autoApprove: true, reason: wrapped.command ? "PowerShell内のGitコマンドが登録済みコマンドと完全一致しました" : "登録済みコマンドと完全一致しました", matchedRule: `command:${matched}` }
    : { autoApprove: false, reason: "登録済みコマンドと一致しません" };
}

function unwrapPowerShellGitCommand(value: string): { recognized: boolean; command?: string } {
  const executableMatch = value.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/);
  if (!executableMatch) return { recognized: false };
  const executable = (executableMatch[1] ?? executableMatch[2] ?? executableMatch[3]).replace(/\\/g, "/").split("/").pop()?.toLocaleLowerCase();
  if (!executable || !["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) return { recognized: false };
  const commandMatch = executableMatch[4].match(/^([\s\S]*?)(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i);
  if (!commandMatch || !safePowerShellOptions(commandMatch[1])) return { recognized: true };
  let inner = commandMatch[2].trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) inner = inner.slice(1, -1).trim();
  if (!/^git(?:\.exe)?(?:\s|$)/i.test(inner)) return { recognized: true };
  if (/[;|&<>`\r\n]/.test(inner) || /\$\(|\$\{|\$[A-Za-z_]/.test(inner)) return { recognized: true };
  return { recognized: true, command: inner };
}

function safePowerShellOptions(value: string): boolean {
  const options = value.trim();
  if (!options) return true;
  return /^(?:(?:-(?:NoProfile|NonInteractive|NoLogo|NoExit))\s*|(?:-ExecutionPolicy\s+(?:Restricted|AllSigned|RemoteSigned|Unrestricted|Bypass|Undefined))\s*)+$/i.test(options);
}

function evaluateFileChange(
  policy: AutoApprovalPolicy,
  sessionRoot: string,
  targetPath: string | undefined,
): ApprovalPolicyResult {
  if (!targetPath) return { autoApprove: false, reason: "変更対象パスを確認できないため手動確認が必要です" };
  const resolvedTarget = path.resolve(targetPath);
  if (!isInside(resolvedTarget, sessionRoot)) {
    return { autoApprove: false, reason: "セッションの作業フォルダ外なので手動確認が必要です" };
  }
  const matched = policy.allowedPaths.find((rule) => {
    const expanded = rule === "${sessionRoot}" ? sessionRoot : rule;
    return expanded.trim().length > 0 && isInside(resolvedTarget, expanded);
  });
  return matched
    ? { autoApprove: true, reason: "許可されたパス配下のファイル変更です", matchedRule: `path:${matched}` }
    : { autoApprove: false, reason: "許可されたパスに一致しません" };
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
