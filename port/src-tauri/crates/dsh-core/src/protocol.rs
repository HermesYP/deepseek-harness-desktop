//! Every payload type of `docs/contracts/tauri-contract.md`, with the
//! verbatim re-declarations the contract names:
//!
//! - `IndexInjection` — `_upstream/packages/host/webserver/src/injections.ts:15-31`.
//! - `DesktopUpdatePresentation` / `DesktopUpdateState` — `_upstream/apps/desktop/src/ipc.ts:35-68`.
//! - `ShortcutConfigSnapshot`, `ShortcutSaveResult`, `ShortcutEdit`,
//!   `ShortcutDefinition` — `_upstream/packages/client/shortcuts/protocol`
//!   (`persistence.ts:11-38`, `configuration.ts:7-29`), field names and
//!   optionality unchanged.
//!
//! `ShortcutBinding` (the `dsh://shortcuts/changed` row) is upstream
//! `NormalizedBinding` plus the command `id`, ratified in the contract.
//! Upstream's declared-binding type (`binding.ts:15-19`, where `primary` is
//! still legal) is re-declared as `ShortcutBindingSpec` and used inside the
//! verbatim types above.
//!
//! Fixtures in `port/fixtures/protocol/*.json` are compact JSON with struct
//! field order; both language sides must round-trip them byte-identically.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Application identity
// ---------------------------------------------------------------------------

/// Supported shell locales (contract `"en" | "zh"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocaleId {
    En,
    Zh,
}

impl LocaleId {
    /// The stable string form used by settings and events.
    pub fn as_str(self) -> &'static str {
        match self {
            LocaleId::En => "en",
            LocaleId::Zh => "zh",
        }
    }
}

/// How the effective locale was chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LocaleSource {
    Preference,
    Os,
    Default,
}

/// Response of `shell_locale_get` / `shell_locale_set` / `shell_locale_apply`
/// (amendment A9: `languages` is the OS language order used for automatic
/// selection — `__DSH_LOCALE__.read()` returns `{languages, preference}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocaleState {
    /// Explicit user preference, or `null` for automatic selection.
    pub preference: Option<LocaleId>,
    /// Dictionary in effect.
    pub effective: LocaleId,
    /// Where `effective` came from.
    pub source: LocaleSource,
    /// Operating-system languages in preference order (BCP 47 tags).
    pub languages: Vec<String>,
}

/// Response of `shell_app_info`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    /// Product name (`DeepSeek Harness`).
    pub product_name: String,
    /// Installed release version (identical to the bundled dsh runtime version).
    pub version: String,
    /// Desktop-Host lifecycle protocol generation; always `4`.
    pub protocol_generation: u32,
    /// Bundled dsh runtime version.
    pub runtime_version: String,
    /// `win32` | `darwin` | `linux` (upstream `process.platform` spellings).
    pub platform: String,
    /// `x64` | `arm64` (upstream `process.arch` spellings).
    pub arch: String,
    /// Effective shell locale.
    pub locale: LocaleId,
    /// Official provider's configured credential reference (amendment A5),
    /// supplied at boot; `null` means none configured and onboarding reports
    /// no API key. A reference identifier, never a secret.
    pub credential_ref: Option<CredentialIdentity>,
}

/// Theme preference (`shell_theme_set`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

/// Response of `shell_appearance`; backs the Windows caption colour sync.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Appearance {
    pub theme: Theme,
    /// CSS colour of the caption accent surface.
    pub accent: String,
    /// Windows caption height in device-independent pixels (upstream `WINDOWS_TITLEBAR_HEIGHT`, 40).
    pub caption_height_dip: u32,
    pub reduce_motion: bool,
    pub reduce_transparency: bool,
    pub increase_contrast: bool,
}

/// Closed union of `shell_menu_action` (`docs/contracts/tauri-contract.md`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MenuActionId {
    About,
    CheckForUpdates,
    Exit,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    Delete,
    SelectAll,
    ClosePageOrWindow,
    ReloadPage,
    RestartAppAndHost,
    ToggleDevtools,
    Minimize,
    Hide,
    HideOthers,
    ShowAll,
    ZoomIn,
    ZoomOut,
    ResetZoom,
}

// ---------------------------------------------------------------------------
// Index injections (verbatim from packages/host/webserver/src/injections.ts)
// ---------------------------------------------------------------------------

/// Document region a rendered row lands in: after the opening head or body tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IndexInjectionPlacement {
    Head,
    Body,
}

