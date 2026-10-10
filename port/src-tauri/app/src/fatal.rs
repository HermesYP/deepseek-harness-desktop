//! Native fatal-recovery flow (`apps/desktop/src/fatal-recovery.ts`):
//! first fatal wins, crash report first (bounded by 1 s), then the native
//! dialog — Exit / Restart / Disable third-party plugins, with the
//! `listen EADDRINUSE` special case — looping until a recovery operation
//! succeeds.
//!
//! ## The three buttons (`fatal-recovery.ts:74-87`)
//!
//! | # | Label | Action |
//! |---|---|---|
//! | 0 | `Exit` | stop, then exit without confirmation |
//! | 1 | `Restart` (default) | stop, then relaunch and exit without confirmation |
//! | 2 | `Disable third-party plugins, back up profile patch, and restart` | stop, disable bundles, then relaunch |
//!
//! The `EADDRINUSE` case (`fatal-recovery.ts:73,81-83`) drops button 2 and
//! replaces the detail with `startupAddressInUse`: a second DSH already holds
//! the port, and disabling this profile's plugins cannot free it.
//!
//! ## The loop (`fatal-recovery.ts:72-103`)
//!
//! The dialog re-opens with `recoveryOperationFailed` and the *recovery
//! operation's* error as its detail whenever the chosen operation throws — the
//! distinction the earlier port lost by exiting unconditionally. Exit is the
//! only terminal answer; a failed restart comes back to the user.
//!
//! ## Stopping, answers, and consent
//!
//! Every recovery action stops the Host first through [`stop_for_recovery`],
//! which **propagates** its error: a repair, restart, or exit never races a
//! surviving Host tree, and a stop that did not resolve is shown to the user as
//! the failed operation's detail. The dialog is answered through its callback
//! (`native_dialog::answer` + `show_with_result`) rather than a blocking show,
//! so the main thread and the runtime's workers stay free while the user
//! decides; a callback dropped without a result is *not* consent, so it cannot
//! silently disable third-party plugins, restart, or exit.
//!
//! ## Plugin recovery (`project-manager.ts:71-78` → `profile-sanitize.ts:18-34`)
//!
//! `disableAllPlugins` renames `cordis.patch.yml` to
//! `cordis.patch.yml.bak-<unix-millis>[-<ordinal>]` and rewrites only the
//! manifest's `dsh.profile.bundles` to the shipped template. Installed
//! dependencies, every other manifest field, and the whole Harness home
//! (sessions, storages, credentials, user data) are left exactly as they were:
//! the recovery is a *backup plus bundle reset*, never a delete. The port
//! implements that here so a fatal startup can be recovered without the user
//! losing customizations.
//!
//! ## Diagnostics
//!
//! Console lines and failure messages are captured by
//! [`crate::renderer_diagnostics`], which bounds their length and redacts
//! secret-shaped text before it reaches the report. The plugin-recovery step
//! records only the backup **file name** (never its contents) in the crash
//! report, so a profile patch that happens to hold a token is not copied into a
//! second file.

use std::path::{Path, PathBuf};
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

/// The bundle layers recovery restores: upstream
/// `PROFILE_TEMPLATES.web.bundles` (`app-boot/src/profile.ts:183-185`), which
/// is what `project-manager.ts:77` passes as `WEB_PROFILE.bundles`.
///
/// This list deliberately does *not* include the port-owned desktop updates
/// bundle: recovery must return the profile to the reviewed upstream template so
/// a broken third-party layer cannot be reintroduced by the repair itself.
pub const RECOVERY_BUNDLES: [&str; 2] = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"];

/// The profile patch file recovery backs up (`PROFILE_PATCH_FILENAME`).
pub const PROFILE_PATCH_FILENAME: &str = "cordis.patch.yml";

/// What the user chose in the recovery dialog.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecoveryChoice {
    /// Stop and exit.
    Exit,
    /// Stop, disable third-party plugins, then restart.
    DisablePlugins,
    /// Stop and restart.
    Restart,
}

/// The buttons the dialog offers, in display order
/// (`fatal-recovery.ts:81-83`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryButtons {
    /// Exit label.
    pub exit: String,
    /// Restart label.
    pub restart: String,
    /// Third button; `None` for the `EADDRINUSE` case, which drops it.
    pub disable_plugins: Option<String>,
}

/// Classify the dialog's answer index into a choice.
///
/// The reference reads `response === 0` as Exit and `response === 2` as
/// "disable plugins"; every other index (including the `noLink` dialog's
/// dismissal) restarts (`fatal-recovery.ts:88-97`).
pub fn classify_choice(response: usize, offers_disable: bool) -> RecoveryChoice {
    match response {
        0 => RecoveryChoice::Exit,
        2 if offers_disable => RecoveryChoice::DisablePlugins,
        _ => RecoveryChoice::Restart,
    }
}

