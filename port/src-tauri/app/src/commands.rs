//! Every `#[tauri::command]` of `docs/contracts/tauri-contract.md` (34
//! commands, amendments A4/A5/A9 included). No command exists outside the
//! contract and none is a stub; each returns `Result<T, DshError>`.

use std::sync::Arc;

use dsh_core::error::DshError;
use dsh_core::protocol::*;
use dsh_core::settings::validate_key;
use tauri::{Emitter, Manager};
use tokio::sync::watch;

use crate::state::{resolve_startup_locale, AppState, LOCALE_PREFERENCE_KEY, THEME_KEY};

// ---------------------------------------------------------------------------
// Application identity and lifecycle
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn shell_app_info(state: tauri::State<'_, Arc<AppState>>) -> Result<AppInfo, DshError> {
    let locale = state
        .locale
        .try_lock()
        .map(|model| model.snapshot().effective)
        .unwrap_or(LocaleId::En);
    Ok(AppInfo {
        product_name: dsh_core::paths::PRODUCT_NAME.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        protocol_generation: dsh_core::protocol::PROTOCOL_GENERATION,
        runtime_version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS
            .replace("windows", "win32")
            .replace("macos", "darwin"),
        arch: std::env::consts::ARCH
            .replace("x86_64", "x64")
            .replace("aarch64", "arm64"),
        locale,
        credential_ref: state.credential_ref.clone(),
    })
}

#[tauri::command]
pub fn shell_locale_get(state: tauri::State<'_, Arc<AppState>>) -> Result<LocaleState, DshError> {
    state
        .locale
        .try_lock()
        .map(|m| m.snapshot())
        .map_err(|_| DshError::other("locale_busy", "locale model is busy"))
}

#[tauri::command]
pub async fn shell_locale_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    preference: Option<LocaleId>,
) -> Result<LocaleState, DshError> {
    let snapshot = {
        let mut settings = state.settings.lock().await;
        match preference {
            Some(value) => settings.set(
                LOCALE_PREFERENCE_KEY,
                SettingValue::String(value.as_str().to_string()),
            )?,
            // `null` restores automatic selection and writes no preference.
            None => {
                if settings.get(LOCALE_PREFERENCE_KEY)?.is_some() {
                    settings.reset(LOCALE_PREFERENCE_KEY)?;
                }
            }
        }
        let mut model = state.locale.lock().await;
        model.preference = preference;
        model.applied = None;
        let (effective, source) = resolve_startup_locale(preference, &model.languages.clone());
        model.effective = effective;
        model.source = source;
        model.snapshot()
    };
    app.emit("dsh://locale/changed", &snapshot).ok();
    Ok(snapshot)
}

/// `shell_locale_apply` (amendment A4): reports the active locale so the shell
/// can update its dictionary and menu; persists nothing.
#[tauri::command]
pub async fn shell_locale_apply(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    locale: LocaleId,
) -> Result<LocaleState, DshError> {
    let snapshot = {
        let mut model = state.locale.lock().await;
        model.applied = Some(locale);
        model.snapshot()
    };
    app.emit("dsh://locale/changed", &snapshot).ok();
    Ok(snapshot)
}

#[tauri::command]
pub fn shell_window_set_fullscreen(window: tauri::Window, enabled: bool) -> Result<(), DshError> {
    window
        .set_fullscreen(enabled)
        .map_err(|e| DshError::other("window_fullscreen", e.to_string()))
}

/// Dispatches one of the shell-owned Windows caption controls.
#[tauri::command]
pub fn shell_window_chrome_action(
    window: tauri::WebviewWindow,
    action: String,
) -> Result<(), DshError> {
    match action.as_str() {
        "minimize" => window.minimize(),
        "maximize" => {
            if window
                .is_maximized()
                .map_err(|e| DshError::other("window_maximize", e.to_string()))?
            {
                window.unmaximize()
            } else {
                window.maximize()
            }
        }
        "close" => window.close(),
        _ => {
            return Err(DshError::invalid_argument(
                "action",
                "unsupported window action",
            ))
        }
    }
    .map_err(|e| DshError::other("window_chrome", e.to_string()))
}

/// Toggles WebView developer tools for the Windows F12 accelerator.
#[tauri::command]
pub fn shell_window_toggle_devtools(window: tauri::WebviewWindow) {
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
}

