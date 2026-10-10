//! Ownership and lifecycle of native guest views.
//!
//! The reference keeps two owners alive longer than their windows:
//!
//! * `DesktopBrowserGuests` — `partitions: Map<workspace, partition>` survives
//!   individual tabs (a released tab keeps its workspace's storage), and
//!   `leases: Map<lease, GuestLease>` is the set of live tabs. A stale lease is
//!   silently ignored on release; a lease owned by another window is refused.
//! * `DesktopPlatformView` — one generation counter, one current view, one
//!   credential snapshot that is discarded together with the view.
//!
//! `GuestViews` is the same bookkeeping with an explicit native step: each
//! mutation records a [`NativeGuestAction`] for the main thread to perform, so a
//! unit test can assert the *lifecycle* (create once, move once, destroy once,
//! in order) without a window.

use std::collections::HashMap;

use dsh_core::error::DshError;

use super::geometry::GuestBounds;
use super::partition::{browser_partition, platform_partition};
use super::policy::{allowed_navigation, guest_bridge_error, platform_bridge_error};
use super::GuestBrowserState;

/// Prefix of every browser guest partition (upstream
/// `dsh-sidebar-browser-`).
pub const BROWSER_PARTITION_PREFIX: &str = "dsh-sidebar-browser-";

/// Prefix of every Platform partition (upstream `dsh-platform-`).
pub const PLATFORM_PARTITION_PREFIX: &str = "dsh-platform-";

/// Longest accepted workspace storage identity.
///
/// Upstream rejects a workspace identity longer than 4096 characters
/// (`browser-guests.ts` `acquire`); the retained client supplies `cwd:<path>`,
/// which stays well below it.
pub const MAX_WORKSPACE_IDENTITY: usize = 4096;

/// One live browser guest.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserGuest {
    /// Opaque main-issued lease; also the guest view's label.
    pub lease: String,
    /// Workspace storage identity this lease was approved for.
    pub workspace: String,
    /// Approved storage partition for the guest's workspace.
    pub partition: String,
    /// Whether the child view has been created and not yet destroyed.
    pub created: bool,
    /// Whether the child view is currently shown.
    pub visible: bool,
    /// Monotonic epoch of the last placement this lease produced.
    ///
    /// Every placement carries the epoch it was produced under, so a placement
    /// that was overtaken by a newer one — a hide, in particular — is refused
    /// instead of moving or revealing the guest again.
    pub placement: u64,
    /// The last document state the native layer observed for this lease, in the
    /// same typed payload `dsh://guests/browser-state` carries.
    ///
    /// It starts as the reservation's own bootstrap address, which is the
    /// address the port requested and not an observation; the published state is
    /// the native layer's, and this mirror is only ever replaced by it.
    pub state: GuestBrowserState,
}

/// Everything needed to open one Platform document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformGuestRequest {
    /// `usage` or `top-up`.
    pub page: String,
    /// Account origin; the document is confined to it.
    pub origin: String,
    /// Account identity; `None` mints a temporary partition.
    pub user_id: Option<String>,
    /// Embedded deployment parameter, when the session published one.
    pub embedded_page_dist: Option<String>,
    /// Whether an account session has been published at all.
    pub has_session: bool,
    /// Renderer rectangle in CSS pixels.
    pub bounds: GuestBounds,
}

/// One live Platform guest request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlatformGuest {
    /// `usage` or `top-up`.
    pub page: String,
    /// Account origin the document is confined to.
    pub origin: String,
    /// Partition backing the document (persistent unless the account has no id).
    pub partition: String,
    /// Embedded deployment parameter published with the account session.
    pub embedded_page_dist: Option<String>,
    /// Whether the child view has been created and not yet destroyed.
    pub created: bool,
    /// Whether the injected credential headers are currently installed.
    pub session_applied: bool,
    /// Monotonic epoch of the last placement this document produced; a placement
    /// overtaken by a newer one is refused, for the same reason as
    /// [`BrowserGuest::placement`].
    pub placement: u64,
}

/// One native step the main thread must perform, in the order produced.
///
/// The main thread drains this queue inside a single command; it is never
/// observable from the renderer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NativeGuestAction {
    /// Create a child browser guest and point it at the inert bootstrap
    /// document (`about:blank#<lease>`, upstream `ElectronWebviewPresentation`).
    CreateBrowser { lease: String, partition: String },
    /// Move and show or hide an existing browser guest.
    ///
    /// `placement` is the epoch this step was produced under; the native layer
    /// refuses a step an older epoch than the one its carrier already applied, so
    /// a placement that crossed a newer one cannot reveal a hidden guest.
    PlaceBrowser {
        lease: String,
        bounds: GuestBounds,
        placement: u64,
    },
    /// Destroy a browser guest's document; the workspace partition survives.
    DestroyBrowser { lease: String },
    /// Load one validated address in an existing browser guest.
    ///
    /// The address arrives already validated by [`GuestViews::navigate_browser`];
    /// the native layer re-validates it through the same policy the WebView2
    /// navigation hook uses, so a second path cannot weaken it.
    NavigateBrowser { lease: String, url: String },
    /// Move backward in the guest's history.
    GoBackBrowser { lease: String },
    /// Move forward in the guest's history.
    GoForwardBrowser { lease: String },
    /// Reload the guest's current address.
    ReloadBrowser { lease: String },
    /// Create the Platform child view for an account session.
    OpenPlatform {
        generation: u64,
        page: String,
        origin: String,
        partition: String,
        bounds: GuestBounds,
        /// Placement epoch, as [`NativeGuestAction::PlaceBrowser::placement`].
        placement: u64,
    },
    /// Move and show or hide the Platform view.
    PlacePlatform {
        generation: u64,
        bounds: GuestBounds,
        /// Placement epoch, as [`NativeGuestAction::PlaceBrowser::placement`].
        placement: u64,
    },
    /// Destroy the Platform document and clear its session only if it still
    /// represents the retired generation.
    ClosePlatform { generation: u64 },
}