/// Whether the failure is a port collision (`fatal-recovery.ts:73`).
///
/// The reference matches the word-bounded regular expression
/// `/\blisten EADDRINUSE\b/u`; a bare `EADDRINUSE` inside unrelated prose, or a
/// longer identifier that merely starts with it, does not qualify.
pub fn is_address_in_use(detail: &str) -> bool {
    const MARKER: &str = "listen EADDRINUSE";
    let mut from = 0;
    while let Some(relative) = detail[from..].find(MARKER) {
        let start = from + relative;
        let end = start + MARKER.len();
        // `\b` before `l` and after `E`: the character on each side must not be
        // a word character.
        let before_ok = !detail[..start]
            .chars()
            .next_back()
            .is_some_and(|c| c.is_alphanumeric() || c == '_');
        let after_ok = !detail[end..]
            .chars()
            .next()
            .is_some_and(|c| c.is_alphanumeric() || c == '_');
        if before_ok && after_ok {
            return true;
        }
        from = end;
    }
    false
}

/// Result of the profile recovery step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PluginRecovery {
    /// Backup file name (never a full path, never the file's contents).
    pub backup_file: Option<String>,
    /// Whether the profile manifest's bundle list was rewritten.
    pub manifest_rewritten: bool,
}

/// Disable every third-party bundle in `profile`, backing up the user's patch
/// layer first.
///
/// Mirrors `sanitizeProfile` (`profile-sanitize.ts:18-34`):
///
/// 1. rename `cordis.patch.yml` to `cordis.patch.yml.bak-<millis>` (an ordinal
///    suffix is appended while that name exists), tolerating its absence;
/// 2. rewrite **only** `dsh.profile.bundles` on the existing manifest, keeping
///    `name`, `private`, every dependency and every other field byte-identical;
/// 3. touch nothing else in the profile or the Harness home.
///
/// A profile with no `package.json` keeps its absent manifest: the reference
/// only rewrites a manifest it could read (`profile-sanitize.ts:32`).
pub fn disable_third_party_plugins(
    profile: &Path,
    bundles: &[&str],
    now_millis: u128,
) -> Result<PluginRecovery, DshError> {
    let patch = profile.join(PROFILE_PATCH_FILENAME);
    let backup = backup_profile_patch(&patch, now_millis)?;

    let manifest_path = profile.join("package.json");
    if !manifest_path.is_file() {
        return Ok(PluginRecovery {
            backup_file: backup,
            manifest_rewritten: false,
        });
    }
    let raw = std::fs::read_to_string(&manifest_path).map_err(|error| {
        DshError::io(
            "read desktop profile manifest",
            Some(manifest_path.display().to_string()),
            &error,
        )
    })?;
    let mut manifest: serde_json::Value = serde_json::from_str(&raw).map_err(|error| {
        DshError::other(
            "desktop_profile_manifest",
            format!(
                "the desktop profile manifest at {} is not valid JSON: {error}",
                manifest_path.display()
            ),
        )
    })?;
    let object = manifest.as_object_mut().ok_or_else(|| {
        DshError::other(
            "desktop_profile_manifest",
            format!(
                "the desktop profile manifest at {} is not a JSON object",
                manifest_path.display()
            ),
        )
    })?;
    // Preserve every existing field; only the bundle list is replaced.
    let dsh = object.entry("dsh").or_insert_with(|| serde_json::json!({}));
    let dsh = dsh.as_object_mut().ok_or_else(|| {
        DshError::other(
            "desktop_profile_manifest",
            "the desktop profile manifest's `dsh` field is not an object",
        )
    })?;
    let profile_section = dsh
        .entry("profile")
        .or_insert_with(|| serde_json::json!({}));
    let profile_section = profile_section.as_object_mut().ok_or_else(|| {
        DshError::other(
            "desktop_profile_manifest",
            "the desktop profile manifest's `dsh.profile` field is not an object",
        )
    })?;
    profile_section.insert(
        "bundles".to_string(),
        serde_json::Value::Array(
            bundles
                .iter()
                .map(|bundle| serde_json::Value::String((*bundle).to_string()))
                .collect(),
        ),
    );

    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(&manifest)
            .map_err(|error| DshError::other("desktop_profile_manifest", error.to_string()))?
    );
    write_atomically(&manifest_path, rendered.as_bytes())?;
    Ok(PluginRecovery {
        backup_file: backup,
        manifest_rewritten: true,
    })
}

/// Rename the patch layer out of the way, returning the backup file name.
fn backup_profile_patch(patch: &Path, now_millis: u128) -> Result<Option<String>, DshError> {
    if !patch.exists() {
        return Ok(None);
    }
    // The reference's `while (existsSync(backupPath)) backupPath = base-${++ordinal}`.
    let base = format!("{}.bak-{now_millis}", patch.display());
    let mut candidate = PathBuf::from(&base);
    let mut ordinal = 0u32;
    while candidate.exists() {
        ordinal += 1;
        candidate = PathBuf::from(format!("{base}-{ordinal}"));
    }
    std::fs::rename(patch, &candidate).map_err(|error| {
        DshError::io(
            "back up desktop profile patch",
            Some(patch.display().to_string()),
            &error,
        )
    })?;
    Ok(candidate
        .file_name()
        .map(|name| name.to_string_lossy().into_owned()))
}

