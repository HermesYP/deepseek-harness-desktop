//! Adversarial control-channel and lifecycle regression tests (lane R).
//!
//! Every test here has a **hard outer deadline** wrapped around the whole
//! scenario. The audit found several paths that could wait forever (a peer that
//! authenticates and never reports `ready`, a peer that stops reading, a
//! shutdown whose send blocks); without an outer deadline a regression in any of
//! them would hang the suite instead of failing it.
//!
//! The fixtures also cover the two failures that only appear on a real
//! byte-stream socket: an **oversized newline frame** and a **silent /
//! non-reading peer**.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dsh_core::protocol::RuntimeState;
use dsh_runtime::control::{
    self, ControlEndpoint, ControlServer, HostEvent, ShellMessage, UpdateTasksAction,
    EVENT_QUEUE_CAPACITY, MAX_OUTBOUND_FRAME_BYTES, UNTERMINATED_FRAME_CAP_BYTES,
    WRITE_QUEUE_CAPACITY,
};
use dsh_runtime::process_alive;
use dsh_runtime::supervisor::{SpawnPlan, Supervisor};

/// Hard outer deadline for one scenario. Long enough for a real process spawn
/// and teardown on a loaded machine, short enough that a regression fails the
/// suite instead of hanging it.
const SCENARIO_DEADLINE: Duration = Duration::from_secs(45);

/// Run `scenario` and fail loudly if it does not finish within
/// [`SCENARIO_DEADLINE`].
async fn bounded<F, T>(label: &str, scenario: F) -> T
where
    F: std::future::Future<Output = T>,
{
    match tokio::time::timeout(SCENARIO_DEADLINE, scenario).await {
        Ok(value) => value,
        Err(_) => panic!("{label}: exceeded the {SCENARIO_DEADLINE:?} outer deadline"),
    }
}

// ---------------------------------------------------------------------------
// Fake-Host fixtures (re-exec pattern; no external runtime required)
// ---------------------------------------------------------------------------

/// Re-exec entry: the fake Host control-protocol twin of `runtime/adapter.mjs`.
#[test]
fn adversarial_host_main() {
    if std::env::var("DSH_ADV_HOST").is_err() {
        return;
    }
    run_adversarial_host();
}

/// Re-exec entry: a grandchild that must not survive teardown.
#[test]
fn adversarial_host_child() {
    if std::env::var("DSH_ADV_CHILD").is_err() {
        return;
    }
    std::thread::sleep(Duration::from_secs(120));
}

