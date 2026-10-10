//! The updater's check runner: the runtime half of the polling policy.
//!
//! [`crate::update_security::UpdateSchedule`] is the *policy* — validated
//! intervals, failure doubling to a cap, symmetric jitter, and joining-caller
//! accounting — with time supplied by the caller so it is testable without a
//! clock. This module is the *runtime* that drives it: a monotonic timer that
//! fires the initial check, re-arms after each completion, and exits cleanly.
//!
//! Parity target: `_upstream/apps/desktop/src/update-schedule.ts`. The
//! behaviours that file owns and this module preserves:
//!
//! - **One completion-based deadline** shared by the launch check, the periodic
//!   timer, and explicit checks. The delay is armed only when the last *joined*
//!   caller settles, so several manual callers that joined one request advance
//!   the backoff exactly once.
//! - **Monotonic time.** Delays are measured with a monotonic clock, never wall
//!   time, so a system clock correction cannot make polling fire early, stall,
//!   or double-fire.
//! - **Manual checks bypass the deadline** without bypassing the coordinator's
//!   single-flight join.
//! - **External wakes.** Foreground/resume wakes re-evaluate the existing
//!   deadline; they never bypass completion-based delay or failure backoff.
//!   Explicit mandatory-policy and channel changes make a check due now.
//! - **Disposal is final.** Once disposed, no late completion can re-arm the
//!   timer, and no new check starts.
//!
//! **No network is attempted when delivery is disabled.** With no packaged
//! trust configuration — an unpackaged build, or one whose `updates.json` is
//! absent, unreadable, or malformed — a check cannot produce a candidate, so
//! the runner never arms at all. That is the upstream `app-update.yml` rule
//! (`update-coordinator.ts:53`): an application with no packaged update source
//! has no release delivery, and must not poll for one.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Notify;

use crate::update_security::{UpdateSchedule, UpdateScheduleConfig};

/// Why an *automatic* check was started. Recorded so the runner can report what
/// it did and so tests can assert which trigger fired.
///
/// A user-initiated check is deliberately absent. `update_check`, the "Check for
/// Updates" menu entry, and `policy_update` all call
/// [`crate::update_flow::check`] directly, which owns its own single flight and
/// never consults this schedule; routing them through the runner would run a
/// second, redundant feed request. Upstream's rule that a manual check bypasses
/// the armed deadline therefore has no effect here: the schedule it would have
/// bypassed is not consulted at all. If a future composition does route manual
/// checks through the runner, a `Manual` variant must come back together with
/// the bypass rule in [`UpdateSchedule::begin_check`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckTrigger {
    /// The check armed at startup, before any timer has elapsed.
    Initial,
    /// A timer fired after a successful check.
    Normal,
    /// A timer fired after a failed check (the delay is doubled up to the cap).
    Retry,
    /// A foreground or system-resume wake re-evaluates the existing deadline.
    Resume,
    /// A mandatory-update decision arrived and wants the feed consulted now.
    MandatoryPolicy,
    /// The release channel changed, so the previously admitted candidate (and
    /// any in-flight download for it) no longer applies and the newly selected
    /// channel wants the feed consulted now.
    ChannelChange,
}

impl CheckTrigger {
    /// Whether this trigger makes a future check due immediately rather than
    /// waiting for the armed deadline.
    pub fn forces_early(self) -> bool {
        matches!(self, Self::MandatoryPolicy | Self::ChannelChange)
    }

    /// Stable label for diagnostics.
    pub fn label(self) -> &'static str {
        match self {
            Self::Initial => "initial",
            Self::Normal => "normal",
            Self::Retry => "retry",
            Self::Resume => "resume",
            Self::MandatoryPolicy => "mandatory-policy",
            Self::ChannelChange => "channel-change",
        }
    }
}

/// One attempt's outcome, as the coordinator reported it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckOutcome {
    /// The check completed; the base interval is restored.
    Succeeded,
    /// The check failed; the retry delay doubles up to the cap.
    Failed,
    /// The check was skipped because the coordinator had other work in flight.
    /// The schedule is left as it was: nothing completed.
    Skipped,
}

impl CheckOutcome {
    /// Whether the retry delay should double.
    pub fn is_failure(self) -> bool {
        matches!(self, Self::Failed)
    }
}

