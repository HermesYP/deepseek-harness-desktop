//! The only module that talks to Tauri/WebView2 for guest surfaces.
//!
//! It performs the [`NativeGuestAction`]s produced by
//! [`GuestViews`](super::registry::GuestViews) and is where a delivery failure
//! triggers registry rollback and best-effort native cleanup. A close failure can
//! still leave a native child alive — headless tests cannot rule that out — so its
//! handle is retained rather than dropped with its view, and every later teardown
//! retries it (see "Teardown order and unconfirmed releases" below).
//!
//! ## Storage isolation is delivered by the child builder
//!
//! A guest is created with `WebviewBuilder::data_directory` pointed at the
//! isolation root of its partition (`guests::partition`). Tauri keys its
//! WebView2 environment store by exactly that path
//! (`tauri-runtime-wry-2.11.4/src/lib.rs:4793-4812`: `web_context_key =
//! webview_attributes.data_directory`, then `WryWebContext::new(key)`), so the
//! value reaches `CoreWebView2EnvironmentOptions` through
//! `context.data_directory()` (`wry-0.55.1/src/webview2/mod.rs:287-291`). This is
//! the **workspace-identity** rule the reference implements with an Electron
//! partition string: guests of one workspace share one directory and therefore
//! one storage jar, and guests of two workspaces or two Platform accounts share
//! nothing. The directory is never derived from the lease, which is minted per
//! tab.
//!
//! The shell's own webview passes no data directory, so it uses the WebView2
//! default user-data folder while every guest uses a sibling under
//! `<user-data>/webview-data/`. No guest shares a jar with the application
//! document.
//!
//! ## Hardening is explicit, never inherited
//!
//! WebView2 defaults are **not** this port's defaults, so nothing is left to
//! them. Every guest is created through [`guest_builder`] with:
//!
//! * `on_navigation` → [`guest_navigation_allowed`], with the guest's own inert
//!   seed exempted by [`webview2_guard::seed_navigation_allowed`]: a `false`
//!   answer makes wry call `args.SetCancel(true)` on WebView2's
//!   `NavigationStarting` (`wry-0.55.1/src/webview2/mod.rs:673-694`). This is the
//!   only hook that can cancel a navigation a page starts itself, including a
//!   click on a link or a redirect, which the client cannot intercept.
//! * `on_new_window` → `NewWindowResponse::Deny`, always. wry registers
//!   `NewWindowRequested` unconditionally (`:702-788`), but the **default** when
//!   no handler is installed is `args.SetHandled(true)` with no window
//!   (`:781-783`), so the deny has to be stated explicitly rather than assumed.
//! * `on_download` → [`allowed_download`], which is `false`; that is what makes
//!   wry call `args.SetCancel(true)` on WebView2's `DownloadStarting`
//!   (`wry-0.55.1/src/webview2/mod.rs:857-870`). Downloads are not left to the
//!   WebView2 default (which starts its own download UI).
//! * `zoom_hotkeys_enabled(false)`, `browser_extensions_enabled(false)`,
//!   `devtools(false)` and `disable_drag_drop_handler()`, each of which wry
//!   otherwise leaves enabled (`webview2/mod.rs:572-573`, `:596-598`, `:328`).
//!
//! ## What a Tauri handler cannot express
//!
//! Subresource requests (`onBeforeRequest`), permission answers, HTTP
//! authentication refusal and popup decisions have no Tauri handler. They are
//! enforced against the pinned WebView2 interface in [`webview2_guard`]:
//! `add_WebResourceRequested` + `SetResponse` for the request rule,
//! `add_PermissionRequested` for permissions, `add_BasicAuthenticationRequested`
//! for HTTP authentication, and `add_NewWindowRequested` for popups.
//! [`webview2_guard::install`] registers all of them before the guest's first
//! document is requested.
//!
//! The one reference rule with no observation in the pinned SDK is the popup
//! body: a `target="_blank"` POST cannot be told from `window.open`, so
//! [`webview2_guard::popup_outcome`] refuses every browser popup. That is
//! fail-closed for one feature and does not refuse the guest — a Browser guest
//! is created, navigates and loads exactly as the reference does.
//!
//! ## No guest exists before the application origin is known
//!
//! [`policy::is_application_request`] answers `false` for every address while
//! the application origin is unknown, so the navigation and request rules
//! degrade to "refuse nothing extra" during that window — a guest created then
//! could reach the loopback gateway. [`webview2_guard::enforce`] therefore
//! refuses to create **any** guest until the origin is known, before a child is
//! allocated. The only document left reachable in that state is the guest's own
//! inert seed, which the port requests itself and which names no authority.
//!
//! ## A hook failure closes the guest
//!
//! [`create_guest`] allocates the child at the inert seed; nothing is requested
//! until [`webview2_guard::install`] has registered the permission,
//! authentication and popup handlers on the WebView2 UI thread, and the guest's
//! real first document is navigated to from inside that same registration. If
//! any registration fails, the child is closed there and no document is
//! requested; if the registration cannot even be scheduled, the caller destroys
//! the tracked view and additionally looks the child up by label. A guest is
//! never left running with only the Tauri-level half of the policy.
//!
//! ## Permissions
//!
//! [`webview2_guard`] registers `ICoreWebView2::add_PermissionRequested` and
//! answers `COREWEBVIEW2_PERMISSION_STATE_DENY` for every kind, which is the
//! reference's `setPermissionRequestHandler` / `setPermissionCheckHandler` /
//! `setDevicePermissionHandler` / `setDisplayMediaRequestHandler` all returning
//! false. That denial is the whole decision — there is no separate per-permission
//! policy function to keep in step, precisely because a guest session is refused
//! wholesale. The deliberate asymmetry with the application document — which
//! grants microphone access to its own main frame (upstream
//! `microphone-permissions.ts`) — is preserved: a guest reaches none of it. See
//! `policy`'s module documentation for the same rule stated as policy.
//!
//! ## Authority
//!
//! WebView2 always installs its own `window.ipc` bootstrap script
//! (`wry-0.55.1/src/webview2/mod.rs:880-890`, `attach_ipc_handler`), so a guest
//! document does have *a* Tauri IPC bridge object. It carries **zero authority**:
//! no Tauri IPC initialization script is added
//! (`wry-0.55.1/src/webview2/mod.rs:492-495` only runs what the caller supplies),
//! and the ACL grants nothing to any webview other than `main`
//! (`app/capabilities/default.json`, `security::OwnedAppOrigin::install` binds
//! the runtime capability to the `main` view). This module states that rather
//! than claiming the host object is absent.
//!
//! ## Observations, placement epochs and teardown order
//!
//! Each created guest gets one [`ObservationSink`], installed with
//! [`observation::install`] *before* [`webview2_guard::install`]. Both reach the
//! WebView2 UI thread through `Webview::with_webview`, which executes inline on
//! the application's main thread (`tauri-runtime-wry-2.11.4/src/lib.rs:239-248`)
//! — which is where this module runs — so every observation of a guest's
//! document is registered before the policy registration requests its first
//! document, and a guest is never created with only one half of its native
//! contract.
//!
//! Placement carries the registry's epoch ([`NativeGuestAction::PlaceBrowser`]
//! and [`NativeGuestAction::PlacePlatform`]). The native layer records the last
//! epoch it applied and refuses an older one, so a placement overtaken by a
//! newer hide cannot move or reveal the guest again.
//!
//! Teardown is [`observation::dispose_carrier`]: the carrier's generation is
//! retired (dropping every pending observation frame), the guest is hidden, and
//! only then is it released. A failed hide does not cancel the release.
//!
//! ## Ownership survives a refused or cancelled teardown
//!
//! The [`GuestContext`] — not the batch a teardown was asked to perform — is the
//! authority on which native children exist. A close that fails, and a batch
//! whose round trip never reached the main thread, both leave their handle in the
//! context: `release_tracked` moves a carrier whose release was refused into
//! `GuestContext::pending_teardown` instead of dropping it, and
//! [`release_every_guest`] retries every retained handle on the next teardown.
//! [`MainThreadGuests::teardown`](super::host::MainThreadGuests::teardown)
//! therefore sweeps even when the registry has no steps left to give — which is
//! the case on a retried exit — so a cancelled wait never abandons a live child.
//!
//! [`observation::retry_pending_releases`] is the retry rule, and
//! [`observation::CarrierRelease::released`] is the fact it turns on: only a
//! confirmed release lets an identity go.
//!
//! [`ObservationSink`]: super::observation::ObservationSink
//! [`observation::install`]: super::observation::install
//! [`observation::dispose_carrier`]: super::observation::dispose_carrier

