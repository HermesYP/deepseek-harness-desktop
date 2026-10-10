//! Reconstructed regression coverage after an agent overwrote uncommitted tests.
//! The tracked gateway suite remains intact; these are equivalent behavioral
//! checks, not a claim that the lost source was recovered byte-for-byte.
use dsh_gateway::{start, GatewayConfig, GatewayHandle};
use std::path::PathBuf;

struct Fixture {
    _root: tempfile::TempDir,
    root: PathBuf,
    gateway: GatewayHandle,
    client: reqwest::Client,
    cookie: String,
    host: tokio::task::JoinHandle<()>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.host.abort();
    }
}
impl Fixture {
    async fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_path_buf();
        std::fs::write(
            root.join("index.html"),
            "<html><head></head><body>shell fixture</body></html>",
        )
        .unwrap();
        std::fs::create_dir(root.join("assets")).unwrap();
        std::fs::write(root.join("assets/app.js"), "globalThis.fixture = 1;").unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let app = axum::Router::new().fallback(axum::routing::any(
            |method: axum::http::Method, uri: axum::http::Uri, body: axum::body::Bytes| async move {
                if method == axum::http::Method::GET
                    && uri.path() == "/"
                    && uri.query() == Some("token=static-fixture")
                {
                    return axum::response::Response::builder()
                        .status(303)
                        .header("set-cookie", "dsh=static-fixture; Path=/; HttpOnly")
                        .header("location", "/")
                        .body(axum::body::Body::empty())
                        .unwrap();
                }
                axum::response::Response::builder()
                    .status(200)
                    .header("x-fixture-host", "unchanged")
                    .body(axum::body::Body::from(format!(
                        "{method} {uri} body={}",
                        String::from_utf8_lossy(&body)
                    )))
                    .unwrap()
            },
        ));
        let host = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let gateway = start(GatewayConfig::loopback(root.clone()), vec![71; 32])
            .await
            .unwrap();
        gateway
            .set_host(&format!("http://{address}/?token=static-fixture"))
            .await
            .unwrap();
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let minted = client
            .get(gateway.authenticated_url())
            .send()
            .await
            .unwrap();
        assert_eq!(minted.status().as_u16(), 303);
        let cookie = minted.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .split(';')
            .next()
            .unwrap()
            .to_owned();
        Self {
            _root: dir,
            root,
            gateway,
            client,
            cookie,
            host,
        }
    }
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.client
            .request(method, format!("{}{path}", self.gateway.origin()))
            .header("cookie", &self.cookie)
    }
}

#[tokio::test]
async fn proxied_get_forwards_without_a_request_body() {
    let fixture = Fixture::new().await;
    let response = fixture
        .request(reqwest::Method::GET, "/api/echo?preserved=yes")
        .send()
        .await
        .unwrap();
    assert_eq!(response.headers()["x-fixture-host"], "unchanged");
    assert_eq!(
        response.text().await.unwrap(),
        "GET /api/echo?preserved=yes body="
    );
}

#[tokio::test]
async fn static_root_is_not_cached_and_plugin_bundles_stay_no_store() {
    let fixture = Fixture::new().await;
    let first = fixture
        .request(reqwest::Method::GET, "/")
        .send()
        .await
        .unwrap();
    assert!(first.headers().get("cache-control").is_none());
    assert!(first.text().await.unwrap().contains("shell fixture"));
    std::fs::write(
        fixture.root.join("index.html"),
        "<head></head>changed fixture",
    )
    .unwrap();
    let second = fixture
        .request(reqwest::Method::GET, "/")
        .send()
        .await
        .unwrap();
    assert!(second.text().await.unwrap().contains("changed fixture"));
    let plugin = fixture
        .request(reqwest::Method::GET, "/plugins/fixture/main.js")
        .send()
        .await
        .unwrap();
    assert_eq!(plugin.headers()["cache-control"], "no-store");
}

#[tokio::test]
async fn static_assets_serve_with_reference_metadata_and_boot_injection() {
    let fixture = Fixture::new().await;
    let response = fixture
        .request(reqwest::Method::GET, "/assets/app.js")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert_eq!(response.headers()["content-length"], "23");
    for header in [
        "cache-control",
        "etag",
        "last-modified",
        "expires",
        "content-encoding",
    ] {
        assert!(
            response.headers().get(header).is_none(),
            "unexpected {header}"
        );
    }
    assert_eq!(response.text().await.unwrap(), "globalThis.fixture = 1;");
    let html = fixture
        .request(reqwest::Method::GET, "/")
        .send()
        .await
        .unwrap()
        .text()
        .await
        .unwrap();
    assert_eq!(html.matches("__DSH_BOOT_READY__").count(), 1);
    assert!(html.contains("Promise.withResolvers()"));
}

