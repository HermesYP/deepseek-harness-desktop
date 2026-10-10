# Build, install and troubleshoot

Reproducible instructions for the Rust-core desktop port of DeepSeek Harness. The reference machine is
described in [`reference-environment.md`](reference-environment.md); the architecture is in
[`decisions/0001-desktop-architecture.md`](decisions/0001-desktop-architecture.md).

> **Safety rule.** A live agent harness runs on this machine at `http://127.0.0.1:3080` with
> `DSH_HOME=C:\Users\Yoova\.dsh`. Never run the reference or the port against that home or that port.
> Every command below isolates `DSH_HOME` and uses port 3085+.

> **Approval rule.** Nothing in §5–§7 may be performed without separate explicit approval: installing to
> a real destination, uninstalling, restarting or terminating a user's application or processes,
> publishing, and signing. The commands shown there are the *intended* procedure, not a standing
> authorization.

## 2026-10-10 repair qualification override

For changed-source acceptance, use [the qualification gate](../port/tests/run-verification-gate.ps1), not historical system-Node counts or a glob that may collect no tests. The gate requires pinned Node **22.20.0**, explicit executable hash/version/MIC and actual child token evidence, plus owned write, named-pipe, sentinel and watchdog probes. SKIP/precondition failure/unknown visibility are non-pass. See [the repair ledger](repair-ledger-2026-10-10.md) for current results.

Use a new short owned root; if workspace MIC restricts a helper, use the verified plain-copy procedure rather than inherited-label copies, hardlinks, recursive ACL resets or MIC relabels. Paths and launcher argument quoting must survive Windows PowerShell 5.1. Retain environment, image/child integrity and exact source/adapter hashes with each run. Fresh development handoffs are exclusive owner-only creations: never reuse/truncate a previous run's handoff.

Isolated DEBUG startup may access OS credentials **only** under an explicit canonical UUID with home/user-data strictly inside that build's compile-time scratch fence. Release rejects that opt-in before durable initialization; neither copied home nor a temporary directory implies credential isolation. Do not run §§5–7 during source/DEBUG repair. Release clean-machine installation remains a separately authorized disposable-host gate.

### Trusted Rust and runtime staging

