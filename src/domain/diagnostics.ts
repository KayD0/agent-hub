export type DiagnosticStatus = "ready" | "warning" | "error";

export interface ToolDiagnostic {
  status: DiagnosticStatus;
  label: string;
  detail: string;
  command?: string;
}

export interface EnvironmentDiagnostics {
  generatedAt: string;
  extensionVersion: string;
  vscodeVersion: string;
  platform: string;
  codex: ToolDiagnostic;
  codexAuthentication: ToolDiagnostic;
  github: ToolDiagnostic;
}
