//! Authoritative application composition. No policy configuration means no policy work.
//! Invalid configuration, incomplete presentation and shutdown deny normal admission.
use crate::{
    mandatory_update::{MandatoryDecision, PolicyAuthentication, PolicyScenario},
    native_policy_surface::NativePolicySurface,
    policy_bootstrap::PackagedPolicy,
    policy_owner::{NativeAction, PolicyEventSink, PolicyOwner, RouteVerdict},
    policy_runner::PolicyRunner,
    state::AppState,
};
use dsh_core::error::DshError;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
};
use tauri::Manager;
use tokio::sync::{watch, Mutex as AsyncMutex};

trait Authority: Send + Sync {
    fn route(&self, action: NativeAction) -> RouteVerdict;
    fn current(&self) -> MandatoryDecision;
}
impl Authority for PolicyOwner {
    fn route(&self, action: NativeAction) -> RouteVerdict {
        PolicyOwner::route(self, action)
    }
    fn current(&self) -> MandatoryDecision {
        PolicyOwner::current(self)
    }
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Disabled,
    Starting,
    Active,
    Failed,
    Disposed,
}
struct Admission {
    phase: Phase,
    authority: Option<Arc<dyn Authority>>,
}
pub struct PolicyGate {
    admission: Mutex<Admission>,
    owner: AsyncMutex<Option<Arc<PolicyOwner>>>,
    surface: AsyncMutex<Option<NativePolicySurface>>,
    navigation: AsyncMutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    shutdown: watch::Sender<bool>,
    pub client_version: Option<String>,
    pub runtime_version: Option<String>,
}
static APPLICATION_GATE: OnceLock<Arc<PolicyGate>> = OnceLock::new();
impl PolicyGate {
    pub fn from_input(input: &Result<Option<PackagedPolicy>, String>) -> Arc<Self> {
        let (phase, client_version, runtime_version) = match input {
            Ok(None) => (Phase::Disabled, None, None),
            Ok(Some(policy)) => (
                Phase::Starting,
                Some(policy.client_version.clone()),
                Some(policy.identity.bundled_dsh_version.clone()),
            ),
            Err(_) => (Phase::Failed, None, None),
        };
        Arc::new(Self {
            admission: Mutex::new(Admission {
                phase,
                authority: None,
            }),
            owner: AsyncMutex::new(None),
            surface: AsyncMutex::new(None),
            navigation: AsyncMutex::new(None),
            shutdown: watch::channel(false).0,
            client_version,
            runtime_version,
        })
    }
    pub fn enabled(&self) -> bool {
        self.admission.lock().unwrap().phase != Phase::Disabled
    }
    pub fn allows(&self, action: NativeAction) -> bool {
        if action == NativeAction::Quit {
            return true;
        }
        let authority = {
            let state = self.admission.lock().unwrap();
            if state.phase == Phase::Disabled {
                return action == NativeAction::Normal;
            }
            if state.phase != Phase::Active {
                return false;
            }
            state.authority.clone()
        };
        let Some(authority) = authority else {
            return false;
        };
        let admitted = authority.route(action) == RouteVerdict::Allow;
        let state = self.admission.lock().unwrap();
        admitted
            && state.phase == Phase::Active
            && state
                .authority
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &authority))
    }
    pub fn current_decision(&self) -> Option<MandatoryDecision> {
        let authority = {
            let state = self.admission.lock().unwrap();
            if !matches!(state.phase, Phase::Starting | Phase::Active) {
                return None;
            }
            state.authority.clone()?
        };
        let decision = authority.current();
        let state = self.admission.lock().unwrap();
        (matches!(state.phase, Phase::Starting | Phase::Active)
            && state
                .authority
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &authority)))
        .then_some(decision)
    }
    pub fn fail(&self) {
        self.admission.lock().unwrap().phase = Phase::Failed;
    }
    pub fn trigger(&self, scenario: PolicyScenario) {
        if let Ok(slot) = self.owner.try_lock() {
            if let Some(owner) = slot.as_ref() {
                owner.trigger(scenario);
            }
        }
    }
    pub async fn presented(&self, sequence: u64) -> Result<(), String> {
        let surface = self
            .surface
            .lock()
            .await
            .as_ref()
            .cloned()
            .ok_or("policy surface unavailable")?;
        surface.acknowledge(sequence).await
    }
    pub async fn dispose(&self) {
        self.admission.lock().unwrap().phase = Phase::Disposed;
        self.shutdown.send_replace(true);
        // Each ownership slot remains populated across its await, including cancellation.
        let mut owner = self.owner.lock().await;
        if let Some(value) = owner.as_ref() {
            value.dispose().await;
        }
        *owner = None;
        drop(owner);
        let mut navigation = self.navigation.lock().await;
        if let Some(task) = navigation.as_mut() {
            if let Err(error) = task.await {
                tracing::error!(%error, "policy navigation task failed");
            }
        }
        *navigation = None;
        drop(navigation);
        let mut surface = self.surface.lock().await;
        if let Some(value) = surface.as_ref() {
            value.dispose().await;
        }
        *surface = None;
        self.admission.lock().unwrap().authority = None;
    }
}

