# AgentHub for Codex

複数のCodexセッションをVS Codeのサイドバーから監視・操作する拡張機能です。`codex app-server`のstdio JSONLプロトコルを利用し、PTYや画面文字列解析に依存しません。

詳しい導入方法と操作方法は[利用マニュアル](./docs/user-manual.md)を参照してください。

## 開発

```powershell
npm install
npm run compile
npm test
```

VS Codeでこのフォルダを開き、`F5`で`Run AgentHub Extension`を起動します。Activity BarのAgentHubから新しいセッションを開始してください。

## 前提

- VS Code Desktop 1.100以降
- Codex CLIがインストール済みで、認証が完了していること
- 既定ではPATH上の`codex`を使用。必要なら`agentHub.codexPath`を設定

## MVP機能

- 作業フォルダを選んでCodex Threadを開始
- 複数セッションの状態別一覧
- コマンド実行・ファイル変更の承認と拒否
- 選択式入力要求への回答
- メッセージ、コマンド、ファイル変更の詳細表示
- 追加入力とTurn中断
- セッションメタデータの復元

## 現時点の主な制約

- 開発版であり、VSIX配布は未対応
- 自由入力型の`requestUserInput`と複数質問への一括回答は未完成
- app-serverの自動再起動とVS Code E2Eテストは未対応

