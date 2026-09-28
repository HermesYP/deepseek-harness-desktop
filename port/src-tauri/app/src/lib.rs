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

use dsh_core::credentials::{CredentialStore, KeyringBackend};
use dsh_core::paths::{resolve_app_paths, resolve_desktop_paths};
use dsh_core::protocol::{LocaleId, RuntimeStatus, ShellWindowEvent, ShellWindowState, Theme};
use dsh_core::settings::SettingsStore;
use dsh_core::shortcuts::{ShortcutPersistence, ShortcutRuntime};
use dsh_runtime::supervisor::{SpawnPlan, Supervisor};
use tauri::{Emitter, Manager};

mod commands;
mod dev_handoff;
mod fatal;
mod menu_action;
mod quit_flow;
mod state;
mod update_flow;

use state::{
    shortcut_platform, AppState, LocaleModel, UpdateService, CREDENTIAL_PROVIDER_KEY,
    CREDENTIAL_REFERENCE_KEY, LOCALE_PREFERENCE_KEY, THEME_KEY,
};

/// Injected Windows controls replace the native caption on the frameless window.
const WINDOWS_CHROME_SCRIPT: &str = r#"
    if (!document.getElementById('dsh-native-chrome')) {
      const style = document.createElement('style');
      style.textContent = `
        body { box-sizing: border-box !important; padding-top: 40px !important;
          background: var(--dsh-caption-fill, #f9fafb); }
        #root { height: 100% !important; box-sizing: border-box !important; }
        #dsh-native-chrome { position: fixed; inset: 0 0 auto 0; height: 40px; z-index: 2147483647;
          display: flex; justify-content: flex-end; pointer-events: none; color: var(--dsh-caption-symbol, #0f1115);
          background: var(--dsh-caption-fill, #f9fafb); font-family: system-ui, sans-serif; }
        #dsh-native-chrome .dsh-drag { flex: 1; min-width: 0; pointer-events: auto; }
        #dsh-native-chrome .dsh-buttons { display: flex; width: 138px; height: 40px; pointer-events: auto; }
        #dsh-native-chrome button { width: 46px; height: 40px; padding: 0; border: 0; border-radius: 0;
          color: inherit; background: transparent; display: grid; place-items: center; cursor: default; }
        #dsh-native-chrome button:hover { background: color-mix(in srgb, currentColor 12%, transparent); }
        #dsh-native-chrome button[data-action="close"]:hover { background: #c42b1c; color: white; }
        #dsh-native-chrome svg { width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 1; }
        #dsh-native-chrome .dsh-grip { position: fixed; pointer-events: auto; z-index: 2; background: transparent; }
        #dsh-native-chrome .dsh-n, #dsh-native-chrome .dsh-s { left: 10px; right: 10px; height: 6px; cursor: ns-resize; }
        #dsh-native-chrome .dsh-n { top: 0; } #dsh-native-chrome .dsh-s { bottom: 0; }
        #dsh-native-chrome .dsh-e, #dsh-native-chrome .dsh-w { top: 10px; bottom: 10px; width: 6px; cursor: ew-resize; }
        #dsh-native-chrome .dsh-e { right: 0; } #dsh-native-chrome .dsh-w { left: 0; }
        #dsh-native-chrome .dsh-ne, #dsh-native-chrome .dsh-nw, #dsh-native-chrome .dsh-se, #dsh-native-chrome .dsh-sw { width: 12px; height: 12px; }
        #dsh-native-chrome .dsh-ne { top: 0; right: 0; cursor: nesw-resize; }
        #dsh-native-chrome .dsh-nw { top: 0; left: 0; cursor: nwse-resize; }
        #dsh-native-chrome .dsh-se { bottom: 0; right: 0; cursor: nwse-resize; }
        #dsh-native-chrome .dsh-sw { bottom: 0; left: 0; cursor: nesw-resize; }
      `;
      document.documentElement.appendChild(style);
      const chrome = document.createElement('div');
      chrome.id = 'dsh-native-chrome';
      chrome.innerHTML = '<div class="dsh-drag" data-tauri-drag-region></div><div class="dsh-buttons">'
        + '<button type="button" aria-label="Minimize" title="Minimize" data-action="minimize"><svg viewBox="0 0 10 10"><path d="M1 7.5h8"/></svg></button>'
        + '<button type="button" aria-label="Maximize" title="Maximize" data-action="maximize"><svg viewBox="0 0 10 10"><rect x="1.5" y="1.5" width="7" height="7"/></svg></button>'
        + '<button type="button" aria-label="Close" title="Close" data-action="close"><svg viewBox="0 0 10 10"><path d="M2 2l6 6M8 2L2 8"/></svg></button></div>'
        + '<div class="dsh-grip dsh-n" data-resize="North"></div><div class="dsh-grip dsh-s" data-resize="South"></div>'
        + '<div class="dsh-grip dsh-e" data-resize="East"></div><div class="dsh-grip dsh-w" data-resize="West"></div>'
        + '<div class="dsh-grip dsh-ne" data-resize="NorthEast"></div><div class="dsh-grip dsh-nw" data-resize="NorthWest"></div>'
        + '<div class="dsh-grip dsh-se" data-resize="SouthEast"></div><div class="dsh-grip dsh-sw" data-resize="SouthWest"></div>';
      document.documentElement.appendChild(chrome);
      chrome.addEventListener('pointerdown', event => {
        const direction = event.target.closest('[data-resize]')?.dataset.resize;
        if (direction) {
          event.preventDefault();
          window.__TAURI_INTERNALS__.invoke('plugin:window|start_resize_dragging', { direction }).catch(() => {});
        }
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
      const fallbackDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      chrome.style.setProperty('--dsh-caption-fill', fallbackDark ? '#1b1b1c' : '#f9fafb');
      chrome.style.setProperty('--dsh-caption-symbol', fallbackDark ? '#f9fafb' : '#0f1115');
      const installCaptionThemeSync = () => {
        const probe = document.createElement('span');
        probe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;background-color:var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, Canvas));color:var(--dsw-alias-label-primary,#0f1115)';
        document.body.appendChild(probe);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) return;
        const rgba = color => {
          context.clearRect(0, 0, 1, 1);
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
          return `rgba(${red}, ${green}, ${blue}, ${alpha / 255})`;
        };
        let previous = '';
        const send = () => {
          const style = getComputedStyle(probe);
          const fill = rgba(style.backgroundColor);
          const symbol = rgba(style.color);
          const values = JSON.stringify([document.documentElement.lang, fill, symbol]);
          if (values === previous) return;
          previous = values;
          chrome.style.setProperty('--dsh-caption-fill', fill);
          chrome.style.setProperty('--dsh-caption-symbol', symbol);
        };
        const observer = new MutationObserver(send);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] });
        observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme', 'style'] });
        observer.observe(document.head, { childList: true, subtree: true, characterData: true });
        document.head.addEventListener('load', send, true);
        window.addEventListener('pagehide', () => {
          observer.disconnect();
          probe.remove();
          document.head.removeEventListener('load', send, true);
        }, { once: true });
        send();
      };
      if (document.body) installCaptionThemeSync();
      else window.addEventListener('DOMContentLoaded', installCaptionThemeSync, { once: true });
    }