/// What one fired check did. Returned by [`UpdateRunner::run_once`] so tests
/// and the shell can both observe the decision without re-deriving it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckDecision {
    /// A check ran and the timer was re-armed.
    Ran {
        trigger: CheckTrigger,
        outcome: CheckOutcome,
    },
    /// The check was not due, so nothing ran and the deadline stands.
    NotDue { trigger: CheckTrigger },
    /// Polling is disposed, so nothing ran.
    Disposed,
}

/// The executor one fired check runs through.
///
/// The runner owns *when* a check happens; the executor owns *what* it does.
/// In the shell that is [`crate::update_flow::check`]; in tests it is a
/// recorder. Keeping them apart is what makes the timer testable without a
/// network, a window, or a real feed.
///
/// The future is boxed because the runner stores a `dyn CheckExecutor`: a
/// trait method returning `impl Future` is not dyn-compatible, and the runner
/// must accept any executor at runtime (the shell's network check, or a test
/// recording one) rather than being generic over it.
pub trait CheckExecutor: Send + Sync + 'static {
    /// Run one check and report its outcome.
    fn execute(
        &self,
        trigger: CheckTrigger,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CheckOutcome> + Send + '_>>;
}

/// The runner's shared, atomic disposition.
#[derive(Debug, Default)]
struct Disposition {
    /// Monotonic milliseconds since the runner started.
    clock: MonotonicClock,
    /// Whether `dispose` has run.
    disposed: std::sync::atomic::AtomicBool,
    /// Number of checks that actually ran.
    ran: AtomicU64,
    /// Number of times a trigger was refused because nothing was due.
    skipped: AtomicU64,
}

/// A monotonic millisecond clock anchored at construction.
///
/// Deliberately not `SystemTime`: the schedule must not move when the system
/// clock is corrected, and it must never observe a negative delta.
#[derive(Debug)]
pub struct MonotonicClock {
    origin: std::time::Instant,
    /// Test-only offset, so a test can advance time without sleeping. Always zero
    /// in a non-test build, where nothing may move the schedule's clock.
    offset_ms: AtomicU64,
}

impl Default for MonotonicClock {
    fn default() -> Self {
        Self {
            origin: std::time::Instant::now(),
            offset_ms: AtomicU64::new(0),
        }
    }
}

impl MonotonicClock {
    /// Current monotonic milliseconds.
    pub fn now_ms(&self) -> u64 {
        let elapsed = self.origin.elapsed().as_millis() as u64;
        elapsed.saturating_add(self.offset_ms.load(Ordering::SeqCst))
    }

    /// Advance the clock by `delta_ms` without sleeping (tests only).
    #[cfg(test)]
    pub fn advance(&self, delta_ms: u64) {
        self.offset_ms.fetch_add(delta_ms, Ordering::SeqCst);
    }
}

/// The updater's check runner.
///
/// Construct one per application, [`UpdateRunner::start`] it once the shell is
/// ready, and [`UpdateRunner::dispose`] it on the way out. Nothing polls until
/// `start` is called.
pub struct UpdateRunner {
    executor: Arc<dyn CheckExecutor>,
    schedule: std::sync::Mutex<UpdateSchedule>,
    disposition: Disposition,
    /// Woken when a trigger arrives or the runner is disposed, so the timer
    /// task stops sleeping and re-evaluates immediately.
    wake: Arc<Notify>,
    /// The task driving the timer, once started.
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    /// Whether `start` has run; `start` is idempotent.
    started: std::sync::atomic::AtomicBool,
}

impl UpdateRunner {
    /// Build a runner for `config` that drives `executor`.
    ///
    /// A runner with no executor is not useful, and a runner that is built but
    /// never started never polls, so both properties are explicit.
    pub fn new(config: UpdateScheduleConfig, executor: Arc<dyn CheckExecutor>) -> Self {
        Self {
            executor,
            schedule: std::sync::Mutex::new(UpdateSchedule::new(config)),
            disposition: Disposition::default(),
            wake: Arc::new(Notify::new()),
            task: tokio::sync::Mutex::new(None),
            started: std::sync::atomic::AtomicBool::new(false),
        }
    }

    /// Monotonic milliseconds since this runner was built.
    #[cfg(test)]
    pub fn now_ms(&self) -> u64 {
        self.disposition.clock.now_ms()
    }

    /// Whether polling has been stopped.
    pub fn is_disposed(&self) -> bool {
        self.disposition.disposed.load(Ordering::SeqCst)
    }

    /// Whether the runner is armed: started and not disposed.
    #[cfg(test)]
    pub fn is_running(&self) -> bool {
        self.started.load(Ordering::SeqCst) && !self.is_disposed()
    }

