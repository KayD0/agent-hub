import * as fs from "node:fs/promises";
import * as path from "node:path";
import { run as runSmoke } from "./extension.test";

export async function run(): Promise<void> {
  const startedAt = new Date().toISOString();
  const outputDir = process.env.AGENT_HUB_E2E_OUTPUT;
  try {
    await runSmoke();
    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, "extension-host-result.json"), JSON.stringify({ status: "passed", startedAt, finishedAt: new Date().toISOString() }, null, 2));
    }
  } catch (error) {
    if (outputDir) {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(path.join(outputDir, "extension-host-result.json"), JSON.stringify({ status: "failed", startedAt, finishedAt: new Date().toISOString(), error: error instanceof Error ? error.stack : String(error) }, null, 2));
    }
    throw error;
  }
}
