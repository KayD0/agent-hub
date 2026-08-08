# VSIXの導入・更新・ロールバック

## 前提と診断

VS Code Desktop 1.100以降とCodex CLIが必要です。GitHub Issue連携を使う場合だけGitHub CLI（`gh`）も用意します。

インストール後はコマンドパレットの「AgentHub: セットアップと診断」で、Codex CLI、Codex認証、任意のGitHub CLIを確認できます。Codex CLIが見つからない場合は、PATHを設定するか`agentHub.codexPath`を指定して「利用環境を再診断」してください。VS Codeの再起動は不要です。GitHub CLIの問題はIssue連携だけに影響し、Codexセッションは引き続き利用できます。

## 新規インストール

1. CIの`agenthub-vsix-*` artifact、または`npm run package:vsix`で生成した`releases/agenthub-codex.vsix`を取得します。
2. VS Codeの拡張機能ビューで「…」→「VSIXからのインストール」を選択します。
3. VSIXを選び、案内に従ってウィンドウを再読み込みします。

CLIでは`code --install-extension releases/agenthub-codex.vsix`でも導入できます。

## 更新

更新前のVSIXを保管し、新版を同じ手順で上書きインストールします。設定とセッションメタデータはVS Codeの拡張機能ストレージに保持されます。

## ロールバック

1. 拡張機能ビューからAgentHubをアンインストールします。
2. 保管した旧版VSIXを「VSIXからのインストール」で導入します。
3. ウィンドウを再読み込みし、「AgentHub: セットアップと診断」を実行します。

問題調査では「AgentHub: ログを表示」または「AgentHub: 診断情報をエクスポート」を使います。診断ファイルはトークン、認証コード、入力文、ユーザーのホームパスを伏せた状態で出力されますが、共有前に内容を確認してください。
