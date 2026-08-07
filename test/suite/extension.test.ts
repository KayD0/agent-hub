import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

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
  for (const command of ["agentHub.startSession", "agentHub.refresh", "agentHub.openSession", "agentHub.addRepository", "agentHub.openRepositoryChanges"]) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }
  await vscode.commands.executeCommand("agentHub.refresh");

  const repositoryGroupPath = await fs.mkdtemp(path.join(os.tmpdir(), "agenthub-repository-group-smoke-"));
  try {
    const repositoryPath = path.join(repositoryGroupPath, "app");
    const secondRepositoryPath = path.join(repositoryGroupPath, "design");
    await fs.mkdir(repositoryPath);
    await fs.mkdir(secondRepositoryPath);
    await execFileAsync("git", ["init", "-b", "develop"], { cwd: repositoryPath });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: repositoryPath });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: repositoryPath });
    await fs.writeFile(path.join(repositoryPath, "README.md"), "# Before\n");
    await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: repositoryPath });
    await fs.writeFile(path.join(repositoryPath, "README.md"), "# After\n\nChanged outside the open workspace.\n");

    await execFileAsync("git", ["init", "-b", "main"], { cwd: secondRepositoryPath });
    await execFileAsync("git", ["config", "user.email", "agenthub@example.test"], { cwd: secondRepositoryPath });
    await execFileAsync("git", ["config", "user.name", "AgentHub Test"], { cwd: secondRepositoryPath });
    await fs.writeFile(path.join(secondRepositoryPath, "concept.md"), "# Concept\n");
    await execFileAsync("git", ["add", "concept.md"], { cwd: secondRepositoryPath });
    await execFileAsync("git", ["commit", "-m", "initial"], { cwd: secondRepositoryPath });
    await fs.writeFile(path.join(secondRepositoryPath, "notes.md"), "untracked design notes\n");

    const repositoryGroupId = await vscode.commands.executeCommand<string>("agentHub.addRepository", vscode.Uri.file(repositoryGroupPath));
    assert.ok(repositoryGroupId, "repository group registration returns an id");
    await vscode.commands.executeCommand("agentHub.openRepositoryChanges", repositoryGroupId);
    await vscode.commands.executeCommand("agentHub.removeRepository", repositoryGroupId);
  } finally {
    await fs.rm(repositoryGroupPath, { recursive: true, force: true });
  }
}