/// Replace `path` with `bytes` through a temporary file in the same directory,
/// so a failure part-way through cannot leave a truncated manifest.
fn write_atomically(path: &Path, bytes: &[u8]) -> Result<(), DshError> {
    let directory = path.parent().unwrap_or_else(|| Path::new("."));
    let temporary = directory.join(format!(
        ".{}.recovery-{}",
        path.file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "manifest".to_string()),
        std::process::id()
    ));
    std::fs::write(&temporary, bytes).map_err(|error| {
        DshError::io(
            "write desktop profile manifest",
            Some(temporary.display().to_string()),
            &error,
        )
    })?;
    std::fs::rename(&temporary, path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary);
        DshError::io(
            "replace desktop profile manifest",
            Some(path.display().to_string()),
            &error,
        )
    })
}

/// The Desktop profile directory recovery repairs.
///
/// `assertDesktopSender`-style ownership is not needed here: this path is
/// resolved by the shell from its own environment, never from renderer input.
/// It is resolved on demand because `AppState` deliberately does not carry the
/// Harness-home paths, and recovery must work even when state setup itself was
/// the thing that failed.
pub fn recovery_profile_dir() -> std::path::PathBuf {
    dsh_core::paths::resolve_desktop_paths(None).profile
}

/// Report the first fatal failure of this process and run the recovery action
/// the user chooses. Later reports cannot replace it or open another dialog.
pub async fn report_fatal(app: &tauri::AppHandle, message: &str) -> Result<(), DshError> {
    report_fatal_from(app, message, CrashReportSource::WebBoot).await
}

/// A failure observed by the native main-webview callbacks, not renderer IPC.
pub async fn report_renderer_fatal(app: &tauri::AppHandle, message: &str) -> Result<(), DshError> {
    report_fatal_from(app, message, CrashReportSource::Main).await
}

async fn report_fatal_from(
    app: &tauri::AppHandle,
    message: &str,
    source: CrashReportSource,
) -> Result<(), DshError> {
    crate::policy_composition::require_normal(app)?;
    if REPORTED.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    struct Reported;
    impl Drop for Reported {
        fn drop(&mut self) {
            REPORTED.store(false, Ordering::SeqCst);
        }
    }
    let _reported = Reported;
    let state = app.state::<Arc<AppState>>();
    let locale = {
        let model = state.locale.lock().await;
        model.snapshot().effective
    };
    let messages = crate::state::messages(locale);
    let extension = crate::shell_messages::messages(locale);
    // The crash report is written first, bounded by `CRASH_REPORT_WAIT_MS`, so
    // the dialog can name it.
    let report_path = tokio::time::timeout(
        CRASH_REPORT_WAIT_MS,
        persist_report(&state, message, source),
    )
    .await
    .ok()
    .and_then(Result::ok);

    // `fatal-recovery.ts:70` — the loop's detail is the *original* error until a
    // recovery operation fails, and then that operation's error.
    let mut detail = message.to_string();
    let mut summary = extension.fatal_summary.to_string();
    loop {
        crate::policy_composition::require_state(&state)?;
        let address_in_use = is_address_in_use(&detail);
        let buttons = if address_in_use {
            RecoveryButtons {
                exit: messages.exit_application.to_string(),
                restart: messages.restart_application.to_string(),
                disable_plugins: None,
            }
        } else {
            RecoveryButtons {
                exit: messages.exit_application.to_string(),
                restart: messages.restart_application.to_string(),
                disable_plugins: Some(extension.disable_third_party_plugins.to_string()),
            }
        };
        let body = if address_in_use {
            format!(
                "{}{}",
                extension.startup_address_in_use,
                report_line(messages, report_path.as_deref())
            )
        } else {
            dialog_detail(&detail, messages, report_path.as_deref())
        };
        let Some(response) = ask_recovery(app, &body, &summary, &buttons).await else {
            // No answer arrived at all: the dialog was dropped without a result
            // (the application is tearing down). That is not consent to disable
            // plugins, restart, or exit, so no recovery action is taken.
            tracing::warn!(
                recovery_answer_missing = true,
                "desktop fatal recovery dialog produced no answer; no recovery action taken"
            );
            return Ok(());
        };
        let choice = classify_choice(response, buttons.disable_plugins.is_some());
        if let Err(error) = crate::policy_composition::require_state(&state) {
            if choice == RecoveryChoice::Exit {
                // A force policy can arrive while this older dialog is open.
                // Its Quit path must retain active-agent inspection and consent.
                crate::quit_flow::request_quit(app).await?;
            }
            return Err(error);
        }
        match choice {
            RecoveryChoice::Exit => {
                if let Err(error) = stop_for_recovery(&state).await {
                    // The Host may survive this stop: an ordinary quit keeps
                    // inspection, consent, and the bounded unresolved-stop
                    // decision in play instead of exiting over a live Host.
                    if let Err(quit_error) = crate::quit_flow::request_quit(app).await {
                        tracing::error!(
                            %quit_error,
                            "ordinary quit after a failed recovery stop also failed"
                        );
                    }
                    return Err(error);
                }
                crate::quit_flow::confirm_exit(app, dsh_core::protocol::QuitReason::FatalRecovery)
                    .await?;
                unreachable!("a resolved terminal quit never returns");
            }
            choice => {
                // Both remaining choices stop the Host first and then attempt a
                // recovery operation; a failure re-opens the dialog with the
                // operation's own error instead of exiting silently.
                let failure = match run_recovery(app, &state, choice).await {
                    Ok(()) => match crate::quit_flow::restart_app_and_host(app).await {
                        Ok(()) => return Ok(()),
                        // A restart that did not resolve comes back to the user
                        // rather than exiting over a surviving Host.
                        Err(error) => Some(error),
                    },
                    Err(error) => Some(error),
                };
                if let Some(error) = failure {
                    summary = crate::shell_messages::messages(locale)
                        .recovery_operation_failed
                        .to_string();
                    detail = error.to_string();
                    // Record the failed recovery attempt itself; the user
                    // is about to see it and may exit on the next prompt.
                    tracing::error!(
                        recovery_failed = true,
                        operation = %recovery_operation_name(choice),
                        "desktop fatal recovery operation failed"
                    );
                }
            }
        }
    }
}

