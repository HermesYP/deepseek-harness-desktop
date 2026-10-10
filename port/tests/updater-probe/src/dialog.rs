//! Scripted replacement for `tauri_plugin_dialog`'s dialog surface.
//!
//! The updater's confirmation prompts are native blocking dialogs. Under a
//! headless probe there is no window to attach them to, so this module keeps
//! the exact call shape the updater uses:
//!
//! ```text
//! app.dialog().message(..).title(..)
//!    .buttons(MessageDialogButtons::OkCancelCustom(primary, secondary))
//!    .blocking_show() -> bool
//! ```
//!
//! and answers from a per-app script instead. The answer contract is the
//! plugin's: `blocking_show` returns `true` for the OK/primary button, and a
//! one-button box always answers `true`.

use std::sync::{Arc, Mutex};

/// The dialog buttons the updater offers.
///
/// Mirrors `tauri_plugin_dialog::MessageDialogButtons`, including its
/// `#[non_exhaustive]` marker and every variant, so the production
/// `update_flow.rs` call sites name the same variants they name in a shipped
/// build. The plugin crate itself is not a probe dependency: it links the Wry
/// runtime, whose event loop resolves WebView2 entry points at process start and
/// makes the headless test binary fail to load.
#[non_exhaustive]
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum MessageDialogButtons {
    /// A single `Ok` button with OS default text.
    #[default]
    Ok,
    /// Two buttons, `Ok` and `Cancel`, with OS default text.
    OkCancel,
    /// Two buttons, `Yes` and `No`, with OS default text.
    YesNo,
    /// Three buttons, `Yes`, `No`, and `Cancel`, with OS default text.
    YesNoCancel,
    /// A single `Ok` button with custom text.
    OkCustom(String),
    /// Two buttons, `Ok` and `Cancel`, with custom text.
    OkCancelCustom(String, String),
    /// Three buttons, `Yes`, `No`, and `Cancel`, with custom text.
    YesNoCancelCustom(String, String, String),
}

/// One dialog the updater asked the shell to show.
#[derive(Debug, Clone, PartialEq)]
pub struct DialogRequest {
    pub message: String,
    pub title: String,
    /// `(primary, secondary)`; `secondary` is empty for a one-button box.
    pub buttons: (String, String),
    /// Whether the box offered a real choice.
    pub choice: bool,
}

/// How a test answers a dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum DialogAnswer {
    /// The primary button ("Download and Install", "Install and Restart").
    #[default]
    Primary,
    /// The secondary button ("Later", "Cancel").
    Secondary,
}

/// The per-app dialog script and its request log.
#[derive(Default)]
pub struct DialogScript {
    pub requests: Vec<DialogRequest>,
    pub answers: Vec<DialogAnswer>,
    pub defer_callbacks: bool,
    pub pending_callbacks: Vec<Box<dyn FnOnce(bool) + Send + 'static>>,
}

impl std::fmt::Debug for DialogScript {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DialogScript")
            .field("requests", &self.requests)
            .field("answers", &self.answers)
            .field("defer_callbacks", &self.defer_callbacks)
            .field("pending_callbacks", &self.pending_callbacks.len())
            .finish()
    }
}

/// Resolve the oldest deferred dialog callback for this app.
pub fn resolve_deferred_callback(handle: &crate::update_flow::DesktopApp, answer: bool) -> bool {
    let Some(shell) = crate::host::shell_for(handle) else {
        return false;
    };
    let dialogs = shell.lock().unwrap().dialogs.clone();
    let callback = {
        let mut script = dialogs.lock().unwrap();
        if script.pending_callbacks.is_empty() {
            None
        } else {
            Some(script.pending_callbacks.remove(0))
        }
    };
    if let Some(callback) = callback {
        callback(answer);
        true
    } else {
        false
    }
}

/// Drop all queued callbacks. Their oneshot senders naturally close; no reply is invoked.
pub fn drop_pending_callbacks(handle: &crate::update_flow::DesktopApp) -> usize {
    let Some(shell) = crate::host::shell_for(handle) else {
        return 0;
    };
    let dialogs = shell.lock().unwrap().dialogs.clone();
    let callbacks = {
        let mut script = dialogs.lock().unwrap();
        std::mem::take(&mut script.pending_callbacks)
    };
    let count = callbacks.len();
    drop(callbacks);
    count
}

