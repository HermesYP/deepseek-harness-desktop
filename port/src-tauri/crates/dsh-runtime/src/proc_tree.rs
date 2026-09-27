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

use std::time::{Duration, Instant};

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

/// A live containment over one child process tree.
#[derive(Debug)]
pub struct TreeContainment {
    pid: u32,
    /// Owned job `HANDLE` stored as `usize` so the guard stays `Send + Sync`.
    #[cfg(windows)]
    job: usize,
    #[cfg(unix)]
    pgid: i32,
}

impl TreeContainment {
    /// Establish containment for `pid` (the direct Host child):
    /// Windows job assignment, Unix process-group placement.
    pub fn contain(pid: u32) -> Result<Self, TreeError> {
        #[cfg(windows)]
        {
            let job = unsafe { create_kill_on_close_job()? };
            unsafe { assign_to_job(job, pid)? };
            Ok(Self { pid, job })
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
            Ok(Self { pid, pgid })
        }
        #[cfg(not(any(windows, unix)))]
        {
            Ok(Self { pid })
        }
    }

    /// The contained direct child's pid.
    pub fn pid(&self) -> u32 {
        self.pid
    }

    /// Whether any process of the tree can still run.
    pub fn tree_alive(&self) -> bool {
        #[cfg(windows)]
        {
            process_alive(self.pid) || job_has_processes(self.job)
        }
        #[cfg(unix)]
        {
            process_alive(self.pid)
                || unsafe { libc::killpg(self.pgid, 0) } == 0
        }
        #[cfg(not(any(windows, unix)))]
        {
            process_alive(self.pid)
        }
    }

    /// Force the whole tree dead (SIGTERM-equivalent first call, SIGKILL-grade
    /// after). Idempotent.
    pub fn kill_tree(&self, hard: bool) {
        #[cfg(windows)]
        unsafe {
            // TerminateJobObject is the tree kill: it reaches descendants the
            // direct-child kill would orphan.
            terminate_job(self.job, if hard { 1 } else { 0 });
            if hard {
                terminate_process(self.pid);
            }
        }
        #[cfg(unix)]
        unsafe {
            let signal = if hard { libc::SIGKILL } else { libc::SIGTERM };
            libc::killpg(self.pgid, signal);
            if hard {
                libc::kill(self.pid as i32, libc::SIGKILL);
            }
        }
        #[cfg(not(any(windows, unix)))]
        {
            let _ = hard;
        }
    }
}

impl Drop for TreeContainment {
    /// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` makes dropping the job handle the
    /// last-resort tree kill; Unix mirrors it with one final `killpg`.
    fn drop(&mut self) {
        #[cfg(windows)]
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job as _);
        }
        #[cfg(unix)]
        unsafe {
            libc::killpg(self.pgid, libc::SIGKILL);
        }
    }
}

/// Whether `pid` still names a live process.
pub fn process_alive(pid: u32) -> bool {
    /// `STILL_ACTIVE` exit code (259); spelled as a constant because the
    /// windows-sys alias types differ across versions.
    const STILL_ACTIVE_CODE: u32 = 259;
    #[cfg(windows)]
    {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: u32 = 0;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE_CODE
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

#[cfg(windows)]
unsafe fn create_kill_on_close_job() -> Result<usize, TreeError> {
    use windows_sys::Win32::System::JobObjects::{
        CreateJobObjectW, SetInformationJobObject, JobObjectExtendedLimitInformation,
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
        return Err(TreeError::Containment("SetInformationJobObject failed".into()));
    }
    Ok(job as usize)
}

#[cfg(windows)]
unsafe fn assign_to_job(job: usize, pid: u32) -> Result<(), TreeError> {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
    use windows_sys::Win32::System::JobObjects::AssignProcessToJobObject;
    let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
    if process.is_null() {
        return Err(TreeError::Containment("OpenProcess failed for the host child".into()));
    }
    let ok = AssignProcessToJobObject(job as _, process);
    CloseHandle(process);
    if ok == 0 {
        return Err(TreeError::Containment("AssignProcessToJobObject failed".into()));
    }
    Ok(())
}

#[cfg(windows)]
unsafe fn terminate_job(job: usize, exit_code: u32) {
    use windows_sys::Win32::System::JobObjects::TerminateJobObject;
    TerminateJobObject(job as _, exit_code);
}

#[cfg(windows)]
unsafe fn terminate_process(pid: u32) {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
    if !process.is_null() {
        TerminateProcess(process, 1);
        CloseHandle(process);
    }
}

#[cfg(windows)]
fn job_has_processes(job: usize) -> bool {
    use windows_sys::Win32::System::JobObjects::{
        QueryInformationJobObject, JobObjectBasicAccountingInformation,
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
pub async fn stop_tree(
    containment: &TreeContainment,
    graceful_deadline: Duration,
    wait_exit: impl std::future::Future<Output = Option<i32>>,
    shutdown_acknowledged: impl Fn() -> bool,
) -> Result<StopOutcome, TreeError> {
    let deadline = Instant::now();
    let mut wait_exit = std::pin::pin!(wait_exit);
    let exited = tokio::time::timeout(graceful_deadline.min(GRACEFUL_STOP_TIMEOUT), &mut wait_exit).await;
    let graceful = match exited {
        Ok(code) => return Ok(finish(true, code, &shutdown_acknowledged)),
        Err(_) => false,
    };
    // Forced escalation: SIGTERM-grade, then SIGKILL-grade, each on the tree.
    containment.kill_tree(false);
    let code = match tokio::time::timeout(SIGTERM_TIMEOUT, &mut wait_exit).await {
        Ok(code) => code,
        Err(_) => {
            containment.kill_tree(true);
            match tokio::time::timeout(SIGKILL_TIMEOUT, &mut wait_exit).await {
                Ok(code) => code,
                Err(_) => {
                    // Tree teardown still guarantees no orphan survives us.
                    containment.kill_tree(true);
                    return Err(TreeError::SurvivedForcedKill);
                }
            }
        }
    };
    let _ = deadline;
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
    let clean = outcome.graceful
        && outcome.exit_code == Some(0)
        && outcome.shutdown_acknowledged;
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
            StopOutcome { graceful: false, exit_code: Some(0), shutdown_acknowledged: true },
            StopOutcome { graceful: true, exit_code: Some(1), shutdown_acknowledged: true },
            StopOutcome { graceful: true, exit_code: Some(0), shutdown_acknowledged: false },
        ] {
            assert!(check_graceful(&dirty).is_err(), "unclean outcome must refuse installation: {dirty:?}");
        }
    }
}