use std::collections::BTreeMap;

use dsh_core::error::DshError;
use tauri::{Manager, Runtime, Webview};

use super::geometry::GuestBounds;
use super::observation::{self, ObservationSink};
#[cfg(test)]
use super::partition::WEBVIEW_DATA_DIR_NAME;
use super::partition::{webview_data_directory, PartitionKind};
use super::policy::{
    allowed_navigation, allowed_platform_navigation, native_bounds_error, native_guest_error,
};
use super::registry::NativeGuestAction;
use super::webview2_guard::{self, GuestPolicy};

/// Test-only alias of [`super::partition::WEBVIEW_DATA_DIR_NAME`], used to build
/// the expected isolation root in the retention tests.
#[cfg(test)]
pub const WEBVIEW_DATA_RELATIVE_PATH: &str = WEBVIEW_DATA_DIR_NAME;

/// Platform locale ids sent to the embedded document (upstream `platform-ipc.ts`
/// `PlatformLocale`).
///
/// Test-only: nothing in the shell maps a shell language tag onto these today,
/// so the rule is pinned by its own test until the Platform document is opened
/// with an injected locale.
#[cfg(test)]
pub const PLATFORM_LOCALE_EN: &str = "en_US";
/// Companion of [`PLATFORM_LOCALE_EN`].
#[cfg(test)]
pub const PLATFORM_LOCALE_ZH: &str = "zh_CN";

/// Event carrying an approved guest popup to the client
/// (`DESKTOP_IPC.browserOpenRequested` upstream).
pub const GUEST_BROWSER_OPEN_EVENT: &str = "dsh://guests/browser-open";

/// Event carrying one guest's observed document state to the client.
///
/// The payload is [`super::GuestBrowserState`] itself, so the Rust producer and
/// the client reader share one typed schema. It is emitted by
/// [`super::observation::TauriStateReporter`], never composed at a call site.
pub const GUEST_BROWSER_STATE_EVENT: &str = "dsh://guests/browser-state";

/// Payload of [`GUEST_BROWSER_OPEN_EVENT`] (upstream `DesktopBrowserOpenRequest`).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BrowserOpenRequest {
    /// The guest whose document requested the popup.
    pub lease: String,
    /// Validated `http`/`https` URL the client opens in a new Browser tab.
    pub url: String,
}

/// The live guests of one window, and the application origin guests may never
/// reach.
///
/// The origin travels with the views because both navigation hooks run on the
/// WebView2 message loop and must answer without consulting shared state.
///
/// The views are a `BTreeMap` so teardown's order is a property of the labels
/// rather than of a hash: `guest-browser-*` precedes `guest-platform`, which is
/// the reference's release-all-then-dispose order.
pub struct GuestContext {
    /// Application gateway origin (`GatewayHandle::authenticated_url`, reduced
    /// to scheme + authority), or `None` before the Host is up.
    application_origin: Option<String>,
    views: BTreeMap<String, NativeGuestView<tauri::Wry>>,
    /// Native carriers whose release was never confirmed.
    ///
    /// A child whose close was refused is still there, so its handle is kept —
    /// with the label that names it — instead of being dropped with its view.
    /// [`release_every_guest`] retries every entry; this is the only place a
    /// native child outlives its guest.
    pending_teardown: Vec<PendingCarrier>,
    platform_generation: Option<u64>,
}

/// One native child webview whose release was not confirmed.
///
/// More than one entry can carry the same label, and that is deliberate: a
/// reopened Platform document whose predecessor never closed really is two native
/// children under one label, and dropping either handle would abandon a child.
/// Both are retried, in the order their releases failed.
struct PendingCarrier {
    /// Label the child was created under, for the retry's diagnostics.
    key: String,
    /// The retained native handle itself — the authoritative identity.
    view: NativeGuestView<tauri::Wry>,
}

impl GuestContext {
    /// @param application_origin - owned gateway origin, or `None` before the
    ///   Host has reported one.
    pub fn new(application_origin: Option<String>) -> Self {
        Self {
            application_origin,
            views: BTreeMap::new(),
            pending_teardown: Vec::new(),
            platform_generation: None,
        }
    }

    /// The owned application origin every guest decision is made against.
    pub fn application_origin(&self) -> Option<&str> {
        self.application_origin.as_deref()
    }

    /// Record the owned application origin once the Host has published one.
    ///
    /// Called on the main thread only, so a navigation hook already running on
    /// the WebView2 message loop cannot observe a half-updated value.
    pub fn set_application_origin(&mut self, origin: Option<String>) {
        self.application_origin = origin;
    }

    /// The live webview labelled `label`, for a navigation command.
    pub fn webview(&self, label: &str) -> Option<&Webview<tauri::Wry>> {
        self.views.get(label).map(|view| &view.webview)
    }

    /// The last document state the guest labelled `label` published, if any.
    ///
    /// `None` means no native observation has arrived for a live carrier — which
    /// the caller reports as unavailable rather than filling in from anything the
    /// client asked for.
    pub fn observed(&self, label: &str) -> Option<super::GuestBrowserState> {
        self.views.get(label)?.observations.observed()
    }