"#;

/// Installs platform markers and port-owned window chrome before the client boots.
fn init_script() -> String {
    format!(
        r#"(function () {{
  globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers();
  const mark = () => {{
    const root = document.documentElement;
    if (!root) return;
    root.dataset.platform = '{platform}';
    root.setAttribute('data-ds-theme-source', root.getAttribute('data-ds-theme-source') || 'system');
    {windows_chrome}
  }};
  if (document.documentElement) mark();
  else window.addEventListener('DOMContentLoaded', mark, {{ once: true }});
}})();"#,
        platform = platform_id(),
        windows_chrome = if cfg!(windows) {
            WINDOWS_CHROME_SCRIPT
        } else {
            ""
        },
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

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second launch focuses the existing window.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .invoke_handler(tauri::generate_handler![
            commands::shell_app_info,
            commands::shell_locale_get,
            commands::shell_locale_set,
            commands::shell_locale_apply,
            commands::shell_window_set_fullscreen,
            commands::shell_window_chrome_action,
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
            commands::update_open,
            commands::update_check,
            commands::shell_shortcuts_get,
            commands::shell_shortcuts_edit,
            commands::shell_shortcuts_recording,
        ])
        .setup(|app| setup(app).map_err(|error| Box::new(error) as Box<dyn std::error::Error>))
        .build(tauri::generate_context!())
        .expect("tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { .. } = event {
                // Clean shutdown: stop the runtime tree (graceful then forced)
                // and flush logs before the process ends.
                let state = app.state::<Arc<AppState>>();
                tauri::async_runtime::block_on(async {
                    state.supervisor.stop(false).await.ok();
                });
            }
        });
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

