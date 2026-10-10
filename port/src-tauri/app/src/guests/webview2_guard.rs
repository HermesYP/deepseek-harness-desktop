//! Fail-closed policy for native guest child webviews, and the WebView2
//! enforcement of the part of it the pinned SDK can express.
//!
//! [`super::native::guest_builder`] states the reference policy in Tauri
//! handlers. The decisions themselves live here as pure functions so they can
//! be tested without a window, a COM apartment or a network, and
//! [`install`] turns the expressible ones into WebView2 registrations.
//!
//! | Reference rule | Upstream source | State in this port |
//! | --- | --- | --- |
//! | navigation is `http(s)` without credentials and never the application Host | `browser-guests.ts` `allowedNavigation` | enforced by wry's `NavigationStarting` hook |
//! | no download | `configureSession` `session.on('will-download')` | enforced by wry's `DownloadStarting` hook |
//! | every permission request and check is denied | `configureSession` `setPermissionRequestHandler` / `setPermissionCheckHandler` / `setDevicePermissionHandler` / `setDisplayMediaRequestHandler` | enforced by `ICoreWebView2::add_PermissionRequested` |
//! | an HTTP authentication prompt is refused | `browser-guests.ts` `guest.on('login', …)` | enforced by `add_BasicAuthenticationRequested` |
//! | a Platform popup opens externally over `https` only, never as a native window | `platform-view.ts` `setWindowOpenHandler` | enforced by `add_NewWindowRequested` |
//! | every subresource request is scheme-checked, credential-checked and refused when it names the application Host | `configureSession` `webRequest.onBeforeRequest` | enforced by a `'*'` filter + `add_WebResourceRequested` + `SetResponse` |
//! | a popup carrying a request body is never handed to the client | `guest.setWindowOpenHandler` `postBody === undefined` | no per-popup observation exists — see [`popup_body_is_observable`] |
//!
//! ## The request filter is what makes the request rule exist
//!
//! `ICoreWebView2::add_WebResourceRequested` in the pinned binding publishes
//! two parameters, not four (`webview2-com-sys 0.38.2` `bindings.rs:1682-1698`):
//! there is no filter array on the registration itself. A registration without
//! a wildcard filter never fires, so the handler below — and with it the
//! refusal of the loopback application Host — is unreachable unless a filter is
//! added first. [`REQUEST_FILTER_URI`] is that filter: WebView2's `'*'`, with
//! `COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL`.
//!
//! The filter is registered by a separate call because it has to be:
//! `ICoreWebView2_22::AddWebResourceRequestedFilterWithRequestSourceKinds`
//! (`bindings.rs:41520`) is the only published form that states which request
//! *sources* it reaches, and the two-argument
//! `ICoreWebView2::AddWebResourceRequestedFilter` does not. wry needs the
//! same distinction for its custom protocols and documents the same gap
//! (`wry-0.55.1/src/webview2/mod.rs:936-948`,
//! MicrosoftEdge/WebView2Feedback#1114). [`install`] therefore refuses a
//! runtime that cannot register the three-source-kind form instead of
//! filtering a guest partially — see [`enforce_request_coverage`].
//!
//! ## Refusing a popup is not refusing the guest
//!
//! The pinned SDK exposes no per-popup signal for a request method or body, so
//! [`popup_outcome`] refuses every Sidebar Browser popup. That is a fail-closed
//! answer for one feature — open-in-new-tab inside a guest — and it does **not**
//! block the guest itself: a Browser guest is created normally and navigates,
//! requests and loads documents exactly as the reference does. Losing the popup
//! is the cost of not being able to prove one is bodyless. Refusing the guest
//! would discard far more than that evidence justifies, so nothing here refuses
//! a guest for the popup rule.
//!
//! ## How a refused request is stopped
//!
//! `ICoreWebView2WebResourceRequestedEventArgs` in the pinned binding publishes
//! exactly `Request`, `Response`, `SetResponse`, `GetDeferral` and
//! `ResourceContext` — there is no `SetCancel`. The supported way to stop a
//! request is to answer it so that it never leaves:
//! [`webview2::install_request_filter`] calls `SetResponse` with a bodyless
//! `403` built by `ICoreWebView2Environment::CreateWebResourceResponse`, so a
//! refused address is never sent on the network. That is what makes
//! `onBeforeRequest` enforceable here, including the refusal of the loopback
//! application Host for every subresource.
//!
//! ## Nothing here opens a window
//!
//! The registration never calls `GetDeferral`, never `SetNewWindow` and never
//! `SetHandled(false)`. wry's own `NewWindowRequested` handler still runs
//! (`wry-0.55.1/src/webview2/mod.rs:702-788`) and still returns
//! `NewWindowResponse::Deny`, so the native window is refused by two
//! independent registrations and the observation here cannot depend on the
//! order in which COM delivers them.
//!
//! ## Hook installation precedes the first document
//!
//! [`install`] queues the registration on the WebView2 UI thread, and the
//! caller passes the guest's real first document separately. The document is
//! requested from inside that same callback, after every handler is registered,
//! so a guest never issues an unfiltered request. A registration failure closes
//! the child and the document is never requested. See
//! [`super::native::create_guest`].
//!
//! `ICoreWebView2::add_*` registrations are owned by the WebView2 runtime until
//! the child webview is destroyed; the `EventRegistrationToken` values are only
//! needed to *remove* a handler, which guest teardown does not need.

use dsh_core::error::DshError;
use tauri::{Emitter, Manager};

use super::policy::{
    allowed_external_popup, allowed_navigation, allowed_platform_navigation, allowed_request,
    classify_popup, popup_is_form_submission, PopupDecision,
};

/// Machine code for a guest this SDK cannot create inside the reference policy.
pub const GUEST_POLICY_UNAVAILABLE: &str = "guest_policy_unavailable";

/// Machine code for a guest the port refuses because the application origin is
/// not known yet.
pub const GUEST_ORIGIN_UNAVAILABLE: &str = "guest_origin_unavailable";

/// Machine code for a guest the port refuses because the pinned WebView2
/// interface cannot register a request filter that reaches every request source
/// the reference's `onBeforeRequest` reaches.
pub const GUEST_REQUEST_COVERAGE_UNAVAILABLE: &str = "guest_request_coverage_unavailable";

/// The wildcard every request filter is registered against.
///
/// WebView2's filter grammar accepts `'*'` as "every address this webview can
/// name", which is the same set the reference's `onBeforeRequest` sees. Any
/// narrower filter would leave a request class — and therefore the refusal of
/// the application Host in it — unfiltered.
pub const REQUEST_FILTER_URI: &str = "*";

/// `COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS` exactly as
/// `webview2-com-sys 0.38.2` publishes it (`bindings.rs:998-1012`).
///
/// Mirrored as plain `i32` bit values so the coverage rules below are ordinary
/// functions that can be decided and tested with no COM apartment. On Windows
/// `the_pinned_binding_publishes_exactly_these_source_kinds` asserts the mirror
/// against the binding itself, so a dependency bump cannot silently change what
/// the port believes it registered.
pub mod request_source_kinds {
    /// No request source.
    pub const NONE: i32 = 0;
    /// A top-level document, and every subframe document: WebView2 reports a
    /// subframe navigation with this kind, and the pinned binding names no
    /// separate frame kind.
    pub const DOCUMENT: i32 = 1;
    /// A shared worker.
    pub const SHARED_WORKER: i32 = 2;
    /// A dedicated service worker registration or fetch.
    pub const SERVICE_WORKER: i32 = 4;
    /// Every kind, including kinds a future runtime adds.
    pub const ALL: i32 = -1;

    /// Every kind the pinned binding names, paired with its name, so a coverage
    /// decision can say which one it is missing.
    pub const PUBLISHED: &[(i32, &str)] = &[
        (NONE, "NONE"),
        (DOCUMENT, "DOCUMENT"),
        (SHARED_WORKER, "SHARED_WORKER"),
        (SERVICE_WORKER, "SERVICE_WORKER"),
        (ALL, "ALL"),
    ];
}

/// The request sources the port requires its one filter to reach.
///
/// `DOCUMENT` covers documents and frames together because the pinned binding
/// publishes no separate frame kind. `SHARED_WORKER` and `SERVICE_WORKER` are
/// required in their own right because the two-argument
/// `AddWebResourceRequestedFilter` is documented not to reach shared workers on
/// every runtime, so a guest filtered through it alone would be filtered
/// partially and the port cannot tell which parts.
pub const REQUIRED_REQUEST_SOURCE_KINDS: i32 = request_source_kinds::DOCUMENT
    | request_source_kinds::SHARED_WORKER
    | request_source_kinds::SERVICE_WORKER;

/// Whether one registered filter's source kinds reach every required source.
pub fn request_coverage_is_complete(granted: i32) -> bool {
    granted & REQUIRED_REQUEST_SOURCE_KINDS == REQUIRED_REQUEST_SOURCE_KINDS
}

/// Whether this WebView2 runtime can be given the coverage the port requires.
///
/// Called with the outcome of registering
/// `AddWebResourceRequestedFilterWithRequestSourceKinds` for every required
/// kind. That call publishes no out-parameter for the kinds it applied, so a
/// `true` here means the runtime **accepted** the full source-kind filter — it is
/// an acceptance claim, not a measurement of what the runtime went on to filter.
/// A runtime that refuses the call offers only the two-argument filter, whose
/// shared-worker coverage is not guaranteed, so the answer is a refusal and the
/// guest is torn down rather than created under a filter the port cannot
/// account for.
///
/// @param source_kind_filter_accepted - whether the source-kind form of
///   `AddWebResourceRequestedFilter` was accepted for [`REQUEST_FILTER_URI`].
/// @returns `Ok` when the runtime took the required source kinds.
pub fn enforce_request_coverage(source_kind_filter_accepted: bool) -> Result<(), DshError> {
    if source_kind_filter_accepted {
        return Ok(());
    }
    Err(DshError::other(
        GUEST_REQUEST_COVERAGE_UNAVAILABLE,
        "the WebView2 runtime would not register a '*' request filter for the document, \
         shared worker and service worker sources, so no guest is created under a filter \
         that cannot reach them",
    ))
}

/// What the port does with one intercepted request.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RequestInterception {
    /// Let the request proceed to the network.
    Allowed,
    /// Answer it with a bodyless `403` so it is never sent.
    Refused,
}

/// Decide one intercepted request, including the case where it cannot be read.
///
/// The reference's `onBeforeRequest` decides *every* request
/// (`configureSession` `webRequest.onBeforeRequest`), so a request the port
/// cannot read is one it cannot decide, and an undecided request in a
/// fail-closed port is a refusal. Passing it would let an unparsed address —
/// which is exactly what an address that failed to parse looks like — reach the
/// network.
///
/// @param address - the address WebView2 published, or `None` when it could not
///   be read.
/// @param application_origin - owned gateway origin, never reachable.
pub fn intercept_request(
    address: Option<&str>,
    application_origin: Option<&str>,
) -> RequestInterception {
    match address {
        Some(address) if request_allowed(address, application_origin) => {
            RequestInterception::Allowed
        }
        // `None` never falls through to the network: see above.
        _ => RequestInterception::Refused,
    }
}

/// Name currently known concrete source-kind bits, not measured coverage.
///
/// `ALL` is a mask sentinel covering future kinds too, not another concrete kind.
pub fn describe_request_source_kinds(granted: i32) -> String {
    let named = request_source_kinds::PUBLISHED
        .iter()
        .filter(|(kind, _)| {
            *kind != request_source_kinds::NONE
                && *kind != request_source_kinds::ALL
                && granted & *kind == *kind
        })
        .map(|(_, name)| *name)
        .collect::<Vec<_>>();
    if named.is_empty() {
        return "NONE".to_string();
    }
    named.join("|")
}

/// One intercepted request, exactly as the port saw it.
///
/// Produced for every request the filter delivers, so a native qualification run
/// can show what the handler actually saw rather than what it was supposed to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequestObservation {
    /// The address WebView2 published, or `None` when it could not be read —
    /// which is itself a refusal, never a pass.
    pub address: Option<String>,
    /// `COREWEBVIEW2_WEB_RESOURCE_CONTEXT` as `webview2-com-sys 0.38.2`
    /// publishes it (`bindings.rs:37855`).
    pub resource_context: i32,
    /// `RequestedSourceKind` bits, or
    /// [`request_source_kinds::NONE`] when the runtime published none.
    pub source_kinds: i32,
    /// The decision the port made.
    pub decision: RequestInterception,
}

/// Where every intercepted request is reported.
///
/// `None` in the application: the port decides and answers, and nothing watches.
/// The native interception probe supplies one so a qualification run can show
/// the handler firing, the addresses it saw and the decisions it made.
pub type RequestObserver = std::sync::Arc<dyn Fn(RequestObservation) + Send + Sync>;

/// The ordered registrations [`install`] performs on the WebView2 UI thread.
///
/// Held as a value rather than a comment so the ordering the port depends on —
/// the request filter before the guest's first document — is a testable
/// property of this module.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum SetupStep {
    /// Register the `'*'` filter for every resource context and request source,
    /// then the handler that decides each request.
    RequestFilter,
    /// Deny every permission request and check.
    PermissionDenial,
    /// Refuse every HTTP authentication prompt.
    AuthenticationRefusal,
    /// Observe and decide every window-open request, never opening one.
    PopupObservation,
    /// Request the guest's real first document.
    FirstDocument,
}

/// The setup order, which is also the order [`install`] walks.
pub const SETUP_PLAN: &[SetupStep] = &[
    SetupStep::RequestFilter,
    SetupStep::PermissionDenial,
    SetupStep::AuthenticationRefusal,
    SetupStep::PopupObservation,
    SetupStep::FirstDocument,
];

/// The origins and inert seed one guest's rules are decided against.
///
/// Cloned into every closure the UI thread owns, so it carries owned `String`s
/// and no borrow of the guest map.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GuestPolicy {
    application_origin: Option<String>,
    platform_origin: Option<String>,
    seed: url::Url,
}

impl GuestPolicy {
    /// A Sidebar Browser guest: may reach any approved `http(s)` address and
    /// never the application origin.
    ///
    /// @param application_origin - owned gateway origin, or `None` before the
    ///   Host has published one.
    /// @param seed - [`inert_seed`] of the lease this guest is created under.
    pub fn browser(application_origin: Option<String>, seed: url::Url) -> Self {
        Self {
            application_origin,
            platform_origin: None,
            seed,
        }
    }

    /// The embedded Platform document: confined to its account origin.
    ///
    /// @param platform_origin - the account origin the document is opened for.
    /// @param application_origin - owned gateway origin. Upstream does not
    ///   block the application Host from a Platform session; this port does,
    ///   because the document is untrusted content inside a loopback shell.
    ///   The reference relies on CORS, which stops the response being read and
    ///   not the request being made.
    /// @param seed - the inert document this guest is created at.
    pub fn platform(
        platform_origin: String,
        application_origin: Option<String>,
        seed: url::Url,
    ) -> Self {
        Self {
            application_origin,
            platform_origin: Some(platform_origin),
            seed,
        }
    }

    /// The owned gateway origin every request decision is made against.
    pub fn application_origin(&self) -> Option<&str> {
        self.application_origin.as_deref()
    }

    /// The Platform account origin, when this guest is the embedded document.
    pub fn platform_origin(&self) -> Option<&str> {
        self.platform_origin.as_deref()
    }

    /// The inert document the guest itself was created at.
    pub fn seed(&self) -> &url::Url {
        &self.seed
    }
}

/// The inert document a guest is created at before its first real navigation.
///
/// @param fragment - the guest's own identity, which upstream spells as the
///   fragment of `about:blank#<lease>`; the Platform guest uses its fixed label
///   because it has no lease.
/// @returns `about:blank#<fragment>`, which carries no network request and no
///   script.
pub fn inert_seed(fragment: &str) -> url::Url {
    url::Url::parse(&format!("about:blank#{fragment}"))
        .expect("about:blank is a valid URL with a fragment")
}

/// Whether the port's own inert seed may commit.
///
/// WebView2 reports `NavigationStarting` for the document the host itself asked
/// for. Upstream never filters it — the reference's `will-frame-navigate`
/// listener is attached after the guest's `dom-ready`, and the seed is a webview
/// `src`, not a navigation — so a port that filters it cancels the only
/// document it authorized. The comparison is against the exact address this
/// guest was created with, not against the `about:` scheme, so a page that
/// navigates itself to any other `about:` URL is still refused by
/// [`allowed_navigation`].
///
/// @param url - the address WebView2 is about to commit.
/// @param seed - [`GuestPolicy::seed`] of the guest being created.
pub fn seed_navigation_allowed(url: &url::Url, seed: &url::Url) -> bool {
    url.as_str().eq_ignore_ascii_case(seed.as_str())
}

/// What one window-open request means to this port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupOutcome {
    /// Tell the application client to open a new Browser tab at this address.
    PublishToClient { url: String },
    /// Hand this address to the operating system browser, with no embedded
    /// session and no token.
    OpenExternally { url: String },
    /// Refuse silently: no native window, no client event, no external launch.
    Denied,
}

