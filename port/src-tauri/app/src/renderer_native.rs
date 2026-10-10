//! Native main-webview failure observation. JavaScript cannot manufacture these
//! callbacks. Windows hooks are installed on WebView2's UI thread; other native
//! platforms remain an explicitly unqualified release gate.

#[cfg(windows)]
fn publish(app: tauri::AppHandle, failure: crate::renderer_diagnostics::RendererFailure) {
    tauri::async_runtime::spawn(async move {
        // The console tail is a separate, renderer-fed channel; a native failure
        // is reported immediately and is never queued behind it.
        let message = failure.message();
        if let Err(error) = crate::fatal::report_renderer_fatal(&app, &message).await {
            tracing::warn!(error = %crate::renderer_diagnostics::sanitize_field(&crate::renderer_diagnostics::redact(&error.to_string())), "native renderer failure could not be reported");
        }
    });
}

/// Queue Windows hook registration and then the first application navigation.
/// Dispatch failures return immediately; asynchronous COM failures enter fatal recovery.
/// The caller creates an empty webview so application load failures cannot precede the hooks.
pub fn install_and_navigate(
    window: &tauri::WebviewWindow,
    app: &tauri::AppHandle,
    startup_url: url::Url,
) -> Result<(), tauri::Error> {
    #[cfg(windows)]
    {
        use webview2_com::{
            Microsoft::Web::WebView2::Win32::*, NavigationCompletedEventHandler,
            ProcessFailedEventHandler,
        };
        use windows::core::{Interface, BOOL, HSTRING, PWSTR};
        let app = app.clone();
        window.with_webview(move |native| {
            // Dispatch may have been queued before policy changed. Revalidate
            // here, inside the owning native apartment, not only at enqueue.
            if crate::policy_composition::require_normal(&app).is_err() { return; }
            let result = (|| -> windows::core::Result<()> {
                // SAFETY: Only Send Rust values enter this queued closure. COM
                // interfaces and non-Send FnMut handlers are created and used
                // inside WebView2's UI apartment; no COM pointer leaves it.
                // COM retains registered callbacks until destruction. Source's
                // allocation is released by take_pwstr on this same thread.
                unsafe {
                    let webview = native.controller().CoreWebView2()?;
                    let navigation_app = app.clone();
                    let navigation = NavigationCompletedEventHandler::create(Box::new(move |sender, args| {
                        let Some(args) = args else { return Ok(()); };
                        let mut success = BOOL::default();
                        args.IsSuccess(&mut success)?;
                        if success.as_bool() { return Ok(()); }
                        let mut status = COREWEBVIEW2_WEB_ERROR_STATUS::default();
                        args.WebErrorStatus(&mut status)?;
                        if status == COREWEBVIEW2_WEB_ERROR_STATUS_OPERATION_CANCELED { return Ok(()); }
                        let mut source = PWSTR::null();
                        let url = if let Some(sender) = sender {
                            sender.Source(&mut source)?;
                            webview2_com::take_pwstr(source)
                        } else {
                            "owned application".to_owned()
                        };
                        // Keep the native status distinct from Chromium's -3
                        // ERR_ABORTED convention; enum values are not net codes.
                        publish(
                            navigation_app.clone(),
                            crate::renderer_diagnostics::RendererFailure::native_load(url, status.0),
                        );
                        Ok(())
                    }));
                    let mut navigation_token = 0;
                    webview.add_NavigationCompleted(&navigation, &mut navigation_token)?;
                    let failure_app = app.clone();
                    let process = ProcessFailedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()); };
                        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                        args.ProcessFailedKind(&mut kind)?;
                        // Subframe/utility failures and temporary unresponsiveness
                        // are not the reference's main-renderer exit condition.
                        if kind != COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
                            && kind != COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                            return Ok(());
                        }
                        let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                        if let Ok(details) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                            details.Reason(&mut reason)?;
                        }
                        publish(
                            failure_app.clone(),
                            crate::renderer_diagnostics::RendererFailure::native_process_gone(kind.0, reason.0),
                        );
                        Ok(())
                    }));
                    let mut process_token = 0;
                    if let Err(error) = webview.add_ProcessFailed(&process, &mut process_token) {
                        let _ = webview.remove_NavigationCompleted(navigation_token);
                        return Err(error);
                    }
                    // COM keeps the registered handlers until webview destruction.
                    tracing::info!("native main renderer failure hooks installed");
                    webview.Navigate(&HSTRING::from(startup_url.as_str()))?;
                }
                Ok(())
            })();
            if let Err(error) = result {
                tracing::error!(code = ?error.code(), "native renderer failure hooks unavailable; native qualification failed");
                let message = format!("Native renderer diagnostics could not initialize ({:?})", error.code());
                tauri::async_runtime::spawn(async move {
                    if let Err(report_error) = crate::fatal::report_renderer_fatal(&app, &message).await {
                        tracing::warn!(error = %crate::renderer_diagnostics::sanitize_field(&crate::renderer_diagnostics::redact(&report_error.to_string())), "native hook initialization failure could not be reported");
                    }
                });
            }
        })
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        tracing::warn!("native renderer failure hooks are not qualified on this platform");
        if crate::policy_composition::require_normal(app).is_err() {
            return Err(tauri::Error::Io(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "mandatory policy revoked navigation",
            )));
        }
        window.navigate(startup_url)
    }
}