[The Rust preflight](../port/tests/run-rust-qualification.ps1) prepares a short outside owned target and temporary root, checks cargo/rustc images and actual child tokens, and prints `READY_*` arguments. It **does not build, test or launch the app**. Recheck target trust before each serialized gate and retain a new checkpoint with numeric exit code, stdout/stderr, environment and image/token evidence. [Its supporting module](../port/tests/packaging/rust-qualification.psm1) provides per-child environment overrides and an explicit process wait rather than relying on a nullable `Start-Process` exit code.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File port/tests/run-rust-qualification.ps1
# Use that run's READY_ENV / READY_CARGO_ARGS, not a previous target or home.
# --locked --offline --jobs 1 --config profile.dev.debug=0
```

The DEBUG build must also use this outside target: freshly linked workspace images are Low even when a pre-existing desktop image is explicitly Medium. Labels are read from the object's mandatory-label ACE (including inherited ACEs); an absent label enforces Medium. An ancestor's current label is not a substitute for the file's own label or the child's actual token. The copy self-test currently proves hash-preserving copies on three owned files; its negative workspace destination is rejected by the OneDrive reparse guard first, so it is **not** experimental proof of the separate label guard.

[Runtime staging](../port/scripts/build.ps1) now executes the archive-pinned interpreter through a hash-equal, preflighted outside execution copy, or an explicitly supplied `-AttestedNodePath` that meets the same checks. Scoped PATH and TEMP/TMP are restored, including absent-versus-empty values. This changes **build execution only**, not the shipped pinned bytes, archive provenance or runtime seal. Use `-Stage runtime -RuntimeQualificationName <fresh-name>` for repair evidence; this never replaces the normal runtime/installer manifest. The source adapter's authenticated token-plus-generation handshake is incompatible with the old staged token-only adapter: materialize and seal a fresh qualification payload before any shell/payload run. Never patch sealed runtime files manually.

## 1. Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Windows 10/11 x64 | 10.0.26200 | Primary build host. macOS and Linux have no qualified host here; no target is claimed portable without one. |
| Rust (MSVC) | 1.97.1 | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | C++ workload + Windows SDK | Needed by `windows-sys`/MSVC link and by upstream native addons |
| Node.js | v25.4.0 on the reference machine; upstream `engines` is `^22.19.0 \|\| >=24.0.0` and the port's pinned Node is **22.20.0** | Node is required to *build* the UI and to run the packaging and verification suites. Both supported interpreters run those suites: the ordinary `node --test` invocation is valid on 22.20.0 and on 25.4.0. Do **not** pass `--test-isolation=none`; that option does not exist in 22.20.0 and it exits 9 (`bad option`) before running anything. A user's machine does **not** need Node: the installer carries the pinned interpreter (§3). |
| pnpm | 11.7.0 | Matches upstream `packageManager: pnpm@11.7.0` |
| WebView2 Runtime | 153.x | Preinstalled on Windows 11; the Tauri bootstrapper installs it where missing |
| NSIS | 3.11 (`%LOCALAPPDATA%\tauri\NSIS`) | Supplied by `tauri-bundler`; only needed for the installer |
| PowerShell | Windows PowerShell 5.1 on this host | `build.ps1` and the packaging suites are exercised under 5.1. There is no `pwsh` on the reference machine, so PowerShell 7 compatibility is asserted by convention, not measured. |

`port/ui` declares no dependencies of its own. Its toolchain (Vite, TypeScript, tsdown) is **linked**
from the pinned `_upstream` checkout by `port/ui/link-toolchain.ps1`, which `build.ps1` runs
automatically. A fresh checkout therefore needs §2 done first.

## 2. Build the preserved upstream reference artifacts

The port consumes the **already-built** upstream checkout; it does not re-bundle the UI itself.

```powershell
cd _upstream
pnpm install        # 3m33s reference; 1387 packages, 335 workspace projects
pnpm run build      # tsc + tsdown (host & client) + Vite web build -> apps/web/dist
```

Expected benign warnings are listed in [`reference-environment.md`](reference-environment.md).
`_upstream` stays read-only — nothing in this repository writes to it.

## 3. Build the desktop application

`port/scripts/build.ps1` is the only supported entry point. It exists because the stage order **is**
part of the contract: `bundle.resources` source paths are validated by Tauri's build script at
build-script time, so a compile that runs before the UI and runtime stages fails with
`resource path ... doesn't exist`, which names the symptom and not the cause.

```powershell
# Development build: UI, runtime payload, cargo build + test + clippy
.\port\scripts\build.ps1 -Stage core

# Full clean build including the NSIS installer
.\port\scripts\build.ps1 -Stage all -Release
```

Stages, in the order `-Stage all` runs them:

| Stage | What it produces |
|---|---|
| `ui` | `port/ui/dist` — the preserved client shell, built with upstream's **official** client build profile, plus the port-owned `client-updates` plugin |
| `runtime` | `port/runtime-payload/dsh` — upstream's own packaging pipeline, ending in a flat, hoisted `node_modules` of real directories |
| `core` | `cargo build --workspace --locked`, `cargo test --workspace --locked --offline`, `cargo clippy --workspace --all-targets --locked --offline -- -D warnings` |
| `verify` | locked/offline Rust protocol-fixture parity and TypeScript parity |
| `packaging-tests` | the packaging suites (see §6) |
| `bundle` | `cargo tauri build` — release binary + NSIS installer |

Useful switches:

- `-Release` — build with `--release`. Implied by `bundle`.
- `-NodeArchivePath <zip>` — a locally provisioned pinned Node archive. Its SHA-256 must match
  `port/installer/node-runtime.json`; a mismatch is refused.
