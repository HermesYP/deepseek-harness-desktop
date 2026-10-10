//! Guest commands — the `#[tauri::command]` surface the desktop bridge calls.
//!
//! Each command:
//!
//! * takes the invoking `WebviewWindow` and refuses a document the shell does
//!   not own — a guest document can never call these, because the crate root's
//!   `is_owned_application_window` compares both the window label and the
//!   committed document URL against this launch's owned origin;
//! * validates arguments before they reach the native layer;
//! * returns the native steps' completion, never a fabricated success.
//!
//! ## Threading
//!
//! Tauri runs an `async` command on the application's async runtime. Window and
//! webview operations are main-thread work, and the registry lock must never be
//! taken with a blocking lock from an async context, so every command here:
//!
//! 1. takes the registry lock with `lock().await`,
//! 2. drops it before any native call,
//! 3. runs the native batch through [`crate::guests::inner::native::apply_native_actions`]
//!    **on the main thread**, reached by [`MainThreadGuests`],
//! 4. awaits that round trip.
//!
//! The batch is one main-loop message, so two concurrent commands cannot
//! interleave a create and a destroy of the same guest. No lock is held across
//! a suspension point, and no blocking call runs on a worker thread.

use std::sync::Arc;

use dsh_core::error::DshError;
use serde::Deserialize;

use super::geometry::GuestBounds;
use super::host::MainThreadGuests;
use super::registry::{NativeGuestAction, PlatformGuestRequest};

/// `guest_browser_acquire` request (upstream `DesktopBrowserBridge.acquire`).
#[derive(Debug, Deserialize)]
pub struct BrowserAcquireRequest {
    /// Resolved workspace storage identity (`cwd:<path>` or `session:<id>`).
    pub workspace: String,
    /// Renderer rectangle in CSS pixels.
    pub bounds: serde_json::Value,
}

/// `guest_browser_acquire` response (upstream `DesktopBrowserReservation`).
#[derive(Debug, serde::Serialize)]
pub struct BrowserReservation {
    /// Opaque main-issued lease; also the guest view's label.
    pub lease: super::BrowserLeaseId,
    /// Approved storage partition for the guest's workspace.
    pub partition: String,
}

/// `guest_browser_navigate` request.
#[derive(Debug, Deserialize)]
pub struct BrowserNavigateRequest {
    /// The caller's reservation.
    pub lease: String,
    /// Absolute `http`/`https` address.
    pub url: String,
}

/// `guest_browser_command` request (one existing guest's navigation verb).
#[derive(Debug, Deserialize)]
pub struct BrowserCommandRequest {
    /// The caller's reservation.
    pub lease: String,
    /// One of `back`, `forward`, `reload`, `clear-history`.
    pub command: String,
}

/// `guest_browser_release` / `guest_browser_state` request.
#[derive(Debug, Deserialize)]
pub struct BrowserLeaseRequest {
    /// The caller's reservation.
    pub lease: String,
}

/// `guest_browser_set_bounds` request.
#[derive(Debug, Deserialize)]
pub struct BrowserBoundsRequest {
    /// The caller's reservation.
    pub lease: String,
    /// Renderer rectangle in CSS pixels.
    pub bounds: serde_json::Value,
}

/// `guest_platform_open` request (upstream `dshPlatform.open`).
#[derive(Debug, Deserialize)]
pub struct PlatformOpenRequest {
    /// `usage` or `top-up`.
    pub page: String,
    /// Renderer rectangle in CSS pixels.
    pub bounds: serde_json::Value,
}

/// `guest_platform_set_bounds` request.
#[derive(Debug, Deserialize)]
pub struct GuestBoundsRequest {
    /// Renderer rectangle in CSS pixels.
    pub bounds: serde_json::Value,
}

/// Refuse a caller that does not own the application document.
fn require_owned_window(window: &tauri::WebviewWindow) -> Result<(), DshError> {
    if crate::is_owned_application_window(window) {
        Ok(())
    } else {
        Err(DshError::other(
            "guest_unowned_renderer",
            "guest views are available only to the application window",
        ))
    }
}

/// The owned gateway origin every navigation decision is made against.
///
/// `None` before the Host has published one, which the policy treats as
/// "nothing extra is blocked" — exactly the reference's `hostUrl() === undefined`
/// case. The launch token is stripped: only scheme and authority are kept.
fn application_origin(state: &Arc<crate::state::AppState>) -> Option<String> {
    state
        .gateway
        .authenticated_url()
        .parse::<url::Url>()
        .ok()
        .map(|url| url.origin().ascii_serialization())
}

/// Run one ordered batch of native steps on the application's main thread.
async fn perform(
    state: &Arc<crate::state::AppState>,
    guests: &MainThreadGuests,
    actions: Vec<NativeGuestAction>,
) -> Result<(), DshError> {
    if actions.is_empty() {
        return Ok(());
    }
    let user_data = state.paths.user_data.clone();
    guests
        .perform(application_origin(state).as_deref(), &user_data, actions)
        .await
}

