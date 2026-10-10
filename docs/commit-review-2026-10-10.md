# Windows port review and source checkpoint — 2026-10-10

Reviewed the accumulated working changes based on `a441ca7`, including the previously untracked installer, packaging helpers, native guest and policy modules, bridge tests and updater probe. The user authorized committing this checkpoint. The upstream reference remains pinned; this review does not publish a release or replace an installed application.

## Findings fixed during this review

1. **P1 — startup cleanup and cancelled stop lost process ownership.** `cleanup_failed_start` took containment out of the slot, retired it before observing exit, ignored a five-second reaping timeout and advanced the generation anyway. Cancelling that wait also dropped its only containment owner. Ordinary stop likewise removed its containment/control link across an await. Both controlled cancellation regressions failed against their original implementations. Cleanup now keeps the slot's containment throughout the wait, revokes readiness/session facts, requires both child reaping and empty tree accounting, and propagates unresolved teardown rather than publishing a false terminal outcome. Ordinary stop retains the slot's ownership until settlement. Timeout and cancellation regressions verify ownership, start refusal and eventual retry settlement. Channel failure and process ownership are documented separately.

2. **P1 — Windows casing bypassed the reserved credential guard.** The guard treated casing changes as distinct identities, but the locked keyring backend builds Windows generic targets as `user.service`, and Windows `TargetName` is case-insensitive. Uppercase/mixed-case provider or reference aliases could therefore reach the same signing secret. The Windows boundary now recognizes those ASCII aliases before any credential access, including list/has visibility. Other platforms retain exact comparison. Tests cover aliases and preserve ordinary provider access; the review did not read, overwrite or delete real OS credentials. [Windows credential identity semantics](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw).

3. **P2 — keyboard native subscriptions could duplicate, leak or reject unhandled.** Multiple consumers could register the same input/changed/recording source before its promise settled. A late registration could overwrite a newer generation's disposer, and rejection had no handler. Sources are now shared while pending, explicitly owned, retired on final unsubscribe and guarded against stale delivery. Rejected installation is reported and can retry on a later subscription. Three regressions cover concurrent consumers, rejection/retry and out-of-order registration settlement.

The gateway test and three new text inputs had their line endings normalized to LF, preserving encoding/BOM. Generated client plugin output is retained locally but removed from source tracking under the existing ignore rule; the normal UI build regenerates it before full runtime staging.

## Verification performed

| Check | Result and retained evidence |
| --- | --- |
| Windows execution preflight | Parent and actual children Medium; pinned Node 22.20.0; owned write, named pipe, sentinel and watchdog passed. No relabel or shared-store change. |
| Combined packaging/Node/UI gate | 19 lanes passed, zero lane skips/failures. All seven packaging suites passed: 50/74/14/14/9/12/109 assertions. Root Node: 296 tests, 294 passed, two deliberate opt-in skips; additional Node lanes: 16/11/31/25/6 passed. Initial UI: 364 passed. Receipt: `%LOCALAPPDATA%/DSH-Qualification/gate-4da05608`. |
| Final packaging recheck | Eight lanes passed, zero skips/failures: preflight plus all seven packaging suites, with the same assertion counts after NSIS source line-ending cleanup. Receipt: `%LOCALAPPDATA%/DSH-Qualification/gate-31223d56`. |
| Updated UI gate | Six lanes passed after the keyboard repair: 18 test files / 367 tests; all three TypeScript projects clean; real Vite build produced 193 files / six assets. Receipt: `%LOCALAPPDATA%/DSH-Qualification/gate-973ecb2e`. |
| Rust workspace | Locked/offline build, 14 emitted test-image integrity probes, **699 passed / zero failed / two ignored**, and strict all-target Clippy passed. Receipts: `DSH-Qual-244faeed/checkpoints/workspace-build-20261010-192730-e849de64`, `workspace-test-20261010-192811-705b307b`, `clippy-20261010-192909-4bc8a0e2` under `%LOCALAPPDATA%`. |
| Standalone updater probe | **206 passed**, including the test-only cache facade. Receipt: `%LOCALAPPDATA%/DSH-Qual-244faeed/checkpoints/probe-test-20261010-192936-1f6e0391`. This uses MockRuntime and stand-ins; it does not accept native updating. |
| Source hygiene | Both Rust workspaces pass formatting checks. Patch whitespace check is clean. Changed/new source scanned for common credential/private-key patterns with zero matches. Required untracked inputs are included; generated runtime seals, binaries, scratch profiles, logs and local qualification receipts remain excluded. |

The final Rust gates include the ordinary-stop cancellation repair and source line-ending cleanup. The UI recheck accepts the repaired bridge and its production build. Subsequent final-newline cleanup in a publication helper and a UI test does not change production behavior.

## Remaining qualification

The earlier post-format DEBUG battery in the [repair ledger](repair-ledger-2026-10-10.md) establishes healthy Host readiness, replacement, graceful quit and guarded cleanup for its recorded image. It predates this review's credential, failed-start and keyboard changes and is not acceptance of a rebuilt image containing them. This review ran source, fixture and build checks; it did not launch another application or installer.

Native guests remain disabled. Actual interception, dialogs, failure-close, unresolved-stop consent, DPI/zoom placement and complete native teardown still need product observations. Updates inside Settings remain deferred under the documented account-plugin fallback. Clean release installation without system Node, upgrade/uninstall and signed updater trust remain separate qualification gates. Passing this checkpoint does not establish full feature parity or release readiness.
