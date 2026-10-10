//! Execution-time ownership and rollback shared by the real UI dispatch and tests.
//! The registry guard spans only synchronous native work. Contention refuses;
//! the UI thread never waits for the async registry mutex.

use super::registry::{GuestViews, NativeGuestAction};
use dsh_core::error::DshError;

pub(super) fn with_registry<T>(
    registry: &tokio::sync::Mutex<GuestViews>,
    operation: impl FnOnce(&mut GuestViews) -> Result<T, DshError>,
) -> Result<T, DshError> {
    let mut guard = registry.try_lock().map_err(|_| {
        DshError::other(
            "guest_dispatch_busy",
            "guest ownership is changing; retry the operation",
        )
    })?;
    operation(&mut guard)
}

fn validate(registry: &GuestViews, action: &NativeGuestAction) -> Result<(), DshError> {
    let current = match action {
        NativeGuestAction::CreateBrowser { lease, partition } => registry
            .browser_guest(lease)
            .is_some_and(|guest| &guest.partition == partition),
        // A placement is owned by the epoch that produced it: once a newer
        // placement has advanced the guest's epoch, an older one must not move —
        // or reveal — that guest again.
        NativeGuestAction::PlaceBrowser {
            lease, placement, ..
        } => registry
            .browser_guest(lease)
            .is_some_and(|guest| guest.placement == *placement),
        NativeGuestAction::NavigateBrowser { lease, .. }
        | NativeGuestAction::GoBackBrowser { lease }
        | NativeGuestAction::GoForwardBrowser { lease }
        | NativeGuestAction::ReloadBrowser { lease } => registry.browser_guest(lease).is_some(),
        NativeGuestAction::OpenPlatform {
            generation,
            page,
            origin,
            partition,
            placement,
            ..
        } => {
            registry.platform_generation() == *generation
                && registry.platform_guest().is_some_and(|guest| {
                    &guest.page == page
                        && &guest.origin == origin
                        && &guest.partition == partition
                        && guest.placement == *placement
                })
        }
        NativeGuestAction::PlacePlatform {
            generation,
            placement,
            ..
        } => {
            registry.platform_generation() == *generation
                && registry
                    .platform_guest()
                    .is_some_and(|guest| guest.placement == *placement)
        }
        // Destruction targets an immutable lease or retired native generation.
        // Platform cleanup must additionally check the native instance identity.
        NativeGuestAction::DestroyBrowser { .. } | NativeGuestAction::ClosePlatform { .. } => true,
    };
    if current {
        Ok(())
    } else {
        Err(DshError::other(
            "guest_dispatch_stale",
            "the guest operation no longer owns its document",
        ))
    }
}

pub(super) fn platform_target_is_current(current: Option<u64>, target: u64) -> bool {
    current == Some(target)
}