- `-AllowNodeDownload` — permit downloading the pinned Node archive from its declared HTTPS URL. Without
  it (or `-NodeArchivePath`) the stage fails with guidance rather than substituting a system Node.js.
- `-UpdatePayloadManifest` — overwrite the recorded payload manifest with the freshly built one. Without
  it, a payload whose bytes differ from the record fails the stage.
- `-SkipResourceStages` — do not implicitly run `ui`/`runtime` before `core`/`bundle`. Only when those
  roots are known current; the build then no longer verifies that they are.

Two build hazards worth knowing before you hit them:

- **A `bundle` build needs the target directory to itself.** `build.ps1` refuses to start if any
  `cargo`, `cargo-tauri` or `rustc` process is running, because the NSIS step needs the just-linked
  binary to still be on disk. `test`/`check`/`clippy` do not need this; cargo self-serialises them.
- **No application instance may be running during a `runtime` stage.** A loaded native module
  (`koffi.node`) stays locked, so the old payload tree cannot be replaced. The stage publishes
  atomically and keeps the previous tree as `<published>.previous`, but a locked file still blocks the
  clear.

## 4. Run it (development)

```powershell
$env:DSH_HOME = "$PWD\port\.scratch\run-home"      # throwaway home, never ~/.dsh
.\port\scripts\build.ps1 -Stage core
cd port\src-tauri
cargo tauri dev
```

On start the Rust core:

1. resolves `$DSH_HOME` and takes the single-instance lock on the desktop profile;
2. creates the desktop profile if it is absent, idempotently and never overwriting existing files —
   the profile is a product responsibility, not a development convenience;
3. starts the loopback gateway on `127.0.0.1`;
4. supervises the dsh host runtime process tree and waits for its `ready` control message within a
   bounded startup budget;
5. navigates the window to the gateway, which performs the launch-token → signed-cookie exchange
   against the runtime.

## 5. Build and install the Windows installer

> **Requires approval.** Building the installer is a build action and needs the target directory to
> itself. *Installing* it — to this machine or any other — is a separate, explicitly approved action.

```powershell
.\port\scripts\build.ps1 -Stage all -Release -NodeArchivePath C:\path\to\node-v22.20.0-win-x64.zip
```

Output: `port\src-tauri\target\release\bundle\nsis\DeepSeek Harness_<version>_x64-setup.exe`.
The installer carries the icon, product name, version, publisher and metadata from
`port/src-tauri/app/tauri.conf.json`, installs per-user, and declares two UI languages (English,
SimpChinese) with a language selector.

**Never treat installer presence as success.** A stale artifact can survive a failed rebuild at exactly
this path. Check the size and timestamp as well — an installer that carries the runtime payload is far
larger than one that does not.

### Clean-machine install test (requires approval)

1. On a clean Windows x64 VM or user account (no Node, no Rust, no prior dsh), run
   `deepseek-harness-<version>-x64-setup.exe`.
2. Launch from the Start menu shortcut.
3. Confirm first run: the Internal Testing Notice appears and the workspace renders.
4. Change a desktop-owned setting (theme, a shortcut override) and quit. Relaunch and confirm the
   setting persisted.
5. Confirm credentials: save a model API key and confirm it appears in Windows Credential Manager
   (not in `$DSH_HOME`, not in any log).
6. Confirm process cleanup: start a task, close the window to the tray, then quit from the tray.
   Confirm no `node.exe` child survives (`Get-Process node`).
7. Uninstall from Settings → Apps and confirm the Start-menu shortcut and the install directory are
   removed. User data under `$DSH_HOME` is retained by design.

### The acceptance script fails closed (`port/scripts/verify-installed.ps1`)

The script automates part of the list above, but it is deliberately **refusing more often than it
runs**. It exits 2 and changes nothing when any of the following is true:

- the qualification root is not a **fresh** `port\.scratch\installed-qualification-<uuid>` directory
  (a reused or non-scratch root is refused, never clobbered; `-AllowRoot` was removed, because it is
  what previously allowed a run to target `%TEMP%` and a registered installation);
