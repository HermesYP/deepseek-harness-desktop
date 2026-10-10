//! One guest document's native observations, and the ownership rule that lets
//! exactly one live carrier publish them.
//!
//! The retained client drives a Browser tab through the `<webview>` element
//! surface, whose getters (`getURL`, `getTitle`, `canGoBack`, `canGoForward`,
//! `isLoading`) answered from Chromium's own state. `frame.ts` reproduces that
//! surface, but it can only repeat what the shell observed: without a producer
//! the element answers from its initial values forever. This module is that
//! producer.
//!
//! ## Every published field is read from WebView2
//!
//! | Payload field | Observation |
//! | --- | --- |
//! | `url` | `NavigationStarting::Uri`, or `ICoreWebView2::Source` for a source change and for a completed navigation — including the address an error page was loaded at |
//! | `title` | `ICoreWebView2::DocumentTitle` on `DocumentTitleChanged` |
//! | `loading` | `NavigationStarting` starts it, `NavigationCompleted` ends it |
//! | `canGoBack` / `canGoForward` | `ICoreWebView2::CanGoBack` / `CanGoForward` on `HistoryChanged` |
//! | `error` | `NavigationCompleted::IsSuccess` / `WebErrorStatus` |
//! | `gone` | `ProcessFailed` |
//!
//! [`GuestDocumentObservation`] holds those fields and is a pure state machine:
//! every transition is a function of one native observation, so the producer is
//! testable without a window. [`ObservationSink`] owns the generation that
//! decides whether a callback may still publish, and reports the complete state
//! to the application client through `dsh://guests/browser-state`.
//!
//! No field is ever inferred from what the client asked for. A document that has
//! not been observed yet has no state at all ([`GuestDocumentObservation::state`]
//! answers `None`), which is what keeps `guest_browser_state` from answering
//! with a settled-looking default.
//!
//! ## Generation ownership
//!
//! WebView2 retains every registered handler until the child webview is
//! destroyed, so a callback can still run while — or after — the port retires
//! its carrier. Every callback therefore captures the generation
//! [`ObservationSink::generation`] reported when it was registered, and
//! [`ObservationSink::observe`] refuses an observation from any other
//! generation. [`ObservationSink::retire`] advances the generation, which drops
//! every pending frame of the carrier it belonged to; the last published state
//! is refused from then on, because it is stamped with the retired generation.
//! The same call refuses a callback whose child webview is no longer reachable
//! by label, so a retired lease cannot publish and no observation can resurrect
//! one.
//!
//! The generation is deliberately **not** part of the payload: the guest state
//! event is a frozen eight-field schema (`port/ui/desktop-bridge/protocol.ts`,
//! `readStateEvent`). Ownership is a Rust-side decision; the wire carries only
//! what was observed.
//!
//! ## Teardown order
//!
//! [`dispose_carrier`] is the one teardown path: retire the generation (drop
//! pending frames), await the hide, then release. A failed hide does not cancel
//! the release — the release result is still awaited — and the hide refusal is
//! reported first, because a guest that could not be hidden must not be left
//! running.
//!
//! The two facts are reported apart ([`CarrierRelease`]) because a teardown has
//! to know whether the native child is *gone*: only a confirmed release lets the
//! identity that named the child be dropped. [`retry_pending_releases`] is the
//! matching retry rule for the identities a refused — or never-run — teardown
//! left behind, and `guests::native` keeps every one of them owned until a
//! release is confirmed.
//!
//! ## What this module does not do
//!
//! * **In-page navigation is reported as a URL change, not as its own event.**
//!   The port observes `SourceChanged`, so an in-page navigation (a fragment
//!   change, a `history.pushState`) updates `url`, and the `HistoryChanged` it
//!   causes updates `canGoBack`/`canGoForward`. The frozen payload has no field
//!   that distinguishes an in-page navigation from a document navigation, and
//!   `port/ui/native-guests/src/frame.ts` raises `did-navigate` for a URL change
//!   only. The preserved `ElectronWebViewImpl` also listens for
//!   `did-navigate-in-page`; this port cannot raise it, and adding an optional
//!   payload field to make that possible is a change to the bridge-owned schema,
//!   not to this module.
//! * **`clear-history` has no per-document native operation.** The pinned
//!   WebView2 interface publishes no clear-history member on `ICoreWebView2`
//!   (`webview2-com-sys 0.38.2` publishes `HistoryChanged`, `CanGoBack`,
//!   `CanGoForward` and `add_/remove_HistoryChanged` only;
//!   `ICoreWebView2Profile::ClearBrowsingDataAsync` is profile-wide and would
//!   destroy every other tab's history in the same workspace partition).
//!   `registry::command_browser` therefore keeps refusing it with
//!   `browser_history_unavailable`, and the inert `about:blank#<lease>` seed
//!   remains the first history entry — which this module reports truthfully
//!   through `canGoBack` rather than hiding.
//! * **The error code is the WebView2 status, not Chromium's net error.** The
//!   pinned SDK publishes `COREWEBVIEW2_WEB_ERROR_STATUS` and no mapping onto
//!   Chromium's negative `net::Error` values, so an unqualified translation
//!   would be invented. [`error_status_name`] returns the SDK's own member name,
//!   and the completed navigation the reference ignores as `ERR_ABORTED`
//!   (`code === -3`) is filtered here as `OPERATION_CANCELED`, so a canceled
//!   navigation never reaches the client as a failure.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use dsh_core::error::DshError;

use super::{GuestBrowserFailure, GuestBrowserState};

/// Stable machine code of a shell that cannot observe a guest document.
///
/// The non-Windows registration path reports it, so a Windows build compiles it
/// without referencing it; it is part of this module's refusal contract on every
/// platform.
#[cfg_attr(windows, allow(dead_code))]
pub const GUEST_OBSERVATION_UNAVAILABLE: &str = "guest_observation_unavailable";

/// `COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED` as
/// `webview2-com-sys 0.38.2` publishes it (`bindings.rs:906`).
///
/// WebView2's form of the aborted navigation Electron reports as `ERR_ABORTED`
/// (`-3`), which the preserved `ElectronWebViewImpl` filters instead of
/// reporting a failure. The value is stated here rather than imported so the
/// pure producer stays testable on every platform; the Windows-only test below
/// pins it against the pinned SDK constant.
pub const OPERATION_CANCELED_STATUS: i32 = 14;

/// `COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN` (`bindings.rs:910`).
pub const UNKNOWN_STATUS: i32 = 0;

