//! The ordinary quit flow: host inspection → the quit decision table
//! (`dsh-core::quit`) → the native confirmation → clean shutdown.
//!
//! Rules preserved (`apps/desktop/README.md` "Closing the window and quitting"):
//! every ordinary quit entry asks the Host what it would interrupt; nothing
//! interruptible quits silently; otherwise a native message box without an
//! owner window asks with the correct explanation; concurrent quit requests
//! join the open dialog; the skip rules bypass inspection and confirmation
//! (installer restart, fatal-recovery exit, dev Restart, OS shutdown).

use std::sync::atomic::{AtomicU8, Ordering};

use dsh_core::error::DshError;
use dsh_core::protocol::{QuitReason, ShellQuitConfirmedEvent};
use dsh_core::quit::{decide_quit, QuitAction, QuitHostState, QuitPrompt, QuitRequest, QuitSkip};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// Armed skip rule (process-wide; set by installer / fatal-recovery / dev
/// restart / OS shutdown paths before requesting the quit).
static QUIT_SKIP: AtomicU8 = AtomicU8::new(0);

/// Arm one skip rule: subsequent quits proceed silently.
pub fn arm_skip(skip: QuitSkip) {
    QUIT_SKIP.store(
        match skip {
            QuitSkip::InstallerRestart => 1,
            QuitSkip::FatalRecoveryExit => 2,
            QuitSkip::DevRestart => 3,
            QuitSkip::OsShutdown => 4,
        },
        Ordering::SeqCst,
    );
}

fn armed_skip() -> Option<QuitSkip> {
    match QUIT_SKIP.load(Ordering::SeqCst) {
        1 => Some(QuitSkip::InstallerRestart),
        2 => Some(QuitSkip::FatalRecoveryExit),
        3 => Some(QuitSkip::DevRestart),
        4 => Some(QuitSkip::OsShutdown),
        _ => None,
    }
}

/// One ordinary quit entrypoint (idempotent; concurrent requests join).
pub async fn request_quit(app: &tauri::AppHandle) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    {
        let mut flow = state.quit_flow.lock().await;
        match flow.request() {
            QuitRequest::Ignored => return Ok(()),
            QuitRequest::Join => {
                // Focus the open confirmation instead of stacking a second one.
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.unminimize();
                    let _ = window.show();
                    let _ = window.set_focus();
                }
                return Ok(());
            }
            QuitRequest::Start => {}
        }
    };
    let decision = {
        let host = QuitHostState::from_runtime_state(state.supervisor.status().state);
        let inspection = if host == QuitHostState::Ready {
            state.supervisor.quit_inspection_outcome().await
        } else {
            // A Host that has not reached ready or has failed cannot run tasks.
            dsh_core::quit::QuitInspectionOutcome::Unknown
        };
        decide_quit(armed_skip(), host, &inspection)
    };
    let confirmed = match decision {
        QuitAction::Proceed(reason) => confirm_exit(app, reason).await,
        QuitAction::Ask(prompt) => ask(app, prompt).await,
    };
    let mut flow = state.quit_flow.lock().await;
    if confirmed {
        drop(flow);
        confirm_exit(app, QuitReason::User).await;
    } else {
        // Cancel changes nothing; the flow reopens for the next request.
        flow.finish();
    }
    Ok(())
}

/// The native confirmation (no owner window: hidden windows stay hidden).
/// Button order follows each platform: macOS lays buttons out right-to-left
/// from index 0 (Cancel left of Quit); the Windows task dialog keeps array
/// order (Quit left of Cancel).
async fn ask(app: &tauri::AppHandle, prompt: QuitPrompt) -> bool {
    let state = app.state::<std::sync::Arc<AppState>>();
    let messages = {
        let model = state.locale.lock().await;
        crate::state::messages(model.snapshot().effective)
    };
    let detail = match prompt {
        QuitPrompt::ActiveTasks => messages.quit_active_tasks,
        QuitPrompt::ScheduledTasks => messages.quit_scheduled_tasks,
        QuitPrompt::ActiveAndScheduledTasks => messages.quit_active_and_scheduled_tasks,
    };
    let quit = messages.quit.to_string();
    let cancel = messages.cancel.to_string();
    let answer = app
        .dialog()
        .message(format!("{}\n\n{detail}", messages.quit_title))
        .title(messages.quit_title)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            quit.clone(),
            cancel.clone(),
        ))
        .blocking_show();
    answer
}

/// Terminal quit: emit `dsh://shell/quit-confirmed`, stop the runtime tree
/// (graceful then forced), flush logs, and exit.
pub async fn confirm_exit(app: &tauri::AppHandle, reason: QuitReason) -> ! {
    let state = app.state::<std::sync::Arc<AppState>>();
    app.emit(
        "dsh://shell/quit-confirmed",
        &ShellQuitConfirmedEvent { reason },
    )
    .ok();
    state.quit_flow.lock().await.bypass(reason);
    // Clean shutdown: graceful stop with forced tree kill behind it; crash
    // reports are already durable (synchronous writes).
    state.supervisor.stop(false).await.ok();
    app.exit(0);
    // `AppHandle::exit` terminates the process; keep the divergent type.
    std::process::exit(0);
}

/// Development "Restart App and Host": skip confirmation, stop the Host, then
/// relaunch the application (`apps/desktop/README.md` Develop).
pub async fn restart_app_and_host(app: &tauri::AppHandle) -> Result<(), DshError> {
    arm_skip(QuitSkip::DevRestart);
    let state = app.state::<std::sync::Arc<AppState>>();
    state.supervisor.stop(false).await.ok();
    let executable =
        std::env::current_exe().map_err(|e| DshError::io("resolve executable", None, &e))?;
    std::process::Command::new(executable)
        .spawn()
        .map_err(|e| DshError::io("relaunch", None, &e))?;
    confirm_exit(app, QuitReason::User).await;
}
