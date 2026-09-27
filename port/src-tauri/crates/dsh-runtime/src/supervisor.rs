//! Runtime supervisor: spawn, monitor, restart and stop the dsh Host process
//! tree, carrying the Desktop-Host lifecycle protocol generation 4.
//!
//! Spawn contract transcribed from `_upstream/apps/desktop/src/host-process.ts:186-205`
//! and `node-environment.ts:12-18` (with `apps/desktop-host/src/index.ts:19-41`
//! argv order): `--expose-internals` first, optional dev inspector, the entry
//! script, then `runtimeDir projectDir primaryRuntime [pnpm nodeBin]`; `cwd` is
//! the project (desktop profile) directory; the environment is the caller
//! environment verbatim plus `ELECTRON_RUN_AS_NODE=1`; stdio is
//! `ignore/inherit/capture` — stderr is retained as a bounded 64 Ki-character
//! tail and stdout is forwarded. The Node IPC slot is replaced by the NDJSON
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

/// Maximum time allowed for the Host to establish its authenticated control connection.
const STARTUP_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);

use dsh_core::diagnostics::StderrTail;
use dsh_core::error::DshError;
use dsh_core::protocol::{
    IndexInjection, QuitInspection, RuntimeState, RuntimeStatus,
};
use dsh_core::quit::QuitInspectionOutcome;
use tokio::sync::watch;
use tokio::sync::Mutex;

use crate::control::{
    ControlEndpoint, ControlError, ControlLink, ControlServer, HostEvent, ShellMessage,
    UpdateTasksAction,
};
use crate::proc_tree::{process_alive, stop_tree, TreeContainment};
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
        let primary = primary_runtime.unwrap_or_else(|| {
            runtime_dir
                .join("..")
                .join("runtime")
                .join("primary-runtime")
        });
        args.push(primary.to_string_lossy().into_owned());
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

struct RunSlot {
    link: Option<Arc<ControlLink>>,
    containment: Option<TreeContainment>,
    child: Option<tokio::process::Child>,
    /// `shutdown-complete` observed for the current run (AtomicBool so the stop
    /// path can read it without blocking inside async code).
    ack: Arc<std::sync::atomic::AtomicBool>,
    exit_code: Option<i32>,
    exited: bool,
    ready: Option<HostReady>,
    fatal: Option<HostFatal>,
    stderr: Arc<Mutex<StderrTail>>,
    platform_sessions:
        Option<tokio::sync::mpsc::UnboundedSender<Option<crate::control::PlatformSession>>>,
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
    on_failure: Option<FailureCallback>,
}