/// The status name WebView2 publishes for one `COREWEBVIEW2_WEB_ERROR_STATUS`.
///
/// The name is the SDK member without its `COREWEBVIEW2_WEB_ERROR_STATUS_`
/// prefix. It is reported verbatim because the pinned SDK publishes no mapping
/// onto Chromium's net-error strings, and a translation the port cannot support
/// would be a claim about a value it never observed.
///
/// @param status - the value `ICoreWebView2NavigationCompletedEventArgs::WebErrorStatus`
///   published.
/// @returns the member's name, or `"UNRECOGNIZED"` for a value outside the
///   pinned enum.
pub fn error_status_name(status: i32) -> &'static str {
    match status {
        UNKNOWN_STATUS => "UNKNOWN",
        1 => "CERTIFICATE_COMMON_NAME_IS_INCORRECT",
        2 => "CERTIFICATE_EXPIRED",
        3 => "CLIENT_CERTIFICATE_CONTAINS_ERRORS",
        4 => "CERTIFICATE_REVOKED",
        5 => "CERTIFICATE_IS_INVALID",
        6 => "SERVER_UNREACHABLE",
        7 => "TIMEOUT",
        8 => "ERROR_HTTP_INVALID_SERVER_RESPONSE",
        9 => "CONNECTION_ABORTED",
        10 => "CONNECTION_RESET",
        11 => "DISCONNECTED",
        12 => "CANNOT_CONNECT",
        13 => "HOST_NAME_NOT_RESOLVED",
        OPERATION_CANCELED_STATUS => "OPERATION_CANCELED",
        15 => "REDIRECT_FAILED",
        16 => "UNEXPECTED_ERROR",
        17 => "VALID_AUTHENTICATION_CREDENTIALS_REQUIRED",
        18 => "VALID_PROXY_AUTHENTICATION_REQUIRED",
        _ => "UNRECOGNIZED",
    }
}

/// How one navigation ended, as WebView2 reported it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NavigationOutcome {
    /// The document committed.
    Committed,
    /// The navigation was canceled the way the reference ignores
    /// (`COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED`).
    Canceled,
    /// The navigation failed with the observed WebView2 status.
    Failed {
        /// `COREWEBVIEW2_WEB_ERROR_STATUS` value.
        status: i32,
        /// [`error_status_name`] of that value.
        description: String,
    },
    /// WebView2 reported a failure and no status could be read. Loading ends;
    /// no failure is claimed, because none was observed.
    UnobservedFailure,
}

/// Classify one `NavigationCompleted` from the two values it published.
///
/// @param is_success - `ICoreWebView2NavigationCompletedEventArgs::IsSuccess`.
/// @param status - `WebErrorStatus`, or `None` when the read failed.
/// @returns the outcome the document state records.
pub fn completion_outcome(is_success: bool, status: Option<i32>) -> NavigationOutcome {
    if is_success {
        return NavigationOutcome::Committed;
    }
    match status {
        Some(OPERATION_CANCELED_STATUS) => NavigationOutcome::Canceled,
        Some(status) => NavigationOutcome::Failed {
            status,
            description: error_status_name(status).to_string(),
        },
        None => NavigationOutcome::UnobservedFailure,
    }
}

/// Everything the port has observed about one guest document.
///
/// The fields are exactly the payload's observed fields; [`Self::state`] is the
/// only way they leave this type, and it answers `None` until a native
/// observation has arrived.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestDocumentObservation {
    lease: String,
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    gone: bool,
    error: Option<GuestBrowserFailure>,
    reported: bool,
}

impl GuestDocumentObservation {
    /// Start observing one guest's document.
    ///
    /// @param lease - the guest's reservation, which the payload carries back.
    /// @returns an observation that has reported nothing yet.
    pub fn new(lease: &str) -> Self {
        Self {
            lease: lease.to_string(),
            url: String::new(),
            title: String::new(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            gone: false,
            error: None,
            reported: false,
        }
    }

    /// The complete state as the wire carries it, or `None` when nothing has
    /// been observed yet.
    pub fn state(&self) -> Option<GuestBrowserState> {
        if !self.reported {
            return None;
        }
        Some(GuestBrowserState {
            lease: self.lease.clone(),
            url: self.url.clone(),
            title: self.title.clone(),
            loading: self.loading,
            can_go_back: self.can_go_back,
            can_go_forward: self.can_go_forward,
            gone: self.gone,
            error: self.error.clone(),
        })
    }

    /// Record `NavigationStarting`: a document navigation began.
    ///
    /// The address is the one WebView2 is about to commit, and any failure of
    /// the previous document is cleared with it because that document is being
    /// replaced.
    ///
    /// @param url - `ICoreWebView2NavigationStartingEventArgs::Uri`.
    pub fn navigation_started(&mut self, url: &str) {
        self.url = url.to_string();
        self.loading = true;
        self.error = None;
        self.reported = true;
    }

    /// Record `SourceChanged`: the document's address moved.
    ///
    /// Covers both a new document and an in-page navigation; see the module
    /// documentation for why the payload cannot name the difference.
    ///
    /// @param url - `ICoreWebView2::Source` at the change.
    pub fn source_changed(&mut self, url: &str) {
        self.url = url.to_string();
        self.reported = true;
    }

    /// Record `DocumentTitleChanged`.
    ///
    /// @param title - `ICoreWebView2::DocumentTitle`. A document that publishes
    ///   no title reports the empty string, which is the observed title.
    pub fn title_changed(&mut self, title: &str) {
        self.title = title.to_string();
        self.reported = true;
    }

    /// Record `HistoryChanged`.
    ///
    /// @param can_go_back - `ICoreWebView2::CanGoBack`.
    /// @param can_go_forward - `ICoreWebView2::CanGoForward`.
    pub fn history_changed(&mut self, can_go_back: bool, can_go_forward: bool) {
        self.can_go_back = can_go_back;
        self.can_go_forward = can_go_forward;
        self.reported = true;
    }

    /// Record `NavigationCompleted`.
    ///
    /// @param url - `ICoreWebView2::Source` read at completion, or `None` when
    ///   the read failed. A failed navigation leaves the observed address in
    ///   place: it is the address the error page was loaded at, and the port
    ///   reports what the runtime shows rather than the address it requested.
    /// @param outcome - [`completion_outcome`] of the two published values.
    pub fn navigation_completed(&mut self, url: Option<&str>, outcome: NavigationOutcome) {
        if let Some(url) = url {
            self.url = url.to_string();
        }
        self.loading = false;
        self.error = match outcome {
            // A committed document has no failure, and a canceled navigation is
            // the one the reference ignores rather than reports.
            NavigationOutcome::Committed | NavigationOutcome::Canceled => None,
            NavigationOutcome::Failed {
                status,
                description,
            } => Some(GuestBrowserFailure {
                code: status,
                description,
            }),
            NavigationOutcome::UnobservedFailure => None,
        };
        self.reported = true;
    }

    /// Record `ProcessFailed`: the document is gone.
    ///
    /// Terminal for this carrier: the retained client drops its guest on
    /// `render-process-gone`, so nothing later in this carrier's life clears it,
    /// and the history flags are left exactly as last observed rather than
    /// asserted to have vanished.
    pub fn process_failed(&mut self) {
        self.gone = true;
        self.loading = false;
        self.reported = true;
    }
}

/// Identity of one live guest carrier's observations.
///
/// Cloned into every registered callback; shared with the sink that retires it.
#[derive(Debug, Clone, Default)]
pub struct LeaseGeneration(Arc<AtomicU64>);

impl LeaseGeneration {
    /// The generation a callback registered now must present.
    pub fn current(&self) -> u64 {
        self.0.load(Ordering::Acquire)
    }

