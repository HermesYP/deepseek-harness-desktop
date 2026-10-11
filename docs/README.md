# DeepSeek Harness Desktop — Rust-core port: deliverables

A faithful desktop port of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) onto **Tauri 2 with a Rust application core**, targeting Windows.

Upstream reference: commit **`477b4f420553e8a52c2fbccc464d7561b239c443`** (`master`, `2026-09-24T21:39:59+08:00`, version `0.1.7-rc.2`), pinned checkout at [`../_upstream/`](../_upstream).

## Current acceptance first

Read [current status](../STATUS.md) and [the active repair checkpoint](repair-checkpoint-2026-10-10.md) before the historical documents below. [The implementation plan](port-fix-plan-2026-10-10.md) describes requested repairs, not executed acceptance. The [source review](commit-review-2026-10-10.md), [earlier repair ledger](repair-ledger-2026-10-10.md) and [verification report](verification-report.md) retain observations only for their recorded inputs and image hashes.

## Read in this order

| # | Document | What it is |
|---|---|---|
| 1 | [`decisions/0001-desktop-architecture.md`](decisions/0001-desktop-architecture.md) | The architecture decision, and the **verified** platform assumption (Windows 11 build 26200 x64, WebView2 153). |
| 2 | [`decisions/0002-non-rust-runtime-requirements.md`](decisions/0002-non-rust-runtime-requirements.md) | Every remaining non-Rust runtime requirement and each exception. |
| 3 | [`analysis/architecture-map.md`](analysis/architecture-map.md) | Reverse-engineered architecture map with a component diagram and ownership table. |
| 4 | [`analysis/dependency-service-inventory.md`](analysis/dependency-service-inventory.md) | Dependencies, native runtimes, Cordis services, persistence map, credential handling, license obligations. |
| 5 | [`analysis/feature-inventory.md`](analysis/feature-inventory.md) | Catalogued features with state machines and per-row status (109 rows + a 14-row UNAVAILABLE appendix — that file's own Summary is authoritative). |
| 6 | [`analysis/platform-support.md`](analysis/platform-support.md) | Upstream's own desktop target matrix and platform-exclusive constraints. |
| 7 | [`analysis/ui-inventory.md`](analysis/ui-inventory.md) | Routes, screens, dialogs, state surfaces, visual system, shortcuts and assets. |
| 8 | [`contracts/`](contracts/) | Binding interfaces: `tauri-contract.md` (UI↔Rust commands/events/errors), `desktop-shell-features.md` (native shell bridges), `ui-backend-protocol.md` (preserved RPC + WS + boot), `desktop-host-lifecycle-protocol.md` (Rust↔runtime, protocol v4). |
| 9 | [`reference-environment.md`](reference-environment.md) | Reproducible reference environment and deterministic test data. |
| 10 | [`parity-matrix.md`](parity-matrix.md) | Original behaviour → desktop implementation, with statuses. |
| 11 | [`verification-report.md`](verification-report.md) | What was executed and observed — and what was not. Includes finding F-1. |
| 12 | [`limitations.md`](limitations.md) | The complete list of remaining limitations. |
| 13 | [`build-and-install.md`](build-and-install.md) | Reproducible build, the Windows installer, and troubleshooting. |

## Source

| Path | Contents |
|---|---|
| [`../port/src-tauri/`](../port/src-tauri/) | The Rust application core: `dsh-core`, `dsh-runtime`, `dsh-gateway`, and the Tauri shell `app`. |
| [`../port/ui/`](../port/) | `port/ui/` — the preserved web client shell and the typed desktop bridge. |
| [`../port/fixtures/protocol/`](../port/) | `port/fixtures/protocol/` — canonical JSON fixtures shared by the Rust and TypeScript protocol tests. |
| [`../scripts/capture-reference.mjs`](../scripts/capture-reference.mjs) | Application-content capture harness (never desktop screenshots). |
| [`evidence/reference/`](evidence/reference/) | Reference frames, `trace.json` and `dom-snapshot.html` per run. |

## One-paragraph summary

> **Implementation status.** The Rust `app/`, `dsh-core`, `dsh-runtime` and `dsh-gateway` sources exist and compiled command handlers have scoped source/build evidence in the review and repair ledgers. That evidence does not establish native guest admission, current-image parity or release installation. [Current status](../STATUS.md) records open gates separately; the old R-01 finding remains historical in the verification report. Settings Updates activation is deferred, while the application-menu route and More > Settings fallback remain intentional.

The intended split: the desktop shell and application core are Rust — window lifecycle, tray, application menus, native dialogs, clipboard, external-link handling, quit inspection and confirmation, crash reporting and recovery, single-instance, shortcut arbitration, update presentation, the directory picker, persistent settings, OS-backed credential storage, the runtime supervisor with process-tree containment, and an authenticated HTTP + WebSocket gateway. The web client UI and the dsh agent runtime deliberately remain TypeScript — ADR 0002 explains each exception and the result is **not** claimed as fully Rust. No signed release and no update delivery are claimed. Real model calls were not made and nothing is simulated in their place.
