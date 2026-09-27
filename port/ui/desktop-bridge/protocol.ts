/**
 * Hand-written TypeScript mirror of `docs/contracts/tauri-contract.md`
 * (binding, including amendments A1–A9), with `DshDesktopProductApi` and the
 * sub-bridge shapes specified by `docs/contracts/desktop-shell-features.md`.
 * One TypeScript type per Rust type; field names and wire form match the
 * contract exactly (Rust serde uses `rename_all = "camelCase"` on payload
 * structs and the adjacent `{"kind","detail"}` tagging on `DshError`).
 *
 * Naming rule (amendment A1): when upstream declares a type, this mirror keeps
 * upstream's name and exact shape; a port-specific composite gets a
 * port-specific name (`ShortcutBindingRow`, `ShortcutsChangedEvent`, …).
 *
 * Both language sides round-trip every canonical fixture in
 * `port/fixtures/protocol/*.json` byte-identically: `tests/protocol.spec.ts`
 * (TypeScript) and `port/src-tauri/crates/dsh-core/tests/protocol_fixtures.rs`
 * (Rust) run over the same files.
 */

/** Protocol generation reported by `shell_app_info`; the Desktop-Host lifecycle generation is also 4. */
export const PROTOCOL_GENERATION = 4 as const

/** Locale ids the welcome-window locale rule selects between (`apps/desktop/README.md`). */
export type LocaleCode = 'en' | 'zh'
/** Stored locale preference; `null` restores automatic selection. */
export type LocalePreference = LocaleCode | null
/** Origin of the effective locale. */
export type LocaleSource = 'preference' | 'os' | 'default'
/** Native theme preference backing the `nativeThemeSet` marker. */
export type ThemePreference = 'system' | 'light' | 'dark'

/** Closed union of application menu actions routed to the client page owner. */
export type MenuActionId =
  | 'about' | 'check_for_updates' | 'exit'
  | 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'delete' | 'select_all'
  | 'close_page_or_window' | 'reload_page' | 'restart_app_and_host' | 'toggle_devtools'
  | 'minimize' | 'hide' | 'hide_others' | 'show_all'
  | 'zoom_in' | 'zoom_out' | 'reset_zoom'

/**
 * Reference identifier of one OS-store credential entry (amendment A5): a
 * provider name plus its configured reference. Never a secret.
 */
export interface CredentialAddress {
  readonly provider: string
  readonly reference: string
}

/** `shell_app_info` response. `protocolGeneration` is {@link PROTOCOL_GENERATION}. */
export interface AppInfo {
  readonly productName: string
  readonly version: string
  readonly protocolGeneration: number
  readonly runtimeVersion: string
  readonly platform: string
  readonly arch: string
  readonly locale: LocaleCode
  /**
   * Official provider credential reference supplied at boot (amendment A5);
   * `null` means none is configured and onboarding reports no API key.
   */
  readonly credentialRef: CredentialAddress | null
}

/**
 * `shell_locale_get` / `shell_locale_set` / `shell_locale_apply` response and
 * `dsh://locale/changed` payload (amendment A9: `languages` is the OS language
 * order used for automatic selection).
 */
export interface LocaleState {
  readonly preference: LocalePreference
  readonly effective: LocaleCode
  readonly source: LocaleSource
  readonly languages: readonly string[]
}

/** `shell_locale_set` request. `null` writes no preference. */
export interface LocaleSetRequest {
  readonly preference: LocalePreference
}

/** `shell_locale_apply` request (amendment A4). Reports the active locale; persists nothing. */
export interface LocaleApplyRequest {
  readonly locale: LocaleCode
}

/** `shell_appearance` response and `dsh://appearance/changed` payload. */
export interface Appearance {
  readonly theme: ThemePreference
  readonly accent: string
  readonly captionHeightDip: number
  readonly reduceMotion: boolean
  readonly reduceTransparency: boolean
  readonly increaseContrast: boolean
}

/** `shell_window_set_fullscreen` request. */
export interface WindowSetFullscreenRequest {
  readonly enabled: boolean
}

/** `shell_theme_set` request. */
export interface ThemeSetRequest {
  readonly theme: ThemePreference
}

/** `shell_menu_action` request. */
export interface MenuActionRequest {
  readonly id: MenuActionId
}

/** `shell_open_external` request. Rust rejects non-`http`/`https`/`mailto` schemes. */
export interface OpenExternalRequest {
  readonly url: string
}

/** `shell_clipboard_write` request. */
export interface ClipboardWriteRequest {
  readonly text: string
}

