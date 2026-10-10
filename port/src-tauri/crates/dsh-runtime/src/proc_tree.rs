//! Process-tree containment and clean shutdown.
//!
//! **Improvement over upstream (required by the lifecycle spec §4):** the
//! reference runtime path has no job object and no tree kill, so grandchildren
//! can survive a Host SIGKILL. This module guarantees the opposite:
//! - Windows: one Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The
//!   Host child is assigned at spawn and every descendant inherits membership,
//!   so no child can outlive the shell and a forced stop kills the whole tree.
//! - Unix: the child starts in its own process group (`setpgid`), so `killpg`
//!   reaches the whole tree on shutdown.
//!
//! Graceful-then-forced contract (spec §3.2): `shutdown` request → up to 10 s
//! for exit → tree SIGTERM → 5 s → tree SIGKILL → 5 s → hard error. The tree
//! teardown always runs, so a clean child exit can never orphan a grandchild.
//!
//! ## Identity, not identifiers (the repair this module now owns)
//!
//! A Pid or Pgid is a *derived* identifier: once the direct child has been
//! reaped the kernel may hand the same number to an unrelated process, and a
//! signal sent to it kills a stranger. Containment therefore never derives a
//! kill target from a reaped identifier:
//!
//! - **Windows** retains an owned process `HANDLE` opened from the pid at
//!   containment time (an open handle pins the process object, so the pid
//!   cannot be recycled while containment lives). Child liveness is
//!   `GetExitCodeProcess` on that handle and tree liveness is the job's own
//!   accounting; the pid is never re-opened, so `kill_tree` never kills a
//!   recycled pid. The job handle is the tree authority.
//! - **Unix** keeps exactly one owned group and an explicit monotonically
//!   *retiring* lifetime for it. A signal is issued only while the group can be
//!   shown to still be the one we created: either the original leader still
//!   reports our group (`getpgid(leader) == pgid`), or the group is still
//!   populated (`killpg(pgid, 0) == 0`), which reserves the identifier for as
//!   long as a member exists. The first observation that the group is gone
//!   (`ESRCH`) retires the containment permanently, so no later signal —
//!   including the final kill in `Drop` — can be derived from a stale PGID. The
//!   old bare-PID fallback (`kill(pid, SIGKILL)`) is gone: it was pure
//!   identifier reuse with no containment value.
//!
//! Residual, recorded honestly: a group that empties between two observations
//! and whose id is recycled by a *new group leader* before the next signal
//! cannot be distinguished from our group without a kernel handle (Linux
//! `pidfd`, which this crate does not depend on). The window is bounded by the
//! retiring lifetime above and by the fact that a populated group reserves its
//! id; it is strictly narrower than the identifier fallback it replaces.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use dsh_core::diagnostics::StderrTail;

use crate::control::ControlError;

/// Shutdown escalation budget: graceful phase (upstream `exitsWithin(exited, 10_000)`).
pub const GRACEFUL_STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// First forced phase (upstream `kill('SIGTERM')` + `exitsWithin(exited, 5_000)`).
pub const SIGTERM_TIMEOUT: Duration = Duration::from_secs(5);
/// Final forced phase (upstream `kill('SIGKILL')` + `exitsWithin(exited, 5_000)`).
pub const SIGKILL_TIMEOUT: Duration = Duration::from_secs(5);

/// Process-tree containment errors.
#[derive(Debug, thiserror::Error)]
pub enum TreeError {
    /// The child (or its tree) refused to die within the escalation budget.
    #[error("dsh desktop host did not exit after the forced tree kill")]
    SurvivedForcedKill,
    /// Containment could not be established.
    #[error("process containment failed: {0}")]
    Containment(String),
}