struct PresentationSink {
    surface: NativePolicySurface,
    was_blocking: AtomicBool,
}
impl PolicyEventSink for PresentationSink {
    fn present<'a>(
        &'a self,
        sequence: u64,
        decision: &'a MandatoryDecision,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        // This flag only coalesces wakeups; admission NEVER derives from it.
        if decision.blocking && !self.was_blocking.swap(true, Ordering::AcqRel) {
            crate::update_flow::request_check(
                crate::update_schedule::CheckTrigger::MandatoryPolicy,
            );
        } else if !decision.blocking {
            self.was_blocking.store(false, Ordering::Release);
        }
        self.surface.present(sequence, decision)
    }
}
/// Call on the native setup thread, after main exists and BEFORE starting HTTP.
pub fn install(app: &tauri::AppHandle, policy: PackagedPolicy) -> Result<Arc<PolicyOwner>, String> {
    if policy.config.authentication != PolicyAuthentication::Anonymous {
        return Err("desktop policy: test authentication needs a qualified isolated login session; unavailable in this port".into());
    }
    let gate = app.state::<Arc<AppState>>().policy.clone();
    let surface = NativePolicySurface::prepare(app)?;
    *gate.surface.try_lock().map_err(|_| "policy surface busy")? = Some(surface.clone());
    let metadata = Arc::new(crate::policy_metadata::NativePolicyMetadata::new(
        app.clone(),
        policy.client_version,
    )?);
    tauri::async_runtime::block_on(async {
        // At this point the gateway/invoke gate denies normal routes and the native surface exists.
        let runner = Arc::new(PolicyRunner::spawn_http(
            policy.config,
            policy.identity,
            metadata,
        )?);
        let owner = Arc::new(PolicyOwner::new(runner));
        {
            let mut admission = gate.admission.lock().unwrap();
            if admission.phase != Phase::Starting {
                return Err("policy startup revoked".into());
            }
            admission.authority = Some(owner.clone());
        }
        *gate.owner.lock().await = Some(owner.clone());
        owner
            .start_consumer(Arc::new(PresentationSink {
                surface,
                was_blocking: AtomicBool::new(false),
            }))
            .map_err(str::to_string)?;
        {
            let mut admission = gate.admission.lock().unwrap();
            if admission.phase != Phase::Starting {
                return Err("policy startup revoked".into());
            }
            admission.phase = Phase::Active;
        }
        Ok(owner)
    })
}

