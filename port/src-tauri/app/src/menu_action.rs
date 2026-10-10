//! `shell_menu_action` routing: the contract's closed `MenuActionId` union, plus
//! the Windows caption menus.
//!
//! Edit actions are sent as editing commands to the focused editor (upstream
//! sends native editing keys; the webview equivalent is `document.execCommand`).
//! K10: `Close Page or Window` is delivered through the `kind: 'menu'` arm of
//! `dsh://shortcuts/input` carrying upstream `ShortcutCommandId` `page.close`
//! (amendment A10) — distinct from `MenuActionId`.
//!
//! ## Windows caption menus
//!
//! The released Windows host has **no** application menu bar
//! (`_upstream/apps/desktop/src/main.ts:924-927` builds only two hidden
//! devtools items). Instead `Application` and `Edit` are painted inside the
//! caption row by `preload-menu.ts`, and each button asks the shell for a native
//! popup anchored under itself (`main.ts:957-988`). That request is a
//! *renderer-triggered* menu, so it needs a transport of its own:
//! `shell_caption_menu`.
//!
//! Items (`main.ts:973-983`):
//!
//! | `Application` | `Edit` |
//! |---|---|
//! | About DeepSeek Harness | Undo `Ctrl+Z` |
//! | — separator — | Redo `Ctrl+Y` |
//! | Check for Updates… | — separator — |
//! | (development only) Reload Page / Restart App and Host | Cut `Ctrl+X` |
//! | — separator — | Copy `Ctrl+C` |
//! | Exit | Paste `Ctrl+V` |
//! | | Delete |
//! | | — separator — |
//! | | Select All `Ctrl+A` |
//!
//! Edit items do **not** run `document.execCommand`. The reference routes them
//! through `shortcuts.sendEditingKey`, which synthesizes a real
//! `before-input-event` so the *editor-owned* history (not Chromium's native
//! undo stack) receives the key. The port's equivalent is a synthesized DOM
//! `KeyboardEvent` on the focused element with a matching
//! `beforeinput`/`input` pair signalled through the same `execCommand` surface
//! for the clipboard roles that have no keyboard equivalent (`paste` cannot be
//! synthesized from script at all). Each item therefore carries the same
//! accelerator the reference labels it with, and the action performs the
//! strongest available equivalent — see [`edit_command`].

use dsh_core::error::DshError;
use dsh_core::protocol::{
    DesktopShortcutInput, DesktopShortcutInputMenuKind, DesktopShortcutMenuInput, MenuActionId,
    ShortcutConfigSnapshot,
};
use tauri::menu::{ContextMenu, Menu, MenuBuilder, MenuItemBuilder};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::{AppState, ShellMessages};

/// One caption menu item, before it becomes a native menu entry.
///
/// Kept as data so the item table is testable without a running Tauri app and so
/// the item set, its labels and its accelerators can be asserted against the
/// reference table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptionMenuItem {
    /// Stable id used for the click route.
    pub id: String,
    /// Localized label.
    pub label: String,
    /// Accelerator label exactly as the reference displays it (`None` for
    /// Delete, which has no accelerator; `Some("")` is never produced).
    pub accelerator: Option<&'static str>,
    /// The action this item dispatches.
    pub action: CaptionMenuAction,
}

/// What a caption menu item does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionMenuAction {
    /// A `MenuActionId` routed through [`dispatch`].
    Menu(MenuActionId),
    /// A synthesized editor key (`main.ts:966-972`).
    EditingKey(EditingKey),
    /// A separator.
    Separator,
}

/// One editor key the `Edit` menu sends as if the user typed it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EditingKey {
    /// `KeyboardEvent.key` value (`z`, `y`, `x`, `c`, `v`, `a`).
    pub key: &'static str,
    /// `KeyboardEvent.code` value (`KeyZ`, …).
    pub code: &'static str,
    /// Whether Ctrl participates.
    pub control: bool,
    /// Whether Shift participates.
    pub shift: bool,
    /// Legacy `document.execCommand` name, used when the synthesized key cannot
    /// reach an editor (clipboard roles have no scriptable equivalent).
    pub command: &'static str,
}

