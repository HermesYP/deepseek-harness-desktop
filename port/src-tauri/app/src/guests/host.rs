//! The main-thread owner of every native guest view.
//!
//! Tauri's window and webview calls are main-thread operations, and an `async`
//! command runs on the application's async runtime. This module is the single
//! place the two are joined: a command describes a batch of
//! [`NativeGuestAction`]s, and [`MainThreadGuests::perform`] runs that batch as
//! one message on the main loop, where the live webviews live.
//!
//! Owning the views here (rather than inside `AppState`) is deliberate: the
//! native map is only ever touched on the main thread, so it needs no async
//! lock, and no command can hold it across a suspension point. Reaching it from
//! a worker thread is impossible by construction — there is no other accessor.
//!
//! The application origin travels the same way. It changes once, when the Host
//! reports its URL, and the navigation hooks that read it run on the WebView2
//! message loop where a `Mutex` is the only correct shared state.

use std::sync::{Arc, Mutex};

use dsh_core::error::DshError;
use tauri::Manager;

use super::native::{application_window, apply_native_actions, GuestContext};
use super::registry::NativeGuestAction;

/// What a dispatched job does about a caller that has stopped waiting.
///
/// The distinction is not cosmetic: a mutation whose caller timed out must not
/// apply, but a teardown whose caller timed out must still run, because the
/// identities it releases have already been retired from the registry and the
/// only remaining owner of those native handles is this main-thread state.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Waiter {
    /// The caller's departure cancels the job, so a stale mutation never applies.
    CancelsJob,
    /// The job runs whatever the caller does, and retains every handle whose
    /// release it cannot confirm.
    AppliesAnyway,
}

/// Handle to the main thread's guest state.
///
/// Stored in `AppState` at `setup`, right after the window exists.
#[derive(Clone, Default)]
pub struct MainThreadGuests {
    context: Option<Arc<Mutex<GuestContext>>>,
    app: Option<tauri::AppHandle<tauri::Wry>>,
}

impl MainThreadGuests {
    /// Record the application origin once it is known.
    pub fn set_application_origin(&self, origin: Option<String>) {
        if let Some(context) = self.context.as_ref() {
            if let Ok(mut guard) = context.lock() {
                guard.set_application_origin(origin);
            }
        }
    }

    /// Run one ordered batch on the application's main thread.
    ///
    /// @param application_origin - owned gateway origin for this batch's
    ///   navigation decisions; recorded before the batch runs so a hook that
    ///   fires during creation already sees it.
    /// @param user_data - application user-data directory.
    /// @param actions - ordered steps from the registry.
    /// @returns after every step ran, or the first failure.
    pub async fn perform(
        &self,
        application_origin: Option<&str>,
        user_data: &std::path::Path,
        actions: Vec<NativeGuestAction>,
    ) -> Result<(), DshError> {
        self.set_application_origin(application_origin.map(str::to_string));
        let user_data = user_data.to_path_buf();
        self.dispatch(move |app, registry, context| {
            let window = application_window(app)?;
            apply_native_actions(app, &window, &user_data, registry, context, actions)
        })
        .await
    }

    /// Read one live guest's last observed document state.
    ///
    /// The answer is the native observation the WebView2 handlers published —
    /// the address, title, loading transition, history availability, failure and
    /// lost-document flag the guest's own document reported — and nothing is
    /// derived from what the client asked for. A lease with no live carrier, or a
    /// carrier that has not reported yet, is refused rather than answered with a
    /// settled-looking default.
    ///
    /// @param lease - the guest's reservation (its webview label is derived).
    /// @returns the observed document state.
    /// @throws {DshError::NotFound} when the lease is not live, or
    ///   `guest_state_unavailable` when it has not been observed yet.
    pub async fn observe(&self, lease: &str) -> Result<super::GuestBrowserState, DshError> {
        let lease = lease.to_string();
        let label = super::native::browser_label(&lease);
        self.dispatch(move |_app, registry, context| {
            if registry.browser_guest(&lease).is_none() {
                return Err(DshError::not_found("browser guest", &lease));
            }
            context.observed(&label).ok_or_else(|| {
                DshError::other(
                    "guest_state_unavailable",
                    "the guest has not reported its document yet",
                )
            })
        })
        .await
    }

