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

Start with [current status](STATUS.md) and [the active repair checkpoint](docs/repair-checkpoint-2026-10-10.md). They separate current source checks, exact artifact observations and installed release qualification. [The implementation plan](docs/port-fix-plan-2026-10-10.md) is not execution evidence. [The earlier repair ledger](docs/repair-ledger-2026-10-10.md), [source review](docs/commit-review-2026-10-10.md) and [verification report](docs/verification-report.md) retain historical successes **and failures**; their counts and images do not automatically accept newer bytes.

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
