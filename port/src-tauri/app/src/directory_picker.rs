//! Single ownership of the native directory dialog.
//!
//! Upstream (`_upstream/apps/desktop/src/directory-picker.ts:11-29`) keys the
//! pending dialog by the owning `BrowserWindow` in a `WeakMap`:
//!
//! ```text
//! const existing = pending.get(window); if (existing !== undefined) return existing
//! ...
//! pending.set(window, result)   // and .finally(() => pending.delete(window))
//! ```
//!
//! Two properties follow and both are load-bearing:
//!
//! 1. **At most one dialog is open** for the owned renderer; a second request
//!    joins the first instead of stacking a second modal.
//! 2. **A settled dialog is removed**, so the next request opens a fresh one and
//!    a cancellation stays retryable.
//!
//! The previous Rust implementation published a `watch` receiver through
//! `AppState` and cleared that slot after the blocking pick returned. Two
//! request interleavings could then go wrong: a joiner that read the slot
//! between the sender's `send` and the slot's `= None` could observe `Some(None)`
//! (a *different* dialog's cancellation) as its own result, and a joiner that
//! arrived between the two could wait on a channel nobody would ever write to
//! again. This module makes the ownership explicit with a monotonically
//! increasing **generation**:
//!
//! * a request either creates the generation (and owns the dialog) or joins the
//!   one that is open;
//! * a waiter accepts only its own generation's result;
//! * publishing the result and clearing ownership happen in one critical
//!   section, so no window exists in which the slot is half-retired;
//! * callback-owned retirement survives a dropped waiting request while the
//!   native picker remains open; cancelled queued setup or a dropped callback
//!   retires its generation without allowing a second simultaneous dialog.

use tokio::sync::watch;

/// One open directory dialog.
#[derive(Debug)]
pub struct OpenDialog {
    /// Monotone identity of this dialog; a joiner only accepts its own.
    pub generation: u64,
    /// Result channel: `None` while the dialog is open, `Some(path)` once it
    /// settles (`Some(None)` is a cancellation).
    pub result: watch::Sender<Option<Option<String>>>,
}

/// The process's directory-dialog ownership slot.
#[derive(Debug, Default)]
pub struct DialogOwnership {
    next_generation: u64,
    open: Option<OpenDialog>,
}

/// What one `pick` request must do.
#[derive(Debug)]
pub enum DialogDecision {
    /// No dialog is open: the caller owns generation `generation` and must open
    /// it. The owner publishes through [`DialogOwnership::publish`]; it does not
    /// read the channel itself, so no receiver is handed back here.
    Own {
        /// The generation the caller must publish its result under.
        generation: u64,
    },
    /// A dialog is already open: the caller shares its result.
    Join {
        /// The open dialog's generation.
        generation: u64,
        /// The shared result receiver.
        result: watch::Receiver<Option<Option<String>>>,
    },
}

impl DialogOwnership {
    /// Fresh, closed ownership slot.
    pub fn new() -> Self {
        Self::default()
    }

    /// The generation of the open dialog, if any.
    pub fn generation(&self) -> Option<u64> {
        self.open.as_ref().map(|open| open.generation)
    }

    /// Claim the dialog for one request, or join the open one.
    pub fn claim(&mut self) -> DialogDecision {
        match self.open.as_ref() {
            Some(open) => DialogDecision::Join {
                generation: open.generation,
                result: open.result.subscribe(),
            },
            None => {
                self.next_generation += 1;
                let generation = self.next_generation;
                let (result, unreceived) = watch::channel(None);
                // The owner settles the channel through `publish`; only later
                // joiners subscribe to it, so the initial receiver is dropped.
                drop(unreceived);
                self.open = Some(OpenDialog { generation, result });
                DialogDecision::Own { generation }
            }
        }
    }

    /// Publish the settled result and retire the dialog in one step.
    ///
    /// Returns `false` when `generation` is no longer the open dialog — the
    /// result then belongs to nobody and is dropped rather than waking a waiter
    /// with another dialog's outcome.
    pub fn publish(&mut self, generation: u64, path: Option<String>) -> bool {
        let Some(open) = self.open.as_ref() else {
            return false;
        };
        if open.generation != generation {
            return false;
        }
        // Wake every waiter before the slot is cleared; `send_replace` also
        // updates the value a joiner's `borrow()` reads.
        open.result.send_replace(Some(path));
        self.open = None;
        true
    }

    /// Retire `generation` without a result (the owner was dropped or failed).
    ///
    /// Waiters observe the channel closed and read the last published value,
    /// which is `None` — a cancellation they can retry, never a hang.
    ///
    /// Retirement is generation-checked on purpose: a late callback must not be
    /// able to retire a newer dialog that has already claimed the slot.
    pub fn abandon(&mut self, generation: u64) {
        if self.generation() == Some(generation) {
            self.open = None;
        }
    }
}