/// Production batch runner. Validate the complete batch before touching native
/// state; on failure compensate the failed step and earlier allocations, and
/// retire only the reservations this batch owns. Native close is best-effort.
pub(super) fn apply_batch<T>(
    registry: &mut GuestViews,
    native: &mut T,
    actions: Vec<NativeGuestAction>,
    mut apply: impl FnMut(&mut T, NativeGuestAction) -> Result<(), DshError>,
    mut compensate: impl FnMut(&mut T, &NativeGuestAction),
) -> Result<(), DshError> {
    for action in &actions {
        validate(registry, action)?;
    }
    for (index, action) in actions.iter().enumerate() {
        if let Err(error) = apply(native, action.clone()) {
            compensate(native, action);
            for previous in actions[..index].iter().rev() {
                if matches!(
                    previous,
                    NativeGuestAction::CreateBrowser { .. }
                        | NativeGuestAction::OpenPlatform { .. }
                ) {
                    compensate(native, previous);
                }
            }
            for reservation in &actions {
                match reservation {
                    NativeGuestAction::CreateBrowser { lease, .. } => {
                        registry.rollback_browser_acquire(lease);
                    }
                    NativeGuestAction::OpenPlatform { generation, .. } => {
                        registry.rollback_platform_open(*generation);
                    }
                    _ => {}
                }
            }
            return Err(error);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::super::{geometry::GuestBounds, registry::PlatformGuestRequest};
    use super::*;
    use std::collections::HashSet;

    #[derive(Default)]
    struct Native {
        browsers: HashSet<String>,
        platform: Option<u64>,
        fail_allocation: bool,
        partial_allocation: bool,
        fail_placement: bool,
        touched: usize,
        cleanups: usize,
    }
    fn bounds() -> GuestBounds {
        GuestBounds {
            x: 0,
            y: 0,
            width: 100,
            height: 100,
        }
    }
    fn request() -> PlatformGuestRequest {
        PlatformGuestRequest {
            page: "usage".into(),
            origin: "https://platform.example".into(),
            user_id: Some("u-1".into()),
            embedded_page_dist: None,
            has_session: true,
            bounds: bounds(),
        }
    }
    fn apply(native: &mut Native, action: NativeGuestAction) -> Result<(), DshError> {
        native.touched += 1;
        match action {
            NativeGuestAction::CreateBrowser { lease, .. } => {
                if native.partial_allocation {
                    native.browsers.insert(lease.clone());
                }
                if native.fail_allocation {
                    return Err(DshError::other("fixture_allocation", "injected failure"));
                }
                native.browsers.insert(lease);
            }
            NativeGuestAction::PlaceBrowser { .. } if native.fail_placement => {
                return Err(DshError::other("fixture_placement", "injected failure"));
            }
            NativeGuestAction::DestroyBrowser { lease } => {
                native.browsers.remove(&lease);
            }
            NativeGuestAction::OpenPlatform { generation, .. } => {
                native.platform = Some(generation);
                if native.fail_placement {
                    return Err(DshError::other("fixture_placement", "injected failure"));
                }
            }
            NativeGuestAction::ClosePlatform { generation }
                if platform_target_is_current(native.platform, generation) =>
            {
                native.platform = None;
            }
            _ => {}
        }
        Ok(())
    }
    fn cleanup(native: &mut Native, action: &NativeGuestAction) {
        native.cleanups += 1;
        match action {
            NativeGuestAction::CreateBrowser { lease, .. }
            | NativeGuestAction::PlaceBrowser { lease, .. } => {
                native.browsers.remove(lease);
            }
            NativeGuestAction::OpenPlatform { generation, .. }
                if platform_target_is_current(native.platform, *generation) =>
            {
                native.platform = None;
            }
            _ => {}
        }
    }
    fn run(
        registry: &mut GuestViews,
        native: &mut Native,
        actions: Vec<NativeGuestAction>,
    ) -> Result<(), DshError> {
        apply_batch(registry, native, actions, apply, cleanup)
    }
    fn assert_stale(result: Result<(), DshError>) {
        assert!(
            matches!(result, Err(DshError::Other { code, .. }) if code == "guest_dispatch_stale")
        );
    }

    #[test]
    fn allocation_failure_compensates_native_and_registry_reservation() {
        for partial in [false, true] {
            let mut registry = GuestViews::new(true, true);
            let (lease, _, actions) = registry.acquire_browser("cwd:A", bounds()).unwrap();
            let mut native = Native {
                fail_allocation: true,
                partial_allocation: partial,
                ..Default::default()
            };
            assert!(run(&mut registry, &mut native, actions).is_err());
            assert!(native.browsers.is_empty());
            assert!(native.cleanups > 0);
            assert!(registry.browser_guest(&lease).is_none());
            assert_eq!(
                registry.partition_count(),
                1,
                "workspace storage survives compensation"
            );
        }
    }

    #[test]
    fn placement_failure_after_browser_allocation_compensates_both_owners() {
        let mut registry = GuestViews::new(true, true);
        let (lease, _, actions) = registry.acquire_browser("cwd:A", bounds()).unwrap();
        let mut native = Native {
            fail_placement: true,
            ..Default::default()
        };
        assert!(run(&mut registry, &mut native, actions).is_err());
        assert!(native.browsers.is_empty());
        assert!(registry.browser_guest(&lease).is_none());
        assert_eq!(
            native.touched, 2,
            "creation completed before injected placement failure"
        );
    }

    #[test]
    fn placement_failure_after_platform_allocation_compensates_both_owners() {
        let mut registry = GuestViews::new(true, true);
        let actions = registry.open_platform(request()).unwrap();
        let generation = registry.platform_generation();
        let mut native = Native {
            fail_placement: true,
            ..Default::default()
        };
        assert!(run(&mut registry, &mut native, actions).is_err());
        assert!(native.platform.is_none());
        assert!(registry.platform_guest().is_none());
        assert_ne!(registry.platform_generation(), generation);
    }

    #[test]
    fn close_before_delayed_platform_open_refuses_before_native_allocation() {
        let mut registry = GuestViews::new(true, true);
        let delayed = registry.open_platform(request()).unwrap();
        registry.close_platform();
        let mut native = Native::default();
        assert_stale(run(&mut registry, &mut native, delayed));
        assert_eq!(native.touched, 0);
        assert!(native.platform.is_none());
    }

    #[test]
    fn old_close_cannot_destroy_a_newer_platform_instance() {
        let mut registry = GuestViews::new(true, true);
        let first = registry.open_platform(request()).unwrap();
        let mut native = Native::default();
        run(&mut registry, &mut native, first).unwrap();
        let delayed_close = registry.close_platform();
        let newer = registry.open_platform(request()).unwrap();
        let generation = registry.platform_generation();
        run(&mut registry, &mut native, newer).unwrap();
        run(&mut registry, &mut native, delayed_close).unwrap();
        assert_eq!(native.platform, Some(generation));
        assert!(registry.platform_guest().is_some());
    }

    #[test]
    fn release_before_delayed_browser_create_refuses_before_native_allocation() {
        let mut registry = GuestViews::new(true, true);
        let (lease, _, delayed) = registry.acquire_browser("cwd:A", bounds()).unwrap();
        registry.release_browser(&lease);
        let mut native = Native::default();
        assert_stale(run(&mut registry, &mut native, delayed));
        assert_eq!(native.touched, 0);
        assert!(native.browsers.is_empty());
    }

    #[test]
    fn stale_platform_placement_cannot_move_a_newer_instance() {
        let mut registry = GuestViews::new(true, true);
        registry.open_platform(request()).unwrap();
        let delayed = registry.place_platform(bounds()).unwrap();
        registry.open_platform(request()).unwrap();
        let mut native = Native::default();
        assert_stale(run(&mut registry, &mut native, delayed));
        assert_eq!(native.touched, 0);
    }

    /// A placement overtaken by a newer one is refused before it reaches the
    /// native layer, so a delayed show cannot bring a hidden guest back.
    #[test]
    fn a_placement_overtaken_by_a_hide_is_refused_before_native_work() {
        let mut registry = GuestViews::new(true, true);
        let (lease, _, _) = registry.acquire_browser("cwd:A", bounds()).unwrap();
        let show = registry.place_browser(&lease, bounds()).unwrap();
        let hide = registry
            .place_browser(
                &lease,
                GuestBounds {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
            )
            .unwrap();
        let mut native = Native::default();
        // The hide applies first; the earlier show must not follow it.
        run(&mut registry, &mut native, hide).unwrap();
        assert_stale(run(&mut registry, &mut native, show));
        assert_eq!(native.touched, 1);
    }

    /// The Platform document's placements are epoch-guarded the same way.
    #[test]
    fn a_platform_placement_overtaken_by_a_hide_is_refused_before_native_work() {
        let mut registry = GuestViews::new(true, true);
        registry.open_platform(request()).unwrap();
        let show = registry.place_platform(bounds()).unwrap();
        let hide = registry
            .place_platform(GuestBounds {
                x: 0,
                y: 0,
                width: 0,
                height: 0,
            })
            .unwrap();
        let mut native = Native::default();
        run(&mut registry, &mut native, hide).unwrap();
        assert_stale(run(&mut registry, &mut native, show));
        assert_eq!(native.touched, 1);
    }

    #[test]
    fn registry_contention_refuses_without_running_or_waiting() {
        let registry = tokio::sync::Mutex::new(GuestViews::new(true, true));
        let held = registry.try_lock().unwrap();
        let refused = with_registry(&registry, |_| -> Result<(), DshError> {
            panic!("must not run while ownership is changing")
        });
        assert!(
            matches!(refused, Err(DshError::Other { code, .. }) if code == "guest_dispatch_busy")
        );
        drop(held);
        with_registry(&registry, |_| Ok(())).unwrap();
    }
}