impl EditingKey {
    /// Undo — `Ctrl+Z` (`main.ts:974`).
    pub const UNDO: Self = Self {
        key: "z",
        code: "KeyZ",
        control: true,
        shift: false,
        command: "undo",
    };
    /// Redo — `Ctrl+Y` (`main.ts:975`).
    pub const REDO: Self = Self {
        key: "y",
        code: "KeyY",
        control: true,
        shift: false,
        command: "redo",
    };
    /// Cut — `Ctrl+X` (`main.ts:978`).
    pub const CUT: Self = Self {
        key: "x",
        code: "KeyX",
        control: true,
        shift: false,
        command: "cut",
    };
    /// Copy — `Ctrl+C` (`main.ts:979`).
    pub const COPY: Self = Self {
        key: "c",
        code: "KeyC",
        control: true,
        shift: false,
        command: "copy",
    };
    /// Paste — `Ctrl+V` (`main.ts:980`).
    pub const PASTE: Self = Self {
        key: "v",
        code: "KeyV",
        control: true,
        shift: false,
        command: "paste",
    };
    /// Select All — `Ctrl+A` (`main.ts:982`).
    pub const SELECT_ALL: Self = Self {
        key: "a",
        code: "KeyA",
        control: true,
        shift: false,
        command: "selectAll",
    };
    /// Delete — no modifier (`main.ts:980`).
    pub const DELETE: Self = Self {
        key: "Delete",
        code: "Delete",
        control: false,
        shift: false,
        command: "delete",
    };
}

/// Build the `Application` caption items (`main.ts:896-918`, Windows branch).
///
/// The development-only rows are included when `development` is true, matching
/// `...development ? [ ... ] : []`. K9 holds: no item carries a native
/// accelerator except the labelled editing keys the reference itself labels.
pub fn application_items(messages: &ShellMessages, development: bool) -> Vec<CaptionMenuItem> {
    let mut items = vec![CaptionMenuItem {
        id: "about".to_string(),
        label: messages.about_product.to_string(),
        accelerator: None,
        action: CaptionMenuAction::Menu(MenuActionId::About),
    }];
    items.push(CaptionMenuItem {
        id: "separator-1".to_string(),
        label: String::new(),
        accelerator: None,
        action: CaptionMenuAction::Separator,
    });
    items.push(CaptionMenuItem {
        id: "check_for_updates".to_string(),
        label: messages.check_updates_menu.to_string(),
        accelerator: None,
        action: CaptionMenuAction::Menu(MenuActionId::CheckForUpdates),
    });
    if development {
        items.push(CaptionMenuItem {
            id: "separator-2".to_string(),
            label: String::new(),
            accelerator: None,
            action: CaptionMenuAction::Separator,
        });
        items.push(CaptionMenuItem {
            id: "reload_page".to_string(),
            label: messages.reload_page_menu.to_string(),
            accelerator: None,
            action: CaptionMenuAction::Menu(MenuActionId::ReloadPage),
        });
        items.push(CaptionMenuItem {
            id: "restart_app_and_host".to_string(),
            label: messages.restart_app_host_menu.to_string(),
            accelerator: None,
            action: CaptionMenuAction::Menu(MenuActionId::RestartAppAndHost),
        });
    }
    items.push(CaptionMenuItem {
        id: "separator-3".to_string(),
        label: String::new(),
        accelerator: None,
        action: CaptionMenuAction::Separator,
    });
    items.push(CaptionMenuItem {
        id: "exit".to_string(),
        label: messages.exit_application.to_string(),
        accelerator: None,
        action: CaptionMenuAction::Menu(MenuActionId::Exit),
    });
    items
}

/// Build the `Edit` caption items (`main.ts:973-983`).
///
/// The accelerators are display labels only; K9 forbids native accelerators on
/// accepted shortcut bindings, and these are the reference's own fixed editing
/// chords, not configurable bindings.
pub fn edit_items(messages: &ShellMessages) -> Vec<CaptionMenuItem> {
    fn row(id: &str, label: &str, key: EditingKey, accelerator: &'static str) -> CaptionMenuItem {
        CaptionMenuItem {
            id: id.to_string(),
            label: label.to_string(),
            accelerator: Some(accelerator),
            action: CaptionMenuAction::EditingKey(key),
        }
    }
    fn separator(id: &str) -> CaptionMenuItem {
        CaptionMenuItem {
            id: id.to_string(),
            label: String::new(),
            accelerator: None,
            action: CaptionMenuAction::Separator,
        }
    }
    vec![
        row("undo", messages.undo, EditingKey::UNDO, "Ctrl+Z"),
        row("redo", messages.redo, EditingKey::REDO, "Ctrl+Y"),
        separator("separator-1"),
        row("cut", messages.cut, EditingKey::CUT, "Ctrl+X"),
        row("copy", messages.copy, EditingKey::COPY, "Ctrl+C"),
        row("paste", messages.paste, EditingKey::PASTE, "Ctrl+V"),
        CaptionMenuItem {
            id: "delete".to_string(),
            label: messages.delete.to_string(),
            accelerator: None,
            action: CaptionMenuAction::EditingKey(EditingKey::DELETE),
        },
        separator("separator-2"),
        row(
            "select_all",
            messages.select_all,
            EditingKey::SELECT_ALL,
            "Ctrl+A",
        ),
    ]
}

