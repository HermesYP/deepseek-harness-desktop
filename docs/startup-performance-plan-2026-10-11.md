# Startup performance plan

Date: 2026-10-11. Target: the installed/portable Windows application becomes
usable within **1,500 ms of process launch** on the user's system. This replaces
the previous relative improvement and 3/8-second targets. This is a plan; no
startup optimization has been implemented or benchmarked in this review.

## Acceptance and latency budget

For an existing configured profile, usability means the first painted workspace
has an enabled chat input connected to a ready local Host, a responsive sidebar,
and working Settings navigation. Painting a skeleton while controls are disabled
does not pass. Remote model responses and account/balance refreshes are outside
boot readiness. First-use setup must present its usable setup page within the
same budget; human setup time is measured separately. A mandatory policy/update
refusal remains an explicit gated outcome, not an accepted workspace boot.

Apply the target to fresh-process launches as well as relaunches. Report OS-cold
and empty-cache first launches separately; neither receives an automatic exemption
from the target. Measure from process creation, not from the first JavaScript mark.
The table allocates the critical path; it is not a measurement or a guarantee.

| Cumulative deadline | Required result |
|---|---|
| 150 ms | Native prerequisite work complete; Host and WebView startup underway |
| 700 ms | Core Host services and main WebView available; independent work overlapped |
| 1,000 ms | Core client bytes fetched/registered and ready for activation |
| 1,300 ms | Core dependency closure active; usable workspace painted |
| 1,500 ms | Interaction verified; total startup remains within the allocated 200 ms margin |

Existing Host/WebView overlap must be measured before adding another mechanism.
If native process/WebView startup alone exceeds its budget, record that limit
and address the measured platform cost. Do not assert that plugin tuning can
guarantee 1.5 seconds before measuring it. No resident background process or
prewarmed daemon is assumed by this target; adding one requires a separate
decision about idle resources and lifecycle behavior.

## Strategy for the tighter target

Cache and preload improvements may help, but cannot be assumed to deliver 1.5
seconds while the application waits for every optional plugin. Make the critical
dependency closure explicit: local transport/Host services, renderer, client
store, chat, sidebar, essential navigation and their real dependencies.

Build a small core startup artifact from that closure. Keep optional features
available through real lazy initialization or later activation with visible
readiness and named failures. Account refresh, heavy Office initialization,
document preview engines, optional Settings panels and other large features are
candidates only when the measured dependency graph permits their deferral.
The target does not authorize deleting those features or replacing services with
successful-looking stubs.

Prefer making existing plugin apply operations lightweight and moving expensive
work into supported package-local chunks or first-use methods. If that cannot
remove the all-entry barrier, introduce an explicit port-owned core/deferred
composition and readiness contract. Audit every core entry before mount; audit
deferred entries when activated. Version protocol changes rather than silently
reinterpreting the preserved Host's `ready` event. Missing core dependencies must
fail explicitly, and deferred features must not compete with the first frame.

## What the code establishes

1. The shell draws the boot page before `runtime_boot_ready` completes, so the
   apparent plugin-loading time includes Host startup and gateway attachment.
   Host startup also installs the Office plugin before publishing readiness.
2. `client/modules/src/index.ts` composes bootstrap and application script
   batches. Application batches are advertised as `script-preload` injection
   rows, preceding bootstrap scripts.
3. The port's preserved `shell/src/web-main.ts` calls `applyIndexInjections`.
   Its implementation in `client/web/src/apply-injections.ts:36` ignores
   `script-preload`, so the desktop path misses that early-download opportunity.
4. The Host advertises revisioned script responses with immutable caching;
   `dsh-gateway/src/lib.rs:1063` overrides every `/plugins/` response to
   `no-store`. The gateway selects an ephemeral port, so normal HTTP caches are
   also partitioned by a different origin on subsequent app launches.
5. Immediate-tier prefetch already uses Promise.all, initial Loader entries are
   created concurrently, and batch requests share an in-flight URL promise.
   Applying those same optimizations again is unlikely to improve startup.
6. The boot awaits immediate-tier prefetch, then every plugin's activation, then
   the renderer mount. One slow activation or dependency can delay the whole
   workspace. Factories also materialize synchronously on the renderer thread.