/// Process-wide dialog ownership.
///
/// Upstream keys the pending dialog by the owning `BrowserWindow`
/// (`directory-picker.ts:11`). The port has exactly one owned product window
/// and rejects directory requests from any other renderer
/// ([`crate::security::authorized_invoke`]), so a single process-level slot has
/// the same cardinality and needs no change to the shared state struct or the
/// shell's setup.
pub fn ownership() -> &'static std::sync::Mutex<DialogOwnership> {
    static OWNERSHIP: std::sync::OnceLock<std::sync::Mutex<DialogOwnership>> =
        std::sync::OnceLock::new();
    OWNERSHIP.get_or_init(|| std::sync::Mutex::new(DialogOwnership::new()))
}

/// Acquire the ownership lock, recovering from a poisoned lock.
///
/// A poison flag only records that some thread panicked while holding the lock;
/// the slot holds no cross-field invariant a panic can corrupt, and refusing
/// every later directory pick because of it would be a worse failure than
/// taking the guard.
pub fn lock() -> std::sync::MutexGuard<'static, DialogOwnership> {
    match ownership().lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Claim the process-wide dialog for one request.
pub fn claim() -> DialogDecision {
    lock().claim()
}

/// Publish one generation's settled result and retire it.
pub fn publish(generation: u64, path: Option<String>) -> bool {
    lock().publish(generation, path)
}

/// Release one generation without a result.
pub fn abandon(generation: u64) {
    lock().abandon(generation);
}

/// Native callbacks, not request futures, own a launched dialog's retirement.
/// Dropping a waiting IPC future must not permit another dialog while the first
/// native dialog remains open. Dropping a queued/failed callback still retires it.
pub struct DialogLease {
    generation: u64,
    retire: Option<Box<dyn FnOnce(u64) + Send>>,
}
impl DialogLease {
    fn new(generation: u64, retire: impl FnOnce(u64) + Send + 'static) -> Self {
        Self {
            generation,
            retire: Some(Box::new(retire)),
        }
    }
    pub fn retain(generation: u64) -> Self {
        Self::new(generation, abandon)
    }
}
impl Drop for DialogLease {
    fn drop(&mut self) {
        if let Some(retire) = self.retire.take() {
            retire(self.generation);
        }
    }
}

