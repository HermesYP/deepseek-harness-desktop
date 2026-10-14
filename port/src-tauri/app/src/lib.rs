//! DeepSeek Harness Desktop — the Tauri 2 shell over the Rust application core.
//!
//! Implements `docs/contracts/tauri-contract.md` exactly: 34 commands, the
//! `dsh://` event set. The initialization script installs only DOM markers;
//! the TypeScript bridge owns product globals. Window close hides to the
//! tray (Windows, with the first-hide acknowledgement marker), the tray and
//! application menus are localized, quit runs the inspection + confirmation
//! model, and exit stops the runtime tree (graceful then forced) and flushes
//! logs.

use std::sync::Arc;

use dsh_core::credentials::CredentialStore;
use dsh_core::paths::{resolve_app_paths, resolve_desktop_paths};
use dsh_core::protocol::{LocaleId, RuntimeStatus, ShellWindowEvent, ShellWindowState, Theme};
use dsh_core::settings::SettingsStore;
use dsh_core::shortcuts::{ShortcutPersistence, ShortcutRuntime};
use dsh_runtime::supervisor::{SpawnPlan, Supervisor};
use tauri::{Emitter, Manager};

mod chrome;
mod commands;
mod credential_backend;
#[cfg(debug_assertions)]
mod dev_handoff;
#[path = "dev_handoff_boundary.rs"]
mod dev_handoff_boundary;
mod directory_picker;
mod fatal;
#[path = "guests.rs"]
mod guests;
mod mandatory_update;
mod menu_action;
mod native_dialog;
mod native_paths;
mod native_policy_surface;
mod policy_bootstrap;
mod policy_composition;
mod policy_metadata;
mod policy_owner;
mod policy_runner;
mod policy_transport;
mod power_resume;
mod quit_flow;
mod renderer_bridge;
mod renderer_diagnostics;
mod renderer_native;
mod security;
mod shell_messages;
mod state;
mod tray_close;
mod update_flow;
mod update_schedule;
mod update_security;

/// The application, not a setup stack frame, owns the asynchronous log writer.
pub(crate) struct DiagnosticsLifetime(
    std::sync::Mutex<Option<dsh_core::diagnostics::DiagnosticsGuard>>,
);

impl DiagnosticsLifetime {
    fn flush(&self) {
        // Taking the guard joins the writer and flushes final diagnostic lines.
        drop(
            self.0
                .lock()
                .unwrap_or_else(|poison| poison.into_inner())
                .take(),
        );
    }
}

/// A single-use explicit survivor-consent permit, bound to the quit generation.
/// Ordinary exits and inspection skip rules never create this permission.
#[derive(Default)]
pub(crate) struct TerminalExitPermit(std::sync::Mutex<Option<dsh_core::quit::QuitAttempt>>);

impl TerminalExitPermit {
    pub(crate) fn authorize(&self, attempt: dsh_core::quit::QuitAttempt) {
        *self.0.lock().unwrap_or_else(|poison| poison.into_inner()) = Some(attempt);
    }

    fn take_for(&self, flow: &dsh_core::quit::QuitFlow) -> Option<dsh_core::quit::QuitAttempt> {
        self.0
            .lock()
            .unwrap_or_else(|poison| poison.into_inner())
            .take()
            .filter(|attempt| flow.owns(*attempt))
    }
}

static CLOSE_TO_TRAY: std::sync::LazyLock<tray_close::CloseGate> =
    std::sync::LazyLock::new(tray_close::CloseGate::default);

use state::{
    shortcut_platform, AppState, LocaleModel, UpdateService, CREDENTIAL_PROVIDER_KEY,
    CREDENTIAL_REFERENCE_KEY, LOCALE_PREFERENCE_KEY, THEME_KEY,
};

/// Injected Windows controls replace the native caption on the frameless window.
const WINDOWS_CHROME_SCRIPT: &str = r#"
    if (!document.getElementById('dsh-native-chrome')) {
      const style = document.createElement('style');
      style.textContent = `
        body { background: var(--dsh-caption-fill, #f9fafb); }
        #root { height: 100% !important; box-sizing: border-box !important; }
        #dsh-native-chrome { position: fixed; inset: 0 0 auto 0; height: 40px; z-index: 1090;
          display: flex; justify-content: flex-end; pointer-events: none; color: var(--dsh-caption-symbol, #0f1115);
          background: var(--dsh-caption-fill, #f9fafb); font-family: system-ui, sans-serif; }
        #dsh-native-chrome .dsh-drag { flex: 1; min-width: 0; pointer-events: auto; }
        #dsh-native-chrome .dsh-buttons { display: flex; width: 138px; height: 40px; pointer-events: auto; }
        #dsh-native-chrome button { width: 46px; height: 40px; padding: 0; border: 0; border-radius: 0;
          color: inherit; background: transparent; display: grid; place-items: center; cursor: default; }
        #dsh-native-chrome button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
        #dsh-native-chrome button[data-action="close"]:hover { background: #c42b1c; color: white; }
        #dsh-native-chrome svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
      `;
      document.documentElement.appendChild(style);
      const chrome = document.createElement('div');
      chrome.id = 'dsh-native-chrome';
      chrome.innerHTML = '<div class="dsh-drag"></div><div class="dsh-buttons">'
        + '<button type="button" aria-label="Minimize" title="Minimize" data-action="minimize"><svg viewBox="0 0 10 10"><path d="M1 7.5h8"/></svg></button>'
        + '<button type="button" aria-label="Maximize" title="Maximize" data-action="maximize"><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg></button>'
        + '<button type="button" aria-label="Close" title="Close" data-action="close"><svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8"/></svg></button></div>';
      document.documentElement.appendChild(chrome);
      chrome.querySelector('.dsh-drag').addEventListener('mousedown', event => {
        if (event.button !== 0) return;
        const action = event.detail === 2 ? 'maximize' : 'drag';
        window.__TAURI_INTERNALS__.invoke('shell_window_chrome_action', { action }).catch(() => {});
      });
      chrome.addEventListener('click', event => {
        const action = event.target.closest('button')?.dataset.action;
        if (action) window.__TAURI_INTERNALS__.invoke('shell_window_chrome_action', { action }).catch(() => {});
      });
      window.addEventListener('keydown', event => {
        if (event.key === 'F12' && !event.repeat) {
          event.preventDefault();
          window.__TAURI_INTERNALS__.invoke('shell_window_toggle_devtools').catch(() => {});
        }
      });
    }
"#;

/// Installs platform markers and port-owned window chrome before the client boots.
fn init_script(locale: dsh_core::protocol::LocaleId) -> String {
    format!(
        r#"(function () {{
  globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers();
  const mark = () => {{
    const root = document.documentElement;
    if (!root) return;
    root.dataset.platform = '{platform}';
    root.setAttribute('data-ds-theme-source', root.getAttribute('data-ds-theme-source') || 'system');
    {caption_labels}
    {windows_chrome}
    {host_paths}
    {renderer_console}
  }};
  if (document.documentElement) mark();
  else window.addEventListener('DOMContentLoaded', mark, {{ once: true }});
}})();"#,
        platform = platform_id(),
        windows_chrome = if cfg!(windows) {
            // Mark the root immediately; mount the menu only after body exists.
            // Tauri does not provide Electron's Windows title-bar overlay, so
            // retain port-owned window controls without a second resize layer.
            format!(
                "{root}\n{WINDOWS_CHROME_SCRIPT}\n(function () {{ const install = () => {{ {bundle} }}; if (document.body) install(); else window.addEventListener('DOMContentLoaded', install, {{ once: true }}); }})();",
                root = chrome::windows_caption_root_script(),
                bundle = chrome::windows_caption_scripts(),
            )
        } else {
            String::new()
        },
        host_paths = native_paths::HOST_PATHS_SCRIPT,
        caption_labels = chrome::label_sync_script(&chrome::caption_menu_labels(locale)),
        renderer_console = renderer_bridge::SCRIPT,
    )
}