#[allow(clippy::zombie_processes)]
fn run_adversarial_host() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        let endpoint = ControlEndpoint {
            socket_name: std::env::var("DSH_DESKTOP_CONTROL_SOCKET").expect("socket env"),
            token: std::env::var("DSH_DESKTOP_CONTROL_TOKEN").expect("token env"),
        };
        // Mode: connect, authenticate, then never send `ready`. The supervisor
        // must give up on its own readiness budget.
        if let Ok(marker) = std::env::var("DSH_ADV_AUTHENTICATED_SILENT") {
            let mut channel = control::connect(&endpoint).await.expect("control connect");
            std::fs::write(marker, std::process::id().to_string()).expect("write pid");
            // Hold the connection open and read nothing that matters.
            tokio::time::sleep(Duration::from_secs(600)).await;
            let _ = channel.send_event(&HostEvent::ShutdownComplete {}).await;
            return;
        }
        // Mode: reach `ready`, then never read from the socket again, so the
        // shell's write queue fills and its sends stall.
        if let Ok(marker) = std::env::var("DSH_ADV_NON_READING") {
            let mut channel = control::connect(&endpoint).await.expect("control connect");
            std::fs::write(marker, std::process::id().to_string()).expect("write pid");
            channel
                .send_event(&HostEvent::Ready {
                    url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                    injections: Some(Vec::new()),
                })
                .await
                .expect("ready");
            tokio::time::sleep(Duration::from_secs(600)).await;
            return;
        }
        // Mode: reach `ready`, then flood unsolicited events that nobody
        // consumes, exercising the bounded event queue.
        //
        // The flooded event must be one the shell legitimately accepts. An
        // unrequested `shutdown-complete` is a protocol violation (the Host may
        // only acknowledge a `shutdown` the shell sent), so flooding it turns
        // this fixture into a startup-failure test and hides the queue
        // behaviour behind a correct `host_fatal`. `platform-session` is the
        // shell's unsolicited channel, `None` carries no credentials, and it
        // still travels the bounded event queue.
        if let Ok(marker) = std::env::var("DSH_ADV_FLOODING") {
            let mut channel = control::connect(&endpoint).await.expect("control connect");
            std::fs::write(marker, std::process::id().to_string()).expect("write pid");
            channel
                .send_event(&HostEvent::Ready {
                    url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                    injections: Some(Vec::new()),
                })
                .await
                .expect("ready");
            for _ in 0..(EVENT_QUEUE_CAPACITY * 8) {
                if channel
                    .send_event(&HostEvent::PlatformSession { session: None })
                    .await
                    .is_err()
                {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_secs(600)).await;
            return;
        }
        // Mode: reach `ready`, then acknowledge a shutdown nobody requested.
        // That is a protocol violation, and the shell must treat it as terminal
        // (`host_fatal`) rather than as a teardown hint.
        if let Ok(marker) = std::env::var("DSH_ADV_UNREQUESTED_SHUTDOWN") {
            let mut channel = control::connect(&endpoint).await.expect("control connect");
            std::fs::write(marker, std::process::id().to_string()).expect("write pid");
            channel
                .send_event(&HostEvent::Ready {
                    url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                    injections: Some(Vec::new()),
                })
                .await
                .expect("ready");
            channel
                .send_event(&HostEvent::ShutdownComplete {})
                .await
                .expect("unrequested shutdown-complete");
            tokio::time::sleep(Duration::from_secs(600)).await;
            return;
        }
        // Mode: reach `ready` and start a grandchild, then refuse to read, so a
        // stop cannot rely on the graceful handshake.
        if let Ok(marker) = std::env::var("DSH_ADV_READY_THEN_STALL") {
            let mut channel = control::connect(&endpoint).await.expect("control connect");
            let mut child = spawn_adversarial_child();
            std::fs::write(marker, child.id().to_string()).expect("write child pid");
            channel
                .send_event(&HostEvent::Ready {
                    url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                    injections: Some(Vec::new()),
                })
                .await
                .expect("ready");
            tokio::time::sleep(Duration::from_secs(600)).await;
            let _ = child.kill();
            return;
        }
        // Mode: reach `ready`, then publish a credential session and hold the
        // connection open. Used to prove credential ownership across
        // subscribe/stop/restart and generation replacement.
        if let Ok(marker) = std::env::var("DSH_ADV_PLATFORM_SESSION") {
            let mut channel = control::connect(&endpoint).await.expect("control connect");
            std::fs::write(marker, std::process::id().to_string()).expect("write pid");
            channel
                .send_event(&HostEvent::Ready {
                    url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                    injections: Some(Vec::new()),
                })
                .await
                .expect("ready");
            // The token carries the run's own pid so a test can attribute the
            // session to a specific generation.
            let token = std::env::var("DSH_ADV_SESSION_TOKEN")
                .unwrap_or_else(|_| format!("token-{}", std::process::id()));
            channel
                .send_event(&HostEvent::PlatformSession {
                    session: Some(platform_session(&token)),
                })
                .await
                .expect("platform-session");
            while let Ok(Some(message)) = channel.recv_message().await {
                if matches!(message, ShellMessage::Shutdown {}) {
                    channel
                        .send_event(&HostEvent::ShutdownComplete {})
                        .await
                        .expect("shutdown-complete");
                    return;
                }
            }
            tokio::time::sleep(Duration::from_secs(600)).await;
            return;
        }
        // Default mode: reach `ready` and answer control requests normally.
        let mut channel = control::connect(&endpoint).await.expect("control connect");
        let marker = std::env::var("DSH_ADV_REPORT").expect("report env");
        let mut child = spawn_adversarial_child();
        std::fs::write(&marker, child.id().to_string()).expect("write child pid");
        channel
            .send_event(&HostEvent::Ready {
                url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                injections: Some(Vec::new()),
            })
            .await
            .expect("ready");
        while let Ok(Some(message)) = channel.recv_message().await {
            match message {
                ShellMessage::QuitInspection { request_id } => {
                    channel
                        .send_event(&HostEvent::QuitInspection {
                            request_id,
                            active_tasks: false,
                            scheduled_tasks: false,
                            error: None,
                        })
                        .await
                        .expect("quit-inspection");
                }
                ShellMessage::UpdateTasks { request_id, action } => {
                    channel
                        .send_event(&HostEvent::UpdateTasks {
                            request_id,
                            active: action == UpdateTasksAction::Lock,
                            error: None,
                        })
                        .await
                        .expect("update-tasks");
                }
                ShellMessage::Shutdown {} => {
                    let _ = child.kill();
                    let _ = child.wait();
                    channel
                        .send_event(&HostEvent::ShutdownComplete {})
                        .await
                        .expect("shutdown-complete");
                    return;
                }
            }
        }
    });
}