7. The adapter has no explicit Node compile-cache setup. Whether an inherited
   environment enables it in a particular launch still needs measurement.

These are code findings, not proof of the dominant cost on this machine. The
payload's 284 packages and the UI directory's total size are not equivalent to
the number of plugins or bytes actually loaded during boot.

## Ordered work

### 1. Establish timings and the minimal usable dependency closure

Add an opt-in timing mode to the port-owned shell, adapter and native supervisor.
Record monotonic durations within each process and correlate them by a random
run ID. Do not subtract unrelated process clocks. Instrument the staged/delivered
files actually executed and record their digests with each receipt.

Capture:

- Native setup through Node spawn, control authentication, profile composition,
  Host services ready, Office installation and ready publication.
- Gateway authentication/attachment and the renderer boot-payload wait.
- Bootstrap injection scripts and application batches: unique URL count, byte
  count, fetch duration, retries/fallback requests and main-thread execution.
- Plugin state transitions, unresolved injected services, slow apply operations,
  long tasks, renderer mount, and the first usable chat/sidebar frame.

Define usability as a mounted workspace whose chat input, sidebar and Settings
respond, not merely an HTTP 200 or a fetched bundle. Print package IDs and
durations only; omit authorization material, query strings and account data.

Run five fresh-process launches and five immediate relaunches of the same
artifact/profile, plus a first-use disposable profile. Distinguish these from
an OS-cold run, which requires a reboot or equivalent cache condition; do not
clear the user's real profile or WebView data. Benchmark outside the labelled
checkout with the existing trusted-tool and watchdog checks. Use the actual
native product as the acceptance carrier; bundled-Host-only probes isolate
costs but do not establish UI speed.

Deliverable: baseline receipt with total median, worst observed run, stage
durations, slowest plugins and fetched bytes. Do not report a statistically
meaningful p95 from only five samples.

Alongside the baseline, produce the exact core/deferred roster, dependency
closures and readiness owners. Verify it with the production composition loader;
do not infer a minimal boot roster from package size or display names. Time-box
the profiling work to obtaining the critical path and top costs, then move to
the core startup prototype instead of expanding instrumentation indefinitely.

### 2. Make core startup independent of expensive optional work

Prototype the explicit core closure with lazy initialization first. Preserve
normal service contracts and plugin error handling. Add a port-owned phased
composition only if the existing lifecycle cannot meet the budget through
lightweight apply operations. This is a targeted startup change, not permission
to rewrite the module loader.

Use build-time core batch generation keyed by the reviewed payload and composition
where possible, so first-use startup does not depend on a previously populated
cache. Include only bytes required by the core closure on its critical path;
retain heavy feature implementations in lazy chunks or deferred batches.

Acceptance: chat/sidebar/Settings actually function with the optional work held
back, core dependency/activation audits pass, and each deferred feature activates
correctly on demand. Record full-feature readiness separately from workspace
readiness. Missing-core and failed-deferred cases must remain diagnosable.

### 3. Restore early batch downloads while preserving execution order

Introduce a narrow port-owned injection adapter or transport extension that
honors application `script-preload` hints. Preserve the pinned upstream source
and registration wrapper; document the port delta.

The early download must not execute a factory or activate a plugin. Keep global
rows, the registration facade, bootstrap scripts and the boot gate in their
required order. The eventual script request must use matching URL/credentials
and execute each batch once. Keep the loader's existing per-URL deduplication.

A/B test real WebView2 with current cache headers. If a browser resource preload
is fetched again because of `no-store`, do not accept the duplicate work. Either
coordinate a safe cache-policy change from step 4, or use the existing transport
hook with a bounded per-run download cache that the loader actually consumes.
Do not claim a win from the presence of a preload DOM node.

Acceptance: one effective download and execution per successful batch; earlier
application arrivals; unchanged dependency ordering and explicit failure
reporting. Compare end-to-end startup, not just the download start time.

### 4. Remove redundant bundle work where measurement shows a benefit

Separate immutable script delivery from graph/events, account/RPC responses,
failures and other dynamic `/plugins/` resources. Review the gateway's blanket
no-store contract and its existing regression tests before changing it.

First test browser reuse of exact, Host-advertised revisioned script URLs within
one launch. Retain authentication and current admission checks on requests. Do
not infer that a URL is immutable merely because it has a `rev` parameter.

