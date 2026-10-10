//! Reparse-point containment regression tests for the packaged static root.
//!
//! The reference `serveWebDocument` decides containment with `path.resolve` +
//! `startsWith`, which is entirely **lexical**: a symlink, NTFS junction, or other
//! reparse point that lives inside the packaged root but targets bytes outside it
//! passes that test and is then followed by `readFile`, so the gateway serves
//! those bytes as shell content. `resolve_static` alone cannot prevent that,
//! because no amount of string comparison observes where a reparse point leads.
//!
//! These tests build a real junction fixture and assert the gateway refuses to
//! serve through it, while still serving contained files with unchanged metadata
//! and still refusing lexical escapes.
//!
//! Windows junction creation does not require administrator privilege; symbolic
//! links do (`SeCreateSymbolicLinkPrivilege`). The fixture therefore uses a
//! junction, which is the same reparse-point class for containment purposes. The
//! fixture is created under a `tempfile` directory that the test owns, so no live
//! profile, packaged bundle, or user directory is touched.

use std::path::{Path, PathBuf};

use dsh_gateway::{start, GatewayConfig};

/// Create a directory junction at `link` pointing to `target`.
///
/// Returns `false` when the platform refuses to create it, so the test can report
/// an honest skip rather than pass vacuously: a green assertion over a fixture
/// that was never created would prove nothing about containment.
fn create_junction(link: &Path, target: &Path) -> bool {
    // `mklink` is a cmd builtin, so it must run through the command interpreter.
    let status = std::process::Command::new("cmd")
        .args(["/c", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status();
    match status {
        Ok(status) => status.success() && link.exists(),
        Err(_) => false,
    }
}

struct Fixture {
    _dir: tempfile::TempDir,
    root: PathBuf,
    outside: PathBuf,
}

/// A packaged shell root beside a directory of bytes that must never be served.
///
/// The escaping links are created under `assets/` because only shell-owned
/// pathnames reach the static handler; a root-level link would be Host traffic
/// and never exercise containment.
fn fixture() -> Fixture {
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().join("shell");
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(root.join("assets")).expect("root");
    std::fs::create_dir_all(&outside).expect("outside");
    std::fs::write(
        root.join("index.html"),
        "<html><head><title>shell</title></head><body>dsh</body></html>",
    )
    .expect("index");
    std::fs::write(
        root.join("assets").join("app.js"),
        "export const shell = true;\n",
    )
    .expect("app");
    std::fs::write(outside.join("secret.txt"), b"SENTINEL-OUTSIDE").expect("secret");
    std::fs::create_dir_all(outside.join("nested")).expect("nested");
    std::fs::write(
        outside.join("nested").join("deep.js"),
        "export const leak = true;\n",
    )
    .expect("deep");
    Fixture {
        _dir: dir,
        root,
        outside,
    }
}

async fn gateway_with(root: PathBuf) -> (dsh_gateway::GatewayHandle, reqwest::Client) {
    let handle = start(GatewayConfig::loopback(root), vec![23u8; 32])
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
    assert_eq!(response.status().as_u16(), 303, "launch token must mint");
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

/// A junction inside the root that targets a sibling directory must not serve the
/// sibling's bytes, for a directory link and for a file reached through it.
///
/// This is the regression: before reparse containment, both requests answered
/// `200` with the outside file's bytes, because `/assets/link/secret.txt` is
/// textually inside the root and no lexical test can see the junction.
#[tokio::test]
async fn a_junction_out_of_the_root_never_serves_outside_bytes() {
    let fixture = fixture();
    let link = fixture.root.join("assets").join("link");
    if !create_junction(&link, &fixture.outside) {
        eprintln!("SKIP: this platform refused to create the junction fixture");
        return;
    }
    let (handle, client) = gateway_with(fixture.root.clone()).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    for path in ["/assets/link/secret.txt", "/assets/link/nested/deep.js"] {
        let response = client
            .get(format!("{origin}{path}"))
            .header("cookie", &cookie)
            .send()
            .await
            .expect("escape request");
        assert_eq!(
            response.status().as_u16(),
            403,
            "{path} leaves the packaged root through a junction and must be refused"
        );
        let body = response.bytes().await.expect("body");
        assert!(body.is_empty(), "{path} must return no body");
        assert!(
            !String::from_utf8_lossy(&body).contains("SENTINEL"),
            "{path} must not serve outside bytes"
        );
        assert!(
            !String::from_utf8_lossy(&body).contains("leak"),
            "{path} must not serve outside bytes"
        );
    }

    // The junction really does reach the outside bytes, so the refusals above are
    // containment working rather than the fixture being inert.
    let direct = std::fs::read(link.join("secret.txt")).expect("junction reads through");
    assert_eq!(
        direct, b"SENTINEL-OUTSIDE",
        "the fixture must be a live link"
    );
}

/// Reparse containment applies to `HEAD` as well, so a metadata probe cannot
/// confirm the existence of an escaping path.
#[tokio::test]
async fn head_refuses_an_escaping_junction_without_confirming_it() {
    let fixture = fixture();
    let link = fixture.root.join("assets").join("link");
    if !create_junction(&link, &fixture.outside) {
        eprintln!("SKIP: this platform refused to create the junction fixture");
        return;
    }
    let (handle, client) = gateway_with(fixture.root.clone()).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    let response = client
        .head(format!("{origin}/assets/link/secret.txt"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("head escape");
    assert_eq!(
        response.status().as_u16(),
        403,
        "HEAD must refuse an escaping junction rather than answer metadata for it"
    );
}

/// Containment is decided on the resolved location, not on the request text, so a
/// junction whose name merely *resembles* the outside directory is irrelevant and
/// a contained file behind no link still serves.
///
/// The sibling directory is named so that a naive prefix check on the raw string
/// would be satisfied (`shell-evil` starts with `shell`); component-wise
/// comparison against the canonical root must not be fooled.
#[tokio::test]
async fn a_sibling_directory_sharing_the_root_prefix_is_still_outside() {
    let fixture = fixture();
    // `shell-evil` shares the `shell` textual prefix with the root.
    let evil = fixture.root.parent().expect("parent").join("shell-evil");
    std::fs::create_dir_all(&evil).expect("evil");
    std::fs::write(evil.join("secret.txt"), b"SENTINEL-PREFIX").expect("secret");
    let link = fixture.root.join("assets").join("shady");
    if !create_junction(&link, &evil) {
        eprintln!("SKIP: this platform refused to create the junction fixture");
        return;
    }
    let (handle, client) = gateway_with(fixture.root.clone()).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    let response = client
        .get(format!("{origin}/assets/shady/secret.txt"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("prefix escape");
    assert_eq!(
        response.status().as_u16(),
        403,
        "a prefix-sharing sibling is outside the root, not inside it"
    );
    let body = response.bytes().await.expect("body");
    assert!(
        !String::from_utf8_lossy(&body).contains("SENTINEL"),
        "prefix confusion must not serve the sibling's bytes"
    );
}

/// Contained files still serve exactly as before: same status, same bytes, same
/// content type, and the boot gate still injected into the index.
///
/// This is the counterweight to the refusals above — containment must not have
/// been achieved by refusing everything.
#[tokio::test]
async fn contained_assets_are_unaffected_by_reparse_containment() {
    let fixture = fixture();
    let (handle, client) = gateway_with(fixture.root.clone()).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    let response = client
        .get(format!("{origin}/assets/app.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("contained asset");
    assert_eq!(response.status().as_u16(), 200);
    assert_eq!(
        response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok()),
        Some("text/javascript; charset=utf-8"),
        "the MIME map must still apply"
    );
    assert_eq!(
        response.bytes().await.expect("body"),
        b"export const shell = true;\n".as_slice(),
        "contained bytes must be served unchanged"
    );

    let index = client
        .get(format!("{origin}/"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("index");
    assert_eq!(index.status().as_u16(), 200);
    let body = index.bytes().await.expect("body");
    assert!(
        String::from_utf8_lossy(&body).contains("__DSH_BOOT_READY__"),
        "the boot gate must still be injected"
    );
}

/// An absent shell-owned path is the reference's `ENOENT` branch: a `404` for
/// `GET`, while `HEAD` never performs the read that would discover absence and
/// therefore answers `200` with no body.
#[tokio::test]
async fn an_absent_shell_path_is_a_404_while_head_still_probes() {
    let fixture = fixture();
    let (handle, client) = gateway_with(fixture.root.clone()).await;
    let cookie = cookie_for(&handle, &client).await;
    let origin = handle.origin().to_string();

    let response = client
        .get(format!("{origin}/assets/absent.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("absent get");
    assert_eq!(
        response.status().as_u16(),
        404,
        "an absent shell-owned path is the reference's 404, never a Host miss"
    );
    assert!(response.bytes().await.expect("body").is_empty());

    let head = client
        .head(format!("{origin}/assets/absent.js"))
        .header("cookie", &cookie)
        .send()
        .await
        .expect("absent head");
    assert_eq!(
        head.status().as_u16(),
        200,
        "HEAD does not read, so an absent shell path is not refused"
    );
    assert!(head.bytes().await.expect("body").is_empty());
}
