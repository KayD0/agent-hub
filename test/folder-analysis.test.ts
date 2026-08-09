import assert from "node:assert/strict";
import test from "node:test";
import { folderAnalysisPrompt } from "../src/application/folder-analysis-prompt";
import { parseFolderAnalysisResult } from "../src/domain/folder-analysis";

test("folder analysis prompt explicitly keeps the run read-only", () => {
  const prompt = folderAnalysisPrompt("changes", "standard");
  assert.match(prompt, /読み取り専用/);
  assert.match(prompt, /ファイルの作成・編集・削除/);
  assert.match(prompt, /最大8件/);
});

test("folder analysis result parses a fenced JSON response", () => {
  const result = parseFolderAnalysisResult('```json\n{"summary":"2件確認","candidates":[{"title":"テスト不足","description":"復元経路が未検証","evidence":["test/example.test.ts"],"priority":"high"}]}\n```');
  assert.equal(result?.summary, "2件確認");
  assert.equal(result?.candidates[0].title, "テスト不足");
  assert.equal(result?.candidates[0].priority, "high");
});

test("folder analysis result rejects malformed candidates", () => {
  assert.equal(parseFolderAnalysisResult('{"summary":"invalid","candidates":[{"title":"missing fields"}]}'), undefined);
});
