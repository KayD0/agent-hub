export type FolderAnalysisScope = "changes" | "important" | "all";
export type FolderAnalysisDepth = "quick" | "standard" | "deep";
export type FolderAnalysisPriority = "high" | "medium" | "low";

export interface FolderAnalysisCandidate {
  title: string;
  description: string;
  evidence: string[];
  priority: FolderAnalysisPriority;
}

export interface FolderAnalysisResult {
  summary: string;
  candidates: FolderAnalysisCandidate[];
}

export function parseFolderAnalysisResult(value: string): FolderAnalysisResult | undefined {
  for (const candidate of jsonCandidates(value)) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record.summary !== "string" || !Array.isArray(record.candidates)) continue;
      const candidates = record.candidates.map(parseCandidate);
      if (candidates.some((item) => item === undefined)) continue;
      return { summary: record.summary.trim(), candidates: candidates as FolderAnalysisCandidate[] };
    } catch { /* Try the next JSON-shaped section. */ }
  }
  return undefined;
}

function parseCandidate(value: unknown): FolderAnalysisCandidate | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.title !== "string" || typeof candidate.description !== "string") return undefined;
  if (!Array.isArray(candidate.evidence) || candidate.evidence.some((item) => typeof item !== "string")) return undefined;
  if (candidate.priority !== "high" && candidate.priority !== "medium" && candidate.priority !== "low") return undefined;
  return {
    title: candidate.title.trim(),
    description: candidate.description.trim(),
    evidence: candidate.evidence.map((item) => String(item).trim()).filter(Boolean),
    priority: candidate.priority,
  };
}

function jsonCandidates(value: string): string[] {
  const fenced = [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1].trim());
  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) fenced.push(value.slice(firstBrace, lastBrace + 1));
  return [...new Set(fenced.filter(Boolean))];
}
