# Windows preview: Harness 0.2.1-rc.2

**Unsigned community prerelease for controlled testing. Not an official upstream
Windows binary. Do not use this release as an in-place upgrade over an existing
installation.**

- Release tag: `desktop-v0.2.1-rc.2-port.20261017.1`.
- Target: Windows x64, Tauri desktop wrapper with the upstream Node host and web
  client.
- Upstream: [dsh-v0.2.1-rc.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2),
  commit `687f282e8625c6b8d11ff58211a90524be2e4317`.

## Download identity

_To be filled from the exact built artifact. Do not publish this file before the
artifact hashes below are replaced._

- Installer: `DeepSeek-Harness-Desktop-0.2.1-rc.2-port.20261017.1-windows-x64-setup.exe`
- Installer size: `TBD`
- Installer SHA-256: `TBD`
- Native application SHA-256: `TBD`

## What changed

- Upgraded the preserved runtime and client from upstream `0.2.1-alpha.3` to
  `0.2.1-rc.2` (DeepSeek-V4.1-Flash-1017 and DeepSeek Search/Fetch support).
- Re-materialized the reviewed Windows runtime lock from a built rc.2 checkout
  (304 tarballs, two reviewed dependency patches).
- Re-anchored the account and Cordis transforms against the rc.2 emitted code.
- Removed the private evidence capture from the repository, redacted the expired
  reference token, added `LICENSE`/`NOTICE`, and added a repository hygiene gate
  and CI workflow.
- Wired the installer license page to the repository `LICENSE`.

## What was verified

_This section must describe the exact build only; replace placeholders after the
artifact is built and checked._

- Rust workspace: `cargo test --workspace --locked` and strict Clippy pass.
- UI: `pnpm test` (392 tests) and `pnpm run test:types` pass.
- Runtime: frozen lock validation, payload seal, adapter resolution probe.
- Installer: NSIS build, SHA-256 of installer and native executable recorded.

## Important limits

**Not established:** code signing, automatic-update delivery, clean-machine
installation, default-path deployment, in-place upgrade, native guest admission,
or exhaustive feature coverage. The installer is unsigned and may trigger
SmartScreen. A rebuild is not claimed to be byte-identical.

The private evidence disclosure is in
[docs/security/2026-10-17-evidence-disclosure.md](../security/2026-10-17-evidence-disclosure.md).
