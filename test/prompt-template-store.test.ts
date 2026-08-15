import assert from "node:assert/strict";
import { test } from "node:test";
import { PromptTemplateState, PromptTemplateStore } from "../src/infrastructure/vscode/prompt-template-store";

class MemoryState implements PromptTemplateState {
  private readonly values = new Map<string, unknown>();
  public get<T>(key: string, defaultValue: T): T { return (this.values.has(key) ? this.values.get(key) : defaultValue) as T; }
  public update(key: string, value: unknown): Promise<void> { this.values.set(key, value); return Promise.resolve(); }
}

test("prompt templates include a built-in and persist category, name, and content", async () => {
  const state = new MemoryState();
  const store = new PromptTemplateStore(state);
  assert.equal(store.list()[0].builtIn, true);
  const saved = await store.save("レビュー", "差分確認", "この差分をレビューしてください");
  assert.equal(saved.category, "レビュー");
  assert.equal(new PromptTemplateStore(state).list().at(-1)?.text, "この差分をレビューしてください");
  const updated = await store.save("レビュー", "差分確認", "セキュリティも確認してください");
  assert.equal(updated.id, saved.id);
  assert.equal(store.list().filter((item) => !item.builtIn).length, 1);
});

test("custom and built-in prompt templates can be removed persistently", async () => {
  const state = new MemoryState();
  const store = new PromptTemplateStore(state);
  const custom = await store.save("調査", "市場調査", "競合サービスを調査してください");
  assert.equal(await store.remove("builtin:design-research"), true);
  assert.equal(new PromptTemplateStore(state).list().some((item) => item.id === "builtin:design-research"), false);
  assert.equal(await store.remove(custom.id), true);
  assert.equal(store.list().some((item) => item.id === custom.id), false);
});

test("custom prompt templates can be overwritten while the built-in stays protected", async () => {
  const store = new PromptTemplateStore(new MemoryState());
  const custom = await store.save("調査", "市場調査", "旧本文");
  assert.equal((await store.overwrite(custom.id, "新本文"))?.text, "新本文");
  assert.equal(store.list().find((item) => item.id === custom.id)?.text, "新本文");
  assert.equal(await store.overwrite("builtin:design-research", "変更"), undefined);
});

test("custom prompt template category and name can be changed", async () => {
  const store = new PromptTemplateStore(new MemoryState());
  const custom = await store.save("調査", "市場調査", "本文");
  const renamed = await store.rename(custom.id, "レビュー", "競合レビュー");
  assert.equal(renamed?.category, "レビュー");
  assert.equal(renamed?.name, "競合レビュー");
  assert.equal(await store.rename("builtin:design-research", "変更", "変更"), undefined);
});
