//! Application state: the Rust-side collaborators behind every command.
//!
//! Owns the settings store (K1-excluded `settings.json`), the OS credential
//! store, the shortcut configuration engine (`keybindings.json`), the locale
//! model, the update service, the shared directory picker, and the quit flow.

use std::sync::Arc;

use crate::credential_backend::DesktopSecretBackend;
use dsh_core::credentials::CredentialStore;
use dsh_core::paths::AppPaths;
use dsh_core::protocol::{
    Appearance, CredentialIdentity, LocaleId, LocaleSource, LocaleState, Theme,
};
use dsh_core::quit::QuitFlow;
use dsh_core::settings::SettingsStore;
use dsh_core::shortcuts::{FileShortcutStorage, ShortcutPersistence, ShortcutPlatform};
use dsh_gateway::GatewayHandle;
use dsh_runtime::supervisor::Supervisor;
use tokio::sync::Mutex;

/// The updater-owned half of `AppState` (candidate identity, flight ownership,
/// download episodes), re-exported so `crate::state::UpdateCandidate` and the
/// other existing paths are unchanged. Split out so the scratch updater probe
/// compiles the identical type instead of re-declaring it.
#[path = "state_update.rs"]
mod state_update;

pub use state_update::{
    artifact_file_name, DownloadEpisode, UpdateCandidate, UpdateFlight, UpdateOperation,
    UpdateService,
};

/// Settings key of the locale preference (desktop-owned; never mirrors
/// Harness-owned settings under `$DSH_HOME`).
pub const LOCALE_PREFERENCE_KEY: &str = "locale.preference";
/// Settings key of the theme preference (`system` | `light` | `dark`).
pub const THEME_KEY: &str = "theme";
/// Settings keys of the onboarding credential coordinates (amendment A5:
/// supplied at boot, never hardcoded).
pub const CREDENTIAL_PROVIDER_KEY: &str = "onboarding.credential-provider";
/// Companion of {@link CREDENTIAL_PROVIDER_KEY}.
pub const CREDENTIAL_REFERENCE_KEY: &str = "onboarding.credential-reference";
/// Settings key of the persisted release channel (`stable` or `beta`).
pub const UPDATE_CHANNEL_KEY: &str = "updates.channel";

/// The three localized explanations and shell copy (upstream `locale.ts`,
/// en/zh dictionaries transcribed verbatim for the strings the shell owns).
pub struct ShellMessages {
    pub about_product: &'static str,
    pub about_version: &'static str,
    pub quit_application: &'static str,
    pub open_application: &'static str,
    pub quit: &'static str,
    pub cancel: &'static str,
    pub quit_title: &'static str,
    pub quit_active_tasks: &'static str,
    pub quit_scheduled_tasks: &'static str,
    pub quit_active_and_scheduled_tasks: &'static str,
    pub background_notice_body: &'static str,
    pub background_notice_confirm: &'static str,
    pub application: &'static str,
    pub file_menu: &'static str,
    pub close_page: &'static str,
    pub edit: &'static str,
    pub delete: &'static str,
    pub undo: &'static str,
    pub redo: &'static str,
    pub cut: &'static str,
    pub copy: &'static str,
    pub paste: &'static str,
    pub select_all: &'static str,
    pub check_updates_menu: &'static str,
    pub reload_page_menu: &'static str,
    pub restart_app_host_menu: &'static str,
    pub exit_application: &'static str,
    pub restart_application: &'static str,
    pub diagnostic_truncated: &'static str,
    pub report_written_to: &'static str,
    pub startup_reinstall_advice: &'static str,
    pub update_title: &'static str,
    pub update_current: &'static str,
    pub update_download: &'static str,
    pub update_available: &'static str,
    pub update_detail: &'static str,
    pub install_and_restart: &'static str,
    pub later: &'static str,
    pub update_downloaded_title_windows: &'static str,
    pub update_downloaded_detail_windows: &'static str,
    pub update_active_tasks: &'static str,
    pub update_active_tasks_detail: &'static str,
    pub update_stop_tasks: &'static str,
}

