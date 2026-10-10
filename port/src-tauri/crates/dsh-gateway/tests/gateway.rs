//! Gateway integration tests: the BrowserAuth flow against real HTTP
//! (valid token mints the signed cookie; wrong/duplicate/missing token gets the
//! minimal 401), authenticated reverse proxying with the Host cookie, `/plugins/`
//! `no-store`, and the WebSocket frame relay in both directions (text + binary).

use std::net::SocketAddr;
use std::path::PathBuf;

use dsh_gateway::{auth, start, GatewayConfig};
use futures_util::{SinkExt, StreamExt};

/// Fake Host: launch-token → cookie exchange at `/`, an echo route, a plugin
/// bundle route, and a WebSocket echo at `/api/remote.mux`.
async fn fake_host() -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind");
    let addr = listener.local_addr().expect("addr");
    let expected_origin = format!("http://{addr}");
    let app = axum::Router::new()
        .route(
            "/",
            axum::routing::get(|uri: axum::http::Uri| async move {
                if uri.query() != Some("token=fixture-only") {
                    return axum::response::Response::builder()
                        .status(401)
                        .body(axum::body::Body::empty())
                        .unwrap();
                }
                axum::response::Response::builder()
                    .status(303)
                    .header("set-cookie", "host-auth=fake-host-cookie; Path=/; HttpOnly")
                    .body(axum::body::Body::empty())
                    .unwrap()
            }),
        )
        .route(
            "/api/echo",
            axum::routing::get(|headers: axum::http::HeaderMap| async move {
                let mut rows = Vec::new();
                for (name, value) in headers.iter() {
                    rows.push(format!(
                        "{}={}",
                        name.as_str(),
                        value.to_str().unwrap_or("<binary>")
                    ));
                }
                rows.sort();
                rows.join("\n")
            }),
        )
        .route(
            "/api/write",
            axum::routing::any(
                |method: axum::http::Method, body: axum::body::Bytes| async move {
                    format!(
                        "{method} /api/write body={}",
                        String::from_utf8_lossy(&body)
                    )
                },
            ),
        )
        .route(
            "/client-modules/client.js",
            axum::routing::get(|| async {
                axum::response::Response::builder()
                    .header("content-type", "text/javascript; charset=utf-8")
                    .body(axum::body::Body::from(
                        "globalThis.__clientModulesLoaded = true;",
                    ))
                    .unwrap()
            }),
        )
        .route(
            "/plugins/example.js",
            axum::routing::get(|| async {
                axum::response::Response::builder()
                    .header("cache-control", "public, max-age=31536000, immutable")
                    .header("content-type", "text/javascript")
                    .header("connection", "keep-alive")
                    .header("keep-alive", "timeout=5")
                    .header("set-cookie", "host-only=must-not-escape")
                    .body(axum::body::Body::from("export const revision = 1;\n"))
                    .unwrap()
            }),
        )
        .route(
            "/api/server-close",
            axum::routing::get(|ws: axum::extract::WebSocketUpgrade| async move {
                ws.on_upgrade(|mut socket| async move {
                    let _ = socket.close().await;
                })
            }),
        )
        .route(
            "/api/remote.mux",
            axum::routing::get(
                move |ws: axum::extract::WebSocketUpgrade, headers: axum::http::HeaderMap| {
                    let expected_origin = expected_origin.clone();
                    async move {
                        // Reject anything except the precise exchange cookie and Host origin.
                        if headers.get("cookie").and_then(|v| v.to_str().ok())
                            != Some("host-auth=fake-host-cookie")
                            || headers.get("origin").and_then(|v| v.to_str().ok())
                                != Some(expected_origin.as_str())
                        {
                            return axum::response::Response::builder()
                                .status(403)
                                .body(axum::body::Body::empty())
                                .unwrap();
                        }
                        ws.on_upgrade(|mut socket| async move {
                            while let Some(Ok(message)) = socket.next().await {
                                let echo = match message {
                                    axum::extract::ws::Message::Text(text) => {
                                        axum::extract::ws::Message::Text(text)
                                    }
                                    axum::extract::ws::Message::Binary(bytes) => {
                                        axum::extract::ws::Message::Binary(bytes)
                                    }
                                    _ => continue,
                                };
                                if socket.send(echo).await.is_err() {
                                    break;
                                }
                            }
                        })
                    }
                },
            ),
        );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    addr
}

