//! Guest navigation, popup, download and permission policy — the pure decisions
//! the main thread applies, ported from the reference:
//!
//! * `browser-guests.ts` `configureSession` — permission request/check handlers
//!   answer `false`, the device-permission handler answers `false`, the display
//!   media handler returns an empty request, `will-download` is prevented, and
//!   `onBeforeRequest` cancels credentials-in-URL, the application Host itself,
//!   and every scheme outside `http/https/ws/wss/about/data/blob`.
//! * `browser-guests.ts` `allowedNavigation` — `http`/`https`, no embedded
//!   credentials, never the application Host.
//! * `browser-guests.ts` window-open handling — an approved URL becomes a
//!   client-visible `browserOpenRequested` event and the native window is always
//!   denied; a POST body is never approved.
//! * `platform-view.ts` — navigation and redirects are confined to the account
//!   origin, `https:` popups open in the OS browser without the embedded session
//!   or token, and `will-download` is not granted.
//!
//! Everything here is a decision function so the policy can be tested without a
//! window, a network, or a COM apartment. The main thread (see
//! `commands::guest_*`) is the only caller.
//!
//! ## The permission asymmetry
//!
//! Note the deliberate difference from the application document, which grants
//! microphone access to its own main frame (upstream `microphone-permissions.ts`).
//! A guest never reaches that path: its session is denied wholesale, so an
//! embedded page cannot capture audio or video, read the clipboard, learn a
//! geolocation, or observe a device. The single "deny" answer is not an
//! enumerable [`super::native`] concern — it is expressed once, by refusing the
//! session, which is what the isolation invariant in `super` requires.

use dsh_core::error::DshError;

use super::geometry::GuestBounds;

/// The URL type, named once.
///
/// Both `url` and `tauri` re-export the same crate, and a `#[path]`-included
/// build can resolve the bare name through either; the application crate's
/// dependency is `url`, so that is the one used.
use url::Url;

/// Stable machine code for a build with no embeddable guest surface.
///
/// `docs/desktop-shell-features.md` §2 and the contract amendments name exactly
/// this code; the retained client's Browser tab does not special-case it, so it
/// is only produced by an explicit capability decision, never by a runtime
/// failure of an available surface.
pub const BROWSER_GUEST_UNAVAILABLE: &str = "browser_guest_unavailable";

/// Stable machine code for a build with no embedded Platform document surface.
///
/// `desktop-shell-features.md` §4 names `platform_view_unavailable`.
pub const PLATFORM_VIEW_UNAVAILABLE: &str = "platform_view_unavailable";

/// Schemes a guest document may navigate to, request, or be created from.
///
/// `about:`/`data:`/`blob:` are inert local schemes the reference keeps; they
/// make `load_html`-style seeds and `blob:` downloads work without granting a
/// network capability.
const INERT_SCHEMES: [&str; 3] = ["about", "data", "blob"];

/// What one window-open request means.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PopupDecision {
    /// The guest's UI must be told about this URL (`browserOpenRequested`); the
    /// native window is still not opened by anyone.
    OpenRequested { url: String },
    /// Denied without a client event (unapproved scheme, credentials, the
    /// application origin, or a POST body).
    Denied,
}

/// Parse one URL without accepting a value that cannot be a URL.
fn parse(value: &str) -> Option<Url> {
    Url::parse(value).ok()
}

/// Whether a host is a loopback spelling of the local machine.
///
/// The reference names exactly three (`browser-guests.ts` `isApplicationHost`):
/// `localhost`, `127.0.0.1` and `[::1]`. `Url::host` yields `Domain("localhost")`
/// for the first and `Ipv6(::1)` for the last — never the bracketed text, which
/// only appears in the serialization. An IPv4-mapped address (`::ffff:127.0.0.1`)
/// is unwrapped because Windows routes it to the same loopback interface, so a
/// guest that spelled the application that way would otherwise reach it.
fn is_loopback_host(host: Option<&url::Host<&str>>) -> bool {
    match host {
        Some(url::Host::Domain("localhost")) => true,
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => {
            address.is_loopback() || address.to_ipv4().is_some_and(|v4| v4.is_loopback())
        }
        _ => false,
    }
}

