//! Update presentation, download, verification, and installation.
//!
//! Parity target: `_upstream/apps/desktop/src/update-coordinator.ts`. The
//! behaviours that file owns and this module must preserve are:
//!
//! - **One immutable candidate per operation.** `{version, channel, url,
//!   sha256, signature, artifactPath}` is admitted once and never re-read from a
//!   mutable store, so the version the user confirmed is the version that is
//!   verified and launched.
//! - **Single flight.** Check, download, and install each own the service while
//!   they run; a second request joins or is refused instead of racing.
//! - **Stale completions are rejected.** A download publishes only while the
//!   episode it began in is still current, so a channel switch or a superseding
//!   check cannot be overwritten by a late result.
//! - **Trust precedes disruption.** Integrity (SHA-256) and provenance
//!   (Ed25519 over `{version, channel, sha256}`) are both mandatory and are
//!   checked before the Host is stopped.
//! - **`Later` preserves `Ready`.** Declining a confirmation is not a failure
//!   and never discards a verified artifact.
//!
//! Feed authority comes from packaged configuration ([`crate::update_security`]),
//! never from the renderer-mutable settings store: a product document cannot
//! choose an artifact. A missing trust configuration disables delivery rather
//! than allowing an unsigned installation.

use std::path::PathBuf;
use std::time::Duration;

#[cfg(updater_probe)]
use crate::dialog::{DialogExt, MessageDialogButtons};
use dsh_core::error::DshError;
use dsh_core::protocol::{
    DesktopUpdateOperation, DesktopUpdatePhase, DesktopUpdatePreparationFailureKind,
    DesktopUpdatePresentation, DesktopUpdateState,
};
use dsh_runtime::control::UpdateTasksAction;
use sha2::Digest;
use tauri::{Emitter, Manager};
#[cfg(not(updater_probe))]
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tokio::io::AsyncWriteExt;

/// The application handle this module is written against.
///
/// Exactly `tauri::AppHandle` in a shipped build. The runtime tests build their
/// applications on Tauri's `MockRuntime`, which is headless by construction and
/// is the only runtime that starts without WebView2; naming the alias here keeps
/// that substitution in one line instead of changing every signature.
#[cfg(not(updater_probe))]
pub type DesktopApp = tauri::AppHandle;
#[cfg(updater_probe)]
pub type DesktopApp = tauri::AppHandle<tauri::test::MockRuntime>;

use crate::mandatory_update::{self, MandatoryDecision, MandatoryEnforcement};
use crate::state::{
    artifact_file_name, format_message, AppState, UpdateCandidate, UpdateFlight, UpdateOperation,
    UPDATE_CHANNEL_KEY,
};
use crate::update_schedule::{CheckExecutor, CheckOutcome, CheckTrigger, UpdateRunner};
use crate::update_security::{
    self, PolicyFailure, ReleasePolicy, ReleaseTrustConfig, SignedRelease, TrustConfigOutcome,
    VerifyFailure,
};

/// Packaged release trust configuration filename, resolved beside the
/// executable (the Tauri equivalent of Electron's `process.resourcesPath`).
pub const TRUST_CONFIG_FILE: &str = "updates.json";

/// Connect/header deadline: maximum silence before response headers arrive.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// Idle deadline: maximum silence between response chunks. Not a total
/// deadline (`update-http-executor.ts` documents the same distinction).
const IDLE_TIMEOUT: Duration = Duration::from_secs(60);
/// Total deadline for one artifact download.
const TOTAL_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60 * 60);
/// Deadline for manifest retrieval.
const FEED_TIMEOUT: Duration = Duration::from_secs(30);
/// Largest manifest document accepted, so a hostile feed cannot exhaust memory.
const MAX_FEED_BYTES: u64 = 1024 * 1024;
/// Largest artifact accepted, so a hostile feed cannot exhaust disk or memory.
const MAX_ARTIFACT_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Redirects followed for a single request inside the packaged allow list.
const MAX_REDIRECTS: usize = 5;
/// Progress publications are throttled to integer-percent changes.
const PROGRESS_STEP: f64 = 1.0;
/// Ceiling on one delegated Host admission `unlock`.
///
/// A destructor cannot await, so an abandoned install hands its `unlock` to a
/// retained task; that task must not outlive its usefulness. The control exchange
/// itself is already bounded inside the runtime (10 s), and the request now runs
/// under the supervisor's slot lock, so this ceiling also covers waiting for that
/// slot and then stops rather than leaving a task parked on a wedged Host. It is
/// the same ceiling on how long the quiescence barrier counts a retained release.
const HOST_ADMISSION_UNLOCK_DEADLINE: Duration = Duration::from_secs(15);

// ---------------------------------------------------------------------------
// Trust configuration resolution
// ---------------------------------------------------------------------------

/// Probe-only packaged-trust override.
///
/// The probe harness points resolution at a fixture file so the confirmation and
/// installation paths can run without a packaged build. It exists **only** under
/// `cfg(updater_probe)`, so a shipped binary — and the app crate's own tests —
/// have no way to redirect release authority: there is no global override, and
/// no test-only override either, outside the headless probe.
#[cfg(updater_probe)]
mod trust_override {
    use std::path::PathBuf;

    static OVERRIDE: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);

    pub(super) fn set(path: Option<PathBuf>) {
        *OVERRIDE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = path;
    }

    pub(super) fn get() -> Option<PathBuf> {
        OVERRIDE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }
}

/// Point packaged-trust resolution at `path` (the headless probe only).
///
/// Passing `None` restores resolution beside the executable and in the resource
/// directory. This is the *only* way a test can give the updater release
/// authority, and it does not exist outside `cfg(updater_probe)`.
#[cfg(updater_probe)]
pub fn set_trust_config_override(path: Option<PathBuf>) {
    trust_override::set(path);
}

/// Resolve the packaged trust configuration.
///
/// The executable's directory is searched first (where the installer places
/// `updates.json`), then the Tauri resource directory. Absence is reported as
/// [`TrustConfigOutcome::Absent`] and disables delivery.
pub fn load_packaged_trust(app: &DesktopApp) -> TrustConfigOutcome {
    #[cfg(updater_probe)]
    if let Some(path) = trust_override::get() {
        return update_security::load_trust_config(&path);
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(executable) = std::env::current_exe() {
        if let Some(directory) = executable.parent() {
            candidates.push(directory.join(TRUST_CONFIG_FILE));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join(TRUST_CONFIG_FILE));
    }
    resolve_trust_candidates(
        candidates
            .into_iter()
            .map(|candidate| update_security::load_trust_config(&candidate)),
    )
}

/// Resolve all packaged candidates before choosing authority. Any existing but
/// unusable candidate takes precedence over a valid one; only absent files may
/// be skipped. This prevents a later candidate from masking a broken install.
fn resolve_trust_candidates(
    candidates: impl IntoIterator<Item = TrustConfigOutcome>,
) -> TrustConfigOutcome {
    let mut first_invalid: Option<TrustConfigOutcome> = None;
    let mut first_loaded: Option<TrustConfigOutcome> = None;
    for candidate in candidates {
        match candidate {
            loaded @ TrustConfigOutcome::Loaded(_) if first_loaded.is_none() => {
                first_loaded = Some(loaded)
            }
            TrustConfigOutcome::Loaded(_) | TrustConfigOutcome::Absent => {}
            invalid @ TrustConfigOutcome::Invalid(_) => {
                first_invalid.get_or_insert(invalid);
            }
        }
    }
    first_invalid
        .or(first_loaded)
        .unwrap_or(TrustConfigOutcome::Absent)
}

// ---------------------------------------------------------------------------
// Presentation plumbing
// ---------------------------------------------------------------------------

fn publish(app: &DesktopApp, state: &DesktopUpdateState) -> DesktopUpdatePresentation {
    let presentation = crate::commands::present_update(state);
    app.emit("dsh://update/state", &presentation).ok();
    presentation
}

async fn with_state<F, T>(app: &DesktopApp, f: F) -> T
where
    F: FnOnce(&mut crate::state::UpdateService) -> T,
{
    let state = app.state::<std::sync::Arc<AppState>>();
    let mut update = state.update.lock().await;
    f(&mut update)
}

async fn current(app: &DesktopApp) -> DesktopUpdateState {
    with_state(app, |update| update.state.clone()).await
}

fn mark_failure(state: &mut DesktopUpdateState, operation: DesktopUpdateOperation, message: &str) {
    state.phase = DesktopUpdatePhase::Error;
    state.failed_operation = Some(operation);
    state.message = Some(message.to_string());
}

/// Record a failure attributable to the operation that owns `flight`, if it still
/// owns it.
///
/// The supervisor settles the claim after the operation returns (whatever the
/// outcome), so this only records the failure: a settlement can never clear a
/// newer operation's claim, and an operation that lost ownership never writes
/// over the superseding state.
async fn fail_owned(
    app: &DesktopApp,
    flight: UpdateFlight,
    owner: UpdateOperation,
    operation: DesktopUpdateOperation,
    message: &str,
    invalidate: bool,
) -> DesktopUpdatePresentation {
    let presentation = with_state(app, |update| {
        if update.owns_flight(flight, owner) {
            if invalidate {
                // Losing authority drops the candidate it authorized, and any
                // artifact that candidate had published is retired under the
                // same lock: nothing references it any more, and only the joined
                // shutdown drain removes it.
                let previous = update.candidate.clone();
                let _ = update.invalidate_candidate();
                if let Some(path) = superseded_artifact(previous.as_ref(), None) {
                    update.retire_artifact(path);
                }
            }
            mark_failure(&mut update.state, operation, message);
            update.flight = None;
        }
        crate::commands::present_update(&update.state)
    })
    .await;
    app.emit("dsh://update/state", &presentation).ok();
    presentation
}

/// Render a transport error with the marker upstream uses for timeouts, so the
/// UI can select the network-specific copy.
fn transport_message(operation: &str, error: &reqwest::Error) -> String {
    if error.is_timeout() {
        format!("{operation}: ETIMEDOUT ({error})")
    } else {
        format!("{operation}: {error}")
    }
}

// ---------------------------------------------------------------------------
// Admission and supervision
// ---------------------------------------------------------------------------

/// The ownership claim one admitted operation holds for its whole lifetime.
///
/// The claim is created in the *same lock scope* that captures the operation's
/// context (candidate identity and episode), so the identity that decides what
/// gets installed and the ownership generation that decides who may publish it
/// can never be captured from two different service states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FlightClaim {
    flight: UpdateFlight,
    owner: UpdateOperation,
}

/// The outcome of claiming the update service for one operation.
enum Admission<C> {
    /// Another operation owns the service. The caller joins the presentation
    /// that operation published and starts nothing of its own.
    Busy(DesktopUpdatePresentation),
    /// Update admission is closed for shutdown. Nothing was claimed and no work
    /// may start: the process is winding down and the artifact drain is about to
    /// run behind this operation.
    Closed,
    /// This operation is refused before it starts; the state under the same lock
    /// already records why.
    Refused(DshError),
    /// This operation owns `flight` for the rest of its life.
    Admitted { claim: FlightClaim, context: C },
}

/// What an admitted-and-run operation produced.
enum AdmittedRun<T> {
    /// The service was busy; the caller observes the other operation's state.
    Joined(DesktopUpdatePresentation),
    /// Update admission is closed; nothing ran.
    Closed,
    /// This caller owned the service and its operation produced `T`.
    Ran(T),
}

/// How many admitted update operations have not been **settled** yet, plus the
/// Host admission releases they still owe.
///
/// Incremented before admission is attempted (conservatively, so a barrier never
/// sees zero while an operation is being admitted) and decremented only when the
/// operation's settlement half has completed — see [`ActiveOperation`]. A
/// [`HostAdmission`] guard raises the same counter when it is **armed**, before
/// its `lock` request is sent, and holds it until the matching `unlock` exchange
/// has settled: an abandoned install hands that guard to a retained task, so the
/// release can outlive the operation that owed it, and a barrier must not report
/// [`UpdateQuiescence::Quiescent`] — nor let the artifact drain run — while a Host
/// is still admission-locked on this process's behalf.
static ACTIVE_UPDATE_OPERATIONS: std::sync::atomic::AtomicUsize =
    std::sync::atomic::AtomicUsize::new(0);

/// Woken whenever an admitted operation settles.
static UPDATE_QUIESCENT: std::sync::LazyLock<tokio::sync::Notify> =
    std::sync::LazyLock::new(tokio::sync::Notify::new);