pub fn register_resume_gate(gate: Arc<PolicyGate>) -> Result<(), String> {
    APPLICATION_GATE
        .set(gate)
        .map_err(|_| "policy gate already registered".into())
}
pub fn resume() {
    if let Some(gate) = APPLICATION_GATE.get() {
        gate.trigger(PolicyScenario::ForegroundOrResume);
    }
}
pub fn presentation_is_current(app: &tauri::AppHandle, decision: &MandatoryDecision) -> bool {
    app.try_state::<Arc<AppState>>()
        .and_then(|state| state.policy.current_decision())
        .as_ref()
        == Some(decision)
}
pub fn require_state(state: &AppState) -> Result<(), DshError> {
    if state.policy.allows(NativeAction::Normal) {
        Ok(())
    } else {
        Err(DshError::other("mandatory_policy", "Normal desktop actions are blocked by mandatory policy or incomplete native enforcement."))
    }
}
pub fn require_normal(app: &tauri::AppHandle) -> Result<(), DshError> {
    let state = app.try_state::<Arc<AppState>>().ok_or_else(|| {
        DshError::other("mandatory_policy", "Desktop admission is not initialized.")
    })?;
    require_state(&state)
}

// ---------------------------------------------------------------------------
// Command/action admission table
// ---------------------------------------------------------------------------

/// How one desktop IPC command is admitted by the mandatory-policy gate.
///
/// The gate is the *wrapper* around `tauri::generate_handler!`. It must not be a
/// blanket "`require_normal` for everything except Quit", because a blocking
/// mandatory requirement would then also suppress the reads the mandatory window
/// and the shell need to explain itself — and with no admitted read, the user sees
/// a blocked application with no way to learn why or to act.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CommandAdmission {
    /// Always callable: the command *is* the user's exit or the isolated policy
    /// surface's own authorization, and blocking it would trap the user in a
    /// policy-denied application with no exit.
    Always,
    /// Callable while mandatory policy denies ordinary routes: a read that cannot
    /// change installed state, the running Host, the profile, or a secret value.
    Informational,
    /// Callable only when the mandatory-update action is admitted, which is how a
    /// blocking requirement starts the very update it requires.
    MandatoryUpdate,
    /// Requires ordinary (`NativeAction::Normal`) admission.
    Normal,
}

impl CommandAdmission {
    /// Whether the command needs ordinary admission.
    ///
    /// Test/diagnostic surface: the wrapper classifies through
    /// [`authorize_desktop_command`], which owns every admission decision, and
    /// this predicate exists so a test can assert the classification without
    /// standing up an application handle.
    #[cfg(any(test, updater_probe))]
    pub fn requires_normal(self) -> bool {
        matches!(self, Self::Normal)
    }
}

