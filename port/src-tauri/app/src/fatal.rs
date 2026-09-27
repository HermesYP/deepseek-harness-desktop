//! Native fatal-recovery flow (`apps/desktop/src/fatal-recovery.ts`):
//! first fatal wins, crash report first (bounded by 1 s), then the native
//! dialog — Exit / Restart / Disable third-party plugins, with the
//! `listen EADDRINUSE` special case — looping until a recovery operation
//! succeeds.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use dsh_core::diagnostics::{
    write_crash_report, CrashReportApp, CrashReportInput, CrashReportPhase, CrashReportSource,
    ErrorReport,
};
use dsh_core::error::DshError;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

static REPORTED: AtomicBool = AtomicBool::new(false);

/// Dialog `detail` budget in characters (upstream `DETAIL_BUDGET`).
const DETAIL_BUDGET: usize = 1200;
/// Tail lines of the error kept in the dialog (upstream `DETAIL_TAIL_LINES`).
const DETAIL_TAIL_LINES: usize = 8;

/// Upper bound on waiting for the crash report before the dialog opens
/// (upstream `CRASH_REPORT_WAIT_MS`).
const CRASH_REPORT_WAIT_MS: std::time::Duration = std::time::Duration::from_millis(1_000);

/// Report the first fatal failure of this process and run the recovery action
/// the user chooses. Later reports cannot replace it or open another dialog.
pub async fn report_fatal(app: &tauri::AppHandle, message: &str) -> Result<(), DshError> {
    if REPORTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    let state = app.state::<Arc<AppState>>();
    let messages = {
        let model = state.locale.lock().await;
        crate::state::messages(model.snapshot().effective)
    };
    // The crash report is written first, bounded by `CRASH_REPORT_WAIT_MS`, so
    // the dialog can name it.
    let report_path = tokio::time::timeout(
        CRASH_REPORT_WAIT_MS,
        persist_report(&state, message, CrashReportSource::WebBoot),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let detail = dialog_detail(message, messages, report_path.as_deref());
    let exit = messages.exit_application.to_string();
    let restart = messages.restart_application.to_string();
    loop {
        let buttons = tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
            restart.clone(),
            exit.clone(),
        );
        let confirmed = app
            .dialog()
            .message(detail.clone())
            .title(messages.startup_failed)
            .buttons(buttons)
            .blocking_show();
        if confirmed {
            // Restart: recovery waits for Host shutdown first.
            state.supervisor.stop(false).await.ok();
            crate::quit_flow::arm_skip(dsh_core::quit::QuitSkip::FatalRecoveryExit);
            crate::quit_flow::restart_app_and_host(app).await.ok();
            return Ok(());
        }
        state.supervisor.stop(false).await.ok();
        crate::quit_flow::confirm_exit(app, dsh_core::protocol::QuitReason::FatalRecovery).await;
    }
}

async fn persist_report(
    state: &Arc<AppState>,
    message: &str,
    source: CrashReportSource,
) -> Result<std::path::PathBuf, DshError> {
    let error = ErrorReport::message(message.to_string());
    let stderr = state.supervisor.stderr_tail().await;
    let host_diagnostic = (!stderr.trim().is_empty()).then_some(stderr.as_str());
    let locale = state.locale.lock().await.snapshot().effective;
    let app_facts = CrashReportApp {
        name: dsh_core::paths::PRODUCT_NAME.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        runtime: env!("CARGO_PKG_VERSION").to_string(),
        locale: locale.as_str().to_string(),
    };
    let console = state.renderer_console.lock().await;
    let input = CrashReportInput {
        source,
        phase: if state.supervisor.boot_facts().await.is_some() {
            CrashReportPhase::Running
        } else {
            CrashReportPhase::Startup
        },
        error: &error,
        host_diagnostic,
        renderer_console: console.snapshot(),
        app: &app_facts,
        time: chrono::Utc::now(),
    };
    write_crash_report(&state.paths.logs, &input)
}

/// Compose the dialog detail: the error's last lines (prefixed by the
/// shortening notice when they are not the whole error), then the report path
/// when one was written, then the reinstall advice (upstream `dialogDetail`).
fn dialog_detail(
    error: &str,
    messages: &crate::state::ShellMessages,
    report_path: Option<&std::path::Path>,
) -> String {
    let advice = format!("\n\n{}", messages.startup_reinstall_advice);
    let report = match report_path {
        Some(path) => format!(
            "\n{}",
            crate::state::format_message(
                messages.report_written_to,
                &[("path", &path.display().to_string())],
            )
        ),
        None => String::new(),
    };
    let tail = error
        .split(['\n', '\r'])
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(DETAIL_TAIL_LINES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    let budget = DETAIL_BUDGET
        .saturating_sub(advice.chars().count() + report.chars().count())
        .saturating_sub(messages.diagnostic_truncated.chars().count() + 1);
    let shortened: String = tail
        .chars()
        .rev()
        .take(budget)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let body = if shortened == error {
        error.to_string()
    } else {
        format!("{}\n{shortened}", messages.diagnostic_truncated)
    };
    format!("{body}{report}{advice}")
}
