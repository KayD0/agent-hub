import { FolderAnalysisDepth, FolderAnalysisScope } from "../domain/folder-analysis";

const SCOPE_INSTRUCTIONS: Record<FolderAnalysisScope, string> = {
  changes: "未コミット差分とdevelopブランチとの差分を中心に確認し、必要な周辺コードだけ読む",
  important: "README、package設定、主要なsrc/test、CI設定を確認し、代表的な実装経路を読む",
  all: "生成物と依存ディレクトリを除くリポジトリ全体を横断的に確認する",
};

const DEPTH_INSTRUCTIONS: Record<FolderAnalysisDepth, string> = {
  quick: "明確で影響の大きい候補に絞り、最大3件を挙げる",
  standard: "正確性、テスト、保守性、UX、運用性を確認し、最大8件を挙げる",
  deep: "正常系と異常系、状態復元、境界条件、セキュリティ、性能、運用性まで確認し、最大15件を挙げる",
};

export function folderAnalysisPrompt(scope: FolderAnalysisScope, depth: FolderAnalysisDepth): string {
  return `登録フォルダの課題候補を分析してください。

このターンは読み取り専用です。ファイルの作成・編集・削除、コミット、push、Issue作成、外部システムへの書き込みは行わないでください。

分析範囲: ${SCOPE_INSTRUCTIONS[scope]}
分析深度: ${DEPTH_INSTRUCTIONS[depth]}

推測だけの候補は避け、コード、設定、テスト結果など確認可能な根拠を付けてください。既存Issueの確認に認証やネットワークが必要な場合は無理に実行せず、その制約をsummaryに記載してください。

最終結果は説明文を前後に付けず、次の形式のJSONオブジェクトだけを返してください。
{
  "summary": "分析範囲と全体所見",
  "candidates": [
    {
      "title": "課題候補の短いタイトル",
      "description": "利用者への影響と改善する理由",
      "direction": "採るべき方向性。実装手順ではなく、責務・制約・判断基準を含める",
      "evidence": ["相対パス:行番号 または確認した具体的事実"],
      "priority": "high | medium | low"
    }
  ]
}`;
}