/// Decide one window-open request from what WebView2 exposed about it.
///
/// The reference's popup rule is `postBody === undefined`. The pinned SDK
/// exposes nothing that reports it:
///
/// * `ICoreWebView2NewWindowRequestedEventArgs` publishes `Uri`, `NewWindow`,
///   `SetNewWindow`, `SetHandled`, `Handled`, `IsUserInitiated`, `GetDeferral`
///   and `WindowFeatures` — none carries a request method or a body.
/// * The one `AdditionalBrowserArguments` in `webview2-com-sys 0.38.2` belongs
///   to `ICoreWebView2EnvironmentOptions` (`bindings.rs:15975`), the options of
///   an environment WebView2 would *create*; it is not a property of a pending
///   window.
///
/// This states what the pinned binding offers and makes no claim about which
/// WebView2 interface, if any, could report this. The consequence is that
/// `additional_browser_arguments` is always absent, so a browser popup is
/// refused rather than guessed at. A Platform popup is unaffected: upstream
/// ignores the body there.
///
/// @param policy - the requesting guest's origins.
/// @param url - the requested address.
/// @param additional_browser_arguments - the new window's browser arguments, or
///   `None` when no observation is available. `None` is treated as a request
///   body, which refuses the popup.
pub fn popup_outcome(
    policy: &GuestPolicy,
    url: &str,
    additional_browser_arguments: Option<&str>,
) -> PopupOutcome {
    if policy.platform_origin().is_some() {
        // Upstream's Platform window handler inspects the scheme and embedded
        // credentials only; it never looks at a body, so a failing checkout
        // POST still opens the payment page for the user to retry.
        return match allowed_external_popup(url) {
            true => PopupOutcome::OpenExternally {
                url: url.to_string(),
            },
            false => PopupOutcome::Denied,
        };
    }
    // `popup_is_form_submission` is the reference's `postBody === undefined`
    // test. The WebView2 method clause it also accepts is always empty here: the
    // runtime publishes no request method for a pending new window, so the
    // `--form-submit-<method>` argument Chromium writes into that window's
    // command line is the only signal that exists. An unreadable argument is
    // treated as a body rather than folded into the empty string, because
    // "not observed" and "observed empty" must not decide the same way.
    let has_body = match additional_browser_arguments {
        Some(arguments) => popup_is_form_submission(arguments, ""),
        None => true,
    };
    match classify_popup(url, has_body, policy.application_origin()) {
        PopupDecision::OpenRequested { url } => PopupOutcome::PublishToClient { url },
        PopupDecision::Denied => PopupOutcome::Denied,
    }
}

/// Whether one subresource request may proceed (upstream `onBeforeRequest`).
///
/// @param url - the address WebView2 is about to request.
/// @param application_origin - owned gateway origin, never reachable.
pub fn request_allowed(url: &str, application_origin: Option<&str>) -> bool {
    allowed_request(url, application_origin)
}

/// Whether a guest may commit this address as its first document.
///
/// A Platform document is confined to its account origin. A browser guest's
/// first document must satisfy both the navigation rule and the request rule,
/// because the request rule is the stricter of the two wherever they differ.
///
/// @param policy - the guest's origins.
/// @param url - the address the port is about to request.
pub fn first_document_allowed(policy: &GuestPolicy, url: &str) -> bool {
    match policy.platform_origin() {
        Some(origin) => allowed_platform_navigation(url, origin),
        None => {
            allowed_navigation(url, policy.application_origin())
                && request_allowed(url, policy.application_origin())
        }
    }
}

/// Whether this guest's policy can name the application Host at all.
///
/// `is_application_request` answers `false` for every address while
/// `application_origin` is `None`, so navigation and request rules silently
/// degrade to "refuse nothing extra" before the Host has published its URL. A
/// guest created in that window could reach the loopback gateway. The only
/// document that stays reachable is the guest's own inert seed, which the port
/// requests itself and which carries no network request.
///
/// @param policy - the guest about to be created.
/// @returns whether the application origin is known.
pub fn application_origin_is_known(policy: &GuestPolicy) -> bool {
    policy.application_origin().is_some()
}

/// Refuse a guest created before the application origin is known, and any
/// guest on a platform with no WebView2 to enforce the policy against.
///
/// This is the only creation-time refusal. The popup rule deliberately does not
/// appear here: refusing a popup is a decision about one feature, and the guest
/// that would have opened it is still created and still protected by every
/// other rule.
///
/// @param policy - the guest about to be created.
/// @returns a typed refusal, or `Ok` when the guest may be created.
pub fn enforce(policy: &GuestPolicy) -> Result<(), DshError> {
    if !cfg!(windows) {
        return Err(DshError::other(
            GUEST_POLICY_UNAVAILABLE,
            "native guest policy hooks are implemented only against WebView2",
        ));
    }
    if application_origin_is_known(policy) {
        return Ok(());
    }
    Err(DshError::other(
        GUEST_ORIGIN_UNAVAILABLE,
        "no guest is created before the application origin is known: without it the guest \
         policy cannot refuse the application Host",
    ))
}

/// Queue the policy handlers for one child webview.
///
/// The registrations run on the WebView2 UI thread, which is the only apartment
/// that may touch `ICoreWebView2`. `first_document` is requested from inside
/// that same callback, after every handler is registered, so the guest's first
/// request is always filtered. If a registration fails the child is closed and
/// the document is never requested: every step in [`SETUP_PLAN`] — including the
/// `'*'` request filter — ends at the same teardown, so a guest is never left
/// running under a filter that was not registered.
///
/// @param webview - the newly created child webview.
/// @param app - handle used to deliver a popup and to close the child.
/// @param label - the child webview label, used for the popup event payload.
/// @param policy - the guest's origins and inert seed.
/// @param first_document - the guest's real first document, or `None` when the
///   client is expected to navigate it later.
/// @throws {DshError} when the UI thread cannot accept the registration, or on
///   a platform with no WebView2 to register against.
pub fn install(
    webview: &tauri::Webview<tauri::Wry>,
    app: tauri::AppHandle<tauri::Wry>,
    label: String,
    policy: GuestPolicy,
    first_document: Option<url::Url>,
) -> Result<(), DshError> {
    #[cfg(windows)]
    {
        let app = app.clone();
        let label = label.clone();
        webview
            .with_webview(move |native| {
                let app = app.clone();
                let label = label.clone();
                // Owned: the runtime keeps the request handler, and therefore
                // this teardown, until the child is destroyed.
                let teardown: webview2::Teardown = std::sync::Arc::new({
                    let app = app.clone();
                    let label = label.clone();
                    move || close(&app, &label)
                });
                let outcome = unsafe {
                    webview2::install(
                        &native,
                        &app,
                        &label,
                        &teardown,
                        &policy,
                        first_document.as_ref(),
                    )
                };
                if let Err((step, error)) = outcome {
                    tracing::error!(
                        target: "dsh::guests",
                        label = %label,
                        step = ?step,
                        code = ?error.code(),
                        "guest policy hooks could not be installed; the guest is closed before requesting a document"
                    );
                    // The existing teardown: the child is closed and never
                    // navigates, so a failed registration costs a guest rather
                    // than leaving one running unfiltered.
                    close(&app, &label);
                }
            })
            .map_err(|error| {
                DshError::other(
                    "guest_policy",
                    format!("guest policy hooks could not be scheduled: {error}"),
                )
            })
    }
    #[cfg(not(windows))]
    {
        let _ = (webview, app, label, policy, first_document);
        Err(DshError::other(
            GUEST_POLICY_UNAVAILABLE,
            "native guest policy hooks are implemented only against WebView2",
        ))
    }
}

/// Close a child webview, ignoring a failure to do so.
pub fn close(app: &tauri::AppHandle<tauri::Wry>, label: &str) {
    if let Some(webview) = app.get_webview(label) {
        let _ = webview.close();
    }
}

/// Carry one decided popup out of the UI thread to the application client, or to
/// the operating system browser.
///
/// Runs on the WebView2 UI thread. Neither call blocks: emission dispatches to
/// the renderers and `tauri_plugin_opener` runs the platform launch.
///
/// @param app - application handle.
/// @param lease - the guest whose document asked.
/// @param outcome - the decision [`popup_outcome`] returned.
pub fn deliver(app: &tauri::AppHandle<tauri::Wry>, lease: &str, outcome: PopupOutcome) {
    match outcome {
        PopupOutcome::PublishToClient { url } => {
            let request = super::native::BrowserOpenRequest {
                lease: lease.to_string(),
                url,
            };
            let _ = app.emit(super::native::GUEST_BROWSER_OPEN_EVENT, request);
        }
        PopupOutcome::OpenExternally { url } => {
            // The reference hands a failing checkout to the user's own browser
            // and keeps the embedded page available for a retry, so a launch
            // failure stays a logged non-event.
            if let Err(error) = open_in_os_browser(&url) {
                tracing::warn!(
                    target: "dsh::guests",
                    error = %crate::renderer_diagnostics::sanitize_field(
                        &crate::renderer_diagnostics::redact(&error.to_string())
                    ),
                    "the platform popup could not be handed to the operating system browser"
                );
            }
        }
        PopupOutcome::Denied => {}
    }
}

/// Hand one approved Platform popup to the operating system browser.
///
/// @param url - `https:` address with no embedded credentials.
/// @returns the typed refusal when the platform launch failed.
pub fn open_in_os_browser(url: &str) -> Result<(), DshError> {
    let parsed = url::Url::parse(url)
        .map_err(|error| DshError::invalid_argument("url", error.to_string()))?;
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| DshError::other("guest_popup", error.to_string()))
}

/// WebView2 registrations, on the UI thread's apartment.
#[cfg(windows)]
mod webview2 {
    use webview2_com::{
        BasicAuthenticationRequestedEventHandler, Microsoft::Web::WebView2::Win32::*,
        NewWindowRequestedEventHandler, PermissionRequestedEventHandler,
        WebResourceRequestedEventHandler,
    };
    use windows::core::{IUnknown, Interface, PCWSTR, PWSTR};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    use super::{
        close, deliver, describe_request_source_kinds, enforce_request_coverage,
        first_document_allowed, intercept_request, popup_outcome, request_coverage_is_complete,
        request_source_kinds, GuestPolicy, RequestInterception, RequestObservation,
        RequestObserver, SetupStep, REQUEST_FILTER_URI, REQUIRED_REQUEST_SOURCE_KINDS, SETUP_PLAN,
    };

    /// The teardown a WebView2 callback can invoke when the guest can no longer
    /// be kept safe.
    ///
    /// Owned rather than borrowed because the runtime retains a request handler
    /// until the child webview is destroyed, which is long after the callback
    /// that registered it has returned. In the application this is the existing
    /// close of the child webview; the native interception probe supplies its
    /// own, so both drive the same registration code.
    pub(super) type Teardown = std::sync::Arc<dyn Fn() + Send + Sync>;

    /// Install every guest policy handler and then request the first document.
    ///
    /// # Safety
    ///
    /// Must run on the WebView2 UI thread inside `Webview::with_webview`. Every
    /// COM interface and every `FnMut` handler created here is created, used and
    /// dropped on that one thread; the `Send + 'static` closure that reaches this
    /// function carries only owned Rust values.
    pub(super) unsafe fn install(
        native: &tauri::webview::PlatformWebview,
        app: &tauri::AppHandle<tauri::Wry>,
        label: &str,
        teardown: &Teardown,
        policy: &GuestPolicy,
        first_document: Option<&url::Url>,
    ) -> Result<(), (SetupStep, windows::core::Error)> {
        let webview = native.controller().CoreWebView2().map_err(|error| {
            (
                SetupStep::RequestFilter,
                windows::core::Error::new(error.code(), "the guest controller has no CoreWebView2"),
            )
        })?;

        // SAFETY (for every registration and the navigation below): the caller
        // runs on the WebView2 UI thread, `ICoreWebView2` came from this
        // controller, and the runtime retains each registered handler until the
        // child is destroyed.
        unsafe {
            // `SETUP_PLAN` is walked rather than the steps being written out, so
            // the order the port depends on cannot drift away from the order the
            // tests assert.
            for step in SETUP_PLAN {
                let result = match step {
                    SetupStep::RequestFilter => {
                        // No observer in the application: the port decides and
                        // answers, and nothing watches. The native interception
                        // probe drives this same function with one.
                        install_request_filter(&webview, policy, teardown.clone(), None)
                    }
                    SetupStep::PermissionDenial => install_permission_denial(&webview),
                    SetupStep::AuthenticationRefusal => install_authentication_refusal(&webview),
                    SetupStep::PopupObservation => {
                        install_popup_observation(&webview, app, label, policy)
                    }
                    SetupStep::FirstDocument => {
                        match first_document {
                            // No first document: the client navigates later, and
                            // that navigation is covered by the filter above.
                            None => Ok(()),
                            // Refused here rather than after: a document this
                            // policy refuses must not be requested at all.
                            Some(document) => {
                                if !first_document_allowed(policy, document.as_str()) {
                                    tracing::error!(
                                        target: "dsh::guests",
                                        label = %label,
                                        "the guest's first document is not permitted by the guest policy"
                                    );
                                    close(app, label);
                                    return Err((
                                        *step,
                                        windows::core::Error::new(
                                            windows::Win32::Foundation::E_ACCESSDENIED,
                                            "guest first document refused",
                                        ),
                                    ));
                                }
                                webview.Navigate(&windows::core::HSTRING::from(document.as_str()))
                            }
                        }
                    }
                };
                if let Err(error) = result {
                    return Err((*step, error));
                }
            }
        }
        Ok(())
    }

