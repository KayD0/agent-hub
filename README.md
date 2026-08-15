# AgentHub for Codex

複数のCodexセッションを、フォルダ単位で監視・操作し、Git差分まで確認できるVS Code拡張機能です。

AgentHubは、複数のAI作業を並行して進めるときの「監督画面」を目指しています。セッションごとにターミナルを巡回せず、実行状況、承認待ち、入力待ち、完了結果、リポジトリの変更をVS Code内でまとめて確認できます。

Codexとの通信には`codex app-server`のstdio JSONLプロトコルを使用し、PTYやターミナル画面の文字列解析には依存しません。

詳しい利用場面は[概要とメリット](./docs/app-benefits.md)、操作方法は[利用マニュアル](./docs/user-manual.md)、VSIXの導入と復旧は[VSIX導入手順](./docs/vsix-installation.md)を参照してください。

## 主な機能

### 複数セッションの監視と操作

- 作業フォルダを選択してCodex Threadを開始
- 実行中、承認待ち、入力待ち、完了、失敗、中断、切断を一覧表示
- 実行中Turnへの追加指示と中断
- セッション一覧・詳細画面で`Esc`キーによる実行中Turnの中断
- 完了結果のクイック表示と詳細画面
- セッションの並べ替え
- VS Code通知による承認待ち、完了、失敗の通知

### 画像を含む指示

- セッション一覧または詳細画面の入力欄へ、クリップボードのPNG・JPEG画像を貼り付けて送信
- 1回につき最大4枚、1枚10MBまで添付可能
- 詳細画面では送信前のサムネイル確認と個別削除に対応
- 添付画像はCodexのTurnが完了するまで一時保存し、完了・失敗・中断後に削除
- 本文を省略して画像だけを送信可能

動画ファイルの添付と画像生成には現在対応していません。

### メッセージテンプレート

- セッション詳細画面の入力欄上部から、カテゴリ別のテンプレートを選択
- 利用者がカテゴリ、テンプレート名、本文を設定して最大100件まで保存
- 保存済みのカスタムテンプレートは本文の上書き、カテゴリ・名前の変更、削除が可能
- 組み込みの「Figmaデザイン調査」テンプレートを同梱
- 組み込みテンプレートも不要な場合は削除可能

テンプレートはVS Codeの拡張機能ストレージへ保存されます。組み込みテンプレートは本文の上書きや名前変更には対応していません。

### フォルダ単位の整理

- 複数のGitリポジトリを含むフォルダグループを登録
- 登録フォルダからCodexセッションを開始
- フォルダごとのセッション絞り込み
- フィルターの「すべてチェック」「すべてクリア」
- 現在のVS Codeワークスペース外にあるフォルダにも対応

### Git差分の確認

- 登録フォルダ配下のGitリポジトリを自動検出
- リポジトリ、ブランチ、変更ファイル数、追加・削除行数を表示
- 追加、変更、削除、名前変更、未追跡ファイルを区別
- 変更ファイル一覧とインライン差分をエディタ領域に表示
- ファイル一覧と差分表示の幅をドラッグまたはキーボードで調整
- 必要な場合だけ対象フォルダを新しいVS Codeウィンドウで開く

差分画面は読み取り専用です。checkout、reset、clean、mergeなど、作業ツリーを変更するGit操作は実行しません。

### GitHub Issue連携

- 登録フォルダ配下のGitHubリポジトリからOpen Issueを取得
- Issue番号、タイトル、ラベル、担当者、更新日時、本文を表示
- IssueをGitHubで開く
- Issue番号、タイトル、URL、本文を初期指示としてCodexセッションを開始
- GitHub CLI（`gh`）の既存認証を利用し、AgentHub自身はトークンを保存しない

### フォルダ分析とIssue化

- 登録フォルダを対象に、コード上の課題分析またはWeb調査を含む競合分析をCodexへ依頼
- 対象範囲、分析の深さ、競合分析の観点を開始時に選択
- 構造化された分析結果から候補を選び、GitHub Issueとして一括作成

### Issue worktreeと統合管理

- Issueから専用ブランチと`.worktrees`配下のworktreeを作成し、分離したCodexセッションを開始
- worktreeごとの未コミット差分、マージ可否、競合、マージ済み状態を専用画面で確認
- 未コミット差分のコミットや競合解決を、既存または新規Codexセッションへ依頼
- 選択したworktreeを表示順にベースブランチへマージ
- マージ済みかつ変更のない未使用worktreeだけを安全に削除

マージ処理はpushを行わず、未コミット差分や競合を検出した場合は安全側で停止します。

### Figma MCP連携

- `AgentHub: セットアップと診断`から公式Figma MCPをCodexのユーザー設定へ追加
- Codex app-server経由でFigmaのOAuth認証を開始
- 未設定、ログイン待ち、接続済み、エラーの状態をセットアップ画面で確認
- Figma URLと組み込みテンプレートを使い、Codexへデザイン調査を依頼

Figma連携には、Figma側で対象ファイルを閲覧できるアカウントが必要です。AgentHubがFigmaのアクセストークンを直接保存することはありません。

