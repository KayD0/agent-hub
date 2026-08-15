export interface PromptTemplate {
  id: string;
  category: string;
  name: string;
  text: string;
  builtIn: boolean;
}

export const BUILT_IN_PROMPT_TEMPLATES: readonly PromptTemplate[] = [{
  id: "builtin:design-research",
  category: "デザイン",
  name: "Figmaデザイン調査",
  text: `Figma MCPを使って、対象のデザインを調査してください。

対象URL:
[ここにFigmaのURLを入力]

次の観点を確認してください。
- 画面構成と主要なユーザーフロー
- コンポーネント、配色、タイポグラフィ、余白のルール
- レスポンシブ対応とアクセシビリティ
- 現在の実装との差分と、実装時の注意点

まず調査結果を整理し、この時点では実装を変更しないでください。`,
  builtIn: true,
}];
