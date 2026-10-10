//! The ordinary quit flow: host inspection → the quit decision table
//! (`dsh-core::quit`) → the native confirmation → a proven clean shutdown.
//!
//! Rules preserved (`apps/desktop/README.md` "Closing the window and quitting"):
//! every ordinary quit entry asks the Host what it would interrupt; nothing
//! interruptible quits silently; otherwise a native message box without an
//! owner window asks with the correct explanation; concurrent quit requests
//! join the open dialog.
//!
//! ## Skip reasons are bound to one attempt
//!
//! A skip rule is passed to the entry that consumes it
//! ([`request_quit_with`]) and travels inside the [`QuitAttempt`] the core flow
//! hands back. There is no process-wide armed flag: a reason cannot leak into a
//! later, unrelated quit (which would silently discard that user's tasks), it
//! is consumed by the attempt that owns it, and it is revoked when that attempt
//! is released, superseded, or superseded by a terminal bypass.
//!
//! ## A quit is only terminal once the Host is proven gone
//!
//! [`confirm_exit`] stops the runtime tree **before** it claims anything: no
//! `dsh://shell/quit-confirmed` event and no flow bypass happen while a Host tree
//! may survive. The proof is factual, not inferred from the state machine:
//! `stop(false)` must return `Ok`, the published state must show no Host
//! generation left (`dsh-core::quit::stop_is_resolved`), and the supervisor's own
//! process-ownership snapshot must be settled (`TeardownStatus::is_settled`).
//! When it is not, the failure stays visible in the ordinary way — a bounded
//! native question with an explicit Quit, carrying the facts that are still
//! unresolved — and a refusal leaves the application fully running with the flow
//! still usable.
//!
//! ## Explicit survivor consent is a permit, not a flag
//!
//! The exit request handler owns the Host stop proof, the native teardown, and
//! the disposal of the policy and update owners (`lib.rs` `RunEvent::
//! ExitRequested`); it commits disposal only once that teardown settles. When the
//! user explicitly consents to quit over a Host teardown that did not resolve,
//! [`finish_terminal_exit`] records that consent as
//! [`crate::TerminalExitPermit`] holding the *terminal claim it just made*, so
//! the handler can validate ownership of that exact generation, consume the
//! permission once, and leave without a Host proof. Every other path leaves the
//! permit empty and is refused when the teardown is unresolved. A restart never
//! proceeds on an unresolved Host: the consent it may obtain only downgrades it
//! to an exit.
//!
//! ## Coalescing cleanup is generation-safe
//!
//! Every cleanup presents the attempt it owns. The panic guard releases through
//! `QuitFlow::release`, so neither a late unwinding cleanup nor a superseded
//! caller can reset a newer attempt's coalescing state. The terminal exit
//! snapshots the decision it acts for before its first await and claims the flow
//! and validates that snapshot in one locked transition, so an answer that
//! arrives after an installer/exit-request bypass superseded the decision cannot
//! create another bypass over an owner that is still acting.

use dsh_core::error::DshError;
use dsh_core::protocol::{QuitReason, ShellQuitConfirmedEvent};
use dsh_core::quit::{
    decide_after_unresolved_stop, decide_quit, stop_is_resolved, QuitAction, QuitAttempt,
    QuitEntry, QuitHostState, QuitPrompt, QuitRequest, QuitSkip, SurvivorPolicy,
};
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

/// One ordinary quit entrypoint (idempotent; concurrent requests join).
pub async fn request_quit(app: &tauri::AppHandle) -> Result<(), DshError> {
    request_quit_with(app, None).await
}

/// One ordinary quit entrypoint whose skip rule is bound to this attempt.
///
/// The reason is consumed by the decision of the attempt it was passed with and
/// is revoked with that attempt; nothing is armed process-wide.
pub async fn request_quit_with(
    app: &tauri::AppHandle,
    skip: Option<QuitSkip>,
) -> Result<(), DshError> {
    let app = app.clone();
    crate::native_dialog::retained(async move { request_quit_owned(&app, skip).await })
        .await
        .map_err(|error| DshError::other("quit_flow_failed", error.to_string()))?
}

