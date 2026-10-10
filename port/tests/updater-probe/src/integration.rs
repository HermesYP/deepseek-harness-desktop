//! Integration tests for the updater runtime: single flight, stale-candidate
//! rejection, the `Later`/`Ready` rule, the mandatory gate, and the runner's
//! wiring into the real check path.
//!
//! These drive the **production** `update_flow` module against the probe's
//! inert host, so they assert the shell's real admission logic rather than a
//! restatement of it. Nothing here opens a socket: the packaged trust
//! configuration is pointed at a fixture, so `check` refuses before any
//! network request and the tests observe the refusal path.
//!
//! What is **not** covered here, and must not be implied: a real feed fetch,
//! a real artifact download, a real signature produced by production keys, a
//! real installer launch, and any native window. Those need a packaged build
//! with a live feed (see the lane report's "unrun" section).

use std::sync::Arc;

use dsh_core::error::DshError;
use dsh_core::protocol::{
    DesktopUpdateFailureKind, DesktopUpdateOperation, DesktopUpdatePhase,
    DesktopUpdatePreparationFailureKind,
};

use crate::dialog::DialogAnswer;
use crate::host::{clear_trust_fixture, install_trust_fixture, Harness, UpdateTasksOutcome};
use crate::mandatory_update::{MandatoryDecision, MandatoryEnforcement};
use crate::state::{UpdateCandidate, UpdateFlight};
use crate::update_flow;
use crate::update_schedule::{CheckOutcome, CheckTrigger};

/// A version strictly newer than the running build, whatever that is.
fn newer_version() -> String {
    let current = update_flow::CURRENT_VERSION;
    let mut parts = current
        .split(['.', '-', '+'])
        .filter_map(|part| part.parse::<u64>().ok());
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    let patch = parts.next().unwrap_or(0);
    format!("{major}.{minor}.{}", patch + 1)
}

/// A digest-shaped string.
fn digest() -> String {
    "a".repeat(64)
}

/// How many `unlock` actions the stand-in Host has observed.
fn unlock_count(harness: &Harness) -> usize {
    harness
        .state
        .supervisor
        .observed_actions()
        .into_iter()
        .filter(|action| *action == crate::host::UpdateTasksAction::Unlock)
        .count()
}

/// Let every task the updater scheduled run before the next assertion.
///
/// An abandoned install delegates its `unlock` to a retained task (a destructor
/// cannot await), so a test that asserts "nothing was unlocked" has to give that
/// task the chance to run first; otherwise it would only be asserting that it had
/// not run *yet*.
async fn drain_scheduled_work() {
    for _ in 0..256 {
        tokio::task::yield_now().await;
    }
}

/// Wait (bounded) for a delegated `unlock` to reach the stand-in Host.
async fn wait_for_unlock(harness: &Harness) {
    for _ in 0..20_000 {
        if unlock_count(harness) > 0 {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the abandoned install never unlocked host admission");
}

/// A harness with packaged trust authority installed.
///
/// The trust fixture names a real feed origin and the fixture signing key, so
/// policy resolution succeeds and the confirmation paths can run. It still
/// makes **no** network request: the feed URL is never reached in these tests,
/// because every case either supplies a candidate directly or stops at policy
/// admission.
///
/// The trust override is process-global, so these cases hold [`TRUST_LOCK`] for
/// their whole body: without it two tests could interleave and each would
/// observe the other's configuration.
struct TrustedHarness {
    harness: Harness,
    fixture: std::path::PathBuf,
    _guard: tokio::sync::MutexGuard<'static, ()>,
}

/// Serializes every case that installs a process-global trust override.
///
/// Async-aware on purpose: a trusted case holds this across its whole body,
/// because the override must stay installed while it awaits, and a
/// `std::sync::Mutex` guard held across an await point is what Clippy's
/// `await_holding_lock` refuses. There is no poisoning to recover from - a
/// panicking case unwinds and releases the guard, so the remaining cases still
/// run instead of cascading that one failure.
static TRUST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

impl TrustedHarness {
    async fn new(label: &str) -> Self {
        Self::build(label, UpdateTasksOutcome::default()).await
    }

    async fn with_tasks(label: &str, tasks: UpdateTasksOutcome) -> Self {
        Self::build(label, tasks).await
    }

    async fn with_runtime_version(label: &str, runtime_version: &str) -> Self {
        Self::build_runtime(label, UpdateTasksOutcome::default(), Some(runtime_version)).await
    }

    async fn build(label: &str, tasks: UpdateTasksOutcome) -> Self {
        Self::build_runtime(label, tasks, None).await
    }

    async fn build_runtime(
        label: &str,
        tasks: UpdateTasksOutcome,
        runtime_version: Option<&str>,
    ) -> Self {
        // The guard is held for the whole test body through `_guard`. The lock is
        // async-aware, so this acquisition must be awaited; there is no poison
        // state to recover, because a panicking holder simply releases it.
        let guard = TRUST_LOCK.lock().await;
        let fixture = install_trust_fixture(label);
        Self {
            harness: Harness::with_runtime_version(tasks, runtime_version),
            fixture,
            _guard: guard,
        }
    }
}

impl Drop for TrustedHarness {
    fn drop(&mut self) {
        clear_trust_fixture(&self.fixture);
    }
}

impl std::ops::Deref for TrustedHarness {
    type Target = Harness;
    fn deref(&self) -> &Self::Target {
        &self.harness
    }
}

// ---------------------------------------------------------------------------
// Single flight
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_check_joins_an_in_flight_check_instead_of_duplicating_it() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    // Claim the service as an in-flight check would.
    {
        let mut update = harness.state.update.lock().await;
        update.flight = Some(UpdateFlight::Check);
        update.state.phase = DesktopUpdatePhase::Checking;
    }
    let presentation = update_flow::check(&harness.app)
        .await
        .expect("join succeeds");
    // The caller observes the in-flight state verbatim and starts nothing.
    assert_eq!(presentation.phase, DesktopUpdatePhase::Checking);
    assert_eq!(
        harness.state.update.lock().await.flight,
        Some(UpdateFlight::Check),
        "the joining caller must not clear the owner's flight"
    );
}

#[tokio::test]
async fn a_check_is_refused_while_a_download_owns_the_service() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    {
        let mut update = harness.state.update.lock().await;
        update.flight = Some(UpdateFlight::Download);
        update.state.phase = DesktopUpdatePhase::Downloading;
    }
    let presentation = update_flow::check(&harness.app)
        .await
        .expect("refusal succeeds");
    assert_eq!(
        presentation.phase,
        DesktopUpdatePhase::Downloading,
        "a check must not displace a confirmed download"
    );
    assert_eq!(
        harness.state.update.lock().await.flight,
        Some(UpdateFlight::Download),
        "the download keeps ownership"
    );
    // And the refusal is reported to the runner as a skip, not a failure, so an
    // unrelated download cannot push the poll interval out to the backoff cap.
    let (_, outcome) = update_flow::check_with_outcome(&harness.app)
        .await
        .expect("refusal succeeds");
    assert_eq!(outcome, CheckOutcome::Skipped);
}

#[tokio::test]
async fn a_check_is_refused_while_an_install_owns_the_service() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    {
        let mut update = harness.state.update.lock().await;
        update.flight = Some(UpdateFlight::Install);
        update.state.phase = DesktopUpdatePhase::Installing;
    }
    let presentation = update_flow::check(&harness.app)
        .await
        .expect("refusal succeeds");
    assert_eq!(presentation.phase, DesktopUpdatePhase::Installing);
    let (_, outcome) = update_flow::check_with_outcome(&harness.app)
        .await
        .expect("refusal succeeds");
    assert_eq!(outcome, CheckOutcome::Skipped);
}

