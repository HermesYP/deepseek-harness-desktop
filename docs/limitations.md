# Remaining limitations

The complete, explicit list of what this port does not yet do. Nothing in this file is counted as complete anywhere else, and nothing here is presented as verified.

Grouped by kind. Cross-reference: [`parity-matrix.md`](parity-matrix.md) (row ids), [`verification-report.md`](verification-report.md) (§6 N-ids, §4 P-ids).

## A. Architectural — documented non-Rust exceptions

These are inherent to a fidelity-preserving port. Full rationale: [`decisions/0002-non-rust-runtime-requirements.md`](decisions/0002-non-rust-runtime-requirements.md).

| # | Limitation | Consequence | What a fix would require |
|---|---|---|---|
| A1 | The **web client UI remains TypeScript + React 18** in a system webview. | The application is **not** a fully Rust implementation and is not described as one. | A UI rewrite would necessarily change layout, animation timing, focus, selection, scrolling and text rendering — the exact fidelity the brief protects. |
| A2 | The **dsh agent runtime remains TypeScript on Node.js** as a supervised child process tree. | Agent, tools, session log, providers and persistence are not Rust. | Reproduce Cordis composition and effect semantics; reproduce `SESSION_FORMAT_VERSION` and every released migration byte-exactly; pass `test:snapshot`, both SDK expected outputs and the real-API e2e suite. |
| A3 | Non-Node foreign runtimes are still carried: `node-pty` (ConPTY), `koffi` (`MoveFileExW`), LibreOffice kit, a bundled CPython, ripgrep, pnpm, `sharp`, the Landlock/ACL sandbox addons. | Those capabilities are not Rust-owned. | Per-component reimplementation; each has data-integrity or OS-semantics consequences. |
| A4 | The Rust↔runtime control channel is a **transport substitution** (local NDJSON socket instead of Node `process.send`). | None observable — the message vocabulary and protocol generation 4 are unchanged. | None needed. Recorded as a deliberate difference (parity matrix D1). |
| A5 | The application origin is the gateway's loopback URL rather than `dsh-app://app/`. | The origin string differs; cookies, RPC and WebSocket streaming behave exactly as upstream Web. | Carry WebSocket upgrades through a Tauri custom scheme, which Tauri does not support. |

## B. Product features not ported in this pass