fn resolve_shell_directory(
    app: &tauri::App,
) -> Result<std::path::PathBuf, dsh_core::error::DshError> {
    if let Ok(directory) = std::env::var("DSH_DESKTOP_SHELL_DIR") {
        return Ok(std::path::PathBuf::from(directory));
    }
    if cfg!(debug_assertions) {
        return Ok(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/dist"));
    }
    app.path()
        .resource_dir()
        .map(|directory| directory.join("ui"))
        .map_err(|error| dsh_core::error::DshError::other("resource_dir", error.to_string()))
}

fn setup(app: &mut tauri::App) -> Result<(), dsh_core::error::DshError> {
    let (exe_dir, exe_dir_error) = match executable_directory() {
        Ok(directory) => (directory, None),
        Err(error) => (std::path::PathBuf::new(), Some(error)),
    };
    let shell_dir = resolve_shell_directory(app)?;
    let shell_assets_missing =
        !shell_dir.join("index.html").is_file() || !shell_dir.join("assets").is_dir();
    let paths = resolve_app_paths(None);
    std::fs::create_dir_all(&paths.user_data).map_err(|e| {
        dsh_core::error::DshError::io(
            "create user data",
            Some(paths.user_data.display().to_string()),
            &e,
        )
    })?;
    let desktop = resolve_desktop_paths(None);
    // Process-lifetime single-instance lock on the desktop profile, claimed
    // before any profile access (upstream `claimDesktopSingleInstance`).
    match dsh_core::single_instance::acquire(&desktop)? {
        dsh_core::single_instance::InstanceClaim::AlreadyRunning => {
            app.handle().exit(0);
            return Ok(());
        }
        dsh_core::single_instance::InstanceClaim::Acquired(_lock) => {
            // Held for the process lifetime by leaking the guard: the lock must
            // outlive every window.
            std::mem::forget(_lock);
        }
    }
    let _log_guard = dsh_core::diagnostics::init_diagnostics(&paths.logs)?;
    std::mem::forget(_log_guard);
    dsh_core::diagnostics::prune_crash_reports(
        &paths.logs,
        dsh_core::diagnostics::CRASH_REPORTS_RETAINED,
    )
    .ok();

    let settings = SettingsStore::open(&paths.settings)?;
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

    let mut credentials = CredentialStore::<KeyringBackend>::open_os(
        &paths.user_data.join("credentials-index.json"),
    )?;
    let signing_secret =
        dsh_gateway::auth::load_or_create_secret(&mut credentials).inspect_err(|_error| {
            tracing::error!("browser-session signing secret unavailable");
        })?;

    let runtime_dir = std::env::var("DSH_DESKTOP_RUNTIME_DIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("dsh"));
    let node = std::env::var("DSH_DESKTOP_NODE")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::path::PathBuf::from("node"));
    let adapter = std::env::var("DSH_DESKTOP_RUNTIME_ADAPTER")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| exe_dir.join("dsh").join("adapter.mjs"));
    let prerequisite_node = node.clone();
    let prerequisite_adapter = adapter.clone();
    let prerequisite_runtime_dir = runtime_dir.clone();
    let plan = SpawnPlan::desktop_host(
        node,
        adapter,
        runtime_dir,
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
    ));
    let gateway = tauri::async_runtime::block_on(dsh_gateway::start(
        dsh_gateway::GatewayConfig::loopback(shell_dir.clone()),
        signing_secret,
    ))?;
    // Development-only assembled-app acceptance handoff; unset by default and never logged.
    dev_handoff::write_gateway_url(&gateway)?;

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
        picker: tokio::sync::Mutex::new(None),
        onboarding_active: tokio::sync::Mutex::new(false),
        credential_ref,
        renderer_console: tokio::sync::Mutex::new(
            dsh_core::diagnostics::RendererConsoleTail::default(),
        ),
        background_close_confirmed: tokio::sync::Mutex::new(
            std::fs::metadata(&paths.background_close_confirmed).is_ok(),
        ),
        boot_outcome: tokio::sync::Mutex::new(None),
        boot_notify: tokio::sync::Notify::new(),
    });
    app.manage(state.clone());

    if let Some(error) = exe_dir_error {
        tauri::async_runtime::block_on(fatal::report_fatal(app.handle(), &error.to_string()))?;
        return Ok(());
    }

    if shell_assets_missing {
        let error = dsh_core::error::DshError::other(
            "shell_assets_missing",
            format!(
                "Packaged web UI assets are missing from {}.",
                shell_dir.display()
            ),
        );
        tauri::async_runtime::block_on(fatal::report_fatal(app.handle(), &error.to_string()))?;
        return Ok(());
    }

    // Start the Host under the supervisor and bind the gateway to it once ready.
    let startup_state = state.clone();
    let startup_node = prerequisite_node;
    let startup_adapter = prerequisite_adapter;
    let startup_runtime_dir = prerequisite_runtime_dir;
    let startup_profile = desktop.profile.clone();
    let app_handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            dsh_core::profile::initialize_desktop_profile(&startup_profile)?;
            validate_host_prerequisites(&startup_node, &startup_adapter, &startup_runtime_dir)?;
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

    // The window navigates to the gateway's authenticated URL (the deliberate
    // application-origin substitution of ADR 0001).
    let window = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        tauri::WebviewUrl::External(state.gateway.authenticated_url().parse().map_err(
            |e: url::ParseError| dsh_core::error::DshError::invalid_argument("url", e.to_string()),
        )?),
    )
    .title(dsh_core::paths::PRODUCT_NAME)
    .inner_size(1280.0, 800.0)
    .decorations(!cfg!(target_os = "windows"))
    .initialization_script(init_script())
    .build()
    .map_err(|e| dsh_core::error::DshError::other("window_create", e.to_string()))?;

    wire_window_events(&app_handle, &window);
    build_tray(&app_handle)?;
    build_menu(&app_handle)?;
    Ok(())
}