/// The in-flight accounting one admitted operation owns until it is settled.
///
/// Its lifetime deliberately spans **both** halves of the supervision:
/// [`admitted`] raises it before admission, it is moved into the settlement
/// closure, and that closure runs inside the retained supervision task *after*
/// the operation future has finished. So it is released only when settlement has
/// completed — never when the operation merely returned, failed, or unwound.
///
/// That ordering is what makes the shutdown barrier sound: if the guard belonged
/// to the operation future, the counter would drop the moment the operation ended
/// and [`quiesce_updates`] could report [`UpdateQuiescence::Quiescent`] — and the
/// artifact drain could run — while the claim was still unsettled.
///
/// The destructor of a [`HostAdmission`] *moves* such a guard into the release it
/// delegates, for the same reason: that release is not owned by any operation
/// future any more, and quiescence must not be claimable while it is owed.
struct ActiveOperation {
    /// Test-only witness for **this exact guard**.
    ///
    /// Set when this guard is dropped, so a test can prove that the guard it is
    /// holding is still alive during a parked settlement without comparing
    /// global counter snapshots (which other concurrent tests also move). It is
    /// compiled out of shipped builds, and the counter itself is unchanged.
    #[cfg(test)]
    dropped: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

impl ActiveOperation {
    fn begin() -> Self {
        ACTIVE_UPDATE_OPERATIONS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        Self {
            #[cfg(test)]
            dropped: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// A witness that turns true when **this** guard is dropped.
    #[cfg(test)]
    fn drop_witness(&self) -> std::sync::Arc<std::sync::atomic::AtomicBool> {
        self.dropped.clone()
    }
}

impl Drop for ActiveOperation {
    fn drop(&mut self) {
        ACTIVE_UPDATE_OPERATIONS.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
        #[cfg(test)]
        self.dropped
            .store(true, std::sync::atomic::Ordering::SeqCst);
        UPDATE_QUIESCENT.notify_waiters();
    }
}

/// How many admitted update operations are still unsettled, including the Host
/// admission releases an abandoned install handed to a destructor.
pub fn active_update_operations() -> usize {
    ACTIVE_UPDATE_OPERATIONS.load(std::sync::atomic::Ordering::SeqCst)
}

/// Run one admitted operation under settlement supervision.
///
/// The admitted operation runs in **its own** task, and a separate retained
/// supervision owner joins that task and then settles the claim. This shape is
/// load-bearing: a single body (`run.await; settle(claim).await`) would let a
/// controlled unwind in `run` end the task *before* settlement, leaving the
/// flight claimed forever — exactly the wedged state supervision exists to
/// prevent. Here a panic is observed as a `JoinError` by the owner, the claim is
/// still settled, and the caller receives `update_operation_failed`.
///
/// Cancelling the caller's wait cancels neither task (dropping a `JoinHandle`
/// detaches), so an admitted operation always runs to completion and always
/// settles. Settlement is owner-checked ([`UpdateService::settle_flight`]), so a
/// stale settlement cannot clear a newer operation's flight.
async fn supervise<T, R, S, SF>(claim: FlightClaim, run: R, settle: S) -> Result<T, DshError>
where
    T: Send + 'static,
    R: std::future::Future<Output = Result<T, DshError>> + Send + 'static,
    S: FnOnce(FlightClaim) -> SF + Send + 'static,
    SF: std::future::Future<Output = ()> + Send + 'static,
{
    let operation = tokio::spawn(run);
    let supervised = tokio::spawn(async move {
        let outcome = operation.await;
        // Settlement is unconditional: it happens before the outcome is mapped,
        // so no operation outcome can skip it.
        settle(claim).await;
        match outcome {
            Ok(result) => result,
            Err(join) => Err(DshError::other(
                "update_operation_failed",
                format!("the update operation did not run to completion: {join}"),
            )),
        }
    });
    match supervised.await {
        Ok(result) => result,
        Err(join) => Err(DshError::other(
            "update_operation_failed",
            format!("the update supervision did not run to completion: {join}"),
        )),
    }
}

/// Release `claim` if it is still the current one.
async fn settle_claim(app: &DesktopApp, claim: FlightClaim) -> bool {
    // Probe seam: lets the headless probe park settlement and observe the
    // operation→settlement handoff (the in-flight counter must still be raised
    // while settlement is pending). Compiled out of every shipped build.
    #[cfg(updater_probe)]
    settlement_gate::wait().await;
    let released = with_state(app, |update| {
        update.settle_flight(claim.flight, claim.owner)
    })
    .await;
    if !released {
        tracing::debug!(
            "update {} ownership was already superseded; leaving the newer owner alone",
            claim.flight.label()
        );
    }
    released
}

/// Probe-only settlement gate.
///
/// It parks the settlement half of supervision for a bounded window, so a probe
/// test can prove the in-flight counter is held by settlement (not by the
/// operation future that has already finished). The window always expires, so a
/// panicking test cannot wedge other tests' settlements indefinitely.
#[cfg(updater_probe)]
mod settlement_gate {
    use std::time::{Duration, Instant};

    static RELEASE_AT: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    static RELEASED: std::sync::LazyLock<tokio::sync::Notify> =
        std::sync::LazyLock::new(tokio::sync::Notify::new);

    fn deadline() -> Option<Instant> {
        *RELEASE_AT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn park(window: Option<Duration>) {
        let deadline = window.map(|window| Instant::now() + window);
        *RELEASE_AT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = deadline;
        if deadline.is_none() {
            RELEASED.notify_waiters();
        }
    }

    pub(super) async fn wait() {
        loop {
            let Some(deadline) = deadline() else { return };
            if Instant::now() >= deadline {
                return;
            }
            let wait = RELEASED.notified();
            let _ = tokio::time::timeout(Duration::from_millis(25), wait).await;
        }
    }
}

/// Park (or release) update settlement for the headless probe.
///
/// `Some(window)` parks settlement until the window expires or
/// `park_settlements(None)` is called; `None` releases immediately. The seam
/// exists only under `cfg(updater_probe)`.
#[cfg(updater_probe)]
pub fn park_settlements(window: Option<std::time::Duration>) {
    settlement_gate::park(window);
}

/// Probe-only gate for the release an abandoned install delegates.
///
/// A destructor cannot await, so the unlock it owes is delivered by a retained
/// task. Parking that task before it runs the exchange lets a probe test prove
/// two things deterministically: the shutdown barrier counts the retained release
/// and therefore waits for it, and a release whose exchange then observes closed
/// admission sends nothing. The window always expires, so a panicking test cannot
/// wedge later releases.
#[cfg(updater_probe)]
mod admission_release_gate {
    use std::time::{Duration, Instant};

    static RELEASE_AT: std::sync::Mutex<Option<Instant>> = std::sync::Mutex::new(None);
    static RELEASED: std::sync::LazyLock<tokio::sync::Notify> =
        std::sync::LazyLock::new(tokio::sync::Notify::new);

    fn deadline() -> Option<Instant> {
        *RELEASE_AT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(super) fn park(window: Option<Duration>) {
        let deadline = window.map(|window| Instant::now() + window);
        *RELEASE_AT
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = deadline;
        if deadline.is_none() {
            RELEASED.notify_waiters();
        }
    }

    pub(super) async fn wait() {
        loop {
            let Some(deadline) = deadline() else { return };
            if Instant::now() >= deadline {
                return;
            }
            let wait = RELEASED.notified();
            let _ = tokio::time::timeout(Duration::from_millis(25), wait).await;
        }
    }
}

/// Park (or release) the release a destructor delegates (the headless probe only).
///
/// `Some(window)` parks the delegated release until the window expires or
/// `park_admission_releases(None)` is called; `None` releases immediately. Only
/// the destructor path consults this probe gate, so an explicit rollback is never
/// delayed. The seam exists only under `cfg(updater_probe)`.
#[cfg(updater_probe)]
pub fn park_admission_releases(window: Option<std::time::Duration>) {
    admission_release_gate::park(window);
}

/// Admit one update operation under the service lock, then supervise it.
///
/// `admit` decides under a single lock acquisition whether this caller joins, is
/// closed out, is refused, or owns the service, and returns everything the
/// operation needs. `run` receives the handle, its claim, and that context.
///
/// The in-flight counter is raised **before** admission is attempted and moved
/// into the **settlement** half of the supervision (not the operation half), so a
/// concurrent shutdown barrier sees the operation from the moment it might be
/// admitted until its claim has actually been settled — never the other way
/// around.
async fn admitted<C, T, A, R, RF>(
    app: &DesktopApp,
    admit: A,
    run: R,
) -> Result<AdmittedRun<T>, DshError>
where
    C: Send + 'static,
    T: Send + 'static,
    A: FnOnce(&mut crate::state::UpdateService) -> Admission<C>,
    R: FnOnce(DesktopApp, FlightClaim, C) -> RF + Send + 'static,
    RF: std::future::Future<Output = Result<T, DshError>> + Send + 'static,
{
    let active = ActiveOperation::begin();
    let admission = with_state(app, admit).await;
    let (claim, context) = match admission {
        Admission::Busy(presentation) => return Ok(AdmittedRun::Joined(presentation)),
        Admission::Closed => return Ok(AdmittedRun::Closed),
        Admission::Refused(error) => {
            publish(app, &current(app).await);
            return Err(error);
        }
        Admission::Admitted { claim, context } => (claim, context),
    };
    let settle_app = app.clone();
    // The operation's own handle is cloned *outside* the async block: a clone
    // taken from the borrowed `app` inside it would capture the borrow, and the
    // operation future must be `'static` (it is spawned).
    let operation_app = app.clone();
    let result = supervise(
        claim,
        async move { run(operation_app, claim, context).await },
        move |claim| {
            let settle_app = settle_app.clone();
            async move {
                // The in-flight guard is held by the **settlement** half, not by
                // the operation: it is released only when settlement completes.
                // Otherwise the counter would drop the instant the operation
                // returned (or unwound), and a shutdown barrier could report
                // quiescent — and run the artifact drain — while this claim had
                // not been settled yet.
                let _active = active;
                settle_claim(&settle_app, claim).await;
            }
        },
    )
    .await?;
    Ok(AdmittedRun::Ran(result))
}

/// The artifact path a candidate transition retires, if any.
///
/// A transition retires the *previous* candidate's verified artifact once that
/// path is detached from the service, and never the path the next candidate
/// publishes: a re-download of the same release targets the same filename, so
/// retiring it would delete a live artifact.
fn superseded_artifact(
    previous: Option<&UpdateCandidate>,
    next: Option<&UpdateCandidate>,
) -> Option<PathBuf> {
    let previous = previous?.artifact_path.clone()?;
    if next.and_then(|candidate| candidate.artifact_path.as_ref()) == Some(&previous) {
        return None;
    }
    Some(previous)
}

// ---------------------------------------------------------------------------
// Retained artifact cleanup
// ---------------------------------------------------------------------------

/// What one cleanup drain observed.
///
/// `delivery` is the honest part: a drain that could not join the retained owner
/// reports [`CleanupDelivery::NotObserved`] and claims nothing about the disk.
/// Nothing in this module ever reports a removal it did not observe.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CleanupReport {
    /// Artifacts whose removal was observed during this drain.
    pub retired: usize,
    /// Artifacts whose removal failed, with the reason.
    pub failed: Vec<(PathBuf, String)>,
    /// Whether the retained owner was joined.
    pub delivery: CleanupDelivery,
}

/// Whether a cleanup drain observed the removals it reports.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum CleanupDelivery {
    /// The retained owner was joined; `retired`/`failed` are observed facts.
    #[default]
    Joined,
    /// No cleanup owner was running, so nothing was removed by this drain.
    Idle,
    /// The owner did not finish. Whatever it removed is not claimed.
    NotObserved(String),
}

/// Remove the retired artifacts under a retained, joined owner.
///
/// Removal is deliberately *not* attempted at retirement time: a `Drop` cannot
/// await, and a removal racing a fresh publication of the same filename could
/// delete a live artifact. Retirement only records the path on the service
/// ([`crate::state::UpdateService::retire_artifact`]); the work happens here,
/// under a [`crate::native_dialog::RetainedOwner`] that is joined. A drain whose
/// future is dropped mid-join leaves that owner unobserved — its own `Drop`
/// records the delivery failure, and nothing here claims the files are gone.
///
/// **Shutdown API.** Call this after the update service is quiescent — after the
/// check runner is disposed and no download or install is in flight — because
/// retirement does not re-check live state at removal time. [`shutdown_updates`]
/// is the ordered entry point that establishes that precondition; calling this
/// directly is only correct once [`quiesce_updates`] has reported
/// [`UpdateQuiescence::Quiescent`]. A drain that cannot join its owner (the task
/// panicked) reports [`CleanupDelivery::NotObserved`] and claims nothing about the
/// disk; a drain with nothing retired reports [`CleanupDelivery::Idle`].
/// Repeatable: each call drains whatever is retired.
pub async fn drain_artifact_cleanup(app: &DesktopApp) -> CleanupReport {
    let batch = with_state(app, |update| update.take_retired_artifacts()).await;
    remove_retired_artifacts(batch).await
}

/// Where the retired artifacts are actually removed.
///
/// Separated from the drain so the removal — including the refused path and the
/// unobserved-owner report — is testable without an application handle.
async fn remove_retired_artifacts(batch: Vec<PathBuf>) -> CleanupReport {
    if batch.is_empty() {
        return CleanupReport {
            delivery: CleanupDelivery::Idle,
            ..CleanupReport::default()
        };
    }
    // One retained owner per drain, so a caller that abandons the drain leaves
    // the removal unobserved rather than pretending it happened.
    let owner = crate::native_dialog::RetainedOwner::start(async move {
        let mut removed = 0usize;
        let mut failed: Vec<(PathBuf, String)> = Vec::new();
        for path in batch {
            match std::fs::remove_file(&path) {
                // Already gone is a successful retirement.
                Ok(()) => removed += 1,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => removed += 1,
                Err(error) => {
                    tracing::warn!(path = %path.display(), %error, "retired artifact could not be removed");
                    failed.push((path, error.to_string()));
                }
            }
        }
        (removed, failed)
    });
    match owner.join().await {
        Ok((removed, failed)) => CleanupReport {
            retired: removed,
            failed,
            delivery: CleanupDelivery::Joined,
        },
        Err(join) => {
            tracing::error!(%join, "artifact cleanup owner did not finish; nothing about the disk is claimed");
            CleanupReport {
                retired: 0,
                failed: Vec::new(),
                delivery: CleanupDelivery::NotObserved(join.to_string()),
            }
        }
    }
}

/// What the update quiescence barrier observed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateQuiescence {
    /// Admission is closed and every admitted operation has settled.
    Quiescent,
    /// Admission is closed, but this many operations had not settled when the
    /// caller's deadline expired. Nothing about their artifacts may be assumed.
    TimedOut { active: usize },
}

impl UpdateQuiescence {
    /// Whether the drain precondition (no in-flight operation) was established.
    pub fn is_quiescent(self) -> bool {
        matches!(self, Self::Quiescent)
    }
}

/// What a whole update-shutdown sequence observed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UpdateShutdown {
    /// Whether every admitted operation settled before the drain.
    pub quiescence: UpdateQuiescence,
    /// What the artifact drain observed. `NotObserved` when the barrier timed out,
    /// because the drain was then deliberately **not** run.
    pub cleanup: CleanupReport,
}

/// Close update admission and wait until every admitted operation has settled.
///
/// **Shutdown barrier.** Closing admission is the service-side state
/// (`UpdateService::admission_closed`), so a check, download, or install that
/// arrives while the process winds down is refused instead of starting network or
/// Host work behind the drain. The wait then covers operations that were already
/// admitted: `dispose_runner` only stops the *timer*, and joins nothing, so it is
/// not by itself a barrier.
///
/// The wait is bounded by `timeout` (the caller's shutdown budget): a download may
/// legitimately have an hour-long deadline, and a shutdown must not inherit it.
/// On expiry this reports [`UpdateQuiescence::TimedOut`] rather than claiming the
/// service is quiet.
///
/// The close is the one-way commitment every pending or future [`HostAdmission`]
/// release observes: the release re-checks `admission_is_open` under the
/// supervisor's slot lock (`update_tasks_if`), and the shutdown paths that close
/// admission *before* touching the Host do it from a closure under that same lock
/// (the exit path's `stop_if`), so a release can never be sent after the commit it
/// had to observe. This function's own close runs on the update-shutdown path,
/// which in the desktop exit sequence is reached after the Host stop has already
/// revoked the control link an `unlock` would travel over.
pub async fn quiesce_updates(app: &DesktopApp, timeout: Duration) -> UpdateQuiescence {
    with_state(app, |update| update.close_admission()).await;
    let deadline = std::time::Instant::now() + timeout;
    loop {
        let active = active_update_operations();
        if active == 0 {
            return UpdateQuiescence::Quiescent;
        }
        let remaining = deadline
            .checked_duration_since(std::time::Instant::now())
            .filter(|remaining| !remaining.is_zero());
        let Some(remaining) = remaining else {
            return UpdateQuiescence::TimedOut { active };
        };
        // Re-check after every wake: the notification is a hint, the counter is
        // the truth, and a missed wake only costs one bounded poll.
        let wait = UPDATE_QUIESCENT.notified();
        let _ = tokio::time::timeout(remaining.min(Duration::from_millis(100)), wait).await;
    }
}

/// Stop polling, close update admission, join in-flight operations, then drain
/// retired artifacts — the one ordered call a shutdown path needs.
///
/// The drain runs **only** when the barrier reported [`UpdateQuiescence::Quiescent`].
/// A timed-out barrier returns [`CleanupDelivery::NotObserved`] and leaves every
/// retired artifact in place, because a still-running download could be writing
/// the very filename a drain would remove.
pub async fn shutdown_updates(app: &DesktopApp, timeout: Duration) -> UpdateShutdown {
    dispose_runner().await;
    let quiescence = quiesce_updates(app, timeout).await;
    let cleanup = match quiescence {
        UpdateQuiescence::Quiescent => {
            let report = drain_artifact_cleanup(app).await;
            tracing::debug!(
                retired = report.retired,
                failed = report.failed.len(),
                delivery = ?report.delivery,
                "retired update artifacts were drained"
            );
            report
        }
        UpdateQuiescence::TimedOut { active } => {
            tracing::warn!(
                active,
                "update shutdown barrier timed out; artifact cleanup was not run"
            );
            CleanupReport {
                retired: 0,
                failed: Vec::new(),
                delivery: CleanupDelivery::NotObserved(format!(
                    "{active} update operations were still in flight when the shutdown deadline expired"
                )),
            }
        }
    };
    let shutdown = UpdateShutdown {
        quiescence,
        cleanup,
    };
    tracing::debug!(
        quiescent = shutdown.quiescence.is_quiescent(),
        delivery = ?shutdown.cleanup.delivery,
        "update shutdown sequence complete"
    );
    shutdown
}

// ---------------------------------------------------------------------------
// Channel policy
// ---------------------------------------------------------------------------

/// The requested channel and the packaged policy for it.
///
/// The loaded configuration is deliberately not retained: [`ReleasePolicy`] owns
/// every value the updater reads from it (feed URL, allow list, trusted keys), so
/// keeping a second copy would allow the two to diverge.
struct ChannelSelection {
    channel: &'static str,
    policy: ReleasePolicy,
}

/// Resolve the packaged policy for the persisted channel preference.
///
/// Fails closed: a missing or malformed packaged configuration, a channel with
/// no packaged source, or a channel without a trusted key is an error that
/// disables delivery before any network request.
fn resolve_policy(app: &DesktopApp, channel: &'static str) -> Result<ChannelSelection, String> {
    let outcome = load_packaged_trust(app);
    let config = match outcome {
        TrustConfigOutcome::Loaded(config) => config,
        TrustConfigOutcome::Absent => {
            return Err(format!(
                "release delivery is disabled: no packaged update source ({TRUST_CONFIG_FILE} is absent)"
            ))
        }
        TrustConfigOutcome::Invalid(detail) => return Err(format!("release delivery is disabled: {detail}")),
    };
    let policy = ReleasePolicy::select(&config, channel).map_err(|error| error.to_string())?;
    if !policy.has_trust_anchor() {
        return Err(format!(
            "release delivery is disabled: the `{channel}` channel has no packaged release signing key, \
             so a downloaded artifact could not be verified as a genuine release"
        ));
    }
    Ok(ChannelSelection { channel, policy })
}

/// The renderer's persisted preference; packaged authority may override it.
async fn channel_preference(app: &DesktopApp) -> Result<&'static str, String> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let settings = state.settings.lock().await;
    match settings.get(UPDATE_CHANNEL_KEY) {
        Ok(value) => Ok(update_security::normalize_channel(value)),
        Err(error) => Err(error.to_string()),
    }
}

/// Read-only configuration for the Updates page, using the same packaged source
/// as checks. Renderer settings never provide feed authority.
pub async fn configuration(
    app: &DesktopApp,
) -> Result<update_security::UpdateConfiguration, DshError> {
    let requested = channel_preference(app)
        .await
        .map_err(|error| DshError::other("update_configuration", error))?;
    Ok(update_security::present_configuration(
        &load_packaged_trust(app),
        requested,
    ))
}

/// Effective check channel, honoring a packaged pin even after an older build
/// persisted another channel preference.
async fn requested_channel(app: &DesktopApp) -> Result<&'static str, String> {
    let requested = channel_preference(app).await?;
    Ok(update_security::effective_channel(
        &load_packaged_trust(app),
        requested,
    ))
}

// ---------------------------------------------------------------------------
// Mandatory-update decision
// ---------------------------------------------------------------------------

// The last confirmed mandatory decision is *not* held here. The independent
// policy runner (`policy_runner` behind `policy_composition::PolicyGate`) owns it,
// and ordinary-update admission reads the authoritative verdict fresh from
// `AppState.policy` through `current_enforcement`, so a presentation callback or
// ordinary-feed failure cannot replace it.
//
// It is deliberately not a persisted value: upstream is explicit that policy is
// not carried across restarts, and an unqueried process starts from
// `MandatoryDecision::initial`, which does not block.
//
// ---------------------------------------------------------------------------
// Automatic check runner
// ---------------------------------------------------------------------------

/// The check runner shared by the whole process.
///
/// One per application: the schedule is a single completion-based deadline
/// shared by the launch check, the periodic timer, and every explicit request,
/// which is what makes joined callers advance the backoff only once. The cell
/// is written once by [`start_runner`] and read by [`runner`]; a second start
/// is refused rather than replacing a live timer.
static RUNNER: std::sync::OnceLock<std::sync::Arc<UpdateRunner>> = std::sync::OnceLock::new();

/// The network check, as the runner sees it.
///
/// It delegates to [`check_with_outcome`], which already owns single flight: a
/// check that joins an in-flight one, or that is refused because a download or
/// install owns the service, reports [`CheckOutcome::Skipped`] so the runner
/// leaves the polling deadline alone. Treating those as failures would let an
/// unrelated download push the poll interval out to the backoff cap.
struct NetworkCheckExecutor {
    app: DesktopApp,
}

impl CheckExecutor for NetworkCheckExecutor {
    fn execute(
        &self,
        trigger: CheckTrigger,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CheckOutcome> + Send + '_>> {
        Box::pin(async move {
            tracing::debug!("automatic update check ({})", trigger.label());
            match check_with_outcome(&self.app).await {
                Ok((_presentation, outcome)) => outcome,
                Err(error) => {
                    // A command-level error still means the attempt was made.
                    tracing::debug!("automatic update check failed: {error}");
                    CheckOutcome::Failed
                }
            }
        })
    }
}

