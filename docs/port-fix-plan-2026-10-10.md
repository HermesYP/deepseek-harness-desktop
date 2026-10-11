# Port repair plan: installer handoff, reproducible payload, and release boundaries

Date: 2026-10-10. Reviewed baseline: `bd4641e1c58928add9f0adddf5e9afe8fbd201ea`.

## Outcome and scope

Make the Windows updater invoke an installer that waits, refuses safely, and relaunches once; freeze runtime dependency resolution; remove development handoffs from release builds; and make release trust and qualification status explicit.

This is an implementation plan, not new execution evidence. It changes neither runtime code nor release configuration. The fixes below should be separate reviewable commits, with receipts identifying the source commit and, for execution, the exact executable hash.

The existing project is the starting point. Keep the preserved upstream checkout unchanged, retain the functioning application-menu update route and More > Settings fallback, and keep native guest admissions disabled. The deferred Updates section inside Settings is a separate feature task; it is not a prerequisite for repairing the native updater.

## Current findings and decisions

| Finding | Current conclusion | Planned treatment |
| --- | --- | --- |
| Installer gets only `/S` | Confirmed. Spawn success does not prove installation success. | Fix first; test the production invocation against executable NSIS behavior. |
| Installer never kills | True of the custom hooks, not of the complete installer. The stock check after the hooks can kill a process that appears between checks. | Remove reachable killing branches from the port's install and uninstall paths. |
| Runtime lockfile generated during normal build | Confirmed. Freezing a just-generated lock does not freeze dependency inputs across builds. | Promote reviewed, portable runtime locks; normal builds must consume them unchanged. |
| Dependency scripts unspecified | Needs correction. The imported runtime metadata generator sets `allowBuilds`. | Preserve required native builds, explicitly pin policy, and test unknown-script rejection. |
| Development handoff in release | Confirmed, including the companion boot-payload writer. | Compile both handoff paths out of shipped release builds. |
| Update freshness, revocation, target binding | Real design gaps, with no qualified production feed today. | Add authenticated metadata evolution before enabling production delivery. |
| Status documentation stale | Partly corrected already. Root README/report identify historical evidence; docs index still has obsolete claims. | Add a concise status page and repair conflicting pointers. |
| Native guests and protocol fixtures | Guest admission remains unqualified; the shared serialization fixtures are useful and should stay. | Preserve gates and fixtures; qualify native behavior separately. |

## 1. Repair the updater-to-installer contract and remove process killing

Primary files: `port/src-tauri/app/src/update_flow.rs`, `port/installer/installer-hooks.nsh`, `port/installer/installer-process.nsh`, `port/src-tauri/app/tauri.conf.json`, and the NSIS packaging suites.

### Changes

1. Make the Windows production launch pass exactly `/S`, `/UPDATE`, and `/R`. Keep its verified artifact path, read lease, lifecycle admission, graceful Host shutdown, and spawn-failure recovery intact. Retain non-Windows behavior without claiming those installers are qualified.
2. Put argument construction at a small shared production boundary that both the real launcher and its tests use. Do not let a test build its own unrelated argument list.
3. Add a repository-owned NSIS template derived from the pinned Tauri bundler template. Replace the stock killing checks with the port's bounded, non-killing refusal logic in both Install and Uninstall. Register that template through Tauri configuration; do not edit the Cargo registry, installed NSIS toolset, or shared caches.
4. Preserve the rest of the pinned template's behavior: languages, current-user installation, custom destination, registry/shortcut handling, upgrade invocation, and silent/passive relaunch. Keep a provenance hash and a narrowly reviewed template diff. A Tauri version change must force template review.
5. Check the upgrade path's invocation of an existing uninstaller as well. An old uninstaller can retain an old killing branch; a new template must not be credited with fixing historical installer bytes. Record any unsupported upgrade baseline explicitly.
6. Keep name-based detection's conservative side-by-side refusal for this milestone. A path-aware native helper is a separate enhancement. Repeated checks are not an atomic installation lease; document that concurrency limit and keep file-copy failures visible.

