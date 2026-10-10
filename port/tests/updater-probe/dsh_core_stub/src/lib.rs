//! Minimal stand-in for the workspace `dsh-core` crate, used only by the
//! scratch updater probe.
//!
//! Every item below mirrors the real definition in
//! `port/src-tauri/crates/dsh-core/src/` so a signature or field change in the
//! real crate still breaks the probe's compilation.

pub mod error {
    /// Mirrors `dsh_core::error::DshError` (same variant, field and
    /// constructor names; `Display` follows the same shape).
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum DshError {
        NotFound {
            entity: String,
            id: String,
        },
        InvalidArgument {
            field: String,
            reason: String,
        },
        Io {
            operation: String,
            path: Option<String>,
            message: String,
        },
        RuntimeUnavailable {
            state: String,
            reason: String,
        },
        Other {
            code: String,
            message: String,
        },
    }

    impl std::fmt::Display for DshError {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::NotFound { entity, id } => write!(formatter, "unknown {entity}: {id}"),
                Self::InvalidArgument { field, reason } => {
                    write!(formatter, "invalid {field}: {reason}")
                }
                Self::Io {
                    operation, message, ..
                } => write!(formatter, "{operation} failed: {message}"),
                Self::RuntimeUnavailable { state, reason } => {
                    write!(formatter, "runtime unavailable ({state}): {reason}")
                }
                Self::Other { code, message } => write!(formatter, "{code}: {message}"),
            }
        }
    }

    impl std::error::Error for DshError {}

    impl DshError {
        pub fn not_found(entity: impl Into<String>, id: impl Into<String>) -> Self {
            Self::NotFound {
                entity: entity.into(),
                id: id.into(),
            }
        }

        pub fn invalid_argument(field: impl Into<String>, reason: impl Into<String>) -> Self {
            Self::InvalidArgument {
                field: field.into(),
                reason: reason.into(),
            }
        }

        pub fn io(
            operation: impl Into<String>,
            path: Option<String>,
            error: &dyn std::fmt::Display,
        ) -> Self {
            Self::Io {
                operation: operation.into(),
                path,
                message: error.to_string(),
            }
        }

        pub fn runtime_unavailable(state: impl Into<String>, reason: impl Into<String>) -> Self {
            Self::RuntimeUnavailable {
                state: state.into(),
                reason: reason.into(),
            }
        }

        pub fn other(code: impl Into<String>, message: impl Into<String>) -> Self {
            Self::Other {
                code: code.into(),
                message: message.into(),
            }
        }
    }
}

pub mod quit {
    /// Mirrors `dsh_core::quit::QuitSkip`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum QuitSkip {
        InstallerRestart,
    }
}

pub mod protocol {
    use serde::{Deserialize, Serialize};

    /// Mirrors `dsh_core::protocol::QuitReason` (cases the install path uses).
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub enum QuitReason {
        User,
        Installer,
        Update,
        FatalRecovery,
        OsShutdown,
    }

    /// Mirrors `dsh_core::protocol::RuntimeState`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum RuntimeState {
        Idle,
        Starting,
        Ready,
        Failed,
        Stopped,
    }

    /// Mirrors `dsh_core::protocol::RuntimeStatus`.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct RuntimeStatus {
        pub state: RuntimeState,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub url: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub started_at: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub last_error: Option<String>,
    }

    /// Mirrors `dsh_core::protocol::SettingValue` (cases the updater paths read).
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(untagged)]
    pub enum SettingValue {
        Bool(bool),
        Number(f64),
        String(String),
        List(Vec<SettingValue>),
    }

    /// Mirrors `dsh_core::protocol::DesktopUpdatePhase`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum DesktopUpdatePhase {
        Idle,
        Checking,
        Available,
        Downloading,
        Verifying,
        Installing,
        Ready,
        Error,
    }

    /// Mirrors `dsh_core::protocol::DesktopUpdatePreparationFailureKind`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum DesktopUpdatePreparationFailureKind {
        StopFailed,
        TasksChanged,
        TasksUnavailable,
    }

    /// Mirrors `dsh_core::protocol::DesktopUpdateOperation`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "lowercase")]
    pub enum DesktopUpdateOperation {
        Check,
        Download,
        Install,
    }

    /// Mirrors `dsh_core::protocol::DesktopUpdateFailureKind`.
    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum DesktopUpdateFailureKind {
        Check,
        CheckNetwork,
        Download,
        DownloadNetwork,
        Install,
        InstallNetwork,
        StopFailed,
        TasksChanged,
        TasksUnavailable,
    }

    /// Mirrors `dsh_core::protocol::DesktopUpdateState`.
    #[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DesktopUpdateState {
        pub phase: DesktopUpdatePhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub technical_details: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub percent: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub failed_operation: Option<DesktopUpdateOperation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub preparation_failure: Option<DesktopUpdatePreparationFailureKind>,
    }

    /// Mirrors `dsh_core::protocol::DesktopUpdatePresentation`.
    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DesktopUpdatePresentation {
        pub phase: DesktopUpdatePhase,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub version: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub percent: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub failure: Option<DesktopUpdateFailureKind>,
    }
}
