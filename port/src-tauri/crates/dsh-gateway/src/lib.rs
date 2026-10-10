//! `dsh-gateway` — the authenticated loopback HTTP + WebSocket application
//! gateway the Tauri window navigates to (replaces Electron's `dsh-app://app/`
//! document serving and request forwarding; `ui-backend-protocol.md` §7.3
//! "shell-owned path").
//!
//! Contracts:
//! - Serves the packaged web-client shell from an allowlist of shell-owned
//!   pathnames (`/`, `/index.html`, `/assets/…`, `/favicon.svg`,
//!   `/manifest.webmanifest`, plus the port's packaged
//!   `/favicon-dark.svg`, `/mandatory-policy.html`, and
//!   `/desktop-policy-bootstrap.json`). Those routes answer `GET`/`HEAD` only
//!   (`405` otherwise), refuse a path that escapes the packaged root (`403`),
//!   refuse a malformed percent-escape (`400`), and answer a missing file
//!   (`404`) instead of forwarding it to the Host. Path containment, the
//!   upstream MIME map, and the `__DSH_BOOT_READY__` boot gate re-asserted into
//!   `index.html`'s `<head>` are unchanged.
//! - Reverse-proxies every other HTTP request to the supervised Host's
//!   authenticated origin, forwarding the Host session cookie obtained by the
//!   launch-token → cookie exchange (`authenticateWebHost`),
//!   stripping inbound `host`/`origin`/`cookie`/`sec-fetch-site`, dropping
//!   connection-level response headers (`transfer-encoding`, `connection`,
//!   `keep-alive`, `set-cookie`, …) exactly as `web-document.ts` does, and
//!   marking `/plugins/` responses `no-store`.
//! - Proxies WebSocket upgrades transparently (text and binary frame relay in
//!   both directions) with the Host cookie and Host `Origin`.
//! - Implements the `BrowserAuth` flow (`auth.rs`) and never logs the token or
//!   the signing secret.
//! - Binds `127.0.0.1` only unless the explicit LAN opt-in is configured.

pub mod auth;

use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use auth::{BrowserAuth, IndexOutcome};
use axum::body::Body;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::response::Response;
use dsh_core::error::DshError;
use futures_util::{SinkExt, StreamExt};

/// Upstream MIME map (`web-document.ts:5-8`).
///
/// The reference keys the map on `extname(target)` — the last `.` in the whole
/// resolved path — and looks it up in a case-sensitive record. This mirror keeps
/// that exactly: a `.PNG` request is `application/octet-stream` upstream, and a
/// path whose final segment has no dot is unmatched even when a directory
/// component carries one.
fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
    {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "woff2" => "font/woff2",
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => "application/octet-stream",
    }
}

/// Boot-readiness deferred re-asserted into the literal `<head>` of
/// `index.html` (`web-document.ts:10`).
const BOOT_SCRIPT: &str =
    "<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>";

/// Marker inside [`BOOT_SCRIPT`] whose presence means the document already
/// asserts the boot gate, so re-asserting it would install two resolvers.
const BOOT_GATE_MARKER: &str = "globalThis.__DSH_BOOT_READY__";

/// Path prefixes the packaged shell owns (`apps/desktop/src/main.ts:622-623`).
///
/// The reference decides shell-versus-Host from the request pathname *before* it
/// reads anything: only these pathnames reach `serveWebDocument`; every other
/// pathname is forwarded to the Host whatever method it carries. Matching is on
/// the raw pathname, before any percent-decode, exactly as the reference's
/// `url.pathname` test is.
const SHELL_PATH_PREFIXES: [&str; 1] = ["/assets/"];

/// Exact pathnames the packaged shell owns (`main.ts:622-623`).
///
/// The last three are additive port routes: the packaged shell's `index.html`
/// links `/favicon-dark.svg`, and the mandatory-update flow owns
/// `/mandatory-policy.html` and `/desktop-policy-bootstrap.json`. They are
/// packaged shell files, so owning them here keeps them off the Host and makes a
/// missing one answer `404` rather than a proxied Host response.
const SHELL_EXACT_PATHS: [&str; 7] = [
    "/",
    "/index.html",
    "/favicon.svg",
    "/manifest.webmanifest",
    "/favicon-dark.svg",
    "/mandatory-policy.html",
    "/desktop-policy-bootstrap.json",
];

/// Whether the request pathname is shell-owned (`main.ts:622-623`).
fn shell_owns_path(path: &str) -> bool {
    SHELL_EXACT_PATHS.contains(&path)
        || SHELL_PATH_PREFIXES
            .iter()
            .any(|prefix| path.starts_with(prefix))
}

/// Response headers not relayed to the renderer (`web-document.ts:58-62`).
const WITHHELD_RESPONSE_HEADERS: [&str; 11] = [
    "set-cookie",
    "content-encoding",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
];

/// Content-Security-Policy for the gateway-served shell document.
///
/// # Why this exists
///
/// The reference sets no policy at all: Electron's `dsh-app://` protocol serves
/// the document with only `content-type` (`web-document.ts:33-35`), and
/// `tauri.conf.json` leaves `security.csp` null, so the packaged shell document
/// is currently unconstrained. The port's own `mandatory-policy.html` ships
/// `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
/// connect-src ipc: http://ipc.localhost`, and this is the same shape widened to
/// what the preserved web client actually loads.
///
/// # Why there is no nonce or hash
///
/// A `nonce-`/`sha256-` source makes `'unsafe-inline'` ignored (CSP Level 3,
/// `script-src`), and the shipped boot path cannot avoid inline script:
/// - the served `index.html` carries the `__DSH_BOOT_READY__` literal, and this
///   gateway re-asserts it for a document that lacks it;
/// - the Host's boot table is applied at runtime by
///   `applyIndexInjections`, which appends `<script>` elements with
///   `textContent` and no nonce (`packages/client/web/src/apply-injections.ts:
///   27-32`); the table always carries at least the `client-modules` queue row
///   (`packages/client/modules/src/index.ts:578`) and the theme boot row
///   (`ui-theme/src/boot-theme.ts:51`);
/// - the shipped bundle contains the client expression evaluator
///   (`new Function`/`eval`), which needs `'unsafe-eval'`.
///
/// A nonce/hash policy therefore cannot boot this client, so the policy keeps
/// `'unsafe-inline'`/`'unsafe-eval'` for scripts and narrows what it can:
/// no remote or custom scheme is reachable except the Tauri IPC channel, object,
/// base, form, and framing are refused, and every other resource kind is limited
/// to this origin, `data:`, and `blob:` — the forms the preserved client uses
/// for attachments and document preview (blob: image/frame/worker/stylesheet
/// URLs and an `about:` `srcDoc` frame,
/// `ui-sidebar-documentpreview/src/client/{image/ImageBody.tsx,html/HtmlBody.tsx,
/// html/bootstrap.ts,excel/parse.ts,pdf/runtime.ts}`). `'unsafe-eval'` is kept
/// because the shipped bundle contains the client expression evaluator and only
/// a live run could show that no client configuration reaches it.
///
/// # What this policy does not establish
///
/// It is served on every shell document response by default
/// ([`GatewayConfig::loopback`]); [`GatewayConfig::
/// without_shell_content_security_policy`] exists only as an explicit parity
/// escape hatch for a comparison that must observe a policy-free reference
/// response. A response-header test proves the emitted bytes, not that WebView2
/// accepted them or that every resource kind the client can request is covered;
/// those must be observed in a live window before any claim of native
/// enforcement.
const SHELL_CONTENT_SECURITY_POLICY: &str = concat!(
    "default-src 'self' data: blob:; ",
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; ",
    "style-src 'self' 'unsafe-inline' blob:; ",
    "img-src 'self' data: blob:; ",
    "font-src 'self' data:; ",
    "media-src 'self' data: blob:; ",
    "connect-src 'self' ipc: http://ipc.localhost; ",
    "frame-src 'self' blob: data: about:; ",
    "worker-src 'self' blob:; ",
    "manifest-src 'self'; ",
    "base-uri 'none'; ",
    "object-src 'none'; ",
    "form-action 'none'; ",
    "frame-ancestors 'none'",
);