async fn request_quit_owned(
    app: &tauri::AppHandle,
    skip: Option<QuitSkip>,
) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let attempt = {
        let mut flow = state.quit_flow.lock().await;
        match flow.request(skip) {
            QuitRequest::Ignored => return Ok(()),
            QuitRequest::Join => {
                // Do not reveal a hidden main or front the policy over the
                // ownerless question. Windows upstream only joins here;
                // macOS application-level alert activation remains unqualified.
                return Ok(());
            }
            QuitRequest::Start(attempt) => attempt,
        }
    };
    // A panicking attempt must not strand the coalescing state, and its cleanup
    // must not touch a newer attempt. The guard releases the *generation it
    // owns*, so a detached late release is inert against a superseding attempt
    // or terminal bypass. Every ordinary exit disarms it after releasing
    // explicitly; only unwinding still reaches the guard.
    struct ReleaseOnDrop {
        state: std::sync::Arc<AppState>,
        attempt: QuitAttempt,
        armed: bool,
    }
    impl Drop for ReleaseOnDrop {
        fn drop(&mut self) {
            if !self.armed {
                return;
            }
            // An uncontended flow lock needs no task at all: release inline,
            // which is what makes the panic path a synchronous, owned reset.
            if let Ok(mut flow) = self.state.quit_flow.try_lock() {
                let released = flow.release(self.attempt);
                tracing::warn!(
                    quit_attempt_panicked = true,
                    generation = self.attempt.generation(),
                    released,
                    "quit attempt unwound without resolving its decision"
                );
                return;
            }
            // Contended: unwinding must not block on the lock. The spawned
            // release is still owned by this generation, so it cannot reset a
            // newer attempt.
            let state = self.state.clone();
            let attempt = self.attempt;
            tauri::async_runtime::spawn(async move {
                let released = state.quit_flow.lock().await.release(attempt);
                tracing::warn!(
                    quit_attempt_panicked = true,
                    generation = attempt.generation(),
                    released,
                    "quit attempt unwound without resolving its decision"
                );
            });
        }
    }
    let mut reset = ReleaseOnDrop {
        state: state.inner().clone(),
        attempt,
        armed: true,
    };
    let decision = {
        let host = QuitHostState::from_runtime_state(state.supervisor.status().state);
        let inspection = if host == QuitHostState::Ready {
            state.supervisor.quit_inspection_outcome().await
        } else {
            dsh_core::quit::QuitInspectionOutcome::Unknown
        };
        decide_quit(attempt.skip(), host, &inspection)
    };
    // Inspection can finish after an installer/OS bypass. Do not open another
    // confirmation or commit an obsolete ordinary decision in that case.
    let flow = state.quit_flow.lock().await;
    if !flow.owns(attempt) {
        reset.armed = false;
        return Ok(());
    }
    let prompt = match decision {
        QuitAction::Proceed(reason) => {
            // The decision stays open across the terminal shutdown so a
            // concurrent quit request still joins instead of opening a second
            // confirmation; `finish_terminal_exit` claims the bypass only once
            // the Host teardown resolved (or the user consented to quit anyway).
            drop(flow);
            let outcome = confirm_exit(app, reason).await;
            // Only a terminal quit that did not resolve reaches this point.
            let mut flow = state.quit_flow.lock().await;
            flow.release(attempt);
            drop(flow);
            reset.armed = false;
            return outcome;
        }
        QuitAction::Ask(prompt) => prompt,
    };
    drop(flow);
    let confirmed = ask(app, prompt).await;
    let mut flow = state.quit_flow.lock().await;
    let terminal = flow.resolve_confirmation(attempt, confirmed);
    // Resolving or refusing the answer and disarming cleanup are one locked
    // transition: no late guard can finish a newer decision.
    reset.armed = false;
    drop(flow);
    match terminal {
        None => Ok(()),
        Some(claim) => match confirm_exit(app, QuitReason::User).await {
            // `confirm_exit` diverges on a resolved shutdown, so this arm keeps
            // the signature total rather than reporting a success it cannot see.
            Ok(()) => Ok(()),
            Err(error) => {
                // The terminal quit did not resolve: release exactly the bypass
                // it claimed so Quit stays available with the failure visible.
                state.quit_flow.lock().await.release(claim);
                Err(error)
            }
        },
    }
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
    crate::native_dialog::answer(|reply| {
        app.dialog()
            .message(format!("{}\n\n{detail}", messages.quit_title))
            .title(messages.quit_title)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                quit, cancel,
            ))
            .show(reply);
    })
    .await
    .unwrap_or(false)
}

