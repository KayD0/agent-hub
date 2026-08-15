import { randomUUID } from "node:crypto";
import { BUILT_IN_PROMPT_TEMPLATES, PromptTemplate } from "../../application/prompt-template";

const STORAGE_KEY = "agentHub.promptTemplates.v1";
const REMOVED_BUILT_INS_KEY = "agentHub.removedBuiltInPromptTemplates.v1";
const MAX_TEMPLATES = 100;

export interface PromptTemplateState {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: unknown): Thenable<void>;
}

interface StoredPromptTemplate {
  id: string;
  category: string;
  name: string;
  text: string;
}

export class PromptTemplateStore {
  public constructor(private readonly state: PromptTemplateState) {}

  public list(): PromptTemplate[] {
    const custom = this.read().map((template) => ({ ...template, builtIn: false }));
    const removedBuiltIns = new Set(this.state.get<unknown>(REMOVED_BUILT_INS_KEY, []) instanceof Array
      ? this.state.get<string[]>(REMOVED_BUILT_INS_KEY, [])
      : []);
    return [...BUILT_IN_PROMPT_TEMPLATES.filter((template) => !removedBuiltIns.has(template.id)), ...custom];
  }

  public async save(categoryValue: string, nameValue: string, textValue: string): Promise<PromptTemplate> {
    const category = required(categoryValue, "カテゴリ", 60);
    const name = required(nameValue, "テンプレート名", 80);
    const text = required(textValue, "テンプレート本文", 20_000);
    const templates = this.read();
    const existing = templates.find((item) => item.category === category && item.name === name);
    if (existing) {
      existing.text = text;
      await this.state.update(STORAGE_KEY, templates);
      return { ...existing, builtIn: false };
    }
    if (templates.length >= MAX_TEMPLATES) throw new Error(`テンプレートは最大${MAX_TEMPLATES}件まで保存できます。`);
    const created = { id: `custom:${randomUUID()}`, category, name, text };
    await this.state.update(STORAGE_KEY, [...templates, created]);
    return { ...created, builtIn: false };
  }

  public async remove(id: string): Promise<boolean> {
    if (BUILT_IN_PROMPT_TEMPLATES.some((template) => template.id === id)) {
      const removed = this.state.get<string[]>(REMOVED_BUILT_INS_KEY, []).filter((value) => typeof value === "string");
      if (removed.includes(id)) return false;
      await this.state.update(REMOVED_BUILT_INS_KEY, [...removed, id]);
      return true;
    }
    if (!id.startsWith("custom:")) return false;
    const templates = this.read();
    const next = templates.filter((item) => item.id !== id);
    if (next.length === templates.length) return false;
    await this.state.update(STORAGE_KEY, next);
    return true;
  }

  public async overwrite(id: string, textValue: string): Promise<PromptTemplate | undefined> {
    if (!id.startsWith("custom:")) return undefined;
    const text = required(textValue, "テンプレート本文", 20_000);
    const templates = this.read();
    const template = templates.find((item) => item.id === id);
    if (!template) return undefined;
    template.text = text;
    await this.state.update(STORAGE_KEY, templates);
    return { ...template, builtIn: false };
  }

  public async rename(id: string, categoryValue: string, nameValue: string): Promise<PromptTemplate | undefined> {
    if (!id.startsWith("custom:")) return undefined;
    const category = required(categoryValue, "カテゴリ", 60);
    const name = required(nameValue, "テンプレート名", 80);
    const templates = this.read();
    const template = templates.find((item) => item.id === id);
    if (!template) return undefined;
    if (templates.some((item) => item.id !== id && item.category === category && item.name === name)) throw new Error("同じカテゴリに同名のテンプレートがあります。");
    template.category = category;
    template.name = name;
    await this.state.update(STORAGE_KEY, templates);
    return { ...template, builtIn: false };
  }

  private read(): StoredPromptTemplate[] {
    const value = this.state.get<unknown>(STORAGE_KEY, []);
    if (!Array.isArray(value)) return [];
    return value.filter(isStoredTemplate).slice(0, MAX_TEMPLATES);
  }
}

function required(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label}を入力してください。`);
  if (normalized.length > maxLength) throw new Error(`${label}は${maxLength}文字以内で入力してください。`);
  return normalized;
}

function isStoredTemplate(value: unknown): value is StoredPromptTemplate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredPromptTemplate>;
  return typeof item.id === "string" && item.id.startsWith("custom:")
    && typeof item.category === "string" && item.category.length > 0 && item.category.length <= 60
    && typeof item.name === "string" && item.name.length > 0 && item.name.length <= 80
    && typeof item.text === "string" && item.text.length > 0 && item.text.length <= 20_000;
}