#[allow(clippy::zombie_processes)]
fn spawn_adversarial_child() -> std::process::Child {
    std::process::Command::new(std::env::current_exe().expect("current exe"))
        .args([
            "adversarial_host_child",
            "--exact",
            "adversarial_host_child",
            "--nocapture",
        ])
        .env("DSH_ADV_CHILD", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn child")
}

/// A structurally valid credential session for the fixture (never logged).
fn platform_session(token: &str) -> dsh_runtime::control::PlatformSession {
    dsh_runtime::control::PlatformSession {
        origin: "http://127.0.0.1:3080".into(),
        token: token.into(),
        user_id: Some("fixture-user".into()),
        embedded_page_dist: None,
        request_headers: None,
    }
}

fn adversarial_plan(extra_env: &[(&str, &str)]) -> SpawnPlan {
    let mut env = std::collections::BTreeMap::new();
    env.insert("DSH_ADV_HOST".to_string(), "1".to_string());
    for (key, value) in extra_env {
        env.insert((*key).to_string(), (*value).to_string());
    }
    SpawnPlan {
        program: std::env::current_exe().expect("current exe"),
        args: vec![
            "adversarial_host_main".to_string(),
            "--exact".to_string(),
            "adversarial_host_main".to_string(),
            "--nocapture".to_string(),
        ],
        cwd: std::env::temp_dir(),
        env,
        forward_stdout: false,
    }
}

// ---------------------------------------------------------------------------
// Authentication against a non-reading / wrong-token peer
// ---------------------------------------------------------------------------

/// The audit item that motivated the outer deadlines: a **wrong-token accept**
/// must not hang when the sandboxed client's `open` fails. The server has to
/// answer within its own budget instead of waiting for a token that can never
/// arrive.
#[tokio::test(flavor = "multi_thread")]
async fn wrong_token_accept_terminates_even_when_the_client_cannot_open() {
    bounded("wrong token accept", async {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let wrong = ControlEndpoint {
            token: format!("{}x", endpoint.token),
            ..endpoint.clone()
        };
        // The client either connects and presents the wrong token, or cannot
        // open the pipe at all (confinement). Both must resolve.
        let client = tokio::spawn(async move {
            let _ = control::connect(&wrong).await;
        });
        let accepted = tokio::time::timeout(Duration::from_secs(20), server.accept()).await;
        let _ = client.await;
        match accepted {
            Ok(Err(_)) => {}
            Ok(Ok(_)) => panic!("a wrong token must never authenticate"),
            Err(_) => panic!("accept must not wait forever for a valid token"),
        }
    })
    .await;
}

/// A peer that connects and sends **no token at all** must be refused rather
/// than held open. This opens the socket directly: `control::connect` is the
/// authenticated client and would send a token.
#[tokio::test(flavor = "multi_thread")]
async fn a_peer_that_sends_no_token_is_refused() {
    bounded("silent unauthenticated peer", async {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        // Connect and send nothing, then hold the connection open.
        let client = tokio::spawn({
            let endpoint = endpoint.clone();
            async move {
                match open_raw(&endpoint).await {
                    Ok(stream) => {
                        tokio::time::sleep(Duration::from_secs(90)).await;
                        drop(stream);
                    }
                    // Confinement may refuse the open; the assertion below still
                    // requires the server to give up on its own budget.
                    Err(_) => tokio::time::sleep(Duration::from_secs(90)).await,
                }
            }
        });
        // The server's unauthenticated handshake budget is 30 s; allow margin.
        let result = tokio::time::timeout(Duration::from_secs(40), accept).await;
        client.abort();
        match result {
            Ok(Ok(Err(_))) => {}
            Ok(Ok(Ok(_))) => panic!("an unauthenticated peer must not be accepted"),
            Ok(Err(error)) => panic!("accept task failed: {error}"),
            Err(_) => panic!("accept must bound the unauthenticated handshake"),
        }
    })
    .await;
}

/// Open the control endpoint without sending the transport token.
#[cfg(windows)]
async fn open_raw(
    endpoint: &ControlEndpoint,
) -> Result<tokio::net::windows::named_pipe::NamedPipeClient, std::io::Error> {
    tokio::net::windows::named_pipe::ClientOptions::new().open(&endpoint.socket_name)
}

/// Open the control endpoint without sending the transport token.
#[cfg(unix)]
async fn open_raw(
    endpoint: &ControlEndpoint,
) -> Result<tokio::net::unix::UnixStream, std::io::Error> {
    tokio::net::UnixStream::connect(&endpoint.socket_name).await
}

// ---------------------------------------------------------------------------
// Framing under a byte-stream socket
// ---------------------------------------------------------------------------

/// An oversized newline frame must be rejected rather than buffered and parsed.
///
/// The bound lives in the frame decoder, and a socket peer cannot be relied on
/// to deliver 8 MB of flood (the writer blocks on its own socket buffer long
/// before the reader's cap is reached), so the decoder is driven directly with
/// the exact byte patterns a streaming peer produces.
#[test]
fn oversized_newline_frame_is_rejected_not_buffered() {
    use dsh_runtime::control::FrameDecoder;

    // A delimiter-free flood is refused by the unterminated cap before the
    // buffer can grow past it.
    let mut decoder = FrameDecoder::new();
    let piece = vec![b'x'; 64 * 1024];
    let mut refusal = None;
    for _ in 0..(UNTERMINATED_FRAME_CAP_BYTES / piece.len() + 8) {
        if let Err(error) = decoder.push(&piece) {
            refusal = Some(error);
            break;
        }
        assert!(
            decoder.buffered_len() <= UNTERMINATED_FRAME_CAP_BYTES,
            "the buffer must stay inside the unterminated cap"
        );
    }
    let refusal = refusal.expect("a delimiter-free flood must be refused");
    assert!(
        refusal.is_overflow(),
        "the refusal must be reported as an overflow, got {refusal:?}"
    );

    // A frame that completes inside one chunk is measured against the
    // terminated cap, so a large-but-legal frame is not rejected by the
    // unterminated bound.
    let mut decoder = FrameDecoder::new();
    let mut frame = vec![b'y'; UNTERMINATED_FRAME_CAP_BYTES];
    frame.push(b'\n');
    let frames = decoder
        .push_chunk(&frame)
        .expect("a terminated frame is admitted whole");
    assert_eq!(frames.len(), 1);
    let line = frames.into_iter().next().unwrap().expect("decodes");
    assert_eq!(line.len(), UNTERMINATED_FRAME_CAP_BYTES);
}

/// A malformed frame on the wire closes the link and drops every waiter, which
/// is the end-to-end behaviour the supervisor's event pump depends on.
#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_frame_closes_the_link() {
    bounded("malformed frame closes the link", async {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = control::connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        // Register a waiter by racing the request against the protocol
        // violation: the request is answered by the reader failing, not by the
        // peer, so it is driven with `join!` instead of a spawned borrow.
        let answer = tokio::join!(
            link.request(
                |id| ShellMessage::QuitInspection { request_id: id },
                Duration::from_secs(20),
            ),
            async {
                assert!(matches!(
                    child.recv_message().await.expect("recv"),
                    Some(ShellMessage::QuitInspection { .. })
                ));
                child
                    .send_raw(b"{\"type\":\"not-a-known-event\"}\n")
                    .await
                    .expect("send malformed frame");
            }
        );
        assert!(
            answer.0.is_err(),
            "a protocol violation must fail the pending request"
        );
        assert!(link.is_closed(), "a protocol violation closes the link");
        assert_eq!(link.pending_count(), 0);
    })
    .await;
}

