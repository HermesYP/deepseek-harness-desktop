//! The quit model: when to ask, the three localized explanations, fail-closed
//! behaviour, and the skip rules (`apps/desktop/src/quit-confirmation.ts`,
//! `apps/desktop/README.md` "Closing the window and quitting").
//!
//! Decision table (one ordinary quit decision):
//!
//! | Condition | Outcome |
//! |---|---|
//! | A skip rule is armed (installer restart, fatal-recovery exit, dev Restart, OS shutdown/restart/logoff) | quit silently |
//! | Host has not reached `ready`, or has `failed` (cannot run tasks) | quit silently |
//! | Inspection answered nothing interruptible (both facts false) | quit silently |
//! | Inspection reports active tasks | ask, "Running tasks will be interrupted." |
//! | Inspection reports armed scheduled reminders | ask, "Scheduled tasks will not run while the app is closed." |
//! | Inspection reports both | ask, combined explanation |
//! | Inspection failed, or missed the 2-second deadline (**fail closed**) | ask, running-tasks explanation |
//!
//! Concurrency: one decision at a time — repeated quit requests join the open
//! confirmation (and focus it) instead of stacking. An installer-owned quit
//! cancels any pending ordinary decision; late inspection results and dialog
//! answers cannot open another confirmation.

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

/// The Host's availability as it bears on quitting: a Host that has not reached
/// ready or has failed cannot run tasks, so the quit proceeds without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitHostState {
    /// Not `ready` yet or already `stopping`/`stopped` — nothing can be running.
    NotReady,
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
            RuntimeState::Starting | RuntimeState::Stopping | RuntimeState::Stopped => {
                QuitHostState::NotReady
            }
        }
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
        QuitHostState::NotReady | QuitHostState::Failed => QuitAction::Proceed(QuitReason::User),
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

/// What a new `request()` does under the current flow state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitRequest {
    /// The caller runs the decision (inspection + possible dialog).
    Start,
    /// A decision is already open: focus it instead of stacking (K: "another
    /// quit request joins it instead of stacking a second one").
    Join,
    /// The application already left through a bypassing quit.
    Ignored,
}

/// The quit model's concurrency and bypass state.
#[derive(Debug, Default)]
pub struct QuitFlow {
    state: Option<QuitFlowState>,
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

    /// One ordinary quit entrypoint.
    pub fn request(&mut self) -> QuitRequest {
        match self.state() {
            QuitFlowState::Idle => {
                self.state = Some(QuitFlowState::Deciding);
                QuitRequest::Start
            }
            QuitFlowState::Deciding => QuitRequest::Join,
            QuitFlowState::Bypassed => QuitRequest::Ignored,
        }
    }

    /// Finish a decision (approved or cancelled); the flow reopens for the
    /// next ordinary quit request.
    pub fn finish(&mut self) {
        if self.state() == QuitFlowState::Deciding {
            self.state = Some(QuitFlowState::Idle);
        }
    }

    /// A quit that does not ask (installer, fatal recovery, dev restart, OS
    /// shutdown). Cancels any pending ordinary decision: late inspection
    /// results and dialog answers cannot open another confirmation.
    pub fn bypass(&mut self, reason: QuitReason) {
        let _ = reason;
        self.state = Some(QuitFlowState::Bypassed);
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
        assert_eq!(decide_quit(None, QuitHostState::Ready, &facts(true, false)), Ask(ActiveTasks));
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
        assert_eq!(decide_quit(None, QuitHostState::Ready, &errored), Ask(ActiveTasks));
        // Host not ready or failed cannot run tasks → quit silently.
        assert_eq!(
            decide_quit(None, QuitHostState::NotReady, &facts(true, true)),
            Proceed(QuitReason::User)
        );
        assert_eq!(
            decide_quit(None, QuitHostState::Failed, &QuitInspectionOutcome::Unknown),
            Proceed(QuitReason::User)
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
            // Even with active work and an unknown inspection, a skip proceeds.
            assert_eq!(
                decide_quit(Some(skip), QuitHostState::Ready, &QuitInspectionOutcome::Unknown),
                QuitAction::Proceed(reason)
            );
        }
    }

    #[test]
    fn unknown_prompt_maps_to_running_tasks() {
        assert_eq!(resolve_quit_prompt(&QuitInspectionOutcome::Unknown), Some(QuitPrompt::ActiveTasks));
    }

    #[test]
    fn concurrent_requests_join_and_bypass_cancels() {
        let mut flow = QuitFlow::new();
        assert_eq!(flow.request(), QuitRequest::Start);
        assert_eq!(flow.request(), QuitRequest::Join, "second request joins the open dialog");
        assert_eq!(flow.state(), QuitFlowState::Deciding);
        // An installer-owned quit cancels the pending decision.
        flow.bypass(QuitReason::Installer);
        assert_eq!(flow.state(), QuitFlowState::Bypassed);
        assert_eq!(flow.request(), QuitRequest::Ignored, "no confirmation may open after bypass");
        flow.finish();
        assert_eq!(flow.state(), QuitFlowState::Bypassed, "finish cannot reopen a bypassed flow");
    }

    #[test]
    fn finish_reopens_the_flow_after_an_ordinary_decision() {
        let mut flow = QuitFlow::new();
        assert_eq!(flow.request(), QuitRequest::Start);
        flow.finish();
        assert_eq!(flow.state(), QuitFlowState::Idle);
        assert_eq!(flow.request(), QuitRequest::Start);
    }

    #[test]
    fn host_state_derivation_matches_upstream_rule() {
        assert_eq!(QuitHostState::from_runtime_state(RuntimeState::Ready), QuitHostState::Ready);
        assert_eq!(QuitHostState::from_runtime_state(RuntimeState::Failed), QuitHostState::Failed);
        for state in [
            RuntimeState::Starting,
            RuntimeState::Stopping,
            RuntimeState::Stopped,
        ] {
            assert_eq!(QuitHostState::from_runtime_state(state), QuitHostState::NotReady);
        }
    }
}
