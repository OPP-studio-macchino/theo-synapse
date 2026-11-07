# Theo Synapse

Theo Synapse connects ChatGPT to local Codex on macOS. The ChatGPT plugin is the interface; the macOS app manages its local host.

## Scope

- Apple Silicon / macOS SwiftUI companion.
- Direct, Owner-approved workspace tasks and per-action approval gates.
- READONLY and DIRECT managed modes.
- The Secure MCP Tunnel is a separate runtime dependency.

## 主な仕様・How To・C2C Auto-loopとの違い（日本語）

### Theo Synapseとは

**Theo Synapseは、ChatGPTからMac上のCodexへ作業を渡し、結果を回収する独立製品です。** ChatGPTプラグインが操作の入口で、macOSの管理アプリがローカルホストを管理します。C2C Auto-loop、Agent Fabric、Remote Desktop Commanderは実行時の必須構成要素ではありません。

構成は「ChatGPT → 公式Secure MCP Tunnel → Theo SynapseのMac側ホスト（非公開ローカルIPC）→ Codex App Server」です。依頼の内容や返答はChatGPT経由で扱うため、機密ソースを扱う前に対象Workspaceと指示を確認してください。

### 主な仕様

| 項目 | 動作・制約 |
| --- | --- |
| 動作環境 | Apple Silicon Mac、macOS 14以降。Mac管理アプリはSwiftUI。 |
| Codex | ユーザーがインストール・ログインした公式Codex CLI／App Serverを利用。 |
| `READONLY(8)` | 標準の8ツール。機能・登録済み読み取り用プロジェクトの確認、読み取り専用タスクの状態や結果の取得など。 |
| `DIRECT(10)` | Mac本人が有効化した場合のみ、`codex_turn_start`と`codex_turn_wait`を追加。本人が登録した実Workspaceに対して実行。 |
| モード | `read_only` と `workspace_write`。後者はMacの**タスク単位承認**に加え、必要なコマンド・ファイル変更ごとに**個別操作承認**が必要。 |
| 承認 | 既定は拒否。明示拒否は`DIRECT_OWNER_DECLINED`、30秒無応答は`DIRECT_OWNER_TIMEOUT`として区別（v0.1.13実機検収）。 |
| 実行履歴 | タスクID・Run ID・状態・結果をローカルSQLiteに保存。`UNKNOWN`を成功扱いせず、同じRunを無断再実行しない。 |
| 再起動 | 所有者Macのv0.1.13 Build 16では、ログイン後のDIRECT/Tunnel自動復帰と新規Codexタスク完走を確認済み。 |

