//! The quit model: when to ask, the three localized explanations, fail-closed
//! behaviour, the skip rules (`apps/desktop/src/quit-confirmation.ts`,
//! `apps/desktop/README.md` "Closing the window and quitting"), and the bounded
//! policy that applies when the Host could not be stopped.
//!
//! Decision table (one ordinary quit decision):
//!
//! | Condition | Outcome |
//! |---|---|
//! | A skip rule is bound to the attempt (installer restart, fatal-recovery exit, dev Restart, OS shutdown/restart/logoff) | quit silently |
//! | Host has not started yet, or is fully `stopped` | quit silently |
//! | Host has `failed` (cannot run tasks) | quit silently |
//! | Host is `stopping` and its stop has not been confirmed complete | ask, "Running tasks will be interrupted." |
//! | Inspection answered nothing interruptible (both facts false) | quit silently |
//! | Inspection reports active tasks | ask, "Running tasks will be interrupted." |
//! | Inspection reports armed scheduled reminders | ask, "Scheduled tasks will not run while the app is closed." |
//! | Inspection reports both | ask, combined explanation |
//! | Inspection failed, or missed the 2-second deadline (**fail closed**) | ask, running-tasks explanation |
//!
//! A `stopping` Host is **not** the same fact as a stopped one: the supervisor
//! reaches `Stopping` before it has reaped the tree, so a failed or in-flight
//! stop leaves the state there while the Host tree may still be alive and able
//! to run work. [`QuitHostState::Stopping`] therefore fails closed onto the
//! running-tasks explanation instead of assuming the Host cannot work, and
//! [`stop_is_resolved`] refuses to treat such a state as a completed teardown.
//!
//! Concurrency: one decision at a time — repeated quit requests join the open
//! confirmation (and focus it) instead of stacking. Every attempt is claimed as
//! a [`QuitAttempt`] carrying its own generation and skip rule, so cleanup is
//! generation-safe: a late release, confirmation or supersede from an older
//! attempt can never reset or consume a newer one. A terminal quit (installer,
//! fatal recovery, dev Restart, OS shutdown) supersedes any pending ordinary
//! decision; late inspection results and dialog answers cannot open another
//! confirmation.

use crate::protocol::{QuitInspection, QuitReason, RuntimeState};

/// Deadline of one quit inspection (upstream `QUIT_INSPECTION_DEADLINE_MS`).
/// A slower Host counts as unknown work and the shell asks before quitting.
pub const QUIT_INSPECTION_DEADLINE_MS: u64 = 2_000;

/// Locale key of the explanation shown before quitting, or none when quitting
/// interrupts nothing (upstream `DesktopQuitPrompt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitPrompt {
    ActiveTasks,
    ScheduledTasks,
    ActiveAndScheduledTasks,
}

/// A quit inspection outcome. `Unknown` covers inspection failure and the
/// deadline miss.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitInspectionOutcome {
    /// The Host answered.
    Answered(QuitInspection),
    /// Inspection failed or missed {@link QUIT_INSPECTION_DEADLINE_MS}.
    Unknown,
}

/// Choose the confirmation copy for one inspection result
/// (upstream `resolveDesktopQuitPrompt`). An unknown state warns about running
/// tasks rather than quitting silently.
pub fn resolve_quit_prompt(outcome: &QuitInspectionOutcome) -> Option<QuitPrompt> {
    let facts = match outcome {
        QuitInspectionOutcome::Unknown => return Some(QuitPrompt::ActiveTasks),
        QuitInspectionOutcome::Answered(facts) => facts,
    };
    if facts.active_tasks && facts.scheduled_tasks {
        Some(QuitPrompt::ActiveAndScheduledTasks)
    } else if facts.active_tasks {
        Some(QuitPrompt::ActiveTasks)
    } else if facts.scheduled_tasks {
        Some(QuitPrompt::ScheduledTasks)
    } else {
        None
    }
}

/// Why a quit skips the confirmation (upstream skip rules).
///
/// The rule travels with the attempt that consumes it (see [`QuitFlow`]); there
/// is no process-wide armed state a later, unrelated quit could inherit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitSkip {
    /// The installer restart already confirmed task interruption.
    InstallerRestart,
    /// The fatal-recovery dialog exits or restarts.
    FatalRecoveryExit,
    /// The development "Restart App and Host" command runs.
    DevRestart,
    /// Operating-system shutdown, restart, or log-off.
    OsShutdown,
}

