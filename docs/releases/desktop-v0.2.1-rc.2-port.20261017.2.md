# Windows preview: Harness 0.2.1-rc.2 (hardening build 2)

**Unsigned community prerelease for controlled testing. Not an official upstream
Windows binary. Do not use this release as an in-place upgrade over an existing
installation.**

- Release tag: `desktop-v0.2.1-rc.2-port.20261017.2`.
- Target: Windows x64, Tauri desktop wrapper with the upstream Node host and web
  client.
- Upstream: [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2),
  commit `687f282e8625c6b8d11ff58211a90524be2e4317`.
- Port source: commit `1731d65`.

This build supersedes `desktop-v0.2.1-rc.2-port.20261017.1`.

## Download identity

- Installer: `DeepSeek-Harness-Desktop-0.2.1-rc.2-port.20261017.2-windows-x64-setup.exe`
- Installer size: **122,802,607 bytes** (117.1 MiB)
- Installer SHA-256: `023ff0e33305e3c44688079eb243f9fe079e8380f8c41cf1a8fe6636210e9885`
- Native application SHA-256: `4a3889290220243702f1dd19df087eb223601a91cb874b20294ddb6ced18de64`
- Authenticode status: **NotSigned**

## What changed in this hardening build

- A corrupt `settings.json` is now quarantined as
  `settings.corrupt-<utc>.json` and the application starts with defaults instead
  of refusing to launch. A future schema version is still refused, not discarded.
- Release builds now ignore `DSH_DESKTOP_SHELL_DIR`, `DSH_DESKTOP_RUNTIME_DIR`,
  `DSH_DESKTOP_RUNTIME_ADAPTER`, `DSH_DESKTOP_NODE` and
  `DSH_DESKTOP_PRIMARY_RUNTIME_DIR`. Those overrides remain available in debug
  builds only; a release always uses its packaged payload.
- The missing-runtime errors now say the packaged runtime is incomplete and
  should be reinstalled, instead of telling the user to install Node.js on PATH
  or set a developer override the release no longer honors.
- The Windows Job Object pre-assignment window is documented as a residual
  limitation rather than claimed closed.

## Verified on this build

- Rust workspace: **737 passed, 0 failed, 2 ignored** across the rc.2 branch;
  the final app-only rerun after hardening passed **512 tests, 0 failed,
  1 ignored**.
- Strict Clippy passed.
- UI: **392 tests passed**; all TypeScript checks passed.
- Runtime payload: 15,995 files, 0 reparse points, sealed; adapter resolution
  probe passed.
- UI payload: 193 files.

## Limits

The installer was produced by `cargo tauri bundle` from the release executable.
The build script's NSIS `pre-bundle` resource-verification step did not complete
because its verifier stalled; the installer was not deleted or re-signed. The
app was not installed or launched by this run. Code signing, automatic updates,
clean-machine acceptance, installed-app acceptance and in-place upgrade remain
unqualified.

The private evidence disclosure is in
[docs/security/2026-10-17-evidence-disclosure.md](../security/2026-10-17-evidence-disclosure.md).
