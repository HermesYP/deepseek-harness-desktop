//! Harness-home resolution and desktop-owned paths, mirroring
//! `_upstream/apps/desktop/src/paths.ts` plus `_upstream/packages/util/home-paths/src/index.ts`.
//!
//! Contracts:
//! - `$DSH_HOME` (non-empty after trim) overrides the Harness home; an empty or
//!   whitespace-only value is treated as unset (upstream `resolveDshHome`).
//! - The default Harness home is `<user home>/.dsh` (`DSH_HOME_DIR_NAME`).
//! - The desktop profile is `<home>/profiles/desktop`; its lock is
//!   `<home>/profiles/desktop/lock`.
//! - `DSH_DESKTOP_USER_DATA_DIR` overrides the application user-data directory
//!   (the development isolation hook upstream prints at launch).
//! - Paths may contain Unicode, spaces, and exceed legacy length limits; all
//!   filesystem APIs used by the crates are wide/UTF-8 capable.

use std::path::{Path, PathBuf};

/// Directory name of the default Harness home under the user home.
pub const DSH_HOME_DIR_NAME: &str = ".dsh";

/// Environment variable overriding the Harness home.
pub const DSH_HOME_ENV: &str = "DSH_HOME";

/// Environment variable overriding the application user-data directory.
pub const DSH_DESKTOP_USER_DATA_DIR_ENV: &str = "DSH_DESKTOP_USER_DATA_DIR";

/// Stable desktop installation paths under the shared Harness home.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesktopPaths {
    /// `$DSH_HOME/profiles/desktop` — the Desktop plugin profile directory.
    pub profile: PathBuf,
    /// `$DSH_HOME/profiles/desktop/lock` — the profile lock path.
    pub lock: PathBuf,
    /// The resolved Harness home itself.
    pub home: PathBuf,
}

/// Application-owned paths (settings, markers, logs) outside `$DSH_HOME`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppPaths {
    /// Application user-data directory (`DSH_DESKTOP_USER_DATA_DIR` or the platform default).
    pub user_data: PathBuf,
    /// `settings.json` inside the user-data directory.
    pub settings: PathBuf,
    /// `keybindings.json` inside the user-data directory (K1: separate from `$DSH_HOME`).
    pub keybindings: PathBuf,
    /// `background-close-confirmed` marker inside the user-data directory.
    pub background_close_confirmed: PathBuf,
    /// Crash-report and diagnostic-log directory (`logs` beside user data; `~/Library/Logs/<product>` on macOS).
    pub logs: PathBuf,
}

/// Product name used for default directory naming and single-instance naming.
pub const PRODUCT_NAME: &str = "DeepSeek Harness";

fn env_non_empty(name: &str) -> Option<PathBuf> {
    match std::env::var(name) {
        Ok(value) if !value.trim().is_empty() => Some(PathBuf::from(value)),
        _ => None,
    }
}

/// Resolve the Harness home: explicit argument, then `$DSH_HOME`, then `<home>/.dsh`.
/// A blank override never shadows the default (upstream behaviour).
pub fn resolve_dsh_home(explicit: Option<PathBuf>) -> PathBuf {
    if let Some(home) = explicit.filter(|p| !p.as_os_str().is_empty()) {
        return home;
    }
    if let Some(home) = env_non_empty(DSH_HOME_ENV) {
        return home;
    }
    default_dsh_home()
}

/// `<user home>/.dsh`; falls back to a relative `.dsh` only when the OS user home is unavailable.
pub fn default_dsh_home() -> PathBuf {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(DSH_HOME_DIR_NAME)
}

/// Resolve the immutable desktop path set (upstream `resolveDesktopPaths`).
pub fn resolve_desktop_paths(dsh_home: Option<PathBuf>) -> DesktopPaths {
    let home = resolve_dsh_home(dsh_home);
    let profile = home.join("profiles").join("desktop");
    let lock = profile.join("lock");
    DesktopPaths {
        profile,
        lock,
        home,
    }
}

/// Resolve application-owned paths. `DSH_DESKTOP_USER_DATA_DIR` wins over the
/// platform default so development runs can isolate user data.
pub fn resolve_app_paths(user_data_override: Option<PathBuf>) -> AppPaths {
    let user_data = user_data_override
        .or_else(|| env_non_empty(DSH_DESKTOP_USER_DATA_DIR_ENV))
        .unwrap_or_else(default_user_data_dir);
    AppPaths {
        settings: user_data.join("settings.json"),
        keybindings: user_data.join("keybindings.json"),
        background_close_confirmed: user_data.join("background-close-confirmed"),
        logs: logs_dir(&user_data),
        user_data,
    }
}

/// Platform user-data default: `%APPDATA%\<product>` on Windows,
/// `~/Library/Application Support/<product>` on macOS, `~/.local/share/<product>` on Linux.
fn default_user_data_dir() -> PathBuf {
    let base = if cfg!(target_os = "macos") {
        dirs::home_dir().map(|home| home.join("Library").join("Application Support"))
    } else {
        dirs::data_dir()
    };
    base.unwrap_or_else(|| PathBuf::from("."))
        .join(PRODUCT_NAME)
}

/// Logs directory: `~/Library/Logs/<product>` on macOS (upstream `app.getPath('logs')`),
/// `logs` under the user-data directory on Windows and Linux.
fn logs_dir(user_data: &Path) -> PathBuf {
    if cfg!(target_os = "macos") {
        dirs::home_dir()
            .map(|home| home.join("Library").join("Logs").join(PRODUCT_NAME))
            .unwrap_or_else(|| user_data.join("logs"))
    } else {
        user_data.join("logs")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_home_beats_environment() {
        let explicit = PathBuf::from("/tmp/explicit dsh ✓");
        assert_eq!(
            resolve_dsh_home(Some(explicit.clone())),
            explicit,
            "an explicit home must not be shadowed by DSH_HOME"
        );
    }

    #[test]
    fn default_home_is_dot_dsh_under_user_home() {
        assert_eq!(
            default_dsh_home().file_name(),
            Some(std::ffi::OsStr::new(DSH_HOME_DIR_NAME))
        );
    }

    #[test]
    fn desktop_paths_mirror_upstream_layout() {
        let paths = resolve_desktop_paths(Some(PathBuf::from("H:\\my home")));
        assert_eq!(
            paths.profile,
            Path::new("H:\\my home").join("profiles").join("desktop")
        );
        assert_eq!(
            paths.lock,
            Path::new("H:\\my home")
                .join("profiles")
                .join("desktop")
                .join("lock")
        );
        assert_eq!(paths.home, Path::new("H:\\my home"));
    }

    #[test]
    fn app_paths_put_settings_and_keybindings_beside_user_data() {
        let paths = resolve_app_paths(Some(PathBuf::from("U:\\user data ✓")));
        assert_eq!(
            paths.settings,
            Path::new("U:\\user data ✓").join("settings.json")
        );
        assert_eq!(
            paths.keybindings,
            Path::new("U:\\user data ✓").join("keybindings.json")
        );
        assert_eq!(
            paths.background_close_confirmed,
            Path::new("U:\\user data ✓").join("background-close-confirmed")
        );
    }
}