/// Start automatic polling, if this build can deliver a release at all.
///
/// **A build with no packaged trust configuration never polls.** Absent,
/// unreadable, malformed, or unkeyed `updates.json` means no feed authority, so
/// a check could not produce an installable candidate and the timer would only
/// generate periodic failures. That is upstream's `app-update.yml` rule: an
/// application with no packaged update source has no release delivery.
///
/// Returns whether polling was started, so the caller can report the reason a
/// portable build stays silent instead of inferring it.
pub fn start_runner(app: &DesktopApp) -> bool {
    let outcome = load_packaged_trust(app);
    match outcome {
        TrustConfigOutcome::Loaded(config) => {
            if !any_channel_has_a_trust_anchor(&config) {
                tracing::debug!(
                    "automatic update checks are disabled: the packaged update source declares no trusted signing key"
                );
                return false;
            }
        }
        TrustConfigOutcome::Absent => {
            tracing::debug!(
                "automatic update checks are disabled: no packaged update source ({TRUST_CONFIG_FILE} is absent)"
            );
            return false;
        }
        TrustConfigOutcome::Invalid(detail) => {
            tracing::warn!("automatic update checks are disabled: {detail}");
            return false;
        }
    }
    let config = match update_security::resolve_schedule_config(|name| std::env::var(name).ok()) {
        Ok(config) => config,
        Err(error) => {
            // An invalid override is a configuration bug, not a reason to poll
            // with guessed values: fail loud and stay off.
            tracing::error!("automatic update checks are disabled: {error}");
            return false;
        }
    };
    let runner = std::sync::Arc::new(UpdateRunner::new(
        config,
        std::sync::Arc::new(NetworkCheckExecutor { app: app.clone() }),
    ));
    if RUNNER.set(runner.clone()).is_err() {
        // Already started by an earlier call; leave the live timer alone.
        return true;
    }
    runner.start();
    true
}

/// Whether any packaged channel carries a trusted release signing key.
fn any_channel_has_a_trust_anchor(config: &ReleaseTrustConfig) -> bool {
    [config.stable.as_ref(), config.beta.as_ref()]
        .into_iter()
        .flatten()
        .any(|feed| !feed.trusted_keys.is_empty())
}

/// The process's check runner, when automatic polling has started.
///
/// `None` before [`start_runner`] succeeds and after a build with no packaged
/// trust has refused to poll. The headless probe's seam only
/// (`cfg(updater_probe)`): the shell starts, wakes, and disposes the runner
/// through the functions below and never reads the cell.
#[cfg(updater_probe)]
pub fn runner() -> Option<&'static std::sync::Arc<UpdateRunner>> {
    RUNNER.get()
}

/// Dispose the runner. Idempotent, and a no-op when polling never started.
pub async fn dispose_runner() {
    if let Some(runner) = RUNNER.get() {
        runner.dispose().await;
    }
}

/// Ask for an automatic check now (a foreground or system-resume wake).
pub fn request_check(trigger: CheckTrigger) {
    if let Some(runner) = RUNNER.get() {
        runner.request(trigger);
    }
}

// ---------------------------------------------------------------------------
// Manifest retrieval
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateManifest {
    version: String,
    url: String,
    sha256: String,
    #[serde(default)]
    signature: Option<String>,
}

/// A manifest that has passed every admission check.
///
/// `Debug` is derived for assertion messages: `Result::expect_err` requires the
/// success side to be printable, and an admission failure that cannot say which
/// manifest was admitted is much harder to diagnose.
#[derive(Debug, Clone, PartialEq, Eq)]
struct AdmittedManifest {
    version: String,
    url: String,
    sha256: String,
    signature: String,
}

/// Fetch and fully admit the manifest for `selection`.
///
/// Returns the admitted manifest or the classified failure message. No network
/// request is made unless the packaged policy first admits the feed URL.
async fn fetch_manifest(selection: &ChannelSelection) -> Result<AdmittedManifest, String> {
    let plan = selection
        .policy
        .admit_check()
        .map_err(|error: PolicyFailure| error.to_string())?;
    let client = build_client()?;
    let body = fetch_url(
        &client,
        &selection.policy,
        &plan,
        MAX_FEED_BYTES,
        FEED_TIMEOUT,
    )
    .await
    .map_err(|error| format!("update feed request failed: {error}"))?;
    let manifest: UpdateManifest = serde_json::from_slice(&body)
        .map_err(|error| format!("invalid update feed response: {error}"))?;
    admit_manifest(selection, manifest)
}

/// Validate one manifest against the packaged policy.
fn admit_manifest(
    selection: &ChannelSelection,
    manifest: UpdateManifest,
) -> Result<AdmittedManifest, String> {
    let UpdateManifest {
        version,
        url,
        sha256,
        signature,
    } = manifest;
    if !update_security::is_valid_semver(&version) {
        return Err("invalid update feed response: version is not valid SemVer".to_string());
    }
    if sha256.trim().is_empty() {
        return Err(
            "invalid update feed response: the manifest carries no SHA-256 digest".to_string(),
        );
    }
    // The digest is a *shape* requirement before it is a signed-metadata
    // requirement: it is interpolated into the signed message and later into the
    // artifact filename, so anything that is not exactly 64 ASCII hex characters
    // is refused here instead of being signed over or sliced.
    if !update_security::is_valid_sha256(&sha256) {
        return Err(format!(
            "invalid update feed response: {}",
            VerifyFailure::MalformedDigest
        ));
    }
    // Provenance is mandatory and is verified before the artifact is fetched,
    // so an unsigned or wrongly signed release is never downloaded at all.
    let release = SignedRelease {
        version: &version,
        channel: selection.channel,
        sha256: &sha256,
    };
    let signature = signature
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            format!(
                "the release manifest is not signed: {}",
                VerifyFailure::MissingSignature
            )
        })?;
    update_security::verify_release(selection.policy.trusted_keys(), &release, Some(signature))
        .map_err(|failure| {
            format!("the release manifest failed signature verification: {failure}")
        })?;
    // The artifact host must be admitted by the same allow list as the feed.
    selection
        .policy
        .admit_artifact(&url)
        .map_err(|error| format!("the release artifact was refused: {error}"))?;
    Ok(AdmittedManifest {
        version,
        url,
        sha256: sha256.to_ascii_lowercase(),
        signature: signature.to_ascii_lowercase(),
    })
}

/// One reqwest client with no implicit redirect following: redirects are
/// resolved by hand so each hop is checked against the packaged allow list.
fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|error| format!("could not create the release HTTP client: {error}"))
}

/// One admitted response body, with its declared length when the server
/// announced one.
///
/// Manifests and artifacts are both read as a stream: the manifest reader caps
/// how much it collects, and the artifact reader hashes and writes chunks as
/// they arrive. Buffering a whole body first would make the cap a
/// post-condition instead of a limit.
struct Body {
    response: reqwest::Response,
    content_length: Option<u64>,
}

/// Execute one admitted request, following only allowed redirects.
async fn execute(
    client: &reqwest::Client,
    policy: &ReleasePolicy,
    plan: &update_security::RequestPlan,
    deadline: Duration,
) -> Result<Body, String> {
    let started = std::time::Instant::now();
    let mut url = plan.url.clone();
    for _ in 0..=MAX_REDIRECTS {
        let remaining = deadline
            .checked_sub(started.elapsed())
            .ok_or_else(|| "ETIMEDOUT: the request exceeded its total deadline".to_string())?;
        let response = tokio::time::timeout(remaining, client.get(url.clone()).send())
            .await
            .map_err(|_| "ETIMEDOUT: no response headers within the connect deadline".to_string())?
            .map_err(|error| transport_message("release request failed", &error))?;
        let status = response.status();
        if status.is_redirection() {
            let location = response
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|value| value.to_str().ok())
                .ok_or_else(|| {
                    format!("the release server returned {status} without a Location header")
                })?;
            url = policy
                .admit_redirect(plan, location)
                .map_err(|error: PolicyFailure| error.to_string())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("artifact HTTP failure: {status}"));
        }
        let content_length = response.content_length();
        return Ok(Body {
            response,
            content_length,
        });
    }
    Err(format!(
        "the release server redirected more than {MAX_REDIRECTS} times"
    ))
}

/// Fetch a small body into memory with a hard cap.
async fn fetch_url(
    client: &reqwest::Client,
    policy: &ReleasePolicy,
    plan: &update_security::RequestPlan,
    cap: u64,
    deadline: Duration,
) -> Result<Vec<u8>, String> {
    let body = execute(client, policy, plan, deadline).await?;
    let Body {
        mut response,
        content_length,
    } = body;
    if let Some(length) = content_length {
        if length > cap {
            return Err(format!(
                "the release server offered {length} bytes, above the {cap}-byte limit"
            ));
        }
    }
    let mut collected = Vec::new();
    let read = tokio::time::timeout(deadline, async {
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|error| transport_message("release body read failed", &error))?
        {
            if collected.len() as u64 + chunk.len() as u64 > cap {
                return Err(format!("the release body exceeded the {cap}-byte limit"));
            }
            collected.extend_from_slice(&chunk);
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "ETIMEDOUT: the release body did not finish within the deadline".to_string())?;
    read?;
    Ok(collected)
}

// ---------------------------------------------------------------------------
// Check
// ---------------------------------------------------------------------------

/// `update_check`: consult the packaged feed and present the result.
///
/// Single-flight: a check already in progress is joined rather than duplicated.
pub async fn check(app: &DesktopApp) -> Result<DesktopUpdatePresentation, DshError> {
    let (presentation, _outcome) = check_with_outcome(app).await?;
    Ok(presentation)
}

/// Boxed result of one scheduled check, including its polling outcome.
type UpdateCheckFuture<'a> = std::pin::Pin<
    Box<
        dyn std::future::Future<
                Output = Result<(DesktopUpdatePresentation, CheckOutcome), DshError>,
            > + Send
            + 'a,
    >,
>;

/// [`check`], plus the outcome the schedule runner needs.
///
/// The three cases are distinguished because they mean different things to the
/// polling deadline:
///
/// - a check that actually consulted the feed and failed is a **failure**, and
///   doubles the retry delay;
/// - a check that joined an in-flight request, or was refused because a
///   download or install owns the service, **skipped**: nothing was attempted,
///   so the deadline must not move;
/// - anything else **succeeded**, restoring the base interval.
pub fn check_with_outcome(app: &DesktopApp) -> UpdateCheckFuture<'_> {
    // Explicitly erase the recursive Check -> confirmation -> Check future.
    let app = app.clone();
    Box::pin(async move {
        let outcome = admitted(
            &app,
            |update| {
                if !update.admission_is_open() {
                    return Admission::Closed;
                }
                // Join an in-flight operation, and refuse while a download or
                // install owns the service so a check cannot displace a
                // confirmed target.
                if let Some(flight) = update.flight {
                    tracing::debug!("update check skipped: {} is in flight", flight.label());
                    return Admission::Busy(crate::commands::present_update(&update.state));
                }
                match update.claim_flight(UpdateFlight::Check) {
                    Ok(owner) => {
                        update.state.phase = DesktopUpdatePhase::Checking;
                        update.state.failed_operation = None;
                        update.state.message = None;
                        update.state.technical_details = None;
                        Admission::Admitted {
                            claim: FlightClaim {
                                flight: UpdateFlight::Check,
                                owner,
                            },
                            context: (),
                        }
                    }
                    Err(exhausted) => {
                        // Typed exhaustion, never a panic: nothing was claimed,
                        // and the refusal is reported like any other check
                        // failure so the runner backs off instead of retrying a
                        // service that cannot admit work.
                        mark_failure(
                            &mut update.state,
                            DesktopUpdateOperation::Check,
                            &exhausted.to_string(),
                        );
                        Admission::Busy(crate::commands::present_update(&update.state))
                    }
                }
            },
            |app, claim, ()| async move { run_check(&app, claim).await },
        )
        .await?;
        let (presentation, closed) = match outcome {
            AdmittedRun::Joined(presentation) | AdmittedRun::Ran(presentation) => {
                (presentation, false)
            }
            // Nothing was attempted: reporting the currently published
            // *presentation* (never the raw state) as a skipped poll is what
            // keeps a shutting-down process from being read as "checked
            // recently". No emit: this caller publishes nothing of its own.
            AdmittedRun::Closed => (crate::commands::present_update(&current(&app).await), true),
        };
        let outcome = if closed {
            CheckOutcome::Skipped
        } else {
            classify_check_outcome(&app, &presentation).await
        };
        Ok((presentation, outcome))
    })
}

/// Decide what a completed check means for the polling schedule.
async fn classify_check_outcome(
    app: &DesktopApp,
    presentation: &DesktopUpdatePresentation,
) -> CheckOutcome {
    // A download or install that started while the check ran means this check
    // was refused rather than attempted. `fail` never leaves a flight set, so a
    // check that owns the service itself reports its own result below.
    let blocked_by_other_work = {
        let state = app.state::<std::sync::Arc<AppState>>();
        let update = state.update.lock().await;
        matches!(
            update.flight,
            Some(UpdateFlight::Download) | Some(UpdateFlight::Install)
        )
    };
    if blocked_by_other_work {
        return CheckOutcome::Skipped;
    }
    match presentation.phase {
        DesktopUpdatePhase::Error if presentation.failure_operation_is_check() => {
            CheckOutcome::Failed
        }
        // `Checking` is the join case: another caller owns the request.
        DesktopUpdatePhase::Checking => CheckOutcome::Skipped,
        _ => CheckOutcome::Succeeded,
    }
}

/// Whether a failed presentation attributes the failure to the check itself.
trait PresentationFailureOperation {
    fn failure_operation_is_check(&self) -> bool;
}

impl PresentationFailureOperation for DesktopUpdatePresentation {
    fn failure_operation_is_check(&self) -> bool {
        use dsh_core::protocol::DesktopUpdateFailureKind::*;
        matches!(self.failure, Some(Check) | Some(CheckNetwork))
    }
}

/// The body of one admitted check.
///
/// The caller already claimed `claim` under the service lock (see
/// [`check_with_outcome`]); this function only uses the claim it was given, so a
/// check can never capture a candidate against an ownership generation other
/// than the one that admitted it.
async fn run_check(
    app: &DesktopApp,
    claim: FlightClaim,
) -> Result<DesktopUpdatePresentation, DshError> {
    let owner = claim.owner;

    let channel = match requested_channel(app).await {
        Ok(channel) => channel,
        Err(error) => {
            return Ok(fail_owned(
                app,
                UpdateFlight::Check,
                owner,
                DesktopUpdateOperation::Check,
                &error,
                false,
            )
            .await);
        }
    };
    let selection = match resolve_policy(app, channel) {
        Ok(selection) => selection,
        Err(detail) => {
            // No packaged authority: refuse before any network activity and
            // invalidate whatever was previously admitted.
            return Ok(fail_owned(
                app,
                UpdateFlight::Check,
                owner,
                DesktopUpdateOperation::Check,
                &detail,
                true,
            )
            .await);
        }
    };

    if !with_state(app, |update| update.owns_flight(UpdateFlight::Check, owner)).await {
        return Ok(publish(app, &current(app).await));
    }
    publish(app, &current(app).await);

    let manifest = fetch_manifest(&selection).await;
    let installed = installed_version(&app.state::<std::sync::Arc<AppState>>()).to_string();

    let presentation = match manifest {
        Err(message) => {
            fail_owned(
                app,
                UpdateFlight::Check,
                owner,
                DesktopUpdateOperation::Check,
                &message,
                false,
            )
            .await
        }
        Ok(manifest) if !update_security::greater_version(&manifest.version, &installed) => {
            // No newer release: the previous candidate is no longer applicable.
            let committed = with_state(app, |update| {
                if !update.owns_flight(UpdateFlight::Check, owner) {
                    return false;
                }
                let previous = update.candidate.clone();
                let _ = update.invalidate_candidate();
                update.state.phase = DesktopUpdatePhase::Idle;
                update.state.version = Some(installed.clone());
                update.state.failed_operation = None;
                update.state.message = None;
                update.state.technical_details = None;
                update.flight = None;
                update.checked = true;
                // Retire under the same lock that detached the candidate: a
                // path can only be queued once nothing owns it.
                if let Some(path) = superseded_artifact(previous.as_ref(), None) {
                    update.retire_artifact(path);
                }
                true
            })
            .await;
            let presentation = publish(app, &current(app).await);
            if committed {
                present_up_to_date(app).await;
            }
            presentation
        }
        Ok(manifest) => {
            let candidate = UpdateCandidate {
                version: manifest.version.clone(),
                channel: selection.channel.to_string(),
                url: manifest.url.clone(),
                sha256: manifest.sha256.clone(),
                signature: manifest.signature.clone(),
                artifact_path: None,
            };
            let committed = with_state(app, |update| {
                if !update.owns_flight(UpdateFlight::Check, owner) {
                    return false;
                }
                // A new candidate supersedes any previous target and invalidates
                // any in-progress download episode.
                let previous = update.candidate.clone();
                let superseded = superseded_artifact(previous.as_ref(), Some(&candidate));
                let _ = update.invalidate_candidate();
                update.state.phase = DesktopUpdatePhase::Available;
                update.state.version = Some(candidate.version.clone());
                update.state.failed_operation = None;
                update.state.preparation_failure = None;
                update.state.percent = None;
                update.state.message = None;
                update.state.technical_details = None;
                update.candidate = Some(candidate);
                // The check releases its claim before prompting: the prompt is
                // reserved (not flown), so a download or install can claim the
                // service while the user decides. The supervisor's settlement
                // then finds nothing to release.
                update.flight = None;
                update.checked = true;
                // Retire under the same lock that detached the previous
                // candidate; never the path the next candidate publishes.
                if let Some(path) = superseded {
                    update.retire_artifact(path);
                }
                true
            })
            .await;
            let presentation = publish(app, &current(app).await);
            if committed {
                open_confirmation(app).await?;
            }
            presentation
        }
    };
    Ok(presentation)
}

/// The installed application version, which is the comparison baseline.
pub const CURRENT_VERSION: &str = env!("CARGO_PKG_VERSION");

async fn present_up_to_date(app: &DesktopApp) {
    let state = app.state::<std::sync::Arc<AppState>>();
    let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
    let _ = crate::native_dialog::answer(|reply| {
        app.dialog()
            .message(format_message(
                messages.update_current,
                &[("version", installed_version(&state))],
            ))
            .title(messages.update_title)
            .buttons(MessageDialogButtons::Ok)
            .show(reply);
    })
    .await;
}