### Acceptance

- A controlled executable receives the arguments emitted by the production launch boundary, including paths containing spaces.
- An executable NSIS fixture waits for an owned app stand-in to exit, permits the update afterward, and records exactly one relaunch.
- A stuck stand-in produces a bounded refusal and exit code 2, with installed sentinel bytes unchanged.
- A deterministic barrier introduces a same-name process after the first hook check and before the subsequent check. The installer refuses; the process remains alive. Run this for install and uninstall.
- A separate same-name installation is refused without termination.
- Missing or invalid process observations refuse safely. Spawn failure still restores the Host or reports the existing recovery outcome.
- Inspect the actual rendered/expanded installer program produced by the bundle pipeline. There must be no reachable stock name-based kill operation. Merely compiling the existing shortened hook fixture is insufficient.
- Run existing NSIS behavior, strings, compile, and instance-guard checks with the new template, preserving non-pass handling for skips.

The contract fixture is not acceptance of a real upgrade. A packaged updater-to-installer run remains in the final product qualification gate.

Suggested commit: `Fix Windows update handoff and remove installer process killing`.

## 2. Freeze the runtime dependency inputs

Primary files: `port/scripts/lib/runtime-payload.psm1`, `port/scripts/lib/payload-manifest.psm1`, `port/scripts/build.ps1`, and materializer/seal/build tests.

### Changes

1. Establish the Windows x64 runtime package closure as the first supported lock target. Other targets need their own reviewed inputs or an explicitly validated shared lock; Node archive availability does not qualify their full runtime.
2. Add a port-owned runtime-lock input directory containing the reviewed lockfile, workspace build policy, and a descriptor of upstream commit, package-manager version, target, dependency metadata, and local tarball inputs. Use stable relative tarball paths rather than machine-specific staging paths.
3. Add an explicit lock-refresh maintenance command. It resolves dependencies in an owned staging root, emits a candidate diff and input descriptor, and never silently blesses the result as a normal build step.
4. Remove `install --lockfile-only` from the normal runtime stage. Copy the reviewed inputs into the isolated project and install frozen; missing, stale, or mismatched inputs must fail before publication. Keep lock integrity enforced when using the existing `--trust-lockfile` option.
5. Preserve the upstream-approved native script allow-list. Make the port's expected policy and strict handling explicit, reject ambient settings that would widen it, and record which reviewed builds executed. Do not add blanket `--ignore-scripts` without qualifying the required native modules.
6. Bind the lock, policy, and input-descriptor hashes into the payload manifest alongside the existing final-file seals. The build must compare expected inputs, not just create a new inventory of whatever it resolved.
7. Check local tarball stability. If rebuilding identical inputs changes their integrity, identify archive metadata or build-output nondeterminism and fix or explicitly bound it. Do not quietly regenerate the expected lock or digest to make the build pass.

### Acceptance

- Two fresh staging roots consume the same reviewed lock and produce the same resolved package versions/integrities.
- A registry offering a newer compatible transitive version cannot alter the frozen build.
- Missing lock, changed dependency metadata, altered tarball integrity, wrong target, and mismatched build policy each fail before the atomic publish step; the previously published payload stays intact.
- An unreviewed dependency build script cannot run. Required native modules still load and the actual bundled Host reaches readiness.
- Existing reparse-point, packaged-resolution, seal, and atomic-publication checks remain green.
- Compare final payload inventories as well. Report byte-for-byte reproducibility only if those inventories match; a stable dependency graph alone is a narrower result.

Suggested commit: `Consume reviewed runtime locks during payload staging`.

## 3. Remove development handoffs from release builds

Primary files: `port/src-tauri/app/src/dev_handoff.rs`, `port/src-tauri/app/src/lib.rs`, and `port/src-tauri/app/src/commands.rs`.

### Changes and acceptance

