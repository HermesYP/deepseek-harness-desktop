//! Native guest surfaces for the Tauri port.
//!
//! Declared with `#[path = "guests.rs"]` from the crate root, so this file is
//! the module root while [`mod.rs`] carries the layer documentation and the
//! wire payloads.
//!
//! Layers, outermost first:
//!
//! 1. [`inner::commands`] — the `#[tauri::command]` surface the bridge calls. Every one
//!    takes the invoking `WebviewWindow` and refuses a document the shell does
//!    not own (`app::is_owned_application_window`).
//! 2. [`inner::native`] — the only place that talks to Tauri/WebView2: creating child
//!    webviews with their own data directory and their explicit navigation,
//!    popup, download and settings policy, placing them, navigating them and
//!    destroying them.
//! 3. [`inner::observation`] — the only place that turns WebView2's own document
//!    events into the guest state the client reads, with the per-carrier
//!    generation that refuses a stale callback.
//! 4. [`inner::registry`] / [`inner::policy`] / [`inner::geometry`] / [`inner::partition`] — ownership,
//!    policy and geometry, unit-testable without a window.
//!
//! Running this module's tests needs no window and no WebView2: `cargo test -p
//! dsh-desktop guests::` exercises the observation producer, the policy and the
//! lifecycle only. The WebView2 registrations themselves are native
//! qualification, not unit coverage.

#[path = "guests/mod.rs"]
pub mod inner;

pub use inner::commands;
pub use inner::host::MainThreadGuests;
pub use inner::registry::GuestViews;
