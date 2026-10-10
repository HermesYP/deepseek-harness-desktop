//! Focused regression tests for the static handler's metadata contract.
//!
//! These cover the properties that the `HEAD` and content-metadata paths
//! previously got wrong. They are deliberately separate from `gateway.rs` so the
//! behavioural proxy/auth suite stays readable.
//!
//! On what is *not* tested here: no test in this file claims to prove that the
//! file read is asynchronous. A timing guard cannot show that — the OS page cache
//! makes a blocking read of a resident file fast enough to pass any latency bound,
//! which was verified by running such a guard against a deliberately reintroduced
//! `std::fs::read` and watching it pass. The asynchronous read is therefore
//! covered by construction (the call is `tokio::fs::read` and the whole handler is
//! `async`, with no `std::fs` read of a served asset anywhere in the crate), and a
//! reviewer should check that directly rather than trust a flaky assertion.

use std::path::PathBuf;

use dsh_gateway::{start, GatewayConfig};

/// A static root with an index carrying the boot-gate target and one binary
/// asset, so metadata assertions have a non-text extension to exercise.
fn static_dir(asset_bytes: usize) -> (tempfile::TempDir, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    std::fs::write(
        root.join("index.html"),
        "<html><head><title>shell</title></head><body>dsh</body></html>",
    )
    .expect("index");
    std::fs::create_dir_all(root.join("assets")).expect("assets");
    let mut body = Vec::with_capacity(asset_bytes);
    let mut state: u32 = 0x9e37_79b9;
    while body.len() < asset_bytes {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        body.extend_from_slice(&state.to_le_bytes());
    }
    body.truncate(asset_bytes);
    std::fs::write(root.join("assets").join("big.js"), &body).expect("asset");
    (dir, root)
}

async fn gateway_with(root: PathBuf) -> (dsh_gateway::GatewayHandle, reqwest::Client) {
    let handle = start(GatewayConfig::loopback(root), vec![11u8; 32])
        .await
        .expect("gateway");
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("client");
    (handle, client)
}

