//! The updater half of `app/src/state.rs`, included from the production file.
//!
//! `update_flow.rs` calls `crate::state::{artifact_file_name, format_message,
//! UPDATE_CHANNEL_KEY, UpdateCandidate, UpdateFlight}` and drives
//! `UpdateService` (candidate identity, flight ownership, download episodes).
//! Those declarations live in the production `app/src/state_update.rs`, which
//! this module includes verbatim, so the probe drives the shipped type rather
//! than a re-declaration of it.
//!
//! Everything else `state.rs` owns (locale dictionaries, credential store,
//! shortcut engine, the full `AppState`) is bound to the probe's shell
//! stand-in, because the production versions need an OS keyring, a real Tauri
//! window, and `dsh-gateway`.

#[path = "../../../src-tauri/app/src/state_update.rs"]
mod production;

pub use production::*;

pub use crate::host::{format_message, messages, AppState, UPDATE_CHANNEL_KEY};