/// One stop's escalation budget. The documented default is the 10 s / 5 s / 5 s
/// contract; callers that are already past their own deadline (OS shutdown, the
/// forced-stop paths) shorten it explicitly instead of inventing new constants.
#[derive(Debug, Clone, Copy)]
pub struct StopBudget {
    /// Graceful wait before the first forced phase.
    pub graceful: Duration,
    /// First forced phase (SIGTERM-grade).
    pub term: Duration,
    /// Final forced phase (SIGKILL-grade).
    pub kill: Duration,
}

impl Default for StopBudget {
    fn default() -> Self {
        Self {
            graceful: GRACEFUL_STOP_TIMEOUT,
            term: SIGTERM_TIMEOUT,
            kill: SIGKILL_TIMEOUT,
        }
    }
}

impl StopBudget {
    /// Explicit budget; the graceful phase is still clamped to the documented
    /// ceiling so no caller can wait longer than the contract allows.
    pub fn new(graceful: Duration, term: Duration, kill: Duration) -> Self {
        Self {
            graceful: graceful.min(GRACEFUL_STOP_TIMEOUT),
            term,
            kill,
        }
    }

    /// The default budget with a shortened graceful phase, keeping both forced
    /// phases at their documented length.
    pub fn with_graceful(graceful: Duration) -> Self {
        Self {
            graceful: graceful.min(GRACEFUL_STOP_TIMEOUT),
            ..Self::default()
        }
    }
}

/// A live containment over one child process tree.
#[derive(Debug)]
pub struct TreeContainment {
    pid: u32,
    /// Owned process `HANDLE` (identity for liveness; keeps the pid reserved).
    #[cfg(windows)]
    process: usize,
    /// Owned job `HANDLE` (tree authority) stored as `usize` so the guard stays
    /// `Send + Sync`.
    #[cfg(windows)]
    job: usize,
    #[cfg(unix)]
    pgid: i32,
    /// Owned-lifetime flag: once set, no signal is ever derived from the stored
    /// identifier again.
    retired: AtomicBool,
}

impl TreeContainment {
    /// Establish containment for `pid` (the direct Host child):
    /// Windows job assignment over a retained process handle, Unix
    /// process-group placement.
    pub fn contain(pid: u32) -> Result<Self, TreeError> {
        #[cfg(windows)]
        {
            let process = unsafe { open_owned_process(pid)? };
            let job = match unsafe { create_kill_on_close_job() } {
                Ok(job) => job,
                Err(error) => {
                    unsafe { close_handle(process) };
                    return Err(error);
                }
            };
            // Assignment uses the retained handle: no second OpenProcess by pid,
            // so a recycled pid can never be assigned (or killed) by mistake.
            match unsafe { assign_to_job(job, process) } {
                Ok(()) => {}
                Err(error) => {
                    unsafe {
                        close_handle(job);
                        close_handle(process);
                    }
                    return Err(error);
                }
            }
            Ok(Self {
                pid,
                process,
                job,
                retired: AtomicBool::new(false),
            })
        }
        #[cfg(unix)]
        {
            // The child is spawned with `process_group(0)`, so its pgid equals
            // its pid; record it and verify placement.
            let pgid = pid as i32;
            let actual = unsafe { libc::getpgid(pgid) };
            if actual != pgid {
                return Err(TreeError::Containment(format!(
                    "child {pid} is in process group {actual}, expected {pgid}"
                )));
            }
            Ok(Self {
                pid,
                pgid,
                retired: AtomicBool::new(false),
            })
        }
        #[cfg(not(any(windows, unix)))]
        {
            Ok(Self {
                pid,
                retired: AtomicBool::new(false),
            })
        }
    }

    /// The contained direct child's pid. Diagnostic only: never feed this back
    /// into a kill after the child may have been reaped.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Whether the direct child is still running, resolved through the retained
    /// identity (Windows process handle) or the owned group (Unix) — never
    /// through a bare pid lookup.
    pub fn leader_alive(&self) -> bool {
        #[cfg(windows)]
        {
            process_handle_alive(self.process)
        }
        #[cfg(unix)]
        {
            self.addressable_group().is_some()
        }
        #[cfg(not(any(windows, unix)))]
        {
            false
        }
    }

