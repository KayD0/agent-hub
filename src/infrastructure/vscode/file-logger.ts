import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export class FileLogger implements vscode.Disposable {
  private writeQueue: Promise<void> = Promise.resolve();

  public readonly filePath: string;

  public constructor(
    extensionUri: vscode.Uri,
    private readonly output: vscode.OutputChannel,
  ) {
    this.filePath = path.join(extensionUri.fsPath, "logs", "agenthub.log");
  }

  public async initialize(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await this.log("INFO", "AgentHub logger initialized", { filePath: this.filePath });
  }

  public log(level: "INFO" | "WARN" | "ERROR", message: string, details?: unknown): Promise<void> {
    const suffix = details === undefined ? "" : ` ${formatDetails(details)}`;
    const line = `${new Date().toISOString()} [${level}] ${message}${suffix}`;
    this.output.appendLine(line);
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
