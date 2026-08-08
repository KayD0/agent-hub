import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AuthenticationState } from "../../domain/authentication";
import { EnvironmentDiagnostics, ToolDiagnostic } from "../../domain/diagnostics";
import { resolveCodexCommand } from "../codex/app-server-client";

const execFileAsync = promisify(execFile);

export async function collectEnvironmentDiagnostics(options: {
  configuredCodexPath?: string;
  authentication: AuthenticationState;
  extensionVersion: string;
  vscodeVersion: string;
}): Promise<EnvironmentDiagnostics> {
  return {
    generatedAt: new Date().toISOString(), extensionVersion: options.extensionVersion,
    vscodeVersion: options.vscodeVersion, platform: `${process.platform} ${process.arch}`,
    codex: await diagnoseCodex(options.configuredCodexPath),
    codexAuthentication: diagnoseAuthentication(options.authentication), github: await diagnoseGitHub(),
  };
}

async function diagnoseCodex(configuredPath?: string): Promise<ToolDiagnostic> {
  try {
    const command = resolveCodexCommand(configuredPath);
    const { stdout, stderr } = await execFileAsync(command.file, [...command.args, "--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    return { status: "ready", label: "Codex CLI", detail: (stdout || stderr).trim() || "検出済み", command: command.file };
  } catch (error) { return { status: "error", label: "Codex CLI", detail: message(error) }; }
}

function diagnoseAuthentication(state: AuthenticationState): ToolDiagnostic {
  if (state.status === "authenticated") return { status: "ready", label: "Codex認証", detail: state.email ? `${state.email} · ${state.planType ?? "ログイン済み"}` : "ログイン済み" };
  if (state.status === "logging_in") return { status: "warning", label: "Codex認証", detail: "ログイン処理中" };
  if (state.status === "error") return { status: "error", label: "Codex認証", detail: state.error ?? "認証状態を取得できません" };
  return { status: "warning", label: "Codex認証", detail: "未ログイン" };
}

async function diagnoseGitHub(): Promise<ToolDiagnostic> {
  try {
    const version = await execFileAsync("gh", ["--version"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
    try {
      await execFileAsync("gh", ["auth", "status", "--hostname", "github.com"], { encoding: "utf8", windowsHide: true, timeout: 10_000 });
      return { status: "ready", label: "GitHub CLI（任意）", detail: version.stdout.split(/\r?\n/, 1)[0] || "認証済み", command: "gh" };
    } catch (error) { return { status: "warning", label: "GitHub CLI（任意）", detail: `未認証: ${message(error)}`, command: "gh" }; }
  } catch (error) { return { status: "warning", label: "GitHub CLI（任意）", detail: `未検出: ${message(error)}` }; }
}

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, " ").trim().slice(0, 500);
}