    /// Keep one carrier whose release was not confirmed.
    ///
    /// The handle is the authoritative native identity of a child that may still
    /// exist, so a refused close retains it rather than dropping it. Nothing is
    /// released here: the retry happens on the next teardown, through
    /// [`release_every_guest`].
    fn retain(&mut self, key: &str, view: NativeGuestView<tauri::Wry>) {
        self.pending_teardown.push(PendingCarrier {
            key: key.to_string(),
            view,
        });
    }
}

/// Map key of one action's guest identity.
fn guest_key(action: &NativeGuestAction) -> String {
    match action {
        NativeGuestAction::CreateBrowser { lease, .. }
        | NativeGuestAction::PlaceBrowser { lease, .. }
        | NativeGuestAction::DestroyBrowser { lease }
        | NativeGuestAction::NavigateBrowser { lease, .. }
        | NativeGuestAction::GoBackBrowser { lease }
        | NativeGuestAction::GoForwardBrowser { lease }
        | NativeGuestAction::ReloadBrowser { lease } => browser_label(lease),
        NativeGuestAction::OpenPlatform { .. }
        | NativeGuestAction::PlacePlatform { .. }
        | NativeGuestAction::ClosePlatform { .. } => PLATFORM_GUEST_LABEL.to_string(),
    }
}

/// Label of the application window the shell owns.
///
/// Also the only window label a guest command accepts; every guest child
/// webview gets a different label, which is what keeps the bridge out of reach
/// of guest content.
pub const APPLICATION_WINDOW_LABEL: &str = "main";

/// Label prefix of a browser guest child webview.
pub const BROWSER_GUEST_LABEL_PREFIX: &str = "guest-browser-";
/// Label of the single Platform guest child webview.
pub const PLATFORM_GUEST_LABEL: &str = "guest-platform";

/// Child webview label of one browser lease.
///
/// @param lease - opaque main-issued reservation identity.
/// @returns the label naming exactly that guest.
pub fn browser_label(lease: &str) -> String {
    format!("{BROWSER_GUEST_LABEL_PREFIX}{lease}")
}

/// A live child webview plus the placement state the native layer remembers.
pub struct NativeGuestView<R: Runtime> {
    /// The child webview.
    pub webview: Webview<R>,
    /// Whether the last placement showed the guest.
    pub visible: bool,
    /// Placement epoch of the last placement this view applied.
    pub placement: u64,
    /// Where this carrier's document observations are published.
    pub observations: ObservationSink,
}

/// One live child webview as a disposal carrier.
struct WebviewCarrier<'a> {
    webview: &'a Webview<tauri::Wry>,
}

impl observation::GuestCarrier for WebviewCarrier<'_> {
    fn hide(&mut self) -> Result<(), DshError> {
        self.webview
            .hide()
            .map_err(|error| native_guest_error("hide", error))
    }

    fn release(&mut self) -> Result<(), DshError> {
        self.webview
            .close()
            .map_err(|error| native_guest_error("close", error))
    }
}

/// Perform one ordered batch of native guest actions.
///
/// @param app - the application handle the guest events are emitted through.
/// @param window - the owned application window that hosts the guests.
/// @param user_data - application user-data directory (`AppPaths::user_data`).
/// @param views - the window's live native guests.
/// @param actions - steps produced by [`GuestViews`], executed in order.
/// @returns after every step has run.
/// @throws {DshError} `guest_create`/`guest_bounds`/`guest_show`/… on failure;
///   tracked views are closed before returning. Creation failure also attempts
///   a label lookup for a child allocated before `add_child` reported failure.
/// @throws {DshError::NotFound} when a placement names a guest that is not live,
///   which can only mean the registry and the native layer disagree.
pub fn apply_native_actions(
    app: &tauri::AppHandle<tauri::Wry>,
    window: &tauri::Window<tauri::Wry>,
    user_data: &std::path::Path,
    registry: &mut super::registry::GuestViews,
    context: &mut GuestContext,
    actions: Vec<NativeGuestAction>,
) -> Result<(), DshError> {
    super::orchestration::apply_batch(
        registry,
        context,
        actions,
        |context, action| {
            match action {
                NativeGuestAction::CreateBrowser { lease, partition } => {
                    let label = browser_label(&lease);
                    // Remove any child tracked from an earlier batch before retrying.
                    // A failed add_child may have allocated an untracked native child;
                    // this tracked-map removal alone cannot prove it was closed.
                    destroy(context, &label);
                    let observations = ObservationSink::for_tauri(app, &lease, &label);
                    let webview = match create_browser_guest(
                        app,
                        window,
                        user_data,
                        context,
                        &lease,
                        &partition,
                        &observations,
                    ) {
                        Ok(webview) => webview,
                        Err(error) => {
                            destroy(context, &label);
                            close_untracked_child(app, &label);
                            return Err(error);
                        }
                    };
                    context.views.insert(
                        label,
                        NativeGuestView {
                            webview,
                            visible: false,
                            placement: 0,
                            observations,
                        },
                    );
                }
                NativeGuestAction::PlaceBrowser {
                    lease,
                    bounds,
                    placement,
                } => {
                    place_or_destroy(context, &browser_label(&lease), bounds, placement)?;
                }
                NativeGuestAction::DestroyBrowser { lease } => {
                    destroy(context, &browser_label(&lease));
                }
                NativeGuestAction::NavigateBrowser { lease, url } => {
                    let label = browser_label(&lease);
                    // The address was validated by the registry against the same
                    // policy the WebView2 navigation hook applies; parsing it here
                    // can therefore only fail for a value the policy already
                    // admitted, which is reported rather than ignored.
                    let parsed = url::Url::parse(&url)
                        .map_err(|error| DshError::invalid_argument("url", error.to_string()))?;
                    let webview = context
                        .webview(&label)
                        .ok_or_else(|| DshError::not_found("guest view", &label))?;
                    webview
                        .navigate(parsed)
                        .map_err(|error| native_guest_error("navigate", error))?;
                }
                NativeGuestAction::GoBackBrowser { lease } => {
                    let label = browser_label(&lease);
                    let webview = context
                        .webview(&label)
                        .ok_or_else(|| DshError::not_found("guest view", &label))?;
                    history_step(webview, HistoryStep::Back)?;
                }
                NativeGuestAction::GoForwardBrowser { lease } => {
                    let label = browser_label(&lease);
                    let webview = context
                        .webview(&label)
                        .ok_or_else(|| DshError::not_found("guest view", &label))?;
                    history_step(webview, HistoryStep::Forward)?;
                }
                NativeGuestAction::ReloadBrowser { lease } => {
                    let label = browser_label(&lease);
                    let webview = context
                        .webview(&label)
                        .ok_or_else(|| DshError::not_found("guest view", &label))?;
                    webview
                        .reload()
                        .map_err(|error| native_guest_error("reload", error))?;
                }
                NativeGuestAction::OpenPlatform {
                    generation,
                    page,
                    origin,
                    partition,
                    bounds,
                    placement,
                } => {
                    // `OpenPlatform` may follow a failed prior open. Close a
                    // previously tracked view; this does not prove cleanup of an
                    // untracked child left by a partially failed allocation.
                    destroy(context, PLATFORM_GUEST_LABEL);
                    let observations =
                        ObservationSink::for_tauri(app, PLATFORM_GUEST_LABEL, PLATFORM_GUEST_LABEL);
                    let webview = match create_platform_guest(
                        app,
                        window,
                        user_data,
                        context,
                        PlatformDocument {
                            page: page.as_str(),
                            origin: origin.as_str(),
                            partition: partition.as_str(),
                        },
                        &observations,
                    ) {
                        Ok(webview) => webview,
                        Err(error) => {
                            destroy(context, PLATFORM_GUEST_LABEL);
                            close_untracked_child(app, PLATFORM_GUEST_LABEL);
                            return Err(error);
                        }
                    };
                    context.views.insert(
                        PLATFORM_GUEST_LABEL.to_string(),
                        NativeGuestView {
                            webview,
                            visible: false,
                            placement: 0,
                            observations,
                        },
                    );
                    context.platform_generation = Some(generation);
                    place_or_destroy(context, PLATFORM_GUEST_LABEL, bounds, placement)?;
                }
                NativeGuestAction::PlacePlatform {
                    generation,
                    bounds,
                    placement,
                } => {
                    if !super::orchestration::platform_target_is_current(
                        context.platform_generation,
                        generation,
                    ) {
                        return Err(DshError::other(
                            "guest_dispatch_stale",
                            "the native Platform document was replaced",
                        ));
                    }
                    place_or_destroy(context, PLATFORM_GUEST_LABEL, bounds, placement)?;
                }
                NativeGuestAction::ClosePlatform { generation } => {
                    if super::orchestration::platform_target_is_current(
                        context.platform_generation,
                        generation,
                    ) {
                        destroy(context, PLATFORM_GUEST_LABEL);
                    }
                }
            }
            Ok(())
        },
        |context, action| match action {
            NativeGuestAction::OpenPlatform { generation, .. }
            | NativeGuestAction::PlacePlatform { generation, .. }
            | NativeGuestAction::ClosePlatform { generation } => {
                if super::orchestration::platform_target_is_current(
                    context.platform_generation,
                    *generation,
                ) {
                    destroy(context, PLATFORM_GUEST_LABEL);
                }
            }
            _ => destroy(context, &guest_key(action)),
        },
    )
}

