# updater-probe (promoted)

Headless harness for lane U2 (updater runtime lifecycle and mandatory policy). **Not a product
artifact, not part of the `port/src-tauri` workspace.**

Promoted by **copy** (never moved, the original was left untouched) from the ignored scratch
directory `port/.scratch/updater-probe/` so the final source inventory contains it. Only source files
were copied; build output, scratch temp trees and run logs were excluded (see the inventory below).
The promoted crate differs from the source in exactly two reviewed places: the `Cargo.toml`
`unexpected_cfgs` lint row (`allow` raised to `warn`, `check-cfg` unchanged) and the probe-only `dirs`
dependency substitution described under *Additional cache substitution*; `Cargo.lock` is the copied
lock plus the minimal records for that substitution.

## File inventory (17 files = 14 copied sources + `dirs_stub/` 2 files + this README)

```
Cargo.toml                          crate manifest; `[workspace]` keeps it standalone
Cargo.lock                          copied lock + the facade's 2 records; --locked is authoritative
.cargo/config.toml                  `--cfg updater_probe` rustflags + `[net] offline = true`
src/lib.rs                          probe entry: module shims + `#[cfg(test)] mod integration`
src/production.rs                   `#[path]` includes of the four production updater modules
src/state.rs                        `#[path]` include of production `state_update.rs` + host shims
src/host.rs                         Tauri harness: real `AppHandle<MockRuntime>`, scripts, state
src/dialog.rs                       scripted stand-in for the `tauri_plugin_dialog` surface
src/integration.rs                  the tests (`#[cfg(test)]`)
dsh_core_stub/Cargo.toml            package `dsh-core` (stand-in)
dsh_core_stub/src/lib.rs            protocol/error/quit items the updater reads
dsh_runtime_stub/Cargo.toml         package `dsh-runtime` (stand-in)
dsh_runtime_stub/src/lib.rs         `UpdateTasksAction`
dirs_stub/Cargo.toml                package `probe-isolated-dirs` (TEST ONLY cache facade)
dirs_stub/src/lib.rs                `cache_dir()` + its pure path unit test
tests/fixtures/update-signatures.json   signing fixture the production tests read
README.md                           this file
```

Intentionally **not** copied: `target/` (build output), `updater-probe-temp/` (scratch temp tree),
`*.log` / `*.txt` run logs, and the source's top-level `fixtures/updates.template.json` - no file in
the crate or in the production modules it includes references that template (`updates.template` has
no match anywhere under `port/tests/updater-probe/src` or in `port/src-tauri/app/src/update_*.rs`).

## What is real, and what is a stand-in

Real production text, compiled from its shipped path through `#[path]` (no copy, so it cannot drift):

| Production file | Included by |
| --- | --- |
| `app/src/update_security.rs` | `src/production.rs` |
| `app/src/update_schedule.rs` | `src/production.rs` |
| `app/src/mandatory_update.rs` | `src/production.rs` |
| `app/src/update_flow.rs` | `src/production.rs` |
| `app/src/native_dialog.rs` | `src/lib.rs` |
| `app/src/state_update.rs` | `src/state.rs` |

`#[path]` is resolved relative to the containing file's directory, so the promoted location must stay
at the same depth as the scratch original (`port/<x>/updater-probe/src/`): `../../../src-tauri/app/src/...`
resolves to `port/src-tauri/app/src/...` from here exactly as it did before.

Also real: the `tauri::AppHandle<tauri::MockRuntime>` is built with Tauri's own
`tauri::test::mock_builder() / mock_context() / noop_assets()` (no window, no display server, no Wry),
together with `ring` Ed25519 verification, the real `reqwest` dependency graph, and the real
`update_flow` check/download/install state machine driven with inert inputs.

Stand-ins (each exists because the real item needs a window, an OS keyring, or `dsh-gateway`):

| Stand-in | Replaces | Boundary |
| --- | --- | --- |
| `dsh_core_stub` | workspace `dsh-core` | only the updater-visible items; field/enum/serde shapes mirror `crates/dsh-core/src/{protocol,error,quit}.rs` |
| `dsh_runtime_stub` | workspace `dsh-runtime` | only `UpdateTasksAction` |
| `src/host.rs` | the app shell | real Tauri handle + state registry, but a probe `AppState`, scripted supervisor counts and a probe host URL |
| `src/dialog.rs` | `tauri_plugin_dialog` | `DialogExt`/`MessageDialogButtons` with the plugin's call shape, answered from a per-app script instead of a native blocking dialog |
| `policy_owner` (in `src/lib.rs`) | app native policy gate | records `Normal` / `MandatoryUpdate` admission outcomes |
| `quit_flow` (in `src/lib.rs`) | `app/src/quit_flow.rs` | records the request and the installer-restart arm; never quits a process |
| `dirs_stub` (`probe-isolated-dirs`) | registry `dirs` (for this crate only) | `cache_dir()` under the current process temp dir; no KnownFolder call, no I/O |