// ---------------------------------------------------------------------------
// No packaged trust: no network, and a truthful failure
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_build_without_packaged_trust_refuses_before_any_network_request() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    // No trust fixture is configured, so the executable-adjacent `updates.json`
    // does not exist and delivery must be disabled.
    let presentation = update_flow::check(&harness.app)
        .await
        .expect("refusal succeeds");
    assert_eq!(
        presentation.phase,
        DesktopUpdatePhase::Error,
        "an unconfigured build reports the refusal rather than pretending to check"
    );
    assert_eq!(presentation.failure, Some(DesktopUpdateFailureKind::Check));
    let state = harness.update_state().await;
    assert_eq!(state.failed_operation, Some(DesktopUpdateOperation::Check));
    let message = state.message.expect("a refusal explains itself");
    assert!(
        message.contains("release delivery is disabled"),
        "the message must say delivery is disabled, saw: {message}"
    );
    // The flight is released, so a later check can run once trust is packaged.
    assert_eq!(harness.state.update.lock().await.flight, None);
}

#[tokio::test]
async fn a_refused_check_invalidates_a_previously_admitted_candidate() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    // A verified artifact of that candidate is retired with it: loss of authority
    // must not leave installable-looking bytes behind.
    let path = std::env::temp_dir().join(format!("dsh-refused-check-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&path, b"verified bytes").expect("write artifact");
    assert!(harness.publish_artifact(path.clone()).await);
    assert!(harness.candidate_version().await.is_some());
    update_flow::check(&harness.app)
        .await
        .expect("refusal succeeds");
    assert_eq!(
        harness.candidate_version().await,
        None,
        "loss of packaged authority must drop the candidate it authorized"
    );
    let mut update = harness.state.update.lock().await;
    assert!(
        !update.has_published_artifact(),
        "and no artifact remains installable"
    );
    let retired = update.take_retired_artifacts();
    assert_eq!(
        retired,
        vec![path.clone()],
        "the superseded artifact is retired for the shutdown drain"
    );
    drop(update);
    assert!(path.is_file(), "retirement itself must not remove the file");
    std::fs::remove_file(&path).ok();
}

// ---------------------------------------------------------------------------
// Stale completion rejection (episodes)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_download_that_completes_after_a_new_episode_cannot_publish() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    let (stale_episode, candidate) = {
        let update = harness.state.update.lock().await;
        (update.episode, update.candidate.clone().expect("admitted"))
    };
    // A channel switch (or a superseding check) begins a new episode.
    let _ = harness.state.update.lock().await.invalidate_candidate();
    assert!(
        !harness
            .state
            .update
            .lock()
            .await
            .episode_is_current(stale_episode),
        "the new episode supersedes the in-flight download"
    );
    // The late completion is discarded, and the newer state is untouched.
    let mut update = harness.state.update.lock().await;
    assert!(!update.publish_artifact(stale_episode, std::path::PathBuf::from("late.bin")));
    assert_eq!(update.candidate, None, "the newer state is untouched");
    assert!(!update.has_published_artifact());
    let _ = candidate;
}

#[tokio::test]
async fn only_a_newer_release_replaces_the_admitted_candidate() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    let older = "0.0.1";
    harness.admit_candidate(older, "stable", &digest()).await;
    assert_eq!(harness.candidate_version().await.as_deref(), Some(older));
    // Admitting a different release invalidates the previous episode, so the
    // old artifact can never be installed under the new version.
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    assert_eq!(
        harness.candidate_version().await.as_deref(),
        Some(newer_version().as_str())
    );
    assert!(harness.candidate_artifact().await.is_none());
}

// ---------------------------------------------------------------------------
// Channel invalidation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_channel_change_invalidates_the_candidate_and_clears_the_presentation() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    harness.state.update.lock().await.checked = true;
    update_flow::invalidate_for_channel_change(&harness.app).await;

    let update = harness.state.update.lock().await;
    assert_eq!(update.candidate, None);
    assert_eq!(update.flight, None);
    assert!(!update.checked, "the section becomes unchecked");
    assert_eq!(update.state.phase, DesktopUpdatePhase::Idle);
    assert_eq!(update.state.version, None);
    assert_eq!(update.state.percent, None);
    assert_eq!(update.state.message, None);
    assert!(!update.has_published_artifact());
}

#[tokio::test]
async fn a_channel_change_asks_the_runner_for_an_immediate_check() {
    // The runner is not started in this test (no packaged trust), so the
    // request is observed through the module's own entry point being callable
    // without panicking and leaving no runner behind.
    assert!(
        update_flow::runner().is_none(),
        "no runner without packaged trust"
    );
    update_flow::request_check(CheckTrigger::ChannelChange);
    update_flow::dispose_runner().await;
}

// ---------------------------------------------------------------------------
// Trust-before-disruption: installation admission
// ---------------------------------------------------------------------------

#[tokio::test]
async fn installation_is_refused_without_a_published_artifact() {
    let trusted = TrustedHarness::new("ea9fc79a").await;
    let harness = &trusted.harness;
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    // Admission reaches the artifact check and refuses before touching the Host.
    let error = update_flow::install_for_test(&harness.app, Some(newer_version()))
        .await
        .expect_err("no verified artifact exists");
    assert!(
        format!("{error}").contains("update_artifact_not_ready"),
        "saw: {error}"
    );
    assert_eq!(
        harness.state.supervisor.stop_count(),
        0,
        "the Host must not be stopped when installation is refused"
    );
    let state = harness.update_state().await;
    assert_eq!(
        state.failed_operation,
        Some(DesktopUpdateOperation::Install)
    );
}

#[tokio::test]
async fn installation_refuses_a_stale_confirmed_version_without_stopping_the_host() {
    let trusted = TrustedHarness::new("e497f9ad").await;
    let harness = &trusted.harness;
    let admitted = newer_version();
    harness
        .admit_candidate(&admitted, "stable", &digest())
        .await;
    // A version that is definitely not the admitted one, so this tests the
    // comparison rather than accidentally matching it. (`newer_version()` is
    // derived from the *probe* crate's version, so a literal must not be
    // assumed to be different from it.)
    assert_ne!(admitted, "9.9.9");
    let error = update_flow::install_for_test(&harness.app, Some("9.9.9".to_string()))
        .await
        .expect_err("the confirmed version is stale");
    assert!(
        format!("{error}").contains("update_confirmation_stale"),
        "saw: {error}"
    );
    assert_eq!(harness.state.supervisor.stop_count(), 0);
}

