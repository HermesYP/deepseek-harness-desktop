//! `shell_menu_action` routing: the contract's closed `MenuActionId` union.
//!
//! Edit actions are sent as editing commands to the focused editor (upstream
//! sends native editing keys; the webview equivalent is `document.execCommand`).
//! K10: `Close Page or Window` is delivered through the `kind: 'menu'` arm of
//! `dsh://shortcuts/input` carrying upstream `ShortcutCommandId` `page.close`
//! (amendment A10) — distinct from `MenuActionId`.

use dsh_core::error::DshError;
use dsh_core::protocol::{
    DesktopShortcutInput, DesktopShortcutInputMenuKind, DesktopShortcutMenuInput, MenuActionId,
    ShortcutConfigSnapshot,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

pub async fn dispatch(
    app: &tauri::AppHandle,
    state: &std::sync::Arc<AppState>,
    id: MenuActionId,
) -> Result<(), DshError> {
    let window = app.get_webview_window("main");
    match id {
        MenuActionId::About => {
            let messages = crate::state::EN;
            let detail = crate::state::format_message(
                messages.about_version,
                &[("version", env!("CARGO_PKG_VERSION"))],
            );
            app.dialog()
                .message(format!("{}\n\n{detail}", messages.about_product))
                .title(messages.about_product)
                .blocking_show();
            Ok(())
        }
        MenuActionId::CheckForUpdates => crate::update_flow::check(app).await.map(|_| ()),
        MenuActionId::Exit => crate::quit_flow::request_quit(app).await,
        MenuActionId::Undo => eval(&window, "document.execCommand('undo')"),
        MenuActionId::Redo => eval(&window, "document.execCommand('redo')"),
        MenuActionId::Cut => eval(&window, "document.execCommand('cut')"),
        MenuActionId::Copy => eval(&window, "document.execCommand('copy')"),
        MenuActionId::Paste => eval(&window, "document.execCommand('paste')"),
        MenuActionId::Delete => eval(&window, "document.execCommand('delete')"),
        MenuActionId::SelectAll => eval(&window, "document.execCommand('selectAll')"),
        MenuActionId::ClosePageOrWindow => {
            // K10: routed through the client page owner via the upstream
            // `kind: 'menu'` input arm (`native.ts:6-10`).
            let snapshot = state.shortcuts.read_current();
            app.emit("dsh://shortcuts/input", &menu_input(&snapshot))
                .map_err(|e| DshError::other("shortcuts_input", e.to_string()))
        }
        MenuActionId::ReloadPage => eval(&window, "location.reload()"),
        MenuActionId::RestartAppAndHost => crate::quit_flow::restart_app_and_host(app).await,
        MenuActionId::ToggleDevtools => {
            let Some(window) = window else {
                return Ok(());
            };
            window.open_devtools();
            Ok(())
        }
        MenuActionId::Minimize => window
            .map(|window| window.minimize())
            .unwrap_or(Ok(()))
            .map_err(|e| DshError::other("window_minimize", e.to_string())),
        MenuActionId::Hide => window
            .map(|window| window.hide())
            .unwrap_or(Ok(()))
            .map_err(|e| DshError::other("window_hide", e.to_string())),
        MenuActionId::HideOthers => {
            #[cfg(target_os = "macos")]
            app.hide_other_apps();
            Ok(())
        }
        MenuActionId::ShowAll => {
            #[cfg(target_os = "macos")]
            app.show_all();
            if let Some(window) = window {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
            Ok(())
        }
        MenuActionId::ZoomIn => eval(
            &window,
            "window.__dshZoom = Math.min(3, (window.__dshZoom || 1) + 0.1); \
             document.documentElement.style.zoom = window.__dshZoom",
        ),
        MenuActionId::ZoomOut => eval(
            &window,
            "window.__dshZoom = Math.max(0.5, (window.__dshZoom || 1) - 0.1); \
             document.documentElement.style.zoom = window.__dshZoom",
        ),
        MenuActionId::ResetZoom => eval(
            &window,
            "window.__dshZoom = 1; document.documentElement.style.zoom = ''",
        ),
    }
}

fn menu_input(snapshot: &ShortcutConfigSnapshot) -> DesktopShortcutInput {
    DesktopShortcutInput::Menu(DesktopShortcutMenuInput {
        revision: snapshot.revision.clone(),
        kind: DesktopShortcutInputMenuKind::Menu,
        command_id: "page.close".to_string(),
    })
}

fn eval(window: &Option<tauri::WebviewWindow>, script: &str) -> Result<(), DshError> {
    match window {
        Some(window) => window
            .eval(script)
            .map_err(|e| DshError::other("editor_command", e.to_string())),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Mutex;

    use dsh_core::error::DshError;
    use dsh_core::protocol::{
        ShortcutBinding, ShortcutDefinition, ShortcutModifier, ShortcutSaveStatus,
    };
    use dsh_core::shortcuts::{
        ShortcutPersistence, ShortcutPlatform, ShortcutRuntime, ShortcutStorage,
    };

    use super::menu_input;

    struct MemoryStorage(Mutex<Option<String>>);

    impl ShortcutStorage for MemoryStorage {
        fn read(&self) -> Result<Option<String>, DshError> {
            Ok(self.0.lock().expect("storage lock").clone())
        }

        fn write(&self, raw: &str) -> Result<(), DshError> {
            *self.0.lock().expect("storage lock") = Some(raw.to_string());
            Ok(())
        }
    }

    fn persistence() -> ShortcutPersistence {
        let definition = ShortcutDefinition {
            id: "page.close".to_string(),
            defaults: BTreeMap::from([(
                "desktop:windows".to_string(),
                ShortcutBinding {
                    code: "KeyW".to_string(),
                    second_code: None,
                    modifiers: vec![ShortcutModifier::Primary],
                },
            )]),
            fixed: None,
        };
        let shortcuts = ShortcutPersistence::new(
            Box::new(MemoryStorage(Mutex::new(None))),
            ShortcutRuntime::Desktop,
            ShortcutPlatform::Windows,
            Box::new(|_| {}),
        );
        shortcuts.set_definitions(Some(vec![definition]));
        shortcuts
    }

    #[test]
    fn menu_input_uses_configuration_read_revision_and_upstream_menu_shape() {
        let shortcuts = persistence();
        let read_snapshot = shortcuts.read_current();
        let emitted = menu_input(&read_snapshot);
        let payload = serde_json::to_value(emitted).expect("serialize menu input");
        assert_eq!(payload["revision"], read_snapshot.revision);
        assert_eq!(payload["kind"], "menu");
        assert_eq!(payload["commandId"], "page.close");
        assert!(payload.get("frameName").is_none());
    }

    #[test]
    fn menu_input_tracks_revision_after_accepted_configuration_edit() {
        let shortcuts = persistence();
        let before = shortcuts.read_current();
        let edit = dsh_core::shortcuts::parse_shortcut_edit(&serde_json::json!({
            "type": "set",
            "id": "page.close",
            "binding": { "code": "KeyQ", "modifiers": ["primary"] }
        }))
        .expect("parse edit");
        let saved = shortcuts.edit(&edit, &before.revision);
        assert_eq!(saved.status, ShortcutSaveStatus::Saved);

        let after = shortcuts.read_current();
        assert_eq!(after.revision, saved.snapshot.revision);
        assert_ne!(after.revision, before.revision);
        let emitted = menu_input(&after);
        let payload = serde_json::to_value(emitted).expect("serialize menu input");
        assert_eq!(payload["revision"], after.revision);
        assert_eq!(payload["kind"], "menu");
        assert_eq!(payload["commandId"], "page.close");
    }
}