    /// Retire every callback registered before this call.
    ///
    /// @returns the generation that is no longer current.
    pub fn retire(&self) -> u64 {
        self.0.fetch_add(1, Ordering::AcqRel)
    }

    /// Whether a callback that captured `generation` still owns this carrier.
    pub fn is_current(&self, generation: u64) -> bool {
        self.current() == generation
    }
}

/// Delivery of one observed state to the application client.
pub trait StateReporter: Send + Sync {
    /// @param state - the complete observed document state.
    fn report(&self, state: &GuestBrowserState);
}

/// Whether the carrier a sink observes is still reachable.
///
/// The label lookup is the port's liveness proof: Tauri's manager answers a
/// label only while the child webview exists, and `guests::native` removes it in
/// the same main-thread batch that closes it.
pub trait CarrierLiveness: Send + Sync {
    /// @param label - the child webview label of the guest.
    /// @returns whether that child is still reachable.
    fn is_live(&self, label: &str) -> bool;
}

/// What one observation did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PublishOutcome {
    /// The state was stored and reported.
    Published,
    /// The carrier was retired; the observation is dropped.
    StaleGeneration,
    /// The child webview is no longer reachable; the observation is dropped.
    CarrierGone,
    /// Another frame holds the observation, so this one is dropped rather than
    /// waited on.
    FramePending,
    /// Nothing has been observed yet, so there is no complete state to report.
    NothingObserved,
}

/// The production reporter: one Tauri event per observation.
///
/// The event name is the guest wire name and the payload is
/// [`GuestBrowserState`] itself, so the Rust producer and the client reader
/// cannot drift apart without failing the schema test below.
pub struct TauriStateReporter {
    app: tauri::AppHandle<tauri::Wry>,
}

impl TauriStateReporter {
    /// @param app - the application handle the event is emitted through.
    pub fn new(app: tauri::AppHandle<tauri::Wry>) -> Self {
        Self { app }
    }
}

impl StateReporter for TauriStateReporter {
    fn report(&self, state: &GuestBrowserState) {
        use tauri::Emitter;
        if let Err(error) = self
            .app
            .emit(super::native::GUEST_BROWSER_STATE_EVENT, state)
        {
            tracing::warn!(
                target: "dsh::guests",
                error = %error,
                lease = %state.lease,
                "a guest state report could not be emitted"
            );
        }
    }
}

/// The application's carrier liveness: the label is reachable while the child
/// webview exists.
pub struct TauriCarrier {
    app: tauri::AppHandle<tauri::Wry>,
}

impl TauriCarrier {
    /// @param app - the application handle the child webviews are registered in.
    pub fn new(app: tauri::AppHandle<tauri::Wry>) -> Self {
        Self { app }
    }
}

impl CarrierLiveness for TauriCarrier {
    fn is_live(&self, label: &str) -> bool {
        use tauri::Manager;
        self.app.get_webview(label).is_some()
    }
}

/// The state published while it was stamped by the current generation.
#[derive(Debug)]
struct StoredObservation {
    generation: u64,
    observation: GuestDocumentObservation,
}

/// Where one guest's native observations are applied and published.
///
/// One sink per live child webview. It is cloned into each registered WebView2
/// handler, which is why it holds only `Arc`s and owned values.
#[derive(Clone)]
pub struct ObservationSink {
    label: String,
    generation: LeaseGeneration,
    stored: Arc<Mutex<StoredObservation>>,
    carrier: Arc<dyn CarrierLiveness>,
    reporter: Arc<dyn StateReporter>,
}

impl ObservationSink {
    /// @param lease - the guest's reservation; the payload carries it back.
    /// @param label - the child webview label, for the liveness check.
    /// @param carrier - whether the child webview is still reachable.
    /// @param reporter - where a complete state is reported.
    pub fn new(
        lease: &str,
        label: &str,
        carrier: Arc<dyn CarrierLiveness>,
        reporter: Arc<dyn StateReporter>,
    ) -> Self {
        let generation = LeaseGeneration::default();
        let stored = StoredObservation {
            generation: generation.current(),
            observation: GuestDocumentObservation::new(lease),
        };
        Self {
            label: label.to_string(),
            generation,
            stored: Arc::new(Mutex::new(stored)),
            carrier,
            reporter,
        }
    }

    /// A sink for one guest of the running application.
    ///
    /// @param app - the application handle the report is emitted through and the
    ///   child webview is looked up in.
    /// @param lease - the guest's reservation.
    /// @param label - the child webview label.
    pub fn for_tauri(app: &tauri::AppHandle<tauri::Wry>, lease: &str, label: &str) -> Self {
        Self::new(
            lease,
            label,
            Arc::new(TauriCarrier::new(app.clone())),
            Arc::new(TauriStateReporter::new(app.clone())),
        )
    }

    /// The child webview label this sink observes.
    ///
    /// Test-only: production names a carrier through `native::browser_label` (or
    /// the Platform label), the same derivation the sink was built from, so no
    /// production path needs the sink to repeat its own label.
    #[cfg(test)]
    pub fn label(&self) -> &str {
        &self.label
    }

    /// The generation a callback registered now must present.
    pub fn generation(&self) -> u64 {
        self.generation.current()
    }

    /// Apply one native observation and report the resulting complete state.
    ///
    /// @param generation - the value [`Self::generation`] returned when the
    ///   callback was registered.
    /// @param transition - the one observation to apply.
    /// @returns what became of it; nothing is reported unless it was
    ///   [`PublishOutcome::Published`].
    pub fn observe(
        &self,
        generation: u64,
        transition: impl FnOnce(&mut GuestDocumentObservation),
    ) -> PublishOutcome {
        if !self.generation.is_current(generation) {
            return PublishOutcome::StaleGeneration;
        }
        if !self.carrier.is_live(&self.label) {
            return PublishOutcome::CarrierGone;
        }
        // A contended lock means another frame owns the model. Waiting would
        // stall the WebView2 UI thread for a state nobody is blocked on, so the
        // frame is dropped.
        let Ok(mut stored) = self.stored.try_lock() else {
            return PublishOutcome::FramePending;
        };
        transition(&mut stored.observation);
        let Some(state) = stored.observation.state() else {
            return PublishOutcome::NothingObserved;
        };
        stored.generation = generation;
        drop(stored);
        self.reporter.report(&state);
        PublishOutcome::Published
    }

