//! The production updater modules, included from their real source paths.
//!
//! `#[path]` here is resolved relative to this file's directory (`src/`), so
//! these entries always name the shipped files. Editing a production module
//! therefore changes what the probe compiles, with no copy step and no chance
//! of the two drifting.

/// `app/src/update_security.rs` — packaged trust, feed policy, Ed25519
/// verification over the maintained `ring` implementation, and the
/// check-schedule policy.
#[path = "../../../src-tauri/app/src/update_security.rs"]
pub mod update_security;

/// `app/src/update_schedule.rs` — the monotonic check runner that drives the
/// policy above.
#[path = "../../../src-tauri/app/src/update_schedule.rs"]
pub mod update_schedule;

/// `app/src/mandatory_update.rs` — the mandatory-update decision, its polling,
/// and the release-satisfaction gate.
#[path = "../../../src-tauri/app/src/mandatory_update.rs"]
pub mod mandatory_update;

/// `app/src/update_flow.rs` — check, confirmation, download, and installation.
#[path = "../../../src-tauri/app/src/update_flow.rs"]
pub mod update_flow;
