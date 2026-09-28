//! The single `DshError` taxonomy of `docs/contracts/tauri-contract.md`.
//!
//! Serialization is `{ "kind": ..., "detail": { ... } }` (`tag = "kind"`,
//! `content = "detail"`, snake_case variant names). The UI renders
//! `message`/`reason`/`operation` text verbatim and never renders `code` or
//! `message` from `Other` as the sole explanation of a known condition.

use serde::{Deserialize, Serialize};

/// Contract error taxonomy. Every fallible Tauri command returns `Result<T, DshError>`.
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error, PartialEq, Eq)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum DshError {
    /// The requested object does not exist (unknown session id, unknown setting key).
    #[error("unknown {entity}: {id}")]
    NotFound { entity: String, id: String },
    /// Caller supplied a value the domain rejects.
    #[error("invalid {field}: {reason}")]
    InvalidArgument { field: String, reason: String },
    /// An underlying OS or filesystem operation failed.
    #[error("{operation} failed: {message}")]
    Io {
        operation: String,
        path: Option<String>,
        message: String,
    },
    /// The dsh host process is not in a state that can serve the request.
    #[error("runtime unavailable ({state}): {reason}")]
    RuntimeUnavailable { state: String, reason: String },
    /// The credential store refused or could not complete an operation.
    #[error("credential store {operation} failed: {message}")]
    CredentialStore { operation: String, message: String },
    /// A timed wait expired.
    #[error("{operation} timed out after {millis} ms")]
    Timeout { operation: String, millis: u64 },
    /// The operation was cancelled by the user.
    #[error("{operation} was cancelled")]
    Cancelled { operation: String },
    /// Anything else, with a stable machine code and a human message.
    #[error("{code}: {message}")]
    Other { code: String, message: String },
}

impl DshError {
    /// `NotFound` constructor.
    pub fn not_found(entity: impl Into<String>, id: impl Into<String>) -> Self {
        Self::NotFound {
            entity: entity.into(),
            id: id.into(),
        }
    }

    /// `InvalidArgument` constructor.
    pub fn invalid_argument(field: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::InvalidArgument {
            field: field.into(),
            reason: reason.into(),
        }
    }

    /// `Io` constructor carrying the operation, an optional path, and an underlying error.
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

    /// `RuntimeUnavailable` constructor.
    pub fn runtime_unavailable(state: impl Into<String>, reason: impl Into<String>) -> Self {
        Self::RuntimeUnavailable {
            state: state.into(),
            reason: reason.into(),
        }
    }

    /// `CredentialStore` constructor.
    pub fn credential_store(operation: impl Into<String>, message: impl Into<String>) -> Self {
        Self::CredentialStore {
            operation: operation.into(),
            message: message.into(),
        }
    }

    /// `Timeout` constructor.
    pub fn timeout(operation: impl Into<String>, millis: u64) -> Self {
        Self::Timeout {
            operation: operation.into(),
            millis,
        }
    }

    /// `Cancelled` constructor.
    pub fn cancelled(operation: impl Into<String>) -> Self {
        Self::Cancelled {
            operation: operation.into(),
        }
    }

    /// `Other` constructor with a stable machine code.
    pub fn other(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Other {
            code: code.into(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_as_tagged_object() {
        let error = DshError::not_found("setting", "missing.key");
        let json = serde_json::to_string(&error).expect("serialize");
        assert_eq!(
            json,
            r#"{"kind":"not_found","detail":{"entity":"setting","id":"missing.key"}}"#
        );
    }

    #[test]
    fn io_path_is_optional_and_round_trips() {
        let with_path = DshError::io("read", Some("C:\\a b\\c.txt".to_string()), &"boom");
        let without_path = DshError::io("read", None, &"boom");
        for error in [with_path, without_path] {
            let json = serde_json::to_string(&error).expect("serialize");
            let back: DshError = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, error);
        }
    }

    #[test]
    fn display_never_carries_the_tag_shape() {
        let error = DshError::timeout("desktop quit: inspection", 2000);
        assert_eq!(
            error.to_string(),
            "desktop quit: inspection timed out after 2000 ms"
        );
    }
}