#[tauri::command]
pub async fn shell_theme_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    theme: Theme,
) -> Result<(), DshError> {
    {
        let mut settings = state.settings.lock().await;
        let value = match theme {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        };
        settings.set(THEME_KEY, SettingValue::String(value.to_string()))?;
        *state.theme.lock().await = theme;
    }
    // `data-ds-theme-source` on <html> mirrors the native theme (the
    // `nativeThemeSet` marker's contract).
    if let Some(window) = app.get_webview_window("main") {
        let value = match theme {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        };
        window
            .eval(format!(
                "document.documentElement.setAttribute('data-ds-theme-source', '{value}')"
            ))
            .ok();
    }
    Ok(())
}

#[tauri::command]
pub async fn shell_appearance(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Appearance, DshError> {
    let theme = *state.theme.lock().await;
    Ok(state.appearance(theme))
}

/// `shell_menu_action`: route one application-menu action (contract's closed
/// `MenuActionId` union).
#[tauri::command]
pub async fn shell_menu_action(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    id: MenuActionId,
) -> Result<(), DshError> {
    crate::menu_action::dispatch(&app, &state, id).await
}

#[tauri::command]
pub fn shell_open_external(app: tauri::AppHandle, url: String) -> Result<(), DshError> {
    use tauri_plugin_opener::OpenerExt;
    let parsed =
        url::Url::parse(&url).map_err(|e| DshError::invalid_argument("url", e.to_string()))?;
    match parsed.scheme() {
        "http" | "https" | "mailto" => app
            .opener()
            .open_url(url, None::<&str>)
            .map_err(|e| DshError::other("open_external", e.to_string())),
        _ => Err(DshError::invalid_argument(
            "url",
            "only http, https and mailto URLs may be opened externally",
        )),
    }
}

#[tauri::command]
pub async fn shell_clipboard_write(app: tauri::AppHandle, text: String) -> Result<(), DshError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| DshError::other("clipboard_write", e.to_string()))
}

#[tauri::command]
pub async fn shell_clipboard_read(app: tauri::AppHandle) -> Result<ClipboardText, DshError> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let text = app
        .clipboard()
        .read_text()
        .map_err(|e| DshError::other("clipboard_read", e.to_string()))?;
    Ok(ClipboardText { text })
}

#[tauri::command]
pub async fn shell_quit_request(app: tauri::AppHandle) -> Result<(), DshError> {
    crate::quit_flow::request_quit(&app).await
}

#[tauri::command]
pub fn shell_close_window(
    window: tauri::Window,
    revision: String,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), DshError> {
    // The revision correlates and retires the binding dispatch (A9): a stale
    // revision must not close the window.
    let current = state.shortcuts.read_current().revision;
    if revision != current {
        return Ok(());
    }
    window
        .close()
        .map_err(|e| DshError::other("window_close", e.to_string()))
}

/// `shell_onboarding_set_active` (amendment A9): onboarding visibility so the
/// shell can hold or release the workspace.
#[tauri::command]
pub async fn shell_onboarding_set_active(
    state: tauri::State<'_, Arc<AppState>>,
    active: bool,
) -> Result<(), DshError> {
    *state.onboarding_active.lock().await = active;
    Ok(())
}

