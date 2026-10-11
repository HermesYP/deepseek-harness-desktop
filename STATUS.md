# Current Windows port status

Reviewed baseline: `bd4641e1c58928add9f0adddf5e9afe8fbd201ea`.
Report generated: 2026-10-10T22:26:56.194782+05:30 (IST dates are recorded in receipts).

A source check, compiled fixture or historical image cannot qualify a different artifact or installed behavior. Missing receipts stay UNQUALIFIED; deliberately skipped work stays DEFERRED. No production update delivery or release publication is accepted here.

| Gate | Status | Source commit | Artifact SHA-256 | Date | Scope / measured counts | Deliberate skips / evidence |
| --- | --- | --- | --- | --- | --- | --- |
| Source checks | UNQUALIFIED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Current-source locked Rust/probe tests, strict Clippy and declared all-lane checks; historical counts do not accept changed inputs; no matched execution receipt | no matched receipt; current gate open |
| UI build | UNQUALIFIED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Fresh preserved UI output and inventory hash; no renderer activation inferred; no matched execution receipt | no matched receipt; current gate open |
| Bundled Host | UNQUALIFIED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | New sealed payload, bundled interpreter and dependencies, composition and actual readiness; no matched execution receipt | no matched receipt; current gate open |
| Native app | UNQUALIFIED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Rebuilt DEBUG image, readiness, Host replacement, graceful quit and application-menu route; no matched execution receipt | no matched receipt; current gate open |
| Updater / installer contract | UNQUALIFIED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Production argv, expanded non-killing template and owned wait/refusal/race/one-relaunch fixtures; not a real upgrade; no matched execution receipt | no matched receipt; current gate open |
| Clean install / upgrade / uninstall | UNQUALIFIED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Exact release bytes, production identity without overlap, no system Node; separate installed-artifact gate; no matched execution receipt | no matched receipt; current gate open |
| Settings Updates activation | DEFERRED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Existing application-menu update route and More > Settings fallback remain intentional; no matched execution receipt | Separate deferred feature; do not disable account Settings |
| Native guest admission | DEFERRED | not recorded | not recorded | 2026-10-10T22:26:56.194782+05:30 | Interception, failure-close, permissions, download/popup isolation, DPI/zoom and teardown remain unqualified; protocol fixtures retained; no matched execution receipt | Admission remains disabled pending exact product receipts |

Counts above come only from schema- and identity-validated structured receipts; overlapping suites are not summed. A receipt must name all required feature checks. A PASS containing ignored/skipped tests, missing checks, a nonzero exit, or mismatched source/artifact identities is rejected.

Current work: [repair checkpoint](docs/repair-checkpoint-2026-10-10.md) and [implementation plan](docs/port-fix-plan-2026-10-10.md).
History: [review checkpoint](docs/commit-review-2026-10-10.md), [earlier repair ledger](docs/repair-ledger-2026-10-10.md), and [verification report](docs/verification-report.md). These remain evidence only for their recorded sources/images.

Native guest admission remains disabled. The Settings Updates section is deferred; the functioning application-menu update route and More > Settings fallback remain intentional. Exact release installation, upgrade and uninstall without system Node require a separate non-overlapping production-identity environment.
