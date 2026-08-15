import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { AppServerClient, resolveCodexCommand } from "../src/infrastructure/codex/app-server-client";

const fixture = path.resolve(__dirname, "../../test/fixtures/fake-codex.js");

test("Codex command resolution prefers an explicit executable", () => {
  const result = resolveCodexCommand("C:\\tools\\custom-codex.exe", {
    platform: "win32",
    pathValue: "C:\\ignored",
    existsSync: (candidate) => candidate === "C:\\tools\\custom-codex.exe",
  });
  assert.deepEqual(result, { file: "C:\\tools\\custom-codex.exe", args: [] });
});

test("Codex command resolution detects a Windows npm shim from PATH", () => {
  const result = resolveCodexCommand(undefined, {
    platform: "win32",
    pathValue: '"C:\\Program Files\\nodejs";C:\\Users\\test\\AppData\\Roaming\\npm',
    comSpec: "C:\\Windows\\System32\\cmd.exe",
    existsSync: (candidate) => candidate === "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd",
  });
  assert.deepEqual(result, {
    file: "C:\\Windows\\System32\\cmd.exe",
    args: ["/d", "/s", "/c", "C:\\Users\\test\\AppData\\Roaming\\npm\\codex.cmd"],
  });
});

test("Codex command resolution explains how to fix a missing CLI", () => {
  assert.throws(
    () => resolveCodexCommand(undefined, { platform: "win32", pathValue: "C:\\empty", existsSync: () => false }),
    /Codex CLIが見つかりません.*PATH.*agentHub\.codexPath/,
  );
});

test("AppServerClient exchanges JSONL with a fake app-server", async () => {
  const client = new AppServerClient(process.execPath, () => {}, [fixture]);
  await client.start();
  assert.deepEqual(await client.readAccount(), {
    account: { type: "chatgpt", email: "fake@example.test", planType: undefined },
    requiresOpenaiAuth: true,
  });
  assert.deepEqual(await client.startThread("C:\\work"), { threadId: "fake-thread" });
  assert.deepEqual(await client.listMcpServers(), [{ name: "figma", authStatus: "notLoggedIn", toolCount: 1 }]);
  await client.writeMcpServerConfig("figma", "https://mcp.figma.com/mcp");
  await client.reloadMcpServers();
  assert.deepEqual(await client.startMcpOauthLogin("figma"), { authorizationUrl: "https://figma.example.test/oauth" });
  await client.stop();
});

test("AppServerClient rejects timed out RPC and remains stoppable", async () => {
  const client = new AppServerClient(process.execPath, () => {}, [fixture], 200);
  await client.start();
  await assert.rejects(client.startThread("__timeout__"), /応答/);
  await client.stop();
});

test("AppServerClient reports abnormal process exit", async () => {
  const client = new AppServerClient(process.execPath, () => {}, [fixture]);
  const exit = new Promise<string>((resolve) => client.onExit(resolve));
  await client.start();
  await assert.rejects(client.startThread("__crash__"), /code=23/);
  assert.match(await exit, /code=23/);
  await client.stop();
});