fn platform_id() -> &'static str {
    if cfg!(target_os = "windows") {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

pub(crate) fn is_owned_application_window(window: &tauri::WebviewWindow) -> bool {
    window.label() == "main"
        && window
            .try_state::<security::OwnedAppOrigin>()
            .and_then(|origin| window.url().ok().map(|url| origin.allows_navigation(&url)))
            .unwrap_or(false)
}

fn allow_global_instance_activation(requested_namespace: Option<&std::ffi::OsStr>) -> bool {
    requested_namespace.is_none()
}

fn terminal_stop_admission_refused(result: &Result<(), dsh_core::DshError>) -> bool {
    matches!(
        result,
        Err(dsh_core::DshError::Other { code, .. })
            if matches!(code.as_str(), "quit_busy" | "quit_superseded" | "update_shutdown_busy")
    )
}

pub fn run() -> Result<(), tauri::Error> {
    // Keep ownership until the event loop exits. Shutdown must remain asynchronous:
    // a cancelled earlier disposer may retain cleanup queued on this UI thread.
    let shutdown_done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let shutdown_active = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut shutdown_task: Option<tauri::async_runtime::JoinHandle<()>> = None;
    let desktop_handler: fn(tauri::ipc::Invoke) -> bool = tauri::generate_handler![
        guests::commands::guest_browser_acquire,
        guests::commands::guest_browser_release,
        guests::commands::guest_browser_set_bounds,
        guests::commands::guest_browser_navigate,
        guests::commands::guest_browser_command,
        guests::commands::guest_browser_state,
        guests::commands::guest_platform_status,
        guests::commands::guest_platform_open,
        guests::commands::guest_platform_set_bounds,
        guests::commands::guest_platform_close,
        commands::shell_host_paths,
        commands::shell_host_paths_consume,
        commands::shell_caption_menu,
        chrome::shell_caption_palette,
        renderer_bridge::shell_renderer_console,
        commands::shell_app_info,
        commands::shell_locale_get,
        commands::shell_locale_set,
        commands::shell_locale_apply,
        commands::shell_window_set_fullscreen,
        commands::shell_window_chrome_action,
        commands::shell_window_resize_dragging,
        commands::shell_window_toggle_devtools,
        commands::shell_theme_set,
        commands::shell_appearance,
        commands::shell_menu_action,
        commands::shell_open_external,
        commands::shell_clipboard_write,
        commands::shell_clipboard_read,
        commands::shell_quit_request,
        commands::shell_close_window,
        commands::shell_onboarding_set_active,
        commands::shell_pick_directory,
        commands::runtime_boot_ready,
        commands::runtime_boot_failed,
        commands::runtime_status,
        commands::runtime_restart,
        commands::runtime_quit_inspection,
        commands::settings_get,
        commands::settings_set,
        commands::settings_list,
        commands::settings_reset,
        commands::credential_list,
        commands::credential_has,
        commands::credential_store,
        commands::credential_delete,
        commands::update_status,
        commands::update_configuration,
        commands::update_open,
        commands::update_check,
        commands::shell_shortcuts_get,
        commands::shell_shortcuts_edit,
        commands::shell_shortcuts_recording,
        policy_composition::policy_presented,
        policy_composition::policy_retry,
        policy_composition::policy_update,
        policy_composition::policy_quit,
    ];
    let startup_failure = Arc::new(std::sync::OnceLock::<dsh_core::DshError>::new());
    let builder = tauri::Builder::default()
        .manage(startup_failure.clone())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // The shell routes links through shell_open_external, with the owned
        // origin and normal-policy checks. The plugin's automatic click script
        // invokes a separate command outside that capability inventory.
        .plugin(
            tauri_plugin_opener::Builder::new()
                .open_js_links_on_click(false)
                .build(),
        );
    // The plugin's singleton names use only the static application identifier.
    // An explicitly requested qualification namespace must never activate an
    // installed instance, including before setup rejects an invalid namespace.
    // Setup still validates Unicode/debug UUID containment before acquiring the
    // independent profile-scoped lock. Ordinary launches retain the plugin.
    let requested_namespace = std::env::var_os(credential_backend::OWNED_NAMESPACE_ENV);
    let builder = if allow_global_instance_activation(requested_namespace.as_deref()) {
        builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            policy_composition::show_owned_main(app);
        }))
    } else {
        builder
    };
    let exit_code = builder
        .invoke_handler(move |invoke| {
            let policy_command = invoke.message.command().starts_with("policy_");
            let authorized = if policy_command {
                security::authorized_policy_invoke(&invoke)
            } else {
                security::authorized_invoke(&invoke)
                    && policy_composition::authorize_desktop_command(
                        invoke.message.webview_ref().app_handle(),
                        invoke.message.command(),
                    )
                    .is_ok()
            };
            if !authorized {
                invoke.resolver.reject(
                    "Desktop command denied for this webview, origin, or mandatory policy.",
                );
                return true;
            }
            desktop_handler(invoke)
        })
        .setup(|app| match setup(app) {
            Ok(()) => Ok(()),
            Err(error) => record_startup_failure(app, &error)
                .map_err(|error| Box::new(error) as Box<dyn std::error::Error>),
        })
        .build(tauri::generate_context!())?
        .run_return(move |app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                // A profile-lock loser exits before AppState/Host/window setup.
                // Do not prevent that exit or schedule disposal of missing state.
                if app.try_state::<Arc<AppState>>().is_none() {
                    return;
                }
                if shutdown_done.load(std::sync::atomic::Ordering::Acquire) {
                    return;
                }
                api.prevent_exit();
                if shutdown_task.is_none()
                    || !shutdown_active.load(std::sync::atomic::Ordering::Acquire)
                {
                    if shutdown_active.swap(true, std::sync::atomic::Ordering::AcqRel) {
                        return;
                    }
                    let app = app.clone();
                    let done = shutdown_done.clone();
                    let active = shutdown_active.clone();
                    let previous = shutdown_task.take();
                    shutdown_task = Some(tauri::async_runtime::spawn(async move {
                        // Failed or unwinding teardown must leave Quit available
                        // for a subsequent explicit attempt, not strand a sticky flag.
                        struct Attempt(Arc<std::sync::atomic::AtomicBool>);
                        impl Drop for Attempt {
                            fn drop(&mut self) {
                                self.0.store(false, std::sync::atomic::Ordering::Release);
                            }
                        }
                        let _attempt = Attempt(active);
                        if let Some(previous) = previous {
                            if let Err(error) = previous.await {
                                tracing::error!(%error, "previous desktop shutdown task failed");
                            }
                        }
                        let state = app.state::<Arc<AppState>>();
                        let (exit_claim, survivor_consent) = {
                            let mut flow = state.quit_flow.lock().await;
                            match app.state::<TerminalExitPermit>().take_for(&flow) {
                                Some(attempt) => (attempt, true),
                                None => (flow.bypass(dsh_core::protocol::QuitReason::User), false),
                            }
                        };
                        // Commit one-way update closure under the same supervisor
                        // slot that guards Host Unlock delivery. Never await an
                        // update/quit mutex while holding that slot: contention or
                        // supersession refuses this attempt instead of reopening it.
                        let stop_result = state
                            .supervisor
                            .stop_if(false, || {
                                let flow = state.quit_flow.try_lock().map_err(|_| {
                                    dsh_core::DshError::other(
                                        "quit_busy",
                                        "quit state changed during terminal admission",
                                    )
                                })?;
                                if !flow.owns(exit_claim) {
                                    return Err(dsh_core::DshError::other(
                                        "quit_superseded",
                                        "terminal exit attempt no longer owns admission",
                                    ));
                                }
                                let mut update = state.update.try_lock().map_err(|_| {
                                    dsh_core::DshError::other(
                                        "update_shutdown_busy",
                                        "update state is busy during terminal admission",
                                    )
                                })?;
                                update.close_admission();
                                Ok(())
                            })
                            .await;
                        let teardown = state.supervisor.teardown_status().await;
                        let stopped = stop_result.is_ok()
                            && teardown.is_settled()
                            && dsh_core::quit::stop_is_resolved(state.supervisor.status().state);
                        if !state.quit_flow.lock().await.owns(exit_claim) {
                            tracing::warn!("superseded desktop exit attempt cannot commit");
                            return;
                        }
                        // Consent for an owned survivor is not consent to bypass
                        // a refused lifecycle admission or leave updates open.
                        if terminal_stop_admission_refused(&stop_result) {
                            tracing::warn!(error = ?stop_result.err(), "application exit admission refused");
                            state.quit_flow.lock().await.release(exit_claim);
                            return;
                        }
                        if !stopped && !survivor_consent {
                            tracing::error!(error = ?stop_result.err(), "application exit refused: Host teardown remains unresolved");
                            state.quit_flow.lock().await.release(exit_claim);
                            return;
                        }
                        if !stopped {
                            tracing::warn!(error = ?stop_result.err(), "explicit generation-owned consent permits exit with unresolved Host teardown");
                        }
                        // Close admission before retiring native identities. Bound
                        // the main-loop round trip so a stalled UI cannot hold
                        // the Host tree alive indefinitely during exit.
                        let guests = app.state::<guests::MainThreadGuests>().inner().clone();
                        let cleanup = async {
                            let actions = state.guests.lock().await.shutdown();
                            guests.teardown(&state.paths.user_data, actions).await
                        };
                        match tokio::time::timeout(std::time::Duration::from_secs(5), cleanup).await
                        {
                            Ok(Ok(())) => {}
                            Ok(Err(error)) => {
                                tracing::error!(%error, "native guest exit teardown failed");
                                state.quit_flow.lock().await.release(exit_claim);
                                return;
                            }
                            Err(_) => {
                                tracing::error!("native guest exit teardown deadline exceeded");
                                state.quit_flow.lock().await.release(exit_claim);
                                return;
                            }
                        }
                        if !state.quit_flow.lock().await.owns(exit_claim) {
                            tracing::warn!("superseded exit refused before owner disposal");
                            return;
                        }
                        // A timer disposal is not update quiescence. Close
                        // admission and await operation settlement before draining
                        // retired artifacts or disposing the policy owner.
                        let updates = update_flow::shutdown_updates(
                            &app,
                            std::time::Duration::from_secs(10),
                        )
                        .await;
                        if !updates.quiescence.is_quiescent() {
                            tracing::error!(quiescence = ?updates.quiescence,
                                "application exit refused: update owners have not settled; artifacts retained");
                            state.quit_flow.lock().await.release(exit_claim);
                            return;
                        }
                        if !updates.cleanup.failed.is_empty()
                            || matches!(&updates.cleanup.delivery, update_flow::CleanupDelivery::NotObserved(_))
                        {
                            tracing::warn!(cleanup = ?updates.cleanup,
                                "update artifact cleanup was incomplete; no claim that retired files are gone");
                        }
                        if !state.quit_flow.lock().await.owns(exit_claim) {
                            tracing::warn!("superseded exit refused after update settlement");
                            return;
                        }
                        // Keep the policy owner available through a refused exit.
                        state.policy.dispose().await;
                        if stopped {
                            tracing::info!("desktop shutdown completed");
                        } else {
                            tracing::warn!("desktop exiting by explicit consent, not a successful Host stop");
                        }
                        done.store(true, std::sync::atomic::Ordering::Release);
                        app.exit(code.unwrap_or(0));
                    }));
                }
            } else if matches!(event, tauri::RunEvent::Exit) {
                tracing::info!("desktop event loop exiting");
                if let Some(diagnostics) = app.try_state::<DiagnosticsLifetime>() {
                    diagnostics.flush();
                }
            }
        });
    // Tauri executes setup inside its event loop and panics on a setup Err.
    // Keep refusals on the normal exit path, then return their original cause
    // after run_return has delivered Exit and flushed managed diagnostics.
    desktop_run_result(exit_code, startup_failure.get())
}