    /// Checks that actually ran.
    #[cfg(test)]
    pub fn checks_run(&self) -> u64 {
        self.disposition.ran.load(Ordering::SeqCst)
    }

    /// Triggers refused because nothing was due.
    #[cfg(test)]
    pub fn triggers_skipped(&self) -> u64 {
        self.disposition.skipped.load(Ordering::SeqCst)
    }

    /// The armed deadline, as monotonic milliseconds.
    #[cfg(test)]
    pub fn next_check_ms(&self) -> Option<u64> {
        self.schedule.lock().unwrap().next_check_ms()
    }

    /// Current backoff delay (before jitter).
    #[cfg(test)]
    pub fn backoff_ms(&self) -> u64 {
        self.schedule.lock().unwrap().backoff_ms()
    }

    /// Whether a check could run right now.
    #[cfg(test)]
    pub fn is_due(&self) -> bool {
        if self.is_disposed() {
            return false;
        }
        let schedule = self.schedule.lock().unwrap();
        if schedule.is_disposed() {
            return false;
        }
        schedule.is_due(self.disposition.clock.now_ms())
    }

    /// Start polling: arm the initial check and spawn the timer task.
    ///
    /// Idempotent, and a no-op after disposal. The initial check runs
    /// immediately (upstream's launch check), which is what makes a freshly
    /// installed build report an available update without waiting ten minutes.
    pub fn start(self: &Arc<Self>) {
        // Serialize task publication with disposal. A contending starter or
        // disposer already owns this slot; never spawn an unowned task first.
        let Ok(mut task) = self.task.try_lock() else {
            return;
        };
        if self.is_disposed() || self.started.swap(true, Ordering::SeqCst) {
            return;
        }
        let runner = self.clone();
        *task = Some(tokio::spawn(async move {
            runner.drive().await;
        }));
    }

    /// Fire the initial check without waiting for the timer task to be polled.
    ///
    /// `start` spawns the timer, which is the only production path; a test needs
    /// the launch check to have run before it can assert the armed deadline.
    #[cfg(test)]
    pub async fn run_initial(&self) -> CheckDecision {
        self.run_once(CheckTrigger::Initial).await
    }

    /// Run one check for `trigger`, honouring the deadline.
    ///
    /// A trigger that is not due changes nothing and reports
    /// [`CheckDecision::NotDue`], which is what keeps an automatic trigger from
    /// resetting the backoff it did not earn.
    pub async fn run_once(&self, trigger: CheckTrigger) -> CheckDecision {
        if self.is_disposed() {
            return CheckDecision::Disposed;
        }
        let now_ms = self.disposition.clock.now_ms();
        {
            let mut schedule = self.schedule.lock().unwrap();
            if !schedule.begin_check(now_ms) {
                drop(schedule);
                self.disposition.skipped.fetch_add(1, Ordering::SeqCst);
                return CheckDecision::NotDue { trigger };
            }
        }
        self.disposition.ran.fetch_add(1, Ordering::SeqCst);
        let outcome = self.executor.execute(trigger).await;
        let random = jitter_sample();
        {
            let mut schedule = self.schedule.lock().unwrap();
            if matches!(outcome, CheckOutcome::Skipped) {
                // The coordinator had other work in flight, so no check
                // completed: release this caller's join without advancing the
                // backoff, and re-arm the deadline it would have had.
                schedule.complete_skipped(self.disposition.clock.now_ms());
            } else {
                schedule.complete_check(
                    outcome.is_failure(),
                    self.disposition.clock.now_ms(),
                    random,
                );
            }
        }
        // A completion may have re-armed the timer; wake the driver so it
        // recomputes its sleep instead of finishing the previous one.
        self.wake.notify_waiters();
        CheckDecision::Ran { trigger, outcome }
    }

    /// Ask for a check now, and wake the timer.
    ///
    /// The check itself is performed by the timer task, so the caller does not
    /// have to be async. Used by the shell's foreground/resume hook and by the
    /// mandatory-policy hook.
    pub fn request(&self, trigger: CheckTrigger) {
        if self.is_disposed() {
            return;
        }
        if trigger.forces_early() || trigger == CheckTrigger::Initial {
            self.schedule
                .lock()
                .unwrap()
                .due_now(self.disposition.clock.now_ms());
        }
        self.wake.notify_waiters();
    }

