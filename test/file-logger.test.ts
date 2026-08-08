import assert from "node:assert/strict";
import test from "node:test";
import { redactSensitive, redactText } from "../src/infrastructure/vscode/file-logger";

test("diagnostic redaction removes secrets and user home paths", () => {
  const value = redactSensitive({ token: "sk-abcdefghijk", nested: { userCode: "ABCD-EFGH" }, path: "C:\\Users\\alice\\repo" });
  assert.deepEqual(value, { token: "<redacted>", nested: { userCode: "<redacted>" }, path: "<redacted>" });
});

test("free-form log text redacts common credentials", () => {
  const value = redactText("authorization: Bearer-secret ghp_abcdefghijk /home/alice/project");
  assert.equal(value.includes("ghp_abcdefghijk"), false);
  assert.equal(value.includes("/home/alice"), false);
});