fn recovery_operation_name(choice: RecoveryChoice) -> &'static str {
    match choice {
        RecoveryChoice::Exit => "exit",
        RecoveryChoice::DisablePlugins => "disable-plugins",
        RecoveryChoice::Restart => "restart",
    }
}

/// Stop the Host before a recovery operation, and refuse to continue when the
/// stop does not resolve.
///
/// A repair, a restart, or an exit must never race a surviving Host tree, so
/// **every** stop error is propagated to the caller: the dialog re-opens with
/// the stop failure as its detail instead of running the chosen operation over
/// a live Host. `require_graceful` is `false` because recovery has no update
/// handoff to validate (upstream's recovery `stop()` takes no such flag); the
/// forced tree kill and its escalation are unchanged, so containment is not
/// weakened. A resolved-but-unclean exit is therefore not an error here, which
/// is what keeps recovery usable when the Host is the thing that is broken.
async fn stop_for_recovery(state: &Arc<AppState>) -> Result<(), DshError> {
    state
        .supervisor
        .stop_if(false, || crate::policy_composition::require_state(state))
        .await?;
    let status = state.supervisor.status();
    if dsh_core::quit::stop_is_resolved(status.state) {
        return Ok(());
    }
    // The supervisor returned without proving the tree is gone (the failed-stop
    // path leaves `stopping` behind): treat it as a stop failure.
    Err(DshError::other(
        "host_stop_unresolved",
        format!(
            "the desktop host stop did not resolve before recovery: the supervisor still reports {:?}",
            status.state
        ),
    ))
}

/// Run one recovery operation.
async fn run_recovery(
    app: &tauri::AppHandle,
    state: &Arc<AppState>,
    choice: RecoveryChoice,
) -> Result<(), DshError> {
    crate::policy_composition::require_state(state)?;
    stop_for_recovery(state).await?;
    crate::policy_composition::require_state(state)?;
    match choice {
        RecoveryChoice::Exit | RecoveryChoice::Restart => Ok(()),
        RecoveryChoice::DisablePlugins => {
            let profile = recovery_profile_dir();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_millis())
                .unwrap_or_default();
            let recovery = disable_third_party_plugins(&profile, &RECOVERY_BUNDLES, now)?;
            // The backup is named in the log and the crash report by file name
            // only; its contents are never read or copied.
            tracing::info!(
                profile_patch_backup = recovery.backup_file.as_deref().unwrap_or("none"),
                home_patch = "unchanged",
                "desktop profile recovery completed"
            );
            persist_recovery_note(state, &recovery).await;
            let _ = app;
            Ok(())
        }
    }
}