    /// Register the filter that makes the request handler reachable, then the
    /// handler itself.
    ///
    /// Two registrations, in this order, because the pinned binding publishes no
    /// filter array on `add_WebResourceRequested`
    /// (`webview2-com-sys 0.38.2` `bindings.rs:1682-1698`). Without
    /// [`REQUEST_FILTER_URI`] registered first the handler is never invoked, so
    /// every rule below it would be dead code and the application Host would be
    /// reachable from every guest. wry splits the same two registrations for its
    /// custom protocols (`wry-0.55.1/src/webview2/mod.rs:920-956`).
    ///
    /// # Safety
    ///
    /// Runs on the WebView2 UI thread; `webview` came from this controller on
    /// this thread.
    pub(super) unsafe fn install_request_filter(
        webview: &ICoreWebView2,
        policy: &GuestPolicy,
        teardown: Teardown,
        observer: Option<RequestObserver>,
    ) -> windows::core::Result<()> {
        // SAFETY (this function): caller contract above. `Interface::cast` is the
        // `QueryInterface` this port relies on, so the boundary it crosses is
        // named rather than hidden behind an `as_unknown` convenience.
        unsafe {
            register_request_filter(&webview.cast::<IUnknown>()?)?;
        }
        // `ICoreWebView2_2` publishes `Environment`; an older runtime refuses the
        // cast, which is reported rather than ignored, because silently dropping
        // this rule would leave every subresource unfiltered.
        let environment: ICoreWebView2Environment =
            webview.cast::<ICoreWebView2_2>()?.Environment()?;
        let origin = policy.application_origin().map(str::to_string);
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else {
                // Nothing can be answered without the event arguments. WebView2
                // withholds them only while it is destroying the webview, so there
                // is no request in flight to refuse; this is reported because it
                // is the one shape of this callback that cannot fail closed.
                tracing::error!(
                    target: "dsh::guests",
                    "WebView2 delivered a resource request with no event arguments and the \
                     runtime is tearing the guest down"
                );
                return Ok(());
            };
            let mut uri = PWSTR::null();
            let address = match args.Request().and_then(|request| request.Uri(&mut uri)) {
                Ok(()) => webview2_com::take_pwstr(uri),
                Err(error) => {
                    // An address that cannot be read is refused, never passed.
                    tracing::warn!(
                        target: "dsh::guests",
                        error = %error,
                        "an intercepted guest request could not be read and is refused rather than passed"
                    );
                    report(
                        &observer,
                        RequestObservation {
                            address: None,
                            resource_context: observed_resource_context(&args),
                            source_kinds: observed_request_source_kinds(&args),
                            decision: RequestInterception::Refused,
                        },
                    );
                    // SAFETY: this callback runs on the WebView2 UI thread and
                    // owns both arguments.
                    return unsafe { refuse(&args, &environment, &teardown) };
                }
            };
            let kinds = observed_request_source_kinds(&args);
            let decision = intercept_request(Some(address.as_str()), origin.as_deref());
            report(
                &observer,
                RequestObservation {
                    address: Some(address.clone()),
                    resource_context: observed_resource_context(&args),
                    source_kinds: kinds,
                    decision,
                },
            );
            match decision {
                RequestInterception::Allowed => {
                    tracing::trace!(
                        target: "dsh::guests",
                        %address,
                        source_kinds = %describe_request_source_kinds(kinds),
                        "guest request allowed"
                    );
                    Ok(())
                }
                RequestInterception::Refused => {
                    tracing::debug!(
                        target: "dsh::guests",
                        %address,
                        source_kinds = %describe_request_source_kinds(kinds),
                        "guest request refused before it reaches the network"
                    );
                    // SAFETY: this callback runs on the WebView2 UI thread and
                    // owns both arguments.
                    unsafe { refuse(&args, &environment, &teardown) }
                }
            }
        }));
        let mut token = 0i64;
        webview.add_WebResourceRequested(&handler, &mut token)
    }

    /// Hand one observation to the optional observer. A failing observer is
    /// dropped, not reported: it watches, it never decides, so its own failure
    /// must not change the decision already made.
    fn report(observer: &Option<RequestObserver>, observation: RequestObservation) {
        if let Some(observer) = observer {
            observer(observation);
        }
    }

    /// The resource context WebView2 attributed to the request now in hand.
    ///
    /// Evidence only. Coverage is decided from the filter registration, never
    /// from this read, because a runtime that published no context would
    /// otherwise be mistaken for one that filters less.
    fn observed_resource_context(args: &ICoreWebView2WebResourceRequestedEventArgs) -> i32 {
        // SAFETY: `args` is a live `ICoreWebView2WebResourceRequestedEventArgs`
        // owned by this callback, and the out-parameter is a local.
        let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT::default();
        unsafe { args.ResourceContext(&mut context) }
            .map(|()| context.0)
            .unwrap_or_default()
    }

    /// Register the one wildcard filter, for every resource context and every
    /// request source the reference's `onBeforeRequest` sees.
    ///
    /// Takes `IUnknown` rather than `ICoreWebView2` because that is the whole of
    /// what it uses — one cast — and narrowing it makes this the single place the
    /// coverage decision crosses a COM boundary. That boundary is what the
    /// native interception probe drives with a deliberate failure, so the
    /// fail-closed answer is exercised against real COM rather than described.
    ///
    /// # Safety
    ///
    /// Runs on the WebView2 UI thread. `source` must be a live COM object whose
    /// `QueryInterface` for `ICoreWebView2_22` is safe to call.
    pub(super) unsafe fn register_request_filter(source: &IUnknown) -> windows::core::Result<()> {
        let filter: Vec<u16> = REQUEST_FILTER_URI
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // `ICoreWebView2_22` publishes the source-kind form of the call. A
        // runtime that refuses the cast offers only
        // `ICoreWebView2::AddWebResourceRequestedFilter`, whose shared-worker
        // coverage is not guaranteed (MicrosoftEdge/WebView2Feedback#1114, cited
        // by wry-0.55.1 at `src/webview2/mod.rs:936-948`), so this port does
        // not fall back to it: a guest filtered through it would be filtered
        // partially and nothing here could tell which parts.
        const REQUESTED: i32 = REQUIRED_REQUEST_SOURCE_KINDS;
        let registered = unsafe {
            source.cast::<ICoreWebView2_22>().and_then(|webview| {
                webview.AddWebResourceRequestedFilterWithRequestSourceKinds(
                    PCWSTR(filter.as_ptr()),
                    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
                    COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS(REQUESTED),
                )
            })
        };
        // What was *asked for*, not what was granted.
        //
        // `AddWebResourceRequestedFilterWithRequestSourceKinds` returns
        // `Result<()>` and publishes no out-parameter for the kinds it actually
        // applied, so there is no value here that could observe coverage. The
        // only real signal is whether the runtime accepted the call for the three
        // required source kinds (mask 7). This is an **acceptance** claim, not a
        // measurement, so nothing may describe it as granted coverage.
        // The request must still contain everything the port requires; asking for
        // less than this would be refused by `enforce_request_coverage` below
        // even if a runtime accepted it.
        debug_assert!(request_coverage_is_complete(REQUESTED));
        let accepted = registered.is_ok();
        if let Err(error) = enforce_request_coverage(accepted) {
            tracing::error!(
                target: "dsh::guests",
                filter = REQUEST_FILTER_URI,
                requested = %describe_request_source_kinds(REQUESTED),
                required = %describe_request_source_kinds(REQUIRED_REQUEST_SOURCE_KINDS),
                detail = %error,
                "this WebView2 runtime would not accept a '*' request filter for the required \
                 source kinds, so no guest is created under an incomplete filter"
            );
            return Err(windows::core::Error::new(
                windows::Win32::Foundation::E_NOINTERFACE,
                "WebView2 would not accept the required request filter coverage",
            ));
        }
        registered
    }

    /// The request sources WebView2 attributes to the request now in hand.
    ///
    /// `ICoreWebView2WebResourceRequestedEventArgs2` publishes
    /// `RequestedSourceKind` (`webview2-com-sys 0.38.2` `bindings.rs:38032`).
    /// This is evidence only, and never admission: the filter was registered for
    /// every source kind before the handler existed, so a runtime too old to
    /// publish this still filters every request it delivers. A refusal here would
    /// claim a coverage gap that the registration has already ruled out.
    fn observed_request_source_kinds(args: &ICoreWebView2WebResourceRequestedEventArgs) -> i32 {
        let Ok(args) = args.cast::<ICoreWebView2WebResourceRequestedEventArgs2>() else {
            return request_source_kinds::NONE;
        };
        // SAFETY: `args` is a live `ICoreWebView2WebResourceRequestedEventArgs2`
        // owned by this callback, and the out-parameter is a local.
        unsafe {
            let mut kinds = COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS::default();
            match args.RequestedSourceKind(&mut kinds) {
                Ok(()) => kinds.0,
                Err(error) => {
                    tracing::debug!(
                        target: "dsh::guests",
                        error = %error,
                        "an intercepted guest request did not report its source kind"
                    );
                    request_source_kinds::NONE
                }
            }
        }
    }

    /// Answer one request with the bodyless `403` that keeps it off the network.
    ///
    /// A refusal that cannot be delivered is the one path where a refused request
    /// could still reach the network. WebView2 offers no way to cancel from this
    /// interface, so the guest is closed through the same teardown a failed
    /// registration uses: losing the guest is cheaper than the one request this
    /// port promised never to make.
    ///
    /// # Safety
    ///
    /// Runs on the WebView2 UI thread; `environment` came from this controller on
    /// this thread and `args` is the live event argument for this callback.
    unsafe fn refuse(
        args: &ICoreWebView2WebResourceRequestedEventArgs,
        environment: &ICoreWebView2Environment,
        teardown: &Teardown,
    ) -> windows::core::Result<()> {
        // SAFETY (this function): caller contract above.
        let delivered = unsafe {
            refused_response(environment).and_then(|response| args.SetResponse(&response))
        };
        match delivered {
            Ok(()) => Ok(()),
            Err(error) => {
                tracing::error!(
                    target: "dsh::guests",
                    error = %error,
                    "a refused guest request could not be answered; the guest is closed rather \
                     than left able to send it"
                );
                teardown();
                Err(error)
            }
        }
    }

    /// The bodyless `403` that replaces one refused request.
    ///
    /// `SHCreateMemStream` with an empty initial buffer is a real, zero-length
    /// stream, so the response has no content and cannot be confused with the
    /// document the guest asked for. `Win32_UI_Shell` is already a dependency
    /// feature, so this needs no manifest change.
    ///
    /// # Safety
    ///
    /// Must run on the WebView2 UI thread; `environment` came from this
    /// controller on this thread.
    unsafe fn refused_response(
        environment: &ICoreWebView2Environment,
    ) -> windows::core::Result<ICoreWebView2WebResourceResponse> {
        let body = SHCreateMemStream(Some(&[]))
            .ok_or_else(|| windows::core::Error::from(windows::Win32::Foundation::E_FAIL))?;
        let reason: Vec<u16> = "Refused by the desktop guest policy"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let headers: Vec<u16> =
            "Content-Type: text/plain\r\nContent-Length: 0\r\nCache-Control: no-store\r\n"
                .encode_utf16()
                .chain(std::iter::once(0))
                .collect();
        environment.CreateWebResourceResponse(
            &body,
            403,
            PCWSTR(reason.as_ptr()),
            PCWSTR(headers.as_ptr()),
        )
    }

    /// Deny every permission the reference denies.
    ///
    /// wry installs an `add_PermissionRequested` handler that *allows* clipboard
    /// reads whenever a webview enables clipboard access
    /// (`wry-0.55.1/src/webview2/mod.rs:497-515`). `guest_builder` never calls
    /// `enable_clipboard_access`, so that registration does not exist for a
    /// guest; this one denies the kind unconditionally, so no future attribute
    /// on that builder can turn into a grant.
    unsafe fn install_permission_denial(webview: &ICoreWebView2) -> windows::core::Result<()> {
        let handler = PermissionRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
            Ok(())
        }));
        let mut token = 0i64;
        webview.add_PermissionRequested(&handler, &mut token)
    }

    /// Refuse HTTP authentication prompts (upstream `guest.on('login', …)`).
    unsafe fn install_authentication_refusal(webview: &ICoreWebView2) -> windows::core::Result<()> {
        // `ICoreWebView2_10` publishes the event; an older WebView2 runtime
        // refuses the cast, which is reported rather than ignored, because
        // silently dropping this rule would leave a guest able to answer an
        // HTTP challenge.
        let webview: ICoreWebView2_10 = webview.cast()?;
        let handler = BasicAuthenticationRequestedEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            // `callback()` with no arguments in the reference: cancel the
            // challenge without answering it.
            args.SetCancel(true)?;
            Ok(())
        }));
        let mut token = 0i64;
        webview.add_BasicAuthenticationRequested(&handler, &mut token)
    }

    /// Observe window-open requests and decide the popup, never opening one.
    unsafe fn install_popup_observation(
        webview: &ICoreWebView2,
        app: &tauri::AppHandle<tauri::Wry>,
        label: &str,
        policy: &GuestPolicy,
    ) -> windows::core::Result<()> {
        let app = app.clone();
        let label = label.to_string();
        let policy = policy.clone();
        let handler = NewWindowRequestedEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let url = webview2_com::take_pwstr(uri);
            // `None` says the body could not be observed. `popup_outcome` treats
            // that as a request body and refuses the popup, so a Platform popup
            // is unaffected and a browser popup could not be created anyway.
            deliver(&app, &label, popup_outcome(&policy, &url, None));
            // No deferral is taken, so none is completed, and nothing here opens
            // a window. wry's own registration refuses the native window.
            Ok(())
        }));
        let mut token = 0i64;
        webview.add_NewWindowRequested(&handler, &mut token)
    }
}

#[cfg(test)]
mod tests {
    use super::super::native::{browser_label, guest_navigation_allowed, PLATFORM_GUEST_LABEL};
    use super::*;

    const APPLICATION: &str = "http://127.0.0.1:41234";

    fn browser_policy() -> GuestPolicy {
        GuestPolicy::browser(Some(APPLICATION.to_string()), inert_seed("l-1"))
    }

    fn platform_policy() -> GuestPolicy {
        GuestPolicy::platform(
            "https://platform.example".to_string(),
            Some(APPLICATION.to_string()),
            inert_seed(PLATFORM_GUEST_LABEL),
        )
    }

    /// The document the port itself asked for is not refused by the port's own
    /// navigation filter.
    #[test]
    fn the_inert_seed_commits_but_no_other_about_document_does() {
        let policy = browser_policy();
        let seed = inert_seed("l-1");
        assert!(seed_navigation_allowed(&seed, policy.seed()));
        for refused in [
            "about:blank",
            "about:blank#other-lease",
            "about:srcdoc",
            "https://example.com/a",
        ] {
            let url = url::Url::parse(refused).expect("url");
            assert!(
                !seed_navigation_allowed(&url, policy.seed()),
                "{refused} must not pass as this guest's seed"
            );
        }
    }

    /// A second guest must not be able to present its own seed as this one's.
    #[test]
    fn a_seed_belongs_to_exactly_one_guest() {
        let first = browser_policy();
        let second = GuestPolicy::browser(Some(APPLICATION.to_string()), inert_seed("l-2"));
        let first_seed = inert_seed("l-1");
        assert!(seed_navigation_allowed(&first_seed, first.seed()));
        assert!(!seed_navigation_allowed(&first_seed, second.seed()));
    }

    /// The inert seed is genuinely inert: no host, no network scheme, no script,
    /// and the fragment is the lease the reference attaches to it.
    #[test]
    fn the_seed_document_carries_no_authority() {
        let seed = inert_seed("l-1");
        assert_eq!(seed.scheme(), "about");
        assert_eq!(seed.host_str(), None);
        assert_eq!(seed.as_str(), "about:blank#l-1");
        assert_eq!(browser_label("l-1"), "guest-browser-l-1");
    }

    /// A plain `window.open` reaches the client; the same request carrying a
    /// body does not, because the client would open it as a GET.
    #[test]
    fn a_popup_with_a_request_body_is_never_handed_to_the_client() {
        let policy = browser_policy();
        assert_eq!(
            popup_outcome(&policy, "https://example.com/next", Some("")),
            PopupOutcome::PublishToClient {
                url: "https://example.com/next".to_string()
            }
        );
        for arguments in [
            "--form-submit-post",
            "--FORM-SUBMIT-POST",
            "--enable-features=x --form-submit-put",
        ] {
            assert_eq!(
                popup_outcome(&policy, "https://example.com/post", Some(arguments)),
                PopupOutcome::Denied,
                "{arguments}"
            );
        }
    }

    /// The observation could not be made, so the popup is refused rather than
    /// assumed bodyless.
    #[test]
    fn an_unreadable_popup_observation_fails_closed() {
        let policy = browser_policy();
        assert_eq!(
            popup_outcome(&policy, "https://example.com/next", None),
            PopupOutcome::Denied
        );
    }

    /// The application origin and unapproved schemes are still refused with the
    /// body rule in place.
    #[test]
    fn popup_rules_hold_independently_of_the_body_observation() {
        let policy = browser_policy();
        assert_eq!(
            popup_outcome(&policy, APPLICATION, Some("")),
            PopupOutcome::Denied
        );
        assert_eq!(
            popup_outcome(&policy, "mailto:someone@example.com", Some("")),
            PopupOutcome::Denied
        );
        assert_eq!(
            popup_outcome(&policy, "https://user:pw@example.com/", Some("")),
            PopupOutcome::Denied
        );
    }

    /// Upstream's Platform handler never looks at a body; a failing checkout
    /// POST still opens the payment page for the user to retry.
    #[test]
    fn a_platform_popup_ignores_the_body_and_keeps_https() {
        let policy = platform_policy();
        assert_eq!(
            popup_outcome(
                &policy,
                "https://pay.example/checkout",
                Some("--form-submit-post")
            ),
            PopupOutcome::OpenExternally {
                url: "https://pay.example/checkout".to_string()
            }
        );
        assert_eq!(
            popup_outcome(&policy, "http://pay.example/checkout", Some("")),
            PopupOutcome::Denied
        );
        assert_eq!(
            popup_outcome(&policy, APPLICATION, Some("")),
            PopupOutcome::Denied
        );
    }

    /// The request rule reaches every subresource, not only the document.
    #[test]
    fn subresource_requests_follow_the_reference_allowlist() {
        assert!(request_allowed(
            "https://example.com/app.js",
            Some(APPLICATION)
        ));
        assert!(request_allowed(
            "wss://example.com/socket",
            Some(APPLICATION)
        ));
        assert!(request_allowed(
            "blob:https://example.com/9a1",
            Some(APPLICATION)
        ));
        assert!(!request_allowed(APPLICATION, Some(APPLICATION)));
        assert!(!request_allowed(
            "http://127.0.0.1:41234/api",
            Some(APPLICATION)
        ));
        assert!(!request_allowed(
            "file:///C:/Windows/win.ini",
            Some(APPLICATION)
        ));
        assert!(!request_allowed("chrome://settings", Some(APPLICATION)));
        assert!(!request_allowed(
            "https://user:pw@example.com/",
            Some(APPLICATION)
        ));
    }

    /// A browser guest's first document satisfies both rules, so a scheme the
    /// navigation rule allows but the request rule does not still cannot load.
    #[test]
    fn a_browser_first_document_must_satisfy_both_rules() {
        let policy = browser_policy();
        assert!(first_document_allowed(&policy, "https://example.com/"));
        // Websockets are requestable but never navigable.
        assert!(!first_document_allowed(&policy, "wss://example.com/socket"));
        // Inert schemes are requestable but never navigable.
        assert!(!first_document_allowed(&policy, "about:blank"));
        assert!(!first_document_allowed(&policy, APPLICATION));
    }

    /// The Platform document is confined by navigation, while its subresources
    /// may legitimately come from another origin; the application Host is
    /// refused for the document itself.
    #[test]
    fn a_platform_first_document_stays_on_the_account_origin() {
        let policy = platform_policy();
        assert!(first_document_allowed(
            &policy,
            "https://platform.example/usage?dist=stable"
        ));
        assert!(first_document_allowed(
            &policy,
            "https://platform.example/top_up"
        ));
        assert!(!first_document_allowed(
            &policy,
            "https://cdn.example/index.html"
        ));
        assert!(!first_document_allowed(&policy, APPLICATION));
        assert!(!first_document_allowed(
            &policy,
            "https://platform.example.evil.test/usage"
        ));
    }

    /// A guest is created inside the reference policy: the subresource rule is
    /// enforceable through `SetResponse`, and the popup rule costs only the
    /// popup. Neither refuses the guest.
    #[test]
    fn an_unobservable_popup_body_never_refuses_the_guest() {
        assert!(enforce(&browser_policy()).is_ok());
        assert!(enforce(&platform_policy()).is_ok());
    }

    /// Losing the ability to classify a popup costs the popup and nothing else:
    /// a plain `window.open` to an approved address is refused, but the guest
    /// still navigates, requests and loads exactly as the reference does.
    #[test]
    fn a_browser_popup_is_refused_but_the_guest_still_loads() {
        let policy = browser_policy();
        assert_eq!(
            popup_outcome(&policy, "https://example.com/next", None),
            PopupOutcome::Denied
        );
        // The same guest's own documents and subresources are unaffected.
        assert!(first_document_allowed(&policy, "https://example.com/"));
        assert!(request_allowed(
            "https://example.com/app.js",
            Some(APPLICATION)
        ));
        assert!(guest_navigation_allowed(
            &url::Url::parse("https://example.com/next").expect("url"),
            Some(APPLICATION),
            None
        ));
    }

    /// The request rule is the one that keeps a guest off the loopback
    /// application Host for every subresource, and it is decided per address.
    #[test]
    fn the_subresource_rule_reaches_the_application_host() {
        for address in [
            APPLICATION,
            "http://127.0.0.1:41234/api/state",
            "http://localhost:41234/",
            "https://user:pw@example.com/",
            "file:///C:/Windows/win.ini",
            "chrome://settings",
        ] {
            assert!(!request_allowed(address, Some(APPLICATION)), "{address}");
        }
        // A CDN asset a Platform document legitimately needs is not refused.
        assert!(request_allowed(
            "https://cdn.example/app.js",
            Some(APPLICATION)
        ));
    }

