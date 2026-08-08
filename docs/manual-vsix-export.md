# VS Code 拡張機能の手動エクスポート・インポート手順

AgentHub for Codex を Marketplace へ公開せず、ローカルで利用するための手順です。

## 前提条件

- VS Code Desktop 1.100 以降
- Node.js と npm
- Codex CLI
- このリポジトリをローカルへ取得済みであること

VS Code Web（`vscode.dev`、`github.dev`）では利用できません。

## 1. VSIXをエクスポートする

PowerShellを開き、クローンしたリポジトリのルートへ移動してから、拡張機能のプロジェクトへ移動します。

```powershell
cd .\app
```

このコマンドは、現在位置がリポジトリのルートであることを前提としています。別の場所にクローンした場合も、そのルートから同じコマンドを実行できます。

初回、または依存関係が更新された場合は、依存パッケージをインストールします。

```powershell
npm install
```

テストを実行します。

```powershell
npm test
```

VSIXを生成します。

```powershell
npm run package:vsix
```

正常に完了すると、次のファイルが生成または上書きされます。

```text
releases/agenthub-codex.vsix
```

## 2. VS Codeへ手動インポートする

1. VS Codeを開きます。
2. Activity Barから「拡張機能」を開きます。
3. 拡張機能ビュー右上の「…」を選択します。
4. 「VSIXからのインストール...」を選択します。
5. `releases/agenthub-codex.vsix` を選択します。
6. インストール完了後、案内が表示されたらVS Codeを再読み込みします。
7. Activity Barに「AgentHub」が表示されることを確認します。

コマンドラインからインストールする場合は、次を実行します。

```powershell
code --install-extension .\releases\agenthub-codex.vsix
```

## 3. Codex CLIを確認する

VS Codeを起動した環境で、Codex CLIを実行できることを確認します。

```powershell
codex --version
```

`codex` が見つからない場合は、VS Code設定の `agentHub.codexPath` に `codex.exe` の絶対パスを指定します。

設定例：

```json
{
  "agentHub.codexPath": "C:\\path\\to\\codex.exe"
}
```

## 4. 拡張機能を更新する

コード変更後に次を実行し、VSIXを作り直します。

```powershell
npm test
npm run package:vsix
```

VS Codeで再度「VSIXからのインストール...」を選び、同じファイルを指定します。確認が表示された場合は上書きを許可し、VS Codeを再読み込みします。

同じバージョンを確実に入れ直したい場合は、先に既存の拡張機能をアンインストールしてからVSIXをインストールします。

## 5. アンインストールする

1. VS Codeの「拡張機能」を開きます。
2. `AgentHub for Codex` を選択します。
3. 「アンインストール」を選択します。
4. VS Codeを再読み込みします。

## トラブルシューティング

### `npm run package:vsix` が失敗する

依存関係を入れ直し、再実行します。

```powershell
npm install
npm run package:vsix
```

### インストール後にAgentHubが表示されない

- VS Codeが1.100以降であることを確認します。
- VS Codeを再読み込みします。
- 拡張機能画面で `AgentHub for Codex` が有効になっていることを確認します。

### セッションを開始できない

- `codex --version` が成功することを確認します。
- `agentHub.codexPath` の設定を確認します。
- VS Codeを起動し直し、Codex CLIのPATH変更を反映します。