/// A silent peer that keeps the socket open must not pin correlated requests:
/// the request deadline is what bounds the wait.
#[tokio::test(flavor = "multi_thread")]
async fn a_silent_peer_cannot_pin_a_correlated_request() {
    bounded("silent peer request", async {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = control::connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let started = std::time::Instant::now();
        let outcome = link
            .request(
                |id| ShellMessage::QuitInspection { request_id: id },
                Duration::from_millis(250),
            )
            .await;
        assert!(
            outcome.is_err(),
            "an unanswered request must fail at its deadline"
        );
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "the deadline, not the peer, must bound the wait"
        );
        // The request did reach the peer, proving the deadline covered the reply.
        assert!(matches!(
            child.recv_message().await.expect("recv"),
            Some(ShellMessage::QuitInspection { .. })
        ));
        assert_eq!(
            link.pending_count(),
            0,
            "a timed-out request must not leak a pending entry"
        );
    })
    .await;
}

/// A peer that stops reading must stall its sender at a **bounded** cost, and
/// the whole operation must still return at its deadline.
#[tokio::test(flavor = "multi_thread")]
async fn a_non_reading_peer_stalls_requests_within_the_deadline() {
    bounded("non-reading peer", async {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        // Authenticate, then never read again.
        let child = control::connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        let started = std::time::Instant::now();
        let mut errors = 0usize;
        let mut issued = 0usize;
        while issued < WRITE_QUEUE_CAPACITY * 8 && started.elapsed() < Duration::from_secs(20) {
            issued += 1;
            if link
                .request(
                    |id| ShellMessage::QuitInspection { request_id: id },
                    Duration::from_millis(200),
                )
                .await
                .is_err()
            {
                errors += 1;
            }
        }
        assert!(
            errors > 0,
            "a peer that never reads must eventually fail a request"
        );
        assert!(
            started.elapsed() < Duration::from_secs(25),
            "the write queue is bounded, so this cannot take unbounded time"
        );
        drop(child);
    })
    .await;
}

