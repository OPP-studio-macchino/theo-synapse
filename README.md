# Theo Synapse

Theo Synapse is a macOS companion for a ChatGPT-to-local-Codex workflow.

## Scope

- Apple Silicon / macOS SwiftUI companion.
- Direct, Owner-approved workspace tasks and per-action approval gates.
- READONLY and DIRECT managed modes.
- The Secure MCP Tunnel is a separate runtime dependency.

## Build and safety

This repository contains reviewed source code and synthetic tests only.
It does **not** contain tokens, private key material, local credentials,
user-specific databases, Apple signing credentials, or a ready-to-install
release binary. Do not infer public release readiness from one Owner's
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
