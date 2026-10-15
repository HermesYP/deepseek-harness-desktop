# Windows preview: Harness 0.2.1-alpha.3

**Unsigned community prerelease for controlled testing. Not an official upstream Windows binary. Do not use this release as an in-place upgrade over an existing installation.**

- Release tag: `desktop-v0.2.1-alpha.3-port.20261015.1`.
- Target: Windows x64, Tauri desktop wrapper with the upstream Node host and web client.
- Upstream: [dsh-v0.2.1-alpha.3](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-alpha.3), commit `2fbf4359b82fb94c03dcce0b831660d87f12ea5c`.
- [Release and downloads](https://github.com/HermesYP/deepseek-harness-desktop/releases/tag/desktop-v0.2.1-alpha.3-port.20261015.1).

## Download identity

Download the [Windows x64 installer](<https://github.com/HermesYP/deepseek-harness-desktop/releases/download/desktop-v0.2.1-alpha.3-port.20261015.1/DeepSeek-Harness-Desktop-0.2.1-alpha.3-port.20261015.1-windows-x64-setup.exe>).

- Installer size: **122,749,788 bytes**.
- Installer SHA-256: `3affc18993500fd0ccb469b02274731c78cb56302d45eb5f638d26d0ea63fd90`.
- Native application SHA-256: `c38ea4e7dcdc700abc2faa5ffe684e0d7983a9b4a59c796803303dadc03698f8`.
- Bundled uninstaller SHA-256: `d3fe1f5df1dd56f7b3698a8673cebc9cea0df3ba5626aacafe151b50aa7dfa8a`.

[SHA256SUMS.txt](<https://github.com/HermesYP/deepseek-harness-desktop/releases/download/desktop-v0.2.1-alpha.3-port.20261015.1/SHA256SUMS.txt>) and [BUILD-IDENTITY.json](<https://github.com/HermesYP/deepseek-harness-desktop/releases/download/desktop-v0.2.1-alpha.3-port.20261015.1/BUILD-IDENTITY.json>) accompany the installer. The release name differs from the locally tested filename, but the installer bytes are unchanged. Checksums identify bytes; they are not code signing or independent provenance attestations.

## What changed

- Targeted the official alpha.3 release, with reviewed Windows runtime locks and updated account integration.
- Used the actual Windows browser profile for authorization instead of a blank isolated browser profile; retained normal credential-store behavior.
- Restored a reachable sidebar collapse/reopen control in the Windows title-bar layout.
- Repaired real NSIS packaging: early plugin registration, shared mode-variable ordering and canonical resource source paths.
- Kept the physical-file and byte-exact resource guards; did not bypass them to obtain a bundle.

## What was actually verified

The following describes this particular build and test machine, not universal feature coverage:

- **Compiled and installed human checks:** sign-in through the normal browser profile, a real new chat reply, terminal execution, sidebar collapse/reopen, and retained authentication/conversation after restart.
- **Actual isolated install:** the NSIS installer exited 0, and the installed executable and uninstaller were checked. The install used `/NS`; ordinary shortcut creation and default-path deployment were not accepted by this test.
- **Every installed resource:** all 15,978 runtime files and 193 UI files matched their qualified source trees by membership and SHA-256, with physical metadata checked. Missing, extra and mismatched counts were zero.
- **Native and affected regressions:** the recorded Rust run passed 511 tests with one ignored; the account suite passed 25 with one skipped; the bridge suite passed 249. These were separate scoped runs, not a claim that all upstream features were tested.
- **Real bundling:** compilation, pre-bundle resource guard, actual NSIS bundle and post-bundle resource guard completed in order. The source-path boundary was tested with the real compiler rather than inferred from string length alone.
- **Preservation-mode removal:** the pinned uninstaller exited 0 using `/UPDATE`, the owned test app was removed, both original registry leaves were restored exactly, and authenticated profiles were retained.
- **Windows preservation:** installation/removal comparisons found no changes to 198 shortcut files, 290 jump-list files or the product autostart state. No reparse entries were skipped.

### Tray behavior

Closing the window can leave the app running in the tray. Use **Quit** from the tray to exit fully. The restart/removal witness did not mistake a closed window for process exit and did not force-kill the application.

### Transparent restoration incident

The separate qualification transaction helper initially stopped during registry restoration: Windows PowerShell 5.1 treated the native registry tool's successful stderr banner as a terminating error. One leaf had already been restored; the other had not. A guarded, hash-pinned, absent-leaf-only recovery imported the remaining backup via a process API and checked its exit code. Both original leaves were then independently verified exactly. The original failure record was retained. A separate synthetic test reproduced the helper bug and verified the process-API fix. This was not reported as a clean pass of the original wrapper, and the frozen failed transaction was not rerun.

## Source and evidence scope

The release tag includes the final native/packaging repairs and reviewed runtime-lock inputs, rather than pointing only at the older pre-repair HEAD. The source snapshot was committed after local qualification; that does not make this a reproducible-build or signed-provenance claim. The [build identity](<https://github.com/HermesYP/deepseek-harness-desktop/releases/download/desktop-v0.2.1-alpha.3-port.20261015.1/BUILD-IDENTITY.json>) records the exact source commit and tree used for the release snapshot.

This public summary omits machine-specific paths and registry contents. The release attachments do not include authenticated profiles, credentials, registry backups or raw local diagnostic logs. No application rebuild or deployment is part of publication.

## Important limits

**Not established:** default-path/current-profile production deployment; clean-machine acceptance; genuine alpha.2-to-alpha.3 or older in-place upgrade; ordinary app-data-removing uninstall; code signing; automatic-update delivery; automated GUI coverage; or every individual upstream feature. Historical feature, performance and policy gates are not erased by these core-flow results.

The ordinary upgrade path may invoke a previously installed uninstaller. New package guards do not retrofit that older binary, so an existing installation requires a separately controlled replacement decision. The qualification test installation was removed afterward, with the original registration and authenticated profiles preserved; it was not left as a daily-use deployment.

This release is marked **prerelease** and **not latest**. It does not publish an automatic-update feed, signing claim, or portable package.
