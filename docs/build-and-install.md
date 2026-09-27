# Build, install and troubleshoot

> **STATUS — READ FIRST.** These instructions describe the intended build and packaging flow and are **not yet reproducible end to end**. At the time of the independent adversarial review (finding R-03) `port/src-tauri/tauri.conf.json` and `port/src-tauri/app/capabilities/` did **not exist**, `app/` and `dsh-gateway/` were placeholders, and no `#[tauri::command]` handler was compiled — so §3–5 below cannot currently produce a booting application or an NSIS installer. §1 and §2 **are** verified reproducible. Check [`verification-report.md`](verification-report.md) §4 for current status before relying on §3–5.

Reproducible instructions for the Rust-core desktop port of DeepSeek Harness. The reference machine is described in [`reference-environment.md`](reference-environment.md); the architecture is in [`decisions/0001-desktop-architecture.md`](decisions/0001-desktop-architecture.md).

> **Safety rule.** A live agent harness runs on this machine at `http://127.0.0.1:3080` with `DSH_HOME=C:\Users\Yoova\.dsh`. Never run the reference or the port against that home or that port. Every command below isolates `DSH_HOME` and uses port 3085+.

## 1. Prerequisites

| Tool | Version used | Notes |
|---|---|---|
| Windows 10/11 x64 | 10.0.26200 | Primary target. macOS is a portable, non-parity-verified target. Linux has no upstream desktop release to compare against. |
| Rust (MSVC) | 1.97.1 | `rustup default stable-x86_64-pc-windows-msvc` |
| Visual Studio Build Tools | C++ workload + Windows SDK | Needed by `windows-sys`/MSVC link and by upstream native addons |
| Node.js | v25.4.0 (engines `^22.19.0 \|\| >=24.0.0`) | Builds the preserved frontend and the supervised runtime |
| pnpm | 11.7.0 | Matches upstream `packageManager` |
| WebView2 Runtime | 153.x | Preinstalled on Windows 11; the Tauri bootstrapper installs it where missing |
| NSIS | 3.x | Only for building the installer (`tauri-bundler`) |

## 2. Build the preserved upstream reference artifacts

The port consumes the **already-built** upstream web client; it does not re-bundle the UI.

```powershell
cd _upstream
pnpm install        # 3m33s reference; 1387 packages, 335 workspace projects
pnpm run build      # tsc + tsdown (host & client) + Vite web build -> apps/web/dist
```

Expected benign warnings are listed in [`reference-environment.md`](reference-environment.md).

## 3. Build the desktop application

```powershell
# 1. the preserved web client shell
cd port/ui
pnpm install
pnpm run build

# 2. the Rust application core and the Tauri shell
cd ..\src-tauri
cargo build                 # dev build
cargo test                  # unit + integration tests
cargo clippy --all-targets -- -D warnings
```

A packaged release build is `cargo tauri build` (or `cargo build --release`) driven through `port/scripts/build.ps1`, which also stages the supervised runtime payload beside the executable.

## 4. Run it

```powershell
$env:DSH_HOME = "$PWD\port\.scratch\run-home"      # throwaway home, never ~/.dsh
cargo tauri dev
```

The Rust core will:

1. resolve `$DSH_HOME` and take the single-instance lock on `$DSH_HOME/profiles/desktop`;
2. start the loopback gateway on `127.0.0.1`;
3. supervise the dsh host runtime process tree and wait for its `ready` control message;
4. navigate the window to the gateway, which performs the launch-token → signed-cookie exchange against the runtime.

## 5. Build the Windows installer

```powershell
cd port\src-tauri
cargo tauri build           # produces an NSIS installer under src-tauri\target\release\bundle\nsis\
```

The installer carries the application icon, product name, version, publisher and metadata from `port/src-tauri/tauri.conf.json`, and installs per-user.

### Clean-machine install test

1. On a clean Windows x64 VM or user account (no Node, no Rust, no prior dsh), run `deepseek-harness-<version>-x64-setup.exe`.
2. Launch from the Start menu shortcut.
3. Confirm first run: the Internal Testing Notice appears and the workspace renders.
4. Change a desktop-owned setting (theme, a shortcut override) and quit. Relaunch and confirm the setting persisted.
5. Confirm credentials: save a model API key and confirm it appears in Windows Credential Manager (not in `$DSH_HOME`, not in any log).
6. Confirm process cleanup: start a task, close the window to the tray, then quit from the tray. Confirm no `node.exe` child survives (`Get-Process node`).
7. Uninstall from Settings → Apps and confirm the Start-menu shortcut and the install directory are removed. User data under `$DSH_HOME` is retained by design.

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The window shows a blank page or a 401 | The gateway could not complete the launch-token exchange with the runtime | Check the diagnostic log (`%LOCALAPPDATA%\DeepSeek Harness\logs`). Confirm the runtime reached `ready`. Re-run with `RUST_LOG=dsh_runtime=debug,dsh_gateway=debug`. |
| `RuntimeUnavailable { state: "starting" }` in the UI | The host runtime has not yet reported `ready` | Wait; if it persists, the runtime failed to boot — read the crash report written before the recovery dialog. |
| Startup hangs, then a recovery dialog appears | A plugin or the runtime failed during boot | Choose **Restart**, or **Disable third-party plugins, back up profile patch, and restart**. The patch is renamed `cordis.patch.yml.bak-<timestamp>`; installed packages are kept. |
| `listen EADDRINUSE` | Another dsh instance already owns the port | Quit other running dsh instances. The recovery dialog offers only **Exit** and **Restart** for this case. |
| Installer says the application is running | A dsh desktop process is still alive | Quit it from the system tray (Windows) and retry. |
| Leftover `.new-*` / `.old-*` directories after a power loss | An interrupted upgrade | Re-run the installer for the same version; it promotes or restores the directory. |
| Terminal/PTY tools fail | The ConPTY backend is unavailable | Terminals need Windows ConPTY or a POSIX pty; see `_upstream/docs/subsystems/terminal.md`. |
| Office conversion fails | The primary-runtime payload is missing | The payload is installed on first use under `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`; a cross-target payload cannot be assembled here (see the parity matrix B5). |
| Diagnostic logs | — | `%LOCALAPPDATA%\DeepSeek Harness\logs\` (rolling) and `crash-<UTC>-<source>.log` (the ten newest are retained) |

## 7. Signing and updates — planned, not claimed

The port is **not** a signed release and **no** update delivery is functional. See [`parity-matrix.md`](parity-matrix.md) §9 B1–B3. The plan is:

- **Windows:** sign the installer and every shipped PE with an EV code-signing certificate through SignTool, with a timestamp server and a publisher name pinned in the update feed. Blocked on hardware token + certificate.
- **macOS:** Developer ID signing, hardened runtime with a JIT entitlement for the bundled Node and the LibreOffice UNO bridge, notarization and stapling. Blocked on Apple credentials and a macOS host.
- **Updates:** a single signed unit of shell + matching dsh runtime + bundled pnpm, served from a generic provider feed; clients accept only greater versions. Blocked on bucket credentials.

Do not describe any of the above as delivered.