/// Cancellation suppresses queued setup, but does not release an already-open
/// dialog: its callback keeps the DialogLease until the native pick settles.
#[derive(Clone)]
pub struct PendingDispatch(std::sync::Arc<std::sync::atomic::AtomicBool>);
pub struct CancelDispatchOnDrop(PendingDispatch);
impl PendingDispatch {
    pub fn new() -> (Self, CancelDispatchOnDrop) {
        let pending = Self(std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
            false,
        )));
        (pending.clone(), CancelDispatchOnDrop(pending))
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(std::sync::atomic::Ordering::Acquire)
    }
}
impl Drop for CancelDispatchOnDrop {
    fn drop(&mut self) {
        self.0 .0.store(true, std::sync::atomic::Ordering::Release);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A one-shot decision that is either `Own` or `Join` with its generation.
    fn decision_generation(decision: &DialogDecision) -> u64 {
        match decision {
            DialogDecision::Own { generation } | DialogDecision::Join { generation, .. } => {
                *generation
            }
        }
    }

    #[test]
    fn the_first_request_owns_the_dialog_and_later_ones_join_it() {
        let mut ownership = DialogOwnership::new();
        let first = ownership.claim();
        assert!(matches!(first, DialogDecision::Own { .. }));
        assert!(ownership.generation().is_some());
        let second = ownership.claim();
        assert!(matches!(second, DialogDecision::Join { .. }));
        assert_eq!(
            decision_generation(&first),
            decision_generation(&second),
            "a joiner must read the dialog it joined"
        );
    }

    #[test]
    fn publishing_wakes_every_joiner_with_the_same_result() {
        let mut ownership = DialogOwnership::new();
        let DialogDecision::Own { generation } = ownership.claim() else {
            panic!("first request owns the dialog");
        };
        let DialogDecision::Join { result: joined, .. } = ownership.claim() else {
            panic!("second request joins");
        };
        assert!(ownership.publish(generation, Some("C:\\picked".to_string())));
        assert_eq!(
            joined.borrow().clone(),
            Some(Some("C:\\picked".to_string()))
        );
        assert_eq!(ownership.generation(), None, "a settled dialog is retired");
    }

    #[test]
    fn a_retired_dialog_is_replaced_by_a_fresh_generation() {
        let mut ownership = DialogOwnership::new();
        let DialogDecision::Own { generation } = ownership.claim() else {
            panic!("first request owns the dialog");
        };
        ownership.publish(generation, None);
        let DialogDecision::Own { generation: next } = ownership.claim() else {
            panic!("a later request must open its own dialog");
        };
        assert_ne!(generation, next);
        assert_eq!(ownership.generation(), Some(next));
    }

    #[test]
    fn a_stale_generation_cannot_publish_over_the_current_dialog() {
        let mut ownership = DialogOwnership::new();
        let DialogDecision::Own { generation } = ownership.claim() else {
            panic!("first request owns the dialog");
        };
        ownership.publish(generation, None);
        let DialogDecision::Own {
            generation: current,
        } = ownership.claim()
        else {
            panic!("second dialog");
        };
        assert!(
            !ownership.publish(generation, Some("C:\\stale".to_string())),
            "the retired generation must not settle the open dialog"
        );
        assert!(ownership.generation().is_some());
        assert_eq!(ownership.generation(), Some(current));
        assert!(ownership.publish(current, Some("C:\\live".to_string())));
    }

    #[test]
    fn abandoning_the_open_generation_releases_ownership() {
        let mut ownership = DialogOwnership::new();
        let DialogDecision::Own { generation } = ownership.claim() else {
            panic!("first request owns the dialog");
        };
        ownership.abandon(generation + 1);
        assert!(
            ownership.generation().is_some(),
            "only the open generation may be retired"
        );
        ownership.abandon(generation);
        assert_eq!(ownership.generation(), None);
        // A released slot lets the next request open rather than join.
        assert!(matches!(ownership.claim(), DialogDecision::Own { .. }));
    }

    #[test]
    fn a_dropped_owner_never_leaves_a_waiter_hanging() {
        let mut ownership = DialogOwnership::new();
        let DialogDecision::Own { generation } = ownership.claim() else {
            panic!("first request owns the dialog");
        };
        let DialogDecision::Join { result: joined, .. } = ownership.claim() else {
            panic!("second request joins");
        };
        ownership.abandon(generation);
        // The channel is closed and the last value is the pre-settlement `None`:
        // a cancellation the joiner can retry, not a blocked future.
        drop(ownership);
        assert!(joined.has_changed().is_err() || joined.borrow().is_none());
    }

    fn leased_slot() -> (
        std::sync::Arc<std::sync::Mutex<DialogOwnership>>,
        u64,
        DialogLease,
    ) {
        let slot = std::sync::Arc::new(std::sync::Mutex::new(DialogOwnership::new()));
        let generation = decision_generation(&slot.lock().unwrap().claim());
        let retire_slot = slot.clone();
        let lease = DialogLease::new(generation, move |generation| {
            retire_slot.lock().unwrap().abandon(generation);
        });
        (slot, generation, lease)
    }

    #[test]
    fn cancelled_queued_setup_retires_without_opening_a_dialog() {
        let (slot, _, lease) = leased_slot();
        let (pending, cancel) = PendingDispatch::new();
        let queued = move || {
            let _lease = lease;
            !pending.is_cancelled()
        };
        drop(cancel);
        assert!(
            !queued(),
            "a dropped request cannot launch queued native setup"
        );
        assert_eq!(slot.lock().unwrap().generation(), None);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dropping_a_waiter_keeps_the_native_callback_owned_and_joinable() {
        let (slot, generation, lease) = leased_slot();
        let (reply, waiting) = tokio::sync::oneshot::channel();
        let callback_slot = slot.clone();
        let native_callback = move |path: Option<String>| {
            let _lease = lease;
            assert!(callback_slot
                .lock()
                .unwrap()
                .publish(generation, path.clone()));
            let _ = reply.send(path);
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            let _ = started.send(());
            waiting.await
        });
        ready.await.unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        let DialogDecision::Join {
            generation: joined_generation,
            result,
        } = slot.lock().unwrap().claim()
        else {
            panic!("an open native dialog must remain joinable")
        };
        assert_eq!(joined_generation, generation);
        native_callback(Some("C:\\picked".into()));
        assert_eq!(*result.borrow(), Some(Some("C:\\picked".into())));
        assert_eq!(slot.lock().unwrap().generation(), None);
        assert!(matches!(
            slot.lock().unwrap().claim(),
            DialogDecision::Own { .. }
        ));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn pending_callback_does_not_block_unrelated_runtime_work() {
        let (_slot, _generation, lease) = leased_slot();
        let (reply, waiting) = tokio::sync::oneshot::channel();
        let callback = move || {
            let _lease = lease;
            let _ = reply.send(17);
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let waiter = tokio::spawn(async move {
            let _ = started.send(());
            waiting.await
        });
        ready.await.unwrap();
        assert_eq!(tokio::spawn(async { 23 }).await.unwrap(), 23);
        assert!(!waiter.is_finished(), "the dialog is still pending");
        callback();
        assert_eq!(waiter.await.unwrap().unwrap(), 17);
    }

    #[tokio::test]
    async fn dropping_a_native_callback_retires_ownership_and_wakes_waiters() {
        let (slot, _, lease) = leased_slot();
        let DialogDecision::Join { mut result, .. } = slot.lock().unwrap().claim() else {
            panic!("join")
        };
        let (reply, waiting) = tokio::sync::oneshot::channel::<()>();
        let callback = move || {
            let _lease = lease;
            let _ = reply.send(());
        };
        drop(callback);
        assert!(waiting.await.is_err());
        assert!(result.changed().await.is_err());
        assert_eq!(slot.lock().unwrap().generation(), None);
    }

    #[test]
    fn a_late_callback_lease_cannot_retire_a_newer_dialog() {
        let (slot, generation, lease) = leased_slot();
        let current = {
            let mut ownership = slot.lock().unwrap();
            assert!(ownership.publish(generation, None));
            decision_generation(&ownership.claim())
        };
        drop(lease);
        assert_eq!(slot.lock().unwrap().generation(), Some(current));
    }
}