/// The explicit loopback port of one URL, or `None` for a URL whose port comes
/// from its scheme.
///
/// A guest never reaches the application over a scheme-default port, so a
/// missing explicit port cannot name the same service as `:41234` and the two
/// spellings must not be treated as equal.
fn explicit_port(url: &Url) -> Option<u16> {
    url.port()
}

/// Whether a request to `value` belongs to the hosted application itself.
///
/// @param value - candidate request or navigation URL.
/// @param application_origin - the gateway origin the shell serves
///   (`GatewayHandle::origin`), or `None` before the Host is up.
///
/// Two URLs name the same application when, and only when:
///
/// * both carry an **explicit** port and those ports are equal — the gateway
///   always listens on one (`GatewayConfig::loopback`); a URL without a port
///   targets the scheme default and is therefore a different service;
/// * **both** hosts are loopback, or the hosts are equal.
///
/// The port is compared first and the host second, and the loopback allowance
/// applies to *both* sides. The earlier form tested "the candidate host is
/// loopback" and "the application host is loopback" as independent alternatives
/// while `is_loopback_host` accepted **every** IPv4 address, so any public
/// `http://93.184.216.34:<gateway port>/` matched the application and was
/// refused by `allowed_navigation`/`allowed_request` for the wrong reason.
pub fn is_application_request(value: &str, application_origin: Option<&str>) -> bool {
    let Some(application_origin) = application_origin else {
        return false;
    };
    let (Some(candidate), Some(application)) = (parse(value), parse(application_origin)) else {
        return false;
    };
    let (Some(candidate_port), Some(application_port)) =
        (explicit_port(&candidate), explicit_port(&application))
    else {
        return false;
    };
    if candidate_port != application_port {
        return false;
    }
    let (candidate_host, application_host) = (candidate.host(), application.host());
    candidate_host == application_host
        || (is_loopback_host(candidate_host.as_ref())
            && is_loopback_host(application_host.as_ref()))
}

/// Whether a request may only be a form submission, never a popup.
///
/// WebView2's `NewWindowRequestedEventArgs` exposes the request method and the
/// `additionalBrowserArguments` of a `target="_blank"` form submission carries
/// `--form-submit-<method>`. Both are checked because neither is present for
/// every request kind: the arguments clause is the only signal for a form POST
/// that WebView2 satisfies through its own navigation path, and the method
/// clause is the only signal for a script-injected `POST` request.
pub fn popup_is_form_submission(additional_browser_arguments: &str, method: &str) -> bool {
    additional_browser_arguments
        .to_ascii_lowercase()
        .contains("--form-submit-")
        || method.eq_ignore_ascii_case("POST")
}

/// Whether a browser guest may navigate to `value`
/// (upstream `allowedNavigation`).
///
/// @param value - renderer- or page-supplied URL.
/// @param application_origin - gateway origin, blocked for every guest.
pub fn allowed_navigation(value: &str, application_origin: Option<&str>) -> bool {
    let Some(url) = parse(value) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && !is_application_request(value, application_origin)
}

/// Whether the browser guest's network layer may issue this request
/// (upstream `onBeforeRequest`).
///
/// Differs from [`allowed_navigation`] in exactly the ways the reference
/// differs: websocket schemes are allowed because a page's own websockets are
/// not navigations, and the inert schemes are allowed because they carry no
/// network request. Credentials in the URL are cancelled in both.
pub fn allowed_request(value: &str, application_origin: Option<&str>) -> bool {
    let Some(url) = parse(value) else {
        return false;
    };
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if matches!(url.scheme(), "http" | "https" | "ws" | "wss") {
        return !is_application_request(value, application_origin);
    }
    INERT_SCHEMES.contains(&url.scheme())
}

/// Whether a guest document may download at all.
///
/// The reference prevents every download in both guest sessions; the decision
/// stays a named function so the caller cannot silently start granting them.
pub fn allowed_download() -> bool {
    false
}

/// Whether a Platform document may navigate to `value`
/// (upstream `allowNavigation`).
///
/// @param value - navigation or redirect target.
/// @param origin - the account origin the guest was opened for.
pub fn allowed_platform_navigation(value: &str, origin: &str) -> bool {
    let Some(url) = parse(value) else {
        return false;
    };
    let Some(account) = parse(origin) else {
        return false;
    };
    url.origin() == account.origin() && url.username().is_empty() && url.password().is_none()
}

