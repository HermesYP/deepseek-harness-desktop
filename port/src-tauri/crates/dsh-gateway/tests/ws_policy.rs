//! Real idle WebSocket revocation and re-admission against one retained fixture
//! backend. This proves relay/backend-listener behavior, not live-agent parity.
use dsh_gateway::{start, GatewayConfig};
use futures_util::{SinkExt, StreamExt};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;
use tokio_tungstenite::tungstenite::{client::IntoClientRequest, Message};

struct Server(tokio::task::JoinHandle<()>);
impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}
struct Closed(Arc<tokio::sync::Notify>);
impl Drop for Closed {
    fn drop(&mut self) {
        self.0.notify_one();
    }
}

#[tokio::test]
async fn idle_revocation_closes_the_relay_and_restoration_reuses_the_live_backend() {
    let allowed = Arc::new(AtomicBool::new(true));
    let check = allowed.clone();
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("index.html"), "<head></head>").unwrap();
    let gateway = start(
        GatewayConfig::loopback(directory.path().to_owned())
            .with_admission(Arc::new(move || check.load(Ordering::SeqCst))),
        vec![81; 32],
    )
    .await
    .unwrap();
    let received = Arc::new(AtomicUsize::new(0));
    let started = Arc::new(tokio::sync::Notify::new());
    let closed = Arc::new(tokio::sync::Notify::new());
    let (count, start, close) = (received.clone(), started.clone(), closed.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/",
            axum::routing::get(|uri: axum::http::Uri| async move {
                if uri.query() != Some("token=ws-fixture") {
                    return axum::response::Response::builder()
                        .status(401)
                        .body(axum::body::Body::empty())
                        .unwrap();
                }
                axum::response::Response::builder()
                    .status(303)
                    .header("set-cookie", "host-auth=ws-fixture; Path=/")
                    .header("location", "/")
                    .body(axum::body::Body::empty())
                    .unwrap()
            }),
        )
        .route(
            "/alive",
            axum::routing::get(|| async { "same-backend-alive" }),
        )
        .route(
            "/api/remote.mux",
            axum::routing::get(move |ws: axum::extract::WebSocketUpgrade| {
                let (count, start, close) = (count.clone(), start.clone(), close.clone());
                async move {
                    ws.on_upgrade(move |mut socket| async move {
                        let _closed = Closed(close);
                        start.notify_one();
                        while let Some(Ok(message)) = socket.next().await {
                            if let axum::extract::ws::Message::Text(text) = message {
                                count.fetch_add(1, Ordering::SeqCst);
                                if socket
                                    .send(axum::extract::ws::Message::Text(text))
                                    .await
                                    .is_err()
                                {
                                    break;
                                }
                            }
                        }
                    })
                }
            }),
        );
    let server = Server(tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    }));
    gateway
        .set_host(&format!("http://{address}/?token=ws-fixture"))
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
    let request = || {
        let mut request = format!("ws://{}/api/remote.mux", gateway.local_addr())
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("cookie", cookie.parse().unwrap());
        request
            .headers_mut()
            .insert("origin", gateway.origin().parse().unwrap());
        request
    };
    let (mut socket, _) = tokio_tungstenite::connect_async(request()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .expect("fixture backend upgraded");
    // Neither direction sends a frame: the independent revocation monitor must
    // close an otherwise idle tunnel, without requiring client activity.
    allowed.store(false, Ordering::SeqCst);
    let terminated = tokio::time::timeout(Duration::from_secs(2), socket.next())
        .await
        .expect("idle tunnel must close");
    assert!(
        terminated.is_none() || matches!(terminated, Some(Ok(Message::Close(_))) | Some(Err(_))),
        "unexpected frame: {terminated:?}"
    );
    let _ = socket.send(Message::Text("must-not-forward".into())).await;
    tokio::time::timeout(Duration::from_secs(2), closed.notified())
        .await
        .expect("backend relay loop must finish");
    assert_eq!(received.load(Ordering::SeqCst), 0);
    assert!(
        !server.0.is_finished(),
        "revocation does not stop the backend listener"
    );
    assert_eq!(
        client
            .get(format!("http://{address}/alive"))
            .send()
            .await
            .unwrap()
            .text()
            .await
            .unwrap(),
        "same-backend-alive"
    );
    let refused = client
        .get(format!("{}/alive", gateway.origin()))
        .header("cookie", &cookie)
        .send()
        .await
        .unwrap();
    assert_eq!(refused.status().as_u16(), 503);
    let refused_ws = tokio_tungstenite::connect_async(request())
        .await
        .unwrap_err();
    assert!(
        matches!(refused_ws, tokio_tungstenite::tungstenite::Error::Http(ref response) if response.status().as_u16() == 503)
    );
    allowed.store(true, Ordering::SeqCst);
    let (mut restored, _) = tokio_tungstenite::connect_async(request()).await.unwrap();
    restored
        .send(Message::Text("after-restore".into()))
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), restored.next())
            .await
            .unwrap()
            .unwrap()
            .unwrap(),
        Message::Text("after-restore".into())
    );
    assert_eq!(received.load(Ordering::SeqCst), 1);
    assert!(!server.0.is_finished());
    let _ = restored.close(None).await;
}