async fn cookie_for(handle: &dsh_gateway::GatewayHandle, client: &reqwest::Client) -> String {
    let response = client
        .get(handle.authenticated_url())
        .send()
        .await
        .expect("mint");
    assert_eq!(response.status().as_u16(), 303);
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

const BOOT_SCRIPT: &str =
    "<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>";

/// The index advertises the length of the document it actually serves, including
/// the injected boot gate, and serves exactly that many bytes.
///
/// This is the property the previous implementation broke: it read the file,
/// injected the gate, then let Hyper recompute a length for the injected body
/// while the handler's own comment claimed the on-disk length. A cache or preload
/// path that trusts the header must see the injected size.
#[tokio::test]
async fn index_content_length_describes_the_injected_document() {
    let (_dir, root) = static_dir(1024);
    let (handle, client) = gateway_with(root).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    let response = client
        .get(format!("{origin}/"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("index");
    assert_eq!(response.status().as_u16(), 200);
    let declared: usize = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .expect("content-length")
        .parse()
        .expect("numeric");
    let body = response.bytes().await.expect("body");
    assert_eq!(
        body.len(),
        declared,
        "the declared length must equal the served bytes"
    );
    assert!(
        String::from_utf8_lossy(&body).contains("__DSH_BOOT_READY__"),
        "the served index must carry the boot gate"
    );

    // The on-disk file is shorter than what is served, by exactly the gate, so
    // the declared length is demonstrably not the file's own size.
    let on_disk = std::fs::read(_dir.path().join("index.html")).expect("index file");
    assert_eq!(
        declared,
        on_disk.len() + BOOT_SCRIPT.len(),
        "the gate is included in the advertised length"
    );
    assert_ne!(
        declared,
        on_disk.len(),
        "the advertised length must not be the on-disk length"
    );
}

/// `HEAD` answers status and content type with no payload, for both the injected
/// index and a large asset, and does so for a path that does not exist.
///
/// The last case is the one that distinguishes "checked for existence, then
/// answered" from the reference, which never performs the read that would raise
/// `ENOENT` and therefore cannot discover absence.
#[tokio::test]
async fn head_reports_metadata_and_never_a_payload() {
    // 8 MiB: if the handler read the asset to answer HEAD, the request would move
    // megabytes for a body it discards. The size is asserted below by a GET so
    // the HEAD result cannot be passing because the asset is empty.
    let (_dir, root) = static_dir(8 * 1024 * 1024);
    let (handle, client) = gateway_with(root).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    for (path, expected_type) in [
        ("/", "text/html; charset=utf-8"),
        ("/index.html", "text/html; charset=utf-8"),
        ("/assets/big.js", "text/javascript; charset=utf-8"),
    ] {
        let response = client
            .head(format!("{origin}{path}"))
            .header("cookie", &cookie)
            .send()
            .await
            .expect("head");
        assert_eq!(response.status().as_u16(), 200, "HEAD {path}");
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            Some(expected_type),
            "HEAD {path} content type"
        );
        assert_eq!(
            response.content_length(),
            Some(0),
            "HEAD {path} must carry no payload"
        );
        assert!(
            response.bytes().await.expect("body").is_empty(),
            "HEAD {path} must transfer no bytes"
        );
    }

    // The asset really is 8 MiB, so HEAD above was not reporting an empty file.
    let response = client
        .get(format!("{origin}/assets/big.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("get");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response.bytes().await.expect("body").len(),
        8 * 1024 * 1024,
        "GET serves the whole asset"
    );

    // A HEAD for a contained, absent path answers 200 with no body: the reference
    // never reads, so it never learns the file is missing. A GET for the same path
    // does read, gets ENOENT, and proxies to the Host instead.
    let head_missing = client
        .head(format!("{origin}/assets/absent.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("head missing");
    assert_eq!(
        head_missing.status().as_u16(),
        200,
        "HEAD does not read, so it cannot report absence"
    );
    assert!(head_missing.bytes().await.expect("body").is_empty());
}

/// Serving the shell leaves the response cacheable by Chromium's ordinary
/// heuristics and attaches no validator the packaged revision cannot honour.
#[tokio::test]
async fn shell_assets_declare_no_cache_policy_of_their_own() {
    let (_dir, root) = static_dir(1024);
    let (handle, client) = gateway_with(root).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    for path in ["/", "/index.html", "/assets/big.js"] {
        let response = client
            .get(format!("{origin}{path}"))
            .header("cookie", &cookie)
            .send()
            .await
            .expect("static request");
        assert_eq!(response.status().as_u16(), 200, "{path}");
        for header in ["cache-control", "etag", "last-modified", "expires"] {
            assert!(
                response.headers().get(header).is_none(),
                "{path} must not carry {header}: the reference sets only content-type"
            );
        }
        // The served bytes are not encoded, so claiming an encoding would make
        // the renderer decode plain text.
        assert!(
            response.headers().get("content-encoding").is_none(),
            "{path} must not claim an encoding"
        );
        assert!(
            response.headers().get("set-cookie").is_none(),
            "{path} must not hand the page a cookie"
        );
    }
}

/// The static root answers `403` for a shell-owned escape and never serves bytes
/// from outside the packaged tree, for every spelling that survives the client's
/// own normalization. A malformed escape is the reference's `400`, and a
/// root-level traversal is not shell-owned at all, so it proxies to the Host
/// rather than being answered from the packaged root.
#[tokio::test]
async fn escapes_are_refused_without_serving_outside_bytes() {
    let (dir, root) = static_dir(256);
    // A sentinel beside the packaged root that a traversal would reach.
    let sentinel = dir.path().join("sentinel-secret.txt");
    std::fs::write(&sentinel, b"SENTINEL-MUST-NOT-BE-SERVED").expect("sentinel");
    let (handle, client) = gateway_with(root).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    for traversal in [
        "/assets/%2e%2e%2f%2e%2e%2fsentinel-secret.txt",
        "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fsentinel-secret.txt",
        "/assets/..%5c..%5csentinel-secret.txt",
    ] {
        let response = client
            .get(format!("{origin}{traversal}"))
            .header("cookie", &cookie)
            .send()
            .await
            .expect("traversal request");
        assert_eq!(
            response.status().as_u16(),
            403,
            "{traversal} escapes the packaged root and must be refused"
        );
        assert_eq!(
            response
                .headers()
                .get("content-type")
                .and_then(|v| v.to_str().ok()),
            None,
            "{traversal} must not describe a body it does not serve"
        );
        let body = response.bytes().await.expect("body");
        assert!(body.is_empty(), "{traversal} must return no body");
        assert!(
            !String::from_utf8_lossy(&body).contains("SENTINEL"),
            "{traversal} must not serve the sentinel"
        );
    }

    // A malformed percent-escape is the reference's `decodeURIComponent`
    // throw, answered as `400` before any containment test.
    let malformed = client
        .get(format!("{origin}/assets/%zz"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("malformed request");
    assert_eq!(malformed.status().as_u16(), 400);
    assert!(malformed.bytes().await.expect("body").is_empty());
}

/// An interior `..` under a shell-owned prefix stays inside the packaged root,
/// so it is a contained miss (`404`) rather than a refusal — and it is answered
/// by the shell, never proxied.
///
/// The request is written to a raw socket because every HTTP client removes a
/// literal `..` segment before sending; `static_regressions.rs` pins the
/// client-normalized form (which leaves the allowlist and proxies).
#[tokio::test]
async fn an_interior_traversal_under_the_shell_prefix_is_a_contained_miss() {
    let (_dir, root) = static_dir(256);
    let (handle, client) = gateway_with(root).await;
    let cookie = cookie_for(&handle, &client).await;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(handle.local_addr())
        .await
        .expect("connect");
    let request = format!(
        "GET /assets/../absent.js HTTP/1.1\r\nhost: {}\r\ncookie: {cookie}\r\nconnection: close\r\n\r\n",
        handle.local_addr()
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write request");
    let mut raw = Vec::new();
    stream.read_to_end(&mut raw).await.expect("read response");
    let text = String::from_utf8_lossy(&raw);
    assert!(
        text.starts_with("HTTP/1.1 404"),
        "an interior traversal under `/assets/` is a contained miss: {text}"
    );
}