/// The bounded policy question offered when the Host could not be stopped: the
/// user may explicitly quit anyway, or stay. A dropped dialog callback is not
/// consent (`native_dialog::answer` resolves `None`), and nothing here asks
/// twice: the caller asks once per attempt and then obeys the answer.
async fn ask_quit_despite_unresolved_host(app: &tauri::AppHandle, error: &DshError) -> bool {
    let state = app.state::<std::sync::Arc<AppState>>();
    let messages = {
        let model = state.locale.lock().await;
        crate::state::messages(model.snapshot().effective)
    };
    crate::native_dialog::answer(|reply| {
        app.dialog()
            .message(format!("{error}\n\n{}", messages.quit_active_tasks))
            .title(messages.quit_title)
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancelCustom(
                messages.quit.to_string(),
                messages.cancel.to_string(),
            ))
            .show(reply);
    })
    .await
    .unwrap_or(false)
}

/// Stop the Host for a terminal quit or restart, and prove the teardown
/// resolved.
///
/// Three independent facts must hold, and the state machine alone is not one of
/// them: the stop call returned `Ok`, the published state proves no Host
/// generation is left (`stop_is_resolved`), **and** the supervisor's process
/// ownership snapshot is settled — nothing owned and nothing able to run
/// (`TeardownStatus::is_settled`). An unresolved stop retains containment over a
/// tree that may still be alive, so the ownership snapshot is the runtime's own
/// factual answer to "is anything left?". A failure reports those facts
/// (`tree_owned`/`tree_alive`/`unresolved`) so the bounded question and the log
/// say what is actually still running.
async fn stop_host_for_terminal_quit(state: &AppState) -> Result<(), DshError> {
    let stop_result = state.supervisor.stop(false).await;
    let status = state.supervisor.status();
    let teardown = state.supervisor.teardown_status().await;
    if stop_result.is_ok() && stop_is_resolved(status.state) && teardown.is_settled() {
        return Ok(());
    }
    let cause = match &stop_result {
        Ok(()) => "the stop returned without confirming teardown".to_string(),
        Err(error) => error.to_string(),
    };
    // A failed stop already carries the runtime's own unresolved text, so the
    // snapshot's copy is reported only when the call itself looked clean.
    let last_unresolved = match (&stop_result, teardown.unresolved.as_deref()) {
        (Ok(()), Some(detail)) => format!(", last unresolved teardown: {detail}"),
        _ => String::new(),
    };
    Err(DshError::other(
        "host_stop_unresolved",
        format!(
            "the desktop host teardown is unresolved: {cause} (supervisor state {:?}, tree_owned={}, tree_alive={}{last_unresolved})",
            status.state, teardown.tree_owned, teardown.tree_alive,
        ),
    ))
}

/// Terminal quit: prove the runtime tree stopped, then emit
/// `dsh://shell/quit-confirmed` and leave through the exit request handler.
///
/// On a resolved shutdown this future never returns (the installer caller stays
/// divergent until the application exits). When the Host teardown does not
/// resolve, the failure is surfaced through [`ask_quit_despite_unresolved_host`]
/// and — unless the user explicitly consents to quitting anyway — `Err` is
/// returned with **nothing claimed**: no confirmation event, no flow bypass, no
/// permit, so the application is still fully usable. An explicit consent is
/// carried into [`finish_terminal_exit`] as the exit path's permission to leave
/// without a Host proof.
///
/// The decision this call acts for is snapshotted **before** the stop and the
/// bounded question can await anything: an installer or exit-request bypass may
/// supersede that decision while the user is being asked, and a stale answer
/// must then not claim the flow again (`finish_terminal_exit` checks ownership
/// and claims in one locked transition).
pub async fn confirm_exit(app: &tauri::AppHandle, reason: QuitReason) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    let deciding = state.quit_flow.lock().await.attempt();
    let explicit_survivor_consent = match stop_host_for_terminal_quit(state.inner()).await {
        Ok(()) => false,
        Err(error) => {
            tracing::error!(
                %error,
                "terminal quit refused: the desktop host teardown did not resolve"
            );
            let consent = ask_quit_despite_unresolved_host(app, &error).await;
            if decide_after_unresolved_stop(QuitEntry::Quit, consent) != SurvivorPolicy::ExitAnyway
            {
                return Err(error);
            }
            tracing::warn!(
                explicit_quit_with_surviving_host = true,
                "user consented to quit with a desktop host teardown that did not resolve"
            );
            true
        }
    };
    finish_terminal_exit(app, reason, explicit_survivor_consent, deciding).await
}

