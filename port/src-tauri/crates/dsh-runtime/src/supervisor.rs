//! Runtime supervisor: spawn, monitor, restart and stop the dsh Host process
//! tree, carrying the Desktop-Host lifecycle protocol generation 4.
//!
//! Spawn contract transcribed from `_upstream/apps/desktop/src/host-process.ts:186-205`
//! and `node-environment.ts:12-18` (with `apps/desktop-host/src/index.ts:19-41`
//! argv order): `--expose-internals` first, optional dev inspector, the entry
//! script, then `runtimeDir projectDir primaryRuntime [pnpm nodeBin]`; `cwd` is
//! the project (desktop profile) directory; the environment is the caller
//! environment verbatim plus `ELECTRON_RUN_AS_NODE=1`; stdio is
//! `ignore/pipe/pipe` — stderr is retained as a bounded 64 Ki-character
//! tail, stdout is optionally forwarded, and both streams can be observed
//! independently of a terminal. The Node IPC slot is replaced by the NDJSON
//! control socket (`control.rs`).
//!
//! State machine: `starting → ready → stopping → stopped`, with `failed` as the
//! absorbing failure state. First failure wins (`fail()` semantics): the ready
//! promise and every pending control request reject with it and `on_failure`
//! runs exactly once.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

/// Maximum time allowed for the Host to establish its authenticated control
/// connection.
const STARTUP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

/// Maximum time allowed for the Host to publish `ready` **after** its control
/// connection authenticated. Upstream has the same shape of bound through the
/// shell's startup watchdog; without it a Host that connects and then never
/// reports readiness keeps `start()` (and therefore the whole lifecycle
/// transaction and every command queued behind it) pending forever.
///
/// Overridable through `DSH_DESKTOP_STARTUP_READY_TIMEOUT_MS` so an isolated
/// test can exercise the timeout without waiting the production budget.
fn startup_ready_timeout() -> Duration {
    match std::env::var("DSH_DESKTOP_STARTUP_READY_TIMEOUT_MS") {
        Ok(value) => value
            .parse::<u64>()
            .map(Duration::from_millis)
            .unwrap_or(STARTUP_READY_TIMEOUT),
        Err(_) => STARTUP_READY_TIMEOUT,
    }
}

const STARTUP_READY_TIMEOUT: Duration = Duration::from_secs(60);

use dsh_core::diagnostics::StderrTail;
use dsh_core::error::DshError;
use dsh_core::protocol::{IndexInjection, QuitInspection, RuntimeState, RuntimeStatus};
use dsh_core::quit::QuitInspectionOutcome;
use tokio::sync::watch;
use tokio::sync::Mutex;

use crate::control::{
    ControlEndpoint, ControlError, ControlLink, ControlServer, HostEvent, ShellMessage,
    UpdateTasksAction, SHUTDOWN_SEND_TIMEOUT,
};
use crate::output::{drain_output, HostOutputStream, OutputObserver};
use crate::proc_tree::{
    process_alive, stop_tree, StopBudget, TreeContainment, TreeError, GRACEFUL_STOP_TIMEOUT,
};
use crate::quit_inspection::inspect_quit;
use crate::update_tasks::update_tasks;

/// Bundled package-manager launcher pair (upstream `packageManager`).
#[derive(Debug, Clone)]
pub struct PackageManager {
    /// Bundled pnpm entry script.
    pub pnpm: PathBuf,
    /// Directory of the private node shell launcher.
    pub node_bin: PathBuf,
}

/// Everything needed to spawn one Host child (upstream `DesktopHostProcess` inputs).
#[derive(Debug, Clone)]
pub struct SpawnPlan {
    /// Node executable (upstream: Electron in Node mode; the port uses the
    /// bundled or system Node runtime — ADR 0002).
    pub program: PathBuf,
    /// Exact argv after the program (upstream order).
    pub args: Vec<String>,
    /// Child working directory = the desktop profile (`projectDir`).
    pub cwd: PathBuf,
    /// Extra environment merged over the inherited environment.
    pub env: BTreeMap<String, String>,
    /// Forward child stdout to the shell's stdout (upstream pipes it through).
    pub forward_stdout: bool,
}

impl SpawnPlan {
    /// The upstream spawn contract: `node --expose-internals [--inspect=…] <entry>
    /// <runtimeDir> <projectDir> <primaryRuntime> [<pnpm> <nodeBin>]`.
    ///
    /// `entry` is the Node adapter (`runtime/adapter.mjs`), the single Node
    /// touch-point that runs the unmodified upstream `runProfile` boot exactly
    /// as `apps/desktop-host/src/index.ts` does over the NDJSON socket.
    #[allow(clippy::too_many_arguments)]
    pub fn desktop_host(
        node: PathBuf,
        adapter_entry: PathBuf,
        runtime_dir: PathBuf,
        project_dir: PathBuf,
        primary_runtime: Option<PathBuf>,
        package_manager: Option<PackageManager>,
        inspect_port: Option<u16>,
    ) -> Self {
        let mut args = vec!["--expose-internals".to_string()];
        if let Some(port) = inspect_port {
            args.push(format!("--inspect=127.0.0.1:{port}"));
        }
        args.push(adapter_entry.to_string_lossy().into_owned());
        args.push(runtime_dir.to_string_lossy().into_owned());
        args.push(project_dir.to_string_lossy().into_owned());
        if let Some(primary) = primary_runtime {
            args.push(primary.to_string_lossy().into_owned());
        } else if package_manager.is_some() {
            // Preserve package-manager positions without inventing a payload path.
            args.push(String::new());
        }
        if let Some(manager) = package_manager {
            args.push(manager.pnpm.to_string_lossy().into_owned());
            args.push(manager.node_bin.to_string_lossy().into_owned());
        }
        let mut env = BTreeMap::new();
        // `desktopNodeEnvironment(node, undefined, environment)`: the caller
        // environment plus `ELECTRON_RUN_AS_NODE=1`, with no PATH prepending at
        // Host spawn time (that stays scoped to package operations).
        env.insert("ELECTRON_RUN_AS_NODE".to_string(), "1".to_string());
        Self {
            program: node,
            args,
            cwd: project_dir,
            env,
            forward_stdout: true,
        }
    }
}

/// Readiness facts captured from the Host's `ready` message.
#[derive(Debug, Clone)]
pub struct HostReady {
    /// The Host's authenticated URL (`authenticatedUrl` output).
    pub url: String,
    /// `collectIndexInjections()` rows (required for startup).
    pub injections: Option<Vec<IndexInjection>>,
    /// RFC 3339 readiness time.
    pub started_at: String,
}

/// Fatal failure carrying the Host's inspected error verbatim (upstream
/// `DesktopHostFatalError`) for the crash report.
#[derive(Debug, Clone)]
pub struct HostFatal {
    pub message: String,
    pub diagnostic: Option<String>,
}

/// Process-ownership facts of the supervisor, for the quit/exit mapping.
///
/// Runtime state describes channel availability, not process ownership. A fatal
/// channel can publish `Failed` while its process tree is still owned; callers
/// must use this snapshot before treating shutdown as settled. An unresolved
/// stop leaves the state `Stopping`, records the real error in `last_error`,
/// keeps containment, and reports it here:
/// - settled: nothing owned, nothing running — the tree is gone;
/// - owned but not alive: containment retained, no process left (the next stop
///   settles it);
/// - owned and alive: a Host tree may still be running work.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeardownStatus {
    /// The supervisor still holds containment (job object / owned process
    /// group) over a Host tree.
    pub tree_owned: bool,
    /// A process of that owned tree can still run.
    pub tree_alive: bool,
    /// The verbatim error of the last stop that could not confirm teardown.
    pub unresolved: Option<String>,
}

impl TeardownStatus {
    /// Nothing is owned and nothing can run: the runtime is fully settled.
    pub fn is_settled(&self) -> bool {
        !self.tree_owned && !self.tree_alive
    }
}

struct RunSlot {
    link: Option<Arc<ControlLink>>,
    /// Authoritative containment of the current (or last, unresolved) Host tree.
    /// Held behind `Arc` so a stop can own the escalation while the slot keeps
    /// the only other reference: a containment that could not confirm teardown
    /// stays here, and is retried instead of being dropped.
    containment: Option<Arc<TreeContainment>>,
    child: Option<tokio::process::Child>,
    /// `shutdown-complete` observed for the current run (AtomicBool so the stop
    /// path can read it without blocking inside async code).
    ack: Arc<std::sync::atomic::AtomicBool>,
    exit_code: Option<i32>,
    exited: bool,
    ready: Option<HostReady>,
    fatal: Option<HostFatal>,
    stderr: Arc<Mutex<StderrTail>>,
    /// Live credential sink. Created on first subscription and kept across the
    /// run so a later subscriber joins the same channel instead of replacing it.
    platform_sessions: Option<watch::Sender<Option<crate::control::PlatformSession>>>,
    /// Latest credential value observed from the Host, independent of whether a
    /// consumer is subscribed. Seeded into a new receiver on subscription and
    /// **cleared on stop/restart/run replacement** so credentials never outlive
    /// the Host generation that produced them.
    platform_session: Option<crate::control::PlatformSession>,
    run_id: u64,
    failure_reported: bool,
    /// Verbatim error of the last stop that could not confirm teardown. Present
    /// exactly while `containment` still owns an un-reaped tree.
    teardown_error: Option<String>,
}