**配布状況（2026-11-08）:** v0.1.13 Build 16は**所有者Macで受入PASS**していますが、GitHub Releasesでは未配布です。現在ダウンロードできるのは旧[`v0.1.9-rc.1`検証版](https://github.com/OPP-studio-macchino/theo-synapse/releases/tag/v0.1.9-rc.1)で、再起動に関する既知の問題があります。READMEの手順は、新規ユーザー・別Macでの受入試験に代わるものではありません。

### How To：MacとChatGPTから使う

**1. 必要な環境を確認する。** Node.js 24以降、公式Codex CLI、Mac用Theo Synapseアプリ、ChatGPTの対応するカスタムMCP接続、公式Secure MCP Tunnelが必要です。MacアプリだけではChatGPTの接続やTunnel認証は設定されません。

~~~sh
node --version
codex --version
codex login status
~~~

未ログインならMac本人が`codex login`を実行してください。パスワード、トークン、APIキーをChatGPTやGitHubへ貼り付けないでください。

**2. Macアプリを初期設定する。** `Theo Synapse.app`を通常起動して初期設定を行い、最初は`READONLY(8)`で状態を確認します。旧検証版のダウンロードとソースcheckoutの違いは、[英語のセットアップ手順](#setup-mac-codex-and-chatgpt)を参照してください。

**3. Secure MCP TunnelをChatGPTにつなぐ。** 本人の認証で公式OpenAI Secure MCP Tunnelを設定し、ChatGPTの**設定 → Plugins**から対応するカスタムMCP接続機能で**自分のTunnel接続先**を登録します。画面表示や利用可能な機能はアカウントによって異なります。接続直後は次のように依頼すると、Codexを起動せずに確認できます。

> Theo Synapseで`standalone_capabilities`と登録済み読み取り用プロジェクトの一覧を確認して。まだCodexタスクは開始しないで。

**4. 実際のWorkspaceはMac本人が登録する。** ChatGPTの依頼だけで任意のローカルフォルダをDIRECTへ登録することはできません。**インストール済みCore**のOwner用コマンドで登録案を表示し、確認コードと作成時刻を照合して登録・macOS本人承認を行います。

~~~sh
CORE="$HOME/Library/Application Support/Theo Synapse/core"
node "$CORE/scripts/theo-direct-workspaces.mjs" list
node "$CORE/scripts/theo-direct-workspaces.mjs" plan my-project "/absolute/path/to/project"
~~~

`my-project`とフォルダは自分のものに置換してください。登録時は`plan`が返す値を使用し、別のmacOS登録承認を行います。その後Macアプリで「DIRECTを起動」を選び、**起動についても別途本人が承認**します。

**5. ChatGPTで新しいタスクを依頼する。** 最初は`read_only`が適切です。

> Theo Synapseの承認済みWorkspace「my-project」でREADME.mdを読み取り専用で確認し、構成を説明して。ファイル変更・ネットワークは禁止。新しいタスクを開始し、返ってきた同じRun IDで結果を回収して。

変更が必要な場合は、対象ファイルと作業内容を指定して`workspace_write`を依頼します。Macでのタスク承認と、その後の個別操作承認は**それぞれ本人が判断**します。拒否や時間切れはChatGPTから解除できません。

**6. Mac CLIから実行する場合（v0.1.13のインストール済みCore）。** 指示ファイルを用意し、`review → handoff → execute`で読み取り専用タスクを実行します。`review`で出た確認コードを使い、`execute`時にもMac本人の物理承認が必要です。`status/result`は結果を読み取り専用で確認します。

~~~sh
CLI="$HOME/Library/Application Support/Theo Synapse/core/scripts/theo-local-handoff.mjs"
node "$CLI" review task-001 my-project "/absolute/path/to/instruction.txt"
node "$CLI" handoff task-001 my-project "/absolute/path/to/instruction.txt" "REVIEW_CODE"
node "$CLI" execute task-001 my-project "/absolute/path/to/instruction.txt" "REVIEW_CODE"
node "$CLI" status task-001 task-001:1 my-project
node "$CLI" result task-001 task-001:1 my-project
~~~

`task-001`、`REVIEW_CODE`、Run IDは例です。実際の返却値を使用してください。ソースcheckoutのCLIを署名済みのインストールCoreの代わりに使用しないでください。

**異常時：** 接続診断のPASSはCodexタスクの完走を意味しません。`COMPLETED`でも実際の差分やテストを必要に応じて別途確認します。`UNKNOWN`や承認不成立のRunは、同じIDで再実行せず保存結果を先に調べます。

### C2C Auto-loopとの違い

| 比較項目 | Theo Synapse | C2C Auto-loop |
| --- | --- | --- |
| 主目的 | **ChatGPTとCodexの直接接続・本人承認下での個別実行** | **実装から受入までの自律反復**（実装→テスト→修正→再テスト） |
| 依頼の単位 | 承認済みWorkspaceに対する明示的なタスクとRun ID | 目標、許可する相対パス、受入コマンド、作業予算を束ねた作業契約 |
| 自動反復 | 自律的な修正・再テストの繰り返しを中心機能とはしない | `codex_autonomous_start`で、許可範囲内なら同一作業中に修正・テスト・再修正が可能 |
| Workspace | Mac本人が実フォルダを登録・承認。`READONLY(8)`と`DIRECT(10)`を分離 | 登録済み・Owner承認済みWorkspace profileを選んで作業 |
| 書込みの境界 | `workspace_write`にはタスク単位・操作単位の別Mac本人承認 | `allowed_paths`・`acceptance_commands`・`budget_ms`等を固定し、許可外の操作を禁止 |
| 結果と証拠 | SQLiteのRun状態、結果、必要なファイル照合 | `codex_autonomous_result`の保存状態・コマンド終了コードに加え、Git差分・テスト結果を独立照合 |
| 向く作業 | 調査、単発の実Codexタスク、慎重な本人承認付き編集 | 複数工程の開発、テスト失敗時の修正、受入条件までの反復実行 |

**選び方：**「このファイルを調べる」「承認して1件を変更する」ならTheo Synapse。「この機能を実装し、テスト失敗を修正して受入まで進める」ならC2C Auto-loopが向いています。どちらも許可範囲を超える操作を自動承認しません。

**C2Cの境界：** 現在公開されているC2Cの自律実行ツールは、ネットワーク・commit・push・deploy・署名・OS変更まで自動許可するものではありません。承認済みのローカルRunが継続しても、**ChatGPT自身を自動的に呼び戻し、次の仕事を新規開始する機能は未実装**です。また、公開ツールの存在と、すべての環境での実機受入PASSは別の事実です。

この比較は現在のC2C Auto-loopの公開ツール契約を基にしています。C2CのGitHub READMEには以前の基本ブリッジ構成の説明も含まれるため、最新版の公開機能と混同しないでください。

参考： [C2C Auto-loopのリポジトリ](https://github.com/OPP-studio-macchino/codex-with-chatgpt) ／ [Theoの英語セットアップ](#setup-mac-codex-and-chatgpt)。

## Setup: Mac, Codex and ChatGPT

These steps describe the available setup paths. A fresh installation and
ChatGPT connection on a different user's Mac have **not** been independently
accepted; documentation is not a public-release test.

### Available builds (checked 2026-11-08)

- **Owner-tested:** v0.1.13 Build 16 passed installation, Mac Owner approvals,
  DIRECT(10), real Codex tasks and reboot recovery on the Owner's Mac. This
  build is **not published in GitHub Releases**.
- **Downloadable:** [v0.1.9-rc.1](https://github.com/OPP-studio-macchino/theo-synapse/releases/tag/v0.1.9-rc.1)
  is an **older pre-release**, not the current Owner-tested build. Its release
  notes document a DIRECT registration/reboot problem. Do not use it as proof
  of stable or current behavior.
- **Source checkout:** this repository contains source and tests. Cloning it
  does not install the signed Mac companion or connect ChatGPT.

### Requirements

- Apple Silicon Mac with macOS 14 or later for the published Mac build.
- Node.js 24 or later and the Codex CLI, installed and authenticated **by the
  Mac user**.
- A ChatGPT account with access to custom MCP connections and a separately
  configured **official OpenAI Secure MCP Tunnel**. Availability and setup
  depend on the account; the Mac app does not create a ChatGPT connection.

Check the local tools before starting:

~~~sh
node --version
codex --version
codex login status
~~~

If Codex is not signed in, use `codex login` on your own Mac. Never paste a
login token, API key or Tunnel credential into ChatGPT or this repository.

### Install the published Mac pre-release (optional)

Only use this procedure if you intentionally want to evaluate the older
v0.1.9 pre-release despite its known reboot issue.

1. Download the Apple Silicon ZIP and its `.sha256` file from
   [v0.1.9-rc.1](https://github.com/OPP-studio-macchino/theo-synapse/releases/tag/v0.1.9-rc.1).
2. In Terminal, run `shasum -a 256` on the downloaded ZIP and compare its
   digest with the checksum in the release. Do not install if they differ.
3. Extract the ZIP, place `Theo Synapse.app` in your own
   `~/Applications` directory, and open it normally. Do **not** bypass
   Gatekeeper or remove the app's signature.
4. Use the app's **初期設定** (initial setup) flow, then check its reported
   `READONLY(8)` status. Do not enable DIRECT or register a real project
   until you understand the separate Owner approvals.

The Mac helper does not include your Node/Codex login, Tunnel credentials,
registered projects or private task history.

### Work with the source (developer checks, not a binary install)

~~~sh
git clone https://github.com/OPP-studio-macchino/theo-synapse.git
cd theo-synapse
npm ci --ignore-scripts --no-audit --no-fund
npm run setup:readonly
npm run verify:batch
~~~

`setup:readonly` creates a private `theo-lab` demo in that source
checkout. It does **not** register a real source directory in the native Mac
app. The batch checks do not constitute a signed-app or live ChatGPT E2E.

### Connect to ChatGPT

1. Configure the **official OpenAI Secure MCP Tunnel** using your own
   authentication and its supported setup flow. The Tunnel is separate from
   the Theo Synapse app; no connection URLs, credentials or owner-specific
   profiles are shipped here.
2. In an eligible ChatGPT account, open **Settings → Plugins** and use the
   supported developer-mode/custom-MCP connection flow to connect **your
   own configured Tunnel endpoint**. Installing `Theo Synapse.app` alone
   does not add the plugin to ChatGPT.
3. In ChatGPT, select the connected Theo Synapse plugin and first request
   `standalone_capabilities` and `standalone_list_projects`. Check the
   returned project IDs and the live mode **without starting a model turn**.
   `READONLY(8)` has eight tools; Owner-enabled `DIRECT(10)` adds
   `codex_turn_start` and `codex_turn_wait`.
4. To use a **real** project with DIRECT, register its folder on the Mac
   through the Owner-local `theo-direct-workspaces.mjs` workflow. Review
   the exact folder, fingerprint and expiry, then complete its separate
   native Mac approval. Activate DIRECT from the Mac app and approve that
   action separately. ChatGPT cannot approve or register a Mac folder on
   your behalf.
5. Start a **new, read-only** Codex task against an approved workspace,
   using a new task ID. Retrieve its result with `codex_turn_wait` and the
   **same returned run ID**. A real Codex turn may use your Codex quota.

The exact local registration syntax is documented by running
`node scripts/theo-direct-workspaces.mjs` **inside an installed native
Core that contains this script**. Do not run Owner maintenance commands
against an unrelated checkout or copy someone else's registry.

See [plugin first use](docs/THEO_PLUGIN_FIRST_USE_20261029.md) and
[real-workspace registration](docs/REAL_WORKSPACE_REGISTRATION_STATUS_20261029.md)
for the source-based flow. Those dated documents describe their own
historical versions; verify the actual installed app and Core before use.

### Approval and recovery rules

- `workspace_write` needs a separate **Mac Owner task approval** and,
  when Codex asks to change files or execute a command, **one-action approval**.
  There is no persistent or blanket write grant.
- The task approval defaults to **Deny**. Explicit refusal and 30-second
  inactivity both block execution; they are recorded separately in
  v0.1.13 on the Owner's verified installation.
- If a run ends in `UNKNOWN`, do not retry that task/run ID, relabel it
  `COMPLETED`, delete its history, or bypass a denied permission. Inspect
  its persisted status before creating a **new** task.
- Do not copy a Mac Owner's Tunnel profile, credentials, SQLite history or
  registered project paths to a second computer.

## Build and safety

This repository contains reviewed source code and synthetic tests only.
It does **not** contain tokens, private key material, local credentials,
user-specific databases, Apple signing credentials, or a current signed Mac
binary in the source tree. The older v0.1.9 pre-release ZIP is hosted
separately on GitHub Releases. Do not infer public release readiness from one Owner's
local machine acceptance. Review AGENTS.md before modifications.

The signed macOS application is managed separately. Do not disable
Gatekeeper, bypass the required Mac Owner approval, or replay UNKNOWN tasks.

## Local tests

With a compatible Node.js installation, run:

```sh
npm ci
npm run verify:batch
```

See package.json and scripts for local release-specific procedures.

## Public-source sanitization

The public export substitutes generic user paths for developer machine-specific
paths and synthetic token fixtures for test literals resembling API keys.
Original local source and private backups remain unchanged. These redactions
are not authentication credentials. Some owner-specific maintenance scripts
may need local configuration before use on another Mac.
