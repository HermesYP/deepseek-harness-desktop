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

/** Windows caption controls the shell dispatches (`shell_window_chrome_action`). */
export type WindowChromeAction = 'drag' | 'minimize' | 'maximize' | 'close'

/** `shell_window_chrome_action` request. */
export interface WindowChromeActionRequest {
  readonly action: WindowChromeAction
}

/**
 * Resize directions of `shell_window_resize_dragging` — the variant names of
 * `tauri_runtime::ResizeDirection`, which carries no serde rename, so the
 * frameless grip layer sends (and Rust accepts) exactly this spelling.
 */
export type WindowResizeDirection =
  | 'East' | 'North' | 'NorthEast' | 'NorthWest'
  | 'South' | 'SouthEast' | 'SouthWest' | 'West'

/** `shell_window_resize_dragging` request. */
export interface WindowResizeDraggingRequest {
  readonly direction: WindowResizeDirection
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

/**
 * `dsh://shell/window-error` payload: why one window presentation request was
 * refused or failed, as the serialized {@link DshError} taxonomy.
 *
 * The failure is a separate channel from {@link ShellWindowEvent} on purpose:
 * it never changes the presentation state, so a consumer keeps the last
 * observed `ShellWindowState` (a refused hide is not a hide). The shell emits
 * it when it cannot honour the request — for example a policy denial or a
 * native hide failure.
 */
export type ShellWindowErrorEvent = DshError

/** Terminal quit reasons of `dsh://shell/quit-confirmed`. */
export type QuitReason = 'user' | 'installer' | 'update' | 'fatal-recovery' | 'os-shutdown'

/** `dsh://shell/quit-confirmed` payload. */
export interface ShellQuitConfirmedEvent {
  readonly reason: QuitReason
}

/** `dsh://update/state` payload. Backs `updatesPresentation`. */
export type DesktopUpdatePresentationEvent = DesktopUpdatePresentation

// ---------------------------------------------------------------------------
// Native guests, native file paths, caption menus and renderer diagnostics.
//
// These are the port's typed additions to the wire vocabulary. Each one names a
// `#[tauri::command]` or an emitted event that exists in the Rust application
// crate today, so the TypeScript mirror and the shell agree on one spelling:
//
//   * guest commands/events   `port/src-tauri/app/src/guests/{commands,mod}.rs`
//   * native file paths       `port/src-tauri/app/src/native_paths.rs` +
//                             `commands.rs` (`shell_host_paths*`)
//   * caption menus           `port/src-tauri/app/src/menu_action.rs` +
//                             `commands.rs` (`shell_caption_menu`)
//   * renderer console        `port/src-tauri/app/src/renderer_bridge.rs`
//
// Naming follows the same rule as the rest of this file: a type upstream
// declares keeps upstream's name (`DesktopBrowserReservation`,
// `DesktopBrowserOpenRequest`); a port-specific addition gets a port-specific
// name.
// ---------------------------------------------------------------------------

/** One guest's approved, process-local storage partition (upstream `DesktopBrowserReservation`). */
export interface BrowserReservation {
  /** Opaque main-issued lease; also the guest child view's label. */
  readonly lease: string
  /** Approved storage partition derived from the workspace identity. */
  readonly partition: string
}

/** Rectangle in CSS pixels, as the renderer measures it (`guests::geometry::GuestBounds`). */
export interface GuestBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** `guest_browser_acquire` request. */
export interface BrowserAcquireRequest {
  /** Resolved workspace storage identity (`cwd:<path>` or `session:<id>`). */
  readonly workspace: string
  /** Initial rectangle; a zero extent hides the guest until the presentation places it. */
  readonly bounds: GuestBounds
}

/** `guest_browser_release` / `guest_browser_state` request. */
export interface BrowserLeaseRequest {
  readonly lease: string
}

/** `guest_browser_set_bounds` request. */
export interface BrowserBoundsRequest {
  readonly lease: string
  readonly bounds: GuestBounds
}

/** `guest_browser_navigate` request. The address is re-validated by the shell. */
export interface BrowserNavigateRequest {
  readonly lease: string
  readonly url: string
}

/** Navigation verbs one existing guest accepts (`guests::registry::command_browser`). */
export type GuestNavigationCommand = 'back' | 'forward' | 'reload' | 'clear-history'

/** `guest_browser_command` request. */
export interface BrowserCommandRequest {
  readonly lease: string
  readonly command: GuestNavigationCommand
}

/** Main-frame load failure of a guest document (`guests::GuestBrowserFailure`). */
export interface GuestBrowserFailure {
  /** Chromium/WebView2 error code. */
  readonly code: number
  /** Human-readable description. */
  readonly description: string
}

/**
 * One browser guest's observed document state (`guests::GuestBrowserState`).
 *
 * Every field is a native observation; nothing is inferred from what the client
 * asked for, and no credential or injected header is part of the payload. It is
 * both the `guest_browser_state` response and the
 * `dsh://guests/browser-state` payload.
 */
export interface GuestBrowserState {
  /** The guest's reservation. */
  readonly lease: string
  /** Current document address, or `''` before the first commit. */
  readonly url: string
  /** Current document title. */
  readonly title: string
  /** Whether the guest is loading. */
  readonly loading: boolean
  /** Whether a backward history entry exists. */
  readonly canGoBack: boolean
  /** Whether a forward history entry exists. */
  readonly canGoForward: boolean
  /** Whether the guest lost its document. */
  readonly gone: boolean
  /** Main-frame load failure for the current document, when the shell reported one. */
  readonly error: GuestBrowserFailure | null
}

/** Destinations the embedded Platform document supports (`platform-pages.ts`). */
export type PlatformPage = 'usage' | 'top-up'

/** `guest_platform_open` request (upstream `dshPlatform.open`). */
export interface PlatformOpenRequest {
  readonly page: PlatformPage
  readonly bounds: GuestBounds
}

/** `guest_platform_set_bounds` request. */
export interface GuestBoundsRequest {
  readonly bounds: GuestBounds
}

/**
 * `dsh://guests/browser-open` payload (`guests::BrowserOpenRequest`): an approved
 * `window.open` inside a guest, routed to that lease's one listener.
 */
export interface BrowserOpenRequestEvent {
  /** The guest whose document requested the popup. */
  readonly lease: string
  /** Validated `http`/`https` URL the client opens in a new Browser tab. */
  readonly url: string
}

/**
 * `shell_host_paths` response (`native_paths::HostPaths`).
 *
 * The shell adopts the absolute paths of one native OS drop; the page reads this
 * batch once (guarded by `consumed`) and pairs each path with the `File` the
 * browser produced for that drop. The command returns what the shell actually
 * observed and never a synthesised path.
 */
export interface HostPaths {
  /** Absolute paths adopted from the most recent native drop, in drop order. */
  readonly paths: readonly string[]
  /** Whether the page already imported this batch. */
  readonly consumed: boolean
}

/** Names of the two Windows caption menus the shell can pop (`menu_action::caption_items`). */
export type CaptionMenuName = 'application' | 'edit'

/**
 * `shell_caption_menu` request: one caption menu anchored at a client point.
 * `x`/`y` are CSS pixels measured from the button's `getBoundingClientRect()`.
 */
export interface CaptionMenuRequest {
  readonly name: CaptionMenuName
  readonly x: number
  readonly y: number
}

/**
 * `shell_caption_palette` request: the renderer's positional
 * `[language, fill, symbol]` measurement (`chrome::CaptionPalette::from_json`
 * accepts exactly three strings), sent by the shell's own caption probe.
 */
export interface CaptionPaletteRequest {
  readonly palette: readonly [string, string, string]
}

/**
 * One batched renderer console line (`renderer_bridge::ConsoleEntry`).
 *
 * Reporting is bounded by the shell: at most 32 entries, a source id of at most
 * 4096 characters and a message of at most 32768 characters. The batch is a
 * diagnostic, so the shell refuses an oversized one rather than truncating it.
 */
export interface RendererConsoleEntry {
  /** Where the line came from; the shell keeps at most its origin, never a boot URL with a query. */
  readonly sourceId: string
  /** Source line number. */
  readonly line: number
  /** Already-clipped message text. */
  readonly message: string
}

/** `shell_renderer_console` request. */
export interface RendererConsoleRequest {
  readonly lines: readonly RendererConsoleEntry[]
}

/**
 * `policy_presented` request: the isolated mandatory-policy surface
 * (`policy-surface` permission set) acknowledges the decision sequence it is
 * showing, so the shell can record that the presentation was seen.
 */
export interface PolicyPresentedRequest {
  readonly sequence: number
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
 *
 * One exception, recorded here because it is the easiest thing to get wrong:
 * the commands in {@link DshRequestCommandName} declare a SINGLE
 * `request: <Struct>` parameter, so their payload travels nested under
 * `request`. The `shell_*`, `settings_*`, `credential_*`, `runtime_*` and
 * `update_*` commands declare flat parameters and are invoked flat, and
 * `guest_platform_close`/`guest_platform_status` declare none at all.
 */
export interface DshCommandMap {
  shell_app_info: { readonly request: void; readonly response: AppInfo }
  shell_locale_get: { readonly request: void; readonly response: LocaleState }
  shell_locale_set: { readonly request: LocaleSetRequest; readonly response: LocaleState }
  shell_locale_apply: { readonly request: LocaleApplyRequest; readonly response: LocaleState }
  shell_window_set_fullscreen: { readonly request: WindowSetFullscreenRequest; readonly response: void }
  /** Windows caption control (`drag`/`minimize`/`maximize`/`close`). */
  shell_window_chrome_action: { readonly request: WindowChromeActionRequest; readonly response: void }
  /** Frameless resize grip; the direction is `tauri_runtime::ResizeDirection`'s variant name. */
  shell_window_resize_dragging: { readonly request: WindowResizeDraggingRequest; readonly response: void }
  /** Toggle WebView developer tools (Windows F12 accelerator). */
  shell_window_toggle_devtools: { readonly request: void; readonly response: void }
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
  guest_browser_acquire: { readonly request: BrowserAcquireRequest; readonly response: BrowserReservation }
  guest_browser_release: { readonly request: BrowserLeaseRequest; readonly response: void }
  guest_browser_set_bounds: { readonly request: BrowserBoundsRequest; readonly response: void }
  guest_browser_navigate: { readonly request: BrowserNavigateRequest; readonly response: void }
  guest_browser_command: { readonly request: BrowserCommandRequest; readonly response: void }
  guest_browser_state: { readonly request: BrowserLeaseRequest; readonly response: GuestBrowserState }
  guest_platform_open: { readonly request: PlatformOpenRequest; readonly response: void }
  guest_platform_set_bounds: { readonly request: GuestBoundsRequest; readonly response: void }
  guest_platform_close: { readonly request: void; readonly response: void }
  /** Port extension beyond the reference's `PlatformBridge`: whether a Platform document is live. */
  guest_platform_status: { readonly request: void; readonly response: boolean }
  shell_host_paths: { readonly request: void; readonly response: HostPaths }
  shell_host_paths_consume: { readonly request: void; readonly response: void }
  /** Windows caption menus (`application`/`edit`). */
  shell_caption_menu: { readonly request: CaptionMenuRequest; readonly response: void }
  /** Caption palette measurement reported by the shell's own caption probe. */
  shell_caption_palette: { readonly request: CaptionPaletteRequest; readonly response: void }
  /** Mandatory-policy presentation acknowledgement; the isolated policy surface's commands. */
  policy_presented: { readonly request: PolicyPresentedRequest; readonly response: void }
  /** Retry the mandatory-policy check. */
  policy_retry: { readonly request: void; readonly response: void }
  /** Re-run the authoritative mandatory update. */
  policy_update: { readonly request: void; readonly response: void }
  /** Quit from the policy surface. */
  policy_quit: { readonly request: void; readonly response: void }
  /** Bounded main-renderer console batch. Installed by the shell's own initialization script. */
  shell_renderer_console: { readonly request: RendererConsoleRequest; readonly response: void }
}

/** Every `#[tauri::command]` name in the contract. */
export type DshCommandName = keyof DshCommandMap

/**
 * Commands whose Rust signature declares exactly ONE `request: <Struct>`
 * parameter, so the payload travels nested under `request`.
 *
 * Every other command declares flat parameters (or none) and is invoked
 * directly. `guest_platform_close` and `guest_platform_status` take no request
 * struct, so they are NOT members here. This list is the single home of that
 * wire fact: `index.ts`'s `invokeRequestCommand` keys off it and `guests.ts`
 * invokes through it.
 */
export type DshRequestCommandName =
  | 'guest_browser_acquire' | 'guest_browser_release' | 'guest_browser_set_bounds'
  | 'guest_browser_navigate' | 'guest_browser_command' | 'guest_browser_state'
  | 'guest_platform_open' | 'guest_platform_set_bounds'

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
  /**
   * One refused or failed window presentation request. Separate from
   * `dsh://shell/window` so a failure never fabricates a presentation state.
   */
  'dsh://shell/window-error': ShellWindowErrorEvent
  'dsh://shell/quit-confirmed': ShellQuitConfirmedEvent
  /** Approved guest popup, routed to the listener registered for that lease. */
  'dsh://guests/browser-open': BrowserOpenRequestEvent
  /** One guest's observed document state; drives the native element's DOM events. */
  'dsh://guests/browser-state': GuestBrowserState
}

/** Every `dsh://` event name in the contract. */
export type DshEventName = keyof DshEventMap