/** `shell_clipboard_read` response. */
export interface ClipboardText {
  readonly text: string
}

/** `runtime_boot_failed` request. */
export interface BootFailedRequest {
  readonly message: string
}

/** Document region a rendered injection row lands in: after the opening head or body tag. */
export type IndexInjectionPlacement = 'head' | 'body'

/**
 * One structured index injection row — the upstream type from
 * `packages/host/webserver/src/injections.ts`, re-declared verbatim in Rust.
 * Rows execute strictly in table order, so a `global` row lands before the
 * scripts that read it.
 */
export type IndexInjection =
  /** Assign a JSON-serializable value to a `globalThis` property, ahead of later script rows. */
  | { readonly kind: 'global'; readonly name: string; readonly value: unknown }
  /** Inline classic script. `text` must not contain `</script`, which would close the element early. */
  | { readonly kind: 'script'; readonly placement: IndexInjectionPlacement; readonly text: string }
  /** External classic script, executed in table order. */
  | { readonly kind: 'script-src'; readonly placement: IndexInjectionPlacement; readonly src: string }
  /** Advisory preload for an external classic script; static workers may ignore it. */
  | { readonly kind: 'script-preload'; readonly src: string }
  /** A `<style>` element in the head. `text` must not contain `</style`, which would close the element early. */
  | { readonly kind: 'style'; readonly text: string }
  /** Raw markup fragment. */
  | { readonly kind: 'html'; readonly placement: IndexInjectionPlacement; readonly html: string }

/**
 * `runtime_boot_ready` response. Resolves when the host control channel has
 * reported `ready`; `injections` is the Host's `collectIndexInjections()`
 * output and `streamBaseUrl` is the Host origin.
 */
export interface BootPayload {
  readonly injections: readonly IndexInjection[]
  readonly streamBaseUrl: string
  readonly authenticatedUrl: string
}

/** Host runtime lifecycle states. */
export type RuntimeState = 'starting' | 'ready' | 'stopping' | 'stopped' | 'failed'

/** `runtime_status` / `runtime_restart` response and `dsh://runtime/state` payload. */
export interface RuntimeStatus {
  readonly state: RuntimeState
  readonly url: string | null
  readonly startedAt: string | null
  readonly lastError: string | null
}

/** `runtime_quit_inspection` response. Fails closed: an unavailable host reports `activeTasks: true`. */
export interface QuitInspection {
  readonly activeTasks: boolean
  readonly scheduledTasks: boolean
  readonly error: string | null
}

/** One settings value; the desktop-owned store is versioned and authoritative. */
export type SettingValue = string | number | boolean | null

/** `settings_list` response. */
export type SettingsMap = Record<string, SettingValue>

/** `settings_get` request. */
export interface SettingsGetRequest {
  readonly key: string
}

/** `settings_set` request. Atomic write. */
export interface SettingsSetRequest {
  readonly key: string
  readonly value: SettingValue
}

/** `settings_reset` request. */
export interface SettingsResetRequest {
  readonly key: string
}

/** `credential_has` / `credential_delete` request. */
export type CredentialLookupRequest = CredentialAddress

/** `credential_store` request. The secret never returns over any channel. */
export type CredentialStoreRequest = CredentialAddress & {
  readonly secret: string
}

/** `credential_list` response row — metadata only, never the secret value. */
export interface CredentialRef {
  readonly provider: string
  readonly reference: string
  readonly hasSecret: boolean
  /** RFC 3339 timestamp of the last write. */
  readonly updatedAt: string
}

/** `credential_has` response. */
export interface CredentialPresence {
  readonly present: boolean
}

/** `shell_pick_directory` request. `null` fields let the shell choose its defaults. */
export interface PickDirectoryRequest {
  readonly title: string | null
  readonly defaultPath: string | null
}

/** `shell_pick_directory` response. Cancellation returns `null` and stays retryable. */
export interface PickedDirectory {
  readonly path: string | null
}

/** Update phases of the main-owned updater (`DesktopUpdateState['phase']`, `apps/desktop/src/ipc.ts`). */
export type DesktopUpdatePhase =
  | 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'

/** Classified update failure copy selected by the Web locale (`apps/desktop/src/ipc.ts`). */
export type DesktopUpdateFailureKind =
  | 'check' | 'check-network'
  | 'download' | 'download-network'
  | 'install' | 'install-network'
  | 'stop-failed' | 'tasks-changed' | 'tasks-unavailable'

/**
 * `update_status` / `update_check` response and `dsh://update/state` payload —
 * the upstream `DesktopUpdatePresentation` from `apps/desktop/src/ipc.ts:63-68`
 * verbatim. Product documents cannot supply update versions, package URLs, or
 * installation authorization.
 */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdatePhase
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
}