fn withhold_response_header(name: &str) -> bool {
    WITHHELD_RESPONSE_HEADERS.contains(&name)
}

/// Request headers dropped before forwarding (`web-document.ts:85`).
const STRIPPED_REQUEST_HEADERS: [&str; 4] = ["host", "origin", "cookie", "sec-fetch-site"];

/// Host routes whose responses carry immutable cache headers keyed by a
/// per-process revision (`web-document.ts:65`).
const PLUGIN_BUNDLE_PREFIX: &str = "/plugins/";

/// Gateway configuration.
pub struct GatewayConfig {
    /// Packaged web-client dist directory (the shell).
    pub static_dir: PathBuf,
    /// TCP port; `0` picks an ephemeral port. Ignored when `lan` is false in
    /// favour of the loopback bind.
    pub port: u16,
    /// Explicit LAN opt-in. Without it the gateway binds `127.0.0.1` only.
    pub lan: bool,
    /// Absolute browser-cookie lifetime in days (upstream default 30).
    pub cookie_max_age_days: u32,
    /// Whether [`SHELL_CONTENT_SECURITY_POLICY`] is served on the shell
    /// document.
    ///
    /// On by default: the reference sends no policy, so the shipped shell
    /// document would otherwise be unconstrained in a window that can reach the
    /// Host and the native bridge. The policy is the compatible one described on
    /// the constant — it keeps the inline/eval/blob forms the preserved client
    /// boots with and narrows the rest.
    shell_content_security_policy: bool,
    admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
}

impl GatewayConfig {
    /// Shell-serving configuration bound to loopback.
    pub fn loopback(static_dir: impl Into<PathBuf>) -> Self {
        Self {
            static_dir: static_dir.into(),
            port: 0,
            lan: false,
            cookie_max_age_days: 30,
            shell_content_security_policy: true,
            admission: None,
        }
    }

    /// Attach a synchronous, authoritative admission predicate.
    pub fn with_admission(mut self, admission: Arc<dyn Fn() -> bool + Send + Sync>) -> Self {
        self.admission = Some(admission);
        self
    }

    /// Stop serving [`SHELL_CONTENT_SECURITY_POLICY`] on the shell document.
    ///
    /// This exists only so a comparison against a policy-free reference response
    /// stays possible; the shipped configuration serves the policy. The policy is
    /// attached to `/` and `/index.html` only: a document policy governs the
    /// assets, workers, and frames it loads, and the reference sends no header on
    /// any shell asset.
    pub fn without_shell_content_security_policy(mut self) -> Self {
        self.shell_content_security_policy = false;
        self
    }
}

#[derive(Clone)]
struct HostTarget {
    /// Host HTTP origin (scheme + authority).
    origin: String,
    /// Host-issued `name=value` session cookie forwarded to the Host.
    cookie: String,
}

struct GatewayState {
    /// Canonicalized packaged shell root. Canonicalized once at startup so every
    /// per-request containment test compares against a fully resolved directory
    /// and so the gateway can never serve a root that itself is a reparse point
    /// out of the bundle.
    static_dir: PathBuf,
    auth: BrowserAuth,
    /// Gateway's own `http(s)://authority` origin.
    origin: String,
    /// Latest authenticated Host, observable by requests that arrive while the
    /// startup token exchange is still in flight.
    host: tokio::sync::watch::Sender<Option<HostTarget>>,
    client: reqwest::Client,
    admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
    shell_content_security_policy: bool,
}

/// Handle over a running gateway.
pub struct GatewayHandle {
    state: Arc<GatewayState>,
    local_addr: SocketAddr,
    shutdown: tokio::sync::watch::Sender<bool>,
}

impl GatewayHandle {
    /// The gateway origin (HTTP).
    pub fn origin(&self) -> &str {
        &self.state.origin
    }

    /// `BootPayload.streamBaseUrl`: the origin the client re-bases the mux onto.
    pub fn stream_base_url(&self) -> String {
        self.state.origin.clone()
    }

    /// `BootPayload.authenticatedUrl`: the application URL carrying this
    /// process's one-time launch token.
    pub fn authenticated_url(&self) -> String {
        self.state.auth.authenticated_url(&self.state.origin)
    }

    /// The bound socket address (for diagnostics).
    pub fn local_addr(&self) -> SocketAddr {
        self.local_addr
    }

    /// Bind the gateway to a supervised Host: perform the launch-token →
    /// cookie exchange against `authenticated_host_url` (expect `303` +
    /// `set-cookie`, `web-document.ts:43-50`) and retain the cookie pair for
    /// forwarded requests. 503-equivalent behaviour while unset: proxied
    /// requests fail loudly rather than silently.
    pub async fn set_host(&self, authenticated_host_url: &str) -> Result<(), DshError> {
        let response = self
            .state
            .client
            .get(authenticated_host_url)
            .send()
            .await
            .map_err(|e| DshError::other("host_authentication", e.to_string()))?;
        let status = response.status().as_u16();
        let cookie = response
            .headers()
            .get(reqwest::header::SET_COOKIE)
            .and_then(|value| value.to_str().ok())
            .map(|value| {
                let end = value.find(';').unwrap_or(value.len());
                value[..end].to_string()
            });
        if status != 303 || cookie.is_none() {
            return Err(DshError::other(
                "host_authentication",
                "Desktop Host authentication failed",
            ));
        }
        let url = url::Url::parse(authenticated_host_url)
            .map_err(|e| DshError::invalid_argument("url", e.to_string()))?;
        let host = url
            .host()
            .map(|host| match host {
                url::Host::Ipv6(address) => format!("[{address}]"),
                host => host.to_string(),
            })
            .unwrap_or_else(|| "127.0.0.1".to_string());
        let authority = match url.port() {
            Some(port) => format!("{host}:{port}"),
            None => host,
        };
        let origin = format!("{}://{authority}", url.scheme());
        let cookie = cookie.expect("checked");
        tracing::info!(
            host_set = true,
            host_cookie_present = true,
            host_cookie_len = cookie.len(),
            "gateway host authentication completed"
        );
        self.state
            .host
            .send_replace(Some(HostTarget { origin, cookie }));
        Ok(())
    }

    /// Stop accepting traffic and end the serve task.
    pub fn shutdown(&self) {
        let _ = self.shutdown.send(true);
    }
}