fn static_dir() -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    std::fs::write(
        root.join("index.html"),
        "<html><head><title>shell</title></head><body>dsh</body></html>",
    )
    .expect("index");
    std::fs::create_dir_all(root.join("assets")).expect("assets dir");
    std::fs::write(root.join("assets").join("app.js"), "console.log(1);").expect("asset");
    (dir, root)
}

async fn gateway() -> (
    tempfile::TempDir,
    dsh_gateway::GatewayHandle,
    reqwest::Client,
) {
    let (_dir, root) = static_dir();
    let dir = _dir;
    let handle = start(GatewayConfig::loopback(root), vec![9u8; 32])
        .await
        .expect("gateway");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    (dir, handle, client)
}

async fn mint_cookie(handle: &dsh_gateway::GatewayHandle, client: &reqwest::Client) -> String {
    let url = handle.authenticated_url();
    let response = client.get(&url).send().await.expect("mint");
    assert_eq!(
        response.status().as_u16(),
        303,
        "a valid token mints with a 303"
    );
    assert_eq!(
        response
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok()),
        Some("./"),
        "the redirect is directory-relative"
    );
    response
        .headers()
        .get("set-cookie")
        .and_then(|v| v.to_str().ok())
        .expect("set-cookie")
        .split(';')
        .next()
        .expect("pair")
        .to_string()
}