    /// The last state this sink published, or `None` when nothing has been
    /// observed or the carrier has been retired.
    pub fn observed(&self) -> Option<GuestBrowserState> {
        let stored = self.stored.try_lock().ok()?;
        if !self.generation.is_current(stored.generation) {
            return None;
        }
        stored.observation.state()
    }

    /// Retire this carrier's observations: every callback registered before now
    /// is refused, and the last published state stops being readable.
    pub fn retire(&self) {
        self.generation.retire();
    }
}

/// One native carrier's placement and teardown.
///
/// Stated as a trait so the teardown order is a property of this module rather
/// than of the code that happens to call `Webview` today.
pub trait GuestCarrier {
    /// Hide the guest without releasing it.
    fn hide(&mut self) -> Result<(), DshError>;
    /// Release the guest's native document.
    fn release(&mut self) -> Result<(), DshError>;
}

/// What one carrier's disposal did.
///
/// The two facts are kept apart because a caller acts on them differently: the
/// refusal is the alarming report — a hide that failed first, then a release —
/// while [`Self::released`] is the only thing that decides whether the native
/// child is gone, and therefore whether the identity that named it may be
/// dropped. A refused hide with a confirmed release reports both: the guest must
/// not be left running, and nothing is left to own.
#[derive(Debug)]
pub struct CarrierRelease {
    /// The first refusal of the disposal, hide before release.
    pub refusal: Option<DshError>,
    /// Whether the native release itself was confirmed.
    pub released: bool,
}

/// Tear one guest carrier down in the order that keeps a retired document from
/// publishing or reappearing.
///
/// The generation is retired first, so no pending frame of this carrier can
/// publish after the guest starts going away; the hide is awaited next; the
/// release is always awaited after it. A failed hide does not cancel the
/// release, and its refusal is reported ahead of the release's because a guest
/// that could not be hidden is the more alarming of the two.
///
/// @param sink - the carrier's observations.
/// @param carrier - the native carrier.
/// @returns the hide refusal before the release's, and whether the release was
///   confirmed.
pub fn dispose_carrier<C: GuestCarrier>(sink: &ObservationSink, carrier: &mut C) -> CarrierRelease {
    sink.retire();
    let hidden = carrier.hide();
    let released = carrier.release();
    let confirmed = released.is_ok();
    let refusal = hidden.err().or_else(|| released.err());
    CarrierRelease {
        refusal,
        released: confirmed,
    }
}

/// Retry every release that has not been confirmed.
///
/// Used by the native teardown path, where a release that failed — or a main-loop
/// round trip that was cancelled before it ran — leaves a native child behind.
/// The caller keeps every identity this returns as still unconfirmed, so a later
/// attempt retries it and no native handle is abandoned.
///
/// @param pending - identities whose release is unconfirmed, retried and consumed
///   in this order.
/// @param release - one release attempt per identity; `Ok` confirms the release.
/// @returns the first refusal, and the identities that are still unconfirmed —
///   the caller owns them again, in the order they were attempted.
pub fn retry_pending_releases<T>(
    pending: Vec<T>,
    mut release: impl FnMut(&T) -> Result<(), DshError>,
) -> (Option<DshError>, Vec<T>) {
    let mut first_error = None;
    let mut still_pending = Vec::new();
    for identity in pending {
        if let Err(error) = release(&identity) {
            if first_error.is_none() {
                first_error = Some(error);
            }
            still_pending.push(identity);
        }
    }
    (first_error, still_pending)
}