/// Ownership of every native guest view of one application window.
///
/// One instance lives in `AppState`. It holds no `tauri` handle: the main thread
/// performs [`NativeGuestAction`]s, which keeps the ownership rules testable.
pub struct GuestViews {
    /// Workspace storage identity → partition. Outlives individual leases.
    partitions: HashMap<String, String>,
    /// Live browser leases by lease id.
    leases: HashMap<String, BrowserGuest>,
    /// Whether this build can create child webviews at all.
    browser_available: bool,
    /// The current Platform document, if any.
    platform: Option<PlatformGuest>,
    /// Whether this build can create the Platform child view.
    platform_available: bool,
    /// Monotonic Platform identity; an operation from an older generation must
    /// not close a newer document (upstream `DesktopPlatformView.generation`).
    platform_generation: u64,
}

impl GuestViews {
    /// @param browser_available - whether the build can create child webviews.
    /// @param platform_available - whether the build can create the Platform view.
    pub fn new(browser_available: bool, platform_available: bool) -> Self {
        Self {
            partitions: HashMap::new(),
            leases: HashMap::new(),
            browser_available,
            platform: None,
            platform_available,
            platform_generation: 0,
        }
    }

    /// Whether child webviews can be created in this build.
    #[cfg(test)]
    pub fn browser_available(&self) -> bool {
        self.browser_available
    }

    /// Whether the Platform child view can be created in this build.
    #[cfg(test)]
    pub fn platform_available(&self) -> bool {
        self.platform_available
    }

    /// Live browser lease count (diagnostics and teardown assertions).
    #[cfg(test)]
    pub fn browser_lease_count(&self) -> usize {
        self.leases.len()
    }

    /// Workspace partitions minted in this process (they outlive their tabs).
    #[cfg(test)]
    pub fn partition_count(&self) -> usize {
        self.partitions.len()
    }

    /// The current Platform document, if one is open.
    pub fn platform_guest(&self) -> Option<&PlatformGuest> {
        self.platform.as_ref()
    }

    /// The live browser guest behind `lease`, if any.
    pub fn browser_guest(&self, lease: &str) -> Option<&BrowserGuest> {
        self.leases.get(lease)
    }

