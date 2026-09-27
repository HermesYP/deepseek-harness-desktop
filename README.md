# DeepSeek Harness — native desktop application (Rust core port)

A faithful port of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web
application into a **native desktop application**: a **Tauri 2 shell with a Rust application core**,
shipping the **original web client unchanged**.

This is a port, not a redesign. The user interface you see is upstream's own client, built with
upstream's own official build profile; what is new here is the desktop shell around it — window
lifecycle, process supervision, the gateway, OS credential storage, and packaging.

## Upstream provenance

- **Upstream:** `deepseek-ai/deepseek-harness`
- **Pinned commit:** `477b4f420553e8a52c2fbccc464d7561b239c443` (`0.1.7-rc.2`)
- **License:** MIT — upstream's copyright and license terms apply to upstream code.

This repository contains **no upstream source**. The reference checkout lives in a sibling
`_upstream/` clone that is deliberately excluded from version control, and the runtime payload the
installer ships is generated from it at build time. Where upstream code *is* reproduced — the
preserved client, rebuilt with upstream's official profile — it remains under upstream's license and
its authorship.

## Status

Verified working, end to end on Windows x86_64:

- Installs from an NSIS installer and launches with **no development overrides**
  (**18 PASS / 0 FAIL / 0 SKIP** on the installed-acceptance harness).
- Host reaches readiness; gateway enforces the 401/303/cookie authentication boundary; the mux
  WebSocket upgrades.
- The preserved client mounts and renders its workspace in the real WebView2, with **128 of 196**
  upstream `apps/web/dist` files still **byte-identical**.
- Frameless port-drawn window: drag region, minimise / maximise / close, eight resize grips
  (**resize verified by `WM_NCHITTEST`**), and caption colours that track the client's own theme
  tokens live.
- Desktop profile is created by the shell before the Host spawns, is idempotent, and **never
  overwrites existing files** — a user's edited `cordis.patch.yml` survives every launch.

Not delivered, and stated plainly:

- **Not a fully Rust application.** The UI and the agent runtime are TypeScript.
- **Requires a system Node.js on `PATH`** — the installer is not yet self-contained.
- **Unsigned.** No signed release is claimed.
- **No update delivery.** The flow is implemented and proven, but no feed or signing key is
  provisioned.
- **macOS and Linux are uncompiled.** Upstream ships no Linux desktop at all.
- **Updates-in-Settings** builds and ships but is not yet served by the Host (see finding F-47).

The full, deliberately blunt account — including this project's own false greens and false reds — is
in [`docs/verification-report.md`](docs/verification-report.md) (42 findings) and
[`docs/limitations.md`](docs/limitations.md).

## Layout

```
port/src-tauri/crates/dsh-core      paths, settings, OS credentials, diagnostics, cancel,
                                    single-instance, quit model, protocol types, shortcuts,
                                    desktop profile initialisation
port/src-tauri/crates/dsh-runtime   host supervision, NDJSON control channel, process containment
port/src-tauri/crates/dsh-gateway   BrowserAuth, shell serving, HTTP proxy, WebSocket relay
port/src-tauri/app                  Tauri shell: commands, events, markers, tray, menus, chrome
port/ui                             preserved client shell + typed desktop bridge (TypeScript)
port/scripts                        build + acceptance harnesses (PowerShell)
port/fixtures                       protocol fixtures
docs                                analysis, contracts, decisions, verification, limitations
```

## Build and verify

```powershell
# Reference client (once): build the pinned upstream checkout
#   _upstream: pnpm install; pnpm run build

# Build the preserved client, the runtime payload, and the Windows installer
./port/scripts/build.ps1 -Stage all

# Installed acceptance: installs and launches with NO overrides
./port/scripts/verify-installed.ps1 -WaitSeconds 120

# Development launch, with the boot handoff and assembled-flow checks
./port/scripts/dev-e2e.ps1 -Verify
```

Always run the application against an **isolated** `DSH_HOME`; never point a test at a live harness
home. The scripts do this themselves.

## Read this before trusting a check

This project's recurring lesson is recorded in the verification report because it is the most useful
thing in it: **no passing build, suite, guard, probe or harness ever meant the product worked.** A
gateway suite passed with a broken WebSocket; an installer build passed with an application that
could not boot; two of the project's own guards gave false greens and one probe gave a false
positive on known-good code. Sections 3 and 6 of the report list, by finding, which conclusions came
from instrumenting a running system and which came from reasoning about code that had never run.