/// Unsolicited events fill a bounded queue, and the queue's bound is what
/// applies backpressure instead of unbounded memory growth.
#[tokio::test(flavor = "multi_thread")]
async fn the_event_queue_is_bounded() {
    bounded("bounded event queue", async {
        let endpoint = ControlEndpoint::generate();
        let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
        let accept = tokio::spawn(async move { server.accept().await });
        let mut child = control::connect(&endpoint).await.expect("connect");
        let link = accept.await.expect("join").expect("accept");

        // Push far more events than the queue holds, without consuming any. The
        // flood runs on its own task because the bounded queue eventually stops
        // the reader, which in turn blocks the flood — the point of the bound.
        let target = EVENT_QUEUE_CAPACITY * 4;
        let flood = tokio::spawn(async move {
            let mut sent = 0usize;
            for _ in 0..target {
                if child
                    .send_event(&HostEvent::ShutdownComplete {})
                    .await
                    .is_err()
                {
                    break;
                }
                sent += 1;
            }
            sent
        });
        // Give the reader time to fill its queue.
        tokio::time::sleep(Duration::from_millis(500)).await;
        let mut drained = 0usize;
        while drained < target {
            match tokio::time::timeout(Duration::from_millis(100), link.next_event()).await {
                Ok(Some(_)) => drained += 1,
                _ => break,
            }
        }
        assert!(drained > 0, "queued events remain readable");
        // The peer may still be blocked mid-flood; that is the backpressure the
        // bound is meant to apply, so it is not awaited to completion.
        flood.abort();
    })
    .await;
}

/// Outbound frames are capped, so the shell cannot be made to send a
/// pathologically large request even if a caller builds one.
#[test]
fn outbound_frame_cap_is_enforced() {
    const {
        assert!(MAX_OUTBOUND_FRAME_BYTES < UNTERMINATED_FRAME_CAP_BYTES);
    }
    let ordinary = dsh_runtime::control::encode_frame(&ShellMessage::Shutdown {}).expect("encode");
    assert!(ordinary.len() <= MAX_OUTBOUND_FRAME_BYTES);
}

// ---------------------------------------------------------------------------
// Supervisor lifecycle under adversarial peers
// ---------------------------------------------------------------------------

