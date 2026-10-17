# Active port repair checkpoint — 2026-10-10

## Starting point and preservation

- Authorized source root: `%USERPROFILE%/OneDrive/Dokumen/Coding/dsh`.
- Reviewed baseline: `bd4641e1c58928add9f0adddf5e9afe8fbd201ea`.
- Work branch: `repair/installer-runtime-release-20261010`.
- Preserved upstream: `477b4f420553e8a52c2fbccc464d7561b239c443`; upstream edits remain prohibited.
- [Verified source checkpoint](%USERPROFILE%/Hermes/dsh-desktop/port-repair-20261010-220615-33378627/checkpoint.json): 444 tracked-source/plan files archived and hash-read back before edits; dependencies and generated resources are explicitly outside this snapshot's scope.
- Archive SHA-256: `4f0d14e3b4da72065384102e564dac45803fc3615729c22a563520ad76ff99c0`.
- The older `Documents/dq-5a111a08` repair tree and its unsigned installer are separate sources/bytes. Their 569/20-test counts and installer readback are not acceptance of this Git checkout.

## Current work and evidence boundaries

Installer contract/template, reviewed runtime-lock staging, and Release handoff source repairs are in independent Luna workstreams. A read-only maintained-TUF/cryptography migration assessment is separate. Worker summaries are not acceptance: the parent must inspect exact changes, run integrated gates and make separate reviewable local commits. No production release/trust configuration is enabled by these tasks.

The initial [current status](../STATUS.md) has eight explicit rows. It deliberately carries no matched execution receipt for the changed tree: source/UI/Host/native/installer/installed rows remain UNQUALIFIED, and Settings Updates/native guest work remains DEFERRED. No historical receipt was promoted.

### Focused status-contract source regression

- [Latest stdout](%USERPROFILE%/Hermes/dsh-desktop/port-repair-20261010-220615-33378627/status/declaration-green-13/stdout.log) and [runner receipt](%USERPROFILE%/Hermes/dsh-desktop/port-repair-20261010-220615-33378627/status/declaration-green-13/receipt.json): **6 tests, 6 passed, 0 failed, 0 skipped**, exit 0.
- Pinned Node 22.20.0, exact image SHA-256 `fdddbf4581e046b8102815d56208d6a248950bb554570b81519a8a5dacfee95d`; parent and actual runner Medium; owned pipe/write/sentinel/watchdog preflight passed.
- This accepts only the dirty-tree helper inputs named by the receipt. It is not a committed whole-source gate, application image, installer contract or installed-artifact qualification.
- Six separately retained RED slots reproduce missing helper/identity guard/incomplete-PASS guard/renderer/duplicate-row guard/explicit declaration defects. Each subsequent GREEN is a distinct slot; failed receipts were not overwritten.
- Schema validation rejects mismatched source/input/artifact identities, unsupported schema/result values, booleans as counts/exits, accounting mismatches, missing/duplicate feature checks, absent hashed evidence references and invalid execution intervals. PASS cannot hide failures, skips or ignored tests. Receipt schema validation does not authenticate a report's author or replace inspection of its producing stage.
- The source contract is explicitly named in `run-verification-gate.ps1` with nonempty floors; this source declaration is not an all-lane execution result.
- [Actual status-generator invocation](%USERPROFILE%/Hermes/dsh-desktop/port-repair-20261010-220615-33378627/status/generation-11/receipt.json) exited 0 under the attested interpreter and produced the eight-row root status page. The generator accepts structured inputs in `docs/current-status.json`; ordinary prose edits have no invented test counts.

## Entry points and historical evidence

[Root README](../README.md), [docs index](README.md) and [verification report](verification-report.md) point at current status and this checkpoint. The obsolete docs-index claim that `app/` and `dsh-gateway/` do not exist has been removed. The report's historical body, including P6/P9 observations and failures, remains unchanged.

[Prior review](commit-review-2026-10-10.md) and [earlier repair ledger](repair-ledger-2026-10-10.md) remain historical evidence for their recorded source/images. They do not accept the latest workstream edits.

## Deliberately open gates

- Production delivery stays disabled without authentic publisher trust, compatible signed release artifacts, target/freshness/rotation/migration acceptance and exact production TLS/feed receipts.
- Full current-source Rust/probe/strict-Clippy/all-lane qualification remains pending until integration and source freeze.
- New sealed bundled-Host readiness and rebuilt DEBUG readiness/replacement/quit/menu observations require their own exact hashes.
- Owned executable NSIS contract fixtures are not a real upgrade. Qualification-product installation must have separate registry/product/data identities; custom destination alone is insufficient isolation.
- Exact production release install/upgrade/uninstall without system Node requires a non-overlapping account/environment and explicit current receipts. No production installer has been executed by this repair checkpoint.
- Settings Updates activation stays deferred; the application-menu route and More > Settings fallback remain intentional. Both native guest admissions remain disabled, and shared byte-identical Rust/TypeScript protocol fixtures remain intact.