- a same-product footprint exists anywhere on the host - the
  `…\CurrentVersion\Uninstall\DeepSeek Harness` registration (HKCU, HKLM and the WOW6432Node view),
  the `DeepSeek Harness` Start-menu folder, `%APPDATA%\DeepSeek Harness`,
  `%LOCALAPPDATA%\DeepSeek Harness`, `%LOCALAPPDATA%\Programs\DeepSeek Harness`, the
  identifier-derived WebView2 profile `%LOCALAPPDATA%\ai.deepseek.harness.desktop`, a populated
  `%USERPROFILE%\.dsh\profiles\desktop`, a populated `%USERPROFILE%\.dsh\vault`, a second
  WebView2/SDK data directory, a running `dsh-desktop.exe` / `DeepSeek Harness.exe` /
  `DeepSeekHarness.exe`, or a **domain-joined machine** (see below).

The vault is probed in its own right: a host can carry production secrets under `.dsh\vault` while
carrying no desktop profile at all, and checking only the profile would read such a host as clean.

The footprint gate runs **before** the installer process starts and **before** the application is
launched. The script never repairs, restores or overwrites a footprint it finds: a script that
cleaned up would already have decided the live installation was disposable. There is no switch, no
environment variable and no flag that proceeds past it.

**A same-user release launch cannot be isolated, so it is separately gated.** A release build cannot
be pointed at an owned credential namespace - the opt-in is `cfg!(debug_assertions)`-gated in
`port/src-tauri/app/src/credential_backend.rs` - and boot unconditionally reads or *creates* the
shared `dsh-desktop:*` OS credential through `load_or_create_secret`. `DSH_HOME` relocation does not
fence secrets, because the OS store is per **user account**. Launching therefore also requires
`-Launch -CleanAccountAttestation`, and the attestation is recorded in the evidence report as an
**unverified human claim** (`cleanAccountAttestationIsMachineVerified = false`). It is reachable only
after every footprint check above has passed, which is false on any machine that has ever run this
product.

#### Qualifying an account: local, non-domain-joined, disposable

The clean-account claim is valid **only** on a **non-domain-joined local, disposable Windows account
or VM**. This is not advice, it is enforced.

A read-only `Win32_ComputerSystem.PartOfDomain` lookup runs in the preflight census and yields one of
three states:

| State | Result |
|---|---|
| `Workgroup` | the only state that can proceed |
| `Joined` | **refused**, regardless of attestation |
| `Unknown` (query failed, or the class did not publish the property) | **refused**, regardless of attestation |

The reason is that Windows Credential Manager entries can **roam** with a domain profile. On a
domain-joined host "this local account holds no real `dsh-desktop:*` credentials" is not a true
statement, and a human attestation cannot make it one. The same reasoning applies when the machine
will not answer: a host that cannot be asked is not assumed to be the safe case. There is deliberately
no default-to-workgroup path, because that default would itself be a bypass, and there is no escape
hatch: the domain state is a census finding like any other, and findings refuse before the attestation
is even considered. The probe only reads; it never joins, leaves, or configures a domain.

`Credential roaming is not checked` is stated in the attestation text for the same reason.

#### Scope of this gate - what it is not

Be clear about what the census and the attestation do and do not establish:

- The census is a **refusal gate**, not a verification of the vault. It proves that no *known* same-
  product footprint is present, so a run cannot quietly displace a live installation.
- It is **not** automatic verification that no credentials exist. `%USERPROFILE%\.dsh\vault` is
  checked for *presence* and its presence refuses the run, but nothing here opens, reads, enumerates
  or validates credential contents. No Windows Credential Manager entry is ever read.
- `cleanAccountAttestationIsMachineVerified = false` is literal: the script never verifies the claim.
  It records it so a reader can see that a human made it.
- Because a release build always uses the per-user `dsh-desktop:*` store, the only thing that makes a
  launch safe is running it on an account that genuinely has nothing on it. That remains a human
  responsibility, and the evidence report says so.