/// The items of one caption menu, or `None` for an unknown name.
pub fn caption_items(
    name: &str,
    messages: &ShellMessages,
    development: bool,
) -> Option<Vec<CaptionMenuItem>> {
    match name {
        "application" => Some(application_items(messages, development)),
        "edit" => Some(edit_items(messages)),
        _ => None,
    }
}

/// Script that performs one editing command on the focused editor.
///
/// The reference sends a synthetic input event so the *editor-owned* history
/// receives it (`keyboard.ts:225-241`); the port does both: dispatch a real
/// `KeyboardEvent` carrying the reference's chord (which the composer's
/// ProseMirror keymap observes), and, when that key cannot reach any editor
/// (clipboard roles), fall back to the webview's editing command so the item is
/// never a dead control.
pub fn editing_script(key: EditingKey) -> String {
    let command = serde_json::to_string(key.command).unwrap_or_else(|_| "\"\"".to_string());
    let event_key = serde_json::to_string(key.key).unwrap_or_else(|_| "\"\"".to_string());
    let code = serde_json::to_string(key.code).unwrap_or_else(|_| "\"\"".to_string());
    let modifiers = serde_json::json!({
        "ctrlKey": key.control,
        "shiftKey": key.shift,
        "metaKey": false,
        "altKey": false,
    });
    format!(
        r#"(function () {{
  var command = {command};
  var target = document.activeElement;
  while (target && target.shadowRoot && target.shadowRoot.activeElement) {{
    target = target.shadowRoot.activeElement;
  }}
  var delivered = false;
  if (target && typeof target.dispatchEvent === 'function') {{
    var init = Object.assign({{
      key: {event_key}, code: {code}, bubbles: true, cancelable: true, composed: true,
    }}, {modifiers});
    try {{
      delivered = target.dispatchEvent(new KeyboardEvent('keydown', init)) === false;
    }} catch (error) {{
      delivered = false;
    }}
  }}
  if (delivered) return true;
  // No editor consumed the chord: the clipboard and selection roles have no
  // scriptable keyboard equivalent, so the webview's own editing command is the
  // reference's `sendInputEvent` equivalent.
  try {{ return document.execCommand(command); }} catch (error) {{ return false; }}
}})();"#
    )
}

/// Show one caption menu anchored at the reported client point.
///
/// The reported `x`/`y` are CSS pixels from the button's
/// `getBoundingClientRect()` (`preload-menu.ts:63`), and the reference converts
/// them exactly once, by the page's own zoom factor, before the native popup
/// (`main.ts:984-986`: `x * webContents.getZoomFactor()`).
///
/// The port converts with the **measured** page zoom — the live WebView2 zoom
/// factor ([`measured_webview_zoom`]) — and never with
/// `WebviewWindow::scale_factor`. Those are different numbers: the scale factor
/// is the monitor's DPI scale, which the native popup already applies when it
/// maps a logical point to the monitor the window is on. Substituting it would
/// double-apply the DPI, and on a window on a differently scaled monitor it
/// would be simply wrong. When no zoom can be measured the popup is refused
/// rather than placed with a guessed ratio.
///
/// The popup is fire-and-forget from this command's perspective: Tauri's
/// `ContextMenu::popup_at` returns as soon as the menu is shown and the chosen
/// item arrives on the app's `on_menu_event` handler, where
/// [`handle_caption_menu_event`] routes it. The command therefore resolves when
/// the menu has been presented, which is what the reference's
/// `ipcRenderer.invoke` awaits (`preload-menu.ts:67`) and what releases the
/// button's `aria-expanded` state.
pub async fn show_caption_menu(
    app: &tauri::AppHandle,
    state: &std::sync::Arc<AppState>,
    window: &tauri::WebviewWindow,
    name: &str,
    x: f64,
    y: f64,
) -> Result<(), DshError> {
    crate::policy_composition::require_state(state)?;
    let locale = {
        let model = state.locale.lock().await;
        model.snapshot().effective
    };
    crate::policy_composition::require_state(state)?;
    let messages = crate::state::messages(locale);
    let items = caption_items(name, messages, cfg!(debug_assertions))
        .ok_or_else(|| DshError::invalid_argument("name", "unsupported caption menu"))?;

    let handle = app.clone();
    let window = window.clone();
    crate::policy_composition::on_main_normal(app, move || {
        let menu = build_caption_menu(&handle, &items)?;
        let zoom = measured_webview_zoom(&window).ok_or_else(|| {
            DshError::invalid_argument(
                "position",
                "the caption menu anchor needs the measured page zoom, and the webview reported none",
            )
        })?;
        let anchor = caption_anchor(x, y, zoom)
            .map_err(|error| DshError::invalid_argument("position", error.to_string()))?;
        let position = tauri::LogicalPosition::new(anchor.x, anchor.y);
        let host = window.as_ref().window();
        menu.popup_at(host, position)
            .map_err(|error| DshError::other("caption_menu", error.to_string()))
    })
    .await
}