### 承認と入力

- コマンド実行とファイル変更の承認・拒否
- セッション内での許可
- 選択式、複数選択式、自由入力を含む複数質問への一括回答
- 承認結果、判定理由、適用ルールの監査ログ

### 安全側のAuto承認

セッション単位でAutoを有効にできますが、すべての要求を無条件に承認する機能ではありません。

- 設定したコマンドと完全一致する操作だけを自動承認
- 設定したコマンド接頭辞に一致する通常のGit・GitHub操作を自動承認
- PowerShellの`-Command`でラップされた単一Gitコマンドは、内側のコマンドを完全一致で判定
- セッションの作業フォルダ内かつ許可パス配下のファイル変更だけを自動承認
- 再帰削除、直接的な外部通信、force push、branch削除、`reset --hard`、`clean`は常に手動確認
- 対象や内容を判定できない要求は手動確認
- Auto設定はVS Code再起動後に無効化

### 認証と障害復旧

- ChatGPTブラウザ認証
- ブラウザコールバックを利用できない場合のデバイスコード認証
- 認証情報の管理をCodex app-serverへ委譲
- セッションメタデータと順序の保存
- VS Code再起動後のThread復元
- app-server異常終了後の自動再接続とセッション復元
- 切断時の保留中承認を安全側に破棄
- 起動時は保存済みセッション一覧を先に表示し、Codex Threadへの再接続をバックグラウンドで実行
- 非表示のリポジトリ画面は必要になるまで更新を遅延し、変更のないworktreeのGit再取得を抑制

## 必要な環境

- VS Code Desktop 1.100以降
- Node.js 20以降
- npm
- Codex CLI
- Git（リポジトリ差分機能を利用する場合）
- GitHub CLI（Issue連携を利用する場合）
- Figmaアカウント（Figma MCP連携を利用する場合）

既定ではPATH上から`codex`（Windowsでは`codex.exe`、`codex.cmd`を含む）を検出します。必要な場合だけ、VS Code設定の`agentHub.codexPath`へ実行ファイルのパスを指定してください。見つからない場合は、PATHの設定または`agentHub.codexPath`の指定方法を含むエラーを表示します。

VS Code Web、`vscode.dev`、`github.dev`は対象外です。

## 開発版を起動する

開発版のVSIXを再現可能な手順で生成できます。

```powershell
npm install
npm test
npm run package:vsix
```

VS Codeでこのフォルダを開き、`F5`で`Run AgentHub Extension`を起動します。開いたExtension Development HostのActivity BarからAgentHubを選択してください。

## テスト

```powershell
# コンパイルと全Node.jsテスト
npm test

# ユニットテスト
npm run test:unit

# JSONLプロトコル境界
npm run test:protocol

# fake app-serverによる正常系・異常系
npm run test:app-server

# VS Code Extension Host smoke
npm run test:extension
```

Extension Host smokeの結果は`artifacts/`配下へ保存されます。

## 主な設定

| 設定 | 既定値 | 説明 |
| --- | --- | --- |
| `agentHub.codexPath` | 未指定 | Codex CLI実行ファイルの任意指定。未指定時はPATHから自動検出 |
| `agentHub.codexArgs` | `[]` | `app-server`より前へ追加する引数 |
| `agentHub.notifyOnActionRequired` | `true` | 承認・入力待ちを通知 |
| `agentHub.notifyOnComplete` | `true` | Turn完了を通知 |
| `agentHub.notifyOnFailure` | `true` | 失敗・切断を通知 |
| `agentHub.autoApprove.allowedCommands` | `[]` | Auto承認できるコマンドの完全一致リスト |
| `agentHub.autoApprove.allowedCommandPrefixes` | Git・GitHubの安全な既定値 | Auto承認できるコマンド接頭辞 |
| `agentHub.autoApprove.allowedPaths` | `["${sessionRoot}"]` | Auto承認できるファイル変更パス。`${sessionRoot}`を利用可能 |

## 現在の制約

- Codex CLI以外のエージェントには未対応
- Marketplace公開と自動更新は未対応（VSIX配布には対応）
- GitHub Issueの任意編集・コメント・Close、Pull Request、CIとの連携は未対応
- 動画添付と、ChatGPTのような画像生成は未対応
- Figma MCP連携はデザイン情報の取得・調査をCodexへ依頼するもので、FigmaファイルをAgentHub上で直接編集する機能ではない
- 差分画面からのファイル編集、commit、checkout、mergeなどは未対応
- 複数Agent Workspace間の横断比較は未対応
- 完了済みThreadのCodex側アーカイブ・削除は未対応
- セッション詳細のアクティビティは再起動後に復元されない

## 設計上の特徴

- `codex app-server`のstdio JSONLプロトコルを使用
- PTYや画面文字列解析に非依存
- Domain、Application、Infrastructure、Presentationの責務を分離
- Gitコマンドをシェル文字列ではなく引数配列で実行
- 外部フォルダとGit差分の操作は読み取りを基本とする
