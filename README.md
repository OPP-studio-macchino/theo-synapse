# Theo Synapse

Theo Synapse connects ChatGPT to local Codex on macOS. The ChatGPT plugin is the interface; the macOS app manages its local host.

## Scope

- Apple Silicon / macOS SwiftUI companion.
- Direct, Owner-approved workspace tasks and per-action approval gates.
- READONLY and DIRECT managed modes.
- The Secure MCP Tunnel is a separate runtime dependency.

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
