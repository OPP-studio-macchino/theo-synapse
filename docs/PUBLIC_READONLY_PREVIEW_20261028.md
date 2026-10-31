# Theo Synapse — macOS Read-only Preview 0.0.5

これは **macOS向け開発者プレビュー** です。正式な署名・Apple公証は未実施で、一般配布の完成版ではありません。

ChatGPTとMacのCodex App Serverをつなぐ独立した読み取り専用MCPです。C2C Auto-loop／Agent Fabricは不要です。

## 動作条件

- macOS、Node.js 24以上
- ローカルにCodex CLIをインストール済み（`~/.local/bin/codex`など）。Codexのログイン・利用可能枠は個別に必要です。
- 初回の依存モジュール導入にはnpmパッケージへのアクセス、または検証済みのローカルキャッシュが必要です。
- このアーカイブには **Tunnelの認証設定、秘密鍵、既存の接続情報、外部プロジェクト、実行履歴を含めません**。

## ローカル導入（外部公開や常駐の自動設定は行いません）

1. 配布元を確認し、`.tar.gz`のSHA-256と同梱manifestを検証してから展開してください。
2. 展開後のフォルダで以下を実行します。

```sh
# 展開済みのTheo Synapseフォルダで
node --version
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:readonly
npm run doctor
npm run smoke:portable
```

`npm ci`は利用者の明示した操作であり、必要に応じて外部のnpmレジストリへ接続します。インストール時のスクリプト実行は`--ignore-scripts`で無効にしています。

`setup:readonly`は自分のフォルダ内に**専用の無害なデモ**`theo-lab`を作るだけで、既存プロジェクトを書き換えません。再実行は同じ内容の場合のみ許可し、差異があれば停止します。

`doctor`はMac／Node／Codex CLI／依存モジュール／manifest／秘密設定権限を調べます。`smoke:portable`は隔離したMCPと専用デーモンを起動して8ツール・デモの登録・書き込み無効を確認しますが、Codexのモデル実行は開始しません。

## Macの自動起動ファイルを確認する

```sh
npm run launchagent:stage
```

このコマンドは自分の`.local/theo-runtime/installer-staging/`へ**検討用plistを生成するだけ**です。`~/Library/LaunchAgents`には配置せず、`launchctl`を実行せず、既存のサービスを停止・変更しません。

内容を確認してから正式に導入する必要があります。ChatGPTと接続するには、ユーザーごとに正規のSecure MCP Tunnelと認証設定が別途必要です。既存の他アプリのTunnel設定をコピーしないでください。

## できること／できないこと

現時点の主機能は、登録済みの読み取り専用プロジェクトを列挙し、Ownerの依頼に応じてCodexに読み取り専用タスクを渡し、進捗・結果・停止要求を確認することです。タスク開始はCodex利用枠を消費し得ます。

**できません:** ChatGPT Proの通常プラグインからの任意コード変更、実プロジェクトの自動修正、暗黙のOwner承認、権限昇格、署名や公証の省略、認証情報の自動生成／移行。

元プロジェクトを登録する際はMac Ownerが個別にプレビュー・ネイティブ承認し、選別済みテキストを隔離コピーします。認証情報の自動判定は完全ではないので、機密情報を含むプロジェクトは取り込まないでください。

## セキュリティとサポート境界

- アーカイブのmanifestは**ハッシュ照合用であり、公開鍵署名ではありません**。配布元の確認、Apple Developer ID署名・公証は別工程です。
- Node.js標準モジュール、固定したnpm依存バージョン、ローカルのUnixソケットを使用します。
- 既定では書き込みツールを公開せず、書き込み許可の台帳も初期化しません。
- 初期化、診断、MCPスモークはChatGPTアカウントへの接続・課金を必要としません。
- 危険なファイルや権限・既存データとの衝突を検出した場合は処理を停止します。

製品情報: O.P.P Studio / Theo Synapse。開発者プレビュー、サポート保証なし。
