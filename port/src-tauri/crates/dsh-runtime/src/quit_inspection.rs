//! Quit-inspection request/response plumbing (deadline: 2 000 ms).
//!
//! Contract (`desktop-host-lifecycle-protocol.md` §1.4): the shell mints a
//! monotone `requestId`, the Host answers `activeTasks`/`scheduledTasks` with
//! an optional `error`, and a Host that misses the two-second deadline is
//! treated as unknown work — **fail closed**.

use std::time::Duration;

use dsh_core::protocol::QuitInspection;
use dsh_core::quit::QUIT_INSPECTION_DEADLINE_MS;

use crate::control::{ControlError, ControlLink, HostEvent, ShellMessage};

/// Deadline of one quit inspection (upstream `QUIT_INSPECTION_DEADLINE_MS`).
pub const QUIT_INSPECTION_DEADLINE: Duration = Duration::from_millis(QUIT_INSPECTION_DEADLINE_MS);

/// Ask the Host what quitting now would interrupt.
///
/// Returns the Host answer verbatim. A deadline miss or transport failure maps
/// to `None`; the caller (quit model) then treats the state as unknown work and
/// asks before quitting.
pub async fn inspect_quit(link: &ControlLink) -> Option<QuitInspection> {
    let response = link
        .request(
            |request_id| ShellMessage::QuitInspection { request_id },
            QUIT_INSPECTION_DEADLINE,
        )
        .await;
    match response {
        Ok(HostEvent::QuitInspection {
            active_tasks,
            scheduled_tasks,
            error,
            ..
        }) => Some(QuitInspection {
            active_tasks,
            scheduled_tasks,
            error,
        }),
        Ok(_) => None,
        Err(ControlError::Transport(message)) if message.contains("deadline") => None,
        Err(_) => None,
    }
}