/// The application window itself, from any handle that manages windows.
///
/// @param manager - the app handle or window a command received.
/// @returns the owned window, or a typed refusal when it is gone.
pub fn application_window<R: Runtime, M: Manager<R>>(
    manager: &M,
) -> Result<tauri::Window<R>, DshError> {
    manager.get_window(APPLICATION_WINDOW_LABEL).ok_or_else(|| {
        DshError::other(
            "guest_window_unavailable",
            "the application window is not open",
        )
    })
}

/// One step through a guest's own history.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryStep {
    /// One entry backward.
    Back,
    /// One entry forward.
    Forward,
}

/// Move one guest through its own history with the WebView2 member that does it.
///
/// `ICoreWebView2` publishes `GoBack` and `GoForward` (`webview2-com-sys 0.38.2`
/// `bindings.rs:1506`, `:1512`), so the guest document does not perform the step
/// itself: nothing is evaluated inside guest content, and the resulting
/// navigation is filtered by the same navigation hook as any other. Whether an
/// entry exists is a separate native observation
/// (`ICoreWebView2::CanGoBack` / `CanGoForward`, published by [`observation`]).
///
/// @param webview - the guest's child webview.
/// @param step - the direction.
/// @returns after the runtime accepted the step.
fn history_step(webview: &Webview<tauri::Wry>, step: HistoryStep) -> Result<(), DshError> {
    #[cfg(windows)]
    {
        ui_thread::call(webview, move |core| {
            // SAFETY: the closure runs on the WebView2 UI thread inside
            // `ui_thread::call`, which owns the controller the call is made on.
            match step {
                HistoryStep::Back => unsafe { core.GoBack() },
                HistoryStep::Forward => unsafe { core.GoForward() },
            }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, step);
        Err(DshError::other(
            super::observation::GUEST_OBSERVATION_UNAVAILABLE,
            "guest history is implemented only against WebView2",
        ))
    }
}

/// One WebView2 call on the guest's own UI thread.
#[cfg(windows)]
pub(crate) mod ui_thread {
    use std::sync::{Arc, Mutex};

    use dsh_core::error::DshError;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;

    /// Run one operation against a guest's `ICoreWebView2`.
    ///
    /// `Webview::with_webview` executes its closure inline when it is called on
    /// the application's main thread
    /// (`tauri-runtime-wry-2.11.4/src/lib.rs:239-248`), which is where every batch
    /// in this module runs, so the operation's result is available synchronously.
    /// An operation that cannot report its result is refused rather than assumed
    /// to have succeeded.
    ///
    /// @param webview - the child webview the operation belongs to.
    /// @param operation - the WebView2 call, run on the WebView2 UI thread.
    /// @returns the operation's value.
    /// @throws {DshError} `guest_webview2` when the runtime refuses the call or
    ///   does not report its outcome.
    pub(crate) fn call<T: Send + 'static>(
        webview: &tauri::Webview<tauri::Wry>,
        operation: impl FnOnce(&ICoreWebView2) -> windows::core::Result<T> + Send + 'static,
    ) -> Result<T, DshError> {
        let reported: Arc<Mutex<Option<Result<T, DshError>>>> = Arc::new(Mutex::new(None));
        let cell = reported.clone();
        webview
            .with_webview(move |native| {
                // SAFETY: `with_webview` runs on the WebView2 UI thread that owns
                // this controller, and `operation` touches only that thread's
                // interfaces.
                let outcome = unsafe {
                    native
                        .controller()
                        .CoreWebView2()
                        .map_err(|error| {
                            DshError::other(
                                "guest_webview2",
                                format!("the guest controller has no CoreWebView2: {error}"),
                            )
                        })
                        .and_then(|core| {
                            operation(&core).map_err(|error| {
                                DshError::other(
                                    "guest_webview2",
                                    format!("a WebView2 call on the guest failed: {error}"),
                                )
                            })
                        })
                };
                if let Ok(mut slot) = cell.lock() {
                    *slot = Some(outcome);
                }
            })
            .map_err(|error| {
                DshError::other(
                    "guest_webview2",
                    format!("a WebView2 call could not be scheduled: {error}"),
                )
            })?;
        let outcome = reported
            .lock()
            .map_err(|_| {
                DshError::other(
                    "guest_webview2",
                    "the WebView2 call outcome could not be read",
                )
            })?
            .take();
        outcome.unwrap_or_else(|| {
            Err(DshError::other(
                "guest_webview2",
                "the WebView2 call did not run on the application main thread",
            ))
        })
    }
}

