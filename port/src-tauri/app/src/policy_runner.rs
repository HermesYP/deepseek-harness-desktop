//! Independent mandatory-policy polling. The shell must install native blocking
//! enforcement before composing this runner; this module does not activate it.
//!
//! One owned task drives both the timer and HTTP future. Concurrent checks share
//! a reserved flight, including before the task is polled. Foreground/resume
//! keeps the deadline; only an explicit manual check bypasses it. Disposal closes
//! publications before cancelling the request and awaits the driver.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::sync::{broadcast, watch, Mutex as AsyncMutex, Notify};
use tokio::task::JoinHandle;
use tokio::time::Instant;

use crate::mandatory_update::{
    DesktopPolicyConfig, DesktopPolicyIdentity, MandatoryDecision, PolicyScenario, PolicySchedule,
};
use crate::policy_transport::{check_policy, PolicyClientMetadata, PolicyTransportError};

type PolicyFuture<'a> =
    Pin<Box<dyn Future<Output = Result<MandatoryDecision, PolicyTransportError>> + Send + 'a>>;
pub(super) type MetadataFuture<'a> =
    Pin<Box<dyn Future<Output = Result<PolicyClientMetadata, PolicyTransportError>> + Send + 'a>>;

/// Native request-time metadata. Implementations use trusted build identity and
/// sample locale and OS UTC offset; renderer values are not an authority.
pub(super) trait PolicyMetadataSource: Send + Sync {
    fn sample(&self) -> MetadataFuture<'_>;
}

trait PolicyExecutor: Send + Sync {
    /// Construct an inert future; request effects occur only when it is polled.
    fn execute(&self, scenario: PolicyScenario) -> PolicyFuture<'_>;
}

struct HttpPolicyExecutor {
    config: DesktopPolicyConfig,
    identity: DesktopPolicyIdentity,
    metadata: Arc<dyn PolicyMetadataSource>,
}

