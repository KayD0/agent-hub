import { CompetitiveAnalysisFocus, FolderAnalysisDepth, FolderAnalysisScope } from "../domain/folder-analysis";

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

const COMPETITIVE_FOCUS: Record<CompetitiveAnalysisFocus, string> = {
  positioning: "対象ユーザー、主要な価値提案、選ばれる理由、差別化余地を中心に比較する",
  features: "主要機能、利用フロー、連携、運用体験の差を中心に比較する",
  pricing: "料金体系、無料枠、チーム利用、導入コストを中心に比較する",
  all: "ポジショニング、機能、料金、運用、リスクを横断的に比較する",
};

export function competitiveAnalysisPrompt(focus: CompetitiveAnalysisFocus, depth: FolderAnalysisDepth): string {
  return `登録フォルダのプロダクトについて競合分析を行い、採るべき対応方針を提案してください。

最初にREADME、設計資料、主要機能を読み、自プロダクトの対象ユーザーと価値提案を把握してください。その後、必ずWebで最新情報を調査し、直接競合、間接競合、代替手段を区別してください。競合の機能・料金・ポジショニングは公式サイトや公式ドキュメントを優先し、確認日とURLを根拠に含めてください。

分析観点: ${COMPETITIVE_FOCUS[focus]}
分析深度: ${DEPTH_INSTRUCTIONS[depth]}

競合が強い軸をそのまま模倣するのではなく、誰にとってなぜ選ぶ理由になるか、避けるべき方向、追加調査が必要な未確定事項も考慮してください。このターンではファイル変更、コミット、push、Issue作成などの書き込みは行わないでください。

最終結果は説明文を前後に付けず、次の形式のJSONオブジェクトだけを返してください。
{
  "summary": "主要競合、比較結果、自プロダクトの強みと全体所見",
  "candidates": [
    {
      "title": "対応方針の短いタイトル",
      "description": "競合状況と、この対応が利用者・事業にもたらす効果",
      "direction": "採るべきポジショニングまたはプロダクト方針。避けることと判断基準も含める",
      "evidence": ["競合名・確認日・公式URL、または自プロダクトの相対パス:行番号"],
      "priority": "high | medium | low"
    }
  ]
}`;
}
