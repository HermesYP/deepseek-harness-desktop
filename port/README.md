# DeepSeek Harness Desktop — Rust-core port

This directory is the desktop port of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
onto **Tauri 2 with a Rust application core**, preserving the upstream React web client and the upstream
Node.js agent Host.

Read these first:

- [`../docs/decisions/0001-desktop-architecture.md`](../docs/decisions/0001-desktop-architecture.md) — why this shape, and the verified platform assumption.
- [`../docs/decisions/0002-non-rust-runtime-requirements.md`](../docs/decisions/0002-non-rust-runtime-requirements.md) — every component that is deliberately **not** Rust, with reasons and `_upstream` citations.
- [`../docs/contracts/`](../docs/contracts/) — the binding interfaces.
- [`../docs/implementation-plan.md`](../docs/implementation-plan.md) — the workstreams, milestones and the definition of done.

## RC.2 upgrade — 2026-10-17

The port now targets upstream `0.2.1-rc.2` (tag `dsh-v0.2.1-rc.2`, commit
`687f282e8625c6b8d11ff58211a90524be2e4317`). The runtime lock was re-materialized
from a built rc.2 checkout, the account/Cordis transformations were re-anchored,
and the repository hygiene fixes (evidence removal, LICENSE/NOTICE, CI gate) are
part of the same line. Installer qualification for this build is recorded in the
release notes for the exact artifact; this section alone is not acceptance.

## Alpha.3 core end-to-end acceptance — 2026-10-15

The [public qualification report](<../docs/releases/desktop-v0.2.1-alpha.3-port.20261015.1.md>) records a rebuilt `0.2.1-alpha.3` Windows app, successful real NSIS packaging, full installed resource SHA-256/physical qualification, and human-confirmed sign-in through the normal browser profile, real chat, terminal, sidebar collapse/reopen and restart persistence. Actual isolated install and preservation-mode uninstall completed; both original registry leaves were exactly restored after a documented PowerShell stderr-wrapper recovery. Shortcut, jump-list and product-autostart inventories were unchanged. Authenticated owned profiles were retained.

This is an **unsigned prerelease core-flow qualification**, not a default-path production deployment, clean-machine test, in-place upgrade, automatic-update qualification or universal feature acceptance. The isolated test installation was removed as approved. Do not run the installer as an unqualified upgrade over the restored legacy registration; see the report's deployment boundary and artifact hashes.

## Historical repair checkpoint — 2026-10-12

The [Updates repair](../docs/updates-repair-2026-10-12.md) adds the port plugin to the desktop composition while retaining Account and its Settings launcher. Production-loader composition, staged Host serving and real Cordis registration pass. The page reads packaged update configuration through the native bridge, explains disabled delivery, retries failed metadata reads and does not report a fresh idle process as up to date. Native visual acceptance and installed upgrade qualification remain open; no production release source is packaged.

The [latest sign-in repair](../docs/desktop-signin-repair-2026-10-12.md) adds the native authorization-browser launcher and directs desktop PKCE callbacks to the existing Host listener. The [account-data repair](../docs/account-data-analysis-2026-10-12.md) preserves results and pending reads across same-login notifications, clears them on credential changes, and adds explicit failure reasons and Retry. A fresh test-account PKCE exchange succeeds, and an isolated native debug app visibly displays the account contact and `$0.00` balance; Get started saves successfully. The latest onboarding Add credits browser fallback passes the actual component test but still needs native visual acceptance. Direct Node profile refresh returns refused HTML, so a durable profile transport remains unresolved; the valid exchange and grant-bound cache supply identity in the live test. The 1.5-second startup target is not met. Production browser/platform guest admission remains disabled. The [older repair ledger](../docs/repair-ledger-2026-10-10.md) is historical evidence; each portable's build receipt identifies its actual bytes and acceptance limits.

Run the [qualification gate](tests/run-verification-gate.ps1) with an explicitly attested pinned Node **22.20.0**. It checks parent/image/child integrity and owned write/pipe/sentinel/watchdog probes before native helpers, requires nonempty counts, and reports SKIP/unknown visibility as non-pass. A trusted plain copy outside a Low workspace must preserve content hashes; never repair trust by recursive relabel/ACL reset. DEBUG credential tests require the explicit per-run UUID and compile-time owned scratch fence; home redirection alone does not isolate the shared OS store.

