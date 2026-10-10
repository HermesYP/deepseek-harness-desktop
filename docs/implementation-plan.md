# Rust desktop completion plan

Status: resumed toward a verified working 1-to-1 product against the pinned `0.1.7-rc.2` reference; local work from dirty HEAD `a441ca756c37155bf3961f8d96e0f3f5fe1a3c09`. The current route catalog exposes the user's requested Space Bunny Alpha as `openrouter/stealth/space-bunny-alpha`; it is now the primary delegator for scoped native policy, Office execution and credential-isolation work. Earlier route refusals remain historical evidence, not the current model availability. First unblock and execute adapter/Office, Node identity, Updates and isolated Host gates, then address remaining native/parity defects against actual acceptance evidence. Upstream rebase is excluded. See the [current evidence](<verification-report.md#bounded-integration-continuation-2026-10-01>).

## Current Windows repair (2026-10-10)

The direct user request now selects `command-code/deepseek/deepseek-v4.1-flash` scoped subagents. Prior route/delegator notes above are historical, not the current implementation route. Follow [the repair ledger](<repair-ledger-2026-10-10.md>) for the preservation, execution-trust, credential/runtime, capability, update/policy, gateway/CSP and qualification order. Native Browser and Platform admissions stay disabled until their full native gates pass; DEBUG account qualification cannot replace disposable clean-machine installer acceptance. Existing failed gates are retained, never relabeled green.

## Outcome and scope

Deliver a Rust/Tauri desktop shell that preserves the upstream React UI and Node agent Host, reaches feature and native interaction parity, has bounded lifecycle operations, installs/updates safely, and demonstrates performance through measurements. Do not rewrite the agent or UI just to increase the Rust percentage.

The present reproducible reference is commit `477b4f420553e8a52c2fbccc464d7561b239c443` (`0.1.7-rc.2`). The latest checked upstream revision is `639ed015397290b3745d163aafe02ffee4aa3f84` (`0.2.0-rc.2`). First inventory that drift; rebaseline only as an atomic change to the runtime graph, protocol consumers, build inputs, fixtures and documentation. Do not imply latest parity before doing so. Keep the reference checkout read-only; maintain any adaptations as tracked port code or reproducible overlays.

Public publishing, production signing and additional platform qualification require their actual credentials/hosts. Local implementation, development fixtures and unsigned builds do not count as those release gates.

## Safety and collaboration

- Preserve the existing untracked `scripts/boot-graph-probe.mjs` and reference logs. Do not reset, clean, commit, push or replace user data.
- Never launch against the live Harness home or its port 3080. Use isolated homes below `port/.scratch/` and dedicated ports 3085+; no replacement GUI server.
- No installation, updater execution or process termination against existing installations without explicit approval. Use isolated qualification installations only.
- Do not print credentials or add secrets/private signing keys to source.
- Use disjoint file ownership. The lead integrates shared Rust manifests/lockfiles, shell entry, command registration and shared bridge contracts after contributors provide concrete changes.
- Every task result must distinguish implemented, integrated, tested, blocked and incomplete. A model response or compiling module is not proof of native behavior.
- Respect the active runtime policy: latest snapshot is `danger-full-access`, approval policy `never`; do not request sandbox escalation. The user authorized scoped Windows permission diagnosis, previously blocked Rust/isolated Host execution and isolated native builds/tests. The authorized unconfined diagnosis found no repairable permission issue and changed no permissions; checks use their normal owned transport and Cargo directory. Live installed-app changes, installation and publication remain unauthorized.

## Immediate resumed execution order

