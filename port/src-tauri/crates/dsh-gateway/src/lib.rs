//! `dsh-gateway` — the authenticated loopback HTTP + WebSocket application
//! gateway the Tauri window navigates to (replaces Electron's `dsh-app://app/`
//! document serving and request forwarding; `ui-backend-protocol.md` §7.3
//! "shell-owned path").
//!
//! Contracts:
//! - Serves the packaged web-client shell at `/` (GET/HEAD only, path
//!   containment, upstream MIME map, `__DSH_BOOT_READY__` injected into
//!   `index.html`'s `<head>`).
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
fn content_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
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

/// Boot-readiness deferred injected into the literal `<head>` of `index.html`
/// (`web-document.ts:10`).
const BOOT_SCRIPT: &str =
    "<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>";

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
}

impl GatewayConfig {
    /// Shell-serving configuration bound to loopback.
    pub fn loopback(static_dir: impl Into<PathBuf>) -> Self {
        Self {
            static_dir: static_dir.into(),
            port: 0,
            lan: false,
            cookie_max_age_days: 30,
        }
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
    static_dir: PathBuf,
    auth: BrowserAuth,
    /// Gateway's own `http(s)://authority` origin.
    origin: String,
    /// Latest authenticated Host, observable by requests that arrive while the
    /// startup token exchange is still in flight.
    host: tokio::sync::watch::Sender<Option<HostTarget>>,
    client: reqwest::Client,
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
        static_dir: config.static_dir,
        auth,
        origin,
        host,
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

    // Static shell first (GET/HEAD), then reverse-proxy everything else.
    if method == Method::GET || method == Method::HEAD {
        if let Some(response) = serve_static(&state.static_dir, &method_str, &path).await {
            return response;
        }
    } else if is_static_path(&state.static_dir, &path) {
        // The static root answers 405 for its own paths on other methods
        // (upstream `serveWebDocument`).
        return Response::builder()
            .status(StatusCode::METHOD_NOT_ALLOWED)
            .body(Body::empty())
            .expect("response");
    }
    proxy_http(state, method, &uri, &parts.headers, body).await
}

/// Percent-decoded static resolution with path containment
/// (`web-document.ts:22-25`): `None` for paths outside the root.
fn resolve_static(root: &Path, request_path: &str) -> Option<PathBuf> {
    let decoded = percent_decode(request_path)?;
    let target = if decoded == "/" {
        root.join("index.html")
    } else {
        root.join(decoded.trim_start_matches('/'))
    };
    let canonical_root = root.canonicalize().ok()?;
    let canonical_target = target.canonicalize().ok()?;
    if canonical_target.starts_with(&canonical_root) && canonical_target.is_file() {
        Some(canonical_target)
    } else {
        None
    }
}

fn is_static_path(root: &Path, request_path: &str) -> bool {
    let decoded = percent_decode(request_path).unwrap_or_default();
    let candidate = root.join(decoded.trim_start_matches('/'));
    candidate.exists()
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

async fn serve_static(root: &Path, method: &str, path: &str) -> Option<Response> {
    let target = resolve_static(root, path)?;
    let content = std::fs::read(&target).ok()?;
    let is_index = path == "/" || path == "/index.html";
    let payload: Vec<u8> = if is_index {
        // The desktop boot gate goes into the literal `<head>`.
        let text = String::from_utf8_lossy(&content).to_string();
        match text.find("<head>") {
            Some(at) => {
                let mut out = String::with_capacity(text.len() + BOOT_SCRIPT.len());
                out.push_str(&text[..at + "<head>".len()]);
                out.push_str(BOOT_SCRIPT);
                out.push_str(&text[at + "<head>".len()..]);
                out.into_bytes()
            }
            None => {
                let mut out = String::from(BOOT_SCRIPT);
                out.push_str(&text);
                out.into_bytes()
            }
        }
    } else {
        content
    };
    let body = if method == "HEAD" {
        Body::empty()
    } else {
        Body::from(payload)
    };
    Some(
        Response::builder()
            .status(StatusCode::OK)
            .header("content-type", content_type_for(&target))
            .body(body)
            .expect("response"),
    )
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
    let mut request = state
        .client
        .request(
            reqwest::Method::from_bytes(method.as_str().as_bytes()).unwrap_or(reqwest::Method::GET),
            &target,
        )
        .body(reqwest::Body::wrap_stream(body_frames(body)));
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
    upgrade.on_upgrade(move |client| relay_frames(client, upstream))
}

async fn relay_frames(
    client: axum::extract::ws::WebSocket,
    upstream: tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) {
    let (mut client_sink, mut client_stream) = client.split();
    let (mut upstream_sink, mut upstream_stream) = upstream.split();
    let to_host = async {
        while let Some(Ok(message)) = client_stream.next().await {
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
            if upstream_sink.send(frame).await.is_err() {
                break;
            }
        }
    };
    let to_client = async {
        while let Some(Ok(message)) = upstream_stream.next().await {
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
            if client_sink.send(frame).await.is_err() {
                break;
            }
        }
    };
    tokio::select! {
        () = to_host => {},
        () = to_client => {},
    }
}

#[cfg(test)]
mod tests {
    use super::withhold_response_header;

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
}