/// Whether a Platform popup may be handed to the operating system browser.
///
/// The reference opens `https:` destinations without embedded credentials and
/// hands them no session or token; anything else is dropped silently.
pub fn allowed_external_popup(value: &str) -> bool {
    match parse(value) {
        Some(url) => {
            url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
        }
        None => false,
    }
}

/// Classify one browser-guest window-open request.
///
/// @param value - `window.open`/`target=_blank` URL.
/// @param has_body - whether the request carries a POST body; the reference
///   refuses those because the URL alone would lose the request. This port
///   cannot read the body (see `policy::popup_is_form_submission`), so the
///   caller passes the two signals WebView2 does expose.
/// @param application_origin - gateway origin, never opened.
pub fn classify_popup(
    value: &str,
    has_body: bool,
    application_origin: Option<&str>,
) -> PopupDecision {
    if has_body || !allowed_navigation(value, application_origin) {
        return PopupDecision::Denied;
    }
    // `popup_open_request` does the canonical serialization; this function only
    // decides.
    PopupDecision::OpenRequested {
        url: canonical_address(value),
    }
}

/// Canonical serialization of an address already admitted by
/// [`allowed_navigation`].
///
/// `Url::as_str` lowercases scheme and host and elides a default port, which is
/// the form the retained client re-parses in `openTab`.
fn canonical_address(value: &str) -> String {
    match parse(value) {
        Some(url) => url.into(),
        // Unreachable through `allowed_navigation`, which parses first; a
        // non-URL is echoed so the caller cannot receive an invented address.
        None => value.to_string(),
    }
}

/// `DshError` for a build without an embeddable browser guest surface.
///
/// The retained UI shows the refusal, so the message must name the situation
/// rather than imply a transient failure.
pub fn guest_bridge_error() -> DshError {
    DshError::other(
        BROWSER_GUEST_UNAVAILABLE,
        "this build has no embeddable browser guest surface",
    )
}

/// `DshError` for a build without an embedded Platform document surface.
pub fn platform_bridge_error() -> DshError {
    DshError::other(
        PLATFORM_VIEW_UNAVAILABLE,
        "this build has no embedded Platform document surface",
    )
}

/// `DshError` for a guest rectangle the native layer cannot place.
pub fn native_bounds_error(reason: impl Into<String>) -> DshError {
    DshError::other("guest_bounds", reason.into())
}

/// `DshError` for a native guest operation that failed.
pub fn native_guest_error(operation: &str, reason: impl std::fmt::Display) -> DshError {
    DshError::other(format!("guest_{operation}"), reason.to_string())
}

/// Read a guest rectangle out of an invoke argument.
///
/// Shared by every guest command so one malformed rectangle can never reach the
/// native layer through a second, less careful path.
pub fn bounds_from_value(value: Option<&serde_json::Value>) -> Result<GuestBounds, DshError> {
    let Some(value) = value else {
        return Err(DshError::invalid_argument(
            "bounds",
            "a bounds object with x, y, width and height is required",
        ));
    };
    GuestBounds::parse(value)
}

#[cfg(test)]
mod tests {
    use super::*;

    const APPLICATION: &str = "http://127.0.0.1:41234";

    #[test]
    fn navigation_allowlist_matches_the_reference() {
        assert!(allowed_navigation(
            "https://example.com/a?b=1",
            Some(APPLICATION)
        ));
        assert!(allowed_navigation("http://example.com/", Some(APPLICATION)));
        // Schemes with no HTTP(S) semantics never become guest navigations.
        for refused in [
            "file:///C:/Windows/System32/drivers/etc/hosts",
            "javascript:alert(1)",
            "data:text/html,<script>1</script>",
            "about:blank",
            "dsh-app://app/",
            "ws://example.com/socket",
        ] {
            assert!(!allowed_navigation(refused, Some(APPLICATION)), "{refused}");
        }
    }