1. Retain the passing real owned-pipe Host and offline resolver/runtime evidence. Run desktop library tests after each cleanup; keep strict lint failure diagnostics visible.
2. Remove redundant exports and fix style findings without blanket lint allowances. Investigate production-dead findings as potential missing composition, not merely compiler noise.
3. Resolve the current native-guest gap: shell setup creates `GuestViews::new(false, false)` and manages a default, uninstalled main-thread owner. Do not simply turn these flags on: establish complete navigation/request/download/permission policy, event forwarding, owned origin, placement and teardown behavior first, then wire and test the owner.
4. Audit the remaining updater/policy/chrome/renderer findings for missing production paths and complete their bounded lifecycle/error behavior.
5. Rebuild and seal current UI/adapter/Node resources and a matching isolated native executable. Execute the Updates/Settings verifier only against that owned app; source tests and retained dependencies are not that gate.

## Workstreams and dependency order

| Lane | Owned implementation | Acceptance gate |
| --- | --- | --- |
| R: runtime reliability | Rust control link/supervisor and Node transport adapter | Complete-operation deadlines; cancellation-safe pending cleanup; bounded frame/queue memory; startup/stop escalation; silent/non-reading/oversized/cancelled peer tests with outer deadlines. |
| U: updater correctness/security | Update service/state and separate verification/policy modules; Updates client | Immutable single-flight candidate; exact confirmed-version install; stale-result rejection; bounded streamed downloads; mandatory integrity/trusted signatures; trusted HTTPS feed policy; scheduler/channel policy and accurate progress; no Host stop before verification. |
| P: build/distribution | Build and staging scripts, reproducible payload manifests, installer source hooks | Self-contained pinned Node and required runtime assets; staged/atomic payload publication before compilation; clean-build support; path-specific instance handling and reliable relaunch; no generated-artifact-only fix. |
| V: parity gates | Capture/comparison/desktop verification scripts and regression tests | Zero captures, missing actions, wrong pages, activation errors and raster differences fail; exact advertised Updates artifact/activation/Settings slots verified; fixture and environment fingerprints recorded. |
| G: native guests | Native browser/Platform view adapters and presentation/event/storage lifecycle consumers | Real view creation; navigation, tab/session isolation, focus, geometry, popup policy, permissions and teardown; matching retained UI; no always-rejecting API or iframe claimed as native parity. |
| S: shell/native integration | Caption/menu/native-path/locale/onboarding/recovery modules | Windows caption and layout markers match reference; native path attachments and directory-picker ownership; welcome/onboarding sizing; locale/theme propagation; useful load/crash diagnostics and safe plugin-disable recovery. |
| B: baseline/performance | Upstream drift inventory, gateway static handling, qualification/benchmark tooling | Explicit baseline/consumer migration checklist; async static IO and correct HEAD/cache semantics; reproducible whole-process-tree measurement, not shell-only memory claims. |

Initial lanes can run concurrently. Each implementation is followed by an independent requested-model review. Shared entry-point changes, dependency additions, profile composition and artifacts remain with the lead to prevent overlapping writes.

### Milestone 1: honest baseline and test gates

1. Record Git state and model availability; retain existing work.
2. Capture the current protocol, profile, runtime and UI artifact identities.
3. Inventory upstream changes through the checked `0.2.0-rc.2` revision. Identify API/session-format migration consumers before updating the baseline.
4. Correct false-green parity scripts and add self-contained negative fixtures.
5. Record a reference benchmark plan and current measurements where runnable.

Exit: failures are visible; the intended baseline and outstanding differences are explicit.

### Milestone 2: bounded lifecycle and trust boundary

1. Bound control send/writer/reply as one operation, ready startup and shutdown; clean cancelled pending requests; bound both transport implementations.
2. Add last-completed-stage diagnostics to distinguish boot, DI, transport, provider/tool, approval and renderer waits.
3. Restrict native authority to the owned application origin/window and prevent untrusted navigation/new-window access. Guest content receives no privileged bridge.
4. Replace renderer-mutable release authority with packaged trust configuration. Require integrity and signature verification; missing trust configuration disables release delivery rather than allowing unsafe installation.

Exit: adversarial lifecycle and authority tests pass. The audit's source hazards must not be presented as the already-proven cause of reported agent stalls.

### Milestone 3: full product parity and migration

