//! Callback-to-async native dialog results and retained-operation ownership.
//!
//! Two rules this module exists to make structural rather than conventional:
//!
//! - **A native dialog is never waited on synchronously.** [`answer`] converts
//!   Tauri's callback API into a future that the runtime can park, so no Tokio
//!   worker is blocked while the user decides. A dialog that is never answered
//!   because the callback was dropped yields `None`, which is *not consent*:
//!   every caller treats `None` as "no answer", never as "yes".
//! - **Nothing borrowed from application state is held across the dialog.** The
//!   prompt text and button labels are read (and copied) *before* [`answer`] is
//!   awaited; the closure it takes receives only the reply sink, so a state lock
//!   cannot be alive while the user decides. Dropping a waiter does not dismiss a
//!   native dialog: [`retained`] and [`RetainedOwner`] run the admitted
//!   operation to completion even when the caller's wait is cancelled.

use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// One native prompt's answer, as the runtime sees it.
///
/// `None` is a dropped callback — the dialog was dismissed without an answer, or
/// the platform never delivered one. It is deliberately indistinguishable from
/// "no", but never from "yes": no caller may treat it as consent.
pub async fn answer<T: Send + 'static>(
    show: impl FnOnce(Box<dyn FnOnce(T) + Send + 'static>),
) -> Option<T> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    show(Box::new(move |value| {
        let _ = sender.send(value);
    }));
    receiver.await.ok()
}

/// A caller cancelling its wait must not cancel an admitted quit operation or
/// strand its coalescing state. Tokio JoinHandle drop detaches, not aborts.
pub async fn retained<T, F>(operation: F) -> Result<T, tokio::task::JoinError>
where
    T: Send + 'static,
    F: Future<Output = T> + Send + 'static,
{
    tokio::spawn(operation).await
}

/// A retained operation whose completion is *observed*, never assumed.
///
/// `tokio::spawn`'s handle drop detaches the task, so dropping a `RetainedOwner`
/// does **not** stop the work — and it does not observe it either. A `Drop` cannot
/// await, so this type does not pretend otherwise: dropping without [`join`]
/// records a delivery failure (a log and an unset observation flag) instead of
/// claiming the work finished. That is the honest counterpart to
/// [`tokio::task::JoinHandle`]'s detach-on-drop, and the reason a caller that
/// needs a guarantee must `join` (or await its own completion signal).
///
/// Operating-system serialization that must be *released* rather than merely
/// dropped (a Host admission unlock, an installer lease) therefore belongs in an
/// operation that is joined at shutdown, not in a `Drop` body.
///
/// [`join`]: RetainedOwner::join
pub struct RetainedOwner<T> {
    handle: tokio::task::JoinHandle<T>,
    observed: Arc<AtomicBool>,
}

impl<T> RetainedOwner<T> {
    /// Start `operation` in a retained task.
    pub fn start<F>(operation: F) -> Self
    where
        T: Send + 'static,
        F: Future<Output = T> + Send + 'static,
    {
        Self {
            handle: tokio::spawn(operation),
            observed: Arc::new(AtomicBool::new(false)),
        }
    }

    /// A handle to this owner's observation flag, for diagnostics and tests.
    ///
    /// It stays `false` when the owner is dropped without [`join`], which is what
    /// makes "the completion was not observed" assertable rather than implied.
    ///
    /// [`join`]: RetainedOwner::join
    #[cfg(any(test, updater_probe))]
    pub fn completion_watch(&self) -> Arc<AtomicBool> {
        self.observed.clone()
    }

    /// Whether the retained task has already finished.
    ///
    /// Probe/test surface: production observes completion by joining, which is
    /// the only thing that makes the join claimable.
    #[cfg(any(test, updater_probe))]
    pub fn is_finished(&self) -> bool {
        self.handle.is_finished()
    }