/// Development "Restart App and Host" (`apps/desktop/README.md` Develop): stop
/// the Host, prove the stop, then relaunch the application.
///
/// While a Host may survive, the restart is refused: the bounded question can
/// only downgrade an explicit consent to an exit
/// (`decide_after_unresolved_stop`), so a second Host is never launched over a
/// surviving one. That downgraded exit carries the same explicit survivor
/// consent as the quit path, and the decision snapshotted before its first await
/// for the same supersede reason as [`confirm_exit`].
pub async fn restart_app_and_host(app: &tauri::AppHandle) -> Result<(), DshError> {
    crate::policy_composition::require_normal(app)?;
    let state = app.state::<std::sync::Arc<AppState>>();
    let deciding = state.quit_flow.lock().await.attempt();
    if let Err(error) = stop_host_for_terminal_quit(state.inner()).await {
        tracing::error!(
            %error,
            "restart refused: the desktop host teardown did not resolve"
        );
        let consent = ask_quit_despite_unresolved_host(app, &error).await;
        if decide_after_unresolved_stop(QuitEntry::Restart, consent) != SurvivorPolicy::ExitAnyway {
            return Err(error);
        }
        tracing::warn!(
            explicit_quit_with_surviving_host = true,
            "user consented to exit instead of restarting over a surviving desktop host"
        );
        return finish_terminal_exit(app, QuitReason::User, true, deciding).await;
    }
    // The relaunch is requested through Tauri's lifecycle instead of racing a
    // second-instance launch against the current process or discarding its
    // startup arguments. `AppHandle::restart` is terminal for this future, and
    // the exit request handler performs the policy/update disposal once the Host
    // proof and the native teardown settle.
    app.restart()
}

/// The terminal transition: claim the flow, record the explicit survivor
/// consent that the exit request handler validates, tell the client, and request
/// the application exit.
///
/// `deciding` is the decision this terminal exit acts for, snapshotted before
/// its caller's first await (`None` for a caller that owns no ordinary decision,
/// such as the installer or the fatal-recovery exit). Claiming and validating
/// that snapshot happen in **one locked transition**: a decision superseded by
/// an installer/exit-request bypass while the stop or the bounded question
/// awaited fails here instead of claiming the flow again over a bypass that
/// another owner is still acting on.
///
/// Disposal of the policy and update owners is deliberately **not** here: a
/// request the exit path then refuses must leave the application able to run
/// normal actions, so those owners are dropped only by the handler that commits
/// the exit (`lib.rs`).
///
/// This future never yields a value: after `app.exit(0)` it awaits
/// [`std::future::pending`], so the application stays in its event-loop exit
/// rather than being torn down by `process::exit`. The `Ok` variant is therefore
/// never constructed — the `Result` exists so both terminal call sites
/// (`confirm_exit`, which the installer awaits as its tail expression, and the
/// restart downgraded to an exit) keep the signatures they already have.
async fn finish_terminal_exit(
    app: &tauri::AppHandle,
    reason: QuitReason,
    explicit_survivor_consent: bool,
    deciding: Option<QuitAttempt>,
) -> Result<(), DshError> {
    let state = app.state::<std::sync::Arc<AppState>>();
    // Claim before anything observable: a concurrent quit request must join
    // this terminal quit instead of starting another decision.
    let claim = {
        let mut flow = state.quit_flow.lock().await;
        if deciding.is_some_and(|attempt| !flow.owns(attempt)) {
            tracing::warn!(
                quit_decision_superseded = true,
                "a superseded quit decision does not claim the flow again"
            );
            return Err(DshError::other(
                "quit_superseded",
                "the quit decision was superseded before its terminal exit",
            ));
        }
        flow.bypass(reason)
    };
    if explicit_survivor_consent {
        // Only the user's explicit decision to leave over a Host teardown that
        // did not resolve may authorize an exit without a fresh Host proof. The
        // permit carries this exact claim, never a boolean: the exit path
        // validates it against the flow (`owns`) and consumes it once, so a
        // superseded generation cannot be replayed and a skip rule can never
        // reach it.
        app.state::<crate::TerminalExitPermit>().authorize(claim);
    }
    app.emit(
        "dsh://shell/quit-confirmed",
        &ShellQuitConfirmedEvent { reason },
    )
    .ok();
    app.exit(0);
    // exit() requests an event-loop exit; do not bypass the retained
    // ExitRequested task or Tauri's native teardown with process::exit.
    // Installer callers stay divergent until the application exits.
    std::future::pending::<()>().await;
    unreachable!("the terminal quit future remains pending until application exit");
}
