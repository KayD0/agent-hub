const fs = require("node:fs");
const path = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  for (const key of Object.keys(process.env)) {
    if (key.toUpperCase() === "ELECTRON_RUN_AS_NODE") delete process.env[key];
  }
  const root = path.resolve(__dirname, "..");
  const runId = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "-");
  const issue = Number(process.env.AGENT_HUB_E2E_ISSUE || "1");
  const issueSlug = process.env.AGENT_HUB_E2E_SLUG || "extension-release-readiness";
  const outputDir = process.env.AGENT_HUB_E2E_OUTPUT || path.join(root, "artifacts", `${String(issue).padStart(4, "0")}-${issueSlug}`, runId);
  fs.mkdirSync(outputDir, { recursive: true });
  const isolatedRoot = path.join(root, ".vscode-test", "runs", `${runId}-${process.pid}`);
  const userDataDir = path.join(isolatedRoot, "user-data");
  const extensionsDir = path.join(isolatedRoot, "extensions");
  fs.mkdirSync(userDataDir, { recursive: true });
  fs.mkdirSync(extensionsDir, { recursive: true });
  process.env.AGENT_HUB_E2E_OUTPUT = outputDir;
  fs.writeFileSync(path.join(outputDir, "manifest.json"), JSON.stringify({ issue, command: "npm run test:extension", platform: process.platform, arch: process.arch, node: process.version, startedAt: new Date().toISOString() }, null, 2));
  await runTests({
    version: process.env.VSCODE_TEST_VERSION || "1.100.3",
    extensionDevelopmentPath: root,
    extensionTestsPath: path.join(root, "dist", "test", "suite", "index.js"),
    launchArgs: ["--disable-workspace-trust", "--skip-welcome", "--skip-release-notes", `--user-data-dir=${userDataDir}`, `--extensions-dir=${extensionsDir}`],
  });
  console.log(`Extension Host evidence: ${outputDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