// ---------------------------------------------------------------------------
// Shortcut protocol — upstream names and shapes verbatim (amendment A1).
// ---------------------------------------------------------------------------

/** Stable command identity owned by the registering feature (`Branded<'ShortcutCommandId'>` upstream). Distinct from {@link MenuActionId}: the `DesktopShortcutInput` `kind: 'menu'` arm carries K10 page commands under this id (amendment A10). */
export type ShortcutCommandId = string
/** Opaque accepted-state identity (`Branded<'ShortcutRevision'>` upstream). */
export type ShortcutRevision = string
/** Operating system of the device receiving input. */
export type ShortcutPlatform = 'macos' | 'windows' | 'linux'
/** Application shell selecting the default bindings. */
export type ShortcutRuntime = 'desktop' | 'web'
/** Runtime and operating system selecting one explicit default and preference profile. */
export type ShortcutProfile = `${ShortcutRuntime}:${ShortcutPlatform}`
/** Logical primary expands to Meta on macOS and Control elsewhere. */
export type ShortcutModifier = 'primary' | 'control' | 'alt' | 'shift' | 'meta'

/**
 * One or two distinct physical keys held together, plus an exact set of
 * modifiers — upstream `ShortcutBinding`
 * (`_upstream/packages/client/shortcuts/src/binding.ts:15-19`) verbatim, no
 * `id` (amendment A1). Used inside `ShortcutDefinition`, `ShortcutDocument`,
 * `ShortcutEdit`, `ShortcutConfigSnapshot`, `ShortcutSaveResult`.
 */
export interface ShortcutBinding {
  readonly code: string
  readonly secondCode?: string
  readonly modifiers: readonly ShortcutModifier[]
}

/**
 * Accepted effective binding row (port-specific composite, amendment A1): the
 * owning command id plus its `ShortcutBinding`. Carried by
 * `dsh://shortcuts/changed`.
 */
export type ShortcutBindingRow = { readonly id: ShortcutCommandId } & ShortcutBinding

/** Validation failures select localized copy in the UI (upstream `BindingIssue`). */
export type BindingIssue = 'reserved' | 'unsupported-browser' | 'modifier-required' | 'unsupported-key'

/** Overrides are platform-local; absent commands inherit defaults and null explicitly unbinds (upstream `ShortcutDocument`). */
export interface ShortcutDocument {
  readonly schemaVersion: 1 | 2
  readonly profiles: Readonly<Partial<Record<ShortcutProfile, Readonly<Record<string, ShortcutBinding | null>>>>>
}

/** Serializable command definitions accepted from the trusted product frame (upstream `ShortcutDefinition`). */
export interface ShortcutDefinition {
  readonly id: ShortcutCommandId
  readonly defaults: Readonly<Partial<Record<ShortcutProfile, ShortcutBinding>>>
  /** Fixed actions reserve one or more combinations instead of exposing an editable default. */
  readonly fixed?: readonly [ShortcutBinding, ...ShortcutBinding[]]
}

/** One revision-checked preference edit (upstream `ShortcutEdit`). */
export type ShortcutEdit =
  | { readonly type: 'set'; readonly id: ShortcutCommandId; readonly binding: ShortcutBinding | null }
  | { readonly type: 'reset'; readonly id: ShortcutCommandId }
  | { readonly type: 'reset-all' }

/** Read state retains the last accepted document on failure (upstream `ShortcutConfigSnapshot`). */
export interface ShortcutConfigSnapshot {
  readonly revision: ShortcutRevision
  /** Monotonic within one storage-owner lifetime; clients discard out-of-order replies. */
  readonly sequence: number
  readonly document: ShortcutDocument
  readonly status: 'loading' | 'ready' | 'unreadable'
  readonly error: 'read' | 'invalid' | 'future' | null
  readonly usingDefaults: boolean
}

/** Save failures never replace effective preferences (upstream `ShortcutSaveResult`). */
export interface ShortcutSaveResult {
  readonly status: 'saved' | 'stale' | 'unreadable' | 'write-failed' | 'not-ready' | 'conflict'
  readonly snapshot: ShortcutConfigSnapshot
  readonly issue?: BindingIssue
  readonly conflicts?: readonly ShortcutCommandId[]
}

/**
 * Trusted product-window input exchanged with the shell's top frame — upstream
 * `DesktopShortcutInput` (`_upstream/apps/desktop/src/preload-app.ts:18-36`)
 * verbatim (amendment A2). Native input carries the accepted configuration
 * identity; frame names identify the focused iframe or browser guest.
 */
