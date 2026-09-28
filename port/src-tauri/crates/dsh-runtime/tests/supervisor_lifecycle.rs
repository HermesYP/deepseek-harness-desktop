//! Integration test: a fake Host speaks the Desktop-Host lifecycle protocol
//! (generation 4) over the NDJSON control socket, and the supervisor must reach
//! `ready`, answer `quit-inspection` / `update-tasks`, and shut down with **no
//! surviving children** — including after a forced stop, where upstream could
//! orphan grandchildren (the Job-Object / process-group containment is a
//! deliberate improvement over the reference implementation).
//!
//! The test binary doubles as the fake host and as its grandchild (re-exec
//! pattern), so `cargo test` needs no external runtime.

use std::time::Duration;

use dsh_core::protocol::RuntimeState;
use dsh_runtime::control::{self, ControlEndpoint, HostEvent, ShellMessage, UpdateTasksAction};
use dsh_runtime::process_alive;
use dsh_runtime::supervisor::{SpawnPlan, Supervisor};

/// Re-exec entry: the fake Host (control-protocol twin of `runtime/adapter.mjs`).
#[test]
fn fake_host_main() {
    if std::env::var("DSH_FAKE_HOST").is_err() {
        return;
    }
    run_fake_host();
}

/// Re-exec entry: a grandchild that outlives its parent unless the tree kill
/// reaches it.
#[test]
fn fake_host_sleeper() {
    if std::env::var("DSH_FAKE_SLEEP").is_err() {
        return;
    }
    std::thread::sleep(Duration::from_secs(60));
}

