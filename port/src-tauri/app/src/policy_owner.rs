//! App-owned mandatory-policy decision and native routing coordinator.
//! Inert until the shell installs a native presenter and routes every entry point.

use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};

use tokio::sync::{broadcast, watch, Mutex as AsyncMutex};
use tokio::task::JoinHandle;

use crate::mandatory_update::{MandatoryDecision, PolicyScenario};
use crate::policy_runner::PolicyRunner;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NativeAction {
    Normal,
    Quit,
    PolicyRetry,
    MandatoryUpdate,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteVerdict {
    Allow,
    Deny,
}

pub trait PolicyEventSink: Send + Sync + 'static {
    fn present<'a>(
        &'a self,
        sequence: u64,
        decision: &'a MandatoryDecision,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>>;
}

trait PolicySource: Send + Sync + 'static {
    fn subscribe(&self) -> (MandatoryDecision, broadcast::Receiver<MandatoryDecision>);
    fn current(&self) -> MandatoryDecision;
    fn request(&self, scenario: PolicyScenario);
    fn dispose<'a>(&'a self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>>;
}
impl PolicySource for PolicyRunner {
    fn subscribe(&self) -> (MandatoryDecision, broadcast::Receiver<MandatoryDecision>) {
        PolicyRunner::subscribe(self)
    }
    fn current(&self) -> MandatoryDecision {
        PolicyRunner::current(self)
    }
    fn request(&self, scenario: PolicyScenario) {
        PolicyRunner::request(self, scenario)
    }
    fn dispose<'a>(&'a self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
        Box::pin(PolicyRunner::dispose(self))
    }
}

struct OwnerState {
    decision: MandatoryDecision,
    sequence: u64,
    presentation_failed: bool,
    disposed: bool,
    routes_changed: watch::Sender<u64>,
}
pub struct PolicyOwner {
    source: Arc<dyn PolicySource>,
    state: Arc<Mutex<OwnerState>>,
    consumer: AsyncMutex<Option<JoinHandle<()>>>,
    shutdown: watch::Sender<bool>,
}
impl PolicyOwner {
    pub fn new(runner: Arc<PolicyRunner>) -> Self {
        Self::from_source(runner)
    }
    fn from_source(source: Arc<dyn PolicySource>) -> Self {
        let decision = source.current();
        let (shutdown, _) = watch::channel(false);
        Self {
            source,
            state: Arc::new(Mutex::new(OwnerState {
                decision,
                sequence: 0,
                presentation_failed: false,
                disposed: false,
                routes_changed: watch::channel(0).0,
            })),
            consumer: AsyncMutex::new(None),
            shutdown,
        }
    }