1. Implement native Browser and Platform consumers plus backing views, not leases alone.
2. Restore Office Host composition and required runtime resources.
3. Complete caption menus/layout, welcome/onboarding constraints, native file/directory attachment handoff, microphone/focus policies, localization/theme and recovery.
4. Add safe profile migrations that activate required first-party packages without overwriting user/plugin customization.
5. Execute browser/native interactions against the pinned reference and current port: matched theme, locale, DPI, viewport, fixtures and task/session state.
6. Keep the pinned baseline and its consumers consistent; adopting a newer upstream remains a separate explicitly authorized change.

Exit: feature checklist rows have concrete passing evidence or a named intentional deviation approved by the user; no parity percentage inferred from identical files.

### Milestone 4: safe updater and packaging

1. Own one immutable candidate `{version, channel, url, hash, signature, artifactPath}` per update operation. Exact identity survives confirmation and installation.
2. Stream with connect/idle/total/size bounds, unique temporary files and atomic publication; reject stale completions and concurrent installs. Channel switches invalidate the correct backend candidate.
3. Preserve Ready after download/Later; add truthful progress, scheduler/backoff/mandatory-policy behavior and actionable manual-check failures.
4. Verify trust before disrupting the Host. Preserve task consent, admission rollback and failure recovery.
5. Correct source-controlled NSIS update handoff/relaunch and path-specific process handling. Never kill unrelated same-name installations.
6. Bundle pinned Node and the complete required payload. Assemble resources in a staging tree before compiling the shell, with licenses and content manifests.

Checkpoint: final package registration, root-only manifest exclusions, bundled-interpreter sealing and inner-tree publication/post-publication verification now pass 44 Node tests and 121 PowerShell assertions. A 7,000-real-file fixture reproduced and repaired the inventory-size limit without relaxing identity-document bounds. Policy-owner lifecycle repairs pass 11 focused tests; the full offline Rust suite passes 467 tests. These are local fixture/headless results, not complete production payload assembly, native policy composition or installed trust. Compile guards and interrupted repair still check presence only.

Exit: local artifact and updater fixtures pass; an unsigned build remains explicitly unsigned and must not be offered as a trusted public update.

### Milestone 5: installed qualification

Run approved isolated tests, recording build identity and evidence:

- Fresh installation with system Node removed from PATH; first usable workspace and first-party plugin activation.
- Profile upgrade from existing installations, including retained settings, credentials, sessions and custom plugins.
- Installed N-to-N+1 upgrade with signed test/release artifacts, customized destination, relaunch, active-task consent and unrelated-instance survival.
- Interrupted download/install, corrupt or incorrectly signed artifact, stale channel/version, failure recovery and uninstall data retention.
- All native desktop actions and guest lifetime/focus/storage/permissions.
- Provider/tool continuation tests with test fixtures first; real-provider use only with approved credentials/budget.

Windows x64 is the primary build host. macOS and any additional supported targets require their own real hosts and signing/qualification. Do not label a cross-platform source path as a tested release.

### Milestone 6: measured optimization and release

Compare same-machine, same-fixture release builds of reference and port:

- Cold/warm startup and first usable UI.
- p50/p95 input, render, scroll, session-open and long-conversation latency.
- Active streaming/reconnect, terminal IO and agent continuation.
- Whole process tree private memory (Rust shell + WebView2 + Node + tool children), idle CPU and retained-memory growth.

Optimize observed bottlenecks only. Preserve revisioned plugin activation and intentional no-store semantics. Compare size-oriented and speed-oriented Rust release settings using data; do not assume Rust automatically improves provider latency or overall memory.

Release only after signed artifact/feed trust, actual installed upgrade, platform qualification and parity gates pass. Publish a manifest tying shell/runtime/UI/protocol identities together, exact test evidence, benchmark results and acknowledged intentional differences. Production certificates, feed hosting and platform build hosts are explicit prerequisites, not simulated completion.

## Current execution checkpoint (2026-09-30)

