//! Windows OS-resume wakeup for the updater's existing automatic schedule.
//!
//! Focus is not OS resume. Neither wakeup forces a check before the completion
//! deadline or failure backoff. The subclass retains no app handle or heap data;
//! WM_NCDESTROY removes it on the same UI thread that owns the main window.

#[cfg(any(windows, test))]
const WM_POWERBROADCAST_MESSAGE: u32 = 0x0218;
#[cfg(any(windows, test))]
const PBT_APMRESUMESUSPEND_SIGNAL: usize = 0x0007;
#[cfg(any(windows, test))]
const PBT_APMRESUMEAUTOMATIC_SIGNAL: usize = 0x0012;

#[cfg(any(windows, test))]
fn is_resume_message(message: u32, signal: usize) -> bool {
    message == WM_POWERBROADCAST_MESSAGE
        && matches!(
            signal,
            PBT_APMRESUMESUSPEND_SIGNAL | PBT_APMRESUMEAUTOMATIC_SIGNAL
        )
}

#[cfg(windows)]
mod native {
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::WM_NCDESTROY;

    const SUBCLASS_ID: usize = 0x4453_4852; // DSHR, distinct from renderer hooks.

    unsafe extern "system" fn window_proc(
        window: HWND,
        message: u32,
        parameter: WPARAM,
        data: LPARAM,
        subclass_id: usize,
        _reference_data: usize,
    ) -> LRESULT {
        if super::is_resume_message(message, parameter.0) {
            // Never unwind across the OS callback boundary. This only enqueues
            // a wakeup; network checks remain on the managed async runner.
            let _ = std::panic::catch_unwind(|| {
                crate::update_flow::request_check(crate::update_schedule::CheckTrigger::Resume);
                crate::policy_composition::resume();
            });
        }
        if message == WM_NCDESTROY {
            // No queued dispatch, blocking wait, leaked Box, or AppHandle cycle.
            unsafe {
                let _ = RemoveWindowSubclass(window, Some(window_proc), subclass_id);
            }
        }
        unsafe { DefSubclassProc(window, message, parameter, data) }
    }

    pub(super) fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
        if window.label() != "main" {
            return Err("power resume hook requires the owned main window".into());
        }
        let handle = window.hwnd().map_err(|error| error.to_string())?;
        let handle = HWND(handle.0);
        // Called in setup on the window's owning UI thread, before navigation.
        if !unsafe { SetWindowSubclass(handle, Some(window_proc), SUBCLASS_ID, 0) }.as_bool() {
            return Err("could not install the Windows power resume hook".into());
        }
        Ok(())
    }
}

pub fn install(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    {
        native::install(window)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_windows_resume_notifications_wake_the_automatic_schedule() {
        assert!(is_resume_message(
            WM_POWERBROADCAST_MESSAGE,
            PBT_APMRESUMESUSPEND_SIGNAL
        ));
        assert!(is_resume_message(
            WM_POWERBROADCAST_MESSAGE,
            PBT_APMRESUMEAUTOMATIC_SIGNAL
        ));
    }

    #[test]
    fn focus_suspend_query_and_unrelated_signals_are_not_resume() {
        for signal in [0, 1, 2, 4, 6, 10, usize::MAX] {
            assert!(!is_resume_message(WM_POWERBROADCAST_MESSAGE, signal));
        }
        assert!(!is_resume_message(0x0007, PBT_APMRESUMEAUTOMATIC_SIGNAL)); // WM_SETFOCUS
        assert!(!is_resume_message(0x0082, PBT_APMRESUMEAUTOMATIC_SIGNAL)); // WM_NCDESTROY
    }
}