fn desktop_run_result(
    exit_code: i32,
    startup_failure: Option<&dsh_core::DshError>,
) -> Result<(), tauri::Error> {
    if let Some(error) = startup_failure {
        let error: Box<dyn std::error::Error> = Box::new(error.clone());
        return Err(tauri::Error::Setup(error.into()));
    }
    if exit_code != 0 {
        let error: Box<dyn std::error::Error> = Box::new(dsh_core::DshError::other(
            "desktop_exit_nonzero",
            format!("Desktop event loop returned exit code {exit_code}."),
        ));
        return Err(tauri::Error::Setup(error.into()));
    }
    Ok(())
}

fn desktop_node_target(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("win-x64"),
        ("windows", "aarch64") => Some("win-arm64"),
        ("macos", "x86_64") => Some("darwin-x64"),
        ("macos", "aarch64") => Some("darwin-arm64"),
        ("linux", "x86_64") => Some("linux-x64"),
        ("linux", "aarch64") => Some("linux-arm64"),
        _ => None,
    }
}

fn resolve_desktop_node(
    runtime_dir: &std::path::Path,
    explicit_override: Option<std::ffi::OsString>,
) -> Result<std::path::PathBuf, dsh_core::error::DshError> {
    if let Some(node) = explicit_override {
        return Ok(std::path::PathBuf::from(node));
    }

    let manifest_path = runtime_dir.join("runtime-payload.json");
    let manifest = std::fs::read_to_string(&manifest_path).map_err(|error| {
        dsh_core::error::DshError::io(
            "read runtime identity",
            Some(manifest_path.display().to_string()),
            &error,
        )
    })?;
    // The manifest contains thousands of file inventory rows. Startup only
    // needs Node identity; ignore the inventory instead of allocating a generic
    // JSON tree for every row before the Host can be spawned.
    #[derive(serde::Deserialize)]
    struct RuntimeIdentity {
        node: Option<NodeIdentity>,
    }
    #[derive(serde::Deserialize)]
    struct NodeIdentity {
        version: Option<String>,
        target: Option<String>,
    }
    let identity: RuntimeIdentity = serde_json::from_str(&manifest).map_err(|error| {
        dsh_core::error::DshError::other("runtime_identity_invalid", error.to_string())
    })?;
    let version = identity
        .node
        .as_ref()
        .and_then(|node| node.version.as_deref());
    let target = identity
        .node
        .as_ref()
        .and_then(|node| node.target.as_deref());
    let expected_target = desktop_node_target(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or_else(|| {
            dsh_core::error::DshError::other(
                "runtime_target_unsupported",
                "This build has no supported bundled Node target.",
            )
        })?;
    if version.is_none_or(|value| value.trim().is_empty()) || target != Some(expected_target) {
        return Err(dsh_core::error::DshError::other(
            "runtime_identity_invalid",
            format!(
                "The bundled Node identity is missing or does not match this build at {}.",
                manifest_path.display()
            ),
        ));
    }

    #[cfg(target_os = "windows")]
    let relative = std::path::Path::new("node").join("node.exe");
    #[cfg(not(target_os = "windows"))]
    let relative = std::path::Path::new("node").join("bin").join("node");
    Ok(runtime_dir.join(relative))
}

fn validate_host_prerequisites(
    node: &std::path::Path,
    adapter: &std::path::Path,
    runtime_dir: &std::path::Path,
) -> Result<(), dsh_core::error::DshError> {
    if !adapter.is_file() {
        return Err(dsh_core::error::DshError::other(
            "host_adapter_missing",
            format!(
                "The Desktop Host adapter is missing at {}. Reinstall the application or set DSH_DESKTOP_RUNTIME_ADAPTER to a valid adapter file.",
                adapter.display()
            ),
        ));
    }

    for package in [
        "@deepseek-ai/dsh/package.json",
        "@deepseek-ai/cordis-plugin-group/package.json",
    ] {
        if !runtime_dir.join("node_modules").join(package).is_file() {
            return Err(dsh_core::error::DshError::other(
                "host_runtime_incomplete",
                format!(
                    "The Desktop Host runtime is missing node_modules/{package} under {}. Reinstall the application; its runtime payload is incomplete.",
                    runtime_dir.display()
                ),
            ));
        }
    }

    let output = std::process::Command::new(node)
        .arg("--version")
        .output()
        .map_err(|_| {
            dsh_core::error::DshError::other(
                "node_missing",
                format!(
                    "Node.js 22.19+ or 24+ is required to run the Desktop Host. Install a supported Node.js version and ensure it is on PATH, or set DSH_DESKTOP_NODE to its executable. Checked: {}.",
                    node.display()
                ),
            )
        })?;
    let version = String::from_utf8_lossy(&output.stdout);
    let mut components = version.trim().trim_start_matches('v').split('.');
    let major = components
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    let minor = components
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    let patch = components
        .next()
        .and_then(|value| value.parse::<u32>().ok());
    let supported = match (major, minor, patch) {
        (Some(22), Some(minor), Some(patch)) => (minor, patch) >= (19, 0),
        (Some(major), _, _) => major >= 24,
        _ => false,
    };
    if !output.status.success() || !supported {
        return Err(dsh_core::error::DshError::other(
            "node_unsupported",
            format!(
                "Node.js 22.19+ or 24+ is required to run the Desktop Host. Install a supported Node.js version and ensure it is on PATH, or set DSH_DESKTOP_NODE to its executable. Checked: {}.",
                node.display()
            ),
        ));
    }
    Ok(())
}

fn executable_directory() -> Result<std::path::PathBuf, dsh_core::error::DshError> {
    let executable = std::env::current_exe()
        .map_err(|error| dsh_core::error::DshError::io("current_exe", None, &error))?;
    executable
        .parent()
        .map(std::path::Path::to_path_buf)
        .ok_or_else(|| dsh_core::error::DshError::Io {
            operation: "current_exe.parent".to_string(),
            path: None,
            message: "executable has no parent directory".to_string(),
        })
}

/// True only when `directory/index.html` exists AND is a regular file.
///
/// A missing path, or a directory named `index.html`, is not a bundled UI. The
/// probe follows links (`std::fs::metadata`), so a symlinked entry point counts
/// as present, matching how the shell later reads it.
fn shell_index_is_regular_file(directory: &std::path::Path) -> bool {
    std::fs::metadata(directory.join("index.html"))
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
}

/// Choose the shell (client UI) directory from injected inputs.
///
/// Order, and why:
///   1. an explicit `DSH_DESKTOP_SHELL_DIR` always wins (development override);
///   2. otherwise the UI bundled BESIDE THE EXECUTABLE wins whenever its
///      `index.html` is a regular file — in debug AND release builds, so a
///      packaged debug candidate proves its own assembled UI instead of a
///      checkout source tree;
///   3. only when no bundled UI exists does a debug build fall back to the
///      checkout source directory (development without an assembled bundle);
///   4. a release build falls back to `resource_dir()/ui` (the Tauri bundle).
///
/// Pure: every input — including the regular-file probe result and the resource
/// directory outcome — is injected, so the decision can be unit-tested without
/// touching the filesystem or the process environment.
fn select_shell_directory(
    explicit: Option<std::path::PathBuf>,
    bundled_ui: Option<std::path::PathBuf>,
    bundled_ui_present: bool,
    development_source: Option<std::path::PathBuf>,
    release_fallback: Result<std::path::PathBuf, dsh_core::error::DshError>,
) -> Result<std::path::PathBuf, dsh_core::error::DshError> {
    if let Some(directory) = explicit {
        return Ok(directory);
    }
    if let Some(directory) = bundled_ui.filter(|_| bundled_ui_present) {
        return Ok(directory);
    }
    if let Some(directory) = development_source {
        return Ok(directory);
    }
    release_fallback
}

fn resolve_shell_directory(
    app: &tauri::App,
) -> Result<std::path::PathBuf, dsh_core::error::DshError> {
    let bundled_ui = executable_directory()
        .ok()
        .map(|directory| directory.join("ui"));
    let bundled_ui_present = bundled_ui
        .as_deref()
        .map(shell_index_is_regular_file)
        .unwrap_or(false);
    // A debug build without an assembled bundle still runs from the checkout; a
    // release build never reads the source tree.
    let development_source = cfg!(debug_assertions)
        .then(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist"));
    let release_fallback = app
        .path()
        .resource_dir()
        .map(|directory| directory.join("ui"))
        .map_err(|error| dsh_core::error::DshError::other("resource_dir", error.to_string()));
    select_shell_directory(
        std::env::var("DSH_DESKTOP_SHELL_DIR")
            .ok()
            .map(std::path::PathBuf::from),
        bundled_ui,
        bundled_ui_present,
        development_source,
        release_fallback,
    )
}

/// Report a startup failure that happens before the shell state exists.
///
/// [`fatal::report_fatal`] resolves locale, policy and the recovery loop through
/// `AppState`, which itself needs the settings store, the credential store and
/// the gateway signing secret. A failure before those exist — packaged-input
/// validation, the credential fence, diagnostics setup, or the credential
/// store/secret itself — therefore cannot use it, and must not create any of
/// them just to complain: the diagnostic would otherwise depend on the very
/// credential it reports about. This path needs neither state nor credentials:
/// it records the failure on the diagnostic sink when one is installed, always
/// writes it to stderr, and ends the launch without a further durable write.
fn record_startup_failure(
    app: &tauri::App,
    error: &dsh_core::error::DshError,
) -> Result<(), dsh_core::error::DshError> {
    let message = error.to_string();
    tracing::error!(%message, "desktop startup failed before the shell state was available");
    eprintln!(
        "{}: startup failed: {message}",
        dsh_core::paths::PRODUCT_NAME
    );
    let failure = app.state::<Arc<std::sync::OnceLock<dsh_core::DshError>>>();
    let _ = failure.set(error.clone());
    app.handle().exit(1);
    Ok(())
}

fn setup(app: &mut tauri::App) -> Result<(), dsh_core::error::DshError> {
    // ── Validation phase ────────────────────────────────────────────────────
    // Every packaged input and the credential fence are resolved and checked
    // here, before the first durable write. Nothing in this phase creates a
    // directory, a settings file, a credential index or an OS credential, so a
    // rejected configuration cannot leave user data or a fresh signing secret
    // behind, and the shipped credential identities stay untouched.
    let (exe_dir, exe_dir_error) = match executable_directory() {
        Ok(directory) => (directory, None),
        Err(error) => (std::path::PathBuf::new(), Some(error)),
    };
    let (shell_dir, shell_dir_error) = match resolve_shell_directory(app) {
        Ok(directory) => (directory, None),
        Err(error) => (std::path::PathBuf::new(), Some(error)),
    };
    // Packaged web UI assets are validated in the same phase: a missing bundle
    // must be known before the credential index or the signing secret exists.
    let shell_assets_error = if shell_dir_error.is_none()
        && (!shell_dir.join("index.html").is_file() || !shell_dir.join("assets").is_dir())
    {
        Some(dsh_core::error::DshError::other(
            "shell_assets_missing",
            format!(
                "Packaged web UI assets are missing from {}.",
                shell_dir.display()
            ),
        ))
    } else {
        None
    };

    if let Some(error) = exe_dir_error.or(shell_dir_error).or(shell_assets_error) {
        return record_startup_failure(app, &error);
    }

    let runtime_dir = std::env::var("DSH_DESKTOP_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("dsh"));
    // The runtime manifest identity, the pinned Node and the adapter are
    // validated before any durable write, so a broken runtime payload can no
    // longer leave a durable secret (or user data) behind.
    let node = match resolve_desktop_node(&runtime_dir, std::env::var_os("DSH_DESKTOP_NODE")) {
        Ok(node) => node,
        Err(error) => return record_startup_failure(app, &error),
    };
    let adapter = std::env::var("DSH_DESKTOP_RUNTIME_ADAPTER")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| runtime_dir.join("adapter.mjs"));
    if let Err(error) = validate_host_prerequisites(&node, &adapter, &runtime_dir) {
        return record_startup_failure(app, &error);
    }
    let paths = resolve_app_paths(None);
    let desktop = resolve_desktop_paths(None);
    let owned_namespace = std::env::var_os(credential_backend::OWNED_NAMESPACE_ENV)
        .map(|value| {
            value.into_string().map_err(|_| {
                dsh_core::DshError::invalid_argument("ownedNamespace", "must be valid Unicode")
            })
        })
        .transpose();
    let owned_namespace = match owned_namespace {
        Ok(namespace) => namespace,
        Err(error) => return record_startup_failure(app, &error),
    };
    // The credential fence is validated before `create_dir_all`, the settings
    // store, the credential index and the signing secret. An explicitly
    // requested namespace is rejected — release build, non-canonical UUID, or a
    // root outside the compile-time owned scratch directory — without writing
    // anything; it is a caller decision, never derived from (or migrated to) a
    // path or the environment.
    let credential_backend = match credential_backend::DesktopSecretBackend::select(
        owned_namespace.as_deref(),
        &desktop.home,
        &paths.user_data,
    ) {
        Ok(backend) => backend,
        Err(error) => return record_startup_failure(app, &error),
    };
    // ── Durable phase ───────────────────────────────────────────────────────
    std::fs::create_dir_all(&paths.user_data).map_err(|e| {
        dsh_core::error::DshError::io(
            "create user data",
            Some(paths.user_data.display().to_string()),
            &e,
        )
    })?;
    // Process-lifetime single-instance lock on the desktop profile, claimed
    // before any profile access (upstream `claimDesktopSingleInstance`).
    match dsh_core::single_instance::acquire(&desktop) {
        Ok(dsh_core::single_instance::InstanceClaim::AlreadyRunning) => {
            app.handle().exit(0);
            return Ok(());
        }
        Ok(dsh_core::single_instance::InstanceClaim::Acquired(lock)) => {
            // The application owns the claim for its lifetime: managing it keeps
            // the lock alive past every setup frame instead of leaking it.
            app.manage(lock);
        }
        Err(error) => return record_startup_failure(app, &error),
    }
    // Diagnostics are installed before the credential work, so a credential
    // failure is still recorded and a diagnostics failure itself is reported
    // without any credential dependency.
    let log_guard = match dsh_core::diagnostics::init_diagnostics(&paths.logs) {
        Ok(guard) => guard,
        Err(error) => return record_startup_failure(app, &error),
    };
    // The application, not a setup stack frame, owns the asynchronous writer:
    // the managed guard flushes it during exit.
    app.manage(DiagnosticsLifetime(std::sync::Mutex::new(Some(log_guard))));
    // Record the paths selected for this run, so copied portable assets cannot
    // be mistaken for the bytes actually loaded by a development executable.
    // Both files are packaged inputs; no profile data or launch tokens appear.
    for (component, file) in [
        ("ui-index", shell_dir.join("index.html")),
        ("host-adapter", adapter.clone()),
    ] {
        if let Ok(bytes) = std::fs::read(&file) {
            use sha2::{Digest, Sha256};
            let sha256 = format!("{:x}", Sha256::digest(bytes));
            tracing::info!(component, path = %file.display(), %sha256, "selected startup artifact");
        }
    }
    dsh_core::diagnostics::prune_crash_reports(
        &paths.logs,
        dsh_core::diagnostics::CRASH_REPORTS_RETAINED,
    )
    .ok();
    if let Some(namespace) = credential_backend.namespace() {
        tracing::info!(%namespace, "using isolated qualification credential namespace");
    }

    let settings = match SettingsStore::open(&paths.settings) {
        Ok(settings) => settings,
        Err(error) => return record_startup_failure(app, &error),
    };
    let credential_ref = {
        let provider = settings
            .get(CREDENTIAL_PROVIDER_KEY)
            .ok()
            .flatten()
            .cloned();
        let reference = settings
            .get(CREDENTIAL_REFERENCE_KEY)
            .ok()
            .flatten()
            .cloned();
        match (provider, reference) {
            (
                Some(dsh_core::protocol::SettingValue::String(provider)),
                Some(dsh_core::protocol::SettingValue::String(reference)),
            ) => Some(dsh_core::protocol::CredentialIdentity {
                provider,
                reference,
            }),
            _ => None,
        }
    };
    let theme = match settings.get(THEME_KEY).ok().flatten().cloned() {
        Some(dsh_core::protocol::SettingValue::String(value)) if value == "light" => Theme::Light,
        Some(dsh_core::protocol::SettingValue::String(value)) if value == "dark" => Theme::Dark,
        _ => Theme::System,
    };
    let preference = match settings.get(LOCALE_PREFERENCE_KEY).ok().flatten().cloned() {
        Some(dsh_core::protocol::SettingValue::String(value)) if value == "zh" => {
            Some(LocaleId::Zh)
        }
        Some(dsh_core::protocol::SettingValue::String(value)) if value == "en" => {
            Some(LocaleId::En)
        }
        _ => None,
    };
    let languages = state::os_languages();
    let (effective, source) = state::resolve_startup_locale(preference, &languages);

    // A credential-store or signing-secret failure is reported through the
    // credential-free startup diagnostic: `AppState` cannot exist without the
    // very credential that just failed, and no dialog may depend on it.
    let mut credentials = match CredentialStore::open(
        &credential_backend::credential_index_path(&paths.user_data),
        credential_backend,
    ) {
        Ok(store) => store,
        Err(error) => return record_startup_failure(app, &error),
    };
    let signing_secret = match dsh_gateway::auth::load_or_create_secret(&mut credentials) {
        Ok(secret) => secret,
        Err(error) => {
            tracing::error!("browser-session signing secret unavailable");
            return record_startup_failure(app, &error);
        }
    };

    // The Host spawn plan consumes the inputs validated above; `runtime_dir`
    // stays behind for the packaged policy bootstrap.
    let plan = SpawnPlan::desktop_host(
        node,
        adapter,
        runtime_dir.clone(),
        desktop.profile.clone(),
        std::env::var("DSH_DESKTOP_PRIMARY_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .ok(),
        None,
        None,
    );
    let recovery_app = app.handle().clone();
    let supervisor = Arc::new(Supervisor::new(
        plan,
        Some(Box::new(move |fatal| {
            let app = recovery_app.clone();
            let message = fatal.message.clone();
            tauri::async_runtime::spawn(async move {
                fatal::report_fatal(&app, &message).await.ok();
            });
        })),
    ).with_output_observer(Arc::new(|stream, line| {
        let output = renderer_diagnostics::sanitize_field(&renderer_diagnostics::redact(line));
        tracing::info!(host_stream = stream.as_str(), host_output = %output, "Host diagnostic output");
    })));
    let policy_input = policy_bootstrap::load_packaged_policy_paths(
        &shell_dir.join("desktop-policy-bootstrap.json"),
        &runtime_dir,
    );
    let policy_gate = policy_composition::PolicyGate::from_input(&policy_input);
    policy_composition::register_resume_gate(policy_gate.clone())
        .map_err(|error| dsh_core::error::DshError::other("policy_gate", error))?;
    let gateway_gate = policy_gate.clone();
    let gateway = match tauri::async_runtime::block_on(dsh_gateway::start(
        dsh_gateway::GatewayConfig::loopback(shell_dir.clone()).with_admission(Arc::new(
            move || gateway_gate.allows(policy_owner::NativeAction::Normal),
        )),
        signing_secret,
    )) {
        Ok(gateway) => gateway,
        Err(error) => return record_startup_failure(app, &error),
    };
    // Register only this launch's owned origin, before a privileged view exists.
    let gateway_url = match gateway.authenticated_url().parse::<url::Url>() {
        Ok(url) => url,
        Err(error) => {
            return record_startup_failure(
                app,
                &dsh_core::error::DshError::invalid_argument("gateway_url", error.to_string()),
            )
        }
    };
    let owned_origin = match security::OwnedAppOrigin::from_gateway_url(&gateway_url) {
        Ok(origin) => origin,
        Err(error) => return record_startup_failure(app, &error),
    };
    if let Err(error) = owned_origin.install(app.handle()) {
        return record_startup_failure(
            app,
            &dsh_core::error::DshError::other("desktop_capability", error.to_string()),
        );
    }
    app.manage(owned_origin.clone());
    // Development-only assembled-app acceptance handoff; the shared macro
    // removes the call and failure path entirely from Release.
    crate::dsh_debug_handoff! {
        if let Err(error) = dev_handoff::write_gateway_url(&gateway) {
            return record_startup_failure(app, &error);
        }
    };

    let shortcuts = ShortcutPersistence::new(
        Box::new(state::shortcut_storage(&paths)),
        ShortcutRuntime::Desktop,
        shortcut_platform(),
        Box::new(|snapshot| {
            tracing::debug!("shortcut snapshot sequence {}", snapshot.sequence);
        }),
    );
    let state = Arc::new(AppState {
        paths: paths.clone(),
        settings: tokio::sync::Mutex::new(settings),
        credentials: tokio::sync::Mutex::new(credentials),
        shortcuts,
        supervisor: supervisor.clone(),
        gateway,
        policy: policy_gate.clone(),
        // Closed until the native navigation/authentication adapters are qualified.
        guests: tokio::sync::Mutex::new(guests::GuestViews::new(false, false)),
        platform_session: tokio::sync::Mutex::new(None),
        locale: tokio::sync::Mutex::new(LocaleModel {
            preference,
            effective,
            source,
            languages,
            applied: None,
        }),
        theme: tokio::sync::Mutex::new(theme),
        update: tokio::sync::Mutex::new(UpdateService::idle()),
        quit_flow: tokio::sync::Mutex::new(dsh_core::quit::QuitFlow::new()),
        onboarding_active: tokio::sync::Mutex::new(false),
        credential_ref,
        renderer_console: tokio::sync::Mutex::new(renderer_diagnostics::RendererDiagnostics::new()),
        background_close_confirmed: tokio::sync::Mutex::new(
            std::fs::metadata(&paths.background_close_confirmed).is_ok(),
        ),
        boot_outcome: tokio::sync::Mutex::new(None),
        boot_notify: tokio::sync::Notify::new(),
    });
    app.manage(state.clone());
    app.manage(TerminalExitPermit::default());
    // Compose the main-thread lifecycle owner independently of admission.
    // GuestViews remains fail-closed until native policy/session qualification;
    // merely installing the owner allocates no child view and grants no IPC.
    let application_origin = state
        .gateway
        .authenticated_url()
        .parse::<url::Url>()
        .ok()
        .map(|url| url.origin().ascii_serialization());
    app.manage(guests::inner::host::install(
        app.handle(),
        application_origin,
    ));

    // Start the Host under the supervisor and bind the gateway to it once ready.
    let startup_state = state.clone();
    let startup_profile = desktop.profile.clone();
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            dsh_core::profile::initialize_desktop_profile(&startup_profile)?;
            dsh_core::profile::migrate_desktop_profile(&startup_profile)?;
            // The runtime payload, pinned Node and adapter were validated before
            // any durable write.
            let ready = startup_state.supervisor.start().await?;
            startup_state.gateway.set_host(&ready.url).await
        }
        .await;
        {
            let mut slot = startup_state.boot_outcome.lock().await;
            *slot = Some(outcome.map_err(|error: dsh_core::error::DshError| error.to_string()));
        }
        startup_state.boot_notify.notify_waiters();
    });
    // Runtime status → `dsh://runtime/state`.
    {
        let mut watch = supervisor.subscribe();
        let app_handle = app_handle.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                let status: RuntimeStatus = watch.borrow_and_update().clone();
                app_handle.emit("dsh://runtime/state", &status).ok();
                if watch.changed().await.is_err() {
                    break;
                }
            }
        });
    }

    // Create an empty view first. The native hook installer initiates the
    // authenticated gateway navigation only after both callbacks register.
    let startup_url = state
        .gateway
        .authenticated_url()
        .parse()
        .map_err(|e: url::ParseError| {
            dsh_core::error::DshError::invalid_argument("url", e.to_string())
        })?;
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External("about:blank".parse().expect("static empty webview URL")),
    )
    .title(dsh_core::paths::PRODUCT_NAME)
    .data_directory(state.paths.user_data.join("webview"))
    .background_color(chrome::chrome_fallback_background(theme))
    .inner_size(1280.0, 820.0)
    .visible(!policy_gate.enabled())
    .decorations(!cfg!(target_os = "windows"))
    .on_navigation(move |url| owned_origin.allows_navigation(url))
    .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
    .on_page_load(|webview, payload| {
        let app = webview.app_handle();
        if webview.label() != "main"
            || !app
                .state::<security::OwnedAppOrigin>()
                .allows_navigation(payload.url())
        {
            return;
        }
        match payload.event() {
            tauri::webview::PageLoadEvent::Started => native_paths::clear_drop(),
            tauri::webview::PageLoadEvent::Finished => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let state = app.state::<Arc<AppState>>();
                    let effective = state.locale.lock().await.snapshot().effective;
                    if let Some(window) = app.get_webview_window("main") {
                        if is_owned_application_window(&window) {
                            chrome::sync_caption_labels(&app, effective);
                        }
                    }
                });
            }
        }
    })
    .initialization_script(init_script(effective))
    .build()
    .map_err(|e| dsh_core::error::DshError::other("window_create", e.to_string()))?;

    wire_window_events(&app_handle, &window);
    power_resume::install(&window)
        .map_err(|error| dsh_core::error::DshError::other("power_resume_hook", error))?;
    update_flow::start_runner(&app_handle);
    build_tray(&app_handle)?;
    build_menu(&app_handle)?;
    match policy_input {
        Ok(None) => renderer_native::install_and_navigate(&window, &app_handle, startup_url)
            .map_err(|error| {
                dsh_core::error::DshError::other("renderer_hooks", error.to_string())
            })?,
        configured => {
            let result = configured.and_then(|policy| {
                security::install_policy_capability(&app_handle)
                    .map_err(|error| error.to_string())?;
                let owner = policy_composition::install(
                    &app_handle,
                    policy.ok_or("missing policy configuration")?,
                )?;
                policy_composition::defer_navigation(
                    app_handle.clone(),
                    window.clone(),
                    startup_url,
                    owner,
                )
            });
            if let Err(error) = result {
                policy_gate.fail();
                tracing::error!(%error, "mandatory policy enforcement initialization failed closed");
                let app = app_handle.clone();
                tauri::async_runtime::spawn(async move {
                    policy_composition::present_initialization_failure(&app, &error).await;
                });
            }
        }
    }
    Ok(())
}

