/**
 * Typed desktop bridge over Tauri 2 `invoke` commands and `dsh://` events —
 * the TypeScript half of `docs/contracts/tauri-contract.md`. One wrapper per
 * command and one typed subscription per event; `desktop` is the typed facade.
 *
 * Outside the desktop shell every accessor degrades gracefully: `tryDesktop()`
 * returns `undefined` and every `desktop.*` method rejects with the typed
 * {@link NotDesktopError} (`kind: 'not_desktop'`), so the same bundle still
 * runs in a plain browser (the preserved client then takes its Web path).
 *
 * Transport: Tauri 2 exposes `globalThis.__TAURI_INTERNALS__` (or, with
 * `withGlobalTauri`, `globalThis.__TAURI__.core`) to the webview; this module
 * uses that channel directly instead of importing `@tauri-apps/api`, so the
 * preserved upstream client's dependency graph stays untouched. Events use the
 * Tauri 2 core event plugin (`plugin:event|listen` / `plugin:event|unlisten`)
 * with `transformCallback`-style callback ids, exactly as `@tauri-apps/api`
 * does internally.
 */
import type {
  AppInfo, Appearance, BootFailedRequest, BootPayload, ClipboardText, ClipboardWriteRequest,
  CredentialLookupRequest, CredentialPresence, CredentialRef, CredentialStoreRequest,
  DesktopUpdatePresentation, DshCommandMap, DshCommandName, DshError, DshEventMap, DshEventName,
  LocaleApplyRequest, LocaleSetRequest, LocaleState, MenuActionRequest, OnboardingSetActiveRequest,
  OpenExternalRequest, PickedDirectory, PickDirectoryRequest, QuitInspection, RuntimeStatus,
  SettingValue, SettingsGetRequest, SettingsMap, SettingsResetRequest, SettingsSetRequest,
  ShellCloseWindowRequest, ShortcutConfigSnapshot, ShortcutSaveResult, ShortcutsEditRequest,
  ShortcutsGetRequest, ShortcutsRecordingRequest, ThemeSetRequest, WindowSetFullscreenRequest,
} from './protocol.ts'

/** Disposer returned by every event subscription. */
export type Unlisten = () => void

/**
 * Envelope Tauri's `plugin:event|listen` callback receives for every emission
 * (the `Event<T>` of `@tauri-apps/api` v2): listeners below always receive the
 * unwrapped `payload`, never this envelope.
 */
export interface TauriEventEnvelope<T> {
  readonly event: string
  readonly id: number
  readonly payload: T
}

/** Typed `not_desktop` error: the bridge runs outside the Tauri shell. */
export class NotDesktopError extends Error {
  /** Stable machine discriminant shared with the Rust `DshError::Other` codes. */
  readonly kind = 'not_desktop' as const

  constructor() {
    super('dsh desktop bridge: not running inside the desktop shell')
    this.name = 'NotDesktopError'
  }
}

/** Callback registry entry of Tauri's `transformCallback` channel (delivers {@link TauriEventEnvelope}s). */
type TauriCallback = (envelope: never) => void

interface TauriInternals {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>
  transformCallback(callback: TauriCallback, once?: boolean): number
}

interface TauriGlobal {
  __TAURI_INTERNALS__?: TauriInternals
  __TAURI__?: { core?: { invoke?: TauriInternals['invoke'] } }
}

let callbackSequence = 0

/** Register `callback` under a Tauri callback id, mirroring `transformCallback`. */
function transformCallback(callback: TauriCallback): number {
  const internals = (globalThis as TauriGlobal).__TAURI_INTERNALS__
  if (internals?.transformCallback !== undefined) return internals.transformCallback(callback)
  callbackSequence += 1
  const id = callbackSequence
  ;(globalThis as unknown as Record<string, TauriCallback>)[`_${id}`] = callback
  return id
}

/** Resolve the raw Tauri invoke channel, or undefined outside the shell. */
function readInvoke(): TauriInternals['invoke'] | undefined {
  const globals = globalThis as TauriGlobal
  const internals = globals.__TAURI_INTERNALS__
  if (internals?.invoke !== undefined) return internals.invoke.bind(internals)
  const core = globals.__TAURI__?.core
  if (core?.invoke !== undefined) return core.invoke.bind(core)
  return undefined
}