/// First-failure callback type (`on_failure`).
pub type FailureCallback = Arc<dyn Fn(&HostFatal) + Send + Sync>;

/// Owned first-failure handler as accepted by [`Supervisor::new`].
pub type FailureHandler = Box<dyn Fn(&HostFatal) + Send + Sync>;

/// The runtime supervisor.
pub struct Supervisor {
    plan: SpawnPlan,
    status: watch::Sender<RuntimeStatus>,
    slot: Arc<Mutex<RunSlot>>,
    /// Serializes complete start/stop/restart transactions.
    lifecycle: Mutex<()>,
    on_failure: Option<FailureCallback>,
    output_observer: Option<OutputObserver>,
}

impl Supervisor {
    /// Create a supervisor for `plan`; `on_failure` receives the first
    /// unexpected child failure exactly once per run.
    pub fn new(plan: SpawnPlan, on_failure: Option<FailureHandler>) -> Self {
        let (status, _) = watch::channel(RuntimeStatus {
            state: RuntimeState::Stopped,
            url: None,
            started_at: None,
            last_error: None,
        });
        Self {
            plan,
            status,
            slot: Arc::new(Mutex::new(RunSlot {
                link: None,
                containment: None,
                child: None,
                ack: Arc::new(std::sync::atomic::AtomicBool::new(false)),
                exit_code: None,
                exited: false,
                ready: None,
                fatal: None,
                stderr: Arc::new(Mutex::new(StderrTail::new())),
                platform_sessions: None,
                platform_session: None,
                run_id: 0,
                failure_reported: false,
                teardown_error: None,
            })),
            lifecycle: Mutex::new(()),
            on_failure: on_failure.map(|f| -> FailureCallback { Arc::from(f) }),
            output_observer: None,
        }
    }

    /// Observe complete Host lines, independently of optional terminal output.
    pub fn with_output_observer(mut self, observer: OutputObserver) -> Self {
        self.output_observer = Some(observer);
        self
    }

    /// Subscribe to runtime status transitions (mapped to `dsh://runtime/state`).
    pub fn subscribe(&self) -> watch::Receiver<RuntimeStatus> {
        self.status.subscribe()
    }

    /// Current status snapshot.
    pub fn status(&self) -> RuntimeStatus {
        self.status.borrow().clone()
    }

    /// The bounded host stderr tail (for crash reports; may contain plugin output).
    pub async fn stderr_tail(&self) -> String {
        self.slot
            .lock()
            .await
            .stderr
            .lock()
            .await
            .snapshot()
            .to_string()
    }

    /// Start one Host child and await its `ready` message (the readiness
    /// boundary of the lifecycle protocol). Concurrent callers join the run.
    pub async fn start(&self) -> Result<HostReady, DshError> {
        let _transaction = self.lifecycle.lock().await;
        if self.status().state == RuntimeState::Ready {
            if let Some(ready) = self.slot.lock().await.ready.clone() {
                return Ok(ready);
            }
        }
        self.start_inner().await
    }