fn wire_window_events(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let app_emit = app.clone();
    let emit_window = move |payload: ShellWindowEvent| {
        app_emit.emit("dsh://shell/window", &payload).ok();
    };
    // Subscribe to the main *webview*, not its parent window: child guests
    // share that window but must not adopt or clear the main document's batch.
    {
        let event_window = window.clone();
        window.on_webview_event(move |event| {
            if !is_owned_application_window(&event_window) {
                return;
            }
            match event {
                tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) => {
                    if policy_composition::require_normal(event_window.app_handle()).is_err() {
                        return;
                    }
                    native_paths::adopt_drop(paths.iter().filter_map(|path| path.to_str()));
                    let script = native_paths::adopt_script(&native_paths::adopted_drop().0);
                    event_window.eval(&script).ok();
                }
                tauri::WebviewEvent::DragDrop(tauri::DragDropEvent::Leave) => {
                    if policy_composition::require_normal(event_window.app_handle()).is_err() {
                        return;
                    }
                    native_paths::clear_drop();
                    event_window.eval(native_paths::adopt_script(&[])).ok();
                }
                _ => {}
            }
        });
    }
    {
        let emit_window = emit_window.clone();
        let event_window = window.clone();
        let handler_app = app.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Focused(true) => {
                // Foreground wakes share the automatic deadline; they are not
                // explicit user/policy requests that bypass the poll backoff.
                update_flow::request_check(update_schedule::CheckTrigger::Normal);
                handler_app
                    .state::<Arc<AppState>>()
                    .policy
                    .trigger(mandatory_update::PolicyScenario::ForegroundOrResume);
                emit_window(ShellWindowEvent {
                    state: ShellWindowState::Focused,
                });
            }
            tauri::WindowEvent::Focused(false) => {
                emit_window(ShellWindowEvent {
                    state: ShellWindowState::Blurred,
                });
            }
            tauri::WindowEvent::CloseRequested { api, .. } => {
                // Close hides to tray; the page and host keep running and the
                // next show presents the same document (never reloaded).
                api.prevent_close();
                let window = event_window.clone();
                let app = handler_app.clone();
                tauri::async_runtime::spawn(async move {
                    hide_to_tray(&app, &window).await;
                });
            }
            _ => {}
        });
    }
}