    /// Lease ids currently owned, for teardown and diagnostics.
    pub fn lease_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.leases.keys().cloned().collect();
        ids.sort();
        ids
    }

    /// Lease ids that currently have a child webview.
    ///
    /// The native layer creates only these, so a lease whose creation failed
    /// stays in the bookkeeping and is repaired by the next placement.
    #[cfg(test)]
    pub fn created_lease_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .leases
            .values()
            .filter(|guest| guest.created)
            .map(|guest| guest.lease.clone())
            .collect();
        ids.sort();
        ids
    }

    /// The workspace storage identity of one lease.
    #[cfg(test)]
    pub fn workspace_of(&self, lease: &str) -> Option<&str> {
        self.leases.get(lease).map(|guest| guest.workspace.as_str())
    }

    /// Reserve one browser guest in its workspace's process-lifetime partition
    /// (upstream `DesktopBrowserGuests.acquire`).
    ///
    /// @param workspace - resolved workspace storage identity from the retained
    ///   client (`cwd:<path>` or `session:<id>`).
    /// @param bounds - the renderer rectangle the guest is placed at.
    /// @returns the lease, its partition, and the ordered native steps.
    pub fn acquire_browser(
        &mut self,
        workspace: &str,
        bounds: GuestBounds,
    ) -> Result<(String, String, Vec<NativeGuestAction>), DshError> {
        if !self.browser_available {
            return Err(guest_bridge_error());
        }
        if workspace.is_empty() || workspace.len() > MAX_WORKSPACE_IDENTITY {
            return Err(DshError::invalid_argument(
                "workspace",
                format!("a workspace storage identity of 1..={MAX_WORKSPACE_IDENTITY} characters is required"),
            ));
        }
        let partition = match self.partitions.get(workspace) {
            Some(partition) => partition.clone(),
            None => {
                let partition = browser_partition(workspace);
                self.partitions
                    .insert(workspace.to_string(), partition.clone());
                partition
            }
        };
        let lease = uuid::Uuid::new_v4().to_string();
        self.leases.insert(
            lease.clone(),
            BrowserGuest {
                lease: lease.clone(),
                workspace: workspace.to_string(),
                partition: partition.clone(),
                created: true,
                visible: false,
                placement: 1,
                state: GuestBrowserState {
                    lease: lease.clone(),
                    // The reservation's own inert seed, which is the address the
                    // port requested; the first native observation replaces it.
                    url: format!("about:blank#{lease}"),
                    title: String::new(),
                    loading: false,
                    can_go_back: false,
                    can_go_forward: false,
                    gone: false,
                    error: None,
                },
            },
        );
        Ok((
            lease.clone(),
            partition.clone(),
            vec![
                NativeGuestAction::CreateBrowser {
                    lease: lease.clone(),
                    partition,
                },
                NativeGuestAction::PlaceBrowser {
                    lease,
                    bounds,
                    placement: 1,
                },
            ],
        ))
    }

    /// Release one lease (upstream `DesktopBrowserGuests.release`).
    ///
    /// An unknown lease resolves to nothing — the reference returns early, so a
    /// double release is not an error. The workspace partition is retained.
    /// @param lease - the caller's reservation.
    /// @returns the native steps that destroy the guest document.
    pub fn release_browser(&mut self, lease: &str) -> Vec<NativeGuestAction> {
        match self.leases.remove(lease) {
            Some(guest) if guest.created => vec![NativeGuestAction::DestroyBrowser {
                lease: lease.to_string(),
            }],
            _ => Vec::new(),
        }
    }

    /// Move and show/hide one existing browser guest.
    ///
    /// The placement epoch advances with every call, so the step carries the
    /// identity of this placement rather than of the guest: a step produced here
    /// and applied after a later placement is refused instead of moving — or
    /// revealing — the guest the later placement already decided.
    ///
    /// @param lease - the caller's reservation.
    /// @param bounds - the renderer rectangle, or a zero-extent hide.
    pub fn place_browser(
        &mut self,
        lease: &str,
        bounds: GuestBounds,
    ) -> Result<Vec<NativeGuestAction>, DshError> {
        let Some(guest) = self.leases.get_mut(lease) else {
            return Err(DshError::not_found("browser guest", lease));
        };
        guest.placement = guest.placement.wrapping_add(1);
        Ok(vec![NativeGuestAction::PlaceBrowser {
            lease: lease.to_string(),
            bounds,
            placement: guest.placement,
        }])
    }

    /// Release every browser lease of this window (upstream `releaseAll` on
    /// renderer navigation, renderer loss and window destruction).
    pub fn release_all_browsers(&mut self) -> Vec<NativeGuestAction> {
        let ids = self.lease_ids();
        let mut actions = Vec::new();
        for id in ids {
            actions.extend(self.release_browser(&id));
        }
        actions
    }

    /// Load one validated address in an existing browser guest.
    ///
    /// The address is validated here as well as in the native navigation hook:
    /// a refusal has to reach the client as a typed error rather than as a
    /// silently ignored navigation, and the hook covers the navigations the
    /// client never issues.
    ///
    /// @param lease - the caller's reservation.
    /// @param url - renderer-supplied address.
    /// @param application_origin - owned gateway origin, never loaded.
    /// @returns the ordered native steps.
    pub fn navigate_browser(
        &mut self,
        lease: &str,
        url: &str,
        application_origin: Option<&str>,
    ) -> Result<Vec<NativeGuestAction>, DshError> {
        let Some(guest) = self.leases.get(lease) else {
            return Err(DshError::not_found("browser guest", lease));
        };
        if !allowed_navigation(url, application_origin) {
            return Err(DshError::other(
                "guest_navigation_refused",
                "this address is outside the guest's navigation policy",
            ));
        }
        let canonical = url::Url::parse(url)
            .map_err(|error| DshError::invalid_argument("url", error.to_string()))?;
        if guest.state.url == canonical.as_str()
            && !guest.state.loading
            && guest.state.error.is_none()
        {
            return Ok(vec![NativeGuestAction::ReloadBrowser {
                lease: lease.to_string(),
            }]);
        }
        Ok(vec![NativeGuestAction::NavigateBrowser {
            lease: lease.to_string(),
            url: canonical.to_string(),
        }])
    }

    /// Give an existing browser guest one navigation verb.
    ///
    /// @param lease - the caller's reservation.
    /// @param command - `back`, `forward`, `reload` or `clear-history`.
    /// @returns the ordered native steps.
    pub fn command_browser(
        &self,
        lease: &str,
        command: &str,
    ) -> Result<Vec<NativeGuestAction>, DshError> {
        if !self.leases.contains_key(lease) {
            return Err(DshError::not_found("browser guest", lease));
        }
        let step = match command {
            "back" => NativeGuestAction::GoBackBrowser {
                lease: lease.to_string(),
            },
            "forward" => NativeGuestAction::GoForwardBrowser {
                lease: lease.to_string(),
            },
            "reload" => NativeGuestAction::ReloadBrowser {
                lease: lease.to_string(),
            },
            "clear-history" => {
                return Err(DshError::other(
                    "browser_history_unavailable",
                    "this native backend cannot clear browser history",
                ))
            }
            _ => {
                return Err(DshError::invalid_argument(
                    "command",
                    "expected one of back, forward, reload, clear-history",
                ))
            }
        };
        Ok(vec![step])
    }

    /// Replace one browser guest's state with what the native layer observed.
    ///
    /// The state is the *native* observation: the client renders it, it is not
    /// invented here, and the same typed payload is what
    /// `dsh://guests/browser-state` carries. A state naming a lease this
    /// registry does not own — or naming a different lease than the one being
    /// updated — answers `false` and changes nothing.
    ///
    /// @param state - observed document state, carrying its own lease.
    /// @returns whether a live guest was updated.
    pub fn apply_browser_state(&mut self, state: GuestBrowserState) -> bool {
        let Some(guest) = self.leases.get_mut(&state.lease) else {
            return false;
        };
        guest.state = state;
        true
    }

    /// Open one Platform document (upstream `DesktopPlatformView.open`).
    ///
    /// Any previous document is closed first — the reference's `open` destroys
    /// whatever was showing — and the generation is advanced so an in-flight
    /// older operation cannot close this one.
    /// @param request - page, account identity, origin and rectangle.
    /// @returns the ordered native steps.
    pub fn open_platform(
        &mut self,
        request: PlatformGuestRequest,
    ) -> Result<Vec<NativeGuestAction>, DshError> {
        if !self.platform_available {
            return Err(platform_bridge_error());
        }
        if request.page != "usage" && request.page != "top-up" {
            return Err(DshError::invalid_argument(
                "page",
                "expected one of usage, top-up",
            ));
        }
        if !request.has_session {
            return Err(DshError::other(
                "platform_account_unavailable",
                "no Platform account session has been published",
            ));
        }
        if request.origin.is_empty() || url::Url::parse(&request.origin).is_err() {
            return Err(DshError::invalid_argument(
                "origin",
                "a platform account origin is required",
            ));
        }
        // close_platform retires the preceding operation even if no view exists.
        let mut actions = self.close_platform();
        let generation = self.platform_generation;
        let partition = platform_partition(&request.origin, request.user_id.as_deref());
        self.platform = Some(PlatformGuest {
            page: request.page.clone(),
            origin: request.origin.clone(),
            partition: partition.clone(),
            embedded_page_dist: request.embedded_page_dist.clone(),
            created: true,
            // A published session is not proof that native per-request hooks
            // completed. Only the hook-installation acknowledgement may grant it.
            session_applied: false,
            placement: 1,
        });
        actions.push(NativeGuestAction::OpenPlatform {
            generation,
            page: request.page,
            origin: request.origin,
            partition,
            bounds: request.bounds,
            placement: 1,
        });
        Ok(actions)
    }

    /// Move and show/hide the current Platform document.
    ///
    /// The placement epoch advances exactly as [`Self::place_browser`]'s does,
    /// and for the same reason: a placement overtaken by a newer one must not
    /// reveal a document the newer placement hid.
    pub fn place_platform(
        &mut self,
        bounds: GuestBounds,
    ) -> Result<Vec<NativeGuestAction>, DshError> {
        let Some(platform) = self.platform.as_mut() else {
            return Err(DshError::not_found("platform view", "current"));
        };
        platform.placement = platform.placement.wrapping_add(1);
        Ok(vec![NativeGuestAction::PlacePlatform {
            generation: self.platform_generation,
            bounds,
            placement: platform.placement,
        }])
    }

    /// Destroy the current Platform document (upstream `close`): the account
    /// session is dropped with the view, and account-scoped preferences survive
    /// because the partition is persistent.
    pub fn close_platform(&mut self) -> Vec<NativeGuestAction> {
        // Retire every captured operation, even when the view has already been
        // removed (for example, after a failed native open).
        let retired_generation = self.platform_generation;
        self.platform_generation = self.platform_generation.wrapping_add(1);
        match self.platform.take() {
            Some(_) if self.platform_available => vec![NativeGuestAction::ClosePlatform {
                generation: retired_generation,
            }],
            _ => Vec::new(),
        }
    }

    /// Roll back a precommitted open only while it still owns the generation.
    pub fn rollback_platform_open(&mut self, generation: u64) -> Vec<NativeGuestAction> {
        if self.platform_generation != generation {
            return Vec::new();
        }
        self.close_platform()
    }

    /// Remove a failed browser reservation without touching a newer lease.
    pub fn rollback_browser_acquire(&mut self, lease: &str) -> Vec<NativeGuestAction> {
        self.release_browser(lease)
    }

    /// The Platform identity of the current document, or `None`.
    ///
    /// Used to reject a stale in-flight operation: a caller that captured the
    /// generation before opening must not act on a document opened after it.
    pub fn platform_generation(&self) -> u64 {
        self.platform_generation
    }

    /// Revoke the current Platform document's session-applied state.
    ///
    /// This registry has no acknowledgement from native header hooks, so it must
    /// never assert that those hooks completed. A future hook installer may set
    /// the state only after its native operation succeeds.
    #[cfg(test)]
    pub fn set_platform_session(&mut self, _applied: bool) {
        // No native hook installer/acknowledgement exists. Fail closed for both
        // inputs; callers cannot assert successful credential application.
        if let Some(platform) = self.platform.as_mut() {
            platform.session_applied = false;
        }
    }

    /// Close admission permanently before retiring the current guests. Queued
    /// positive actions fail lease/generation validation after this transition.
    pub fn shutdown(&mut self) -> Vec<NativeGuestAction> {
        // Generate destruction while capability flags still describe the live
        // views. This synchronous transition is protected by the registry lock;
        // no command can enter between retirement and admission closure.
        let actions = self.teardown();
        self.browser_available = false;
        self.platform_available = false;
        actions
    }

    /// Tear down every guest of this window, in order (upstream
    /// `releaseAll` + `platformView.dispose`).
    pub fn teardown(&mut self) -> Vec<NativeGuestAction> {
        let mut actions = self.release_all_browsers();
        actions.extend(self.close_platform());
        actions
    }
}