// ---------------------------------------------------------------------------
// Confirmation dialogs
// ---------------------------------------------------------------------------

/// `update_open`: the main-process-owned confirmation.
///
/// The confirmed version is read from the candidate, never from the renderer.
pub async fn open_confirmation(app: &DesktopApp) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let (phase, version, busy, enforcement) = {
        let update = state.update.lock().await;
        (
            update.state.phase,
            update.candidate.as_ref().map(|c| c.version.clone()),
            update.flight.is_some(),
            current_enforcement(&state, &update),
        )
    };
    // **The mandatory gate.** A blocking decision changes the *shape* of the
    // prompt, not whether the update exists: the user must install, so the
    // download prompt offers no "Later" while tasks are unaffected. What it
    // must never do is make an ordinary available update mandatory — that is
    // why this reads `enforcement`, which requires a blocking verdict, and not
    // the presence of a candidate.
    if enforcement.is_blocking() {
        return open_mandatory_confirmation(app, phase, version, &enforcement).await;
    }
    match phase {
        DesktopUpdatePhase::Ready => confirm_install(app, version).await,
        DesktopUpdatePhase::Available => {
            // A busy service must not start a second download.
            if busy {
                return Ok(());
            }
            // Reserve the one confirmation *before* the dialog is shown. This is
            // what closes the post-check gap: a second caller — a duplicate
            // `update_open`, or the prompt this check is about to open — joins
            // this reservation instead of opening a second dialog, and the answer
            // below is bound to the candidate and episode reserved here.
            let reserved = with_state(app, |update| update.reserve_confirmation().is_some()).await;
            if !reserved {
                tracing::debug!("update confirmation already open; joining the reserved prompt");
                return Ok(());
            }
            let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
            let install = messages.update_download.to_string();
            let later = messages.later.to_string();
            let answer = crate::native_dialog::answer(|reply| {
                app.dialog()
                    .message(format_message(
                        &format!(
                            "{}\n\n{}",
                            messages.update_available, messages.update_detail
                        ),
                        &[("version", version.as_deref().unwrap_or_default())],
                    ))
                    .title(messages.update_title)
                    .buttons(MessageDialogButtons::OkCancelCustom(install, later))
                    .show(reply);
            })
            .await;
            let outcome =
                with_state(app, |update| update.answer_reserved_confirmation(answer)).await;
            // A superseded reservation authorizes nothing: the candidate the user
            // saw is no longer admitted, so no late download starts.
            let Some(answer) = outcome.answered() else {
                tracing::debug!("update confirmation was superseded before it was answered");
                return Ok(());
            };
            if answer == Some(true) {
                download(app, version).await?;
            }
            // Declining leaves the candidate admitted in `Available`, so the
            // user can confirm later without re-checking.
            Ok(())
        }
        DesktopUpdatePhase::Error | DesktopUpdatePhase::Idle => {
            // Boxed: `check` → `open_confirmation` → `check` is mutual
            // recursion across async fns.
            Box::pin(check(app)).await?;
            Ok(())
        }
        _ => Ok(()),
    }
}

/// The mandatory enforcement for the current shell state.
///
/// `available` is the admitted candidate's version, which is the only release
/// this process may install: satisfying a mandatory requirement still goes
/// through the same verified candidate.
fn current_enforcement(
    state: &AppState,
    update: &crate::state::UpdateService,
) -> MandatoryEnforcement {
    let decision = state
        .policy
        .current_decision()
        .unwrap_or_else(MandatoryDecision::initial);
    mandatory_update::enforcement(
        &decision,
        update
            .candidate
            .as_ref()
            .map(|candidate| candidate.version.as_str()),
        installed_version(state),
    )
}

fn installed_version(state: &AppState) -> &str {
    state
        .policy
        .runtime_version
        .as_deref()
        .unwrap_or(CURRENT_VERSION)
}

/// The mandatory-update confirmation.
///
/// Differs from the ordinary prompt in exactly two ways, and both come from
/// upstream `mandatory-update-window.ts`:
///
/// - **No `Later` while the requirement stands.** The primary action proceeds;
///   the secondary only appears when live tasks make a deferral meaningful, and
///   even then it defers the *restart*, never the requirement.
/// - **A blocking decision with no release still blocks.** The prompt then
///   explains that no applicable update is available and offers the approved
///   download page, rather than silently falling through to an optional prompt
///   the user could dismiss.
async fn open_mandatory_confirmation(
    app: &DesktopApp,
    phase: DesktopUpdatePhase,
    version: Option<String>,
    enforcement: &MandatoryEnforcement,
) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
    match enforcement {
        MandatoryEnforcement::Required { version: required } => {
            // A verified target is installed by the ordinary path; a target that
            // is not yet downloaded is confirmed with no decline option.
            if phase == DesktopUpdatePhase::Ready {
                return confirm_install(app, version).await;
            }
            // Reserve before the dialog: a mandatory download prompt is a
            // confirmation like any other, and a second caller joins it.
            let reserved = with_state(app, |update| update.reserve_confirmation().is_some()).await;
            if !reserved {
                return Ok(());
            }
            let answer = crate::native_dialog::answer(|reply| {
                app.dialog()
                    .message(format_message(
                        &format!(
                            "{}\n\n{}",
                            messages.update_available, messages.update_detail
                        ),
                        &[("version", required.as_str())],
                    ))
                    .title(messages.update_title)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        messages.update_download.to_string(),
                        messages.quit.to_string(),
                    ))
                    .show(reply);
            })
            .await;
            let outcome =
                with_state(app, |update| update.answer_reserved_confirmation(answer)).await;
            let Some(answer) = outcome.answered() else {
                return Ok(());
            };
            match answer {
                Some(true) => download(app, Some(required.clone())).await?,
                // Consent-based Quit is the *secondary button*, never a lost
                // callback: `None` above is not the user's Quit choice.
                Some(false) => crate::quit_flow::request_quit(app).await?,
                None => {}
            }
            Ok(())
        }
        MandatoryEnforcement::RequiredWithoutRelease { page } => {
            // The requirement stands and no installable release is known. The
            // page is the policy's approved fallback, already checked against
            // the packaged allow list; absent one, the guidance is to retry.
            //
            // Deliberately **not** reserved: this prompt authorizes no operation
            // (it only explains the requirement and points at an approved page),
            // so coalescing it would suppress information without protecting any
            // state transition.
            let body = match page {
                Some(page) => format!("{}\n\n{page}", messages.update_available),
                None => format!(
                    "{}\n\n{}",
                    messages.update_available, messages.update_detail
                ),
            };
            let _ = crate::native_dialog::answer(|reply| {
                app.dialog()
                    .message(body)
                    .title(messages.update_title)
                    .buttons(MessageDialogButtons::Ok)
                    .show(reply);
            })
            .await;
            Ok(())
        }
        // `NotRequired` and `Checking` never reach this function.
        MandatoryEnforcement::NotRequired | MandatoryEnforcement::Checking => Ok(()),
    }
}

/// The Install-and-Restart confirmation (upstream `desktopUpdateReadyConfirmation`).
///
/// Reserves the one confirmation slot before the dialog is shown, so the answer
/// is bound to the candidate and episode the user saw: a verified target that is
/// superseded while the prompt is open authorizes nothing, and `Later` leaves the
/// `Ready` presentation and the published artifact exactly as they were.
async fn confirm_install(app: &DesktopApp, version: Option<String>) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let required = state
        .policy
        .current_decision()
        .is_some_and(|decision| decision.blocking);
    let reserved = with_state(app, |update| update.reserve_confirmation().is_some()).await;
    if !reserved {
        tracing::debug!("install confirmation already open; joining the reserved prompt");
        return Ok(());
    }
    let messages = {
        let model = state.locale.lock().await;
        crate::state::messages(model.snapshot().effective)
    };
    let install_label = messages.install_and_restart.to_string();
    let later = if required {
        messages.quit
    } else {
        messages.later
    }
    .to_string();
    let answer = crate::native_dialog::answer(|reply| {
        app.dialog()
            .message(format_message(
                &format!(
                    "{}\n\n{}",
                    if cfg!(windows) {
                        messages.update_downloaded_title_windows
                    } else {
                        messages.update_available
                    },
                    if cfg!(windows) {
                        messages.update_downloaded_detail_windows
                    } else {
                        messages.update_detail
                    }
                ),
                &[("version", version.as_deref().unwrap_or_default())],
            ))
            .title(messages.update_title)
            .buttons(MessageDialogButtons::OkCancelCustom(install_label, later))
            .show(reply);
    })
    .await;
    let outcome = with_state(app, |update| update.answer_reserved_confirmation(answer)).await;
    let Some(answer) = outcome.answered() else {
        tracing::debug!("install confirmation was superseded before it was answered");
        return Ok(());
    };
    if answer != Some(true) {
        // Cancellation never clears a mandatory requirement or stops live tasks.
        // In a required prompt the secondary action is ordinary, consent-based
        // Quit; a lost callback (`None`) is neither consent nor Quit.
        if answer == Some(false) && required {
            crate::quit_flow::request_quit(app).await?;
        }
        // `Later`: the verified artifact and the `Ready` presentation stay.
        return Ok(());
    }
    install(app, version).await
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/// Cache directory for verified artifacts.
fn artifact_cache_dir() -> PathBuf {
    dirs::cache_dir()
        .unwrap_or_else(std::env::temp_dir)
        .join("dsh-desktop-updater")
}

/// Stream the admitted artifact, verify it, and publish it atomically.
///
/// `confirmed_version` is the version the user saw in the confirmation. It must
/// match the candidate exactly; a mismatch means the confirmation is stale and
/// the download is refused (upstream `download(version)`).
async fn download(app: &DesktopApp, confirmed_version: Option<String>) -> Result<(), DshError> {
    let app = app.clone();
    let outcome = admitted(
        &app,
        move |update| {
            if !update.admission_is_open() {
                return Admission::Closed;
            }
            if update.flight.is_some() {
                return Admission::Refused(DshError::other(
                    "update_busy",
                    "another update operation is already in progress",
                ));
            }
            let refusal = match update.candidate.as_ref() {
                None => Some(DshError::other(
                    "update_no_candidate",
                    "no checked update is available to download",
                )),
                Some(candidate)
                    if confirmed_version.as_deref() != Some(candidate.version.as_str()) =>
                {
                    Some(DshError::other(
                        "update_confirmation_stale",
                        "the confirmed update version is no longer the admitted candidate",
                    ))
                }
                _ => None,
            };
            if let Some(error) = refusal {
                // Refusal is recorded under this lock, never by re-locking it or
                // clearing a flight that another caller claimed after we returned.
                mark_failure(
                    &mut update.state,
                    DesktopUpdateOperation::Download,
                    &error.to_string(),
                );
                return Admission::Refused(error);
            }
            // Claim ownership, the episode identity, and the immutable candidate
            // in one lock scope: the bytes that will be verified are the bytes of
            // the candidate that was confirmed.
            let candidate = update
                .candidate
                .as_ref()
                .expect("a refusal was returned when no candidate is admitted")
                .clone();
            let episode = match update.begin_episode() {
                Ok(episode) => episode,
                Err(exhausted) => {
                    let error = DshError::other("update_identity_exhausted", exhausted.to_string());
                    mark_failure(
                        &mut update.state,
                        DesktopUpdateOperation::Download,
                        &error.to_string(),
                    );
                    return Admission::Refused(error);
                }
            };
            let owner = match update.claim_flight(UpdateFlight::Download) {
                Ok(owner) => owner,
                Err(exhausted) => {
                    let error = DshError::other("update_identity_exhausted", exhausted.to_string());
                    mark_failure(
                        &mut update.state,
                        DesktopUpdateOperation::Download,
                        &error.to_string(),
                    );
                    return Admission::Refused(error);
                }
            };
            update.state.phase = DesktopUpdatePhase::Downloading;
            update.state.percent = Some(0.0);
            update.state.failed_operation = None;
            update.state.message = None;
            Admission::Admitted {
                claim: FlightClaim {
                    flight: UpdateFlight::Download,
                    owner,
                },
                context: DownloadAdmission {
                    channel: candidate.channel.clone(),
                    candidate,
                    episode,
                },
            }
        },
        |app, claim, context| async move { download_owned(&app, claim, context).await },
    )
    .await?;
    match outcome {
        AdmittedRun::Ran(()) => Ok(()),
        AdmittedRun::Joined(_) => Err(DshError::other(
            "update_busy",
            "another update operation is already in progress",
        )),
        // Admission is closed for shutdown: no download may start.
        AdmittedRun::Closed => Err(DshError::other(
            "update_shutting_down",
            "the updater is shutting down; the download was not admitted",
        )),
    }
}

/// Everything an admitted download needs, captured under the admission lock.
struct DownloadAdmission {
    candidate: UpdateCandidate,
    episode: crate::state::DownloadEpisode,
    channel: String,
}

async fn download_owned(
    app: &DesktopApp,
    claim: FlightClaim,
    admission: DownloadAdmission,
) -> Result<(), DshError> {
    let DownloadAdmission {
        candidate,
        episode,
        channel,
    } = admission;
    let owner = claim.owner;
    publish(app, &current(app).await);

    // Re-resolve the packaged policy for the candidate's own channel: the
    // artifact is admitted against the authority it was admitted under, not
    // against whatever the settings store says now.
    let selection = match channel.as_str() {
        "beta" => resolve_policy(app, "beta"),
        _ => resolve_policy(app, "stable"),
    };
    let result = match selection {
        Err(detail) => Err(detail),
        Ok(selection) if selection.channel != candidate.channel => Err(format!(
            "the release channel changed to `{}` while the update was being downloaded",
            selection.channel
        )),
        Ok(selection) => run_download(app, &selection.policy, &candidate, episode).await,
    };

    match result {
        Ok(path) => {
            let published = with_state(app, |update| {
                if !update.owns_flight(UpdateFlight::Download, owner) {
                    update.retire_artifact(path.clone());
                    return false;
                }
                // The published artifact must belong to the still-admitted
                // candidate, so a stale completion cannot mark a newer or
                // different target Ready.
                let admitted_here = update.candidate.as_ref().is_some_and(|current| {
                    current.version == candidate.version
                        && current.channel == candidate.channel
                        && current.sha256 == candidate.sha256
                });
                if !admitted_here {
                    update.retire_artifact(path.clone());
                    return false;
                }
                // `publish_artifact` itself refuses a superseded episode, so the
                // episode rule is enforced in one place.
                let published = update.publish_artifact(episode, path.clone());
                if !published {
                    // Superseded while downloading: the verified bytes are
                    // discarded rather than left where a newer candidate could be
                    // marked Ready by them. Retired under the same lock that
                    // refused the publication, and the newer state is untouched.
                    update.retire_artifact(path.clone());
                }
                published
            })
            .await;
            if !published {
                tracing::debug!(
                    "discarded a superseded update download for version {}",
                    candidate.version
                );
                return Ok(());
            }
            // The download hands off to the Ready prompt: release the download
            // claim first so the install confirmation and the install operation
            // can claim the service. The supervisor's settlement is then a no-op.
            with_state(app, |update| {
                update.settle_flight(UpdateFlight::Download, owner)
            })
            .await;
            publish(app, &current(app).await);
            confirm_install(app, Some(candidate.version.clone())).await
        }
        Err(message) => {
            // A failed download never leaves a Ready artifact behind. The
            // superseded path is retired, not deleted here: removal belongs to
            // the retained cleanup owner, which reports what it observed.
            let presentation = with_state(app, |update| {
                if !update.owns_flight(UpdateFlight::Download, owner)
                    || !update.episode_is_current(episode)
                {
                    return crate::commands::present_update(&update.state);
                }
                let _ = update.begin_episode();
                // End the candidate borrow before retiring on the same service.
                let retired = update
                    .candidate
                    .as_mut()
                    .and_then(|current_candidate| current_candidate.artifact_path.take());
                if let Some(retired) = retired {
                    update.retire_artifact(retired);
                }
                mark_failure(
                    &mut update.state,
                    DesktopUpdateOperation::Download,
                    &message,
                );
                crate::commands::present_update(&update.state)
            })
            .await;
            app.emit("dsh://update/state", &presentation).ok();
            Err(DshError::other("update_download", message))
        }
    }
}