/// One structured index injection row (verbatim `IndexInjection` union).
///
/// A JSON-absent `value` (a TypeScript `value: undefined`) is represented as
/// `null`, which is JSON's own encoding of that state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum IndexInjection {
    /// Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows.
    Global {
        name: String,
        #[serde(default)]
        value: serde_json::Value,
    },
    /// Inline classic script. `text` must not contain `</script`.
    Script {
        placement: IndexInjectionPlacement,
        text: String,
    },
    /// External classic script, executed in table order.
    ScriptSrc {
        placement: IndexInjectionPlacement,
        src: String,
    },
    /// Advisory preload for an external classic script.
    ScriptPreload { src: String },
    /// A `<style>` element in the head. `text` must not contain `</style`.
    Style { text: String },
    /// Raw markup fragment.
    Html {
        placement: IndexInjectionPlacement,
        html: String,
    },
}

/// Response of `runtime_boot_ready`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BootPayload {
    /// The Host's collected injection table (`collectIndexInjections()`).
    pub injections: Vec<IndexInjection>,
    /// Gateway origin the client re-bases the stream mux onto.
    pub stream_base_url: String,
    /// The authenticated application URL (carries the one-time launch token).
    pub authenticated_url: String,
}

// ---------------------------------------------------------------------------
// Runtime supervision
// ---------------------------------------------------------------------------

/// Supervisor state machine (`RuntimeState` closed union).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeState {
    Starting,
    Ready,
    Stopping,
    Stopped,
    Failed,
}

/// Response of `runtime_status`; emitted as `dsh://runtime/state` on every transition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub state: RuntimeState,
    /// The Host's authenticated URL while ready.
    pub url: Option<String>,
    /// RFC 3339 timestamp of the current run's readiness.
    pub started_at: Option<String>,
    /// Rendered text of the last failure, if any.
    pub last_error: Option<String>,
}

/// Response of `runtime_quit_inspection` and the Host's `quit-inspection` answer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QuitInspection {
    /// Work the update-restart check also counts (running agents, queued messages, live jobs).
    pub active_tasks: bool,
    /// A loaded session holds a scheduled reminder whose timer is armed in this process.
    pub scheduled_tasks: bool,
    /// Diagnostic from a failed inspection; the decision model still fails closed.
    pub error: Option<String>,
}

/// Terminal `dsh://shell/quit-confirmed` reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum QuitReason {
    User,
    Installer,
    Update,
    FatalRecovery,
    OsShutdown,
}

/// Window lifecycle state (`dsh://shell/window`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellWindowState {
    Shown,
    Hidden,
    Focused,
    Blurred,
}

// ---------------------------------------------------------------------------
// Settings and credentials
// ---------------------------------------------------------------------------

/// Closed union over `string | number | boolean | null`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum SettingValue {
    String(String),
    Number(serde_json::Number),
    Bool(bool),
    Null,
}

/// Metadata returned by `credential_list`; never carries a secret value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialRef {
    /// Credential provider namespace (e.g. `client-connection`).
    pub provider: String,
    /// Reference id within the provider (e.g. `browser-session`).
    pub reference: String,
    /// Whether a secret currently exists in the OS store.
    pub has_secret: bool,
    /// RFC 3339 timestamp of the last write through this store.
    pub updated_at: String,
}

/// Response of `credential_has`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialPresence {
    pub present: bool,
}

/// Response of `shell_clipboard_read` (declared type `ClipboardText`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClipboardText {
    pub text: String,
}

/// Response of `shell_pick_directory` (declared type `PickedDirectory`);
/// `path: null` is the cancellation arm and stays retryable.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PickedDirectory {
    pub path: Option<String>,
}

/// Response of `settings_list`: `Record<string, SettingValue>` (declared type
/// `SettingsMap`).
pub type SettingsMap = BTreeMap<String, SettingValue>;

/// Request of `shell_locale_set` (persists the preference).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocaleSetRequest {
    pub preference: Option<LocaleId>,
}

/// Request of `shell_locale_apply` (amendment A4: reports the active locale,
/// persists nothing).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocaleApplyRequest {
    pub locale: LocaleId,
}

/// Request of `shell_shortcuts_get`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutsGetRequest {
    pub definitions: Vec<ShortcutDefinition>,
}

/// Request of `shell_shortcuts_edit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutsEditRequest {
    pub edit: ShortcutEdit,
    pub revision: String,
}