impl PolicyExecutor for HttpPolicyExecutor {
    fn execute(&self, scenario: PolicyScenario) -> PolicyFuture<'_> {
        Box::pin(async move {
            // Bound the complete operation, including native metadata sampling.
            // The transport keeps its own body deadline; this outer deadline
            // prevents a stalled metadata supplier from retaining a flight forever.
            tokio::time::timeout(Duration::from_millis(self.config.timeout_ms), async {
                let metadata = self.metadata.sample().await?;
                check_policy(&self.config, &self.identity, &metadata, scenario).await
            })
            .await
            .unwrap_or_else(|_| {
                Err(PolicyTransportError::Unavailable(
                    "desktop policy: complete check timed out".into(),
                ))
            })
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum PolicyRunError {
    Disposed,
    Stopped,
}

type CheckResult = Result<MandatoryDecision, PolicyRunError>;

/// One flight retains one terminal result; callers own their own watch receivers.
struct Flight {
    scenario: PolicyScenario,
    result: watch::Sender<Option<CheckResult>>,
}

impl Flight {
    fn new(scenario: PolicyScenario) -> Self {
        let (result, _) = watch::channel(None);
        Self { scenario, result }
    }

    /// Test-only observation seam over the flight's terminal result.
    ///
    /// The shell never awaits a check: `policy_retry` is fire-and-forget and the
    /// verdict reaches the UI through the publication channel, so there is no
    /// production caller to join with. The join itself is still the only way to
    /// observe a flight from the outside, so the lifecycle tests use it to
    /// order themselves against an in-flight check. Not compiled into the
    /// application.
    #[cfg(test)]
    async fn wait(&self) -> CheckResult {
        let mut receiver = self.result.subscribe();
        loop {
            let result = receiver.borrow_and_update().clone();
            if let Some(result) = result {
                return result;
            }
            if receiver.changed().await.is_err() {
                return Err(PolicyRunError::Stopped);
            }
        }
    }

    fn finish(&self, result: CheckResult) {
        self.result.send_replace(Some(result));
    }
}

struct State {
    decision: MandatoryDecision,
    schedule: PolicySchedule,
    flight: Option<Arc<Flight>>,
    disposed: bool,
    // Dropped at shutdown, so consumers do not wait on an open notification registry.
    publications: Option<broadcast::Sender<MandatoryDecision>>,
}

struct Shared {
    state: Mutex<State>,
    origin: Instant,
    wake: Notify,
    shutdown: watch::Sender<bool>,
    jitter: fn() -> f64,
}

/// How one check request was satisfied.
///
/// Carries no result: the driver reads the reserved flight straight out of
/// [`State`], and the application never awaits a check, so nothing in the
/// shipped binary would have a use for the outcome.
enum Requested {
    /// The runner is disposed and will never run another check.
    Disposed,
    /// The armed deadline stands; the current decision is unchanged.
    NotDue,
    /// A check is in flight, or one was just reserved for this request.
    Flight,
}

enum DriverAction {
    Stop,
    Run(Arc<Flight>),
    Wait(Duration),
}

impl Shared {
    fn now_ms(&self) -> u64 {
        self.origin.elapsed().as_millis().min(u64::MAX as u128) as u64
    }

    fn publish(state: &State) {
        if let Some(sender) = &state.publications {
            let _ = sender.send(state.decision.clone());
        }
    }

    fn reserve(state: &mut State, scenario: PolicyScenario) -> Arc<Flight> {
        let flight = Arc::new(Flight::new(scenario));
        state.flight = Some(flight.clone());
        state.decision = state.decision.checking();
        Self::publish(state);
        flight
    }

    fn request(&self, scenario: PolicyScenario, manual: bool) -> Requested {
        let mut state = self.state.lock().unwrap();
        if state.disposed {
            return Requested::Disposed;
        }
        if state.flight.is_some() {
            // Concurrent requests share the one in-flight check.
            return Requested::Flight;
        }
        // The scenario is diagnostic; only the explicit manual flag bypasses.
        let scheduling = if manual {
            PolicyScenario::Manual
        } else {
            PolicyScenario::Periodic
        };
        if !state.schedule.begin(scheduling, self.now_ms()) {
            return Requested::NotDue;
        }
        Self::reserve(&mut state, scenario);
        // Notify retains a permit if the driver has not begun waiting yet.
        self.wake.notify_one();
        Requested::Flight
    }

    fn next_action(&self) -> DriverAction {
        let mut state = self.state.lock().unwrap();
        if state.disposed {
            return DriverAction::Stop;
        }
        if let Some(flight) = &state.flight {
            return DriverAction::Run(flight.clone());
        }
        let now = self.now_ms();
        // Launch was reserved by the constructor; subsequent timer checks are periodic.
        if state.schedule.begin(PolicyScenario::Periodic, now) {
            return DriverAction::Run(Self::reserve(&mut state, PolicyScenario::Periodic));
        }
        DriverAction::Wait(Duration::from_millis(
            state.schedule.next_check_ms().unwrap().saturating_sub(now),
        ))
    }

    fn complete(
        &self,
        flight: &Arc<Flight>,
        outcome: Result<MandatoryDecision, PolicyTransportError>,
    ) {
        let random = (self.jitter)();
        let mut state = self.state.lock().unwrap();
        if state.disposed
            || !state
                .flight
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, flight))
        {
            return;
        }
        let failed = outcome.is_err();
        let decision = crate::policy_transport::retain_result(&state.decision, outcome);
        state.decision = decision;
        state.schedule.complete(!failed, self.now_ms(), random);
        state.flight = None;
        // Lifecycle and publication are serialized; disposal cannot interleave
        // between the ownership check and notification of this committed result.
        Self::publish(&state);
        flight.finish(Ok(state.decision.clone()));
    }

    fn close(&self, error: PolicyRunError) {
        let mut state = self.state.lock().unwrap();
        if state.disposed {
            return;
        }
        state.disposed = true;
        state.schedule.dispose();
        drop(state.publications.take());
        if let Some(flight) = state.flight.take() {
            flight.finish(Err(error));
        }
        self.shutdown.send_replace(true);
        self.wake.notify_one();
    }
}

struct DriverExit(Arc<Shared>);

impl Drop for DriverExit {
    fn drop(&mut self) {
        // Also settle joiners if an executor panics or the runtime drops the task.
        self.0.close(PolicyRunError::Stopped);
    }
}

async fn drive(
    shared: Arc<Shared>,
    executor: Arc<dyn PolicyExecutor>,
    mut shutdown: watch::Receiver<bool>,
) {
    let _exit = DriverExit(shared.clone());
    loop {
        let wake = shared.wake.notified();
        tokio::pin!(wake);
        wake.as_mut().enable();
        match shared.next_action() {
            DriverAction::Stop => return,
            DriverAction::Run(flight) => {
                let outcome = tokio::select! {
                    biased;
                    _ = shutdown.changed() => return,
                    outcome = executor.execute(flight.scenario) => outcome,
                };
                shared.complete(&flight, outcome);
            }
            DriverAction::Wait(duration) => {
                tokio::select! {
                    biased;
                    _ = shutdown.changed() => return,
                    _ = &mut wake => {},
                    _ = tokio::time::sleep(duration) => {},
                }
            }
        }
    }
}

/// Application-owned policy task. Construct inside a Tokio runtime. Dropping
/// signals cancellation only; the application must await `dispose` for quiescence.
pub(super) struct PolicyRunner {
    shared: Arc<Shared>,
    task: AsyncMutex<Option<JoinHandle<()>>>,
}

impl PolicyRunner {
    /// Compose real transport with a separately sourced bundled runtime identity.
    /// This does not install enforcement and must not be called before it exists.
    pub fn spawn_http(
        config: DesktopPolicyConfig,
        identity: DesktopPolicyIdentity,
        metadata: Arc<dyn PolicyMetadataSource>,
    ) -> Result<Self, String> {
        identity.validate()?;
        let executor = Arc::new(HttpPolicyExecutor {
            config: config.clone(),
            identity,
            metadata,
        });
        Ok(Self::spawn(config, executor, jitter_sample))
    }