export type DesktopShortcutInput = { readonly revision: ShortcutRevision } & (
  | { readonly kind: 'menu'; readonly commandId: ShortcutCommandId }
  | {
    readonly kind: 'keyboard' | 'iframe' | 'webview'
    readonly frameName: string
    readonly code: string
    readonly secondCode?: string
    readonly control: boolean
    readonly alt: boolean
    readonly shift: boolean
    readonly meta: boolean
    readonly repeat: boolean
  }
)

/** `shell_shortcuts_get` request. */
export interface ShortcutsGetRequest {
  readonly definitions: readonly ShortcutDefinition[]
}

/** `shell_shortcuts_edit` request. */
export interface ShortcutsEditRequest {
  readonly edit: ShortcutEdit
  readonly revision: ShortcutRevision
}

/** `shell_shortcuts_recording` request. */
export interface ShortcutsRecordingRequest {
  readonly active: boolean
}

/** `shell_close_window` request (amendment A9: carries the accepted configuration revision). */
export interface ShellCloseWindowRequest {
  readonly revision: ShortcutRevision
}

/** `shell_onboarding_set_active` request (amendment A9): onboarding visibility for the shell. */
export interface OnboardingSetActiveRequest {
  readonly active: boolean
}

// ---------------------------------------------------------------------------
// Event payloads (port-specific names per amendment A7).
// ---------------------------------------------------------------------------

/** `dsh://shortcuts/changed` payload. Backs `shortcutsChanged`. */
export interface ShortcutsChangedEvent {
  readonly bindings: readonly ShortcutBindingRow[]
}

/** `dsh://shortcuts/recording` payload. Backs `shortcutsRecording`. */
export interface ShortcutsRecordingEvent {
  readonly recording: boolean
}

/** Window presentation states of `dsh://shell/window`. */
export type ShellWindowState = 'shown' | 'hidden' | 'focused' | 'blurred'

/** `dsh://shell/window` payload. */
export interface ShellWindowEvent {
  readonly state: ShellWindowState
}

/** Terminal quit reasons of `dsh://shell/quit-confirmed`. */
export type QuitReason = 'user' | 'installer' | 'update' | 'fatal-recovery' | 'os-shutdown'

/** `dsh://shell/quit-confirmed` payload. */
export interface ShellQuitConfirmedEvent {
  readonly reason: QuitReason
}

// ---------------------------------------------------------------------------
// Error taxonomy.
// ---------------------------------------------------------------------------

/** `DshError::NotFound` detail. */
export interface DshErrorNotFoundDetail {
  readonly entity: string
  readonly id: string
}

/** `DshError::InvalidArgument` detail. */
export interface DshErrorInvalidArgumentDetail {
  readonly field: string
  readonly reason: string
}

/** `DshError::Io` detail. */
export interface DshErrorIoDetail {
  readonly operation: string
  readonly path: string | null
  readonly message: string
}

/** `DshError::RuntimeUnavailable` detail. */
export interface DshErrorRuntimeUnavailableDetail {
  readonly state: string
  readonly reason: string
}

/** `DshError::CredentialStore` detail. */
export interface DshErrorCredentialStoreDetail {
  readonly operation: string
  readonly message: string
}

/** `DshError::Timeout` detail. */
export interface DshErrorTimeoutDetail {
  readonly operation: string
  readonly millis: number
}

/** `DshError::Cancelled` detail. */
export interface DshErrorCancelledDetail {
  readonly operation: string
}

/** `DshError::Other` detail. `code` is a stable machine code. */
export interface DshErrorOtherDetail {
  readonly code: string
  readonly message: string
}

/**
 * The single error taxonomy, serialized as `{ "kind": ..., "detail": { ... } }`
 * (serde `tag = "kind", content = "detail", rename_all = "snake_case"`). The UI
 * renders `message`/`reason`/`operation` text verbatim; it never renders `code`
 * or `message` from `other` as the sole explanation of a known condition.
 */
export type DshError =
  | { readonly kind: 'not_found'; readonly detail: DshErrorNotFoundDetail }
  | { readonly kind: 'invalid_argument'; readonly detail: DshErrorInvalidArgumentDetail }
  | { readonly kind: 'io'; readonly detail: DshErrorIoDetail }
  | { readonly kind: 'runtime_unavailable'; readonly detail: DshErrorRuntimeUnavailableDetail }
  | { readonly kind: 'credential_store'; readonly detail: DshErrorCredentialStoreDetail }
  | { readonly kind: 'timeout'; readonly detail: DshErrorTimeoutDetail }
  | { readonly kind: 'cancelled'; readonly detail: DshErrorCancelledDetail }
  | { readonly kind: 'other'; readonly detail: DshErrorOtherDetail }