/// Windows close-to-tray with the first-hide acknowledgement marker
/// (`background-close-confirmed` in the app data dir).
async fn hide_to_tray(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let Some(_attempt) = CLOSE_TO_TRAY.acquire() else {
        return; // One dialog and hide transaction, not a queue of close clicks.
    };
    if let Err(error) = policy_composition::require_normal(app) {
        tracing::warn!(%error, "close-to-tray denied");
        if let Err(delivery) = app.emit("dsh://shell/window-error", &error) {
            tracing::error!(%delivery, "close-to-tray denial event delivery failed");
        }
        return;
    }
    use tauri_plugin_dialog::DialogExt;
    let state = app.state::<Arc<AppState>>();
    let needs_acknowledgement = !*state.background_close_confirmed.lock().await;
    if needs_acknowledgement {
        let messages = state::messages(state.locale.lock().await.snapshot().effective);
        let accepted = native_dialog::answer(|reply| {
            app.dialog()
                .message(messages.background_notice_body)
                .title(messages.about_product)
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                    messages.background_notice_confirm.to_string(),
                    messages.cancel.to_string(),
                ))
                .show(reply);
        })
        .await
        .unwrap_or(false);
        if !accepted {
            return;
        }
    }
    let owned_window = window.clone();
    let hide = policy_composition::on_main_normal(app, move || {
        owned_window
            .hide()
            .map_err(|error| dsh_core::error::DshError::other("window_hide", error.to_string()))
    });
    let commit = tray_close::commit_hidden(
        hide,
        needs_acknowledgement,
        || {
            std::fs::write(&state.paths.background_close_confirmed, "").map_err(|error| {
                dsh_core::error::DshError::io(
                    "record background close acknowledgement",
                    Some(state.paths.background_close_confirmed.display().to_string()),
                    &error,
                )
            })
        },
        || {
            app.emit(
                "dsh://shell/window",
                &ShellWindowEvent {
                    state: ShellWindowState::Hidden,
                },
            )
            .map_err(|error| dsh_core::error::DshError::other("window_event", error.to_string()))
        },
    )
    .await;
    match commit {
        Err(error) => {
            tracing::error!(%error, "close-to-tray hide failed; acknowledgement not recorded");
            if let Err(delivery) = app.emit("dsh://shell/window-error", &error) {
                tracing::error!(%delivery, "close-to-tray failure event delivery failed");
            }
        }
        Ok(commit) => {
            match commit.acknowledgement {
                Some(Ok(())) => *state.background_close_confirmed.lock().await = true,
                Some(Err(error)) => {
                    tracing::error!(%error, "close-to-tray acknowledgement persistence failed")
                }
                None => {}
            }
            if let Err(error) = commit.notification {
                tracing::error!(%error, "close-to-tray hidden event delivery failed");
            }
        }
    }
}