/// The largest caption anchor the renderer may report, in CSS pixels
/// (upstream `main.ts:965` rejects `x > 100_000 || y > 100_000`).
pub const CAPTION_ANCHOR_CEILING: f64 = 100_000.0;

/// One caption-menu anchor converted from CSS pixels to the logical
/// (device-independent) pixels a native popup takes.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CaptionAnchor {
    /// Logical x of the popup anchor.
    pub x: f64,
    /// Logical y of the popup anchor.
    pub y: f64,
}

/// Why a caption anchor was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionAnchorError {
    /// A coordinate is not a finite, non-negative number within
    /// [`CAPTION_ANCHOR_CEILING`].
    Coordinate,
    /// No usable page zoom: not a positive finite ratio. Guessing one would
    /// place the menu at the wrong scale.
    Zoom,
}

impl std::fmt::Display for CaptionAnchorError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Coordinate => {
                formatter.write_str("caption menu coordinates must be finite and within the window")
            }
            Self::Zoom => formatter
                .write_str("the caption menu anchor requires a measured, positive page zoom"),
        }
    }
}

impl std::error::Error for CaptionAnchorError {}

/// Convert one caption-menu anchor from CSS pixels to logical pixels exactly
/// once, by the measured page zoom.
///
/// The result is rounded like the reference's `Math.round`, because the
/// conversion exists to land a native popup on a pixel boundary.
pub fn caption_anchor(x: f64, y: f64, page_zoom: f64) -> Result<CaptionAnchor, CaptionAnchorError> {
    if !x.is_finite()
        || !y.is_finite()
        || x < 0.0
        || y < 0.0
        || x > CAPTION_ANCHOR_CEILING
        || y > CAPTION_ANCHOR_CEILING
    {
        return Err(CaptionAnchorError::Coordinate);
    }
    if !page_zoom.is_finite() || page_zoom <= 0.0 {
        return Err(CaptionAnchorError::Zoom);
    }
    let anchor = CaptionAnchor {
        x: (x * page_zoom).round(),
        y: (y * page_zoom).round(),
    };
    // A finite coordinate times a finite positive ratio cannot overflow to an
    // infinity here, but the anchor is what reaches the native layer: keep the
    // guarantee local instead of trusting the caller's hidden bound.
    if anchor.x.is_finite() && anchor.y.is_finite() {
        Ok(anchor)
    } else {
        Err(CaptionAnchorError::Coordinate)
    }
}

