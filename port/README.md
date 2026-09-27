# DeepSeek Harness Desktop — Rust-core port

This directory is the desktop port of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) onto **Tauri 2 with a Rust application core**.

Read these first:

- [`../docs/decisions/0001-desktop-architecture.md`](../docs/decisions/0001-desktop-architecture.md) — why this shape, and the verified platform assumption.
- [`../docs/decisions/0002-non-rust-runtime-requirements.md`](../docs/decisions/0002-non-rust-runtime-requirements.md) — the complete list of things that are deliberately **not** Rust, with reasons.
- [`../docs/contracts/`](../docs/contracts/) — the binding interfaces.
- [`../docs/parity-matrix.md`](../docs/parity-matrix.md) — original behaviour mapped to desktop implementation, with statuses.

## Layout

```text
port/
  src-tauri/           Rust workspace (the application core)
    crates/
      dsh-core/        paths, settings, credentials, diagnostics, protocol types
      dsh-runtime/     host process supervision, control channel, tree cleanup
      dsh-gateway/     loopback HTTP + WebSocket gateway to the supervised host
    app/               the Tauri shell: window, tray, menus, dialogs, commands
  fixtures/protocol/   canonical JSON fixtures shared with the TypeScript mirror
  ui/                  the preserved upstream web client shell + desktop bridge
  scripts/             build, packaging and verification helpers
  tests/               end-to-end and interface tests
```

## What is Rust and what is not

| Layer | Language | Why |
|---|---|---|
| Desktop shell (window lifecycle, tray, menus, native dialogs, clipboard, external links, quit confirmation, crash recovery, update presentation) | **Rust** | This is the application layer the port rewrites. |
| Application core (paths, persistent settings, OS-backed credential storage, diagnostics and crash reports, cancellation, single-instance, quit model, protocol types) | **Rust** | Backend responsibilities and application orchestration moved out of JavaScript. |
| Runtime supervision (spawn/monitor/stop the host process tree, control channel, Job-Object tree containment) | **Rust** | Application orchestration. |
| Loopback gateway (authenticated reverse proxy for the application HTTP API and WebSocket stream) | **Rust** | Replaces Electron's `dsh-app://app/` request forwarding. |
| Web client UI | TypeScript/React (unmodified upstream) | Fidelity. Rewriting it in Rust would change rendering, which the brief forbids. |
| dsh agent runtime | TypeScript/Node.js (unmodified upstream) | 55 Cordis package groups, a Python runtime and several native addons. See ADR 0002. |

This is therefore **not** a fully Rust implementation and is not described as one.

## Build

See [`../docs/build-and-install.md`](../docs/build-and-install.md) for the reproducible build, the Windows installer, and troubleshooting.