fn build_tray(app: &tauri::AppHandle) -> Result<(), dsh_core::error::DshError> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let messages = state::EN;
    let open = MenuItem::with_id(app, "open", messages.open_application, true, None::<&str>)
        .map_err(|e| dsh_core::error::DshError::other("tray_menu", e.to_string()))?;
    let quit = MenuItem::with_id(app, "quit", messages.quit_application, true, None::<&str>)
        .map_err(|e| dsh_core::error::DshError::other("tray_menu", e.to_string()))?;
    let menu = Menu::with_items(app, &[&open, &quit])
        .map_err(|e| dsh_core::error::DshError::other("tray_menu", e.to_string()))?;
    let builder = TrayIconBuilder::with_id("main")
        .tooltip(dsh_core::paths::PRODUCT_NAME)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                policy_composition::show_owned_main(app);
            }
            "quit" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    quit_flow::request_quit(&app).await.ok();
                });
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                policy_composition::show_owned_main(app);
            }
        });
    builder
        .build(app)
        .map_err(|e| dsh_core::error::DshError::other("tray", e.to_string()))?;
    Ok(())
}

fn build_menu(app: &tauri::AppHandle) -> Result<(), dsh_core::error::DshError> {
    // Popup menu events must be routed even on Windows, where no persistent
    // native menu is installed. Other ids stay with the ordinary handler.
    app.on_menu_event(|app, event| {
        if menu_action::caption_item_index(event.id.as_ref()).is_none() {
            return;
        }
        let id = event.id.as_ref().to_owned();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = app.state::<Arc<AppState>>();
            menu_action::handle_caption_menu_event(&app, &state, &id).await;
        });
    });
    // The released Windows host has no visible application menu; F12 is handled
    // by the injected shell chrome instead of a hidden native menu accelerator.
    if cfg!(target_os = "windows") {
        return Ok(());
    }
    use tauri::menu::{MenuBuilder, SubmenuBuilder};
    let messages = state::EN;
    let error = |e: String| dsh_core::error::DshError::other("menu", e);
    let edit = SubmenuBuilder::new(app, messages.edit)
        .text("undo", messages.undo)
        .text("redo", messages.redo)
        .separator()
        .text("cut", messages.cut)
        .text("copy", messages.copy)
        .text("paste", messages.paste)
        .text("delete", messages.delete)
        .separator()
        .text("select_all", messages.select_all)
        .build()
        .map_err(|e| error(e.to_string()))?;
    let file = SubmenuBuilder::new(app, messages.file_menu)
        .text("close_page_or_window", messages.close_page)
        .build()
        .map_err(|e| error(e.to_string()))?;
    let application = SubmenuBuilder::new(app, messages.application)
        .text("about", messages.about_product)
        .text("check_for_updates", messages.check_updates_menu)
        .separator()
        .text("exit", messages.exit_application)
        .build()
        .map_err(|e| error(e.to_string()))?;
    let dev = SubmenuBuilder::new(app, "Development")
        .text("reload_page", messages.reload_page_menu)
        .text("restart_app_and_host", messages.restart_app_host_menu)
        .build()
        .map_err(|e| error(e.to_string()))?;
    let menu = MenuBuilder::new(app)
        .items(&[&application, &file, &edit, &dev])
        .build()
        .map_err(|e| error(e.to_string()))?;
    app.set_menu(menu).map_err(|e| error(e.to_string()))?;
    app.on_menu_event(|app, event| {
        let id = match event.id.as_ref() {
            "about" => Some(dsh_core::protocol::MenuActionId::About),
            "check_for_updates" => Some(dsh_core::protocol::MenuActionId::CheckForUpdates),
            "exit" => Some(dsh_core::protocol::MenuActionId::Exit),
            "undo" => Some(dsh_core::protocol::MenuActionId::Undo),
            "redo" => Some(dsh_core::protocol::MenuActionId::Redo),
            "cut" => Some(dsh_core::protocol::MenuActionId::Cut),
            "copy" => Some(dsh_core::protocol::MenuActionId::Copy),
            "paste" => Some(dsh_core::protocol::MenuActionId::Paste),
            "delete" => Some(dsh_core::protocol::MenuActionId::Delete),
            "select_all" => Some(dsh_core::protocol::MenuActionId::SelectAll),
            "close_page_or_window" => Some(dsh_core::protocol::MenuActionId::ClosePageOrWindow),
            "reload_page" => Some(dsh_core::protocol::MenuActionId::ReloadPage),
            "restart_app_and_host" => Some(dsh_core::protocol::MenuActionId::RestartAppAndHost),
            _ => None,
        };
        if let Some(id) = id {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<Arc<AppState>>();
                menu_action::dispatch(&app, &state, id).await.ok();
            });
        }
    });
    Ok(())
}