    /// Stop polling. Disposal is final.
    ///
    /// A late completion can no longer re-arm the timer. Abort and join the
    /// owned timer task; concurrent or repeated callers await the same shutdown,
    /// and cancelling a disposer does not detach the task. Safe before `start`.
    /// Checks invoked directly by callers retain their own future lifetimes.
    pub async fn dispose(&self) {
        if !self.disposition.disposed.swap(true, Ordering::SeqCst) {
            self.schedule.lock().unwrap().dispose();
            self.wake.notify_waiters();
        }
        // Serialize all callers and keep ownership in the task slot while
        // awaiting. If this future is cancelled, the next caller can still
        // abort/join the same task rather than mistaking disposal for quiescence.
        let mut task = self.task.lock().await;
        if let Some(handle) = task.as_mut() {
            // Abort rather than await graceful completion: the driver can be
            // sleeping on a long deadline. Await the aborted task to quiescence.
            handle.abort();
            let _ = handle.await;
        }
        task.take();
    }

    /// The timer task: fire when due, sleep otherwise.
    async fn drive(&self) {
        loop {
            if self.is_disposed() {
                return;
            }
            let wait = self.ms_until_due();
            if wait > 0 {
                // Either the deadline elapses, or a trigger/disposal wakes us.
                let woken = tokio::select! {
                    _ = tokio::time::sleep(Duration::from_millis(wait)) => false,
                    _ = self.wake.notified() => true,
                };
                let _ = woken;
                continue;
            }
            let trigger = self.pending_trigger();
            let decision = self.run_once(trigger).await;
            if matches!(decision, CheckDecision::Disposed) {
                return;
            }
            // Re-evaluate: a completion armed a new deadline, and a trigger that
            // arrived while the check ran must not be lost.
            if self.is_disposed() {
                return;
            }
            if self.ms_until_due() == 0 {
                // A queued trigger is already due; loop without sleeping so it
                // fires instead of waiting for the next deadline.
                continue;
            }
        }
    }

    /// Milliseconds until the armed deadline; `0` when a check is due now.
    ///
    /// A runner with no armed deadline treats the next check as due
    /// immediately, which is how `start` produces its initial check.
    fn ms_until_due(&self) -> u64 {
        if self.is_disposed() {
            return u64::MAX;
        }
        let now_ms = self.disposition.clock.now_ms();
        let schedule = self.schedule.lock().unwrap();
        match schedule.next_check_ms() {
            Some(deadline) => deadline.saturating_sub(now_ms),
            None => 0,
        }
    }

    /// Which trigger the next automatic check reports.
    ///
    /// Three cases, in order:
    ///
    /// - nothing has been armed yet, so this is the launch check;
    /// - the current delay exceeds the base interval, so polling is recovering
    ///   from a failure, which is a retry;
    /// - otherwise it is an ordinary poll.
    ///
    /// The distinction is diagnostic: it lets the shell and the tests tell a
    /// launch check, a recovering retry, and a healthy poll apart without
    /// inferring intent from the clock.
    fn pending_trigger(&self) -> CheckTrigger {
        let schedule = self.schedule.lock().unwrap();
        if schedule.next_check_ms().is_none()
            && schedule.backoff_ms() == schedule.config().interval_ms
        {
            // No deadline is armed and the delay is still the base interval:
            // no check has completed yet, so this is the launch check.
            return CheckTrigger::Initial;
        }
        if schedule.backoff_ms() > schedule.config().interval_ms {
            CheckTrigger::Retry
        } else {
            CheckTrigger::Normal
        }
    }
}

