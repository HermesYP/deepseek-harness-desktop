# Onboarding, account details and startup review

Date: 2026-10-12. Source checkpoint: `bff03b421bebc9e051236169f15f4e3793127a6d`, plus the changes in this detached worktree. This work did not modify the primary checkout or updater worktree. No commit or push was made.

## Current result

A separate local test portable is assembled at:

`%USERPROFILE%\Hermes\dsh-desktop\onboarding-startup-fixed-portable\dsh-desktop.exe`

It contains a newly built Release executable, the freshly built UI, the source adapter and the repaired account plugin. Its Host passed an isolated launch, authenticated settings read/write, orderly shutdown and sampled-descendant settlement check. Its runtime seal verified before and after that run. Native WebView2 interaction with the user's account remains pending. The 1.5-second startup target has **not** been achieved.

The payload is a verified snapshot of the existing portable with recorded local overlays, not a fresh official registry stage. The original payload's seal was checked before applying those overlays; the final manifest and descriptor were regenerated and verified. `repair-receipt.json` identifies the frozen base and final inputs. This does not qualify an installer, update, native guests or a production release.

## Findings and fixes

### P1: the user's portable contains several revisions

Changing source does not replace a portable executable. The executable the user identified remained at SHA-256 `e9c59508a2953f6173ca5d6cd9535a108f21123b363b80c9016091d89508153d`, while selected UI and Host files had been replaced in place by earlier hotfixes. The delivered adapter predates the source adapter's generation-4 acknowledgement, startup queue bounds and refusal/teardown handling. It uses a token-only preamble; the current source uses `token + generation` and awaits acknowledgement.

That adapter belongs with the older executable. Replacing either alone would introduce a protocol mismatch. The replacement portable uses both current components together. Its new executable SHA-256 is `df5459f18eb543d8e5634a8d6dd5b52c41ed5bfef9c67c0e254ee7576fb41201`.

This proves artifact drift, not that every reported symptom was caused by it. In particular, rebuilding cannot guarantee that an external account API will accept a profile request.

The native setup now logs the selected physical UI index and Host adapter paths/digests. This makes the files actually selected by a run observable, including when a development executable uses development resources. Startup's Node identity reader also ignores unrelated inventory rows rather than allocating a generic JSON tree for all of them. That allocation change is a small optimization; no measured startup win is attributed to it.

### P1: cached account details still waited on the failing profile request

The earlier portable-only disk fallback awaited `getDetail("profile", ...)` before looking at disk. A blocked or slow request therefore kept the UI waiting even when the same grant had usable saved details. The manual helper also wrote the final cache file directly and accepted unbounded/unvalidated input.

The port now owns this repair in staging:

- Return validated last-known display details for the exact current grant promptly, while refreshing in the background.
- Deduplicate background work within one grant lifetime; a newer lifetime can start its own refresh. A retired result cannot overwrite newer state.
- Keep the actual credential reader and `getDetail` rejection path. A cached profile never authorizes access. An HTTP 401 fixture still invokes credential expiry; subsequent reads return signed out.
- Bound the disk cache to 16 KiB, validate its projected profile fields, reject corrupt/wrong-grant files and discard unknown fields. Store a grant digest, never the raw grant.
- Publish through a unique temporary file and rename. A failed write cannot truncate the previous completed file. This is process-interruption protection, not a power-loss durability claim.
- Accept the previous v1 grant-key format for migration; write v2 with the full digest.
- Refuse unknown plugin versions or unreviewed compiled method bodies. Pin both helper files as payload inputs before sealing.

Files: `port/scripts/lib/account-profile-runtime.mjs`, `port/src-tauri/runtime/account-profile-cache.mjs`, `port/scripts/lib/runtime-payload.psm1`, `port/scripts/build.ps1`.

The captured account request previously received a server edge-block 403. A separate delivery lane's notes describe a later 202/non-JSON response after changing headers; that later network result was not independently verified here. No real grant or account API was used by this review's probes. A rebuild and display cache do not fix a server refusal, and there is no identity to restore if no successful profile has ever been saved. Wallet/balance data is not synthesized or persisted by this helper.

### P2: the earlier onboarding save error is currently not reproducible

The preserved Get started handler invokes the onboarding update; it is not an unbound button. The screenshot's footer represents a caught settings write error, whose original cause was discarded by the client catch handler.

The saved profile now records `step: done`. The user confirmed that a hard restart cleared the Welcome screen. The delivered ConfigEditor const-enum repair is present and retains its ACTIVE lifecycle check.

Two isolated production-profile checks passed: direct production composition/HTTP and the replacement's actual bundled adapter over the authenticated control channel. The latter used an owned copy of configuration only, an empty credential home, the real settings API and a real onboarding write. The actual serialized descriptor/write reply also passed the client mirror/controller diagnostic.

