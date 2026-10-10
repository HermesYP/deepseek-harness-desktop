//! Localized copy the shell surfaces this lane adds, layered on the
//! lead-owned [`crate::state::ShellMessages`] dictionary.
//!
//! Every string here is transcribed verbatim from
//! `_upstream/apps/desktop/src/locale.ts` at the pinned revision, so the native
//! copy stays one dictionary in one language:
//!
//! | Key | Upstream |
//! |---|---|
//! | `menuBar` | `locale.ts:24` / `:168` |
//! | `fatalSummary` | `locale.ts:33` / `:177` |
//! | `startupAddressInUse` | `locale.ts:34` / `:178` |
//! | `recoveryOperationFailed` | `locale.ts:40` / `:184` |
//! | `disableThirdPartyPlugins` | `locale.ts:41` / `:185` |
//!
//! The lane keeps them beside its own modules rather than editing the shared
//! dictionary struct, so no concurrent contributor has to rebase on this
//! change. `crate::state::messages` stays the single locale selector and this
//! module indexes the same [`LocaleId`]; folding these five fields into
//! `ShellMessages` later is a pure move, not a behaviour change.

use dsh_core::protocol::LocaleId;

/// Shell copy added by the shell/native-integration lane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellExtensionMessages {
    /// `role="menubar"` accessible name of the Windows caption menu
    /// (`messages.menuBar`, `preload-menu.ts:100`).
    pub menu_bar: &'static str,
    /// Recovery dialog summary line (`messages.fatalSummary`,
    /// `fatal-recovery.ts:71`).
    pub fatal_summary: &'static str,
    /// Detail shown when the port is already held by another DSH process
    /// (`messages.startupAddressInUse`, `fatal-recovery.ts:78`).
    pub startup_address_in_use: &'static str,
    /// Summary shown after a recovery operation itself failed
    /// (`messages.recoveryOperationFailed`, `fatal-recovery.ts:100`).
    pub recovery_operation_failed: &'static str,
    /// Third recovery button (`messages.disableThirdPartyPlugins`,
    /// `fatal-recovery.ts:83`).
    pub disable_third_party_plugins: &'static str,
}

/// English extension copy (`locale.ts` `en`).
pub const EN: ShellExtensionMessages = ShellExtensionMessages {
    menu_bar: "Application menu",
    fatal_summary: "The application could not start or stopped unexpectedly.",
    startup_address_in_use: "Another DSH instance (such as dsh web or the desktop app) is running. They cannot start at the same time. Quit the other running DSH instance, then restart.",
    recovery_operation_failed: "The recovery operation failed",
    disable_third_party_plugins: "Disable third-party plugins, back up profile patch, and restart",
};

/// Chinese extension copy (`locale.ts` `zh`).
pub const ZH: ShellExtensionMessages = ShellExtensionMessages {
    menu_bar: "应用菜单",
    fatal_summary: "应用无法启动或已意外停止。",
    startup_address_in_use: "有其他正在运行的 DSH（如其他 dsh web、桌面端），无法同时启动，请退出其他正在运行的 DSH 后重启。",
    recovery_operation_failed: "恢复操作失败",
    disable_third_party_plugins: "禁用第三方插件、备份 profile patch 并重启",
};

/// The extension dictionary for one locale.
pub fn messages(locale: LocaleId) -> &'static ShellExtensionMessages {
    match locale {
        LocaleId::En => &EN,
        LocaleId::Zh => &ZH,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_dictionaries_are_complete_and_distinct() {
        assert_ne!(EN.menu_bar, ZH.menu_bar);
        assert_ne!(EN.fatal_summary, ZH.fatal_summary);
        assert_ne!(EN.startup_address_in_use, ZH.startup_address_in_use);
        assert_ne!(EN.recovery_operation_failed, ZH.recovery_operation_failed);
        assert_ne!(
            EN.disable_third_party_plugins,
            ZH.disable_third_party_plugins
        );
        for value in [
            EN.menu_bar,
            EN.fatal_summary,
            EN.startup_address_in_use,
            EN.recovery_operation_failed,
            EN.disable_third_party_plugins,
            ZH.menu_bar,
            ZH.fatal_summary,
            ZH.startup_address_in_use,
            ZH.recovery_operation_failed,
            ZH.disable_third_party_plugins,
        ] {
            assert!(!value.is_empty(), "no copy may be empty");
            assert!(!value.contains('{'), "{value} must not carry placeholders");
        }
    }

    #[test]
    fn copy_matches_the_reference_dictionary_verbatim() {
        // Pinned from `_upstream/apps/desktop/src/locale.ts:24,33,34,40,41`.
        assert_eq!(EN.menu_bar, "Application menu");
        assert_eq!(
            EN.fatal_summary,
            "The application could not start or stopped unexpectedly."
        );
        assert!(EN
            .startup_address_in_use
            .starts_with("Another DSH instance"));
        assert_eq!(
            EN.recovery_operation_failed,
            "The recovery operation failed"
        );
        assert_eq!(
            EN.disable_third_party_plugins,
            "Disable third-party plugins, back up profile patch, and restart"
        );
        // Pinned from `locale.ts:168,177,178,184,185`.
        assert_eq!(ZH.menu_bar, "应用菜单");
        assert_eq!(ZH.fatal_summary, "应用无法启动或已意外停止。");
        assert_eq!(ZH.recovery_operation_failed, "恢复操作失败");
        assert_eq!(
            ZH.disable_third_party_plugins,
            "禁用第三方插件、备份 profile patch 并重启"
        );
    }

    #[test]
    fn the_locale_selector_follows_the_shared_dictionary() {
        assert_eq!(messages(LocaleId::En).menu_bar, EN.menu_bar);
        assert_eq!(messages(LocaleId::Zh).menu_bar, ZH.menu_bar);
    }
}