/// Place one guest, destroying it if the native layer refuses the rectangle.
///
/// A placement from an older epoch than the one this view already applied is
/// refused without touching the view: the newer placement — a hide, in
/// particular — owns what happens to this guest next, and a delayed step must
/// not move or reveal it again. The refusal is the same `guest_dispatch_stale`
/// code the batch validator reports.
fn place_or_destroy(
    context: &mut GuestContext,
    key: &str,
    bounds: GuestBounds,
    placement: u64,
) -> Result<(), DshError> {
    let Some(view) = context.views.get_mut(key) else {
        return Err(DshError::not_found("guest view", key));
    };
    if placement < view.placement {
        return Err(DshError::other(
            "guest_dispatch_stale",
            "the placement was overtaken by a newer one and no longer owns this guest",
        ));
    }
    match place(&view.webview, bounds) {
        Ok(()) => {
            view.visible = bounds.visible();
            view.placement = placement;
            Ok(())
        }
        Err(error) => {
            destroy(context, key);
            Err(error)
        }
    }
}

/// Attempt to close a child allocated by the runtime but not entered in our map.
/// Tauri's Manager lookup includes child webviews; close remains best-effort.
fn close_untracked_child(app: &tauri::AppHandle<tauri::Wry>, label: &str) {
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
}

/// Remove one tracked child webview, retaining it while its release is
/// unconfirmed.
///
/// Every action handler and every compensation path disposes a guest through this
/// function, so the retention rule cannot be bypassed: a close that fails leaves
/// the handle in `GuestContext::pending_teardown` instead of dropping it with
/// the view, and [`release_every_guest`] finds it on the next teardown. The
/// refusal is logged rather than propagated because these callers are already
/// committed to a best-effort cleanup; the sweep is where an unconfirmed release
/// is reported to the exit path.
///
/// @param context - the window's native guest state.
/// @param key - the guest's label.
fn destroy(context: &mut GuestContext, key: &str) {
    if let Err(error) = release_tracked(context, key) {
        tracing::warn!(
            target: "dsh::guests",
            key = %key,
            error = %error,
            "a guest release was not confirmed; the native handle is retained for a later teardown"
        );
    }
}

/// Release one tracked child webview, in the order every disposal uses.
///
/// The carrier's observations are retired first, so no pending frame can publish
/// after the guest starts going away; the hide runs next and the release after
/// it, through [`observation::dispose_carrier`]. A release that is refused keeps
/// the handle owned (`GuestContext::retain`) — the one case in which a native
/// child outlives its view — while a hide refusal is logged rather than returned,
/// because it is the release that decides whether the child is gone.
///
/// Nothing is attempted for a label with no tracked view: this context owns no
/// child under it, and a child it never created is not its identity to release.
///
/// @param context - the window's native guest state.
/// @param key - the guest's label.
/// @returns the refusal when the release was not confirmed.
fn release_tracked(context: &mut GuestContext, key: &str) -> Result<(), DshError> {
    if key == PLATFORM_GUEST_LABEL {
        context.platform_generation = None;
    }
    let Some(view) = context.views.remove(key) else {
        return Ok(());
    };
    let mut carrier = WebviewCarrier {
        webview: &view.webview,
    };
    let outcome = observation::dispose_carrier(&view.observations, &mut carrier);
    if let Some(refusal) = outcome.refusal.as_ref() {
        tracing::warn!(
            target: "dsh::guests",
            key = %key,
            error = %refusal,
            "a guest teardown step was refused"
        );
    }
    if outcome.released {
        return Ok(());
    }
    let refusal = outcome
        .refusal
        .unwrap_or_else(|| native_guest_error("close", "the guest release was not confirmed"));
    context.retain(key, view);
    Err(refusal)
}

/// Retry one retained carrier's release.
///
/// Used by [`release_every_guest`] for a handle an earlier teardown could not
/// close, and by nothing else: a tracked view is released through
/// `release_tracked`, which is also what decides whether the handle is kept.
///
/// @param view - the retained native carrier.
/// @returns the refusal when the release is still not confirmed.
fn release_retained(view: &NativeGuestView<tauri::Wry>) -> Result<(), DshError> {
    let mut carrier = WebviewCarrier {
        webview: &view.webview,
    };
    let outcome = observation::dispose_carrier(&view.observations, &mut carrier);
    if outcome.released {
        return Ok(());
    }
    Err(outcome
        .refusal
        .unwrap_or_else(|| native_guest_error("close", "the guest release was not confirmed")))
}