    /// The pure decision rules degrade to "refuse nothing extra" while the
    /// application origin is unknown, which is why creation is refused instead
    /// of relying on them.
    #[test]
    fn an_unknown_application_origin_refuses_creation_instead_of_degrading() {
        for policy in [
            GuestPolicy::browser(None, inert_seed("l-1")),
            GuestPolicy::platform(
                "https://platform.example".to_string(),
                None,
                inert_seed(PLATFORM_GUEST_LABEL),
            ),
        ] {
            assert!(!application_origin_is_known(&policy));
            // The degradation the refusal exists to prevent.
            assert!(allowed_navigation("http://127.0.0.1:41234/api", None));
            assert!(request_allowed("http://127.0.0.1:41234/api", None));
            match enforce(&policy) {
                Err(DshError::Other { code, message }) => {
                    assert_eq!(code, GUEST_ORIGIN_UNAVAILABLE);
                    assert!(message.contains("application origin"), "{message}");
                }
                other => panic!("an unknown origin must refuse the guest, got {other:?}"),
            }
        }
    }

    /// A known origin restores creation, and that is the only reason left to
    /// refuse a guest.
    #[test]
    fn a_known_origin_is_the_only_creation_refusal() {
        assert!(application_origin_is_known(&browser_policy()));
        assert!(application_origin_is_known(&platform_policy()));
        assert!(enforce(&browser_policy()).is_ok());
        assert!(enforce(&platform_policy()).is_ok());
    }

    /// The controlled initial blank is the one document an unknown origin still
    /// leaves reachable, and it names no network request.
    #[test]
    fn the_controlled_initial_blank_is_the_only_document_left_reachable() {
        let seed = inert_seed("l-1");
        // The port may commit the seed it requested itself.
        assert!(seed_navigation_allowed(&seed, &seed));
        // A page that navigates to it is refused by the navigation rule.
        assert!(!allowed_navigation(seed.as_str(), None));
        // The request rule admits it only because `about:` is inert: it names no
        // authority, so leaving it reachable costs nothing.
        assert!(request_allowed(seed.as_str(), None));
        assert_eq!(seed.scheme(), "about");
        assert_eq!(seed.host_str(), None);
    }

    /// The filter is the wildcard, because the reference's `onBeforeRequest`
    /// decides every request and a narrower filter would leave a whole class of
    /// them — and the application Host inside it — unfiltered.
    #[test]
    fn the_request_filter_is_the_wildcard_and_not_a_narrower_uri() {
        assert_eq!(REQUEST_FILTER_URI, "*");
        // A filter narrower than the wildcard would leave these unfiltered.
        for narrower in ["http://*", "https://example.com/*", ""] {
            assert_ne!(narrower, REQUEST_FILTER_URI, "{narrower}");
        }
    }

    /// The required coverage is documents and frames, shared workers and service
    /// workers, and the wildcard source kind reaches all three.
    #[test]
    fn the_required_coverage_is_documents_shared_workers_and_service_workers() {
        let required = REQUIRED_REQUEST_SOURCE_KINDS;
        for kind in [
            request_source_kinds::DOCUMENT,
            request_source_kinds::SHARED_WORKER,
            request_source_kinds::SERVICE_WORKER,
        ] {
            assert_eq!(required & kind, kind, "kind {kind} is not required");
        }
        assert_eq!(
            required,
            request_source_kinds::DOCUMENT
                | request_source_kinds::SHARED_WORKER
                | request_source_kinds::SERVICE_WORKER
        );
        // Frames are covered by the document kind: the pinned binding names no
        // separate frame kind, so a coverage set that wanted one could not be
        // expressed and must not be pretended to.
        assert!(
            !request_source_kinds::PUBLISHED
                .iter()
                .any(|(_, name)| name.contains("FRAME")),
            "the pinned binding publishes a frame kind this mirror does not know"
        );
    }

    /// Every partial coverage fails closed: `ALL` and nothing less is accepted.
    #[test]
    fn a_partial_request_coverage_is_refused() {
        assert!(request_coverage_is_complete(request_source_kinds::ALL));
        for partial in [
            request_source_kinds::NONE,
            request_source_kinds::DOCUMENT,
            request_source_kinds::DOCUMENT | request_source_kinds::SHARED_WORKER,
            request_source_kinds::SHARED_WORKER | request_source_kinds::SERVICE_WORKER,
            1 | 4,
        ] {
            assert!(!request_coverage_is_complete(partial), "{partial}");
        }
    }

    /// The two-argument filter, the one a runtime without `ICoreWebView2_22`
    /// offers, is not evidence of coverage and cannot be used as one.
    #[test]
    fn a_runtime_without_the_source_kind_filter_refuses_the_guest() {
        assert!(enforce_request_coverage(true).is_ok());
        match enforce_request_coverage(false) {
            Err(DshError::Other { code, message }) => {
                assert_eq!(code, GUEST_REQUEST_COVERAGE_UNAVAILABLE);
                assert!(message.contains("document"), "{message}");
                assert!(message.contains("shared worker"), "{message}");
                assert!(message.contains("service worker"), "{message}");
            }
            other => panic!("missing request coverage must refuse the guest, got {other:?}"),
        }
        // The refusal names a distinct code from the other two creation-time
        // refusals, so a caller can tell "cannot filter" from "cannot name the
        // application Host".
        assert_ne!(GUEST_REQUEST_COVERAGE_UNAVAILABLE, GUEST_ORIGIN_UNAVAILABLE);
        assert_ne!(GUEST_REQUEST_COVERAGE_UNAVAILABLE, GUEST_POLICY_UNAVAILABLE);
    }

    /// An address that could not be read is refused, not passed. This is the
    /// whole reason `intercept_request` takes an `Option`: the reference decides
    /// every request, so an undecided one is a refusal.
    #[test]
    fn an_unreadable_request_is_refused_rather_than_passed() {
        assert_eq!(
            intercept_request(None, Some(APPLICATION)),
            RequestInterception::Refused
        );
        // Even before the application origin is known, "not observed" is a
        // refusal and never a silent pass.
        assert_eq!(intercept_request(None, None), RequestInterception::Refused);
    }

    /// The interception decision is the request rule, and it agrees with it for
    /// every address the rule decides.
    #[test]
    fn the_interception_decision_agrees_with_the_request_rule() {
        for address in [
            "https://example.com/app.js",
            "wss://example.com/socket",
            APPLICATION,
            "http://127.0.0.1:41234/api",
            "file:///C:/Windows/win.ini",
            "chrome://settings",
            "https://user:pw@example.com/",
        ] {
            assert_eq!(
                intercept_request(Some(address), Some(APPLICATION)),
                if request_allowed(address, Some(APPLICATION)) {
                    RequestInterception::Allowed
                } else {
                    RequestInterception::Refused
                },
                "{address}"
            );
        }
    }

    /// The filter is registered before the guest's first document, and it is the
    /// first thing the UI thread does, so no guest ever issues an unfiltered
    /// request.
    #[test]
    fn the_request_filter_is_registered_before_the_first_document() {
        let filter = SETUP_PLAN
            .iter()
            .position(|step| *step == SetupStep::RequestFilter)
            .expect("the request filter is in the setup plan");
        let first_document = SETUP_PLAN
            .iter()
            .position(|step| *step == SetupStep::FirstDocument)
            .expect("the first document is in the setup plan");
        assert_eq!(
            filter, 0,
            "the request filter must be the first registration, not one installed after a \
             request has already been issued"
        );
        assert!(
            filter < first_document,
            "a filter registered after the first navigation cannot filter it"
        );
        // Every step appears exactly once, so no registration is silently
        // skipped by the loop that walks the plan.
        let mut seen = std::collections::BTreeSet::new();
        for step in SETUP_PLAN {
            assert!(
                seen.insert(*step),
                "{step:?} appears twice in the setup plan"
            );
        }
        assert_eq!(seen.len(), SETUP_PLAN.len());
    }

    /// Known source-kind bit names describe masks, not measured coverage.
    #[test]
    fn a_coverage_gap_can_be_named() {
        assert_eq!(
            describe_request_source_kinds(request_source_kinds::NONE),
            "NONE"
        );
        assert_eq!(
            describe_request_source_kinds(request_source_kinds::DOCUMENT),
            "DOCUMENT"
        );
        assert_eq!(
            describe_request_source_kinds(request_source_kinds::ALL),
            "DOCUMENT|SHARED_WORKER|SERVICE_WORKER"
        );
        assert_eq!(
            describe_request_source_kinds(REQUIRED_REQUEST_SOURCE_KINDS),
            describe_request_source_kinds(request_source_kinds::ALL)
        );
        // The one gap that actually matters on an older runtime — no shared
        // worker coverage — is legible in the log rather than implicit.
        assert_eq!(
            describe_request_source_kinds(
                request_source_kinds::ALL & !request_source_kinds::SHARED_WORKER
            ),
            "DOCUMENT|SERVICE_WORKER"
        );
        assert!(!request_coverage_is_complete(
            request_source_kinds::ALL & !request_source_kinds::SHARED_WORKER
        ));
    }

    /// On Windows the mirrored bit values are the binding's own constants, so a
    /// dependency bump cannot quietly change what the port believes it
    /// registered.
    #[cfg(windows)]
    #[test]
    fn the_pinned_binding_publishes_exactly_these_source_kinds() {
        use webview2_com::Microsoft::Web::WebView2::Win32::*;

        assert_eq!(
            request_source_kinds::NONE,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_NONE.0
        );
        assert_eq!(
            request_source_kinds::DOCUMENT,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_DOCUMENT.0
        );
        assert_eq!(
            request_source_kinds::SHARED_WORKER,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SHARED_WORKER.0
        );
        assert_eq!(
            request_source_kinds::SERVICE_WORKER,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_SERVICE_WORKER.0
        );
        assert_eq!(
            request_source_kinds::ALL,
            COREWEBVIEW2_WEB_RESOURCE_REQUEST_SOURCE_KINDS_ALL.0
        );
        // The filter is registered for the wildcard context, so the resource
        // context is not a second axis the port can get wrong.
        assert_eq!(COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL.0, 0);
    }

    /// COM-boundary failure: the casts this module relies on to *observe*
    /// coverage report a failure on an object that cannot support them, rather
    /// than yielding a bogus interface. The port treats that as "no evidence"
    /// and never as coverage.
    #[cfg(windows)]
    #[test]
    fn a_com_cast_onto_a_foreign_object_fails_instead_of_claiming_coverage() {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Environment, ICoreWebView2WebResourceRequestedEventArgs2, ICoreWebView2_22,
        };
        use windows::core::{IUnknown, Interface};
        use windows::Win32::UI::Shell::SHCreateMemStream;

        // SAFETY: `SHCreateMemStream` with an empty initial buffer creates a
        // zero-length in-memory stream; it needs no apartment and touches no
        // file.
        let stream = unsafe { SHCreateMemStream(Some(&[])) }.expect("a shell in-memory stream");
        // `SHCreateMemStream` returns an `IStream`, which supports none of the
        // interfaces this module casts for.
        assert!(stream.cast::<ICoreWebView2_22>().is_err());
        assert!(stream
            .cast::<ICoreWebView2WebResourceRequestedEventArgs2>()
            .is_err());
        assert!(stream.cast::<ICoreWebView2Environment>().is_err());
        // The observation path and the coverage path degrade the same way: a
        // cast that cannot succeed yields the base interface, and the required
        // set is never satisfied by a failed observation.
        assert!(stream.cast::<IUnknown>().is_ok());
        assert!(!request_coverage_is_complete(request_source_kinds::NONE));
    }
}