impl QuitSkip {
    /// Terminal `dsh://shell/quit-confirmed` reason for this skip.
    pub fn quit_reason(self) -> QuitReason {
        match self {
            QuitSkip::InstallerRestart => QuitReason::Installer,
            QuitSkip::FatalRecoveryExit => QuitReason::FatalRecovery,
            QuitSkip::DevRestart => QuitReason::User,
            QuitSkip::OsShutdown => QuitReason::OsShutdown,
        }
    }
}

/// The Host's availability as it bears on quitting.
///
/// `Starting` and `Stopped` cannot run tasks. `Stopping` is kept distinct
/// because it means a stop was *requested*, not confirmed: the tree may still
/// be alive, so a quit must not treat it as an idle Host.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitHostState {
    /// Not `ready` yet or already `stopped` — nothing can be running.
    NotRunning,
    /// A stop is in flight and unconfirmed; the Host tree may still run work.
    Stopping,
    /// Failed — cannot run tasks.
    Failed,
    /// Serving; inspection decides.
    Ready,
}

impl QuitHostState {
    /// Derive the quit-time host state from the supervisor state machine.
    pub fn from_runtime_state(state: RuntimeState) -> Self {
        match state {
            RuntimeState::Ready => QuitHostState::Ready,
            RuntimeState::Failed => QuitHostState::Failed,
            RuntimeState::Stopping => QuitHostState::Stopping,
            RuntimeState::Starting | RuntimeState::Stopped => QuitHostState::NotRunning,
        }
    }
}

/// Whether a supervisor that reported a completed stop is confirmed to have no
/// Host generation left that could still run work.
///
/// `Stopping` (and a still-`Starting` or serving state) is an unresolved
/// teardown: the supervisor returned without reaching a state that proves the
/// tree is gone, so a quit or restart must not be treated as safe on it.
pub fn stop_is_resolved(state: RuntimeState) -> bool {
    matches!(state, RuntimeState::Stopped | RuntimeState::Failed)
}

/// The entry that observed an unresolved Host teardown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitEntry {
    /// An ordinary or terminal quit.
    Quit,
    /// A restart ("Restart App and Host", update or fatal recovery).
    Restart,
}

/// The bounded decision after a Host teardown that did not resolve.
///
/// There is deliberately **no restart variant**: while a Host may survive, no
/// user consent can authorize launching a second one over it. The entries
/// differ only in what an explicit consent downgrades to (`ExitAnyway` is the
/// exit a quit already wanted, and the exit a restart falls back to).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SurvivorPolicy {
    /// Keep the application running with the failure visible.
    Stay,
    /// Exit without a second stop attempt, on the user's explicit consent.
    ExitAnyway,
}

/// Decide what an entry may do after a Host teardown that did not resolve.
///
/// When the Host survives, restart is never authorized: `consent` can only
/// choose between staying and exiting.
pub fn decide_after_unresolved_stop(entry: QuitEntry, consent: bool) -> SurvivorPolicy {
    match (entry, consent) {
        (_, false) => SurvivorPolicy::Stay,
        (QuitEntry::Quit | QuitEntry::Restart, true) => SurvivorPolicy::ExitAnyway,
    }
}

/// The decision one ordinary quit entry produces.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum QuitAction {
    /// Quit now without asking; carries the terminal reason.
    Proceed(QuitReason),
    /// Show the native confirmation with this explanation first.
    Ask(QuitPrompt),
}

/// Decide one quit (pure decision table above).
pub fn decide_quit(
    skip: Option<QuitSkip>,
    host: QuitHostState,
    outcome: &QuitInspectionOutcome,
) -> QuitAction {
    if let Some(skip) = skip {
        return QuitAction::Proceed(skip.quit_reason());
    }
    match host {
        QuitHostState::NotRunning | QuitHostState::Failed => QuitAction::Proceed(QuitReason::User),
        // The stop is unconfirmed: ask rather than assume the Host cannot work.
        QuitHostState::Stopping => QuitAction::Ask(QuitPrompt::ActiveTasks),
        QuitHostState::Ready => match resolve_quit_prompt(outcome) {
            None => QuitAction::Proceed(QuitReason::User),
            Some(prompt) => QuitAction::Ask(prompt),
        },
    }
}

/// Lifecycle of one quit decision window; concurrent quit requests join the
/// open confirmation instead of stacking a second one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitFlowState {
    Idle,
    /// Inspection and/or the confirmation dialog is open.
    Deciding,
    /// The application is quitting through a path that does not ask.
    Bypassed,
}