    /// Join the retained task and report its outcome.
    ///
    /// A panic in the operation is reported as a `JoinError`; the observation
    /// flag is set either way, because the task's end *was* observed.
    pub async fn join(mut self) -> Result<T, tokio::task::JoinError> {
        let outcome = (&mut self.handle).await;
        self.observed.store(true, Ordering::SeqCst);
        outcome
    }
}

impl<T> Drop for RetainedOwner<T> {
    fn drop(&mut self) {
        if !self.observed.load(Ordering::SeqCst) {
            // The task keeps running (the handle detaches); only the observation
            // is lost, and no guarantee about serialized OS state may be claimed.
            tracing::error!(
                "retained operation dropped without observing its completion; nothing here guarantees its effect was applied"
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test(flavor = "current_thread")]
    async fn a_pending_answer_keeps_the_runtime_worker_available() {
        let callback = Arc::new(Mutex::new(None));
        let captured = callback.clone();
        let (opened, ready) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(answer(move |reply| {
            *captured.lock().unwrap() = Some(reply);
            let _ = opened.send(());
        }));
        ready.await.unwrap();
        assert_eq!(tokio::spawn(async { 23 }).await.unwrap(), 23);
        assert!(!waiter.is_finished());
        callback.lock().unwrap().take().unwrap()(true);
        assert_eq!(waiter.await.unwrap(), Some(true));
    }

    #[tokio::test]
    async fn a_dropped_callback_returns_none_not_consent() {
        assert_eq!(answer::<bool>(drop).await, None);
    }

    #[tokio::test]
    async fn a_synchronous_callback_preserves_secondary_answer() {
        assert_eq!(answer(|reply| reply(false)).await, Some(false));
    }

    #[tokio::test]
    async fn cancelling_a_waiter_does_not_abort_the_retained_operation() {
        let (entered, ready) = tokio::sync::oneshot::channel();
        let (release, pending) = tokio::sync::oneshot::channel();
        let (completed, result) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(retained(async move {
            let _ = entered.send(());
            pending.await.unwrap();
            let _ = completed.send(17);
        }));
        ready.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        release.send(()).unwrap();
        assert_eq!(result.await.unwrap(), 17);
    }

    #[tokio::test]
    async fn retained_operation_failure_is_reported() {
        let error = retained(async { panic!("controlled operation failure") })
            .await
            .unwrap_err();
        assert!(error.is_panic());
    }

    #[tokio::test]
    async fn joining_a_retained_owner_observes_its_result() {
        let owner = RetainedOwner::start(async { 17 });
        let watch = owner.completion_watch();
        assert_eq!(owner.join().await.unwrap(), 17);
        assert!(watch.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn a_retained_owner_reports_a_controlled_unwind() {
        let owner = RetainedOwner::start(async { panic!("controlled unwind") });
        let watch = owner.completion_watch();
        assert!(owner.join().await.unwrap_err().is_panic());
        assert!(watch.load(Ordering::SeqCst), "the task's end was observed");
    }

    #[tokio::test]
    async fn dropping_a_retained_owner_never_claims_the_work_was_observed() {
        let (release, pending) = tokio::sync::oneshot::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let worked = finished.clone();
        let owner = RetainedOwner::start(async move {
            pending.await.unwrap();
            worked.store(true, Ordering::SeqCst);
        });
        let watch = owner.completion_watch();
        drop(owner);
        assert!(
            !watch.load(Ordering::SeqCst),
            "a drop must not record a completed join"
        );
        // The retained task is detached by the drop, not aborted: it still runs.
        release.send(()).unwrap();
        for _ in 0..64 {
            if finished.load(Ordering::SeqCst) {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            finished.load(Ordering::SeqCst),
            "the retained work must still complete after the owner is dropped"
        );
    }

    #[tokio::test]
    async fn an_owner_reports_whether_its_task_finished() {
        let owner = RetainedOwner::start(async { 1 });
        // Spin the task to completion without joining it.
        for _ in 0..64 {
            if owner.is_finished() {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(owner.is_finished());
        assert_eq!(owner.join().await.unwrap(), 1);
    }
}