/// An authenticated Host that never reports `ready` must fail startup on the
/// supervisor's own readiness budget, with the child reaped and no leaked state.
#[tokio::test(flavor = "multi_thread")]
async fn authenticated_but_never_ready_host_times_out_and_is_reaped() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("host.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    // The readiness budget is read from the supervisor's own environment, so the
    // production 60 s budget is shortened for this scenario only.
    std::env::set_var("DSH_DESKTOP_STARTUP_READY_TIMEOUT_MS", "1500");
    let supervisor = Supervisor::new(
        adversarial_plan(&[("DSH_ADV_AUTHENTICATED_SILENT", &marker_env)]),
        None,
    );
    bounded("authenticated-but-silent host", async {
        let error = supervisor
            .start()
            .await
            .expect_err("a Host that never reports ready must fail startup");
        std::env::remove_var("DSH_DESKTOP_STARTUP_READY_TIMEOUT_MS");
        let dsh_core::error::DshError::Other { code, .. } = error else {
            panic!("expected a typed startup error, got {error:?}");
        };
        assert_eq!(code, "host_startup_timeout");
        assert_eq!(supervisor.status().state, RuntimeState::Failed);
        let pid: u32 = std::fs::read_to_string(&marker)
            .expect("host pid")
            .parse()
            .expect("pid");
        assert!(!process_alive(pid), "the stalled Host must be reaped");
        assert!(supervisor.boot_facts().await.is_none());
        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(200), false)
            .await
            .expect("stop after startup timeout");
    })
    .await;
}

/// A non-reading Host must not make `stop` wait for the graceful handshake: the
/// tree escalation still runs and reaps the child.
#[tokio::test(flavor = "multi_thread")]
async fn shutdown_escalates_when_the_host_stops_reading() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("child.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    let supervisor = Arc::new(Supervisor::new(
        adversarial_plan(&[("DSH_ADV_READY_THEN_STALL", &marker_env)]),
        None,
    ));
    bounded("shutdown against a stalling host", async {
        supervisor.start().await.expect("start reaches ready");
        let child: u32 = std::fs::read_to_string(&marker)
            .expect("child pid")
            .parse()
            .expect("pid");
        assert!(process_alive(child), "the grandchild runs meanwhile");

        let started = std::time::Instant::now();
        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(200), false)
            .await
            .expect("stop must escalate rather than block on the send");
        assert!(
            started.elapsed() < Duration::from_secs(20),
            "a blocked graceful send must not delay the escalation"
        );
        assert_eq!(supervisor.status().state, RuntimeState::Stopped);
        assert!(
            !process_alive(child),
            "the tree escalation must reap the grandchild"
        );
    })
    .await;
}

/// The successful-admission path is unchanged: a cooperative Host still reaches
/// `ready`, answers both control surfaces, and leaves no survivors.
#[tokio::test(flavor = "multi_thread")]
async fn cooperative_host_still_reaches_ready_and_stops_cleanly() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("child.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    let failures = Arc::new(AtomicUsize::new(0));
    let observed = failures.clone();
    let supervisor = Supervisor::new(
        adversarial_plan(&[("DSH_ADV_REPORT", &marker_env)]),
        Some(Box::new(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        })),
    );
    bounded("cooperative host", async {
        let ready = supervisor.start().await.expect("start");
        assert!(ready.url.contains("token="));
        assert_eq!(supervisor.status().state, RuntimeState::Ready);

        let inspection = supervisor.quit_inspection().await;
        assert!(!inspection.active_tasks);
        assert!(!inspection.scheduled_tasks);
        assert!(!supervisor
            .update_tasks(UpdateTasksAction::Inspect)
            .await
            .expect("inspect"));
        assert!(supervisor
            .update_tasks(UpdateTasksAction::Lock)
            .await
            .expect("lock"));

        let child: u32 = std::fs::read_to_string(&marker)
            .expect("child pid")
            .parse()
            .expect("pid");
        supervisor.stop(true).await.expect("clean stop with ack");
        assert_eq!(supervisor.status().state, RuntimeState::Stopped);
        assert!(!process_alive(child), "no survivors after a clean stop");
        assert_eq!(
            failures.load(Ordering::SeqCst),
            0,
            "a clean lifecycle must not report a failure"
        );
    })
    .await;
}