- Current local gates: **498 Rust workspace tests** (430 library + 68 integration), **147 isolated updater-probe tests** (with overlapping production unit tests), **110 Node policy/verification/packaging tests** and **178 PowerShell assertions** pass with no reported failures. The PowerShell total includes 121 packaging, 54 synthetic accounting and 3 own-tool native identity assertions; none is product performance. The shell rebuilt using pinned Node 22.20.0, including current mandatory-policy assets. Prior 160 desktop/update UI tests and 46 owned Browser tests/typecheck remain historical unchanged-runtime evidence. See the [current verification scope](<verification-report.md#current-repair-evidence-2026-09-30>); no installed/native parity, signing or memory-improvement claim is made.
- Lead integration includes owned-main command/capability scoping, completed main-renderer hook registration before navigation, fail-closed guest default state, actual Windows resume scheduling and creation-identity-verified accounting.
- Native guests are deliberately disabled. Completed guest permission/credential hooks, production state/lifetime observations and retained-client artifact activation are still acceptance gates.
- Exact requested `openai-codex / gpt-6-luna` contributions/reviews are collected through workflows 43–45. The initial native lane was rejected; lead repairs and regressions, not model completion messages, qualify source changes. Native hide freshness, callback picker ownership and late affirmative Quit answers are repaired. The full suite exposed and then verified a repair for stale startup Ready overwriting a fatal Host state. Final scoped reviews found no additional evidenced defect; native acceptance is still withheld. Updater gaps have no-stop/no-restart and owned-versus-superseding-state regressions for failed Lock/Unlock and declined task consent. See the [dialog/lifecycle checkpoint](<luna-integration-review.md#callback-dialogs-and-terminal-ownership-checkpoint>).
- Application policy wiring is implemented: independent runner/owner, launch/focus/resume/login scheduling, fresh command/gateway admission, renderer-ACK-gated native presentation and retained asynchronous shutdown. An absent policy disables networking; invalid-present inputs fail closed. The rebuilt local bootstrap has no configured policy, so no live policy networking occurred. Native execution, dialog/child coverage, capability/ACK behavior and usable task-aware Quit remain unqualified.
- [Callback picker and ordinary Quit](<luna-integration-review.md#callback-dialogs-and-terminal-ownership-checkpoint>) now avoid blocking a Tokio worker on user input, retain admitted ownership through caller cancellation and refuse superseded Quit answers. Initialization errors also await callbacks. Six updater message/consent waits remain synchronous. Workflow 46 found caller-cancellation cleanup/Unlock gaps and stale Check/Install publication across channel invalidation or identical-candidate episodes. Add operation generations, retained admitted work, guarded post-await writers and deterministic cancellation/episode regressions before migrating those waits. Real native parenting, policy-visible confirmation focus and main destruction remain qualification gates.
- Update handoff checks the installed runtime baseline, signed candidate identity and captured channel at the execution boundary while intentionally accepting Normal OR MandatoryUpdate. Precommit refusal or failed/declined task-admission rollback does not restart or stop agents. A Windows artifact lease with bounded hashing and resolved launch path passes owned filesystem/benign-loader fixtures; real signed NSIS and non-Windows replacement behavior remain open. Complete production-payload assembly is still needed; registration, bundled-Node sealing and inner-tree publication already pass focused fixtures.
- Milestones 3–6 remain open: actual native interactions, mandatory blocking while allowing Quit, reproducible full resource/artifact builds, clean installed upgrade, release trust and measured product performance. Keep older captures/installers separate from current qualification.

## Definition of done

- Source changes are integrated, reviewed, and pass focused checks plus final build/type/fixture gates.
- Native and installed behavior is demonstrated, not inferred from code or HTTP boot.
- No unbounded lifecycle waits or update candidate identity races remain in the audited paths.
- Release trust is fail-closed, and installation does not disrupt unrelated instances or lose user state.
- Upstream revision alignment and profile/session migrations are explicit and verified.
- Performance/memory claims use complete process-tree measurements.
- Any unmet native, platform, credential or publication requirement is listed as incomplete; completion is not declared merely because subagents finished.