1. Apply `cfg(debug_assertions)` to the gateway URL and boot-payload handoff boundaries and their callers, keeping release compilation and strict Clippy clean.
2. Keep DEBUG acceptance opt-in, exclusive file creation, owner-only permissions, and refusal to replace existing files.
3. Add a release-mode regression demonstrating that setting either development handoff variable cannot create a handoff file, export session material, or introduce a handoff-path startup failure. Compile-time assertions alone must be described as compile evidence.
4. Re-run existing DEBUG handoff protection tests. Check that session material is absent from logs and evidence summaries.

Suggested commit: `Restrict acceptance handoffs to debug builds`.

## 4. Harden update metadata before enabling production delivery

Primary files: `update_security.rs`, `update_flow.rs`, signing fixtures/generator, updater probe, and `port/updates-trust.md`.

### Changes

1. Define a versioned signed release message that binds product, release version, channel, platform, architecture, artifact digest, and expiry. Add an authenticated metadata version/sequence where freshness and rollback checks require it.
2. Validate the target against the running packaged build before presenting or downloading the candidate. Verify signed metadata freshness before admission and again before installation, since a downloaded artifact may wait past expiry.
3. Specify clock-skew tolerance, unavailable/invalid-clock behavior, and persisted anti-rollback state. Expiry detects stale metadata; it cannot force a blocked network to deliver an update. Report stale metadata clearly without claiming installation succeeded.
4. Add authenticated trust-root/key updates with monotonic versions and an explicitly reviewed rotation/revocation policy. Prefer a maintained TUF implementation if it fits the product; assess its migration cost before adopting it. Reuse maintained cryptography rather than inventing signing primitives.
5. Embed or authenticate the initial trust anchor. Separate operator-controlled feed location from the authority to add signing keys. Preserve HTTPS, exact origin membership, redirect checks, size/time limits, SemVer comparison, re-hashing, and the Windows artifact lease.
6. Define migration from the existing v1 signature contract. Test any transitional acceptance explicitly; do not silently fall back to a weaker schema after v2 validation fails. Update publishing and verification together before any live feed uses the new schema.
7. Document that a user-writable application and trust store do not defend against arbitrary same-user malware. Changing installation privileges or account protections is outside this fix.

### Acceptance

- Wrong target/product/channel, altered digest, expired metadata, excessive clock skew, downgraded metadata/root version, unknown key, and revoked key are refused.
- Authorized key rotation works; a release signer cannot simply widen its own trust authority. Persisted minimum versions survive restart.
- A candidate expiring between download and install cannot be launched.
- Schema migration tests cover current artifacts and an existing installed version, with explicit unsupported cases.
- A local HTTPS fixture exercises the real network, signature, download, and installation boundary. Trust its fixture certificate only inside the test client/build; never disable TLS validation or change the account/global certificate store. Label fixture keys and qualification overrides clearly.
- No production feed, signing key, or release-readiness claim is enabled solely because headless tests pass. Exact production TLS/feed and installer acceptance remain separate receipts.

This is a larger release-security milestone. It must not delay repair of the already confirmed handoff, payload, or release-hook defects. Missing production trust continues to disable delivery while this work is incomplete.

Suggested commits: signed target/freshness contract, then authenticated trust rotation and migration.

## 5. Make current status easy to read

Primary files: root `STATUS.md`, `README.md`, `docs/README.md`, `docs/verification-report.md`, and the current repair ledger.

1. Add a short status page with separate rows for source checks, UI build, bundled Host, native app, updater/installer, clean install/upgrade/uninstall, Settings Updates activation, and guest admission.
2. Each row records PASS, FAIL, DEFERRED, or UNQUALIFIED; source commit; artifact hash where applicable; date; scope; deliberate skips; and an evidence link. A result for old bytes must not automatically accept a newer build.
3. Generate test counts from structured gate receipts, validating their source/artifact identity and result schema. Keep feature acceptance explicit; a newly passing source gate cannot promote native or installed status.
4. Point root and docs indexes at the current status/ledger and remove the obsolete claim that `app/` and `dsh-gateway/` do not exist.
5. Preserve historical failures and successful observations in the verification report, with dated scope labels. Do not rewrite P6/P9 history into current acceptance. State that the Settings update plugin is deferred and its fallback is intentional.