/** Whether the bundle runs inside the Tauri desktop shell. */
export function isDesktop(): boolean {
  return readInvoke() !== undefined
}

/**
 * Invoke one contract command over the raw Tauri channel.
 * @param command - snake_case command name from {@link DshCommandMap}.
 * @param args - request payload fields as top-level invoke arguments (contract
 *   camelCase spelling); omit for `void` requests.
 * @returns the typed command response.
 * @throws {NotDesktopError} outside the desktop shell.
 */
export async function invokeCommand<K extends DshCommandName>(
  command: K,
  ...args: DshCommandMap[K]['request'] extends void ? [] : [request: DshCommandMap[K]['request'] & Record<string, unknown>]
): Promise<DshCommandMap[K]['response']> {
  const invoke = readInvoke()
  if (invoke === undefined) throw new NotDesktopError()
  return await invoke(command, args[0]) as DshCommandMap[K]['response']
}

/**
 * Subscribe to one `dsh://` event over the Tauri event plugin. Tauri invokes
 * the registered callback with the {@link TauriEventEnvelope} `{event, id,
 * payload}`; this wrapper unwraps `.payload`, so `listener` receives the
 * domain payload and field reads are never `undefined` through an envelope.
 * @param event - namespaced event name from {@link DshEventMap}.
 * @param listener - typed payload consumer.
 * @returns typed payload subscription; its disposer removes the listener.
 * @throws {NotDesktopError} outside the desktop shell.
 */
export async function listenEvent<K extends DshEventName>(
  event: K,
  listener: (payload: DshEventMap[K]) => void,
): Promise<Unlisten> {
  const invoke = readInvoke()
  if (invoke === undefined) throw new NotDesktopError()
  const handler: TauriCallback = (envelope: TauriEventEnvelope<DshEventMap[K]>): void => { listener(envelope.payload) }
  const eventId = await invoke('plugin:event|listen', {
    event,
    target: { kind: 'Any' },
    handler: transformCallback(handler),
    once: false,
  }) as number
  return () => {
    void invoke('plugin:event|unlisten', { event, eventId }).catch(() => undefined)
  }
}

/**
 * Narrow an unknown rejection to the contract error taxonomy.
 * @param reason - rejected value from a `desktop.*` call.
 * @returns the `DshError` payload, or undefined when the value is not one.
 */
export function asDshError(reason: unknown): DshError | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined
  const candidate = reason as { kind?: unknown; detail?: unknown }
  if (typeof candidate.kind !== 'string' || typeof candidate.detail !== 'object' || candidate.detail === null) return undefined
  return reason as DshError
}

/**
 * Typed facade: one wrapper per contract command and one subscription per
 * contract event. Every method throws {@link NotDesktopError} outside the shell.
 */