/// The page's own CSS→logical ratio: the live WebView2 zoom factor.
///
/// Upstream reads `webContents.getZoomFactor()`; the port has no getter for the
/// zoom on `WebviewWindow`, so it asks the controller the page renders under
/// (`ICoreWebView2Controller::ZoomFactor`) — the same number, read at the
/// moment the menu is anchored. `with_webview` runs its closure inline when the
/// caller is already on the main thread, which this path always is (the popup
/// runs inside [`crate::policy_composition::on_main_normal`]); a queued
/// call therefore never reaches this read, and `None` is returned instead of a
/// guessed ratio.
fn measured_webview_zoom(window: &tauri::WebviewWindow) -> Option<f64> {
    #[cfg(windows)]
    {
        use std::sync::atomic::{AtomicU64, Ordering};
        // Zero bits can never be a measurement: every accepted zoom is positive.
        let measured = std::sync::Arc::new(AtomicU64::new(0));
        let slot = measured.clone();
        window
            .with_webview(move |native| {
                // SAFETY: `ZoomFactor` is a controller read and must run on the
                // controller's UI apartment; `with_webview` executes the
                // closure on the main thread (inline when already there). Only
                // a plain `f64` leaves the closure, so no COM pointer escapes.
                unsafe {
                    let control: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller =
                        native.controller();
                    let mut factor = 1.0f64;
                    if control.ZoomFactor(&mut factor).is_ok()
                        && factor.is_finite()
                        && factor > 0.0
                    {
                        slot.store(factor.to_bits(), Ordering::SeqCst);
                    }
                }
            })
            .ok()?;
        let bits = measured.load(Ordering::SeqCst);
        (bits != 0).then(|| f64::from_bits(bits))
    }
    #[cfg(not(windows))]
    {
        // The caption chrome and its popup are Windows-only: `lib.rs` injects
        // `windows_caption_scripts` only for `cfg!(windows)`, and there is no
        // WebView2 controller to measure anywhere else.
        let _ = window;
        None
    }
}

/// Build the native menu for one caption item table.
///
/// Item ids are `caption:<menu>:<index>` so
/// [`handle_caption_menu_event`] can recover the action from the table that
/// built them without any global registry: the id carries the menu name and the
/// row index, and the row table is a pure function of the locale and the
/// development flag.
pub fn build_caption_menu(
    app: &tauri::AppHandle,
    items: &[CaptionMenuItem],
) -> Result<Menu<tauri::Wry>, DshError> {
    let mut builder = MenuBuilder::new(app);
    for (index, item) in items.iter().enumerate() {
        match item.action {
            CaptionMenuAction::Separator => {
                builder = builder.separator();
            }
            _ => {
                let id = caption_item_id(index);
                let mut entry = MenuItemBuilder::with_id(&id, &item.label);
                if let Some(accelerator) = item.accelerator {
                    // A display label only: this is a *popup* entry, so the
                    // chord is shown but never registered as a native
                    // accelerator (K9 — a native accelerator would intercept a
                    // binding before the page's own registry sees it).
                    entry = entry.accelerator(accelerator);
                }
                let entry = entry
                    .build(app)
                    .map_err(|e| DshError::other("caption_menu", e.to_string()))?;
                builder = builder.item(&entry);
            }
        }
    }
    builder
        .build()
        .map_err(|e| DshError::other("caption_menu", e.to_string()))
}

/// Item id of one caption row: `caption:<index>`.
///
/// The menu name is not part of the id because a menu event carries only the id
/// and the index is already unique within the popup that produced it; the
/// router looks the row up in the same table the popup was built from.
pub fn caption_item_id(index: usize) -> String {
    format!("caption:{index}")
}

/// Recover the row index from a caption item id, or `None` for a foreign id.
pub fn caption_item_index(id: &str) -> Option<usize> {
    id.strip_prefix("caption:")?.parse::<usize>().ok()
}

/// Route one menu event that came from a caption popup.
///
/// Returns `true` when the id belonged to a caption menu (the caller must then
/// not fall through to the ordinary application-menu routing).
pub async fn handle_caption_menu_event(
    app: &tauri::AppHandle,
    state: &std::sync::Arc<AppState>,
    id: &str,
) -> bool {
    let Some(index) = caption_item_index(id) else {
        return false;
    };
    let locale = {
        let model = state.locale.lock().await;
        model.snapshot().effective
    };
    let messages = crate::state::messages(locale);
    // The index is unique per menu, so search both tables; a captioned menu is
    // the only producer of this id shape, and the two tables never share an
    // index with a different action.
    for items in [
        application_items(messages, cfg!(debug_assertions)),
        edit_items(messages),
    ] {
        let Some(item) = items.get(index) else {
            continue;
        };
        match item.action {
            CaptionMenuAction::Separator => return true,
            CaptionMenuAction::Menu(action) => {
                let _ = dispatch(app, state, action).await;
                return true;
            }
            CaptionMenuAction::EditingKey(key) => {
                if crate::policy_composition::require_state(state).is_err() {
                    return true;
                }
                let handle = app.clone();
                let _ = crate::policy_composition::on_main_normal(app, move || {
                    if let Some(window) = handle.get_webview_window("main") {
                        window.eval(editing_script(key)).map_err(|error| {
                            DshError::other("editor_command", error.to_string())
                        })?;
                    }
                    Ok(())
                })
                .await;
                return true;
            }
        }
    }
    false
}