/// Request of `shell_shortcuts_recording`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutsRecordingRequest {
    pub active: bool,
}

/// Request of `credential_store` — the only command that accepts a secret
/// value. The secret travels once and is never logged, echoed, or persisted to
/// disk by Rust.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialStoreRequest {
    pub provider: String,
    pub reference: String,
    pub secret: String,
}

/// Request of `shell_pick_directory`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PickDirectoryRequest {
    pub title: Option<String>,
    pub default_path: Option<String>,
}

/// Request of `shell_close_window` (amendment A9): the revision correlates and
/// retires the binding dispatch (`DesktopKeyboardApi.closeWindow(revision)`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellCloseWindowRequest {
    pub revision: String,
}

/// Request of `shell_onboarding_set_active` (amendment A9): signals onboarding
/// visibility so the shell can hold or release the workspace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OnboardingSetActiveRequest {
    pub active: bool,
}

// ---------------------------------------------------------------------------
// Update presentation (verbatim from apps/desktop/src/ipc.ts)
// ---------------------------------------------------------------------------

/// Upstream `DesktopUpdateState['phase']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopUpdatePhase {
    Idle,
    Checking,
    Available,
    Downloading,
    Verifying,
    Installing,
    Ready,
    Error,
}

/// Upstream `DesktopUpdatePreparationFailureKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopUpdatePreparationFailureKind {
    StopFailed,
    TasksChanged,
    TasksUnavailable,
}

/// Upstream updater operation that failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopUpdateOperation {
    Check,
    Download,
    Install,
}

/// Upstream `DesktopUpdateFailureKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopUpdateFailureKind {
    Check,
    CheckNetwork,
    Download,
    DownloadNetwork,
    Install,
    InstallNetwork,
    StopFailed,
    TasksChanged,
    TasksUnavailable,
}

/// Upstream `DesktopUpdateState` (`apps/desktop/src/ipc.ts:37-48`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateState {
    pub phase: DesktopUpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Main-owned diagnostics without subprocess output or credentials.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub technical_details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_operation: Option<DesktopUpdateOperation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preparation_failure: Option<DesktopUpdatePreparationFailureKind>,
}

/// Upstream `DesktopUpdatePresentation` (`apps/desktop/src/ipc.ts:63-68`), verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdatePresentation {
    pub phase: DesktopUpdatePhase,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub percent: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<DesktopUpdateFailureKind>,
}

// ---------------------------------------------------------------------------
// Shortcut configuration (verbatim from packages/client/shortcuts/protocol)
// ---------------------------------------------------------------------------

/// Upstream `ShortcutModifier` (`binding.ts:13`); `primary` expands to Meta on
/// macOS and Control elsewhere.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutModifier {
    Primary,
    Control,
    Alt,
    Shift,
    Meta,
}

/// Upstream `ShortcutBinding` (`binding.ts:15-19`) — **verbatim**, no `id`
/// (amendment A1). A declared binding where `primary` is still legal; used
/// inside `ShortcutDefinition`, `ShortcutDocument`, `ShortcutEdit`,
/// `ShortcutConfigSnapshot`, and `ShortcutSaveResult`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBinding {
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub second_code: Option<String>,
    pub modifiers: Vec<ShortcutModifier>,
}

/// `ShortcutBindingRow` = `{ id } & ShortcutBinding` (amendment A1) — the
/// accepted effective binding row carried by `dsh://shortcuts/changed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutBindingRow {
    /// Stable command identity (e.g. `page.close`).
    pub id: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub second_code: Option<String>,
    pub modifiers: Vec<ShortcutModifier>,
}

/// Input kind of the key-bearing arm of `DesktopShortcutInput`
/// (`preload-app.ts:18-36` consumers branch on `iframe`/`webview` frame
/// matching).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DesktopShortcutInputKind {
    Keyboard,
    Iframe,
    Webview,
}

/// The `kind: 'menu'` arm's discriminator (upstream `native.ts:6-10`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DesktopShortcutInputMenuKind {
    #[serde(rename = "menu")]
    Menu,
}

/// `kind: 'menu'` arm of upstream `DesktopShortcutInput`
/// (`native.ts:6-10`, amendment A10): a menu-routed page command (K10).
/// `command_id` is an upstream `ShortcutCommandId` (e.g. `page.close`) and is
/// deliberately distinct from `MenuActionId`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShortcutMenuInput {
    /// Accepted configuration identity (opaque `ShortcutRevision`).
    pub revision: String,
    pub kind: DesktopShortcutInputMenuKind,
    #[serde(rename = "commandId")]
    pub command_id: String,
}