#[cfg(test)]
mod qualification_instance_tests {
    use super::allow_global_instance_activation;
    use std::ffi::OsStr;

    #[test]
    fn ordinary_launch_retains_global_instance_activation() {
        assert!(allow_global_instance_activation(None));
    }

    #[test]
    fn any_explicit_namespace_cannot_activate_an_installed_instance() {
        for namespace in [
            "",
            "invalid",
            "../escape",
            "00000000-0000-0000-0000-000000000000",
            "951d5018-70d7-4159-91d8-99f16e41abfc",
        ] {
            assert!(!allow_global_instance_activation(Some(OsStr::new(
                namespace
            ))));
        }
    }

    #[cfg(windows)]
    #[test]
    fn non_unicode_namespace_cannot_activate_an_installed_instance() {
        use std::os::windows::ffi::OsStringExt;
        let namespace = std::ffi::OsString::from_wide(&[0xd800]);
        assert!(!allow_global_instance_activation(Some(
            namespace.as_os_str()
        )));
    }
}

#[cfg(test)]
mod exit_permit_tests {
    use super::{terminal_stop_admission_refused, TerminalExitPermit};
    use dsh_core::{protocol::QuitReason, quit::QuitFlow};

    #[test]
    fn survivor_consent_cannot_bypass_refused_terminal_admission() {
        for code in ["quit_busy", "quit_superseded", "update_shutdown_busy"] {
            assert!(terminal_stop_admission_refused(&Err(
                dsh_core::DshError::other(code, "refused",)
            )));
        }
        assert!(!terminal_stop_admission_refused(&Ok(())));
        assert!(!terminal_stop_admission_refused(&Err(
            dsh_core::DshError::other("runtime_stop_unresolved", "owned survivor",)
        )));
    }

    #[test]
    fn consent_is_consumed_once_by_the_current_generation() {
        let mut flow = QuitFlow::new();
        let attempt = flow.bypass(QuitReason::User);
        let permit = TerminalExitPermit::default();
        assert_eq!(permit.take_for(&flow), None);
        permit.authorize(attempt);
        assert_eq!(permit.take_for(&flow), Some(attempt));
        assert_eq!(permit.take_for(&flow), None);
    }

    #[test]
    fn stale_consent_cannot_authorize_a_new_exit() {
        let mut flow = QuitFlow::new();
        let previous = flow.bypass(QuitReason::User);
        let permit = TerminalExitPermit::default();
        permit.authorize(previous);
        flow.release(previous);
        let current = flow.bypass(QuitReason::Update);
        assert_eq!(permit.take_for(&flow), None);
        assert!(flow.owns(current));
    }
}