/// Release every native guest this context still owns.
///
/// The context — not the batch a teardown was asked to perform — is the authority
/// on which native children exist, so this sweep is what makes a retried exit
/// safe: a step whose main-loop round trip never ran, and a close that was
/// refused, both leave their handle here, and an empty batch still releases them.
///
/// Handles an earlier attempt already failed to close are retried first, then
/// every tracked view in label order (browser guests, then the Platform
/// document). Each identity is attempted once per call; a refusal is reported and
/// the handle stays owned, so the next call retries exactly what is left.
///
/// @param context - the window's native guest state.
/// @returns the first refusal in attempt order; every unconfirmed handle remains
///   owned.
pub fn release_every_guest(context: &mut GuestContext) -> Result<(), DshError> {
    let retained = std::mem::take(&mut context.pending_teardown);
    let (retained_error, still_retained) =
        observation::retry_pending_releases(retained, |carrier| {
            let outcome = release_retained(&carrier.view);
            if let Err(error) = outcome.as_ref() {
                tracing::warn!(
                    target: "dsh::guests",
                    key = %carrier.key,
                    error = %error,
                    "a retained guest is still not released; it stays owned"
                );
            }
            outcome
        });
    context.pending_teardown = still_retained;
    let live: Vec<String> = context.views.keys().cloned().collect();
    // A refusal here has already retained its handle through `release_tracked`, so
    // the labels this pass reports as unconfirmed are owned again by the context
    // and are retried by the next sweep.
    let (live_error, _unconfirmed) =
        observation::retry_pending_releases(live, |label| release_tracked(context, label));
    match retained_error.or(live_error) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

/// Move, show or hide one child webview.
fn place<R: Runtime>(webview: &Webview<R>, bounds: GuestBounds) -> Result<(), DshError> {
    // The unit type is named explicitly: `GuestBounds` converts to both a
    // logical position and a logical size, so `Into` alone is ambiguous.
    let position: tauri::LogicalPosition<f64> = bounds.into();
    let size: tauri::LogicalSize<f64> = bounds.into();
    webview
        .set_position(position)
        .map_err(|error| native_bounds_error(error.to_string()))?;
    webview
        .set_size(size)
        .map_err(|error| native_bounds_error(error.to_string()))?;
    if bounds.visible() {
        webview
            .show()
            .map_err(|error| native_guest_error("show", error))?;
    } else {
        webview
            .hide()
            .map_err(|error| native_guest_error("hide", error))?;
    }
    if bounds.visible() {
        // A visible guest must be able to take the keyboard; a native overlay
        // that never receives focus looks frozen to the user.
        let _ = webview.set_focus();
    }
    Ok(())
}

/// The one hardening profile every guest child webview is created with.
///
/// Kept as a function of only the isolation directory and the guest's policy,
/// so a second call site cannot quietly create a guest with weaker defaults.
/// The inert seed comes from the policy rather than a second argument, so the
/// address the guest is created at and the address its navigation hook exempts
/// can never drift apart.
///
/// @param label - unique child webview label.
/// @param data_directory - isolation root of the guest's partition.
/// @param policy - the guest's origins and inert seed, shared with
///   [`webview2_guard::install`].
/// @returns the configured builder, seeded with the guest's inert document.
fn guest_builder(
    label: String,
    data_directory: std::path::PathBuf,
    policy: &GuestPolicy,
) -> tauri::webview::WebviewBuilder<tauri::Wry> {
    let seed = policy.seed().clone();
    let exempt_seed = seed.clone();
    let navigation_origin = policy.application_origin().map(str::to_string);
    let navigation_platform = policy.platform_origin().map(str::to_string);
    tauri::webview::WebviewBuilder::new(label, tauri::WebviewUrl::External(seed))
        .data_directory(data_directory)
        .zoom_hotkeys_enabled(false)
        .browser_extensions_enabled(false)
        .devtools(false)
        .disable_drag_drop_handler()
        .on_navigation(move |url| {
            // The seed the port itself requested is the only exemption, and it is
            // compared against the same value the builder loaded.
            webview2_guard::seed_navigation_allowed(url, &exempt_seed)
                || guest_navigation_allowed(
                    url,
                    navigation_origin.as_deref(),
                    navigation_platform.as_deref(),
                )
        })
        // `false` is what makes wry cancel the download; the decision itself is
        // the named reference rule so it cannot be relaxed by editing a literal.
        .on_download(|_webview, _event| super::policy::allowed_download())
}

/// Whether a guest document may commit `url`.
///
/// @param url - the address WebView2 is about to commit.
/// @param application_origin - owned gateway origin, refused for every guest.
/// @param platform_origin - the Platform account origin when the guest is the
///   embedded Platform document.
/// @returns whether the navigation may proceed.
pub fn guest_navigation_allowed(
    url: &url::Url,
    application_origin: Option<&str>,
    platform_origin: Option<&str>,
) -> bool {
    match platform_origin {
        Some(origin) => allowed_platform_navigation(url.as_str(), origin),
        None => allowed_navigation(url.as_str(), application_origin),
    }
}

/// Build one child webview and arm its policy before it can request anything.
///
/// [`webview2_guard::enforce`] runs first: a guest kind whose reference rules
/// this SDK cannot enforce is refused here, before any child is allocated, so a
/// port that cannot protect a guest does not create one. Otherwise the child is
/// created at the policy's inert seed, its document observations are installed,
/// and no document is loaded until [`webview2_guard::install`] has registered
/// every WebView2 policy handler and requested `first_document` from the UI
/// thread. Observations are registered first because `with_webview` runs inline
/// here: the seed's own navigation is therefore observed from its start.
///
/// @param app - application handle the guest's popup publication is emitted from.
/// @param window - owning application window.
/// @param label - the child webview label and the popup event's key.
/// @param first_document - the guest's real first document, or `None` when the
///   client navigates it later.
/// @param data_directory - isolation root of the guest's partition.
/// @param policy - the guest's origins and inert seed.
/// @param observations - the carrier's document observations.
/// @returns the created child webview.
/// @throws {DshError} `guest_origin_unavailable` when the application origin is
///   not known yet, `guest_create` when the runtime refuses the child, or
///   `guest_observation` when its observations cannot be registered. Every
///   refusal happens before a child is allocated, or is followed by a close of
///   the child that was.
fn create_guest(
    app: &tauri::AppHandle<tauri::Wry>,
    window: &tauri::Window<tauri::Wry>,
    label: String,
    first_document: Option<url::Url>,
    data_directory: std::path::PathBuf,
    policy: GuestPolicy,
    observations: &ObservationSink,
) -> Result<Webview<tauri::Wry>, DshError> {
    webview2_guard::enforce(&policy)?;
    // The native window is denied on every path here; the popup decision belongs
    // to the WebView2 registration in `webview2_guard`. Two independent
    // `NewWindowRequested` registrations therefore refuse the native window.
    let builder = guest_builder(label.clone(), data_directory, &policy)
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);
    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::<f64>::new(0.0, 0.0),
            tauri::LogicalSize::<f64>::new(0.0, 0.0),
        )
        .map_err(|error| native_guest_error("create", error))?;
    if let Err(error) = observation::install(&webview, observations) {
        // A guest without observations would answer `guest_browser_state` with
        // nothing, so it is closed here rather than left running half-instrumented.
        let _ = webview.close();
        return Err(error);
    }
    webview2_guard::install(&webview, app.clone(), label, policy, first_document)?;
    Ok(webview)
}

/// Create one Sidebar Browser guest.
///
/// The guest starts at the reference's inert `about:blank#<lease>` document and
/// has no first document of its own: the client navigates it later, and that
/// navigation is filtered by the navigation hook while every request it issues
/// is filtered by [`webview2_guard`].
///
/// @param app - application handle.
/// @param window - owning application window.
/// @param user_data - application user-data directory.
/// @param context - the window's guest context, for the application origin.
/// @param lease - the browser guest's reservation.
/// @param partition - workspace storage partition the isolation root is derived from.
/// @param observations - the carrier's document observations.
/// @returns the created child webview.
fn create_browser_guest(
    app: &tauri::AppHandle<tauri::Wry>,
    window: &tauri::Window<tauri::Wry>,
    user_data: &std::path::Path,
    context: &GuestContext,
    lease: &str,
    partition: &str,
    observations: &ObservationSink,
) -> Result<Webview<tauri::Wry>, DshError> {
    let label = browser_label(lease);
    // The isolation root is derived from the WORKSPACE partition, never from
    // the lease: every tab of one workspace must share one storage jar.
    let directory = guest_directory(user_data, PartitionKind::Browser, partition)?;
    tracing::debug!(
        target: "dsh::guests",
        partition = %partition,
        directory = %directory.display(),
        "browser guest created"
    );
    let seed = webview2_guard::inert_seed(lease);
    let policy = GuestPolicy::browser(context.application_origin().map(str::to_string), seed);
    create_guest(app, window, label, None, directory, policy, observations)
}

/// One Platform document's identity, as the registry's request carried it.
///
/// The page, the account origin it is confined to and the account-scoped storage
/// partition always travel together: the document URL is the page joined to the
/// origin, and the isolation root is derived from the partition. Passing them as
/// one value keeps them from being transposed positionally and keeps the creation
/// call's argument list to the four it shares with a browser guest plus the
/// document and its observations.
struct PlatformDocument<'a> {
    /// `usage` or `top-up`.
    page: &'a str,
    /// The account origin the document is confined to.
    origin: &'a str,
    /// Account storage partition the isolation root is derived from.
    partition: &'a str,
}