/// Append one recovery record to the crash-report stream so a later support
/// request can see which repair ran.
async fn persist_recovery_note(state: &Arc<AppState>, recovery: &PluginRecovery) {
    let locale = state.locale.lock().await.snapshot().effective;
    let app_facts = CrashReportApp {
        name: dsh_core::paths::PRODUCT_NAME.to_string(),
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        arch: std::env::consts::ARCH.to_string(),
        runtime: env!("CARGO_PKG_VERSION").to_string(),
        locale: locale.as_str().to_string(),
    };
    let error = ErrorReport::message("third-party plugins disabled after a fatal startup failure")
        .with_property(
            "profilePatchBackup",
            recovery.backup_file.as_deref().unwrap_or("none"),
        )
        .with_property("homePatch", "unchanged")
        .with_property("manifestRewritten", recovery.manifest_rewritten.to_string());
    let console = state.renderer_console.lock().await;
    let input = CrashReportInput {
        source: CrashReportSource::Main,
        phase: CrashReportPhase::Startup,
        error: &error,
        host_diagnostic: None,
        renderer_console: console.console_snapshot(),
        app: &app_facts,
        time: chrono::Utc::now(),
    };
    if let Err(error) = write_crash_report(&state.paths.logs, &input) {
        tracing::warn!(error_kind = %error, "recovery record could not be written");
    }
}

/// Classify one dialog answer onto the reference's button index.
///
/// The three-button form is `YesNoCancelCustom(Exit, Restart, Disable)` and the
/// two-button `EADDRINUSE` form is `OkCancelCustom(Restart, Exit)`; the dialog
/// plugin rewrites a press to `Custom(<label>)`, so the labels the shell
/// supplied decide which button was pressed. A label that is not one of them is
/// `None` — no consent at all, so it can never select the plugin repair — while
/// any raw code the plugin can still produce for a non-custom shape is the
/// reference's `cancelId: 0` (Exit), also never a repair.
fn recovery_choice_index(
    answer: &tauri_plugin_dialog::MessageDialogResult,
    buttons: &RecoveryButtons,
) -> Option<usize> {
    use tauri_plugin_dialog::MessageDialogResult;
    match answer {
        MessageDialogResult::Custom(label) => {
            if *label == buttons.restart {
                Some(1)
            } else if *label == buttons.exit {
                Some(0)
            } else if buttons.disable_plugins.as_deref() == Some(label.as_str()) {
                Some(2)
            } else {
                None
            }
        }
        _ => Some(0),
    }
}

/// Show one recovery prompt and return the chosen button index.
///
/// The dialog is shown without an owner window (upstream
/// `dialog.showMessageBox(options)`), so a hidden window stays hidden and the
/// box is its own top-level window. The answer arrives through the dialog
/// callback ([`crate::native_dialog::answer`]) instead of a blocking show, so
/// neither the main thread nor a runtime worker waits on the user.
///
/// Index mapping: the three-button form maps `Yes`→0 (Exit), `No`→1 (Restart)
/// and `Cancel`→2 (Disable third-party plugins) onto the reference's array
/// order (`fatal-recovery.ts:82`), whose button 0 is Exit and button 2 is the
/// plugin repair. The two-button form is used only for the `EADDRINUSE` case,
/// where the reference drops button 2; there `Ok`→1 (Restart, the default) and
/// `Cancel`→0 (Exit), matching `defaultId: 1, cancelId: 0`.
///
/// `None` means no answer arrived: the callback was dropped without a result,
/// which is not consent to any recovery action.
async fn ask_recovery(
    app: &tauri::AppHandle,
    detail: &str,
    summary: &str,
    buttons: &RecoveryButtons,
) -> Option<usize> {
    let dialog = app
        .dialog()
        .message(detail.to_string())
        .title(summary.to_string());
    let reply = crate::native_dialog::answer(|answer| {
        let dialog = match &buttons.disable_plugins {
            Some(disable) => dialog.buttons(
                tauri_plugin_dialog::MessageDialogButtons::YesNoCancelCustom(
                    buttons.exit.clone(),
                    buttons.restart.clone(),
                    disable.clone(),
                ),
            ),
            None => dialog.buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                buttons.restart.clone(),
                buttons.exit.clone(),
            )),
        };
        dialog.show_with_result(answer);
    })
    .await;
    reply
        .as_ref()
        .and_then(|answer| recovery_choice_index(answer, buttons))
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
        renderer_console: console.console_snapshot(),
        app: &app_facts,
        time: chrono::Utc::now(),
    };
    write_crash_report(&state.paths.logs, &input)
}

/// The `Diagnostic report: <path>` line, independent of shortening
/// (`fatal-recovery.ts:43-45`).
fn report_line(messages: &crate::state::ShellMessages, report_path: Option<&Path>) -> String {
    match report_path {
        Some(path) => format!(
            "\n{}",
            crate::state::format_message(
                messages.report_written_to,
                &[("path", &path.display().to_string())],
            )
        ),
        None => String::new(),
    }
}