/// Stream, verify, and atomically publish one artifact.
async fn run_download(
    app: &DesktopApp,
    policy: &ReleasePolicy,
    candidate: &UpdateCandidate,
    episode: crate::state::DownloadEpisode,
) -> Result<PathBuf, String> {
    let plan = policy
        .admit_artifact(&candidate.url)
        .map_err(|error| error.to_string())?;
    let client = build_client()?;
    let body = execute(&client, policy, &plan, TOTAL_DOWNLOAD_TIMEOUT).await?;
    let Body {
        mut response,
        content_length,
    } = body;
    if let Some(length) = content_length {
        if length > MAX_ARTIFACT_BYTES {
            return Err(format!(
                "the update artifact is {length} bytes, above the {MAX_ARTIFACT_BYTES}-byte limit"
            ));
        }
    }
    let cache = artifact_cache_dir();
    std::fs::create_dir_all(&cache)
        .map_err(|error| format!("could not create the updater cache directory: {error}"))?;
    // The candidate identity must name a file *before* any path is composed: a
    // digest that is not 64 ASCII hex characters, or a channel/version that is
    // not a safe single path component, is refused here rather than slicing a
    // byte index or selecting a path outside the cache.
    let file_name = artifact_file_name(candidate).map_err(|failure| failure.to_string())?;
    // Unique temporary name: concurrent or repeated attempts never share a
    // partial file, and a crash leaves only a `.part` behind.
    let temporary = cache.join(format!(
        ".{}.{}.{}.part",
        file_name,
        std::process::id(),
        episode.0
    ));
    let _ = std::fs::remove_file(&temporary);

    let mut file = tokio::fs::File::create(&temporary)
        .await
        .map_err(|error| format!("could not create the update file: {error}"))?;
    let mut hasher = <sha2::Sha256 as sha2::Digest>::new();
    let mut received: u64 = 0u64;
    let mut last_percent = 0.0f64;
    let expected_total = content_length.filter(|length| *length > 0);

    let stream_outcome = tokio::time::timeout(TOTAL_DOWNLOAD_TIMEOUT, async {
        loop {
            let chunk = tokio::time::timeout(IDLE_TIMEOUT, response.chunk())
                .await
                .map_err(|_| {
                    "ETIMEDOUT: the update download stalled between response chunks".to_string()
                })?
                .map_err(|error| transport_message("update download failed", &error))?;
            let Some(chunk) = chunk else { break };
            received += chunk.len() as u64;
            if received > MAX_ARTIFACT_BYTES {
                return Err(format!(
                    "the update artifact exceeded the {MAX_ARTIFACT_BYTES}-byte limit"
                ));
            }
            hasher.update(&chunk);
            file.write_all(&chunk)
                .await
                .map_err(|error| format!("could not write the update file: {error}"))?;

            // Honest progress: a percentage is only reported when the server
            // declared a length, so the bar never invents a denominator.
            if let Some(total) = expected_total {
                let percent = ((received as f64 / total as f64) * 100.0).min(100.0);
                if percent - last_percent >= PROGRESS_STEP || percent >= 100.0 {
                    last_percent = percent;
                    let version = candidate.version.clone();
                    let done = percent >= 100.0;
                    let presentation = with_state(app, |update| {
                        if !update.episode_is_current(episode) {
                            return None;
                        }
                        update.state.phase = if done {
                            DesktopUpdatePhase::Verifying
                        } else {
                            DesktopUpdatePhase::Downloading
                        };
                        update.state.percent = Some(percent);
                        update.state.version = Some(version);
                        Some(crate::commands::present_update(&update.state))
                    })
                    .await;
                    if let Some(presentation) = presentation {
                        app.emit("dsh://update/state", &presentation).ok();
                    }
                    if done {
                        let presentation = with_state(app, |update| {
                            if !update.episode_is_current(episode) {
                                return None;
                            }
                            update.state.phase = DesktopUpdatePhase::Verifying;
                            Some(crate::commands::present_update(&update.state))
                        })
                        .await;
                        if let Some(presentation) = presentation {
                            app.emit("dsh://update/state", &presentation).ok();
                        }
                    }
                }
            }
        }
        Ok::<(), String>(())
    })
    .await
    .map_err(|_| "ETIMEDOUT: the update download exceeded its total deadline".to_string())?;

    if let Err(message) = stream_outcome {
        let _ = file.shutdown().await;
        drop(file);
        let _ = std::fs::remove_file(&temporary);
        return Err(message);
    }
    file.flush()
        .await
        .map_err(|error| format!("could not flush the update file: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("could not sync the update file: {error}"))?;
    drop(file);

    // A declared length must match exactly; a truncated transfer is refused.
    if let Some(total) = expected_total {
        if received != total {
            let _ = std::fs::remove_file(&temporary);
            return Err(format!(
                "the update download ended after {received} of {total} bytes"
            ));
        }
    }

    // Integrity: mandatory, compared against the candidate's own digest.
    let digest = update_security::encode_hex(&hasher.finalize());
    if !digest.eq_ignore_ascii_case(&candidate.sha256) {
        let _ = std::fs::remove_file(&temporary);
        return Err(
            "the downloaded update failed SHA-256 verification; the file was discarded".to_string(),
        );
    }
    // Provenance: mandatory, and checked again over the bytes actually received
    // so the signature cannot be decoupled from the published file.
    update_security::verify_release(
        policy.trusted_keys(),
        &candidate.signed_release(),
        Some(&candidate.signature),
    )
    .map_err(|failure| {
        let _ = std::fs::remove_file(&temporary);
        format!("the downloaded update failed signature verification: {failure}")
    })?;

    // Atomic publication: the final name appears only once the bytes are
    // complete, hashed, and verified.
    let final_path = cache.join(file_name);
    replace_file(&temporary, &final_path)?;
    Ok(final_path)
}

/// Atomically publish `temporary` as `final_path`.
///
/// On Windows `rename` fails when the destination exists, so the existing
/// artifact is moved aside first and removed only after the new one is in
/// place; a failure at any point leaves either the old or the new file, never a
/// partial one.
fn replace_file(temporary: &std::path::Path, final_path: &std::path::Path) -> Result<(), String> {
    match std::fs::rename(temporary, final_path) {
        Ok(()) => Ok(()),
        Err(_) if final_path.exists() => {
            let backup = final_path.with_extension("bin.replaced");
            let _ = std::fs::remove_file(&backup);
            std::fs::rename(final_path, &backup)
                .map_err(|error| format!("could not replace the previous update file: {error}"))?;
            match std::fs::rename(temporary, final_path) {
                Ok(()) => {
                    let _ = std::fs::remove_file(&backup);
                    Ok(())
                }
                Err(error) => {
                    // Restore the previous artifact so the failure is total.
                    let _ = std::fs::rename(&backup, final_path);
                    let _ = std::fs::remove_file(temporary);
                    Err(format!(
                        "could not publish the verified update file: {error}"
                    ))
                }
            }
        }
        Err(error) => {
            let _ = std::fs::remove_file(temporary);
            Err(format!(
                "could not publish the verified update file: {error}"
            ))
        }
    }
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

async fn restore_host_or_exit(app: &DesktopApp, state: &AppState) {
    if let Ok(status) = state.supervisor.restart().await {
        if let Some(url) = status.url.as_deref() {
            if state.gateway.set_host(url).await.is_ok() {
                let restored = state.supervisor.status();
                app.emit("dsh://runtime/state", &restored).ok();
                return;
            }
        }
    }
    // A dead backend must never be left behind an open shell. If restart or
    // gateway reattachment fails, terminate the application instead.
    app.exit(1);
}

/// Why installation must be refused, or `None` when it may proceed.
///
/// Pure: it inspects the service and returns the classified refusal, so the
/// caller can release the service lock before reporting it. `fail` re-locks the
/// same mutex, so reporting a refusal while holding the guard would deadlock the
/// updater against itself — the reason this decision is separated from its
/// presentation.
fn install_refusal(
    update: &crate::state::UpdateService,
    confirmed_version: Option<&str>,
) -> Option<DshError> {
    let Some(candidate) = update.candidate.as_ref() else {
        return Some(DshError::other(
            "update_no_candidate",
            "no verified update is available to install",
        ));
    };
    // The confirmed version is checked *before* readiness: a stale confirmation
    // is the more specific and more actionable fault, and reporting "not
    // downloaded yet" for a version that is no longer the candidate would send
    // the user to retry a download that cannot produce the version they saw.
    if confirmed_version != Some(candidate.version.as_str()) {
        return Some(DshError::other(
            "update_confirmation_stale",
            "the confirmed update version is no longer the admitted candidate",
        ));
    }
    if candidate.artifact_path.is_none() {
        return Some(DshError::other(
            "update_artifact_not_ready",
            "the confirmed update has not been downloaded and verified",
        ));
    }
    if !update.has_published_artifact() {
        return Some(DshError::other(
            "update_artifact_stale",
            "the verified update belongs to a superseded download",
        ));
    }
    None
}

/// Fresh, synchronous admission at the supervisor's final pre-stop check.
/// A policy change may allow mandatory Update but never an obsolete artifact.
fn install_execution_admission(
    state: &AppState,
    candidate: &UpdateCandidate,
    owner: UpdateOperation,
) -> Result<(), DshError> {
    use crate::policy_owner::NativeAction;
    let refuse = |message: &str| DshError::other("update_install_admission", message);
    if !state.policy.allows(NativeAction::Normal)
        && !state.policy.allows(NativeAction::MandatoryUpdate)
    {
        return Err(refuse("update admission is no longer available"));
    }
    if !update_security::greater_version(&candidate.version, installed_version(state)) {
        return Err(refuse(
            "the candidate is not newer than the installed runtime",
        ));
    }
    let settings = state
        .settings
        .try_lock()
        .map_err(|_| refuse("channel settings are changing; retry installation"))?;
    let channel = settings
        .get(UPDATE_CHANNEL_KEY)
        .map_err(|_| refuse("release channel is unavailable"))?;
    if update_security::normalize_channel(channel) != candidate.channel {
        return Err(refuse("the release channel changed after confirmation"));
    }
    let update = state
        .update
        .try_lock()
        .map_err(|_| refuse("the update service is changing; retry installation"))?;
    if !update.owns_flight(UpdateFlight::Install, owner)
        || update.candidate.as_ref() != Some(candidate)
        || !update.has_published_artifact()
    {
        return Err(refuse(
            "the confirmed artifact was superseded before installation",
        ));
    }
    Ok(())
}

/// Error code for a Host admission release that was deliberately **not**
/// attempted because the one-way update admission state refuses it.
///
/// Distinct from a transport failure *and* from
/// `update_admission_unverifiable` (the service lock could not be read): nothing
/// was sent, and nothing was owed any more — the process had already committed to
/// shutting the Host down, and an `unlock` would have reopened it to new work.
/// [`HostAdmission`] maps this code to "nothing to release" instead of reporting a
/// failure; an unverifiable state stays a reported failure, because claiming a
/// clean rollback there would hide a Host that is still admission-locked.
const ADMISSION_RELEASE_REFUSED: &str = "update_admission_release_refused";

/// Whether an admission release was refused by the one-way shutdown state rather
/// than failing on the wire.
fn is_release_refusal(error: &DshError) -> bool {
    matches!(error, DshError::Other { code, .. } if code == ADMISSION_RELEASE_REFUSED)
}

/// The one `unlock` exchange a [`HostAdmission`] guard may deliver.
///
/// Boxed so the guard is not generic over the supervisor: this module is
/// compiled against two supervisor types (the app's
/// `dsh_runtime::supervisor::Supervisor` and the headless probe's recorder), and
/// the exchange is the only place that difference appears.
type HostRelease =
    std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, DshError>> + Send + 'static>>;

/// The pre-teardown half of a [`HostAdmission`] guard.
///
/// The verdict that commits a teardown runs inside the supervisor's lifecycle
/// transaction (`stop_if`), which is the only place that can disarm the guard
/// atomically with that verdict. That closure must stay `Fn + Send + Sync`, so it
/// cannot borrow the guard: it holds this shared handle instead.
#[derive(Clone)]
struct HostAdmissionHandoff(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl HostAdmissionHandoff {
    /// Commit to the teardown this admission `lock` authorized.
    ///
    /// After this returns, dropping the guard will **not** send `unlock`: the
    /// Lock belongs to a Host that is being stopped for the installer, and an
    /// `unlock` delivered while it drains could reopen admission and let a new
    /// request start work the installer is about to kill.
    fn disarm(&self) {
        self.0.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// A Host task-admission `lock` this install episode may have applied.
///
/// `update-tasks lock` refuses new API requests and drains admitted ones, and
/// only an explicit `unlock` clears it — the Host protocol has no lease id, so
/// nothing expires it. A panic between the two would therefore strand admission:
/// every later check short-circuits, every download is refused, and the Host
/// keeps refusing new work until it restarts. This guard closes that hole:
///
/// - **Armed before the request is sent.** A `lock` that times out — or unwinds —
///   may already have been applied by the Host, which is exactly why the error
///   path sends `unlock` anyway. The guard's window starts at the request, not at
///   its answer.
/// - **Serialized by the install gate.** The gate travels with the guard and, when
///   the release is delegated, with that delegated exchange. A newer install that
///   waited for admission therefore cannot `lock` before this `unlock` is
///   delivered or abandoned, so a stale episode can never answer a newer Lock.
///   The Host-side generation is not used here because the protocol does not
///   carry one: the gate, not the recorded `owner`, is what serializes.
/// - **Disarmed at handoff.** Once the final admission verdict authorizes
///   teardown, the Host is being stopped for the installer and is therefore not
///   reopened.
/// - **Serialized against the shutdown commitment by the runtime's own slot
///   lock.** The exchange is sent through `Supervisor::update_tasks_if`, whose
///   admission closure runs under that slot and re-checks the one-way
///   `UpdateService::admission_is_open`. The shutdown path closes admission from a
///   closure that runs under the same lock, so the request is either delivered
///   before that commit — the commit waits for the slot — or refused after it,
///   and never sent once the Host is being stopped. Lock order is slot → service
///   (`try_lock`), the same order `stop_if`'s admission closure already uses, so
///   there is no inversion, and no state lock is ever held across the exchange.
/// - **Counted for its whole life.** The guard raises the in-flight accounting
///   when it is armed — before the `lock` request, so the counter can never read
///   zero while a Host admission may be owed — and releases it only when the
///   exchange has settled, including the delegated one. See [`ActiveOperation`].
/// - **Bounded and retained.** A destructor cannot await: the exchange is handed
///   to a retained task ([`HOST_ADMISSION_UNLOCK_DEADLINE`]) whose completion is
///   logged, never assumed. Dropping the guard never blocks.
struct HostAdmission {
    /// The one `unlock` this guard may deliver, taken exactly once.
    exchange: Option<HostRelease>,
    /// The install gate, held from admission until this guard is dropped or a
    /// delegated release finishes.
    gate: Option<tokio::sync::OwnedMutexGuard<()>>,
    /// `false` once the Lock is no longer this guard's to release.
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
    /// The episode the Lock belongs to. Diagnostics only; see the type docs.
    owner: UpdateOperation,
    /// The in-flight accounting this admission owes from the moment the request
    /// is sent until the exchange has settled.
    ///
    /// Raised at **arm** time, before the request, and moved into the delegated
    /// task by `Drop` (`Option` so the destructor can take it): it is never
    /// registered asynchronously after the operation that owed it has settled,
    /// which is exactly the window a shutdown barrier could otherwise read as
    /// quiescent.
    active: Option<ActiveOperation>,
}

impl HostAdmission {
    /// Arm the guard **before** the `lock` request is sent.
    fn arm<F>(owner: UpdateOperation, gate: tokio::sync::OwnedMutexGuard<()>, exchange: F) -> Self
    where
        F: std::future::Future<Output = Result<bool, DshError>> + Send + 'static,
    {
        Self {
            exchange: Some(Box::pin(exchange)),
            gate: Some(gate),
            armed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true)),
            owner,
            active: Some(ActiveOperation::begin()),
        }
    }

    /// The handle the final-admission verdict uses to disarm this guard.
    fn handoff(&self) -> HostAdmissionHandoff {
        HostAdmissionHandoff(self.armed.clone())
    }

    /// Deliver the `unlock` on this task and report whether one was sent.
    ///
    /// Used by every path that rolls an admission back before teardown, so the
    /// exchange happens exactly once: taking `self` means no later drop can send
    /// a second one. `Ok(false)` means the guard was already disarmed by the
    /// handoff (or by an earlier release), so there was nothing to release.
    async fn release(mut self) -> Result<bool, DshError> {
        // Single-winner with `Drop`: whichever side flips the flag first owns the
        // one exchange. A release that runs after the handoff disarmed the guard
        // therefore has nothing to release — taking the exchange anyway would
        // reopen a Host the handoff has already committed to stopping.
        if !self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            return Ok(false);
        }
        let Some(exchange) = self.exchange.take() else {
            return Ok(false);
        };
        // The flag is already `false` here, so a cancelled release can never
        // deliver a second, stale `unlock` for an admission a newer install may
        // already own. The release runs on the retained supervision task (nothing
        // aborts it), which is why the exchange is not a state that can be
        // abandoned halfway in practice.
        //
        // `self` — and with it the install gate — stays alive across the
        // exchange, so a newer install cannot `lock` before this `unlock` is
        // delivered.
        exchange.await
    }
}

impl Drop for HostAdmission {
    fn drop(&mut self) {
        // Single-winner with `release`: the handoff handle is the only other
        // writer and only ever commits `false` on this operation's own task
        // before either of these runs, so there is no third writer to race.
        if !self.armed.swap(false, std::sync::atomic::Ordering::SeqCst) {
            // Handoff-authorized teardown, or already released: the exchange and
            // the gate are simply dropped here.
            return;
        }
        let Some(exchange) = self.exchange.take() else {
            return;
        };
        let gate = self.gate.take();
        let owner = self.owner;
        // The in-flight accounting was raised at arm time, before the request was
        // ever sent; it travels with the delegated release so a shutdown barrier
        // cannot read quiescence while this `unlock` is still owed. Nothing else
        // accounts for it: the release outlives the operation that owed it.
        let active = self.active.take();
        // A destructor cannot await, and it must not block the task that is
        // unwinding. The exchange is handed to a retained task — dropping the
        // `JoinHandle` detaches rather than cancels — and the *install* gate
        // travels with it, so a newer install cannot `lock` before this `unlock`
        // is delivered or abandoned. Completion is observed by that task and
        // logged; nothing here claims the Host actually cleared its lock.
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn(async move {
                    let _active = active;
                    let _gate = gate;
                    // Probe-only: park the delegated release so a test can observe
                    // the shutdown barrier waiting for it, and that a release which
                    // starts after admission closed sends nothing. Compiled out of
                    // shipped builds.
                    #[cfg(updater_probe)]
                    admission_release_gate::wait().await;
                    match exchange.await {
                        // "Finished", not "unlocked": the exchange itself decides
                        // whether an `unlock` was sent (it logs a suppression at
                        // debug when the one-way admission state refuses it), and
                        // nothing here should claim more than that.
                        Ok(active) => tracing::info!(
                            ?owner,
                            active,
                            "host task admission release finished after an abandoned install"
                        ),
                        Err(error) => tracing::warn!(
                            ?owner,
                            %error,
                            "host task admission unlock failed after an abandoned install; the Host may still refuse new work"
                        ),
                    }
                });
            }
            Err(_) => tracing::error!(
                ?owner,
                "host task admission could not be unlocked after an abandoned install: no async runtime is available"
            ),
        }
    }
}

/// Refusal before teardown rolls back Host admission without stopping tasks.
///
/// The guard is consumed, so the `unlock` is delivered exactly once: the
/// destructor cannot send a second one for the same admission.
async fn rollback_rejected_install(
    app: &DesktopApp,
    candidate: &UpdateCandidate,
    owner: UpdateOperation,
    admission: HostAdmission,
) -> Result<(), DshError> {
    debug_assert_eq!(
        admission.owner, owner,
        "a rollback must belong to the episode that armed its admission guard"
    );
    let rollback = admission.release().await;
    let failure = rollback
        .as_ref()
        .err()
        .map(|error| format!("installation refused; Host admission unlock failed: {error}"));
    with_state(app, |update| {
        if update.owns_flight(UpdateFlight::Install, owner)
            && update.candidate.as_ref() == Some(candidate)
        {
            update.flight = None;
            if let Some(message) = failure.as_deref() {
                mark_failure(&mut update.state, DesktopUpdateOperation::Install, message);
            } else {
                update.state.phase = DesktopUpdatePhase::Ready;
            }
        }
    })
    .await;
    publish(app, &current(app).await);
    // A failed unlock is not consent to kill live agents. Keep the backend and
    // verified artifact; report the rollback failure instead of restarting it.
    rollback.map(|_| ()).map_err(|error| {
        DshError::other(
            "update_admission_rollback",
            format!("installation refused; Host admission unlock failed: {error}"),
        )
    })
}

/// Installation admission and handoff.
///
/// Every disruptive step happens only after integrity and provenance have been
/// verified *and* the confirmed version still matches the admitted candidate.
async fn install(app: &DesktopApp, confirmed_version: Option<String>) -> Result<(), DshError> {
    let app = app.clone();
    let outcome = admitted(
        &app,
        move |update| {
            if !update.admission_is_open() {
                return Admission::Closed;
            }
            // Invalidation may revoke the presentation while Lock is still
            // active. Take the install gate *before* claiming, so an old
            // operation whose Unlock is still pending can never release a newer
            // install's Lock, and never after the flight is published.
            let gate = match update.install_gate.clone().try_lock_owned() {
                Ok(gate) => gate,
                Err(_) => {
                    return Admission::Refused(DshError::other(
                        "update_busy",
                        "another installer admission is still in progress",
                    ))
                }
            };
            if update.flight.is_some() {
                // A busy service is not a failure of this operation: the other
                // flight owns the presentation, so it is left untouched.
                return Admission::Refused(DshError::other(
                    "update_busy",
                    "another update operation is already in progress",
                ));
            }
            if let Some(error) = install_refusal(update, confirmed_version.as_deref()) {
                mark_failure(
                    &mut update.state,
                    DesktopUpdateOperation::Install,
                    &error.to_string(),
                );
                return Admission::Refused(error);
            }
            // Capture identity under the same lock as the claim: a channel
            // change between awaits must not turn a missing candidate into a
            // panic or substitute a different artifact.
            let candidate = update
                .candidate
                .as_ref()
                .expect("a refusal was returned when no candidate is ready")
                .clone();
            let owner = match update.claim_flight(UpdateFlight::Install) {
                Ok(owner) => owner,
                Err(exhausted) => {
                    let error = DshError::other("update_identity_exhausted", exhausted.to_string());
                    mark_failure(
                        &mut update.state,
                        DesktopUpdateOperation::Install,
                        &error.to_string(),
                    );
                    return Admission::Refused(error);
                }
            };
            Admission::Admitted {
                claim: FlightClaim {
                    flight: UpdateFlight::Install,
                    owner,
                },
                context: InstallAdmission {
                    candidate,
                    _gate: gate,
                },
            }
        },
        |app, claim, context| async move { install_owned(&app, claim, context).await },
    )
    .await?;
    match outcome {
        AdmittedRun::Ran(()) => Ok(()),
        AdmittedRun::Joined(_) => Err(DshError::other(
            "update_busy",
            "another update operation is already in progress",
        )),
        // Admission is closed for shutdown: nothing may touch the Host.
        AdmittedRun::Closed => Err(DshError::other(
            "update_shutting_down",
            "the updater is shutting down; the installation was not admitted",
        )),
    }
}

#[cfg(any(windows, test))]
fn windows_update_installer_arguments() -> [&'static str; 3] {
    ["/S", "/UPDATE", "/R"]
}

/// An admitted install's captured identity and its held install gate.
struct InstallAdmission {
    candidate: UpdateCandidate,
    /// Held from admission until the Host admission is settled: through
    /// `update-tasks` Lock/Unlock, and — once the operation has locked the Host —
    /// by the [`HostAdmission`] guard that owns those two exchanges. Serialization
    /// matters even when invalidation revokes presentation ownership, because the
    /// Host protocol has no per-installer lease id.
    _gate: tokio::sync::OwnedMutexGuard<()>,
}

async fn install_owned(
    app: &DesktopApp,
    claim: FlightClaim,
    admission: InstallAdmission,
) -> Result<(), DshError> {
    let InstallAdmission { candidate, _gate } = admission;
    let owner = claim.owner;
    let state = app.state::<std::sync::Arc<AppState>>();

    // Trust is rechecked against the bytes on disk before the Host is stopped: a
    // file replaced after publication is refused here.
    //
    // The verdict is computed and the guard released before anything is
    // reported, for the same reason as above: `invalidate_candidate` and
    // `with_state` both take the service lock.
    let artifact: Result<(PathBuf, std::fs::File), String> = {
        let path = candidate.artifact_path.clone().expect("admitted artifact");
        let captured = candidate.clone();
        tokio::task::spawn_blocking(move || verified_artifact_for_launch(&path, &captured))
            .await
            .unwrap_or_else(|error| Err(format!("artifact verification worker failed: {error}")))
    };
    // On Windows this retained handle denies writes and replacement through
    // consent, final admission, Host teardown, and installer launch.
    let (artifact, _artifact_lease) = match artifact {
        Ok(path) => path,
        Err(message) => {
            with_state(app, |update| {
                if update.owns_flight(UpdateFlight::Install, owner)
                    && update.candidate.as_ref() == Some(&candidate)
                {
                    // Bytes that no longer match the signed digest are not a
                    // verified artifact: the path is retired instead of being
                    // left where a later admission could pick it up.
                    let retired = update
                        .candidate
                        .as_mut()
                        .and_then(|current| current.artifact_path.take());
                    if let Some(retired) = retired {
                        update.retire_artifact(retired);
                    }
                    let _ = update.invalidate_candidate();
                    update.flight = None;
                    mark_failure(&mut update.state, DesktopUpdateOperation::Install, &message);
                }
            })
            .await;
            publish(app, &current(app).await);
            return Err(DshError::other("update_artifact_untrusted", message));
        }
    };

    // Verification yielded to a worker. Refuse stale identity or lost policy
    // admission before touching Host task admission at all.
    if let Err(error) = install_execution_admission(&state, &candidate, owner) {
        with_state(app, |update| {
            if update.owns_flight(UpdateFlight::Install, owner)
                && update.candidate.as_ref() == Some(&candidate)
            {
                update.flight = None;
                update.state.phase = DesktopUpdatePhase::Ready;
            }
        })
        .await;
        publish(app, &current(app).await);
        return Err(error);
    }

    // Admission control (`update-tasks`): `lock` refuses new API requests and
    // drains admitted ones, then re-checks tasks. Unknown task state refuses
    // installation.
    //
    // The guard is armed **before** the request goes out: a `lock` that times out
    // or unwinds may still have been applied by the Host, so an abandoned install
    // owes an `unlock` for the request, not for its answer. From here until the
    // handoff commits (or the admission is rolled back) the guard owns the Lock —
    // and the install gate with it, so no newer episode can `lock` behind a
    // delegated `unlock`.
    let host_admission = HostAdmission::arm(owner, _gate, {
        let supervisor = state.supervisor.clone();
        // The release future must be `'static`, so it carries the shared service
        // handle rather than the borrowed `State`.
        let service: std::sync::Arc<AppState> = std::sync::Arc::clone(&state);
        async move {
            // The request goes out through `update_tasks_if`, whose admission
            // closure runs **under the supervisor's slot lock** and re-checks the
            // one-way `UpdateService::admission_is_open`. The shutdown path closes
            // admission from a closure that runs under that same lock, so the two
            // are serialized rather than raced: either this release is delivered
            // before that commit (the commit waits for the slot), or it observes
            // the closed service and sends nothing. Nothing here can reopen a Host
            // the process is stopping. Lock order is slot → service (`try_lock`),
            // the same order `stop_if`'s admission closure already uses.
            let released = tokio::time::timeout(
                HOST_ADMISSION_UNLOCK_DEADLINE,
                supervisor.update_tasks_if(UpdateTasksAction::Unlock, || -> Result<(), DshError> {
                    // The one-way admission state, read under the service lock
                    // (`try_lock`: this closure must not await, and holding the
                    // service lock across the exchange would stall IPC reads).
                    let admission = service.update.try_lock().map_err(|_| {
                        DshError::other(
                            "update_admission_unverifiable",
                            "the update service is changing, so the one-way admission state could not be read and the release was not attempted",
                        )
                    })?;
                    if admission.admission_is_open() {
                        Ok(())
                    } else {
                        Err(DshError::other(
                            ADMISSION_RELEASE_REFUSED,
                            "update admission is closed for shutdown; the admission release was not attempted",
                        ))
                    }
                }),
            )
            .await;
            match released {
                Ok(Ok(result)) => Ok(result),
                Ok(Err(error)) if is_release_refusal(&error) => {
                    tracing::debug!(
                        ?owner,
                        %error,
                        "host task admission release suppressed; no unlock was sent"
                    );
                    Ok(false)
                }
                Ok(Err(error)) => Err(error),
                Err(_) => Err(DshError::other(
                    "update_tasks_unlock_timeout",
                    "the Host did not answer the task admission unlock in time",
                )),
            }
        }
    });
    let handoff = host_admission.handoff();
    let active = match state.supervisor.update_tasks(UpdateTasksAction::Lock).await {
        Ok(active) => active,
        Err(error) => {
            // A timed-out lock request may still be draining in the Host. Send
            // unlock even after timeout; the adapter generation invalidates its
            // stale lock completion, and a late request finish cannot relock.
            let rollback = host_admission.release().await;
            let detail = match rollback {
                Err(rollback) => {
                    format!("{error}; admission unlock failed; Host kept running: {rollback}")
                }
                Ok(_) => error.to_string(),
            };
            let failure = DshError::other("update_tasks_unavailable", "task status is unavailable");
            with_state(app, |update| {
                if update.owns_flight(UpdateFlight::Install, owner)
                    && update.candidate.as_ref() == Some(&candidate)
                {
                    update.flight = None;
                    mark_failure(&mut update.state, DesktopUpdateOperation::Install, &detail);
                }
            })
            .await;
            publish(app, &current(app).await);
            return Err(failure);
        }
    };
    if active {
        let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
        let stop = messages.update_stop_tasks.to_string();
        let cancel = messages.cancel.to_string();
        // This prompt is part of an already-admitted install (the Install flight
        // is held, so no second install prompt can be open) and needs no
        // reservation of its own. A dropped callback is `None`, which is **not**
        // consent to stop live tasks.
        let answer = crate::native_dialog::answer(|reply| {
            app.dialog()
                .message(format!(
                    "{}\n\n{}",
                    messages.update_active_tasks, messages.update_active_tasks_detail
                ))
                .title(messages.update_title)
                .buttons(MessageDialogButtons::OkCancelCustom(stop, cancel))
                .show(reply);
        })
        .await;
        let proceed = answer == Some(true);
        if !proceed {
            // Declining consent never authorizes a restart/kill, even if Unlock
            // fails. Keep the artifact and report rollback failure visibly.
            rollback_rejected_install(app, &candidate, owner, host_admission).await?;
            return Ok(());
        }
    }
    // The handoff refuses after a forced kill, non-zero exit, or missing
    // `shutdown-complete` (upstream `requireGraceful`).
    let owned = with_state(app, |update| {
        if !update.owns_flight(UpdateFlight::Install, owner)
            || update.candidate.as_ref() != Some(&candidate)
        {
            return false;
        }
        update.state.phase = DesktopUpdatePhase::Installing;
        true
    })
    .await;
    if !owned {
        rollback_rejected_install(app, &candidate, owner, host_admission).await?;
        return Err(DshError::other(
            "update_install_admission",
            "the install episode was superseded",
        ));
    }
    publish(app, &current(app).await);
    if let Err(error) = state
        .supervisor
        .stop_if(true, || {
            let verdict = install_execution_admission(&state, &candidate, owner);
            if verdict.is_ok() {
                // The verdict that authorizes teardown has now committed inside
                // the supervisor's lifecycle transaction. From here the Lock
                // belongs to a Host that is being stopped for the installer:
                // disarming *before* the stop is attempted is what keeps an
                // unwind in the teardown (or the release that follows it) from
                // reopening admission on a Host the installer is about to kill.
                handoff.disarm();
            }
            verdict
        })
        .await
    {
        if matches!(&error, DshError::Other { code, .. } if code == "update_install_admission") {
            // The verdict refused *before* any teardown: the Host is still
            // running and admission-locked, so the guard still owes its unlock.
            rollback_rejected_install(app, &candidate, owner, host_admission).await?;
            return Err(error);
        }
        // The stop itself failed after the handoff committed, so the guard is
        // already disarmed and this Host is never reopened. A torn-down Host has
        // nothing to unlock; an *unresolved* teardown deliberately keeps its
        // containment as the supervisor's ownership record (`Stopping`, link
        // revoked) and must stay fail-closed here — reattaching control just to
        // deliver an `unlock` would claim a serialization this layer no longer
        // has. The next stop retries against the retained tree.
        restore_host_or_exit(app, &state).await;
        with_state(app, |update| {
            if !update.owns_flight(UpdateFlight::Install, owner) {
                return;
            }
            update.state.phase = DesktopUpdatePhase::Error;
            update.state.failed_operation = Some(DesktopUpdateOperation::Install);
            update.state.preparation_failure =
                Some(DesktopUpdatePreparationFailureKind::StopFailed);
            update.state.message = Some(format!(
                "{error}; Host restored; installation was not started"
            ));
            update.flight = None;
        })
        .await;
        publish(app, &current(app).await);
        return Err(error);
    }

    // The artifact path came from the immutable candidate, never from a mutable
    // lookup, and the bytes were verified immediately before this point.
    // Launch the installer and leave the exit to the update reason.
    #[cfg(windows)]
    let launch_result = {
        let mut command = std::process::Command::new(&artifact);
        command.args(windows_update_installer_arguments()).spawn()
    };
    #[cfg(not(windows))]
    let launch_result = std::process::Command::new(&artifact).spawn();
    if let Err(io_error) = launch_result {
        let error = DshError::io(
            "launch installer",
            Some(artifact.display().to_string()),
            &io_error,
        );
        restore_host_or_exit(app, &state).await;
        fail_owned(
            app,
            UpdateFlight::Install,
            owner,
            DesktopUpdateOperation::Install,
            &error.to_string(),
            false,
        )
        .await;
        return Err(error);
    }
    // The installer is launched and the exit is left to the update reason.
    //
    // `host_admission` is still alive but already disarmed by the handoff above,
    // so it drops here without reopening anything: the Host it locked was stopped
    // for this installer, and the run ends in a permanent shutdown.
    //
    // There is deliberately **no** ambient process-global "skip" armed here. A
    // sticky skip is process state that outlives the operation that set it, so a
    // later, unrelated quit could silently skip its own shutdown work. The quit
    // reason (`QuitReason::Update`) is the whole handoff contract: `confirm_exit`
    // returns `Ok` only on a successful shutdown and diverges otherwise.
    crate::quit_flow::confirm_exit(app, dsh_core::protocol::QuitReason::Update).await
}

/// The admitted install operation, without an Install-and-Restart prompt.
///
/// The headless probe's seam only (`cfg(updater_probe)`): it exercises the
/// admission, verification, task-lock, and handoff paths directly, so a test can
/// assert what installation refuses *before* any dialog. A shipped build has no
/// way to install without the user's confirmation.
#[cfg(updater_probe)]
pub async fn install_for_test(
    app: &DesktopApp,
    confirmed_version: Option<String>,
) -> Result<(), DshError> {
    install(app, confirmed_version).await
}

/// Whether the confirmed policy verdict requires an update in this process.
///
/// A blocking verdict with a newer release, **or** a blocking verdict with no
/// installable release at all, is mandatory: the requirement does not depend on
/// a candidate being known. A failed or in-flight policy attempt never lifts a
/// requirement it did not answer.
///
/// Probe/test surface: the shell's own paths read the same verdict through
/// `current_enforcement`, and a test needs a way to ask the question without
/// opening a prompt. The headless probe's seam only (`cfg(updater_probe)`).
#[cfg(updater_probe)]
pub async fn is_update_mandatory(app: &DesktopApp) -> bool {
    let state = app.state::<std::sync::Arc<AppState>>();
    let update = state.update.lock().await;
    current_enforcement(&state, &update).is_blocking()
}

/// Resolve aliases before opening/hashing and retain that resolved launch path.
/// Launching the original path would let a rebound directory junction select
/// different bytes despite a lease on the verified file. This does not qualify
/// descriptor-only leases against file replacement on non-Windows platforms.
fn verified_artifact_for_launch(
    path: &std::path::Path,
    candidate: &UpdateCandidate,
) -> Result<(PathBuf, std::fs::File), String> {
    let resolved = std::fs::canonicalize(path)
        .map_err(|error| format!("the update file path could not be resolved: {error}"))?;
    let lease = open_verified_artifact(&resolved, candidate)?;
    Ok((resolved, lease))
}

/// Hash the artifact with bounded memory against the signature-authenticated
/// candidate digest. The manifest signature was checked during admission.
/// Windows sharing excludes writes and deletion until the returned lease drops;
/// other platforms only retain a descriptor and are not replacement-qualified.
fn open_verified_artifact(
    path: &std::path::Path,
    candidate: &UpdateCandidate,
) -> Result<std::fs::File, String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(1); // FILE_SHARE_READ, never WRITE or DELETE.
    }
    let mut file = options.open(path).map_err(|error| {
        format!(
            "the verified update file at {} is no longer readable: {error}",
            path.display()
        )
    })?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| format!("artifact hash read failed: {error}"))?;
        if count == 0 {
            break;
        }
        hasher.update(&buffer[..count]);
    }
    let digest = format!("{:x}", hasher.finalize());
    if !digest.eq_ignore_ascii_case(&candidate.sha256) {
        return Err(
            "the update file changed after it was verified and was refused; retry the update"
                .to_string(),
        );
    }
    Ok(file)
}