This is evidence that the current path works, not proof of the historical error's cause or native button acceptance. Do not reset the user's profile, delete credentials, weaken the lifecycle guard or silently mark onboarding complete as a fix.

### P1: most of the observed cold-start delay precedes browser plugin loading

The user's retained Node timing marks put one run's profile load at 148 ms, application resolution at 7,636 ms and ready at 7,639 ms. Other runs resolved at about 2.7–3.9 seconds. These are Node-uptime marks, not total native-launch-to-usable-UI measurements. The replacement's single isolated Host sample reached ready at 2,907 ms, while other work was running; it is a functional sample, not a performance benchmark.

The existing CPU profile points at file reads, module compilation/resolution, package-scope lookup and Cordis composition. A populated Node compile-cache experiment did not show a useful improvement over the approximately 2.6–2.7-second warm fixture baseline. Boot invoked ConfigEditor configuration only three times; speculative caching there was not added.

The rebuilt UI includes the existing preload sidecar. Its tests establish download/registration behavior, not an end-to-end 1.5-second launch. The replacement source adapter retains Office readiness ordering and current handshake protections. The older measurement adapter's post-ready Office change is not silently carried forward as evidence of parity.

## Validation

| Check | Result | Scope |
| --- | --- | --- |
| Native Release build | Pass | Locked, offline, owned target; actual cargo child Medium; artifact image checked and copy hash verified; native app not launched by this review |
| Native app library tests | 481 pass, 1 ignored | App library only; not a claim about all workspace or native guest acceptance |
| Strict Clippy | Pass | Workspace, all targets, warnings denied |
| UI build | Pass | Fresh qualified Vite output, 193 files |
| UI tests | 382 pass in 18 files | Desktop bridge, client updates, native guest models; not a live guest run |
| TypeScript | Pass | All three declared projects |
| Account repair | 6 pass, no skips | Actual packaged class, intercepted fixture HTTP, cache boundaries and rejection/lifetime behavior |
| Materializer/seal suites | 31 pass, no skips | Materializer contract inspection plus seal tests; not a full official runtime restage |
| Replacement bundled Host | Pass | Final sealed payload; generation-4 handshake, real settings read/write, shutdown-complete, exit 0, sampled descendants settled, seal unchanged |
| Native UI/account acceptance | Pending | Needs opening the new executable and exercising the visible product |
| <=1.5-second usable launch | Unmet | No qualifying native timing cohort recorded |

The first UI invocation used the wrong Vitest working-directory/root combination and failed module lookup. Re-running from the UI directory passed. The first Host fixture ACL audit could not load `Microsoft.PowerShell.Security` through the inherited module path. Selecting built-in Windows PowerShell modules for the test child made the same owner/SYSTEM-only, non-inherited ACL audit pass. No global environment or protection was changed. A probe's mistaken descriptor-array assumption was also corrected before the successful Host run; failed probes are retained, not counted as passes.

The Rust preflight's putative Low-workspace negative control is not applicable to this Medium worktree: it was not refused. It does not prove the label refusal branch. The actual owned target, child and artifact observations are recorded separately.

## Next acceptance and performance work

1. Use Application > Quit on the old app, then open the separate replacement. Check Welcome completion, Settings, account-detail failure/loading behavior and Usage/Top-up browser actions. Record the selected artifact hashes from that run. Closing the window normally hides it to the tray.
2. If profile details still fail, collect a safe status/classification and test the account HTTP response contract using owned fixtures. Keep renderer/native mapping, account protocol and server refusal as separate branches. Preserve credential rejection; do not invent profile values or bypass the server's protections.
3. Measure Release launch to usable chat/sidebar/Settings, plus Host resolution, bootstrap, bundle fetch/evaluation and first interaction. Use the same portable/profile and report true cold and subsequent process launches separately. The current 2.9-second Host-ready sample alone exceeds the 1.5-second product target.
4. Derive the initial Host dependency closure from the real loader and required services. Reduce repeated disk/module work and consider precompilation with one preserved Cordis/service identity. Defer a feature only after proving its registration/readiness contract can be retained. Test full functionality after each measured reduction; keep failure-close and teardown gates.
5. Adopt a reviewed runtime lock and run the official frozen stage before release qualification. The local repair snapshot is a useful comparable test build, not a substitute for that gate. Keep native guest and production updater admissions disabled until their own acceptance passes.

Owned evidence is under `.scratch/` in this worktree, the retained `DSH-Qual-244faeed/checkpoints/onboarding-*` directories, and the Host receipt directory recorded in the portable's repair receipt. No user's credential files were read or copied.