    #[test]
    fn navigation_refuses_embedded_credentials_and_the_application_origin() {
        assert!(!allowed_navigation(
            "https://user:pass@example.com/",
            Some(APPLICATION)
        ));
        assert!(!allowed_navigation(
            "https://user@example.com/",
            Some(APPLICATION)
        ));
        assert!(!allowed_navigation(APPLICATION, Some(APPLICATION)));
        assert!(!allowed_navigation(
            "http://localhost:41234/",
            Some(APPLICATION)
        ));
        assert!(!allowed_navigation(
            "http://127.0.0.1:41234/api/x",
            Some(APPLICATION)
        ));
        // A different port is a different server and stays allowed.
        assert!(allowed_navigation(
            "http://127.0.0.1:41235/",
            Some(APPLICATION)
        ));
        assert!(!allowed_navigation("not a url", Some(APPLICATION)));
    }

    /// This URL predicate cannot identify the Host when its origin is absent.
    /// Its permissive result is not evidence that the Host is unreachable or
    /// authorization to create a native guest without a resolved owned origin.
    #[test]
    fn missing_application_origin_cannot_identify_and_block_the_host() {
        assert!(allowed_navigation("http://127.0.0.1:41234/", None));
    }

    /// The application is named by its loopback spellings and its port, not by
    /// "any IPv4 address on the gateway's port".
    #[test]
    fn application_origin_matches_only_loopback_on_the_gateway_port() {
        for application in [
            "http://localhost:41234/",
            "http://[::1]:41234/",
            "http://127.0.0.1:41234/",
        ] {
            assert!(
                is_application_request(APPLICATION, Some(application)),
                "{application} must name the same application as {APPLICATION}"
            );
            for loopback in [
                "http://localhost:41234/x",
                "http://[::1]:41234/x",
                "http://127.0.0.1:41234/x",
            ] {
                assert!(
                    is_application_request(loopback, Some(application)),
                    "{loopback} must be refused for application {application}"
                );
            }
        }
    }

    /// A public address on the gateway's port is a different service. The
    /// earlier loopback test accepted every `Ipv4(_)` host, so this address
    /// matched the application and navigation to it was refused as if it were
    /// the application itself.
    #[test]
    fn a_public_ipv4_on_the_gateway_port_is_not_the_application() {
        for public in [
            "http://93.184.216.34:41234/",
            "http://10.0.0.7:41234/",
            "http://192.168.1.5:41234/",
        ] {
            assert!(
                !is_application_request(public, Some(APPLICATION)),
                "{public}"
            );
            assert!(allowed_navigation(public, Some(APPLICATION)), "{public}");
            assert!(allowed_request(public, Some(APPLICATION)), "{public}");
        }
    }

    /// `::1` is loopback, so a guest must never reach it either — including the
    /// compressed and IPv4-mapped spellings a page can write.
    #[test]
    fn ipv6_loopback_reaches_the_application_in_every_spelling() {
        for spelling in [
            "http://[::1]:41234/",
            "http://[0:0:0:0:0:0:0:1]:41234/",
            "http://[::ffff:127.0.0.1]:41234/",
        ] {
            assert!(
                is_application_request(spelling, Some(APPLICATION)),
                "{spelling}"
            );
            assert!(
                !allowed_navigation(spelling, Some(APPLICATION)),
                "{spelling}"
            );
            assert!(!allowed_request(spelling, Some(APPLICATION)), "{spelling}");
        }
        // A non-loopback IPv6 literal stays an ordinary destination.
        assert!(allowed_navigation(
            "http://[2001:db8::1]:41234/",
            Some(APPLICATION)
        ));
    }

    /// A URL without an explicit port targets the scheme default, which is not
    /// the gateway's port, so it can never be the application.
    #[test]
    fn a_scheme_default_port_never_names_the_application() {
        assert!(!is_application_request(
            "http://localhost/",
            Some(APPLICATION)
        ));
        assert!(!is_application_request(
            APPLICATION,
            Some("http://localhost/")
        ));
        assert!(!is_application_request(
            "https://localhost/",
            Some("https://localhost/")
        ));
    }

    #[test]
    fn popup_body_detection_reads_the_two_signals_webview2_exposes() {
        // `target="_blank"` form submission: the browser arguments carry the method.
        assert!(popup_is_form_submission("--form-submit-post", "GET"));
        assert!(popup_is_form_submission("--FORM-SUBMIT-POST", "GET"));
        assert!(popup_is_form_submission("", "POST"));
        assert!(popup_is_form_submission("", "post"));
        assert!(!popup_is_form_submission("", "GET"));
        assert!(!popup_is_form_submission("--disable-features=x", "GET"));
    }

