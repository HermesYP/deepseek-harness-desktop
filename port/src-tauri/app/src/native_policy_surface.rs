//! Local-only mandatory presentation; acknowledgment is an actual renderer round-trip.
use crate::mandatory_update::MandatoryDecision;
use std::{
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tauri::{Manager, WebviewUrl};
use tokio::sync::{oneshot, Mutex as AsyncMutex, Notify};

struct Generation {
    sequence: u64,
    disposed: bool,
    pending: Option<(u64, oneshot::Sender<Result<(), String>>)>,
}
struct Inner {
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    generation: Mutex<Generation>,
    page_ready: Arc<AtomicBool>,
    ready: Arc<Notify>,
    hidden_main: AtomicBool,
    cleanup_done: AtomicBool,
    cleanup: AsyncMutex<Option<oneshot::Receiver<Result<(), String>>>>,
}
#[derive(Clone)]
pub struct NativePolicySurface(Arc<Inner>);
impl NativePolicySurface {
    pub fn prepare(app: &tauri::AppHandle) -> Result<Self, String> {
        let page_ready = Arc::new(AtomicBool::new(false));
        let ready = Arc::new(Notify::new());
        let callback_ready = (page_ready.clone(), ready.clone());
        let window = tauri::WebviewWindowBuilder::new(
            app,
            "mandatory-policy",
            WebviewUrl::App("mandatory-policy.html".into()),
        )
        .title("Mandatory update")
        .data_directory(
            app.state::<Arc<crate::state::AppState>>()
                .paths
                .user_data
                .join("policy-webview"),
        )
        .inner_size(560.0, 460.0)
        .resizable(false)
        .visible(false)
        .on_navigation(is_policy_origin)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |_, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished
                && is_policy_origin(payload.url())
            {
                callback_ready.0.store(true, Ordering::Release);
                callback_ready.1.notify_waiters();
            }
        })
        .build()
        .map_err(|error| format!("mandatory policy window creation failed: {error}"))?;
        let close_app = app.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // As upstream, close requests task-aware Quit instead of
                // dismissing the gate. destroy() skips CloseRequested.
                api.prevent_close();
                let app = close_app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = crate::quit_flow::request_quit(&app).await;
                });
            }
        });
        Ok(Self(Arc::new(Inner {
            app: app.clone(),
            window,
            generation: Mutex::new(Generation {
                sequence: 0,
                disposed: false,
                pending: None,
            }),
            page_ready,
            ready,
            hidden_main: AtomicBool::new(false),
            cleanup_done: AtomicBool::new(false),
            cleanup: AsyncMutex::new(None),
        })))
    }
    fn is_current(inner: &Inner, sequence: u64, decision: &MandatoryDecision) -> bool {
        {
            let generation = inner.generation.lock().unwrap();
            if generation.disposed || generation.sequence != sequence {
                return false;
            }
        }
        if !crate::policy_composition::presentation_is_current(&inner.app, decision) {
            return false;
        }
        let generation = inner.generation.lock().unwrap();
        !generation.disposed && generation.sequence == sequence
    }
    pub async fn acknowledge(&self, sequence: u64) -> Result<(), String> {
        let sender = {
            let mut generation = self.0.generation.lock().unwrap();
            if generation.disposed || generation.sequence != sequence {
                return Err("stale mandatory acknowledgment".into());
            }
            match generation.pending.take() {
                Some((pending_sequence, sender)) if pending_sequence == sequence => sender,
                _ => return Err("unknown mandatory acknowledgment".into()),
            }
        };
        sender
            .send(Ok(()))
            .map_err(|_| "mandatory presentation cancelled".into())
    }
    pub async fn dispose(&self) {
        {
            let mut generation = self.0.generation.lock().unwrap();
            generation.disposed = true;
            generation.pending = None;
        }
        self.0.ready.notify_waiters();
        // Retain the receiver across await. A cancelled disposer cannot strand cleanup.
        let mut cleanup = self.0.cleanup.lock().await;
        if self.0.cleanup_done.load(Ordering::Acquire) {
            return;
        }
        if cleanup.is_none() {
            let (sender, receiver) = oneshot::channel();
            let inner = self.0.clone();
            if let Err(error) = self.0.app.run_on_main_thread(move || {
                let result = inner.window.destroy().map_err(|error| error.to_string());
                let _ = sender.send(result);
            }) {
                tracing::error!(%error, "policy window cleanup dispatch failed");
                return;
            }
            *cleanup = Some(receiver);
        }
        if let Some(receiver) = cleanup.as_mut() {
            match receiver.await {
                Ok(Ok(())) => {
                    self.0.cleanup_done.store(true, Ordering::Release);
                }
                result => {
                    tracing::error!(?result, "policy window destruction failed");
                }
            }
        }
        *cleanup = None;
    }
    async fn dispatch<F>(
        &self,
        deadline: tokio::time::Instant,
        sequence: u64,
        decision: MandatoryDecision,
        effect: F,
    ) -> Result<(), String>
    where
        F: FnOnce(&Inner) -> Result<(), String> + Send + 'static,
    {
        let inner = self.0.clone();
        let (sender, receiver) = oneshot::channel();
        self.0
            .app
            .run_on_main_thread(move || {
                let result = if Self::is_current(&inner, sequence, &decision) {
                    effect(&inner)
                } else {
                    Err("stale mandatory presentation".into())
                };
                let _ = sender.send(result);
            })
            .map_err(|error| error.to_string())?;
        tokio::time::timeout_at(deadline, receiver)
            .await
            .map_err(|_| "mandatory native dispatch deadline")?
            .map_err(|_| "mandatory native dispatch cancelled")?
    }
}
impl crate::policy_owner::PolicyEventSink for NativePolicySurface {
    fn present<'a>(
        &'a self,
        sequence: u64,
        decision: &'a MandatoryDecision,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + 'a>> {
        // Reserve BEFORE polling, revoking every queued closure from an older future.
        {
            let mut generation = self.0.generation.lock().unwrap();
            generation.sequence = sequence;
            generation.pending = None;
        }
        Box::pin(async move {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
            if !Self::is_current(&self.0, sequence, decision) {
                return Err("stale mandatory presentation".into());
            }
            let expected = decision.clone();
            self.dispatch(deadline, sequence, decision.clone(), move |inner| {
                let mut show_policy = expected.blocking;
                if let Some(main) = inner.app.get_webview_window("main") {
                    let visible = main.is_visible().map_err(|error| error.to_string())?;
                    // Initial no-force still needs an ACK before main navigation.
                    // Keep native Close/Quit visible if readiness or IPC fails.
                    show_policy |= !visible;
                    if expected.blocking && visible {
                        if !Self::is_current(inner, sequence, &expected) {
                            return Err("stale mandatory presentation".into());
                        }
                        main.hide().map_err(|error| error.to_string())?;
                        inner.hidden_main.store(true, Ordering::Release);
                    }
                }
                if show_policy {
                    if !Self::is_current(inner, sequence, &expected) {
                        return Err("stale mandatory presentation".into());
                    }
                    inner.window.show().map_err(|error| error.to_string())?;
                    if !Self::is_current(inner, sequence, &expected) {
                        return Err("stale mandatory presentation".into());
                    }
                    inner
                        .window
                        .set_focus()
                        .map_err(|error| error.to_string())?;
                }
                Ok(())
            })
            .await?;
            loop {
                // Register first: Notify::notify_waiters does not retain permits.
                let notified = self.0.ready.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                if !Self::is_current(&self.0, sequence, decision) {
                    return Err("stale mandatory presentation".into());
                }
                if self.0.page_ready.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::timeout_at(deadline, notified)
                    .await
                    .map_err(|_| "mandatory page readiness deadline")?;
            }
            let state = self.0.app.state::<Arc<crate::state::AppState>>();
            let locale = state.locale.lock().await.snapshot().effective;
            let payload = serde_json::json!({"sequence":sequence,"blocking":decision.blocking,"checking":decision.checking,"title":decision.title,"detail":decision.detail,"page":decision.page,"error":decision.error.as_ref().map(|error| format!("{error:?}")),"locale":locale.as_str(),"clientVersion":state.policy.client_version});
            let data = serde_json::to_string(&payload).map_err(|error| error.to_string())?;
            let script = format!(
                "window.__DSH_POLICY_RENDER(JSON.parse({}));",
                serde_json::to_string(&data).map_err(|error| error.to_string())?
            );
            let (sender, receiver) = oneshot::channel();
            {
                let mut generation = self.0.generation.lock().unwrap();
                if generation.disposed || generation.sequence != sequence {
                    return Err("stale mandatory presentation".into());
                }
                generation.pending = Some((sequence, sender));
            }
            self.dispatch(deadline, sequence, decision.clone(), move |inner| {
                inner
                    .window
                    .eval(&script)
                    .map_err(|error| error.to_string())
            })
            .await?;
            tokio::time::timeout_at(deadline, receiver)
                .await
                .map_err(|_| "mandatory renderer acknowledgment deadline")?
                .map_err(|_| "mandatory renderer acknowledgment cancelled")??;
            if !Self::is_current(&self.0, sequence, decision) {
                return Err("stale mandatory renderer acknowledgment".into());
            }
            if !decision.blocking {
                let expected = decision.clone();
                self.dispatch(deadline, sequence, decision.clone(), move |inner| {
                    inner.window.hide().map_err(|error| error.to_string())?;
                    if inner.hidden_main.load(Ordering::Acquire) {
                        if let Some(main) = inner.app.get_webview_window("main") {
                            if !Self::is_current(inner, sequence, &expected) {
                                return Err("stale main restoration".into());
                            }
                            main.show().map_err(|error| error.to_string())?;
                            // Keep ownership on failure or staleness so the next
                            // fresh no-force presentation can retry restoration.
                            inner.hidden_main.store(false, Ordering::Release);
                        }
                    }
                    Ok(())
                })
                .await?;
            }
            Ok(())
        })
    }
}
/// Exact packaged local document, not arbitrary loopback or a network localhost.
pub fn is_policy_origin(url: &url::Url) -> bool {
    let (scheme, host) = if cfg!(target_os = "windows") {
        ("http", "tauri.localhost")
    } else {
        ("tauri", "localhost")
    };
    url.scheme() == scheme
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/mandatory-policy.html"
        && url.query().is_none()
        && url.fragment().is_none()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_document_is_local_exact_and_uncredentialed() {
        let valid = if cfg!(target_os = "windows") {
            "http://tauri.localhost/mandatory-policy.html"
        } else {
            "tauri://localhost/mandatory-policy.html"
        };
        assert!(is_policy_origin(&valid.parse().unwrap()));
        for invalid in [
            "https://tauri.localhost/mandatory-policy.html",
            "http://localhost/mandatory-policy.html",
            "http://tauri.localhost:1234/mandatory-policy.html",
            "http://user@tauri.localhost/mandatory-policy.html",
            "http://tauri.localhost/other.html",
        ] {
            assert!(!is_policy_origin(&invalid.parse().unwrap()));
        }
        for suffix in ["?x=1", "#x"] {
            assert!(!is_policy_origin(
                &format!("{valid}{suffix}").parse().unwrap()
            ));
        }
    }
}
