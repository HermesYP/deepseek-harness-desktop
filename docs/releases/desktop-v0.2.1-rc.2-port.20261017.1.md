# Windows preview: Harness 0.2.1-rc.2

**Unsigned community prerelease for controlled testing. Not an official upstream
Windows binary. Do not use this release as an in-place upgrade over an existing
installation.**

- Release tag: `desktop-v0.2.1-rc.2-port.20261017.1`.
- Target: Windows x64, Tauri desktop wrapper with the upstream Node host and web
  client.
- Upstream: [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2),
  commit `687f282e8625c6b8d11ff58211a90524be2e4317`.
- Port source: commit `420afee` on `release/desktop-0.2.1-rc.2-20261017.1`.

## Download identity

- Installer: `DeepSeek-Harness-Desktop-0.2.1-rc.2-port.20261017.1-windows-x64-setup.exe`
- Installer size: **122,789,943 bytes** (117.1 MiB)
- Installer SHA-256: `5bae713d6882649ca700f4f53a4704ac95c4b88d31bb6f9e3d60ea5993966a52`
- Native application SHA-256: `c11718c8190e2e0841e8c0240b5de37b49283276856817c7a334c6dd94aa28c2`
- Authenticode status: **NotSigned**

The installer was produced by `cargo tauri bundle` from the release executable
after the Tauri build. The build script's NSIS `pre-bundle` resource-verification
step did not complete because its verifier stalled; the produced installer was
not deleted or re-signed. This is recorded as a qualification limitation, not as
a completed guard.

## What changed

- Upgraded the preserved runtime and client from upstream `0.2.1-alpha.3` to
  `0.2.1-rc.2` (DeepSeek-V4.1-Flash-1017 and DeepSeek Search/Fetch support).
- Re-materialized the reviewed Windows runtime lock from a built rc.2 checkout
  (304 tarballs, two reviewed dependency patches, `REVIEWED` descriptor).
- Re-anchored the account and Cordis transforms against the rc.2 emitted code.
- Removed the private evidence capture from the repository, redacted the expired
  reference token, added `LICENSE`/`NOTICE`, and added a repository hygiene gate
  and CI workflow.
- Wired the NSIS license page to the repository `LICENSE`.

## What was verified on this build

- Rust workspace: **737 passed, 0 failed, 2 ignored**; strict Clippy passed.
- UI: **392 tests passed**; all three TypeScript checks passed.
- Account transforms: 19 passed, 2 skipped.
- Target/packaging release-identity tests: 21 passed.
- Runtime payload: **15,995 files**, 0 reparse points, deepest path 232 chars,
  sealed and adapter resolution probe passed.
- UI payload: **193 files**.
- Installer and native executable hashes recorded above.

This is not a clean-machine acceptance, an installed-app acceptance, an
in-place-upgrade test, code signing, automatic-update delivery, or exhaustive
feature coverage. The app was not installed by this run.

The private evidence disclosure is in
[docs/security/2026-10-17-evidence-disclosure.md](../security/2026-10-17-evidence-disclosure.md).
