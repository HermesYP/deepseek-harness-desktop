//! Every `#[tauri::command]` of `docs/contracts/tauri-contract.md` (34
//! commands, amendments A4/A5/A9 included). No command exists outside the
//! contract and none is a stub; each returns `Result<T, DshError>`.

use std::sync::Arc;

use dsh_core::error::DshError;
use dsh_core::protocol::*;
use dsh_core::settings::validate_key;
use tauri::{Emitter, Manager};

use crate::native_paths::HostPaths;
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
    crate::policy_composition::require_state(&state)?;
    let snapshot = {
        let mut settings = state.settings.lock().await;
        let mut model = state.locale.lock().await;
        crate::policy_composition::require_state(&state)?;
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
        model.preference = preference;
        model.applied = None;
        let (effective, source) = resolve_startup_locale(preference, &model.languages.clone());
        model.effective = effective;
        model.source = source;
        model.snapshot()
    };
    crate::policy_composition::require_state(&state)?;
    app.emit("dsh://locale/changed", &snapshot).ok();
    crate::chrome::sync_caption_labels(&app, snapshot.effective);
    Ok(snapshot)
}

/// `shell_locale_apply` (amendment A4): reports the active locale so the shell
/// can update its dictionary and menu; persists nothing.
///
/// The native side follows the active locale in the same request: the caption
/// menus render from the same dictionary the dialogs use
/// (`preload-windows.ts:44` calls `menu.update()` inside the palette sender and
/// `main.ts:711-721` rebuilds the application menu on a locale change), so a
/// locale switch that only updated the page would leave the shell half
/// translated.
#[tauri::command]
pub async fn shell_locale_apply(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    locale: LocaleId,
) -> Result<LocaleState, DshError> {
    let snapshot = {
        let mut model = state.locale.lock().await;
        crate::policy_composition::require_state(&state)?;
        model.applied = Some(locale);
        model.snapshot()
    };
    crate::policy_composition::require_state(&state)?;
    app.emit("dsh://locale/changed", &snapshot).ok();
    crate::chrome::sync_caption_labels(&app, snapshot.effective);
    Ok(snapshot)
}

