# Port DeepSeek Harness to a native desktop application with a Rust core

## Summary

This changeset adds a **native desktop application** for the DeepSeek Harness, built as a **Tauri 2 shell with a Rust application core**, while **preserving the original web client byte-for-byte**.

It is a port, not a redesign. The original frontend is shipped unchanged; the desktop shell, the process supervision, the gateway, the credential storage and the packaging are new Rust.

- **Upstream reference:** `deepseek-ai/deepseek-harness` at commit `477b4f420553e8a52c2fbccc464d7561b239c443` (`0.1.7-rc.2`, MIT).
- **Primary target:** Windows x86_64 (verified end to end). macOS and Linux paths are `cfg`-gated and **have never been compiled**.
- **~130 source files, ~20,000 lines** of new code (Rust, TypeScript, PowerShell), plus 19 documents.

## Motivation

The original desktop app is Electron (`apps/desktop`) with a Node orchestration entry (`apps/desktop-host`). This ports that surface to a Rust core so the application can own its own lifecycle, process containment, credential storage and packaging natively, without changing what the user sees.

## Architecture

The window loads a **loopback gateway origin** rather than a Tauri custom scheme, because custom schemes cannot carry WebSocket upgrades and the client depends on a mux WebSocket.

| Component | Path | Responsibility |
|---|---|---|
| `dsh-core` | `port/src-tauri/crates/dsh-core` | Desktop paths, settings persistence, OS credential storage (keyring), diagnostics and crash reports, cancellation, single-instance lock, quit model, protocol types, shortcuts engine, **desktop profile initialisation** |
| `dsh-runtime` | `port/src-tauri/crates/dsh-runtime` | Host supervision, the generation-4 NDJSON control channel, process containment (Windows Job Object / process group) |
| `dsh-gateway` | `port/src-tauri/crates/dsh-gateway` | BrowserAuth (one-time launch token → HMAC-signed, authority-bound cookie), shell asset serving, HTTP proxy with response-header handling, transparent WebSocket relay, Host readiness gating |
| `app` | `port/src-tauri/app` | Tauri shell: 34 commands, 10 `dsh://` events, DOM markers, tray, menus, window chrome, update flow, NSIS packaging |

### Composition and registration

- The desktop profile is **created by the shell before the Host is spawned**, is idempotent, and **never overwrites existing files**, so a user's edited `cordis.patch.yml` survives every launch.
- The preserved client is consumed through upstream's own **official client build profile** (`DSH_CLIENT_BUILD_PROFILE=official`), so the sidebar renders the official mark and name.
- The runtime payload is the **same materialised tree the installer ships** (12,305 files, 0 reparse points, deepest path 234 chars, `.pnpm` absent, four anchors real directories) and is produced through upstream's own packaging pipeline.

## What is delivered

**Application lifecycle and shell**
- Frameless window with **port-drawn chrome**: drag region, minimise / maximise / close, eight resize grips, and theme-tracking caption colours sampled from the client's own design tokens and updated live via a `MutationObserver`.
- Tray, application menu, native dialogs, clipboard, external links.
- Persistent settings; recoverable window state.
- Cancellation, subprocess containment, and clean shutdown with a **quit-inspection handshake** so the app refuses to close under running work.
- Diagnostics and crash reports that embed the **Host's own stderr**, which is what made several failures diagnosable in one read.

**Fidelity**
- **128 of 196** upstream `apps/web/dist` files remain **byte-identical**; the remainder are sourcemaps, content-hashed asset names, `index.html` (expected: official title) and one absent `preview.html`.
- The mux WebSocket, index boot contract, packaged assets and the 401/303/cookie authentication boundary all verified against a running instance.

**Packaging**
- NSIS installer (~89 MB) carrying the full runtime payload, icons, metadata and versioning.

## Verification

| Check | Result |
|---|---|
| `cargo test --workspace` | passing (97 tests at the time of writing, plus added suites) |
| `cargo clippy --workspace --all-targets -- -D warnings` | clean |
| UI typecheck + unit tests | clean, 72 tests |
| Rust protocol fixtures | 12/12 |
| Gateway unit + integration suites | 5 + 4 passing |
| **Installed acceptance, no development overrides** | **18 PASS / 0 FAIL / 0 SKIP** |
| Mount check over CDP against the real WebView2 | workspace renders; 0 console errors |

The installed acceptance runs the built installer, installs it, and launches it with **no `DSH_DESKTOP_*` overrides**, asserting the layout, the absence of reparse points, host readiness and the authentication boundary.

## Known limitations and deliberate deviations

These are recorded honestly rather than hidden. Full detail in `docs/verification-report.md` (42 findings) and `docs/limitations.md`.

1. **Not a fully Rust application.** The UI and the agent runtime are TypeScript. Rationale in `docs/decisions/0002-non-rust-runtime-requirements.md`.
2. **Requires a system Node.js on `PATH`.** The installer is not yet self-contained.
3. **Unsigned.** No signing credentials were available; no signed release is claimed.
4. **No update delivery.** The update flow is implemented and proven (channel persists across a restart, honest "no feed configured" state, SHA-256 verification), but no feed or signing key is provisioned, so nothing is delivered.
5. **`DESKTOP_PROFILE_BUNDLES` extends upstream's `WEB_PROFILE.bundles`**, which is a deliberate, documented divergence with a maintenance cost.
6. **Dropped files are uploaded, not referenced by path.** Tauri's WebView exposes no filesystem path for a JS `File`; the client takes its own supported upload fallback and **no inaccurate shim is set**.
7. **macOS and Linux are uncompiled.** The upstream project ships no Linux desktop at all.
8. **Updates-in-Settings is not delivered.** The plugin builds and ships but the Host never serves its client bundle (recorded as F-47 with the full diagnosis).
9. **One crash-report field renders `[object Object]`.** This is upstream's own behaviour in a byte-identical preserved file and was deliberately left unchanged.

## Documented incidents

Two unintended writes occurred during development and are recorded with remediation, not omitted: one created a benign scaffold file in a live harness home (F-1), and one wrote five artifacts into a user home directory because PowerShell's read-only `$HOME` silently rejected an assignment (F-36). Both were cleaned up; the second produced a rule now enforced when launching — **assert the resolved `DSH_HOME` before starting the application**.

## How to build and verify

```powershell
# 1. Build the preserved client, the runtime payload, and the installer
./port/scripts/build.ps1 -Stage all

# 2. Installed acceptance: installs and launches with no overrides
./port/scripts/verify-installed.ps1 -WaitSeconds 120

# 3. Development launch with the boot handoff
./port/scripts/dev-e2e.ps1 -Verify
```

Runtime tests require an isolated `DSH_HOME`; never point a test at a live harness home.

## Review notes

The verification report is deliberately blunt about its own errors: it records the false greens and false reds produced by the project's own tooling, including a build helper that aborted successful builds, a probe that measured the wrong window handle, and a mount check that asserted a control existed while it was off-screen and unclickable. Read `docs/verification-report.md` section 3 before trusting any single check in this repository.