/// One jitter sample in `[0, 1)`.
///
/// The policy clamps its input, so an out-of-range value would be a bug rather
/// than an error; using the process's own entropy keeps two machines from
/// polling in lockstep after a coordinated restart.
fn jitter_sample() -> f64 {
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
    hasher.write_u64(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos() as u64)
            .unwrap_or(0),
    );
    let value = hasher.finish();
    (value as f64) / (u64::MAX as f64 + 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{poll_fn, Future};
    use std::sync::Mutex as StdMutex;
    use std::task::Poll;

    /// Records every check the runner fired and answers with a scripted queue.
    struct Recorder {
        /// `(trigger)` for each executed check, in order.
        seen: StdMutex<Vec<CheckTrigger>>,
        /// Outcomes to return, in order; the last one repeats.
        script: StdMutex<Vec<CheckOutcome>>,
        /// Notified after each execution so a test can await a firing without
        /// polling.
        fired: Notify,
    }

    impl Recorder {
        fn new(script: Vec<CheckOutcome>) -> Arc<Self> {
            Arc::new(Self {
                seen: StdMutex::new(Vec::new()),
                script: StdMutex::new(script),
                fired: Notify::new(),
            })
        }

        fn triggers(&self) -> Vec<CheckTrigger> {
            self.seen.lock().unwrap().clone()
        }

        fn count(&self) -> usize {
            self.seen.lock().unwrap().len()
        }

        /// Wait until at least `n` checks have run, or time out.
        async fn wait_for(&self, n: usize) -> bool {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            loop {
                if self.count() >= n {
                    return true;
                }
                if std::time::Instant::now() >= deadline {
                    return false;
                }
                let _ =
                    tokio::time::timeout(Duration::from_millis(20), self.fired.notified()).await;
            }
        }
    }

    impl CheckExecutor for Recorder {
        fn execute(
            &self,
            trigger: CheckTrigger,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CheckOutcome> + Send + '_>>
        {
            Box::pin(async move {
                self.seen.lock().unwrap().push(trigger);
                let outcome = {
                    let mut script = self.script.lock().unwrap();
                    if script.is_empty() {
                        CheckOutcome::Succeeded
                    } else if script.len() == 1 {
                        script[0]
                    } else {
                        script.remove(0)
                    }
                };
                self.fired.notify_waiters();
                outcome
            })
        }
    }

    /// An executor that always fails, for the retry path.
    struct AlwaysFailing;

    impl CheckExecutor for AlwaysFailing {
        fn execute(
            &self,
            _trigger: CheckTrigger,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = CheckOutcome> + Send + '_>>
        {
            Box::pin(async { CheckOutcome::Failed })
        }
    }

    fn config(interval_ms: u64, max_backoff_ms: u64) -> UpdateScheduleConfig {
        UpdateScheduleConfig {
            interval_ms,
            max_backoff_ms,
            // Zero jitter so the armed deadline is exactly the base delay and
            // the assertions below are exact rather than ranges.
            jitter: 0.0,
        }
    }

    fn runner(recorder: Arc<Recorder>, interval_ms: u64, max_backoff_ms: u64) -> Arc<UpdateRunner> {
        Arc::new(UpdateRunner::new(
            config(interval_ms, max_backoff_ms),
            recorder,
        ))
    }

    /// Fire a check that is not otherwise due, the way an incoming mandatory
    /// decision does: the intent only arms the deadline, and the check that then
    /// runs reports itself as an ordinary automatic poll.
    async fn forced_check(runner: &UpdateRunner) -> CheckDecision {
        runner.request(CheckTrigger::MandatoryPolicy);
        runner.run_once(CheckTrigger::Normal).await
    }

    // --- trigger classification -------------------------------------------

    #[test]
    fn only_an_explicit_intent_forces_an_early_poll() {
        for eager in [CheckTrigger::MandatoryPolicy, CheckTrigger::ChannelChange] {
            assert!(eager.forces_early(), "{eager:?} makes a check due now");
        }
        for patient in [
            CheckTrigger::Initial,
            CheckTrigger::Normal,
            CheckTrigger::Retry,
            CheckTrigger::Resume,
        ] {
            assert!(
                !patient.forces_early(),
                "{patient:?} waits for the deadline"
            );
        }
    }

    // --- deadline behaviour ------------------------------------------------

    #[tokio::test]
    async fn a_fresh_runner_is_due_so_the_initial_check_fires_immediately() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 600_000, 3_600_000);
        assert!(runner.is_due(), "a fresh runner is due");
        let before_check_ms = runner.disposition.clock.now_ms();
        let decision = runner.run_initial().await;
        let after_check_ms = runner.disposition.clock.now_ms();
        assert_eq!(
            decision,
            CheckDecision::Ran {
                trigger: CheckTrigger::Initial,
                outcome: CheckOutcome::Succeeded
            }
        );
        assert_eq!(recorder.triggers(), vec![CheckTrigger::Initial]);
        // Deadlines are absolute monotonic milliseconds, armed at completion,
        // not exactly at the runner's construction epoch. Bracket that instant
        // with observed clock readings rather than assuming execution took 0 ms.
        let deadline = runner.next_check_ms().expect("the initial check rearmed");
        assert!(
            (before_check_ms + 600_000..=after_check_ms + 600_000).contains(&deadline),
            "deadline {deadline} must be one base interval after check completion"
        );
    }

    #[tokio::test]
    async fn an_automatic_check_before_the_deadline_is_refused_and_changes_nothing() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 600_000, 3_600_000);
        runner.run_initial().await;
        let armed = runner.next_check_ms();

        let decision = runner.run_once(CheckTrigger::Normal).await;
        assert_eq!(
            decision,
            CheckDecision::NotDue {
                trigger: CheckTrigger::Normal
            }
        );
        assert_eq!(recorder.count(), 1, "no second check ran");
        assert_eq!(runner.next_check_ms(), armed, "the deadline is unchanged");
        assert!(!runner.is_due());
        assert_eq!(runner.triggers_skipped(), 1);
    }

    #[tokio::test]
    async fn an_explicit_intent_bypasses_the_armed_deadline_without_changing_the_backoff() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded, CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 600_000, 3_600_000);
        runner.run_initial().await;
        assert!(!runner.is_due(), "the base interval is armed");

        let decision = forced_check(&runner).await;
        assert!(
            matches!(decision, CheckDecision::Ran { .. }),
            "an explicit intent must not be refused as not due"
        );
        assert_eq!(
            recorder.triggers(),
            vec![CheckTrigger::Initial, CheckTrigger::Normal],
            "the armed check reports itself as an ordinary poll"
        );
        assert_eq!(
            runner.backoff_ms(),
            600_000,
            "arming an early check is not a failure, so the delay is untouched"
        );
    }

    #[tokio::test]
    async fn a_successful_check_rearms_the_base_interval() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded, CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 60_000, 240_000);
        for trigger in [CheckTrigger::Initial, CheckTrigger::Normal] {
            if trigger == CheckTrigger::Normal {
                runner.request(CheckTrigger::MandatoryPolicy);
            }
            let before_check_ms = runner.disposition.clock.now_ms();
            let decision = runner.run_once(trigger).await;
            let after_check_ms = runner.disposition.clock.now_ms();
            assert_eq!(
                decision,
                CheckDecision::Ran {
                    trigger,
                    outcome: CheckOutcome::Succeeded
                }
            );
            let deadline = runner
                .next_check_ms()
                .expect("success rearmed the interval");
            assert!(
                (before_check_ms + 60_000..=after_check_ms + 60_000).contains(&deadline),
                "{trigger:?} deadline must be one base interval after completion"
            );
            assert_eq!(runner.backoff_ms(), 60_000);
        }
    }

    #[tokio::test]
    async fn consecutive_failures_double_the_delay_up_to_the_cap() {
        let recorder = Arc::new(AlwaysFailing);
        let runner = Arc::new(UpdateRunner::new(config(10_000, 40_000), recorder));
        // First check fails: 10_000 -> 20_000.
        assert!(matches!(
            runner.run_initial().await,
            CheckDecision::Ran {
                outcome: CheckOutcome::Failed,
                ..
            }
        ));
        assert_eq!(runner.backoff_ms(), 20_000);
        // A retry timer fires off the armed deadline: 20_000 -> 40_000 (the cap).
        forced_check(&runner).await;
        assert_eq!(runner.backoff_ms(), 40_000);
        // And the cap holds.
        forced_check(&runner).await;
        assert_eq!(runner.backoff_ms(), 40_000);
    }

    #[tokio::test]
    async fn a_skipped_check_leaves_the_backoff_alone() {
        // The coordinator had a download in flight, so nothing was attempted.
        let recorder = Recorder::new(vec![CheckOutcome::Failed, CheckOutcome::Skipped]);
        let runner = runner(recorder, 10_000, 40_000);
        runner.run_initial().await;
        let after_failure = runner.backoff_ms();
        assert_eq!(after_failure, 20_000);
        assert!(matches!(
            forced_check(&runner).await,
            CheckDecision::Ran {
                outcome: CheckOutcome::Skipped,
                ..
            }
        ));
        assert_eq!(
            runner.backoff_ms(),
            after_failure,
            "a skip is not a failure and must not back off the interval"
        );
    }

    // --- disposal ----------------------------------------------------------

    #[tokio::test]
    async fn disposal_is_final_and_prevents_late_rearming() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 10_000, 40_000);
        runner.run_initial().await;
        assert!(!runner.is_running(), "not started, so not running");

        runner.dispose().await;
        assert!(runner.is_disposed());
        assert_eq!(
            runner.run_once(CheckTrigger::Normal).await,
            CheckDecision::Disposed
        );
        assert_eq!(
            forced_check(&runner).await,
            CheckDecision::Disposed,
            "no trigger, not even an explicit intent, can revive a disposed runner"
        );
        assert_eq!(recorder.count(), 1, "no check ran after disposal");
        assert!(!runner.is_due());
        assert_eq!(runner.next_check_ms(), None);
    }

    #[tokio::test]
    async fn disposal_is_idempotent_and_safe_without_start() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder, 10_000, 40_000);
        runner.dispose().await;
        runner.dispose().await;
        assert!(runner.is_disposed());
    }

    #[tokio::test]
    async fn start_after_disposal_does_not_spawn() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder, 10_000, 40_000);
        runner.dispose().await;
        runner.start();
        assert!(!runner.is_running());
        assert_eq!(runner.checks_run(), 0);
    }

    // --- the timer ---------------------------------------------------------

    #[tokio::test]
    async fn the_timer_fires_the_initial_check_then_polls_on_the_interval() {
        // Real (short) intervals rather than paused time: `start_paused`
        // requires tokio's `test-util` feature, which this crate does not
        // enable, and a paused clock would not exercise the spawned task's own
        // `sleep`/wake behaviour.
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 25, 100);
        runner.start();
        assert!(runner.is_running());

        // The initial check is due immediately, then the timer polls.
        for expected in 1..=3usize {
            assert!(
                recorder.wait_for(expected).await,
                "check {expected} must fire (initial, then on the interval)"
            );
        }
        assert_eq!(
            recorder.triggers()[0],
            CheckTrigger::Initial,
            "the first check is the launch check"
        );
        // Every later poll is automatic. A poll that lands while the previous
        // failure count is zero reports `Normal`.
        assert!(
            recorder.triggers()[1..]
                .iter()
                .all(|trigger| *trigger == CheckTrigger::Normal),
            "later polls are normal, saw {:?}",
            recorder.triggers()
        );
        runner.dispose().await;
    }

    #[tokio::test]
    async fn the_timer_reports_a_retry_after_a_failure() {
        let recorder = Arc::new(AlwaysFailing);
        let runner = Arc::new(UpdateRunner::new(config(20, 80), recorder));
        runner.start();
        // The initial check fails immediately, doubling the delay to 40 ms.
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while runner.backoff_ms() <= 20 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            runner.backoff_ms() > 20,
            "a failure must double the delay (saw {})",
            runner.backoff_ms()
        );
        runner.dispose().await;
    }

    #[tokio::test]
    async fn an_explicit_policy_request_makes_the_next_check_due_immediately() {
        // A long interval would be unreachable in a test, so the wake is
        // asserted through the deadline itself: `request` must clear the armed
        // deadline rather than wait it out.
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 600_000, 3_600_000);
        runner.run_initial().await;
        assert!(!runner.is_due(), "the deadline is armed");

        let before_request_ms = runner.now_ms();
        runner.request(CheckTrigger::MandatoryPolicy);
        let after_request_ms = runner.now_ms();
        assert!(
            runner.is_due(),
            "an explicit mandatory-policy intent makes a check due now"
        );
        let deadline = runner
            .next_check_ms()
            .expect("policy request set a deadline");
        assert!((before_request_ms..=after_request_ms).contains(&deadline));

        // And the timer honours it: with the deadline already passed, the
        // driver fires without waiting for the interval.
        runner.start();
        assert!(
            recorder.wait_for(2).await,
            "the wake must produce a check without waiting out the interval"
        );
        assert_eq!(recorder.triggers()[1], CheckTrigger::Normal);
        runner.dispose().await;
    }

    #[tokio::test]
    async fn resume_preserves_both_success_deadline_and_failure_backoff() {
        for outcome in [CheckOutcome::Succeeded, CheckOutcome::Failed] {
            let recorder = Recorder::new(vec![outcome]);
            let runner = runner(recorder.clone(), 600_000, 3_600_000);
            runner.run_initial().await;
            let deadline = runner.next_check_ms();
            let backoff = runner.backoff_ms();
            assert!(!runner.is_due());
            runner.request(CheckTrigger::Resume);
            assert_eq!(runner.next_check_ms(), deadline);
            assert_eq!(runner.backoff_ms(), backoff);
            assert!(!runner.is_due());
            assert_eq!(
                recorder.count(),
                1,
                "resume must not issue an early request"
            );
            runner.dispose().await;
        }
    }

    #[tokio::test]
    async fn an_ordinary_request_does_not_force_an_early_check() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 600_000, 3_600_000);
        runner.run_initial().await;
        // `Normal` is not an external wake, so it must not clear the deadline.
        runner.request(CheckTrigger::Normal);
        assert!(
            !runner.is_due(),
            "only a forcing trigger clears the deadline"
        );
    }

    #[tokio::test]
    async fn disposing_stops_the_timer_task() {
        let recorder = Recorder::new(vec![CheckOutcome::Succeeded]);
        let runner = runner(recorder.clone(), 20, 80);
        runner.start();
        assert!(recorder.wait_for(1).await);
        runner.dispose().await;
        let after_disposal = recorder.count();
        // Real time passes; a disposed runner must not poll again.
        tokio::time::sleep(Duration::from_millis(120)).await;
        assert_eq!(
            recorder.count(),
            after_disposal,
            "a disposed runner must not poll"
        );
    }

    struct HeldCheck {
        entered: Notify,
        dropped: Arc<std::sync::atomic::AtomicBool>,
    }

    struct MarkDropped(Arc<std::sync::atomic::AtomicBool>);
    impl Drop for MarkDropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    impl CheckExecutor for HeldCheck {
        fn execute(
            &self,
            _: CheckTrigger,
        ) -> std::pin::Pin<Box<dyn Future<Output = CheckOutcome> + Send + '_>> {
            Box::pin(async move {
                let _owned_request = MarkDropped(self.dropped.clone());
                self.entered.notify_one();
                std::future::pending().await
            })
        }
    }

    fn held_runner() -> (Arc<UpdateRunner>, Arc<HeldCheck>) {
        let executor = Arc::new(HeldCheck {
            entered: Notify::new(),
            dropped: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        });
        let runner = Arc::new(UpdateRunner::new(
            config(600_000, 3_600_000),
            executor.clone(),
        ));
        (runner, executor)
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_disposer_retains_the_join_until_driver_quiescence() {
        let (runner, executor) = held_runner();
        runner.start();
        executor.entered.notified().await;
        let mut disposal = Box::pin(runner.dispose());
        poll_fn(|cx| {
            assert!(disposal.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        assert!(runner.is_disposed());
        assert!(
            runner.task.try_lock().is_err(),
            "the disposer owns the task slot"
        );
        assert!(!executor.dropped.load(Ordering::SeqCst));
        drop(disposal);
        {
            let task = runner
                .task
                .try_lock()
                .expect("cancellation releases the slot lock");
            assert!(
                task.is_some(),
                "cancellation must not remove join ownership"
            );
        }
        runner.dispose().await;
        assert!(
            executor.dropped.load(Ordering::SeqCst),
            "joining waits for the request future to drop"
        );
        assert!(runner.task.lock().await.is_none());
        assert_eq!(runner.next_check_ms(), None);
        assert_eq!(runner.checks_run(), 1);
        assert_eq!(forced_check(&runner).await, CheckDecision::Disposed);
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_disposers_both_wait_and_start_cannot_publish_during_shutdown() {
        let (runner, executor) = held_runner();
        runner.start();
        executor.entered.notified().await;
        let mut first = Box::pin(runner.dispose());
        poll_fn(|cx| {
            assert!(first.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
        let mut second = Box::pin(runner.dispose());
        poll_fn(|cx| {
            assert!(
                second.as_mut().poll(cx).is_pending(),
                "another disposer cannot report quiescence early"
            );
            Poll::Ready(())
        })
        .await;
        // The synchronous start entry must not panic or create another task
        // while the first disposer owns the publication slot.
        runner.start();
        assert_eq!(runner.checks_run(), 1);
        assert!(!executor.dropped.load(Ordering::SeqCst));
        let ((), ()) = tokio::join!(first, second);
        assert!(executor.dropped.load(Ordering::SeqCst));
        assert!(runner.task.lock().await.is_none());
        runner.start();
        runner.dispose().await;
        assert!(runner.task.lock().await.is_none());
        assert_eq!(runner.checks_run(), 1);
    }

    // --- clock -------------------------------------------------------------

    #[test]
    fn the_clock_is_monotonic_and_offsettable() {
        let clock = MonotonicClock::default();
        let first = clock.now_ms();
        clock.advance(5_000);
        assert_eq!(clock.now_ms(), first + 5_000);
        // Real elapsed time only ever moves forward.
        let second = clock.now_ms();
        assert!(clock.now_ms() >= second);
    }

    #[test]
    fn jitter_samples_stay_in_range() {
        for _ in 0..64 {
            let sample = jitter_sample();
            assert!((0.0..1.0).contains(&sample), "sample {sample} out of range");
        }
    }
}