    pub fn start_consumer(&self, sink: Arc<dyn PolicyEventSink>) -> Result<(), &'static str> {
        let mut slot = self.consumer.try_lock().map_err(|_| "consumer busy")?;
        {
            let mut owner = self.state.lock().unwrap();
            if owner.disposed {
                return Err("owner disposed");
            }
            if slot.is_some() {
                return Err("consumer already started");
            }
            owner.presentation_failed = true;
        }
        // Neither sources nor presentation callbacks run under the state lock.
        let (snapshot, mut events) = self.source.subscribe();
        let owner = self.state.lock().unwrap();
        if owner.disposed {
            return Err("owner disposed");
        }
        let source = self.source.clone();
        let state = self.state.clone();
        let mut shutdown = self.shutdown.subscribe();
        *slot = Some(tokio::spawn(async move {
            let _exit = ConsumerExit {
                state: state.clone(),
            };
            let mut next = Some(snapshot);
            loop {
                // changed() alone misses shutdown published before subscription/poll.
                if *shutdown.borrow() {
                    break;
                }
                if let Some(decision) = next.take() {
                    let sequence = {
                        let mut s = state.lock().unwrap();
                        if s.disposed {
                            break;
                        }
                        s.sequence = s.sequence.saturating_add(1);
                        s.decision = decision.clone();
                        s.presentation_failed = true;
                        s.sequence
                    };
                    let presentation = sink.present(sequence, &decision);
                    tokio::pin!(presentation);
                    tokio::select! {
                        biased;
                        changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                        received = events.recv() => match received {
                            Ok(value) => next = Some(value),
                            Err(broadcast::error::RecvError::Lagged(_)) => { let (latest, receiver) = source.subscribe(); events = receiver; next = Some(latest); }
                            Err(broadcast::error::RecvError::Closed) => break,
                        },
                        result = &mut presentation => acknowledge(&state, sequence, result),
                    }
                } else {
                    tokio::select! {
                        biased;
                        changed = shutdown.changed() => { if changed.is_err() || *shutdown.borrow() { break; } }
                        received = events.recv() => match received {
                            Ok(value) => next = Some(value),
                            Err(broadcast::error::RecvError::Lagged(_)) => { let (latest, receiver) = source.subscribe(); events = receiver; next = Some(latest); }
                            Err(broadcast::error::RecvError::Closed) => break,
                        }
                    }
                }
            }
        }));
        Ok(())
    }
    /// Fresh authoritative decision, never the presentation cache.
    pub fn current(&self) -> MandatoryDecision {
        self.source.current()
    }

    /// Event-driven startup navigation waits for native acknowledgment, not a timer.
    pub async fn wait_for_normal(&self) -> bool {
        let mut changes = self.state.lock().unwrap().routes_changed.subscribe();
        loop {
            if self.state.lock().unwrap().disposed {
                return false;
            }
            if self.route(NativeAction::Normal) == RouteVerdict::Allow {
                return true;
            }
            if changes.changed().await.is_err() {
                return false;
            }
        }
    }

    pub fn trigger(&self, scenario: PolicyScenario) {
        let disposed = self.state.lock().unwrap().disposed;
        if !disposed {
            self.source.request(scenario);
        }
    }
    pub fn route(&self, action: NativeAction) -> RouteVerdict {
        if action == NativeAction::Quit {
            return RouteVerdict::Allow;
        }
        // Authoritative blocking applies before the consumer handles its event.
        let blocking = self.source.current().blocking;
        let s = self.state.lock().unwrap();
        if s.disposed {
            return RouteVerdict::Deny;
        }
        if action == NativeAction::Normal
            && (blocking || s.decision.blocking || s.presentation_failed)
        {
            RouteVerdict::Deny
        } else {
            RouteVerdict::Allow
        }
    }
    pub async fn dispose(&self) {
        {
            let mut s = self.state.lock().unwrap();
            s.disposed = true;
            s.presentation_failed = true;
            s.routes_changed
                .send_modify(|revision| *revision = revision.saturating_add(1));
        }
        self.shutdown.send_replace(true);
        self.source.dispose().await;
        // Retain ownership throughout await: cancelling a disposer releases the
        // mutex but cannot drop/detach the consumer's JoinHandle.
        let mut task = self.consumer.lock().await;
        if let Some(handle) = task.as_mut() {
            if let Err(error) = handle.await {
                tracing::error!(%error, "mandatory policy consumer stopped unexpectedly");
            }
            *task = None;
        }
    }
}
struct ConsumerExit {
    state: Arc<Mutex<OwnerState>>,
}
impl Drop for ConsumerExit {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        if !state.disposed {
            state.presentation_failed = true;
            state
                .routes_changed
                .send_modify(|revision| *revision = revision.saturating_add(1));
        }
    }
}
fn acknowledge(state: &Mutex<OwnerState>, sequence: u64, result: Result<(), String>) {
    let mut s = state.lock().unwrap();
    if !s.disposed && s.sequence == sequence {
        s.presentation_failed = result.is_err();
        s.routes_changed
            .send_modify(|revision| *revision = revision.saturating_add(1));
    }
}
impl Drop for PolicyOwner {
    fn drop(&mut self) {
        let mut state = self.state.lock().unwrap();
        state.disposed = true;
        state
            .routes_changed
            .send_modify(|revision| *revision = revision.saturating_add(1));
        self.shutdown.send_replace(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::task::{Context, Poll, Waker};
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot};

    struct FakeState {
        decision: MandatoryDecision,
        events: Option<broadcast::Sender<MandatoryDecision>>,
    }
    type Hook = Arc<dyn Fn() + Send + Sync>;
    struct Fake {
        state: Mutex<FakeState>,
        disposed: AtomicUsize,
        requested: AtomicUsize,
        subscribe_hook: Mutex<Option<Hook>>,
        request_hook: Mutex<Option<Hook>>,
    }
    impl Fake {
        fn new(decision: MandatoryDecision) -> Arc<Self> {
            let (events, _) = broadcast::channel(16);
            Arc::new(Self {
                state: Mutex::new(FakeState {
                    decision,
                    events: Some(events),
                }),
                disposed: AtomicUsize::new(0),
                requested: AtomicUsize::new(0),
                subscribe_hook: Mutex::new(None),
                request_hook: Mutex::new(None),
            })
        }
        fn publish(&self, decision: MandatoryDecision) {
            let mut state = self.state.lock().unwrap();
            state.decision = decision.clone();
            if let Some(sender) = &state.events {
                let _ = sender.send(decision);
            }
        }
        fn close(&self) {
            self.state.lock().unwrap().events = None;
        }
    }
    impl PolicySource for Fake {
        fn subscribe(&self) -> (MandatoryDecision, broadcast::Receiver<MandatoryDecision>) {
            let hook = self.subscribe_hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
            let state = self.state.lock().unwrap();
            let receiver = match &state.events {
                Some(sender) => sender.subscribe(),
                None => {
                    let (sender, receiver) = broadcast::channel(16);
                    drop(sender);
                    receiver
                }
            };
            (state.decision.clone(), receiver)
        }
        fn current(&self) -> MandatoryDecision {
            self.state.lock().unwrap().decision.clone()
        }
        fn request(&self, _: PolicyScenario) {
            self.requested.fetch_add(1, Ordering::SeqCst);
            let hook = self.request_hook.lock().unwrap().clone();
            if let Some(hook) = hook {
                hook();
            }
        }
        fn dispose<'a>(&'a self) -> Pin<Box<dyn Future<Output = ()> + Send + 'a>> {
            Box::pin(async move {
                self.disposed.fetch_add(1, Ordering::SeqCst);
                self.close();
            })
        }
    }
    fn initial() -> MandatoryDecision {
        MandatoryDecision::initial()
    }
    fn blocked() -> MandatoryDecision {
        MandatoryDecision {
            blocking: true,
            ..initial()
        }
    }
    fn owner(fake: &Arc<Fake>) -> PolicyOwner {
        PolicyOwner::from_source(fake.clone())
    }
    async fn bounded<F: Future>(future: F) -> F::Output {
        tokio::time::timeout(Duration::from_secs(2), future)
            .await
            .expect("operation timed out")
    }

    struct Finished(Option<oneshot::Sender<()>>);
    impl Drop for Finished {
        fn drop(&mut self) {
            if let Some(sender) = self.0.take() {
                let _ = sender.send(());
            }
        }
    }
    struct Presented {
        sequence: u64,
        decision: MandatoryDecision,
        ack: oneshot::Sender<Result<(), String>>,
        finished: oneshot::Receiver<()>,
    }
    impl Presented {
        async fn complete(self, result: Result<(), String>) {
            self.ack
                .send(result)
                .expect("presentation unexpectedly cancelled");
            // Future destruction follows the consumer's acknowledgment branch.
            bounded(self.finished).await.unwrap();
        }
    }
    struct ControlledSink {
        started: mpsc::Sender<Presented>,
    }
    impl PolicyEventSink for ControlledSink {
        fn present<'a>(
            &'a self,
            sequence: u64,
            decision: &'a MandatoryDecision,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
            let decision = decision.clone();
            Box::pin(async move {
                let (ack, result) = oneshot::channel();
                let (done, finished) = oneshot::channel();
                let _finished = Finished(Some(done));
                self.started
                    .send(Presented {
                        sequence,
                        decision,
                        ack,
                        finished,
                    })
                    .await
                    .map_err(|_| "presenter closed")?;
                result
                    .await
                    .map_err(|_| "acknowledgment closed".to_string())?
            })
        }
    }
    fn controlled() -> (Arc<ControlledSink>, mpsc::Receiver<Presented>) {
        let (started, receiver) = mpsc::channel(8);
        (Arc::new(ControlledSink { started }), receiver)
    }
    async fn presented(receiver: &mut mpsc::Receiver<Presented>) -> Presented {
        bounded(receiver.recv()).await.expect("presenter stopped")
    }
    async fn join_consumer(owner: &PolicyOwner) -> Result<(), tokio::task::JoinError> {
        let mut slot = owner.consumer.lock().await;
        let result = bounded(slot.as_mut().expect("no consumer")).await;
        *slot = None;
        result
    }

    #[tokio::test]
    async fn navigation_waits_for_successful_ack_and_fresh_no_force() {
        let fake = Fake::new(blocked());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        let wait = owner.wait_for_normal();
        tokio::pin!(wait);
        assert!(matches!(
            std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        presented(&mut rx).await.complete(Ok(())).await;
        assert!(matches!(
            std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        fake.publish(initial());
        let no_force = presented(&mut rx).await;
        assert!(matches!(
            std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        no_force.complete(Ok(())).await;
        assert!(bounded(wait).await);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn navigation_wait_is_woken_and_denied_by_disposal() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        let _pending = presented(&mut rx).await;
        let wait = owner.wait_for_normal();
        tokio::pin!(wait);
        assert!(matches!(
            std::future::poll_fn(|cx| Poll::Ready(wait.as_mut().poll(cx))).await,
            Poll::Pending
        ));
        owner.dispose().await;
        assert!(!bounded(wait).await);
    }

    #[tokio::test]
    async fn pending_failed_and_successful_presentations_control_normal_routes() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        assert_eq!(owner.route(NativeAction::Quit), RouteVerdict::Allow);
        presented(&mut rx)
            .await
            .complete(Err("no presenter".into()))
            .await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        fake.publish(initial());
        presented(&mut rx).await.complete(Ok(())).await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Allow);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn authoritative_block_precedes_consumption_and_stale_ack_cannot_clear_it() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        let old = presented(&mut rx).await;
        fake.publish(blocked());
        assert!(!owner.state.lock().unwrap().decision.blocking);
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        let newest = presented(&mut rx).await;
        assert!(newest.sequence > old.sequence && newest.decision.blocking);
        assert!(old.ack.send(Ok(())).is_err());
        acknowledge(&owner.state, old.sequence, Ok(()));
        assert!(owner.state.lock().unwrap().presentation_failed);
        newest.complete(Ok(())).await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        fake.publish(initial());
        let clear = presented(&mut rx).await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        acknowledge(&owner.state, old.sequence, Ok(()));
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        clear.complete(Ok(())).await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Allow);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn lag_replaces_receiver_and_discards_buffered_no_force() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        let old = presented(&mut rx).await;
        for i in 0..40 {
            fake.publish(if i == 39 { blocked() } else { initial() });
        }
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        let newest = presented(&mut rx).await;
        assert!(newest.decision.blocking);
        newest.complete(Ok(())).await;
        assert!(rx.try_recv().is_err());
        assert!(old.ack.send(Ok(())).is_err());
        owner.dispose().await;
    }

    #[tokio::test]
    async fn newer_event_has_priority_over_ready_old_ack() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        let old = presented(&mut rx).await;
        // Both select branches become ready before this current-thread task yields.
        old.ack.send(Ok(())).unwrap();
        fake.publish(blocked());
        let newest = presented(&mut rx).await;
        assert!(newest.decision.blocking && newest.sequence > old.sequence);
        assert!(owner.state.lock().unwrap().presentation_failed);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn closed_source_after_successful_ack_joins_and_fails_closed() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        presented(&mut rx).await.complete(Ok(())).await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Allow);
        fake.close();
        join_consumer(&owner).await.unwrap();
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        assert_eq!(owner.route(NativeAction::Quit), RouteVerdict::Allow);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn shutdown_before_first_poll_skips_presentation_and_joins() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        owner.shutdown.send_replace(true);
        join_consumer(&owner).await.unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn cancelled_dispose_retains_same_handle_and_rejects_concurrent_start() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink.clone()).unwrap();
        let flight = presented(&mut rx).await;
        assert_eq!(
            owner.start_consumer(sink.clone()),
            Err("consumer already started")
        );
        let id = owner.consumer.try_lock().unwrap().as_ref().unwrap().id();
        let mut dispose = Box::pin(owner.dispose());
        let mut cx = Context::from_waker(Waker::noop());
        assert!(matches!(dispose.as_mut().poll(&mut cx), Poll::Pending));
        assert_eq!(owner.start_consumer(sink.clone()), Err("consumer busy"));
        drop(dispose);
        assert_eq!(
            owner.consumer.try_lock().unwrap().as_ref().unwrap().id(),
            id
        );
        assert_eq!(owner.start_consumer(sink), Err("owner disposed"));
        bounded(owner.dispose()).await;
        assert!(owner.consumer.try_lock().unwrap().is_none());
        assert!(flight.ack.send(Ok(())).is_err());
        assert_eq!(fake.disposed.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn concurrent_disposers_join_after_first_is_cancelled() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        let _flight = presented(&mut rx).await;
        let mut first = Box::pin(owner.dispose());
        let mut second = Box::pin(owner.dispose());
        let mut cx = Context::from_waker(Waker::noop());
        assert!(first.as_mut().poll(&mut cx).is_pending());
        assert!(second.as_mut().poll(&mut cx).is_pending());
        drop(first);
        bounded(second).await;
        assert!(owner.consumer.try_lock().unwrap().is_none());
    }

    struct Reentrant {
        owner: std::sync::Weak<PolicyOwner>,
        called: mpsc::Sender<()>,
    }
    impl PolicyEventSink for Reentrant {
        fn present<'a>(
            &'a self,
            _: u64,
            _: &'a MandatoryDecision,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
            let owner = self.owner.upgrade().unwrap();
            assert!(
                owner.state.try_lock().is_ok(),
                "callback ran under owner state lock"
            );
            let _ = owner.route(NativeAction::Normal);
            owner.trigger(PolicyScenario::Manual);
            self.called.try_send(()).unwrap();
            Box::pin(async { Ok(()) })
        }
    }
    #[tokio::test]
    async fn sink_and_source_callbacks_can_reenter_without_state_lock() {
        let fake = Fake::new(initial());
        let owner = Arc::new(owner(&fake));
        let weak = Arc::downgrade(&owner);
        let hook: Hook = Arc::new(move || {
            let owner = weak.upgrade().unwrap();
            assert!(
                owner.state.try_lock().is_ok(),
                "source callback held owner state lock"
            );
            let _ = owner.route(NativeAction::Normal);
        });
        *fake.subscribe_hook.lock().unwrap() = Some(hook.clone());
        *fake.request_hook.lock().unwrap() = Some(hook);
        let (called, mut rx) = mpsc::channel(1);
        owner
            .start_consumer(Arc::new(Reentrant {
                owner: Arc::downgrade(&owner),
                called,
            }))
            .unwrap();
        bounded(rx.recv()).await.unwrap();
        assert_eq!(fake.requested.load(Ordering::SeqCst), 1);
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Allow);
        owner.dispose().await;
    }

    struct PanicSink;
    impl PolicyEventSink for PanicSink {
        fn present<'a>(
            &'a self,
            _: u64,
            _: &'a MandatoryDecision,
        ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
            panic!("injected policy presentation panic");
        }
    }
    #[tokio::test]
    async fn presenter_panic_runs_exit_guard_and_fails_closed() {
        let fake = Fake::new(initial());
        let owner = owner(&fake);
        owner.start_consumer(Arc::new(PanicSink)).unwrap();
        assert!(join_consumer(&owner).await.unwrap_err().is_panic());
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        assert_eq!(owner.route(NativeAction::Quit), RouteVerdict::Allow);
        owner.dispose().await;
    }

    #[tokio::test]
    async fn errors_keep_blocking_and_disposal_denies_all_but_quit() {
        let fake = Fake::new(blocked());
        let owner = owner(&fake);
        let (sink, mut rx) = controlled();
        owner.start_consumer(sink).unwrap();
        presented(&mut rx).await.complete(Ok(())).await;
        fake.publish(MandatoryDecision {
            error: Some(crate::mandatory_update::PolicyError::Unavailable),
            ..blocked()
        });
        presented(&mut rx).await.complete(Ok(())).await;
        assert_eq!(owner.route(NativeAction::Normal), RouteVerdict::Deny);
        assert_eq!(owner.route(NativeAction::PolicyRetry), RouteVerdict::Allow);
        assert_eq!(
            owner.route(NativeAction::MandatoryUpdate),
            RouteVerdict::Allow
        );
        owner.trigger(PolicyScenario::Manual);
        owner.dispose().await;
        // Fake current() still blocks, exercising the formerly unsafe early return.
        for action in [
            NativeAction::Normal,
            NativeAction::PolicyRetry,
            NativeAction::MandatoryUpdate,
        ] {
            assert_eq!(owner.route(action), RouteVerdict::Deny);
        }
        assert_eq!(owner.route(NativeAction::Quit), RouteVerdict::Allow);
        owner.trigger(PolicyScenario::Manual);
        assert_eq!(fake.requested.load(Ordering::SeqCst), 1);
    }
}