/// One claimed quit attempt: its generation and the skip rule (if any) that
/// belongs to *this* attempt alone.
///
/// The value is the attempt's only identity. Cleanup, confirmation and
/// supersede all present it back, so a late caller cannot act on a newer
/// attempt, and the skip is consumed by the decision of the attempt that owns
/// it instead of by ambient process state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct QuitAttempt {
    generation: u64,
    skip: Option<QuitSkip>,
}

impl QuitAttempt {
    /// The attempt's generation; cleanup is refused for any other generation.
    pub fn generation(self) -> u64 {
        self.generation
    }

    /// The skip rule bound to this attempt (consumed by its decision).
    pub fn skip(self) -> Option<QuitSkip> {
        self.skip
    }
}

/// What a new `request()` does under the current flow state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitRequest {
    /// The caller runs the decision (inspection + possible dialog) for this
    /// attempt. The skip rule used by the decision is carried here.
    Start(QuitAttempt),
    /// A decision is already open: focus it instead of stacking (K: "another
    /// quit request joins it instead of stacking a second one"). The open
    /// attempt keeps its own skip; a joiner inherits nothing.
    Join,
    /// The application already left through a bypassing quit.
    Ignored,
}

/// The quit model's concurrency, generation and bypass state.
#[derive(Debug, Default)]
pub struct QuitFlow {
    state: Option<QuitFlowState>,
    generation: u64,
    attempt: Option<QuitAttempt>,
}

impl QuitFlow {
    /// Fresh flow with no decision open.
    pub fn new() -> Self {
        Self::default()
    }

    /// Current flow state.
    pub fn state(&self) -> QuitFlowState {
        self.state.unwrap_or(QuitFlowState::Idle)
    }

    /// The attempt that currently owns the flow, if any.
    pub fn attempt(&self) -> Option<QuitAttempt> {
        self.attempt
    }

    /// One ordinary quit entrypoint, claiming a fresh attempt that carries
    /// `skip`.
    pub fn request(&mut self, skip: Option<QuitSkip>) -> QuitRequest {
        match self.state() {
            QuitFlowState::Idle => {
                self.state = Some(QuitFlowState::Deciding);
                QuitRequest::Start(self.claim(skip))
            }
            QuitFlowState::Deciding => QuitRequest::Join,
            QuitFlowState::Bypassed => QuitRequest::Ignored,
        }
    }

    /// Mint the next attempt and make it the flow's owner.
    ///
    /// `wrapping_add` is exact here: an attempt's identity is compared against
    /// the flow's *current* generation only, so a repeat would need 2^64
    /// attempts within one process lifetime.
    fn claim(&mut self, skip: Option<QuitSkip>) -> QuitAttempt {
        self.generation = self.generation.wrapping_add(1);
        let attempt = QuitAttempt {
            generation: self.generation,
            skip,
        };
        self.attempt = Some(attempt);
        attempt
    }

    /// Whether `attempt` is still the attempt that owns this flow.
    pub fn owns(&self, attempt: QuitAttempt) -> bool {
        self.state() != QuitFlowState::Idle
            && self
                .attempt
                .is_some_and(|current| current.generation == attempt.generation)
    }

    /// Release one attempt (finished, cancelled, or failed); the flow reopens
    /// for the next ordinary quit request and the attempt's skip rule is
    /// revoked with it.
    ///
    /// Generation-safe cleanup: a late release from an older attempt — the
    /// panic path or a superseded caller — is refused and cannot reset the
    /// flow a newer attempt now owns. Returns whether this call released it.
    pub fn release(&mut self, attempt: QuitAttempt) -> bool {
        if !self.owns(attempt) {
            return false;
        }
        self.attempt = None;
        self.state = Some(QuitFlowState::Idle);
        true
    }

    /// Apply a dialog answer only to a still-owned ordinary decision. A bypass
    /// or a newer attempt invalidates pending answers.
    ///
    /// `Some(claim)` means an affirmative answer committed the terminal bypass
    /// and the caller must begin shutdown: `claim` is that bypass's own attempt,
    /// so a terminal shutdown which does not resolve can release exactly it and
    /// leave Quit available again. `None` means the answer was refused (the
    /// flow reopens) or the decision was already superseded.
    pub fn resolve_confirmation(
        &mut self,
        attempt: QuitAttempt,
        confirmed: bool,
    ) -> Option<QuitAttempt> {
        if !self.owns(attempt) {
            return None;
        }
        if confirmed {
            Some(self.bypass(QuitReason::User))
        } else {
            self.release(attempt);
            None
        }
    }

