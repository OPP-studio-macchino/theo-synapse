# Theo Synapse plugin — first use (native Core)

Product: **Theo Synapse**. As of 2026-10-31, one official Owner-approved single-file write E2E passed through the signed v0.1.5 Core. That evidence is scoped to the approved run; it does not automatically enable a new plugin schema, change an account/workspace policy, or prove a future connection. The optional Mac helper is local-only and is not proof that ChatGPT is connected.

1. Install the signed/notarized Mac helper if desired, then install its native Core. The default locations are `~/Applications/Theo Synapse.app` and `~/Library/Application Support/Theo Synapse/core`. Authenticate Node/Codex yourself; do not paste, copy, or expose credentials in chat.
2. Configure the official OpenAI Secure MCP Tunnel in its supported developer-mode/connector flow. Supply the official runtime API key only as its file reference; do not copy key or profile contents into this repository, the native Core, or chat. Confirm that the intended ChatGPT plan is eligible for the connector.
3. Run the local, read-only readiness check. It does not start a daemon, task, model turn, or tunnel, and never reads legacy Standalone configuration:

```sh
npm run doctor:native-plugin
```

For an isolated native install, explicitly supply `--native-core` and `--app`. To request the optional official control-plane poll, supply only the health URL file reference plus `--require-control-plane-poll`; the doctor invokes `tunnel-client health --url-file … --require-control-plane-poll --json` and emits no tool output or secret value.

```sh
node scripts/theo-native-plugin-doctor.mjs \
  --native-core /safe/native/core --app "/safe/Theo Synapse.app" \
  --health-url-file /safe/official-health-url --require-control-plane-poll
```

`LOCAL_TUNNEL_READY_CHATGPT_E2E_REQUIRED` means local Core and requested tunnel health are ready, **not** that ChatGPT-side E2E has been proven. Finish in ChatGPT developer mode by connecting the official connector and listing its tools. Do not use first-use to activate, refresh, or work around a denied plugin schema/write policy. No credential migration, legacy registration, or `chappy-signal` import is part of first use.

If no health URL file is provided, the doctor reports `SETUP_REQUIRED`/`NOT_CHECKED`; it never treats this as tunnel or ChatGPT success. The native private registry must contain `theo-lab`; additional explicitly Owner-approved native projects are allowed. `chappy-signal` remains in legacy only and is forbidden in native Core.

The source-only v0.1.6 candidate adds an opt-in Owner-managed direct daemon that starts at login only after explicit registration and a separate start confirmation. It is not signed, installed, or reboot-tested. Until that candidate is independently installed and accepted, a manually launched direct daemon has no persistence guarantee and is intentionally not managed by the app.