The production `update_flow.rs` reads `DialogExt` from `crate::dialog` instead of `tauri_plugin_dialog`
only under `cfg(updater_probe)`; that cfg-gated import is the single production line the probe changes.

## Additional cache substitution (TEST ONLY)

The included production text resolves its artifact cache through `dirs::cache_dir()`
(`app/src/update_flow.rs`, `artifact_cache_dir`). The shipped `dirs` crate answers that from the
platform KnownFolder API, and on Windows that value **ignores a plain `LOCALAPPDATA` environment
redirect**: it resolves the live, shared updater cache (`...\LocalAppData\dsh-desktop-updater`). A
standalone integration run must never read or write that directory, because a shared cache is another
installation's state - and `dirs::cache_dir()` there would also need write access the standalone
probe has no business taking.

So the manifest maps the dependency **key** `dirs` onto a probe-owned package:

```toml
dirs = { path = "dirs_stub", package = "probe-isolated-dirs", version = "0.0.0" }
```

* the key stays `dirs`, so the included production text
  (`update_flow.rs::artifact_cache_dir`) is **unchanged**;
* `dirs_stub/src/lib.rs` answers `cache_dir() -> Some(std::env::temp_dir().join("dsh-updater-probe-artifact-cache"))`
  - a pure path computation: no KnownFolder call, no I/O, no directory created, no platform global
  state touched;
* the package name is unique (`probe-isolated-dirs`), so no registry crate is shadowed; the registry
  `dirs 6.0.0` record stays in the lock because `tauri` and `tauri-build` still depend on it, and no
  other version or checksum in the lock changed;
* `Cargo.lock` carries only two minimal records for this: `"probe-isolated-dirs"` replaces `"dirs"`
  in the `updater-probe` package's dependency list, and one new path-package entry
  (`name = "probe-isolated-dirs"`, `version = "0.0.0"`, no `source`, no `checksum`, no dependencies).
  That is the whole diff: 5 lines added, 1 removed.

Boundaries, stated plainly: this is a **test-only dependency substitution**, not a claim about the
production cache path, and it is **not** cache or account acceptance. No shipped build uses this
crate, no production source was modified, and nothing here exercises the real KnownFolder resolution.

Because the facade resolves under `std::env::temp_dir()`, the gate recipe below must point `TEMP`/`TMP`
at a fresh, attested directory outside the repository: that is what makes the probe's artifact cache
isolated per run.