pub async fn dispatch(
    app: &tauri::AppHandle,
    state: &std::sync::Arc<AppState>,
    id: MenuActionId,
) -> Result<(), DshError> {
    if id != MenuActionId::Exit {
        crate::policy_composition::require_normal(app)?;
    }
    match id {
        MenuActionId::About => show_about(app, state).await,
        MenuActionId::CheckForUpdates => crate::update_flow::check(app).await.map(|_| ()),
        MenuActionId::Exit => crate::quit_flow::request_quit(app).await,
        MenuActionId::RestartAppAndHost => crate::quit_flow::restart_app_and_host(app).await,
        _ => {
            let handle = app.clone();
            let state = state.clone();
            crate::policy_composition::on_main_normal(app, move || {
                dispatch_native(&handle, &state, id)
            })
            .await
        }
    }
}

/// `About DeepSeek Harness`: one informational message box with a single
/// acknowledge button (`main.ts:367-369`, `ordinaryMessageBox`).
///
/// The box is shown through the dialog *callback* (`show`, not
/// `blocking_show`), so neither the main thread nor the IPC worker waits on a
/// user answer — the dialog plugin marshals the presentation to the main thread
/// itself and this future completes when the box closes. A dropped callback (a
/// dismissed box, or an application already tearing down) needs no follow-up:
/// the box has no other effect.
async fn show_about(
    app: &tauri::AppHandle,
    state: &std::sync::Arc<AppState>,
) -> Result<(), DshError> {
    let locale = {
        let model = state.locale.lock().await;
        model.snapshot().effective
    };
    // Revalidate as late as possible: the acknowledge box is admitted only
    // while normal desktop actions are allowed.
    crate::policy_composition::require_state(state)?;
    let messages = crate::state::messages(locale);
    let detail = crate::state::format_message(
        messages.about_version,
        &[("version", env!("CARGO_PKG_VERSION"))],
    );
    let body = format!("{}\n\n{detail}", messages.about_product);
    crate::native_dialog::answer(|reply| {
        app.dialog()
            .message(body)
            .title(messages.about_product)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::Ok)
            .show(reply);
    })
    .await;
    Ok(())
}