impl DialogScript {
    /// The answer for the request about to be made.
    pub fn next_answer(&self) -> DialogAnswer {
        self.answers
            .get(self.requests.len())
            .copied()
            .unwrap_or_default()
    }

    /// Every message shown, in order.
    pub fn messages(&self) -> Vec<String> {
        self.requests
            .iter()
            .map(|request| request.message.clone())
            .collect()
    }

    /// The last buttons offered, if any dialog was shown.
    pub fn last_buttons(&self) -> Option<(String, String)> {
        self.requests.last().map(|request| request.buttons.clone())
    }
}

/// Shared handle to one app's dialog script.
pub type SharedScript = Arc<Mutex<DialogScript>>;

/// Mirrors `tauri_plugin_dialog::DialogExt`.
pub trait DialogExt {
    /// Start building one dialog.
    fn dialog(&self) -> DialogBuilder;
}

impl DialogExt for tauri::AppHandle<tauri::test::MockRuntime> {
    fn dialog(&self) -> DialogBuilder {
        DialogBuilder {
            handle: self.clone(),
            message: String::new(),
            title: String::new(),
            buttons: MessageDialogButtons::Ok,
        }
    }
}

/// Builder mirroring `MessageDialogBuilder`'s fluent API.
pub struct DialogBuilder {
    handle: crate::update_flow::DesktopApp,
    message: String,
    title: String,
    buttons: MessageDialogButtons,
}

impl DialogBuilder {
    pub fn message(mut self, message: impl Into<String>) -> Self {
        self.message = message.into();
        self
    }

    pub fn title(mut self, title: impl Into<String>) -> Self {
        self.title = title.into();
        self
    }

    pub fn buttons(mut self, buttons: MessageDialogButtons) -> Self {
        self.buttons = buttons;
        self
    }

    /// Same signature and return type as the plugin's blocking call: `true`
    /// when the user chose the OK/primary button.
    ///
    /// Every variant of [`MessageDialogButtons`] is matched explicitly. The
    /// production call sites offer only `Ok` and `OkCancelCustom`, so a
    /// mismatch between this enum and the plugin's would surface as a compile
    /// error here rather than as a silently mis-answered prompt.
    pub fn blocking_show(self) -> bool {
        let handle = self.handle.clone();
        let (request, choice) = self.into_request();
        let answer = crate::host::answer_dialog(&handle, request);
        if !choice {
            return true;
        }
        answer == DialogAnswer::Primary
    }

    /// Callback-shaped counterpart to the native dialog SDK. Scripted hooks and
    /// request logging run exactly once, before either immediate or deferred reply.
    pub fn show<F: FnOnce(bool) + Send + 'static>(self, callback: F) {
        let handle = self.handle.clone();
        let (request, choice) = self.into_request();
        let answer = crate::host::answer_dialog(&handle, request);
        let result = !choice || answer == DialogAnswer::Primary;
        let Some(shell) = crate::host::shell_for(&handle) else {
            callback(result);
            return;
        };
        let dialogs = shell.lock().unwrap().dialogs.clone();
        let mut script = dialogs.lock().unwrap();
        if script.defer_callbacks {
            script.pending_callbacks.push(Box::new(callback));
        } else {
            drop(script);
            callback(result);
        }
    }

    fn into_request(self) -> (DialogRequest, bool) {
        let (buttons, choice) = match &self.buttons {
            MessageDialogButtons::Ok => (("OK".to_string(), String::new()), false),
            MessageDialogButtons::OkCustom(label) => ((label.clone(), String::new()), false),
            MessageDialogButtons::OkCancel => (("OK".to_string(), "Cancel".to_string()), true),
            MessageDialogButtons::YesNo => (("Yes".to_string(), "No".to_string()), true),
            MessageDialogButtons::YesNoCancel => (("Yes".to_string(), "No".to_string()), true),
            MessageDialogButtons::OkCancelCustom(primary, secondary) => {
                ((primary.clone(), secondary.clone()), true)
            }
            MessageDialogButtons::YesNoCancelCustom(yes, no, _cancel) => {
                ((yes.clone(), no.clone()), true)
            }
        };
        (
            DialogRequest {
                message: self.message,
                title: self.title,
                buttons,
                choice,
            },
            choice,
        )
    }
}