/// The grandchild is deliberately left running on the unrequested-exit path: that
/// test asserts the supervisor records `Failed` and that its teardown still reaps
/// the tree, so reaping here would remove what the tree kill is meant to prove.
#[allow(clippy::zombie_processes)]
fn run_fake_host() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("runtime");
    runtime.block_on(async {
        if let Ok(code) = std::env::var("DSH_FAKE_HOST_EXIT_BEFORE_CONNECT") {
            let report = std::env::var("DSH_FAKE_HOST_REPORT").expect("report env");
            std::fs::write(report, std::process::id().to_string()).expect("write host pid");
            eprintln!("fixture startup failure diagnostic");
            std::process::exit(code.parse().unwrap_or(7));
        }
        if let Ok(delay) = std::env::var("DSH_FAKE_HOST_CONNECT_DELAY_MS") {
            if delay == "60000" {
                let report = std::env::var("DSH_FAKE_HOST_REPORT").expect("report env");
                std::fs::write(report, std::process::id().to_string()).expect("write host pid");
            }
            tokio::time::sleep(Duration::from_millis(delay.parse().unwrap_or(0))).await;
        }
        let endpoint = ControlEndpoint {
            socket_name: std::env::var("DSH_DESKTOP_CONTROL_SOCKET").expect("socket env"),
            token: std::env::var("DSH_DESKTOP_CONTROL_TOKEN").expect("token env"),
        };
        let mut channel = control::connect(&endpoint).await.expect("control connect");
        if let Ok(path) = std::env::var("DSH_FAKE_HOST_RUN_COUNT") {
            use std::io::Write;
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(path)
                .expect("run count");
            writeln!(file, "{}", std::process::id()).expect("record host run");
        }
        // Grandchild process that must not survive the tree teardown.
        let report = std::env::var("DSH_FAKE_HOST_REPORT").expect("report env");
        let mut grandchild = spawn_sleeper();
        std::fs::write(report, grandchild.id().to_string()).expect("write report");
        channel
            .send_event(&HostEvent::Ready {
                url: "http://127.0.0.1:19387/?token=fixture-only".into(),
                injections: Some(Vec::new()),
            })
            .await
            .expect("ready");
        // Unrequested-exit mode: reach `ready`, then die on our own, so a test can
        // observe how the supervisor records an exit it never asked for.
        if let Ok(code) = std::env::var("DSH_FAKE_HOST_EXIT_AFTER_READY") {
            let code: i32 = code.parse().unwrap_or(1);
            tokio::time::sleep(Duration::from_millis(150)).await;
            std::process::exit(code);
        }
        if std::env::var("DSH_FAKE_HOST_FATAL_AFTER_READY").is_ok() {
            channel
                .send_event(&HostEvent::Fatal {
                    message: "fixture fatal after ready".into(),
                    diagnostic: Some("fixture diagnostic".into()),
                })
                .await
                .expect("fatal event");
            tokio::time::sleep(Duration::from_secs(60)).await;
            return;
        }
        if std::env::var("DSH_FAKE_HOST_CONTROL_EOF").is_ok() {
            drop(channel);
            tokio::time::sleep(Duration::from_secs(60)).await;
            return;
        }
        let ignore_shutdown = std::env::var("DSH_FAKE_HOST_IGNORE_SHUTDOWN").is_ok();
        let silent = std::env::var("DSH_FAKE_HOST_SILENT").is_ok();
        while let Ok(Some(message)) = channel.recv_message().await {
            match message {
                ShellMessage::QuitInspection { request_id } => {
                    if silent {
                        continue;
                    }
                    channel
                        .send_event(&HostEvent::QuitInspection {
                            request_id,
                            active_tasks: false,
                            scheduled_tasks: true,
                            error: None,
                        })
                        .await
                        .expect("quit-inspection");
                }
                ShellMessage::UpdateTasks { request_id, action } => {
                    if silent {
                        continue;
                    }
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
                    if ignore_shutdown {
                        // Deliberately unresponsive: forces the tree escalation.
                        continue;
                    }
                    // Cooperative teardown: own children end before the ack.
                    let _ = grandchild.kill();
                    let _ = grandchild.wait();
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

/// The grandchild under test. It is deliberately killed by the tree teardown
/// being tested (or by the cooperative fake host) and its exit status is
/// asserted through `process_alive`, so an ordinary `wait()` per path would
/// fight the assertion; the harness reaps it.
#[allow(clippy::zombie_processes)]
fn spawn_sleeper() -> std::process::Child {
    std::process::Command::new(std::env::current_exe().expect("current exe"))
        .args([
            "fake_host_sleeper",
            "--exact",
            "fake_host_sleeper",
            "--nocapture",
        ])
        .env("DSH_FAKE_SLEEP", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .expect("spawn sleeper")
}

fn fake_host_plan(report: &std::path::Path, extra_env: &[(&str, &str)]) -> SpawnPlan {
    let mut env = std::collections::BTreeMap::new();
    env.insert("DSH_FAKE_HOST".to_string(), "1".to_string());
    env.insert(
        "DSH_FAKE_HOST_REPORT".to_string(),
        report.to_string_lossy().into_owned(),
    );
    for (key, value) in extra_env {
        env.insert((*key).to_string(), (*value).to_string());
    }
    SpawnPlan {
        program: std::env::current_exe().expect("current exe"),
        args: vec![
            "fake_host_main".to_string(),
            "--exact".to_string(),
            "fake_host_main".to_string(),
            "--nocapture".to_string(),
        ],
        cwd: std::env::temp_dir(),
        env,
        forward_stdout: false,
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_exit_before_connect_is_typed_prompt_and_reaped() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("host.pid");
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_EXIT_BEFORE_CONNECT", "7")]),
        None,
    );
    let started = std::time::Instant::now();
    let error = supervisor.start().await.expect_err("early exit must fail");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "must report exit before startup deadline"
    );
    let dsh_core::error::DshError::Other { code, message } = error else {
        panic!("expected typed child-exit error, got {error:?}");
    };
    assert_eq!(code, "host_startup_child_exit");
    assert!(message.contains('7'), "exit code missing: {message}");
    assert!(
        message.contains("fixture startup failure diagnostic"),
        "stderr tail missing: {message}"
    );
    let pid: u32 = std::fs::read_to_string(report)
        .expect("host pid")
        .parse()
        .expect("pid");
    assert!(!process_alive(pid), "failed startup child must be reaped");
    supervisor
        .stop(false)
        .await
        .expect("stop after startup failure");
}

#[tokio::test(flavor = "multi_thread")]
async fn startup_connection_after_delay_still_reaches_ready() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_CONNECT_DELAY_MS", "250")]),
        None,
    );
    assert!(supervisor
        .start()
        .await
        .expect("late connect")
        .url
        .contains("token="));
    supervisor.stop(false).await.expect("stop");
}

#[tokio::test(flavor = "multi_thread")]
async fn stop_immediately_after_start_reaps_unconnected_child() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("host.pid");
    let supervisor = std::sync::Arc::new(Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_CONNECT_DELAY_MS", "60000")]),
        None,
    ));
    let starting = {
        let supervisor = supervisor.clone();
        tokio::spawn(async move { supervisor.start().await })
    };
    tokio::time::timeout(Duration::from_secs(5), async {
        while !report.exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child started");
    supervisor
        .stop_with_graceful_deadline(Duration::from_millis(100), false)
        .await
        .expect("immediate stop");
    let _ = tokio::time::timeout(Duration::from_secs(2), starting)
        .await
        .expect("start task exits");
    let pid: u32 = std::fs::read_to_string(report)
        .expect("host pid")
        .parse()
        .expect("pid");
    assert!(!process_alive(pid), "stop must reap startup child");
}

/// Required acceptance test: the supervisor reaches `ready`, answers
/// `quit-inspection` (2 s deadline) and `update-tasks` (10 s deadline), and a
/// clean shutdown leaves no surviving children.
#[tokio::test(flavor = "multi_thread")]
async fn supervisor_ready_inspection_and_clean_shutdown_leave_no_children() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let supervisor = Supervisor::new(fake_host_plan(&report, &[]), None);
    let ready = supervisor.start().await.expect("start");
    assert!(
        ready.url.contains("token="),
        "ready carries the host authenticated URL"
    );
    assert_eq!(supervisor.status().state, RuntimeState::Ready);

    // Quit inspection reaches the host and fails closed only on timeout.
    let inspection = supervisor.quit_inspection().await;
    assert!(!inspection.active_tasks);
    assert!(inspection.scheduled_tasks);

    // Update-task control reaches the host (responses carry `active`).
    assert!(!supervisor
        .update_tasks(UpdateTasksAction::Inspect)
        .await
        .expect("inspect"));
    assert!(supervisor
        .update_tasks(UpdateTasksAction::Lock)
        .await
        .expect("lock"));
    assert!(!supervisor
        .update_tasks(UpdateTasksAction::Unlock)
        .await
        .expect("unlock"));

    let grandchild: u32 = std::fs::read_to_string(&report)
        .expect("report")
        .trim()
        .parse()
        .expect("pid");
    assert!(
        process_alive(grandchild),
        "grandchild runs while the host runs"
    );

    supervisor.stop(true).await.expect("clean stop");
    assert_eq!(supervisor.status().state, RuntimeState::Stopped);
    // No surviving children: the tree teardown reaped the grandchild too.
    assert!(
        !process_alive(grandchild),
        "grandchild must not survive a clean shutdown"
    );
}

/// The required orphan test: even when the Host ignores `shutdown` and leaves
/// its grandchild running, a forced stop cannot orphan it (Windows Job Object /
/// Unix process group), and the update handoff refuses the unclean exit.
#[tokio::test(flavor = "multi_thread")]
async fn forced_stop_cannot_orphan_a_grandchild() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_IGNORE_SHUTDOWN", "1")]),
        None,
    );
    supervisor.start().await.expect("start");
    let grandchild: u32 = std::fs::read_to_string(&report)
        .expect("report")
        .trim()
        .parse()
        .expect("pid");
    assert!(process_alive(grandchild));

    // Shortened graceful phase; the forced tree kill must still reap everything.
    let refused = supervisor
        .stop_with_graceful_deadline(Duration::from_millis(300), true)
        .await;
    assert!(
        refused.is_err(),
        "an unclean exit must refuse the update handoff"
    );
    assert!(
        !process_alive(grandchild),
        "a forced stop must not orphan a grandchild"
    );
}

