export function parseAnswers(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.length === 0) return undefined;
  if (!entries.every(([id, answers]) => id.length > 0 && isStringArray(answers) && answers.length > 0)) return undefined;
  return Object.fromEntries(entries);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
