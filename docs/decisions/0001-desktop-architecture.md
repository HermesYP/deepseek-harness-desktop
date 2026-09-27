# ADR 0001 — Desktop architecture for the Rust-core port of DeepSeek Harness

Status: accepted

## Reference

Upstream repository `https://github.com/deepseek-ai/deepseek-harness`, reference commit `477b4f420553e8a52c2fbccc464d7561b239c443` (`master`, tag family `dsh-v0.1.7-rc.2`, root package version `0.1.7-rc.2`), pinned checkout at `_upstream/`.

## Platform assumption — verified, not assumed

The brief names Windows as primary and asks that the assumption be verified before platform-exclusive decisions.

| Check | Result | Evidence |
|---|---|---|
| Build host OS | Microsoft Windows 11 Home Single Language, 10.0.26200, 64-bit | `Win32_OperatingSystem` |
| Rust target | `x86_64-pc-windows-msvc`, rustc 1.97.1 | `rustup show` |
| WebView2 Runtime | Microsoft Edge WebView2 Runtime 153.0.4234.48 present | `HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` |
| Node toolchain | node v25.4.0 (inside the declared `^22.19.0 \|\| >=24.0.0` engines range), pnpm 11.7.0 (the declared `packageManager`) | `node --version`, `pnpm --version` |
| Upstream desktop target matrix | `win-x64`, `mac-arm64`, `mac-x64`. Upstream states "Linux is not a supported Desktop release target." | `_upstream/apps/desktop/README.md`, `_upstream/package.json` `package:desktop:*` scripts |

Conclusion: Windows x64 is the correct primary target and is directly comparable against upstream, because upstream ships a Windows build. macOS is comparable (upstream ships it). Linux is **not** comparable against an upstream desktop release, because upstream ships none; Linux parity can only be measured against upstream's Web application. The port therefore treats macOS and Linux as portable-but-not-parity-verified targets and says so in the parity matrix.

## The decision

Port the desktop application to **Tauri 2 with a Rust application core**, and preserve the original frontend framework, components, styles, fonts, icons, assets, layout and rendering behaviour unchanged.

The Rust core replaces both of the upstream desktop layers:

1. `apps/desktop` — the Electron shell (main process, preloads, renderer chrome). This is the majority of the Rust work.
2. `apps/desktop-host` — the Node orchestration entry that launches the shared profile runner, negotiates the lifecycle protocol with the shell, and installs quit inspection, update-task control, platform-session publishing and Office engine resolution.

What is **not** rewritten is stated in ADR 0002.

## Why Tauri 2 first

The brief asks for Tauri 2 with a Rust core to be evaluated first. It is selected because:

- It is the only mainstream shell that puts the application core in Rust while keeping a system webview, which is exactly the "Rust application core, preserved frontend" shape the brief demands.
- WebView2 is present on the target machine and is redistributable on Windows, so the primary target has no runtime acquisition problem.
- `tauri-bundler` produces the required Windows NSIS installer with icons and metadata, satisfying the installer requirement without Electron.
- Tauri's `#[tauri::command]` surface and event system give the typed UI↔Rust channel the brief asks for.

Electron was rejected as the port target because it would leave the application core in JavaScript/TypeScript and would contradict "a Rust application core".

## Component shape

```text
+--------------------------------------------------------------+
|  dsh-desktop (bin)  — Tauri 2 shell, Rust                     |
|  window lifecycle, tray, application menus, native dialogs,   |
|  clipboard, external links, quit confirmation, DevTools,      |
|  caption/menus, update presentation, crash recovery dialog    |
+-----------------------+--------------------------------------+
                        |  typed #[tauri::command] + tauri events
+-----------------------v--------------------------------------+
|  dsh-core (lib) — Rust application core                       |
|  paths, persistent settings, OS credential store, diagnostics |
|  + crash reports, cancellation, single-instance, quit model,  |
|  protocol types, error taxonomy                              |
+-----------------------+--------------------------------------+
                        |
+-----------------------v--------------------------------------+
|  dsh-runtime (lib) — Rust runtime supervisor                  |
|  spawn/monitor/stop the dsh host process tree, control        |
|  channel, health, Job-Object tree containment, clean shutdown |
+-----------------------+--------------------------------------+
                        |  NDJSON control channel (local socket)
                        |  + the preserved HTTP/WebSocket RPC
+-----------------------v--------------------------------------+
|  dsh host runtime  [NON-RUST EXCEPTION — see ADR 0002]        |
|  unmodified upstream Cordis profile runner (Node.js/TS)       |
+--------------------------------------------------------------+
```

The UI in the webview is the unmodified upstream web client [NON-RUST EXCEPTION — see ADR 0002].

## UI ↔ Rust transport

Typed Tauri commands and events, as the brief prefers.

The upstream desktop already demonstrates a concrete second transport: the browser client reaches the agent runtime over an authenticated HTTP API plus WebSocket streaming (`packages/client/connection`, `packages/api`), and the Electron shell reaches the host over a Node-IPC lifecycle channel (`apps/desktop/src/host-process.ts`). Both are preserved as transports to their existing endpoints, because replacing either would change streaming, tool-call and session-event semantics rather than merely relocating them.

- UI ↔ Rust: Tauri `invoke` commands and `emit` events. This is new and is the port's own contract (`docs/contracts/tauri-contract.md`).
- UI ↔ agent runtime: the preserved upstream authenticated HTTP + WebSocket protocol, unchanged (`docs/contracts/ui-backend-protocol.md`).
- Rust ↔ host process: the preserved upstream Desktop-Host lifecycle message vocabulary over a local NDJSON control socket (`docs/contracts/desktop-host-lifecycle-protocol.md`).

## Deliberate difference: control-channel transport

Upstream carries the Desktop-Host lifecycle protocol over Node's `process.send` IPC channel. A Rust parent process has no Node IPC stack. The port carries the **identical message vocabulary and protocol generation 4** over a local socket (named pipe on Windows, Unix domain socket on macOS/Linux) speaking newline-delimited JSON.

This is a transport substitution only. Message names, field names, direction, ordering and failure behaviour are unchanged. It is recorded in the parity matrix as a documented difference rather than a parity loss.

## Deliberate difference: application origin

Upstream serves the packaged web entry from the `dsh-app://app/` custom scheme and forwards application HTTP requests to the authenticated host. Tauri custom schemes cannot carry WebSocket upgrades, and the client's streaming channel is a WebSocket. The port therefore navigates the window at the host's authenticated loopback URL, which is what the same code already does in upstream Web mode.

Consequence: the application origin is `http://127.0.0.1:<port>` instead of `dsh-app://app/`. Cookies, WebSocket streaming, and the authenticated RPC are then identical to upstream Web. The desktop markers that upstream's preload publishes are supplied by the Rust core through Tauri initialization scripts instead of an Electron preload (`docs/contracts/tauri-contract.md`).

## Non-goals

- No redesign of any screen, control, copy string, icon, font, spacing, colour or animation.
- No replacement of the UI framework.
- No claim of a fully Rust implementation while the frontend and the agent runtime remain non-Rust.