#[cfg(test)]
mod desktop_startup_result_tests {
    use super::desktop_run_result;

    #[test]
    fn startup_refusal_remains_error_when_event_loop_returns_success() {
        let cause = dsh_core::DshError::other("node_missing", "owned missing executable");
        for code in [0, 23] {
            let error = desktop_run_result(code, Some(&cause)).unwrap_err();
            assert!(matches!(error, tauri::Error::Setup(_)));
            assert!(error
                .to_string()
                .contains("node_missing: owned missing executable"));
            assert!(!error.to_string().contains("desktop_exit_nonzero"));
        }
    }

    #[test]
    fn event_loop_success_and_failure_remain_distinct() {
        assert!(desktop_run_result(0, None).is_ok());
        let error = desktop_run_result(23, None).unwrap_err();
        assert!(error.to_string().contains("returned exit code 23"));
    }
}

#[cfg(test)]
mod desktop_node_resolver_tests {
    use super::{desktop_node_target, resolve_desktop_node};
    use std::path::Path;

    #[test]
    fn explicit_node_override_is_preserved_verbatim() {
        let path = Path::new("relative/custom-node");
        assert_eq!(
            resolve_desktop_node(Path::new("unused"), Some(path.as_os_str().to_owned())).unwrap(),
            path
        );
    }

    #[test]
    fn unsupported_node_targets_are_refused() {
        for (os, arch, target) in [
            ("windows", "x86_64", "win-x64"),
            ("windows", "aarch64", "win-arm64"),
            ("macos", "x86_64", "darwin-x64"),
            ("macos", "aarch64", "darwin-arm64"),
            ("linux", "x86_64", "linux-x64"),
            ("linux", "aarch64", "linux-arm64"),
        ] {
            assert_eq!(desktop_node_target(os, arch), Some(target));
        }
        assert_eq!(desktop_node_target("windows", "x86"), None);
        assert_eq!(desktop_node_target("freebsd", "x86_64"), None);
    }

    #[test]
    fn missing_malformed_and_wrong_target_identities_are_refused() {
        let fixture = tempfile::tempdir().unwrap();
        let runtime = fixture.path();
        assert!(resolve_desktop_node(runtime, None).is_err());
        let target = desktop_node_target(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        for identity in [
            "not json".to_owned(),
            "{}".to_owned(),
            r#"{"node":null}"#.to_owned(),
            r#"{"node":[]}"#.to_owned(),
            format!(r#"{{"node":{{"version":22,"target":"{target}"}}}}"#),
            format!(r#"{{"node":{{"version":null,"target":"{target}"}}}}"#),
            format!(r#"{{"node":{{"target":"{target}"}}}}"#),
            format!(r#"{{"node":{{"version":"","target":"{target}"}}}}"#),
            format!(r#"{{"node":{{"version":"   ","target":"{target}"}}}}"#),
            r#"{"node":{"version":"22.20.0"}}"#.to_owned(),
            r#"{"node":{"version":"22.20.0","target":""}}"#.to_owned(),
            r#"{"node":{"version":"22.20.0","target":22}}"#.to_owned(),
            r#"{"node":{"version":"22.20.0","target":null}}"#.to_owned(),
            r#"{"node":{"version":"22.20.0","target":"wrong-target"}}"#.to_owned(),
        ] {
            std::fs::write(runtime.join("runtime-payload.json"), &identity).unwrap();
            assert!(
                resolve_desktop_node(runtime, None).is_err(),
                "accepted {identity}"
            );
        }
        // The override remains independent of even malformed packaged identity.
        assert_eq!(
            resolve_desktop_node(runtime, Some("custom-node".into())).unwrap(),
            Path::new("custom-node")
        );
    }

    #[test]
    fn default_node_uses_bundled_absolute_path_and_recorded_identity() {
        let fixture = tempfile::tempdir().unwrap();
        let runtime = fixture.path().join("selected-runtime");
        std::fs::create_dir_all(&runtime).unwrap();
        let target = desktop_node_target(std::env::consts::OS, std::env::consts::ARCH).unwrap();
        std::fs::write(
            runtime.join("runtime-payload.json"),
            format!(r#"{{"node":{{"version":"22.20.0","target":"{target}"}}}}"#),
        )
        .unwrap();
        let resolved = resolve_desktop_node(&runtime, None).unwrap();
        assert!(resolved.is_absolute());
        #[cfg(target_os = "windows")]
        assert_eq!(resolved, runtime.join("node").join("node.exe"));
        #[cfg(not(target_os = "windows"))]
        assert_eq!(resolved, runtime.join("node").join("bin").join("node"));
    }
}

#[cfg(test)]
mod shell_directory_resolver_tests {
    use super::{select_shell_directory, shell_index_is_regular_file};
    use std::path::{Path, PathBuf};

    fn path(parts: &[&str]) -> PathBuf {
        let mut result = PathBuf::new();
        for part in parts {
            result.push(part);
        }
        result
    }

    #[test]
    fn bundled_ui_beside_the_executable_wins_in_debug_and_release() {
        let bundled = path(&["candidate", "ui"]);
        let development = path(&["checkout", "port", "ui", "dist"]);
        let installed = path(&["installed", "resources", "ui"]);
        // DEBUG: the assembled UI beside the executable outranks the checkout.
        assert_eq!(
            select_shell_directory(
                None,
                Some(bundled.clone()),
                true,
                Some(development),
                Ok(installed.clone()),
            )
            .unwrap(),
            bundled
        );
        // RELEASE: identical preference; no development source is even offered.
        assert_eq!(
            select_shell_directory(None, Some(bundled.clone()), true, None, Ok(installed)).unwrap(),
            bundled
        );
    }

    #[test]
    fn explicit_override_always_wins() {
        let explicit = path(&["explicit", "ui"]);
        for bundled_ui_present in [true, false] {
            assert_eq!(
                select_shell_directory(
                    Some(explicit.clone()),
                    Some(path(&["candidate", "ui"])),
                    bundled_ui_present,
                    Some(path(&["checkout", "port", "ui", "dist"])),
                    Ok(path(&["installed", "resources", "ui"])),
                )
                .unwrap(),
                explicit
            );
        }
    }

    #[test]
    fn absent_bundled_ui_falls_back_to_the_checkout_in_debug() {
        let development = path(&["checkout", "port", "ui", "dist"]);
        assert_eq!(
            select_shell_directory(
                None,
                Some(path(&["candidate", "ui"])),
                false,
                Some(development.clone()),
                Ok(path(&["installed", "resources", "ui"])),
            )
            .unwrap(),
            development
        );
        // Not knowing the executable directory is the same as having no bundle.
        assert_eq!(
            select_shell_directory(
                None,
                None,
                false,
                Some(development.clone()),
                Ok(path(&["installed", "resources", "ui"])),
            )
            .unwrap(),
            development
        );
    }

    #[test]
    fn release_falls_back_to_the_resource_directory_and_keeps_its_error() {
        let installed = path(&["installed", "resources", "ui"]);
        assert_eq!(
            select_shell_directory(
                None,
                Some(path(&["candidate", "ui"])),
                false,
                None,
                Ok(installed.clone()),
            )
            .unwrap(),
            installed
        );
        let error = select_shell_directory(
            None,
            None,
            false,
            None,
            Err(dsh_core::error::DshError::other(
                "resource_dir",
                "unavailable",
            )),
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("resource_dir"),
            "the resource_dir failure must be retained: {error}"
        );
    }

    #[test]
    fn only_a_regular_index_html_counts_as_a_bundled_ui() {
        assert!(!shell_index_is_regular_file(
            &Path::new("directory-that-does-not-exist").join("ui")
        ));
        let fixture = tempfile::tempdir().unwrap();
        // No index.html at all.
        assert!(!shell_index_is_regular_file(fixture.path()));
        // An index.html that is a DIRECTORY is not a regular file.
        std::fs::create_dir(fixture.path().join("index.html")).unwrap();
        assert!(!shell_index_is_regular_file(fixture.path()));
        std::fs::remove_dir(fixture.path().join("index.html")).unwrap();
        // Only a real file counts.
        std::fs::write(fixture.path().join("index.html"), "<html></html>").unwrap();
        assert!(shell_index_is_regular_file(fixture.path()));
    }
}