Acceptance: current entry points agree; missing receipts and skips cannot become PASS; deliberately mismatched source/artifact receipts are rejected. No new tests are needed for ordinary prose edits.

Suggested commit: `Separate current port status from historical verification`.

## 6. Qualification order on the current Windows account

A VM is not required for source gates or owned contract fixtures. Use the existing current-account qualification approach: fresh, local roots outside the labelled workspace, attested Medium executables and actual children, scoped environment changes, named-pipe/write/visibility/watchdog preflight, and process-creation identity records. Do not relabel the workspace or weaken its ACL/MIC protections.

Run in this order after each relevant milestone, broadening only when changes warrant it:

1. Focused regressions for that change, including a recorded failure against the original defect where useful.
2. Locked Rust workspace/updater-probe checks, strict Clippy, and affected TypeScript/UI checks using the existing trusted outside-target runners. Preserve ignored native tests as unqualified.
3. `powershell -NoProfile -ExecutionPolicy Bypass -File port/tests/run-verification-gate.ps1 -Lane all`, after adding the new contract coverage to explicitly declared lanes. Do not hide it behind an optional empty glob. This gate currently executes fixture suites, not a real installer.
4. Rebuild/stage and run the actual bundled Host. Verify the packaged interpreter, dependency tree, profile composition, and readiness from the new bytes.
5. Rebuild the DEBUG product; qualify readiness, Host replacement, graceful quit, and application-menu update behavior against its recorded image. Existing native receipts predate the latest source changes.
6. Qualify the updater-to-installer handoff in a deliberately isolated current-account product fixture, including expiry/signature refusal, bounded exit waiting, exactly-one relaunch, and persistence. Use a separate qualification product/registry identity and owned data paths; a custom install directory alone does not prevent registry collisions. Report that this build is a qualification fixture, not the exact production installer.
7. Qualify exact release install, upgrade, and uninstall without system Node in an environment where the production identity does not overlap an existing installation. A fresh Windows account is an alternative to a VM. This separate release gate is required before publishing a release, not before completing the source repairs.

All cleanup is restricted to recorded owned paths/process identities. Fixture failure, unknown visibility, or a watchdog rescue is a failed/refused observation, never a pass. Capture the specific failed boundary, retain evidence, and fix it before repeating broader runs.

## Work deliberately kept separate

- Native guest admission stays disabled until real interception, failure-close, permissions, downloads/popups, isolation, DPI/zoom placement, and complete teardown have their own product receipts. No extra mock coverage can replace this gate.
- Settings Updates activation remains deferred with the existing Settings fallback. When resumed, load the profile offline with production `dsh-app-boot` first; then inspect the actual staged Host's scan/resolution and browser `apply(ctx)` effects. Stop at the first measured failing boundary. Do not disable account Settings until replacement launchers and the Updates section both activate.
- Shared Rust/TypeScript byte-identical protocol fixtures remain the bridge contract regression mechanism. Extend them only when a protocol shape actually changes.

## Completion criteria

The repair checkpoint is complete when the updater contract and non-killing installer are exercised together, normal payload builds consume reviewed dependency inputs, release builds cannot export development handoffs, and status clearly identifies the remaining trust/native/release gates.

Production update delivery and release publication additionally require milestone 4 and exact installed-artifact qualification. Keep those gates open if they have no current receipt; do not describe the repair checkpoint as full port completion.

## References used for the plan

- [Current code review](commit-review-2026-10-10.md) and [repair ledger](repair-ledger-2026-10-10.md).
- [pnpm build policy](https://pnpm.io/settings/build#allowbuilds) and [frozen installation](https://pnpm.io/cli/install#--frozen-lockfile).
- [TUF specification: freshness, rollback and authenticated root updates](https://theupdateframework.github.io/specification/v1.0.36/).
- [Pinned Node 22.20.0 official checksums](https://nodejs.org/dist/v22.20.0/SHASUMS256.txt); all six configured archive digests matched during the preceding review.