fn wire_window_events(app: &tauri::AppHandle, window: &tauri::WebviewWindow) {
    let app_emit = app.clone();
    let emit_window = move |payload: ShellWindowEvent| {
        app_emit.emit("dsh://shell/window", &payload).ok();
    };
    {
        let emit_window = emit_window.clone();
        let event_window = window.clone();
        let handler_app = app.clone();
        window.on_window_event(move |event| match event {
            tauri::WindowEvent::Focused(true) => {
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
    use tauri_plugin_dialog::DialogExt;
    let state = app.state::<Arc<AppState>>();
    {
        let confirmed = state.background_close_confirmed.lock().await;
        if !*confirmed {
            drop(confirmed);
            let messages = state::EN;
            let ok = app
                .dialog()
                .message(messages.background_notice_body)
                .title(messages.about_product)
                .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                    messages.background_notice_confirm.to_string(),
                    messages.cancel.to_string(),
                ))
                .blocking_show();
            if !ok {
                return;
            }
            if std::fs::write(&state.paths.background_close_confirmed, "").is_ok() {
                *state.background_close_confirmed.lock().await = true;
            }
        }
    }
    window.hide().ok();
    app.emit(
        "dsh://shell/window",
        &ShellWindowEvent {
            state: ShellWindowState::Hidden,
        },
    )
    .ok();
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
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
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
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        });
    builder
        .build(app)
        .map_err(|e| dsh_core::error::DshError::other("tray", e.to_string()))?;
    Ok(())
}

fn build_menu(app: &tauri::AppHandle) -> Result<(), dsh_core::error::DshError> {
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