/// English dictionary (verbatim upstream `locale.ts` strings the shell owns).
pub const EN: ShellMessages = ShellMessages {
    about_product: "DeepSeek Harness",
    about_version: "Version V{version}",
    quit_application: "Quit DeepSeek Harness",
    open_application: "Open DeepSeek Harness",
    quit: "Quit",
    cancel: "Cancel",
    quit_title: "Quit DeepSeek Harness?",
    quit_active_tasks: "Running tasks will be interrupted.",
    quit_scheduled_tasks: "Scheduled tasks will not run while the app is closed.",
    quit_active_and_scheduled_tasks:
        "Running tasks will be interrupted, and scheduled tasks will not run while the app is closed.",
    background_notice_body: "Running tasks will continue. You can reopen the window from the system tray.",
    background_notice_confirm: "Confirm",
    application: "Application",
    file_menu: "File",
    close_page: "Close Page or Window",
    edit: "Edit",
    delete: "Delete",
    undo: "Undo",
    redo: "Redo",
    cut: "Cut",
    copy: "Copy",
    paste: "Paste",
    select_all: "Select All",
    check_updates_menu: "Check for Updates…",
    reload_page_menu: "Reload Page",
    restart_app_host_menu: "Restart App and Host",
    exit_application: "Exit",
    restart_application: "Restart",
    diagnostic_truncated: "… Error details shortened.",
    report_written_to: "Diagnostic report: {path}",
    startup_reinstall_advice: "If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.",
    update_title: "DeepSeek Harness Update",
    update_current: "No updates available. Current version: V{version}",
    update_download: "Download update",
    update_available: "An update is available",
    update_detail: "DeepSeek Harness {version}\n\nDeepSeek Harness will restart to complete the update.",
    install_and_restart: "Install and Restart",
    later: "Later",
    update_downloaded_title_windows: "New version v{version} is ready",
    update_downloaded_detail_windows: "The app will close temporarily during the update and reopen automatically when it is complete.\n\nThe update may take some time. Please wait and do not launch the app again during installation.",
    update_active_tasks: "Tasks are still in progress",
    update_active_tasks_detail: "Restarting to update may interrupt these tasks. Continue updating?",
    update_stop_tasks: "Stop tasks and update",
};

/// Chinese dictionary (verbatim upstream `locale.ts` strings the shell owns).
pub const ZH: ShellMessages = ShellMessages {
    about_product: "DeepSeek Harness",
    about_version: "版本 V{version}",
    quit_application: "退出 DeepSeek Harness",
    open_application: "打开 DeepSeek Harness",
    quit: "退出",
    cancel: "取消",
    quit_title: "退出 DeepSeek Harness？",
    quit_active_tasks: "当前正在运行的任务将会中断",
    quit_scheduled_tasks: "应用关闭期间，定时任务不会运行",
    quit_active_and_scheduled_tasks: "当前正在运行的任务将会中断，且应用关闭期间，定时任务不会运行",
    background_notice_body: "正在运行的任务不会中断，可在系统托盘中重新打开窗口",
    background_notice_confirm: "确认",
    application: "应用",
    file_menu: "文件",
    close_page: "关闭页面或窗口",
    edit: "编辑",
    delete: "删除",
    undo: "撤销",
    redo: "重做",
    cut: "剪切",
    copy: "复制",
    paste: "粘贴",
    select_all: "全选",
    check_updates_menu: "检查更新…",
    reload_page_menu: "刷新页面",
    restart_app_host_menu: "重启应用与 Host",
    exit_application: "退出",
    restart_application: "重启",
    diagnostic_truncated: "… 错误详情已截短。",
    report_written_to: "诊断报告：{path}",
    startup_reinstall_advice: "如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。",
    update_title: "DeepSeek Harness 更新",
    update_current: "当前暂无可用更新。当前版本：V{version}",
    update_download: "下载更新",
    update_available: "发现可用更新",
    update_detail: "DeepSeek Harness {version}\n\nDeepSeek Harness 将重启以完成更新。",
    install_and_restart: "安装并重启",
    later: "稍后",
    update_downloaded_title_windows: "新版本 v{version} 已准备就绪",
    update_downloaded_detail_windows: "更新期间应用将暂时关闭，完成后会自动打开。\n\n更新可能需要一些时间，请耐心等待，期间请勿重复启动应用。",
    update_active_tasks: "仍有进行中的任务",
    update_active_tasks_detail: "重启更新可能中断这些任务，是否要继续更新？",
    update_stop_tasks: "停止任务并更新",
};

/// The shell dictionary for one locale.
pub fn messages(locale: LocaleId) -> &'static ShellMessages {
    match locale {
        LocaleId::En => &EN,
        LocaleId::Zh => &ZH,
    }
}