export interface DshDesktopApi {
  readonly available: boolean
  /** `shell_app_info` */
  shellAppInfo(): Promise<AppInfo>
  /** `shell_locale_get` */
  shellLocaleGet(): Promise<LocaleState>
  /** `shell_locale_set` */
  shellLocaleSet(request: LocaleSetRequest): Promise<LocaleState>
  /** `shell_locale_apply` (amendment A4: reports the active locale, persists nothing). */
  shellLocaleApply(request: LocaleApplyRequest): Promise<LocaleState>
  /** `shell_window_set_fullscreen` */
  shellWindowSetFullscreen(request: WindowSetFullscreenRequest): Promise<void>
  /** `shell_theme_set` */
  shellThemeSet(request: ThemeSetRequest): Promise<void>
  /** `shell_appearance` */
  shellAppearance(): Promise<Appearance>
  /** `shell_menu_action` */
  shellMenuAction(request: MenuActionRequest): Promise<void>
  /** `shell_open_external` */
  shellOpenExternal(request: OpenExternalRequest): Promise<void>
  /** `shell_clipboard_write` */
  shellClipboardWrite(request: ClipboardWriteRequest): Promise<void>
  /** `shell_clipboard_read` */
  shellClipboardRead(): Promise<ClipboardText>
  /** `shell_quit_request` */
  shellQuitRequest(): Promise<void>
  /** `shell_close_window` (amendment A9: carries the accepted configuration revision). */
  shellCloseWindow(request: ShellCloseWindowRequest): Promise<void>
  /** `shell_onboarding_set_active` (amendment A9). */
  shellOnboardingSetActive(request: OnboardingSetActiveRequest): Promise<void>
  /** `shell_shortcuts_get` */
  shellShortcutsGet(request: ShortcutsGetRequest): Promise<ShortcutConfigSnapshot>
  /** `shell_shortcuts_edit` */
  shellShortcutsEdit(request: ShortcutsEditRequest): Promise<ShortcutSaveResult>
  /** `shell_shortcuts_recording` */
  shellShortcutsRecording(request: ShortcutsRecordingRequest): Promise<void>
  /** `runtime_boot_ready` */
  runtimeBootReady(): Promise<BootPayload>
  /** `runtime_boot_failed` */
  runtimeBootFailed(request: BootFailedRequest): Promise<void>
  /** `runtime_status` */
  runtimeStatus(): Promise<RuntimeStatus>
  /** `runtime_restart` */
  runtimeRestart(): Promise<RuntimeStatus>
  /** `runtime_quit_inspection` */
  runtimeQuitInspection(): Promise<QuitInspection>
  /** `settings_get` */
  settingsGet(request: SettingsGetRequest): Promise<SettingValue>
  /** `settings_set` */
  settingsSet(request: SettingsSetRequest): Promise<void>
  /** `settings_list` */
  settingsList(): Promise<SettingsMap>
  /** `settings_reset` */
  settingsReset(request: SettingsResetRequest): Promise<void>
  /** `credential_list` */
  credentialList(): Promise<readonly CredentialRef[]>
  /** `credential_has` */
  credentialHas(request: CredentialLookupRequest): Promise<CredentialPresence>
  /** `credential_store` */
  credentialStore(request: CredentialStoreRequest): Promise<void>
  /** `credential_delete` */
  credentialDelete(request: CredentialLookupRequest): Promise<void>
  /** `shell_pick_directory` */
  shellPickDirectory(request: PickDirectoryRequest): Promise<PickedDirectory>
  /** `update_status` */
  updateStatus(): Promise<DesktopUpdatePresentation>
  /** `update_open` */
  updateOpen(): Promise<void>
  /** `update_check` */
  updateCheck(): Promise<DesktopUpdatePresentation>
  /** Subscribe to `dsh://runtime/state`. */
  onRuntimeState(listener: (payload: RuntimeStatus) => void): Promise<Unlisten>
  /** Subscribe to `dsh://locale/changed`. */
  onLocaleChanged(listener: (payload: LocaleState) => void): Promise<Unlisten>
  /** Subscribe to `dsh://appearance/changed`. */
  onAppearanceChanged(listener: (payload: Appearance) => void): Promise<Unlisten>
  /** Subscribe to `dsh://shortcuts/changed`. */
  onShortcutsChanged(listener: (payload: DshEventMap['dsh://shortcuts/changed']) => void): Promise<Unlisten>
  /** Subscribe to `dsh://shortcuts/recording`. */
  onShortcutsRecording(listener: (payload: DshEventMap['dsh://shortcuts/recording']) => void): Promise<Unlisten>
  /** Subscribe to `dsh://shortcuts/input` (upstream `DesktopShortcutInput` verbatim, incl. its `kind: 'menu'` arm for K10 page commands; amendments A2/A10). */
  onShortcutsInput(listener: (payload: DshEventMap['dsh://shortcuts/input']) => void): Promise<Unlisten>
  /** Subscribe to `dsh://update/state`. */
  onUpdateState(listener: (payload: DesktopUpdatePresentation) => void): Promise<Unlisten>
  /** Subscribe to `dsh://shell/window`. */
  onShellWindow(listener: (payload: DshEventMap['dsh://shell/window']) => void): Promise<Unlisten>
  /** Subscribe to `dsh://shell/quit-confirmed`. */
  onShellQuitConfirmed(listener: (payload: DshEventMap['dsh://shell/quit-confirmed']) => void): Promise<Unlisten>
}

/**
 * Build the typed facade over one raw invoke channel.
 * @param invoke - raw Tauri invoke, or undefined outside the shell (all calls
 *   then throw {@link NotDesktopError}).
 * @returns the typed desktop facade.
 */