| # | Limitation | Original | Why deferred |
|---|---|---|---|
| B1 | **Welcome window** (600×700 entry / sign-in-status / API-key pages, Montserrat Light, macOS vibrancy or Windows acrylic with the onboarding tint, Reduce-Motion handling). | S20 | A separate top-level window with its own material and its own preload. The in-app **"Add an API key to get started"** gate *is* present and verified (report R4), so the workflow is reachable; the standalone branded window is not. |
| B2 | **Embedded Platform documents** in a partition-keyed `WebContentsView` with per-account storage isolation and cleanup-on-open/close. | S22 | Needs an embeddable browser guest view with independent storage partitions. Tauri has no equivalent surface. |
| B3 | **`<webview>` browser guests** with main-issued lease and partition, used by Sidebar Browser. | S23 | Same reason. The Sidebar Browser panel will not host arbitrary pages. |
| B4 | **Microphone permission framing** restricting audio requests to the primary application frame. | S24 | Partially covered by Tauri capability scoping; the per-frame restriction needs the `dsh-app://app` frame model of B2/B3. |
| B5 | Windows 40-DIP caption with palette-synchronised native control colours and the Application/Edit popup menus. | S15 | Window chrome is the least portable shell surface; the functional commands are reachable from the application menu. |
| B6 | **The runtime adapter carries no Office-engine resolution.** Upstream's desktop host calls `installOfficeEngineResolution(runtimeDir)` and mounts the `desktopOffice` plugin (`_upstream/apps/desktop-host/src/index.ts:21,95-99`); the port's `runtime/adapter.mjs` transcribes the other desktop-host installers but omits this one. | — | Office document conversion (`render_document`, the `office-*` skills' PDF step) will not resolve its engine under the port. The skills' authoring path is unaffected. Documented in the adapter file itself. |
| B7 | Welcome window and the standalone mandatory-update dialog documents. | S20, plus the shell-owned `dshWelcome` / `dshUpdateDialog` / `dshMandatoryUpdate` bridges. | The in-app API-key gate is present and verified (report R4); the branded standalone window and the dialog documents are not. |
| B8 | macOS and Linux code paths are `cfg`-gated but were **never compiled or run**. | — | Only `x86_64-pc-windows-msvc` is built on this machine. The portability claim is structural, not tested. |

## C. Release and distribution — blocked on credentials or infrastructure

Never claimed as delivered. See [`build-and-install.md`](build-and-install.md) §7 for the plan.

| # | Limitation | Blocker |
|---|---|---|
| C1 | **No signed release.** The Windows installer is unsigned. | SafeNet EV hardware token, PIN and certificate. |
| C2 | **No macOS release at all** (no Developer ID signing, hardened runtime, JIT entitlements, notarization, stapling). | Apple credentials and a macOS build host. |
| C3 | **No functioning update delivery.** `update_status` / `update_check` report state honestly and never pretend an update exists; there is no feed. | Bucket credentials, a published feed, and signed artifacts. |
| C4 | No PE-signature audit or Windows signature cache. | As C1. |
| C5 | No cross-target primary-runtime payload assembly (the bundled Python/Node/pnpm distributions). | Upstream: cross-target execution and signed installation require the target release host. |

## D. Verification gaps — done, but not proven against the original

| # | Limitation | Note |
|---|---|---|
| D1 | Real model streaming, tool execution, subagents, jobs and schedules were **not** exercised against a live provider. | Requires `DEEPSEEK_API_KEY` or a configured provider credential. **No model call was made and no response is simulated anywhere in the port.** |
| D2 | Linux behaviour is unverified and Linux desktop parity is **unmeasurable**. | Upstream ships no Linux desktop release, so no original exists to compare against. The port is kept portable; it is not claimed as Linux-parity. |
| D3 | macOS behaviour is coded behind `cfg` gates but was never observed. | No macOS host was available. |
| D4 | Office document conversion and the `office-*` skills were not exercised end to end. | Depends on C5. |
| D5 | Computer-use and browser-use were not exercised. | Depend on external driver credentials and on B2/B3. |
| D6 | Windows installer qualification (`smoke-windows.ps1`, `test:installer`) was not run. | Needs pinned NSIS/7-Zip plugin tooling and an interactive desktop. A clean-machine install test is specified in `build-and-install.md` §5 and must be run before any release. |
| D7 | **No end-to-end run against the real Node host and a real WebView2 window.** | The Rust suite used a fake host plus HTTP-level tests. The gateway, supervisor and marker injection have never been exercised together against the actual `dsh` runtime in a live window. This is the largest remaining verification gap. |
| D8 | Gateway HTTP/WebSocket integration tests and full-workspace `clippy -D warnings` were failing at the time of the implementation report. | See `verification-report.md` §4 rows P2 and P3 for the current authoritative result. Do not treat the gateway's streaming path as verified until they are green. |

## E. Known rough edges

| # | Limitation | Note |
|---|---|---|
| E1 | Five of nineteen capture steps per run record an `actionError` and no DOM facts. | The error text is kept in `trace.json` rather than the row being dropped, so the gap is visible. Cause (corrected per review finding R-07): the modal overlay mask intercepts pointer events, so clicks behind it never land — several steps never got past the modal. |
| E2 | The reference version badge reads `0.1.7-rc.2-477b4f4-dirty`. | `pnpm install` / `pnpm run build` write artifacts into the reference checkout. Cosmetic. |
| E3 | The parity matrix's status column is only authoritative after the acceptance pass updates `verification-report.md` §4. | Any row still reading `specified` is **not** `verified`. |

## F. Honesty constraints stated for the record

- This port is **not** a fully Rust implementation. The UI and the agent runtime are TypeScript; ADR 0002 names every exception and its reason.
- **No signed releases and no functioning update delivery** are claimed.
- **No feature is a placeholder**, and no button is dead: anything not implemented is listed here or absent from the UI. Where a desktop capability cannot be reached in a given build, the failure is reported rather than silently swallowed.
- **No unavailable reference behaviour is marked verified.** Blocked checks are excluded from every completion claim.
- During this work the lead made one unintended write into the live harness home on this machine. It is fully accounted for in [`verification-report.md`](verification-report.md) §5 (finding F-1): one benign scaffold file created, one timestamp refreshed, no credentials, sessions, logs or settings altered, and the running harness on port 3080 was never disturbed.