    async fn start_inner(&self) -> Result<HostReady, DshError> {
        // Never stand a second Host on top of a tree whose death was never
        // confirmed. Dropping that containment would discard the only
        // authoritative handle to whatever survived it, so the start is refused
        // with a typed error; the caller stops first (and `stop` retries the
        // escalation against the retained tree).
        //
        // The guard is bound (not held inside the `if let`) so nothing else can
        // deadlock on the slot lock: `if let` keeps its scrutinee's temporaries
        // alive for the whole block.
        let retained = self.slot.lock().await.containment.clone();
        if let Some(retained) = retained {
            let message = format!(
                "a previous host process tree is still owned (alive: {}); stop it before starting a new host",
                retained.tree_alive()
            );
            // Preserve the existing failure or stop state. Process ownership
            // is reported separately through `teardown_status()`.
            return Err(DshError::other("host_start_blocked", message));
        }
        self.set_state(RuntimeState::Starting, None, None).await;
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone())
            .await
            .map_err(control_error)?;
        let mut command = tokio::process::Command::new(&self.plan.program);
        command
            .args(&self.plan.args)
            .current_dir(&self.plan.cwd)
            .envs(&self.plan.env)
            .envs(endpoint.child_environment())
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn().map_err(|e| {
            DshError::io(
                "spawn host",
                Some(self.plan.program.display().to_string()),
                &e,
            )
        })?;
        let pid = child.id().ok_or_else(|| {
            DshError::runtime_unavailable("starting", "host child exited before containment")
        })?;
        let containment = match TreeContainment::contain(pid) {
            Ok(containment) => Arc::new(containment),
            Err(error) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(DshError::runtime_unavailable("starting", error.to_string()));
            }
        };
        if let Some(stdout_pipe) = child.stdout.take() {
            tokio::spawn(drain_output(
                stdout_pipe,
                HostOutputStream::Stdout,
                None,
                self.output_observer.clone(),
                self.plan.forward_stdout,
            ));
        }
        // Preserve the stderr tail, and also observe complete diagnostic lines.
        let stderr = self.slot.lock().await.stderr.clone();
        if let Some(stderr_pipe) = child.stderr.take() {
            tokio::spawn(drain_output(
                stderr_pipe,
                HostOutputStream::Stderr,
                Some(stderr),
                self.output_observer.clone(),
                false,
            ));
        }
        // Publish ownership before the first await that can stall. The monitor
        // takes the Child handle but the slot retains the containment guard, so
        // stop() and failure cleanup can always terminate/reap the tree.
        let run_id = {
            let mut slot = self.slot.lock().await;
            slot.run_id = slot.run_id.wrapping_add(1);
            slot.failure_reported = false;
            slot.link = None;
            slot.containment = Some(containment);
            slot.child = Some(child);
            slot.ack.store(false, std::sync::atomic::Ordering::SeqCst);
            slot.exit_code = None;
            slot.exited = false;
            slot.ready = None;
            slot.fatal = None;
            // A new generation starts with no credentials. Any session the
            // previous run published must be forgotten *before* this run can
            // publish its own, so an old-generation frame arriving late can
            // never restore what this generation has not yet reported. The
            // generation check in the event pump drops those frames, and this
            // reset covers the window where the new run is already current.
            clear_platform_session(&mut slot);
            // A start admitted past the retained-tree guard owns a fresh tree, so
            // any previous unresolved-teardown record is consumed here.
            slot.teardown_error = None;
            slot.run_id
        };
        self.spawn_exit_monitor(run_id);
        let mut watch_status = self.status.subscribe();
        match self.status().state {
            RuntimeState::Failed => {
                let error = self.exit_error().await;
                self.cleanup_failed_start().await?;
                self.set_state(RuntimeState::Failed, None, Some(error.to_string()))
                    .await;
                return Err(error);
            }
            RuntimeState::Stopping | RuntimeState::Stopped => {
                self.cleanup_failed_start().await?;
                self.slot.lock().await.ready = None;
                self.set_state(RuntimeState::Stopped, None, None).await;
                return Err(DshError::other(
                    "host_startup_cancelled",
                    "host startup was cancelled",
                ));
            }
            _ => {}
        }
        let accept_result = tokio::select! {
            result = server.accept() => result.map(Arc::new),
            changed = watch_status.changed() => {
                let _ = changed;
                let state = self.status();
                if state.state == RuntimeState::Failed {
                    let error = self.exit_error().await;
                    self.cleanup_failed_start().await?;
                    self.set_state(RuntimeState::Failed, None, Some(error.to_string())).await;
                    return Err(error);
                }
                self.cleanup_failed_start().await?;
                self.slot.lock().await.ready = None;
                self.set_state(RuntimeState::Stopped, None, None).await;
                return Err(DshError::other("host_startup_cancelled", "host startup was cancelled"));
            }
            _ = tokio::time::sleep(STARTUP_CONNECT_TIMEOUT) => {
                self.cleanup_failed_start().await?;
                let error = DshError::other("host_startup_timeout", format!("dsh desktop host did not connect within {} seconds", STARTUP_CONNECT_TIMEOUT.as_secs()));
                self.set_state(RuntimeState::Failed, None, Some(error.to_string())).await;
                return Err(error);
            }
        };
        // The authenticated-but-never-ready bound is enforced by the readiness
        // loop below; a Host that connects and reports `ready` promptly is
        // unaffected.
        let link = match accept_result {
            Ok(link) => link,
            Err(error) => {
                self.cleanup_failed_start().await?;
                let error = DshError::other(
                    "host_startup_connection",
                    format!("dsh desktop host control connection failed: {error}"),
                );
                self.set_state(RuntimeState::Failed, None, Some(error.to_string()))
                    .await;
                return Err(error);
            }
        };
        {
            self.slot.lock().await.link = Some(link.clone());
        }
        self.spawn_event_pump(link.clone(), run_id);
        // Await the readiness boundary: `ready`, first `fatal`, or child exit —
        // and never longer than STARTUP_READY_TIMEOUT. The Host has already
        // authenticated by this point, so a stall here means it booted its
        // control channel but never finished starting; upstream's startup
        // watchdog treats that as a startup failure, and without this bound the
        // lifecycle transaction would hold every queued command forever.
        let ready_budget = startup_ready_timeout();
        let ready_deadline = tokio::time::Instant::now() + ready_budget;
        loop {
            enum Observed {
                Ready(HostReady),
                Fatal(String),
                Exited,
                Cancelled,
            }
            // Readiness observation and publication share the run-slot lock.
            // Releasing it before publishing lets a fatal/exit event win, then
            // a stale Ready snapshot incorrectly overwrite the terminal state.
            // Remaining actions run without this non-reentrant mutex held.
            let observed = {
                let slot = self.slot.lock().await;
                if matches!(
                    self.status().state,
                    RuntimeState::Stopping | RuntimeState::Stopped
                ) {
                    Some(Observed::Cancelled)
                } else if let Some(fatal) = &slot.fatal {
                    Some(Observed::Fatal(fatal.message.clone()))
                } else if slot.exited {
                    Some(Observed::Exited)
                } else if slot.ready.is_some() {
                    publish_ready(&slot, &self.status, run_id).map(Observed::Ready)
                } else {
                    None
                }
            };
            match observed {
                Some(Observed::Fatal(message)) => {
                    self.set_state(RuntimeState::Failed, None, Some(message.clone()))
                        .await;
                    return Err(DshError::other("host_fatal", message));
                }
                Some(Observed::Ready(ready)) => return Ok(ready),
                Some(Observed::Exited) => {
                    let error = self.exit_error().await;
                    self.set_state(RuntimeState::Failed, None, Some(error.to_string()))
                        .await;
                    return Err(error);
                }
                Some(Observed::Cancelled) => {
                    self.cleanup_failed_start().await?;
                    self.slot.lock().await.ready = None;
                    self.set_state(RuntimeState::Stopped, None, None).await;
                    return Err(DshError::other(
                        "host_startup_cancelled",
                        "host startup was cancelled",
                    ));
                }
                None => {}
            }
            match tokio::time::timeout_at(ready_deadline, watch_status.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => {
                    // Status sender dropped: treat as teardown.
                    self.cleanup_failed_start().await?;
                    return Err(DshError::runtime_unavailable(
                        "stopped",
                        "supervisor closed",
                    ));
                }
                Err(_) => {
                    // The Host authenticated but never reached `ready`.
                    self.cleanup_failed_start().await?;
                    let error = DshError::other(
                        "host_startup_timeout",
                        format!(
                            "dsh desktop host authenticated its control channel but did not report ready within {} seconds",
                            ready_budget.as_secs()
                        ),
                    );
                    self.set_state(RuntimeState::Failed, None, Some(error.to_string()))
                        .await;
                    return Err(error);
                }
            }
        }
    }

    /// Request teardown and await child exit, escalating termination on the
    /// contained tree (`require_graceful` gates the update handoff exactly like
    /// upstream `stop(requireGraceful)`).
    pub async fn stop(&self, require_graceful: bool) -> Result<(), DshError> {
        self.stop_with_graceful_deadline(GRACEFUL_STOP_TIMEOUT, require_graceful)
            .await
    }

    /// For user actions queued behind another lifecycle transaction, revalidate
    /// admission after every lock wait and before committing teardown.
    pub async fn stop_if<F>(&self, require_graceful: bool, admission: F) -> Result<(), DshError>
    where
        F: Fn() -> Result<(), DshError> + Send + Sync,
    {
        let _transaction = self.lifecycle.lock().await;
        self.stop_inner_checked(StopBudget::default(), require_graceful, Some(&admission))
            .await
    }

    /// The same stop with a shortened graceful phase (the forced tree kill and
    /// its 5 s/5 s escalation are unchanged). Used where waiting the full
    /// graceful budget is wrong — OS shutdown, and the forced-stop tests.
    pub async fn stop_with_graceful_deadline(
        &self,
        graceful_deadline: Duration,
        require_graceful: bool,
    ) -> Result<(), DshError> {
        self.stop_with_budget(
            StopBudget::with_graceful(graceful_deadline),
            require_graceful,
        )
        .await
    }

    /// One stop with an explicit escalation budget (the graceful phase is still
    /// clamped to the documented ceiling). Exposed for OS shutdown and the
    /// forced-stop paths that are already past their own deadline.
    pub async fn stop_with_budget(
        &self,
        budget: StopBudget,
        require_graceful: bool,
    ) -> Result<(), DshError> {
        // Publish the cancellation and kill the tree BEFORE taking the
        // lifecycle transaction. `start()` holds that transaction across its
        // whole run, so waiting for it first would make this stop wait for the
        // startup it is trying to cancel. The state flip is what the starting
        // run observes as `Observed::Cancelled`, and the tree kill is what
        // makes that observation prompt.
        let cancel_start = self.status().state == RuntimeState::Starting;
        if cancel_start {
            self.set_state(RuntimeState::Stopping, None, None).await;
            let containment = self.slot.lock().await.containment.clone();
            if let Some(containment) = containment {
                containment.kill_tree(true);
            }
        }
        let _transaction = self.lifecycle.lock().await;
        // A start that began between the check above and this point is still
        // covered: the state is already `Stopping`, which `start_inner`
        // re-checks before it awaits its control connection.
        if !cancel_start && self.status().state == RuntimeState::Starting {
            self.set_state(RuntimeState::Stopping, None, None).await;
            let containment = self.slot.lock().await.containment.clone();
            if let Some(containment) = containment {
                containment.kill_tree(true);
            }
        }
        self.stop_inner_checked(budget, require_graceful, None)
            .await
    }

    async fn stop_inner_checked(
        &self,
        budget: StopBudget,
        require_graceful: bool,
        admission: Option<&(dyn Fn() -> Result<(), DshError> + Send + Sync)>,
    ) -> Result<(), DshError> {
        let (link_opt, containment_opt, ack_flag) = {
            let mut slot = self.slot.lock().await;
            if let Some(check) = admission {
                check()?;
            }
            // A containment retained by an earlier failed stop is **still ours**:
            // this attempt adopts it and retries the escalation. A stop that
            // quietly reported success here is exactly how a live Host used to
            // survive a "stopped" supervisor.
            let owns_run =
                slot.child.is_some() || slot.link.is_some() || slot.containment.is_some();
            if !owns_run {
                // Never leave a stale link behind a "nothing to stop" answer.
                slot.link = None;
                return Ok(());
            }
            self.set_state_unlocked(&mut slot, RuntimeState::Stopping)
                .await;
            slot.ack.store(false, std::sync::atomic::Ordering::SeqCst);
            // The slot remains the owner while this attempt awaits shutdown.
            // Cancellation must not discard its only containment or control
            // link; a later stop can then retry the same generation.
            (
                slot.link.clone(),
                slot.containment.clone(),
                slot.ack.clone(),
            )
        };
        if let Some(link) = &link_opt {
            // The graceful request is bounded: a Host that has stopped reading
            // its control socket (or stopped draining it) must not stall the
            // stop behind queue capacity. A missed send is not a stop failure —
            // it just means the peer never got the hint, so escalation is the
            // path that actually reaps the tree. Upstream's equivalent wait is
            // the first `exitsWithin` phase (`host-process.ts:295`), so this
            // budget stays inside the documented 10 s / 5 s / 5 s escalation.
            if let Err(error) = link
                .send_with_deadline(&ShellMessage::Shutdown {}, SHUTDOWN_SEND_TIMEOUT)
                .await
            {
                tracing::warn!(
                    target: "dsh_runtime",
                    error = %error,
                    "desktop host did not accept the graceful shutdown request; escalating"
                );
            }
        }
        let Some(containment) = containment_opt else {
            // A link with no containment cannot be escalated: no tree was ever
            // ours. Settle the run instead of leaving `Stopping` behind.
            self.settle_without_tree().await;
            return Ok(());
        };
        let slot = self.slot.clone();
        let wait_exit = async move {
            loop {
                {
                    let guard = slot.lock().await;
                    if guard.exited {
                        return guard.exit_code;
                    }
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        };
        let ack = move || ack_flag.load(std::sync::atomic::Ordering::SeqCst);
        let outcome = match stop_tree(&containment, budget, wait_exit, ack).await {
            Ok(outcome) => outcome,
            Err(error) => {
                // The child survived the forced kill. Revoke the dead
                // generation's channel, keep the containment as the ownership
                // record, publish the failure and return it.
                if let Some(link) = &link_opt {
                    link.fail_pending();
                }
                return Err(self.retain_unresolved_teardown(containment, error).await);
            }
        };
        // Tree teardown: any process still inside the tree after its owner
        // exited is a straggler and must not survive (the orphan guarantee).
        // The final signal is issued while the owned job/group is still
        // provably ours, then the owned lifetime is retired so the drop below
        // cannot derive another signal from a possibly recycled identifier.
        containment.kill_tree(true);
        containment.retire();
        {
            let mut slot = self.slot.lock().await;
            slot.child = None;
            slot.link = None;
            slot.containment = None;
            // The process tree is gone regardless of whether graceful
            // validation accepts the update handoff; never retain stale boot
            // facts for a dead Host.
            slot.ready = None;
            // Credentials belong to the Host generation that produced them.
            // The tree is dead, so the newest session must be dropped here — a
            // consumer that outlives this stop must not keep seeing a token the
            // Host is no longer serving. Clearing through the sender also wakes
            // every subscriber with `None`.
            clear_platform_session(&mut slot);
            slot.teardown_error = None;
        }
        // Closing the last containment reference is the final OS teardown
        // (Windows closes the job handle; Unix retires the owned group).
        drop(containment);
        let graceful_error = if require_graceful {
            crate::proc_tree::check_graceful(&outcome)
                .err()
                .map(|error| DshError::other("update_unclean_exit", error.to_string()))
        } else {
            None
        };
        self.set_state(RuntimeState::Stopped, None, None).await;
        if let Some(error) = graceful_error {
            return Err(error);
        }
        Ok(())
    }

    /// Settle a run that owns no process tree (a control link with no
    /// containment): revoke the dead generation's facts and publish `Stopped`,
    /// so `Stopping` can never be terminal.
    async fn settle_without_tree(&self) {
        {
            let mut slot = self.slot.lock().await;
            slot.child = None;
            slot.link = None;
            slot.ready = None;
            clear_platform_session(&mut slot);
            slot.teardown_error = None;
        }
        self.set_state(RuntimeState::Stopped, None, None).await;
    }

    /// The forced stop did not confirm the child's death.
    ///
    /// Keep the containment as the authoritative ownership record (a later
    /// `stop` retries against it rather than reporting success), revoke every
    /// stale fact of the generation, publish the **real** failure in
    /// `last_error`, and return it.
    ///
    /// The state stays `Stopping` to keep unresolved teardown visible alongside
    /// `last_error`; channel failure alone is not proof that its tree exited.
    /// The generation id is deliberately not advanced either — the
    /// retained tree still belongs to it, and the exit monitor must keep
    /// reporting its exit so a later stop can settle it.
    async fn retain_unresolved_teardown(
        &self,
        containment: Arc<TreeContainment>,
        error: TreeError,
    ) -> DshError {
        let unresolved = format!(
            "{error}; the host process tree is still owned and is retried by the next stop"
        );
        {
            let mut slot = self.slot.lock().await;
            slot.containment = Some(containment);
            slot.child = None;
            slot.link = None;
            slot.ready = None;
            clear_platform_session(&mut slot);
            slot.teardown_error = Some(unresolved.clone());
        }
        self.status.send_modify(|status| {
            status.state = RuntimeState::Stopping;
            status.url = None;
            status.started_at = None;
            status.last_error = Some(unresolved.clone());
        });
        DshError::other("host_stop_unresolved", unresolved)
    }

    /// What the supervisor still owns of the Host process tree.
    ///
    /// `RuntimeState::Failed` means the *generation* is terminal; it does **not**
    /// mean the process tree is gone. An unresolved stop (the child survived the
    /// forced kill) keeps the containment and reports it here, so the quit/exit
    /// mapping can tell "cannot run tasks" from "may still be running tasks".
    pub async fn teardown_status(&self) -> TeardownStatus {
        let slot = self.slot.lock().await;
        TeardownStatus {
            tree_owned: slot.containment.is_some(),
            tree_alive: slot
                .containment
                .as_ref()
                .is_some_and(|containment| containment.tree_alive()),
            unresolved: slot.teardown_error.clone(),
        }
    }

    /// Restart the Host: stop (graceful ordering per `apps/desktop/README.md` —
    /// wait for Host shutdown before relaunching), then start again.
    pub async fn restart(&self) -> Result<RuntimeStatus, DshError> {
        self.restart_if(|| Ok(())).await
    }

    /// Revalidate after both lifecycle and process-slot waits, immediately before
    /// committing teardown. Once admitted, finish the transaction so a later
    /// revocation cannot leave an already-stopped Host orphaned or unrestarted.
    pub async fn restart_if<F>(&self, admission: F) -> Result<RuntimeStatus, DshError>
    where
        F: Fn() -> Result<(), DshError> + Send + Sync,
    {
        let _transaction = self.lifecycle.lock().await;
        self.stop_inner_checked(StopBudget::default(), false, Some(&admission))
            .await?;
        self.start_inner().await?;
        Ok(self.status())
    }

    /// Ask the Host what quitting would interrupt. **Fails closed**: an
    /// unavailable host or a missed 2-second deadline reports `activeTasks:
    /// true` (contract `runtime_quit_inspection`).
    pub async fn quit_inspection(&self) -> QuitInspection {
        let link = self.slot.lock().await.link.clone();
        let Some(link) = link else {
            let state = self.status().state;
            return QuitInspection {
                active_tasks: true,
                scheduled_tasks: false,
                error: Some(format!("runtime unavailable ({state:?})")),
            };
        };
        match inspect_quit(&link).await {
            Some(facts) => facts,
            None => QuitInspection {
                active_tasks: true,
                scheduled_tasks: false,
                error: Some("desktop quit: inspection timed out".to_string()),
            },
        }
    }

    /// Quit inspection for the quit model (unknown on failure/timeout).
    pub async fn quit_inspection_outcome(&self) -> QuitInspectionOutcome {
        let link = self.slot.lock().await.link.clone();
        let Some(link) = link else {
            return QuitInspectionOutcome::Unknown;
        };
        match inspect_quit(&link).await {
            Some(facts) => QuitInspectionOutcome::Answered(facts),
            None => QuitInspectionOutcome::Unknown,
        }
    }

    /// Update-admission inspection (`inspect` | `lock` | `unlock`).
    /// Errors mean task state is unknown and must refuse installation.
    pub async fn update_tasks(&self, action: UpdateTasksAction) -> Result<bool, DshError> {
        self.update_tasks_if(action, Self::admit_always).await
    }

    /// The unconditional admission check: `update_tasks` is exactly
    /// [`Self::update_tasks_if`] with nothing to verify.
    fn admit_always() -> Result<(), DshError> {
        Ok(())
    }

    /// The same exchange behind a synchronous admission check that runs **under
    /// the slot lock**, and with the slot held until the answer arrives.
    ///
    /// That is the serialization point a caller needs when the decision to send
    /// the request depends on state a teardown also commits under this same lock:
    /// a commit that closes something (see `stop_if`'s admission closure) and this
    /// send cannot interleave, so the request is either delivered before that
    /// commit — the commit waits for the slot — or refused after it, and it can
    /// never be sent *after* something it had to observe.
    ///
    /// The lifecycle transaction is deliberately not taken: this check must be
    /// able to run while a stop holds it, exactly as `stop_if` runs its own check
    /// under this slot. The slot is held across the exchange (bounded by the
    /// control exchange's own deadline), and the free `update_tasks` function is
    /// used on the captured link so the outer hold cannot self-deadlock.
    ///
    /// `admission` must not await, and `Err` refuses the exchange without sending
    /// anything. Errors mean task state is unknown and must refuse installation.
    pub async fn update_tasks_if<F>(
        &self,
        action: UpdateTasksAction,
        admission: F,
    ) -> Result<bool, DshError>
    where
        F: FnOnce() -> Result<(), DshError> + Send,
    {
        let slot = self.slot.lock().await;
        admission()?;
        let link = slot.link.clone().ok_or_else(|| {
            DshError::runtime_unavailable(
                format!("{:?}", self.status().state),
                "host is unavailable",
            )
        })?;
        let outcome = update_tasks(&link, action).await.map_err(control_error);
        // Explicit boundary: the slot is held across the exchange on purpose, and
        // released only once the request has been answered (or refused).
        drop(slot);
        outcome
    }

    /// Subscribe to `platform-session` updates (credentials; never log or
    /// forward to a renderer).
    ///
    /// A `watch` receiver holds only the newest value, which is exactly the
    /// protocol's semantics (at-least-once, last-value-wins): a consumer that
    /// falls behind observes the latest session instead of an unbounded backlog,
    /// and the Host event pump is never blocked by a slow credential consumer.
    ///
    /// **Subscribe-once.** There is exactly one credential sink per supervisor
    /// (upstream's shell has a single `onPlatformSession` consumer). A second
    /// caller joins the existing subscription instead of replacing its sender:
    /// replacing it would silently disconnect the first consumer and — worse —
    /// leave the *newest* session with the newest caller only, so a consumer
    /// that subscribed earlier would silently stop receiving credentials while
    /// still appearing live. The returned receiver is seeded with the session
    /// already observed, so a late subscriber (or one re-subscribing after a
    /// gap) sees the current value rather than `None`.
    pub async fn platform_sessions(
        &self,
    ) -> watch::Receiver<Option<crate::control::PlatformSession>> {
        let mut slot = self.slot.lock().await;
        if let Some(existing) = &slot.platform_sessions {
            return existing.subscribe();
        }
        let (tx, rx) = watch::channel(slot.platform_session.clone());
        slot.platform_sessions = Some(tx);
        rx
    }

    /// Readiness facts for `runtime_boot_ready`.
    pub async fn boot_facts(&self) -> Option<HostReady> {
        self.slot.lock().await.ready.clone()
    }

    fn spawn_event_pump(&self, link: Arc<ControlLink>, run_id: u64) {
        let slot = self.slot.clone();
        let on_failure = self.on_failure.clone();
        let status = self.status.clone();
        tokio::spawn(async move {
            while let Some(event) = link.next_event().await {
                match event {
                    HostEvent::Ready { url, injections } => {
                        let mut guard = slot.lock().await;
                        if guard.run_id == run_id
                            && guard.fatal.is_none()
                            && !guard.exited
                            && guard.ready.is_none()
                            && matches!(
                                status.borrow().state,
                                RuntimeState::Starting | RuntimeState::Ready
                            )
                        {
                            guard.ready = Some(HostReady {
                                url,
                                injections,
                                started_at: chrono::Utc::now()
                                    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                            });
                            let _ = publish_ready(&guard, &status, run_id);
                        }
                    }
                    HostEvent::Fatal {
                        message,
                        diagnostic,
                    } => {
                        terminal_failure(
                            &slot,
                            &status,
                            &on_failure,
                            run_id,
                            HostFatal {
                                message,
                                diagnostic,
                            },
                        )
                        .await;
                    }
                    HostEvent::PlatformSession { session } => {
                        if session.as_ref().is_some_and(|session| !session.validate()) {
                            terminal_failure(
                                &slot,
                                &status,
                                &on_failure,
                                run_id,
                                HostFatal {
                                    message: "dsh desktop host sent an invalid IPC event".into(),
                                    diagnostic: None,
                                },
                            )
                            .await;
                            continue;
                        }
                        let mut guard = slot.lock().await;
                        // Generation guard: a session published by a superseded
                        // Host run must never be recorded or delivered, or an old
                        // generation's credentials would reappear after a
                        // restart replaced them.
                        record_platform_session(&mut guard, run_id, status.borrow().state, session);
                    }
                    HostEvent::ShutdownComplete {} => {
                        if status.borrow().state == RuntimeState::Stopping {
                            let guard = slot.lock().await;
                            if guard.run_id == run_id {
                                guard.ack.store(true, std::sync::atomic::Ordering::SeqCst);
                            }
                        } else {
                            terminal_failure(
                                &slot,
                                &status,
                                &on_failure,
                                run_id,
                                HostFatal {
                                    message:
                                        "dsh desktop host acknowledged an unrequested shutdown"
                                            .into(),
                                    diagnostic: None,
                                },
                            )
                            .await;
                        }
                    }
                    HostEvent::UpdateTasks { .. } | HostEvent::QuitInspection { .. } => {
                        // Correlated responses are routed to their waiters in
                        // the link; a late response finds no waiter and drops.
                    }
                }
            }
            // Process exit closes control at nearly the same time it becomes
            // observable to the child monitor. Let that monitor publish its
            // more informative exit-code diagnosis first when applicable.
            tokio::time::sleep(Duration::from_millis(50)).await;
            let exit_code = {
                let guard = slot.lock().await;
                (guard.run_id == run_id && guard.exited)
                    .then_some(guard.exit_code)
                    .flatten()
            };
            let message = match exit_code {
                Some(code) => format!("the dsh host exited unexpectedly (exit code {code})"),
                None => "dsh desktop host control channel closed unexpectedly".into(),
            };
            terminal_failure(
                &slot,
                &status,
                &on_failure,
                run_id,
                HostFatal {
                    message,
                    diagnostic: None,
                },
            )
            .await;
        });
    }

    fn spawn_exit_monitor(&self, run_id: u64) {
        let slot = self.slot.clone();
        let status = self.status.clone();
        let on_failure = self.on_failure.clone();
        tokio::spawn(async move {
            let mut child = {
                let mut guard = slot.lock().await;
                if guard.run_id == run_id {
                    guard.child.take()
                } else {
                    None
                }
            };
            let code = match child.as_mut() {
                Some(child) => child.wait().await.ok().map(|status| status.code()),
                None => None,
            };
            {
                let mut guard = slot.lock().await;
                if guard.run_id != run_id {
                    return;
                }
                guard.exited = true;
                guard.exit_code = code.flatten();
            }
            // A readiness waiter must observe every child exit, including an
            // expected exit while Stopping (terminal_failure intentionally
            // leaves that state alone and therefore cannot provide this wake).
            status.send_modify(|_| {});
            terminal_failure(
                &slot,
                &status,
                &on_failure,
                run_id,
                HostFatal {
                    message: match code.flatten() {
                        Some(code) => {
                            format!("the dsh host exited unexpectedly (exit code {code})")
                        }
                        None => "the dsh host exited unexpectedly (no exit code)".to_string(),
                    },
                    diagnostic: None,
                },
            )
            .await;
        });
    }

    /// Force cleanup after an unsuccessful startup and retain containment until
    /// the exit monitor and tree accounting both confirm settlement. Keeping the
    /// slot's owner throughout the wait also makes caller cancellation safe.
    async fn cleanup_failed_start(&self) -> Result<(), DshError> {
        self.cleanup_failed_start_with_timeout(Duration::from_secs(5))
            .await
    }

    async fn cleanup_failed_start_with_timeout(&self, timeout: Duration) -> Result<(), DshError> {
        let containment = {
            let mut slot = self.slot.lock().await;
            if let Some(link) = slot.link.take() {
                link.fail_pending();
            }
            slot.ready = None;
            clear_platform_session(&mut slot);
            if slot.containment.is_some() {
                self.status.send_modify(|status| {
                    status.state = RuntimeState::Stopping;
                    status.url = None;
                    status.started_at = None;
                });
            }
            slot.containment.clone()
        };
        if let Some(containment) = containment {
            containment.kill_tree(true);
            let settled = tokio::time::timeout(timeout, async {
                loop {
                    if self.slot.lock().await.exited && !containment.tree_alive() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            if settled.is_err() {
                return Err(self
                    .retain_unresolved_teardown(containment, TreeError::SurvivedForcedKill)
                    .await);
            }
            containment.retire();
        }
        let mut slot = self.slot.lock().await;
        slot.containment = None;
        slot.link = None;
        slot.child = None;
        slot.ready = None;
        slot.teardown_error = None;
        // End the generation under the same lock as revocation. A frame
        // already queued by the failed Host must not republish its credentials
        // after cleanup but before the caller publishes Failed/Stopped.
        slot.run_id = slot.run_id.wrapping_add(1);
        clear_platform_session(&mut slot);
        Ok(())
    }

    async fn exit_error(&self) -> DshError {
        let slot = self.slot.lock().await;
        let tail = slot.stderr.lock().await.snapshot().trim().to_string();
        let suffix = if tail.is_empty() {
            String::new()
        } else {
            format!(": {tail}")
        };
        match slot.exit_code {
            Some(code) => DshError::other(
                "host_startup_child_exit",
                format!("dsh desktop host exited with code {code}{suffix}"),
            ),
            None => DshError::other(
                "host_startup_child_exit",
                format!("dsh desktop host exited without an exit code{suffix}"),
            ),
        }
    }

    async fn set_state(
        &self,
        state: RuntimeState,
        url: Option<String>,
        last_error: Option<String>,
    ) {
        let slot = self.slot.lock().await;
        let started_at = slot.ready.as_ref().map(|ready| ready.started_at.clone());
        // Publish the complete snapshot while still owning the slot. A second
        // publication after unlocking could overwrite a concurrent failure.
        self.status.send_modify(|status| {
            status.state = state;
            status.url = url;
            status.started_at = started_at;
            status.last_error = last_error;
        });
        drop(slot);
    }

    async fn set_state_unlocked(&self, _slot: &mut RunSlot, state: RuntimeState) {
        self.status.send_modify(|status| {
            status.state = state;
        });
    }
}

/// Publish complete readiness only while the caller holds the current run slot.
/// A previously copied Ready fact cannot undo a terminal or stopping generation.
fn publish_ready(
    slot: &RunSlot,
    status: &watch::Sender<RuntimeStatus>,
    run_id: u64,
) -> Option<HostReady> {
    if slot.run_id != run_id
        || slot.fatal.is_some()
        || slot.exited
        || !matches!(
            status.borrow().state,
            RuntimeState::Starting | RuntimeState::Ready
        )
    {
        return None;
    }
    let ready = slot.ready.clone()?;
    status.send_modify(|current| {
        current.state = RuntimeState::Ready;
        current.url = Some(ready.url.clone());
        current.started_at = Some(ready.started_at.clone());
        current.last_error = None;
    });
    Some(ready)
}

/// Commit only a live generation's latest credential record. Queueing a frame
/// does not grant it a lifetime beyond a terminal failure or startup cleanup.
fn record_platform_session(
    slot: &mut RunSlot,
    run_id: u64,
    runtime_state: RuntimeState,
    session: Option<crate::control::PlatformSession>,
) -> bool {
    if slot.run_id != run_id
        || slot.fatal.is_some()
        || slot.exited
        || !matches!(runtime_state, RuntimeState::Starting | RuntimeState::Ready)
    {
        return false;
    }
    slot.platform_session = session.clone();
    if let Some(sender) = &slot.platform_sessions {
        // Last value wins, with no credential backlog for slow subscribers.
        sender.send_replace(session);
    }
    true
}

/// Publish `None` to the credential sink and forget the recorded session.
///
/// Called wherever a Host generation ends or is replaced (stop, restart, a new
/// run, terminal failure) so credentials never outlive their Host: the sender
/// is kept so existing subscribers are woken with `None` rather than left
/// holding a dead token, and `platform_session` is cleared so a subscriber that
/// arrives later is seeded with `None` instead of the previous generation's
/// session.
fn clear_platform_session(slot: &mut RunSlot) {
    slot.platform_session = None;
    if let Some(sender) = &slot.platform_sessions {
        sender.send_replace(None);
    }
}

async fn terminal_failure(
    slot: &Arc<Mutex<RunSlot>>,
    status: &watch::Sender<RuntimeStatus>,
    on_failure: &Option<FailureCallback>,
    run_id: u64,
    fatal: HostFatal,
) {
    let notify = {
        let mut guard = slot.lock().await;
        if guard.run_id != run_id
            || guard.fatal.is_some()
            || !matches!(
                status.borrow().state,
                RuntimeState::Starting | RuntimeState::Ready
            )
        {
            false
        } else {
            guard.fatal = Some(fatal.clone());
            guard.ready = None;
            // The Host is terminal: its credentials are dead with it and must
            // not survive into whatever the caller does next.
            clear_platform_session(&mut guard);
            if let Some(link) = &guard.link {
                link.fail_pending();
            }
            if !guard.failure_reported {
                guard.failure_reported = true;
                status.send_modify(|current| {
                    current.state = RuntimeState::Failed;
                    current.url = None;
                    current.started_at = None;
                    current.last_error = Some(fatal.message.clone());
                });
                true
            } else {
                false
            }
        }
    };
    if notify {
        if let Some(callback) = on_failure {
            callback(&fatal);
        }
    }
}

fn control_error(error: ControlError) -> DshError {
    match error {
        ControlError::Transport(message) if message.contains("deadline") => {
            DshError::timeout("control request", 0)
        }
        ControlError::Authentication | ControlError::GenerationMismatch { .. } => {
            DshError::runtime_unavailable("starting", error.to_string())
        }
        other => DshError::runtime_unavailable("running", other.to_string()),
    }
}

/// Whether `pid` is still alive (re-exported for shutdown verification).
pub fn host_process_alive(pid: u32) -> bool {
    process_alive(pid)
}

#[cfg(test)]
mod credential_lifetime_tests {
    use super::*;
    use crate::control::PlatformSession;

    #[test]
    fn desktop_spawn_omits_an_unstaged_primary_payload() {
        let plan = SpawnPlan::desktop_host(
            "node".into(),
            "adapter.mjs".into(),
            "runtime".into(),
            "project".into(),
            None,
            None,
            None,
        );
        assert_eq!(
            plan.args,
            ["--expose-internals", "adapter.mjs", "runtime", "project"]
        );
    }

    #[test]
    fn desktop_spawn_preserves_explicit_primary_payload() {
        let plan = SpawnPlan::desktop_host(
            "node".into(),
            "adapter.mjs".into(),
            "runtime".into(),
            "project".into(),
            Some("primary".into()),
            None,
            None,
        );
        assert_eq!(plan.args[4], "primary");
    }

    #[test]
    fn desktop_spawn_keeps_package_manager_positions_without_primary_payload() {
        let plan = SpawnPlan::desktop_host(
            "node".into(),
            "adapter.mjs".into(),
            "runtime".into(),
            "project".into(),
            None,
            Some(PackageManager {
                pnpm: "pnpm.mjs".into(),
                node_bin: "node-bin".into(),
            }),
            None,
        );
        assert_eq!(&plan.args[4..], ["", "pnpm.mjs", "node-bin"]);
    }

    fn supervisor() -> Supervisor {
        Supervisor::new(
            SpawnPlan {
                program: PathBuf::from("unused-fixture-node"),
                args: Vec::new(),
                cwd: PathBuf::from("."),
                env: BTreeMap::new(),
                forward_stdout: false,
            },
            None,
        )
    }

    fn ready_fact() -> HostReady {
        HostReady {
            url: "http://127.0.0.1:12345/fixture".into(),
            injections: None,
            started_at: "2026-09-30T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn readiness_publishes_a_complete_current_generation_snapshot() {
        let supervisor = supervisor();
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Starting);
        let mut listener = supervisor.subscribe();
        let mut slot = supervisor.slot.lock().await;
        slot.run_id = 7;
        slot.ready = Some(ready_fact());
        let ready = publish_ready(&slot, &supervisor.status, 7).unwrap();
        let status = listener.borrow_and_update().clone();
        assert_eq!(status.state, RuntimeState::Ready);
        assert_eq!(status.url.as_deref(), Some(ready.url.as_str()));
        assert_eq!(
            status.started_at.as_deref(),
            Some(ready.started_at.as_str())
        );
        assert!(status.last_error.is_none());
    }

    #[tokio::test]
    async fn a_stale_ready_observation_cannot_overwrite_a_terminal_failure() {
        let supervisor = supervisor();
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Starting);
        let observed = {
            let mut slot = supervisor.slot.lock().await;
            slot.run_id = 7;
            slot.ready = Some(ready_fact());
            slot.ready.clone().unwrap()
        };
        terminal_failure(
            &supervisor.slot,
            &supervisor.status,
            &None,
            7,
            HostFatal {
                message: "failure after readiness observation".into(),
                diagnostic: None,
            },
        )
        .await;
        let slot = supervisor.slot.lock().await;
        assert!(
            !observed.url.is_empty(),
            "the old startup path held this copied fact"
        );
        assert!(publish_ready(&slot, &supervisor.status, 7).is_none());
        let status = supervisor.status();
        assert_eq!(status.state, RuntimeState::Failed);
        assert!(status.url.is_none());
        assert!(status.started_at.is_none());
        assert_eq!(
            status.last_error.as_deref(),
            Some("failure after readiness observation")
        );
    }

    #[tokio::test]
    async fn readiness_refuses_cancelled_failed_exited_or_replaced_generations() {
        let supervisor = supervisor();
        let mut slot = supervisor.slot.lock().await;
        slot.run_id = 7;
        slot.ready = Some(ready_fact());
        for state in [
            RuntimeState::Stopping,
            RuntimeState::Stopped,
            RuntimeState::Failed,
        ] {
            supervisor.status.send_modify(|status| status.state = state);
            assert!(publish_ready(&slot, &supervisor.status, 7).is_none());
            assert_eq!(supervisor.status().state, state);
        }
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Starting);
        assert!(publish_ready(&slot, &supervisor.status, 6).is_none());
        slot.exited = true;
        assert!(publish_ready(&slot, &supervisor.status, 7).is_none());
        assert_eq!(supervisor.status().state, RuntimeState::Starting);
    }

    fn session() -> Option<PlatformSession> {
        Some(PlatformSession {
            origin: "https://fixture.invalid".into(),
            token: "fixture-secret".into(),
            user_id: None,
            embedded_page_dist: None,
            request_headers: None,
        })
    }

    async fn denied_lifecycle_does_not_mutate_after_lock_wait(restart: bool, wait_on_slot: bool) {
        use std::{
            future::Future,
            sync::atomic::{AtomicBool, AtomicUsize, Ordering},
            task::Poll,
        };
        let supervisor = supervisor();
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Ready);
        {
            let mut slot = supervisor.slot.lock().await;
            slot.run_id = 7;
            assert!(record_platform_session(
                &mut slot,
                7,
                RuntimeState::Ready,
                session()
            ));
        }
        let before = supervisor.status();
        let admitted = AtomicBool::new(true);
        let checked = AtomicUsize::new(0);
        let lifecycle = if wait_on_slot {
            None
        } else {
            Some(supervisor.lifecycle.lock().await)
        };
        let slot = if wait_on_slot {
            Some(supervisor.slot.lock().await)
        } else {
            None
        };
        let admission = || {
            checked.fetch_add(1, Ordering::SeqCst);
            if admitted.load(Ordering::SeqCst) {
                Ok(())
            } else {
                Err(DshError::other("fixture_denied", "revoked while waiting"))
            }
        };
        let operation = async {
            if restart {
                supervisor.restart_if(admission).await.map(|_| ())
            } else {
                supervisor.stop_if(false, admission).await.map(|_| ())
            }
        };
        tokio::pin!(operation);
        assert!(
            std::future::poll_fn(|cx| Poll::Ready(operation.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        assert_eq!(
            checked.load(Ordering::SeqCst),
            0,
            "admission is checked after both locks"
        );
        admitted.store(false, Ordering::SeqCst);
        drop(slot);
        drop(lifecycle);
        let error = tokio::time::timeout(Duration::from_secs(1), operation)
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, DshError::Other { ref code, .. } if code == "fixture_denied"));
        assert_eq!(checked.load(Ordering::SeqCst), 1);
        assert_eq!(supervisor.status().state, before.state);
        assert_eq!(supervisor.status().url, before.url);
        let slot = supervisor.slot.lock().await;
        assert_eq!(slot.run_id, 7);
        assert!(
            slot.platform_session.is_some(),
            "denial must not revoke live credentials"
        );
        assert!(!slot.exited);
    }

    #[tokio::test]
    async fn stop_and_restart_revalidate_after_lifecycle_wait() {
        for restart in [false, true] {
            denied_lifecycle_does_not_mutate_after_lock_wait(restart, false).await;
        }
    }
    #[tokio::test]
    async fn stop_and_restart_revalidate_after_process_slot_wait() {
        for restart in [false, true] {
            denied_lifecycle_does_not_mutate_after_lock_wait(restart, true).await;
        }
    }

    #[tokio::test]
    async fn failed_start_revokes_existing_and_late_subscribers_and_queued_frames() {
        let supervisor = supervisor();
        let mut existing = supervisor.platform_sessions().await;
        {
            let mut slot = supervisor.slot.lock().await;
            slot.run_id = 7;
            assert!(record_platform_session(
                &mut slot,
                7,
                RuntimeState::Starting,
                session()
            ));
        }
        assert!(existing.borrow_and_update().is_some());
        supervisor
            .cleanup_failed_start()
            .await
            .expect("a startup with no owned tree settles");
        assert!(existing.has_changed().unwrap());
        assert!(existing.borrow_and_update().is_none());
        assert!(supervisor.platform_sessions().await.borrow().is_none());
        {
            let mut slot = supervisor.slot.lock().await;
            assert!(!record_platform_session(
                &mut slot,
                7,
                RuntimeState::Starting,
                session()
            ));
            assert!(slot.platform_session.is_none());
        }
        assert!(
            !existing.has_changed().unwrap(),
            "queued old frame cannot regrant credentials"
        );
    }

    #[tokio::test]
    async fn terminal_failure_cannot_be_undone_by_a_same_generation_frame() {
        let supervisor = supervisor();
        let mut existing = supervisor.platform_sessions().await;
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Ready);
        {
            let mut slot = supervisor.slot.lock().await;
            slot.run_id = 4;
            assert!(record_platform_session(
                &mut slot,
                4,
                RuntimeState::Ready,
                session()
            ));
        }
        assert!(existing.borrow_and_update().is_some());
        terminal_failure(
            &supervisor.slot,
            &supervisor.status,
            &None,
            4,
            HostFatal {
                message: "fixture failure".into(),
                diagnostic: None,
            },
        )
        .await;
        assert!(existing.borrow_and_update().is_none());
        let mut slot = supervisor.slot.lock().await;
        assert!(!record_platform_session(
            &mut slot,
            4,
            RuntimeState::Ready,
            session()
        ));
        assert!(slot.platform_session.is_none());
    }

    #[tokio::test]
    async fn stopped_or_exited_host_cannot_publish_even_with_current_run_id() {
        let supervisor = supervisor();
        let mut slot = supervisor.slot.lock().await;
        for state in [
            RuntimeState::Stopping,
            RuntimeState::Stopped,
            RuntimeState::Failed,
        ] {
            assert!(!record_platform_session(&mut slot, 0, state, session()));
        }
        slot.exited = true;
        assert!(!record_platform_session(
            &mut slot,
            0,
            RuntimeState::Ready,
            session()
        ));
        assert!(slot.platform_session.is_none());
    }
}

/// The stop-transaction repair: an unresolved teardown keeps ownership,
/// revokes the dead generation's facts, publishes the real failure, and is
/// retried (never silently reported as success) by a later stop.
#[cfg(test)]
mod stop_teardown_tests {
    use super::*;
    use crate::proc_tree::TreeContainment;

    fn supervisor() -> Supervisor {
        Supervisor::new(
            SpawnPlan {
                program: PathBuf::from("unused-fixture-node"),
                args: Vec::new(),
                cwd: PathBuf::from("."),
                env: BTreeMap::new(),
                forward_stdout: false,
            },
            None,
        )
    }

    async fn install_owned_tree(supervisor: &Supervisor, run_id: u64) {
        let mut slot = supervisor.slot.lock().await;
        slot.run_id = run_id;
        slot.containment = Some(Arc::new(TreeContainment::inert_for_tests()));
        slot.child = None;
        slot.link = None;
        slot.exited = false;
        slot.exit_code = None;
        slot.failure_reported = false;
        slot.teardown_error = None;
        slot.ready = Some(HostReady {
            url: "http://127.0.0.1:12345/fixture".into(),
            injections: None,
            started_at: "2026-10-01T00:00:00Z".into(),
        });
        // Publish a live generation with credentials, so the revocation can be
        // observed rather than assumed.
        assert!(record_platform_session(
            &mut slot,
            run_id,
            RuntimeState::Ready,
            Some(crate::control::PlatformSession {
                origin: "https://fixture.invalid".into(),
                token: "fixture-secret".into(),
                user_id: None,
                embedded_page_dist: None,
                request_headers: None,
            })
        ));
        supervisor.status.send_modify(|status| {
            status.state = RuntimeState::Ready;
            status.url = slot.ready.as_ref().map(|ready| ready.url.clone());
            status.started_at = slot.ready.as_ref().map(|ready| ready.started_at.clone());
            status.last_error = None;
        });
    }

    fn immediate_budget() -> StopBudget {
        StopBudget::new(
            Duration::from_millis(5),
            Duration::from_millis(5),
            Duration::from_millis(5),
        )
    }

    #[tokio::test]
    async fn startup_cleanup_timeout_keeps_ownership_until_the_child_is_reaped() {
        let supervisor = supervisor();
        let mut sessions = supervisor.platform_sessions().await;
        install_owned_tree(&supervisor, 7).await;
        assert!(sessions.borrow_and_update().is_some());

        let error = supervisor
            .cleanup_failed_start_with_timeout(Duration::from_millis(5))
            .await
            .expect_err("an unreaped child must not be treated as settled");
        assert!(matches!(
            error,
            DshError::Other { ref code, .. } if code == "host_stop_unresolved"
        ));
        let teardown = supervisor.teardown_status().await;
        assert!(
            teardown.tree_owned,
            "a startup cleanup timeout must retain the unreaped tree: {teardown:?}"
        );
        assert!(!teardown.is_settled());
        assert_eq!(supervisor.slot.lock().await.run_id, 7);
        assert!(supervisor.boot_facts().await.is_none());
        assert!(sessions.borrow_and_update().is_none());
        assert!(matches!(
            supervisor.start().await,
            Err(DshError::Other { ref code, .. }) if code == "host_start_blocked"
        ));

        {
            let mut slot = supervisor.slot.lock().await;
            slot.exited = true;
            slot.exit_code = Some(1);
        }
        supervisor
            .stop_with_budget(immediate_budget(), false)
            .await
            .expect("an observed child exit allows a later stop to settle");
        assert!(supervisor.teardown_status().await.is_settled());
    }

    #[tokio::test]
    async fn cancelled_startup_cleanup_keeps_the_tree_owned() {
        let supervisor = supervisor();
        install_owned_tree(&supervisor, 7).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(10), supervisor.cleanup_failed_start(),)
                .await
                .is_err()
        );
        assert!(
            supervisor.teardown_status().await.tree_owned,
            "dropping cleanup must not drop the only containment owner"
        );
        assert_eq!(supervisor.slot.lock().await.run_id, 7);
    }

    #[tokio::test]
    async fn cancelled_stop_keeps_containment_for_a_later_retry() {
        let supervisor = supervisor();
        install_owned_tree(&supervisor, 7).await;
        assert!(tokio::time::timeout(
            Duration::from_millis(10),
            supervisor.stop_with_budget(StopBudget::default(), false),
        )
        .await
        .is_err());
        assert!(
            supervisor.teardown_status().await.tree_owned,
            "cancelling stop must not discard its containment owner"
        );
        assert_eq!(supervisor.slot.lock().await.run_id, 7);
        {
            let mut slot = supervisor.slot.lock().await;
            slot.exited = true;
            slot.exit_code = Some(1);
        }
        supervisor
            .stop_with_budget(immediate_budget(), false)
            .await
            .expect("the retained tree can settle through a later stop");
        assert!(supervisor.teardown_status().await.is_settled());
    }

    #[tokio::test]
    async fn an_unresolved_stop_retains_ownership_and_publishes_the_real_failure() {
        let supervisor = supervisor();
        let mut sessions = supervisor.platform_sessions().await;
        install_owned_tree(&supervisor, 7).await;
        assert!(sessions.borrow_and_update().is_some());

        let error = supervisor
            .stop_with_budget(immediate_budget(), false)
            .await
            .expect_err("a child that survives the forced kill is an unresolved stop");
        assert!(
            matches!(error, DshError::Other { ref code, .. } if code == "host_stop_unresolved"),
            "the stop must report a stable unresolved-teardown error, got {error:?}"
        );

        // Ownership is retained, so an unresolved stop can never be mistaken
        // for a tree that is gone.
        let status = supervisor.teardown_status().await;
        assert!(status.tree_owned, "the containment is still ours");
        assert!(
            status.unresolved.is_some(),
            "the unresolved teardown is reported"
        );
        assert!(!status.is_settled());

        // The dead generation's facts are revoked, including credentials — but
        // the state is NOT `Failed`: that is reserved for a generation whose
        // death is proven, and a caller that reads "failed" as "cannot run
        // tasks" would quit on top of a tree that may still be running work.
        let published = supervisor.status();
        assert_eq!(
            published.state,
            RuntimeState::Stopping,
            "an unresolved stop is not a proven-terminal generation"
        );
        assert!(published.url.is_none());
        assert!(published.started_at.is_none());
        let message = published.last_error.unwrap_or_default();
        assert!(
            message.contains("did not exit after the forced tree kill"),
            "the published failure must be the real one, got: {message}"
        );
        assert!(
            sessions.borrow_and_update().is_none(),
            "credentials must not outlive the revoked generation"
        );

        // A later stop *retries and reports*: it cannot answer `Ok` while the
        // tree is still owned.
        let retried = supervisor
            .stop_with_budget(immediate_budget(), false)
            .await
            .expect_err("the retry reports the same unresolved teardown");
        assert!(
            matches!(retried, DshError::Other { ref code, .. } if code == "host_stop_unresolved")
        );

        // Starting on top of an unresolved tree is refused rather than silently
        // dropping the only handle we have to it.
        let blocked = supervisor.start().await.expect_err("start is blocked");
        assert!(
            matches!(blocked, DshError::Other { ref code, .. } if code == "host_start_blocked")
        );

        // Once the retained tree actually settles, the next stop completes and
        // clears the unresolved record.
        {
            let mut slot = supervisor.slot.lock().await;
            slot.exited = true;
            slot.exit_code = Some(1);
        }
        supervisor
            .stop_with_budget(immediate_budget(), false)
            .await
            .expect("a settled tree stops cleanly");
        assert_eq!(supervisor.status().state, RuntimeState::Stopped);
        let settled = supervisor.teardown_status().await;
        assert!(settled.is_settled(), "ownership is released: {settled:?}");
        assert!(settled.unresolved.is_none());
    }

    #[tokio::test]
    async fn a_stop_that_owns_only_a_link_settles_instead_of_staying_in_stopping() {
        let supervisor = supervisor();
        let endpoint = crate::control::ControlEndpoint::generate();
        let server = crate::control::ControlServer::bind(endpoint.clone())
            .await
            .expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let child = crate::control::connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Ready);
        {
            // A link with no containment: no tree was ever ours, so the stop must
            // settle the run rather than leave it in Stopping.
            let mut slot = supervisor.slot.lock().await;
            slot.run_id = 3;
            slot.link = Some(Arc::new(link));
            slot.child = None;
            slot.containment = None;
            slot.ready = Some(HostReady {
                url: "http://127.0.0.1:12345/fixture".into(),
                injections: None,
                started_at: "2026-10-01T00:00:00Z".into(),
            });
        }
        supervisor
            .stop_with_budget(immediate_budget(), false)
            .await
            .expect("a link-only run settles");
        assert_eq!(supervisor.status().state, RuntimeState::Stopped);
        assert!(supervisor.status().url.is_none());
        assert!(supervisor.boot_facts().await.is_none());
        assert!(supervisor.teardown_status().await.is_settled());
        drop(child);
    }

    #[tokio::test]
    async fn a_healthy_generation_reports_an_owned_tree() {
        let supervisor = supervisor();
        supervisor
            .status
            .send_modify(|status| status.state = RuntimeState::Ready);
        {
            let mut slot = supervisor.slot.lock().await;
            slot.run_id = 5;
            slot.containment = Some(Arc::new(TreeContainment::inert_for_tests()));
        }
        let status = supervisor.teardown_status().await;
        assert!(status.tree_owned);
        assert!(
            status.unresolved.is_none(),
            "a healthy generation has no unresolved teardown"
        );
    }
}

