use dsh_gateway::{start, GatewayConfig};
use futures_util::StreamExt;
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

async fn fixture() -> (
    tempfile::TempDir,
    dsh_gateway::GatewayHandle,
    reqwest::Client,
    String,
    Arc<AtomicBool>,
) {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<head></head>").unwrap();
    let gate = Arc::new(AtomicBool::new(true));
    let check = gate.clone();
    let handle = start(
        GatewayConfig::loopback(PathBuf::from(dir.path()))
            .with_admission(Arc::new(move || check.load(Ordering::SeqCst))),
        vec![9; 32],
    )
    .await
    .unwrap();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let response = client.get(handle.authenticated_url()).send().await.unwrap();
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    (dir, handle, client, cookie, gate)
}

async fn host() -> (
    std::net::SocketAddr,
    tokio::sync::mpsc::UnboundedReceiver<()>,
) {
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/",
            axum::routing::get(|| async {
                axum::response::Response::builder()
                    .status(303)
                    .header("set-cookie", "host=x; Path=/")
                    .body(axum::body::Body::empty())
                    .unwrap()
            }),
        )
        .route(
            "/echo",
            axum::routing::get(move || {
                let tx = tx.clone();
                async move {
                    let _ = tx.send(());
                    "ok"
                }
            }),
        )
        .route(
            "/ws",
            axum::routing::get(|ws: axum::extract::WebSocketUpgrade| async move {
                ws.on_upgrade(|mut s| async move {
                    while let Some(Ok(m)) = s.next().await {
                        if s.send(m).await.is_err() {
                            break;
                        }
                    }
                })
            }),
        );
    tokio::spawn(async move {
        let _ = axum::serve(listener, app).await;
    });
    (addr, rx)
}

#[tokio::test]
async fn same_gateway_callback_freshly_governs_http_allow_deny_allow() {
    let (_dir, gateway, client, cookie, gate) = fixture().await;
    let (addr, mut hits) = host().await;
    gateway
        .set_host(&format!("http://{addr}/?token=x"))
        .await
        .unwrap();
    let url = format!("{}/echo", gateway.origin());
    let response = client
        .get(&url)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    tokio::time::timeout(Duration::from_secs(2), hits.recv())
        .await
        .unwrap()
        .unwrap();
    gate.store(false, Ordering::SeqCst);
    assert_eq!(
        client
            .get(&url)
            .header("cookie", &cookie)
            .send()
            .await
            .unwrap()
            .status(),
        503
    );
    assert!(tokio::time::timeout(Duration::from_millis(50), hits.recv())
        .await
        .is_err());
    gate.store(true, Ordering::SeqCst);
    let response = client
        .get(&url)
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(response.text().await.unwrap(), "ok");
    tokio::time::timeout(Duration::from_secs(2), hits.recv())
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn default_absent_callback_preserves_shell_and_ws_admission_is_live() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::write(dir.path().join("index.html"), "<head></head>").unwrap();
    let gateway = start(GatewayConfig::loopback(dir.path()), vec![9; 32])
        .await
        .unwrap();
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .unwrap();
    let cookie = client
        .get(gateway.authenticated_url())
        .send()
        .await
        .unwrap()
        .headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        client
            .get(gateway.origin())
            .header("cookie", cookie)
            .send()
            .await
            .unwrap()
            .status(),
        200
    );
}