impl Default for GuestViews {
    fn default() -> Self {
        Self::new(true, true)
    }
}

#[cfg(test)]
mod tests {
    use super::super::GuestBrowserFailure;
    use super::*;

    fn bounds(width: i32) -> GuestBounds {
        GuestBounds {
            x: 0,
            y: 0,
            width,
            height: 640,
        }
    }

    fn platform_request(user_id: Option<&str>) -> PlatformGuestRequest {
        PlatformGuestRequest {
            page: "usage".to_string(),
            origin: "https://platform.example".to_string(),
            user_id: user_id.map(str::to_string),
            embedded_page_dist: None,
            has_session: true,
            bounds: bounds(800),
        }
    }

    #[test]
    fn acquire_creates_once_and_places_the_guest() {
        let mut views = GuestViews::new(true, true);
        let (lease, partition, actions) = views
            .acquire_browser("cwd:C:\\work", bounds(700))
            .expect("acquire");
        assert!(partition.starts_with(BROWSER_PARTITION_PREFIX));
        assert_eq!(
            actions,
            vec![
                NativeGuestAction::CreateBrowser {
                    lease: lease.clone(),
                    partition: partition.clone(),
                },
                NativeGuestAction::PlaceBrowser {
                    lease: lease.clone(),
                    bounds: bounds(700),
                    placement: 1,
                }
            ]
        );
        assert_eq!(views.browser_lease_count(), 1);
        assert_eq!(views.created_lease_ids(), vec![lease]);
    }