/// Key-bearing arm (`kind: 'keyboard' | 'iframe' | 'webview'`) of upstream
/// `DesktopShortcutInput` (`native.ts:11-16`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopShortcutKeyInput {
    /// Accepted configuration identity (opaque `ShortcutRevision`).
    pub revision: String,
    pub kind: DesktopShortcutInputKind,
    /// Identifies the focused iframe or browser-guest embedding element.
    pub frame_name: String,
    pub code: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub second_code: Option<String>,
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub meta: bool,
    pub repeat: bool,
}

/// `DesktopShortcutInput` — upstream verbatim (amendment A10), the payload of
/// `dsh://shortcuts/input`: `{revision} & ({kind:'menu', commandId} |
/// {kind:'keyboard'|'iframe'|'webview', frameName, code, secondCode?, control,
/// alt, shift, meta, repeat})`. Drives `DesktopKeyboardApi.subscribe`; the
/// `menu` arm carries K10 menu-routed page commands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DesktopShortcutInput {
    Menu(DesktopShortcutMenuInput),
    Keys(DesktopShortcutKeyInput),
}

/// Identity of an onboarding credential reference (amendment A5): a reference
/// identifier, never a secret.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CredentialIdentity {
    pub provider: String,
    pub reference: String,
}

/// Upstream `ShortcutDocument` (`configuration.ts:7-10`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDocument {
    pub schema_version: u32,
    pub profiles: BTreeMap<String, BTreeMap<String, Option<ShortcutBinding>>>,
}

/// Upstream `ShortcutDefinition` (`configuration.ts:12-17`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutDefinition {
    pub id: String,
    pub defaults: BTreeMap<String, ShortcutBinding>,
    /// Fixed actions reserve one or more combinations instead of an editable default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fixed: Option<Vec<ShortcutBinding>>,
}

/// Upstream `BindingIssue` (`configuration.ts:19`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BindingIssue {
    Reserved,
    UnsupportedBrowser,
    ModifierRequired,
    UnsupportedKey,
}

/// Upstream `ShortcutConfigSnapshot['status']` (`persistence.ts:15`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutConfigStatus {
    Loading,
    Ready,
    Unreadable,
}

/// Upstream `ShortcutConfigSnapshot['error']` (`persistence.ts:18`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShortcutConfigError {
    Read,
    Invalid,
    Future,
}

/// Upstream `ShortcutConfigSnapshot` (`persistence.ts:11-19`), verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutConfigSnapshot {
    pub revision: String,
    pub sequence: u64,
    pub document: ShortcutDocument,
    pub status: ShortcutConfigStatus,
    pub error: Option<ShortcutConfigError>,
    pub using_defaults: bool,
}

/// Upstream `ShortcutSaveResult['status']` (`persistence.ts:22`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ShortcutSaveStatus {
    Saved,
    Stale,
    Unreadable,
    WriteFailed,
    NotReady,
    Conflict,
}

/// Upstream `ShortcutSaveResult` (`persistence.ts:21-26`), verbatim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutSaveResult {
    pub status: ShortcutSaveStatus,
    pub snapshot: ShortcutConfigSnapshot,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue: Option<BindingIssue>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conflicts: Option<Vec<String>>,
}

/// Upstream `ShortcutEdit` (`configuration.ts:29-30`), verbatim closed union.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ShortcutEdit {
    /// `set` stores `null` to explicitly unbind.
    Set {
        id: String,
        binding: Option<ShortcutBinding>,
    },
    Reset { id: String },
    ResetAll,
}

/// Payload of `dsh://shortcuts/changed` (declared type `ShortcutsChangedEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutsChangedEvent {
    pub bindings: Vec<ShortcutBindingRow>,
}

/// Payload of `dsh://shortcuts/recording` (declared type `ShortcutsRecordingEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShortcutsRecordingEvent {
    pub recording: bool,
}

/// Payload of `dsh://shell/window` (declared type `ShellWindowEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellWindowEvent {
    pub state: ShellWindowState,
}

/// Payload of `dsh://shell/quit-confirmed` (declared type `ShellQuitConfirmedEvent`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellQuitConfirmedEvent {
    pub reason: QuitReason,
}