    /// A quit that does not ask (installer, fatal recovery, dev restart, OS
    /// shutdown). Cancels any pending ordinary decision — late inspection
    /// results and dialog answers cannot open another confirmation — and
    /// returns the claimed attempt so a failed teardown can release exactly
    /// this generation and leave Quit available again.
    pub fn bypass(&mut self, reason: QuitReason) -> QuitAttempt {
        let _ = reason;
        self.state = Some(QuitFlowState::Bypassed);
        self.claim(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts(active: bool, scheduled: bool) -> QuitInspectionOutcome {
        QuitInspectionOutcome::Answered(QuitInspection {
            active_tasks: active,
            scheduled_tasks: scheduled,
            error: None,
        })
    }

    /// A started attempt, or a failed test assertion.
    fn start(flow: &mut QuitFlow, skip: Option<QuitSkip>) -> QuitAttempt {
        match flow.request(skip) {
            QuitRequest::Start(attempt) => attempt,
            other => panic!("expected a started attempt, got {other:?}"),
        }
    }

    #[test]
    fn decision_table_covers_every_row() {
        use QuitAction::*;
        use QuitPrompt::*;
        // Nothing interruptible → quit silently.
        assert_eq!(
            decide_quit(None, QuitHostState::Ready, &facts(false, false)),
            Proceed(QuitReason::User)
        );
        // The three explanations.
        assert_eq!(
            decide_quit(None, QuitHostState::Ready, &facts(true, false)),
            Ask(ActiveTasks)
        );
        assert_eq!(
            decide_quit(None, QuitHostState::Ready, &facts(false, true)),
            Ask(ScheduledTasks)
        );
        assert_eq!(
            decide_quit(None, QuitHostState::Ready, &facts(true, true)),
            Ask(ActiveAndScheduledTasks)
        );
        // Fail closed: inspection failure or deadline miss asks about running tasks.
        assert_eq!(
            decide_quit(None, QuitHostState::Ready, &QuitInspectionOutcome::Unknown),
            Ask(ActiveTasks)
        );
        // A Host error field still fails closed through the reported facts.
        let errored = QuitInspectionOutcome::Answered(QuitInspection {
            active_tasks: true,
            scheduled_tasks: false,
            error: Some("desktop quit: Host is stopping".into()),
        });
        assert_eq!(
            decide_quit(None, QuitHostState::Ready, &errored),
            Ask(ActiveTasks)
        );
        // Host not started or failed cannot run tasks → quit silently.
        assert_eq!(
            decide_quit(None, QuitHostState::NotRunning, &facts(true, true)),
            Proceed(QuitReason::User)
        );
        assert_eq!(
            decide_quit(None, QuitHostState::Failed, &QuitInspectionOutcome::Unknown),
            Proceed(QuitReason::User)
        );
    }

    #[test]
    fn an_unconfirmed_stop_never_quits_silently() {
        // `Stopping` is a requested stop, not a completed one: the tree may
        // still run work, so even an inspection that reports nothing
        // interruptible must not become a silent quit.
        assert_eq!(
            decide_quit(None, QuitHostState::Stopping, &facts(false, false)),
            QuitAction::Ask(QuitPrompt::ActiveTasks)
        );
        assert_eq!(
            decide_quit(
                None,
                QuitHostState::Stopping,
                &QuitInspectionOutcome::Unknown
            ),
            QuitAction::Ask(QuitPrompt::ActiveTasks)
        );
    }

    #[test]
    fn every_skip_rule_quits_silently_with_its_reason() {
        for (skip, reason) in [
            (QuitSkip::InstallerRestart, QuitReason::Installer),
            (QuitSkip::FatalRecoveryExit, QuitReason::FatalRecovery),
            (QuitSkip::DevRestart, QuitReason::User),
            (QuitSkip::OsShutdown, QuitReason::OsShutdown),
        ] {
            // Even with active work, an unknown inspection, or an unconfirmed
            // stop, a skip proceeds.
            for host in [
                QuitHostState::Ready,
                QuitHostState::Stopping,
                QuitHostState::NotRunning,
            ] {
                assert_eq!(
                    decide_quit(Some(skip), host, &QuitInspectionOutcome::Unknown),
                    QuitAction::Proceed(reason)
                );
            }
        }
    }

    #[test]
    fn unknown_prompt_maps_to_running_tasks() {
        assert_eq!(
            resolve_quit_prompt(&QuitInspectionOutcome::Unknown),
            Some(QuitPrompt::ActiveTasks)
        );
    }

    #[test]
    fn host_state_derivation_distinguishes_stopping_from_stopped() {
        assert_eq!(
            QuitHostState::from_runtime_state(RuntimeState::Ready),
            QuitHostState::Ready
        );
        assert_eq!(
            QuitHostState::from_runtime_state(RuntimeState::Failed),
            QuitHostState::Failed
        );
        assert_eq!(
            QuitHostState::from_runtime_state(RuntimeState::Stopping),
            QuitHostState::Stopping,
            "a stop in flight is not an idle Host"
        );
        for state in [RuntimeState::Starting, RuntimeState::Stopped] {
            assert_eq!(
                QuitHostState::from_runtime_state(state),
                QuitHostState::NotRunning
            );
        }
    }

    #[test]
    fn only_a_stopped_or_failed_supervisor_proves_the_teardown_resolved() {
        assert!(stop_is_resolved(RuntimeState::Stopped));
        assert!(stop_is_resolved(RuntimeState::Failed));
        for unresolved in [
            RuntimeState::Starting,
            RuntimeState::Stopping,
            RuntimeState::Ready,
        ] {
            assert!(
                !stop_is_resolved(unresolved),
                "{unresolved:?} does not prove the Host tree is gone"
            );
        }
    }

    #[test]
    fn a_surviving_host_can_never_authorize_a_restart() {
        // The return type has no restart variant, so every combination of entry
        // and consent is either staying or an explicit exit.
        for entry in [QuitEntry::Quit, QuitEntry::Restart] {
            for consent in [false, true] {
                let policy = decide_after_unresolved_stop(entry, consent);
                assert_eq!(
                    policy,
                    if consent {
                        SurvivorPolicy::ExitAnyway
                    } else {
                        SurvivorPolicy::Stay
                    }
                );
                assert!(matches!(
                    policy,
                    SurvivorPolicy::Stay | SurvivorPolicy::ExitAnyway
                ));
            }
        }
        // Consent is what turns staying into exiting; without it nothing moves.
        assert_eq!(
            decide_after_unresolved_stop(QuitEntry::Restart, false),
            SurvivorPolicy::Stay
        );
    }

    #[test]
    fn a_started_attempt_carries_its_own_skip_and_a_joiner_inherits_nothing() {
        let mut flow = QuitFlow::new();
        let attempt = start(&mut flow, Some(QuitSkip::InstallerRestart));
        assert_eq!(attempt.skip(), Some(QuitSkip::InstallerRestart));
        // A concurrent request joins the open decision: it is handed no attempt
        // and therefore cannot consume or re-arm the bound skip.
        assert_eq!(flow.request(Some(QuitSkip::OsShutdown)), QuitRequest::Join);
        assert_eq!(flow.attempt(), Some(attempt));
        assert_eq!(
            flow.attempt().and_then(|current| current.skip()),
            Some(QuitSkip::InstallerRestart),
            "the join must not replace the owning attempt's rule"
        );
    }

    #[test]
    fn releasing_an_attempt_revokes_its_skip_and_the_next_attempt_is_a_new_generation() {
        let mut flow = QuitFlow::new();
        let first = start(&mut flow, Some(QuitSkip::InstallerRestart));
        assert!(flow.release(first));
        assert_eq!(flow.state(), QuitFlowState::Idle);
        assert_eq!(flow.attempt(), None, "no sticky rule survives the attempt");
        // The next attempt is a different generation and consumes only the
        // reason its own caller passed.
        let second = start(&mut flow, None);
        assert_ne!(second.generation(), first.generation());
        assert_eq!(second.skip(), None);
        assert!(!flow.release(first), "the older generation is inert");
        assert_eq!(flow.state(), QuitFlowState::Deciding);
        assert_eq!(flow.attempt(), Some(second));
    }

    #[test]
    fn stale_cleanup_cannot_reset_a_newer_attempt() {
        let mut flow = QuitFlow::new();
        let old = start(&mut flow, None);
        // A terminal bypass supersedes the open decision and becomes the owner.
        let terminal = flow.bypass(QuitReason::Installer);
        assert!(
            !flow.owns(old),
            "the bypass superseded the ordinary attempt"
        );
        assert!(
            !flow.release(old),
            "a late cleanup from the superseded attempt cannot reopen the flow"
        );
        assert_eq!(flow.state(), QuitFlowState::Bypassed);
        assert!(flow.owns(terminal));
        assert!(
            flow.release(terminal),
            "the owning generation releases itself"
        );
        assert_eq!(flow.state(), QuitFlowState::Idle);
    }

    #[test]
    fn a_released_bypass_reopens_quit_for_a_retry() {
        // The exit-request teardown claims a bypass and, when the Host stop
        // fails, releases exactly that generation so a later quit can run.
        let mut flow = QuitFlow::new();
        let claim = flow.bypass(QuitReason::User);
        assert_eq!(flow.request(None), QuitRequest::Ignored);
        assert!(flow.release(claim));
        assert_eq!(flow.state(), QuitFlowState::Idle);
        assert!(matches!(flow.request(None), QuitRequest::Start(_)));
    }

    #[test]
    fn the_terminal_claim_validates_once_and_expires_with_its_generation() {
        // An explicit survivor-consent permit carries the terminal claim of the
        // quit that obtained the consent, and the exit path validates it with
        // `owns`. One generation may authorize exactly one exit, and a claim the
        // flow no longer owns authorizes none.
        let mut flow = QuitFlow::new();
        let claim = flow.bypass(QuitReason::User);
        assert!(flow.owns(claim), "the permit's claim is the current owner");
        assert!(
            flow.release(claim),
            "the exit path consumes the claim exactly once"
        );
        assert!(!flow.owns(claim));
        assert!(
            !flow.release(claim),
            "a consumed generation cannot authorize a second exit"
        );
        // A superseding terminal decision invalidates an unconsumed permit.
        let mut flow = QuitFlow::new();
        let stale = flow.bypass(QuitReason::User);
        let newer = flow.bypass(QuitReason::FatalRecovery);
        assert!(!flow.owns(stale), "a superseded permit is refused");
        assert!(flow.owns(newer), "only the newest claim may be consumed");
    }

    #[test]
    fn confirmation_only_commits_a_still_owned_decision() {
        let mut flow = QuitFlow::new();
        let unattempted = QuitAttempt {
            generation: 41,
            skip: None,
        };
        assert_eq!(flow.resolve_confirmation(unattempted, true), None);
        assert_eq!(flow.state(), QuitFlowState::Idle);
        let refused = start(&mut flow, None);
        assert_eq!(flow.resolve_confirmation(refused, false), None);
        assert_eq!(flow.state(), QuitFlowState::Idle);
        let confirmed = start(&mut flow, None);
        let claim = flow
            .resolve_confirmation(confirmed, true)
            .expect("an affirmative answer commits a terminal bypass");
        assert_eq!(flow.state(), QuitFlowState::Bypassed);
        assert_eq!(flow.attempt(), Some(claim));
        assert_eq!(
            flow.resolve_confirmation(confirmed, true),
            None,
            "a second answer cannot commit twice"
        );
        // The committed bypass can still be released by its own attempt: that is
        // how a terminal shutdown which did not resolve leaves Quit available.
        assert!(flow.release(claim));
        assert_eq!(flow.state(), QuitFlowState::Idle);
        for reason in [
            QuitReason::Installer,
            QuitReason::FatalRecovery,
            QuitReason::OsShutdown,
        ] {
            for answer in [false, true] {
                let mut flow = QuitFlow::new();
                let stale = start(&mut flow, None);
                flow.bypass(reason);
                assert_eq!(
                    flow.resolve_confirmation(stale, answer),
                    None,
                    "a bypass invalidates late answers"
                );
                assert_eq!(flow.state(), QuitFlowState::Bypassed);
                assert_eq!(flow.request(None), QuitRequest::Ignored);
            }
        }
    }

    #[test]
    fn concurrent_requests_join_and_bypass_cancels() {
        let mut flow = QuitFlow::new();
        assert!(matches!(flow.request(None), QuitRequest::Start(_)));
        assert_eq!(
            flow.request(None),
            QuitRequest::Join,
            "second request joins the open dialog"
        );
        assert_eq!(flow.state(), QuitFlowState::Deciding);
        // An installer-owned quit cancels the pending decision.
        flow.bypass(QuitReason::Installer);
        assert_eq!(flow.state(), QuitFlowState::Bypassed);
        assert_eq!(
            flow.request(None),
            QuitRequest::Ignored,
            "no confirmation may open after bypass"
        );
    }
}