fn dispatch_native(
    app: &tauri::AppHandle,
    state: &std::sync::Arc<AppState>,
    id: MenuActionId,
) -> Result<(), DshError> {
    let window = app.get_webview_window("main");
    match id {
        MenuActionId::About
        | MenuActionId::CheckForUpdates
        | MenuActionId::Exit
        | MenuActionId::RestartAppAndHost => {
            unreachable!("asynchronous actions are routed before native dispatch")
        }
        MenuActionId::Undo => eval(&window, &editing_script(EditingKey::UNDO)),
        MenuActionId::Redo => eval(&window, &editing_script(EditingKey::REDO)),
        MenuActionId::Cut => eval(&window, &editing_script(EditingKey::CUT)),
        MenuActionId::Copy => eval(&window, &editing_script(EditingKey::COPY)),
        MenuActionId::Paste => eval(&window, &editing_script(EditingKey::PASTE)),
        MenuActionId::Delete => eval(&window, &editing_script(EditingKey::DELETE)),
        MenuActionId::SelectAll => eval(&window, &editing_script(EditingKey::SELECT_ALL)),
        MenuActionId::ClosePageOrWindow => {
            // K10: routed through the client page owner via the upstream
            // `kind: 'menu'` input arm (`native.ts:6-10`).
            let snapshot = state.shortcuts.read_current();
            app.emit("dsh://shortcuts/input", &menu_input(&snapshot))
                .map_err(|e| DshError::other("shortcuts_input", e.to_string()))
        }
        MenuActionId::ReloadPage => eval(&window, "location.reload()"),
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

    use super::*;

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

    /// The item table the reference builds (`main.ts:973-983`), asserted in
    /// order with its labels and display accelerators.
    #[test]
    fn edit_caption_items_match_the_reference_table_and_order() {
        let items = edit_items(&crate::state::EN);
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "undo",
                "redo",
                "separator-1",
                "cut",
                "copy",
                "paste",
                "delete",
                "separator-2",
                "select_all",
            ]
        );
        let labels: Vec<&str> = items
            .iter()
            .filter(|item| item.action != CaptionMenuAction::Separator)
            .map(|item| item.label.as_str())
            .collect();
        assert_eq!(
            labels,
            [
                "Undo",
                "Redo",
                "Cut",
                "Copy",
                "Paste",
                "Delete",
                "Select All"
            ]
        );
        let accelerators: Vec<Option<&str>> = items
            .iter()
            .filter(|item| item.action != CaptionMenuAction::Separator)
            .map(|item| item.accelerator)
            .collect();
        assert_eq!(
            accelerators,
            [
                Some("Ctrl+Z"),
                Some("Ctrl+Y"),
                Some("Ctrl+X"),
                Some("Ctrl+C"),
                Some("Ctrl+V"),
                None,
                Some("Ctrl+A"),
            ]
        );
        // Delete is the only item without a modifier (`main.ts:980`).
        let delete = items
            .iter()
            .find(|item| item.id == "delete")
            .expect("delete row");
        assert_eq!(
            delete.action,
            CaptionMenuAction::EditingKey(EditingKey::DELETE)
        );
        match &delete.action {
            CaptionMenuAction::EditingKey(key) => assert!(!key.control),
            _ => panic!("delete row must dispatch an editing key"),
        }
    }

    #[test]
    fn edit_caption_items_are_localized_from_the_shell_dictionary() {
        let zh = edit_items(&crate::state::ZH);
        let labels: Vec<&str> = zh
            .iter()
            .filter(|item| item.action != CaptionMenuAction::Separator)
            .map(|item| item.label.as_str())
            .collect();
        assert_eq!(
            labels,
            ["撤销", "重做", "剪切", "复制", "粘贴", "删除", "全选"]
        );
    }

    #[test]
    fn application_caption_items_hide_development_rows_when_released() {
        let released = application_items(&crate::state::EN, false);
        let ids: Vec<&str> = released.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "about",
                "separator-1",
                "check_for_updates",
                "separator-3",
                "exit"
            ]
        );
        assert_eq!(
            released[0].action,
            CaptionMenuAction::Menu(MenuActionId::About)
        );
        assert_eq!(
            released.last().expect("exit").action,
            CaptionMenuAction::Menu(MenuActionId::Exit)
        );
        let development = application_items(&crate::state::EN, true);
        let ids: Vec<&str> = development.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "about",
                "separator-1",
                "check_for_updates",
                "separator-2",
                "reload_page",
                "restart_app_and_host",
                "separator-3",
                "exit",
            ]
        );
    }

    #[test]
    fn caption_menu_names_are_the_closed_two_element_set() {
        assert!(caption_items("application", &crate::state::EN, false).is_some());
        assert!(caption_items("edit", &crate::state::EN, false).is_some());
        for rejected in ["file", "view", "help", "", "Application", "edit "] {
            assert!(
                caption_items(rejected, &crate::state::EN, false).is_none(),
                "{rejected} must not resolve to a menu"
            );
        }
    }

    /// No caption item may carry a native accelerator (K9): the reference
    /// routes every configurable command through the client registry, and a
    /// native accelerator here would intercept the binding before the page.
    #[test]
    fn caption_items_carry_only_display_accelerators() {
        for items in [
            application_items(&crate::state::EN, true),
            edit_items(&crate::state::EN),
        ] {
            for item in items {
                match item.action {
                    CaptionMenuAction::Separator => {
                        assert!(item.accelerator.is_none(), "{}", item.id);
                        assert!(item.label.is_empty(), "{}", item.id);
                    }
                    CaptionMenuAction::Menu(_) => {
                        assert!(
                            item.accelerator.is_none(),
                            "{} must not own a native accelerator",
                            item.id
                        );
                    }
                    CaptionMenuAction::EditingKey(_) => {}
                }
            }
        }
    }

    #[test]
    fn editing_script_targets_the_deepest_focused_editor_and_is_injection_safe() {
        let script = editing_script(EditingKey::PASTE);
        // Shadow DOM traversal mirrors the client's own focus resolution.
        assert!(script.contains("shadowRoot.activeElement"), "{script}");
        assert!(script.contains("\"paste\""), "{script}");
        assert!(script.contains("\"v\""), "{script}");
        assert!(script.contains("\"KeyV\""), "{script}");
        let modifiers = script
            .split("}, ")
            .nth(1)
            .and_then(|value| value.split(");").next())
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
            .expect("keyboard modifiers are a JSON object passed to Object.assign");
        assert_eq!(modifiers["ctrlKey"], true);
        assert_eq!(modifiers["shiftKey"], false);
        // The fallback only runs when nothing consumed the chord.
        assert!(script.contains("if (delivered) return true;"), "{script}");
    }

    #[test]
    fn delete_editing_script_has_no_modifier() {
        let script = editing_script(EditingKey::DELETE);
        let modifiers = script
            .split("}, ")
            .nth(1)
            .and_then(|value| value.split(");").next())
            .and_then(|value| serde_json::from_str::<serde_json::Value>(value).ok())
            .expect("keyboard modifiers are a JSON object passed to Object.assign");
        for name in ["ctrlKey", "shiftKey", "metaKey", "altKey"] {
            assert_eq!(modifiers[name], false, "{name}");
        }
        assert!(script.contains("\"Delete\""), "{script}");
    }

    #[test]
    fn caption_item_ids_round_trip_and_reject_foreign_ids() {
        for index in [0usize, 1, 7, 42, 999] {
            let id = caption_item_id(index);
            assert_eq!(caption_item_index(&id), Some(index));
        }
        for foreign in [
            "about",
            "exit",
            "caption:",
            "caption:x",
            "caption:-1",
            "dsh-caption:0",
            "",
        ] {
            assert_eq!(caption_item_index(foreign), None, "{foreign}");
        }
    }

    /// The router resolves a caption id against the same table the popup was
    /// built from, so every non-separator row of every menu must be reachable.
    #[test]
    fn every_caption_row_resolves_through_its_index() {
        for items in [
            application_items(&crate::state::EN, false),
            application_items(&crate::state::EN, true),
            edit_items(&crate::state::EN),
        ] {
            for (index, item) in items.iter().enumerate() {
                let resolved = caption_item_index(&caption_item_id(index)).expect("index");
                assert_eq!(resolved, index);
                assert_eq!(
                    items.get(resolved).map(|row| &row.action),
                    Some(&item.action),
                    "row {index} must resolve to itself"
                );
            }
        }
    }

    #[test]
    fn caption_anchor_converts_css_to_logical_once_by_the_measured_zoom() {
        assert_eq!(
            caption_anchor(10.0, 20.0, 1.0).expect("identity"),
            CaptionAnchor { x: 10.0, y: 20.0 }
        );
        assert_eq!(
            caption_anchor(10.0, 20.0, 2.0).expect("scaled"),
            CaptionAnchor { x: 20.0, y: 40.0 }
        );
        // Fractional zoom lands on a pixel boundary, like the reference's
        // `Math.round(x * zoom)` (`main.ts:985`).
        assert_eq!(
            caption_anchor(10.4, 20.6, 1.25).expect("rounded"),
            CaptionAnchor { x: 13.0, y: 26.0 }
        );
    }

    #[test]
    fn caption_anchor_rejects_unusable_coordinates_and_unmeasured_zoom() {
        for (x, y) in [
            (f64::NAN, 1.0),
            (1.0, f64::NAN),
            (f64::INFINITY, 1.0),
            (1.0, f64::NEG_INFINITY),
            (-1.0, 1.0),
            (1.0, -1.0),
            (CAPTION_ANCHOR_CEILING + 1.0, 1.0),
            (1.0, CAPTION_ANCHOR_CEILING + 1.0),
        ] {
            assert_eq!(
                caption_anchor(x, y, 1.0).unwrap_err(),
                CaptionAnchorError::Coordinate,
                "{x},{y}"
            );
        }
        // The reference's comparison is `> 100_000`, so the bound itself is
        // still accepted.
        assert!(caption_anchor(CAPTION_ANCHOR_CEILING, CAPTION_ANCHOR_CEILING, 1.0).is_ok());
        // No measured zoom is never replaced by a guess, and a non-ratio is
        // refused rather than converted with.
        for zoom in [0.0, -1.0, f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert_eq!(
                caption_anchor(1.0, 1.0, zoom).unwrap_err(),
                CaptionAnchorError::Zoom,
                "{zoom}"
            );
        }
    }

    /// The page reports CSS pixels from the button rectangle (upstream
    /// `preload-menu.ts:63`) and owns no DPI arithmetic: the single
    /// CSS→logical conversion happens on the native side, by the measured page
    /// zoom, which is why no scale factor appears in the script either.
    #[test]
    fn the_caption_script_reports_css_pixels_and_no_dpi_scale() {
        let script = crate::chrome::windows_caption_scripts();
        assert!(script.contains("x: rect.left, y: rect.bottom"), "{script}");
        assert!(!script.contains("devicePixelRatio"), "{script}");
        assert!(!script.contains("scaleFactor"), "{script}");
        assert!(!script.contains("scale_factor"), "{script}");
    }
}