    /// Destroy every live guest before the process stops.
    ///
    /// Two things run in one main-thread batch: the registry's own teardown steps,
    /// and a sweep of every native identity this window still owns. The sweep is
    /// what makes a retried exit work — after the registry has retired its guests,
    /// `shutdown()` has no steps left to give, so the empty batch still has to
    /// release the child webviews whose close was refused or whose earlier batch
    /// never reached this thread.
    ///
    /// The job runs even when the caller has already stopped waiting. The exit path
    /// bounds this call, and a timed-out teardown must leave every handle owned —
    /// never dropped — so a later call retries exactly what is left.
    ///
    /// @param user_data - application user-data directory.
    /// @param actions - teardown steps from the registry; empty on a retry.
    /// @returns after every step has run, or the first refusal. A refusal retains
    ///   the handles it could not release.
    pub async fn teardown(
        &self,
        user_data: &std::path::Path,
        actions: Vec<NativeGuestAction>,
    ) -> Result<(), DshError> {
        if actions.is_empty() && self.context.is_none() {
            // A handle with no native state (the profile-lock loser installs none)
            // owns no child, so there is nothing to release and nothing to retry.
            return Ok(());
        }
        let user_data = user_data.to_path_buf();
        self.dispatch_with(Waiter::AppliesAnyway, move |app, registry, context| {
            let batch = if actions.is_empty() {
                Ok(())
            } else {
                let window = application_window(app)?;
                apply_native_actions(app, &window, &user_data, registry, context, actions)
            };
            // The sweep does not depend on the batch: both are evaluated, so a
            // refused step cannot stop the identities it retained from being
            // retried in the same pass.
            let swept = super::native::release_every_guest(context);
            batch.and(swept)
        })
        .await
    }

    /// Schedule one mutation-class job on the main thread and await its result.
    ///
    /// The result must be `Send` because the oneshot channel hands it back to the
    /// awaiting task, which may resume on another worker thread.
    async fn dispatch<T, F>(&self, job: F) -> Result<T, DshError>
    where
        T: Send + 'static,
        F: FnOnce(
                &tauri::AppHandle<tauri::Wry>,
                &mut super::registry::GuestViews,
                &mut GuestContext,
            ) -> Result<T, DshError>
            + Send
            + 'static,
    {
        self.dispatch_with(Waiter::CancelsJob, job).await
    }

    /// Schedule one job on the main thread and await its result.
    ///
    /// @param waiter - what the job does about a caller that never receives the
    ///   outcome.
    /// @param job - the batch to run on the main thread.
    /// @returns the job's outcome.
    async fn dispatch_with<T, F>(&self, waiter: Waiter, job: F) -> Result<T, DshError>
    where
        T: Send + 'static,
        F: FnOnce(
                &tauri::AppHandle<tauri::Wry>,
                &mut super::registry::GuestViews,
                &mut GuestContext,
            ) -> Result<T, DshError>
            + Send
            + 'static,
    {
        let context = self.context.clone().ok_or_else(|| {
            DshError::other(
                "guest_state_unavailable",
                "native guest views are not installed in this application",
            )
        })?;
        let app = self.app.clone().ok_or_else(|| {
            DshError::other(
                "guest_state_unavailable",
                "native guest views are not installed in this application",
            )
        })?;
        let (sender, receiver) = tokio::sync::oneshot::channel::<Result<T, DshError>>();
        let job_app = app.clone();
        let dispatched = app.run_on_main_thread(move || {
            // A waiter that has left cancels work that has not begun, so no stale
            // mutation is applied — except for teardown, where the identities the
            // job would release must not be abandoned (see `Waiter`).
            if waiter == Waiter::CancelsJob && sender.is_closed() {
                return;
            }
            let state = job_app.state::<std::sync::Arc<crate::state::AppState>>();
            let outcome = super::orchestration::with_registry(&state.guests, |registry| {
                let mut guard = context.try_lock().map_err(|_| {
                    DshError::other(
                        "guest_state_unavailable",
                        "the native guest state is busy or unavailable",
                    )
                })?;
                job(&job_app, registry, &mut guard)
            });
            let _ = sender.send(outcome);
        });
        if dispatched.is_err() {
            return Err(DshError::other(
                "guest_main_thread",
                "the application main thread is no longer accepting work",
            ));
        }
        tokio::time::timeout(std::time::Duration::from_secs(5), receiver)
            .await
            .map_err(|_| DshError::other(
                "guest_main_thread_timeout",
                "the main thread did not report the guest outcome within the deadline; do not retry an indeterminate mutation",
            ))?
            .map_err(|_| {
                DshError::other(
                    "guest_main_thread",
                    "the main thread did not report the guest step's outcome",
                )
            })?
    }
}

/// Install the main thread's guest context and return its handle.
///
/// @param app - application handle the batches are scheduled on.
/// @param application_origin - owned gateway origin when already known.
/// @returns the handle stored in `AppState`.
pub fn install(
    app: &tauri::AppHandle<tauri::Wry>,
    application_origin: Option<String>,
) -> MainThreadGuests {
    MainThreadGuests {
        context: Some(Arc::new(Mutex::new(GuestContext::new(application_origin)))),
        app: Some(app.clone()),
    }
}