## Baseline

| | Value |
|---|---|
| Supported target revision (what the port stages from and carries) | `687f282e8625c6b8d11ff58211a90524be2e4317`, tag [`dsh-v0.2.1-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2), root package version `0.2.1-rc.2`, pnpm `11.28.5` |
| Recorded target descriptor | [`scripts/lib/target-release.mjs`](scripts/lib/target-release.mjs) — the one recorded identity, with a fail-closed probe that validates any checkout against it |
| Upstream checkout | explicit input, defaulting to `_upstream/`; `-UpstreamRoot <path>` or `$env:DSH_UPSTREAM_ROOT` selects an externally owned checkout. **Read-only either way; nothing under it is ever edited** |
| Previous reviewed revision | `477b4f420553e8a52c2fbccc464d7561b239c443`, tag `dsh-v0.1.7-rc.2` |

The product version pins (`port/src-tauri/app/tauri.conf.json`, `port/src-tauri/Cargo.toml` and its lockfile, `port/fixtures/protocol/app-info.json`, the port-owned UI packages) are at `0.2.1-rc.2`.

**What is recorded, and what is still not claimed.** The staged runtime payload
(`port/runtime-payload/dsh/package.json`), the reviewed runtime-lock descriptors under
`port/runtime-locks/` (`win-x64`, `REVIEWED` at the recorded `upstreamCommit`), and the account
transformation reviews (`port/scripts/lib/account-*-runtime.mjs`) are recorded at this release
(`0.2.1-rc.2`) after re-materialization from a *built* checkout of the recorded target
(sources alone are not enough: the transforms hash reviewed blocks of emitted `lib/`, and the lock
refresh consumes the target's own pnpm `11.28.5`). The account transforms refuse unreviewed
versions and emitted shapes, so a payload requires a matching transformation review. See
[the alpha.2 upgrade record](../docs/harness-upgrade-0.2.1-alpha.2.md) for the previous revision's
drift inventory. Recording version pins alone is not acceptance: the rebuilt alpha.3 artifact now has
the scoped core-flow qualification recorded above, while installed upgrade and other explicitly listed
release gates remain open. No parity with the target is claimed for an artifact not rebuilt from it.

## Layout

```text
port/
  src-tauri/           Rust workspace
    crates/
      dsh-core/        paths, settings, credentials, diagnostics, protocol types, shortcuts, profile
      dsh-runtime/     host process supervision, control channel, tree cleanup
      dsh-gateway/     loopback static/HTTP gateway to the supervised host
    app/               the Tauri shell: window, tray, menus, dialogs, commands, guests, updater
    runtime/           adapter.mjs — the single Node touch-point of the Rust port
  installer/           NSIS hooks, localized installer strings, pinned Node manifest
  runtime-payload/     the staged supervised runtime (build output; gitignored)
  fixtures/protocol/   canonical JSON fixtures shared with the TypeScript mirror
  ui/                  the preserved upstream web client shell + desktop bridge
  scripts/             build, verification and benchmark helpers
  tests/               packaging and parity-gate tests
```

## What is Rust and what is not

| Layer | Language | Why |
|---|---|---|
| Desktop shell (window lifecycle, tray, menus, native dialogs, clipboard, external links, quit confirmation, crash recovery, update presentation) | **Rust** | This is the application layer the port rewrites. |
| Application core (paths, persistent settings, OS-backed credential storage, diagnostics and crash reports, cancellation, single-instance, quit model, protocol types, profile initialisation) | **Rust** | Backend responsibilities and application orchestration moved out of JavaScript. |
| Runtime supervision (spawn/monitor/stop the host process tree, control channel, tree containment) | **Rust** | Application orchestration. |
| Loopback gateway (authenticated static/HTTP surface for the preserved client) | **Rust** | Replaces Electron's `dsh-app://app/` request forwarding. |
| Web client UI | TypeScript/React (preserved upstream, rebuilt unmodified) | Fidelity. Rewriting it in Rust would change rendering, which the brief forbids. |
| dsh agent runtime | TypeScript/Node.js (upstream packages, unmodified) | The Cordis plugin graph is the product's behaviour. See [ADR 0002](../docs/decisions/0002-non-rust-runtime-requirements.md). |

**This is not a fully Rust implementation and is not described as one.** The UI and the agent runtime
are the two permanent exceptions; ADR 0002 also lists the non-Node foreign runtimes the port carries.

Rust owns process lifetime and application orchestration. It does **not** own the agent loop, the tool
implementations, the session log, or the terminal/Office/Python backing runtimes — all of which stay in
the supervised Node runtime.

## Build

```powershell
.\port\scripts\build.ps1 -Stage all -Release
```

`build.ps1` is the single entry point; it stages the UI and the runtime payload before compiling,
because Tauri validates `bundle.resources` source paths at build-script time. See
[`../docs/build-and-install.md`](../docs/build-and-install.md) for the prerequisites, the stage list,
the isolation rules, and the exact list of steps that require separate approval.

## Status

Implemented and locally exercised: the Rust workspace (core, runtime, gateway, Tauri shell), the
preserved client build, the runtime-payload staging and publication pipeline, the NSIS installer
sources and their packaging suites.

**Not yet established** — do not read these directories as evidence for them:

- Native qualification: no approved end-to-end installed acceptance run on a clean machine.
- Product whole-process-tree measurements remain absent. The [accounting suite](scripts/tests/process-tree-accounting.ps1) now passes 54 deterministic assertions; a two-sample live smoke on the tool's own PowerShell process is explicitly partial and is not product-performance evidence.
- Production feed, signing and packaged update trust: `createUpdaterArtifacts` and
  `plugins.updater.pubkey` are deliberately unset, and no `updates.json` ships, so update delivery
  fails closed.
- The exact original cause of the reported stuck-agent behaviour: lifecycle defects of the right shape
  were found and fixed, and helper tests cover them, but the original incident was not reproduced and
  no helper test is evidence about it.
- Native guests remain disabled. Command registration, owned-main capability scoping and default managed state are now present, but they do not install a native backend. Remaining gates include completed permission/credential hooks, the app's consumer of revisioned Platform sessions, actual title/history/error/lifetime observations and creation-failure compensation, and a reproducible retained-client adapter artifact. Unsupported native clear-history explicitly refuses. See the [retained-consumer gate](.scratch/lane-reports/F2-to-G2-adapters.md).
- Windows [OS-resume integration](src-tauri/app/src/power_resume.rs) is compiled and wired to the automatic updater deadline/backoff, separately from focus; real suspend/resume and subclass teardown still need native acceptance. The [bounded policy transport](src-tauri/app/src/policy_transport.rs) passes 10 HTTP fixture tests and the [independent owned policy runner](src-tauri/app/src/policy_runner.rs) passes 15 tests, including complete metadata-plus-HTTP timeout and cancellation-safe quiescent disposal. The [packaged policy input loader](<src-tauri/app/src/policy_bootstrap.rs>) passes nine tests and the [native request-time sampler](<src-tauri/app/src/policy_metadata.rs>) passes three; the [UI producer](<ui/shell/policy-bootstrap.mjs>) records the actual inlined version and trusted application policy without guessing. Policy networking is not activated: final runtime descriptor sealing and bundled-interpreter verification are implemented and pass fixtures, but complete payload assembly, startup/focus/resume/login/quit ownership and mandatory blocking across native children while allowing Quit remain incomplete. The [ordinary updater](<src-tauri/app/src/update_schedule.rs>) also retains its timer join during disposer cancellation and serializes publication/shutdown, verified by 22 schedule tests; direct manual/check futures remain caller-owned.
- The current [integration checkpoint](../docs/luna-integration-review.md) records 467 passing Rust tests, 44 Node packaging tests, 121 PowerShell packaging assertions, 58 verifier/producer fixtures, both UI typechecks and a successful port-shell build. Prior unchanged runtime evidence is 160 desktop/update tests plus 46 owned Browser tests/typecheck. Execution-time guest ownership uses a production-tested headless seam; actual native allocation/destruction and retained-consumer artifact activation are not established.

Release gates that need credentials or hosts are listed in
[`../docs/implementation-plan.md`](../docs/implementation-plan.md) §Milestone 5–6 and are explicitly
unmet.