/** Discriminant values of {@link DshError}. */
export type DshErrorKind = DshError['kind']

// ---------------------------------------------------------------------------
// Command and event maps.
// ---------------------------------------------------------------------------

/**
 * Request/response pair of one command. `request: void` commands take no
 * arguments; the TypeScript mirror invokes them with the same snake_case
 * command string given here. Request payload fields travel as top-level invoke
 * arguments in the spelling below (Tauri maps them to snake_case Rust
 * parameters); response payloads and events use the contract field names
 * verbatim.
 */
export interface DshCommandMap {
  shell_app_info: { readonly request: void; readonly response: AppInfo }
  shell_locale_get: { readonly request: void; readonly response: LocaleState }
  shell_locale_set: { readonly request: LocaleSetRequest; readonly response: LocaleState }
  shell_locale_apply: { readonly request: LocaleApplyRequest; readonly response: LocaleState }
  shell_window_set_fullscreen: { readonly request: WindowSetFullscreenRequest; readonly response: void }
  shell_theme_set: { readonly request: ThemeSetRequest; readonly response: void }
  shell_appearance: { readonly request: void; readonly response: Appearance }
  shell_menu_action: { readonly request: MenuActionRequest; readonly response: void }
  shell_open_external: { readonly request: OpenExternalRequest; readonly response: void }
  shell_clipboard_write: { readonly request: ClipboardWriteRequest; readonly response: void }
  shell_clipboard_read: { readonly request: void; readonly response: ClipboardText }
  shell_quit_request: { readonly request: void; readonly response: void }
  shell_close_window: { readonly request: ShellCloseWindowRequest; readonly response: void }
  shell_onboarding_set_active: { readonly request: OnboardingSetActiveRequest; readonly response: void }
  shell_shortcuts_get: { readonly request: ShortcutsGetRequest; readonly response: ShortcutConfigSnapshot }
  shell_shortcuts_edit: { readonly request: ShortcutsEditRequest; readonly response: ShortcutSaveResult }
  shell_shortcuts_recording: { readonly request: ShortcutsRecordingRequest; readonly response: void }
  runtime_boot_ready: { readonly request: void; readonly response: BootPayload }
  runtime_boot_failed: { readonly request: BootFailedRequest; readonly response: void }
  runtime_status: { readonly request: void; readonly response: RuntimeStatus }
  runtime_restart: { readonly request: void; readonly response: RuntimeStatus }
  runtime_quit_inspection: { readonly request: void; readonly response: QuitInspection }
  settings_get: { readonly request: SettingsGetRequest; readonly response: SettingValue }
  settings_set: { readonly request: SettingsSetRequest; readonly response: void }
  settings_list: { readonly request: void; readonly response: SettingsMap }
  settings_reset: { readonly request: SettingsResetRequest; readonly response: void }
  credential_list: { readonly request: void; readonly response: readonly CredentialRef[] }
  credential_has: { readonly request: CredentialLookupRequest; readonly response: CredentialPresence }
  credential_store: { readonly request: CredentialStoreRequest; readonly response: void }
  credential_delete: { readonly request: CredentialLookupRequest; readonly response: void }
  shell_pick_directory: { readonly request: PickDirectoryRequest; readonly response: PickedDirectory }
  update_status: { readonly request: void; readonly response: DesktopUpdatePresentation }
  update_open: { readonly request: void; readonly response: void }
  update_check: { readonly request: void; readonly response: DesktopUpdatePresentation }
}

/** Every `#[tauri::command]` name in the contract. */
export type DshCommandName = keyof DshCommandMap

/** Event name to payload map for the Rust-`emit`ed `dsh://` events. */
export interface DshEventMap {
  'dsh://runtime/state': RuntimeStatus
  'dsh://locale/changed': LocaleState
  'dsh://appearance/changed': Appearance
  'dsh://shortcuts/changed': ShortcutsChangedEvent
  'dsh://shortcuts/recording': ShortcutsRecordingEvent
  'dsh://shortcuts/input': DesktopShortcutInput
  'dsh://update/state': DesktopUpdatePresentation
  'dsh://shell/window': ShellWindowEvent
  'dsh://shell/quit-confirmed': ShellQuitConfirmedEvent
}

/** Every `dsh://` event name in the contract. */
export type DshEventName = keyof DshEventMap
