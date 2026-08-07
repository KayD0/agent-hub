# AgentHub for Codex

複数のCodexセッションを、フォルダ単位で監視・操作し、Git差分まで確認できるVS Code拡張機能です。

AgentHubは、複数のAI作業を並行して進めるときの「監督画面」を目指しています。セッションごとにターミナルを巡回せず、実行状況、承認待ち、入力待ち、完了結果、リポジトリの変更をVS Code内でまとめて確認できます。

Codexとの通信には`codex app-server`のstdio JSONLプロトコルを使用し、PTYやターミナル画面の文字列解析には依存しません。

詳しい利用場面は[概要とメリット](./docs/app-benefits.md)、操作方法は[利用マニュアル](./docs/user-manual.md)を参照してください。

## 主な機能

### 複数セッションの監視と操作

- 作業フォルダを選択してCodex Threadを開始
- 実行中、承認待ち、入力待ち、完了、失敗、中断、切断を一覧表示
- 実行中Turnへの追加指示と中断
- 完了結果のクイック表示と詳細画面
- セッションの並べ替え
- VS Code通知による承認待ち、完了、失敗の通知

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

### 承認と入力

- コマンド実行とファイル変更の承認・拒否
- セッション内での許可
- 選択式、複数選択式、自由入力を含む複数質問への一括回答
- 承認結果、判定理由、適用ルールの監査ログ

### 安全側のAuto承認

セッション単位でAutoを有効にできますが、すべての要求を無条件に承認する機能ではありません。

- 設定したコマンドと完全一致する操作だけを自動承認
- PowerShellの`-Command`でラップされた単一Gitコマンドは、内側のコマンドを完全一致で判定
- セッションの作業フォルダ内かつ許可パス配下のファイル変更だけを自動承認
- 再帰削除と直接的な外部通信は常に手動確認
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

## 必要な環境

- VS Code Desktop 1.100以降
- Node.js 20以降
- npm
- Codex CLI
- Git（リポジトリ差分機能を利用する場合）
- GitHub CLI（Issue連携を利用する場合）

既定ではPATH上の`codex`を使用します。必要な場合はVS Code設定の`agentHub.codexPath`へ実行ファイルのパスを指定してください。

VS Code Web、`vscode.dev`、`github.dev`は対象外です。

## 開発版を起動する

現在は開発版であり、VSIXによる通常配布には対応していません。

```powershell
npm install
npm test
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
| `agentHub.codexPath` | `codex` | Codex CLI実行ファイルのパス |
| `agentHub.codexArgs` | `[]` | `app-server`より前へ追加する引数 |
| `agentHub.notifyOnActionRequired` | `true` | 承認・入力待ちを通知 |
| `agentHub.notifyOnComplete` | `true` | Turn完了を通知 |
| `agentHub.notifyOnFailure` | `true` | 失敗・切断を通知 |
| `agentHub.autoApprove.allowedCommands` | `[]` | Auto承認できるコマンドの完全一致リスト |
| `agentHub.autoApprove.allowedPaths` | `[]` | Auto承認できるファイル変更パス。`${sessionRoot}`を利用可能 |

## 現在の制約

- Codex CLI以外のエージェントには未対応
- VSIXパッケージによる通常配布は未対応
- GitHub Issueの作成・編集・コメント・Close、Pull Request、CIとの連携は未対応
- 差分画面からのファイル編集、commit、checkout、mergeなどは未対応
- 複数ブランチ、複数worktree、複数Agent Workspace間の比較は未対応
- 完了済みThreadのCodex側アーカイブ・削除は未対応
- セッション詳細のアクティビティは再起動後に復元されない

## 設計上の特徴

- `codex app-server`のstdio JSONLプロトコルを使用
- PTYや画面文字列解析に非依存
- Domain、Application、Infrastructure、Presentationの責務を分離
- Gitコマンドをシェル文字列ではなく引数配列で実行
- 外部フォルダとGit差分の操作は読み取りを基本とする