/// Create the embedded Platform document.
///
/// Unlike a browser guest this one has a real first document, so it is requested
/// only after the WebView2 handlers are registered.
///
/// The document gets the same observations as a browser guest, published on the
/// same wire channel under its fixed label; no browser lease matches that label,
/// so only a consumer that asks for the Platform document's own state can read
/// it.
///
/// @param app - application handle.
/// @param window - owning application window.
/// @param user_data - application user-data directory.
/// @param context - the window's guest context, for the application origin.
/// @param document - the document's page, account origin and storage partition.
/// @param observations - the carrier's document observations.
/// @returns the created child webview.
fn create_platform_guest(
    app: &tauri::AppHandle<tauri::Wry>,
    window: &tauri::Window<tauri::Wry>,
    user_data: &std::path::Path,
    context: &GuestContext,
    document: PlatformDocument<'_>,
    observations: &ObservationSink,
) -> Result<Webview<tauri::Wry>, DshError> {
    let url = platform_page_url(document.page, document.origin)?;
    let directory = guest_directory(user_data, PartitionKind::Platform, document.partition)?;
    tracing::debug!(
        target: "dsh::guests",
        partition = %document.partition,
        directory = %directory.display(),
        "platform guest created"
    );
    let seed = webview2_guard::inert_seed(PLATFORM_GUEST_LABEL);
    // A Platform document is confined to its account origin for navigation, but
    // its subresources are ordinary `http(s)` requests and the application Host
    // is refused for them too, which the reference relies on CORS to achieve.
    let policy = GuestPolicy::platform(
        document.origin.to_string(),
        context.application_origin().map(str::to_string),
        seed,
    );
    create_guest(
        app,
        window,
        PLATFORM_GUEST_LABEL.to_string(),
        Some(url),
        directory,
        policy,
        observations,
    )
}

/// Create (once) the isolation directory of one guest partition.
///
/// WebView2 creates the environment from this path; it must exist beforehand so
/// a failure is reported where the guest is created rather than surfacing as an
/// opaque environment-creation error.
fn guest_directory(
    user_data: &std::path::Path,
    kind: PartitionKind,
    partition: &str,
) -> Result<std::path::PathBuf, DshError> {
    let directory = webview_data_directory(user_data, kind, partition);
    std::fs::create_dir_all(&directory).map_err(|error| {
        DshError::io(
            "create guest data directory",
            Some(directory.display().to_string()),
            &error,
        )
    })?;
    Ok(directory)
}

/// The Platform document URL for one page.
///
/// Upstream builds `new URL(page === 'usage' ? '/usage' : '/top_up',
/// account.origin)` and adds `?dist=<embeddedPageDist>` from the account
/// session. `embeddedPageDist` is published by the Host control message and held
/// with the account session in `AppState`; the command layer must pass it here
/// once it forwards the session.
///
/// @param page - `usage` or `top-up`.
/// @param origin - the account origin the document is confined to.
/// @returns the absolute document URL.
pub fn platform_page_url(page: &str, origin: &str) -> Result<url::Url, DshError> {
    let base = url::Url::parse(origin)
        .map_err(|error| DshError::invalid_argument("origin", error.to_string()))?;
    let path = if page == "usage" { "/usage" } else { "/top_up" };
    base.join(path)
        .map_err(|error| DshError::invalid_argument("origin", error.to_string()))
}

/// The same URL with the embedded deployment parameter applied last.
///
/// @param url - result of [`platform_page_url`].
/// @param embedded_page_dist - account `embeddedPageDist`, when published.
/// @returns the URL the document is loaded from.
#[cfg(test)]
pub fn with_embedded_page_dist(url: url::Url, embedded_page_dist: Option<&str>) -> url::Url {
    let mut url = url;
    if let Some(dist) = embedded_page_dist {
        if !dist.is_empty() {
            url.query_pairs_mut().append_pair("dist", dist);
        }
    }
    url
}

/// The guest isolation roots that must survive an uninstall (upstream keeps
/// workspace storage; the Platform partition is sanitized on every open).
#[cfg(test)]
pub fn guest_data_roots(user_data: &std::path::Path) -> Vec<std::path::PathBuf> {
    vec![user_data.join(WEBVIEW_DATA_RELATIVE_PATH)]
}

/// The Platform locale id for one shell language tag (upstream
/// `() => locale.id === 'zh-CN' ? 'zh_CN' : 'en_US'`).
#[cfg(test)]
pub fn platform_locale(language_tag: &str) -> &'static str {
    if language_tag.to_lowercase().starts_with("zh") {
        PLATFORM_LOCALE_ZH
    } else {
        PLATFORM_LOCALE_EN
    }
}

/// Whether a pending guest operation may still act on the live document.
///
/// A caller captures the generation before opening; a newer open advances it, so
/// the older operation stops here instead of closing a document it no longer
/// owns (upstream `DesktopPlatformView.generation`).
#[cfg(test)]
pub fn generation_is_current(views: &super::registry::GuestViews, captured: u64) -> bool {
    views.platform_generation() == captured
}

#[cfg(test)]
mod tests {
    use super::super::geometry::GuestBounds;
    use super::super::registry::{GuestViews, PlatformGuestRequest};
    use super::*;

    #[test]
    fn platform_locale_matches_the_reference_rule() {
        assert_eq!(platform_locale("zh"), PLATFORM_LOCALE_ZH);
        assert_eq!(platform_locale("zh-Hans-CN"), PLATFORM_LOCALE_ZH);
        assert_eq!(platform_locale("en"), PLATFORM_LOCALE_EN);
        assert_eq!(platform_locale("de-DE"), PLATFORM_LOCALE_EN);
        assert_eq!(platform_locale(""), PLATFORM_LOCALE_EN);
    }

    #[test]
    fn platform_page_urls_are_built_from_the_account_origin() {
        assert_eq!(
            platform_page_url("usage", "https://platform.example")
                .expect("usage")
                .as_str(),
            "https://platform.example/usage"
        );
        assert_eq!(
            platform_page_url("top-up", "https://platform.example/deploy/")
                .expect("top-up")
                .as_str(),
            "https://platform.example/top_up"
        );
        assert!(platform_page_url("usage", "not a url").is_err());
    }

    /// `embeddedPageDist` is appended, never invented.
    #[test]
    fn embedded_page_dist_is_applied_only_when_published() {
        let url = platform_page_url("usage", "https://platform.example").expect("usage");
        assert_eq!(
            with_embedded_page_dist(url.clone(), None).as_str(),
            "https://platform.example/usage"
        );
        assert_eq!(
            with_embedded_page_dist(url.clone(), Some("")).as_str(),
            "https://platform.example/usage"
        );
        assert_eq!(
            with_embedded_page_dist(url, Some("stable-2026")).as_str(),
            "https://platform.example/usage?dist=stable-2026"
        );
    }

    #[test]
    fn guest_data_root_is_the_user_data_subdirectory() {
        let roots = guest_data_roots(std::path::Path::new("U:\\user data"));
        assert_eq!(
            roots,
            vec![std::path::Path::new("U:\\user data").join("webview-data")]
        );
    }