    /// One workspace reuses one jar across tabs; closing a tab keeps it.
    #[test]
    fn workspace_storage_survives_individual_tabs() {
        let mut views = GuestViews::new(true, true);
        let (first, partition, _) = views
            .acquire_browser("cwd:C:\\work", bounds(10))
            .expect("first");
        views.release_browser(&first);
        let (second, again, _) = views
            .acquire_browser("cwd:C:\\work", bounds(10))
            .expect("second");
        assert_ne!(first, second, "each tab gets its own lease");
        assert_eq!(partition, again, "the workspace keeps one storage jar");
        assert_eq!(views.partition_count(), 1);
        assert_eq!(views.browser_lease_count(), 1);
    }

    #[test]
    fn different_workspaces_get_different_jars() {
        let mut views = GuestViews::new(true, true);
        let (_, one, _) = views.acquire_browser("cwd:A", bounds(10)).expect("A");
        let (_, two, _) = views.acquire_browser("cwd:B", bounds(10)).expect("B");
        let (_, three, _) = views
            .acquire_browser("session:s-1", bounds(10))
            .expect("session");
        assert_ne!(one, two);
        assert_ne!(two, three);
        assert_eq!(views.partition_count(), 3);
    }

    #[test]
    fn release_is_idempotent_for_an_unknown_lease() {
        let mut views = GuestViews::new(true, true);
        assert!(views.release_browser("never-issued").is_empty());
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        assert_eq!(
            views.release_browser(&lease),
            vec![NativeGuestAction::DestroyBrowser {
                lease: lease.clone()
            }]
        );
        assert!(views.release_browser(&lease).is_empty());
        assert_eq!(views.browser_lease_count(), 0);
    }

    #[test]
    fn placing_an_unknown_lease_is_refused() {
        let mut views = GuestViews::new(true, true);
        match views.place_browser("never-issued", bounds(10)) {
            Err(DshError::NotFound { entity, .. }) => assert_eq!(entity, "browser guest"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    #[test]
    fn a_zero_extent_placement_hides_without_destroying() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views
            .acquire_browser("cwd:A", bounds(700))
            .expect("acquire");
        let actions = views.place_browser(&lease, bounds(0)).expect("hide");
        assert_eq!(
            actions,
            vec![NativeGuestAction::PlaceBrowser {
                lease: lease.clone(),
                bounds: bounds(0),
                placement: 2,
            }]
        );
        assert_eq!(views.browser_lease_count(), 1, "hiding is not destruction");
    }

    /// Every placement this registry produces is a new epoch, so a placement
    /// overtaken by a later one is identifiable as stale instead of being
    /// applied out of order.
    #[test]
    fn every_placement_advances_its_epoch() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, acquire) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        assert!(matches!(
            acquire.as_slice(),
            [
                NativeGuestAction::CreateBrowser { .. },
                NativeGuestAction::PlaceBrowser { placement: 1, .. }
            ]
        ));
        // One placement action of either guest kind: the epoch travels in both
        // (`PlaceBrowser` for a lease, `PlacePlatform` for the document), and each
        // guest counts its own placements from the first one it was created with.
        let placement_of = |actions: Vec<NativeGuestAction>| match actions.as_slice() {
            [NativeGuestAction::PlaceBrowser { placement, .. }]
            | [NativeGuestAction::PlacePlatform { placement, .. }] => *placement,
            other => panic!("expected one placement, got {other:?}"),
        };
        let second = placement_of(views.place_browser(&lease, bounds(20)).expect("second"));
        let third = placement_of(views.place_browser(&lease, bounds(0)).expect("hide"));
        assert!(second < third, "{second} must precede {third}");

        // The Platform document's placements are epoch-guarded the same way.
        let opened = views
            .open_platform(platform_request(Some("u-1")))
            .expect("open");
        match opened.as_slice() {
            [NativeGuestAction::OpenPlatform { placement, .. }] => assert_eq!(*placement, 1),
            other => panic!("expected one open, got {other:?}"),
        }
        let first_platform = placement_of(views.place_platform(bounds(20)).expect("place"));
        let second_platform = placement_of(views.place_platform(bounds(0)).expect("hide"));
        assert_eq!(first_platform, 2);
        assert_eq!(second_platform, 3);
    }