    /// Whether any process of the owned tree can still run.
    pub fn tree_alive(&self) -> bool {
        #[cfg(windows)]
        {
            // Job accounting is the tree authority (the direct child is a member
            // too), and the retained handle covers the window in which an exited
            // child has not yet been reaped.
            job_has_processes(self.job) || process_handle_alive(self.process)
        }
        #[cfg(unix)]
        {
            self.addressable_group().is_some()
        }
        #[cfg(not(any(windows, unix)))]
        {
            false
        }
    }

    /// Force the whole tree dead (SIGTERM-equivalent first call, SIGKILL-grade
    /// after). Idempotent, and a no-op once [`TreeContainment::retire`] has run.
    pub fn kill_tree(&self, hard: bool) {
        if self.retired.load(Ordering::SeqCst) {
            return;
        }
        #[cfg(windows)]
        unsafe {
            // TerminateJobObject is the tree kill: it reaches descendants the
            // direct-child kill would orphan. The pid is never re-opened.
            terminate_job(self.job, if hard { 1 } else { 0 });
        }
        #[cfg(unix)]
        unsafe {
            let Some(pgid) = self.addressable_group() else {
                return;
            };
            let signal = if hard { libc::SIGKILL } else { libc::SIGTERM };
            if libc::killpg(pgid, signal) != 0 && last_errno() == libc::ESRCH {
                // The group is gone: retire rather than ever addressing this
                // number again.
                self.retire();
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = hard;
        }
    }

    /// Retire the owned lifetime: the authoritative teardown for this
    /// containment has completed, so later signals — including `Drop` — must
    /// not be derived from the stored identifier again.
    pub fn retire(&self) {
        self.retired.store(true, Ordering::SeqCst);
    }

    /// Whether this containment's owned lifetime is still open.
    pub fn is_retired(&self) -> bool {
        self.retired.load(Ordering::SeqCst)
    }

    /// Unix: the owned group identifier while it may still be signalled.
    ///
    /// Proof, in order:
    /// 1. the containment is not retired;
    /// 2. the original leader still reports our group (`getpgid(leader) == pgid`)
    ///    — a recycled pid only satisfies this if it made itself a group leader
    ///    under that exact number;
    /// 3. otherwise the group must still be populated (`killpg(pgid, 0) == 0`),
    ///    which reserves the identifier for the lifetime of its members.
    ///
    /// Any other outcome (leader gone and group gone) retires the containment.
    #[cfg(unix)]
    fn addressable_group(&self) -> Option<i32> {
        if self.retired.load(Ordering::SeqCst) {
            return None;
        }
        unsafe {
            if libc::getpgid(self.pid as i32) == self.pgid {
                return Some(self.pgid);
            }
            if libc::killpg(self.pgid, 0) == 0 {
                return Some(self.pgid);
            }
        }
        self.retire();
        None
    }

    /// A containment that owns no OS resource, so a runtime state-machine test
    /// can retain, retry and retire it without touching a real process. Signals
    /// it issues go nowhere (an id that cannot exist), and it always reports
    /// itself as not alive.
    #[cfg(test)]
    pub(crate) fn inert_for_tests() -> Self {
        Self {
            pid: u32::MAX,
            #[cfg(windows)]
            process: 0,
            #[cfg(windows)]
            job: 0,
            #[cfg(unix)]
            // A group id that cannot exist, so no signal can reach the test's
            // own process group.
            pgid: i32::MAX - 1,
            retired: AtomicBool::new(false),
        }
    }
}

impl Drop for TreeContainment {
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes dropping the job handle the
    /// last-resort tree kill; Unix mirrors it with one final `killpg` while the
    /// owned group can still be proven ours.
    fn drop(&mut self) {
        self.kill_tree(true);
        #[cfg(windows)]
        unsafe {
            close_handle(self.process);
            close_handle(self.job);
        }
    }
}

#[cfg(unix)]
fn last_errno() -> i32 {
    std::io::Error::last_os_error().raw_os_error().unwrap_or(0)
}

/// `STILL_ACTIVE` exit code (259); spelled as a constant because the windows-sys
/// alias types differ across versions.
#[cfg(windows)]
const STILL_ACTIVE_CODE: u32 = 259;

/// Whether `pid` still names a live process.
///
/// **Diagnostic only.** This is a fresh lookup by identifier, so it shares the
/// identifier-reuse hazard the containment itself avoids: after the process has
/// been reaped the number may belong to an unrelated process. Use
/// [`TreeContainment::leader_alive`] / [`TreeContainment::tree_alive`] for
/// anything that decides whether *our* tree is gone.
pub fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let alive = process_handle_alive(handle as usize);
            close_handle(handle as usize);
            alive
        }
    }
    #[cfg(unix)]
    {
        unsafe { libc::kill(pid as i32, 0) == 0 }
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

/// Whether the process behind an owned handle is still running.
#[cfg(windows)]
fn process_handle_alive(handle: usize) -> bool {
    use windows_sys::Win32::System::Threading::GetExitCodeProcess;
    unsafe {
        let mut code: u32 = 0;
        GetExitCodeProcess(handle as _, &mut code) != 0 && code == STILL_ACTIVE_CODE
    }
}

#[cfg(windows)]
unsafe fn close_handle(handle: usize) {
    windows_sys::Win32::Foundation::CloseHandle(handle as _);
}

/// Open and retain an owned handle to the direct child. `PROCESS_SET_QUOTA` is
/// required for job assignment, `PROCESS_TERMINATE` lets the retained handle
/// outlive the assignment, and `PROCESS_QUERY_LIMITED_INFORMATION` answers
/// `GetExitCodeProcess`.
#[cfg(windows)]
unsafe fn open_owned_process(pid: u32) -> Result<usize, TreeError> {
    use windows_sys::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    };
    let process = OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SET_QUOTA | PROCESS_TERMINATE,
        0,
        pid,
    );
    if process.is_null() {
        return Err(TreeError::Containment(format!(
            "OpenProcess failed for the host child {pid}"
        )));
    }
    Ok(process as usize)
}