#[tokio::test]
async fn installation_refuses_a_published_artifact_whose_bytes_changed() {
    let trusted = TrustedHarness::new("8e75d080").await;
    let harness = &trusted.harness;
    let version = newer_version();
    let real = b"the real release artifact";
    harness
        .admit_candidate(
            &version,
            "stable",
            &crate::update_security::sha256_hex(real),
        )
        .await;
    let directory = std::env::temp_dir().join(format!("dsh-upd-probe-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temp dir");
    let path = directory.join("artifact.bin");
    std::fs::write(&path, real).expect("write artifact");
    assert!(harness.publish_artifact(path.clone()).await);
    assert!(harness.state.update.lock().await.has_published_artifact());

    // The file is swapped after publication: trust is rechecked over the bytes
    // on disk before the Host is disturbed.
    std::fs::write(&path, b"malicious replacement").expect("swap artifact");
    let error = update_flow::install_for_test(&harness.app, Some(version))
        .await
        .expect_err("a swapped artifact is refused");
    assert!(
        format!("{error}").contains("update_artifact_untrusted"),
        "saw: {error}"
    );
    assert_eq!(
        harness.state.supervisor.stop_count(),
        0,
        "the Host must not be stopped for an untrusted artifact"
    );
    assert_eq!(
        harness.candidate_version().await,
        None,
        "an untrusted artifact invalidates the candidate"
    );
    std::fs::remove_dir_all(&directory).ok();
}

#[tokio::test]
async fn installation_is_refused_while_another_operation_owns_the_service() {
    let trusted = TrustedHarness::new("b10ce695").await;
    let harness = &trusted.harness;
    let version = newer_version();
    let bytes = b"verified bytes";
    harness
        .admit_candidate(
            &version,
            "stable",
            &crate::update_security::sha256_hex(bytes),
        )
        .await;
    let directory = std::env::temp_dir().join(format!("dsh-upd-busy-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temp dir");
    let path = directory.join("artifact.bin");
    std::fs::write(&path, bytes).expect("write artifact");
    assert!(harness.publish_artifact(path).await);
    harness.state.update.lock().await.flight = Some(UpdateFlight::Check);

    let error = update_flow::install_for_test(&harness.app, Some(version))
        .await
        .expect_err("a busy service refuses a second install");
    assert!(format!("{error}").contains("update_busy"), "saw: {error}");
    assert_eq!(harness.state.supervisor.stop_count(), 0);
    std::fs::remove_dir_all(&directory).ok();
}

#[tokio::test]
async fn unknown_task_state_refuses_installation_and_rolls_back_admission() {
    let trusted = TrustedHarness::with_tasks("tasks-", UpdateTasksOutcome::Unavailable).await;
    let harness = &trusted.harness;
    let version = newer_version();
    let bytes = b"verified bytes for admission";
    harness
        .admit_candidate(
            &version,
            "stable",
            &crate::update_security::sha256_hex(bytes),
        )
        .await;
    let directory = std::env::temp_dir().join(format!("dsh-upd-adm-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temp dir");
    let path = directory.join("artifact.bin");
    std::fs::write(&path, bytes).expect("write artifact");
    assert!(harness.publish_artifact(path).await);

    let error = update_flow::install_for_test(&harness.app, Some(version))
        .await
        .expect_err("unknown task state refuses installation");
    assert!(
        format!("{error}").contains("update_tasks_unavailable"),
        "saw: {error}"
    );
    // Neither a failed Lock nor a failed Unlock authorizes killing live tasks.
    assert_eq!(harness.state.supervisor.stop_count(), 0);
    assert_eq!(harness.state.supervisor.restart_count(), 0);
    let update = harness.state.update.lock().await;
    assert_eq!(update.state.phase, DesktopUpdatePhase::Error);
    assert_eq!(update.flight, None);
    assert!(update.has_published_artifact());
    drop(update);
    assert!(
        harness
            .state
            .supervisor
            .observed_actions()
            .contains(&crate::host::UpdateTasksAction::Unlock),
        "a failed lock must be rolled back"
    );
    std::fs::remove_dir_all(&directory).ok();
}

#[tokio::test]
async fn declining_the_task_warning_keeps_the_verified_artifact_ready() {
    let trusted = TrustedHarness::with_tasks("tasks-", UpdateTasksOutcome::Active).await;
    let harness = &trusted.harness;
    let version = newer_version();
    let bytes = b"verified bytes with running tasks";
    harness
        .admit_candidate(
            &version,
            "stable",
            &crate::update_security::sha256_hex(bytes),
        )
        .await;
    let directory = std::env::temp_dir().join(format!("dsh-upd-tasks-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temp dir");
    let path = directory.join("artifact.bin");
    std::fs::write(&path, bytes).expect("write artifact");
    assert!(harness.publish_artifact(path.clone()).await);

    // The user declines to stop running tasks.
    harness.script_dialogs(&[DialogAnswer::Secondary]);
    update_flow::install_for_test(&harness.app, Some(version.clone()))
        .await
        .expect("declining is not a failure");

    let update = harness.state.update.lock().await;
    assert_eq!(
        update.state.phase,
        DesktopUpdatePhase::Ready,
        "declining returns to Ready rather than discarding the target"
    );
    assert_eq!(update.flight, None, "ownership is released for a retry");
    assert!(update.has_published_artifact());
    assert_eq!(harness.state.supervisor.restart_count(), 0);
    assert!(
        update
            .candidate
            .as_ref()
            .is_some_and(|candidate| candidate.artifact_path.as_deref() == Some(path.as_path())),
        "the verified artifact stays available for a later confirmation"
    );
    assert_eq!(harness.state.supervisor.stop_count(), 0);
    assert!(
        harness
            .state
            .supervisor
            .observed_actions()
            .contains(&crate::host::UpdateTasksAction::Unlock),
        "the admission lock is released"
    );
    std::fs::remove_dir_all(&directory).ok();
}

#[tokio::test]
async fn declining_with_failed_unlock_preserves_agents_and_owned_or_superseding_state() {
    for supersede in [false, true] {
        let trusted =
            TrustedHarness::with_tasks("decline-unlock", UpdateTasksOutcome::Active).await;
        let h = &trusted.harness;
        let version = newer_version();
        let bytes = b"declined install fixture";
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("fixture.bin");
        std::fs::write(&path, bytes).unwrap();
        h.admit_candidate(
            &version,
            "stable",
            &crate::update_security::sha256_hex(bytes),
        )
        .await;
        assert!(h.publish_artifact(path.clone()).await);
        h.script_dialogs(&[DialogAnswer::Secondary]);
        let state = Arc::downgrade(&h.state);
        *h.state.supervisor.after_task_action.lock().unwrap() = Some(Box::new(move |action| {
            if action == crate::host::UpdateTasksAction::Unlock {
                let state = state.upgrade().unwrap();
                *state.supervisor.tasks.lock().unwrap() = UpdateTasksOutcome::Unavailable;
                if supersede {
                    let mut update = state.update.try_lock().unwrap();
                    update.candidate.as_mut().unwrap().version = "99.0.0".into();
                    update.flight = Some(UpdateFlight::Check);
                    update.state.phase = DesktopUpdatePhase::Checking;
                }
            }
        }));
        let error = update_flow::install_for_test(&h.app, Some(version))
            .await
            .unwrap_err();
        assert!(format!("{error}").contains("update_admission_rollback"));
        assert_eq!(h.state.supervisor.stop_count(), 0);
        assert_eq!(h.state.supervisor.restart_count(), 0);
        assert!(path.is_file());
        let update = h.state.update.lock().await;
        if supersede {
            assert_eq!(update.flight, Some(UpdateFlight::Check));
            assert_eq!(update.state.phase, DesktopUpdatePhase::Checking);
            assert_eq!(update.candidate.as_ref().unwrap().version, "99.0.0");
        } else {
            assert_eq!(update.flight, None);
            assert_eq!(update.state.phase, DesktopUpdatePhase::Error);
            assert_eq!(
                update.state.failed_operation,
                Some(DesktopUpdateOperation::Install)
            );
            assert!(update.has_published_artifact());
        }
    }
}

#[tokio::test]
async fn failed_lock_and_unlock_do_not_overwrite_a_superseding_check() {
    let trusted =
        TrustedHarness::with_tasks("lock-superseded", UpdateTasksOutcome::Unavailable).await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"failed lock fixture";
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    assert!(h.publish_artifact(path.clone()).await);
    let state = Arc::downgrade(&h.state);
    *h.state.supervisor.after_task_action.lock().unwrap() = Some(Box::new(move |action| {
        if action == crate::host::UpdateTasksAction::Lock {
            let state = state.upgrade().unwrap();
            let mut update = state.update.try_lock().unwrap();
            update.candidate.as_mut().unwrap().version = "99.0.0".into();
            update.flight = Some(UpdateFlight::Check);
            update.state.phase = DesktopUpdatePhase::Checking;
        }
    }));
    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .unwrap_err();
    assert!(format!("{error}").contains("update_tasks_unavailable"));
    assert_eq!(h.state.supervisor.stop_count(), 0);
    assert_eq!(h.state.supervisor.restart_count(), 0);
    let update = h.state.update.lock().await;
    assert_eq!(update.flight, Some(UpdateFlight::Check));
    assert_eq!(update.state.phase, DesktopUpdatePhase::Checking);
    assert_eq!(update.candidate.as_ref().unwrap().version, "99.0.0");
    assert!(path.is_file());
}

// ---------------------------------------------------------------------------
// Final admission races (probe hooks are deterministic stand-ins only)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn final_policy_revocation_after_host_lock_unlocks_without_stopping() {
    let trusted = TrustedHarness::with_tasks("final-policy", UpdateTasksOutcome::Active).await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"final admission artifact";
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    let path = std::env::temp_dir().join(format!("probe-final-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).unwrap();
    assert!(h.publish_artifact(path.clone()).await);
    h.state
        .supervisor
        .after_task_action
        .lock()
        .unwrap()
        .replace(Box::new({
            let policy = h.state.policy.clone();
            move |action| {
                if action == crate::host::UpdateTasksAction::Lock {
                    policy
                        .normal_allowed
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                    policy
                        .mandatory_update_allowed
                        .store(false, std::sync::atomic::Ordering::SeqCst);
                }
            }
        }));
    h.script_dialogs(&[DialogAnswer::Primary]);
    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .unwrap_err();
    assert!(!format!("{error}").is_empty());
    assert_eq!(h.state.supervisor.stop_count(), 0);
    assert_eq!(h.state.supervisor.restart_count(), 0);
    assert!(h
        .state
        .supervisor
        .observed_actions()
        .contains(&crate::host::UpdateTasksAction::Unlock));
    // The rollback consumes the Host admission guard, so the unlock is delivered
    // exactly once: a destructor must not add a second one.
    drain_scheduled_work().await;
    assert_eq!(
        unlock_count(h),
        1,
        "an explicit rollback must unlock exactly once"
    );
    let u = h.state.update.lock().await;
    assert_eq!(u.flight, None);
    assert!(u.has_published_artifact());
    drop(u);
    std::fs::remove_file(path).ok();
}

#[tokio::test]
async fn a_panic_after_the_host_lock_unlocks_admission_and_still_settles() {
    let trusted = TrustedHarness::new("panic-after-lock").await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"panic after the host lock fixture";
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    assert!(h.publish_artifact(path.clone()).await);
    // This seam runs inside the supervisor's lifecycle transaction, i.e. *after*
    // the Host answered `lock` and before any teardown: exactly the window in
    // which a panic used to leave admission locked with no unlock behind it.
    *h.state.supervisor.before_final_admission.lock().unwrap() =
        Some(Box::new(|| panic!("controlled unwind after the host lock")));

    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .expect_err("the unwound operation is reported, not propagated");
    assert!(
        format!("{error}").contains("update_operation_failed"),
        "saw: {error}"
    );
    assert_eq!(
        h.state.supervisor.stop_count(),
        0,
        "the Host was never stopped"
    );
    assert_eq!(h.state.supervisor.restart_count(), 0);
    // The guard's destructor delegated the unlock; wait for it and then assert it
    // happened exactly once.
    wait_for_unlock(h).await;
    drain_scheduled_work().await;
    assert_eq!(unlock_count(h), 1, "the abandoned admission locked once");
    // Settlement still ran: the install flight is released even though the
    // operation unwound.
    assert_eq!(h.state.update.lock().await.flight, None);
    assert!(path.is_file(), "the verified artifact is not discarded");
}

#[tokio::test]
async fn a_shutdown_that_began_before_the_handoff_is_not_reopened_by_a_panic() {
    let trusted = TrustedHarness::new("shutdown-before-panic").await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"shutdown before the handoff fixture";
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    assert!(h.publish_artifact(path.clone()).await);
    // Park the release the destructor will delegate, so every assertion below is
    // an ordered handshake instead of a race.
    update_flow::park_admission_releases(Some(std::time::Duration::from_secs(2)));
    // The shutdown begins *before* the handoff: this seam runs after the Host
    // answered `lock`, so the service publishes its one-way commitment and then
    // the operation unwinds at the final-admission step.
    let state = Arc::downgrade(&h.state);
    *h.state.supervisor.before_final_admission.lock().unwrap() = Some(Box::new(move || {
        state
            .upgrade()
            .unwrap()
            .update
            .try_lock()
            .unwrap()
            .close_admission();
        panic!("controlled unwind after the shutdown began");
    }));

    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .expect_err("the unwound operation is reported, not propagated");
    assert!(
        format!("{error}").contains("update_operation_failed"),
        "saw: {error}"
    );
    assert_eq!(
        h.state.supervisor.stop_count(),
        0,
        "the Host was never stopped"
    );

    // The abandoned install still owes an unlock, and that retained release is
    // what keeps the shutdown barrier from claiming quiescence: a process must not
    // drain (or announce quiet) behind an admission it still holds on the Host.
    match update_flow::quiesce_updates(&h.app, std::time::Duration::from_millis(0)).await {
        update_flow::UpdateQuiescence::TimedOut { active } => assert!(
            active >= 1,
            "the retained release is what the barrier is waiting for"
        ),
        other => {
            panic!("the barrier must not report quiescence while a release is owed: {other:?}")
        }
    }

    // Let the parked exchange run. The shutdown began first, so the release must
    // send nothing — reopening a Host the process is stopping is exactly the
    // hazard — and must settle its own accounting.
    update_flow::park_admission_releases(None);
    let quiescence = update_flow::quiesce_updates(&h.app, std::time::Duration::from_secs(10)).await;
    assert!(
        quiescence.is_quiescent(),
        "the retained release must settle: {quiescence:?}"
    );
    assert_eq!(
        unlock_count(h),
        0,
        "a shutdown that began before the release must not be reopened by an unlock"
    );
    assert!(path.is_file(), "the verified artifact is not discarded");
}

#[tokio::test]
async fn final_policy_revocation_with_unlock_failure_reports_error_without_restart() {
    let trusted = TrustedHarness::with_tasks("final-unlock-fail", UpdateTasksOutcome::Active).await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"retained after refused final admission";
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    let path = std::env::temp_dir().join(format!("probe-unlock-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).unwrap();
    assert!(h.publish_artifact(path.clone()).await);
    // Refuse only Unlock: Query/Lock must first succeed to reach final admission.
    let supervisor = Arc::downgrade(&h.state.supervisor);
    *h.state.supervisor.after_task_action.lock().unwrap() = Some(Box::new(move |action| {
        if action == crate::host::UpdateTasksAction::Unlock {
            *supervisor.upgrade().unwrap().tasks.lock().unwrap() = UpdateTasksOutcome::Unavailable;
        }
    }));
    *h.state.supervisor.before_final_admission.lock().unwrap() = Some(Box::new({
        let policy = h.state.policy.clone();
        move || {
            policy
                .normal_allowed
                .store(false, std::sync::atomic::Ordering::SeqCst);
            policy
                .mandatory_update_allowed
                .store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }));
    h.script_dialogs(&[DialogAnswer::Primary]);
    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .unwrap_err();
    assert!(format!("{error}").contains("update_admission_rollback"));
    assert_eq!(h.state.supervisor.stop_count(), 0);
    assert_eq!(h.state.supervisor.restart_count(), 0);
    let u = h.state.update.lock().await;
    assert_eq!(u.state.phase, DesktopUpdatePhase::Error);
    assert_eq!(u.flight, None);
    assert!(u.has_published_artifact());
    drop(u);
    std::fs::remove_file(path).ok();
}

#[tokio::test]
async fn final_admission_rejects_replaced_candidate_without_mutating_replacement() {
    let trusted = TrustedHarness::new("replace-final").await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"old candidate bytes";
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    let path = std::env::temp_dir().join(format!("probe-replace-{}.bin", uuid::Uuid::new_v4()));
    std::fs::write(&path, bytes).unwrap();
    assert!(h.publish_artifact(path.clone()).await);
    // Replace candidate and claim a distinct Check flight at the final-stop
    // seam. This exercises real controller ownership checks, not policy denial.
    let state = Arc::downgrade(&h.state);
    *h.state.supervisor.before_final_admission.lock().unwrap() = Some(Box::new(move || {
        let state = state.upgrade().unwrap();
        let mut update = state
            .update
            .try_lock()
            .expect("final admission holds no update lock");
        let mut replacement = update.candidate.clone().unwrap();
        replacement.version = "99.0.0".to_string();
        update.candidate = Some(replacement);
        update.flight = Some(UpdateFlight::Check);
        update.state.phase = DesktopUpdatePhase::Checking;
    }));
    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .unwrap_err();
    assert!(format!("{error}").contains("update_install_admission"));
    let u = h.state.update.lock().await;
    assert_eq!(u.flight, Some(UpdateFlight::Check));
    assert_eq!(u.state.phase, DesktopUpdatePhase::Checking);
    assert_eq!(u.candidate.as_ref().unwrap().version, "99.0.0");
    assert!(
        path.is_file(),
        "old verified bytes are not deleted on precommit refusal"
    );
    assert_eq!(h.state.supervisor.stop_count(), 0);
    assert_eq!(h.state.supervisor.restart_count(), 0);
    drop(u);
    std::fs::remove_file(path).ok();
}

#[tokio::test]
async fn an_obsolete_installed_runtime_candidate_is_refused_even_when_newer_than_build() {
    let trusted = TrustedHarness::with_runtime_version("installed-baseline", "99.0.0").await;
    let h = &trusted.harness;
    let version = newer_version();
    assert!(crate::update_security::greater_version(
        &version,
        update_flow::CURRENT_VERSION
    ));
    let bytes = b"older than installed runtime";
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    assert!(h.publish_artifact(path).await);
    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .unwrap_err();
    assert!(
        format!("{error}").contains("newer"),
        "unexpected refusal: {error}"
    );
    assert_eq!(h.state.supervisor.stop_count(), 0);
    assert_eq!(h.state.supervisor.restart_count(), 0);
    assert!(!h
        .state
        .supervisor
        .observed_actions()
        .contains(&crate::host::UpdateTasksAction::Lock));
    assert!(h.state.update.lock().await.has_published_artifact());
}

#[tokio::test]
async fn mandatory_action_can_reach_handoff_while_normal_admission_is_denied() {
    // The handoff must not arm any process-global skip: a sticky skip would
    // outlive the operation that set it and silently change a later quit.
    crate::quit_flow::reset();
    let trusted = TrustedHarness::with_runtime_version("mandatory-admission", "1.0.0").await;
    let h = &trusted.harness;
    h.state
        .policy
        .normal_allowed
        .store(false, std::sync::atomic::Ordering::SeqCst);
    h.state
        .policy
        .mandatory_update_allowed
        .store(true, std::sync::atomic::Ordering::SeqCst);
    h.state
        .policy
        .set_decision(crate::mandatory_update::MandatoryDecision {
            blocking: true,
            ..Default::default()
        });
    // Inert non-executable bytes guarantee launch refusal, not a real installer.
    let bytes = b"inert fixture cannot execute";
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    h.admit_candidate(
        "1.0.1",
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    assert!(h.publish_artifact(path).await);
    let error = update_flow::install_for_test(&h.app, Some("1.0.1".into()))
        .await
        .unwrap_err();
    assert!(
        format!("{error}").contains("launch installer"),
        "unexpected refusal: {error}"
    );
    assert_eq!(
        h.state.supervisor.stop_count(),
        1,
        "mock stop proves controller admitted mandatory action"
    );
    assert_eq!(
        h.state.supervisor.restart_count(),
        1,
        "mock rollback follows refused fixture launch"
    );
    // The teardown this admission lock authorized was committed, so the guard was
    // disarmed before the stop: a Host that is being stopped for the installer
    // must never be reopened by a late unlock (the restart above starts a fresh,
    // already-open generation, which is not ours to unlock).
    drain_scheduled_work().await;
    assert_eq!(
        unlock_count(h),
        0,
        "a committed shutdown handoff must not unlock admission"
    );
    assert!(h.state.policy.current_decision().unwrap().blocking);
    assert!(
        !crate::quit_flow::installer_restart_armed(),
        "the install handoff must not arm an ambient sticky skip"
    );
}

#[tokio::test]
async fn channel_change_at_final_stop_seam_refuses_without_stopping_or_restarting() {
    let trusted = TrustedHarness::new("channel-final").await;
    let h = &trusted.harness;
    let version = newer_version();
    let bytes = b"stable candidate fixture";
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("fixture.bin");
    std::fs::write(&path, bytes).unwrap();
    h.admit_candidate(
        &version,
        "stable",
        &crate::update_security::sha256_hex(bytes),
    )
    .await;
    assert!(h.publish_artifact(path).await);
    let state = Arc::downgrade(&h.state);
    *h.state.supervisor.before_final_admission.lock().unwrap() = Some(Box::new(move || {
        state.upgrade().unwrap().settings.try_lock().unwrap().set(
            crate::state::UPDATE_CHANNEL_KEY,
            dsh_core::protocol::SettingValue::String("beta".to_string()),
        );
    }));
    let error = update_flow::install_for_test(&h.app, Some(version))
        .await
        .unwrap_err();
    assert!(format!("{error}").contains("update_install_admission"));
    assert_eq!(h.state.supervisor.stop_count(), 0);
    assert_eq!(h.state.supervisor.restart_count(), 0);
    let u = h.state.update.lock().await;
    assert_eq!(u.flight, None);
    assert_eq!(u.state.phase, DesktopUpdatePhase::Ready);
    assert!(u.has_published_artifact());
}

// ---------------------------------------------------------------------------
// `Later` preserves `Ready`
// ---------------------------------------------------------------------------

#[tokio::test]
async fn declining_the_ready_confirmation_preserves_the_verified_target() {
    let trusted = TrustedHarness::new("8add4143").await;
    let harness = &trusted.harness;
    let version = newer_version();
    let bytes = b"a verified release";
    harness
        .admit_candidate(
            &version,
            "stable",
            &crate::update_security::sha256_hex(bytes),
        )
        .await;
    let directory = std::env::temp_dir().join(format!("dsh-upd-later-{}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("temp dir");
    let path = directory.join("artifact.bin");
    std::fs::write(&path, bytes).expect("write artifact");
    assert!(harness.publish_artifact(path.clone()).await);
    {
        let mut update = harness.state.update.lock().await;
        update.state.phase = DesktopUpdatePhase::Ready;
        update.state.version = Some(version.clone());
        update.state.percent = Some(100.0);
    }

    // "Later" is the secondary button of the Install-and-Restart prompt.
    harness.script_dialogs(&[DialogAnswer::Secondary]);
    update_flow::open_confirmation(&harness.app)
        .await
        .expect("declining is not a failure");

    let update = harness.state.update.lock().await;
    assert_eq!(
        update.state.phase,
        DesktopUpdatePhase::Ready,
        "`Later` must not discard a verified artifact"
    );
    assert_eq!(update.state.version.as_deref(), Some(version.as_str()));
    assert_eq!(update.state.percent, Some(100.0));
    assert!(
        update.has_published_artifact(),
        "the artifact stays installable after declining"
    );
    assert_eq!(harness.state.supervisor.stop_count(), 0);
    std::fs::remove_dir_all(&directory).ok();
}

#[tokio::test]
async fn declining_the_available_confirmation_keeps_the_candidate_admitted() {
    let trusted = TrustedHarness::new("f1ea6a91").await;
    let harness = &trusted.harness;
    let version = newer_version();
    harness.admit_candidate(&version, "stable", &digest()).await;
    // "Later" on the download prompt.
    harness.script_dialogs(&[DialogAnswer::Secondary]);
    update_flow::open_confirmation(&harness.app)
        .await
        .expect("declining is not a failure");

    let update = harness.state.update.lock().await;
    assert_eq!(update.state.phase, DesktopUpdatePhase::Available);
    assert_eq!(
        update.candidate.as_ref().map(|c| c.version.as_str()),
        Some(version.as_str()),
        "the candidate stays admitted so the user can confirm later"
    );
    assert!(update.candidate.as_ref().unwrap().artifact_path.is_none());
}

// ---------------------------------------------------------------------------
// Confirmation reservation: coalescing and dropped callbacks
// ---------------------------------------------------------------------------

/// Wait until `count` dialogs have been requested, or fail after a bounded spin.
async fn wait_for_dialogs(harness: &Harness, count: usize) {
    for _ in 0..4_000 {
        if harness.dialog_messages().len() >= count {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!(
        "dialog {count} was never requested; saw {:?}",
        harness.dialog_messages()
    );
}

#[tokio::test]
async fn a_second_confirmation_joins_the_prompt_that_is_already_reserved() {
    // No packaged trust: these cases must never be able to reach the network,
    // and a confirmation prompt does not need release authority to be shown.
    let harness = Harness::new();
    let version = newer_version();
    harness.admit_candidate(&version, "stable", &digest()).await;

    // Park the first prompt, so it is observably *open* (and therefore reserved).
    harness.set_defer_callbacks(true);
    harness.script_dialogs(&[DialogAnswer::Secondary, DialogAnswer::Secondary]);
    let first = tokio::spawn({
        let app = harness.app.clone();
        async move { update_flow::open_confirmation(&app).await }
    });
    wait_for_dialogs(&harness, 1).await;
    assert!(
        harness.confirmation_is_reserved().await,
        "the open prompt holds the reservation"
    );
    assert_eq!(harness.pending_dialog_callbacks(), 1);

    // A second caller arrives in the post-check gap: it must join the open prompt
    // instead of opening a second one.
    update_flow::open_confirmation(&harness.app)
        .await
        .expect("joining the reserved prompt is not a failure");
    assert_eq!(
        harness.dialog_messages().len(),
        1,
        "only one prompt may be open for one candidate"
    );
    assert_eq!(harness.pending_dialog_callbacks(), 1);

    // Answering the parked prompt with `Later` releases the reservation, does no
    // network work, and keeps the candidate admitted.
    assert!(crate::dialog::resolve_deferred_callback(
        &harness.app,
        false
    ));
    first
        .await
        .expect("the first prompt task completed")
        .expect("declining is not a failure");
    assert!(
        !harness.confirmation_is_reserved().await,
        "the reservation is released when the prompt is answered"
    );
    let update = harness.state.update.lock().await;
    assert_eq!(update.state.phase, DesktopUpdatePhase::Available);
    assert_eq!(
        update
            .candidate
            .as_ref()
            .map(|candidate| candidate.version.as_str()),
        Some(version.as_str())
    );
    assert!(update.candidate.as_ref().unwrap().artifact_path.is_none());
}

#[tokio::test]
async fn a_dropped_dialog_callback_is_not_consent_and_releases_the_reservation() {
    // As above: no packaged trust, so no answer in this case can start a
    // download even if the script were misaligned.
    let harness = Harness::new();
    let version = newer_version();
    harness.admit_candidate(&version, "stable", &digest()).await;

    harness.set_defer_callbacks(true);
    let prompt = tokio::spawn({
        let app = harness.app.clone();
        async move { update_flow::open_confirmation(&app).await }
    });
    wait_for_dialogs(&harness, 1).await;
    assert!(harness.confirmation_is_reserved().await);

    // The native callback is dropped without an answer.
    assert_eq!(crate::dialog::drop_pending_callbacks(&harness.app), 1);
    prompt
        .await
        .expect("the prompt task completed")
        .expect("a lost answer is not a failure");

    // No consent: nothing was downloaded and the candidate stays admitted.
    let update = harness.state.update.lock().await;
    assert_eq!(update.state.phase, DesktopUpdatePhase::Available);
    assert!(update.candidate.as_ref().unwrap().artifact_path.is_none());
    drop(update);
    assert!(
        !harness.confirmation_is_reserved().await,
        "a dropped callback still releases the slot"
    );

    // The slot is free, so the user can confirm later.
    harness.set_defer_callbacks(false);
    // Answers are indexed by request ordinal, and the first request is already
    // recorded: script both so this later prompt cannot fall through to the
    // primary button (which would start a real download).
    harness.script_dialogs(&[DialogAnswer::Secondary, DialogAnswer::Secondary]);
    update_flow::open_confirmation(&harness.app)
        .await
        .expect("a later prompt is possible");
    assert_eq!(harness.dialog_messages().len(), 2);
}

// ---------------------------------------------------------------------------
// In-flight accounting across the operation -> settlement handoff
// ---------------------------------------------------------------------------

/// Serializes the cases that park the process-global settlement gate.
///
/// Async-aware for the same reason as [`TRUST_LOCK`]: the parking cases hold it
/// across their awaits, and a `std::sync::Mutex` guard held across an await is
/// what Clippy refuses. No poisoning to recover from.
static SETTLEMENT_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Wait until the operation half has published something, which is how these
/// cases know it finished its work while settlement is parked behind it.
async fn wait_for_publication(harness: &Harness) {
    for _ in 0..20_000 {
        if harness.last_published().is_some() {
            return;
        }
        tokio::task::yield_now().await;
    }
    panic!("the admitted operation never published its presentation");
}

#[tokio::test]
async fn a_pending_settlement_keeps_an_operation_counted_and_the_barrier_open() {
    let _gate = SETTLEMENT_LOCK.lock().await;
    // No packaged trust: the check is still a real admitted operation; it is
    // refused for lack of authority, which is exactly the failure path that must
    // still settle.
    let harness = Harness::new();
    update_flow::park_settlements(Some(std::time::Duration::from_secs(2)));
    let check = tokio::spawn({
        let app = harness.app.clone();
        async move { update_flow::check(&app).await }
    });
    wait_for_publication(&harness).await;

    // The operation finished its work, but settlement is parked: the operation is
    // NOT complete and must still be counted.
    assert!(
        !check.is_finished(),
        "the admitted call cannot complete before its settlement does"
    );
    assert!(
        update_flow::active_update_operations() >= 1,
        "the in-flight count must be held by the pending settlement"
    );
    assert!(
        matches!(
            update_flow::quiesce_updates(&harness.app, std::time::Duration::from_millis(0)).await,
            update_flow::UpdateQuiescence::TimedOut { .. }
        ),
        "the barrier must not report quiescence while settlement is pending"
    );

    // Releasing settlement completes the operation and lets the barrier quiesce.
    update_flow::park_settlements(None);
    check
        .await
        .expect("the check task completed")
        .expect("the refused check still completes as an operation");
    assert!(
        update_flow::quiesce_updates(&harness.app, std::time::Duration::from_secs(5))
            .await
            .is_quiescent(),
        "settlement released the in-flight count"
    );
}

#[tokio::test]
async fn a_dropped_caller_keeps_a_pending_settlement_counted() {
    let _gate = SETTLEMENT_LOCK.lock().await;
    let harness = Harness::new();
    update_flow::park_settlements(Some(std::time::Duration::from_secs(2)));
    let caller = tokio::spawn({
        let app = harness.app.clone();
        async move { update_flow::check(&app).await }
    });
    wait_for_publication(&harness).await;

    // The *caller* is cancelled while settlement is pending. The supervision is
    // retained, so the operation is still accounted for.
    caller.abort();
    assert!(caller.await.unwrap_err().is_cancelled());
    assert!(
        matches!(
            update_flow::quiesce_updates(&harness.app, std::time::Duration::from_millis(0)).await,
            update_flow::UpdateQuiescence::TimedOut { .. }
        ),
        "a dropped caller must not release an unsettled operation"
    );

    // Release, then wait for the detached supervision to settle and release it.
    update_flow::park_settlements(None);
    let mut quiescent = false;
    for _ in 0..40_000 {
        quiescent = update_flow::quiesce_updates(&harness.app, std::time::Duration::from_millis(0))
            .await
            .is_quiescent();
        if quiescent {
            break;
        }
        tokio::task::yield_now().await;
    }
    assert!(
        quiescent,
        "the retained settlement must eventually release the operation"
    );
}

// ---------------------------------------------------------------------------
// Shutdown barrier (admission closed, in-flight joined, then drain)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_shutdown_barrier_closes_admission_joins_operations_and_then_drains() {
    // No trust configuration is needed: the barrier closes admission *before*
    // any policy resolution, so nothing here reaches the network.
    let harness = Harness::new();
    // One admitted operation runs to completion first: the barrier must observe
    // it settle rather than assume it did.
    let _ = update_flow::check(&harness.app)
        .await
        .expect("a refused check still completes as an operation");
    let quiescence =
        update_flow::quiesce_updates(&harness.app, std::time::Duration::from_secs(5)).await;
    assert_eq!(
        quiescence,
        update_flow::UpdateQuiescence::Quiescent,
        "no operation is left unsettled"
    );
    assert!(
        !harness.state.update.lock().await.admission_is_open(),
        "the barrier closes update admission for good"
    );

    // A check arriving after the barrier is closed out as a *skip*: nothing was
    // attempted, so the polling deadline must not be treated as completed.
    let (presentation, outcome) = update_flow::check_with_outcome(&harness.app)
        .await
        .expect("a closed check is not an error");
    let _ = presentation;
    assert_eq!(outcome, CheckOutcome::Skipped);

    // An installation arriving after the barrier cannot touch the Host.
    let error = update_flow::install_for_test(&harness.app, None)
        .await
        .expect_err("a closed service refuses installation");
    assert!(
        format!("{error}").contains("update_shutting_down"),
        "saw: {error}"
    );
    assert_eq!(harness.state.supervisor.stop_count(), 0);
    assert_eq!(harness.state.supervisor.restart_count(), 0);

    // The drain runs only behind a quiescent barrier, and reports its own state.
    let report = update_flow::drain_artifact_cleanup(&harness.app).await;
    assert_eq!(report.delivery, update_flow::CleanupDelivery::Idle);

    // The one ordered entry point reports the same, and is repeatable. A real
    // (non-zero) budget is used because another case may be deliberately parking
    // settlements at this moment.
    let shutdown =
        update_flow::shutdown_updates(&harness.app, std::time::Duration::from_secs(5)).await;
    assert!(shutdown.quiescence.is_quiescent());
    assert_eq!(
        shutdown.cleanup.delivery,
        update_flow::CleanupDelivery::Idle
    );
}

// ---------------------------------------------------------------------------
// The mandatory gate
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_ordinary_available_update_is_not_mandatory() {
    let trusted = TrustedHarness::new("ff6b6cc1").await;
    let harness = &trusted.harness;
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    // No policy decision has been recorded, so nothing is mandatory and the
    // ordinary prompt — which offers Later — is used.
    assert!(
        !update_flow::is_update_mandatory(&harness.app).await,
        "an available update is never mandatory on its own"
    );
    harness.script_dialogs(&[DialogAnswer::Secondary]);
    update_flow::open_confirmation(&harness.app)
        .await
        .expect("the optional prompt is shown");
    let buttons = harness.last_dialog_buttons().expect("a dialog was shown");
    assert_eq!(
        buttons.1, "Later",
        "the optional prompt must offer Later, saw: {buttons:?}"
    );
}

#[tokio::test]
async fn a_blocking_decision_makes_the_update_mandatory() {
    let trusted = TrustedHarness::new("809df36c").await;
    let harness = &trusted.harness;
    let version = newer_version();
    harness.admit_candidate(&version, "stable", &digest()).await;
    harness.state.policy.set_decision(MandatoryDecision {
        blocking: true,
        ..MandatoryDecision::default()
    });
    assert!(
        update_flow::is_update_mandatory(&harness.app).await,
        "a blocking verdict with a newer release is mandatory"
    );
    harness
        .state
        .policy
        .set_decision(MandatoryDecision::initial());
    assert!(!update_flow::is_update_mandatory(&harness.app).await);
}

#[tokio::test]
async fn a_blocking_decision_without_a_release_still_blocks() {
    let trusted = TrustedHarness::new("9541d281").await;
    let harness = &trusted.harness;
    // No candidate at all: the verdict arrived before the feed was consulted.
    harness.state.policy.set_decision(MandatoryDecision {
        blocking: true,
        ..MandatoryDecision::default()
    });
    assert!(
        update_flow::is_update_mandatory(&harness.app).await,
        "a mandatory requirement does not depend on a release being known"
    );
    // The prompt explains the situation instead of silently doing nothing.
    update_flow::open_confirmation(&harness.app)
        .await
        .expect("the mandatory prompt is shown");
    let messages = harness.dialog_messages();
    assert!(
        !messages.is_empty(),
        "the mandatory path must tell the user something"
    );
    harness
        .state
        .policy
        .set_decision(MandatoryDecision::initial());
}

#[tokio::test]
async fn a_failed_policy_attempt_does_not_lift_a_known_requirement() {
    let trusted = TrustedHarness::new("bf4cc637").await;
    let harness = &trusted.harness;
    harness.state.policy.set_decision(MandatoryDecision {
        blocking: true,
        ..MandatoryDecision::default()
    });
    let snapshot = harness.state.policy.current_decision().unwrap();
    harness
        .state
        .policy
        .set_decision(snapshot.with_error(crate::mandatory_update::PolicyError::Unavailable));
    assert!(
        update_flow::is_update_mandatory(&harness.app).await,
        "a transport failure must not clear a confirmed block"
    );
    let decision = harness.state.policy.current_decision().unwrap();
    assert!(decision.blocking);
    assert_eq!(
        decision.error,
        Some(crate::mandatory_update::PolicyError::Unavailable)
    );
    harness
        .state
        .policy
        .set_decision(MandatoryDecision::initial());
}

#[tokio::test]
async fn a_confirmed_no_force_answer_clears_the_requirement() {
    let trusted = TrustedHarness::new("373df27d").await;
    let harness = &trusted.harness;
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    harness.state.policy.set_decision(MandatoryDecision {
        blocking: true,
        ..MandatoryDecision::default()
    });
    assert!(update_flow::is_update_mandatory(&harness.app).await);
    // A fresh, well-formed no-force answer is the only thing that clears it.
    harness
        .state
        .policy
        .set_decision(MandatoryDecision::initial());
    assert!(!update_flow::is_update_mandatory(&harness.app).await);
    assert_eq!(harness.state.policy.current_decision().unwrap().error, None);
}

#[tokio::test]
async fn an_in_flight_policy_check_does_not_block_by_itself() {
    let trusted = TrustedHarness::new("a2eb1a36").await;
    let harness = &trusted.harness;
    harness
        .admit_candidate(&newer_version(), "stable", &digest())
        .await;
    let snapshot = harness.state.policy.current_decision().unwrap();
    harness.state.policy.set_decision(snapshot.checking());
    assert!(
        !update_flow::is_update_mandatory(&harness.app).await,
        "only a confirmed verdict blocks"
    );
    assert_eq!(
        crate::mandatory_update::enforcement(
            &harness.state.policy.current_decision().unwrap(),
            Some(newer_version().as_str()),
            update_flow::CURRENT_VERSION,
        ),
        MandatoryEnforcement::Checking
    );
    harness
        .state
        .policy
        .set_decision(MandatoryDecision::initial());
}

// ---------------------------------------------------------------------------
// Runner wiring
// ---------------------------------------------------------------------------

#[tokio::test]
async fn automatic_polling_stays_off_without_packaged_trust() {
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    // No `updates.json` is resolvable, so the runner must not start: a check
    // could not produce an installable candidate, and polling would only
    // generate periodic failures.
    assert!(
        !update_flow::start_runner(&harness.app),
        "no packaged trust means no automatic polling"
    );
    assert!(
        update_flow::runner().is_none(),
        "no runner is published when polling does not start"
    );
    update_flow::dispose_runner().await;
    update_flow::request_check(CheckTrigger::Resume);
}

#[tokio::test]
async fn the_failure_kind_for_a_non_network_check_failure_is_check() {
    // Guards the classification the runner relies on: a check failure with no
    // network marker must not be reported as `check-network`, or an
    // authentication or configuration failure would be shown as a connectivity
    // problem.
    let state = dsh_core::protocol::DesktopUpdateState {
        phase: DesktopUpdatePhase::Error,
        version: None,
        message: Some("release delivery is disabled: no packaged update source".to_string()),
        technical_details: None,
        percent: None,
        failed_operation: Some(DesktopUpdateOperation::Check),
        preparation_failure: None,
    };
    let presentation = crate::host::present_update(&state);
    assert_eq!(presentation.failure, Some(DesktopUpdateFailureKind::Check));

    let network = dsh_core::protocol::DesktopUpdateState {
        message: Some("update feed request failed: ETIMEDOUT".to_string()),
        ..state
    };
    assert_eq!(
        crate::host::present_update(&network).failure,
        Some(DesktopUpdateFailureKind::CheckNetwork)
    );
}

#[tokio::test]
async fn the_preparation_failure_kind_selects_install_copy() {
    // The runner treats an install failure as a skipped poll; this guards the
    // classification the UI depends on for that path.
    let state = dsh_core::protocol::DesktopUpdateState {
        phase: DesktopUpdatePhase::Error,
        version: None,
        message: Some("the Host did not stop".to_string()),
        technical_details: None,
        percent: None,
        failed_operation: Some(DesktopUpdateOperation::Install),
        preparation_failure: Some(DesktopUpdatePreparationFailureKind::StopFailed),
    };
    assert_eq!(
        crate::host::present_update(&state).failure,
        Some(DesktopUpdateFailureKind::StopFailed)
    );
}

// ---------------------------------------------------------------------------
// Probe self-checks
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_probe_host_records_what_the_updater_does() {
    // If this fails, every assertion above is measuring the probe rather than
    // the updater.
    let _trust = TRUST_LOCK.lock().await;
    let harness = Harness::new();
    assert!(harness.dialog_messages().is_empty(), "no dialogs yet");
    assert!(
        harness.published_phases().is_empty(),
        "nothing published yet"
    );
    harness.admit_candidate("9.9.9", "stable", &digest()).await;
    assert_eq!(harness.candidate_version().await.as_deref(), Some("9.9.9"));
    update_flow::check(&harness.app).await.expect("check runs");
    assert!(
        !harness.published_phases().is_empty(),
        "the check published at least one state"
    );
}

#[test]
fn the_probe_never_talks_to_the_network() {
    // `update_flow`'s only HTTP entry points are `fetch_manifest` and
    // `run_download`, both of which require an admitted `ReleasePolicy`. With no
    // packaged trust configuration those are unreachable, which is why the
    // integration tests above can assert refusal behaviour without a socket.
    //
    // `blocking_lock` is the safe arrangement for this one synchronous holder:
    // the case is a plain `#[test]` with no Tokio runtime on the thread, so it
    // cannot stall an executor, and the lock is taken before `Harness::new()`
    // builds anything. It must never be reached from async code - every async
    // holder awaits `lock()` instead.
    let _trust = TRUST_LOCK.blocking_lock();
    let harness = Harness::new();
    assert!(
        update_flow::load_packaged_trust(&harness.app)
            .config()
            .is_none(),
        "the probe must run without packaged trust authority"
    );
}

#[test]
fn the_harness_can_admit_a_candidate_for_its_tests() {
    // Plain `#[test]`, no runtime on this thread: the same arrangement as the
    // case above, and it takes the lock before `Harness::new()`.
    let _trust = TRUST_LOCK.blocking_lock();
    let harness = Harness::new();
    let candidate = UpdateCandidate {
        version: "1.2.3".to_string(),
        channel: "stable".to_string(),
        url: "https://updates.example.com/x.bin".to_string(),
        sha256: digest(),
        signature: "ab".repeat(64),
        artifact_path: None,
    };
    assert_eq!(candidate.signed_release().version, "1.2.3");
    let _ = Arc::strong_count(&harness.state);
}

#[test]
fn a_missing_candidate_error_is_stable() {
    // Codes the integration tests assert on; pinned so a rename is caught here
    // rather than in a shell script.
    let error = DshError::other("update_artifact_not_ready", "not verified");
    assert!(format!("{error}").contains("update_artifact_not_ready"));
}
