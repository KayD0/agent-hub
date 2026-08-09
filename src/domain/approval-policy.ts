import * as path from "node:path";

export type ApprovalOperation = "command" | "file_change";

export interface AutoApprovalPolicy {
  allowedCommands: readonly string[];
  allowedCommandPrefixes?: readonly string[];
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
  matchedCommand?: string;
}

const ALWAYS_CONFIRM_COMMANDS: readonly RegExp[] = [
  /(^|\s)(rm\s+-[^\s]*r|remove-item\b[^\r\n]*(?:-recurse|-force)|del\s+\/s)(\s|$)/i,
  /(^|\s)(curl|wget|invoke-webrequest|invoke-restmethod)(\s|$)/i,
  /(^|\s)git(?:\.exe)?\s+(?:reset\s+--hard|clean\b|branch\s+-D\b|push\b[^\r\n]*(?:--force|-f\b|--delete|\+[^\s]+))/i,
  /(^|\s)gh(?:\.exe)?\s+repo\s+delete\b/i,
];

export const EMPTY_AUTO_APPROVAL_POLICY: AutoApprovalPolicy = {
  allowedCommands: [],
  allowedCommandPrefixes: [],
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
  if (ALWAYS_CONFIRM_COMMANDS.some((pattern) => pattern.test(normalized))) {
    return { autoApprove: false, reason: "削除または外部通信を含むため手動確認が必要です" };
  }
  const wrapped = unwrapPowerShellCommands(normalized);
  if (wrapped.recognized && !wrapped.commands) {
    return { autoApprove: false, reason: "PowerShell内のコマンド列を安全に確認できないため手動確認が必要です" };
  }
  if (wrapped.commands?.some((candidate) => ALWAYS_CONFIRM_COMMANDS.some((pattern) => pattern.test(candidate)))) {
    return { autoApprove: false, reason: "削除または外部通信を含むため手動確認が必要です" };
  }
  const effectiveCommands = wrapped.commands ?? [normalized];
  const matches = effectiveCommands.map((candidate) => matchCommand(policy, candidate));
  if (matches.some((match) => !match)) {
    return { autoApprove: false, reason: "Codex rulesの許可条件と一致しません。承認が必要です" };
  }
  const matchedRules = matches.map((match) => match!);
  return {
    autoApprove: true,
    reason: wrapped.commands
      ? effectiveCommands.length === 1
        ? `PowerShell内のコマンド「${effectiveCommands[0]}」がAuto承認ルールに一致しました`
        : `PowerShell内の${effectiveCommands.length}件のコマンドがすべてAuto承認ルールに一致しました`
      : matchedRules[0].startsWith("command:") ? "登録済みコマンドと完全一致しました" : "登録済みコマンド接頭辞に一致しました",
    matchedRule: matchedRules.length === 1 ? matchedRules[0] : `compound:${matchedRules.join(",")}`,
    matchedCommand: wrapped.commands?.join("; "),
  };
}

function matchCommand(policy: AutoApprovalPolicy, command: string): string | undefined {
  const matched = policy.allowedCommands.find((rule) => rule.trim() === command);
  if (matched) return `command:${matched}`;
  const matchedPrefix = policy.allowedCommandPrefixes?.find((rule) => commandHasPrefix(command, rule));
  return matchedPrefix ? `prefix:${matchedPrefix}` : undefined;
}

function unwrapPowerShellCommands(value: string): { recognized: boolean; commands?: string[] } {
  const executableMatch = value.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/);
  if (!executableMatch) return { recognized: false };
  const executable = (executableMatch[1] ?? executableMatch[2] ?? executableMatch[3]).replace(/\\/g, "/").split("/").pop()?.toLocaleLowerCase();
  if (!executable || !["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)) return { recognized: false };
  const commandMatch = executableMatch[4].match(/^([\s\S]*?)(?:^|\s)-(?:command|c)\s+([\s\S]+)$/i);
  if (!commandMatch || !safePowerShellOptions(commandMatch[1])) return { recognized: true };
  let inner = commandMatch[2].trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) inner = inner.slice(1, -1).trim();
  if (/[|&<>`$\r\n]/.test(inner)) return { recognized: true };
  const commands = splitSimplePowerShellCommands(inner);
  if (!commands || commands.some((candidate) => !/^(?:git|gh)(?:\.exe)?(?:\s|$)/i.test(candidate))) return { recognized: true };
  return { recognized: true, commands };
}

function splitSimplePowerShellCommands(value: string): string[] | undefined {
  const commands: string[] = [];
  let start = 0;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote) {
      if (character === quote) {
        if (value[index + 1] === quote) index += 1;
        else quote = undefined;
      }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (character !== ";") continue;
    const command = value.slice(start, index).trim();
    if (!command) return undefined;
    commands.push(command);
    start = index + 1;
  }
  if (quote) return undefined;
  const finalCommand = value.slice(start).trim();
  if (!finalCommand) return undefined;
  commands.push(finalCommand);
  return commands;
}

function commandHasPrefix(command: string, rule: string): boolean {
  const prefix = rule.trim();
  if (!prefix) return false;
  const normalizedCommand = command.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  const normalizedPrefix = prefix.replace(/\s+/g, " ").trim().toLocaleLowerCase();
  return normalizedCommand === normalizedPrefix || normalizedCommand.startsWith(`${normalizedPrefix} `);
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
    : { autoApprove: false, reason: "CodexのSandbox境界を越えるため承認が必要です" };
}

function isInside(candidate: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