    fn spawn(
        config: DesktopPolicyConfig,
        executor: Arc<dyn PolicyExecutor>,
        jitter: fn() -> f64,
    ) -> Self {
        let (publications, _) = broadcast::channel(16);
        let (shutdown, receiver) = watch::channel(false);
        let shared = Arc::new(Shared {
            state: Mutex::new(State {
                decision: MandatoryDecision::initial(),
                schedule: PolicySchedule::new(config),
                flight: None,
                disposed: false,
                publications: Some(publications),
            }),
            origin: Instant::now(),
            wake: Notify::new(),
            shutdown,
            jitter,
        });
        // Reserve before spawning: an immediate manual caller joins launch.
        shared.request(PolicyScenario::Launch, false);
        let task = tokio::spawn(drive(shared.clone(), executor, receiver));
        Self {
            shared,
            task: AsyncMutex::new(Some(task)),
        }
    }

    /// Join an existing check, otherwise respect the deadline unless manual.
    /// Dropping this caller's future does not cancel the application-owned check.
    ///
    /// Test-only; see [`Flight::wait`]. The shell's retry path is event-driven
    /// and never awaits a check result.
    #[cfg(test)]
    pub async fn check(&self, scenario: PolicyScenario, manual: bool) -> CheckResult {
        match self.shared.request(scenario, manual) {
            Requested::Disposed => Err(PolicyRunError::Disposed),
            Requested::NotDue => Ok(self.current()),
            Requested::Flight => {
                let flight = self
                    .shared
                    .state
                    .lock()
                    .unwrap()
                    .flight
                    .clone()
                    .expect("a flight request always leaves one reserved");
                flight.wait().await
            }
        }
    }

