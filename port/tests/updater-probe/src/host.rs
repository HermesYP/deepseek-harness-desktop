//! Probe host: the shell stand-ins `update_flow.rs` reads, plus the headless
//! Tauri app harness that produces a genuine `AppHandle`.
//!
//! `update_flow.rs` reads four things from the shell: the `AppHandle` (state
//! lookup, event emission, dialogs, resource directory, exit), the `AppState`
//! fields it shares (`update`, `settings`, `locale`, `supervisor`, `gateway`),
//! the localized message dictionary, and
//! `crate::commands::{present_update, desktop_update_failure_kind}`.
//!
//! The handle is real (Tauri's `MockRuntime`), the `UpdateService` is the
//! production type compiled from `app/src/state.rs`'s update block, and the
//! supervisor/gateway are inert recorders. No window is created, no socket is
//! opened, and no dialog is displayed.

use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex};

use dsh_core::error::DshError;
use dsh_core::protocol::{
    DesktopUpdateFailureKind, DesktopUpdateOperation, DesktopUpdatePhase,
    DesktopUpdatePreparationFailureKind, DesktopUpdatePresentation, DesktopUpdateState,
    RuntimeState, RuntimeStatus, SettingValue,
};
use tauri::Listener;
use tokio::sync::Mutex;

use crate::dialog::{DialogAnswer, DialogRequest, DialogScript, SharedScript};
use crate::update_flow::DesktopApp;

/// Mirrors `crate::state::UPDATE_CHANNEL_KEY`.
pub const UPDATE_CHANNEL_KEY: &str = "updates.channel";

// ---------------------------------------------------------------------------
// Per-app shell registry
// ---------------------------------------------------------------------------

/// Everything a test observes about one probe app.
#[derive(Debug)]
pub struct Shell {
    pub dialogs: SharedScript,
    pub published: Vec<DesktopUpdatePresentation>,
}

impl Default for Shell {
    fn default() -> Self {
        Self {
            dialogs: Arc::new(StdMutex::new(DialogScript::default())),
            published: Vec::new(),
        }
    }
}

/// The recorder the updater's dialog and event edges resolve for one app.
///
/// The shell lives in the app's **managed state**, not in a side table keyed by
/// a handle address. `AppHandle` is a cloned handle to shared state, so
/// `&handle as *const _` identifies a stack slot that differs between call
/// sites; an address-keyed table therefore misses. Resolving through
/// `app.state::<ShellHandle>()` uses Tauri's real state registry, so any clone
/// of one app's handle reaches the same recorder.
#[derive(Clone)]
pub struct ShellHandle(pub Arc<StdMutex<Shell>>);

impl ShellHandle {
    /// The shell this handle points at.
    pub fn shell(&self) -> Arc<StdMutex<Shell>> {
        self.0.clone()
    }
}

/// The shell recorded for `handle`, when the handle belongs to a probe app.
///
/// A handle whose app was not built by the probe returns `None`, which callers
/// treat as "answer the primary button and record nothing".
pub fn shell_for(handle: &DesktopApp) -> Option<Arc<StdMutex<Shell>>> {
    use tauri::Manager;
    handle.try_state::<ShellHandle>().map(|state| state.shell())
}

/// Answer a dialog from the script and record the request.
pub fn answer_dialog(handle: &DesktopApp, request: DialogRequest) -> DialogAnswer {
    let Some(shell) = shell_for(handle) else {
        return DialogAnswer::Primary;
    };
    let shell = shell.lock().unwrap();
    let mut dialogs = shell.dialogs.lock().unwrap();
    let answer = dialogs.next_answer();
    dialogs.requests.push(request);
    answer
}

/// Script the answers for the next dialogs.
pub fn script_dialogs(handle: &DesktopApp, answers: &[DialogAnswer]) {
    if let Some(shell) = shell_for(handle) {
        shell.lock().unwrap().dialogs.lock().unwrap().answers = answers.to_vec();
    }
}