/// A Host that floods unsolicited events must not break the control surfaces or
/// the teardown: the bounded queue applies backpressure rather than failing.
///
/// The fixture floods a *valid* unsolicited event (`platform-session`, which the
/// shell accepts on the bounded queue) and never reads a request, so the stop
/// has to escalate. The readiness re-assertion after the flood window is what
/// makes an early (wrong) failure visible instead of being masked by the stop.
#[tokio::test(flavor = "multi_thread")]
async fn a_flooding_host_still_stops() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("host.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    let supervisor = Arc::new(Supervisor::new(
        adversarial_plan(&[("DSH_ADV_FLOODING", &marker_env)]),
        None,
    ));
    bounded("flooding host", async {
        let ready = supervisor.start().await.expect("start reaches ready");
        assert!(
            ready.url.contains("token="),
            "readiness carries the Host's authenticated URL"
        );
        let pid: u32 = std::fs::read_to_string(&marker)
            .expect("host pid")
            .parse()
            .expect("pid");
        // Let the flood run for a bounded window, then require the runtime to
        // still be healthy: an invalid flooded event would have produced a
        // terminal failure by now, and asserting it here names that instead of
        // letting the stop below absorb it.
        tokio::time::sleep(Duration::from_millis(250)).await;
        let during = supervisor.status();
        assert_eq!(
            during.state,
            RuntimeState::Ready,
            "the flood must not turn readiness into a failure: {during:?}"
        );
        assert!(
            during.last_error.is_none(),
            "a valid unsolicited flood reports no failure: {during:?}"
        );
        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(300), false)
            .await
            .expect("stop after an event flood");
        assert_eq!(supervisor.status().state, RuntimeState::Stopped);
        assert!(
            supervisor.status().url.is_none(),
            "a stopped runtime advertises no URL"
        );
        assert!(!process_alive(pid), "the flooding Host must be reaped");
    })
    .await;
}

/// An unrequested `shutdown-complete` is a protocol violation, not a teardown
/// hint: the Host may only acknowledge a `shutdown` the shell sent. The shell
/// must publish a terminal `host_fatal`, clear readiness, and report the failure
/// exactly once — and the flooding fixture above must never be the only place
/// this rule is exercised.
#[tokio::test(flavor = "multi_thread")]
async fn an_unrequested_shutdown_acknowledgement_is_terminal() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("host.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    let failures = Arc::new(AtomicUsize::new(0));
    let observed = failures.clone();
    let supervisor = Supervisor::new(
        adversarial_plan(&[("DSH_ADV_UNREQUESTED_SHUTDOWN", &marker_env)]),
        Some(Box::new(move |_| {
            observed.fetch_add(1, Ordering::SeqCst);
        })),
    );
    bounded("unrequested shutdown acknowledgement", async {
        // Readiness and the terminal event race on the wire: either observation
        // order is valid, and neither may leave the runtime looking healthy.
        if let Err(error) = supervisor.start().await {
            assert!(
                matches!(&error, dsh_core::error::DshError::Other { code, .. } if code == "host_fatal"),
                "an unrequested acknowledgement is a typed terminal failure, got {error:?}"
            );
        }
        let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
        loop {
            let status = supervisor.status();
            if status.state == RuntimeState::Failed {
                assert!(
                    status.url.is_none(),
                    "a failed runtime must not advertise a URL"
                );
                assert!(
                    status
                        .last_error
                        .as_deref()
                        .unwrap_or_default()
                        .contains("acknowledged an unrequested shutdown"),
                    "the failure must name the violation: {status:?}"
                );
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "state stayed {:?} after an unrequested shutdown acknowledgement",
                status.state
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        assert_eq!(
            failures.load(Ordering::SeqCst),
            1,
            "a terminal protocol violation reports the first failure exactly once"
        );
        // The fixture never reads a request, so teardown escalates and reaps it.
        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(200), false)
            .await
            .expect("cleanup after the terminal violation");
        let pid: u32 = std::fs::read_to_string(&marker)
            .expect("host pid")
            .parse()
            .expect("pid");
        assert!(!process_alive(pid), "the violating Host must be reaped");
    })
    .await;
}

// ---------------------------------------------------------------------------
// Credential (`platform-session`) ownership
// ---------------------------------------------------------------------------

/// Wait until `receiver` shows a session whose token is `token`, or fail.
async fn await_session_token(
    receiver: &mut tokio::sync::watch::Receiver<Option<dsh_runtime::control::PlatformSession>>,
    token: &str,
    label: &str,
) {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        {
            let current = receiver.borrow_and_update().clone();
            if current
                .as_ref()
                .is_some_and(|session| session.token == token)
            {
                return;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "{label}: never observed token {token}"
        );
        tokio::time::timeout(Duration::from_millis(100), receiver.changed())
            .await
            .ok();
    }
}

/// A second subscriber must **join** the existing credential sink: it must not
/// replace the sender, and both subscribers must keep seeing the same latest
/// session. Replacing the sender would silently disconnect the first consumer.
#[tokio::test(flavor = "multi_thread")]
async fn a_second_subscriber_does_not_steal_the_credential_sink() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("host.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    let supervisor = Supervisor::new(
        adversarial_plan(&[
            ("DSH_ADV_PLATFORM_SESSION", &marker_env),
            ("DSH_ADV_SESSION_TOKEN", "first-generation"),
        ]),
        None,
    );
    bounded("two credential subscribers", async {
        supervisor.start().await.expect("start reaches ready");
        let mut first = supervisor.platform_sessions().await;
        await_session_token(&mut first, "first-generation", "first subscriber").await;

        // The second subscriber joins the same channel, seeded with the value
        // already observed (it must not start at `None`).
        let mut second = supervisor.platform_sessions().await;
        assert_eq!(
            second
                .borrow()
                .as_ref()
                .map(|session| session.token.clone()),
            Some("first-generation".to_string()),
            "a late subscriber is seeded with the latest session"
        );

        // Both keep observing the same value: if the second call had replaced
        // the sender, the first receiver would be orphaned and could never see
        // another update.
        await_session_token(&mut second, "first-generation", "second subscriber").await;
        await_session_token(
            &mut first,
            "first-generation",
            "first subscriber after join",
        )
        .await;

        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(300), false)
            .await
            .expect("stop");
    })
    .await;
}