#[tokio::test]
async fn valid_token_mints_cookie_and_bad_tokens_get_the_minimal_401() {
    let (_dir, handle, client) = gateway().await;
    let origin = handle.origin().to_string();
    let unauth_body = auth::UNAUTHORIZED_BODY;

    // Missing token: the minimal 401.
    let response = client
        .get(format!("{origin}/"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);
    assert_eq!(response.text().await.expect("body"), unauth_body);

    // Wrong token.
    let response = client
        .get(format!("{origin}/?token=wrong"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);

    // Duplicate tokens (exactly one is required).
    let token = handle
        .authenticated_url()
        .split("token=")
        .nth(1)
        .expect("token")
        .to_string();
    let response = client
        .get(format!("{origin}/?token={token}&token={token}"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);

    // The valid token mints the signed cookie and redirects to `./`.
    let cookie = mint_cookie(&handle, &client).await;
    assert!(cookie.starts_with("dsh-auth-"));

    // The cookie serves the shell, with the boot gate injected into <head>.
    let response = client
        .get(format!("{origin}/"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    let body = response.text().await.expect("body");
    assert!(
        body.contains("globalThis.__DSH_BOOT_READY__"),
        "index.html must carry the boot gate: {body}"
    );

    // A bare cookie segment in front of the session cookie must not hide it
    // (the reference's parser continues past a segment with no `=`).
    let response = client
        .get(format!("{origin}/"))
        .header("cookie", format!("consent; {cookie}"))
        .send()
        .await
        .expect("request");
    assert_eq!(
        response.status().as_u16(),
        200,
        "a bare segment must not mask the session cookie"
    );

    // A duplicate of the generated name in front of the real pair is the
    // segment that gets verified, so the request is not authenticated.
    let name = cookie.split('=').next().expect("cookie name");
    let response = client
        .get(format!("{origin}/"))
        .header("cookie", format!("{name}=v1.AA.BB; {cookie}"))
        .send()
        .await
        .expect("request");
    assert_eq!(
        response.status().as_u16(),
        401,
        "the first exact-name cookie segment is the one verified"
    );

    // Authentication cannot expose a traversal target. The reference static
    // handler refuses paths outside the packaged root with 403.
    let host_addr = fake_host().await;
    handle
        .set_host(&format!("http://{host_addr}/?token=fixture-only"))
        .await
        .expect("host bind");

    // Static assets serve with the upstream MIME map and path containment.
    let response = client
        .get(format!("{origin}/assets/app.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/javascript; charset=utf-8")
    );
    let escaped = client
        .get(format!("{origin}/assets/..%5c..%5csettings.json"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(
        escaped.status().as_u16(),
        403,
        "a shell-owned path traversal is refused before either shell serving or Host forwarding"
    );
    // A root-level traversal is not shell-owned: it proxies, and the Host's own
    // answer (404 from the fixture) is what reaches the renderer, never the
    // gateway's 403.
    let proxied_traversal = client
        .get(format!("{origin}/..%5c..%5csettings.json"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(proxied_traversal.status().as_u16(), 404);
    assert!(
        proxied_traversal.bytes().await.expect("body").is_empty(),
        "the Host answered, not the packaged shell"
    );

    // Unauthenticated non-index requests are refused too.
    let response = client
        .get(format!("{origin}/assets/app.js"))
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 401);
}

#[tokio::test]
async fn shell_routes_answer_405_for_writes_and_404_for_missing_files() {
    let (_dir, handle, client) = gateway().await;
    let host_addr = fake_host().await;
    handle
        .set_host(&format!("http://{host_addr}/?token=fixture-only"))
        .await
        .expect("host bind");
    let cookie = mint_cookie(&handle, &client).await;
    let origin = handle.origin().to_string();

    // Shell-owned pathnames are GET/HEAD only: every other method is a bodyless
    // local 405 and never reaches the Host (`web-document.ts:19`).
    for path in [
        "/",
        "/index.html",
        "/assets/app.js",
        "/favicon.svg",
        "/manifest.webmanifest",
        "/favicon-dark.svg",
        "/mandatory-policy.html",
        "/desktop-policy-bootstrap.json",
    ] {
        let response = client
            .post(format!("{origin}{path}"))
            .header("cookie", &cookie)
            .body("payload")
            .send()
            .await
            .expect("request");
        assert_eq!(response.status().as_u16(), 405, "POST {path}");
        assert!(
            response.headers().get("content-type").is_none(),
            "POST {path} is bodyless"
        );
        assert!(response.bytes().await.expect("body").is_empty());
    }

    // A missing shell file is the reference's own 404, never a Host fallback.
    let missing = client
        .get(format!("{origin}/desktop-policy-bootstrap.json"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(missing.status().as_u16(), 404);
    assert!(missing.bytes().await.expect("body").is_empty());

    // Host writes are unaffected: a proxied write keeps its method and body.
    let written = client
        .post(format!("{origin}/api/write"))
        .header("cookie", &cookie)
        .body("payload")
        .send()
        .await
        .expect("request");
    assert_eq!(written.status().as_u16(), 200);
    assert_eq!(
        written.text().await.expect("body"),
        "POST /api/write body=payload"
    );

    // A session refutation precedes the route table: an unauthenticated write on
    // a shell path is still the minimal 401, not a 405.
    let anonymous = client
        .post(format!("{origin}/assets/app.js"))
        .body("payload")
        .send()
        .await
        .expect("request");
    assert_eq!(anonymous.status().as_u16(), 401);
    assert_eq!(
        anonymous.text().await.expect("body"),
        auth::UNAUTHORIZED_BODY
    );
}

#[tokio::test]
async fn shell_document_policy_is_served_by_default_and_attached_to_the_document_only() {
    // The shipped configuration serves the policy on the document.
    let (_dir, handle, client) = gateway().await;
    let cookie = mint_cookie(&handle, &client).await;
    let origin = handle.origin().to_string();
    for (method, path) in [
        (reqwest::Method::GET, "/"),
        (reqwest::Method::HEAD, "/index.html"),
    ] {
        let response = client
            .request(method.clone(), format!("{origin}{path}"))
            .header("cookie", &cookie)
            .send()
            .await
            .expect("request");
        assert_eq!(response.status().as_u16(), 200, "{method} {path}");
        let policy = response
            .headers()
            .get("content-security-policy")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_else(|| panic!("{method} {path} must serve the shell document policy"));
        for expected in [
            "default-src 'self' data: blob:;",
            "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:;",
            "style-src 'self' 'unsafe-inline' blob:;",
            "img-src 'self' data: blob:;",
            "font-src 'self' data:;",
            "media-src 'self' data: blob:;",
            "connect-src 'self' ipc: http://ipc.localhost;",
            "frame-src 'self' blob: data: about:;",
            "worker-src 'self' blob:;",
            "manifest-src 'self';",
            "base-uri 'none';",
            "object-src 'none';",
            "form-action 'none';",
            "frame-ancestors 'none'",
        ] {
            assert!(
                policy.contains(expected),
                "{path} is missing {expected:?}: {policy}"
            );
        }
        // A nonce or hash source would make `'unsafe-inline'` ignored and the
        // preserved client's runtime inline script rows (the boot gate, the
        // `client-modules` queue row, the theme boot row) would not execute.
        assert!(
            !policy.contains("nonce-")
                && !policy.contains("sha256-")
                && !policy.contains("sha384-"),
            "{path} must not carry a nonce/hash source: {policy}"
        );
    }
    // The policy describes a document, so assets carry none of it, and the boot
    // gate the served index carries is still injected under it (it is inline and
    // allowed by `'unsafe-inline'`).
    let asset = client
        .get(format!("{origin}/assets/app.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert!(asset.headers().get("content-security-policy").is_none());
    let document = client
        .get(format!("{origin}/"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert!(document
        .text()
        .await
        .expect("body")
        .contains("globalThis.__DSH_BOOT_READY__"));

    // An explicit opt-out is the only way to serve a policy-free document.
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    std::fs::write(
        root.join("index.html"),
        "<html><head></head><body>dsh</body></html>",
    )
    .expect("index");
    let detached = start(
        GatewayConfig::loopback(root).without_shell_content_security_policy(),
        vec![13u8; 32],
    )
    .await
    .expect("gateway");
    let detached_cookie = mint_cookie(&detached, &client).await;
    let response = client
        .get(format!("{}/", detached.origin()))
        .header("cookie", &detached_cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    assert!(
        response.headers().get("content-security-policy").is_none(),
        "the explicit opt-out serves no document policy"
    );
}

#[tokio::test]
async fn proxy_forwards_host_cookie_strips_hop_headers_and_no_stores_plugin_bundles() {
    let (_dir, handle, client) = gateway().await;
    let host_addr = fake_host().await;
    handle
        .set_host(&format!("http://{host_addr}/?token=fixture-only"))
        .await
        .expect("host bind");
    let cookie = mint_cookie(&handle, &client).await;
    let origin = handle.origin().to_string();

    // Forwarded request carries the Host cookie, not the gateway's.
    let response = client
        .get(format!("{origin}/api/echo"))
        .header("cookie", &cookie)
        .header("origin", &origin)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    let echoed = response.text().await.expect("body");
    assert!(
        echoed.contains("cookie=host-auth=fake-host-cookie"),
        "the Host session cookie must be forwarded: {echoed}"
    );
    assert!(
        !echoed.contains("sec-fetch-site"),
        "sec-fetch-site is stripped before forwarding"
    );
    assert!(
        !echoed.contains(&format!("origin={origin}")),
        "the inbound origin is stripped before forwarding"
    );

    // Plugin bundles lose their per-launch immutable cache headers.
    let response = client
        .get(format!("{origin}/plugins/example.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response
            .headers()
            .get("cache-control")
            .and_then(|v| v.to_str().ok()),
        Some("no-store"),
        "plugin bundles are no-store"
    );

    // Connection-level response headers never reach the renderer.
    // Hyper generates its own chunked framing for the streamed response, so
    // transfer-encoding is checked against the proxy's filtering policy below.
    for withheld in ["connection", "keep-alive", "set-cookie"] {
        assert!(
            response.headers().get(withheld).is_none(),
            "{withheld} must be dropped"
        );
    }

    // A foreign origin is refused (upstream `forwardWebRequest`).
    let response = client
        .get(format!("{origin}/api/echo"))
        .header("cookie", &cookie)
        .header("origin", "http://evil.example")
        .send()
        .await
        .expect("request");
    assert_eq!(response.status().as_u16(), 403);
}

#[tokio::test]
async fn proxied_bootstrap_waits_for_host_and_returns_javascript() {
    let (_dir, handle, client) = gateway().await;
    let host_addr = fake_host().await;
    let cookie = mint_cookie(&handle, &client).await;
    let url = format!("{}/client-modules/client.js", handle.origin());
    let request = client.get(url).header("cookie", cookie);
    let pending = tokio::spawn(async move { request.send().await });

    // The document can request its bootstrap module before Host authentication
    // finishes. It must wait, then proxy JavaScript rather than a local 503.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    handle
        .set_host(&format!("http://{host_addr}/?token=fixture-only"))
        .await
        .expect("host bind");
    let response = tokio::time::timeout(std::time::Duration::from_secs(3), pending)
        .await
        .expect("pending bootstrap request should resume when Host is bound")
        .expect("request task")
        .expect("bootstrap request");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok()),
        Some("text/javascript; charset=utf-8")
    );
    assert_eq!(
        response.text().await.expect("JavaScript body"),
        "globalThis.__clientModulesLoaded = true;"
    );
}

#[tokio::test]
async fn websocket_rejects_foreign_origin_before_host_cookie_forwarding() {
    let (_dir, handle, client) = gateway().await;
    let host_addr = fake_host().await;
    handle
        .set_host(&format!("http://{host_addr}/?token=fixture-only"))
        .await
        .expect("host bind");
    let cookie = mint_cookie(&handle, &client).await;
    let port = handle.local_addr().port();

    let mut request =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://127.0.0.1:{port}/api/remote.mux"
        ))
        .expect("request");
    request
        .headers_mut()
        .insert("cookie", cookie.parse().expect("cookie header"));
    request.headers_mut().insert(
        "origin",
        "http://127.0.0.1:9999"
            .parse()
            .expect("foreign origin header"),
    );

    let refused = tokio_tungstenite::connect_async(request)
        .await
        .expect_err("foreign-origin upgrade must be refused");
    match refused {
        tokio_tungstenite::tungstenite::Error::Http(response) => {
            eprintln!("foreign-origin response status: {}", response.status());
            assert_eq!(response.status().as_u16(), 403);
        }
        other => panic!("expected HTTP refusal, got {other:?}"),
    }
}

#[tokio::test]
async fn websocket_frames_relay_both_directions() {
    let (_dir, handle, client) = gateway().await;
    let host_addr = fake_host().await;
    let cookie = mint_cookie(&handle, &client).await;
    let port = handle.local_addr().port();
    let origin = handle.origin().to_string();

    let request = tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(
        format!("ws://127.0.0.1:{port}/api/remote.mux"),
    )
    .expect("request");
    let mut request = request;
    request
        .headers_mut()
        .insert("cookie", cookie.parse().expect("cookie header"));
    request
        .headers_mut()
        .insert("origin", origin.parse().expect("gateway origin header"));
    let connecting = tokio::spawn(async move { tokio_tungstenite::connect_async(request).await });
    // Model the window's earliest request racing the Host's authenticated
    // token→cookie exchange. The authenticated handshake must remain pending.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    handle
        .set_host(&format!("http://{host_addr}/?token=fixture-only"))
        .await
        .expect("host bind");
    let (mut stream, response) =
        tokio::time::timeout(std::time::Duration::from_secs(3), connecting)
            .await
            .expect("pending WebSocket should resume when Host is bound")
            .expect("connect task")
            .expect("ws connect");
    eprintln!("gateway-origin response status: {}", response.status());
    assert_eq!(response.status().as_u16(), 101, "gateway origin upgrades");

    // Text frames relay verbatim.
    stream
        .send(tokio_tungstenite::tungstenite::Message::Text(
            "{\"type\":\"open\",\"streamId\":\"s-1\"}".into(),
        ))
        .await
        .expect("send text");
    let echoed = stream.next().await.expect("frame").expect("frame");
    assert_eq!(
        echoed,
        tokio_tungstenite::tungstenite::Message::Text(
            "{\"type\":\"open\",\"streamId\":\"s-1\"}".into()
        )
    );

    // Binary frames relay verbatim too.
    let payload = bytes::Bytes::from_static(b"\x00\x01\x02binary");
    stream
        .send(tokio_tungstenite::tungstenite::Message::Binary(
            payload.clone(),
        ))
        .await
        .expect("send binary");
    let echoed = stream.next().await.expect("frame").expect("frame");
    assert_eq!(
        echoed,
        tokio_tungstenite::tungstenite::Message::Binary(payload)
    );

    // A client-initiated close ends its relay without waiting for the Host.
    stream
        .send(tokio_tungstenite::tungstenite::Message::Close(None))
        .await
        .expect("send close");
    let close = tokio::time::timeout(std::time::Duration::from_secs(2), stream.next())
        .await
        .expect("client-close relay timeout");
    assert!(
        close.is_none()
            || matches!(
                close,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            ),
        "client close must terminate cleanly: {close:?}"
    );

    // The Host can also close first; the gateway relays that close to the client.
    let mut host_close =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://127.0.0.1:{port}/api/server-close"
        ))
        .expect("close request");
    host_close
        .headers_mut()
        .insert("cookie", cookie.parse().expect("cookie header"));
    let (mut close_stream, _) = tokio_tungstenite::connect_async(host_close)
        .await
        .expect("close connect");
    let close = tokio::time::timeout(std::time::Duration::from_secs(2), close_stream.next())
        .await
        .expect("host-close relay timeout");
    assert!(
        close.is_none()
            || matches!(
                close,
                Some(Ok(tokio_tungstenite::tungstenite::Message::Close(_)))
            ),
        "Host close must terminate cleanly: {close:?}"
    );

    // An unauthenticated upgrade is refused before any frame flows.
    let mut anonymous =
        tokio_tungstenite::tungstenite::client::IntoClientRequest::into_client_request(format!(
            "ws://127.0.0.1:{port}/api/remote.mux"
        ))
        .expect("request");
    anonymous
        .headers_mut()
        .insert("cookie", "dsh-auth-x=invalid".parse().expect("header"));
    let refused = tokio_tungstenite::connect_async(anonymous).await;
    assert!(refused.is_err(), "anonymous upgrades must be refused");
}
