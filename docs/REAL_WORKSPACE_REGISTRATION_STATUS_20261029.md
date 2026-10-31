# Real workspace registration status — 2026-10-29

Source implementation is present and tested with disposable `/private/tmp` fixtures. It adds an owner-local `direct-workspaces.json` registry separate from the read-only snapshot `projects.json`. Registration plans are fingerprinted and short-lived, require an explicit local confirmation and a separate Mac native confirmation, and do not modify the selected source directory. MCP has no registration operation and public registry reads expose IDs only.

The normal daemon remains direct-off. A trusted local host must explicitly construct `createOwnerApprovedDirectCoordinator` from `src/direct-native-factory.mjs`; that factory reads only the separate real-workspace registry. Real-workspace `workspace_write` tasks enter `APPROVAL_PENDING`, then require a one-time native Mac approval displaying project, real folder, task ID, and instruction digest. The dialog defaults to deny and times out after 30 seconds; the registry is rechecked before any turn begins.

This is a source-level PASS, not live activation. No installed Core, tunnel, daemon, LaunchAgent, keys, plugin configuration, or real source workspace was changed. Native dialog acceptance has not been observed in this change, and no real model was used. A genuine local acceptance should register a disposable source folder, approve one synthetic fake-App-Server write, verify the result stays inside that folder, then refresh the plugin tool inventory before offering direct tools. This document does not make any claim that a Pro plan is impossible to use.

## 2026-10-29 最終RDCホスト追加検収

- C2C Auto-loop型の直接実行経路は、ネイティブデーモンの明示的なホストFactory、Unix IPC、MCPの条件付き2ツールでソース接続済み。通常起動は8ツールを保持し、直接実行はOFF。
- OwnerがMac上で承認した**実際のソースフォルダ**だけを `direct-workspaces.json` へ登録する仕組みを別実装。読み取り用 `projects.json` は無変更。登録・書込みのMac標準承認ダイアログをそれぞれAppleScriptコンパイルでPASS（本人の物理クリックE2Eではない）。
- Owner承認待ち中のホスト停止ではAbortSignalでダイアログを閉じ、タスクをUNKNOWNに保存。再起動後に自動再実行しない。承認前の重複起動/本番権限推定は禁止。
- 署名された native Core でのみ動く、引数なしの明示的Opt-in起動 `scripts/theo-direct-daemon-entry.mjs` をソースに追加。開発checkoutからの起動、余計なパス/引数による起動は拒否する。
- 実MacのRDC検収：`npm run verify:batch` は**140件PASS/0件FAIL**、MCP発見PASS、読み取り専用監査10/10 PASS。証跡 `.local/evidence/phase2-task-tools/theo-acceptance-batch-2026-10-29T02-50-32-234Z.json`。
- 未署名の読み取り専用配布プレビューは52ソースファイルで作成、秘密情報・runtime・依存node_modules・モデルturnを含めない。SHA-256 `758da67b75d33f5f804b26a3a08bf60f192c05679bffedf880091e2d5d86e391`。実際の隔離インストール11/11工程PASS（公式署名・Apple公証済み製品のアップデートではない）。
- 実機の既存ChatGPTプラグインを改めて確認：version 0.0.5、writeEnabled=false、candidateWriteEnabled=false、projects=[theo-lab]。Mac helper v0.1.2、Tunnel稼働中。旧C2C両リポ、Agent Fabric、Chappy Signal、本番環境は変更なし。

## まだ完了していない受入

1. 新しいコードのDeveloper ID署名・Apple公証済みネイティブCoreへの取込みと、Ownerによる実フォルダ登録。
2. 直接実行用のMac native Owner承認の**実クリック**と実Codexによる実ソースへの変更・テスト・復旧。
3. 既存のChatGPTプラグインに新しいMCP2ツールが表示されることとChatGPT経由のreal end-to-end。アプリ権限/安全性チェックをすり抜けて書込み有効化はしない。
4. Mac本体再起動後の継続利用確認。

**判定：SOURCE_DIRECT_ENGINE+DAEMON_IPC+OWNER_REGISTRY+ISOLATED_E2E=PASS。OFFICIAL_CHATGPT_PLUGIN_DIRECT_WRITE_E2E=NOT_DONE。本番での完成宣言は不可。**
