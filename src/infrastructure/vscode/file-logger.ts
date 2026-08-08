import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export class FileLogger implements vscode.Disposable {
  private writeQueue: Promise<void> = Promise.resolve();
  private fileEnabled = true;

  public readonly filePath: string;

  public constructor(
    logUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {
    this.filePath = path.join(logUri.fsPath, "agenthub.log");
  }

  public async initialize(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    } catch (error) {
      this.fileEnabled = false;
      this.output.appendLine(`${new Date().toISOString()} [WARN] File logging is unavailable: ${errorMessage(error)}`);
    }
    await this.log("INFO", "AgentHub logger initialized", { destination: this.fileEnabled ? "VS Code log directory" : "Output channel only" });
  }

  public log(level: "INFO" | "WARN" | "ERROR", message: string, details?: unknown): Promise<void> {
    const suffix = details === undefined ? "" : ` ${formatDetails(redactSensitive(details))}`;
    const line = redactText(`${new Date().toISOString()} [${level}] ${message}${suffix}`);
    this.output.appendLine(line);
    if (!this.fileEnabled) return Promise.resolve();
    this.writeQueue = this.writeQueue
      .catch(() => undefined)
      .then(() => fs.appendFile(this.filePath, `${line}\n`, "utf8"))
      .catch((error: unknown) => {
        this.output.appendLine(`${new Date().toISOString()} [ERROR] Failed to write AgentHub log: ${errorMessage(error)}`);
      });
    return this.writeQueue;
  }

  public info(message: string, details?: unknown): Promise<void> {
    return this.log("INFO", message, details);
  }

  public error(message: string, error: unknown): Promise<void> {
    return this.log("ERROR", message, serializeError(error));
  }

  public dispose(): void {
    void this.writeQueue;
  }

  public async readRecent(maxBytes = 64 * 1024): Promise<string> {
    await this.writeQueue;
    if (!this.fileEnabled) return "ファイルログは利用できません。AgentHub出力チャンネルを確認してください。";
    try {
      const value = await fs.readFile(this.filePath, "utf8");
      return redactText(value.slice(-maxBytes));
    } catch (error) {
      return `ログを読み込めません: ${errorMessage(error)}`;
    }
  }
}

const SENSITIVE_KEY = /(token|secret|password|authorization|cookie|user.?code|prompt|input|environment|env|cwd|path|root|worktree)/i;

export function redactSensitive(value: unknown, key = ""): unknown {
  if (SENSITIVE_KEY.test(key)) return "<redacted>";
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, redactSensitive(child, childKey)]));
  }
  return value;
}

export function redactText(value: string): string {
  return value
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]{8,})\b/g, "<redacted-token>")
    .replace(/\b(authorization|token|password|secret|user[_ -]?code)\s*[:=]\s*[^\s,}]+/gi, "$1=<redacted>")
    .replace(/[A-Za-z]:\\(?:Users|Documents and Settings)\\[^\\\s]+/gi, "<user-home>")
    .replace(/\/(?:Users|home)\/[^/\s]+/g, "<user-home>");
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

function formatDetails(details: unknown): string {
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
