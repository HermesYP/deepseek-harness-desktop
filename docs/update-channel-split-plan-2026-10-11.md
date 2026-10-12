# Update channel split plan: harness payload delivery separate from native shell installation

Date: 2026-10-11. Reviewed baseline: `bff03b4`.

This is a plan, not execution evidence. Each statement below is either **measured** at the reviewed
baseline (a source read, a command run, or a generated record, each named where it is used) or
**proposed** (no receipt exists). No part of this split is implemented, verified, installed or
qualified, and nothing here enables a production feed, a signing key or a release-readiness claim.

## Outcome and scope

The question this document answers: can the underlying harness be separated from the desktop
application, so that the harness is easier to update?

The decision it supports: whether to add a second update artifact kind (the runtime payload) that can
be delivered without the native installer, and what must be true before that work may start.

In scope: the runtime payload as a separately delivered and separately verified unit; the native shell
and its installer as the bootstrap and repair path for that payload; and the compatibility and trust
rules that decide whether a given payload may be booted at all. Out of scope: the deferred Settings
Updates surface, native guest admission, production trust material, and any edit to the preserved
`_upstream` checkout. This plan changes no source, installer or release configuration.

Deliberately excluded: self-updating the native shell by replacing a running executable. See
[Explicitly rejected](#explicitly-rejected).

## The three layers as they exist today

| Layer | Contents | Shipping path (measured) |
| --- | --- | --- |
| Native shell | `dsh-desktop.exe`: Tauri window, tray, WebView2 host, credential backend, Host supervisor, loopback gateway, NSIS installer hooks | `bundle` stage ([build-and-install.md:92](build-and-install.md#L92)) |
| Harness runtime payload | `port/runtime-payload/dsh`: `adapter.mjs`, `@deepseek-ai/dsh` plus a flat hoisted `node_modules`, and the pinned Node interpreter | `runtime` stage ([build-and-install.md:88](build-and-install.md#L88)), then bundled as a resource |
| Web UI | `port/ui/dist`: the preserved client shell built with upstream's official client profile, plus port-owned client plugins | `ui` stage ([build-and-install.md:87](build-and-install.md#L87)) |

Evidence for each shipping path:

- Tauri maps both trees into the installed application as resources: `"../../ui/dist/": "ui/"` and
  `"../../runtime-payload/dsh/": "dsh/"` ([tauri.conf.json:22-24](<../port/src-tauri/app/tauri.conf.json#L22-L24>)),
  with `"frontendDist": "../../ui/dist"` ([tauri.conf.json:9](<../port/src-tauri/app/tauri.conf.json#L9>)).
- `build.ps1` declares the stage set `ui`, `core`, `runtime`, `runtime-lock-refresh`, `bundle`,
  `verify`, `packaging-tests`, `all` ([build.ps1:96](<../port/scripts/build.ps1#L96>)). The stage table
  in [build-and-install.md:83-92](build-and-install.md#L83-L92) lists six of these and omits
  `runtime-lock-refresh`; that drift is a documentation observation, not a functional finding.
- The payload identity record. Measured from the generated `port/installer/runtime-payload.json` in the
  primary workspace: `schemaVersion` 1, `version` `0.1.7-rc.2`, `upstreamCommit` `477b4f42...`,
  `hostProtocolVersion` `"4"`, a `node` object (`version` 22.20.0, `target` win-x64, `url`, `sha256`,
  `source`, `license`, `spdx`), and an `inputs` array of named preimage hashes. That file is generated
  and ignored ([.gitignore:19-20](<../.gitignore#L19-L20>)), so a clean checkout must run a `runtime`
  stage before it can be read.
- The interpreter is a build input, not a system dependency: a matching local archive or an explicit
  download switch is required and a mismatch is refused
  ([build-and-install.md:97-100](build-and-install.md#L97-L100)).

One correction to the framing of the question: there is no single "frontend" here. The web UI is
already a separately built artifact, and the harness serves client plugins itself. This plan therefore
addresses one split, the one with real friction: payload delivery versus the native shell and its
installer.

## What is already a seam

Measured properties of the baseline. They show that the shell was written to boot a payload it does not
own, which is why this is a delivery and trust change rather than a rewrite.

1. **The runtime root is resolved, not hardcoded.** `DSH_DESKTOP_RUNTIME_DIR` overrides it, otherwise
   `exe_dir.join("dsh")` ([lib.rs:738-740](<../port/src-tauri/app/src/lib.rs#L738-L740>)).
   `DSH_DESKTOP_NODE` and `DSH_DESKTOP_RUNTIME_ADAPTER` do the same for the interpreter and adapter
   ([lib.rs:744-750](<../port/src-tauri/app/src/lib.rs#L744-L750>)); the shell asset directory resolves
   separately ([lib.rs:661-674](<../port/src-tauri/app/src/lib.rs#L661-L674>)).
2. **The payload identity is validated before use.** `resolve_desktop_node` reads
   `runtime-payload.json` and requires a non-empty `node.version` with `node.target` equal to the host
   target ([lib.rs:528-576](<../port/src-tauri/app/src/lib.rs#L528-L576>)).
   `validate_host_prerequisites` requires the adapter, two anchor packages and a working interpreter in
   the accepted 22.19+ or 24+ range ([lib.rs:578-646](<../port/src-tauri/app/src/lib.rs#L578-L646>)).
3. **The control handshake carries a generation.** The private preamble is `<token> <generation>`, and
   the token is compared in constant time before the generation is parsed. The source states the intent
   ([control.rs:96-108](<../port/src-tauri/crates/dsh-runtime/src/control.rs#L96-L108>)):

   > The generation is carried explicitly so a swapped runtime cannot boot unvalidated: a staged
   > payload whose adapter speaks a different lifecycle generation presents a different number (or
   > refuses to present one) and the shell refuses the connection instead of exchanging frames it does
   > not understand.

4. **`hostProtocolVersion` equality is the shell-side gate.** The reported value must equal the pinned
   generation 4 ([protocol.rs:711-712](<../port/src-tauri/crates/dsh-core/src/protocol.rs#L711-L712>),
   [protocol.rs:756-766](<../port/src-tauri/crates/dsh-core/src/protocol.rs#L756-L766>)), and sealing
   checks the payload manifest's number against the build identity
   ([seal-runtime.mjs:133-138](<../port/scripts/lib/seal-runtime.mjs#L133-L138>)).
5. **The payload already publishes atomically and keeps a previous tree**
   ([build-and-install.md:106-114](build-and-install.md#L106-L114)).

Two measured limits that this plan depends on:

- The exact interpreter pin is enforced at build and seal time, not at boot: sealing compares
  `node.version`, `node.target` and `node.sha256`
  ([seal-runtime.mjs:133-138](<../port/scripts/lib/seal-runtime.mjs#L133-L138>)), while boot accepts any
  interpreter in range ([lib.rs:631-644](<../port/src-tauri/app/src/lib.rs#L631-L644>)).
- Boot validates identity and anchors, not a file inventory. `validate_host_prerequisites` performs no
  per-file digest check; the seal inventory is produced and verified by the build and qualification
  path.

## What the split buys

| Benefit | Basis |
| --- | --- |
| Faster harness cadence and smaller blast radius: agent, tool and plugin fixes stop paying the shell release cycle | The payload is already a distinct tree with its own identity and version |
| No installer, UAC, registry, shortcut or kill/relaunch work for a payload-only update | The payload already publishes atomically with a retained previous tree; the shell only needs a new root and a restart |
| A far smaller artifact in practice | The combined installer is bounded by a 2 GiB artifact cap ([update_flow.rs:81](<../port/src-tauri/app/src/update_flow.rs#L81>)) |

Stated plainly: **this does not remove the requirement to stop the Host.** A loaded native module stays
locked, so the old payload tree cannot be replaced while the application runs
([build-and-install.md:106-114](build-and-install.md#L106-L114)). The split removes the installer, not
the restart. The restart path is also the healthiest part of the system today: the updater probe that
compiles the production update modules reports 206 passed and 0 failed at this baseline (measured in
this session; no receipt file records it).

## What it costs

1. **Two trust streams and per-stream anti-rollback state.** One signed unit covering shell plus
   runtime, ordered by "strictly greater version"
   ([build-and-install.md:399-401](build-and-install.md#L399-L401)), becomes two independently ordered
   streams that each need an artifact kind and a monotonic sequence. That is milestone 4 of
   [port-fix-plan-2026-10-10.md](port-fix-plan-2026-10-10.md), which is **unqualified**: trust is
   fail-closed and delivery is disabled
   ([build-and-install.md:377-389](build-and-install.md#L377-L389),
   [update_flow.rs:875](<../port/src-tauri/app/src/update_flow.rs#L875>)). Splitting first produces two
   unverified delivery paths instead of one.
2. **Interpreter and ABI pinning.** The payload's native modules are built for the pinned interpreter,
   so a payload update may never change the Node version or ABI; a payload that requires one must force
   the full installer. Boot does not enforce this today, so the rule has to be added rather than assumed.
3. **A shell and payload compatibility matrix**, bounded by the generation gate but required as an
   explicit, tested rule rather than an emergent behaviour.
4. **A runtime rollback story** comparable to the installer's retained previous tree
   ([build-and-install.md:372](build-and-install.md#L372)), under file locks, at swap time, with a
   defined recovery on next start.
5. **A new on-disk trust boundary.** A mutable payload root is writable state that the shell will
   execute. Selecting it by environment variable, as the development seam does
   ([lib.rs:738-740](<../port/src-tauri/app/src/lib.rs#L738-L740>)), is not a trust boundary; a product
   channel requires the full seal inventory to be verified before every boot, which does not happen
   today.
6. **The installer contract defects had to close first, and they now do.** Measured at `bff03b4` in
   this session; all six are fixed in the working tree of this branch, and no matched execution
   receipt records either the defects or the fixes.

| Id | Measured defect | Evidence |
| --- | --- | --- |
| D1 | The process-observation function has no stack sentinel and no indeterminate state, in both the installer and uninstaller copies, which the file's own header warns about | [installer-process.nsh:204-215](<../port/installer/installer-process.nsh#L204-L215>), [:345-354](<../port/installer/installer-process.nsh#L345-L354>), [:201-203](<../port/installer/installer-process.nsh#L201-L203>) |
| D2 | `installer-regressions.test.mjs` is declared in neither entry point, so 5 of its 6 tests can fail while both gates stay green | [build.ps1:1252-1270](<../port/scripts/build.ps1#L1252-L1270>), [run-verification-gate.ps1:288](<../port/tests/run-verification-gate.ps1#L288>) |
| D3 | `installer-contract.test.mjs` is not a `node:test` suite, so its declared lane cannot produce the counts the gate requires | [installer-contract.test.mjs:1-6](<../port/tests/packaging/installer-contract.test.mjs#L1-L6>) |
| D4 | The vendored template hashes to `38be7318...` while the provenance record says `603530b3...`, so nothing binds the reviewed bytes to the shipped template | [installer-template-provenance.json:8](<../port/installer/installer-template-provenance.json#L8>) |
| D5 | Installer comments claim the check race is closed, contradicting the code and the plan's own requirement | [installer-hooks.nsh:30](<../port/installer/installer-hooks.nsh#L30>), [installer-template.nsi:80](<../port/installer/installer-template.nsi#L80>), [installer-process.nsh:47-48](<../port/installer/installer-process.nsh#L47-L48>) |
| D6 | The provenance record does not name the legacy NSIS or WiX upgrade boundary it declares unsupported | [installer-template-provenance.json:14](<../port/installer/installer-template-provenance.json#L14>) |

Instrument defects found while verifying those fixes, in the same family: a suite nothing runs cannot
report anything, and an instrument that cannot compile cannot qualify a template.

| Id | Measured defect | Evidence |
| --- | --- | --- |
| D7 | The derived-template fixture resolved the registered template path from the repository root instead of from the Tauri app directory, so it aborted before compiling and never produced a receipt | [nsis-template-derived-fixture.mjs:32](<../port/tests/packaging/nsis-template-derived-fixture.mjs#L32>) |
| D8 | The same fixture over-escaped every NSIS macro (`\${If}` for `${If}`), omitted the `NoShortcutMode` declaration that its harvested `.onInit` parser reads, and counted comment mentions of the plugin in a check meant to find executable calls | [nsis-template-derived-fixture.mjs:153](<../port/tests/packaging/nsis-template-derived-fixture.mjs#L153>), [:190](<../port/tests/packaging/nsis-template-derived-fixture.mjs#L190>) |

Session results after those fixes, under pinned Node 22.20.0 where named: `installer-regressions.test.mjs`
6/6, `installer-contract.test.mjs` 6/6, `repair-gate-inventory.test.mjs` 1/1, `build-script.test.mjs`
34/34; native suites `installer-hooks-compile` PASS 14 checks, `installer-instance-guard` PASS 9 checks,
`installer-hook-behavior` PASS 12 checks, `installer-strings-messages` PASS 14 checks; the
derived-template fixture compiles and its GREEN phase passes; the updater probe still reports 206 passed,
0 failed. `gate-contract.test.mjs` reports 19/25 both before and after, so its six behavioural failures
are pre-existing and out of scope here. None of this has a receipt file, so all of it is a session
observation and not acceptance.

## The safety rule

**A payload-only update is permitted only within a shell generation.** The generation is the reported
`hostProtocolVersion`, which must equal the pinned generation 4
([protocol.rs:711-712](<../port/src-tauri/crates/dsh-core/src/protocol.rs#L711-L712>)). Any change that
requires a different generation forces the full installer, because an older shell refuses the connection
rather than exchanging frames it does not understand
([control.rs:96-108](<../port/src-tauri/crates/dsh-runtime/src/control.rs#L96-L108>)).

The rule must be explicit and testable, not inferred:

| Predicate | Required outcome |
| --- | --- |
| `hostProtocolVersion` equals the shell's pinned generation | payload-only swap may be offered |
| `hostProtocolVersion` differs in either direction | refuse; require the full installer |
| `nodeVersion` differs from the shell's pinned interpreter | refuse; require the full installer |
| `node.target` differs from the host target | refuse before any swap |
| seal inventory does not match every file | refuse; keep the current payload |
| signed metadata expired, superseded or rolled back | refuse; keep the current payload |

Negative fixtures for each row are the acceptance evidence, in the shape of the generation-mismatch
refusals already pinned in [control.rs:113-136](<../port/src-tauri/crates/dsh-runtime/src/control.rs#L113-L136>).

## Phased plan

Each phase names its acceptance criteria and the evidence that would qualify it. No phase is started
here, and no phase is qualified without its own receipt.

### Phase 0: UI and agent-plugin changes through the harness's own client-plugin mechanism

Free win, available today, with no trust or installer change. The harness scans installed client
packages that carry a `dsh.client` manifest and serves them as `/plugins/<id>/client.js`, with an
immediate prefetch tier and a client HMR package (roster analysis of an equivalent payload copy,
[startup-core-deferred-roster.md:45](startup-core-deferred-roster.md#L45),
[startup-core-deferred-roster.md:54](startup-core-deferred-roster.md#L54)). The port already owns one
such package, `@dsh-port/dsh-client-ui-updates`, whose README records that it is inactive by default and
that its rendering is unqualified ([client-updates/README.md:3-7](<../port/ui/client-updates/README.md#L3-L7>)).

- Acceptance: a UI or plugin-only change reaches an installed profile without a new installer, with only
  the restart the profile already requires.
- Qualifying evidence: actual profile composition plus renderer activation on an installed or staged
  Host, with the exact payload and source hashes. The Settings Updates row is **DEFERRED** and its
  `offline-profile`, `staged-resolution` and `browser-activation` checks have no receipt ([STATUS.md:16](../STATUS.md#L16), [current-status.json:109-124](current-status.json#L109-L124)). Source tests and bundled JavaScript do not establish activation ([client-updates/README.md:17](<../port/ui/client-updates/README.md#L17>)).

### Phase 1: the payload channel as artifact kind 2

Only after milestone 4 (signed metadata with target binding, freshness, rollback and revocation) is
qualified, and only after D1 to D6 are fixed.

1. Extend the signed release message with an artifact kind and a per-stream monotonic sequence, keeping
   the product, release version, channel, platform, architecture, artifact digest and expiry binding
   milestone 4 requires ([port-fix-plan-2026-10-10.md](port-fix-plan-2026-10-10.md)).
2. Publish payload artifacts under a versioned root, verified against a signed manifest carrying the
   same identity fields the generated manifest already has, plus the seal inventory.
3. Swap at next start, not under a running Host, retaining the previous tree.
4. Enforce the table in [The safety rule](#the-safety-rule) before the swap and again before boot.

- Acceptance: wrong kind, wrong target, altered digest, expired metadata, downgraded payload sequence
  and mismatched seal inventory are each refused, and the running payload is untouched in every refusal.
- Qualifying evidence: a local authenticated HTTPS fixture exercising signature, download, verification
  and the swap boundary, plus a restart observation showing which payload actually booted. A passed
  headless suite is not installed acceptance.

### Phase 2: the installer stops carrying the payload

The installer becomes the seed and repair path: it installs the shell and a known-good payload, and it
can restore a payload when the channel is unavailable or the on-disk tree fails verification.

- Acceptance: a clean machine with no system Node installs and boots from the seed payload; a payload
  update and a payload rollback both work with the installer unused; a corrupt payload is repaired by
  the installer without touching user data.
- Qualifying evidence: exact installed-artifact acceptance on a non-overlapping account, which remains
  **UNQUALIFIED** and is a separate gate ([STATUS.md:15](../STATUS.md#L15)).

### Sequencing constraint

Phase 1 must not start before D1 to D8 are fixed and one end-to-end path is qualified. The current state
is that the source-level suites pass (installer contract 6/6, updater probe 206 tests, 0 failed) while the
delivered path is unproven: the updater and installer contract row and the clean install, upgrade and
uninstall row are **UNQUALIFIED** ([STATUS.md:14-15](../STATUS.md#L14-L15)), no real installer has been
run, and no payload channel exists. Splitting delivery while the delivery path is unproven multiplies the
unqualified surface instead of reducing update friction.

## Explicitly rejected

**A native shell self-update that replaces a running executable.** This is rejected, not deferred. It
would reintroduce exactly the failure class the current repair removes: same-name process detection,
bounded refusal, and the one-relaunch contract in
[installer-process.nsh](<../port/installer/installer-process.nsh>) and
[installer-hooks.nsh](<../port/installer/installer-hooks.nsh>). It would also put a new, mutable
executable on the trust path, where a partial write or a lock failure has no recoverable boundary
comparable to the payload's retained previous tree.

## Open questions and deliberately unqualified statements

- **Unqualified:** whether any of this improves update cadence in practice. No throughput, size or
  cadence measurement has been taken; the argument above is structural.
- **Unqualified:** the exact size relationship between the combined installer and a payload-only
  artifact. The 2 GiB artifact cap is measured ([update_flow.rs:81](<../port/src-tauri/app/src/update_flow.rs#L81>));
  artifact sizes are not.
- **Open:** whether the shell should verify the payload seal at every boot, and the startup cost of doing
  so. The updater probe covers the update state machine, not boot-path digest verification.
- **Open:** how a payload channel interacts with the development overrides `DSH_DESKTOP_RUNTIME_DIR`,
  `DSH_DESKTOP_NODE` and `DSH_DESKTOP_RUNTIME_ADAPTER`
  ([lib.rs:738-750](<../port/src-tauri/app/src/lib.rs#L738-L750>)). A shipped payload channel must not be
  selectable by an environment variable, and the release behaviour of these overrides is not qualified
  here.
- **Open:** whether the Settings Updates client surface is the right place to present a payload channel,
  given that it is **DEFERRED** and must load the profile offline with the production boot path first
  ([port-fix-plan-2026-10-10.md](port-fix-plan-2026-10-10.md)).
- **Not claimed:** that the runtime payload can be updated without stopping the Host. Loaded native
  modules stay locked ([build-and-install.md:106-114](build-and-install.md#L106-L114)).
- **Not claimed:** that the three-layer description above is a complete inventory of shipped components.
  It covers the layers this decision touches.
- **Measured in this session with no receipt:** the installer contract defects D1 to D6, and the
  consistent updater-probe pass. The repository's evidence discipline requires a matched execution
  receipt before any of them is treated as acceptance.

## References used for the plan

- [Port repair plan](port-fix-plan-2026-10-10.md), milestones 1 and 4.
- [Build, install and troubleshoot](build-and-install.md), stages, staging hazards and the update boundary.
- [Current Windows port status](../STATUS.md) and [current status rows](current-status.json).
- [Startup core and deferred roster](startup-core-deferred-roster.md), client plugin mechanism.
- Source seams: [lib.rs](<../port/src-tauri/app/src/lib.rs>),
  [control.rs](<../port/src-tauri/crates/dsh-runtime/src/control.rs>),
  [protocol.rs](<../port/src-tauri/crates/dsh-core/src/protocol.rs>),
  [seal-runtime.mjs](<../port/scripts/lib/seal-runtime.mjs>).