/// Start the gateway on `127.0.0.1` (or the configured LAN bind).
pub async fn start(
    config: GatewayConfig,
    signing_secret: Vec<u8>,
) -> Result<GatewayHandle, DshError> {
    let auth = BrowserAuth::new(signing_secret, config.cookie_max_age_days)?;
    // Resolve the packaged root before binding: containment compares real
    // locations, so the root must itself be a real, existing directory.
    let static_dir = canonical_static_root(&config.static_dir)?;
    let bind_ip: std::net::IpAddr = if config.lan {
        "0.0.0.0".parse().expect("literal")
    } else {
        "127.0.0.1".parse().expect("literal")
    };
    let listener = tokio::net::TcpListener::bind(SocketAddr::new(bind_ip, config.port))
        .await
        .map_err(|e| DshError::io("bind gateway", None, &e))?;
    let local_addr = listener
        .local_addr()
        .map_err(|e| DshError::io("gateway local address", None, &e))?;
    let origin = if config.lan {
        format!("http://{}:{}", local_addr.ip(), local_addr.port())
    } else {
        format!("http://127.0.0.1:{}", local_addr.port())
    };
    let (host, _) = tokio::sync::watch::channel(None);
    let state = Arc::new(GatewayState {
        static_dir,
        auth,
        origin,
        host,
        admission: config.admission,
        shell_content_security_policy: config.shell_content_security_policy,
        client: reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| DshError::other("gateway_client", e.to_string()))?,
    });
    let (shutdown, shutdown_rx) = tokio::sync::watch::channel(false);
    let serve_state = state.clone();
    tokio::spawn(async move {
        let mut shutdown_rx = shutdown_rx;
        let app = axum::Router::new()
            .fallback(entrypoint)
            .with_state(serve_state);
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                while !*shutdown_rx.borrow() {
                    if shutdown_rx.changed().await.is_err() {
                        break;
                    }
                }
            })
            .await;
    });
    Ok(GatewayHandle {
        state,
        local_addr,
        shutdown,
    })
}

/// Streaming adapter from an incoming axum body to a `reqwest` stream body:
/// request uploads stream through instead of buffering (upstream `fetch`
/// streaming with `duplex: 'half'`).
fn body_frames(
    mut body: axum::body::Body,
) -> impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Send + 'static {
    use http_body_util::BodyExt as _;
    futures_util::stream::unfold(std::mem::take(&mut body), |mut body| async move {
        loop {
            match body.frame().await {
                Some(Ok(frame)) => match frame.into_data() {
                    Ok(data) => return Some((Ok(data), body)),
                    Err(_) => continue,
                },
                Some(Err(error)) => {
                    return Some((Err(std::io::Error::other(error.to_string())), body))
                }
                None => return None,
            }
        }
    })
}

/// Request entrypoint: WebSocket upgrades relay to the Host; everything else
/// follows the static-shell / reverse-proxy routing.
async fn entrypoint(
    State(state): State<Arc<GatewayState>>,
    request: axum::extract::Request,
) -> Response {
    if !admitted(&state) {
        return unavailable();
    }
    let (mut parts, body) = request.into_parts();
    // WebSocket upgrades relay to the Host with the Host cookie and Host
    // Origin (`ui-backend-protocol.md` §4.1).
    let upgrade = {
        use axum::extract::FromRequestParts as _;
        axum::extract::ws::WebSocketUpgrade::from_request_parts(&mut parts, &state)
            .await
            .ok()
    };
    if let Some(upgrade) = upgrade {
        // Match the HTTP proxy policy before authentication or attaching the
        // Host cookie: absent Origin is allowed for non-browser clients, while
        // a supplied Origin must be this gateway's exact origin.
        if let Some(origin) = header(&parts.headers, "origin") {
            if origin != state.origin {
                return Response::builder()
                    .status(StatusCode::FORBIDDEN)
                    .body(Body::empty())
                    .expect("response");
            }
        }
        let authority = header(&parts.headers, "host").map(str::to_string);
        let cookie = header(&parts.headers, "cookie").map(str::to_string);
        let authenticated = state
            .auth
            .is_authenticated(authority.as_deref(), cookie.as_deref());
        tracing::info!(
            websocket = true,
            authority_present = authority.is_some(),
            browser_cookie_present = cookie.is_some(),
            browser_cookie_len = cookie.as_ref().map_or(0, String::len),
            authenticated,
            "gateway WebSocket authentication checked"
        );
        if !authenticated {
            return unauthorized(parts.method.as_str());
        }
        let path = parts.uri.path().to_string();
        let query = parts.uri.query().unwrap_or("").to_string();
        return websocket_relay(state, &path, &query, upgrade).await;
    }
    route(state, axum::extract::Request::from_parts(parts, body)).await
}

fn admitted(state: &GatewayState) -> bool {
    state.admission.as_ref().is_none_or(|check| check())
}