/// The admission-gated `update-tasks` exchange: the check runs before anything is
/// sent, and the unconditional form is the same code path.
#[cfg(test)]
mod update_tasks_admission_tests {
    use super::*;

    fn supervisor() -> Supervisor {
        Supervisor::new(
            SpawnPlan {
                program: PathBuf::from("unused-fixture-node"),
                args: Vec::new(),
                cwd: PathBuf::from("."),
                env: BTreeMap::new(),
                forward_stdout: false,
            },
            None,
        )
    }

    #[tokio::test]
    async fn a_refused_admission_never_reaches_the_exchange() {
        let supervisor = supervisor();
        // No Host is running, so an accepted exchange can only report that the
        // Host is unavailable — which is what makes the refusal below provable.
        let missing = supervisor
            .update_tasks(UpdateTasksAction::Unlock)
            .await
            .expect_err("no host is running");
        assert!(format!("{missing}").contains("unavailable"), "{missing}");

        // The refusal is the closure's own error, so the exchange was never
        // reached: a request the admission check refuses is not sent.
        let refused = supervisor
            .update_tasks_if(UpdateTasksAction::Unlock, || -> Result<(), DshError> {
                Err(DshError::other("admission_refused", "the check refused"))
            })
            .await
            .expect_err("the refusal is reported");
        assert!(
            matches!(&refused, DshError::Other { code, .. } if code == "admission_refused"),
            "{refused}"
        );
        assert!(
            !format!("{refused}").contains("unavailable"),
            "a refused request must not be sent: {refused}"
        );

        // An accepted admission proceeds to the exchange, which then fails for the
        // missing Host: the unconditional form is exactly this with `Ok(())`.
        let accepted = supervisor
            .update_tasks_if(UpdateTasksAction::Unlock, || -> Result<(), DshError> {
                Ok(())
            })
            .await
            .expect_err("no host is running");
        assert!(format!("{accepted}").contains("unavailable"), "{accepted}");
    }
}