#[tokio::test]
async fn shell_routes_refuse_non_get_head_methods_while_host_writes_proxy() {
    let fixture = Fixture::new().await;
    // A shell-owned pathname answers 405 for every method but GET/HEAD, before
    // the path is decoded or the Host is consulted (`web-document.ts:19`).
    for method in [
        reqwest::Method::POST,
        reqwest::Method::PUT,
        reqwest::Method::PATCH,
        reqwest::Method::DELETE,
    ] {
        let response = fixture
            .request(method.clone(), "/assets/app.js")
            .body("payload")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 405, "{method} on a shell asset");
        assert!(
            response.headers().get("x-fixture-host").is_none(),
            "{method} on a shell asset must not reach the Host"
        );
        assert!(response.bytes().await.unwrap().is_empty());
    }
    // A pathname the shell does not own keeps its method and body: writes still
    // proxy to the Host unchanged.
    for method in [reqwest::Method::POST, reqwest::Method::PUT] {
        let expected = format!("{method} /api/write body=payload");
        let response = fixture
            .request(method.clone(), "/api/write")
            .body("payload")
            .send()
            .await
            .unwrap();
        assert_eq!(
            response.headers()["x-fixture-host"],
            "unchanged",
            "{method}"
        );
        assert_eq!(response.text().await.unwrap(), expected);
    }
}

#[tokio::test]
async fn missing_shell_paths_are_404_and_shell_escapes_are_403() {
    let fixture = Fixture::new().await;
    // A missing shell-owned file is the reference's `ENOENT` branch: a 404 that
    // never falls through to the Host.
    for path in ["/assets/missing.js", "/assets/nested/missing.js"] {
        let response = fixture
            .request(reqwest::Method::GET, path)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 404, "{path}");
        assert!(
            response.headers().get("x-fixture-host").is_none(),
            "{path} must not reach the Host"
        );
    }
    // A shell-owned path that escapes the packaged root is a 403 refusal.
    for path in [
        "/assets/%2e%2e%2f%2e%2e%2foutside.js",
        "/assets/..%5c..%5coutside.js",
    ] {
        let escaped = fixture
            .request(reqwest::Method::GET, path)
            .send()
            .await
            .unwrap();
        assert_eq!(escaped.status().as_u16(), 403, "{path}");
        assert!(escaped.headers().get("x-fixture-host").is_none(), "{path}");
        assert!(escaped.bytes().await.unwrap().is_empty());
    }
    // A malformed percent-escape is the reference's `decodeURIComponent` throw:
    // 400, decided before containment.
    let malformed = fixture
        .request(reqwest::Method::GET, "/assets/%zz")
        .send()
        .await
        .unwrap();
    assert_eq!(malformed.status().as_u16(), 400);
    assert!(malformed.headers().get("x-fixture-host").is_none());

    // A root-level traversal is not shell-owned at all, so it proxies to the
    // Host — which has no access to the packaged root — and no shell bytes are
    // served. The same holds for the normalized form a real HTTP client sends:
    // it removes the `..` segment, so `/assets/../absent.js` arrives as
    // `/absent.js` and leaves the allowlist. (The literal form is pinned by
    // `static_io.rs` over a raw socket: interior traversal under `/assets/`
    // stays a contained shell miss.)
    for path in ["/..%2f..%2foutside.js", "/assets/../absent.js"] {
        let proxied = fixture
            .request(reqwest::Method::GET, path)
            .send()
            .await
            .unwrap();
        assert_eq!(proxied.status().as_u16(), 200, "{path}");
        assert_eq!(proxied.headers()["x-fixture-host"], "unchanged", "{path}");
        let body = proxied.text().await.unwrap();
        assert!(
            !body.contains("fixture = 1"),
            "a proxied path must not be answered from the shell root: {body}"
        );
    }
}

#[tokio::test]
async fn every_shell_owned_route_is_served_locally_and_never_proxied() {
    let fixture = Fixture::new().await;
    std::fs::write(
        fixture.root.join("favicon.svg"),
        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
    )
    .unwrap();
    std::fs::write(fixture.root.join("favicon-dark.svg"), "<svg/>").unwrap();
    std::fs::write(
        fixture.root.join("manifest.webmanifest"),
        "{\"name\":\"fixture\"}",
    )
    .unwrap();
    std::fs::write(fixture.root.join("mandatory-policy.html"), "<head></head>").unwrap();
    std::fs::write(
        fixture.root.join("desktop-policy-bootstrap.json"),
        "{\"schemaVersion\":1}",
    )
    .unwrap();
    for path in [
        "/",
        "/index.html",
        "/assets/app.js",
        "/favicon.svg",
        "/favicon-dark.svg",
        "/manifest.webmanifest",
        "/mandatory-policy.html",
        "/desktop-policy-bootstrap.json",
    ] {
        let response = fixture
            .request(reqwest::Method::GET, path)
            .send()
            .await
            .unwrap();
        assert_eq!(response.status().as_u16(), 200, "{path}");
        assert!(
            response.headers().get("x-fixture-host").is_none(),
            "{path} is shell-owned and must not reach the Host"
        );
    }
}

#[tokio::test]
async fn head_answers_metadata_without_opening_the_asset() {
    let fixture = Fixture::new().await;
    // A directory advertises static metadata but cannot be read as an asset.
    // HEAD must succeed without opening/reading its contents, unlike GET.
    std::fs::create_dir(fixture.root.join("assets/folder.js")).unwrap();
    let response = fixture
        .request(reqwest::Method::HEAD, "/assets/folder.js")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status().as_u16(), 200);
    assert!(response.headers()["content-type"]
        .to_str()
        .unwrap()
        .contains("javascript"));
    assert!(response.bytes().await.unwrap().is_empty());
    let get = fixture
        .request(reqwest::Method::GET, "/assets/folder.js")
        .send()
        .await
        .unwrap();
    assert_eq!(
        get.status().as_u16(),
        500,
        "GET really attempts the directory read"
    );
}
