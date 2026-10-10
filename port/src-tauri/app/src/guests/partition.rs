//! Storage partitions and per-isolation data directories for native guests.
//!
//! The reference gives every guest a partition string and lets Electron own the
//! on-disk layout:
//!
//! * Sidebar Browser — one process-lifetime partition per **workspace storage
//!   identity**, minted once and reused by every tab of that workspace
//!   (`browser-guests.ts` `acquire`; the retained client resolves the identity
//!   as `cwd:<workspace path>` or `session:<session id>`,
//!   `.../src/client/electron/workspace.ts`).
//! * Embedded Platform — a **persistent** partition keyed by
//!   `sha256(JSON.stringify([origin, userId]))`, or a random partition when the
//!   account has no user id yet (`platform-view.ts` `open`).
//!
//! Tauri has no partition string: each child webview needs its own *data
//! directory*, and two webviews may only share a WebView2 environment when
//! their browser arguments, scroll-bar style and extension settings match.
//! Guests never change those, but sharing an environment between a guest and
//! the **main application document** would share the session cookie jar with
//! arbitrary web content — unacceptable. This module therefore maps partitions
//! onto per-partition directories, preserving the reference's **grouping**:
//! guests of one workspace still share one jar, guests of different workspaces
//! and different Platform accounts never do.

use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// Which ownership rule minted a partition; recorded so the on-disk directory
/// name is stable and diagnosable without exposing an account or workspace.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PartitionKind {
    /// Per-workspace, process-lifetime (Sidebar Browser).
    Browser,
    /// Per-account, reopened across runs (embedded Platform).
    Platform,
}

impl PartitionKind {
    /// Stable segment used in the directory name.
    pub fn slug(self) -> &'static str {
        match self {
            Self::Browser => "browser",
            Self::Platform => "platform",
        }
    }
}

/// Directory name under the application user-data directory that holds every
/// guest isolation root. Kept separate from `settings.json` and
/// `keybindings.json`, which stay readable as files in the user-data directory
/// itself.
pub const WEBVIEW_DATA_DIR_NAME: &str = "webview-data";

/// One workspace's process-lifetime browser partition (upstream
/// `dsh-sidebar-browser-<uuid>`), reproduced as a keyed value.
///
/// The reference mints a fresh partition per process run and per workspace;
/// keying by the workspace identity is the faithful equivalent because the
/// identity is already main-derived, already bounded by
/// [`MAX_WORKSPACE_IDENTITY`](super::registry::MAX_WORKSPACE_IDENTITY) and stable for the
/// tab's lifetime. It never contains the raw identity.
pub fn browser_partition(workspace: &str) -> String {
    format!(
        "{}{}",
        super::BROWSER_PARTITION_PREFIX,
        digest16(workspace.as_bytes())
    )
}

/// One Platform account's persistent partition (upstream
/// `persist:dsh-platform-<sha256 hex>`).
///
/// `None` for the user id means the reference mints a **temporary** partition:
/// an account with no id must not have its storage reused by a later account.
pub fn platform_partition(origin: &str, user_id: Option<&str>) -> String {
    match user_id {
        Some(user_id) => {
            let digest = digest16(format!("[{origin},{user_id}]").as_bytes());
            format!("{}{digest}", super::PLATFORM_PARTITION_PREFIX)
        }
        None => format!(
            "{}{}",
            super::PLATFORM_PARTITION_PREFIX,
            digest16(uuid::Uuid::new_v4().as_bytes())
        ),
    }
}

/// The WebView2 data directory of one partition.
///
/// @param user_data - application user-data directory (`AppPaths::user_data`).
/// @param kind - ownership rule that minted the partition.
/// @param partition - partition string from [`browser_partition`] or
///   [`platform_partition`].
/// @returns the directory the child webview must be created with.
pub fn webview_data_directory(user_data: &Path, kind: PartitionKind, partition: &str) -> PathBuf {
    user_data
        .join(WEBVIEW_DATA_DIR_NAME)
        .join(kind.slug())
        .join(partition)
}

/// First 16 bytes of the SHA-256 of `bytes`, lowercase hex.
///
/// 128 bits keeps partition directories short (WebView2 rejects long paths) and
/// collisions are not a practical concern for a value that only ever names a
/// local storage jar.
fn digest16(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(32);
    for byte in &digest[..16] {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_partition_is_stable_and_never_contains_the_identity() {
        let first = browser_partition("cwd:C:\\Users\\someone\\Documents\\project");
        let second = browser_partition("cwd:C:\\Users\\someone\\Documents\\project");
        assert_eq!(first, second, "one workspace must reuse one jar");
        assert!(first.starts_with(super::super::BROWSER_PARTITION_PREFIX));
        assert!(!first.contains("project"));
        assert!(!first.contains("someone"));
    }

    #[test]
    fn different_workspaces_never_share_a_jar() {
        assert_ne!(browser_partition("cwd:A"), browser_partition("cwd:B"));
        assert_ne!(
            browser_partition("cwd:A"),
            browser_partition("session:00000000-0000-0000-0000-000000000000")
        );
    }

    #[test]
    fn platform_partition_is_account_scoped_and_persistent() {
        let account = platform_partition("https://platform.example", Some("u-1"));
        assert_eq!(
            account,
            platform_partition("https://platform.example", Some("u-1"))
        );
        assert_ne!(
            account,
            platform_partition("https://platform.example", Some("u-2"))
        );
        assert_ne!(
            account,
            platform_partition("https://other.example", Some("u-1"))
        );
        assert!(account.starts_with(super::super::PLATFORM_PARTITION_PREFIX));
    }

    /// An account whose id is not known yet must not be given a reusable jar
    /// (upstream mints a random partition in exactly this case).
    #[test]
    fn platform_partition_without_user_id_is_temporary() {
        let first = platform_partition("https://platform.example", None);
        let second = platform_partition("https://platform.example", None);
        assert_ne!(first, second);
        assert!(first.starts_with(super::super::PLATFORM_PARTITION_PREFIX));
    }

    #[test]
    fn data_directories_split_browser_from_platform_isolations() {
        let user_data = Path::new("U:\\user data");
        let browser =
            webview_data_directory(user_data, PartitionKind::Browser, "dsh-sidebar-browser-aa");
        let platform =
            webview_data_directory(user_data, PartitionKind::Platform, "dsh-platform-bb");
        assert_eq!(
            browser,
            user_data
                .join("webview-data")
                .join("browser")
                .join("dsh-sidebar-browser-aa")
        );
        assert_ne!(browser, platform);
    }

    /// The application document's own session is never reused by a guest.
    #[test]
    fn no_guest_directory_is_the_application_data_directory() {
        let user_data = Path::new("U:\\user data");
        let directory =
            webview_data_directory(user_data, PartitionKind::Browser, "dsh-sidebar-browser-aa");
        assert!(directory.starts_with(user_data.join("webview-data")));
        assert_ne!(directory, user_data);
    }
}