// ---------------------------------------------------------------------------
// Bundled release metadata (upstream apps/desktop/src/release.ts)
// ---------------------------------------------------------------------------

/// Release facts embedded in the bundled runtime descriptor
/// (`DesktopRelease`, `apps/desktop/src/release.ts:7-15`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRelease {
    pub schema_version: u32,
    /// Exact version used by both the shell and `@deepseek-ai/dsh`.
    pub version: String,
    /// Must equal `DESKTOP_HOST_PROTOCOL_VERSION` (4).
    pub host_protocol_version: u32,
    pub node_version: String,
    pub pnpm_version: String,
}

/// Minimal SemVer acceptance (upstream `semver.valid`): `major.minor.patch`
/// with an optional `-prerelease` and optional `+build`.
fn valid_semver(value: &str) -> bool {
    let (core, rest) = match value.split_once('+') {
        Some((core, build)) if !build.is_empty() && !build.contains([' ', '+']) => (core, true),
        Some(_) => return false,
        None => (value, true),
    };
    let _ = rest;
    let (numbers, prerelease) = match core.split_once('-') {
        Some((numbers, pre)) if !pre.is_empty() => (numbers, Some(pre)),
        Some(_) => return false,
        None => (core, None),
    };
    let mut parts = numbers.split('.');
    let mut count = 0;
    for part in parts.by_ref() {
        count += 1;
        if part.is_empty()
            || part.len() > 1 && part.starts_with('0')
            || !part.bytes().all(|b| b.is_ascii_digit())
        {
            return false;
        }
    }
    if count != 3 {
        return false;
    }
    match prerelease {
        None => true,
        Some(pre) => pre
            .split('.')
            .all(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')),
    }
}

impl DesktopRelease {
    /// Validate release data read from an installed or packaged filesystem
    /// resource (upstream `parseDesktopRelease`, `release.ts:19-35`).
    /// Requires `host_protocol_version` to equal the pinned generation `4`.
    pub fn validate(&self, expected_protocol_generation: u32) -> bool {
        self.schema_version == 1
            && valid_semver(&self.version)
            && self.host_protocol_version == expected_protocol_generation
            && valid_semver(&self.node_version)
            && valid_semver(&self.pnpm_version)
    }
}

/// Desktop-Host lifecycle protocol generation (`DESKTOP_HOST_PROTOCOL_VERSION`).
pub const PROTOCOL_GENERATION: u32 = 4;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_injection_kind_names_match_upstream() {
        let rows = vec![
            IndexInjection::Global { name: "x".into(), value: serde_json::json!(1) },
            IndexInjection::Script { placement: IndexInjectionPlacement::Head, text: "t".into() },
            IndexInjection::ScriptSrc { placement: IndexInjectionPlacement::Body, src: "s".into() },
            IndexInjection::ScriptPreload { src: "p".into() },
            IndexInjection::Style { text: "css".into() },
            IndexInjection::Html { placement: IndexInjectionPlacement::Body, html: "<b>".into() },
        ];
        let json = serde_json::to_string(&rows).expect("serialize");
        for kind in ["global", "script", "script-src", "script-preload", "style", "html"] {
            assert!(json.contains(&format!("\"kind\":\"{kind}\"")), "missing kind {kind}");
        }
    }

    #[test]
    fn setting_value_closed_union_round_trips() {
        for value in [
            SettingValue::String("s".into()),
            SettingValue::Number(serde_json::Number::from(42)),
            SettingValue::Number(serde_json::Number::from_f64(1.5).expect("finite")),
            SettingValue::Bool(true),
            SettingValue::Null,
        ] {
            let json = serde_json::to_string(&value).expect("serialize");
            let back: SettingValue = serde_json::from_str(&json).expect("deserialize");
            assert_eq!(back, value);
        }
    }

    #[test]
    fn release_validation_pins_protocol_generation() {
        let ok = DesktopRelease {
            schema_version: 1,
            version: "0.1.7-rc.2".into(),
            host_protocol_version: 4,
            node_version: "25.4.0".into(),
            pnpm_version: "11.7.0".into(),
        };
        assert!(ok.validate(PROTOCOL_GENERATION));
        let wrong_generation = DesktopRelease { host_protocol_version: 3, ..ok.clone() };
        assert!(!wrong_generation.validate(PROTOCOL_GENERATION));
        let bad_version = DesktopRelease { version: "1.2".into(), ..ok.clone() };
        assert!(!bad_version.validate(PROTOCOL_GENERATION));
    }
}