/// The admission class of every command in the shell's handler list.
///
/// Deliberately a table rather than a series of `matches!` arms: a test pins it
/// against the exact `tauri::generate_handler!` inventory in `lib.rs`, so a newly
/// declared command cannot silently inherit an admission class. Classification is
/// fail-closed — an unknown command is [`CommandAdmission::Normal`] — so the only
/// way a command becomes callable under a block is by being named here.
///
/// `Always` entries and why (each one is an escape hatch that must not be gated):
///
/// - `shell_quit_request`: consent-based Quit. Blocking it would make a mandatory
///   requirement impossible to leave.
/// - `shell_menu_action`: the menu's own dispatcher (`menu_action::dispatch`)
///   calls `require_normal` for every item except Exit, so the per-item
///   admission decision lives with the menu and this command carries no authority
///   of its own.
/// - `policy_presented` / `policy_retry` / `policy_quit`: the isolated
///   policy-surface commands. They are origin-bound by
///   `security::authorized_policy_invoke` and are the surface's own channel.
///
/// `Informational` entries are reads of state the shell already owns: update and
/// runtime status, the quit inspection, application/path metadata, locale and
/// appearance, settings, credential *metadata* (references and presence — never a
/// secret), and the shortcut configuration. None of them mutates anything.
pub const COMMAND_ADMISSION_TABLE: &[(&str, CommandAdmission)] = &[
    // --- always callable -------------------------------------------------
    ("shell_quit_request", CommandAdmission::Always),
    ("shell_menu_action", CommandAdmission::Always),
    ("policy_presented", CommandAdmission::Always),
    ("policy_retry", CommandAdmission::Always),
    ("policy_quit", CommandAdmission::Always),
    // --- the mandatory-updater arm ---------------------------------------
    ("policy_update", CommandAdmission::MandatoryUpdate),
    // --- informational reads ---------------------------------------------
    ("update_status", CommandAdmission::Informational),
    ("runtime_status", CommandAdmission::Informational),
    ("runtime_quit_inspection", CommandAdmission::Informational),
    ("shell_app_info", CommandAdmission::Informational),
    ("shell_host_paths", CommandAdmission::Informational),
    ("shell_locale_get", CommandAdmission::Informational),
    ("shell_appearance", CommandAdmission::Informational),
    ("shell_shortcuts_get", CommandAdmission::Informational),
    ("settings_get", CommandAdmission::Informational),
    ("settings_list", CommandAdmission::Informational),
    ("credential_list", CommandAdmission::Informational),
    ("credential_has", CommandAdmission::Informational),
    // --- ordinary admission ----------------------------------------------
    ("guest_browser_acquire", CommandAdmission::Normal),
    ("guest_browser_release", CommandAdmission::Normal),
    ("guest_browser_set_bounds", CommandAdmission::Normal),
    ("guest_browser_navigate", CommandAdmission::Normal),
    ("guest_browser_command", CommandAdmission::Normal),
    ("guest_browser_state", CommandAdmission::Normal),
    ("guest_platform_status", CommandAdmission::Normal),
    ("guest_platform_open", CommandAdmission::Normal),
    ("guest_platform_set_bounds", CommandAdmission::Normal),
    ("guest_platform_close", CommandAdmission::Normal),
    ("shell_host_paths_consume", CommandAdmission::Normal),
    ("shell_caption_menu", CommandAdmission::Normal),
    ("shell_caption_palette", CommandAdmission::Normal),
    ("shell_renderer_console", CommandAdmission::Normal),
    ("shell_locale_set", CommandAdmission::Normal),
    ("shell_locale_apply", CommandAdmission::Normal),
    ("shell_window_set_fullscreen", CommandAdmission::Normal),
    ("shell_window_chrome_action", CommandAdmission::Normal),
    ("shell_window_resize_dragging", CommandAdmission::Normal),
    ("shell_window_toggle_devtools", CommandAdmission::Normal),
    ("shell_theme_set", CommandAdmission::Normal),
    ("shell_open_external", CommandAdmission::Normal),
    ("shell_clipboard_write", CommandAdmission::Normal),
    ("shell_clipboard_read", CommandAdmission::Normal),
    ("shell_close_window", CommandAdmission::Normal),
    ("shell_onboarding_set_active", CommandAdmission::Normal),
    ("shell_pick_directory", CommandAdmission::Normal),
    ("runtime_boot_ready", CommandAdmission::Normal),
    ("runtime_boot_failed", CommandAdmission::Normal),
    ("runtime_restart", CommandAdmission::Normal),
    ("settings_set", CommandAdmission::Normal),
    ("settings_reset", CommandAdmission::Normal),
    ("credential_store", CommandAdmission::Normal),
    ("credential_delete", CommandAdmission::Normal),
    ("update_open", CommandAdmission::Normal),
    ("update_check", CommandAdmission::Normal),
    ("shell_shortcuts_edit", CommandAdmission::Normal),
    ("shell_shortcuts_recording", CommandAdmission::Normal),
];

/// Classify one desktop IPC command name. Unknown commands are `Normal`.
pub fn command_admission(command: &str) -> CommandAdmission {
    COMMAND_ADMISSION_TABLE
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, admission)| *admission)
        .unwrap_or(CommandAdmission::Normal)
}