/// Replace named placeholders in one locale-owned message
/// (upstream `formatDesktopMessage`).
pub fn format_message(message: &str, values: &[(&str, &str)]) -> String {
    let mut out = message.to_string();
    for (key, value) in values {
        out = out.replace(&format!("{{{key}}}"), value);
    }
    out
}

/// Startup locale rule (upstream `resolveDesktopStartupLocale`): explicit
/// preference wins; otherwise the first supported OS language; otherwise
/// English.
pub fn resolve_startup_locale(
    preference: Option<LocaleId>,
    languages: &[String],
) -> (LocaleId, LocaleSource) {
    if let Some(preference) = preference {
        return (preference, LocaleSource::Preference);
    }
    for language in languages {
        let primary = language
            .to_lowercase()
            .split('-')
            .next()
            .unwrap_or_default()
            .to_string();
        match primary.as_str() {
            "zh" => return (LocaleId::Zh, LocaleSource::Os),
            "en" => return (LocaleId::En, LocaleSource::Os),
            _ => {}
        }
    }
    (LocaleId::En, LocaleSource::Default)
}

/// Operating-system languages in preference order (BCP 47 tags).
///
/// Windows reports its ordered preferred UI languages (not regional settings);
/// the POSIX locale chain remains the fallback and the only source elsewhere.
/// Evaluation order is deliberate: the environment chain runs last, so a stale
/// `LANG` cannot mask the OS answer the native guest locale rule reads.
pub fn os_languages() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        // `defaults read -g AppleLanguages` is not reachable from a sandboxed
        // helper; the POSIX locale chain is the portable approximation.
    }
    let mut languages: Vec<String> = native_ui_languages();
    for key in ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] {
        if let Ok(value) = std::env::var(key) {
            for part in value.split(':') {
                let tag = part.split('.').next().unwrap_or_default().to_string();
                if !tag.is_empty() && !languages.contains(&tag) {
                    languages.push(tag);
                }
            }
        }
    }
    languages
}

/// Decode a Windows double-NUL-terminated ordered language list.
#[cfg(any(target_os = "windows", test))]
fn decode_ui_language_list(buffer: &[u16]) -> Vec<String> {
    let mut languages = Vec::new();
    for part in buffer
        .split(|word| *word == 0)
        .take_while(|part| !part.is_empty())
    {
        if let Ok(tag) = String::from_utf16(part) {
            if !languages.contains(&tag) {
                languages.push(tag);
            }
        }
    }
    languages
}

/// Preferred UI languages, deliberately independent of the user's region.
#[cfg(target_os = "windows")]
fn native_ui_languages() -> Vec<String> {
    use windows::core::PWSTR;
    use windows::Win32::Globalization::{GetUserPreferredUILanguages, MUI_LANGUAGE_NAME};
    let mut count = 0u32;
    let mut capacity = 0u32;
    // SAFETY: the first call is the documented size query with no output buffer.
    if unsafe { GetUserPreferredUILanguages(MUI_LANGUAGE_NAME, &mut count, None, &mut capacity) }
        .is_err()
        || !(2..=16_384).contains(&capacity)
    {
        return Vec::new();
    }
    let mut buffer = vec![0u16; capacity as usize];
    // SAFETY: capacity exactly describes the writable, live UTF-16 buffer.
    if unsafe {
        GetUserPreferredUILanguages(
            MUI_LANGUAGE_NAME,
            &mut count,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut capacity,
        )
    }
    .is_err()
        || capacity as usize > buffer.len()
    {
        return Vec::new();
    }
    decode_ui_language_list(&buffer[..capacity as usize])
}

/// Non-Windows builds take their language order from the POSIX locale chain.
#[cfg(not(target_os = "windows"))]
fn native_ui_languages() -> Vec<String> {
    Vec::new()
}

/// Current locale bookkeeping (preference persistence is `settings_*`-backed).
pub struct LocaleModel {
    pub preference: Option<LocaleId>,
    pub effective: LocaleId,
    pub source: LocaleSource,
    pub languages: Vec<String>,
    /// Applied without persisting (amendment A4).
    pub applied: Option<LocaleId>,
}

impl LocaleModel {
    pub fn snapshot(&self) -> LocaleState {
        LocaleState {
            preference: self.preference,
            effective: self.applied.unwrap_or(self.effective),
            source: if self.applied.is_some() {
                LocaleSource::Preference
            } else {
                self.source
            },
            languages: self.languages.clone(),
        }
    }
}