    #[test]
    fn request_allowlist_keeps_websockets_and_inert_schemes() {
        assert!(allowed_request("https://example.com/x", Some(APPLICATION)));
        assert!(allowed_request(
            "wss://example.com/socket",
            Some(APPLICATION)
        ));
        assert!(allowed_request(
            "ws://example.com/socket",
            Some(APPLICATION)
        ));
        assert!(allowed_request(
            "blob:https://example.com/9a1",
            Some(APPLICATION)
        ));
        assert!(allowed_request(
            "data:image/png;base64,AA",
            Some(APPLICATION)
        ));
        assert!(allowed_request("about:blank", Some(APPLICATION)));
        assert!(!allowed_request(
            "https://user:pw@example.com/",
            Some(APPLICATION)
        ));
        assert!(!allowed_request(APPLICATION, Some(APPLICATION)));
        assert!(!allowed_request("file:///C:/secret.txt", Some(APPLICATION)));
        assert!(!allowed_request("chrome://settings", Some(APPLICATION)));
    }

    #[test]
    fn downloads_are_never_granted() {
        assert!(!allowed_download());
    }

    #[test]
    fn popup_requests_reach_the_client_and_deny_the_native_window() {
        assert_eq!(
            classify_popup("https://example.com/next", false, Some(APPLICATION)),
            PopupDecision::OpenRequested {
                url: "https://example.com/next".to_string()
            }
        );
        // A POST body cannot be replayed from a URL.
        assert_eq!(
            classify_popup("https://example.com/post", true, Some(APPLICATION)),
            PopupDecision::Denied
        );
        assert_eq!(
            classify_popup(APPLICATION, false, Some(APPLICATION)),
            PopupDecision::Denied
        );
        assert_eq!(
            classify_popup("mailto:someone@example.com", false, Some(APPLICATION)),
            PopupDecision::Denied
        );
        // The client receives the canonical serialization it re-parses.
        assert_eq!(
            classify_popup("HTTPS://EXAMPLE.com:443/a", false, Some(APPLICATION)),
            PopupDecision::OpenRequested {
                url: "https://example.com/a".to_string()
            }
        );
    }

    #[test]
    fn platform_navigation_is_confined_to_the_account_origin() {
        let origin = "https://platform.example";
        assert!(allowed_platform_navigation(
            "https://platform.example/usage?dist=1",
            origin
        ));
        assert!(allowed_platform_navigation(
            "https://platform.example/top_up",
            origin
        ));
        assert!(!allowed_platform_navigation(
            "https://platform.example.evil.test/usage",
            origin
        ));
        assert!(!allowed_platform_navigation(
            "http://platform.example/usage",
            origin
        ));
        assert!(!allowed_platform_navigation(
            "https://user:pw@platform.example/usage",
            origin
        ));
        assert!(!allowed_platform_navigation("javascript:1", origin));
        assert!(!allowed_platform_navigation(
            "https://platform.example/usage",
            "not a url"
        ));
    }

    #[test]
    fn platform_popups_open_externally_only_over_https() {
        assert!(allowed_external_popup("https://pay.example/checkout"));
        assert!(!allowed_external_popup("http://pay.example/checkout"));
        assert!(!allowed_external_popup(
            "https://user:pw@pay.example/checkout"
        ));
        assert!(!allowed_external_popup("file:///C:/secret"));
    }

    #[test]
    fn unavailable_capabilities_use_the_ratified_machine_codes() {
        match guest_bridge_error() {
            DshError::Other { code, .. } => assert_eq!(code, "browser_guest_unavailable"),
            other => panic!("expected other, got {other:?}"),
        }
        match platform_bridge_error() {
            DshError::Other { code, .. } => assert_eq!(code, "platform_view_unavailable"),
            other => panic!("expected other, got {other:?}"),
        }
    }

    #[test]
    fn bounds_helper_refuses_a_missing_value() {
        assert!(bounds_from_value(None).is_err());
        let value = serde_json::json!({ "x": 1, "y": 2, "width": 3, "height": 4 });
        assert_eq!(
            bounds_from_value(Some(&value)).expect("valid"),
            GuestBounds {
                x: 1,
                y: 2,
                width: 3,
                height: 4
            }
        );
    }
}
