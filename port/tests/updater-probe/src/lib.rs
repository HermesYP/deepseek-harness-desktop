//! Scratch harness for lane U2 (updater runtime lifecycle and mandatory
//! policy). **Not a product artifact.**
//!
//! It compiles the **real** updater modules through `#[path]`:
//!
//! * `app/src/update_security.rs` — packaged trust, feed policy, Ed25519
//!   verification, and the check-schedule policy.
//! * `app/src/update_schedule.rs` — the monotonic schedule runner.
//! * `app/src/mandatory_update.rs` — mandatory decision, policy polling, and
//!   the release-satisfaction gate.
//! * `app/src/update_flow.rs` — check, confirmation, download, install.
//!
//! No module is copied: they are included from their production paths, so any
//! change that breaks the production crate breaks the probe too.
//!
//! ## The one substitution
//!
//! `update_flow.rs` is written against `tauri::{AppHandle, Emitter, Manager}`
//! and `tauri_plugin_dialog::DialogExt`. `Manager` and `Emitter` have sealed
//! supertraits, so no harness can implement them for a stand-in handle type.
//! The probe therefore builds a **real headless `tauri::AppHandle`** on Tauri's
//! `MockRuntime` (`tauri::test::{mock_builder, mock_context, noop_assets}`),
//! which creates no window and needs no display server. The handle, the state
//! registry, `app.path().resource_dir()`, the event plumbing and `app.exit` are
//! genuine Tauri implementations.
//!
//! Dialog display is the one behaviour the plugin cannot offer headlessly.
//! `update_flow.rs` accordingly imports `DialogExt` from `crate::dialog` under
//! `cfg(updater_probe)` and from `tauri_plugin_dialog` otherwise; that single
//! `cfg`-gated import line is the only production text the probe changes.

pub mod dialog;
pub mod host;
#[path = "../../../src-tauri/app/src/native_dialog.rs"]
pub mod native_dialog;
pub mod production;
pub mod state;

/// Explicit probe-only substitute for the app-owned native policy gate.
/// This records admission outcomes; it does not exercise native IPC/surfaces.
pub mod policy_owner {
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum NativeAction {
        Normal,
        MandatoryUpdate,
    }

    pub struct ProbePolicy {
        pub normal_allowed: std::sync::atomic::AtomicBool,
        pub mandatory_update_allowed: std::sync::atomic::AtomicBool,
        pub runtime_version: Option<String>,
        pub decision: std::sync::Mutex<crate::mandatory_update::MandatoryDecision>,
    }
    impl ProbePolicy {
        pub fn current_decision(&self) -> Option<crate::mandatory_update::MandatoryDecision> {
            Some(self.decision.lock().unwrap().clone())
        }
        pub fn set_decision(&self, decision: crate::mandatory_update::MandatoryDecision) {
            *self.decision.lock().unwrap() = decision;
        }
        pub fn allows(&self, action: NativeAction) -> bool {
            use std::sync::atomic::Ordering;
            match action {
                NativeAction::Normal => self.normal_allowed.load(Ordering::SeqCst),
                NativeAction::MandatoryUpdate => {
                    self.mandatory_update_allowed.load(Ordering::SeqCst)
                }
            }
        }
    }
}

#[cfg(test)]
mod integration;

pub use production::{mandatory_update, update_flow, update_schedule, update_security};

/// `crate::commands` subset the updater module calls.
pub mod commands {
    pub use crate::host::{desktop_update_failure_kind, present_update};
}

/// `crate::quit_flow` subset the install path calls.
pub mod quit_flow {
    use std::sync::atomic::{AtomicBool, Ordering};

    use dsh_core::error::DshError;
    use dsh_core::protocol::QuitReason;
    use tauri::Manager;

    static ARMED: AtomicBool = AtomicBool::new(false);

    /// Mirrors `crate::quit_flow::arm_skip`.
    pub fn arm_skip(skip: dsh_core::quit::QuitSkip) {
        if matches!(skip, dsh_core::quit::QuitSkip::InstallerRestart) {
            ARMED.store(true, Ordering::SeqCst);
        }
    }

    /// Mirrors `crate::quit_flow::confirm_exit`. The production path reaches it
    /// only after the Host has stopped, so the probe only records the call.
    pub async fn confirm_exit(
        _app: &crate::update_flow::DesktopApp,
        _reason: QuitReason,
    ) -> Result<(), DshError> {
        Ok(())
    }

    /// Explicit consent-based quit stand-in. It records the request, and deliberately
    /// does not invoke platform quit IPC or terminate the test process.
    pub async fn request_quit(app: &crate::update_flow::DesktopApp) -> Result<(), DshError> {
        app.state::<std::sync::Arc<crate::host::AppState>>()
            .exit_code
            .lock()
            .unwrap()
            .replace(0);
        Ok(())
    }

    /// Probe accessor: whether installation armed the installer-restart skip.
    pub fn installer_restart_armed() -> bool {
        ARMED.load(Ordering::SeqCst)
    }

    /// Probe reset between cases.
    pub fn reset() {
        ARMED.store(false, Ordering::SeqCst);
    }
}