    #[test]
    fn guest_keys_separate_leases_from_the_platform_view() {
        assert_eq!(
            guest_key(&NativeGuestAction::DestroyBrowser {
                lease: "l-1".to_string()
            }),
            "guest-browser-l-1"
        );
        assert_eq!(
            guest_key(&NativeGuestAction::ClosePlatform { generation: 0 }),
            "guest-platform"
        );
    }

    /// A guest that has not been observed yet answers nothing, which is what
    /// makes `guest_browser_state` refuse instead of inventing a settled state.
    #[test]
    fn an_unobserved_guest_has_no_state() {
        let context = GuestContext::new(Some("http://127.0.0.1:41234".to_string()));
        assert_eq!(context.observed("guest-browser-l-1"), None);
        assert_eq!(context.observed(PLATFORM_GUEST_LABEL), None);
        assert!(context.webview("guest-browser-l-1").is_none());
    }

    /// The empty teardown a retried exit performs is not a no-op that pretends to
    /// have released something: it sweeps, it owns nothing, and it stays
    /// idempotent.
    ///
    /// The retained-handle half of the rule needs a live WebView2 to execute
    /// (`NativeGuestView` owns a real child), so it is covered where it is pure:
    /// `observation::retry_pending_releases` hands every unconfirmed identity back
    /// to its owner instead of dropping it.
    #[test]
    fn a_teardown_that_owns_nothing_is_confirmed_and_stays_idempotent() {
        let mut context = GuestContext::new(Some("http://127.0.0.1:41234".to_string()));
        assert!(release_every_guest(&mut context).is_ok());
        assert!(context.pending_teardown.is_empty());
        assert!(context.views.is_empty());
        // A second sweep of the same context releases nothing and confirms nothing
        // new, which is what makes a repeated exit attempt safe.
        assert!(release_every_guest(&mut context).is_ok());
        assert!(context.pending_teardown.is_empty());
    }

    /// A label with no tracked view is not this context's identity to release, and
    /// releasing it claims no child was closed.
    #[test]
    fn releasing_an_untracked_label_is_not_an_ownership_claim() {
        let mut context = GuestContext::new(None);
        assert!(release_tracked(&mut context, "guest-browser-never-created").is_ok());
        assert!(context.pending_teardown.is_empty());
    }

    /// A retry keeps what it could not release, in attempt order, and the label is
    /// carried with the handle so the next attempt names the same child.
    #[test]
    fn an_unconfirmed_retry_keeps_the_handle_and_its_label() {
        let retained = vec![
            "guest-browser-a".to_string(),
            PLATFORM_GUEST_LABEL.to_string(),
        ];
        let (first_error, still_retained) =
            observation::retry_pending_releases(retained, |label| match label.as_str() {
                PLATFORM_GUEST_LABEL => Err(DshError::other(
                    "guest_release_fixture",
                    "injected release failure",
                )),
                _ => Ok(()),
            });
        assert!(matches!(
            first_error,
            Some(DshError::Other { code, .. }) if code == "guest_release_fixture"
        ));
        assert_eq!(still_retained, vec![PLATFORM_GUEST_LABEL.to_string()]);
    }

    /// The state event name is the wire name the bridge subscribes to.
    #[test]
    fn the_state_event_is_the_frozen_wire_name() {
        assert_eq!(
            super::super::native::GUEST_BROWSER_STATE_EVENT,
            "dsh://guests/browser-state"
        );
        assert_ne!(
            super::super::native::GUEST_BROWSER_STATE_EVENT,
            GUEST_BROWSER_OPEN_EVENT
        );
    }

    /// The application label is not a guest label, which is what keeps the
    /// desktop bridge out of reach of guest content.
    #[test]
    fn guest_labels_never_collide_with_the_application_window() {
        let lease = "f0a1";
        let browser = browser_label(lease);
        assert_ne!(browser, APPLICATION_WINDOW_LABEL);
        assert_ne!(PLATFORM_GUEST_LABEL, APPLICATION_WINDOW_LABEL);
        assert!(browser.starts_with(BROWSER_GUEST_LABEL_PREFIX));
        assert!(browser.ends_with(lease));
    }

    /// A browser guest is refused the application origin and allowed elsewhere;
    /// a Platform guest is confined to its account origin in both directions.
    #[test]
    fn the_navigation_hook_applies_the_right_policy_per_guest_kind() {
        let application = "http://127.0.0.1:41234";
        let origin = "https://platform.example";
        let application_url = url::Url::parse("http://127.0.0.1:41234/api").expect("url");
        let elsewhere = url::Url::parse("https://example.com/a").expect("url");
        let account = url::Url::parse("https://platform.example/usage").expect("url");
        let other_account = url::Url::parse("https://other.example/usage").expect("url");

        assert!(!guest_navigation_allowed(
            &application_url,
            Some(application),
            None
        ));
        assert!(guest_navigation_allowed(
            &elsewhere,
            Some(application),
            None
        ));
        assert!(guest_navigation_allowed(&account, None, Some(origin)));
        assert!(!guest_navigation_allowed(
            &other_account,
            None,
            Some(origin)
        ));
        // A Platform guest is confined even to the application origin.
        assert!(!guest_navigation_allowed(
            &application_url,
            None,
            Some(origin)
        ));
    }

    /// A guest is created at the reference's inert document and that document
    /// is the only one the port's own navigation filter exempts. Every other
    /// navigation, including a second guest's seed, is still judged by
    /// `guest_navigation_allowed`, which refuses `about:` outright.
    #[test]
    fn the_seed_is_the_only_navigation_the_port_itself_exempts() {
        let application = "http://127.0.0.1:41234";
        let lease = "l-1";
        let seed = webview2_guard::inert_seed(lease);
        assert_eq!(seed.as_str(), "about:blank#l-1");
        // The exemption exists only because the port requested that exact URL.
        assert!(webview2_guard::seed_navigation_allowed(&seed, &seed));
        // The underlying policy still refuses the inert scheme for a page that
        // navigates itself anywhere in `about:`.
        assert!(!guest_navigation_allowed(&seed, Some(application), None));
        let other = webview2_guard::inert_seed("l-2");
        assert!(!webview2_guard::seed_navigation_allowed(&other, &seed));
    }

    /// The download answer is the named reference rule, and the rule is `false`.
    #[test]
    fn the_download_answer_is_the_reference_rule_itself() {
        assert!(!super::super::policy::allowed_download());
    }

    #[test]
    fn generation_guard_tracks_the_live_document() {
        let mut views = GuestViews::new(true, true);
        let captured = views.platform_generation();
        assert!(generation_is_current(&views, captured));
        views
            .open_platform(PlatformGuestRequest {
                page: "usage".to_string(),
                origin: "https://platform.example".to_string(),
                user_id: Some("u-1".to_string()),
                embedded_page_dist: None,
                has_session: true,
                bounds: GuestBounds {
                    x: 0,
                    y: 0,
                    width: 100,
                    height: 100,
                },
            })
            .expect("open");
        assert!(!generation_is_current(&views, captured));
    }
}