/// Authorize one desktop IPC command against the mandatory-policy gate.
///
/// This is the replacement for the wrapper's current
/// `matches!(command, "shell_quit_request" | "shell_menu_action") ||
/// require_normal(app)`: the two hand-written exceptions become table entries,
/// and intentional reads stay callable while a blocking requirement stands.
/// Origin/ACL authorization (`security::authorized_invoke`) is still required
/// first and is not replaced by this function.
pub fn authorize_desktop_command(app: &tauri::AppHandle, command: &str) -> Result<(), DshError> {
    match command_admission(command) {
        CommandAdmission::Always | CommandAdmission::Informational => Ok(()),
        CommandAdmission::MandatoryUpdate => {
            let state = app.try_state::<Arc<AppState>>().ok_or_else(|| {
                DshError::other("mandatory_policy", "Desktop admission is not initialized.")
            })?;
            if state.policy.allows(NativeAction::MandatoryUpdate) {
                Ok(())
            } else {
                Err(DshError::other(
                    "mandatory_policy",
                    "The mandatory update action is not admitted by policy.",
                ))
            }
        }
        CommandAdmission::Normal => require_normal(app),
    }
}
/// Revalidate on the actual UI execution turn, not when a worker queues work.
pub async fn on_main_normal<T, F>(app: &tauri::AppHandle, effect: F) -> Result<T, DshError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, DshError> + Send + 'static,
{
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = require_normal(&handle).and_then(|_| effect());
        let _ = sender.send(result);
    })
    .map_err(|error| DshError::other("native_dispatch", error.to_string()))?;
    receiver
        .await
        .map_err(|_| DshError::other("native_dispatch", "Native action was cancelled."))?
}

pub fn show_owned_main(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || show_owned_main_on_ui(&handle));
}
fn show_owned_main_on_ui(app: &tauri::AppHandle) {
    if require_normal(app).is_err() {
        if let Some(window) = app.get_webview_window("mandatory-policy") {
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        if require_normal(app).is_ok() {
            let _ = window.unminimize();
            if require_normal(app).is_err() {
                return;
            }
            let _ = window.show();
            if require_normal(app).is_err() {
                return;
            }
            let _ = window.set_focus();
        }
    }
}

/// Delay first renderer navigation until native acknowledgment; never navigate to a blocked 503.
pub fn defer_navigation(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    url: url::Url,
    owner: Arc<PolicyOwner>,
) -> Result<(), String> {
    let gate = app.state::<Arc<AppState>>().policy.clone();
    let mut slot = gate
        .navigation
        .try_lock()
        .map_err(|_| "policy navigation busy")?;
    if slot.is_some() {
        return Err("policy navigation already owned".into());
    }
    let worker_gate = gate.clone();
    let mut shutdown = gate.shutdown.subscribe();
    *slot = Some(tauri::async_runtime::spawn(async move {
        loop {
            if *shutdown.borrow() {
                return;
            }
            tokio::select! { biased; _ = shutdown.changed() => return, ready = owner.wait_for_normal() => if !ready { return; } }
            let task_app = app.clone();
            let task_window = window.clone();
            let task_gate = worker_gate.clone();
            let task_url = url.clone();
            let (sender, receiver) = tokio::sync::oneshot::channel();
            if app
                .run_on_main_thread(move || {
                    if !task_gate.allows(NativeAction::Normal) {
                        let _ = sender.send(Ok(false));
                        return;
                    }
                    let result = crate::renderer_native::install_and_navigate(
                        &task_window,
                        &task_app,
                        task_url,
                    )
                    .map_err(|error| error.to_string())
                    .and_then(|_| {
                        if !task_gate.allows(NativeAction::Normal) {
                            return Ok(false);
                        }
                        task_window
                            .show()
                            .map(|_| true)
                            .map_err(|error| error.to_string())
                    });
                    let _ = sender.send(result);
                })
                .is_err()
            {
                worker_gate.fail();
                return;
            }
            tokio::select! { biased; _ = shutdown.changed() => return, result = receiver => match result { Ok(Ok(true)) => return, Ok(Ok(false)) => continue, _ => { worker_gate.fail(); return; } } }
        }
    }));
    Ok(())
}

pub async fn present_initialization_failure(app: &tauri::AppHandle, detail: &str) {
    use tauri_plugin_dialog::DialogExt;
    let state = app.state::<Arc<AppState>>();
    let messages = crate::state::messages(state.locale.lock().await.snapshot().effective);
    let _ = crate::native_dialog::answer(|reply| {
        app.dialog()
            .message(detail)
            .title(messages.update_title)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCustom(
                messages.quit.to_string(),
            ))
            .show(reply);
    })
    .await;
    crate::quit_flow::request_quit(app).await.ok();
}

