# Current Windows port status

Reviewed baseline: `420afee` (`release/desktop-0.2.1-rc.2-20261017.1`).
Report generated: 2026-10-17.

A local source check, compiled fixture or historical image cannot qualify a
different artifact or installed behavior. No installed-app, clean-machine,
in-place-upgrade or automatic-update acceptance is claimed.

| Gate | Status | Evidence |
| --- | --- | --- |
| Upstream target | INTEGRATED | `dsh-v0.2.1-rc.2` at `687f282e8625c6b8d11ff58211a90524be2e4317`; 304-package reviewed runtime lock, `REVIEWED` |
| Source checks | LOCAL PASS | Rust: 737 passed, 0 failed, 2 ignored; strict Clippy pass. UI: 392 tests, all TypeScript checks. Account: 19 passed, 2 skipped. Target/packaging: 21 passed |
| UI build | LOCAL PASS | `port/ui/dist` = 193 files, built with the pinned rc.2 toolchain |
| Bundled Host | LOCAL PASS | 15,995 files, 0 reparse points, deepest path 232 chars; sealed payload and adapter resolution probe |
| Native app | BUILT, NOT LAUNCHED | `dsh-desktop.exe` SHA-256 `c11718c8190e2e0841e8c0240b5de37b49283276856817c7a334c6dd94aa28c2` |
| Windows installer | BUILT, NOT INSTALLED | NSIS installer 122,789,943 bytes, SHA-256 `5bae713d6882649ca700f4f53a4704ac95c4b88d31bb6f9e3d60ea5993966a52`, **NotSigned** |
| Clean install / upgrade / uninstall | UNQUALIFIED | Not run for this artifact |
| Settings Updates activation | UNQUALIFIED | Native WebView2 acceptance not run |
| Native guest admission | DEFERRED | Admission remains disabled |

## Qualification caveat

The NSIS installer was produced by `cargo tauri bundle` from the release
executable. The build script's `pre-bundle` resource-verification step did not
complete because its verifier stalled; the installer was not deleted or
re-signed after that step. This is a real gap in the release guard, recorded
rather than hidden.

The local test counts above are source checks, not installed acceptance. The
application was not launched by this run, and the installer was not executed.

The private evidence disclosure is in
[docs/security/2026-10-17-evidence-disclosure.md](docs/security/2026-10-17-evidence-disclosure.md).