/// Reserve one browser guest in its workspace's process-lifetime partition.
///
/// Refuses with the ratified `browser_guest_unavailable` code when the build has
/// no embeddable guest surface, and never returns a lease without a view.
#[tauri::command]
pub async fn guest_browser_acquire(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: BrowserAcquireRequest,
) -> Result<BrowserReservation, DshError> {
    require_owned_window(&window)?;
    let bounds = super::policy::bounds_from_value(Some(&request.bounds))?;
    let (lease, partition, actions) = {
        let mut registry = state.guests.lock().await;
        registry.acquire_browser(&request.workspace, bounds)?
    };
    if let Err(error) = perform(&state, &guests, actions).await {
        // The native create/place batch may have failed after registry
        // precommit. Retire precisely this UUID lease and close any live child.
        let cleanup = state.guests.lock().await.rollback_browser_acquire(&lease);
        let _ = perform(&state, &guests, cleanup).await;
        return Err(error);
    }
    Ok(BrowserReservation { lease, partition })
}

/// Release one reservation; the workspace partition survives.
#[tauri::command]
pub async fn guest_browser_release(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: BrowserLeaseRequest,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let actions = {
        let mut registry = state.guests.lock().await;
        registry.release_browser(&request.lease)
    };
    perform(&state, &guests, actions).await
}

/// Move and show/hide one existing browser guest.
#[tauri::command]
pub async fn guest_browser_set_bounds(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: BrowserBoundsRequest,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let bounds = super::policy::bounds_from_value(Some(&request.bounds))?;
    let actions = {
        let mut registry = state.guests.lock().await;
        registry.place_browser(&request.lease, bounds)?
    };
    perform(&state, &guests, actions).await
}

/// Load one validated address in an existing browser guest.
#[tauri::command]
pub async fn guest_browser_navigate(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: BrowserNavigateRequest,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let origin = application_origin(&state);
    let actions = {
        let mut registry = state.guests.lock().await;
        registry.navigate_browser(&request.lease, &request.url, origin.as_deref())?
    };
    perform(&state, &guests, actions).await
}

/// Move one existing browser guest through its history or reload it.
#[tauri::command]
pub async fn guest_browser_command(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: BrowserCommandRequest,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let actions = {
        let registry = state.guests.lock().await;
        registry.command_browser(&request.lease, &request.command)?
    };
    perform(&state, &guests, actions).await
}

/// Report one guest's current observed document state to the client.
///
/// The answer is the same typed payload `dsh://guests/browser-state` carries,
/// and every field of it is a native observation of the live child webview:
/// nothing is inferred from what the client asked for, a guest that has not
/// reported yet is refused with `guest_state_unavailable` rather than answered
/// with a settled default, and no credential or injected header is part of the
/// payload.
#[tauri::command]
pub async fn guest_browser_state(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: BrowserLeaseRequest,
) -> Result<super::GuestBrowserState, DshError> {
    require_owned_window(&window)?;
    {
        let registry = state.guests.lock().await;
        if registry.browser_guest(&request.lease).is_none() {
            return Err(DshError::not_found("browser guest", &request.lease));
        }
    }
    let observed = guests.observe(&request.lease).await?;
    {
        // Keep the registry's mirror of the guest in step with the observation,
        // which is what the reload-versus-navigate rule reads.
        let mut registry = state.guests.lock().await;
        registry.apply_browser_state(observed.clone());
    }
    Ok(observed)
}

/// Open the embedded Platform document for the current account session.
#[tauri::command]
pub async fn guest_platform_open(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: PlatformOpenRequest,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let bounds = GuestBounds::parse(&request.bounds)?;
    // The credential snapshot is copied and the lock released before any native
    // work: it must never be held across a main-thread round trip, and it is
    // never logged or returned.
    let account = {
        let session = state.platform_session.lock().await;
        session.clone()
    };
    let (actions, generation) = {
        let mut registry = state.guests.lock().await;
        let actions = registry.open_platform(PlatformGuestRequest {
            page: request.page,
            origin: account
                .as_ref()
                .map(|session| session.origin.clone())
                .unwrap_or_default(),
            user_id: account.as_ref().and_then(|session| session.user_id.clone()),
            embedded_page_dist: account
                .as_ref()
                .and_then(|session| session.embedded_page_dist.clone()),
            has_session: account.is_some(),
            bounds,
        })?;
        (actions, registry.platform_generation())
    };
    if let Err(error) = perform(&state, &guests, actions).await {
        let cleanup = state.guests.lock().await.rollback_platform_open(generation);
        let _ = perform(&state, &guests, cleanup).await;
        return Err(error);
    }
    Ok(())
}

/// Move and show/hide the embedded Platform document.
#[tauri::command]
pub async fn guest_platform_set_bounds(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
    request: GuestBoundsRequest,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let bounds = GuestBounds::parse(&request.bounds)?;
    let actions = {
        let mut registry = state.guests.lock().await;
        registry.place_platform(bounds)?
    };
    perform(&state, &guests, actions).await
}

/// Destroy the embedded Platform document and clear its session.
#[tauri::command]
pub async fn guest_platform_close(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
    guests: tauri::State<'_, MainThreadGuests>,
) -> Result<(), DshError> {
    require_owned_window(&window)?;
    let actions = {
        let mut registry = state.guests.lock().await;
        registry.close_platform()
    };
    perform(&state, &guests, actions).await
}

/// Report whether the embedded Platform document is currently open.
#[tauri::command]
pub async fn guest_platform_status(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, Arc<crate::state::AppState>>,
) -> Result<bool, DshError> {
    require_owned_window(&window)?;
    let registry = state.guests.lock().await;
    Ok(registry.platform_guest().is_some())
}