// ---------------------------------------------------------------------------
// Desktop boot bridge
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn runtime_boot_ready(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<BootPayload, DshError> {
    // Setup publishes this only after the host is ready and the gateway has
    // authenticated and attached it. Wait for that single startup result rather
    // than turning a normal slow launch into a permanent renderer boot failure.
    let outcome = tokio::time::timeout(std::time::Duration::from_secs(120), async {
        loop {
            let notified = state.boot_notify.notified();
            if let Some(outcome) = state.boot_outcome.lock().await.clone() {
                return outcome;
            }
            notified.await;
        }
    })
    .await
    .map_err(|_| {
        DshError::runtime_unavailable("starting", "host startup timed out after 120 seconds")
    })?;
    if let Err(message) = outcome {
        let message = message.replace("[object Object]", "unformatted JavaScript error object");
        let diagnostic = state.supervisor.stderr_tail().await;
        let detail = if diagnostic.trim().is_empty() {
            message
        } else {
            format!("{message}\nHost diagnostic tail:\n{diagnostic}")
        };
        return Err(DshError::runtime_unavailable("failed", detail));
    }
    let ready = state.supervisor.boot_facts().await.ok_or_else(|| {
        DshError::runtime_unavailable(
            "failed",
            "host readiness facts are unavailable after gateway attachment",
        )
    })?;
    let payload = BootPayload {
        injections: ready.injections.ok_or_else(|| {
            DshError::other(
                "boot_injections_missing",
                "the host reported no injection table",
            )
        })?,
        stream_base_url: state.gateway.stream_base_url(),
        authenticated_url: state.gateway.authenticated_url(),
    };
    crate::dev_handoff::write_boot_payload(&payload)?;
    Ok(payload)
}

#[tauri::command]
pub async fn runtime_boot_failed(app: tauri::AppHandle, message: String) -> Result<(), DshError> {
    crate::fatal::report_fatal(&app, &message).await
}

// ---------------------------------------------------------------------------
// Runtime supervision
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn runtime_status(state: tauri::State<'_, Arc<AppState>>) -> Result<RuntimeStatus, DshError> {
    Ok(state.supervisor.status())
}

#[tauri::command]
pub async fn runtime_restart(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<RuntimeStatus, DshError> {
    state.supervisor.stop(false).await?;
    let ready = state.supervisor.start().await?;
    state.gateway.set_host(&ready.url).await?;
    let status = state.supervisor.status();
    app.emit("dsh://runtime/state", &status).ok();
    Ok(status)
}

#[tauri::command]
pub async fn runtime_quit_inspection(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<QuitInspection, DshError> {
    Ok(state.supervisor.quit_inspection().await)
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn settings_get(
    state: tauri::State<'_, Arc<AppState>>,
    key: String,
) -> Result<SettingValue, DshError> {
    validate_key(&key)?;
    let settings = state.settings.lock().await;
    settings
        .get(&key)?
        .cloned()
        .ok_or_else(|| DshError::not_found("setting", key))
}

#[tauri::command]
pub async fn settings_set(
    state: tauri::State<'_, Arc<AppState>>,
    key: String,
    value: SettingValue,
) -> Result<(), DshError> {
    let mut settings = state.settings.lock().await;
    settings.set(&key, value)
}

#[tauri::command]
pub async fn settings_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<SettingsMap, DshError> {
    let settings = state.settings.lock().await;
    Ok(settings.list().clone())
}

#[tauri::command]
pub async fn settings_reset(
    state: tauri::State<'_, Arc<AppState>>,
    key: String,
) -> Result<(), DshError> {
    let mut settings = state.settings.lock().await;
    settings.reset(&key)
}

// ---------------------------------------------------------------------------
// Credentials (OS-backed; metadata only leaves this surface)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn credential_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<CredentialRef>, DshError> {
    let mut credentials = state.credentials.lock().await;
    credentials.list()
}

#[tauri::command]
pub async fn credential_has(
    state: tauri::State<'_, Arc<AppState>>,
    provider: String,
    reference: String,
) -> Result<CredentialPresence, DshError> {
    let credentials = state.credentials.lock().await;
    Ok(CredentialPresence {
        present: credentials.has(&provider, &reference)?,
    })
}

#[tauri::command]
pub async fn credential_store(
    state: tauri::State<'_, Arc<AppState>>,
    provider: String,
    reference: String,
    secret: String,
) -> Result<(), DshError> {
    // The only command that accepts a secret value; it is never logged.
    let mut credentials = state.credentials.lock().await;
    credentials.store(&provider, &reference, &secret)
}

#[tauri::command]
pub async fn credential_delete(
    state: tauri::State<'_, Arc<AppState>>,
    provider: String,
    reference: String,
) -> Result<(), DshError> {
    let mut credentials = state.credentials.lock().await;
    credentials.delete(&provider, &reference)
}

// ---------------------------------------------------------------------------
// Directory picker
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn shell_pick_directory(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<PickedDirectory, DshError> {
    use tauri_plugin_dialog::DialogExt;
    // Concurrent requests share one dialog (upstream `directory-picker.ts`).
    {
        let shared = state.picker.lock().await;
        if let Some(receiver) = shared.as_ref() {
            let mut receiver = receiver.clone();
            drop(shared);
            let mut value = receiver.borrow().clone();
            while value.is_none() {
                if receiver.changed().await.is_err() {
                    break;
                }
                value = receiver.borrow().clone();
            }
            return Ok(PickedDirectory {
                path: value.flatten(),
            });
        }
    }
    let (tx, rx) = watch::channel(None::<Option<String>>);
    *state.picker.lock().await = Some(rx.clone());
    // Restore, show and focus the window first (upstream behaviour).
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let mut builder = app
        .dialog()
        .file()
        .set_title(title.unwrap_or_else(|| "DeepSeek Harness".to_string()));
    if let Some(path) = default_path {
        builder = builder.set_directory(path);
    }
    let picked = builder
        .blocking_pick_folder()
        .and_then(|folder| folder.into_path().ok());
    let result = picked.map(|path| path.to_string_lossy().into_owned());
    tx.send(Some(result.clone())).ok();
    *state.picker.lock().await = None;
    Ok(PickedDirectory { path: result })
}

// ---------------------------------------------------------------------------
// Update presentation
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn update_status(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<DesktopUpdatePresentation, DshError> {
    let update = state.update.lock().await;
    Ok(present_update(&update.state))
}

#[tauri::command]
pub async fn update_open(app: tauri::AppHandle) -> Result<(), DshError> {
    crate::update_flow::open_confirmation(&app).await
}

#[tauri::command]
pub async fn update_check(app: tauri::AppHandle) -> Result<DesktopUpdatePresentation, DshError> {
    crate::update_flow::check(&app).await
}

/// `presentDesktopUpdate` (`update-presentation.ts:44-51`): semantic status
/// without localized copy, diagnostics, or installation controls.
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

/// `desktopUpdateFailureKind` (`update-presentation.ts:8-17`).
pub fn desktop_update_failure_kind(state: &DesktopUpdateState) -> DesktopUpdateFailureKind {
    use DesktopUpdateFailureKind::*;
    if state.failed_operation == Some(DesktopUpdateOperation::Install) {
        if let Some(preparation) = state.preparation_failure {
            return match preparation {
                DesktopUpdatePreparationFailureKind::StopFailed => StopFailed,
                DesktopUpdatePreparationFailureKind::TasksChanged => TasksChanged,
                DesktopUpdatePreparationFailureKind::TasksUnavailable => TasksUnavailable,
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
    match (
        state
            .failed_operation
            .unwrap_or(DesktopUpdateOperation::Install),
        network,
    ) {
        (DesktopUpdateOperation::Check, true) => CheckNetwork,
        (DesktopUpdateOperation::Check, false) => Check,
        (DesktopUpdateOperation::Download, true) => DownloadNetwork,
        (DesktopUpdateOperation::Download, false) => Download,
        (DesktopUpdateOperation::Install, true) => InstallNetwork,
        (DesktopUpdateOperation::Install, false) => Install,
    }
}

// ---------------------------------------------------------------------------
// Shortcut configuration (K1–K3)
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn shell_shortcuts_get(
    state: tauri::State<'_, Arc<AppState>>,
    definitions: Vec<ShortcutDefinition>,
) -> Result<ShortcutConfigSnapshot, DshError> {
    let value = serde_json::to_value(&definitions)
        .map_err(|e| DshError::invalid_argument("definitions", e.to_string()))?;
    let parsed = dsh_core::shortcuts::parse_shortcut_definitions(&value)?;
    state.shortcuts.set_definitions(Some(parsed));
    Ok(state.shortcuts.read_current())
}

#[tauri::command]
pub async fn shell_shortcuts_edit(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    edit: serde_json::Value,
    revision: String,
) -> Result<ShortcutSaveResult, DshError> {
    let edit = dsh_core::shortcuts::parse_shortcut_edit(&edit)?;
    let result = state.shortcuts.edit(&edit, &revision);
    if result.status == ShortcutSaveStatus::Saved {
        // K2: publish accepted bindings after the validated, serialised write.
        let bindings = state.shortcuts.accepted_bindings();
        app.emit(
            "dsh://shortcuts/changed",
            &ShortcutsChangedEvent { bindings },
        )
        .ok();
    }
    Ok(result)
}

#[tauri::command]
pub async fn shell_shortcuts_recording(
    app: tauri::AppHandle,
    active: bool,
) -> Result<(), DshError> {
    app.emit(
        "dsh://shortcuts/recording",
        &ShortcutsRecordingEvent { recording: active },
    )
    .map_err(|e| DshError::other("shortcuts_recording", e.to_string()))
}
