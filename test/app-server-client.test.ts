import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";
import { AppServerClient } from "../src/infrastructure/codex/app-server-client";

const fixture = path.resolve(__dirname, "../../test/fixtures/fake-codex.js");

test("AppServerClient exchanges JSONL with a fake app-server", async () => {
  const client = new AppServerClient(process.execPath, () => {}, [fixture]);
  await client.start();
  assert.deepEqual(await client.readAccount(), {
    account: { type: "chatgpt", email: "fake@example.test", planType: undefined },
    requiresOpenaiAuth: true,
  });
  assert.deepEqual(await client.startThread("C:\\work"), { threadId: "fake-thread" });
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