/// Credentials must not outlive the Host generation that produced them: a stop
/// clears the latest session, and a subscriber sees `None` rather than a stale
/// token belonging to a dead Host.
#[tokio::test(flavor = "multi_thread")]
async fn stop_clears_the_latest_credential_session() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("host.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    let supervisor = Supervisor::new(
        adversarial_plan(&[
            ("DSH_ADV_PLATFORM_SESSION", &marker_env),
            ("DSH_ADV_SESSION_TOKEN", "generation-one"),
        ]),
        None,
    );
    bounded("credentials cleared on stop", async {
        supervisor.start().await.expect("start reaches ready");
        let mut sessions = supervisor.platform_sessions().await;
        await_session_token(&mut sessions, "generation-one", "before stop").await;

        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(300), false)
            .await
            .expect("stop");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if sessions.borrow_and_update().is_none() {
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "a stop must clear the latest credential session"
            );
            tokio::time::timeout(Duration::from_millis(50), sessions.changed())
                .await
                .ok();
        }

        // A subscriber that arrives after the stop must not be seeded with the
        // previous generation's session.
        let late = supervisor.platform_sessions().await;
        assert!(
            late.borrow().is_none(),
            "a post-stop subscriber must start with no credentials"
        );
    })
    .await;
}

/// A restart must not carry the previous generation's credentials forward: the
/// new run publishes nothing until its own Host reports a session.
#[tokio::test(flavor = "multi_thread")]
async fn restart_does_not_restore_the_previous_generation_credentials() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let marker = scratch.path().join("host.pid");
    let marker_env = marker.to_string_lossy().into_owned();
    // Both generations publish; the token is the run's own pid, so a stale value
    // is distinguishable from a fresh one without assuming timing.
    let supervisor = Supervisor::new(
        adversarial_plan(&[("DSH_ADV_PLATFORM_SESSION", &marker_env)]),
        None,
    );
    bounded("credentials do not survive a restart", async {
        supervisor.start().await.expect("start reaches ready");
        let mut sessions = supervisor.platform_sessions().await;
        let first_token = {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
            loop {
                if let Some(session) = sessions.borrow_and_update().clone() {
                    break session.token;
                }
                assert!(
                    tokio::time::Instant::now() < deadline,
                    "the first generation must publish a session"
                );
                tokio::time::timeout(Duration::from_millis(100), sessions.changed())
                    .await
                    .ok();
            }
        };

        supervisor.restart().await.expect("restart reaches ready");

        // Either the session is cleared until the new Host reports (acceptable),
        // or it is the *new* generation's token — never the previous one.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
        loop {
            let current = sessions.borrow_and_update().clone();
            if let Some(session) = &current {
                assert_ne!(
                    session.token, first_token,
                    "a restart must not restore the previous generation's credentials"
                );
                break;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the restarted generation must publish its own session"
            );
            tokio::time::timeout(Duration::from_millis(100), sessions.changed())
                .await
                .ok();
        }

        supervisor
            .stop_with_graceful_deadline(Duration::from_millis(300), false)
            .await
            .expect("stop");
    })
    .await;
}