/// Every dialog message shown, in order.
pub fn dialog_messages(handle: &DesktopApp) -> Vec<String> {
    shell_for(handle)
        .map(|shell| {
            let shell = shell.lock().unwrap();
            let messages = shell.dialogs.lock().unwrap().messages();
            messages
        })
        .unwrap_or_default()
}

/// The buttons of the last dialog shown.
pub fn last_dialog_buttons(handle: &DesktopApp) -> Option<(String, String)> {
    shell_for(handle).and_then(|shell| {
        let shell = shell.lock().unwrap();
        let buttons = shell.dialogs.lock().unwrap().last_buttons();
        buttons
    })
}

/// Forget recorded dialogs (used between phases of one test).
pub fn clear_dialogs(handle: &DesktopApp) {
    if let Some(shell) = shell_for(handle) {
        shell
            .lock()
            .unwrap()
            .dialogs
            .lock()
            .unwrap()
            .requests
            .clear();
    }
}

/// Record one `dsh://update/state` publication.
pub fn record_presentation(handle: &DesktopApp, presentation: &DesktopUpdatePresentation) {
    if let Some(shell) = shell_for(handle) {
        shell.lock().unwrap().published.push(presentation.clone());
    }
}

/// Event name the updater publishes its presentation on.
pub const UPDATE_STATE_EVENT: &str = "dsh://update/state";

/// Subscribe this app's shell to the updater's own event.
///
/// The updater calls the **real** `tauri::Emitter::emit`, so the probe observes
/// publications the way the Web client does — by listening — rather than by
/// intercepting the call. That keeps `publish` in `update_flow.rs` unmodified.
fn subscribe(handle: &tauri::AppHandle<tauri::test::MockRuntime>, shell: Arc<StdMutex<Shell>>) {
    let recorder = shell.clone();
    handle.listen(UPDATE_STATE_EVENT, move |event| {
        let Ok(presentation) = serde_json::from_str::<DesktopUpdatePresentation>(event.payload())
        else {
            return;
        };
        recorder.lock().unwrap().published.push(presentation);
    });
}

/// Every recorded publication, in order.
pub fn published(handle: &DesktopApp) -> Vec<DesktopUpdatePresentation> {
    shell_for(handle)
        .map(|shell| shell.lock().unwrap().published.clone())
        .unwrap_or_default()
}

/// The most recent recorded publication.
pub fn last_published(handle: &DesktopApp) -> Option<DesktopUpdatePresentation> {
    published(handle).pop()
}

// ---------------------------------------------------------------------------
// Settings store
// ---------------------------------------------------------------------------

/// The settings surface the updater reads (the real store's `get`).
#[derive(Debug, Default)]
pub struct SettingsStore {
    values: std::collections::BTreeMap<String, SettingValue>,
}

impl SettingsStore {
    pub fn set(&mut self, key: &str, value: SettingValue) {
        self.values.insert(key.to_string(), value);
    }

    pub fn get(&self, key: &str) -> Result<Option<&SettingValue>, DshError> {
        Ok(self.values.get(key))
    }
}

// ---------------------------------------------------------------------------
// Locale
// ---------------------------------------------------------------------------

/// The locales the shell ships.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocaleId {
    En,
    Zh,
}

#[derive(Debug)]
pub struct LocaleModel {
    pub effective: LocaleId,
}