impl Supervisor {
    /// Create a supervisor for `plan`; `on_failure` receives the first
    /// unexpected child failure exactly once per run.
    pub fn new(
        plan: SpawnPlan,
        on_failure: Option<FailureHandler>,
    ) -> Self {
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
            })),
            on_failure: on_failure.map(|f| -> FailureCallback { Arc::from(f) }),
        }
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
        self.slot.lock().await.stderr.lock().await.snapshot().to_string()
    }

    /// Start one Host child and await its `ready` message (the readiness
    /// boundary of the lifecycle protocol). Concurrent callers join the run.
    pub async fn start(&self) -> Result<HostReady, DshError> {
        self.set_state(RuntimeState::Starting, None, None).await;
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.map_err(control_error)?;
        let mut command = tokio::process::Command::new(&self.plan.program);
        command
            .args(&self.plan.args)
            .current_dir(&self.plan.cwd)
            .envs(&self.plan.env)
            .envs(endpoint.child_environment())
            .stdin(std::process::Stdio::null())
            .stderr(std::process::Stdio::piped());
        if self.plan.forward_stdout {
            command.stdout(std::process::Stdio::inherit());
        } else {
            command.stdout(std::process::Stdio::null());
        }
        #[cfg(unix)]
        std::os::unix::process::CommandExt::process_group(&mut command, 0);
        let mut child = command.spawn().map_err(|e| {
            DshError::io("spawn host", Some(self.plan.program.display().to_string()), &e)
        })?;
        let pid = child.id().ok_or_else(|| {
            DshError::runtime_unavailable("starting", "host child exited before containment")
        })?;
        let containment = match TreeContainment::contain(pid) {
            Ok(containment) => containment,
            Err(error) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(DshError::runtime_unavailable("starting", error.to_string()));
            }
        };
        // Bounded stderr capture (64 Ki chars; host-process.ts:204).
        let stderr = self.slot.lock().await.stderr.clone();
        if let Some(stderr_pipe) = child.stderr.take() {
            tokio::spawn(async move {
                use tokio::io::AsyncReadExt;
                let mut pipe = stderr_pipe;
                let mut buffer = [0u8; 8192];
                loop {
                    match pipe.read(&mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            if let Ok(text) = std::str::from_utf8(&buffer[..count]) {
                                stderr.lock().await.push(text);
                            } else {
                                stderr.lock().await.push(&String::from_utf8_lossy(&buffer[..count]));
                            }
                        }
                    }
                }
            });
        }
        // Publish ownership before the first await that can stall. The monitor
        // takes the Child handle but the slot retains the containment guard, so
        // stop() and failure cleanup can always terminate/reap the tree.
        {
            let mut slot = self.slot.lock().await;
            slot.link = None;
            slot.containment = Some(containment);
            slot.child = Some(child);
            slot.ack.store(false, std::sync::atomic::Ordering::SeqCst);
            slot.exit_code = None;
            slot.exited = false;
            slot.ready = None;
            slot.fatal = None;
        }
        self.spawn_exit_monitor();
        let mut watch_status = self.status.subscribe();
        match self.status().state {
            RuntimeState::Failed => {
                let error = self.exit_error().await;
                self.cleanup_failed_start().await;
                self.set_state(RuntimeState::Failed, None, Some(error.to_string())).await;
                return Err(error);
            }
            RuntimeState::Stopping | RuntimeState::Stopped => {
                self.cleanup_failed_start().await;
                return Err(DshError::other("host_startup_cancelled", "host startup was cancelled"));
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
                    self.cleanup_failed_start().await;
                    self.set_state(RuntimeState::Failed, None, Some(error.to_string())).await;
                    return Err(error);
                }
                self.cleanup_failed_start().await;
                return Err(DshError::other("host_startup_cancelled", "host startup was cancelled"));
            }
            _ = tokio::time::sleep(STARTUP_CONNECT_TIMEOUT) => {
                self.cleanup_failed_start().await;
                let error = DshError::other("host_startup_timeout", format!("dsh desktop host did not connect within {} seconds", STARTUP_CONNECT_TIMEOUT.as_secs()));
                self.set_state(RuntimeState::Failed, None, Some(error.to_string())).await;
                return Err(error);
            }
        };
        let link = match accept_result {
            Ok(link) => link,
            Err(error) => {
                self.cleanup_failed_start().await;
                let error = DshError::other("host_startup_connection", format!("dsh desktop host control connection failed: {error}"));
                self.set_state(RuntimeState::Failed, None, Some(error.to_string())).await;
                return Err(error);
            }
        };
        {
            self.slot.lock().await.link = Some(link.clone());
        }
        self.spawn_event_pump(link.clone());
        // Await the readiness boundary: `ready`, first `fatal`, or child exit.
        loop {
            enum Observed {
                Ready(HostReady),
                Fatal(String),
                Exited,
            }
            // Observe under the lock, then act WITHOUT holding it: `set_state`
            // locks the same non-reentrant mutex.
            let observed = {
                let slot = self.slot.lock().await;
                if let Some(fatal) = &slot.fatal {
                    Some(Observed::Fatal(fatal.message.clone()))
                } else if let Some(ready) = &slot.ready {
                    Some(Observed::Ready(ready.clone()))
                } else if slot.exited {
                    Some(Observed::Exited)
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
                Some(Observed::Ready(ready)) => {
                    self.set_state(RuntimeState::Ready, Some(ready.url.clone()), None)
                        .await;
                    return Ok(ready);
                }
                Some(Observed::Exited) => {
                    let error = self.exit_error().await;
                    self.set_state(RuntimeState::Failed, None, Some(error.to_string()))
                        .await;
                    return Err(error);
                }
                None => {}
            }
            if watch_status.changed().await.is_err() {
                // Status sender dropped: treat as teardown.
                return Err(DshError::runtime_unavailable("stopped", "supervisor closed"));
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

    /// The same stop with a shortened graceful phase (the forced tree kill and
    /// its 5 s/5 s escalation are unchanged). Used where waiting the full
    /// graceful budget is wrong — OS shutdown, and the forced-stop tests.
    pub async fn stop_with_graceful_deadline(
        &self,
        graceful_deadline: Duration,
        require_graceful: bool,
    ) -> Result<(), DshError> {
        let (link_opt, containment_opt, ack_flag) = {
            let mut slot = self.slot.lock().await;
            if slot.child.is_none() && slot.link.is_none() && slot.containment.is_none() {
                return Ok(());
            }
            self.set_state_unlocked(&mut slot, RuntimeState::Stopping)
                .await;
            slot.ack
                .store(false, std::sync::atomic::Ordering::SeqCst);
            (slot.link.clone(), slot.containment.take(), slot.ack.clone())
        };
        if let Some(link) = &link_opt {
            let _ = link.send(&ShellMessage::Shutdown {}).await;
        }
        let Some(containment) = containment_opt else {
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
        let outcome = stop_tree(&containment, graceful_deadline, wait_exit, ack)
            .await
            .map_err(|e| DshError::runtime_unavailable("stopping", e.to_string()))?;
        // Tree teardown: any process still inside the tree after its owner
        // exited is a straggler and must not survive (the orphan guarantee).
        containment.kill_tree(true);
        {
            let mut slot = self.slot.lock().await;
            slot.child = None;
            slot.link = None;
        }
        if require_graceful {
            crate::proc_tree::check_graceful(&outcome)
                .map_err(|e| DshError::other("update_unclean_exit", e.to_string()))?;
        }
        self.set_state(RuntimeState::Stopped, None, None).await;
        Ok(())
    }

    /// Restart the Host: stop (graceful ordering per `apps/desktop/README.md` —
    /// wait for Host shutdown before relaunching), then start again.
    pub async fn restart(&self) -> Result<RuntimeStatus, DshError> {
        self.stop(false).await?;
        self.start().await?;
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
        let link = self.slot.lock().await.link.clone().ok_or_else(|| {
            DshError::runtime_unavailable(format!("{:?}", self.status().state), "host is unavailable")
        })?;
        update_tasks(&link, action).await.map_err(control_error)
    }

    /// Subscribe to `platform-session` updates (credentials; never log or
    /// forward to a renderer).
    pub async fn platform_sessions(
        &self,
    ) -> tokio::sync::mpsc::UnboundedReceiver<Option<crate::control::PlatformSession>> {
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
        self.slot.lock().await.platform_sessions = Some(tx);
        rx
    }

    /// Readiness facts for `runtime_boot_ready`.
    pub async fn boot_facts(&self) -> Option<HostReady> {
        self.slot.lock().await.ready.clone()
    }

    fn spawn_event_pump(&self, link: Arc<ControlLink>) {
        let slot = self.slot.clone();
        let on_failure = self.on_failure.clone();
        let status = self.status.clone();
        tokio::spawn(async move {
            // First-failure-wins reporting (`fail()` semantics).
            let mut reported = false;
            while let Some(event) = link.next_event().await {
                match event {
                    HostEvent::Ready { url, injections } => {
                        {
                            let mut guard = slot.lock().await;
                            if guard.ready.is_none() {
                                guard.ready = Some(HostReady {
                                    url,
                                    injections,
                                    started_at: chrono::Utc::now()
                                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                                });
                            }
                        }
                        status.send_modify(|state| state.state = RuntimeState::Ready);
                    }
                    HostEvent::Fatal { message, diagnostic } => {
                        {
                            let mut guard = slot.lock().await;
                            if guard.fatal.is_none() {
                                guard.fatal = Some(HostFatal {
                                    message: message.clone(),
                                    diagnostic: diagnostic.clone(),
                                });
                            }
                        }
                        if !reported {
                            reported = true;
                            if let Some(callback) = &on_failure {
                                callback(&HostFatal { message, diagnostic });
                            }
                        }
                        status.send_modify(|_| {});
                    }
                    HostEvent::PlatformSession { session } => {
                        if let Some(session) = &session {
                            if !session.validate() {
                                // Protocol violation: a malformed frame is fatal
                                // (`isDesktopHostEvent` strictness).
                                {
                                    let mut guard = slot.lock().await;
                                    if guard.fatal.is_none() {
                                        guard.fatal = Some(HostFatal {
                                            message: "dsh desktop host sent an invalid IPC event"
                                                .into(),
                                            diagnostic: None,
                                        });
                                    }
                                }
                                if !reported {
                                    reported = true;
                                    if let Some(callback) = &on_failure {
                                        callback(&HostFatal {
                                            message: "dsh desktop host sent an invalid IPC event"
                                                .into(),
                                            diagnostic: None,
                                        });
                                    }
                                }
                                status.send_modify(|_| {});
                                continue;
                            }
                        }
                        let guard = slot.lock().await;
                        if let Some(sender) = &guard.platform_sessions {
                            let _ = sender.send(session);
                        }
                    }
                    HostEvent::ShutdownComplete {} => {
                        let stopping =
                            status.borrow().state == RuntimeState::Stopping;
                        {
                            let mut guard = slot.lock().await;
                            if stopping {
                                guard.ack
                                    .store(true, std::sync::atomic::Ordering::SeqCst);
                            } else if guard.fatal.is_none() {
                                // Unrequested `shutdown-complete` is a protocol
                                // violation (host-process.ts:214-217).
                                guard.fatal = Some(HostFatal {
                                    message: "dsh desktop host acknowledged an unrequested shutdown"
                                        .into(),
                                    diagnostic: None,
                                });
                            }
                        }
                        status.send_modify(|_| {});
                    }
                    HostEvent::UpdateTasks { .. } | HostEvent::QuitInspection { .. } => {
                        // Correlated responses are routed to their waiters in
                        // the link; a late response finds no waiter and drops.
                    }
                }
            }
        });
    }

    fn spawn_exit_monitor(&self) {
        let slot = self.slot.clone();
        let status = self.status.clone();
        tokio::spawn(async move {
            // Take the child out of the slot so its `wait()` never holds the
            // run lock for the process lifetime.
            let mut child = slot.lock().await.child.take();
            let code = match child.as_mut() {
                Some(child) => child.wait().await.ok().map(|status| status.code()),
                None => None,
            };
            {
                let mut guard = slot.lock().await;
                guard.exited = true;
                guard.exit_code = code.flatten();
            }
            // An exit observed while `Starting` or `Ready` is unexpected, so it is
            // recorded as `Failed` (with the exit code) instead of merely waking
            // subscribers: otherwise a mid-run crash leaves the state at `Ready`
            // forever and every later command reports a dead host as available.
            // An exit observed while `Stopping`, `Stopped` or `Failed` is an
            // ordinary shutdown and must not overwrite that state.
            //
            // The same notification also wakes `start()`'s readiness loop, which
            // reports the failure when the exit happens during startup.
            status.send_modify(|state| {
                if matches!(state.state, RuntimeState::Starting | RuntimeState::Ready) {
                    state.state = RuntimeState::Failed;
                    state.url = None;
                    state.started_at = None;
                    state.last_error = Some(match code.flatten() {
                        Some(code) => format!("the dsh host exited unexpectedly (exit code {code})"),
                        None => "the dsh host exited unexpectedly (no exit code)".to_string(),
                    });
                }
            });
        });
    }

    /// Force cleanup after an unsuccessful startup, then wait for the exit monitor
    /// to reap the direct child. Taking the guard closes the Windows Job Object
    /// only after an explicit tree kill; Unix mirrors this with killpg.
    async fn cleanup_failed_start(&self) {
        let containment = self.slot.lock().await.containment.take();
        if let Some(containment) = containment {
            containment.kill_tree(true);
            let slot = self.slot.clone();
            let _ = tokio::time::timeout(Duration::from_secs(5), async move {
                loop {
                    if slot.lock().await.exited {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await;
            drop(containment);
        }
        let mut slot = self.slot.lock().await;
        slot.link = None;
        slot.child = None;
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
        let mut slot = self.slot.lock().await;
        self.set_state_unlocked(&mut slot, state).await;
        let started_at = slot.ready.as_ref().map(|ready| ready.started_at.clone());
        drop(slot);
        self.status.send_modify(|status| {
            status.state = state;
            status.url = url;
            status.started_at = started_at;
            status.last_error = last_error;
        });
    }

    async fn set_state_unlocked(&self, _slot: &mut RunSlot, state: RuntimeState) {
        self.status.send_modify(|status| {
            status.state = state;
        });
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

use crate::proc_tree::GRACEFUL_STOP_TIMEOUT;

/// Whether `pid` is still alive (re-exported for shutdown verification).
pub fn host_process_alive(pid: u32) -> bool {
    process_alive(pid)
}