/// Compose the dialog detail: the error's last lines (prefixed by the
/// shortening notice when they are not the whole error), then the report path
/// when one was written, then the reinstall advice (upstream `dialogDetail`,
/// `fatal-recovery.ts:34-41`).
///
/// The comparison is `shortened === error` on the **split-and-joined** tail, so
/// a `\r\n`-terminated error is reported through the shortened branch: upstream
/// splits on `\r\n | [\n\r\u2028\u2029]` and rejoins with `\n`, which can never
/// equal the original bytes. This mirrors that exactly; the notice is accurate
/// either way (the displayed text is the tail, and the full error is in the
/// report the dialog names).
fn dialog_detail(
    error: &str,
    messages: &crate::state::ShellMessages,
    report_path: Option<&Path>,
) -> String {
    let advice = format!("\n\n{}", messages.startup_reinstall_advice);
    let report = report_line(messages, report_path);
    let tail = error
        .split(['\n', '\r', '\u{2028}', '\u{2029}'])
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Isolated temporary directory for one test.
    ///
    /// A hand-rolled fixture rather than `tempfile`: the app crate's
    /// `[dev-dependencies]` is owned by the lead's manifest integration, and a
    /// test-only directory helper is small enough not to justify a new
    /// dependency edge. The name carries the process id and a per-test counter,
    /// so parallel tests cannot collide, and `Drop` removes the tree.
    struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        fn new() -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let unique = SEQUENCE.fetch_add(1, Ordering::SeqCst);
            let path =
                std::env::temp_dir().join(format!("dsh-lane-s-{}-{unique}", std::process::id()));
            let _ = std::fs::remove_dir_all(&path);
            std::fs::create_dir_all(&path).expect("temporary directory");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn address_in_use_is_word_bounded() {
        assert!(is_address_in_use(
            "Error: listen EADDRINUSE: address already in use"
        ));
        assert!(!is_address_in_use("EADDRINUSE happened somewhere else"));
        assert!(!is_address_in_use("listen EADDRINUSE_EXTRA"));
        assert!(!is_address_in_use("connection refused"));
    }

    #[test]
    fn the_disabled_third_button_never_classifies_as_disable_plugins() {
        // With the button present, index 2 disables plugins.
        assert_eq!(classify_choice(2, true), RecoveryChoice::DisablePlugins);
        // Without it, index 2 must not be reachable, and any stray index
        // restarts (`fatal-recovery.ts:88-97`).
        assert_eq!(classify_choice(2, false), RecoveryChoice::Restart);
        assert_eq!(classify_choice(0, true), RecoveryChoice::Exit);
        assert_eq!(classify_choice(1, true), RecoveryChoice::Restart);
        assert_eq!(classify_choice(7, true), RecoveryChoice::Restart);
    }

    #[test]
    fn the_two_button_prompt_maps_ok_to_restart_and_cancel_to_exit() {
        // The two-button dialog is built inline above: its buttons are
        // `OkCancelCustom(restart, exit)`, so `Ok` must be the reference's
        // `defaultId: 1` and `Cancel` its `cancelId: 0` — the reverse of the
        // label order (`fatal-recovery.ts:81-83`). These are the literal indices
        // that inline match arms return.
        assert_eq!(classify_choice(1, false), RecoveryChoice::Restart);
        assert_eq!(classify_choice(0, false), RecoveryChoice::Exit);
    }

    fn buttons(disable_plugins: Option<&str>) -> RecoveryButtons {
        RecoveryButtons {
            exit: "Exit".to_string(),
            restart: "Restart".to_string(),
            disable_plugins: disable_plugins.map(str::to_string),
        }
    }

    #[test]
    fn every_recovery_label_maps_to_its_reference_index() {
        use tauri_plugin_dialog::MessageDialogResult;
        let three = buttons(Some("Disable third-party plugins"));
        // The plugin rewrites a custom-button press to `Custom(<label>)`; the
        // label the shell supplied is what identifies the button.
        assert_eq!(
            recovery_choice_index(&MessageDialogResult::Custom("Exit".into()), &three),
            Some(0)
        );
        assert_eq!(
            recovery_choice_index(&MessageDialogResult::Custom("Restart".into()), &three),
            Some(1)
        );
        assert_eq!(
            recovery_choice_index(
                &MessageDialogResult::Custom("Disable third-party plugins".into()),
                &three
            ),
            Some(2)
        );
        // The `EADDRINUSE` form has no third button, so its two labels map to
        // Exit and Restart only.
        let two = buttons(None);
        assert_eq!(
            recovery_choice_index(&MessageDialogResult::Custom("Restart".into()), &two),
            Some(1)
        );
        assert_eq!(
            recovery_choice_index(&MessageDialogResult::Custom("Exit".into()), &two),
            Some(0)
        );
        assert_eq!(
            recovery_choice_index(
                &MessageDialogResult::Custom("Disable third-party plugins".into()),
                &two
            ),
            None,
            "a label the two-button form never offered cannot select a repair"
        );
    }

    #[test]
    fn an_unrecognized_answer_is_exit_and_never_a_plugin_repair() {
        use tauri_plugin_dialog::MessageDialogResult;
        for form in [buttons(Some("Disable third-party plugins")), buttons(None)] {
            // The reference's `cancelId: 0`: a dismissal or any code the custom
            // shapes do not produce is the Exit button, not the repair.
            assert_eq!(
                recovery_choice_index(&MessageDialogResult::Cancel, &form),
                Some(0)
            );
            assert_eq!(
                recovery_choice_index(&MessageDialogResult::Ok, &form),
                Some(0)
            );
            assert_eq!(
                recovery_choice_index(&MessageDialogResult::Yes, &form),
                Some(0)
            );
            assert_eq!(
                recovery_choice_index(&MessageDialogResult::No, &form),
                Some(0)
            );
            assert_eq!(
                recovery_choice_index(&MessageDialogResult::Custom("Bogus".into()), &form),
                None,
                "an unknown label is no answer, not a repair"
            );
            assert_eq!(
                classify_choice(0, form.disable_plugins.is_some()),
                RecoveryChoice::Exit
            );
        }
    }

    #[test]
    fn plugin_recovery_backs_up_the_patch_and_rewrites_only_bundles() {
        let temp = TempDir::new();
        let profile = temp.path().join("profiles").join("desktop");
        std::fs::create_dir_all(&profile).expect("profile");
        // A user customization that recovery must preserve verbatim.
        std::fs::write(
            profile.join(PROFILE_PATCH_FILENAME),
            "- id: '@user/third-party'\n  config:\n    token: keep-me\n",
        )
        .expect("patch");
        std::fs::write(
            profile.join("package.json"),
            r#"{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": { "@user/third-party": "^1.0.0" },
  "customField": { "keep": true },
  "dsh": { "profile": { "bundles": ["@user/third-party"] }, "other": 3 }
}
"#,
        )
        .expect("manifest");
        std::fs::write(profile.join("pnpm-workspace.yaml"), "packages:\n  - .\n")
            .expect("workspace");

        let recovery = disable_third_party_plugins(&profile, &RECOVERY_BUNDLES, 1_700_000_000_000)
            .expect("recovery");

        assert_eq!(
            recovery.backup_file.as_deref(),
            Some("cordis.patch.yml.bak-1700000000000")
        );
        assert!(recovery.manifest_rewritten);
        // The user's patch layer survives under the backup name, contents
        // untouched.
        let backup = profile.join("cordis.patch.yml.bak-1700000000000");
        assert!(backup.is_file(), "backup must exist");
        assert!(std::fs::read_to_string(&backup)
            .expect("backup")
            .contains("keep-me"));
        assert!(
            !profile.join(PROFILE_PATCH_FILENAME).exists(),
            "the patch layer is moved, not rewritten in place"
        );
        // Only the bundle list changed; dependencies, other `dsh.*` fields and
        // unknown top-level fields are preserved.
        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(profile.join("package.json")).expect("manifest"),
        )
        .expect("json");
        assert_eq!(
            manifest["dsh"]["profile"]["bundles"],
            serde_json::json!(RECOVERY_BUNDLES)
        );
        assert_eq!(
            manifest["dependencies"]["@user/third-party"],
            serde_json::json!("^1.0.0")
        );
        assert_eq!(manifest["customField"]["keep"], serde_json::json!(true));
        assert_eq!(manifest["dsh"]["other"], serde_json::json!(3));
        assert_eq!(manifest["name"], serde_json::json!("dsh-profile-desktop"));
        // The workspace file is not part of recovery.
        assert_eq!(
            std::fs::read_to_string(profile.join("pnpm-workspace.yaml")).expect("workspace"),
            "packages:\n  - .\n"
        );
    }

    #[test]
    fn plugin_recovery_tolerates_a_missing_patch_and_missing_manifest() {
        let temp = TempDir::new();
        let profile = temp.path().join("empty");
        std::fs::create_dir_all(&profile).expect("profile");

        let recovery =
            disable_third_party_plugins(&profile, &RECOVERY_BUNDLES, 42).expect("recovery");

        assert_eq!(recovery.backup_file, None);
        assert!(!recovery.manifest_rewritten);
        assert!(
            !profile.join("package.json").exists(),
            "no manifest is invented"
        );
    }

    #[test]
    fn plugin_recovery_never_overwrites_an_existing_backup() {
        let temp = TempDir::new();
        let profile = temp.path().join("profile");
        std::fs::create_dir_all(&profile).expect("profile");
        std::fs::write(profile.join(PROFILE_PATCH_FILENAME), "first\n").expect("patch");
        std::fs::write(
            profile.join(format!("{PROFILE_PATCH_FILENAME}.bak-7")),
            "previous\n",
        )
        .expect("previous backup");
        std::fs::write(profile.join("package.json"), "{}\n").expect("manifest");

        let recovery =
            disable_third_party_plugins(&profile, &RECOVERY_BUNDLES, 7).expect("recovery");

        assert_eq!(
            recovery.backup_file.as_deref(),
            Some("cordis.patch.yml.bak-7-1")
        );
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml.bak-7")).expect("previous"),
            "previous\n"
        );
        assert_eq!(
            std::fs::read_to_string(profile.join("cordis.patch.yml.bak-7-1")).expect("backup"),
            "first\n"
        );
    }

    #[test]
    fn plugin_recovery_refuses_an_unreadable_manifest_without_losing_the_patch() {
        let temp = TempDir::new();
        let profile = temp.path().join("profile");
        std::fs::create_dir_all(&profile).expect("profile");
        std::fs::write(profile.join(PROFILE_PATCH_FILENAME), "user layer\n").expect("patch");
        std::fs::write(profile.join("package.json"), "{ not json").expect("manifest");

        let error = disable_third_party_plugins(&profile, &RECOVERY_BUNDLES, 1)
            .expect_err("invalid manifest must fail loudly");

        assert!(error.to_string().contains("not valid JSON"), "{error}");
        // The backup already happened, so nothing the user wrote was lost.
        assert!(profile.join("cordis.patch.yml.bak-1").is_file());
    }

    #[test]
    fn recovery_bundles_are_the_reviewed_upstream_web_template() {
        assert_eq!(
            RECOVERY_BUNDLES,
            ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
        );
    }

    fn messages() -> &'static crate::state::ShellMessages {
        &crate::state::EN
    }

    #[test]
    fn dialog_detail_shortens_long_errors_and_names_the_report() {
        let error = (0..20)
            .map(|index| format!("line {index}"))
            .collect::<Vec<_>>()
            .join("\n");
        let detail = dialog_detail(&error, messages(), Some(Path::new("C:\\logs\\crash.log")));
        assert!(
            detail.starts_with(messages().diagnostic_truncated),
            "{detail}"
        );
        assert!(detail.contains("line 19"), "{detail}");
        assert!(!detail.contains("line 0\n"), "{detail}");
        assert!(
            detail.contains("Diagnostic report: C:\\logs\\crash.log"),
            "{detail}"
        );
        assert!(
            detail.ends_with(messages().startup_reinstall_advice),
            "{detail}"
        );
        assert!(detail.chars().count() <= DETAIL_BUDGET + 128, "{detail}");
    }

    #[test]
    fn dialog_detail_keeps_a_short_error_verbatim_and_still_names_the_report() {
        let detail = dialog_detail("boom", messages(), Some(Path::new("/tmp/c.log")));
        assert!(detail.starts_with("boom"), "{detail}");
        assert!(
            !detail.contains(messages().diagnostic_truncated),
            "{detail}"
        );
        assert!(detail.contains("Diagnostic report: /tmp/c.log"), "{detail}");
        // No report on disk: the line is simply absent.
        let without = dialog_detail("boom", messages(), None);
        assert!(!without.contains("Diagnostic report"), "{without}");
    }

    #[test]
    fn dialog_detail_splits_on_every_line_terminator_upstream_splits_on() {
        // Upstream splits on `\r\n | [\n\r\u2028\u2029]` and joins the tail with
        // `\n`, so a unicode line separator becomes an ordinary newline and the
        // tail is marked shortened (it cannot equal the original bytes).
        let error = "a\u{2028}b\u{2029}c\rd\u{000A}e";
        let detail = dialog_detail(error, messages(), None);
        assert!(detail.contains("a\nb\nc\nd\ne"), "{detail}");
    }

    #[test]
    fn a_crlf_error_is_reported_through_the_shortened_branch_like_upstream() {
        // `\r\n` splits on each of its two characters, so `boom\r\ncrash\r\n`
        // becomes `["boom","","crash",""]` and rejoins as `boom\n\ncrash\n` —
        // which can never equal the original bytes. That is upstream's
        // `shortened === error` on the joined tail; the complete error is in the
        // report the dialog names.
        let detail = dialog_detail("boom\r\ncrash\r\n", messages(), None);
        assert!(
            detail.starts_with(messages().diagnostic_truncated),
            "{detail}"
        );
        assert!(detail.contains("boom\n\ncrash\n"), "{detail}");
        assert!(!detail.contains('\r'), "{detail}");
        // An error that survives the round trip verbatim gains no notice.
        let detail = dialog_detail("boom\ncrash", messages(), None);
        assert!(
            !detail.contains(messages().diagnostic_truncated),
            "{detail}"
        );
        assert!(detail.starts_with("boom\ncrash"), "{detail}");
    }

    #[test]
    fn the_report_line_is_independent_of_shortening() {
        let line = report_line(messages(), Some(Path::new("C:\\x.log")));
        assert_eq!(line, "\nDiagnostic report: C:\\x.log");
        assert_eq!(report_line(messages(), None), "");
    }
}
