//! Minimal stand-in for the workspace `dsh-runtime` crate in the updater probe.
//!
//! Only the update-task control surface the updater reads. Mirrors
//! `port/src-tauri/crates/dsh-runtime/src/control.rs`, so a case rename in the
//! real crate still breaks the probe.

pub mod control {
    use serde::{Deserialize, Serialize};

    /// Mirrors `dsh_runtime::control::UpdateTasksAction`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum UpdateTasksAction {
        Inspect,
        Lock,
        Unlock,
    }
}
