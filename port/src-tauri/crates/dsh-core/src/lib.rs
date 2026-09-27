//! `dsh-core` — the Rust application core of the DeepSeek Harness desktop port.
//!
//! Owns: Harness-home and desktop paths, the versioned atomic settings store,
//! OS-backed credential storage, structured diagnostics and crash reports,
//! cancellation, the single-instance lock, the quit model, the shortcut
//! configuration engine (`keybindings.json`, K1–K3), and every protocol type of
//! `docs/contracts/tauri-contract.md`.

pub mod cancel;
pub mod credentials;
pub mod diagnostics;
pub mod error;
pub mod paths;
pub mod profile;
pub mod protocol;
pub mod quit;
pub mod settings;
pub mod shortcuts;
pub mod single_instance;

pub use cancel::CancellationToken;
pub use credentials::{CredentialStore, KeyringBackend, SecretBackend};
pub use error::DshError;
pub use paths::{AppPaths, DesktopPaths};
pub use protocol::PROTOCOL_GENERATION;