impl LocaleModel {
    pub fn snapshot(&self) -> LocaleSnapshot {
        LocaleSnapshot {
            effective: self.effective,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct LocaleSnapshot {
    pub effective: LocaleId,
}

/// Mirrors the updater rows of `crate::state::ShellMessages`.
#[derive(Debug, Clone, Copy)]
pub struct ShellMessages {
    pub update_title: &'static str,
    pub update_current: &'static str,
    pub update_download: &'static str,
    pub update_available: &'static str,
    pub update_detail: &'static str,
    pub install_and_restart: &'static str,
    pub later: &'static str,
    pub update_downloaded_title_windows: &'static str,
    pub update_downloaded_detail_windows: &'static str,
    pub update_active_tasks: &'static str,
    pub update_active_tasks_detail: &'static str,
    pub update_stop_tasks: &'static str,
    pub cancel: &'static str,
    pub quit: &'static str,
}

pub const MESSAGES: ShellMessages = ShellMessages {
    update_title: "Update",
    update_current: "Version V{version} is the latest version.",
    update_download: "Download and Install",
    update_available: "An update is available.",
    update_detail: "Version V{version} is available.",
    install_and_restart: "Install and Restart",
    later: "Later",
    update_downloaded_title_windows: "Update downloaded",
    update_downloaded_detail_windows: "The update has been downloaded.",
    update_active_tasks: "Tasks are running.",
    update_active_tasks_detail: "Stopping them will interrupt them.",
    update_stop_tasks: "Stop Tasks and Install",
    cancel: "Cancel",
    quit: "Quit",
};

/// Mirrors `crate::state::messages`.
pub fn messages(_locale: LocaleId) -> ShellMessages {
    MESSAGES
}

/// Mirrors `crate::state::format_message`.
pub fn format_message(template: &str, values: &[(&str, &str)]) -> String {
    let mut out = template.to_string();
    for (name, value) in values {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

// ---------------------------------------------------------------------------
// Supervisor / gateway stand-ins
// ---------------------------------------------------------------------------

/// What the stand-in Host reports for `update-tasks`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum UpdateTasksOutcome {
    /// `active` is false: no live work would be interrupted.
    #[default]
    Idle,
    /// `active` is true: live work would be interrupted.
    Active,
    /// The exchange fails, so task state is unknown and installation refuses.
    Unavailable,
}

/// Re-exported so probe tests name the same enum the production paths use.
pub use dsh_runtime::control::UpdateTasksAction;

/// One deterministic per-harness hook, invoked after each recorded task action.
///
/// Named so the [`Supervisor`] field's type stays legible; the boxed caller
/// closure is otherwise reported as `clippy::type_complexity`.
pub type AfterTaskActionHook = Box<dyn Fn(UpdateTasksAction) + Send + Sync>;

pub struct Supervisor {
    pub tasks: StdMutex<UpdateTasksOutcome>,
    /// Whether the graceful stop succeeds.
    pub stop_ok: StdMutex<bool>,
    /// Graceful stops requested.
    pub stops: StdMutex<u32>,
    /// Restarts requested.
    pub restarts: StdMutex<u32>,
    /// Update-task actions observed, in order.
    pub task_actions: StdMutex<Vec<UpdateTasksAction>>,
    /// The URLs the gateway was reattached to, in order.
    pub host_urls: StdMutex<Vec<String>>,
    /// Deterministic per-harness hook invoked before the final admission closure.
    pub before_final_admission: StdMutex<Option<Box<dyn Fn() + Send + Sync>>>,
    /// Deterministic per-harness hook invoked after recording each task action.
    pub after_task_action: StdMutex<Option<AfterTaskActionHook>>,
}

impl Supervisor {
    pub fn new(tasks: UpdateTasksOutcome) -> Self {
        Self {
            tasks: StdMutex::new(tasks),
            stop_ok: StdMutex::new(true),
            stops: StdMutex::new(0),
            restarts: StdMutex::new(0),
            task_actions: StdMutex::new(Vec::new()),
            host_urls: StdMutex::new(Vec::new()),
            before_final_admission: StdMutex::new(None),
            after_task_action: StdMutex::new(None),
        }
    }

    pub async fn update_tasks(&self, action: UpdateTasksAction) -> Result<bool, DshError> {
        self.update_tasks_if(action, Self::admit_always).await
    }

    /// Mirrors the runtime's unconditional admission check, so the stand-in keeps
    /// the production shape: `update_tasks` is `update_tasks_if` with nothing to
    /// verify.
    fn admit_always() -> Result<(), DshError> {
        Ok(())
    }

    /// Mirrors `dsh_runtime::supervisor::Supervisor::update_tasks_if`.
    ///
    /// It replays the *ordering* the production method guarantees — the
    /// synchronous admission check runs first, and `Err` refuses the exchange
    /// without recording a task action — but it cannot model the supervisor's
    /// slot lock: the probe has no concurrent Host, so `stop_if`'s closure and
    /// this check never actually race here. That serialization is a runtime
    /// property and is covered by the runtime's own tests, not by this stand-in.
    pub async fn update_tasks_if<F>(
        &self,
        action: UpdateTasksAction,
        admission: F,
    ) -> Result<bool, DshError>
    where
        F: FnOnce() -> Result<(), DshError> + Send,
    {
        admission()?;
        self.exchange_task_action(action)
    }

    /// One recorded `update-tasks` exchange: the stand-in Host's answer.
    fn exchange_task_action(&self, action: UpdateTasksAction) -> Result<bool, DshError> {
        self.task_actions.lock().unwrap().push(action);
        if let Some(hook) = self.after_task_action.lock().unwrap().as_ref() {
            hook(action);
        }
        match *self.tasks.lock().unwrap() {
            UpdateTasksOutcome::Idle => Ok(false),
            UpdateTasksOutcome::Active => Ok(true),
            UpdateTasksOutcome::Unavailable => Err(DshError::other(
                "control_unavailable",
                "the Host did not answer the task query",
            )),
        }
    }

    /// Synchronous final-admission stand-in invoked immediately before the
    /// recorded stop. It does NOT model Supervisor's real locks or races.
    pub async fn stop_if<F>(&self, _graceful: bool, admission: F) -> Result<(), DshError>
    where
        F: Fn() -> Result<(), DshError> + Send + Sync,
    {
        if let Some(hook) = self.before_final_admission.lock().unwrap().as_ref() {
            hook();
        }
        admission()?;
        self.stop(true).await
    }

    pub async fn stop(&self, _graceful: bool) -> Result<(), DshError> {
        *self.stops.lock().unwrap() += 1;
        if *self.stop_ok.lock().unwrap() {
            Ok(())
        } else {
            Err(DshError::other(
                "stop_failed",
                "the Host did not acknowledge shutdown",
            ))
        }
    }

    pub async fn restart(&self) -> Result<RuntimeStatus, DshError> {
        *self.restarts.lock().unwrap() += 1;
        self.host_urls
            .lock()
            .unwrap()
            .push(PROBE_HOST_URL.to_string());
        Ok(self.status())
    }

    pub fn status(&self) -> RuntimeStatus {
        RuntimeStatus {
            state: RuntimeState::Ready,
            url: Some(PROBE_HOST_URL.to_string()),
            started_at: None,
            last_error: None,
        }
    }

    pub fn stop_count(&self) -> u32 {
        *self.stops.lock().unwrap()
    }

    pub fn restart_count(&self) -> u32 {
        *self.restarts.lock().unwrap()
    }

    pub fn observed_actions(&self) -> Vec<UpdateTasksAction> {
        self.task_actions.lock().unwrap().clone()
    }
}

/// The URL a restarted Host is reported at.
pub const PROBE_HOST_URL: &str = "http://127.0.0.1:9/?token=probe";

#[derive(Debug, Default)]
pub struct GatewayHandle {
    /// URLs the shell bound the gateway to, in order.
    pub bound: StdMutex<Vec<String>>,
}

impl GatewayHandle {
    pub async fn set_host(&self, url: &str) -> Result<(), DshError> {
        self.bound.lock().unwrap().push(url.to_string());
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// AppState
// ---------------------------------------------------------------------------

/// Mirrors the `AppState` fields the updater reads; `update` is the production
/// [`crate::state::UpdateService`].
pub struct AppState {
    pub settings: Mutex<SettingsStore>,
    pub locale: Mutex<LocaleModel>,
    pub supervisor: Arc<Supervisor>,
    pub gateway: GatewayHandle,
    pub update: Mutex<crate::state::UpdateService>,
    /// Records a termination request. The production path reaches
    /// `app.exit(1)`, which never returns, so the probe never calls it and
    /// leaves this `None`; see the lane report for what that means.
    pub exit_code: StdMutex<Option<i32>>,
    /// Probe-only synchronous policy gate; never a native policy/IPC test.
    pub policy: Arc<crate::policy_owner::ProbePolicy>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            settings: Mutex::new(SettingsStore::default()),
            locale: Mutex::new(LocaleModel {
                effective: LocaleId::En,
            }),
            supervisor: Arc::new(Supervisor::new(UpdateTasksOutcome::default())),
            gateway: GatewayHandle::default(),
            update: Mutex::new(crate::state::UpdateService::idle()),
            exit_code: StdMutex::new(None),
            policy: Arc::new(crate::policy_owner::ProbePolicy {
                normal_allowed: std::sync::atomic::AtomicBool::new(true),
                mandatory_update_allowed: std::sync::atomic::AtomicBool::new(true),
                runtime_version: None,
                decision: StdMutex::new(crate::mandatory_update::MandatoryDecision::initial()),
            }),
        }
    }

    /// Set the persisted release channel.
    pub async fn set_channel(&self, channel: &str) {
        self.settings.lock().await.set(
            crate::state::UPDATE_CHANNEL_KEY,
            SettingValue::String(channel.to_string()),
        );
    }

    /// Whether the shell recorded a termination request.
    pub fn exit_code(&self) -> Option<i32> {
        *self.exit_code.lock().unwrap()
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Headless app harness
// ---------------------------------------------------------------------------

/// A live probe app: a real headless Tauri handle plus its recorded shell.
pub struct Harness {
    pub app: DesktopApp,
    pub state: Arc<AppState>,
    pub shell: Arc<StdMutex<Shell>>,
}

impl Harness {
    /// Build the headless app.
    ///
    /// The handle is a genuine `tauri::AppHandle<MockRuntime>`, so
    /// `app.state::<Arc<AppState>>()` and the updater's `app.emit(..)` calls go
    /// through the real implementations. No window is created.
    pub fn new() -> Self {
        Self::with_tasks(UpdateTasksOutcome::default())
    }

    /// Build with a scripted Host task outcome.
    ///
    /// The handle is a real `tauri::AppHandle<MockRuntime>` built from Tauri's
    /// mock context, so no window, tray, WebView2, or display server is
    /// involved. `MockRuntime` is the only runtime the probe can use: `Wry`'s
    /// event loop resolves WebView2 entry points at process start and fails to
    /// load in a headless test binary (`STATUS_ENTRYPOINT_NOT_FOUND`).
    /// `update_flow.rs` names its handle through the `DesktopApp` alias, which
    /// is `tauri::AppHandle` in a shipped build and `AppHandle<MockRuntime>`
    /// here.
    pub fn with_tasks(tasks: UpdateTasksOutcome) -> Self {
        Self::with_runtime_version(tasks, None)
    }

    /// Configure the mock installed baseline before publishing immutable state.
    pub fn with_runtime_version(tasks: UpdateTasksOutcome, runtime_version: Option<&str>) -> Self {
        let mut state = AppState::new();
        Arc::get_mut(&mut state.policy).unwrap().runtime_version =
            runtime_version.map(str::to_owned);
        state.supervisor = Arc::new(Supervisor::new(tasks));
        let state = Arc::new(state);
        let shell: Arc<StdMutex<Shell>> = Arc::new(StdMutex::new(Shell::default()));
        let app = tauri::test::mock_builder()
            .manage(state.clone())
            // The shell is managed state, so any clone of this handle resolves
            // it without an address-keyed side table.
            .manage(ShellHandle(shell.clone()))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("headless probe app builds")
            .handle()
            .clone();
        subscribe(&app, shell.clone());
        Self { app, state, shell }
    }

    /// Script the answers for the next dialogs.
    pub fn script_dialogs(&self, answers: &[DialogAnswer]) {
        script_dialogs(&self.app, answers);
    }

    /// Park dialog callbacks instead of answering them immediately, so a test can
    /// observe a prompt that is *open* (and therefore reserved).
    pub fn set_defer_callbacks(&self, defer: bool) {
        if let Some(shell) = shell_for(&self.app) {
            shell
                .lock()
                .unwrap()
                .dialogs
                .lock()
                .unwrap()
                .defer_callbacks = defer;
        }
    }

    /// How many dialog callbacks are parked, waiting for an answer.
    pub fn pending_dialog_callbacks(&self) -> usize {
        shell_for(&self.app)
            .map(|shell| {
                shell
                    .lock()
                    .unwrap()
                    .dialogs
                    .lock()
                    .unwrap()
                    .pending_callbacks
                    .len()
            })
            .unwrap_or(0)
    }

    /// Whether a confirmation prompt is currently reserved on the service.
    pub async fn confirmation_is_reserved(&self) -> bool {
        self.state.update.lock().await.confirmation().is_some()
    }

    /// Every dialog message shown, in order.
    pub fn dialog_messages(&self) -> Vec<String> {
        dialog_messages(&self.app)
    }

    /// The buttons of the last dialog shown.
    pub fn last_dialog_buttons(&self) -> Option<(String, String)> {
        last_dialog_buttons(&self.app)
    }

    /// Forget recorded dialogs.
    pub fn clear_dialogs(&self) {
        clear_dialogs(&self.app);
    }

    /// The phases published through `dsh://update/state`, in order.
    pub fn published_phases(&self) -> Vec<DesktopUpdatePhase> {
        published(&self.app)
            .into_iter()
            .map(|presentation| presentation.phase)
            .collect()
    }

    /// The most recent publication.
    pub fn last_published(&self) -> Option<DesktopUpdatePresentation> {
        last_published(&self.app)
    }

    /// The shell's current update state.
    pub async fn update_state(&self) -> DesktopUpdateState {
        self.state.update.lock().await.state.clone()
    }

    /// The shell's current phase.
    pub async fn phase(&self) -> DesktopUpdatePhase {
        self.update_state().await.phase
    }

    /// The admitted candidate's version, if any.
    pub async fn candidate_version(&self) -> Option<String> {
        self.state
            .update
            .lock()
            .await
            .candidate
            .as_ref()
            .map(|candidate| candidate.version.clone())
    }

    /// The artifact path recorded on the admitted candidate.
    pub async fn candidate_artifact(&self) -> Option<std::path::PathBuf> {
        self.state
            .update
            .lock()
            .await
            .candidate
            .as_ref()
            .and_then(|candidate| candidate.artifact_path.clone())
    }

    /// Install a scripted candidate directly, bypassing the network, so the
    /// install admission path can be exercised on its own.
    pub async fn admit_candidate(&self, version: &str, channel: &str, digest: &str) {
        let mut update = self.state.update.lock().await;
        let _ = update.invalidate_candidate();
        update.candidate = Some(crate::state::UpdateCandidate {
            version: version.to_string(),
            channel: channel.to_string(),
            url: format!("https://updates.example.com/dsh-{version}.bin"),
            sha256: digest.to_string(),
            signature: "ab".repeat(64),
            artifact_path: None,
        });
        update.state.phase = DesktopUpdatePhase::Available;
        update.state.version = Some(version.to_string());
        update.checked = true;
    }

    /// Record that `episode` published `path` as the verified artifact.
    pub async fn publish_artifact(&self, path: std::path::PathBuf) -> bool {
        let mut update = self.state.update.lock().await;
        let episode = update.episode;
        update.publish_artifact(episode, path)
    }
}

impl Default for Harness {
    fn default() -> Self {
        Self::new()
    }
}

/// The stand-in host URL, re-exported for assertions.
pub fn host_url() -> &'static str {
    PROBE_HOST_URL
}

// ---------------------------------------------------------------------------
// Packaged-trust fixture
// ---------------------------------------------------------------------------

/// The trusted release signing key from
/// `app/tests/fixtures/update-signatures.json`.
///
/// Read from the same fixture the updater's own tests use, so a probe trust
/// configuration carries the key the verifier is actually given.
pub fn fixture_trusted_key() -> String {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("src-tauri")
        .join("app")
        .join("tests")
        .join("fixtures")
        .join("update-signatures.json");
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let value: serde_json::Value = serde_json::from_str(&text).expect("fixtures parse");
    value["cases"]
        .as_array()
        .and_then(|cases| {
            cases
                .iter()
                .find(|case| case["channel"] == "stable" && case["label"] == "valid")
        })
        .and_then(|case| case["trustedKey"].as_str())
        .expect("a stable trusted key")
        .to_string()
}

/// Write a packaged trust configuration to a unique temp path and install it as
/// the resolver's override.
///
/// Returns the path so a test can rewrite it (to exercise the malformed case) or
/// remove it. The caller owns cleanup through [`clear_trust_fixture`].
pub fn install_trust_fixture(label: &str) -> PathBuf {
    let directory =
        std::env::temp_dir().join(format!("dsh-updater-probe-{}-{label}", std::process::id()));
    std::fs::create_dir_all(&directory).expect("trust fixture directory");
    let path = directory.join(crate::update_flow::TRUST_CONFIG_FILE);
    let config = serde_json::json!({
        "configVersion": 1,
        "stable": {
            "feedUrl": "https://updates.example.com/stable.json",
            "allowedOrigins": ["updates.example.com"],
            "trustedKeys": [fixture_trusted_key()],
        },
        "beta": {
            "feedUrl": "https://updates.example.com/beta.json",
            "allowedOrigins": ["updates.example.com"],
            "trustedKeys": [fixture_trusted_key()],
        },
    });
    std::fs::write(
        &path,
        serde_json::to_vec_pretty(&config).expect("serialize"),
    )
    .expect("write trust fixture");
    crate::update_flow::set_trust_config_override(Some(path.clone()));
    path
}

/// Remove the trust override and its fixture directory.
pub fn clear_trust_fixture(path: &std::path::Path) {
    crate::update_flow::set_trust_config_override(None);
    if let Some(directory) = path.parent() {
        std::fs::remove_dir_all(directory).ok();
    }
}

/// Mirrors `crate::commands::present_update`.
pub fn present_update(state: &DesktopUpdateState) -> DesktopUpdatePresentation {
    DesktopUpdatePresentation {
        phase: state.phase,
        version: state.version.clone(),
        percent: state.percent.map(|value| value.floor() as u32),
        failure: if state.phase == DesktopUpdatePhase::Error {
            Some(desktop_update_failure_kind(state))
        } else {
            None
        },
    }
}

/// Mirrors `crate::commands::desktop_update_failure_kind`.
pub fn desktop_update_failure_kind(state: &DesktopUpdateState) -> DesktopUpdateFailureKind {
    if state.failed_operation == Some(DesktopUpdateOperation::Install) {
        if let Some(preparation) = state.preparation_failure {
            return match preparation {
                DesktopUpdatePreparationFailureKind::StopFailed => {
                    DesktopUpdateFailureKind::StopFailed
                }
                DesktopUpdatePreparationFailureKind::TasksChanged => {
                    DesktopUpdateFailureKind::TasksChanged
                }
                DesktopUpdatePreparationFailureKind::TasksUnavailable => {
                    DesktopUpdateFailureKind::TasksUnavailable
                }
            };
        }
    }
    let network = state.message.as_deref().is_some_and(|message| {
        [
            "ERR_CONNECTION_CLOSED",
            "ERR_CONNECTION_RESET",
            "ERR_INTERNET_DISCONNECTED",
            "ERR_NAME_NOT_RESOLVED",
            "ETIMEDOUT",
        ]
        .iter()
        .any(|marker| message.contains(marker))
    });
    match (state.failed_operation, network) {
        (Some(DesktopUpdateOperation::Download), true) => DesktopUpdateFailureKind::DownloadNetwork,
        (Some(DesktopUpdateOperation::Download), false) => DesktopUpdateFailureKind::Download,
        (Some(DesktopUpdateOperation::Install), true) => DesktopUpdateFailureKind::InstallNetwork,
        (Some(DesktopUpdateOperation::Install), false) => DesktopUpdateFailureKind::Install,
        (_, true) => DesktopUpdateFailureKind::CheckNetwork,
        _ => DesktopUpdateFailureKind::Check,
    }
}