The footprint census is **fail-closed**. Path existence is probed tri-state (`Present` / `Absent` /
`Unknown`) rather than with `Test-Path`, because `Test-Path` returns `$false` both for "does not exist"
and for "I was not allowed to look", and a protected location must never read as a clean host. The
registry and process queries throw rather than returning an empty set, and **any lookup that cannot
complete is recorded as a finding that refuses the run**. "I could not see it" and "it is not there"
are different answers, and only the first one is true. A registry view that simply does not exist on
the host (for example `WOW6432Node` on 32-bit Windows) is not applicable, not a failure.

An absent value is handled defensively too: under `Set-StrictMode` reading a value a key does not
have *throws* rather than returning `$null`, and an earlier version swallowed exactly that — silently
skipping real uninstall keys while reporting the host as clean.

When it does launch, the environment is built from nothing. Inherited `DSH_*`, `WEBVIEW2_*`, proxy
(`HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` / `npm_config_proxy`), Node and toolchain
(`NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `ESBUILD_BINARY_PATH`, `TSX_TSCONFIG_PATH`, …)
and token/secret-shaped variables are removed, the removal is recorded in `strippedEnvKeys`, and the
result is verified by re-reading the process environment.

The **complete** owned set is then set, and every owned directory is created *before* the installer
runs, so an installer or application that writes to `%TEMP%` cannot fall back to a live location:

| Variable | Owned value | Why |
|---|---|---|
| `DSH_HOME` | `<root>\home` | what `dsh-core/src/paths.rs` resolves first |
| `DSH_DESKTOP_USER_DATA_DIR` | `<root>\user-data` | overrides the `SHGetKnownFolderPath` app-data default |
| `WEBVIEW2_USER_DATA_FOLDER` | `<root>\user-data\webview` | moves the identifier-derived WebView2 profile |
| `HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH` | `<root>\profile` | what the Node host and spawned tools read |
| `APPDATA`, `LOCALAPPDATA` | `<root>\appdata`, `<root>\localappdata` | roaming/local config, caches and logs |
| `TEMP`, `TMP` | `<root>\temp` | scratch files; also where a silent fallback would land |

`DSH_HOME` and the WebView2 folder alone were **not** sufficient: they cover what the Rust core
resolves, but not what the Node host, WebView2 and any spawned tool write through. Each owned variable
is read back and compared, and each owned path is asserted to be inside the fresh root. The seven
development runtime overrides are re-asserted **absent immediately before launch** — the whole point
of the test. Readiness is read **only** from `<root>\user-data\logs`; the previous
`%APPDATA%`/`%LOCALAPPDATA%` fallbacks read the live installation's log, so a run could false-PASS on
another run's readiness line.

> The owned environment does **not** fence the OS credential store, which is per user account. That is
> what the clean-account attestation is for.

**Shutdown is not performed by this script.** Product close (`WM_CLOSE`,
`shell_window_chrome_action`) only hides to the tray; the real quit is `shell_quit_request` on the
owned gateway origin, or a scoped UIA `Exit` InvokePattern, and driving either needs the reviewed
owned native UIA authority. The old `Stop-Process -Force` teardown is removed - it can orphan
`node.exe` children and skip credential cleanup. The run instead records the exact owned process
identities it could not shut down into
`<root>\evidence\verify-installed-report.json` (`ownedProcessesNotShutDown`) and reports
`application shut down gracefully` as **FAIL**, so a run that could not be closed cleanly can never
be reported as PASS.

### `-ReadOnlyExtractedLayout` is a weaker, separate lane

This lane inspects an **externally produced** extraction (`-ExtractedRoot`). The script itself never
extracts, installs, launches or uninstalls in it, and `-Launch` / `-Uninstall` are rejected there.
It performs read-only layout assertions only: executable, adapter, the four runtime anchors as real
directories, both `@dsh-port` packages, `ui\assets`, zero reparse points under `node_modules`, the
pinned `dsh\node\node.exe`, and MAX_PATH headroom.

Its result is **NOT installed acceptance**. It establishes nothing about the uninstall registry
registration, Start-menu shortcuts, updater hooks, `/UPDATE` relaunch or uninstaller behaviour. The
evidence report sets `notInstalledAcceptance = true` and the console says so.

### Guard contract test

`port/tests/packaging/verify-installed-guards.ps1` asserts the guard as a contract - that the gate
ordering holds, that no `Stop-Process`/`taskkill` remains, that no registry write or path deletion
exists, that no bypass-shaped parameter is exposed, that the live log fallbacks are gone, that the
footprint census still *names* the live paths so contamination stays detectable, that the census is
fail-closed, and that the owned environment is complete. It also runs the script's pure
`-GuardSelfTest` mode, which touches no filesystem, registry or process.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File port\tests\packaging\verify-installed-guards.ps1
.\port\scripts\verify-installed.ps1 -GuardSelfTest
```

A **missing** `verify-installed.ps1` makes the suite **FAIL**, not skip: a required guard gate must
never go green by not finding its subject, and a partial checkout is a missing gate rather than a
passing run.

The test is deliberately not wired into `build.ps1 -Stage packaging-tests`; invoke it directly.

## 6. Verification you can run without approval

```powershell
.\port\scripts\build.ps1 -Stage core -SkipResourceStages   # cargo build + test + clippy
.\port\scripts\build.ps1 -Stage verify                     # protocol fixtures, both sides
.\port\scripts\build.ps1 -Stage packaging-tests            # publication, manifest, pinned Node, NSIS hooks
npm --prefix port/ui run test:verification                 # top-level Node verification suite
```

`test:verification` is a plain `node --test ../tests/*.test.mjs` over the top-level files in
[`port/tests/`](../port/tests). It runs unchanged on the pinned **22.20.0** interpreter and on the
reference machine's **25.4.0**; the glob is expanded by Node, not by the shell, so the command is the
same on both. Use the `npm run` form — `npm --prefix port/ui` always sets the working directory, while
the bare `node --test ../tests/*.test.mjs` form must be run *from* `port/ui`. Node does **not** fail when
a glob matches nothing: it prints `tests 0` and exits 0, so read the `tests` count and treat 0 as a
failed check rather than a clean run. To run the suite against the bundled interpreter rather than the
machine's, invoke that executable directly:

```powershell
& .\port\.scratch\rq-r5a\rt\dsh\node\node.exe --test port/tests/*.test.mjs   # v22.20.0, from the repo root
```

One test in that suite — `adapter-launch.integration.test.mjs` — is **opt-in** and reports as *skipped*
unless `DSH_ADAPTER_INTEGRATION_PAYLOAD` or `DSH_ADAPTER_INTEGRATION_NODE` selects a scratch-owned
sealed payload. A skipped result is not a passing Host/native result: nothing about the WebView2 shell,
the renderer or an installed artifact is established by this suite.

The packaging suites are executed individually by direct file invocation. Under the *confined*
development session, `node --test` cannot spawn its per-file child processes (`spawn EPERM`); that is
the documented sandbox boundary, not a product defect. Unconfined runs — and this repository's normal
verification runs — use ordinary `node --test` and are not subject to it.

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `resource path ..\..\runtime-payload\dsh doesn't exist` from any `cargo` command | Tauri's build script validates `bundle.resources` sources, and the resource root is absent | Run `-Stage runtime` (or `-Stage all`). Do not pass `-SkipResourceStages` to silence it. |
| `can't open main binary ...\dsh-desktop.exe: os error 2` during `cargo tauri build` | Two bundling builds shared one target directory; cargo deletes the previous binary at the end of the link step | The script already refuses to start when another `cargo`/`rustc` is live. Wait, then re-run. |
| A `runtime` stage fails to clear `koffi.node` (`Access to the path ... is denied`) | A running application instance has the native module loaded | Close the instance, then re-stage. |
| `build.ps1` reports failure for a step that succeeded | Historically, `$ErrorActionPreference = 'Stop'` turned a tool's stderr progress output into a terminating error. `Invoke-Checked` now scopes the preference and judges success purely by `$LASTEXITCODE`. | If you add a call outside `Invoke-Checked`, wrap it the same way. |
| The window shows a blank page or a 401 | The gateway could not complete the launch-token exchange with the runtime | Check the diagnostic log. Confirm the runtime reached `ready`. Re-run with `RUST_LOG=dsh_runtime=debug,dsh_gateway=debug`. |
| `RuntimeUnavailable { state: "starting" }` in the UI | The host runtime has not yet reported `ready` | Wait; if it persists, the runtime failed to boot — read the crash report written before the recovery dialog. |
| Startup hangs, then a recovery dialog appears | A plugin or the runtime failed during boot | Choose **Restart**, or **Disable third-party plugins, back up profile patch, and restart**. The patch is renamed `cordis.patch.yml.bak-<timestamp>`; installed packages are kept. |
| `listen EADDRINUSE` | Another dsh instance already owns the port | Quit other running dsh instances. The recovery dialog offers only **Exit** and **Restart** for this case. |
| Installer says the application is running | A dsh desktop process is still alive | Quit it from the system tray (Windows) and retry. The installer refuses rather than killing it, by design. |
| Leftover `.new-*` / `.old-*` directories after a power loss | An interrupted upgrade | Re-run the installer for the same version; it promotes or restores the directory. |
| Terminal/PTY tools fail | The ConPTY backend is unavailable | Terminals need Windows ConPTY or a POSIX pty; see `_upstream/docs/subsystems/terminal.md`. |
| Office conversion fails | The runtime payload lacks the Office engine or its resources | The payload must keep `@deepseek-ai/dsh-skill-office`, `@deepseek-ai/dsh-tool-workspace-dependencies`, `@deepseek-ai/libreoffice-kit` and the platform engine package resolvable, plus the sibling `office-skills` and `dependencies/node/bin/node.exe` resources. |
| Diagnostic logs | — | `%APPDATA%\DeepSeek Harness\logs`, `%LOCALAPPDATA%\DeepSeek Harness\logs` (rolling), and `crash-<UTC>-<source>.log` (a bounded number retained) |

## 8. Signing and updates — planned, not claimed

**The port is not a signed release and no update delivery is functional.** This is enforced, not merely
documented: `createUpdaterArtifacts` and `plugins.updater.pubkey` are unset in
`port/src-tauri/app/tauri.conf.json`, no `updates.json` is packaged, and every build prints
*"Signing and update delivery are NOT part of this build"*.

Update delivery is **fail-closed by construction**. Trust comes from a packaged `updates.json` beside the
executable or in the Tauri resource directory — never from the renderer-writable settings store. A
missing, unreadable, malformed or self-contradictory file disables delivery and reports a classified
failure; no network request is made. An unsigned or hash-only manifest is never installable. The schema,
the signing contract and the qualification-only test key are documented in
[`../port/updates-trust.md`](../port/updates-trust.md).

Creating any of the following is a **separate approval and a credential-bearing action**; do not create
development trust or a self-signed key that could be mistaken for release trust:

- **Windows:** sign the installer and every shipped PE with an EV code-signing certificate through
  SignTool, with a timestamp server, and pin a publisher name in the update feed. Blocked on a hardware
  token and certificate.
- **macOS:** Developer ID signing, hardened runtime with a JIT entitlement for the bundled Node and the
  LibreOffice UNO bridge, notarization and stapling. Blocked on Apple credentials and a macOS host.
- **Updates:** a single signed unit of shell + matching dsh runtime + bundled pnpm, served from a
  generic provider feed; clients accept only strictly greater versions. Blocked on feed credentials and
  a real signing key.

Do not describe any of the above as delivered. See also
[`implementation-plan.md`](implementation-plan.md) §Milestone 5–6 and
[`limitations.md`](limitations.md).
