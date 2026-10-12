# Desktop Updates repair — 2026-10-12

The Updates plugin now composes alongside Account, and the final staged Host
advertises and serves it. Its served factory mounts through real Cordis and
registers the Settings section. A freshly compiled Release portable is supplied
for native testing. No production release delivery is enabled.

## Findings and changes

The existing desktop bundle was deliberately a no-op after the previous account
launcher regression. A package in the payload cannot become a client plugin
without an enabled Loader row. The bundle now uses the production loader's
`insert` form. Account remains enabled and owns the single Settings launcher;
the Updates plugin contributes only its section. Its own old bundle patch is a
compatibility no-op. Profiles and the preserved upstream checkout are unchanged.

The plugin previously displayed renderer-owned feed settings while the actual
updater consumed packaged `updates.json`. The new informational native command
`update_configuration` returns the effective channel, packaged feed, available
channels, channel pin and a classified disabled reason. It exposes no keys and
supplies no write authority. Missing source, invalid source, missing channel and
missing signing key have separate explanations. Failed reads have a working
Retry action. A single configured channel remains selectable when an older
preference names another channel.

A packaged channel pin now takes precedence over an older saved preference in
both native checks and presentation. A fresh `idle` snapshot no longer claims
that a feed check occurred. Existing action ownership, channel-generation
invalidation and retained downloaded candidates remain covered by the tests.

The updater already passes `/S /UPDATE /R` to the Windows installer. The existing
verified file lease and non-killing installer hooks remain intact. Their tests
pass; this repair does not claim a real installed upgrade.

The official runtime stage now runs a production-loader composition gate before
publishing, asserts exactly one enabled Updates row plus enabled Account, and
hashes the new verifier as a build input. This catches the original absent-row
failure before launching an app.

## Final payload measurement

The opt-in `port/tests/fixtures/updates-host.mjs` fixture:

- Loads the final payload's production profile and verifies composition without
  a missing-entry warning.
- Starts its actual Host with an owned profile/home and no operator credentials.
- Confirms both Updates and Account are in the client graph.
- Fetches the exact revision-tagged URL advertised by that graph: HTTP 200.
- Executes the served factory through real Cordis with the actual snapshot-store
  engine and confirms section registration, no competing launcher, disabled-source
  explanation, no fabricated up-to-date result and no check request without authority.
- Server-renders the actual component and verifies that a sole configured beta
  channel remains selectable.

An initial probe fetched an invented unversioned combo URL and got 404. The Host
intentionally serves graph-advertised immutable URLs with their exact revision;
that first probe did not establish a production serving defect. Failed probe
receipts are retained alongside final passing evidence.

The native invoke channel and slot/locale adapters in this fixture are controlled
test boundaries. Client-only Zustand/Immer imports resolve from the pinned UI
toolchain, where the real built shell preloads them. They are not added to the
Host's production dependency set. This is plugin activation and component
evidence, not a native WebView2 screenshot.

## Validation and artifact

| Check | Result |
|---|---|
| Locked/offline Rust workspace | 727 pass, 0 fail, 2 previously ignored native tests |
| Locked/offline production updater probe | 227 pass, 0 fail, 0 ignored |
| Strict workspace Clippy | Pass |
| UI suites | 392 distinct tests: initial full run 390 pass with two stale command-count assertions; corrected protocol suite 57/57. Counts overlap and are not added. |
| Desktop bridge and Updates TypeScript checks | Pass |
| Installer source/template contracts | 12/12 |
| Executed NSIS hook behavior | 12 checks, PASS; refusal and single relaunch fixtures |
| Account regressions on the new payload | 18/18, 0 skipped |
| Final runtime seal | Pass |
| Preserved shell and authentic plugin production builds | Pass; loader wrapper matches upstream |

Candidate: `C:\Users\Yoova\Hermes\dsh-desktop\updates-fixed-20261012-portable\`.
Native Release SHA-256:
`b7ae70ec2469de9f871be2ff7144d1851f4687fe90cea5bbd4517fe4a7e38de8`.
The native executable is freshly compiled. The pinned runtime closure is retained,
with rebuilt port client bytes, a fresh shell and a new seal. Its final
`build-receipt.json` records the descriptor, source snapshot and exact evidence.

## Remaining delivery work

This portable has no `updates.json`: the Updates page explains that this build
has no release source and disables checking. A hosting preference was requested;
no production feed, signing key, GitHub release or repository publication was
created. No native window was operated during this update repair.

Before enabling production delivery, make the existing tested v2 metadata contract
authoritative in check/download/install admission, including product/target,
expiry, rollback state and a reviewed rotation/revocation path. The current
production path still uses v1 signatures over version, channel and artifact
digest. Configure real public trust keys and signed release hosting, then qualify
the actual updater-to-installer run with graceful shutdown, bounded waiting and
one relaunch. Qualification keys with publicly known private halves must not ship.

Native visual acceptance of this Updates page and exact install/upgrade/uninstall
remain open. Guest admission stays disabled. The account profile-refresh refusal
and the 1.5-second startup target are separate unresolved work. Changes are not
committed or pushed.
