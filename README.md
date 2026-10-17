# DeepSeek Harness — native desktop application (Rust core port)

A faithful port of the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web
application into a **native desktop application**: a **Tauri 2 shell with a Rust application core**,
shipping the upstream web client with a small, version-pinned set of port patches.

This is a port, not a redesign. The user interface is upstream's own client, built with
upstream's own official build profile; the port adds account integration and Settings > Updates
patches at build time. What is new here is the desktop shell around it — window lifecycle,
process supervision, the gateway, OS credential storage, and packaging.

## Upstream provenance

- **Upstream:** `deepseek-ai/deepseek-harness`
- **Pinned commit:** `687f282e8625c6b8d11ff58211a90524be2e4317` (`0.2.1-rc.2`)
- **License:** MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Upstream's copyright and license terms apply to upstream-derived code.

This repository contains **no upstream source**. The reference checkout is an `_upstream/` clone
beside the tracked tree (git-ignored); the runtime payload the installer ships is generated from
it at build time, and the UI build also compiles upstream source through that checkout. Where
upstream code *is* reproduced — the preserved client, rebuilt with upstream's official profile and
the version-pinned port patches — it remains under upstream's license and authorship.

## Status

Start with [current status](STATUS.md) and [the active repair checkpoint](docs/repair-checkpoint-2026-10-10.md). They separate current source checks, exact artifact observations and installed release qualification. [The implementation plan](docs/port-fix-plan-2026-10-10.md) is not execution evidence. [The earlier repair ledger](docs/repair-ledger-2026-10-10.md), [source review](docs/commit-review-2026-10-10.md) and [verification report](docs/verification-report.md) retain historical successes **and failures**; their counts and images do not automatically accept newer bytes.

- The current target is upstream **0.2.1-rc.2** (`687f282e…`); the runtime lock, account/Cordis transforms and product version pins were re-materialized from a built rc.2 checkout. Installer qualification for this build is recorded in the release notes for the exact artifact.
- Rust owns the Tauri shell, credential boundary, gateway and Host supervision; the preserved client and agent runtime remain TypeScript/Node, not Rust.
- Packaging pins Node **22.20.0** through [the runtime manifest](<port/installer/node-runtime.json>), not an arbitrary system-Node fallback. Installation with system Node absent still requires disposable clean-machine qualification.
- Browser/Platform native-guest admission remains disabled. The renderer must use the real web fallback rather than advertise unusable native capabilities.
- Update delivery fails closed without packaged feed trust; no production feed, signing key, signed release or successful production update is claimed. Serving the Updates module is not proof it activates in Settings.
- No current matched native/UI parity, product performance, macOS/Linux build or clean-machine release acceptance is claimed.

See [the limitations](<docs/limitations.md>) and [binding contracts](<docs/contracts/tauri-contract.md>) for scope.

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

# Separate disposable-host release gate: only with explicit authorization
# ./port/scripts/verify-installed.ps1 -WaitSeconds 120

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