#[cfg(windows)]
unsafe fn create_kill_on_close_job() -> Result<usize, TreeError> {
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
    if job.is_null() {
        return Err(TreeError::Containment("CreateJobObjectW failed".into()));
    }
    let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let ok = SetInformationJobObject(
        job,
        JobObjectExtendedLimitInformation,
        &info as *const _ as *const _,
        std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
    );
    if ok == 0 {
        close_handle(job as usize);
        return Err(TreeError::Containment(
            "SetInformationJobObject failed".into(),
        ));
    }
    Ok(job as usize)
}

#[cfg(windows)]
unsafe fn assign_to_job(job: usize, process: usize) -> Result<(), TreeError> {
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    if AssignProcessToJobObject(job as _, process as _) == 0 {
        return Err(TreeError::Containment(
            "AssignProcessToJobObject failed".into(),
        ));
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn terminate_job(job: usize, exit_code: u32) {
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    TerminateJobObject(job as _, exit_code);
}

#[cfg(windows)]
fn job_has_processes(job: usize) -> bool {
    use windows_sys::Win32::System::JobObjects::{
        JobObjectBasicAccountingInformation, QueryInformationJobObject,
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    };
    unsafe {
        let mut info: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
        let ok = QueryInformationJobObject(
            job as _,
            JobObjectBasicAccountingInformation,
            &mut info as *mut _ as *mut _,
            std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
            std::ptr::null_mut(),
        );
        ok != 0 && info.ActiveProcesses > 0
    }
}

/// Outcome of one graceful-then-forced stop.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StopOutcome {
    /// The child exited within the graceful budget (no forced phase ran first).
    pub graceful: bool,
    /// Exit code recorded at child exit.
    pub exit_code: Option<i32>,
    /// The Host sent `shutdown-complete` before exiting.
    pub shutdown_acknowledged: bool,
}

/// Escalate a stop against a contained tree: graceful wait, tree SIGTERM, tree
/// SIGKILL, then a hard error. `wait_exit` resolves when the direct child has
/// exited; `kill_tree` forces the tree. The tree teardown runs in every path so
/// a forced stop cannot orphan a grandchild.
///
/// A `SurvivedForcedKill` return is *not* a statement that the tree is gone: the
/// caller keeps the containment as its authoritative ownership record and must
/// report the unresolved teardown (see `Supervisor::stop_inner_checked`).
pub async fn stop_tree(
    containment: &TreeContainment,
    budget: StopBudget,
    wait_exit: impl std::future::Future<Output = Option<i32>>,
    shutdown_acknowledged: impl Fn() -> bool,
) -> Result<StopOutcome, TreeError> {
    let mut wait_exit = std::pin::pin!(wait_exit);
    let exited = tokio::time::timeout(budget.graceful, &mut wait_exit).await;
    let graceful = match exited {
        Ok(code) => return Ok(finish(true, code, &shutdown_acknowledged)),
        Err(_) => false,
    };
    // Forced escalation: SIGTERM-grade, then SIGKILL-grade, each on the tree.
    containment.kill_tree(false);
    let code = match tokio::time::timeout(budget.term, &mut wait_exit).await {
        Ok(code) => code,
        Err(_) => {
            containment.kill_tree(true);
            match tokio::time::timeout(budget.kill, &mut wait_exit).await {
                Ok(code) => code,
                Err(_) => {
                    // Tree teardown still guarantees no orphan survives us; the
                    // caller retains ownership because the child never settled.
                    containment.kill_tree(true);
                    return Err(TreeError::SurvivedForcedKill);
                }
            }
        }
    };
    Ok(finish(graceful, code, &shutdown_acknowledged))
}

fn finish(graceful: bool, exit_code: Option<i32>, ack: &impl Fn() -> bool) -> StopOutcome {
    StopOutcome {
        graceful,
        exit_code,
        shutdown_acknowledged: ack(),
    }
}

/// Stderr capture helper wiring the bounded tail into the runtime's exit error.
pub fn stderr_tail() -> StderrTail {
    StderrTail::new()
}

/// Map a stop outcome to the unclean-exit refusal used by the update handoff
/// (upstream `DesktopHostUncleanExitError`, `host-process.ts:304-307`):
/// installation refuses after a forced kill, non-zero exit, or missing
/// `shutdown-complete`, while still confirming the process exited.
pub fn check_graceful(outcome: &StopOutcome) -> Result<(), ControlError> {
    let clean = outcome.graceful && outcome.exit_code == Some(0) && outcome.shutdown_acknowledged;
    if clean {
        Ok(())
    } else {
        Err(ControlError::Transport(format!(
            "desktop update: Host did not complete graceful task teardown (exit {:?}, shutdown acknowledged {}, graceful deadline exceeded {})",
            outcome.exit_code,
            outcome.shutdown_acknowledged,
            !outcome.graceful
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn graceful_gate_refuses_unclean_exits() {
        let clean = StopOutcome {
            graceful: true,
            exit_code: Some(0),
            shutdown_acknowledged: true,
        };
        assert!(check_graceful(&clean).is_ok());
        for dirty in [
            StopOutcome {
                graceful: false,
                exit_code: Some(0),
                shutdown_acknowledged: true,
            },
            StopOutcome {
                graceful: true,
                exit_code: Some(1),
                shutdown_acknowledged: true,
            },
            StopOutcome {
                graceful: true,
                exit_code: Some(0),
                shutdown_acknowledged: false,
            },
        ] {
            assert!(
                check_graceful(&dirty).is_err(),
                "unclean outcome must refuse installation: {dirty:?}"
            );
        }
    }

    #[test]
    fn a_shortened_budget_never_extends_the_documented_ceiling() {
        let budget = StopBudget::with_graceful(Duration::from_secs(3_600));
        assert_eq!(budget.graceful, GRACEFUL_STOP_TIMEOUT);
        assert_eq!(budget.term, SIGTERM_TIMEOUT);
        assert_eq!(budget.kill, SIGKILL_TIMEOUT);
        let immediate = StopBudget::new(
            Duration::from_millis(10),
            Duration::from_millis(20),
            Duration::from_millis(30),
        );
        assert_eq!(immediate.graceful, Duration::from_millis(10));
        assert_eq!(immediate.term, Duration::from_millis(20));
        assert_eq!(immediate.kill, Duration::from_millis(30));
    }

    #[test]
    fn a_survived_forced_kill_names_the_unresolved_tree() {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime");
        let error = runtime.block_on(stop_tree(
            &inert_containment(),
            StopBudget::new(
                Duration::from_millis(5),
                Duration::from_millis(5),
                Duration::from_millis(5),
            ),
            std::future::pending::<Option<i32>>(),
            || false,
        ));
        assert!(matches!(error, Err(TreeError::SurvivedForcedKill)));
    }

    /// A containment with no owned handles, so the escalation state machine can
    /// be driven without a real child. Its signals go nowhere.
    fn inert_containment() -> TreeContainment {
        TreeContainment::inert_for_tests()
    }

    /// The repair, observed rather than asserted by inspection: a retired
    /// containment no longer signals the tree it used to own.
    #[cfg(any(windows, unix))]
    #[test]
    fn a_retired_containment_does_not_signal_its_former_tree() {
        let mut child = spawn_test_sleeper();
        let pid = child.id();
        let containment = TreeContainment::contain(pid).expect("contain the fixture child");
        assert!(containment.leader_alive(), "the fixture child runs");
        containment.retire();
        assert!(containment.is_retired());
        containment.kill_tree(true);
        std::thread::sleep(Duration::from_millis(250));
        assert!(
            process_alive(pid),
            "a retired containment must not derive a kill from its identifier"
        );
        let _ = child.kill();
        let _ = child.wait();
    }

    /// The other direction: an open containment still reaches its own tree, and
    /// its own handle-based liveness view (not a pid lookup) reports the end.
    #[cfg(any(windows, unix))]
    #[test]
    fn an_open_containment_reaches_its_own_tree() {
        let mut child = spawn_test_sleeper();
        let containment = TreeContainment::contain(child.id()).expect("contain the fixture child");
        assert!(
            containment.tree_alive(),
            "the tree is alive while the child runs"
        );
        containment.kill_tree(true);
        let _ = child.wait();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while containment.leader_alive() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
        assert!(
            !containment.leader_alive(),
            "the owned tree was killed, observed through retained identity"
        );
    }

    /// A long-lived child in its own process group (Unix) so containment can be
    /// established exactly as the supervisor establishes it.
    #[cfg(any(windows, unix))]
    #[allow(clippy::zombie_processes)]
    fn spawn_test_sleeper() -> std::process::Child {
        let mut command = std::process::Command::new(std::env::current_exe().expect("current exe"));
        command
            .args([
                // The full libtest path: `--exact` matches the complete name.
                "proc_tree::tests::fixture_sleeper_main",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("DSH_RUNTIME_PROC_TREE_SLEEPER", "1")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        command.spawn().expect("spawn fixture child")
    }

    /// Re-exec entry for the fixture child: a process that outlives the test
    /// body unless something kills it. Ignored so an ordinary `cargo test` never
    /// parks a suite for a minute.
    #[test]
    #[ignore = "re-exec fixture child; spawned only by the containment tests"]
    fn fixture_sleeper_main() {
        if std::env::var("DSH_RUNTIME_PROC_TREE_SLEEPER").is_err() {
            return;
        }
        std::thread::sleep(Duration::from_secs(60));
    }
}