/// Fail-closed quit inspection: a Host that misses the 2-second deadline is
/// treated as running tasks (contract `runtime_quit_inspection`).
#[tokio::test(flavor = "multi_thread")]
async fn quit_inspection_fails_closed_on_the_two_second_deadline() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_SILENT", "1")]),
        None,
    );
    supervisor.start().await.expect("start");
    let started = std::time::Instant::now();
    let inspection = supervisor.quit_inspection().await;
    assert!(
        inspection.active_tasks,
        "unknown work must fail closed to active tasks"
    );
    assert!(!inspection.scheduled_tasks);
    assert!(inspection.error.is_some());
    assert!(
        started.elapsed() < Duration::from_secs(6),
        "the two-second deadline must bound the wait"
    );
    supervisor
        .stop_with_graceful_deadline(Duration::from_millis(300), false)
        .await
        .expect("stop");
}

/// Unrequested `shutdown-complete` and malformed frames are protocol
/// violations; the correlated-response plumbing drops late responses.
#[tokio::test(flavor = "multi_thread")]
async fn control_responses_are_correlated_by_request_id() {
    use dsh_runtime::control::{connect, ControlServer};
    let endpoint = ControlEndpoint::generate();
    let server = ControlServer::bind(endpoint.clone()).await.expect("bind");
    let accept = tokio::spawn(async move { server.accept().await });
    let mut child = connect(&endpoint).await.expect("connect");
    let link = accept.await.expect("join").expect("accept");

    // Out-of-order responses resolve their own request only; a foreign
    // requestId is dropped as a late response.
    let (result, _answered) = tokio::join!(
        link.request(
            |id| ShellMessage::QuitInspection { request_id: id },
            Duration::from_secs(5),
        ),
        async {
            let message = child.recv_message().await.expect("recv").expect("request");
            let ShellMessage::QuitInspection { request_id } = message else {
                panic!("expected quit-inspection");
            };
            child
                .send_event(&HostEvent::QuitInspection {
                    request_id: 999,
                    active_tasks: true,
                    scheduled_tasks: true,
                    error: None,
                })
                .await
                .expect("late response");
            child
                .send_event(&HostEvent::QuitInspection {
                    request_id,
                    active_tasks: false,
                    scheduled_tasks: false,
                    error: None,
                })
                .await
                .expect("real response");
        }
    );
    let response = result.expect("correlated");
    assert!(
        matches!(
            response,
            HostEvent::QuitInspection {
                active_tasks: false,
                ..
            }
        ),
        "the real response resolves the waiter"
    );
}