    #[test]
    fn renderer_navigation_releases_every_lease_in_order() {
        let mut views = GuestViews::new(true, true);
        let (first, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("first");
        let (second, _, _) = views.acquire_browser("cwd:B", bounds(10)).expect("second");
        let third = views.acquire_browser("cwd:C", bounds(10)).expect("third").0;
        let actions = views.release_all_browsers();
        let mut expected = [first, second, third].to_vec();
        expected.sort();
        let destroyed: Vec<String> = actions
            .into_iter()
            .map(|action| match action {
                NativeGuestAction::DestroyBrowser { lease } => lease,
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(destroyed, expected, "every lease is destroyed exactly once");
        assert_eq!(views.browser_lease_count(), 0);
        assert_eq!(
            views.partition_count(),
            3,
            "workspace jars survive the window"
        );
    }

    #[test]
    fn workspace_identity_bounds_are_enforced() {
        let mut views = GuestViews::new(true, true);
        assert!(views.acquire_browser("", bounds(10)).is_err());
        let oversized = "x".repeat(MAX_WORKSPACE_IDENTITY + 1);
        match views.acquire_browser(&oversized, bounds(10)) {
            Err(DshError::InvalidArgument { field, .. }) => assert_eq!(field, "workspace"),
            other => panic!("expected invalid_argument, got {other:?}"),
        }
        assert!(views
            .acquire_browser(&"x".repeat(MAX_WORKSPACE_IDENTITY), bounds(10))
            .is_ok());
    }

    #[test]
    fn platform_open_requires_a_published_account_session() {
        let mut views = GuestViews::new(true, true);
        let mut request = platform_request(Some("u-1"));
        request.has_session = false;
        match views.open_platform(request) {
            Err(DshError::Other { code, .. }) => assert_eq!(code, "platform_account_unavailable"),
            other => panic!("expected other, got {other:?}"),
        }
        assert!(views.platform_guest().is_none());
    }

    #[test]
    fn platform_open_accepts_only_the_two_supported_pages() {
        let mut views = GuestViews::new(true, true);
        let mut request = platform_request(Some("u-1"));
        request.page = "https://evil.example".to_string();
        match views.open_platform(request) {
            Err(DshError::InvalidArgument { field, .. }) => assert_eq!(field, "page"),
            other => panic!("expected invalid_argument, got {other:?}"),
        }
    }

    #[test]
    fn platform_open_moves_the_live_document_and_applies_bounds() {
        let mut views = GuestViews::new(true, true);
        let actions = views
            .open_platform(platform_request(Some("u-1")))
            .expect("open");
        assert_eq!(
            actions,
            vec![NativeGuestAction::OpenPlatform {
                generation: views.platform_generation(),
                page: "usage".to_string(),
                origin: "https://platform.example".to_string(),
                partition: platform_partition("https://platform.example", Some("u-1")),
                bounds: bounds(800),
                placement: 1,
            }]
        );
        assert_eq!(
            views.place_platform(bounds(500)).expect("place"),
            vec![NativeGuestAction::PlacePlatform {
                generation: views.platform_generation(),
                bounds: bounds(500),
                placement: 2,
            }]
        );
    }

    /// A newer request retires the previous document before it appears.
    #[test]
    fn platform_open_replaces_the_previous_document() {
        let mut views = GuestViews::new(true, true);
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("first");
        let mut second = platform_request(Some("u-1"));
        second.page = "top-up".to_string();
        let actions = views.open_platform(second).expect("second");
        assert_eq!(actions.len(), 2);
        assert_eq!(
            actions[0],
            NativeGuestAction::ClosePlatform { generation: 1 }
        );
        match &actions[1] {
            NativeGuestAction::OpenPlatform { page, .. } => assert_eq!(page, "top-up"),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(views.platform_guest().expect("live").page, "top-up");
    }

    #[test]
    fn close_drops_the_session_and_place_after_close_is_refused() {
        let mut views = GuestViews::new(true, true);
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("open");
        assert_eq!(
            views.close_platform(),
            vec![NativeGuestAction::ClosePlatform { generation: 1 }]
        );
        assert!(views.platform_guest().is_none());
        assert!(views.close_platform().is_empty(), "close is idempotent");
        match views.place_platform(bounds(10)) {
            Err(DshError::NotFound { entity, .. }) => assert_eq!(entity, "platform view"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    /// The generation advances on every open, so a later operation can tell
    /// that its document was replaced.
    #[test]
    fn platform_generation_advances_on_every_open() {
        let mut views = GuestViews::new(true, true);
        let start = views.platform_generation();
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("first");
        let second = views.platform_generation();
        assert!(second > start);
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("second");
        assert!(views.platform_generation() > second);
    }

    #[test]
    fn an_account_without_an_id_gets_a_temporary_partition() {
        let mut views = GuestViews::new(true, true);
        views.open_platform(platform_request(None)).expect("first");
        let first = views.platform_guest().expect("live").partition.clone();
        views.open_platform(platform_request(None)).expect("second");
        let second = views.platform_guest().expect("live").partition.clone();
        assert_ne!(first, second, "no id means no reusable storage");
    }

    #[test]
    fn teardown_destroys_browser_guests_then_the_platform_document() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("open");
        assert_eq!(
            views.teardown(),
            vec![
                NativeGuestAction::DestroyBrowser { lease },
                NativeGuestAction::ClosePlatform { generation: 1 }
            ]
        );
        assert_eq!(views.browser_lease_count(), 0);
        assert!(views.platform_guest().is_none());
    }

    #[test]
    fn shutdown_retires_guests_and_permanently_closes_admission() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("open");
        assert_eq!(
            views.shutdown(),
            vec![
                NativeGuestAction::DestroyBrowser { lease },
                NativeGuestAction::ClosePlatform { generation: 1 },
            ]
        );
        assert!(!views.browser_available());
        assert!(!views.platform_available());
        assert!(views.acquire_browser("cwd:B", bounds(10)).is_err());
        assert!(views.open_platform(platform_request(Some("u-1"))).is_err());
        assert!(views.shutdown().is_empty());
    }

    /// A disabled capability refuses through the ratified machine code instead
    /// of pretending a guest exists.
    #[test]
    fn disabled_capabilities_refuse_with_their_machine_codes() {
        let mut disabled = GuestViews::new(false, false);
        match disabled.acquire_browser("cwd:A", bounds(10)) {
            Err(DshError::Other { code, .. }) => assert_eq!(code, "browser_guest_unavailable"),
            other => panic!("expected other, got {other:?}"),
        }
        match disabled.open_platform(platform_request(Some("u-1"))) {
            Err(DshError::Other { code, .. }) => assert_eq!(code, "platform_view_unavailable"),
            other => panic!("expected other, got {other:?}"),
        }
        assert_eq!(disabled.teardown(), Vec::new());
    }

    #[test]
    fn platform_origin_must_be_a_url() {
        let mut views = GuestViews::new(true, true);
        let mut request = platform_request(Some("u-1"));
        request.origin = "platform.example".to_string();
        match views.open_platform(request) {
            Err(DshError::InvalidArgument { field, .. }) => assert_eq!(field, "origin"),
            other => panic!("expected invalid_argument, got {other:?}"),
        }
    }

    #[test]
    fn platform_session_flag_tracks_injected_credentials() {
        let mut views = GuestViews::new(true, true);
        views
            .open_platform(platform_request(Some("u-1")))
            .expect("open");
        assert!(!views.platform_guest().expect("live").session_applied);
        // The registry has no native-hook acknowledgement and cannot grant this.
        views.set_platform_session(true);
        assert!(!views.platform_guest().expect("live").session_applied);
        views.set_platform_session(false);
        assert!(!views.platform_guest().expect("live").session_applied);
    }

    #[test]
    fn close_invalidates_captured_generation_even_without_a_live_view() {
        let mut views = GuestViews::new(true, true);
        let captured = views.platform_generation();
        assert!(views.close_platform().is_empty());
        assert_ne!(views.platform_generation(), captured);
        assert!(views.rollback_platform_open(captured).is_empty());
    }

    /// The guest's own documented address is the one the client observes, and a
    /// lease the registry does not own is never updated.
    #[test]
    fn navigation_state_is_recorded_only_for_a_live_lease() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        assert_eq!(
            views.browser_guest(&lease).expect("live").state.url,
            format!("about:blank#{lease}")
        );
        assert!(views.apply_browser_state(GuestBrowserState {
            lease: lease.clone(),
            url: "https://example.com/a".to_string(),
            title: "Example".to_string(),
            loading: true,
            can_go_back: true,
            can_go_forward: false,
            gone: false,
            error: None,
        }));
        let guest = views.browser_guest(&lease).expect("live");
        assert_eq!(guest.state.url, "https://example.com/a");
        assert_eq!(guest.state.title, "Example");
        assert!(guest.state.loading);
        assert!(guest.state.can_go_back);
        assert!(guest.state.error.is_none());
        // The payload carries its own lease, so a report for one guest can never
        // be applied to another — nor to a lease the registry does not own.
        assert!(!views.apply_browser_state(GuestBrowserState {
            lease: "never-issued".to_string(),
            url: "https://example.com/a".to_string(),
            title: String::new(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            gone: false,
            error: None,
        }));
        assert_eq!(
            views.browser_guest(&lease).expect("live").state.url,
            "https://example.com/a",
            "another lease's report changed nothing"
        );
    }

    /// The workspace behind a lease is what the native layer derives the
    /// isolation directory from; it is never the lease itself.
    #[test]
    fn a_lease_reports_the_workspace_its_partition_belongs_to() {
        let mut views = GuestViews::new(true, true);
        let (lease, partition, _) = views
            .acquire_browser("cwd:C:\\work", bounds(10))
            .expect("acquire");
        assert_eq!(views.workspace_of(&lease), Some("cwd:C:\\work"));
        assert_eq!(partition, browser_partition("cwd:C:\\work"));
        assert!(views.workspace_of("never-issued").is_none());
    }

    #[test]
    fn navigation_is_refused_outside_the_guest_policy() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        let application = "http://127.0.0.1:41234";
        assert_eq!(
            views
                .navigate_browser(&lease, "https://example.com/a", Some(application))
                .expect("allowed"),
            vec![NativeGuestAction::NavigateBrowser {
                lease: lease.clone(),
                url: "https://example.com/a".to_string(),
            }]
        );
        for refused in [
            application,
            "javascript:alert(1)",
            "https://user:pw@example.com/",
            "file:///C:/secret.txt",
        ] {
            match views.navigate_browser(&lease, refused, Some(application)) {
                Err(DshError::Other { code, .. }) => {
                    assert_eq!(code, "guest_navigation_refused", "{refused}")
                }
                other => panic!("expected a refusal for {refused}, got {other:?}"),
            }
        }
        match views.navigate_browser("never-issued", "https://example.com/", Some(application)) {
            Err(DshError::NotFound { entity, .. }) => assert_eq!(entity, "browser guest"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    /// Re-requesting the address the guest already shows is a reload, not a new
    /// history entry — the reference's `loadUrl` rule.
    #[test]
    fn reloading_the_current_address_does_not_navigate() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        views.apply_browser_state(GuestBrowserState {
            lease: lease.clone(),
            url: "https://example.com/a".to_string(),
            title: "A".to_string(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            gone: false,
            error: None,
        });
        assert_eq!(
            views
                .navigate_browser(&lease, "https://example.com/a", None)
                .expect("allowed"),
            vec![NativeGuestAction::ReloadBrowser {
                lease: lease.clone()
            }]
        );
        // A failed document is a retry, which is a real navigation again.
        views.apply_browser_state(GuestBrowserState {
            lease: lease.clone(),
            url: "https://example.com/a".to_string(),
            title: "A".to_string(),
            loading: false,
            can_go_back: false,
            can_go_forward: false,
            gone: false,
            error: Some(GuestBrowserFailure {
                code: 13,
                description: "HOST_NAME_NOT_RESOLVED".to_string(),
            }),
        });
        assert_eq!(
            views
                .navigate_browser(&lease, "https://example.com/a", None)
                .expect("allowed"),
            vec![NativeGuestAction::NavigateBrowser {
                lease: lease.clone(),
                url: "https://example.com/a".to_string(),
            }]
        );
    }

    #[test]
    fn navigation_commands_map_to_their_native_step() {
        let mut views = GuestViews::new(true, true);
        let (lease, _, _) = views.acquire_browser("cwd:A", bounds(10)).expect("acquire");
        for (command, expected) in [
            (
                "back",
                NativeGuestAction::GoBackBrowser {
                    lease: lease.clone(),
                },
            ),
            (
                "forward",
                NativeGuestAction::GoForwardBrowser {
                    lease: lease.clone(),
                },
            ),
            (
                "reload",
                NativeGuestAction::ReloadBrowser {
                    lease: lease.clone(),
                },
            ),
        ] {
            assert_eq!(
                views.command_browser(&lease, command).expect(command),
                vec![expected]
            );
        }
        match views.command_browser(&lease, "clear-history") {
            Err(DshError::Other { code, .. }) => assert_eq!(code, "browser_history_unavailable"),
            other => panic!("expected explicit capability refusal, got {other:?}"),
        }
        match views.command_browser(&lease, "print") {
            Err(DshError::InvalidArgument { field, .. }) => assert_eq!(field, "command"),
            other => panic!("expected invalid_argument, got {other:?}"),
        }
        match views.command_browser("never-issued", "reload") {
            Err(DshError::NotFound { entity, .. }) => assert_eq!(entity, "browser guest"),
            other => panic!("expected not_found, got {other:?}"),
        }
    }

    /// The published `embeddedPageDist` reaches the opened document.
    #[test]
    fn embedded_page_dist_is_carried_into_the_open_action() {
        let mut views = GuestViews::new(true, true);
        let mut request = platform_request(Some("u-1"));
        request.embedded_page_dist = Some("stable-2026".to_string());
        views.open_platform(request).expect("open");
        assert_eq!(
            views
                .platform_guest()
                .expect("live")
                .embedded_page_dist
                .as_deref(),
            Some("stable-2026")
        );
    }
}