#[tauri::command]
pub fn shell_window_set_fullscreen(
    app: tauri::AppHandle,
    window: tauri::Window,
    enabled: bool,
) -> Result<(), DshError> {
    crate::policy_composition::require_normal(&app)?;
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
    crate::policy_composition::require_normal(window.app_handle())?;
    match action.as_str() {
        "drag" => window.start_dragging(),
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

/// The normal bridge owns resizing; core plugin mutation grants are deliberately absent.
#[tauri::command]
pub fn shell_window_resize_dragging(
    window: tauri::WebviewWindow,
    direction: String,
) -> Result<(), DshError> {
    crate::policy_composition::require_normal(window.app_handle())?;
    let direction = serde_json::from_value(serde_json::Value::String(direction))
        .map_err(|error| DshError::invalid_argument("direction", error.to_string()))?;
    window
        .as_ref()
        .window()
        .start_resize_dragging(direction)
        .map_err(|error| DshError::other("window_resize", error.to_string()))
}

/// Toggles WebView developer tools for the Windows F12 accelerator.
#[tauri::command]
pub fn shell_window_toggle_devtools(window: tauri::WebviewWindow) -> Result<(), DshError> {
    crate::policy_composition::require_normal(window.app_handle())?;
    if window.is_devtools_open() {
        window.close_devtools();
    } else {
        window.open_devtools();
    }
    Ok(())
}

#[tauri::command]
pub async fn shell_theme_set(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    theme: Theme,
) -> Result<(), DshError> {
    crate::policy_composition::require_state(&state)?;
    {
        let mut settings = state.settings.lock().await;
        let mut current_theme = state.theme.lock().await;
        crate::policy_composition::require_state(&state)?;
        let value = match theme {
            Theme::System => "system",
            Theme::Light => "light",
            Theme::Dark => "dark",
        };
        settings.set(THEME_KEY, SettingValue::String(value.to_string()))?;
        *current_theme = theme;
    }
    // `data-ds-theme-source` on <html> mirrors the native theme (the
    // `nativeThemeSet` marker's contract).
    let handle = app.clone();
    crate::policy_composition::on_main_normal(&app, move || {
        if let Some(window) = handle.get_webview_window("main") {
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
    })
    .await
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
    if id != MenuActionId::Exit {
        crate::policy_composition::require_normal(&app)?;
    }
    crate::menu_action::dispatch(&app, &state, id).await
}

#[tauri::command]
pub fn shell_open_external(app: tauri::AppHandle, url: String) -> Result<(), DshError> {
    crate::policy_composition::require_normal(&app)?;
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
    crate::policy_composition::require_normal(&app)?;
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard()
        .write_text(text)
        .map_err(|e| DshError::other("clipboard_write", e.to_string()))
}

#[tauri::command]
pub async fn shell_clipboard_read(app: tauri::AppHandle) -> Result<ClipboardText, DshError> {
    crate::policy_composition::require_normal(&app)?;
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
    crate::policy_composition::require_state(&state)?;
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
///
/// Mirrors `main.ts:730-740`: the signal carries the 960-wide onboarding
/// minimum while showing and restores the 520 workspace minimum when it ends.
/// The window is re-configured here rather than by the caller so the state flag
/// and the geometry cannot disagree — the reference has the same property,
/// where the IPC handler is the only writer of both.
#[tauri::command]
pub async fn shell_onboarding_set_active(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<AppState>>,
    active: bool,
) -> Result<(), DshError> {
    let mut onboarding = state.onboarding_active.lock().await;
    crate::policy_composition::require_state(&state)?;
    *onboarding = active;
    apply_onboarding_size(&window, active);
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
    crate::policy_composition::require_state(&state)?;
    crate::dev_handoff::write_boot_payload(&payload)?;
    Ok(payload)
}

#[tauri::command]
pub async fn runtime_boot_failed(app: tauri::AppHandle, message: String) -> Result<(), DshError> {
    crate::policy_composition::require_normal(&app)?;
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
    crate::policy_composition::require_state(&state)?;
    let status = state
        .supervisor
        .restart_if(|| crate::policy_composition::require_state(&state))
        .await?;
    let url = status.url.as_deref().ok_or_else(|| {
        DshError::runtime_unavailable("failed", "restarted host has no authenticated URL")
    })?;
    state.gateway.set_host(url).await?;
    crate::policy_composition::require_state(&state)?;
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
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    key: String,
    value: SettingValue,
) -> Result<(), DshError> {
    crate::policy_composition::require_state(&state)?;
    let mut settings = state.settings.lock().await;
    crate::policy_composition::require_state(&state)?;
    settings.set(&key, value)?;
    drop(settings);
    if key == "updates.channel" {
        crate::update_flow::invalidate_for_channel_change(&app).await;
    }
    Ok(())
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
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<AppState>>,
    key: String,
) -> Result<(), DshError> {
    crate::policy_composition::require_state(&state)?;
    let mut settings = state.settings.lock().await;
    crate::policy_composition::require_state(&state)?;
    settings.reset(&key)?;
    drop(settings);
    if key == "updates.channel" {
        crate::update_flow::invalidate_for_channel_change(&app).await;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Credentials (OS-backed; metadata only leaves this surface)
//
// Renderer boundary: the shell owns one credential identity end to end — the
// gateway's browser-session signing secret — and this surface neither exposes
// it nor lets a renderer overwrite or delete it. `credential_list` filters it
// out, `credential_has` answers a documented `false` without consulting the OS
// store, and `credential_store`/`credential_delete` reject it outright. Every
// other provider/reference pair keeps the full CRUD behaviour. The gateway's
// own read/write path (`dsh_gateway::auth::load_or_create_secret`) does not go
// through these commands, so internal authentication is unaffected.
// ---------------------------------------------------------------------------

/// The rejection returned for a renderer-originated mutation of a shell-owned
/// identity. The message is constant: the caller's input is never echoed.
fn reserved_credential_error() -> DshError {
    DshError::other(
        "credential_reserved",
        "That credential identity belongs to the desktop shell and cannot be written or deleted through the renderer bridge.",
    )
}

/// The renderer-visible projection of the credential index.
fn visible_credentials(rows: Vec<CredentialRef>) -> Vec<CredentialRef> {
    rows.into_iter()
        .filter(|row| {
            !crate::credential_backend::is_shell_reserved_credential(&row.provider, &row.reference)
        })
        .collect()
}

/// Whether the renderer bridge may ask the OS store about this identity.
///
/// A reserved identity answers `false` (documented absence) instead of an
/// error: an error would let a caller probe the shell's session state, and
/// "not visible here" is the truthful answer for the renderer boundary.
fn renderer_may_probe_credential(provider: &str, reference: &str) -> bool {
    !crate::credential_backend::is_shell_reserved_credential(provider, reference)
}

#[tauri::command]
pub async fn credential_list(
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<Vec<CredentialRef>, DshError> {
    let mut credentials = state.credentials.lock().await;
    Ok(visible_credentials(credentials.list()?))
}

#[tauri::command]
pub async fn credential_has(
    state: tauri::State<'_, Arc<AppState>>,
    provider: String,
    reference: String,
) -> Result<CredentialPresence, DshError> {
    if !renderer_may_probe_credential(&provider, &reference) {
        return Ok(CredentialPresence { present: false });
    }
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
    // The only command that accepts a secret value; it is never logged. The
    // reserved-identity check runs first and unconditionally, before any OS
    // credential call or index write.
    if !renderer_may_probe_credential(&provider, &reference) {
        return Err(reserved_credential_error());
    }
    crate::policy_composition::require_state(&state)?;
    let mut credentials = state.credentials.lock().await;
    crate::policy_composition::require_state(&state)?;
    credentials.store(&provider, &reference, &secret)
}

#[tauri::command]
pub async fn credential_delete(
    state: tauri::State<'_, Arc<AppState>>,
    provider: String,
    reference: String,
) -> Result<(), DshError> {
    // Same unconditional boundary as `credential_store`: a renderer can never
    // retire the shell's session-signing secret.
    if !renderer_may_probe_credential(&provider, &reference) {
        return Err(reserved_credential_error());
    }
    crate::policy_composition::require_state(&state)?;
    let mut credentials = state.credentials.lock().await;
    crate::policy_composition::require_state(&state)?;
    credentials.delete(&provider, &reference)
}

// ---------------------------------------------------------------------------
// Directory picker
// ---------------------------------------------------------------------------

/// `shell_pick_directory`: one native folder dialog owned by the shell.
///
/// Upstream invariant (`directory-picker.ts:11-29`): concurrent requests from
/// the owned renderer **share** the one open dialog and resolve with its result;
/// the promise is dropped when it settles, so a later request opens a fresh
/// dialog. Cancellation resolves `null` and stays retryable.
///
/// [`crate::directory_picker`] owns the single-ownership decision and explains
/// the generation protocol that replaced the previous `watch`-slot race.
#[tauri::command]
pub async fn shell_pick_directory(
    app: tauri::AppHandle,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<PickedDirectory, DshError> {
    crate::policy_composition::require_normal(&app)?;
    match crate::directory_picker::claim() {
        crate::directory_picker::DialogDecision::Join {
            generation,
            mut result,
        } => {
            // A joiner reads the dialog it joined. `None` means "still open";
            // `Some(None)` is that dialog's cancellation. The generation is
            // carried so a joiner can prove it is reporting the dialog it
            // claimed rather than a later one that replaced it.
            tracing::debug!(
                picker_generation = generation,
                picker_role = "joined",
                "directory picker request joined the open dialog"
            );
            let mut observed = result.borrow().clone();
            while observed.is_none() {
                if result.changed().await.is_err() {
                    // The owning dialog was retired without a result (window
                    // gone / owner dropped). Report a retryable cancellation
                    // rather than blocking forever.
                    tracing::debug!(
                        picker_generation = generation,
                        "directory picker ownership ended before a result"
                    );
                    break;
                }
                observed = result.borrow().clone();
            }
            crate::policy_composition::require_normal(&app)?;
            Ok(PickedDirectory {
                path: observed.flatten(),
            })
        }
        crate::directory_picker::DialogDecision::Own { generation, .. } => {
            tracing::debug!(
                picker_generation = generation,
                picker_role = "owner",
                "directory picker request opened the native dialog"
            );
            open_directory_dialog(app, generation, title, default_path).await
        }
    }
}

/// Open the one owned dialog for `generation` and publish its result.
///
/// The queued setup/native callback owns retirement. A dropped request cancels
/// queued setup but cannot retire a still-open native dialog and permit stacking.
/// Failed/dropped callbacks release the slot and wake joiners.
async fn open_directory_dialog(
    app: tauri::AppHandle,
    generation: u64,
    title: Option<String>,
    default_path: Option<String>,
) -> Result<PickedDirectory, DshError> {
    use tauri_plugin_dialog::DialogExt;

    let lease = crate::directory_picker::DialogLease::retain(generation);
    let (pending, _cancel_pending) = crate::directory_picker::PendingDispatch::new();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let ui_app = app.clone();
    crate::policy_composition::on_main_normal(&app, move || {
        let fresh = || {
            if pending.is_cancelled() {
                return Err(DshError::other(
                    "directory_pick_cancelled",
                    "the directory request ended before native setup",
                ));
            }
            crate::policy_composition::require_normal(&ui_app)
        };
        fresh()?;
        // Restore/show/focus on the owning UI turn, with a fresh check before
        // each effect. Never revive main after policy revocation or cancellation.
        let window = ui_app.get_webview_window("main").ok_or_else(|| {
            DshError::other("directory_pick_cancelled", "the owned window is gone")
        })?;
        let setup_error =
            |error: tauri::Error| DshError::other("directory_pick_setup", error.to_string());
        fresh()?;
        window.unminimize().map_err(setup_error)?;
        fresh()?;
        window.show().map_err(setup_error)?;
        fresh()?;
        window.set_focus().map_err(setup_error)?;
        let mut builder = ui_app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title(title.unwrap_or_else(|| dsh_core::paths::PRODUCT_NAME.to_string()));
        if let Some(path) = default_path {
            builder = builder.set_directory(path);
        }
        fresh()?;
        let callback_app = ui_app.clone();
        // Callback API: no Tokio worker is blocked while the user considers the
        // picker. The callback owns retirement even if this IPC future is dropped.
        builder.pick_folder(move |picked| {
            let _lease = lease;
            let outcome = crate::policy_composition::require_normal(&callback_app).and_then(|_| {
                let picked = if callback_app.get_webview_window("main").is_some() {
                    picked
                } else {
                    None
                };
                let path = picked
                    .and_then(|folder| folder.into_path().ok())
                    .map(|path| path.to_string_lossy().into_owned())
                    .filter(|path| crate::native_paths::is_absolute_host_path(path));
                if !crate::directory_picker::publish(generation, path.clone()) {
                    return Err(DshError::other(
                        "directory_pick_superseded",
                        "the directory dialog was superseded before it settled",
                    ));
                }
                Ok(PickedDirectory { path })
            });
            let _ = sender.send(outcome);
        });
        Ok(())
    })
    .await?;
    let outcome = receiver.await.map_err(|_| {
        DshError::other(
            "directory_pick_cancelled",
            "the native directory callback ended without a result",
        )
    })?;
    crate::policy_composition::require_normal(&app)?;
    outcome
}

// ---------------------------------------------------------------------------
// Native file paths (Windows drag/drop handoff)
// ---------------------------------------------------------------------------

/// `shell_host_paths`: the paths the page may resolve through
/// `__DSH_HOST_PATHS__`.
///
/// Returns the adopted batch plus whether the page has already imported it. The
/// page calls this after a `dsh-host-paths` document event (a native OS drop the
/// shell observed) so it can feed the real, absolute paths into the composer's
/// ordinary file intake, exactly as the reference feeds a dropped `File`'s
/// `webUtils.getPathForFile` result. A batch the page has consumed is not
/// re-imported: without that, one drop would attach twice.
#[tauri::command]
pub async fn shell_host_paths(app: tauri::AppHandle) -> Result<HostPaths, DshError> {
    crate::policy_composition::require_normal(&app)?;
    let (paths, consumed) = crate::native_paths::adopted_drop();
    Ok(HostPaths { paths, consumed })
}

/// `shell_host_paths_consume`: report that the page imported the pending drop.
#[tauri::command]
pub async fn shell_host_paths_consume(app: tauri::AppHandle) -> Result<(), DshError> {
    crate::policy_composition::require_normal(&app)?;
    crate::native_paths::consume_drop();
    Ok(())
}

// ---------------------------------------------------------------------------
// Caption menus (Windows)
// ---------------------------------------------------------------------------

/// `shell_caption_menu`: pop one caption menu at the reported client point.
///
/// Upstream `main.ts:957-988` validates the request (menu name, finite
/// non-negative coordinates within 100 000, reported in *CSS* pixels and scaled
/// by the webview zoom factor before the native popup), builds the same items,
/// and resolves when the popup closes. Only the owned main view may call it:
/// [`crate::security::authorized_invoke`] enforces that, and this command
/// additionally rejects a menu name outside the closed set.
#[tauri::command]
pub async fn shell_caption_menu(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    name: String,
    x: f64,
    y: f64,
    state: tauri::State<'_, Arc<AppState>>,
) -> Result<(), DshError> {
    if !(name == "application" || name == "edit") {
        return Err(DshError::invalid_argument(
            "name",
            "unsupported caption menu",
        ));
    }
    if !x.is_finite() || !y.is_finite() || x < 0.0 || y < 0.0 || x > 100_000.0 || y > 100_000.0 {
        return Err(DshError::invalid_argument(
            "position",
            "caption menu coordinates must be finite and within the window",
        ));
    }
    crate::menu_action::show_caption_menu(&app, &state, &window, &name, x, y).await
}
// ---------------------------------------------------------------------------
// Onboarding presentation (Windows minimum sizing)
// ---------------------------------------------------------------------------

/// Minimum inner size of the main window while onboarding is showing
/// (`main.ts:735` — `setMinimumSize(active ? 960 : 520, 600)`).
pub const ONBOARDING_MIN_WIDTH: f64 = 960.0;
/// Minimum inner size outside onboarding.
pub const WORKSPACE_MIN_WIDTH: f64 = 520.0;
/// Minimum inner height, unchanged by onboarding.
pub const WINDOW_MIN_HEIGHT: f64 = 600.0;

/// Apply the onboarding minimum-size rule to the main window.
///
/// The reference raises the *minimum* width to 960 while onboarding shows and
/// widens a narrower window once; releasing onboarding restores 520 without
/// shrinking the window back, so whatever the user arranged is kept.
pub fn apply_onboarding_size(window: &tauri::WebviewWindow, active: bool) {
    let minimum_width = if active {
        ONBOARDING_MIN_WIDTH
    } else {
        WORKSPACE_MIN_WIDTH
    };
    let _ = window.set_min_size(Some(tauri::LogicalSize::new(
        minimum_width,
        WINDOW_MIN_HEIGHT,
    )));
    if !active {
        return;
    }
    let Ok(size) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let width = size.width as f64 / scale;
    let height = size.height as f64 / scale;
    if width < ONBOARDING_MIN_WIDTH {
        let _ = window.set_size(tauri::LogicalSize::new(ONBOARDING_MIN_WIDTH, height));
    }
}

// ---------------------------------------------------------------------------
// Shortcut configuration (K1–K3)
// ---------------------------------------------------------------------------

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
    crate::policy_composition::require_state(&state)?;
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
    crate::policy_composition::require_state(&state)?;
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
    crate::policy_composition::require_normal(&app)?;
    app.emit(
        "dsh://shortcuts/recording",
        &ShortcutsRecordingEvent { recording: active },
    )
    .map_err(|e| DshError::other("shortcuts_recording", e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn failed(operation: DesktopUpdateOperation, message: &str) -> DesktopUpdateState {
        DesktopUpdateState {
            phase: DesktopUpdatePhase::Error,
            version: None,
            message: Some(message.to_string()),
            technical_details: None,
            percent: None,
            failed_operation: Some(operation),
            preparation_failure: None,
        }
    }

    /// The marker list is what selects the localized copy, so it is asserted on
    /// the function that actually classifies rather than on a helper.
    #[test]
    fn network_failures_are_classified_for_localized_copy() {
        use DesktopUpdateFailureKind::*;
        for marker in [
            "ETIMEDOUT",
            "ERR_CONNECTION_CLOSED",
            "ERR_CONNECTION_RESET",
            "ERR_INTERNET_DISCONNECTED",
            "ERR_NAME_NOT_RESOLVED",
        ] {
            for operation in [
                DesktopUpdateOperation::Check,
                DesktopUpdateOperation::Download,
                DesktopUpdateOperation::Install,
            ] {
                let kind = desktop_update_failure_kind(&failed(
                    operation,
                    &format!("update feed request failed: {marker}"),
                ));
                assert!(
                    matches!(kind, CheckNetwork | DownloadNetwork | InstallNetwork),
                    "{marker} on {operation:?} classified as {kind:?}"
                );
            }
        }
        // A verification failure is not a transport problem and must not be
        // reported as one.
        assert_eq!(
            desktop_update_failure_kind(&failed(
                DesktopUpdateOperation::Download,
                "the downloaded update failed SHA-256 verification"
            )),
            Download
        );
        assert_eq!(
            desktop_update_failure_kind(&failed(
                DesktopUpdateOperation::Check,
                "signature verification failed"
            )),
            Check
        );
    }

    /// An install-preparation failure outranks the message-based classification.
    #[test]
    fn install_preparation_failures_outrank_network_markers() {
        use DesktopUpdateFailureKind::*;
        for (preparation, expected) in [
            (DesktopUpdatePreparationFailureKind::StopFailed, StopFailed),
            (
                DesktopUpdatePreparationFailureKind::TasksChanged,
                TasksChanged,
            ),
            (
                DesktopUpdatePreparationFailureKind::TasksUnavailable,
                TasksUnavailable,
            ),
        ] {
            let mut state = failed(DesktopUpdateOperation::Install, "ETIMEDOUT");
            state.preparation_failure = Some(preparation);
            assert_eq!(desktop_update_failure_kind(&state), expected);
        }
    }

    fn reference_row(provider: &str, reference: &str) -> CredentialRef {
        CredentialRef {
            provider: provider.to_string(),
            reference: reference.to_string(),
            has_secret: true,
            updated_at: "2026-01-01T00:00:00Z".to_string(),
        }
    }

    /// The shell's own signing identity is neither listed nor probeable, while
    /// ordinary provider credentials keep the full CRUD surface.
    #[test]
    fn shell_owned_identity_is_outside_the_renderer_credential_boundary() {
        let (reserved_provider, reserved_reference) = (
            dsh_gateway::auth::AUTH_PROVIDER,
            dsh_gateway::auth::AUTH_REFERENCE,
        );

        assert!(!renderer_may_probe_credential(
            reserved_provider,
            reserved_reference
        ));
        for (provider, reference) in [
            ("openai", "default"),
            ("anthropic", reserved_reference),
            (reserved_provider, "onboarding"),
            ("", ""),
        ] {
            assert!(
                renderer_may_probe_credential(provider, reference),
                "{provider}/{reference} must stay on the general provider surface"
            );
        }

        let visible = visible_credentials(vec![
            reference_row("openai", "default"),
            reference_row(reserved_provider, reserved_reference),
            reference_row("anthropic", "work"),
        ]);
        let rows: Vec<(&str, &str)> = visible
            .iter()
            .map(|row| (row.provider.as_str(), row.reference.as_str()))
            .collect();
        assert_eq!(rows, [("openai", "default"), ("anthropic", "work")]);
    }

    /// Both mutations of the reserved identity fail with the same stable code,
    /// and the message never echoes the caller's input.
    #[test]
    fn reserved_identity_mutations_are_rejected_with_a_stable_code() {
        let error = reserved_credential_error();
        match &error {
            DshError::Other { code, message } => {
                assert_eq!(code, "credential_reserved");
                assert!(!message.contains(dsh_gateway::auth::AUTH_PROVIDER));
                assert!(!message.contains(dsh_gateway::auth::AUTH_REFERENCE));
            }
            other => panic!("unexpected error shape: {other:?}"),
        }
    }

    #[cfg(windows)]
    #[test]
    fn reserved_windows_case_aliases_are_hidden_and_not_probeable() {
        let aliases = [
            ("Client-Connection", "browser-session"),
            ("client-connection", "Browser-Session"),
            ("CLIENT-CONNECTION", "BROWSER-SESSION"),
        ];
        let mut indexed = vec![reference_row("openai", "default")];
        for (provider, reference) in aliases {
            assert!(!renderer_may_probe_credential(provider, reference));
            indexed.push(reference_row(provider, reference));
        }
        let visible = visible_credentials(indexed);
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].provider, "openai");
        assert_eq!(visible[0].reference, "default");
    }
}
