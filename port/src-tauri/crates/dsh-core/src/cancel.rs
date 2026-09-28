//! Cancellation-token primitive used by long-running commands.
//!
//! Contracts: cloneable (all clones share one signal), single-shot (the first
//! `cancel()` wins and is idempotent), and propagating (every clone observes
//! the cancellation).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use tokio::sync::Notify;

#[derive(Debug, Default)]
struct TokenInner {
    cancelled: AtomicBool,
    notify: Notify,
}

/// Cloneable, single-shot, propagating cancellation token.
#[derive(Debug, Clone, Default)]
pub struct CancellationToken {
    inner: Arc<TokenInner>,
}

impl CancellationToken {
    /// Create a fresh uncancelled token.
    pub fn new() -> Self {
        Self::default()
    }

    /// Trigger cancellation. Idempotent; wakes every waiter exactly once per wait.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    /// Whether cancellation has been requested.
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolve when (or immediately if) the token is cancelled.
    pub async fn cancelled(&self) {
        while !self.is_cancelled() {
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
        }
    }

    /// Run `operation` to completion unless the token cancels first.
    /// Returns `Err(Cancelled)` when the token fired before completion.
    pub async fn race<T>(
        &self,
        operation: impl std::future::Future<Output = T>,
        operation_name: &str,
    ) -> Result<T, crate::error::DshError> {
        tokio::select! {
            biased;
            () = self.cancelled() => Err(crate::error::DshError::cancelled(operation_name)),
            value = operation => Ok(value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancel_is_single_shot_and_propagates() {
        let token = CancellationToken::new();
        let clone = token.clone();
        assert!(!clone.is_cancelled());
        token.cancel();
        token.cancel();
        assert!(clone.is_cancelled(), "cancellation must reach every clone");
    }

    #[tokio::test]
    async fn waiters_wake_on_cancel() {
        let token = CancellationToken::new();
        let waiter = token.clone();
        let handle = tokio::spawn(async move { waiter.cancelled().await });
        tokio::task::yield_now().await;
        token.cancel();
        handle.await.expect("waiter");
    }

    #[tokio::test]
    async fn race_cancels_pending_work() {
        let token = CancellationToken::new();
        token.cancel();
        let outcome: Result<u32, _> = token.race(std::future::pending::<u32>(), "op").await;
        assert!(matches!(
            outcome,
            Err(crate::error::DshError::Cancelled { .. })
        ));
    }
}