function createDesktopApi(invoke: TauriInternals['invoke'] | undefined): DshDesktopApi {
  const call = async <T>(command: DshCommandName, request?: Record<string, unknown>): Promise<T> => {
    if (invoke === undefined) throw new NotDesktopError()
    return await invoke(command, request) as T
  }
  const on = <K extends DshEventName>(event: K, listener: (payload: DshEventMap[K]) => void): Promise<Unlisten> =>
    listenEvent(event, listener)
  return {
    available: invoke !== undefined,
    shellAppInfo: () => call<AppInfo>('shell_app_info'),
    shellLocaleGet: () => call<LocaleState>('shell_locale_get'),
    shellLocaleSet: request => call<LocaleState>('shell_locale_set', { ...request }),
    shellLocaleApply: request => call<LocaleState>('shell_locale_apply', { ...request }),
    shellWindowSetFullscreen: request => call<void>('shell_window_set_fullscreen', { ...request }),
    shellThemeSet: request => call<void>('shell_theme_set', { ...request }),
    shellAppearance: () => call<Appearance>('shell_appearance'),
    shellMenuAction: request => call<void>('shell_menu_action', { ...request }),
    shellOpenExternal: request => call<void>('shell_open_external', { ...request }),
    shellClipboardWrite: request => call<void>('shell_clipboard_write', { ...request }),
    shellClipboardRead: () => call<ClipboardText>('shell_clipboard_read'),
    shellQuitRequest: () => call<void>('shell_quit_request'),
    shellCloseWindow: request => call<void>('shell_close_window', { ...request }),
    shellOnboardingSetActive: request => call<void>('shell_onboarding_set_active', { ...request }),
    shellShortcutsGet: request => call<ShortcutConfigSnapshot>('shell_shortcuts_get', { ...request }),
    shellShortcutsEdit: request => call<ShortcutSaveResult>('shell_shortcuts_edit', { ...request }),
    shellShortcutsRecording: request => call<void>('shell_shortcuts_recording', { ...request }),
    runtimeBootReady: () => call<BootPayload>('runtime_boot_ready'),
    runtimeBootFailed: request => call<void>('runtime_boot_failed', { ...request }),
    runtimeStatus: () => call<RuntimeStatus>('runtime_status'),
    runtimeRestart: () => call<RuntimeStatus>('runtime_restart'),
    runtimeQuitInspection: () => call<QuitInspection>('runtime_quit_inspection'),
    settingsGet: request => call<SettingValue>('settings_get', { ...request }),
    settingsSet: request => call<void>('settings_set', { ...request }),
    settingsList: () => call<SettingsMap>('settings_list'),
    settingsReset: request => call<void>('settings_reset', { ...request }),
    credentialList: () => call<readonly CredentialRef[]>('credential_list'),
    credentialHas: request => call<CredentialPresence>('credential_has', { ...request }),
    credentialStore: request => call<void>('credential_store', { ...request }),
    credentialDelete: request => call<void>('credential_delete', { ...request }),
    shellPickDirectory: request => call<PickedDirectory>('shell_pick_directory', { ...request }),
    updateStatus: () => call<DesktopUpdatePresentation>('update_status'),
    updateOpen: () => call<void>('update_open'),
    updateCheck: () => call<DesktopUpdatePresentation>('update_check'),
    onRuntimeState: listener => on('dsh://runtime/state', listener),
    onLocaleChanged: listener => on('dsh://locale/changed', listener),
    onAppearanceChanged: listener => on('dsh://appearance/changed', listener),
    onShortcutsChanged: listener => on('dsh://shortcuts/changed', listener),
    onShortcutsRecording: listener => on('dsh://shortcuts/recording', listener),
    onShortcutsInput: listener => on('dsh://shortcuts/input', listener),
    onUpdateState: listener => on('dsh://update/state', listener),
    onShellWindow: listener => on('dsh://shell/window', listener),
    onShellQuitConfirmed: listener => on('dsh://shell/quit-confirmed', listener),
  }
}

/** The typed desktop facade; every call throws {@link NotDesktopError} outside the shell. */
export const desktop: DshDesktopApi = createDesktopApi(readInvoke())

/**
 * Graceful accessor for callers that support Web mode.
 * @returns the typed facade inside the desktop shell, otherwise undefined.
 */
export function tryDesktop(): DshDesktopApi | undefined {
  return isDesktop() ? desktop : undefined
}
