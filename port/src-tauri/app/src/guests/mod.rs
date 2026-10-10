//! Native guest views — the Rust/Tauri half of the Sidebar Browser guest and
//! the embedded Platform document, ported from the reference Electron shell.
//!
//! Reference behaviour, read verbatim before this module was written:
//!
//! * `_upstream/apps/desktop/src/browser-guests.ts` — main-process ownership,
//!   fixed isolation policy, per-workspace storage partitions, navigation and
//!   popup policy, permission denial, teardown.
//! * `_upstream/apps/desktop/src/platform-view.ts` — the account-scoped
//!   Platform document, its sanitized persistent storage, injected client
//!   headers, bootstrap credentials and cleanup-on-open/close.
//! * `_upstream/packages/client/ui-sidebar-browser/src/client/electron/` —
//!   the retained UI contract this module must feed (`ElectronWebViewImpl`,
//!   `ElectronWebviewPresentation`).
//! * `_upstream/packages/client/ui-settings-account/src/client/PlatformOverlay.tsx`
//!   — `dshPlatform.open/setBounds/close`.
//!
//! ## Current gate
//!
//! Native guests remain disabled (`GuestViews::new(false, false)` is what
//! `AppState` installs, and `host::install` grants no admission). The document
//! observations this module publishes are now produced from real WebView2
//! events rather than assumed, but they are **not** native-qualified: no run of
//! this port against a live WebView2 has been recorded, the Platform credential
//! hooks still have no acknowledgement, and permission / request / popup
//! behaviour has only ever been exercised by pure tests. These unit tests do not
//! authorize activation.
//!
//! ## What this module is, exactly
//!
//! [`registry`] is presentation **state and policy**, testable without a
//! window: lease identity, workspace partitions, the Platform generation,
//! navigation policy, placement epochs and ordered teardown. [`host`] owns the
//! live child webviews on the application's main thread and performs those
//! decisions through [`native`]. [`observation`] turns WebView2's document
//! events into [`GuestBrowserState`] and owns the generation that decides which
//! callback may still publish. [`geometry`] and [`partition`] are the two pure
//! derivations every layer shares.
//!
//! ## Isolation invariant (must not be weakened)
//!
//! A guest document receives no desktop authority. Child webviews are created
//! with their own WebView2 data directory (their storage jar is never the
//! application's), with no Tauri IPC initialization script, and with download,
//! popup, extension, zoom and devtools behaviour denied explicitly rather than
//! inherited from WebView2 defaults. The ACL grants nothing to any webview other
//! than `main`, so even the `window.ipc` object WebView2 always injects carries
//! zero authority; nothing here grants a guest `invoke`, `dshDesktop`,
//! `__DSH_BOOT_READY__` or any main-shell power.

pub mod commands;
pub mod geometry;
pub mod host;
pub mod native;
pub mod observation;
mod orchestration;
pub mod partition;
pub mod policy;
pub mod registry;
pub mod webview2_guard;

pub use registry::{BROWSER_PARTITION_PREFIX, PLATFORM_PARTITION_PREFIX};

/// Lease identity of one browser guest reservation.
///
/// The client treats this as an opaque branded string
/// (`Branded<'DesktopBrowserLeaseId'>` upstream). It doubles as the guest's
/// stable view label, so `guest_*` commands can name one child view without
/// exposing anything else about it to the renderer.
pub type BrowserLeaseId = String;

/// One browser guest's observed state, as the client's navigation adapter needs
/// it to reproduce the preserved `<webview>` element events.
///
/// This is the one typed schema of the guest state: the payload of
/// `dsh://guests/browser-state`, the response of `guest_browser_state`, the
/// registry's mirror of the last observation, and
/// [`observation::GuestDocumentObservation::state`] are all this type. The field
/// names and their camelCase wire spelling are frozen with the bridge owner
/// (`port/ui/desktop-bridge/guests.ts` `GuestBrowserStateEvent`, which also
/// reads the same object back from `guest_browser_state`).
///
/// Every field is a native observation ([`observation`] names the WebView2 event
/// behind each one); nothing here is inferred from what the client asked for,
/// and a guest that has not reported yet has no state at all rather than a
/// settled-looking default.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuestBrowserState {
    /// The guest's reservation.
    pub lease: String,
    /// Current document address, as `NavigationStarting` or
    /// `ICoreWebView2::Source` reported it.
    pub url: String,
    /// Current document title, as `ICoreWebView2::DocumentTitle` reported it.
    pub title: String,
    /// Whether a navigation is in flight.
    pub loading: bool,
    /// Whether `ICoreWebView2::CanGoBack` reports a backward entry.
    pub can_go_back: bool,
    /// Whether `ICoreWebView2::CanGoForward` reports a forward entry.
    pub can_go_forward: bool,
    /// Whether the guest lost its document.
    pub gone: bool,
    /// Main-frame load failure for the current document, if any.
    pub error: Option<GuestBrowserFailure>,
}

/// One main-frame load failure in the payload shape the client consumes.
#[derive(Debug, Clone, serde::Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GuestBrowserFailure {
    /// `COREWEBVIEW2_WEB_ERROR_STATUS` value reported for the failure.
    ///
    /// WebView2's own status, not Chromium's negative `net::Error` value: the
    /// pinned SDK publishes no mapping between them, so the port reports the
    /// value it observed. See [`observation::error_status_name`].
    pub code: i32,
    /// The SDK member name of that status.
    pub description: String,
}

// The guest wire names this port owes the client live in the TypeScript owner as
// the source of truth, and the Rust producer states the two it emits:
// `native::GUEST_BROWSER_STATE_EVENT` (one guest's observed document, emitted by
// `observation::TauriStateReporter`) and `native::GUEST_BROWSER_OPEN_EVENT` (an
// approved popup, emitted by `webview2_guard::deliver`). The same applies to the
// `data-sidebar-browser-frame` marker attribute: this port installs no native
// <webview> host, so it has no producer or consumer for that attribute on the
// Rust side.