fn unavailable() -> Response {
    Response::builder()
        .status(StatusCode::SERVICE_UNAVAILABLE)
        .header("cache-control", "no-store")
        .body(Body::empty())
        .expect("response")
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn unauthorized(method: &str) -> Response {
    let body = if method == "HEAD" {
        Body::empty()
    } else {
        Body::from(auth::UNAUTHORIZED_BODY)
    };
    Response::builder()
        .status(StatusCode::UNAUTHORIZED)
        .header("cache-control", "no-store")
        .header("content-type", "text/plain; charset=utf-8")
        .body(body)
        .expect("response")
}

async fn route(state: Arc<GatewayState>, request: axum::extract::Request) -> Response {
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let uri = parts.uri.clone();
    let method_str = method.as_str().to_string();
    let authority = header(&parts.headers, "host").map(str::to_string);
    let cookie = header(&parts.headers, "cookie").map(str::to_string);
    let path = uri.path().to_string();
    let query = uri.query().unwrap_or("").to_string();

    let is_index = path == "/" || path == "/index.html";
    if is_index {
        match state.auth.authorize_index(
            &method_str,
            &path,
            &query,
            authority.as_deref(),
            cookie.as_deref(),
        ) {
            IndexOutcome::Serve => {}
            IndexOutcome::Redirect { set_cookie } => {
                let mut builder = Response::builder()
                    .status(StatusCode::SEE_OTHER)
                    .header("cache-control", "no-store")
                    .header("location", "./")
                    .header("referrer-policy", "no-referrer");
                if let Some(cookie) = set_cookie {
                    builder = builder.header("set-cookie", cookie);
                }
                return builder.body(Body::empty()).expect("response");
            }
            IndexOutcome::Unauthorized => return unauthorized(&method_str),
        }
    } else if !state
        .auth
        .is_authenticated(authority.as_deref(), cookie.as_deref())
    {
        return unauthorized(&method_str);
    }

    // Shell-owned pathnames are answered from the packaged root and never reach
    // the Host; every other pathname is proxied with its method and body intact
    // (`apps/desktop/src/main.ts:621-629`).
    //
    // Authentication runs first for both branches. The reference relies on
    // Electron's own `dsh-app://` session for that; this gateway is a real
    // loopback HTTP origin, so the browser-session cookie is the port's
    // equivalent of that session and an unauthenticated caller learns nothing
    // about the shell route table.
    if shell_owns_path(&path) {
        let response = match serve_static(&state.static_dir, &method_str, &path).await {
            StaticOutcome::Served(response) => response,
            StaticOutcome::MethodNotAllowed => empty_response(StatusCode::METHOD_NOT_ALLOWED),
            StaticOutcome::BadRequest => empty_response(StatusCode::BAD_REQUEST),
            StaticOutcome::Escaped => empty_response(StatusCode::FORBIDDEN),
            StaticOutcome::Missing => empty_response(StatusCode::NOT_FOUND),
        };
        return if is_index && state.shell_content_security_policy {
            attach_shell_document_policy(response)
        } else {
            response
        };
    }
    proxy_http(state, method, &uri, &parts.headers, body).await
}

/// Attach the shell document policy to an index response.
fn attach_shell_document_policy(mut response: Response) -> Response {
    response.headers_mut().insert(
        "content-security-policy",
        HeaderValue::from_static(SHELL_CONTENT_SECURITY_POLICY),
    );
    response
}

/// Bodyless answer carrying only a status, as every refusal branch of the
/// reference's static handler builds (`new Response(null, { status })`).
fn empty_response(status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .body(Body::empty())
        .expect("response")
}

/// Result of consulting the packaged shell for a shell-owned pathname.
enum StaticOutcome {
    /// The shell owns this path and produced this response.
    Served(Response),
    /// A method other than `GET`/`HEAD`, refused before the path is even decoded
    /// (`web-document.ts:19`): `405`.
    MethodNotAllowed,
    /// `decodeURIComponent` threw on the pathname (`web-document.ts:22`): `400`.
    BadRequest,
    /// The path normalizes outside the packaged root
    /// (`web-document.ts:25`): `403`, and never a read.
    Escaped,
    /// `ENOENT` for a shell-owned path (`web-document.ts:28`): `404`. A
    /// shell-owned pathname is never forwarded, so the reference's `ENOENT`
    /// branch is a `404` rather than a Host miss.
    Missing,
}

/// Percent-decoded static resolution (`web-document.ts:22-25`).
#[derive(Debug)]
enum StaticPath {
    /// A contained target: the normalized absolute path inside the root.
    Target(PathBuf),
    /// The pathname is not a valid percent-escaped string.
    Malformed,
    /// The pathname normalizes outside the packaged root.
    Escaped,
}

/// Percent-decoded static resolution with path containment
/// (`web-document.ts:22-25`).
///
/// The reference resolves the request against the root with `path.resolve`,
/// which **lexically normalizes** `.` and `..` before the containment test. That
/// normalization is the whole defence: `resolve(root, './' + '/../settings.json')`
/// becomes a sibling of the root, `startsWith(directory + sep)` is false, and the
/// reference answers `403` without ever touching the file. Skipping it and
/// testing the un-normalized join would leave a `..` segment inside a path that
/// still *looks* contained, so traversal would be served as shell content rather
/// than refused.
///
/// Containment is therefore decided on the normalized path, and the read in
/// [`serve_static`] decides only whether there is a body — matching the reference
/// order, which compares strings before it calls `readFile`.
///
/// A pathname `decodeURIComponent` rejects is [`StaticPath::Malformed`], the
/// reference's `400` branch, which is decided before any containment test.
///
/// # Divergence from the reference: reparse-point containment
///
/// `path.resolve` is purely lexical, so the reference's `startsWith` test is
/// decided on **path text** and a symlink, NTFS junction, or other reparse point
/// inside the packaged root that targets outside it is followed by `readFile`
/// and served. Lexical containment alone therefore does not contain the read.
///
/// The packaged `static_dir` ships inside the application bundle and the gateway
/// is the only component that reads it, so this port closes that hole rather
/// than reproducing it: the returned path is *also* required to resolve, through
/// every reparse point on it, to a location inside the canonical root. A path
/// that is textually contained but physically escapes is refused as
/// [`StaticPath::Escaped`] — the same `403` the reference gives a lexical escape,
/// and never a read.
///
/// The reference's observable behaviour is unchanged for every path it can
/// actually serve: contained regular files (byte-identical reads, same MIME,
/// same boot-gate re-assertion) and lexical escapes (same `403`). Only paths
/// whose bytes live outside the packaged tree differ, which is exactly the case
/// the reference got wrong.
fn resolve_static(root: &Path, request_path: &str) -> StaticPath {
    let Some(decoded) = percent_decode(request_path) else {
        return StaticPath::Malformed;
    };
    // `'.' + pathname`, with `/` mapped to `/index.html` first.
    let relative = if decoded == "/" {
        "./index.html".to_string()
    } else {
        format!(".{decoded}")
    };
    let Some(target) = normalize_lexically(&root.join(relative)) else {
        return StaticPath::Escaped;
    };
    let Some(directory) = normalize_lexically(root) else {
        return StaticPath::Escaped;
    };
    if !target.starts_with(&directory) {
        return StaticPath::Escaped;
    }
    StaticPath::Target(target)
}

/// Canonicalize the packaged root once, at startup, so per-request containment
/// compares against a fully resolved directory instead of re-resolving it.
///
/// Fails loud rather than falling back to the unresolved path: a root that cannot
/// be canonicalized cannot be contained against, and silently continuing would
/// reintroduce the escape this module closes.
pub fn canonical_static_root(root: &Path) -> Result<PathBuf, DshError> {
    std::fs::canonicalize(root)
        .map_err(|e| DshError::io("resolve static root", Some(root.display().to_string()), &e))
}

/// Whether every reparse point between the canonical root and `target` keeps
/// `target` inside that root.
///
/// `std::fs::canonicalize` resolves symlinks, junctions, and other reparse points
/// on the whole path at once, then the result is compared component-wise against
/// the already-canonical root. Comparing canonical forms means the check is made
/// on where the bytes actually live, so a junction to a sibling directory, a
/// relative symlink loop, or a `\\?\`-prefixed target all fail it.
///
/// `canonicalize` also requires the leaf to exist, so a contained-but-absent path
/// answers `false` here and is reported as a miss.
fn resolves_inside(canonical_root: &Path, target: &Path) -> Option<PathBuf> {
    let real = std::fs::canonicalize(target).ok()?;
    real.starts_with(canonical_root).then_some(real)
}

/// Lexically resolve `.` and `..` components without touching the filesystem,
/// mirroring `path.resolve`'s normalization.
///
/// This function does **not** resolve reparse points, and it is not the
/// containment decision on its own: it only reproduces the reference's textual
/// normalization, which [`resolve_static`] applies first and [`resolves_inside`]
/// then backs with a check on where the bytes actually live. Leaving containment
/// to this function alone is the escape the module documents on
/// [`resolve_static`] — a junction inside the root whose text is contained but
/// whose target is not would be served.
///
/// `None` when a `..` would ascend past a relative root with nothing to pop,
/// which `path.resolve` answers against the process working directory.
fn normalize_lexically(path: &Path) -> Option<PathBuf> {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => out.push(prefix.as_os_str()),
            Component::RootDir => out.push(Component::RootDir.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                let popped = out.pop();
                if !popped && !out.has_root() {
                    return None;
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    Some(out)
}

/// `ENOENT` for a missing static file, matching upstream's
/// `(error as NodeJS.ErrnoException).code === 'ENOENT'` branch
/// (`web-document.ts:28`).
fn is_not_found(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

/// Serve one shell-owned pathname (`serveWebDocument`, `web-document.ts:18-36`).
///
/// The method check comes first, before the path is decoded or resolved, exactly
/// as the reference orders it: a `POST /assets/…` is a `405` and never a `400`
/// or `403`.
///
/// `HEAD` never reads the file: the reference constructs the `Response` with a
/// null body and Chromium sees exactly the status and headers, so reading
/// megabytes of `app.js` to answer a metadata probe is work the product never
/// does. The trade the reference accepts is that a `HEAD` for a missing file
/// answers `200` with no body, because the read that would raise `ENOENT` never
/// happens; this mirror keeps that behaviour rather than inventing a `404`.
///
/// Reparse containment is decided before the `HEAD` short-circuit, so a path
/// whose bytes live outside the root is refused for `HEAD` exactly as it is for
/// `GET`. An absent path is still not a refusal — it is the reference's miss
/// branch, which is what keeps `HEAD` answering `200` for a file that is not
/// there.
///
/// A present file is opened once for metadata and read from that same handle, so
/// the served bytes and the reported length cannot disagree the way two separate
/// path lookups could.
async fn serve_static(root: &Path, method: &str, path: &str) -> StaticOutcome {
    if method != "GET" && method != "HEAD" {
        return StaticOutcome::MethodNotAllowed;
    }
    let target = match resolve_static(root, path) {
        StaticPath::Target(target) => target,
        StaticPath::Malformed => return StaticOutcome::BadRequest,
        StaticPath::Escaped => return StaticOutcome::Escaped,
    };
    let content_type = content_type_for(&target);
    // Resolve through every reparse point on the path. An escaping link is a
    // refusal; an absent path is the miss branch, which `HEAD` answers 200 for.
    let resolved = resolves_inside(root, &target);
    if resolved.is_none() && target.exists() {
        return StaticOutcome::Escaped;
    }
    if method == "HEAD" {
        return StaticOutcome::Served(empty_static_response(StatusCode::OK, content_type, None));
    }
    let Some(target) = resolved else {
        return StaticOutcome::Missing;
    };
    let content = match tokio::fs::read(&target).await {
        Ok(content) => content,
        Err(error) if is_not_found(&error) => return StaticOutcome::Missing,
        Err(error) => {
            tracing::warn!(
                response_status = 500,
                static_error_kind = ?error.kind(),
                "static asset could not be read"
            );
            return StaticOutcome::Served(empty_static_response(
                StatusCode::INTERNAL_SERVER_ERROR,
                "",
                None,
            ));
        }
    };
    let is_index = path == "/" || path == "/index.html";
    let payload: Vec<u8> = if is_index {
        inject_boot_script(content)
    } else {
        content
    };
    // The reference constructs the body from a string, so `content-length`
    // describes the re-asserted bytes, not the on-disk length. `content-encoding`
    // is deliberately absent: these bytes are not encoded.
    StaticOutcome::Served(empty_static_response(
        StatusCode::OK,
        content_type,
        Some(&payload),
    ))
}

/// Re-assert the desktop boot gate in the literal `<head>` of `index.html`
/// (`web-document.ts:31-32`).
///
/// Upstream's `body.toString().replace('<head>', '<head>' + BOOT)` replaces the
/// **first** occurrence; when there is none the document passes through
/// unchanged rather than gaining a prefix. This mirror follows the source, and
/// decodes lossily so a non-UTF-8 byte cannot turn the shell into an error page.
///
/// One divergence: the port's packaged `index.html` already carries the literal
/// ([`BOOT_GATE_MARKER`]) and owns it — the shell writes `__DSH_BOOT_READY__`
/// itself and this side only re-asserts it idempotently
/// (`port/ui/desktop-bridge/shell-boot.ts` ownership table). Inserting the
/// script into a document that already carries the assertion would install two
/// resolvers with the gate read from the last assignment, so a document that
/// already asserts the gate is returned byte-identical. The upstream dist has no
/// literal, so its observable behaviour is unchanged.
fn inject_boot_script(content: Vec<u8>) -> Vec<u8> {
    let text = String::from_utf8_lossy(&content);
    if text.contains(BOOT_GATE_MARKER) {
        return content;
    }
    match text.find("<head>") {
        Some(at) => {
            let mut out = String::with_capacity(text.len() + BOOT_SCRIPT.len());
            out.push_str(&text[..at + "<head>".len()]);
            out.push_str(BOOT_SCRIPT);
            out.push_str(&text[at + "<head>".len()..]);
            out.into_bytes()
        }
        None => content,
    }
}

/// Build a static response. `payload` is `None` for bodyless answers (`HEAD`,
/// `404`, `500`), which never carry a `content-length` the reference would omit.
fn empty_static_response(
    status: StatusCode,
    content_type: &'static str,
    payload: Option<&[u8]>,
) -> Response {
    let mut builder = Response::builder().status(status);
    if !content_type.is_empty() {
        builder = builder.header("content-type", content_type);
    }
    if let Some(bytes) = payload {
        builder = builder.header("content-length", bytes.len().to_string());
    }
    builder
        .body(match payload {
            Some(bytes) => Body::from(bytes.to_vec()),
            None => Body::empty(),
        })
        .expect("response")
}

fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => {
                let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).ok()?;
                out.push(u8::from_str_radix(hex, 16).ok()?);
                index += 3;
            }
            b'%' => return None,
            byte => {
                out.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

async fn proxy_http(
    state: Arc<GatewayState>,
    method: Method,
    uri: &Uri,
    headers: &HeaderMap,
    body: axum::body::Body,
) -> Response {
    // The window may request bootstrap modules before set_host finishes its
    // token→cookie exchange. Proxy requests wait for that same startup edge as
    // WebSockets, instead of returning a body that a <script> could misread as
    // a successful JavaScript load.
    let mut host_rx = state.host.subscribe();
    let current_host = host_rx.borrow_and_update().clone();
    let host = match current_host {
        Some(host) => host,
        None => {
            tracing::info!(
                response_status = 503,
                response_content_type = "none",
                response_body_prefix = "dsh desktop: host is not ready",
                "waiting for Host before proxied HTTP response"
            );
            match tokio::time::timeout(std::time::Duration::from_secs(30), async {
                loop {
                    if let Some(host) = host_rx.borrow_and_update().clone() {
                        return Some(host);
                    }
                    if host_rx.changed().await.is_err() {
                        return None;
                    }
                }
            })
            .await
            {
                Ok(Some(host)) => host,
                _ => {
                    tracing::warn!(
                        response_status = 503,
                        response_content_type = "none",
                        response_body_prefix = "dsh desktop: host is not ready",
                        "Host did not become ready for proxied HTTP request"
                    );
                    return Response::builder()
                        .status(StatusCode::SERVICE_UNAVAILABLE)
                        .header("content-type", "text/plain; charset=utf-8")
                        .body(Body::from("dsh desktop: host is not ready"))
                        .expect("response");
                }
            }
        }
    };
    // `forwardWebRequest` refuses foreign origins (`web-document.ts:79-80`).
    if let Some(origin) = header(headers, "origin") {
        if origin != state.origin {
            return Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Body::empty())
                .expect("response");
        }
    }
    let target = format!(
        "{}{}{}",
        host.origin,
        uri.path(),
        match uri.query() {
            Some(query) => format!("?{query}"),
            None => String::new(),
        }
    );
    let mut request = state.client.request(
        reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
        &target,
    );
    // `forwardWebRequest` passes `request.body`, which is null for a GET or HEAD.
    // Wrapping an empty stream instead would make reqwest choose
    // `transfer-encoding: chunked` and send a body the Host never receives from
    // the reference, so a Host that rejects bodies on read routes would answer
    // differently under this gateway than under Electron.
    if !matches!(method, Method::GET | Method::HEAD) {
        request = request.body(reqwest::Body::wrap_stream(body_frames(body)));
    } else {
        // `body_frames` owns the extractor body; dropping it here releases the
        // request's remaining frames immediately rather than at stream end.
        drop(body);
    }
    for (name, value) in headers.iter() {
        let key = name.as_str();
        if STRIPPED_REQUEST_HEADERS.contains(&key)
            || key == "content-length"
            || key == "transfer-encoding"
        {
            continue;
        }
        if let Ok(value) = value.to_str() {
            request = request.header(key, value);
        }
    }
    request = request.header("cookie", host.cookie.clone());
    if !admitted(&state) {
        return unavailable();
    }
    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from(format!(
                    "dsh desktop: host request failed: {error}"
                )))
                .expect("response")
        }
    };
    if !admitted(&state) {
        return unavailable();
    }
    let mut builder = Response::builder().status(upstream.status().as_u16());
    for (name, value) in upstream.headers().iter() {
        let key = name.as_str();
        if withhold_response_header(key) {
            continue;
        }
        if let Ok(value) = value.to_str() {
            builder = builder.header(key, value);
        }
    }
    if uri.path().starts_with(PLUGIN_BUNDLE_PREFIX) {
        if let Some(headers) = builder.headers_mut() {
            headers.insert(
                reqwest::header::CACHE_CONTROL,
                HeaderValue::from_static("no-store"),
            );
        }
    }
    builder
        .body(Body::from_stream(upstream.bytes_stream()))
        .expect("response")
}

