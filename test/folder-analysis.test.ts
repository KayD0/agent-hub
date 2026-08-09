import assert from "node:assert/strict";
import test from "node:test";
import { competitiveAnalysisPrompt, folderAnalysisPrompt } from "../src/application/folder-analysis-prompt";
import { parseFolderAnalysisResult } from "../src/domain/folder-analysis";

test("folder analysis prompt explicitly keeps the run read-only", () => {
  const prompt = folderAnalysisPrompt("changes", "standard");
  assert.match(prompt, /読み取り専用/);
  assert.match(prompt, /ファイルの作成・編集・削除/);
  assert.match(prompt, /最大8件/);
});

test("competitive analysis prompt requires current primary sources and a response direction", () => {
  const prompt = competitiveAnalysisPrompt("positioning", "standard");
  assert.match(prompt, /必ずWebで最新情報/);
  assert.match(prompt, /公式サイトや公式ドキュメント/);
  assert.match(prompt, /直接競合、間接競合、代替手段/);
  assert.match(prompt, /採るべきポジショニングまたはプロダクト方針/);
});

test("folder analysis result parses a fenced JSON response", () => {
  const result = parseFolderAnalysisResult('```json\n{"summary":"2件確認","candidates":[{"title":"テスト不足","description":"復元経路が未検証","direction":"状態復元の契約をテストで固定する","evidence":["test/example.test.ts"],"priority":"high"}]}\n```');
  assert.equal(result?.summary, "2件確認");
  assert.equal(result?.candidates[0].title, "テスト不足");
  assert.equal(result?.candidates[0].priority, "high");
  assert.equal(result?.candidates[0].direction, "状態復元の契約をテストで固定する");
});

test("folder analysis result rejects malformed candidates", () => {
  assert.equal(parseFolderAnalysisResult('{"summary":"invalid","candidates":[{"title":"missing fields"}]}'), undefined);
});

test("folder analysis result keeps older results without a direction readable", () => {
  const result = parseFolderAnalysisResult('{"summary":"legacy","candidates":[{"title":"既存課題","description":"以前の分析結果","evidence":[],"priority":"low"}]}');
  assert.match(result?.candidates[0].direction ?? "", /根拠を再確認/);
});
