//! Update-task control plumbing (deadline: 10 000 ms).
//!
//! Contract (`desktop-host-lifecycle-protocol.md` §1.5): `inspect` reports
//! live work; `lock` refuses new API requests with `503`, drains admitted
//! requests, then re-checks work; `unlock` clears the lock. Responses carry
//! `active` (not `activeTasks`); `error` present means "tasks unknown", which
//! refuses installation. A missing answer at the deadline refuses installation.

use std::time::Duration;

use crate::control::{ControlError, ControlLink, HostEvent, ShellMessage, UpdateTasksAction};

/// Deadline of one `update-tasks` exchange (upstream `control(..., 10_000, ...)`).
pub const UPDATE_TASKS_DEADLINE: Duration = Duration::from_secs(10);

/// Run one update-admission action.
///
/// `Ok(true)` means live tasks would be affected. Errors mean the task state is
/// unknown: callers must not authorize installation.
pub async fn update_tasks(
    link: &ControlLink,
    action: UpdateTasksAction,
) -> Result<bool, ControlError> {
    let response = link
        .request(
            |request_id| ShellMessage::UpdateTasks {
                request_id,
                action,
            },
            UPDATE_TASKS_DEADLINE,
        )
        .await?;
    match response {
        HostEvent::UpdateTasks {
            active, error: None, ..
        } => Ok(active),
        HostEvent::UpdateTasks {
            active: _,
            error: Some(error),
            ..
        } => Err(ControlError::Transport(format!(
            "desktop update: task inspection reported unknown state: {error}"
        ))),
        _ => Err(ControlError::Transport(
            "desktop update: Host answered with a different control response".into(),
        )),
    }
}
