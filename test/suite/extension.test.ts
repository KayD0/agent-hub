import assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension("local.agenthub-codex");
  assert.ok(extension, "AgentHub extension is installed in the Extension Host");

  const fixture = path.resolve(extension.extensionPath, "test/fixtures/fake-codex.js");
  const configuration = vscode.workspace.getConfiguration("agentHub");
  await configuration.update("codexPath", process.execPath, vscode.ConfigurationTarget.Global);
  await configuration.update("codexArgs", [fixture], vscode.ConfigurationTarget.Global);

  await extension.activate();
  assert.equal(extension.isActive, true);

  const commands = await vscode.commands.getCommands(true);
  for (const command of ["agentHub.startSession", "agentHub.refresh", "agentHub.openSession"]) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }
  await vscode.commands.executeCommand("agentHub.refresh");
}