#[tauri::command]
pub async fn policy_presented(
    state: tauri::State<'_, Arc<AppState>>,
    sequence: u64,
) -> Result<(), String> {
    state.policy.presented(sequence).await
}
#[tauri::command]
pub fn policy_retry(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if !state.policy.allows(NativeAction::PolicyRetry) {
        return Err("Policy retry unavailable".into());
    }
    state.policy.trigger(PolicyScenario::Manual);
    Ok(())
}
#[tauri::command]
pub async fn policy_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), String> {
    if !state.policy.allows(NativeAction::MandatoryUpdate)
        || !state
            .policy
            .current_decision()
            .is_some_and(|decision| decision.blocking)
    {
        return Err("No authoritative mandatory update is active".into());
    }
    crate::update_flow::check(&app)
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}
#[tauri::command]
pub async fn policy_quit(app: tauri::AppHandle) -> Result<(), String> {
    crate::quit_flow::request_quit(&app)
        .await
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fake(Mutex<MandatoryDecision>);
    impl Authority for Fake {
        fn current(&self) -> MandatoryDecision {
            self.0.lock().unwrap().clone()
        }
        fn route(&self, action: NativeAction) -> RouteVerdict {
            if action == NativeAction::Normal && self.current().blocking {
                RouteVerdict::Deny
            } else {
                RouteVerdict::Allow
            }
        }
    }
    fn starting() -> Arc<PolicyGate> {
        let gate = PolicyGate::from_input(&Err("invalid".into()));
        gate.admission.lock().unwrap().phase = Phase::Starting;
        gate
    }
    #[test]
    fn absent_means_normal_only_and_quit() {
        let gate = PolicyGate::from_input(&Ok(None));
        assert!(gate.allows(NativeAction::Normal));
        assert!(gate.allows(NativeAction::Quit));
        assert!(!gate.allows(NativeAction::PolicyRetry));
        assert!(!gate.allows(NativeAction::MandatoryUpdate));
    }
    #[test]
    fn invalid_starting_and_disposed_always_allow_quit_only() {
        let gate = starting();
        for phase in [Phase::Starting, Phase::Failed, Phase::Disposed] {
            gate.admission.lock().unwrap().phase = phase;
            assert!(gate.allows(NativeAction::Quit));
            for action in [
                NativeAction::Normal,
                NativeAction::PolicyRetry,
                NativeAction::MandatoryUpdate,
            ] {
                assert!(!gate.allows(action));
            }
        }
    }
    #[test]
    fn authoritative_changes_apply_without_publication_cache() {
        let gate = starting();
        let fake = Arc::new(Fake(Mutex::new(MandatoryDecision::initial())));
        {
            let mut admission = gate.admission.lock().unwrap();
            admission.authority = Some(fake.clone());
            admission.phase = Phase::Active;
        }
        assert!(gate.allows(NativeAction::Normal));
        fake.0.lock().unwrap().blocking = true;
        assert!(!gate.allows(NativeAction::Normal));
        assert!(gate.allows(NativeAction::PolicyRetry));
        assert!(gate.current_decision().unwrap().blocking);
        fake.0.lock().unwrap().blocking = false;
        assert!(gate.allows(NativeAction::Normal));
        gate.fail();
        assert!(!gate.allows(NativeAction::Normal));
        assert!(gate.current_decision().is_none());
    }
    #[tokio::test]
    async fn disposed_disabled_gate_cannot_reopen_normal() {
        let gate = PolicyGate::from_input(&Ok(None));
        gate.dispose().await;
        assert!(!gate.allows(NativeAction::Normal));
        assert!(gate.allows(NativeAction::Quit));
        gate.dispose().await;
        assert!(!gate.allows(NativeAction::Normal));
    }

    // --- command/action admission table ------------------------------------

    /// The command names the shell actually declares, read from `lib.rs`.
    ///
    /// Source-pinned: the table below and the handler list must agree, so adding
    /// a command without classifying it fails here rather than silently
    /// inheriting ordinary admission (or, worse, an exception).
    fn declared_desktop_commands() -> Vec<String> {
        let source = include_str!("lib.rs");
        let start = source
            .find("tauri::generate_handler![")
            .expect("the shell declares a handler list");
        let rest = &source[start..];
        let end = rest.find("];").expect("the handler list is terminated");
        rest[..end]
            .split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty() && *entry != "tauri::generate_handler![")
            .map(|entry| {
                entry
                    .rsplit("::")
                    .next()
                    .expect("a handler path has a last segment")
                    .trim()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn every_declared_desktop_command_has_exactly_one_admission_class() {
        let declared = declared_desktop_commands();
        assert!(
            declared.len() > 40,
            "the pin must read the real handler list, saw {declared:?}"
        );
        for command in &declared {
            let classified = COMMAND_ADMISSION_TABLE
                .iter()
                .filter(|(name, _)| name == command)
                .count();
            assert_eq!(
                classified, 1,
                "`{command}` is declared in lib.rs and must be classified exactly once"
            );
        }
        for (name, _) in COMMAND_ADMISSION_TABLE {
            assert!(
                declared.iter().any(|command| command == name),
                "`{name}` is classified but not declared in lib.rs"
            );
        }
        assert_eq!(
            COMMAND_ADMISSION_TABLE.len(),
            declared.len(),
            "the table and the handler list must have the same size"
        );
    }

    #[test]
    fn an_unknown_command_is_classified_normal_not_exempt() {
        assert_eq!(
            command_admission("shell_something_new"),
            CommandAdmission::Normal
        );
        assert!(command_admission("shell_something_new").requires_normal());
        assert_eq!(command_admission(""), CommandAdmission::Normal);
    }

    #[test]
    fn the_table_names_the_quit_and_menu_exceptions_explicitly() {
        // These are the two hand-written exceptions the wrapper used to carry.
        assert_eq!(
            command_admission("shell_quit_request"),
            CommandAdmission::Always
        );
        assert_eq!(
            command_admission("shell_menu_action"),
            CommandAdmission::Always
        );
        for command in ["policy_presented", "policy_retry", "policy_quit"] {
            assert_eq!(
                command_admission(command),
                CommandAdmission::Always,
                "{command}"
            );
        }
        assert_eq!(
            command_admission("policy_update"),
            CommandAdmission::MandatoryUpdate
        );
    }

    #[test]
    fn informational_reads_survive_a_block_that_denies_ordinary_routes() {
        // A gate that denies Normal is what a blocking mandatory requirement (or
        // an incomplete native presentation) produces.
        let gate = starting();
        assert!(
            !gate.allows(NativeAction::Normal),
            "the gate in this state denies ordinary routes"
        );
        for command in [
            "update_status",
            "runtime_status",
            "runtime_quit_inspection",
            "shell_app_info",
            "shell_host_paths",
            "shell_locale_get",
            "shell_appearance",
            "shell_shortcuts_get",
            "settings_get",
            "settings_list",
            "credential_list",
            "credential_has",
        ] {
            let admission = command_admission(command);
            assert_eq!(
                admission,
                CommandAdmission::Informational,
                "`{command}` must stay readable while Normal is denied"
            );
            assert!(
                !admission.requires_normal(),
                "`{command}` must not require ordinary admission"
            );
        }
        // The mutations and native effects stay on the ordinary route.
        for command in [
            "settings_set",
            "shell_theme_set",
            "shell_quit_request_adjacent_unknown",
            "update_check",
            "update_open",
            "runtime_restart",
            "credential_store",
        ] {
            assert!(
                command_admission(command).requires_normal(),
                "`{command}` must require ordinary admission"
            );
        }
    }
}