/// Native qualification of the request filter.
///
/// This is **not** a unit test. It stands up a real WebView2 environment, a real
/// `ICoreWebView2Controller` on a hidden message-only window, and two loopback
/// listeners it binds itself, then drives [`super::webview2::install_request_filter`]
/// — the same function the application uses — and records what the handler saw
/// and what the listeners received. It is `#[ignore]`d so an ordinary
/// `cargo test` never creates a window or a listener; it runs only when invoked
/// explicitly, and it writes its evidence **outside** its own WebView2 profile.
///
/// What it proves, and what it does not, is stated per check below. Nothing here
/// is a substitute for the unit tests above: those decide, this one observes.
///
/// # Preconditions the probe refuses to run without
///
/// * `DSH_PROBE_ROOT` names a directory that **already exists**, is **empty**,
///   and whose DACL this probe reads back and checks (see
///   [`require_private_root`]). The harness creates it with a current-user +
///   SYSTEM ACL *before* launching, because an ACL applied after the profile's
///   first byte exists is not an ACL applied at creation.
/// * The harness must choose a fresh GUID root under an OS-known plain
///   LocalAppData/Temp path, never repository `.scratch`. Every ancestor must be
///   non-reparse; no cloud-path exception is made. Evidence is a profile sibling.
/// * Ambient `WEBVIEW2_*` names or WebView2 policy-key presence/unreadability
///   refuse SDK creation. The actual SDK folder is attested before controllers.
///   These checks are not race-proof; an external watchdog and clean executor
///   remain mandatory. No successful traffic run qualifies whole guest admission.
#[cfg(all(test, windows))]
mod interception_probe {
    use std::io::{Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

    use std::os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::MetadataExt,
    };
    use webview2_com::CoreWebView2EnvironmentOptions;
    use webview2_com::Microsoft::Web::WebView2::Win32::*;
    use webview2_com::{
        CreateCoreWebView2ControllerCompletedHandler, CreateCoreWebView2EnvironmentCompletedHandler,
    };
    use windows::core::{IUnknown, Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS, HANDLE, HINSTANCE, HLOCAL, HWND,
        LPARAM, LRESULT, WIN32_ERROR, WPARAM,
    };
    use windows::Win32::Security::Authorization::{
        ConvertStringSidToSidW, GetNamedSecurityInfoW, SE_FILE_OBJECT,
    };
    use windows::Win32::Security::{
        AclSizeInformation, GetAce, GetAclInformation, GetLengthSid, GetSecurityDescriptorControl,
        GetTokenInformation, IsValidAcl, IsValidSid, TokenUser, ACCESS_ALLOWED_ACE, ACE_HEADER,
        ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, SE_DACL_PROTECTED, TOKEN_QUERY, TOKEN_USER,
    };
    use windows::Win32::System::Com::{
        CoInitializeEx, CoTaskMemFree, CoUninitialize, COINIT_APARTMENTTHREADED,
    };
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ,
        KEY_WOW64_32KEY, KEY_WOW64_64KEY, REG_SAM_FLAGS,
    };
    use windows::Win32::System::Threading::OpenProcessToken;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, DispatchMessageW, PeekMessageW, RegisterClassW,
        TranslateMessage, HWND_MESSAGE, MSG, PM_REMOVE, WINDOW_EX_STYLE, WNDCLASSW,
        WS_OVERLAPPEDWINDOW,
    };

    use super::{
        describe_request_source_kinds, inert_seed, intercept_request, request_source_kinds,
        GuestPolicy, RequestInterception, RequestObservation, REQUEST_FILTER_URI,
        REQUIRED_REQUEST_SOURCE_KINDS,
    };

    /// The decision type, under the name the corpus reads best with.
    type Decision = RequestInterception;

    /// Environment variable naming the pre-created, private, empty run root.
    const ROOT_VARIABLE: &str = "DSH_PROBE_ROOT";

    /// The whole run, bounded. Expiry ends *measurement*, never cleanup.
    const RUN_BUDGET: Duration = Duration::from_secs(150);

    /// Each COM creation gets its own bound, so a runtime that never completes
    /// fails the run instead of hanging the qualification gate forever.
    const CREATE_BUDGET: Duration = Duration::from_secs(30);

    /// The share of [`RUN_BUDGET`] the settle loop may take.
    const SETTLE_BUDGET: Duration = Duration::from_secs(75);

    /// Quiet period **after the most recent new hit**, re-armed on every hit.
    const SETTLE_QUIET: Duration = Duration::from_secs(6);

    /// One poll of the non-blocking accept loop, and therefore the upper bound on
    /// how long a listener takes to notice its stop flag.
    const POLL_INTERVAL: Duration = Duration::from_millis(10);

    /// The upper bound on one teardown step.
    const TEARDOWN_STEP_BUDGET: Duration = Duration::from_secs(10);

    /// How long the delayed worker-initiated application-origin request waits
    /// before it fires. It must land well inside [`SETTLE_QUIET`] so the quiet
    /// window is something the run actually waits for.
    const DELAYED_FETCH_DELAY_MS: u32 = 4_000;

    /// Deny ambient SDK overrides before the SDK can touch any profile.
    /// Only names and key-open statuses are inspected; no values are logged/read.
    /// This is a preflight, not a race-proof lock on environment or policy state.
    fn require_sdk_preflight(
        names: impl IntoIterator<Item = std::ffi::OsString>,
        mut open_policy: impl FnMut(HKEY, REG_SAM_FLAGS) -> WIN32_ERROR,
    ) -> Result<(), String> {
        if names.into_iter().any(|name| {
            name.to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("WEBVIEW2_")
        }) {
            return Err(
                "ambient WEBVIEW2_* override name present; SDK creation refused".to_string(),
            );
        }
        for (hive_name, hive) in [("HKCU", HKEY_CURRENT_USER), ("HKLM", HKEY_LOCAL_MACHINE)] {
            for (view_name, view) in [("32-bit", KEY_WOW64_32KEY), ("64-bit", KEY_WOW64_64KEY)] {
                let status = open_policy(hive, view);
                if status != ERROR_FILE_NOT_FOUND && status != ERROR_PATH_NOT_FOUND {
                    return Err(format!(
                        "WebView2 policy key must be absent in {hive_name}/{view_name}; open status {}",
                        status.0
                    ));
                }
            }
        }
        Ok(())
    }

    struct OwnedPolicyKey(HKEY);

    impl Drop for OwnedPolicyKey {
        fn drop(&mut self) {
            // SAFETY: this is a successfully opened key, never a predefined hive.
            let status = unsafe { RegCloseKey(self.0) };
            if status != ERROR_SUCCESS {
                tracing::error!(status = status.0, "probe policy key close failed");
            }
        }
    }

    fn sdk_override_preflight() -> Result<(), String> {
        require_sdk_preflight(std::env::vars_os().map(|(name, _)| name), |hive, view| {
            let mut key = HKEY::default();
            // SAFETY: fixed NUL-terminated policy path, predefined hive, valid out-pointer.
            // KEY_READ only; no values are queried and no registry writes are possible here.
            let status = unsafe {
                RegOpenKeyExW(
                    hive,
                    windows::core::w!("SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2"),
                    None,
                    KEY_READ | view,
                    &mut key,
                )
            };
            if status == ERROR_SUCCESS {
                let _owned = OwnedPolicyKey(key);
                // Any presence, including an empty key, causes conservative refusal.
            }
            status
        })
    }

    #[test]
    fn sdk_preflight_blocks_override_names_before_policy_reads() {
        for name in [
            "WEBVIEW2_USER_DATA_FOLDER",
            "webview2_browser_executable_folder",
            "WeBvIeW2_unknown",
            "WEBVIEW2_",
        ] {
            assert!(require_sdk_preflight([name.into()], |_, _| {
                panic!("override names must refuse before policy reads")
            })
            .is_err());
        }
    }

    #[test]
    fn sdk_preflight_requires_absence_in_both_hives_and_views() {
        let mut scopes = Vec::new();
        assert!(
            require_sdk_preflight(["SAFE_WEBVIEW2_NAME".into()], |hive, view| {
                scopes.push((hive, view));
                if view == KEY_WOW64_32KEY {
                    ERROR_FILE_NOT_FOUND
                } else {
                    ERROR_PATH_NOT_FOUND
                }
            })
            .is_ok()
        );
        assert_eq!(
            scopes,
            vec![
                (HKEY_CURRENT_USER, KEY_WOW64_32KEY),
                (HKEY_CURRENT_USER, KEY_WOW64_64KEY),
                (HKEY_LOCAL_MACHINE, KEY_WOW64_32KEY),
                (HKEY_LOCAL_MACHINE, KEY_WOW64_64KEY),
            ]
        );
    }

    #[test]
    fn sdk_preflight_refuses_presence_and_every_unreadable_scope() {
        use windows::Win32::Foundation::{
            ERROR_ACCESS_DENIED, ERROR_INVALID_PARAMETER, ERROR_MORE_DATA,
        };
        for refused_status in [
            ERROR_SUCCESS,
            ERROR_ACCESS_DENIED,
            ERROR_INVALID_PARAMETER,
            ERROR_MORE_DATA,
        ] {
            for refused_scope in 0..4 {
                let mut scope = 0;
                let outcome = require_sdk_preflight(std::iter::empty(), |_, _| {
                    let status = if scope == refused_scope {
                        refused_status
                    } else {
                        ERROR_FILE_NOT_FOUND
                    };
                    scope += 1;
                    status
                });
                assert!(outcome.is_err());
                assert_eq!(scope, refused_scope + 1);
            }
        }
    }

    /// A moment in this run that can be waited on.
    struct Deadline {
        at: Instant,
    }

    impl Deadline {
        fn after(budget: Duration) -> Self {
            Self {
                at: Instant::now() + budget,
            }
        }

        fn expired(&self) -> bool {
            Instant::now() >= self.at
        }

        fn left(&self) -> Duration {
            self.at.saturating_duration_since(Instant::now())
        }
    }

    /// One request this probe's own listener accepted. The listener is the only
    /// witness that a refused address never reached the network: a refusal that
    /// happened "in time" and a refusal that never dispatched look identical from
    /// inside the webview, and only one of them leaves no hit here.
    #[derive(Clone, Debug, serde::Serialize)]
    struct Hit {
        at_unix_ms: u128,
        method: String,
        target: String,
    }

    /// An accept-loop error. Recorded, never swallowed: a listener that stopped
    /// accepting for any reason other than its stop flag would otherwise look
    /// exactly like a listener nothing ever reached.
    #[derive(Clone, Debug, serde::Serialize)]
    struct Fault {
        at_unix_ms: u128,
        error: String,
    }

    /// A loopback listener this process owns: it binds `127.0.0.1:0`, so the
    /// port is chosen by the OS at run time and cannot collide with the
    /// application's gateway or with another run.
    struct OwnedListener {
        origin: String,
        hits: Arc<Mutex<Vec<Hit>>>,
        faults: Arc<Mutex<Vec<Fault>>>,
        /// When the most recent hit arrived, so the settle window can be
        /// re-armed on every new hit instead of measured from loop entry.
        last_hit: Arc<Mutex<Option<Instant>>>,
        stop_flag: Arc<AtomicBool>,
        worker: Option<std::thread::JoinHandle<()>>,
    }

    impl OwnedListener {
        /// Bind one owned listener.
        ///
        /// `application_origin` is the origin the *document* names when it asks
        /// for the application Host; the listener serves its own origin, which
        /// is different, so the two never collide.
        fn bind(name: &str, application_origin: &str) -> std::io::Result<Self> {
            let listener = TcpListener::bind("127.0.0.1:0")?;
            listener.set_nonblocking(true)?;
            // The OS picks the port, so it cannot collide with the gateway or
            // with another run.
            let addr = listener.local_addr()?;
            let origin = format!("http://{addr}");
            let hits = Arc::new(Mutex::new(Vec::new()));
            let faults = Arc::new(Mutex::new(Vec::new()));
            let last_hit = Arc::new(Mutex::new(None));
            let stop_flag = Arc::new(AtomicBool::new(false));
            let worker = {
                let hits = Arc::clone(&hits);
                let faults = Arc::clone(&faults);
                let last_hit = Arc::clone(&last_hit);
                let stop_flag = Arc::clone(&stop_flag);
                let name = name.to_string();
                let application_origin = application_origin.to_string();
                let self_origin = origin.clone();
                std::thread::spawn(move || {
                    serve(
                        listener,
                        ListenerLogs {
                            hits,
                            faults,
                            last_hit,
                            stop: stop_flag,
                        },
                        name,
                        application_origin,
                        self_origin,
                    )
                })
            };
            Ok(Self {
                origin,
                hits,
                faults,
                last_hit,
                stop_flag,
                worker: Some(worker),
            })
        }

        fn targets(&self) -> Vec<String> {
            self.hits
                .lock()
                .expect("the probe's own listener log")
                .iter()
                .map(|hit| hit.target.clone())
                .collect()
        }

        fn is_empty(&self) -> bool {
            self.hits
                .lock()
                .expect("the probe's own listener log")
                .is_empty()
        }

        fn faults(&self) -> Vec<Fault> {
            self.faults
                .lock()
                .expect("the probe's own fault log")
                .clone()
        }

        fn last_hit_at(&self) -> Option<Instant> {
            *self.last_hit.lock().expect("the probe's own listener log")
        }

        /// Ask the accept loop to stop, without waiting for it.
        fn stop(&self) {
            self.stop_flag.store(true, Ordering::SeqCst);
        }

        /// Wait for the accept loop to exit, for at most `budget`.
        ///
        /// `JoinHandle` has no timed join, so the thread is polled through
        /// `is_finished` after the stop flag is set.
        ///
        /// @returns whether the thread finished inside the budget. A `false`
        ///   here is a finding, not a warning: a listener still accepting on a
        ///   port the evidence calls closed is exactly the leftover this run
        ///   must be able to rule out.
        fn join_bounded(&mut self, budget: Duration) -> bool {
            let Some(worker) = self.worker.take() else {
                return true;
            };
            self.stop_flag.store(true, Ordering::SeqCst);
            let deadline = Instant::now() + budget;
            while Instant::now() < deadline {
                if worker.is_finished() {
                    if worker.join().is_ok() {
                        return true;
                    }
                    self.record_fault("listener worker panicked".into());
                    return false;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            self.record_fault(format!("listener join exceeded {budget:?}"));
            false
        }

        fn record_fault(&self, error: String) {
            if let Ok(mut faults) = self.faults.lock() {
                faults.push(Fault {
                    at_unix_ms: now_millis(),
                    error,
                });
            } else {
                tracing::error!("probe listener fault log is poisoned");
            }
        }
    }

    impl Drop for OwnedListener {
        /// Signals the stop flag and **does not join**.
        ///
        /// A `Drop` that joins is a `Drop` that can block, and this run has a
        /// bounded deadline: cleanup has to be a sequence of bounded steps, not a
        /// surprise wait on whichever thread happens to be unwinding. The
        /// ordered teardown calls [`OwnedListener::join_bounded`] explicitly; this
        /// impl is the fallback for a panic path, and it only ever asks a thread
        /// that is already bound to exit to exit.
        fn drop(&mut self) {
            self.stop_flag.store(true, Ordering::SeqCst);
            if self
                .worker
                .as_ref()
                .is_some_and(|worker| !worker.is_finished())
            {
                self.record_fault(
                    "listener dropped before bounded join; stop signalled only".into(),
                );
                tracing::error!("probe listener dropped before bounded join");
            }
        }
    }

    struct ListenerLogs {
        hits: Arc<Mutex<Vec<Hit>>>,
        faults: Arc<Mutex<Vec<Fault>>>,
        last_hit: Arc<Mutex<Option<Instant>>>,
        stop: Arc<AtomicBool>,
    }

    fn serve(
        listener: TcpListener,
        logs: ListenerLogs,
        name: String,
        application_origin: String,
        self_origin: String,
    ) {
        let ListenerLogs {
            hits,
            faults,
            last_hit,
            stop,
        } = logs;
        while !stop.load(Ordering::SeqCst) {
            match listener.accept() {
                Ok((stream, _)) => {
                    *last_hit.lock().expect("the probe's own listener log") = Some(Instant::now());
                    let handled = stream
                        .set_read_timeout(Some(Duration::from_secs(2)))
                        .and_then(|()| stream.set_write_timeout(Some(Duration::from_secs(2))))
                        .and_then(|()| {
                            handle(&stream, &name, &hits, &application_origin, &self_origin)
                        });
                    if let Err(error) = handled {
                        faults
                            .lock()
                            .expect("the probe's own fault log")
                            .push(Fault {
                                at_unix_ms: now_millis(),
                                error: format!("listener request: {error}"),
                            });
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(POLL_INTERVAL);
                }
                Err(error) => {
                    // Recorded, not swallowed. An accept failure that silently
                    // ended this thread would look identical to a listener
                    // nothing ever reached, which is the one thing the run's
                    // central claim rests on.
                    faults
                        .lock()
                        .expect("the probe's own fault log")
                        .push(Fault {
                            at_unix_ms: now_millis(),
                            error: error.to_string(),
                        });
                    return;
                }
            }
        }
    }

    /// Read one request line, record it, and answer with the probe's own body.
    fn handle(
        stream: &TcpStream,
        name: &str,
        hits: &Arc<Mutex<Vec<Hit>>>,
        application_origin: &str,
        self_origin: &str,
    ) -> std::io::Result<()> {
        let mut reader = stream.try_clone()?;
        let mut buffer = [0u8; 4096];
        // Short read: the request line is the only part the probe records.
        let read = reader.read(&mut buffer)?;
        let head = String::from_utf8_lossy(&buffer[..read]);
        let mut parts = head.lines().next().unwrap_or_default().split(' ');
        let method = parts.next().unwrap_or_default().to_string();
        let target = parts.next().unwrap_or("/").to_string();
        hits.lock()
            .expect("the probe's own listener log")
            .push(Hit {
                at_unix_ms: now_millis(),
                method,
                target: crate::renderer_diagnostics::redact(&target),
            });

        let body = body_for(name, &target, application_origin, self_origin);
        // A service worker or shared worker script served as `text/html` fails the
        // MIME check outright and never registers, which would leave the worker
        // coverage claim satisfied by accident — no worker, nothing missed. The
        // content type is therefore routed per script rather than hardcoded for
        // the whole corpus.
        let path = target.split('?').next().unwrap_or(target.as_str());
        let content_type = if path.ends_with(".js") {
            "application/javascript; charset=utf-8"
        } else {
            "text/html; charset=utf-8"
        };
        let mut writer = stream;
        writer.write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\n\
                 Content-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        )?;
        writer.flush()
    }

    fn body_for(name: &str, target: &str, application_origin: &str, self_origin: &str) -> String {
        let path = target.split('?').next().unwrap_or(target);
        if name == "application" {
            // Reached at all is the failure this listener exists to witness.
            return "<!doctype html><p>application origin was reached</p>".to_string();
        }
        match path {
            // The document. Its load is what makes the probe's negative claim
            // mean something: the delayed worker fetch below has to have been
            // armed before the settle window can be believed.
            "/" => r#"<!doctype html><meta charset="utf-8"><title>dsh interception probe</title>
<iframe src="/frame" width="200" height="80"></iframe>
<iframe src="__APPLICATION_ORIGIN__/from-document" width="200" height="80"></iframe>
<script>
window.probeSharedWorker = new SharedWorker('/shared-worker.js');
window.probeSharedWorker.port.start();
fetch('/app.js').catch(() => {});
(async () => {
  try {
    await navigator.serviceWorker.register('/service-worker.js');
    const ready = await navigator.serviceWorker.ready;
    ready.active.postMessage('go');
  } catch (e) {}
})();
</script>"#
                .replace(
                    "__APPLICATION_ORIGIN__",
                    &application_origin
                        .replace('&', "&amp;")
                        .replace('"', "&quot;")
                        .replace('<', "&lt;")
                        .replace('>', "&gt;"),
                ),
            "/frame" => "<!doctype html><meta charset=\"utf-8\"><p>frame</p>".to_string(),
            // A service worker that issues a **delayed** request for the
            // application Host. Delayed, and aimed at the refused origin, so the
            // settle window is measured against something that would arrive if
            // the filter let it — rather than against traffic the port has no
            // reason to hold back.
            "/service-worker.js" => format!(
                r#"addEventListener('install', e => e.waitUntil(self.skipWaiting()));
addEventListener('activate', e => e.waitUntil(self.clients.claim()));
addEventListener('message', e => e.waitUntil((async () => {{
  await new Promise(resolve => setTimeout(resolve, {DELAYED_FETCH_DELAY_MS}));
  await fetch('{application_origin}/from-sw').catch(() => {{}});
  await fetch('{self_origin}/sw-ready');
}})()));
//# sourceURL=/service-worker.js"#
            ),
            // A shared worker that issues a request of its own, for the same
            // reason.
            "/shared-worker.js" => format!(
                r#"onconnect = e => {{
  e.ports[0].start();
  (async () => {{
    await fetch('{application_origin}/from-shared').catch(() => {{}});
    await fetch('{self_origin}/shared-ready');
    e.ports[0].postMessage('shared');
  }})();
}};
//# sourceURL=/shared-worker.js"#
            ),
            "/app.js" => "//# sourceURL=/app.js\n".to_string(),
            _ => "<!doctype html><p>probe</p>".to_string(),
        }
    }

    #[test]
    fn document_fixture_uses_the_actual_refused_origin_and_escapes_html() {
        let document = body_for(
            "allowed",
            "/",
            "http://127.0.0.1:43210",
            "http://127.0.0.1:43211",
        );
        assert!(document.contains("src=\"http://127.0.0.1:43210/from-document\""));
        assert!(document.contains("src=\"/frame\""));
        assert!(!document.contains("__APPLICATION_ORIGIN__"));
        let escaped = body_for(
            "allowed",
            "/",
            "http://owned/\"<&>",
            "http://127.0.0.1:43211",
        );
        assert!(escaped.contains("http://owned/&quot;&lt;&amp;&gt;/from-document"));
    }

    fn now_millis() -> u128 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|since| since.as_millis())
            .unwrap_or_default()
    }

    /// The window procedure for the probe's message-only window.
    ///
    /// `WNDCLASSW::lpfnWndProc` is `WNDPROC = Option<unsafe extern "system" fn(..)>`,
    /// and the pinned `DefWindowProcW` is an ordinary Rust-ABI `unsafe fn`, so it
    /// cannot be assigned directly. This wrapper carries the right ABI; the window
    /// handles nothing, because a message-only window is never shown and this run
    /// never waits on a message.
    ///
    /// # Safety
    ///
    /// Called only by the window manager, on the thread that created the window.
    unsafe extern "system" fn probe_window_proc(
        hwnd: HWND,
        message: u32,
        wparam: WPARAM,
        lparam: LPARAM,
    ) -> LRESULT {
        // SAFETY: `DefWindowProcW` is forwarded exactly the arguments it was given.
        unsafe {
            windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(hwnd, message, wparam, lparam)
        }
    }

    /// A hidden message-only window. WebView2 requires a parent `HWND`; this one
    /// is never shown, has no title bar and belongs to no visible desktop
    /// surface, so the run cannot flash a window and cannot receive a
    /// user-initiated close. `WM_CLOSE` is therefore not in play at all: this is
    /// not the product, and the product's hide-to-tray semantics do not apply.
    ///
    /// # Safety
    ///
    /// Raw Win32 class and window creation. The class name carries this run's
    /// UUID, so `RegisterClassW` never collides with a previous run.
    unsafe fn create_hidden_window(class_name: &str) -> windows::core::Result<HWND> {
        let class: Vec<u16> = class_name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        // `RegisterClassW` returns an `ATOM`, not a `Result`: a zero atom is the
        // failure, and it is reported rather than tolerated.
        let atom = RegisterClassW(&WNDCLASSW {
            lpfnWndProc: Some(probe_window_proc),
            hInstance: HINSTANCE(std::ptr::null_mut()),
            lpszClassName: PCWSTR(class.as_ptr()),
            ..Default::default()
        });
        if atom == 0 {
            return Err(windows::core::Error::from_win32());
        }
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            PCWSTR(class.as_ptr()),
            windows::core::w!("dsh-webview2-interception-probe"),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            64,
            64,
            Some(HWND_MESSAGE),
            None,
            Some(HINSTANCE(std::ptr::null_mut())),
            None,
        )
    }

    /// The COM apartment this run creates, and balances.
    ///
    /// `webview2_com` does not initialise an apartment for the caller, so the
    /// probe owns the whole lifecycle: initialise before the first WebView2 call
    /// and uninitialise after the last. [`Apartment::enter`] fails closed rather
    /// than continuing on an apartment it did not establish.
    struct Apartment {
        balanced: bool,
    }

    impl Apartment {
        /// # Safety
        ///
        /// Initialises COM on the calling thread. Every WebView2 call this probe
        /// makes happens on that thread.
        unsafe fn enter() -> windows::core::Result<Self> {
            // SAFETY: the caller guarantees this thread is the only one touching
            // COM in this process for the duration.
            let hr = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            // `S_OK` and `S_FALSE` both mean "initialised"; `S_FALSE` means it was
            // already initialised on this thread, which is still an apartment this
            // run may use and still has to balance.
            if !hr.is_ok() {
                return Err(windows::core::Error::from(hr));
            }
            Ok(Self { balanced: true })
        }
    }

    impl Drop for Apartment {
        fn drop(&mut self) {
            if self.balanced {
                // SAFETY: paired with the `CoInitializeEx` in `enter`, on the same
                // thread, after every COM interface this probe holds has been
                // released by `ProbeGuest`'s own drop.
                unsafe { CoUninitialize() };
                self.balanced = false;
            }
        }
    }

    /// Everything this probe owns outside Rust: one controller and one window.
    ///
    /// Both are released here, in order — controller, then window — on **every**
    /// exit path including a panic, which is the whole point: the most likely
    /// failure of this run used to unwind past the only `DestroyWindow` in the
    /// file and leave an unclosed controller with a live browser behind it.
    struct ProbeGuest {
        controller: Option<ICoreWebView2Controller>,
        environment: ICoreWebView2Environment,
        browser_processes: Arc<Mutex<Vec<serde_json::Value>>>,
        window: HWND,
        teardown_log: Arc<Mutex<Vec<String>>>,
    }

    thread_local! {
        static PROBE_CONTROLLER: std::cell::RefCell<Option<(ICoreWebView2Controller, ICoreWebView2Environment)>> = const {
            std::cell::RefCell::new(None)
        };
    }

    impl ProbeGuest {
        fn webview(&self) -> windows::core::Result<ICoreWebView2> {
            // SAFETY: the controller is live and owned by this struct.
            unsafe {
                self.controller
                    .as_ref()
                    .ok_or_else(|| {
                        windows::core::Error::from(windows::Win32::Foundation::E_POINTER)
                    })?
                    .CoreWebView2()
            }
        }
    }

    impl Drop for ProbeGuest {
        fn drop(&mut self) {
            let processes = browser_process_identities(&self.environment);
            let mut process_log = self
                .browser_processes
                .lock()
                .expect("the probe's own process log");
            process_log.extend(processes);
            drop(process_log);
            PROBE_CONTROLLER.with(|slot| slot.borrow_mut().take());
            let mut log = Vec::new();
            // Scoped: exactly this controller, exactly this window. No name
            // matching, no tree walk, no process-wide termination — the browser
            // descendants this controller spawned are WebView2's to reap when
            // the controller closes, and the harness re-attests anything left.
            //
            // SAFETY: both handles are live and owned by this struct, and this is
            // the only place either is destroyed.
            if let Some(controller) = &self.controller {
                match unsafe { controller.Close() } {
                    Ok(()) => log.push("controller.Close() ok".to_string()),
                    Err(error) => log.push(format!("controller.Close() failed: {error}")),
                }
            }
            match unsafe { DestroyWindow(self.window) } {
                Ok(()) => log.push("DestroyWindow ok".to_string()),
                Err(error) => log.push(format!("DestroyWindow failed: {error}")),
            }
            if let Ok(mut teardown_log) = self.teardown_log.lock() {
                teardown_log.extend(log);
            } else {
                tracing::error!("probe teardown log is poisoned");
            }
        }
    }

    /// The pre-created run root, validated or refused.
    ///
    /// The harness must have created it, with a current-user + SYSTEM ACL,
    /// *before* launching this process. That ordering is the point: an ACL
    /// applied after the WebView2 profile's first byte exists is not an ACL
    /// applied at creation, so the probe refuses to create the directory itself
    /// and refuses to proceed unless the DACL it reads back looks private.
    fn require_private_root() -> std::path::PathBuf {
        let raw = std::env::var(ROOT_VARIABLE).unwrap_or_else(|_| {
            panic!("{ROOT_VARIABLE} must name a pre-created, private, empty run root")
        });
        let root = std::path::PathBuf::from(raw);
        assert!(
            root.is_absolute(),
            "{ROOT_VARIABLE} must be an absolute path"
        );
        assert!(
            !root.components().any(|part| matches!(
                part,
                std::path::Component::ParentDir | std::path::Component::CurDir
            )),
            "{ROOT_VARIABLE} must not contain dot components"
        );
        require_no_reparse_points(&root);
        assert!(
            root.is_dir(),
            "{ROOT_VARIABLE} must name an existing directory: {}",
            root.display()
        );
        assert_eq!(
            std::fs::read_dir(&root)
                .unwrap_or_else(|error| panic!("the run root must be readable: {error}"))
                .count(),
            0,
            "the run root must be empty: a previous run left state behind"
        );
        let verdict = verify_private_directory(&root);
        assert!(
            verdict.is_private,
            "the run root is not private: {}",
            verdict.reason
        );
        root
    }

    /// What the DACL readback concluded about a directory.
    struct AclVerdict {
        is_private: bool,
        reason: String,
    }

    /// Refuse a root, or any of its ancestors, that is a reparse point.
    ///
    /// `DSH_PROBE_ROOT` names a path and nothing else; if any component of it is
    /// a junction or a symbolic link, the path the probe then reads, and the
    /// profile it creates, live somewhere the ACL readback never looked. The
    /// check walks the whole chain with `MetadataExt::file_attributes` rather
    /// than trusting a canonicalised path, because canonicalising is exactly what
    /// would hide the redirection.
    fn require_no_reparse_points(path: &std::path::Path) {
        check_no_reparse_points(path).unwrap_or_else(|error| panic!("{error}"));
    }

    fn check_no_reparse_points(path: &std::path::Path) -> Result<(), String> {
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let ancestors: Vec<_> = path.ancestors().collect();
        for candidate in ancestors.into_iter().rev() {
            let metadata = std::fs::symlink_metadata(candidate)
                .map_err(|error| format!("profile ancestor metadata unavailable: {error}"))?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(
                    "profile or ancestor is a reparse point; refusing to follow it".to_string(),
                );
            }
        }
        Ok(())
    }

    struct OwnedSdkFolder(PWSTR);

    impl Drop for OwnedSdkFolder {
        fn drop(&mut self) {
            // SAFETY: UserDataFolder allocates its output with the COM task allocator.
            if !self.0.is_null() {
                unsafe { CoTaskMemFree(Some(self.0.as_ptr().cast())) };
            }
        }
    }

    /// Verify the SDK's actual profile before any controller/navigation exists.
    /// Preflight cannot undo earlier SDK access or prevent ambient-policy races.
    fn attest_sdk_profile(
        environment: &ICoreWebView2Environment,
        expected: &std::path::Path,
    ) -> Result<(), String> {
        let environment7 = environment
            .cast::<ICoreWebView2Environment7>()
            .map_err(|error| format!("environment7 unavailable: {:?}", error.code()))?;
        let mut folder = OwnedSdkFolder(PWSTR::null());
        // SAFETY: live pinned COM interface and valid typed output pointer.
        unsafe { environment7.UserDataFolder(&mut folder.0) }
            .map_err(|error| format!("UserDataFolder failed: {:?}", error.code()))?;
        if folder.0.is_null() {
            return Err("SDK effective profile was null".to_string());
        }
        // SAFETY: successful UserDataFolder returns a NUL-terminated UTF-16 string
        // owned by `folder` until the lossless OsString copy completes.
        let effective =
            std::path::PathBuf::from(std::ffi::OsString::from_wide(unsafe { folder.0.as_wide() }));
        if !effective.is_absolute()
            || effective.components().any(|part| {
                matches!(
                    part,
                    std::path::Component::ParentDir | std::path::Component::CurDir
                )
            })
        {
            return Err(
                "SDK effective profile must be an absolute path without dot components".to_string(),
            );
        }
        let root = expected
            .parent()
            .ok_or_else(|| "owned profile has no root".to_string())?;
        // Check every component BEFORE canonicalization can follow anything.
        check_no_reparse_points(root)?;
        check_no_reparse_points(expected)?;
        check_no_reparse_points(&effective)?;
        let canonical_root = std::fs::canonicalize(root)
            .map_err(|error| format!("owned root canonicalization: {error}"))?;
        let canonical_expected = std::fs::canonicalize(expected)
            .map_err(|error| format!("owned profile canonicalization: {error}"))?;
        let canonical_effective = std::fs::canonicalize(&effective)
            .map_err(|error| format!("SDK profile canonicalization: {error}"))?;
        check_no_reparse_points(&canonical_root)?;
        check_no_reparse_points(&canonical_expected)?;
        check_no_reparse_points(&canonical_effective)?;
        if canonical_effective != canonical_expected
            || canonical_expected.parent() != Some(canonical_root.as_path())
        {
            return Err("SDK effective profile does not match the owned profile".to_string());
        }
        Ok(())
    }

    /// The SID bytes of the account this process runs as.
    ///
    /// Read from the process token rather than parsed from `whoami`, so the value
    /// is the one the kernel is using and not a command's rendering of it.
    fn current_user_sid() -> Result<Vec<u8>, String> {
        let mut token = HANDLE::default();
        // SAFETY: `GetCurrentProcess` is a pseudo-handle that is always valid, and
        // `token` is a valid out-parameter.
        let process = unsafe { windows::Win32::System::Threading::GetCurrentProcess() };
        // SAFETY: the pseudo-handle is valid and `TOKEN_QUERY` is the least
        // privilege that can read `TokenUser`.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }
            .map_err(|error| format!("OpenProcessToken: {error}"))?;
        let _owned_token = OwnedToken(token);
        let mut needed = 0u32;
        // SAFETY: the first call asks only for the size, which is the documented way
        // to size a `GetTokenInformation` call.
        let _ = unsafe { GetTokenInformation(token, TokenUser, None, 0, &mut needed) };
        if needed == 0 {
            return Err("the process token reported no TokenUser size".to_string());
        }
        let mut buffer = vec![0usize; (needed as usize).div_ceil(std::mem::size_of::<usize>())];
        // SAFETY: `buffer` is at least `needed` bytes, as just established.
        unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                Some(buffer.as_mut_ptr().cast()),
                needed,
                &mut needed,
            )
        }
        .map_err(|error| format!("GetTokenInformation: {error}"))?;
        // SAFETY: the buffer now holds a `TOKEN_USER`, whose SID points inside the
        // same allocation, which is still owned here.
        let user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
        // SAFETY: as above.
        unsafe { copy_sid(user.User.Sid) }
    }

    struct OwnedToken(HANDLE);

    impl Drop for OwnedToken {
        fn drop(&mut self) {
            // SAFETY: this handle came from OpenProcessToken and is closed once.
            if let Err(error) = unsafe { windows::Win32::Foundation::CloseHandle(self.0) } {
                tracing::error!(%error, "probe token CloseHandle failed");
            }
        }
    }

    /// Copy one SID into an owned byte vector so it can outlive the buffer that
    /// holds it.
    ///
    /// # Safety
    ///
    /// `sid` must be a valid SID for as long as this call runs.
    unsafe fn copy_sid(sid: PSID) -> Result<Vec<u8>, String> {
        if sid.0.is_null() {
            return Err("a null SID".to_string());
        }
        // SAFETY: caller contract.
        if !unsafe { IsValidSid(sid) }.as_bool() {
            return Err("an invalid SID".to_string());
        }
        // SAFETY: IsValidSid succeeded; the first byte is a revision, not a length.
        let length = unsafe { GetLengthSid(sid) } as usize;
        if !(8..=68).contains(&length) {
            return Err(format!("an implausible SID length of {length}"));
        }
        // SAFETY: caller contract, and the length is bounded to a SID's maximum.
        Ok(unsafe { std::slice::from_raw_parts(sid.0.cast::<u8>(), length) }.to_vec())
    }

    /// The Local System SID, `S-1-5-18`.
    fn known_system_sid() -> Result<Vec<u8>, String> {
        let text = windows::core::w!("S-1-5-18");
        let mut sid = PSID::default();
        // SAFETY: `text` is NUL-terminated and `sid` is a valid out-parameter.
        unsafe { ConvertStringSidToSidW(PCWSTR(text.as_ptr()), &mut sid) }
            .map_err(|error| format!("S-1-5-18 is not a valid SID: {error}"))?;
        // SAFETY: `sid` is a system-allocated SID the caller owns after a
        // successful conversion, and it is freed exactly once below.
        let _owned_sid = OwnedSid(sid);
        // SAFETY: `sid` is a valid SID.
        unsafe { copy_sid(sid) }
    }

    /// Frees a SID the system allocated for us.
    struct OwnedSid(PSID);

    impl Drop for OwnedSid {
        fn drop(&mut self) {
            if !self.0 .0.is_null() {
                // SAFETY: a non-null SID came from `ConvertStringSidToSidW` and is
                // freed exactly once with the allocator that produced it.
                let remaining =
                    unsafe { windows::Win32::Foundation::LocalFree(Some(HLOCAL(self.0 .0))) };
                if !remaining.0.is_null() {
                    tracing::error!("probe SID LocalFree failed");
                }
            }
        }
    }

    /// Verify that `path` is readable only by this account and `SYSTEM`.
    ///
    /// This compares the **actual SID on every ACE**, because a count cannot
    /// tell `current user + SYSTEM` from `WORLD + Everyone`: both are two
    /// entries, and the second hands the directory to every account on the host.
    ///
    /// * the DACL must exist — a NULL DACL grants everyone full control;
    /// * it must be **protected**, not inherited, because an inherited DACL can be
    ///   widened by whatever the parent grants later;
    /// * every entry must be a plain allow ACE — a deny ACE, an audit ACE, or any
    ///   object/inherit variant is refused rather than interpreted, so an
    ///   unexpected shape can never be mistaken for a grant;
    /// * the SID on each must be this process's user or `S-1-5-18`, byte-compared;
    /// * and both must actually appear, so an over-tight DACL fails too.
    fn verify_private_directory(path: &std::path::Path) -> AclVerdict {
        let refuse = |reason: String| AclVerdict {
            is_private: false,
            reason,
        };
        let user = match current_user_sid() {
            Ok(sid) => sid,
            Err(reason) => return refuse(reason),
        };
        let system = match known_system_sid() {
            Ok(sid) => sid,
            Err(reason) => return refuse(reason),
        };

        if user == system {
            return refuse(
                "the probe must run as a distinct current-user account, not SYSTEM".into(),
            );
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        if wide.contains(&0) {
            return refuse("the root path contains an embedded NUL".into());
        }
        wide.push(0);
        let mut dacl: *mut ACL = std::ptr::null_mut();
        let mut owner = PSID::default();
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        // Protection is read from descriptor control below, not inferred from a
        // query flag. This function only reads; it never repairs an ACL.
        // SAFETY: `wide` is NUL-terminated and outlives the call; both
        // out-pointers are valid for its duration and the descriptor is freed
        // below.
        let status = unsafe {
            GetNamedSecurityInfoW(
                PCWSTR(wide.as_ptr()),
                SE_FILE_OBJECT,
                DACL_SECURITY_INFORMATION | OWNER_SECURITY_INFORMATION,
                Some(&mut owner),
                None,
                Some(&mut dacl),
                None,
                &mut descriptor,
            )
        };
        // SAFETY: `descriptor` is either null or a buffer this call just asked the
        // system to allocate, and it is freed exactly once here.
        let _owned_descriptor = OwnedSecurityDescriptor(descriptor);
        if status != WIN32_ERROR(0) {
            return refuse(format!(
                "the owner/DACL could not be read back (WIN32_ERROR({}))",
                status.0
            ));
        }
        if descriptor.0.is_null() {
            return refuse("the security descriptor is NULL".into());
        }
        // SAFETY: owner is part of the live security descriptor.
        if unsafe { copy_sid(owner) }.as_ref() != Ok(&user) {
            return refuse("the directory is not owned by the current user".into());
        }
        if dacl.is_null() {
            return refuse(
                "the directory has a NULL DACL, which grants everyone everything".into(),
            );
        }
        // SAFETY: dacl is part of the live security descriptor.
        if !unsafe { IsValidAcl(dacl) }.as_bool() {
            return refuse("the DACL is invalid".into());
        }
        let mut control = 0u16;
        let mut revision = 0u32;
        // SAFETY: `descriptor` is a live, owned security descriptor and both
        // out-parameters are valid locals.
        if unsafe { GetSecurityDescriptorControl(descriptor, &mut control, &mut revision) }.is_err()
            || control & SE_DACL_PROTECTED.0 == 0
            || control & 0x0004 == 0
        // SE_DACL_PRESENT
        {
            return refuse("the DACL is inherited rather than protected".into());
        }

        let mut information = ACL_SIZE_INFORMATION::default();
        // SAFETY: `dacl` is a live ACL owned by `descriptor`, and `information` is a
        // correctly sized local for the requested information class.
        let read = unsafe {
            GetAclInformation(
                dacl,
                (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        };
        if read.is_err() {
            return refuse("the DACL size could not be read".into());
        }

        let mut saw_user = false;
        let mut saw_system = false;
        for index in 0..information.AceCount {
            let mut ace: *mut std::ffi::c_void = std::ptr::null_mut();
            // SAFETY: `index` is below the reported `AceCount` and `dacl` is live.
            if unsafe { GetAce(dacl, index, &mut ace) }.is_err() || ace.is_null() {
                return refuse(format!("ACE {index} could not be read"));
            }
            // SAFETY: `GetAce` returned a pointer to a live `ACE_HEADER` inside `dacl`.
            let header = unsafe { *ace.cast::<ACE_HEADER>() };
            // Only the plain access-allowed form is accepted.
            const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                return refuse(format!(
                    "ACE {index} is type {}, not a plain allow ACE",
                    header.AceType
                ));
            }
            // Exactly OI|CI: propagate the private grant to child files and
            // directories; reject inherited, inherit-only and no-propagate ACEs.
            if header.AceFlags != 0x03 || header.AceSize < 16 {
                return refuse(format!(
                    "ACE {index} lacks direct, inheritable OI|CI rights or is truncated"
                ));
            }
            // SAFETY: IsValidAcl and the checked plain-allow layout/size establish
            // the fixed fields and at least the eight-byte SID header.
            let entry = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            const FILE_ALL_ACCESS: u32 = 0x001f_01ff;
            if entry.Mask & FILE_ALL_ACCESS != FILE_ALL_ACCESS {
                return refuse(format!("ACE {index} lacks full directory/child access"));
            }
            let sid_pointer = (&entry.SidStart as *const u32).cast::<u8>();
            // SAFETY: AceSize >= 16 places the subauthority count inside this ACE.
            let sid_length = 8 + 4 * usize::from(unsafe { *sid_pointer.add(1) });
            if sid_length > 68 || 8 + sid_length > usize::from(header.AceSize) {
                return refuse(format!("ACE {index} has a truncated SID"));
            }
            // SAFETY: the entire SID is contained in this live ACE.
            let found = match unsafe { copy_sid(PSID(sid_pointer.cast_mut().cast())) } {
                Ok(found) => found,
                Err(reason) => return refuse(format!("ACE {index}: {reason}")),
            };
            if found == user && !saw_user {
                saw_user = true;
            } else if found == system && !saw_system {
                saw_system = true;
            } else {
                return refuse(format!(
                    "ACE {index} names an unknown or duplicate principal"
                ));
            }
        }
        match (saw_user, saw_system) {
            (true, true) => AclVerdict {
                is_private: true,
                reason: "this account and SYSTEM only, DACL protected".to_string(),
            },
            (false, false) => refuse("the DACL grants neither this account nor SYSTEM".into()),
            _ => refuse("the DACL grants only one of this account and SYSTEM".into()),
        }
    }
    /// Frees a security descriptor the system allocated for us.
    struct OwnedSecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl Drop for OwnedSecurityDescriptor {
        fn drop(&mut self) {
            if !self.0 .0.is_null() {
                // SAFETY: a non-null descriptor came from `GetNamedSecurityInfoW`
                // and is freed exactly once, after all borrowed ACL/SID reads.
                let remaining =
                    unsafe { windows::Win32::Foundation::LocalFree(Some(HLOCAL(self.0 .0))) };
                if !remaining.0.is_null() {
                    tracing::error!("probe security descriptor LocalFree failed");
                }
            }
        }
    }

    /// Pump this thread's messages until `rx` yields a value or the budget ends.
    ///
    /// `webview2_com::wait_with_pump` blocks on `GetMessage` and has no deadline,
    /// so a runtime that never completes environment or controller creation would
    /// hang this qualification gate forever with no output and no evidence. This
    /// pump is bounded and reports the expiry as a failure.
    fn bounded_pump<T>(rx: &mpsc::Receiver<T>, budget: Duration) -> Result<T, String> {
        let deadline = Instant::now() + budget;
        loop {
            if Instant::now() >= deadline {
                return Err(format!(
                    "no completion within {budget:?}; the WebView2 runtime did not answer"
                ));
            }
            match rx.try_recv() {
                Ok(value) => return Ok(value),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err("completion channel disconnected".into())
                }
                Err(mpsc::TryRecvError::Empty) => {}
            }
            pump_messages();
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    fn pump_messages() {
        let mut message = MSG::default();
        // Cap each batch so a continuously replenished queue cannot starve deadline checks.
        for _ in 0..64 {
            // SAFETY: valid local on the probe's UI thread; PeekMessage does not wait.
            unsafe {
                if !PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
                    break;
                }
                let _ = TranslateMessage(&message);
                DispatchMessageW(&message);
            }
        }
    }

    /// One check, with the evidence that decided it.
    struct Check {
        name: &'static str,
        passed: bool,
        detail: serde_json::Value,
    }

    impl Check {
        fn new(name: &'static str, passed: bool, detail: serde_json::Value) -> Self {
            Self {
                name,
                passed,
                detail,
            }
        }
    }

    /// The decision half of the corpus, decided rather than observed.
    ///
    /// Some addresses never reach a listener by construction — a `file:` or
    /// `chrome:` URL is refused by the page loader before WebView2 publishes it —
    /// so asserting "the listener saw nothing" for them would prove nothing at
    /// all. These cases are therefore decided directly by the port's own
    /// decision function, and the network half of the corpus covers only what can
    /// actually be watched on a socket.
    fn decision_corpus(application_origin: &str) -> Check {
        let localhost_alias = format!(
            "http://localhost:{}/",
            application_origin.rsplit(':').next().unwrap_or("")
        );
        let cases: Vec<(&str, Decision)> = vec![
            // The application Host itself.
            (application_origin, Decision::Refused),
            // Loopback aliases of the application Host, with paths and queries:
            // the port compares loopback hosts and explicit ports, not text.
            (&localhost_alias, Decision::Refused),
            (application_origin, Decision::Refused),
            ("https://user:pw@example.com/", Decision::Refused),
            ("file:///C:/Windows/win.ini", Decision::Refused),
            ("chrome://settings/", Decision::Refused),
            ("wss://example.com/socket", Decision::Allowed),
            ("https://example.com/app.js", Decision::Allowed),
            ("about:blank", Decision::Allowed),
        ];
        let decided: Vec<serde_json::Value> = cases
            .iter()
            .map(|(address, expected)| {
                let actual = intercept_request(Some(address), Some(application_origin));
                serde_json::json!({
                    "address": safe_evidence_address(address),
                    "expected": format!("{expected:?}"),
                    "actual": format!("{actual:?}"),
                    "passed": actual == *expected,
                })
            })
            .collect();
        Check::new(
            "the_decision_covers_the_interception_corpus",
            decided
                .iter()
                .all(|entry| entry["passed"].as_bool().unwrap_or(false)),
            serde_json::json!({ "cases": decided }),
        )
    }

    /// Native qualification for the guest request filter.
    ///
    /// Run explicitly; never as part of an ordinary `cargo test`:
    ///
    /// ```text
    /// cargo test -p dsh-desktop webview2_guard::interception_probe -- --ignored --nocapture
    /// ```
    #[test]
    #[ignore = "native qualification: creates a WebView2 controller and two loopback listeners"]
    fn the_request_filter_reaches_every_source_and_stops_the_application_origin() {
        let run = uuid::Uuid::new_v4().to_string();
        // Pre-created, private and empty, or the run does not start.
        let root = require_private_root().join(format!("interception-{run}"));
        let profile = root.join("user-data");
        let evidence_file = root.join("evidence.json");
        std::fs::create_dir(&root).expect("the run directory this run owns");
        require_no_reparse_points(&root);
        std::fs::create_dir(&profile).expect("the WebView2 profile this run owns");
        require_no_reparse_points(&profile);

        let observations: Arc<Mutex<Vec<RequestObservation>>> = Arc::new(Mutex::new(Vec::new()));
        let teardown_log = Arc::new(Mutex::new(Vec::new()));
        let mut checks = Vec::new();
        let mut setup_fault: Option<String> = None;

        let mut browser_processes: Vec<serde_json::Value> = Vec::new();
        let mut teardown_summary = Vec::new();
        let outcome = (|| {
            // SAFETY: all COM work is on this thread, balanced after the last interface.
            let _apartment = unsafe { Apartment::enter() }.map_err(|error| error.to_string())?;
            // This exercises the real QI refusal boundary, NOT production teardown.
            // Calling an arbitrary test closure here would not prove a controller closes.
            let stream = unsafe { windows::Win32::UI::Shell::SHCreateMemStream(Some(&[])) }
                .ok_or_else(|| "no shell in-memory stream".to_string())?;
            let source = stream
                .cast::<IUnknown>()
                .map_err(|error| error.to_string())?;
            let refused = unsafe { super::webview2::register_request_filter(&source) }.is_err();
            checks.push(Check::new(
                "unsupported_source_interface_is_refused",
                refused,
                serde_json::json!({ "registration_refused": refused, "proves_guest_teardown": false }),
            ));
            // SAFETY: private pre-created profile and single COM/UI thread.
            unsafe {
                run_live_guest(
                    &run,
                    &profile,
                    Arc::clone(&observations),
                    Arc::clone(&teardown_log),
                    &mut checks,
                    &mut browser_processes,
                )
            }
        })();
        match outcome {
            Ok(summary) => teardown_summary = summary,
            // Recorded, not panicked: the most likely failure of this run must
            // still leave an artifact behind rather than only a panic string.
            Err(error) => setup_fault = Some(error),
        }

        let close_log = teardown_log
            .lock()
            .expect("the probe's own teardown log")
            .clone();
        checks.push(Check::new(
            "scoped_native_teardown_completed",
            close_log.iter().any(|line| line == "controller.Close() ok")
                && close_log.iter().any(|line| line == "DestroyWindow ok")
                && !close_log
                    .iter()
                    .any(|line| line.contains("failed:") || line.contains("Err(")),
            serde_json::json!({ "log": close_log, "proves_process_descendant_absence": false }),
        ));
        checks.push(Check::new(
            "browser_process_inventory_was_captured_before_close",
            browser_processes.iter().any(|row| row["pid"].as_i64().is_some_and(|pid| pid > 0))
                && browser_processes.iter().all(|row| row["error"].is_null()),
            serde_json::json!({ "processes": browser_processes, "external_identity_gate_required": true }),
        ));
        // Evidence is written **before** anything is asserted, so a failing run is
        // still evidence.
        let failed: Vec<&str> = checks
            .iter()
            .filter(|check| !check.passed)
            .map(|check| check.name)
            .collect();
        let report = serde_json::json!({
            "run": run,
            "recorded_at_utc": chrono::Utc::now().to_rfc3339(),
            "recorded_at_unix_ms_utc": now_millis(),
            "process_descendant_absence_proved": false,
            "refusal_delivery_failure_close_qualified": false,
            "full_guest_teardown_qualified": false,
            "guest_admission_qualified": false,
            "all_passed_scope": "local probe checks only; never whole guest admission qualification",
            "accepted_requested_mask_is_not_measured_coverage": true,
            "probe_pid": std::process::id(),
            "webview2_com": "=0.38.2 (pinned)",
            "filter_uri": REQUEST_FILTER_URI,
            "required_source_kinds": describe_request_source_kinds(REQUIRED_REQUEST_SOURCE_KINDS),
            "required_source_kinds_raw": REQUIRED_REQUEST_SOURCE_KINDS,
            "run_budget_seconds": RUN_BUDGET.as_secs(),
            "create_budget_seconds": CREATE_BUDGET.as_secs(),
            "settle_quiet_seconds": SETTLE_QUIET.as_secs(),
            "setup_fault": setup_fault,
            "browser_processes": browser_processes,
            "teardown_log": teardown_log.lock().expect("the probe's own teardown log").clone(),
            "observations": observations
                .lock()
                .expect("the probe's own observation log")
                .iter()
                .map(observation_json)
                .collect::<Vec<_>>(),
            "checks": checks
                .iter()
                .map(|check| serde_json::json!({
                    "name": check.name,
                    "passed": check.passed,
                    "detail": check.detail,
                }))
                .collect::<Vec<_>>(),
            "all_passed": setup_fault.is_none() && failed.is_empty(),
            // Re-attestation is the harness's job, from `probe_pid`: exe path and
            // creation time are not observable from inside this process without
            // a toolhelp snapshot, which this crate does not enable.
            "harness_must_re_attest": [
                "resolve probe_pid to a fresh exe path and creation time",
                "enumerate descendants whose creation time is >= the probe's",
                "terminate by scoped single PID only; never by name or tree",
            ],
        });
        // A refused/changed root must never receive a post-failure evidence write.
        // External failure capture is required when this safety check refuses.
        require_no_reparse_points(&root);
        require_no_reparse_points(&profile);
        std::fs::write(
            &evidence_file,
            serde_json::to_vec_pretty(&report).expect("evidence is serializable"),
        )
        .expect("the run directory this run owns");

        assert!(
            setup_fault.is_none(),
            "the probe could not run: {setup_fault:?}\nevidence: {}",
            evidence_file.display()
        );
        assert!(
            failed.is_empty(),
            "native interception qualification failed: {failed:?} (teardown: {teardown_summary:?})\n\
             evidence: {}",
            evidence_file.display()
        );
    }

    /// Drive one live guest from creation to scoped teardown.
    ///
    /// # Safety
    ///
    /// Creates the WebView2 environment, controller and message-only window this
    /// run owns, and destroys exactly those. `Profile` is a pre-created, private,
    /// empty directory supplied by the harness.
    unsafe fn run_live_guest(
        run: &str,
        profile: &std::path::Path,
        observations: Arc<Mutex<Vec<RequestObservation>>>,
        teardown_log: Arc<Mutex<Vec<String>>>,
        checks: &mut Vec<Check>,
        browser_processes: &mut Vec<serde_json::Value>,
    ) -> Result<Vec<String>, String> {
        // Both listeners are bound before either is used, so the application
        // origin the document names is a real, listening origin and not a dead
        // port — "nothing reached it" therefore means "nothing was sent".
        let mut application = OwnedListener::bind("application", "http://127.0.0.1:1")
            .map_err(|error| error.to_string())?;
        let application_origin = application.origin.clone();
        let mut allowed = match OwnedListener::bind("allowed", &application_origin) {
            Ok(listener) => listener,
            Err(error) => {
                let stopped = application.join_bounded(TEARDOWN_STEP_BUDGET);
                teardown_log
                    .lock()
                    .expect("the probe's own teardown log")
                    .push(format!(
                        "application listener stopped after bind failure: {stopped}"
                    ));
                return Err(format!(
                    "allowed listener bind: {error}; application faults: {:?}",
                    application.faults()
                ));
            }
        };
        let process_log = Arc::new(Mutex::new(Vec::new()));
        let outcome = drive_guest(
            run,
            profile,
            &application_origin,
            &allowed,
            &application,
            LiveLogs {
                observations,
                teardown_log: Arc::clone(&teardown_log),
                checks,
                browser_processes: Arc::clone(&process_log),
                deadline: Deadline::after(RUN_BUDGET.saturating_sub(TEARDOWN_STEP_BUDGET * 2)),
            },
        );
        *browser_processes = process_log
            .lock()
            .expect("the probe's own process log")
            .clone();

        // Ordered teardown, every step bounded, on the pass and fail paths alike.
        allowed.stop();
        application.stop();
        let summary = vec![
            format!(
                "allowed listener stopped: {}",
                allowed.join_bounded(TEARDOWN_STEP_BUDGET)
            ),
            format!(
                "application listener stopped: {}",
                application.join_bounded(TEARDOWN_STEP_BUDGET)
            ),
        ];
        // One extra accounting check: a listener that took faults or failed to
        // stop would make every negative claim in the evidence unsound.
        for (name, listener) in [("allowed", &allowed), ("application", &application)] {
            let faults = listener.faults();
            checks.push(Check::new(
                "listeners_accepted_without_faults",
                faults.is_empty(),
                serde_json::json!({ "listener": name, "faults": faults }),
            ));
        }
        teardown_log
            .lock()
            .expect("the probe's own teardown log")
            .extend(summary.clone());
        outcome.map(|()| summary)
    }

    struct LiveLogs<'a> {
        observations: Arc<Mutex<Vec<RequestObservation>>>,
        teardown_log: Arc<Mutex<Vec<String>>>,
        checks: &'a mut Vec<Check>,
        browser_processes: Arc<Mutex<Vec<serde_json::Value>>>,
        deadline: Deadline,
    }

    /// The part of the run that creates the guest, navigates it, and settles.
    ///
    /// # Safety
    ///
    /// Caller contract of `run_live_guest`.
    unsafe fn drive_guest(
        run: &str,
        profile: &std::path::Path,
        application_origin: &str,
        allowed: &OwnedListener,
        application: &OwnedListener,
        logs: LiveLogs<'_>,
    ) -> Result<(), String> {
        let LiveLogs {
            observations,
            teardown_log,
            checks,
            browser_processes,
            deadline,
        } = logs;
        let preflight = sdk_override_preflight().and_then(|()| check_no_reparse_points(profile));
        checks.push(Check::new(
            "sdk_override_and_profile_preflight_passed",
            preflight.is_ok(),
            serde_json::json!({
                "ambient_webview2_names_and_policy_keys_absent": preflight.is_ok(),
                "policy_values_read": false,
                "proves_override_race_absence": false,
            }),
        ));
        preflight?;
        let folder: Vec<u16> = profile
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();

        // SAFETY: caller contract.
        let _apartment =
            unsafe { Apartment::enter() }.map_err(|error| format!("COM apartment: {error}"))?;

        // SAFETY: caller contract.
        let (tx, rx) = mpsc::channel();
        // SAFETY: caller contract. `userdatafolder` is this run's own directory.
        unsafe {
            CreateCoreWebView2EnvironmentWithOptions(
                PCWSTR::null(),
                PCWSTR(folder.as_ptr()),
                &ICoreWebView2EnvironmentOptions::from(CoreWebView2EnvironmentOptions::default()),
                &CreateCoreWebView2EnvironmentCompletedHandler::create(Box::new(
                    move |error, environment| {
                        let outcome = error.and_then(|()| {
                            environment.ok_or_else(|| {
                                windows::core::Error::from(windows::Win32::Foundation::E_POINTER)
                            })
                        });
                        // The completion handler must itself answer
                        // `windows::core::Result`, and a dropped send would leave
                        // the bounded pump waiting for a receiver nobody wrote to.
                        tx.send(outcome).map_err(|_| {
                            windows::core::Error::from(windows::Win32::Foundation::E_UNEXPECTED)
                        })
                    },
                )),
            )
        }
        .map_err(|error| format!("environment creation was refused: {error}"))?;
        let environment = bounded_pump(&rx, CREATE_BUDGET.min(deadline.left()))?
            .map_err(|error: windows::core::Error| error.to_string())?;

        *browser_processes
            .lock()
            .expect("the probe's own process log") = browser_process_identities(&environment);
        let profile_attestation = attest_sdk_profile(&environment, profile);
        checks.push(Check::new(
            "sdk_effective_profile_matches_owned_profile",
            profile_attestation.is_ok(),
            serde_json::json!({
                "matched_actual_sdk_profile": profile_attestation.is_ok(),
                "post_sdk_root_profile_and_all_ancestors_checked": profile_attestation.is_ok(),
                "proves_override_race_absence": false,
            }),
        ));
        profile_attestation?;
        // SAFETY: caller contract.
        let window = unsafe { create_hidden_window(&format!("dsh-interception-probe-{run}")) }
            .map_err(|error| format!("hidden window: {error}"))?;
        let mut guest = ProbeGuest {
            controller: None,
            environment: environment.clone(),
            browser_processes: Arc::clone(&browser_processes),
            window,
            teardown_log: Arc::clone(&teardown_log),
        };
        let (tx, rx) = mpsc::channel();
        let late_teardown_log = Arc::clone(&teardown_log);
        // SAFETY: caller contract.
        unsafe {
            environment.CreateCoreWebView2Controller(
                window,
                &CreateCoreWebView2ControllerCompletedHandler::create(Box::new(
                    move |error, controller| {
                        if error.is_err() {
                            if let Some(controller) = &controller {
                                let closed = controller.Close();
                                late_teardown_log
                                    .lock()
                                    .expect("the probe's own teardown log")
                                    .push(format!("failed controller callback Close: {closed:?}"));
                            }
                        }
                        let outcome = error.and_then(|()| {
                            controller.ok_or_else(|| {
                                windows::core::Error::from(windows::Win32::Foundation::E_POINTER)
                            })
                        });
                        match tx.send(outcome) {
                            Ok(()) => Ok(()),
                            Err(unsent) => {
                                if let Ok(controller) = unsent.0 {
                                    let closed = controller.Close();
                                    late_teardown_log
                                        .lock()
                                        .expect("the probe's own teardown log")
                                        .push(format!(
                                            "late controller callback Close: {closed:?}"
                                        ));
                                }
                                Err(windows::core::Error::from(
                                    windows::Win32::Foundation::E_UNEXPECTED,
                                ))
                            }
                        }
                    },
                )),
            )
        }
        .map_err(|error| format!("controller creation was refused: {error}"))?;
        let controller_completion = match bounded_pump(&rx, CREATE_BUDGET.min(deadline.left())) {
            Ok(completion) => completion,
            Err(error) => {
                // A callback may have queued a controller while a message batch
                // exhausted the deadline. Close that queued controller explicitly.
                if let Ok(Ok(controller)) = rx.try_recv() {
                    guest.controller = Some(controller);
                }
                return Err(error);
            }
        };
        let controller: ICoreWebView2Controller =
            controller_completion.map_err(|error: windows::core::Error| error.to_string())?;

        guest.controller = Some(controller);
        // The send/sync production callback closes only the controller installed
        // on this very UI thread; no COM pointer is sent across threads.
        PROBE_CONTROLLER.with(|slot| {
            *slot.borrow_mut() = guest
                .controller
                .clone()
                .map(|controller| (controller, environment.clone()));
        });
        let webview = guest
            .webview()
            .map_err(|error| format!("no CoreWebView2: {error}"))?;

        checks.push(decision_corpus(application_origin));

        let refusal_delivery_failed = Arc::new(AtomicBool::new(false));
        let teardown: super::webview2::Teardown = Arc::new({
            let failed = Arc::clone(&refusal_delivery_failed);
            let log = Arc::clone(&teardown_log);
            let process_log = Arc::clone(&browser_processes);
            move || {
                failed.store(true, Ordering::SeqCst);
                // The production callback invokes this on the same WebView2 UI thread.
                let owned = PROBE_CONTROLLER.with(|slot| slot.borrow_mut().take());
                let result = if let Some((controller, environment)) = owned {
                    process_log
                        .lock()
                        .expect("the probe's own process log")
                        .extend(browser_process_identities(&environment));
                    unsafe { controller.Close() }.map_err(|error| error.to_string())
                } else {
                    Err("probe teardown had no UI-thread controller".to_string())
                };
                log.lock()
                    .expect("the probe's own teardown log")
                    .push(format!(
                        "refusal-delivery failure controller.Close: {result:?}"
                    ));
            }
        });
        let observer: super::RequestObserver = Arc::new({
            let observations = Arc::clone(&observations);
            move |observation| {
                observations
                    .lock()
                    .expect("the probe's own observation log")
                    .push(observation);
            }
        });
        // Bound before the call: a policy built inline would be a temporary that
        // dies while the registration still refers to it.
        let guest_policy = GuestPolicy::browser(
            Some(application_origin.to_string()),
            inert_seed("interception-probe"),
        );
        // SAFETY: caller contract; the webview is live and owned by `guest`.
        let installed = unsafe {
            super::webview2::install_request_filter(
                &webview,
                &guest_policy,
                teardown,
                Some(observer),
            )
        };
        checks.push(Check::new(
            "required_source_kind_filter_was_accepted",
            installed.is_ok(),
            serde_json::json!({
                "requested_mask": REQUIRED_REQUEST_SOURCE_KINDS,
                "accepted": installed.is_ok(),
                "measured_coverage": false,
                "error": installed.as_ref().err().map(ToString::to_string),
            }),
        ));
        installed.map_err(|error| format!("the request filter was not installed: {error}"))?;

        let before = observations
            .lock()
            .expect("the probe's own observation log")
            .len();
        // SAFETY: `webview` is live and owned by `guest`, on this thread.
        unsafe {
            webview.Navigate(&windows::core::HSTRING::from(format!(
                "{}/",
                allowed.origin
            )))
        }
        .map_err(|error| format!("navigation: {error}"))?;

        // The settle window is re-armed on **every** new hit, so it measures
        // quiet after the last request rather than time since loop entry — which
        // is what a late worker-initiated application-origin request needs.
        let wanted = [
            "/",
            "/frame",
            "/app.js",
            "/service-worker.js",
            "/shared-worker.js",
            "/sw-ready",
            "/shared-ready",
        ];
        let started = Instant::now();
        let settle_deadline = Deadline::after(SETTLE_BUDGET.min(deadline.left()));
        let settled = loop {
            pump_messages();
            let targets = allowed.targets();
            let last_seen = [allowed.last_hit_at(), application.last_hit_at()]
                .into_iter()
                .flatten()
                .max()
                .unwrap_or(started);
            let complete = wanted
                .iter()
                .all(|path| targets.iter().any(|seen| seen.as_str() == *path));
            if complete && last_seen.elapsed() >= SETTLE_QUIET {
                break true;
            }
            if settle_deadline.expired() {
                break false;
            }
            if deadline.expired() || refusal_delivery_failed.load(Ordering::SeqCst) {
                break false;
            }
            std::thread::sleep(Duration::from_millis(100));
        };

        let seen: Vec<RequestObservation> = observations
            .lock()
            .expect("the probe's own observation log")
            .iter()
            .skip(before)
            .cloned()
            .collect();

        checks.push(Check::new(
            "the_settle_window_completed",
            settled,
            serde_json::json!({
                "wanted": wanted,
                "seen": allowed.targets(),
                "settle_quiet_seconds": SETTLE_QUIET.as_secs(),
            }),
        ));
        checks.push(Check::new(
            "the_handler_is_invoked",
            !seen.is_empty(),
            serde_json::json!({ "observed": seen.len() }),
        ));
        let allowed_targets = allowed.targets();
        checks.push(Check::new(
            "allowed_resources_reach_their_listener",
            wanted
                .iter()
                .all(|path| allowed_targets.iter().any(|seen| seen.as_str() == *path)),
            serde_json::json!({ "targets": allowed_targets, "wanted": wanted }),
        ));
        checks.push(Check::new(
            "the_application_origin_never_reaches_its_listener",
            application.is_empty(),
            serde_json::json!({
                "application_origin": application_origin,
                "hits": application.targets(),
                "hit_count": application.targets().len(),
            }),
        ));
        let refused_application: Vec<serde_json::Value> = seen
            .iter()
            .filter(|observation| {
                observation.decision == RequestInterception::Refused
                    && observation
                        .address
                        .as_deref()
                        .is_some_and(|address| address.starts_with(application_origin))
            })
            .map(observation_json)
            .collect();
        checks.push(Check::new(
            "the_application_origin_request_is_refused_by_the_handler",
            !refused_application.is_empty(),
            serde_json::json!({ "refused": refused_application }),
        ));

        for (path, kind) in [
            ("/from-document", request_source_kinds::DOCUMENT),
            ("/from-sw", request_source_kinds::SERVICE_WORKER),
            ("/from-shared", request_source_kinds::SHARED_WORKER),
        ] {
            let address = format!("{application_origin}{path}");
            let witnessed: Vec<_> = seen
                .iter()
                .filter(|observation| {
                    observation.address.as_deref() == Some(address.as_str())
                        && observation.decision == RequestInterception::Refused
                        && observation.source_kinds & kind != 0
                })
                .map(observation_json)
                .collect();
            checks.push(Check::new(
                "application_origin_source_request_is_observed_and_refused",
                !witnessed.is_empty()
                    && application.is_empty()
                    && !refusal_delivery_failed.load(Ordering::SeqCst),
                serde_json::json!({ "path": path, "expected_kind": kind, "observed": witnessed,
                    "refusal_delivery_failed": refusal_delivery_failed.load(Ordering::SeqCst) }),
            ));
        }
        checks.push(Check::new(
            "frame_request_is_observed",
            seen.iter().any(|observation| {
                observation.address.as_deref() == Some(format!("{}/frame", allowed.origin).as_str())
                    && observation.source_kinds & request_source_kinds::DOCUMENT != 0
                    && observation.decision == RequestInterception::Allowed
            }),
            serde_json::json!({ "frame_target": "/frame" }),
        ));
        checks.push(Check::new(
            "refusals_were_delivered_without_forced_close",
            !refusal_delivery_failed.load(Ordering::SeqCst),
            serde_json::json!({ "refusal_delivery_failed": refusal_delivery_failed.load(Ordering::SeqCst) }),
        ));

        // Aggregate proof: every required source kind, across the whole run
        // rather than in any single request.
        let mut observed_kinds = 0i32;
        for observation in &seen {
            observed_kinds |= observation.source_kinds;
        }
        checks.push(Check::new(
            "frames_and_worker_sources_are_observed",
            observed_kinds & REQUIRED_REQUEST_SOURCE_KINDS == REQUIRED_REQUEST_SOURCE_KINDS,
            serde_json::json!({
                "observed_kinds": describe_request_source_kinds(observed_kinds),
                "observed_kinds_raw": observed_kinds,
                "required": describe_request_source_kinds(REQUIRED_REQUEST_SOURCE_KINDS),
                "document": observed_kinds & request_source_kinds::DOCUMENT != 0,
                "shared_worker": observed_kinds & request_source_kinds::SHARED_WORKER != 0,
                "service_worker": observed_kinds & request_source_kinds::SERVICE_WORKER != 0,
            }),
        ));
        checks.push(Check::new(
            "no_request_is_passed_without_a_readable_address",
            !seen.iter().any(|observation| {
                observation.address.is_none() && observation.decision == RequestInterception::Allowed
            }),
            serde_json::json!({
                "unreadable": seen.iter().filter(|observation| observation.address.is_none()).count(),
            }),
        ));

        // `guest` drops here — controller `Close()`, then `DestroyWindow` — on
        // both the pass and the fail path, because nothing below can panic.
        drop(guest);
        Ok(())
    }

    /// The browser processes this environment owns, captured before teardown.
    ///
    /// PIDs only: exe path and creation time are not observable from inside this
    /// process without a toolhelp snapshot, which this crate does not enable, so
    /// the harness re-attests them from [`std::process::id`] and these PIDs.
    fn browser_process_identities(
        environment: &ICoreWebView2Environment,
    ) -> Vec<serde_json::Value> {
        // SAFETY: `environment` is live; `GetProcessInfos` is a read.
        let environment8 = match environment.cast::<ICoreWebView2Environment8>() {
            Ok(environment) => environment,
            Err(error) => {
                return vec![serde_json::json!({ "error": format!("environment8: {error}") })]
            }
        };
        // SAFETY: as above.
        let collection = match unsafe { environment8.GetProcessInfos() } {
            Ok(collection) => collection,
            Err(error) => {
                return vec![serde_json::json!({ "error": format!("GetProcessInfos: {error}") })]
            }
        };
        let mut count = 0u32;
        // SAFETY: `count` is a valid out-parameter.
        if let Err(error) = unsafe { collection.Count(&mut count) } {
            return vec![serde_json::json!({ "error": format!("process Count: {error}") })];
        }
        if count > 1024 {
            return vec![
                serde_json::json!({ "error": "process inventory exceeds bounded limit", "count": count }),
            ];
        }
        let mut identities = Vec::with_capacity(count as usize);
        for index in 0..count {
            // SAFETY: `index` is below the reported `Count`.
            let info = match unsafe { collection.GetValueAtIndex(index) } {
                Ok(info) => info,
                Err(error) => {
                    identities.push(serde_json::json!({ "index": index, "error": format!("process item: {error}") }));
                    continue;
                }
            };
            let mut pid = 0i32;
            let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
            // SAFETY: both out-parameters are valid locals.
            if let Err(error) = unsafe { info.ProcessId(&mut pid) } {
                identities.push(
                    serde_json::json!({ "index": index, "error": format!("ProcessId: {error}") }),
                );
                continue;
            }
            // SAFETY: live COM interface and valid out-parameter.
            let kind_result = unsafe { info.Kind(&mut kind) };
            identities.push(serde_json::json!({
                "index": index,
                "pid": pid,
                "kind_raw": kind_result.as_ref().ok().map(|()| kind.0),
                "error": kind_result.err().map(|error| format!("process Kind: {error}")),
                "exe_path": null,
                "creation_time": null,
                "external_identity_re_attestation_required": true,
                "captured_at_unix_ms_utc": now_millis(),
            }));
        }
        identities
    }

    fn safe_evidence_address(address: &str) -> String {
        let Ok(mut parsed) = url::Url::parse(address) else {
            return "[unparseable address redacted]".to_string();
        };
        let has_credentials = !parsed.username().is_empty() || parsed.password().is_some();
        if has_credentials {
            let _ = parsed.set_username("redacted");
            let _ = parsed.set_password(None);
            crate::renderer_diagnostics::redact(parsed.as_str())
        } else {
            // Keep the actual URL unchanged when it has no secret-shaped fields.
            crate::renderer_diagnostics::redact(address)
        }
    }

    /// One observation as evidence JSON, without making the production types
    /// carry a serialization derive.
    fn observation_json(observation: &RequestObservation) -> serde_json::Value {
        serde_json::json!({
            "address": observation.address.as_deref().map(safe_evidence_address),
            "resource_context": observation.resource_context,
            "source_kinds": observation.source_kinds,
            "source_kinds_named": describe_request_source_kinds(observation.source_kinds),
            "decision": match observation.decision {
                RequestInterception::Allowed => "allowed",
                RequestInterception::Refused => "refused",
            },
        })
    }
}