For reuse across app launches, account for the ephemeral gateway origin. If
transfer or Host batch generation dominates, evaluate a bounded application-owned
content-addressed cache or build-time batch artifact, selected against the current
profile graph and payload bytes. Its identity must cover the ordered plugin set,
actual script digests, relevant configuration, payload release and loader version.
Do not cache account data, cookies, tokens or the profile's enablement decision.

Invalidate on package bytes, roster/configuration, release or loader changes;
fail back to ordinary validated loading on a cache miss or invalid cache entry.
Exercise upgrade, rollback, changed profiles, Host replacement and corrupt-cache
cases. Preserve exact-origin isolation and the current loopback-port design.

Do not add compression unless transfer is a measured bottleneck: this is
loopback traffic, and recompression can consume more CPU than it saves.

### 5. Reduce Node startup cost if the Host dominates

Test the pinned Node's supported compile cache with a per-child
`NODE_COMPILE_CACHE` directory under an owned user-data location, configured
before launching the adapter so its static imports are covered. Keep environment
changes local to the spawned Host. Associate evidence/cache layout with the
pinned Node and payload identity, and retain Node's source-change validation.

Compare fresh-cache and populated-cache runs. A missing or unwritable cache
must fall back to ordinary startup, not become a new fatal requirement. Preserve
tool integrity checks and runtime validation. Do not relabel executables, alter
ACLs or weaken protections to make a benchmark pass.

If filesystem reads dominate instead, identify the measured repeated reads or
recompositions and cache/deduplicate only those. Do not assume that the release
seal is rehashed in full every launch: the inspected native prerequisite path
does not establish such a scan.

### 6. Refine the remaining activation and background work

Use the trace to identify expensive plugin initialization and remote requests
awaited before mount. Move optional data refresh or heavy feature work behind
first use when the plugin contract permits it. A slow account response must not
become a dependency of the usable workspace merely to populate a Settings card.

Use the core/deferred composition established in step 2. Keep commands/routes
unavailable or visibly loading until their owner activates. A failed deferred
plugin must produce a named error and a safe retry. Start optional background work
after the first usable frame and schedule it so it does not freeze typing or
sidebar interaction immediately after an apparent fast boot.

This changes preserved client lifecycle behavior. Implement it as a separately
reviewable port composition, with readiness semantics and bounded waits; do not
remove `loader.await`, suppress the active-entry audit, change `immediately`
flags indiscriminately or mount half-initialized services. Stop and reassess if
it requires a broad rewrite of the preserved module system.

### 7. Qualify the delivered result against 1,500 ms

Run the same native benchmark and visual interaction checks after each accepted
optimization. Measure the exact rebuilt portable/release bytes, outside OneDrive,
with the existing integrity/visibility/watchdog preflight. Keep a rollback build.
No VM is required for these scoped startup measurements on the user's account.

Check chat input, sidebar, Settings, Usage/Top-up, keyboard shortcuts and plugin
errors after both fresh-process launch and relaunch. Include missing-bundle,
failed-activation, offline, changed-profile, update and Host-restart cases as
applicable to each change. Preserve containment, teardown, admission and guest
gates. Avoid reinstalling/uninstalling the user's current application just to
measure startup.

The acceptance limit is **1,500 ms**, not a percentage improvement. Collect at
least 20 ordinary launches of the delivered release artifact and report every
observed duration, the median and the worst run. Add independently labeled
OS-cold and first-use runs. A run above 1,500 ms is a missed target; do not average
it away or exclude it after seeing the result. Retain evidence of failures and
the hardware/build/cache conditions. A finite passing sample is not a guarantee
that every future Windows launch meets the limit.

After readiness, exercise typing, switching sessions and opening Settings while
deferred work runs. Reject improvements that hide the loading page prematurely,
introduce a post-boot freeze, break feature activation, or weaken admission and
teardown. Do not use a DEBUG performance result as release acceptance.

## First implementation slice

Start with timing receipts and the core/deferred dependency inventory, then build
a small usable-core prototype. A/B test preloading and compile/bundle caches
against it. If measured native/Host startup already consumes the 1.5-second
budget, address that cost before tuning optional plugin downloads. Keep the
existing module system, exact-origin model and feature set; avoid a fixed
gateway origin or an unrequested resident daemon.
