import assert from "node:assert/strict";
import test from "node:test";
import { decodeRpcMessage } from "../src/infrastructure/codex/jsonl-protocol";
import { parseAnswers } from "../src/presentation/webview-messages";

test("JSONL protocol decodes response, event, and server request envelopes", () => {
  assert.deepEqual(decodeRpcMessage('{"id":1,"result":{"ok":true}}'), { id: 1, result: { ok: true } });
  assert.deepEqual(decodeRpcMessage('{"method":"turn/completed","params":{"threadId":"t1"}}'), {
    method: "turn/completed", params: { threadId: "t1" },
  });
  assert.deepEqual(decodeRpcMessage('{"id":"r1","method":"item/tool/requestUserInput","params":{}}'), {
    id: "r1", method: "item/tool/requestUserInput", params: {},
  });
  assert.throws(() => decodeRpcMessage("not json"));
  assert.throws(() => decodeRpcMessage("[]"), /must be an object/);
});

test("webview answer boundary accepts only non-empty answer maps", () => {
  assert.deepEqual(parseAnswers({ scope: ["UI", "API"], note: ["done"] }), {
    scope: ["UI", "API"], note: ["done"],
  });
  assert.equal(parseAnswers({}), undefined);
  assert.equal(parseAnswers({ scope: [] }), undefined);
  assert.equal(parseAnswers({ scope: "UI" }), undefined);
  assert.equal(parseAnswers({ scope: [1] }), undefined);
});
