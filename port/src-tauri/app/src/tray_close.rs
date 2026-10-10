//! A single close-to-tray attempt owns the acknowledgement dialog and hide.
//! The lease holds no model lock while a native callback is pending.
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Default)]
pub struct CloseGate(AtomicBool);

impl CloseGate {
    pub fn acquire(&self) -> Option<CloseLease<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| CloseLease(self))
    }
}

pub struct CloseLease<'a>(&'a CloseGate);

impl Drop for CloseLease<'_> {
    fn drop(&mut self) {
        self.0 .0.store(false, Ordering::Release);
    }
}

pub struct HiddenCommit<E> {
    pub acknowledgement: Option<Result<(), E>>,
    pub notification: Result<(), E>,
}

/// Hide is the commit point. Persistence and publication never run on a
/// refused/failed hide, and a marker failure does not deny the observed hide.
pub async fn commit_hidden<E>(
    hide: impl std::future::Future<Output = Result<(), E>>,
    needs_acknowledgement: bool,
    persist: impl FnOnce() -> Result<(), E>,
    notify: impl FnOnce() -> Result<(), E>,
) -> Result<HiddenCommit<E>, E> {
    hide.await?;
    let acknowledgement = needs_acknowledgement.then(persist);
    Ok(HiddenCommit {
        acknowledgement,
        notification: notify(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeated_close_coalesces_until_the_attempt_settles() {
        let gate = CloseGate::default();
        let attempt = gate.acquire().unwrap();
        assert!(gate.acquire().is_none());
        drop(attempt);
        assert!(gate.acquire().is_some());
    }

    #[tokio::test]
    async fn hide_failure_never_acknowledges_or_emits_hidden() {
        let committed = commit_hidden(
            async { Err("hide failed") },
            true,
            || -> Result<(), &str> { panic!("failed hide must not persist") },
            || -> Result<(), &str> { panic!("failed hide must not emit Hidden") },
        )
        .await;
        assert!(matches!(committed, Err("hide failed")));
    }

    #[tokio::test]
    async fn marker_failure_still_publishes_an_observed_hidden_window() {
        let order = std::cell::RefCell::new(Vec::new());
        let committed = commit_hidden(
            async {
                order.borrow_mut().push("hide");
                Ok(())
            },
            true,
            || {
                order.borrow_mut().push("persist");
                Err("marker failed")
            },
            || {
                order.borrow_mut().push("Hidden");
                Ok(())
            },
        )
        .await
        .unwrap();
        assert_eq!(order.into_inner(), ["hide", "persist", "Hidden"]);
        assert_eq!(committed.acknowledgement, Some(Err("marker failed")));
        assert_eq!(committed.notification, Ok(()));
    }

    #[tokio::test]
    async fn previously_acknowledged_close_does_not_rewrite_the_marker() {
        let committed = commit_hidden(
            async { Ok(()) },
            false,
            || -> Result<(), &str> { panic!("already acknowledged") },
            || Ok(()),
        )
        .await
        .unwrap();
        assert_eq!(committed.acknowledgement, None);
        assert_eq!(committed.notification, Ok(()));
    }

    #[test]
    fn unwind_releases_admission_for_a_later_close() {
        let gate = CloseGate::default();
        let result = std::panic::catch_unwind(|| {
            let _attempt = gate.acquire().unwrap();
            panic!("controlled close failure");
        });
        assert!(result.is_err());
        assert!(gate.acquire().is_some());
    }
}