/// An exit nobody asked for must not keep reporting `Ready`.
///
/// The exit monitor previously only woke status subscribers, leaving the state
/// at `Ready` after a mid-run crash, so every later command reported a dead host
/// as available. It must now record `Failed` with the exit code, while an
/// ordinary `Stopping`/`Stopped` transition is left untouched.
#[tokio::test(flavor = "multi_thread")]
async fn unrequested_host_exit_is_reported_as_failed() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let failures = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed_failures = failures.clone();
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_EXIT_AFTER_READY", "3")]),
        Some(Box::new(move |_| {
            observed_failures.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })),
    );
    supervisor.start().await.expect("start");
    assert_eq!(supervisor.status().state, RuntimeState::Ready);

    // The host dies on its own; the state must move to `Failed` promptly rather
    // than stay `Ready` forever.
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    loop {
        let status = supervisor.status();
        if status.state == RuntimeState::Failed {
            let message = status.last_error.unwrap_or_default();
            assert!(
                message.contains('3'),
                "the failure must name the host's exit code, got: {message}"
            );
            assert!(
                status.url.is_none(),
                "a failed runtime must not advertise a URL"
            );
            assert_eq!(
                failures.load(std::sync::atomic::Ordering::SeqCst),
                1,
                "unexpected exit invokes the failure callback exactly once"
            );
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "state stayed {:?} after an unrequested host exit",
            status.state
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    // Teardown must still succeed (and reap the tree) after an unrequested exit.
    supervisor
        .stop_with_graceful_deadline(Duration::from_millis(300), false)
        .await
        .expect("stop after an unrequested exit");
}

#[tokio::test(flavor = "multi_thread")]
async fn fatal_frame_after_ready_publishes_failed_and_calls_callback() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let failures = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = failures.clone();
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_FATAL_AFTER_READY", "1")]),
        Some(Box::new(move |_| {
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })),
    );
    supervisor.start().await.expect("host reaches ready first");
    tokio::time::timeout(Duration::from_secs(3), async {
        while supervisor.status().state != RuntimeState::Failed {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("fatal event is terminal");
    let status = supervisor.status();
    assert_eq!(status.state, RuntimeState::Failed);
    assert!(status.url.is_none());
    assert!(status
        .last_error
        .as_deref()
        .unwrap_or_default()
        .contains("fixture fatal after ready"));
    assert_eq!(failures.load(std::sync::atomic::Ordering::SeqCst), 1);
    supervisor
        .stop_with_graceful_deadline(Duration::from_millis(100), false)
        .await
        .expect("cleanup");
}

#[tokio::test(flavor = "multi_thread")]
async fn control_channel_eof_publishes_failed_and_calls_callback() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let failures = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let observed = failures.clone();
    let supervisor = Supervisor::new(
        fake_host_plan(&report, &[("DSH_FAKE_HOST_CONTROL_EOF", "1")]),
        Some(Box::new(move |_| {
            observed.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })),
    );
    supervisor.start().await.expect("host reaches ready first");
    tokio::time::timeout(Duration::from_secs(3), async {
        while supervisor.status().state != RuntimeState::Failed {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("control EOF is terminal");
    let status = supervisor.status();
    assert_eq!(status.state, RuntimeState::Failed);
    assert!(status.url.is_none());
    assert!(status
        .last_error
        .as_deref()
        .unwrap_or_default()
        .contains("control channel closed"));
    assert_eq!(failures.load(std::sync::atomic::Ordering::SeqCst), 1);
    supervisor
        .stop_with_graceful_deadline(Duration::from_millis(100), false)
        .await
        .expect("cleanup");
}

#[tokio::test(flavor = "multi_thread")]
async fn concurrent_start_callers_join_the_same_host_run() {
    let scratch = tempfile::tempdir().expect("tempdir");
    let report = scratch.path().join("grandchild.pid");
    let run_count = scratch.path().join("host-runs.txt");
    let run_count_env = run_count.to_string_lossy().into_owned();
    let supervisor = std::sync::Arc::new(Supervisor::new(
        fake_host_plan(
            &report,
            &[
                ("DSH_FAKE_HOST_CONNECT_DELAY_MS", "250"),
                ("DSH_FAKE_HOST_RUN_COUNT", &run_count_env),
            ],
        ),
        None,
    ));
    let (first, second) = tokio::join!(supervisor.start(), supervisor.start());
    let first = first.expect("first start joins run");
    let second = second.expect("second start joins run");
    assert_eq!(first.url, second.url);
    let runs = std::fs::read_to_string(&run_count).expect("one host run was recorded");
    assert_eq!(
        runs.lines().count(),
        1,
        "both callers must share one spawned Host"
    );
    let pid: u32 = std::fs::read_to_string(&report)
        .expect("child report")
        .trim()
        .parse()
        .expect("pid");
    assert!(process_alive(pid));
    supervisor.stop(false).await.expect("single run stops");
    assert!(!process_alive(pid));
}