/// Register every document observation on one child webview.
///
/// `Webview::with_webview` executes its closure inline when it is called on the
/// application's main thread (`tauri-runtime-wry-2.11.4/src/lib.rs:239-248`),
/// which is where `guests::native` runs. `guests::native` therefore calls this
/// before `webview2_guard::install`, so every observation is registered before
/// the policy registration requests the guest's first document. A registration
/// that cannot report its outcome is refused rather than assumed: this port does
/// not leave a guest running with only half of its native contract.
///
/// @param webview - the child webview to observe.
/// @param sink - the carrier's observations.
/// @returns after every handler is registered.
/// @throws {DshError} `guest_observation_unavailable` on a platform with no
///   WebView2 to observe, or `guest_observation` when the runtime refuses a
///   registration or does not report one.
pub fn install(
    webview: &tauri::Webview<tauri::Wry>,
    sink: &ObservationSink,
) -> Result<(), DshError> {
    #[cfg(windows)]
    {
        let sink = sink.clone();
        super::native::ui_thread::call(webview, move |core| {
            // SAFETY: `ui_thread::call` runs the closure on the WebView2 UI
            // thread, which owns the controller the observation is registered on.
            unsafe { webview2::install_document_observation(core, &sink) }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, sink);
        Err(DshError::other(
            GUEST_OBSERVATION_UNAVAILABLE,
            "guest document observations are implemented only against WebView2",
        ))
    }
}

/// WebView2 registrations, on the UI thread's apartment.
#[cfg(windows)]
mod webview2 {
    use webview2_com::{
        DocumentTitleChangedEventHandler, HistoryChangedEventHandler,
        Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
        NavigationStartingEventHandler, ProcessFailedEventHandler, SourceChangedEventHandler,
    };
    use windows::core::{BOOL, PWSTR};

    use super::{completion_outcome, ObservationSink};

    /// Read `ICoreWebView2::Source`.
    ///
    /// @returns the observed address, or `None` when it could not be read — in
    ///   which case the caller keeps the address it already observed rather than
    ///   publishing an address it never saw.
    fn observed_source(webview: &ICoreWebView2) -> Option<String> {
        let mut uri = PWSTR::null();
        // SAFETY: the caller runs on the UI thread and owns `webview`; `uri` is
        // a local this function passes for the callee to fill.
        match unsafe { webview.Source(&mut uri) } {
            Ok(()) => Some(webview2_com::take_pwstr(uri)),
            Err(_) => None,
        }
    }

    /// Read both `CanGoBack` and `CanGoForward`.
    ///
    /// @returns the two observed values, or `None` when either read failed — in
    ///   which case no history claim is published.
    fn observed_history(webview: &ICoreWebView2) -> Option<(bool, bool)> {
        let mut back = BOOL::default();
        let mut forward = BOOL::default();
        // SAFETY: both calls are on the UI thread's own controller, and each
        // writes into a local `BOOL` this function owns.
        unsafe {
            webview.CanGoBack(&mut back).ok()?;
            webview.CanGoForward(&mut forward).ok()?;
        }
        Some((back.as_bool(), forward.as_bool()))
    }

    /// Read `ProcessFailed::ProcessFailedKind`.
    ///
    /// @returns the observed kind, which is diagnostic only, or `None` when it
    ///   could not be read.
    fn observed_process_failure_kind(args: &ICoreWebView2ProcessFailedEventArgs) -> Option<i32> {
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED;
        // SAFETY: the callback owns `args` on the UI thread, and `kind` is a local
        // this function passes for the callee to fill.
        unsafe { args.ProcessFailedKind(&mut kind).ok().map(|()| kind.0) }
    }

    /// Register every document observation and report each resulting state.
    ///
    /// # Safety
    ///
    /// Must run on the WebView2 UI thread inside `Webview::with_webview`. Every
    /// COM interface and handler created here is created, used and dropped on
    /// that one thread; the sink is `Send + Sync` and holds only `Arc`s and
    /// owned values.
    pub(super) unsafe fn install_document_observation(
        webview: &ICoreWebView2,
        sink: &ObservationSink,
    ) -> windows::core::Result<()> {
        let generation = sink.generation();
        install_navigation_starting(webview, sink.clone(), generation)?;
        install_source_changed(webview, sink.clone(), generation)?;
        install_document_title_changed(webview, sink.clone(), generation)?;
        install_history_changed(webview, sink.clone(), generation)?;
        install_navigation_completed(webview, sink.clone(), generation)?;
        install_process_failed(webview, sink.clone(), generation)
    }

    /// Observe the beginning of every document navigation.
    fn install_navigation_starting(
        webview: &ICoreWebView2,
        sink: ObservationSink,
        generation: u64,
    ) -> windows::core::Result<()> {
        let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            // SAFETY: this callback runs on the WebView2 UI thread and owns
            // `args`; `uri` is a local this closure passes for the callee to fill.
            match unsafe { args.Uri(&mut uri) } {
                Ok(()) => {
                    let url = webview2_com::take_pwstr(uri);
                    sink.observe(generation, |observation| {
                        observation.navigation_started(&url)
                    });
                }
                // An address that cannot be read is never replaced by a guess,
                // and no other field of the state is known to have moved.
                Err(error) => tracing::warn!(
                    target: "dsh::guests",
                    error = %error,
                    "a guest navigation start could not be read and is not reported"
                ),
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the caller runs on the UI thread and owns `webview`.
        unsafe { webview.add_NavigationStarting(&handler, &mut token) }
    }

    /// Observe every address the document's source moves to.
    fn install_source_changed(
        webview: &ICoreWebView2,
        sink: ObservationSink,
        generation: u64,
    ) -> windows::core::Result<()> {
        let handler = SourceChangedEventHandler::create(Box::new(move |webview, _args| {
            let Some(webview) = webview else {
                return Ok(());
            };
            let Some(url) = observed_source(&webview) else {
                tracing::warn!(
                    target: "dsh::guests",
                    "a guest source change could not be read and is not reported"
                );
                return Ok(());
            };
            sink.observe(generation, |observation| observation.source_changed(&url));
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the caller runs on the UI thread and owns `webview`.
        unsafe { webview.add_SourceChanged(&handler, &mut token) }
    }

    /// Observe every document title the guest publishes.
    fn install_document_title_changed(
        webview: &ICoreWebView2,
        sink: ObservationSink,
        generation: u64,
    ) -> windows::core::Result<()> {
        let handler = DocumentTitleChangedEventHandler::create(Box::new(move |webview, _args| {
            let Some(webview) = webview else {
                return Ok(());
            };
            let mut title = PWSTR::null();
            // SAFETY: the callback runs on the UI thread and owns `webview`;
            // `title` is a local this closure passes for the callee to fill.
            match unsafe { webview.DocumentTitle(&mut title) } {
                Ok(()) => {
                    let title = webview2_com::take_pwstr(title);
                    sink.observe(generation, |observation| observation.title_changed(&title));
                }
                Err(error) => tracing::warn!(
                    target: "dsh::guests",
                    error = %error,
                    "a guest document title could not be read and is not reported"
                ),
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the caller runs on the UI thread and owns `webview`.
        unsafe { webview.add_DocumentTitleChanged(&handler, &mut token) }
    }

    /// Observe every history change.
    fn install_history_changed(
        webview: &ICoreWebView2,
        sink: ObservationSink,
        generation: u64,
    ) -> windows::core::Result<()> {
        let handler = HistoryChangedEventHandler::create(Box::new(move |webview, _args| {
            let Some(webview) = webview else {
                return Ok(());
            };
            match observed_history(&webview) {
                Some((back, forward)) => {
                    sink.observe(generation, |observation| {
                        observation.history_changed(back, forward)
                    });
                }
                None => tracing::warn!(
                    target: "dsh::guests",
                    "a guest history change could not be read and is not reported"
                ),
            }
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the caller runs on the UI thread and owns `webview`.
        unsafe { webview.add_HistoryChanged(&handler, &mut token) }
    }

    /// Observe how every navigation ended.
    fn install_navigation_completed(
        webview: &ICoreWebView2,
        sink: ObservationSink,
        generation: u64,
    ) -> windows::core::Result<()> {
        let handler = NavigationCompletedEventHandler::create(Box::new(move |webview, args| {
            let Some(args) = args else { return Ok(()) };
            let mut success = BOOL::default();
            // SAFETY: the callback runs on the UI thread and owns `args`; each
            // read writes into a local this closure owns.
            let is_success = unsafe {
                match args.IsSuccess(&mut success) {
                    Ok(()) => success.as_bool(),
                    Err(error) => {
                        // Neither a success nor a failure may be claimed from a
                        // value that could not be read, so nothing is reported
                        // and the state keeps its last observation.
                        tracing::warn!(
                            target: "dsh::guests",
                            error = %error,
                            "a guest navigation result could not be read and is not reported"
                        );
                        return Ok(());
                    }
                }
            };
            let mut status = COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN;
            // SAFETY: as above.
            let status = unsafe { args.WebErrorStatus(&mut status).ok().map(|()| status.0) };
            let outcome = completion_outcome(is_success, status);
            let url = webview.as_ref().and_then(observed_source);
            sink.observe(generation, |observation| {
                observation.navigation_completed(url.as_deref(), outcome)
            });
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the caller runs on the UI thread and owns `webview`.
        unsafe { webview.add_NavigationCompleted(&handler, &mut token) }
    }

    /// Observe the loss of the guest's process.
    fn install_process_failed(
        webview: &ICoreWebView2,
        sink: ObservationSink,
        generation: u64,
    ) -> windows::core::Result<()> {
        let handler = ProcessFailedEventHandler::create(Box::new(move |_webview, args| {
            // The kind is diagnostic only: the payload carries that the document
            // is gone, and no field distinguishes how it was lost.
            let kind = args.as_ref().and_then(observed_process_failure_kind);
            sink.observe(generation, |observation| observation.process_failed());
            tracing::warn!(
                target: "dsh::guests",
                kind = ?kind,
                "a guest process failed; the document is reported gone"
            );
            Ok(())
        }));
        let mut token = 0i64;
        // SAFETY: the caller runs on the UI thread and owns `webview`.
        unsafe { webview.add_ProcessFailed(&handler, &mut token) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A reporter that records what the sink published.
    #[derive(Default)]
    struct Recorder {
        reported: Mutex<Vec<GuestBrowserState>>,
    }

    impl Recorder {
        fn states(&self) -> Vec<GuestBrowserState> {
            self.reported.lock().expect("recorder").clone()
        }
    }

    impl StateReporter for Recorder {
        fn report(&self, state: &GuestBrowserState) {
            self.reported.lock().expect("recorder").push(state.clone());
        }
    }

    /// A carrier whose liveness the test drives.
    struct Carrier {
        live: std::sync::atomic::AtomicBool,
    }

    impl Carrier {
        fn live() -> Arc<Self> {
            Arc::new(Self {
                live: std::sync::atomic::AtomicBool::new(true),
            })
        }

        fn departed(&self) {
            self.live.store(false, Ordering::Release);
        }
    }

    impl CarrierLiveness for Carrier {
        fn is_live(&self, _label: &str) -> bool {
            self.live.load(Ordering::Acquire)
        }
    }

    fn sink() -> (ObservationSink, Arc<Recorder>, Arc<Carrier>) {
        let reporter = Arc::new(Recorder::default());
        let carrier = Carrier::live();
        let sink = ObservationSink::new(
            "l-1",
            "guest-browser-l-1",
            carrier.clone(),
            reporter.clone(),
        );
        (sink, reporter, carrier)
    }

    fn expected(
        url: &str,
        title: &str,
        loading: bool,
        back: bool,
        forward: bool,
        gone: bool,
        error: Option<GuestBrowserFailure>,
    ) -> GuestBrowserState {
        GuestBrowserState {
            lease: "l-1".to_string(),
            url: url.to_string(),
            title: title.to_string(),
            loading,
            can_go_back: back,
            can_go_forward: forward,
            gone,
            error,
        }
    }

    /// Nothing is published before a native observation arrives, so a fresh
    /// guest cannot answer with a settled-looking default.
    #[test]
    fn a_document_that_has_not_reported_has_no_state() {
        let observation = GuestDocumentObservation::new("l-1");
        assert_eq!(observation.state(), None);
        let (sink, reporter, _carrier) = sink();
        assert_eq!(sink.observed(), None);
        assert_eq!(
            sink.observe(sink.generation(), |observation| {
                assert_eq!(observation.state(), None)
            }),
            PublishOutcome::NothingObserved
        );
        assert!(reporter.states().is_empty());
    }

    /// The whole published state is one complete snapshot per observation.
    #[test]
    fn every_observation_publishes_the_complete_state() {
        let (sink, reporter, _carrier) = sink();
        let generation = sink.generation();
        assert_eq!(
            sink.observe(generation, |observation| observation
                .navigation_started("about:blank#l-1")),
            PublishOutcome::Published
        );
        assert_eq!(
            reporter.states(),
            vec![expected(
                "about:blank#l-1",
                "",
                true,
                false,
                false,
                false,
                None
            )]
        );
        assert_eq!(
            sink.observe(generation, |observation| observation.navigation_completed(
                Some("https://example.com/a"),
                NavigationOutcome::Committed
            )),
            PublishOutcome::Published
        );
        let settled = expected(
            "https://example.com/a",
            "",
            false,
            false,
            false,
            false,
            None,
        );
        assert_eq!(reporter.states().last().expect("published"), &settled);
        assert_eq!(sink.observed(), Some(settled));
        assert_eq!(sink.label(), "guest-browser-l-1");
    }

    /// `loading` brackets a navigation: started, then finished.
    #[test]
    fn loading_follows_the_navigation_not_a_settled_default() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        assert!(observation.state().expect("observed").loading);
        observation
            .navigation_completed(Some("https://example.com/a"), NavigationOutcome::Committed);
        assert!(!observation.state().expect("observed").loading);
        // A failed navigation also ends loading, and reports the failure.
        observation.navigation_started("https://example.com/b");
        observation.navigation_completed(
            Some("https://example.com/b"),
            completion_outcome(false, Some(13)),
        );
        let state = observation.state().expect("observed");
        assert!(!state.loading);
        assert_eq!(
            state.error,
            Some(GuestBrowserFailure {
                code: 13,
                description: "HOST_NAME_NOT_RESOLVED".to_string()
            })
        );
    }

    /// The reference ignores an aborted navigation (`ERR_ABORTED`, `-3`) rather
    /// than reporting a failure; WebView2's form of it is `OPERATION_CANCELED`.
    #[test]
    fn a_canceled_navigation_is_not_a_reported_failure() {
        assert_eq!(
            completion_outcome(false, Some(OPERATION_CANCELED_STATUS)),
            NavigationOutcome::Canceled
        );
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        observation.navigation_completed(
            Some("https://example.com/a"),
            completion_outcome(false, Some(OPERATION_CANCELED_STATUS)),
        );
        let state = observation.state().expect("observed");
        assert!(!state.loading);
        assert_eq!(state.error, None);
    }

    /// An unreadable failure status ends loading without claiming a failure.
    #[test]
    fn an_unobserved_failure_claims_nothing() {
        assert_eq!(
            completion_outcome(false, None),
            NavigationOutcome::UnobservedFailure
        );
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        observation.navigation_completed(None, NavigationOutcome::UnobservedFailure);
        let state = observation.state().expect("observed");
        assert!(!state.loading);
        assert_eq!(state.error, None);
        // The address is the last one observed, not one invented for the failure.
        assert_eq!(state.url, "https://example.com/a");
    }

    /// The error's address is the one the runtime reported, which for a failed
    /// navigation is the address the error page was loaded at.
    #[test]
    fn the_error_address_is_the_observed_source() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/missing");
        observation.navigation_completed(
            Some("https://example.com/missing"),
            completion_outcome(false, Some(13)),
        );
        let state = observation.state().expect("observed");
        assert_eq!(state.url, "https://example.com/missing");
        assert_eq!(state.error.as_ref().map(|failure| failure.code), Some(13));
        // A completion whose source could not be read keeps the last observation
        // instead of replacing it with an address the port never saw.
        observation.navigation_started("https://example.com/next");
        observation.navigation_completed(None, NavigationOutcome::Committed);
        assert_eq!(
            observation.state().expect("observed").url,
            "https://example.com/next"
        );
    }

    /// A new navigation clears the previous document's failure.
    #[test]
    fn a_new_navigation_clears_the_previous_failure() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        observation.navigation_completed(
            Some("https://example.com/a"),
            completion_outcome(false, Some(13)),
        );
        assert!(observation.state().expect("observed").error.is_some());
        observation.navigation_started("https://example.com/b");
        assert_eq!(observation.state().expect("observed").error, None);
    }

    /// History flags are the two values WebView2 publishes, never derived from
    /// the address the port asked for.
    #[test]
    fn history_flags_are_the_observed_values() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.history_changed(true, false);
        let state = observation.state().expect("observed");
        assert!(state.can_go_back);
        assert!(!state.can_go_forward);
        observation.history_changed(false, true);
        let state = observation.state().expect("observed");
        assert!(!state.can_go_back);
        assert!(state.can_go_forward);
    }

    /// A title change publishes exactly the document's own title, including the
    /// empty one a document without a title publishes.
    #[test]
    fn a_title_is_the_document_title_or_the_empty_one_it_published() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.title_changed("Example Domain");
        assert_eq!(
            observation.state().expect("observed").title,
            "Example Domain"
        );
        observation.title_changed("");
        assert_eq!(observation.state().expect("observed").title, "");
    }

    /// A source change moves the address, and is the only observation an
    /// in-page navigation produces for the address.
    #[test]
    fn a_source_change_moves_the_address_and_keeps_everything_else() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        observation
            .navigation_completed(Some("https://example.com/a"), NavigationOutcome::Committed);
        observation.title_changed("A");
        observation.history_changed(false, false);
        observation.source_changed("https://example.com/a#section");
        observation.history_changed(true, false);
        let state = observation.state().expect("observed");
        assert_eq!(state.url, "https://example.com/a#section");
        assert_eq!(state.title, "A");
        assert!(!state.loading);
        assert_eq!(state.error, None);
        assert!(state.can_go_back);
    }

    /// A lost process is terminal for the carrier, and it does not assert
    /// anything about history that was not observed.
    #[test]
    fn a_failed_process_is_gone_and_keeps_the_observed_history() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        observation.history_changed(true, false);
        observation.process_failed();
        let state = observation.state().expect("observed");
        assert!(state.gone);
        assert!(!state.loading);
        assert!(state.can_go_back);
        assert!(!state.can_go_forward);
    }

    /// The whole status table is the pinned SDK's own enum.
    #[test]
    fn every_status_has_the_sdk_member_name() {
        for status in 0..=18 {
            assert_ne!(error_status_name(status), "UNRECOGNIZED", "{status}");
        }
        assert_eq!(error_status_name(UNKNOWN_STATUS), "UNKNOWN");
        assert_eq!(error_status_name(13), "HOST_NAME_NOT_RESOLVED");
        assert_eq!(
            error_status_name(OPERATION_CANCELED_STATUS),
            "OPERATION_CANCELED"
        );
        assert_eq!(error_status_name(i32::MAX), "UNRECOGNIZED");
    }

    /// The two status values this module states literally are the pinned SDK's.
    #[cfg(windows)]
    #[test]
    fn the_stated_status_values_are_the_pinned_sdk_constants() {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN,
        };
        assert_eq!(
            OPERATION_CANCELED_STATUS,
            COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED.0
        );
        assert_eq!(UNKNOWN_STATUS, COREWEBVIEW2_WEB_ERROR_STATUS_UNKNOWN.0);
    }

    /// The payload is the frozen eight-field camelCase schema the bridge reads.
    #[test]
    fn the_published_payload_is_the_frozen_wire_schema() {
        let mut observation = GuestDocumentObservation::new("l-1");
        observation.navigation_started("https://example.com/a");
        let json = serde_json::to_value(observation.state().expect("observed")).expect("serialize");
        let object = json.as_object().expect("an object");
        let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
        keys.sort_unstable();
        assert_eq!(
            keys,
            vec![
                "canGoBack",
                "canGoForward",
                "error",
                "gone",
                "lease",
                "loading",
                "title",
                "url"
            ],
            "the payload schema is frozen at exactly these eight camelCase fields"
        );
        // `error` is present and null when there is no failure: the client reads
        // it as a required field.
        assert_eq!(object.get("error"), Some(&serde_json::Value::Null));
        assert_eq!(
            object.get("lease").and_then(|value| value.as_str()),
            Some("l-1")
        );
        assert_eq!(object.get("loading"), Some(&serde_json::Value::Bool(true)));
        assert_eq!(
            object.get("canGoBack"),
            Some(&serde_json::Value::Bool(false))
        );
        // A failure serializes as the nested object the reader narrows.
        observation.navigation_completed(
            Some("https://example.com/a"),
            completion_outcome(false, Some(13)),
        );
        let json = serde_json::to_value(observation.state().expect("observed")).expect("serialize");
        assert_eq!(
            json.get("error"),
            Some(&serde_json::json!({
                "code": 13,
                "description": "HOST_NAME_NOT_RESOLVED"
            }))
        );
    }

    /// A retired generation drops every pending observation, including one that
    /// arrives after the retire but was registered before it.
    #[test]
    fn a_retired_generation_drops_its_pending_frames() {
        let (sink, reporter, _carrier) = sink();
        let generation = sink.generation();
        sink.observe(generation, |observation| {
            observation.navigation_started("https://example.com/a")
        });
        assert_eq!(reporter.states().len(), 1);
        sink.retire();
        assert_ne!(sink.generation(), generation);
        assert_eq!(
            sink.observe(generation, |observation| {
                observation.navigation_started("https://example.com/after-retire")
            }),
            PublishOutcome::StaleGeneration
        );
        assert_eq!(
            reporter.states().len(),
            1,
            "a retired carrier must not publish"
        );
        // The last state is refused as well: it belongs to the retired carrier.
        assert_eq!(sink.observed(), None);
    }

    /// The generation a callback presents is the one it was registered under;
    /// an older one can never publish into a newer carrier.
    #[test]
    fn only_the_current_generation_may_publish() {
        let (sink, reporter, _carrier) = sink();
        let first = sink.generation();
        sink.observe(first, |observation| {
            observation.navigation_started("https://example.com/a")
        });
        // A replacement carrier may reuse the label but not the generation.
        sink.retire();
        let second = sink.generation();
        assert_ne!(first, second);
        assert_eq!(
            sink.observe(first, |observation| {
                observation.navigation_started("https://example.com/stale")
            }),
            PublishOutcome::StaleGeneration
        );
        assert_eq!(
            sink.observe(second, |observation| {
                observation.source_changed("https://example.com/fresh")
            }),
            PublishOutcome::Published
        );
        assert_eq!(
            reporter.states().last().expect("published").url,
            "https://example.com/fresh"
        );
    }

    /// A callback whose child webview is gone cannot publish, even while its
    /// generation is still current.
    #[test]
    fn a_callback_of_a_departed_carrier_cannot_publish() {
        let (sink, reporter, carrier) = sink();
        let generation = sink.generation();
        sink.observe(generation, |observation| {
            observation.navigation_started("https://example.com/a")
        });
        carrier.departed();
        assert_eq!(
            sink.observe(generation, |observation| {
                observation.source_changed("https://example.com/after-close")
            }),
            PublishOutcome::CarrierGone
        );
        assert_eq!(reporter.states().len(), 1);
        assert_eq!(
            reporter.states()[0].url,
            "https://example.com/a",
            "a retired lease cannot be resurrected by a late callback"
        );
    }

    /// A frame that cannot take the observation is dropped rather than waited
    /// on, so the WebView2 UI thread never stalls behind the state model.
    #[test]
    fn a_pending_frame_is_dropped_rather_than_waited_on() {
        let (sink, reporter, _carrier) = sink();
        let generation = sink.generation();
        let held = sink.stored.lock().expect("held frame");
        assert_eq!(
            sink.observe(generation, |observation| {
                observation.navigation_started("https://example.com/a")
            }),
            PublishOutcome::FramePending
        );
        assert_eq!(sink.observed(), None);
        drop(held);
        assert_eq!(reporter.states().len(), 0);
    }

    /// Teardown retires pending frames, hides, and only then releases.
    #[test]
    fn teardown_retires_pending_frames_then_hides_then_releases() {
        struct Steps {
            sink: ObservationSink,
            generation: u64,
            sequence: Vec<&'static str>,
            published_while_hiding: usize,
        }

        impl GuestCarrier for Steps {
            fn hide(&mut self) -> Result<(), DshError> {
                self.sequence.push("hide");
                // A frame that was pending at disposal must not publish.
                let outcome = self.sink.observe(self.generation, |observation| {
                    observation.source_changed("https://example.com/after-dispose")
                });
                if outcome == PublishOutcome::Published {
                    self.published_while_hiding += 1;
                }
                Ok(())
            }

            fn release(&mut self) -> Result<(), DshError> {
                self.sequence.push("release");
                Ok(())
            }
        }

        let (sink, reporter, _carrier) = sink();
        let generation = sink.generation();
        sink.observe(generation, |observation| {
            observation.navigation_started("https://example.com/a")
        });
        let mut steps = Steps {
            sink: sink.clone(),
            generation,
            sequence: Vec::new(),
            published_while_hiding: 0,
        };
        let outcome = dispose_carrier(&sink, &mut steps);
        assert!(outcome.refusal.is_none());
        assert!(outcome.released, "the release is confirmed");
        assert_eq!(steps.sequence, vec!["hide", "release"]);
        assert_eq!(steps.published_while_hiding, 0);
        assert_eq!(reporter.states().len(), 1);
        assert_eq!(sink.observed(), None);
    }

    /// A refused hide does not cancel the release, and the hide refusal is the
    /// one reported.
    #[test]
    fn a_refused_hide_still_releases_and_is_reported_first() {
        struct Steps {
            sequence: Vec<&'static str>,
        }

        impl GuestCarrier for Steps {
            fn hide(&mut self) -> Result<(), DshError> {
                self.sequence.push("hide");
                Err(DshError::other(
                    "guest_hide_fixture",
                    "injected hide failure",
                ))
            }

            fn release(&mut self) -> Result<(), DshError> {
                self.sequence.push("release");
                Err(DshError::other(
                    "guest_release_fixture",
                    "injected release failure",
                ))
            }
        }

        let (sink, _reporter, _carrier) = sink();
        let mut steps = Steps {
            sequence: Vec::new(),
        };
        let outcome = dispose_carrier(&sink, &mut steps);
        match outcome.refusal {
            Some(DshError::Other { code, .. }) => assert_eq!(code, "guest_hide_fixture"),
            other => panic!("expected the hide refusal, got {other:?}"),
        }
        assert!(
            !outcome.released,
            "a release that was refused is not confirmed, so the identity stays owned"
        );
        assert_eq!(steps.sequence, vec!["hide", "release"]);
    }

    /// A confirmed release is confirmed even when the hide before it was refused:
    /// that is the pair of facts a teardown needs to decide whether the identity
    /// that named the child may be dropped.
    #[test]
    fn a_confirmed_release_is_reported_even_when_the_hide_was_refused() {
        struct Steps;

        impl GuestCarrier for Steps {
            fn hide(&mut self) -> Result<(), DshError> {
                Err(DshError::other(
                    "guest_hide_fixture",
                    "injected hide failure",
                ))
            }

            fn release(&mut self) -> Result<(), DshError> {
                Ok(())
            }
        }

        let (sink, _reporter, _carrier) = sink();
        let outcome = dispose_carrier(&sink, &mut Steps);
        match outcome.refusal {
            Some(DshError::Other { code, .. }) => assert_eq!(code, "guest_hide_fixture"),
            other => panic!("expected the hide refusal, got {other:?}"),
        }
        assert!(
            outcome.released,
            "the released child is gone even though the hide was refused"
        );
    }

    /// An unconfirmed release stays unconfirmed, every other one is confirmed,
    /// and the first refusal is the one reported — which is what lets a later
    /// teardown retry exactly the carriers that are still there.
    #[test]
    fn a_retry_reports_the_first_refusal_and_keeps_only_the_unconfirmed() {
        let pending = vec![
            "guest-browser-a".to_string(),
            "guest-browser-b".to_string(),
            "guest-platform".to_string(),
        ];
        let mut attempts = 0;
        let (first_error, unconfirmed) = retry_pending_releases(pending, |label| {
            attempts += 1;
            match label.as_str() {
                "guest-browser-b" => Err(DshError::other(
                    "guest_release_fixture",
                    "injected release failure",
                )),
                _ => Ok(()),
            }
        });
        assert_eq!(attempts, 3, "every unconfirmed release is retried");
        assert_eq!(unconfirmed, vec!["guest-browser-b".to_string()]);
        match first_error {
            Some(DshError::Other { code, .. }) => assert_eq!(code, "guest_release_fixture"),
            other => panic!("expected the release refusal, got {other:?}"),
        }
        // Everything released is confirmed; a second retry only sees what is left.
        let (first_error, unconfirmed) = retry_pending_releases(unconfirmed, |_| Ok(()));
        assert!(first_error.is_none());
        assert!(unconfirmed.is_empty());
    }

    /// The identities handed to a retry are the caller's again when they are not
    /// confirmed: the value itself comes back, so a handle can never be dropped
    /// by a refused attempt.
    #[test]
    fn an_unconfirmed_identity_is_handed_back_rather_than_dropped() {
        let pending = vec!["the-only-handle".to_string()];
        let (first_error, unconfirmed) = retry_pending_releases(pending, |_| {
            Err(DshError::other(
                "guest_release_fixture",
                "injected release failure",
            ))
        });
        assert!(first_error.is_some());
        assert_eq!(unconfirmed, vec!["the-only-handle".to_string()]);
    }
}