#[cfg(test)]
fn verify_published_artifact(
    path: &std::path::Path,
    candidate: &UpdateCandidate,
) -> Result<(), String> {
    open_verified_artifact(path, candidate).map(|_| ())
}

// ---------------------------------------------------------------------------
// Channel invalidation entry point
// ---------------------------------------------------------------------------

/// Invalidate the admitted candidate after a release-channel change.
///
/// Called by the settings path so a candidate admitted for one channel can
/// never be installed after the user switches to the other. Owned by this lane;
/// the lead wires it into `settings_set` (see the lane report).
///
/// The superseded artifact is retired (removed by the retained cleanup owner at
/// shutdown), and the schedule is asked for a check now: the newly selected
/// channel has no admitted candidate, and waiting for the armed deadline would
/// leave the section empty for up to a full interval.
pub async fn invalidate_for_channel_change(app: &DesktopApp) {
    with_state(app, |update| {
        let previous = update.candidate.clone();
        let _ = update.invalidate_candidate();
        update.checked = false;
        update.flight = None;
        update.state.phase = DesktopUpdatePhase::Idle;
        update.state.version = None;
        update.state.percent = None;
        update.state.failed_operation = None;
        update.state.preparation_failure = None;
        update.state.message = None;
        update.state.technical_details = None;
        if let Some(path) = superseded_artifact(previous.as_ref(), None) {
            update.retire_artifact(path);
        }
    })
    .await;
    publish(app, &current(app).await);
    request_check(CheckTrigger::ChannelChange);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update_security::{load_trust_config, ChannelFeed};

    #[test]
    fn windows_update_installer_arguments_match_the_tauri_contract() {
        assert_eq!(
            windows_update_installer_arguments(),
            ["/S", "/UPDATE", "/R"]
        );
    }

    fn trust_outcome_loaded() -> TrustConfigOutcome {
        TrustConfigOutcome::Loaded(ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: None,
            stable: Some(ChannelFeed {
                feed_url: "https://updates.example.test/stable.json".into(),
                allowed_origins: vec!["updates.example.test".into()],
                trusted_keys: vec!["11".repeat(32)],
            }),
            beta: None,
        })
    }

    #[test]
    fn invalid_trust_candidate_precedes_a_later_valid_candidate() {
        let invalid = TrustConfigOutcome::Invalid("malformed earlier candidate".into());
        assert_eq!(
            resolve_trust_candidates([invalid.clone(), trust_outcome_loaded()]),
            invalid
        );
    }

    #[test]
    fn invalid_trust_candidate_also_takes_precedence_after_a_valid_candidate() {
        let invalid = TrustConfigOutcome::Invalid("malformed later candidate".into());
        assert_eq!(
            resolve_trust_candidates([trust_outcome_loaded(), invalid.clone()]),
            invalid
        );
    }

    #[test]
    fn absent_trust_candidates_do_not_hide_a_later_valid_candidate() {
        let loaded = trust_outcome_loaded();
        assert_eq!(
            resolve_trust_candidates([TrustConfigOutcome::Absent, loaded.clone()]),
            loaded
        );
    }

    #[test]
    fn all_absent_trust_candidates_remain_absent() {
        assert_eq!(
            resolve_trust_candidates([TrustConfigOutcome::Absent, TrustConfigOutcome::Absent]),
            TrustConfigOutcome::Absent
        );
    }

    #[test]
    fn unreadable_trust_candidate_disables_a_later_valid_candidate() {
        let unreadable =
            TrustConfigOutcome::Invalid("release trust configuration could not be read".into());
        assert_eq!(
            resolve_trust_candidates([unreadable.clone(), trust_outcome_loaded()]),
            unreadable
        );
    }

    #[test]
    fn real_filesystem_trust_candidates_fail_closed_in_either_order() {
        let temporary = std::fs::canonicalize(std::env::temp_dir()).unwrap();
        let folder = format!("dsh-trust-candidate-order-{}", uuid::Uuid::new_v4());
        let root = temporary.join(&folder);
        std::fs::create_dir(&root).unwrap();
        let valid = root.join("valid.json");
        let malformed = root.join("malformed.json");
        let unreadable_as_config = root.join("directory.json");
        let absent = root.join("absent.json");
        let loaded = trust_outcome_loaded();
        let TrustConfigOutcome::Loaded(config) = &loaded else {
            unreachable!("fixture is loaded");
        };
        std::fs::write(&valid, serde_json::to_vec(config).unwrap()).unwrap();
        assert_eq!(
            load_trust_config(&valid),
            loaded,
            "the later candidate must really be valid"
        );
        std::fs::write(&malformed, "not JSON").unwrap();
        std::fs::create_dir(&unreadable_as_config).unwrap();
        for bad in [&malformed, &unreadable_as_config] {
            for candidates in [[bad, &valid], [&valid, bad]] {
                assert!(matches!(
                    resolve_trust_candidates(
                        candidates.into_iter().map(|path| load_trust_config(path))
                    ),
                    TrustConfigOutcome::Invalid(_)
                ));
            }
        }
        assert!(matches!(
            resolve_trust_candidates(
                [&absent, &valid]
                    .into_iter()
                    .map(|path| load_trust_config(path))
            ),
            TrustConfigOutcome::Loaded(_)
        ));
        assert_eq!(load_trust_config(&absent), TrustConfigOutcome::Absent);
        // Resolve and verify the exact owned temporary root before deletion.
        let resolved = std::fs::canonicalize(&root).unwrap();
        assert_eq!(resolved.parent(), Some(temporary.as_path()));
        assert_eq!(
            resolved.file_name().and_then(|name| name.to_str()),
            Some(folder.as_str())
        );
        std::fs::remove_dir_all(resolved).unwrap();
    }

    /// The independently signed fixture set (`tests/fixtures/update-signatures.json`).
    ///
    /// The admission tests need a signature that genuinely verifies, because
    /// provenance is checked *before* the artifact host: a dummy signature would
    /// make a host-rule test pass for the wrong reason.
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignatureCase {
        label: String,
        channel: String,
        trusted_key: String,
        version: String,
        message_channel: String,
        message_sha256: String,
        signature: String,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct SignatureFixtures {
        payload_sha256: String,
        cases: Vec<SignatureCase>,
    }

    fn fixtures() -> SignatureFixtures {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("update-signatures.json");
        let text = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        serde_json::from_str(&text).expect("signature fixtures parse")
    }

    /// The `stable` fixture whose signature covers exactly its own tuple.
    fn stable_signed_case() -> SignatureCase {
        fixtures()
            .cases
            .into_iter()
            .find(|case| case.channel == "stable" && case.label == "valid")
            .expect("a valid stable fixture")
    }

    /// The fixture itself is self-consistent: its recorded payload digest is the
    /// SHA-256 of the payload, and every case signs a value the case declares.
    ///
    /// This is what makes the fixture trustworthy as an oracle for admission
    /// tests: if the recorded digest were not the real digest, a manifest built
    /// from it would fail verification for a reason unrelated to the rule under
    /// test. The `other-channel` case deliberately signs the *opposite* channel
    /// — that is the binding it exists to demonstrate — so the channel assertion
    /// is scoped to the cases that are meant to sign their own.
    #[test]
    fn the_signature_fixtures_are_self_consistent() {
        let fixtures = fixtures();
        assert_eq!(
            fixtures.payload_sha256,
            update_security::sha256_hex(b"dsh-desktop-update-fixture-payload"),
            "the recorded payload digest must be the real digest"
        );
        assert!(!fixtures.cases.is_empty());
        assert!(
            fixtures
                .cases
                .iter()
                .any(|case| case.label == "other-channel"),
            "the fixture set must pin the cross-channel binding"
        );
        for case in &fixtures.cases {
            match case.label.as_str() {
                // These cases exist precisely to sign *something else*: the
                // opposite channel, or a different artifact digest. Their value
                // is that they are refused when presented with the real release.
                "other-channel" => assert_ne!(
                    case.channel, case.message_channel,
                    "the cross-channel case must sign the other channel"
                ),
                "other-digest" => assert_ne!(
                    case.message_sha256, fixtures.payload_sha256,
                    "the cross-digest case must sign a different digest"
                ),
                // Every other case signs a value it declares, over the recorded
                // payload, so it isolates the field its label names.
                _ => {
                    assert_eq!(
                        case.channel, case.message_channel,
                        "`{}` must sign its own channel",
                        case.label
                    );
                    assert_eq!(
                        case.message_sha256, fixtures.payload_sha256,
                        "`{}` signs the recorded payload",
                        case.label
                    );
                }
            }
            assert!(
                !case.signature.is_empty() && case.signature.len() == 128,
                "{}",
                case.label
            );
            assert_eq!(case.trusted_key.len(), 64, "{}", case.label);
        }
    }

    fn key() -> String {
        // The fixture set's own trusted key, so a manifest signed by the
        // independent signer verifies against the packaged trust anchor.
        stable_signed_case().trusted_key
    }

    fn selection_for(channel: &'static str) -> ChannelSelection {
        let feed = ChannelFeed {
            feed_url: format!("https://updates.example.com/{channel}.json"),
            allowed_origins: vec!["updates.example.com".to_string()],
            trusted_keys: vec![key()],
        };
        let config = ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: None,
            stable: Some(feed.clone()),
            beta: Some(feed),
        };
        let policy = ReleasePolicy::select(&config, channel).expect("policy builds");
        ChannelSelection { channel, policy }
    }

    fn manifest(version: &str, sha: &str, signature: Option<&str>) -> UpdateManifest {
        UpdateManifest {
            version: version.to_string(),
            url: "https://updates.example.com/Setup.exe".to_string(),
            sha256: sha.to_string(),
            signature: signature.map(str::to_string),
        }
    }

    #[test]
    fn an_unsigned_manifest_is_refused_before_the_artifact_is_fetched() {
        let selection = selection_for("stable");
        let error = admit_manifest(&selection, manifest("0.1.8", &"a".repeat(64), None))
            .expect_err("unsigned manifests are refused");
        assert!(error.contains("not signed"), "{error}");
    }

    #[test]
    fn a_manifest_without_a_digest_is_refused() {
        let selection = selection_for("stable");
        let error = admit_manifest(&selection, manifest("0.1.8", "  ", Some(&"b".repeat(128))))
            .expect_err("a digest is required");
        assert!(error.contains("no SHA-256 digest"), "{error}");
    }

    #[test]
    fn an_invalid_version_is_refused() {
        let selection = selection_for("stable");
        let error = admit_manifest(
            &selection,
            manifest("not-a-version", &"a".repeat(64), Some(&"b".repeat(128))),
        )
        .expect_err("SemVer is required");
        assert!(error.contains("not valid SemVer"), "{error}");
    }

    #[test]
    fn an_artifact_on_an_unlisted_host_is_refused() {
        // Provenance is verified *before* the artifact host, so a dummy
        // signature would make this test fail (or pass) for the wrong reason:
        // it would report a signature failure and never reach the host rule.
        // The fixture signature genuinely verifies, which isolates the host
        // check as the reason for refusal.
        let case = stable_signed_case();
        let selection = selection_for("stable");
        let manifest = |url: &str| UpdateManifest {
            version: case.version.clone(),
            url: url.to_string(),
            sha256: case.message_sha256.clone(),
            signature: Some(case.signature.clone()),
        };
        // The same signed release on an allow-listed host is admitted, which is
        // what makes the refusal below attributable to the host alone.
        assert!(
            admit_manifest(
                &selection,
                manifest("https://updates.example.com/Setup.exe")
            )
            .is_ok(),
            "the signed release on an allowed host must be admitted"
        );
        let error = admit_manifest(&selection, manifest("https://evil.test/Setup.exe"))
            .expect_err("host must be allowlisted");
        assert!(
            error.contains("refused"),
            "the host rule must be the reported reason, saw: {error}"
        );
    }

    #[test]
    fn a_manifest_signed_for_another_channel_is_refused() {
        // The signature covers the channel, so a beta-signed manifest cannot be
        // admitted on the stable channel.
        let beta = selection_for("beta");
        let stable = selection_for("stable");
        // Sign over the beta channel by construction: use the beta policy to
        // admit, then present the same manifest to stable.
        let manifest = manifest("0.1.8", &"a".repeat(64), Some(&"b".repeat(128)));
        assert!(admit_manifest(&beta, manifest.clone()).is_err());
        assert!(admit_manifest(&stable, manifest).is_err());
    }

    #[cfg(windows)]
    #[test]
    fn verified_artifact_lease_prevents_writes_and_replacement_until_launch() {
        let directory = tempfile::tempdir().unwrap();
        let cache = directory.path().join("cache");
        std::fs::create_dir(&cache).unwrap();
        let path = cache.join("pinned-installer.exe");
        let replacement = directory.path().join("replacement.exe");
        let bytes = vec![91u8; 3 * 64 * 1024 + 19];
        std::fs::write(&path, &bytes).unwrap();
        std::fs::write(&replacement, b"untrusted replacement").unwrap();
        let candidate = UpdateCandidate {
            version: "0.1.8".into(),
            channel: "stable".into(),
            url: "https://fixture.invalid/Setup.exe".into(),
            sha256: update_security::sha256_hex(&bytes),
            signature: "00".repeat(64),
            artifact_path: Some(path.clone()),
        };
        let lease = open_verified_artifact(&path, &candidate).unwrap();
        assert_eq!(
            std::fs::read(&path).unwrap(),
            bytes,
            "other readers remain allowed"
        );
        assert!(
            std::fs::write(&path, b"changed").is_err(),
            "verified bytes cannot change during consent"
        );
        assert!(
            std::fs::rename(&replacement, &path).is_err(),
            "verified path cannot be replaced"
        );
        assert!(
            std::fs::remove_file(&path).is_err(),
            "verified path cannot be deleted"
        );
        assert!(
            std::fs::rename(&cache, directory.path().join("moved-cache")).is_err(),
            "the containing cache cannot be relocated while verification is pinned"
        );
        drop(lease);
        std::fs::write(&path, b"changed after lease").unwrap();
        assert!(
            open_verified_artifact(&path, &candidate).is_err(),
            "changed bytes fail a new admission"
        );
    }

    #[cfg(windows)]
    #[test]
    fn verified_launch_path_survives_rebinding_the_original_directory_junction() {
        use std::os::windows::{fs::MetadataExt, process::CommandExt};
        let directory = tempfile::tempdir().unwrap();
        let original = directory.path().join("original");
        let replacement = directory.path().join("replacement");
        let alias = directory.path().join("alias");
        std::fs::create_dir(&original).unwrap();
        std::fs::create_dir(&replacement).unwrap();
        let bytes = b"trusted fixture bytes";
        std::fs::write(original.join("fixture.bin"), bytes).unwrap();
        std::fs::write(replacement.join("fixture.bin"), b"untrusted replacement").unwrap();
        let cmd = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        let make_junction = |target: &std::path::Path| {
            let status = std::process::Command::new(&cmd)
                .args(["/d", "/c", "mklink", "/J"])
                .arg(&alias)
                .arg(target)
                .creation_flags(0x08000000) // CREATE_NO_WINDOW
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(
                status.success(),
                "create isolated fixture junction: {status}"
            );
        };
        make_junction(&original);
        let path = alias.join("fixture.bin");
        let candidate = UpdateCandidate {
            version: "0.1.8".into(),
            channel: "stable".into(),
            url: "https://fixture.invalid/Setup.exe".into(),
            sha256: update_security::sha256_hex(bytes),
            signature: "00".repeat(64),
            artifact_path: Some(path.clone()),
        };
        let (launch_path, lease) = verified_artifact_for_launch(&path, &candidate).unwrap();
        // Verify the exact owned absolute entry is a reparse point before
        // removing only the junction itself, never its target or contents.
        assert!(alias.is_absolute());
        assert_eq!(alias.parent(), Some(directory.path()));
        assert_ne!(
            std::fs::symlink_metadata(&alias).unwrap().file_attributes() & 0x400,
            0
        );
        std::fs::remove_dir(&alias).expect("remove owned junction, not its target");
        make_junction(&replacement);
        assert_eq!(std::fs::read(&path).unwrap(), b"untrusted replacement");
        assert_eq!(std::fs::read(&launch_path).unwrap(), bytes);
        assert!(std::fs::write(&launch_path, b"changed").is_err());
        drop(lease);
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn verified_artifact_lease_allows_launch_of_a_trusted_fixture_executable() {
        // Launch only a copy of this test harness, with a filter matching no
        // tests. This is Windows process-loader evidence, NOT NSIS acceptance.
        let directory = tempfile::tempdir().unwrap();
        let source = std::env::current_exe().unwrap();
        let path = directory.path().join("trusted-launch-fixture.exe");
        std::fs::copy(&source, &path).unwrap();
        // MSVC emits this test harness's Common Controls activation manifest
        // beside the executable. Copy that trusted fixture dependency too;
        // without it the child fails before main with STATUS_ENTRYPOINT_NOT_FOUND.
        let source_manifest = source.with_extension("exe.manifest");
        if source_manifest.is_file() {
            std::fs::copy(source_manifest, path.with_extension("exe.manifest")).unwrap();
        }
        let candidate = UpdateCandidate {
            version: "0.1.8".into(),
            channel: "stable".into(),
            url: "https://fixture.invalid/Setup.exe".into(),
            sha256: update_security::sha256_hex(&std::fs::read(&source).unwrap()),
            signature: "00".repeat(64),
            artifact_path: Some(path.clone()),
        };
        let (launch_path, lease) = verified_artifact_for_launch(&path, &candidate).unwrap();
        let status = tokio::time::timeout(
            Duration::from_secs(10),
            tokio::process::Command::new(&launch_path)
                .args([
                    "--exact",
                    "__dsh_artifact_launch_fixture_no_matching_tests__",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .kill_on_drop(true)
                .status(),
        )
        .await
        .expect("fixture launch deadline")
        .expect("fixture process launch");
        assert!(
            status.success(),
            "the Windows loader must accept the read-only pinned executable: {status}"
        );
        assert!(std::fs::write(&path, b"changed").is_err());
        drop(lease);
    }

    #[test]
    fn published_artifact_verification_detects_a_swapped_file() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-artifact-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let path = directory.join("artifact.bin");
        std::fs::write(&path, b"the real artifact").expect("write artifact");
        let candidate = UpdateCandidate {
            version: "0.1.8".to_string(),
            channel: "stable".to_string(),
            url: "https://updates.example.com/Setup.exe".to_string(),
            sha256: update_security::sha256_hex(b"the real artifact"),
            signature: "00".repeat(64),
            artifact_path: Some(path.clone()),
        };
        assert!(verify_published_artifact(&path, &candidate).is_ok());
        // A file swapped after publication is refused.
        std::fs::write(&path, b"malicious bytes").expect("overwrite artifact");
        let error = verify_published_artifact(&path, &candidate).expect_err("swap is detected");
        assert!(error.contains("changed after it was verified"), "{error}");
        // A missing file is refused too.
        std::fs::remove_file(&path).expect("remove artifact");
        assert!(verify_published_artifact(&path, &candidate).is_err());
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn atomic_publication_never_leaves_a_partial_file() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-publish-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let final_path = directory.join("artifact.bin");

        // First publication creates the file.
        let first = directory.join(".artifact.part1");
        std::fs::write(&first, b"first").expect("write first");
        replace_file(&first, &final_path).expect("publish first");
        assert_eq!(std::fs::read(&final_path).unwrap(), b"first");
        assert!(!first.exists(), "the temporary file is consumed");

        // A replacement overwrites it entirely, leaving no partial content.
        let second = directory.join(".artifact.part2");
        std::fs::write(&second, b"second-and-longer").expect("write second");
        replace_file(&second, &final_path).expect("publish second");
        assert_eq!(std::fs::read(&final_path).unwrap(), b"second-and-longer");
        assert!(!second.exists());

        // A failed publication (missing source) leaves the previous file intact.
        let missing = directory.join(".artifact.missing");
        assert!(replace_file(&missing, &final_path).is_err());
        assert_eq!(
            std::fs::read(&final_path).unwrap(),
            b"second-and-longer",
            "a failed publication must not destroy the verified artifact"
        );
        std::fs::remove_dir_all(&directory).ok();
    }

    #[test]
    fn no_packaged_trust_configuration_disables_delivery() {
        // `resolve_policy` reads the filesystem, so the refusal is asserted
        // through the pure policy layer it delegates to.
        let config = ReleaseTrustConfig {
            config_version: 1,
            pinned_channel: None,
            stable: None,
            beta: None,
        };
        assert!(ReleasePolicy::select(&config, "stable").is_err());
    }

    // --- digest shape before signed metadata -------------------------------

    #[test]
    fn a_manifest_digest_that_is_not_a_sha256_is_refused_before_provenance() {
        let selection = selection_for("stable");
        // The digest is checked before the signature, so a malformed digest is
        // reported as a digest fault even with an unusable signature.
        for malformed in [
            "a".repeat(63),
            "a".repeat(65),
            "z".repeat(64),
            format!("{} ", "a".repeat(63)),
            format!("{}\n", "a".repeat(63)),
            "é".repeat(32),
        ] {
            let error = admit_manifest(
                &selection,
                manifest("0.1.8", &malformed, Some(&"b".repeat(128))),
            )
            .expect_err("a malformed digest must be refused");
            assert!(
                error.contains("64 ASCII hex"),
                "`{malformed}` must be refused on shape, saw: {error}"
            );
        }
        // The empty case keeps its own, more specific message.
        let error = admit_manifest(&selection, manifest("0.1.8", "  ", Some(&"b".repeat(128))))
            .expect_err("an absent digest is refused");
        assert!(error.contains("no SHA-256 digest"), "{error}");
    }

    // --- settlement supervision -------------------------------------------

    /// A recorder for the claims a settlement was asked to release.
    ///
    /// Each test builds its settle closure inline, so `supervise` sees a concrete
    /// closure type instead of a boxed trait object.
    fn settled_claims() -> std::sync::Arc<std::sync::Mutex<Vec<FlightClaim>>> {
        std::sync::Arc::new(std::sync::Mutex::new(Vec::new()))
    }

    fn claim() -> FlightClaim {
        FlightClaim {
            flight: UpdateFlight::Download,
            owner: UpdateOperation(7),
        }
    }

    /// One admitted operation that unwinds: a diverging body typed as the
    /// operation's result, so no unreachable tail statement is needed.
    async fn controlled_unwind() -> Result<u8, DshError> {
        panic!("controlled unwind");
    }

    #[tokio::test]
    async fn a_successful_operation_settles_its_claim_exactly_once() {
        let seen = settled_claims();
        let recording = seen.clone();
        let outcome = supervise(claim(), async { Ok::<u8, DshError>(4) }, move |claim| {
            let recording = recording.clone();
            async move {
                recording.lock().unwrap().push(claim);
            }
        })
        .await
        .expect("the operation succeeded");
        assert_eq!(outcome, 4);
        assert_eq!(*seen.lock().unwrap(), vec![claim()]);
    }

    #[tokio::test]
    async fn a_failed_operation_settles_its_claim_exactly_once() {
        let seen = settled_claims();
        let recording = seen.clone();
        let error = supervise(
            claim(),
            async { Err::<u8, DshError>(DshError::other("update_failed", "controlled failure")) },
            move |claim| {
                let recording = recording.clone();
                async move {
                    recording.lock().unwrap().push(claim);
                }
            },
        )
        .await
        .expect_err("the operation failed");
        assert!(error.to_string().contains("update_failed"), "{error}");
        assert_eq!(*seen.lock().unwrap(), vec![claim()]);
    }

    #[tokio::test]
    async fn a_controlled_unwind_settles_its_claim_and_is_reported_as_an_error() {
        let seen = settled_claims();
        let recording = seen.clone();
        let error = supervise(claim(), controlled_unwind(), move |claim| {
            let recording = recording.clone();
            async move {
                recording.lock().unwrap().push(claim);
            }
        })
        .await
        .expect_err("a controlled unwind is reported, not propagated");
        assert!(
            error.to_string().contains("update_operation_failed"),
            "{error}"
        );
        assert_eq!(
            *seen.lock().unwrap(),
            vec![claim()],
            "the claim must be settled even when the operation unwinds"
        );
    }

    #[tokio::test]
    async fn a_cancelled_supervisor_still_runs_the_operation_to_completion() {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, pending) = tokio::sync::oneshot::channel();
        let (completed, settled) = tokio::sync::oneshot::channel();
        let supervisor = tokio::spawn(supervise(
            claim(),
            async move {
                let _ = entered.send(());
                pending.await.unwrap();
                Ok::<u8, DshError>(9)
            },
            move |_claim| async move {
                let _ = completed.send(());
            },
        ));
        ready.await.unwrap();
        // The *caller* is cancelled; the admitted operation is retained.
        supervisor.abort();
        assert!(supervisor.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        settled.await.expect("the claim is still settled");
    }

    #[tokio::test]
    async fn a_pending_settlement_holds_the_in_flight_count_across_an_unwind() {
        let active = ActiveOperation::begin();
        // The witness tracks *this* guard, so the assertions below never compare
        // global counter snapshots that other concurrent tests also move.
        let witness = active.drop_witness();
        let (release, gate) = tokio::sync::oneshot::channel::<()>();
        let (holding, settlement_holds_the_guard) = tokio::sync::oneshot::channel::<()>();
        let supervisor = tokio::spawn(supervise(
            claim(),
            controlled_unwind(),
            move |_claim| async move {
                // The same guard lifetime `admitted` gives the settlement half.
                let _active = active;
                // Barrier: from here the guard is provably held by settlement, so
                // the test needs no yield-count guessing and no global snapshot.
                let _ = holding.send(());
                let _ = gate.await;
            },
        ));

        // Deterministic handshake: settlement is running and holds the guard,
        // while the operation has already unwound.
        tokio::time::timeout(Duration::from_secs(10), settlement_holds_the_guard)
            .await
            .expect("settlement must enter within the test deadline")
            .expect("settlement entered and is holding the guard");
        assert!(
            !witness.load(std::sync::atomic::Ordering::SeqCst),
            "this exact guard must still be alive while settlement is parked"
        );
        assert!(
            !supervisor.is_finished(),
            "settlement is parked, so supervision cannot be finished"
        );
        assert!(
            active_update_operations() >= 1,
            "the raised count includes this live guard"
        );

        // Releasing settlement lets the parked closure end: the guard is dropped
        // before the supervision task completes, so this is not a race either.
        release.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(10), supervisor)
                .await
                .expect("settlement must complete within the test deadline")
                .unwrap()
                .is_err(),
            "the controlled unwind is reported, not propagated"
        );
        assert!(
            witness.load(std::sync::atomic::Ordering::SeqCst),
            "completing settlement releases this exact guard"
        );
    }

    // --- Host admission guard ---------------------------------------------

    /// The install gate and the guard a live install holds on it.
    async fn held_install_gate() -> (
        std::sync::Arc<tokio::sync::Mutex<()>>,
        tokio::sync::OwnedMutexGuard<()>,
    ) {
        let gate = std::sync::Arc::new(tokio::sync::Mutex::new(()));
        let held = gate.clone().lock_owned().await;
        (gate, held)
    }

    /// Bounded wait for a gate to become free.
    ///
    /// The delegated release holds the gate until its exchange has been
    /// delivered, so waiting for the gate is waiting for that delivery.
    async fn gate_is_free(gate: &std::sync::Arc<tokio::sync::Mutex<()>>) -> bool {
        for _ in 0..20_000 {
            if gate.try_lock().is_ok() {
                return true;
            }
            tokio::task::yield_now().await;
        }
        false
    }

    /// A recording `unlock` exchange: counts deliveries and signals each one.
    #[derive(Default)]
    struct UnlockRecorder {
        unlocks: std::sync::atomic::AtomicUsize,
        delivered: tokio::sync::Notify,
    }

    impl UnlockRecorder {
        fn count(&self) -> usize {
            self.unlocks.load(std::sync::atomic::Ordering::SeqCst)
        }

        /// One guard's exchange, reporting the same `active` a live Host would.
        fn exchange(recorder: &std::sync::Arc<Self>) -> HostRelease {
            let recorder = recorder.clone();
            Box::pin(async move {
                recorder
                    .unlocks
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                recorder.delivered.notify_one();
                Ok(false)
            })
        }
    }

    #[tokio::test]
    async fn a_panic_with_an_armed_host_admission_unlocks_from_the_destructor() {
        let (gate, held) = held_install_gate().await;
        let recorder = std::sync::Arc::new(UnlockRecorder::default());
        let unwinding = tokio::spawn({
            let recorder = recorder.clone();
            async move {
                let _admission = HostAdmission::arm(
                    UpdateOperation(11),
                    held,
                    UnlockRecorder::exchange(&recorder),
                );
                panic!("controlled unwind after the host lock");
            }
        });
        assert!(
            unwinding.await.unwrap_err().is_panic(),
            "the guarded body unwinds"
        );
        // A destructor cannot await, so the exchange is retained: the test waits
        // for the delivery instead of assuming it.
        tokio::time::timeout(Duration::from_secs(10), recorder.delivered.notified())
            .await
            .expect("the destructor must schedule the unlock within the deadline");
        assert_eq!(recorder.count(), 1, "exactly one unlock is delivered");
        assert!(
            gate_is_free(&gate).await,
            "the install gate travels with the delegated unlock"
        );
    }

    #[tokio::test]
    async fn a_handoff_disarm_drops_the_guard_without_unlocking() {
        let (gate, held) = held_install_gate().await;
        let recorder = std::sync::Arc::new(UnlockRecorder::default());
        let admission = HostAdmission::arm(
            UpdateOperation(12),
            held,
            UnlockRecorder::exchange(&recorder),
        );
        admission.handoff().disarm();
        drop(admission);
        assert_eq!(
            recorder.count(),
            0,
            "a committed teardown must not reopen the Host it is stopping"
        );
        // Nothing was scheduled either: scheduling is observable on the next
        // turns, and the counter is the witness.
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        assert_eq!(recorder.count(), 0);
        assert!(
            gate.try_lock().is_ok(),
            "a disarmed guard still releases the install gate"
        );
    }

    #[tokio::test]
    async fn an_explicit_release_unlocks_once_and_drop_adds_nothing() {
        let (gate, held) = held_install_gate().await;
        let recorder = std::sync::Arc::new(UnlockRecorder::default());
        let admission = HostAdmission::arm(
            UpdateOperation(13),
            held,
            UnlockRecorder::exchange(&recorder),
        );
        assert!(
            !admission.release().await.expect("the unlock exchange ran"),
            "a probe exchange reports no live tasks"
        );
        assert_eq!(recorder.count(), 1);
        // `release` consumed the guard, so a rollback cannot be doubled by the
        // destructor.
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        assert_eq!(
            recorder.count(),
            1,
            "a released admission must not unlock twice"
        );
        assert!(
            gate.try_lock().is_ok(),
            "the install gate is released after the explicit unlock"
        );
    }

    #[tokio::test]
    async fn a_release_after_the_handoff_reports_nothing_to_release() {
        let (_gate, held) = held_install_gate().await;
        let recorder = std::sync::Arc::new(UnlockRecorder::default());
        let admission = HostAdmission::arm(
            UpdateOperation(14),
            held,
            UnlockRecorder::exchange(&recorder),
        );
        admission.handoff().disarm();
        assert!(
            !admission
                .release()
                .await
                .expect("an already-disarmed release is not a failure"),
            "there was nothing left to release"
        );
        assert_eq!(recorder.count(), 0);
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
        assert_eq!(recorder.count(), 0);
    }

    #[tokio::test]
    async fn a_delegated_release_is_counted_while_it_is_still_owed() {
        let (_gate, held) = held_install_gate().await;
        let (release, parked) = tokio::sync::oneshot::channel::<()>();
        let (entered, running) = tokio::sync::oneshot::channel::<()>();
        let unwinding = tokio::spawn(async move {
            let _admission = HostAdmission::arm(UpdateOperation(15), held, async move {
                let _ = entered.send(());
                let _ = parked.await;
                Ok(false)
            });
            panic!("controlled unwind with a parked release");
        });
        assert!(unwinding.await.unwrap_err().is_panic());
        // Barrier handshake: the delegated release is running and therefore holds
        // the in-flight accounting the destructor raised for it.
        running.await.expect("the delegated release started");
        // A lower bound over the process-global counter, like the settlement
        // case: this proves the release is accounted for, and other cases only
        // add to the count, so it cannot fail spuriously.
        assert!(
            active_update_operations() >= 1,
            "a retained Host admission release must be counted until it settles"
        );
        release.send(()).unwrap();
        // Let the released exchange finish before the case ends. The global
        // counter is deliberately not asserted at zero here: other cases move it
        // concurrently, which is why the settlement case uses a per-guard witness.
        for _ in 0..64 {
            tokio::task::yield_now().await;
        }
    }

    // --- retired artifacts -------------------------------------------------

    #[test]
    fn a_candidate_transition_never_retires_the_path_the_next_candidate_uses() {
        let path = PathBuf::from("/cache/dsh-update-stable-1.2.3-aaaa.bin");
        let previous = UpdateCandidate {
            version: "1.2.3".into(),
            channel: "stable".into(),
            url: "https://updates.example.com/a.bin".into(),
            sha256: "a".repeat(64),
            signature: "ab".repeat(64),
            artifact_path: Some(path.clone()),
        };
        assert_eq!(
            superseded_artifact(Some(&previous), None),
            Some(path.clone())
        );
        // A re-download of the same release publishes the same filename, so the
        // live path must not be queued for removal.
        let next = UpdateCandidate {
            artifact_path: Some(path.clone()),
            ..previous.clone()
        };
        assert_eq!(superseded_artifact(Some(&previous), Some(&next)), None);
        // A candidate with no artifact retires nothing.
        let unbound = UpdateCandidate {
            artifact_path: None,
            ..previous
        };
        assert_eq!(superseded_artifact(Some(&unbound), None), None);
        assert_eq!(superseded_artifact(None, None), None);
    }

    #[tokio::test]
    async fn a_joined_drain_removes_exactly_what_was_retired() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-retire-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        let retired = directory.join("superseded.bin");
        let kept = directory.join("kept.bin");
        std::fs::write(&retired, b"superseded").expect("write retired");
        std::fs::write(&kept, b"kept").expect("write kept");

        let report = remove_retired_artifacts(vec![retired.clone()]).await;
        assert_eq!(report.delivery, CleanupDelivery::Joined);
        assert_eq!(report.retired, 1);
        assert!(report.failed.is_empty());
        assert!(!retired.exists(), "the retired artifact is removed");
        assert!(kept.is_file(), "nothing else is touched");

        // Already-gone paths count as retired, and an empty drain claims nothing.
        let again = remove_retired_artifacts(vec![retired]).await;
        assert_eq!(again.retired, 1, "an already-gone artifact is retired");
        let idle = remove_retired_artifacts(Vec::new()).await;
        assert_eq!(idle.delivery, CleanupDelivery::Idle);
        assert_eq!(idle.retired, 0);
        std::fs::remove_dir_all(&directory).ok();
    }

    #[tokio::test]
    async fn a_drain_reports_a_refused_removal_instead_of_claiming_success() {
        let directory =
            std::env::temp_dir().join(format!("dsh-update-retire-fail-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&directory).expect("create temp directory");
        // A directory cannot be removed with `remove_file`, so this is a real
        // refusal rather than an injected failure.
        let report = remove_retired_artifacts(vec![directory.clone()]).await;
        assert_eq!(report.delivery, CleanupDelivery::Joined);
        assert_eq!(report.retired, 0);
        assert_eq!(report.failed.len(), 1, "{report:?}");
        assert_eq!(report.failed[0].0, directory);
        assert!(
            directory.is_dir(),
            "a refused removal leaves the path in place"
        );
        std::fs::remove_dir_all(&directory).ok();
    }
}
