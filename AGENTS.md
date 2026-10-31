# Theo Synapse workspace guide

## Roles and scope

- Theo Synapse is the ChatGPT plugin.
- ChatGPT plans and reviews; Codex implements and tests end-to-end.
- Treat routine work as functional completion, not a chain of microtasks.
- Do not register `chappy-signal` as a direct workspace.
- Keep changes focused; do not introduce product architecture or workflow gates
  unless the requested work requires them.

## Preserve the local installation

- Preserve code signatures, notarization, existing runtime state, and credentials.
- Do not edit signed applications in `~/Applications` or data in
  `~/Library/Application Support` unless the owner explicitly asks for a
  deployment operation.
- Preserve unrelated user edits and never initialize, reset, clean, or assume a
  Git repository exists.
- Do not change permission policy or work around a denied operation.

## Development and testing

- Source entry points are `scripts/theo-task-entry.mjs` and
  `scripts/theo-direct-daemon-entry.mjs`.
- The package test command is `npm test` (`node --test test/*.test.mjs`).
- For focused direct/IPC work, use the existing targeted tests, for example:
  `node --test test/direct-coordinator.test.mjs test/direct-workspace-registry.test.mjs test/direct-stdio-gate.test.mjs test/direct-native-host-entry.test.mjs test/runtime-daemon.test.mjs`.
- Check changed executable JavaScript with `node --check PATH`.
- Do not run a real Codex model turn, show a Mac approval dialog, or mutate a
  live service, registry, tunnel, plugin, or credential unless explicitly
  requested.

## Handoff quality

- Report code completion, tests actually run, deployment state, and user
  acceptance as separate facts.
- Source test counts do not prove that a signed installed companion or live
  service completed a task.
- State observed errors exactly. Do not replace evidence with blanket
  speculation about Pro-plan limits or plugin writes.
