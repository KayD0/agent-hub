import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAutoApproval } from "../src/domain/approval-policy";

test("command auto approval requires an exact configured match", () => {
  const policy = { allowedCommands: ["npm test"], allowedPaths: [] };
  assert.equal(evaluateAutoApproval(policy, {
    operation: "command",
    sessionRoot: "C:\\work",
    command: "npm test",
  }).autoApprove, true);
  assert.equal(evaluateAutoApproval(policy, {
    operation: "command",
    sessionRoot: "C:\\work",
    command: "npm test -- --watch",
  }).autoApprove, false);
});

test("sensitive commands always require confirmation even when configured", () => {
  for (const command of ["git push origin main", "curl https://example.com", "git reset --hard"]) {
    const result = evaluateAutoApproval({ allowedCommands: [command], allowedPaths: [] }, {
      operation: "command",
      sessionRoot: "C:\\work",
      command,
    });
    assert.equal(result.autoApprove, false, command);
    assert.match(result.reason, /手動確認/);
  }
});

test("file changes require both session containment and an allowed path", () => {
  const policy = { allowedCommands: [], allowedPaths: ["${sessionRoot}"] };
  assert.equal(evaluateAutoApproval(policy, {
    operation: "file_change",
    sessionRoot: "C:\\work",
    targetPath: "C:\\work\\src",
  }).autoApprove, true);
  assert.equal(evaluateAutoApproval(policy, {
    operation: "file_change",
    sessionRoot: "C:\\work",
    targetPath: "C:\\outside",
  }).autoApprove, false);
});

test("missing approval details fail closed", () => {
  const policy = { allowedCommands: ["npm test"], allowedPaths: ["${sessionRoot}"] };
  assert.equal(evaluateAutoApproval(policy, { operation: "command", sessionRoot: "C:\\work" }).autoApprove, false);
  assert.equal(evaluateAutoApproval(policy, { operation: "file_change", sessionRoot: "C:\\work" }).autoApprove, false);
});