/// Shared shell state behind the Tauri commands and events.
pub struct AppState {
    pub paths: AppPaths,
    pub settings: Mutex<SettingsStore>,
    pub credentials: Mutex<CredentialStore<DesktopSecretBackend>>,
    pub shortcuts: ShortcutPersistence,
    pub supervisor: Arc<Supervisor>,
    pub gateway: GatewayHandle,
    pub policy: Arc<crate::policy_composition::PolicyGate>,
    pub guests: Mutex<crate::guests::GuestViews>,
    /// Host-owned credential state; never returned through application IPC.
    pub platform_session: Mutex<Option<dsh_runtime::control::PlatformSession>>,
    pub locale: Mutex<LocaleModel>,
    pub theme: Mutex<Theme>,
    pub update: Mutex<UpdateService>,
    pub quit_flow: Mutex<QuitFlow>,
    /// Onboarding visibility signalled by `shell_onboarding_set_active`.
    pub onboarding_active: Mutex<bool>,
    /// Boot credential coordinates (amendment A5); `None` when unconfigured.
    pub credential_ref: Option<CredentialIdentity>,
    /// Recent error-level renderer console output for crash reports.
    pub renderer_console: Mutex<crate::renderer_diagnostics::RendererDiagnostics>,
    /// Once-only background-close acknowledgement state (Windows first hide).
    pub background_close_confirmed: Mutex<bool>,
    /// Startup outcome of the supervised Host run (set once per run).
    pub boot_outcome: Mutex<Option<Result<(), String>>>,
    /// Wakes `runtime_boot_ready` waiters on every startup progress point.
    pub boot_notify: tokio::sync::Notify,
}

impl AppState {
    /// Build the `Appearance` snapshot backing the Windows caption sync.
    pub fn appearance(&self, theme: Theme) -> Appearance {
        Appearance {
            theme,
            accent: "rgba(24, 25, 28, 0.5)".to_string(),
            caption_height_dip: 40,
            reduce_motion: false,
            reduce_transparency: false,
            increase_contrast: false,
        }
    }
}

/// Shortcut engine platform selector for this build.
pub fn shortcut_platform() -> ShortcutPlatform {
    ShortcutPlatform::current()
}

/// `keybindings.json` storage over the application user-data directory (K1).
pub fn shortcut_storage(paths: &AppPaths) -> FileShortcutStorage {
    FileShortcutStorage::new(&paths.keybindings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ui_language_list_preserves_order_and_stops_at_double_nul() {
        let buffer: Vec<u16> = "de-DE\0zh-Hans\0en-US\0\0fr-FR\0".encode_utf16().collect();
        assert_eq!(
            decode_ui_language_list(&buffer),
            ["de-DE", "zh-Hans", "en-US"]
        );
    }

    #[test]
    fn ui_language_list_ignores_invalid_utf16_and_duplicates() {
        let mut buffer: Vec<u16> = "en-US\0en-US\0".encode_utf16().collect();
        buffer.extend([0xD800, 0]);
        buffer.extend("zh-Hant\0\0".encode_utf16());
        assert_eq!(decode_ui_language_list(&buffer), ["en-US", "zh-Hant"]);
        assert!(decode_ui_language_list(&[0, 0]).is_empty());
    }

    #[test]
    fn preference_wins_over_environment_and_os() {
        let languages = vec!["zh-Hans-CN".to_string(), "en-US".to_string()];
        assert_eq!(
            resolve_startup_locale(Some(LocaleId::En), &languages),
            (LocaleId::En, LocaleSource::Preference)
        );
    }

    #[test]
    fn first_supported_language_decides_automatic_selection() {
        assert_eq!(
            resolve_startup_locale(None, &["de-DE".to_string(), "zh-Hans-CN".to_string()]),
            (LocaleId::Zh, LocaleSource::Os)
        );
        assert_eq!(
            resolve_startup_locale(None, &["fr-FR".to_string()]),
            (LocaleId::En, LocaleSource::Default)
        );
    }

    /// `zh-Hant-TW` must not be mistaken for a supported locale: upstream only
    /// offers `en` and `zh`, and the primary subtag is the whole rule.
    #[test]
    fn primary_subtag_is_the_matching_rule() {
        assert_eq!(
            resolve_startup_locale(None, &["ZH-hant-tw".to_string()]).0,
            LocaleId::Zh
        );
    }
}