    /// Native focus/resume notification; never resets the interval or backoff.
    pub fn request(&self, scenario: PolicyScenario) {
        let _ = self
            .shared
            .request(scenario, scenario == PolicyScenario::Manual);
    }

    pub fn current(&self) -> MandatoryDecision {
        self.shared.state.lock().unwrap().decision.clone()
    }

    /// Subscribe and sample atomically. On receiver lag, read `current` rather
    /// than interpreting missing notifications as permission to clear a block.
    pub fn subscribe(&self) -> (MandatoryDecision, broadcast::Receiver<MandatoryDecision>) {
        let state = self.shared.state.lock().unwrap();
        let receiver = match &state.publications {
            Some(sender) => sender.subscribe(),
            None => {
                let (sender, receiver) = broadcast::channel(1);
                drop(sender);
                receiver
            }
        };
        (state.decision.clone(), receiver)
    }

    /// Final, idempotent shutdown. Concurrent callers all wait for the task to
    /// settle; publications are closed before the owned request future is dropped.
    pub async fn dispose(&self) {
        self.shared.close(PolicyRunError::Disposed);
        let mut task = self.task.lock().await;
        // Keep the handle in the owner while awaiting it. If this disposer is
        // cancelled, a later disposer must still be able to join the driver.
        if let Some(handle) = task.as_mut() {
            if let Err(error) = handle.await {
                tracing::error!(%error, "mandatory policy task stopped unexpectedly");
            }
            *task = None;
        }
    }
}

impl Drop for PolicyRunner {
    fn drop(&mut self) {
        self.shared.close(PolicyRunError::Disposed);
    }
}

fn jitter_sample() -> f64 {
    let random = uuid::Uuid::new_v4();
    let bits = u64::from_le_bytes(random.as_bytes()[8..].try_into().unwrap()) >> 11;
    bits as f64 / ((1_u64 << 53) as f64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tokio::sync::{mpsc, oneshot};

    struct Request {
        scenario: PolicyScenario,
        finish: oneshot::Sender<Result<MandatoryDecision, PolicyTransportError>>,
    }

    struct Executor {
        requests: mpsc::UnboundedSender<Request>,
        dropped: Arc<AtomicUsize>,
    }

    struct RequestDrop(Arc<AtomicUsize>);
    impl Drop for RequestDrop {
        fn drop(&mut self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl PolicyExecutor for Executor {
        fn execute(&self, scenario: PolicyScenario) -> PolicyFuture<'_> {
            Box::pin(async move {
                let _guard = RequestDrop(self.dropped.clone());
                let (finish, outcome) = oneshot::channel();
                self.requests.send(Request { scenario, finish }).unwrap();
                outcome.await.unwrap_or_else(|_| {
                    Err(PolicyTransportError::Unavailable("fixture closed".into()))
                })
            })
        }
    }

    fn config() -> DesktopPolicyConfig {
        crate::mandatory_update::resolve_policy_config(
            Some(&serde_json::json!({
                "origin": "https://policy.example.test",
                "allowedPageOrigins": ["https://download.example.test"],
                "intervalMs": 1000, "timeoutMs": 1000, "maxBackoffMs": 8000, "jitter": 0
            })),
            false,
        )
        .unwrap()
        .unwrap()
    }

    fn fixture() -> (
        PolicyRunner,
        mpsc::UnboundedReceiver<Request>,
        Arc<AtomicUsize>,
    ) {
        let (requests, receiver) = mpsc::unbounded_channel();
        let dropped = Arc::new(AtomicUsize::new(0));
        let executor = Arc::new(Executor {
            requests,
            dropped: dropped.clone(),
        });
        (
            PolicyRunner::spawn(config(), executor, || 0.0),
            receiver,
            dropped,
        )
    }

    fn blocked() -> MandatoryDecision {
        MandatoryDecision {
            blocking: true,
            title: Some("Required".into()),
            ..MandatoryDecision::initial()
        }
    }

    async fn finish(
        runner: &PolicyRunner,
        request: Request,
        outcome: Result<MandatoryDecision, PolicyTransportError>,
    ) -> MandatoryDecision {
        let join = runner.check(PolicyScenario::Manual, true);
        tokio::pin!(join);
        // Register this waiter before the result becomes ready.
        assert!(tokio::time::timeout(Duration::ZERO, &mut join)
            .await
            .is_err());
        request.finish.send(outcome).unwrap();
        join.await.unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn launch_is_reserved_before_polling_and_manual_callers_join() {
        let (runner, mut requests, _) = fixture();
        let first = runner.check(PolicyScenario::Manual, true);
        let second = runner.check(PolicyScenario::Manual, true);
        tokio::pin!(first, second);
        assert!(tokio::time::timeout(Duration::ZERO, &mut first)
            .await
            .is_err());
        assert!(tokio::time::timeout(Duration::ZERO, &mut second)
            .await
            .is_err());
        let request = requests.recv().await.unwrap();
        assert_eq!(request.scenario, PolicyScenario::Launch);
        request.finish.send(Ok(blocked())).unwrap();
        assert_eq!(first.await.unwrap(), blocked());
        assert_eq!(second.await.unwrap(), blocked());
        assert!(requests.try_recv().is_err());
        runner.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn completion_arms_interval_and_focus_does_not_move_it() {
        let (runner, mut requests, _) = fixture();
        let request = requests.recv().await.unwrap();
        tokio::time::advance(Duration::from_millis(500)).await;
        finish(&runner, request, Ok(blocked())).await;
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            Some(1500)
        );
        tokio::time::advance(Duration::from_millis(900)).await;
        runner.request(PolicyScenario::ForegroundOrResume);
        assert_eq!(
            runner
                .check(PolicyScenario::ForegroundOrResume, false)
                .await
                .unwrap(),
            blocked()
        );
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            Some(1500)
        );
        assert!(requests.try_recv().is_err());
        tokio::time::advance(Duration::from_millis(100)).await;
        let request = requests.recv().await.unwrap();
        assert_eq!(request.scenario, PolicyScenario::Periodic);
        finish(&runner, request, Ok(MandatoryDecision::initial())).await;
        runner.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn failures_keep_block_backoff_and_only_fresh_success_clears() {
        let (runner, mut requests, _) = fixture();
        let launch = requests.recv().await.unwrap();
        finish(&runner, launch, Ok(blocked())).await;
        let join = runner.check(PolicyScenario::Manual, true);
        tokio::pin!(join);
        assert!(tokio::time::timeout(Duration::ZERO, &mut join)
            .await
            .is_err());
        let request = requests.recv().await.unwrap();
        assert_eq!(request.scenario, PolicyScenario::Manual);
        request
            .finish
            .send(Err(PolicyTransportError::Unavailable("offline".into())))
            .unwrap();
        let retained = join.await.unwrap();
        assert!(retained.blocking);
        assert!(!retained.checking);
        assert!(retained.error.is_some());
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            Some(2000)
        );
        runner.request(PolicyScenario::ForegroundOrResume);
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            Some(2000)
        );
        tokio::time::advance(Duration::from_millis(2000)).await;
        let retry = requests.recv().await.unwrap();
        finish(&runner, retry, Ok(MandatoryDecision::initial())).await;
        assert!(!runner.current().blocking);
        assert_eq!(runner.shared.state.lock().unwrap().schedule.failures(), 0);
        runner.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn caller_cancellation_does_not_cancel_owned_request() {
        let (runner, mut requests, dropped) = fixture();
        let request = requests.recv().await.unwrap();
        {
            let join = runner.check(PolicyScenario::Manual, true);
            tokio::pin!(join);
            assert!(tokio::time::timeout(Duration::ZERO, &mut join)
                .await
                .is_err());
        }
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
        finish(&runner, request, Ok(blocked())).await;
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        runner.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn concurrent_disposal_closes_events_cancels_and_awaits_request() {
        let (runner, mut requests, dropped) = fixture();
        let request = requests.recv().await.unwrap();
        let (_, mut events) = runner.subscribe();
        let waiter = runner.check(PolicyScenario::Manual, true);
        tokio::pin!(waiter);
        assert!(tokio::time::timeout(Duration::ZERO, &mut waiter)
            .await
            .is_err());
        tokio::join!(runner.dispose(), runner.dispose());
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(waiter.await, Err(PolicyRunError::Disposed));
        assert!(request.finish.send(Ok(blocked())).is_err());
        assert_eq!(
            events.recv().await.unwrap_err(),
            broadcast::error::RecvError::Closed
        );
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            None
        );
        tokio::time::advance(Duration::from_secs(100)).await;
        assert!(requests.try_recv().is_err());
        assert_eq!(
            runner.check(PolicyScenario::Manual, true).await,
            Err(PolicyRunError::Disposed)
        );
        let (_, mut after) = runner.subscribe();
        assert_eq!(
            after.recv().await.unwrap_err(),
            broadcast::error::RecvError::Closed
        );
    }

    #[tokio::test(start_paused = true)]
    async fn disposal_before_first_poll_has_no_request_effects() {
        let (runner, mut requests, dropped) = fixture();
        runner.dispose().await;
        assert!(requests.try_recv().is_err());
        assert_eq!(dropped.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn disposed_completion_cannot_publish_or_rearm() {
        let (runner, mut requests, _) = fixture();
        let request = requests.recv().await.unwrap();
        let flight = runner.shared.state.lock().unwrap().flight.clone().unwrap();
        let (before, mut events) = runner.subscribe();
        runner.shared.close(PolicyRunError::Disposed);
        // Exercise the production commit guard, not only future cancellation.
        runner.shared.complete(&flight, Ok(blocked()));
        assert_eq!(runner.current(), before);
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            None
        );
        assert_eq!(
            events.recv().await.unwrap_err(),
            broadcast::error::RecvError::Closed
        );
        runner.dispose().await;
        assert!(request.finish.send(Ok(blocked())).is_err());
    }

    struct PanickingExecutor;
    impl PolicyExecutor for PanickingExecutor {
        fn execute(&self, _: PolicyScenario) -> PolicyFuture<'_> {
            Box::pin(async { panic!("controlled executor panic") })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn driver_panic_settles_joiners_and_closes_notifications() {
        let runner = PolicyRunner::spawn(config(), Arc::new(PanickingExecutor), || 0.0);
        let (_, mut events) = runner.subscribe();
        assert_eq!(
            runner.check(PolicyScenario::Manual, true).await,
            Err(PolicyRunError::Stopped)
        );
        assert_eq!(
            events.recv().await.unwrap_err(),
            broadcast::error::RecvError::Closed
        );
        runner.dispose().await;
        assert!(runner.shared.state.lock().unwrap().disposed);
    }

    struct SampledMetadata(AtomicUsize);
    impl PolicyMetadataSource for SampledMetadata {
        fn sample(&self) -> MetadataFuture<'_> {
            Box::pin(async move {
                let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
                Ok(PolicyClientMetadata {
                    version: "2.4.0".into(),
                    locale: if first {
                        dsh_core::protocol::LocaleId::En
                    } else {
                        dsh_core::protocol::LocaleId::Zh
                    },
                    timezone_offset_seconds: if first { 19800 } else { -18000 },
                })
            })
        }
    }

    #[tokio::test]
    async fn http_composition_samples_each_request_and_keeps_version_identities_separate() {
        use crate::mandatory_update::{PolicyArch, PolicyPlatform};
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let mut headers = Vec::new();
            for body in [
                r#"{"code":40005}"#,
                r#"{"code":0,"data":{"biz_code":0,"biz_data":null}}"#,
            ] {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let byte = socket.read_u8().await.unwrap();
                    request.push(byte);
                    assert!(request.len() <= 16_384);
                }
                headers.push(String::from_utf8(request).unwrap().to_ascii_lowercase());
                socket.write_all(format!(
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(), body,
                ).as_bytes()).await.unwrap();
            }
            headers
        });
        let config = crate::mandatory_update::resolve_policy_config(
            Some(&serde_json::json!({
                "origin": format!("http://{address}"),
                "allowedPageOrigins": ["https://download.example.test"],
                "intervalMs": 600_000, "timeoutMs": 5000, "jitter": 0,
            })),
            true,
        )
        .unwrap()
        .unwrap();
        let metadata = Arc::new(SampledMetadata(AtomicUsize::new(0)));
        let runner = PolicyRunner::spawn_http(
            config,
            DesktopPolicyIdentity {
                platform: PolicyPlatform::Win32,
                arch: PolicyArch::X64,
                bundled_dsh_version: "1.5.0".into(),
            },
            metadata.clone(),
        )
        .unwrap();
        let first = tokio::time::timeout(
            Duration::from_secs(10),
            runner.check(PolicyScenario::Launch, false),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(first.blocking, "{first:?}");
        let second = tokio::time::timeout(
            Duration::from_secs(10),
            runner.check(PolicyScenario::Manual, true),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(!second.blocking, "{second:?}");
        runner.dispose().await;
        let headers = tokio::time::timeout(Duration::from_secs(10), server)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(metadata.0.load(Ordering::SeqCst), 2);
        assert!(headers[0].starts_with("get /api/v0/check_client_update?scenario=launch "));
        assert!(headers[1].starts_with("get /api/v0/check_client_update?scenario=manual "));
        for header in &headers {
            assert!(header.contains("x-client-version: 2.4.0\r\n"));
            assert!(header.contains("x-client-bundled-dsh-version: 1.5.0\r\n"));
            assert!(header.contains("x-client-platform: desktop-win\r\n"));
            assert!(!header.contains("authorization:"));
            assert!(!header.contains("cookie:"));
        }
        assert!(headers[0].contains("x-client-locale: en_us\r\n"));
        assert!(headers[0].contains("x-client-timezone-offset: 19800\r\n"));
        assert!(headers[1].contains("x-client-locale: zh_cn\r\n"));
        assert!(headers[1].contains("x-client-timezone-offset: -18000\r\n"));
    }

    #[tokio::test(start_paused = true)]
    async fn cancelled_disposer_retains_handle_for_the_next_disposer() {
        let (runner, mut requests, dropped) = fixture();
        let request = requests.recv().await.unwrap();
        {
            let disposing = runner.dispose();
            tokio::pin!(disposing);
            std::future::poll_fn(|context| {
                assert!(disposing.as_mut().poll(context).is_pending());
                assert!(runner.shared.state.lock().unwrap().disposed);
                assert!(
                    runner.task.try_lock().is_err(),
                    "disposer must own the join mutex at its pending await"
                );
                std::task::Poll::Ready(())
            })
            .await;
            // Drop the disposer only after proving it entered its pending join.
        }
        assert!(
            runner.task.lock().await.is_some(),
            "cancellation must not detach the owned handle"
        );
        runner.dispose().await;
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert!(runner.task.lock().await.is_none());
        assert!(request.finish.send(Ok(blocked())).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_manual_request_bypasses_the_deadline_and_keeps_its_own_scenario() {
        let (runner, mut requests, _) = fixture();
        let request = requests.recv().await.unwrap();
        finish(&runner, request, Ok(blocked())).await;
        // A foreground/resume wake re-evaluates the armed deadline and does not
        // start a check, whatever the current verdict is.
        assert_eq!(
            runner
                .check(PolicyScenario::ForegroundOrResume, false)
                .await
                .unwrap(),
            blocked()
        );
        assert!(requests.try_recv().is_err());
        // Only the explicit manual flag bypasses. The request still carries the
        // caller's own scenario, because the scenario is diagnostic and the
        // deadline rule is decided by `manual` alone.
        let join = runner.check(PolicyScenario::ForegroundOrResume, true);
        tokio::pin!(join);
        assert!(tokio::time::timeout(Duration::ZERO, &mut join)
            .await
            .is_err());
        let request = requests.recv().await.unwrap();
        assert_eq!(request.scenario, PolicyScenario::ForegroundOrResume);
        request
            .finish
            .send(Ok(MandatoryDecision::initial()))
            .unwrap();
        assert!(!join.await.unwrap().blocking);
        runner.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn repeated_failures_back_off_and_cap_independently_of_feed_polling() {
        let (runner, mut requests, _) = fixture();
        for delay in [2000, 4000, 8000, 8000] {
            let request = requests.recv().await.unwrap();
            let completed_at = runner.shared.now_ms();
            finish(
                &runner,
                request,
                Err(PolicyTransportError::Unavailable("offline".into())),
            )
            .await;
            assert_eq!(
                runner.shared.state.lock().unwrap().schedule.next_check_ms(),
                Some(completed_at + delay)
            );
            runner.request(PolicyScenario::ForegroundOrResume);
            assert!(requests.try_recv().is_err());
            tokio::time::advance(Duration::from_millis(delay)).await;
        }
        runner.dispose().await;
    }

    #[tokio::test(start_paused = true)]
    async fn lagging_subscriber_reads_the_latest_authoritative_verdict() {
        let (runner, mut requests, _) = fixture();
        let request = requests.recv().await.unwrap();
        finish(&runner, request, Ok(blocked())).await;
        let (snapshot, mut events) = runner.subscribe();
        assert_eq!(snapshot, blocked());
        for _ in 0..20 {
            let join = runner.check(PolicyScenario::Manual, true);
            tokio::pin!(join);
            assert!(tokio::time::timeout(Duration::ZERO, &mut join)
                .await
                .is_err());
            let request = requests.recv().await.unwrap();
            request.finish.send(Ok(blocked())).unwrap();
            join.await.unwrap();
        }
        assert!(matches!(
            events.recv().await,
            Err(broadcast::error::RecvError::Lagged(_))
        ));
        assert_eq!(runner.current(), blocked());
        runner.dispose().await;
    }

    struct StalledMetadata(Arc<AtomicUsize>);
    impl PolicyMetadataSource for StalledMetadata {
        fn sample(&self) -> MetadataFuture<'_> {
            Box::pin(async move {
                let _drop = RequestDrop(self.0.clone());
                std::future::pending().await
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn stalled_metadata_has_a_complete_operation_deadline() {
        use crate::mandatory_update::{PolicyArch, PolicyPlatform};
        let dropped = Arc::new(AtomicUsize::new(0));
        let runner = PolicyRunner::spawn_http(
            config(),
            DesktopPolicyIdentity {
                platform: PolicyPlatform::Win32,
                arch: PolicyArch::X64,
                bundled_dsh_version: "1.5.0".into(),
            },
            Arc::new(StalledMetadata(dropped.clone())),
        )
        .unwrap();
        let decision = runner.check(PolicyScenario::Launch, false).await.unwrap();
        assert!(decision.error.is_some());
        assert!(!decision.checking);
        assert_eq!(dropped.load(Ordering::SeqCst), 1);
        assert_eq!(runner.shared.now_ms(), 1000);
        assert_eq!(
            runner.shared.state.lock().unwrap().schedule.next_check_ms(),
            Some(3000)
        );
        runner.dispose().await;
    }

    #[test]
    fn random_samples_are_in_half_open_unit_interval() {
        for _ in 0..1000 {
            let sample = jitter_sample();
            assert!((0.0..1.0).contains(&sample));
        }
    }
}