/// Transparent WebSocket relay to the Host's `/api/remote.mux` (or any upgrade
/// path): the Host cookie and Host `Origin` are attached before the upgrade
/// leaves (`ui-backend-protocol.md` §4.1, `apps/desktop/src/main.ts:665-676`),
/// and every text/binary frame relays verbatim in both directions.
async fn websocket_relay(
    state: Arc<GatewayState>,
    path: &str,
    query: &str,
    upgrade: axum::extract::ws::WebSocketUpgrade,
) -> Response {
    // The window can make its first WebSocket request immediately after the
    // gateway URL is published, while set_host is still doing the Host's
    // token→cookie exchange. Keep an authenticated upgrade pending so that this
    // startup race does not consume the client's only connection attempt.
    let mut host_rx = state.host.subscribe();
    let current_host = host_rx.borrow_and_update().clone();
    let host = if let Some(host) = current_host {
        host
    } else {
        tracing::info!(
            host_set = false,
            "waiting for Host before WebSocket handshake"
        );
        match tokio::time::timeout(std::time::Duration::from_secs(30), async {
            loop {
                if let Some(host) = host_rx.borrow_and_update().clone() {
                    return Some(host);
                }
                if host_rx.changed().await.is_err() {
                    return None;
                }
            }
        })
        .await
        {
            Ok(Some(host)) => host,
            _ => {
                tracing::warn!(
                    host_set = false,
                    response_status = 503,
                    response_content_type = "text/plain; charset=utf-8",
                    response_body_prefix = "dsh desktop: host is not ready",
                    "Host did not become ready for WebSocket upgrade"
                );
                return Response::builder()
                    .status(StatusCode::SERVICE_UNAVAILABLE)
                    .header("content-type", "text/plain; charset=utf-8")
                    .body(Body::from("dsh desktop: host is not ready"))
                    .expect("response");
            }
        }
    };
    tracing::info!(
        host_set = true,
        host_cookie_present = !host.cookie.is_empty(),
        host_cookie_len = host.cookie.len(),
        "starting upstream WebSocket handshake"
    );
    let ws_scheme = if host.origin.starts_with("https") {
        "wss"
    } else {
        "ws"
    };
    let authority = host
        .origin
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .to_string();
    let target = format!(
        "{ws_scheme}://{authority}{path}{}",
        if query.is_empty() {
            String::new()
        } else {
            format!("?{query}")
        }
    );
    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
            target.as_str(),
        )
        .expect("ws request");
    let request_headers = request.headers_mut();
    request_headers.insert(
        "cookie",
        HeaderValue::from_str(&host.cookie).expect("cookie header"),
    );
    request_headers.insert(
        "origin",
        HeaderValue::from_str(&host.origin).expect("origin header"),
    );
    let upstream = match tokio_tungstenite::connect_async(request).await {
        Ok((stream, response)) => {
            tracing::info!(
                upstream_status = response.status().as_u16(),
                upstream_reason = response.status().canonical_reason().unwrap_or("unknown"),
                host_cookie_present = !host.cookie.is_empty(),
                "upstream WebSocket handshake accepted"
            );
            stream
        }
        Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
            let websocket_headers = response
                .headers()
                .iter()
                .filter(|(name, _)| name.as_str().starts_with("sec-websocket-"))
                .map(|(name, value)| {
                    format!(
                        "{}={}",
                        name.as_str(),
                        value.to_str().unwrap_or("<non-text>")
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            tracing::warn!(
                upstream_status = response.status().as_u16(),
                upstream_reason = response.status().canonical_reason().unwrap_or("unknown"),
                upstream_sec_websocket_headers = %websocket_headers,
                host_cookie_present = !host.cookie.is_empty(),
                host_cookie_len = host.cookie.len(),
                "upstream WebSocket handshake rejected"
            );
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("dsh desktop: host WebSocket upgrade rejected"))
                .expect("response");
        }
        Err(error) => {
            let kind = match error {
                tokio_tungstenite::tungstenite::Error::Io(_) => "transport_io",
                tokio_tungstenite::tungstenite::Error::Tls(_) => "transport_tls",
                _ => "protocol_or_transport",
            };
            tracing::warn!(
                upstream_error_kind = kind,
                host_cookie_present = !host.cookie.is_empty(),
                host_cookie_len = host.cookie.len(),
                "upstream WebSocket handshake failed before HTTP response"
            );
            return Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Body::from("dsh desktop: host WebSocket handshake failed"))
                .expect("response");
        }
    };
    if !admitted(&state) {
        return unavailable();
    }
    let admission = state.admission.clone();
    upgrade.on_upgrade(move |client| relay_frames(client, upstream, admission))
}