The facade carries one unit test (`dirs_stub/src/lib.rs`, `#[cfg(test)]`), which asserts purely on the
returned path: it is under the current process temp dir, it names the probe directory, it never
contains the production cache name `dsh-desktop-updater`, and repeated calls agree (so no global state
is written). Honest caveat: a dependency's own unit tests are not built by `cargo test` for the root
package, so that test executes only when the facade is the test target itself
(`cargo test -p probe-isolated-dirs` from this crate's workspace root); under the probe's own
`cargo test` the facade is exercised indirectly, through the included production code that calls
`dirs::cache_dir()`.

## Gate steps (locked, offline, no repo-local build output)

Run with the **current directory inside this crate** (see the cfg caveat) and keep every write outside
the repository:

```powershell
$probe = "port/tests/updater-probe"
$out   = Join-Path $env:TEMP "dsh-updater-probe-target"   # CARGO_TARGET_DIR, outside the repo
$tmp   = Join-Path $env:TEMP "dsh-updater-probe-tmp"      # TEMP/TMP, outside the repo
New-Item -ItemType Directory -Force -Path $out, $tmp | Out-Null

$env:CARGO_TARGET_DIR = $out
$env:TEMP = $tmp
$env:TMP  = $tmp
Remove-Item Env:DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS, Env:DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS,
  Env:DSH_DESKTOP_UPDATE_CHECK_JITTER -ErrorAction SilentlyContinue

Push-Location $probe
try   { cargo test --locked --offline }
finally { Pop-Location }
```

* `--locked` - authoritative: `Cargo.lock` is copied verbatim and promotion changed no dependency
  (the lint row is not part of the dependency graph).
* `--offline` - the crate never fetches; every dependency must already be in the local registry
  cache. `.cargo/config.toml` also sets `[net] offline = true`.
* `CARGO_TARGET_DIR`, `TEMP` and `TMP` are pointed outside the repository because the suite writes
  through `std::env::temp_dir()` (e.g. `dsh-upd-*`, `probe-final-*.bin`) and `dirs::cache_dir()`
  (`update_flow.rs`), and Cargo would otherwise create `target/` here.
* Leave `DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS` / `_MAX_BACKOFF_MS` / `_JITTER` **unset**: the included
  `update_security::resolve_schedule_config` reads them from the environment and an out-of-range value
  is an error, not a fallback. `DSH_HOME` is *not* read by anything this crate compiles (the settable
  keys live in the production `state.rs`, which the probe does not include).

## cfg caveat

`cfg(updater_probe)` is supplied by `.cargo/config.toml` (`[build] rustflags = ["--cfg",
"updater_probe"]`), **not** by a Cargo feature - a feature would define `feature = "updater_probe"`,
which is not the cfg the included production text tests.

Cargo loads `.cargo/config.toml` from the **current working directory** upward, not from the manifest
directory. Running `cargo test --manifest-path port/tests/updater-probe/Cargo.toml` from the
repository root therefore does **not** apply the flag: `update_flow.rs` would take its
`tauri_plugin_dialog` import - a crate this probe deliberately does not depend on - and fail to
compile. Either run with the current directory inside the crate (the recipe above) or pass the flag
explicitly, e.g. `--config 'build.rustflags=["--cfg","updater_probe"]'`.

Promoting this crate from `.scratch/` to `port/tests/` does not change which `.cargo/config.toml`
applies as long as the gate runs from inside the crate: no `Cargo.toml` exists at the repository root,
`port/`, or `port/tests/`, and `port/src-tauri/Cargo.toml` is a sibling workspace that lists only
`crates/*` and `app` as members. `Cargo.toml` also carries an empty `[workspace]`, which keeps the
crate its own workspace root so no ancestor can capture it.

## Lint and cfg policy

```toml
[lints.rust]
unexpected_cfgs = { level = "warn", check-cfg = ['cfg(updater_probe)'] }
```

`updater_probe` stays a recognized cfg (both through `check-cfg` and the `features` table, which makes
Cargo pass `cfg(feature, values(...))`), while the level is `warn` rather than `allow`: any *other*
unexpected cfg in the included production text is still reported instead of being blanket-silenced.
`--cfg updater_probe` satisfies the included concepts; the lint cannot hide a cfg a shipped build
would reject.

### Fixture serializers and strict Clippy

The two process-global fixture serializers are async-aware:

* `TRUST_LOCK` (`src/integration.rs`) and `SETTLEMENT_LOCK` are
  `tokio::sync::Mutex<()>` declared with `const_new`;
* a trusted case holds `TRUST_LOCK` for its whole body by design - the process-global trust override
  must stay installed while the case awaits - so its guard is acquired with `lock().await`, and
  `TrustedHarness` stores a `tokio::sync::MutexGuard`, which is why its constructors
  (`new`/`with_tasks`/`with_runtime_version`) are `async fn`;
* the one **synchronous** holder is the plain `#[test]` `the_probe_never_talks_to_the_network` (and
  the same arrangement in `the_harness_can_admit_a_candidate_for_its_tests`): it uses
  `blocking_lock()`, which is safe there because that thread has no Tokio runtime and the lock is
  taken before `Harness::new()` builds anything. It must never be reached from async code.
* `tokio::sync::Mutex` has no poisoning, so the earlier "recover a poisoned lock instead of cascading
  one failure" path is unnecessary: a panicking holder unwinds and releases the guard.

This is why a `std::sync::Mutex` guard is never held across an await point here
(`clippy::await_holding_lock`), and no `#[allow]`/suppression is used anywhere in the crate. The
`std::sync::Mutex` **fields** on the probe harness (short callback critical sections) are unchanged,
and the fixture cleanup on unwind (`Drop for TrustedHarness` -> `clear_trust_fixture`) is retained.

## What this suite does NOT establish

Stated by the included tests themselves (`src/integration.rs`, module docs): **no real feed fetch, no
real artifact download, no signature produced by production keys, no real installer launch, and no
native window.** The trust configuration points at a fixture, so `check` refuses before any socket is
opened, and the install stage is driven with **inert non-executable bytes** whose launch is expected
to be *refused* - never a real installer, and never a native dialog acceptance run. Dialog answers are
scripted, not driven through a native dialog. The artifact cache is the probe-owned temp directory
described above, so the production cache location and any real cache contents are never exercised
either.

Two benign real processes are spawned by the Windows-only production tests inside the included
`update_flow.rs`, and neither is an updater run: a copy of the test harness itself launched with
`--exact <non-matching test name>` to prove the verified-launch path survives a pinned read-only
copy, and `cmd.exe /d /c mklink /J` to build a throwaway directory junction in a temp dir (both with
`CREATE_NO_WINDOW` / nulled stdio). Do not read either as an installer or feed acceptance.

## Promotion status

Promotion verified structurally only by inspection: destination absent before the copy, exact
**17-file** inventory (14 copied source files + `dirs_stub/`'s 2 files + this README), byte-identical
copies for every file other than the two reviewed manifest/lock edits (per-file SHA-256 in the lane
report), all six `#[path]` targets and both `CARGO_MANIFEST_DIR`-relative fixture reads resolving at
the new depth, and no `target/`, temp tree or log copied. **No `cargo` or `rustc` command was run** -
compiling and gating this crate is the parent's serialized step.

The `Cargo.lock` change was made by hand and is deliberately minimal (5 lines added, 1 removed; no
version or checksum of any other package touched; the registry `dirs` record retained for
`tauri`/`tauri-build`). `--locked` remains the authority: if the gated build reports that the lock
needs updating, treat that as a request for the parent's scoped offline resolution rather than editing
any other locked dependency here.