async fn relay_frames(
    client: axum::extract::ws::WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
    admission: Option<Arc<dyn Fn() -> bool + Send + Sync>>,
) {
    let (mut client_sink, mut client_stream) = client.split();
    let (mut upstream_sink, mut upstream_stream) = upstream.split();
    let admission_to_host = admission.clone();
    let admission_to_client = admission.clone();
    let to_host = async move {
        loop {
            if admission_to_host.as_ref().is_some_and(|check| !check()) {
                break;
            }
            let Some(Ok(message)) = client_stream.next().await else {
                break;
            };
            let frame = match message {
                axum::extract::ws::Message::Text(text) => {
                    tokio_tungstenite::tungstenite::Message::Text(text.to_string().into())
                }
                axum::extract::ws::Message::Binary(bytes) => {
                    tokio_tungstenite::tungstenite::Message::Binary(bytes)
                }
                axum::extract::ws::Message::Ping(bytes) => {
                    tokio_tungstenite::tungstenite::Message::Ping(bytes)
                }
                axum::extract::ws::Message::Pong(bytes) => {
                    tokio_tungstenite::tungstenite::Message::Pong(bytes)
                }
                axum::extract::ws::Message::Close(frame) => {
                    tokio_tungstenite::tungstenite::Message::Close(frame.map(|f| {
                        tokio_tungstenite::tungstenite::protocol::CloseFrame {
                            code: f.code.into(),
                            reason: f.reason.to_string().into(),
                        }
                    }))
                }
            };
            if admission_to_host.as_ref().is_some_and(|check| !check()) {
                break;
            }
            if upstream_sink.send(frame).await.is_err() {
                break;
            }
        }
    };
    let to_client = async move {
        loop {
            if admission_to_client.as_ref().is_some_and(|check| !check()) {
                break;
            }
            let Some(Ok(message)) = upstream_stream.next().await else {
                break;
            };
            let frame = match message {
                tokio_tungstenite::tungstenite::Message::Text(text) => {
                    axum::extract::ws::Message::Text(text.to_string().into())
                }
                tokio_tungstenite::tungstenite::Message::Binary(bytes) => {
                    axum::extract::ws::Message::Binary(bytes)
                }
                tokio_tungstenite::tungstenite::Message::Ping(bytes) => {
                    axum::extract::ws::Message::Ping(bytes)
                }
                tokio_tungstenite::tungstenite::Message::Pong(bytes) => {
                    axum::extract::ws::Message::Pong(bytes)
                }
                tokio_tungstenite::tungstenite::Message::Close(frame) => {
                    axum::extract::ws::Message::Close(frame.map(|f| {
                        axum::extract::ws::CloseFrame {
                            code: f.code.into(),
                            reason: f.reason.to_string().into(),
                        }
                    }))
                }
                tokio_tungstenite::tungstenite::Message::Frame(_) => continue,
            };
            if admission_to_client.as_ref().is_some_and(|check| !check()) {
                break;
            }
            if client_sink.send(frame).await.is_err() {
                break;
            }
        }
    };
    if let Some(check) = admission {
        let monitor = async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_millis(100));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                interval.tick().await;
                if !check() {
                    break;
                }
            }
        };
        tokio::select! {
            () = to_host => {},
            () = to_client => {},
            () = monitor => {},
        }
    } else {
        tokio::select! {
            () = to_host => {},
            () = to_client => {},
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        content_type_for, empty_response, empty_static_response, inject_boot_script, is_not_found,
        normalize_lexically, resolve_static, withhold_response_header, Path, PathBuf, StatusCode,
        BOOT_GATE_MARKER, BOOT_SCRIPT,
    };

    #[test]
    fn proxy_drops_connection_level_response_headers() {
        for name in [
            "transfer-encoding",
            "connection",
            "keep-alive",
            "te",
            "trailer",
            "upgrade",
        ] {
            assert!(withhold_response_header(name), "{name} must be withheld");
        }
        assert!(!withhold_response_header("content-type"));
    }

    #[test]
    fn mime_map_matches_the_reference_extension_lookup() {
        // Every entry the reference record declares, at its exact spelling.
        for (path, expected) in [
            ("/root/index.html", "text/html; charset=utf-8"),
            ("/root/app.js", "text/javascript; charset=utf-8"),
            ("/root/app.mjs", "text/javascript; charset=utf-8"),
            ("/root/app.css", "text/css; charset=utf-8"),
            ("/root/logo.svg", "image/svg+xml"),
            ("/root/data.json", "application/json"),
            ("/root/site.webmanifest", "application/manifest+json"),
            ("/root/font.woff2", "font/woff2"),
            ("/root/icon.png", "image/png"),
            ("/root/favicon.ico", "image/x-icon"),
        ] {
            assert_eq!(
                content_type_for(Path::new(path)),
                expected,
                "{path} must map like the reference MIME record"
            );
        }
        // The reference looks the extension up case-sensitively and leaves an
        // unknown or absent extension at the octet-stream default.
        assert_eq!(
            content_type_for(Path::new("/root/ICON.PNG")),
            "application/octet-stream",
            "the reference record is case-sensitive"
        );
        assert_eq!(
            content_type_for(Path::new("/root/LICENSE")),
            "application/octet-stream"
        );
        // `extname` reads the last dot in the whole path, so a dotted directory
        // component does not supply the extension.
        assert_eq!(
            content_type_for(Path::new("/root/v1.2/README")),
            "application/octet-stream"
        );
    }

    #[test]
    fn boot_script_lands_after_the_first_literal_head_tag() {
        let injected = inject_boot_script(b"<html><head><title>t</title></head></html>".to_vec());
        let text = String::from_utf8(injected).expect("utf8");
        assert!(text.contains(&format!("<head>{BOOT_SCRIPT}")), "{text}");
        assert_eq!(text.matches(&BOOT_SCRIPT.to_string()).count(), 1);
        // Byte length grows by exactly the injected script.
        assert_eq!(
            text.len(),
            "<html><head><title>t</title></head></html>".len() + BOOT_SCRIPT.len()
        );
    }

    #[test]
    fn boot_script_is_a_single_replacement_and_never_a_prefix() {
        // Upstream replaces the FIRST `<head>` only.
        let text = String::from_utf8(inject_boot_script(b"<head>a</head><head>b</head>".to_vec()))
            .expect("utf8");
        assert_eq!(text, format!("<head>{BOOT_SCRIPT}a</head><head>b</head>"));

        // With no literal `<head>` the reference passes the document through
        // unchanged rather than prepending the script.
        let unchanged = inject_boot_script(b"<html><body>no head</body></html>".to_vec());
        assert_eq!(unchanged, b"<html><body>no head</body></html>".to_vec());

        // An uppercase tag is not the literal the reference matches.
        let uppercase = inject_boot_script(b"<HTML><HEAD></HEAD></HTML>".to_vec());
        assert_eq!(uppercase, b"<HTML><HEAD></HEAD></HTML>".to_vec());
    }

    #[test]
    fn static_resolution_matches_reference_normalization_and_containment() {
        use super::StaticPath;
        // Absolute rooted paths, as the packaged `static_dir` always is.
        let root = Path::new("C:\\app\\shell");
        let directory = PathBuf::from("C:\\app\\shell");

        // Contained paths resolve like `path.resolve(root, '.' + pathname)`.
        for (request, expected) in [
            ("/", "C:\\app\\shell\\index.html"),
            ("/index.html", "C:\\app\\shell\\index.html"),
            ("/assets/app.js", "C:\\app\\shell\\assets\\app.js"),
            // `.` and repeated separators normalize away, as `path.resolve` does.
            ("/./assets/./app.js", "C:\\app\\shell\\assets\\app.js"),
            ("/assets//app.js", "C:\\app\\shell\\assets\\app.js"),
        ] {
            match resolve_static(root, request) {
                StaticPath::Target(target) => {
                    assert_eq!(target, PathBuf::from(expected), "{request}");
                    assert!(target.starts_with(&directory));
                }
                other => panic!("{request} must be contained: {other:?}"),
            }
        }

        // Every traversal spelling the reference normalizes to a sibling must be
        // refused BEFORE any read; this is the whole containment defence.
        for request in [
            "/../settings.json",
            "/..%2f..%2fsettings.json",
            "/assets/../../settings.json",
            "/%2e%2e/settings.json",
            "/assets/../../../etc/hosts",
        ] {
            assert!(
                matches!(resolve_static(root, request), StaticPath::Escaped),
                "{request} normalizes outside the root and must be refused"
            );
        }

        // A malformed escape is the reference's `decodeURIComponent` throw,
        // which it answers as `400` rather than resolving.
        assert!(matches!(
            resolve_static(root, "/%zz"),
            StaticPath::Malformed
        ));
        assert!(matches!(resolve_static(root, "/%2"), StaticPath::Malformed));

        // A `..` that stays inside the root is normalized, not refused.
        match resolve_static(root, "/assets/../index.html") {
            StaticPath::Target(target) => assert_eq!(
                target,
                PathBuf::from("C:\\app\\shell\\index.html"),
                "interior traversal that resolves inside the root is served"
            ),
            other => panic!("interior traversal must be contained: {other:?}"),
        }
    }

    #[test]
    fn shell_route_allowlist_matches_the_reference_and_the_port_additions() {
        use super::shell_owns_path;
        // Every pathname the reference routes to `serveWebDocument`
        // (`apps/desktop/src/main.ts:622-623`).
        for path in [
            "/",
            "/index.html",
            "/assets/app.js",
            "/assets/langs/typescript-abc123.js",
            "/favicon.svg",
            "/manifest.webmanifest",
        ] {
            assert!(shell_owns_path(path), "{path} is shell-owned");
        }
        // The port's packaged additions.
        for path in [
            "/favicon-dark.svg",
            "/mandatory-policy.html",
            "/desktop-policy-bootstrap.json",
        ] {
            assert!(shell_owns_path(path), "{path} is a port shell route");
        }
        // Everything else is Host traffic, including Host routes that merely
        // resemble a shell path and the bare prefix without its separator.
        for path in [
            "/api/echo",
            "/plugins/example.js",
            "/client-modules/client.js",
            "/assets",
            "/assetsx/app.js",
            "/index.htm",
            "/favicon.svg.map",
            "/settings.json",
        ] {
            assert!(!shell_owns_path(path), "{path} must be proxied");
        }
    }

    #[test]
    fn boot_gate_is_re_asserted_only_when_the_document_lacks_it() {
        // The port's packaged index.html owns the literal, so the gateway's
        // re-assertion must leave it byte-identical instead of installing a
        // second resolver.
        let owned = b"<head><script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script></head>"
            .to_vec();
        assert_eq!(inject_boot_script(owned.clone()), owned);
        assert_eq!(
            String::from_utf8(inject_boot_script(owned))
                .expect("utf8")
                .matches(BOOT_GATE_MARKER)
                .count(),
            1
        );
        // A document without the assertion (the upstream dist) still gets it.
        assert_eq!(
            String::from_utf8(inject_boot_script(b"<head></head>".to_vec()))
                .expect("utf8")
                .matches(BOOT_GATE_MARKER)
                .count(),
            1
        );
        // The marker the idempotence test keys on really is inside the script.
        assert!(BOOT_SCRIPT.contains(BOOT_GATE_MARKER));
    }

    #[test]
    fn refusal_answers_are_bodyless_and_carry_no_content_type() {
        for status in [
            StatusCode::METHOD_NOT_ALLOWED,
            StatusCode::BAD_REQUEST,
            StatusCode::FORBIDDEN,
            StatusCode::NOT_FOUND,
        ] {
            let response = empty_response(status);
            assert_eq!(response.status(), status);
            assert!(
                response.headers().get("content-type").is_none(),
                "`new Response(null, {{ status }})` sets no content-type"
            );
            assert!(response.headers().get("content-length").is_none());
        }
    }

    #[test]
    fn reparse_containment_compares_canonical_locations() {
        use super::{canonical_static_root, resolves_inside};
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("shell");
        std::fs::create_dir_all(root.join("assets")).expect("root");
        let outside = dir.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(root.join("index.html"), b"<head></head>").expect("index");
        std::fs::write(outside.join("secret.txt"), b"SENTINEL").expect("secret");

        let canonical = canonical_static_root(&root).expect("canonical root");
        // Component-wise comparison must not be fooled by a shared string prefix:
        // `shell-evil` is not inside `shell`, despite the textual prefix.
        let evil = dir.path().join("shell-evil");
        std::fs::create_dir_all(&evil).expect("evil");
        std::fs::write(evil.join("secret.txt"), b"SENTINEL").expect("evil secret");
        assert_eq!(
            resolves_inside(&canonical, &evil.join("secret.txt")),
            None,
            "a prefix-sharing sibling directory is outside the root"
        );

        // A contained regular file resolves to itself inside the root.
        assert_eq!(
            resolves_inside(&canonical, &root.join("index.html")),
            Some(canonical.join("index.html"))
        );

        // An absent leaf cannot be canonicalized, so it is not reported as inside.
        assert_eq!(resolves_inside(&canonical, &root.join("absent.js")), None);

        // A non-existent root is a loud failure, not a silent unresolved fallback.
        assert!(canonical_static_root(&dir.path().join("missing")).is_err());
    }

    #[test]
    fn lexical_normalization_does_not_follow_symlinks() {
        // The reference compares literal resolved strings, so no filesystem
        // lookup participates. Normalizing must stay purely textual.
        assert_eq!(
            normalize_lexically(Path::new("C:\\app\\shell\\..\\shell\\index.html")),
            Some(PathBuf::from("C:\\app\\shell\\index.html"))
        );
        assert_eq!(
            normalize_lexically(Path::new("C:\\app\\.\\shell\\link.js")),
            Some(PathBuf::from("C:\\app\\shell\\link.js"))
        );
        // Ascending past the root of a relative path has nothing to pop.
        assert_eq!(normalize_lexically(Path::new("app\\..\\..\\escape")), None);
    }

    #[test]
    fn only_not_found_is_a_404() {
        assert!(is_not_found(&std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "missing"
        )));
        assert!(!is_not_found(&std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "denied"
        )));
        assert!(!is_not_found(&std::io::Error::other("other")));
    }

    #[test]
    fn bodyless_static_answers_carry_no_content_length() {
        let head = empty_static_response(StatusCode::OK, "text/javascript; charset=utf-8", None);
        assert_eq!(head.status(), StatusCode::OK);
        assert!(
            head.headers().get("content-length").is_none(),
            "a HEAD answer reports no length, matching `new Response(null, …)`"
        );
        assert_eq!(
            head.headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some("text/javascript; charset=utf-8")
        );

        let not_found = empty_response(StatusCode::NOT_FOUND);
        assert_eq!(not_found.status(), StatusCode::NOT_FOUND);
        assert!(
            not_found.headers().get("content-type").is_none(),
            "`new Response(null, {{ status: 404 }})` sets no content-type"
        );
        assert!(not_found.headers().get("content-length").is_none());
    }

    #[test]
    fn static_answers_report_the_injected_length() {
        let with_injection = empty_static_response(
            StatusCode::OK,
            "text/html; charset=utf-8",
            Some(b"0123456789"),
        );
        assert_eq!(
            with_injection
                .headers()
                .get("content-length")
                .and_then(|v| v.to_str().ok()),
            Some("10"),
            "content-length describes the served bytes, not the on-disk file"
        );
    }
}
