/**
 * Lockstep test: the TypeScript mirror round-trips EVERY canonical fixture in
 * `port/fixtures/protocol/*.json` (the same files
 * `port/src-tauri/crates/dsh-core/tests/protocol_fixtures.rs` round-trips),
 * byte-identically. A fixture file without a registered contract type fails
 * loudly (amendment A7: no exclusions), and the coverage suite asserts that
 * every command response, every event payload, and every `DshError` variant has
 * fixture coverage. Compile-time lockstep: the typed samples and the
 * `Record<...>` maps below fail `tsc` when a mirror type drifts.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type {
  AppInfo, Appearance, BindingIssue, BootFailedRequest, BootPayload, BrowserAcquireRequest,
  BrowserBoundsRequest, BrowserCommandRequest, BrowserNavigateRequest, BrowserOpenRequestEvent,
  BrowserReservation, CaptionMenuRequest, ClipboardText, ClipboardWriteRequest,
  CredentialAddress, CredentialPresence, CredentialRef, CredentialStoreRequest, DesktopShortcutInput,
  DesktopUpdateFailureKind, DesktopUpdatePhase, DesktopUpdatePresentation, DshCommandName, DshError,
  DshErrorKind, DshEventName, GuestBrowserFailure, GuestBrowserState, GuestBounds, HostPaths,
  IndexInjection, IndexInjectionPlacement, LocaleApplyRequest, LocaleCode,
  LocaleSetRequest, LocaleState, LocaleSource, MenuActionId, MenuActionRequest, OpenExternalRequest,
  PickedDirectory, PickDirectoryRequest, PlatformOpenRequest, QuitInspection, QuitReason,
  RendererConsoleEntry, RuntimeState, RuntimeStatus,
  SettingValue, SettingsGetRequest, SettingsMap, SettingsResetRequest, SettingsSetRequest, ShellWindowState,
  ShellWindowEvent, ShellQuitConfirmedEvent, ShellCloseWindowRequest, OnboardingSetActiveRequest,
  ShortcutBinding, ShortcutBindingRow, ShortcutConfigSnapshot,
  ShortcutDocument, ShortcutEdit, ShortcutDefinition, ShortcutModifier, ShortcutProfile, ShortcutSaveResult,
  ShortcutsChangedEvent, ShortcutsEditRequest, ShortcutsGetRequest,
  ShortcutsRecordingEvent, ShortcutsRecordingRequest, ThemePreference, ThemeSetRequest,
  WindowSetFullscreenRequest,
} from '../protocol.ts'

const FIXTURE_DIR = fileURLToPath(new URL('../../../fixtures/protocol/', import.meta.url))

// ---------------------------------------------------------------------------
// Exhaustive validators: each returns the value typed as its contract type.
// ---------------------------------------------------------------------------

type Guard<T> = (value: unknown, path: string) => T

function fail(path: string, message: string): never {
  throw new TypeError(`fixture ${path}: ${message}`)
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(path, 'expected an object')
  return value as Record<string, unknown>
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') return fail(path, 'expected a string')
  return value
}

function asNumber(value: unknown, path: string): number {
  if (typeof value !== 'number') return fail(path, 'expected a number')
  return value
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') return fail(path, 'expected a boolean')
  return value
}

function exactKeys(value: Record<string, unknown>, path: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return fail(path, `unknown field ${JSON.stringify(key)}`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) return fail(path, `missing field ${JSON.stringify(key)}`)
  }
}

function field<T>(o: Record<string, unknown>, key: string, path: string, guard: Guard<T>): T {
  return guard(o[key], `${path}.${key}`)
}

function optionalField<T>(o: Record<string, unknown>, key: string, path: string, guard: Guard<T>): T | undefined {
  return Object.hasOwn(o, key) ? guard(o[key], `${path}.${key}`) : undefined
}

function nullable<T>(guard: Guard<T>): Guard<T | null> {
  return (value, path) => (value === null ? null : guard(value, path))
}

function enumOf<const Values extends readonly string[]>(values: Values): Guard<Values[number]> {
  return (value, path) => {
    const text = asString(value, path)
    if (!(values as readonly string[]).includes(text)) return fail(path, `not one of ${values.join(', ')}`)
    return text as Values[number]
  }
}

function listOf<T>(guard: Guard<T>): Guard<T[]> {
  return (value, path) => {
    if (!Array.isArray(value)) return fail(path, 'expected an array')
    return value.map((item, index) => guard(item, `${path}[${index}]`))
  }
}

function recordOf<T>(guard: Guard<T>): Guard<Record<string, T>> {
  return (value, path) => {
    const o = asRecord(value, path)
    for (const key of Object.keys(o)) o[key] = guard(o[key], `${path}.${key}`)
    return o as Record<string, T>
  }
}

const localeCode: Guard<LocaleCode> = enumOf(['en', 'zh'])
const localeSource: Guard<LocaleSource> = enumOf(['preference', 'os', 'default'])
const themePreference: Guard<ThemePreference> = enumOf(['system', 'light', 'dark'])
const menuActionId: Guard<MenuActionId> = enumOf([
  'about', 'check_for_updates', 'exit', 'undo', 'redo', 'cut', 'copy', 'paste', 'delete', 'select_all',
  'close_page_or_window', 'reload_page', 'restart_app_and_host', 'toggle_devtools', 'minimize', 'hide',
  'hide_others', 'show_all', 'zoom_in', 'zoom_out', 'reset_zoom',
])
const runtimeState: Guard<RuntimeState> = enumOf(['starting', 'ready', 'stopping', 'stopped', 'failed'])
const desktopUpdatePhase: Guard<DesktopUpdatePhase> = enumOf([
  'idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'ready', 'error',
])
const desktopUpdateFailureKind: Guard<DesktopUpdateFailureKind> = enumOf([
  'check', 'check-network', 'download', 'download-network', 'install', 'install-network',
  'stop-failed', 'tasks-changed', 'tasks-unavailable',
])
const shortcutModifier: Guard<ShortcutModifier> = enumOf(['primary', 'control', 'alt', 'shift', 'meta'])
const bindingIssue: Guard<BindingIssue> = enumOf(['reserved', 'unsupported-browser', 'modifier-required', 'unsupported-key'])
const shellWindowState: Guard<ShellWindowState> = enumOf(['shown', 'hidden', 'focused', 'blurred'])
const quitReason: Guard<QuitReason> = enumOf(['user', 'installer', 'update', 'fatal-recovery', 'os-shutdown'])
const indexInjectionPlacement: Guard<IndexInjectionPlacement> = enumOf(['head', 'body'])
const settingValue: Guard<SettingValue> = (value, path) => {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value
  return fail(path, 'expected string | number | boolean | null')
}

const credentialAddress: Guard<CredentialAddress> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['provider', 'reference'])
  return value as CredentialAddress
}

const appInfo: Guard<AppInfo> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['productName', 'version', 'protocolGeneration', 'runtimeVersion', 'platform', 'arch', 'locale', 'credentialRef'])
  field(o, 'productName', path, asString)
  field(o, 'version', path, asString)
  const generation = field(o, 'protocolGeneration', path, asNumber)
  if (generation !== 4) return fail(path, 'protocolGeneration must be 4')
  field(o, 'runtimeVersion', path, asString)
  field(o, 'platform', path, asString)
  field(o, 'arch', path, asString)
  field(o, 'locale', path, localeCode)
  field(o, 'credentialRef', path, nullable(credentialAddress))
  return value as AppInfo
}

const localeState: Guard<LocaleState> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['preference', 'effective', 'source', 'languages'])
  field(o, 'preference', path, nullable(localeCode))
  field(o, 'effective', path, localeCode)
  field(o, 'source', path, localeSource)
  field(o, 'languages', path, listOf(asString))
  return value as LocaleState
}

const appearance: Guard<Appearance> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['theme', 'accent', 'captionHeightDip', 'reduceMotion', 'reduceTransparency', 'increaseContrast'])
  field(o, 'theme', path, themePreference)
  field(o, 'accent', path, asString)
  field(o, 'captionHeightDip', path, asNumber)
  field(o, 'reduceMotion', path, asBoolean)
  field(o, 'reduceTransparency', path, asBoolean)
  field(o, 'increaseContrast', path, asBoolean)
  return value as Appearance
}

const indexInjection: Guard<IndexInjection> = (value, path) => {
  const o = asRecord(value, path)
  switch (asString(o.kind, `${path}.kind`)) {
    case 'global':
      exactKeys(o, path, ['kind', 'name', 'value'])
      field(o, 'name', path, asString)
      break
    case 'script':
      exactKeys(o, path, ['kind', 'placement', 'text'])
      field(o, 'placement', path, indexInjectionPlacement)
      field(o, 'text', path, asString)
      break
    case 'script-src':
      exactKeys(o, path, ['kind', 'placement', 'src'])
      field(o, 'placement', path, indexInjectionPlacement)
      field(o, 'src', path, asString)
      break
    case 'script-preload':
      exactKeys(o, path, ['kind', 'src'])
      field(o, 'src', path, asString)
      break
    case 'style':
      exactKeys(o, path, ['kind', 'text'])
      field(o, 'text', path, asString)
      break
    case 'html':
      exactKeys(o, path, ['kind', 'placement', 'html'])
      field(o, 'placement', path, indexInjectionPlacement)
      field(o, 'html', path, asString)
      break
    default:
      return fail(path, 'unknown IndexInjection kind')
  }
  return value as IndexInjection
}

const bootPayload: Guard<BootPayload> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['injections', 'streamBaseUrl', 'authenticatedUrl'])
  field(o, 'injections', path, listOf(indexInjection))
  field(o, 'streamBaseUrl', path, asString)
  field(o, 'authenticatedUrl', path, asString)
  return value as BootPayload
}

const runtimeStatus: Guard<RuntimeStatus> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['state', 'url', 'startedAt', 'lastError'])
  field(o, 'state', path, runtimeState)
  field(o, 'url', path, nullable(asString))
  field(o, 'startedAt', path, nullable(asString))
  field(o, 'lastError', path, nullable(asString))
  return value as RuntimeStatus
}

const quitInspection: Guard<QuitInspection> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['activeTasks', 'scheduledTasks', 'error'])
  field(o, 'activeTasks', path, asBoolean)
  field(o, 'scheduledTasks', path, asBoolean)
  field(o, 'error', path, nullable(asString))
  return value as QuitInspection
}

const settingsMap: Guard<SettingsMap> = recordOf(settingValue)

const credentialRef: Guard<CredentialRef> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['provider', 'reference', 'hasSecret', 'updatedAt'])
  field(o, 'provider', path, asString)
  field(o, 'reference', path, asString)
  field(o, 'hasSecret', path, asBoolean)
  field(o, 'updatedAt', path, asString)
  return value as CredentialRef
}

const credentialPresence: Guard<CredentialPresence> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['present'])
  field(o, 'present', path, asBoolean)
  return value as CredentialPresence
}

const clipboardText: Guard<ClipboardText> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['text'])
  field(o, 'text', path, asString)
  return value as ClipboardText
}

const pickedDirectory: Guard<PickedDirectory> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['path'])
  field(o, 'path', path, nullable(asString))
  return value as PickedDirectory
}

const desktopUpdatePresentation: Guard<DesktopUpdatePresentation> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['phase'], ['version', 'percent', 'failure'])
  field(o, 'phase', path, desktopUpdatePhase)
  optionalField(o, 'version', path, asString)
  optionalField(o, 'percent', path, asNumber)
  optionalField(o, 'failure', path, desktopUpdateFailureKind)
  return value as DesktopUpdatePresentation
}

const shortcutBindingFields = (o: Record<string, unknown>, path: string, required: readonly string[]): void => {
  exactKeys(o, path, required, ['secondCode'])
  field(o, 'code', path, asString)
  optionalField(o, 'secondCode', path, asString)
  field(o, 'modifiers', path, listOf(shortcutModifier))
}

const shortcutBinding: Guard<ShortcutBinding> = (value, path) => {
  shortcutBindingFields(asRecord(value, path), path, ['code', 'modifiers'])
  return value as ShortcutBinding
}

const shortcutBindingRow: Guard<ShortcutBindingRow> = (value, path) => {
  const o = asRecord(value, path)
  shortcutBindingFields(o, path, ['id', 'code', 'modifiers'])
  field(o, 'id', path, asString)
  return value as ShortcutBindingRow
}

const shortcutProfile: Guard<ShortcutProfile> = (value, path) => {
  const text = asString(value, path)
  const [runtime, platform, ...rest] = text.split(':')
  if (rest.length > 0 || (runtime !== 'desktop' && runtime !== 'web')
    || (platform !== 'macos' && platform !== 'windows' && platform !== 'linux')) {
    return fail(path, 'expected `${desktop|web}:${macos|windows|linux}`')
  }
  return text as ShortcutProfile
}

const shortcutDocument: Guard<ShortcutDocument> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['schemaVersion', 'profiles'])
  const schemaVersion = field(o, 'schemaVersion', path, asNumber)
  if (schemaVersion !== 1 && schemaVersion !== 2) return fail(path, 'schemaVersion must be 1 or 2')
  const profiles = asRecord(o.profiles, `${path}.profiles`)
  for (const key of Object.keys(profiles)) {
    shortcutProfile(key, `${path}.profiles`)
    recordOf(nullable(shortcutBinding))(profiles[key], `${path}.profiles.${key}`)
  }
  return value as ShortcutDocument
}

const shortcutDefinition: Guard<ShortcutDefinition> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['id', 'defaults'], ['fixed'])
  field(o, 'id', path, asString)
  const defaults = asRecord(o.defaults, `${path}.defaults`)
  for (const key of Object.keys(defaults)) {
    shortcutProfile(key, `${path}.defaults`)
    shortcutBinding(defaults[key], `${path}.defaults.${key}`)
  }
  const fixed = optionalField(o, 'fixed', path, listOf(shortcutBinding))
  if (fixed !== undefined && fixed.length === 0) return fail(path, 'fixed must be a non-empty tuple')
  return value as ShortcutDefinition
}

const shortcutEdit: Guard<ShortcutEdit> = (value, path) => {
  const o = asRecord(value, path)
  switch (asString(o.type, `${path}.type`)) {
    case 'set':
      exactKeys(o, path, ['type', 'id', 'binding'])
      field(o, 'id', path, asString)
      field(o, 'binding', path, nullable(shortcutBinding))
      break
    case 'reset':
      exactKeys(o, path, ['type', 'id'])
      field(o, 'id', path, asString)
      break
    case 'reset-all':
      exactKeys(o, path, ['type'])
      break
    default:
      return fail(path, 'unknown ShortcutEdit type')
  }
  return value as ShortcutEdit
}

const shortcutConfigSnapshot: Guard<ShortcutConfigSnapshot> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['revision', 'sequence', 'document', 'status', 'error', 'usingDefaults'])
  field(o, 'revision', path, asString)
  const sequence = field(o, 'sequence', path, asNumber)
  if (!Number.isSafeInteger(sequence) || sequence < 0) return fail(path, 'sequence must be a non-negative integer')
  field(o, 'document', path, shortcutDocument)
  const status = field(o, 'status', path, enumOf(['loading', 'ready', 'unreadable'] as const))
  if (status === 'loading' && o.error !== null) return fail(path, 'loading snapshot has no error')
  field(o, 'error', path, nullable(enumOf(['read', 'invalid', 'future'] as const)))
  field(o, 'usingDefaults', path, asBoolean)
  return value as ShortcutConfigSnapshot
}

const shortcutSaveResult: Guard<ShortcutSaveResult> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['status', 'snapshot'], ['issue', 'conflicts'])
  field(o, 'status', path, enumOf(['saved', 'stale', 'unreadable', 'write-failed', 'not-ready', 'conflict'] as const))
  field(o, 'snapshot', path, shortcutConfigSnapshot)
  optionalField(o, 'issue', path, bindingIssue)
  optionalField(o, 'conflicts', path, listOf(asString))
  return value as ShortcutSaveResult
}

const desktopShortcutInput: Guard<DesktopShortcutInput> = (value, path) => {
  const o = asRecord(value, path)
  switch (asString(o.kind, `${path}.kind`)) {
    case 'menu':
      exactKeys(o, path, ['revision', 'kind', 'commandId'])
      field(o, 'commandId', path, asString)
      break
    case 'keyboard':
    case 'iframe':
    case 'webview':
      exactKeys(o, path, ['revision', 'kind', 'frameName', 'code', 'control', 'alt', 'shift', 'meta', 'repeat'], ['secondCode'])
      field(o, 'frameName', path, asString)
      field(o, 'code', path, asString)
      optionalField(o, 'secondCode', path, asString)
      field(o, 'control', path, asBoolean)
      field(o, 'alt', path, asBoolean)
      field(o, 'shift', path, asBoolean)
      field(o, 'meta', path, asBoolean)
      field(o, 'repeat', path, asBoolean)
      break
    default:
      return fail(path, 'unknown DesktopShortcutInput kind')
  }
  field(o, 'revision', path, asString)
  return value as DesktopShortcutInput
}

const shortcutsChangedEvent: Guard<ShortcutsChangedEvent> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['bindings'])
  field(o, 'bindings', path, listOf(shortcutBindingRow))
  return value as ShortcutsChangedEvent
}

const shortcutsRecordingEvent: Guard<ShortcutsRecordingEvent> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['recording'])
  field(o, 'recording', path, asBoolean)
  return value as ShortcutsRecordingEvent
}

const shellWindowEvent: Guard<ShellWindowEvent> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['state'])
  field(o, 'state', path, shellWindowState)
  return value as ShellWindowEvent
}

const shellQuitConfirmedEvent: Guard<ShellQuitConfirmedEvent> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['reason'])
  field(o, 'reason', path, quitReason)
  return value as ShellQuitConfirmedEvent
}

const dshError: Guard<DshError> = (value, path) => {
  const o = asRecord(value, path)
  switch (asString(o.kind, `${path}.kind`)) {
    case 'not_found': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['entity', 'id'])
      field(d, 'entity', `${path}.detail`, asString)
      field(d, 'id', `${path}.detail`, asString)
      break
    }
    case 'invalid_argument': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['field', 'reason'])
      field(d, 'field', `${path}.detail`, asString)
      field(d, 'reason', `${path}.detail`, asString)
      break
    }
    case 'io': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['operation', 'path', 'message'])
      field(d, 'operation', `${path}.detail`, asString)
      field(d, 'path', `${path}.detail`, nullable(asString))
      field(d, 'message', `${path}.detail`, asString)
      break
    }
    case 'runtime_unavailable': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['state', 'reason'])
      field(d, 'state', `${path}.detail`, asString)
      field(d, 'reason', `${path}.detail`, asString)
      break
    }
    case 'credential_store': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['operation', 'message'])
      field(d, 'operation', `${path}.detail`, asString)
      field(d, 'message', `${path}.detail`, asString)
      break
    }
    case 'timeout': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['operation', 'millis'])
      field(d, 'operation', `${path}.detail`, asString)
      const millis = field(d, 'millis', `${path}.detail`, asNumber)
      if (!Number.isSafeInteger(millis) || millis < 0) return fail(path, 'millis must be a non-negative integer')
      break
    }
    case 'cancelled': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['operation'])
      field(d, 'operation', `${path}.detail`, asString)
      break
    }
    case 'other': {
      exactKeys(o, path, ['kind', 'detail'])
      const d = asRecord(o.detail, `${path}.detail`)
      exactKeys(d, `${path}.detail`, ['code', 'message'])
      field(d, 'code', `${path}.detail`, asString)
      field(d, 'message', `${path}.detail`, asString)
      break
    }
    default:
      return fail(path, 'unknown DshError kind')
  }
  return value as DshError
}

// Request types (round-tripped when the Rust lane publishes their fixtures).
const localeSetRequest: Guard<LocaleSetRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['preference'])
  field(o, 'preference', path, nullable(localeCode))
  return value as LocaleSetRequest
}
const localeApplyRequest: Guard<LocaleApplyRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['locale'])
  field(o, 'locale', path, localeCode)
  return value as LocaleApplyRequest
}
const windowSetFullscreenRequest: Guard<WindowSetFullscreenRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['enabled'])
  field(o, 'enabled', path, asBoolean)
  return value as WindowSetFullscreenRequest
}
const themeSetRequest: Guard<ThemeSetRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['theme'])
  field(o, 'theme', path, themePreference)
  return value as ThemeSetRequest
}
const menuActionRequest: Guard<MenuActionRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['id'])
  field(o, 'id', path, menuActionId)
  return value as MenuActionRequest
}
const openExternalRequest: Guard<OpenExternalRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['url'])
  field(o, 'url', path, asString)
  return value as OpenExternalRequest
}
const clipboardWriteRequest: Guard<ClipboardWriteRequest> = clipboardText
const bootFailedRequest: Guard<BootFailedRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['message'])
  field(o, 'message', path, asString)
  return value as BootFailedRequest
}
const settingsGetRequest: Guard<SettingsGetRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['key'])
  field(o, 'key', path, asString)
  return value as SettingsGetRequest
}
const settingsSetRequest: Guard<SettingsSetRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['key', 'value'])
  field(o, 'key', path, asString)
  field(o, 'value', path, settingValue)
  return value as SettingsSetRequest
}
const settingsResetRequest: Guard<SettingsResetRequest> = settingsGetRequest
const credentialStoreRequest: Guard<CredentialStoreRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['provider', 'reference', 'secret'])
  field(o, 'provider', path, asString)
  field(o, 'reference', path, asString)
  field(o, 'secret', path, asString)
  return value as CredentialStoreRequest
}
const pickDirectoryRequest: Guard<PickDirectoryRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['title', 'defaultPath'])
  field(o, 'title', path, nullable(asString))
  field(o, 'defaultPath', path, nullable(asString))
  return value as PickDirectoryRequest
}
const shortcutsGetRequest: Guard<ShortcutsGetRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['definitions'])
  field(o, 'definitions', path, listOf(shortcutDefinition))
  return value as ShortcutsGetRequest
}
const shortcutsEditRequest: Guard<ShortcutsEditRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['edit', 'revision'])
  field(o, 'edit', path, shortcutEdit)
  field(o, 'revision', path, asString)
  return value as ShortcutsEditRequest
}
const shortcutsRecordingRequest: Guard<ShortcutsRecordingRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['active'])
  field(o, 'active', path, asBoolean)
  return value as ShortcutsRecordingRequest
}
const shellCloseWindowRequest: Guard<ShellCloseWindowRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['revision'])
  field(o, 'revision', path, asString)
  return value as ShellCloseWindowRequest
}
const onboardingSetActiveRequest: Guard<OnboardingSetActiveRequest> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['active'])
  field(o, 'active', path, asBoolean)
  return value as OnboardingSetActiveRequest
}

/** Transitional only (amendment A6): `desktop-release.json` until the Rust lane renames it to `app-info.json`. */
interface TransitionalDesktopRelease {
  readonly schemaVersion: number
  readonly version: string
  readonly hostProtocolVersion: number
  readonly nodeVersion: string
  readonly pnpmVersion: string
}
const transitionalDesktopRelease: Guard<TransitionalDesktopRelease> = (value, path) => {
  const o = asRecord(value, path)
  exactKeys(o, path, ['schemaVersion', 'version', 'hostProtocolVersion', 'nodeVersion', 'pnpmVersion'])
  field(o, 'schemaVersion', path, asNumber)
  field(o, 'version', path, asString)
  field(o, 'hostProtocolVersion', path, asNumber)
  field(o, 'nodeVersion', path, asString)
  field(o, 'pnpmVersion', path, asString)
  return value as TransitionalDesktopRelease
}

// ---------------------------------------------------------------------------
// Fixture registry: fixture base name -> contract type validator. Both the
// amendment-A7 final names and the transitional names currently present in the
// shared directory map to the same validators; an unregistered file fails.
// ---------------------------------------------------------------------------

interface RegistryEntry {
  /** Contract type this file round-trips (for failure messages). */
  readonly type: string
  readonly guard: Guard<unknown>
}

/** Accept one wire form or a list of them (the directory mixes both styles). */
const oneOrMany = <T>(guard: Guard<T>): Guard<unknown> => (value, path) =>
  Array.isArray(value) ? listOf(guard)(value, path) : guard(value, path)

/** A8: `desktop-shortcut-input.<kind>.json` must hold exactly one upstream `kind` arm. */
function inputOfKind(kind: 'menu' | 'keyboard' | 'iframe' | 'webview'): Guard<DesktopShortcutInput> {
  return (value, path) => {
    const parsed = desktopShortcutInput(value, path)
    if (parsed.kind !== kind) return fail(path, `expected kind ${JSON.stringify(kind)}, got ${JSON.stringify(parsed.kind)}`)
    return parsed
  }
}

const REGISTRY: Readonly<Record<string, RegistryEntry>> = {
  'app-info': { type: 'AppInfo', guard: oneOrMany(appInfo) },
  'locale-state': { type: 'LocaleState', guard: oneOrMany(localeState) },
  'appearance': { type: 'Appearance', guard: oneOrMany(appearance) },
  'boot-payload': { type: 'BootPayload', guard: oneOrMany(bootPayload) },
  'index-injection': { type: 'IndexInjection', guard: oneOrMany(indexInjection) },
  'runtime-status': { type: 'RuntimeStatus', guard: oneOrMany(runtimeStatus) },
  'quit-inspection': { type: 'QuitInspection', guard: oneOrMany(quitInspection) },
  'setting-value': { type: 'SettingValue', guard: oneOrMany(settingValue) },
  'setting-values': { type: 'SettingValue', guard: oneOrMany(settingValue) },
  'settings-map': { type: 'SettingsMap', guard: oneOrMany(settingsMap) },
  'credential-ref': { type: 'CredentialRef', guard: oneOrMany(credentialRef) },
  'credential-presence': { type: 'CredentialPresence', guard: oneOrMany(credentialPresence) },
  'credential-address': { type: 'CredentialAddress', guard: oneOrMany(credentialAddress) },
  'clipboard-text': { type: 'ClipboardText', guard: oneOrMany(clipboardText) },
  'picked-directory': { type: 'PickedDirectory', guard: oneOrMany(pickedDirectory) },
  'desktop-shortcut-input': { type: 'DesktopShortcutInput', guard: oneOrMany(desktopShortcutInput) },
  'desktop-update-presentation': { type: 'DesktopUpdatePresentation', guard: oneOrMany(desktopUpdatePresentation) },
  'desktop-update-phase': { type: 'DesktopUpdatePhase', guard: oneOrMany(desktopUpdatePhase) },
  'desktop-update-failure-kind': { type: 'DesktopUpdateFailureKind', guard: oneOrMany(desktopUpdateFailureKind) },
  'dsh-error': { type: 'DshError', guard: oneOrMany(dshError) },
  'shortcut-binding': { type: 'ShortcutBinding', guard: oneOrMany(shortcutBinding) },
  'shortcut-binding-row': { type: 'ShortcutBindingRow', guard: oneOrMany(shortcutBindingRow) },
  'shortcut-modifier': { type: 'ShortcutModifier', guard: oneOrMany(shortcutModifier) },
  'shortcut-profile': { type: 'ShortcutProfile', guard: oneOrMany(shortcutProfile) },
  'binding-issue': { type: 'BindingIssue', guard: oneOrMany(bindingIssue) },
  'shortcut-document': { type: 'ShortcutDocument', guard: oneOrMany(shortcutDocument) },
  'shortcut-definition': { type: 'ShortcutDefinition', guard: oneOrMany(shortcutDefinition) },
  'shortcut-edit': { type: 'ShortcutEdit', guard: oneOrMany(shortcutEdit) },
  'shortcut-config-snapshot': { type: 'ShortcutConfigSnapshot', guard: oneOrMany(shortcutConfigSnapshot) },
  'shortcut-save-result': { type: 'ShortcutSaveResult', guard: oneOrMany(shortcutSaveResult) },
  // A8: `desktop-shortcut-input.<kind>.json` — one upstream `kind` arm per file.
  'desktop-shortcut-input.menu': { type: 'DesktopShortcutInput', guard: oneOrMany(inputOfKind('menu')) },
  'desktop-shortcut-input.keyboard': { type: 'DesktopShortcutInput', guard: oneOrMany(inputOfKind('keyboard')) },
  'desktop-shortcut-input.iframe': { type: 'DesktopShortcutInput', guard: oneOrMany(inputOfKind('iframe')) },
  'desktop-shortcut-input.webview': { type: 'DesktopShortcutInput', guard: oneOrMany(inputOfKind('webview')) },
  'menu-action-id': { type: 'MenuActionId', guard: oneOrMany(menuActionId) },
  'runtime-state': { type: 'RuntimeState', guard: oneOrMany(runtimeState) },
  'shell-window-state': { type: 'ShellWindowState', guard: oneOrMany(shellWindowState) },
  'quit-reason': { type: 'QuitReason', guard: oneOrMany(quitReason) },
  'locale-code': { type: 'LocaleCode', guard: oneOrMany(localeCode) },
  'theme-preference': { type: 'ThemePreference', guard: oneOrMany(themePreference) },
  'index-injection-placement': { type: 'IndexInjectionPlacement', guard: oneOrMany(indexInjectionPlacement) },
  'shortcuts-changed-event': { type: 'ShortcutsChangedEvent', guard: oneOrMany(shortcutsChangedEvent) },
  'shortcuts-recording-event': { type: 'ShortcutsRecordingEvent', guard: oneOrMany(shortcutsRecordingEvent) },
  'shell-window-event': { type: 'ShellWindowEvent', guard: oneOrMany(shellWindowEvent) },
  'shell-quit-confirmed-event': { type: 'ShellQuitConfirmedEvent', guard: oneOrMany(shellQuitConfirmedEvent) },
  'locale-set-request': { type: 'LocaleSetRequest', guard: oneOrMany(localeSetRequest) },
  'locale-apply-request': { type: 'LocaleApplyRequest', guard: oneOrMany(localeApplyRequest) },
  'window-set-fullscreen-request': { type: 'WindowSetFullscreenRequest', guard: oneOrMany(windowSetFullscreenRequest) },
  'theme-set-request': { type: 'ThemeSetRequest', guard: oneOrMany(themeSetRequest) },
  'menu-action-request': { type: 'MenuActionRequest', guard: oneOrMany(menuActionRequest) },
  'open-external-request': { type: 'OpenExternalRequest', guard: oneOrMany(openExternalRequest) },
  'clipboard-write-request': { type: 'ClipboardWriteRequest', guard: oneOrMany(clipboardWriteRequest) },
  'boot-failed-request': { type: 'BootFailedRequest', guard: oneOrMany(bootFailedRequest) },
  'settings-get-request': { type: 'SettingsGetRequest', guard: oneOrMany(settingsGetRequest) },
  'settings-set-request': { type: 'SettingsSetRequest', guard: oneOrMany(settingsSetRequest) },
  'settings-reset-request': { type: 'SettingsResetRequest', guard: oneOrMany(settingsResetRequest) },
  'credential-store-request': { type: 'CredentialStoreRequest', guard: oneOrMany(credentialStoreRequest) },
  'pick-directory-request': { type: 'PickDirectoryRequest', guard: oneOrMany(pickDirectoryRequest) },
  'shortcuts-get-request': { type: 'ShortcutsGetRequest', guard: oneOrMany(shortcutsGetRequest) },
  'shortcuts-edit-request': { type: 'ShortcutsEditRequest', guard: oneOrMany(shortcutsEditRequest) },
  'shortcuts-recording-request': { type: 'ShortcutsRecordingRequest', guard: oneOrMany(shortcutsRecordingRequest) },
  'shell-close-window-request': { type: 'ShellCloseWindowRequest', guard: oneOrMany(shellCloseWindowRequest) },
  'onboarding-set-active-request': { type: 'OnboardingSetActiveRequest', guard: oneOrMany(onboardingSetActiveRequest) },
  // Transitional names present while the Rust lane applies A6/A7 renames.
  'event-shortcuts-changed': { type: 'ShortcutsChangedEvent', guard: oneOrMany(shortcutsChangedEvent) },
  'event-shortcuts-recording': { type: 'ShortcutsRecordingEvent', guard: oneOrMany(shortcutsRecordingEvent) },
  'event-shortcuts-input': { type: 'DesktopShortcutInput', guard: oneOrMany(desktopShortcutInput) },
  'event-shell-window': { type: 'ShellWindowEvent', guard: oneOrMany(shellWindowEvent) },
  'event-shell-quit-confirmed': { type: 'ShellQuitConfirmedEvent', guard: oneOrMany(shellQuitConfirmedEvent) },
  'desktop-release': { type: 'DesktopRelease (transitional, A6)', guard: oneOrMany(transitionalDesktopRelease) },
}

/**
 * Response fixture of each command (`null` for `void` responses). Every entry
 * must name a fixture that exists in `port/fixtures/protocol/`.
 */
const RESPONSE_FIXTURES: Record<DshCommandName, string | null> = {
  shell_app_info: 'app-info',
  shell_locale_get: 'locale-state',
  shell_locale_set: 'locale-state',
  shell_locale_apply: 'locale-state',
  shell_window_set_fullscreen: null,
  shell_window_chrome_action: null,
  shell_window_resize_dragging: null,
  shell_window_toggle_devtools: null,
  shell_theme_set: null,
  shell_appearance: 'appearance',
  shell_menu_action: null,
  shell_open_external: null,
  shell_clipboard_write: null,
  shell_clipboard_read: 'clipboard-text',
  shell_quit_request: null,
  shell_close_window: null,
  shell_onboarding_set_active: null,
  shell_shortcuts_get: 'shortcut-config-snapshot',
  shell_shortcuts_edit: 'shortcut-save-result',
  shell_shortcuts_recording: null,
  runtime_boot_ready: 'boot-payload',
  runtime_boot_failed: null,
  runtime_status: 'runtime-status',
  runtime_restart: 'runtime-status',
  runtime_quit_inspection: 'quit-inspection',
  settings_get: 'setting-value',
  settings_set: null,
  settings_list: 'settings-map',
  settings_reset: null,
  credential_list: 'credential-ref',
  credential_has: 'credential-presence',
  credential_store: null,
  credential_delete: null,
  shell_pick_directory: 'picked-directory',
  update_status: 'desktop-update-presentation',
  update_open: null,
  update_check: 'desktop-update-presentation',
  // Guest commands. The two typed responses below have no Rust-owned fixture
  // file yet (`port/fixtures/**` is generated by `dsh-core`, which this lane
  // must not edit); they are pinned by `GUEST_WIRE_SAMPLES` in the "port
  // additions" suite instead, which round-trips the same JSON byte-identically.
  guest_browser_acquire: null,
  guest_browser_release: null,
  guest_browser_set_bounds: null,
  guest_browser_navigate: null,
  guest_browser_command: null,
  guest_browser_state: null,
  guest_platform_open: null,
  guest_platform_set_bounds: null,
  guest_platform_close: null,
  guest_platform_status: null,
  shell_host_paths: null,
  shell_host_paths_consume: null,
  shell_caption_menu: null,
  shell_caption_palette: null,
  shell_renderer_console: null,
  // The mandatory-policy surface is registered by the same handler as the
  // bridge commands and returns `Result<(), String>`, so its responses carry no
  // fixture type here.
  policy_presented: null,
  policy_retry: null,
  policy_update: null,
  policy_quit: null,
}

/**
 * Event payload fixture of each `dsh://` event; `null` for an event whose wire
 * form has no Rust-owned fixture file yet (pinned by `PORT_WIRE_SAMPLES` below).
 */
const EVENT_FIXTURES: Record<DshEventName, string | null> = {
  'dsh://runtime/state': 'runtime-status',
  'dsh://locale/changed': 'locale-state',
  'dsh://appearance/changed': 'appearance',
  'dsh://shortcuts/changed': 'shortcuts-changed-event',
  'dsh://shortcuts/recording': 'shortcuts-recording-event',
  'dsh://shortcuts/input': 'desktop-shortcut-input',
  'dsh://update/state': 'desktop-update-presentation',
  'dsh://shell/window': 'shell-window-event',
  // The refusal channel carries the shared `DshError` taxonomy, so it is covered
  // by the existing `dsh-error.json` fixture rather than a new file.
  'dsh://shell/window-error': 'dsh-error',
  'dsh://shell/quit-confirmed': 'shell-quit-confirmed-event',
  // Guest events: no Rust-owned fixture file exists yet (`port/fixtures/**` is
  // generated by `dsh-core`, outside this lane); the wire form is pinned by
  // `GUEST_WIRE_SAMPLES` in the "port additions" suite instead.
  'dsh://guests/browser-open': null,
  'dsh://guests/browser-state': null,
}

/** One sample per `DshError` kind — compile-time taxonomy coverage. */
const ERROR_SAMPLES: Record<DshErrorKind, DshError> = {
  not_found: { kind: 'not_found', detail: { entity: 'setting', id: 'locale.preference' } },
  invalid_argument: { kind: 'invalid_argument', detail: { field: 'url', reason: 'scheme not allowed' } },
  io: { kind: 'io', detail: { operation: 'read', path: null, message: 'denied' } },
  runtime_unavailable: { kind: 'runtime_unavailable', detail: { state: 'stopped', reason: 'not running' } },
  credential_store: { kind: 'credential_store', detail: { operation: 'write', message: 'refused' } },
  timeout: { kind: 'timeout', detail: { operation: 'update_check', millis: 30000 } },
  cancelled: { kind: 'cancelled', detail: { operation: 'shell_pick_directory' } },
  other: { kind: 'other', detail: { code: 'browser_guest_unavailable', message: 'unavailable' } },
}

/** Compile-time closed-union checks (a missing member fails `tsc`). */
const MENU_ACTION_IDS: Record<MenuActionId, true> = {
  about: true, check_for_updates: true, exit: true, undo: true, redo: true, cut: true, copy: true,
  paste: true, delete: true, select_all: true, close_page_or_window: true, reload_page: true,
  restart_app_and_host: true, toggle_devtools: true, minimize: true, hide: true, hide_others: true,
  show_all: true, zoom_in: true, zoom_out: true, reset_zoom: true,
}
const COMMAND_NAMES: Record<DshCommandName, true> = {
  shell_app_info: true, shell_locale_get: true, shell_locale_set: true, shell_locale_apply: true,
  shell_window_set_fullscreen: true, shell_window_chrome_action: true, shell_window_resize_dragging: true,
  shell_window_toggle_devtools: true, shell_theme_set: true, shell_appearance: true, shell_menu_action: true,
  shell_open_external: true, shell_clipboard_write: true, shell_clipboard_read: true, shell_quit_request: true,
  shell_close_window: true, shell_onboarding_set_active: true,
  shell_shortcuts_get: true, shell_shortcuts_edit: true, shell_shortcuts_recording: true,
  runtime_boot_ready: true, runtime_boot_failed: true, runtime_status: true, runtime_restart: true,
  runtime_quit_inspection: true, settings_get: true, settings_set: true, settings_list: true,
  settings_reset: true, credential_list: true, credential_has: true, credential_store: true,
  credential_delete: true, shell_pick_directory: true, update_status: true, update_open: true, update_check: true,
  guest_browser_acquire: true, guest_browser_release: true, guest_browser_set_bounds: true,
  guest_browser_navigate: true, guest_browser_command: true, guest_browser_state: true,
  guest_platform_open: true, guest_platform_set_bounds: true, guest_platform_close: true,
  guest_platform_status: true,
  shell_host_paths: true, shell_host_paths_consume: true, shell_caption_menu: true,
  shell_caption_palette: true, shell_renderer_console: true,
  policy_presented: true, policy_retry: true, policy_update: true, policy_quit: true,
}
const EVENT_NAMES: Record<DshEventName, true> = {
  'dsh://runtime/state': true, 'dsh://locale/changed': true, 'dsh://appearance/changed': true,
  'dsh://shortcuts/changed': true, 'dsh://shortcuts/recording': true, 'dsh://shortcuts/input': true,
  'dsh://update/state': true, 'dsh://shell/window': true, 'dsh://shell/window-error': true,
  'dsh://shell/quit-confirmed': true,
  'dsh://guests/browser-open': true, 'dsh://guests/browser-state': true,
}

// ---------------------------------------------------------------------------
// Suites.
// ---------------------------------------------------------------------------

/**
 * Resolve one fixture file name to its registry entry. A8 naming: an arm file
 * `base.<arm>.json` (`.null` for a nullable/optional empty arm,
 * `desktop-shortcut-input.<kind>` for input kinds) resolves to its base type;
 * `desktop-shortcut-input.<kind>` additionally asserts the arm.
 */
function resolveEntry(name: string): RegistryEntry | undefined {
  const exact = REGISTRY[name]
  if (exact !== undefined) return exact
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return undefined
  return REGISTRY[name.slice(0, dot)]
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter(name => name.endsWith('.json'))
    .map(name => name.slice(0, -'.json'.length))
    .sort()
}

function readFixture(base: string): { text: string; value: unknown } {
  const text = readFileSync(`${FIXTURE_DIR}${base}.json`, 'utf8')
  return { text, value: JSON.parse(text) as unknown }
}

describe('fixture round-trip (port/fixtures/protocol/*.json)', () => {
  const names = fixtureNames()

  it('the fixture directory is non-empty', () => {
    expect(names.length).toBeGreaterThan(0)
  })

  it('every fixture file has a registered contract type (A7/A8: no exclusions)', () => {
    const unknown = names.filter(name => resolveEntry(name) === undefined)
    expect(unknown, `unregistered fixture files: ${unknown.join(', ')}`).toEqual([])
  })

  for (const name of names) {
    it(`${name} round-trips as its contract type`, () => {
      const entry = resolveEntry(name)
      if (entry === undefined) throw new Error(`fixture ${name}.json has no registered contract type`)
      const { text, value } = readFixture(name)
      // Byte-identical canonical form: parse + serialize reproduces the file.
      expect(JSON.stringify(value)).toBe(text.replace(/[\r\n]+$/u, ''))
      // The mirror type accepts every element (loud failure otherwise).
      expect(() => entry.guard(value, name)).not.toThrow()
      // Typed round-trip: serializing the validated value returns the same bytes.
      expect(JSON.stringify(entry.guard(value, name))).toBe(JSON.stringify(value))
    })
  }
})

describe('contract coverage', () => {
  const names = fixtureNames()
  /** A fixture name covers a requirement when a file with that base name (or an arm file of it) exists. */
  const covered = (fixture: string): boolean =>
    names.some(name => name === fixture || name.startsWith(`${fixture}.`))

  it('covers every command response type', () => {
    const missing = (Object.entries(RESPONSE_FIXTURES) as [DshCommandName, string | null][])
      .filter(([, fixture]) => fixture !== null && !covered(fixture))
      .map(([command, fixture]) => `${command} -> ${fixture}.json`)
    expect(missing, `response fixtures missing: ${missing.join('; ')}`).toEqual([])
  })

  it('covers every event payload type', () => {
    const missing = (Object.entries(EVENT_FIXTURES) as [DshEventName, string | null][])
      .filter(([, fixture]) => fixture !== null && !covered(fixture))
      .map(([event, fixture]) => `${event} -> ${fixture}.json`)
    expect(missing, `event fixtures missing: ${missing.join('; ')}`).toEqual([])
  })

  it('covers every DshError variant', () => {
    const entry = REGISTRY['dsh-error']
    if (entry === undefined) throw new Error('dsh-error fixture type missing from the registry')
    const { value } = readFixture('dsh-error')
    const kinds = new Set((Array.isArray(value) ? value : [value]).map(row => dshError(row, 'dsh-error').kind))
    const missing = (Object.keys(ERROR_SAMPLES) as DshErrorKind[]).filter(kind => !kinds.has(kind))
    expect(missing, `DshError variants missing from dsh-error.json: ${missing.join(', ')}`).toEqual([])
  })
})

describe('type lockstep', () => {
  it('every DshError kind is constructible and round-trips', () => {
    for (const [kind, sample] of Object.entries(ERROR_SAMPLES)) {
      expect(dshError(JSON.parse(JSON.stringify(sample)) as unknown, kind)).toEqual(sample)
    }
  })

  it('closed unions enumerate every member (compile-time Record coverage)', () => {
    expect(Object.keys(MENU_ACTION_IDS)).toHaveLength(21)
    expect(Object.keys(COMMAND_NAMES)).toHaveLength(56)
    expect(Object.keys(EVENT_NAMES)).toHaveLength(12)
    expect(Object.keys(ERROR_SAMPLES)).toHaveLength(8)
  })

  it('AppInfo carries the runtime credential reference (A5)', () => {
    const sample: AppInfo = {
      productName: 'DeepSeek Harness', version: '0.1.7-rc.2', protocolGeneration: 4,
      runtimeVersion: '0.1.7-rc.2', platform: 'win32', arch: 'x64', locale: 'en',
      credentialRef: { provider: 'deepseek', reference: 'api-key' },
    }
    expect(appInfo(JSON.parse(JSON.stringify(sample)) as unknown, 'sample')).toEqual(sample)
    const withoutRef: AppInfo = { ...sample, credentialRef: null }
    expect(appInfo(JSON.parse(JSON.stringify(withoutRef)) as unknown, 'sample')).toEqual(withoutRef)
  })

  it('ShortcutBinding keeps upstream shape and ShortcutBindingRow adds id (A1)', () => {
    const binding: ShortcutBinding = { code: 'KeyW', secondCode: 'KeyR', modifiers: ['primary'] }
    const row: ShortcutBindingRow = { id: 'page.close', ...binding }
    expect(shortcutBinding(JSON.parse(JSON.stringify(binding)) as unknown, 'sample')).toEqual(binding)
    expect(shortcutBindingRow(JSON.parse(JSON.stringify(row)) as unknown, 'sample')).toEqual(row)
  })
})

// ---------------------------------------------------------------------------
// Port additions: guest, native-path, caption-menu and renderer-console wire
// forms.
//
// These commands and events exist in `port/src-tauri/app/src/` but have no
// file in `port/fixtures/protocol/` yet — that directory is generated and owned
// by `dsh-core`, which this lane must not edit. Each wire form is therefore
// pinned against the Rust struct it mirrors, field for field, in this suite:
// `GuestBrowserState`/`HostPaths` are `#[serde(rename_all = "camelCase")]`, so
// the JSON below is exactly what the shell serializes. A drift in the mirror
// fails here, and the Rust side keeps its own tests.
// ---------------------------------------------------------------------------

/** The exact JSON each port-addition type serializes to, keyed by contract type name. */
const PORT_WIRE_SAMPLES = {
  BrowserReservation: { lease: '3f1c0a1e-5b8f-4a5f-9e2c-6d7a8b9c0d1e', partition: 'dsh-sidebar-browser-9a1b2c3d' },
  GuestBounds: { x: 120, y: 64, width: 480, height: 720 },
  GuestBrowserFailure: { code: -105, description: 'NAME_NOT_RESOLVED' },
  GuestBrowserState: {
    lease: '3f1c0a1e-5b8f-4a5f-9e2c-6d7a8b9c0d1e', url: 'https://example.com/a', title: 'Example',
    loading: false, canGoBack: true, canGoForward: false, gone: false, error: null,
  },
  BrowserOpenRequestEvent: { lease: '3f1c0a1e-5b8f-4a5f-9e2c-6d7a8b9c0d1e', url: 'https://example.com/b' },
  HostPaths: { paths: ['C:\\drop\\a.txt', '/home/me/b.md'], consumed: false },
  RendererConsoleEntry: { sourceId: 'http://127.0.0.1:3080', line: 42, message: 'TypeError: x is not a function' },
  CaptionMenuRequest: { name: 'application', x: 12.5, y: 40 },
  BrowserAcquireRequest: { workspace: 'cwd:C:\\work', bounds: { x: 0, y: 0, width: 0, height: 0 } },
  BrowserBoundsRequest: { lease: 'lease-1', bounds: { x: 8, y: 8, width: 300, height: 200 } },
  BrowserNavigateRequest: { lease: 'lease-1', url: 'https://example.com/' },
  BrowserCommandRequest: { lease: 'lease-1', command: 'clear-history' },
  PlatformOpenRequest: { page: 'top-up', bounds: { x: 0, y: 0, width: 900, height: 600 } },
} as const

describe('port-addition wire forms (no Rust-owned fixture file yet)', () => {
  it('GuestBrowserState serializes with the camelCase fields the shell emits', () => {
    const sample: GuestBrowserState = PORT_WIRE_SAMPLES.GuestBrowserState
    expect(JSON.parse(JSON.stringify(sample)) as unknown).toEqual(PORT_WIRE_SAMPLES.GuestBrowserState)
    // The keys are the contract's, not an invented spelling.
    expect(Object.keys(sample).sort()).toEqual(
      ['canGoBack', 'canGoForward', 'error', 'gone', 'lease', 'loading', 'title', 'url'])
    // A failure arm keeps the same field names inside `error`.
    const failed: GuestBrowserState = {
      ...sample, loading: false, error: PORT_WIRE_SAMPLES.GuestBrowserFailure,
    }
    expect(Object.keys(failed.error ?? {}).sort()).toEqual(['code', 'description'])
  })

  it('HostPaths serializes with paths and consumed only', () => {
    const sample: HostPaths = PORT_WIRE_SAMPLES.HostPaths
    expect(Object.keys(sample).sort()).toEqual(['consumed', 'paths'])
    expect(JSON.parse(JSON.stringify(sample)) as unknown).toEqual(PORT_WIRE_SAMPLES.HostPaths)
  })

  it('a host path is carried verbatim, never normalized or synthesized', () => {
    const windows = 'C:\\Program Files\\app\\x.txt'
    const posix = '/home/me/readme.md'
    const sample: HostPaths = { paths: [windows, posix], consumed: true }
    expect(JSON.parse(JSON.stringify(sample)) as unknown).toEqual({ paths: [windows, posix], consumed: true })
  })

  it('BrowserOpenRequestEvent carries only the lease and the approved URL', () => {
    const sample: BrowserOpenRequestEvent = PORT_WIRE_SAMPLES.BrowserOpenRequestEvent
    expect(Object.keys(sample).sort()).toEqual(['lease', 'url'])
  })

  it('RendererConsoleEntry matches the shell-bound field names', () => {
    const sample: RendererConsoleEntry = PORT_WIRE_SAMPLES.RendererConsoleEntry
    expect(Object.keys(sample).sort()).toEqual(['line', 'message', 'sourceId'])
  })

  it('every port-addition sample survives a JSON round trip unchanged', () => {
    for (const [type, sample] of Object.entries(PORT_WIRE_SAMPLES)) {
      const text = JSON.stringify(sample)
      expect(JSON.parse(text) as unknown, type).toEqual(sample)
      expect(JSON.stringify(JSON.parse(text) as unknown), type).toBe(text)
    }
  })

  it('every added command response and event payload has a declared type (compile-time)', () => {
    // `Record<...>` over the closed maps: a command or event added to
    // `DshCommandMap`/`DshEventMap` without a sample here fails `tsc`.
    const commands: Record<DshCommandName, true> = {
      shell_app_info: true, shell_locale_get: true, shell_locale_set: true, shell_locale_apply: true,
      shell_window_set_fullscreen: true, shell_window_chrome_action: true, shell_window_resize_dragging: true,
      shell_window_toggle_devtools: true, shell_theme_set: true, shell_appearance: true,
      shell_menu_action: true, shell_open_external: true, shell_clipboard_write: true,
      shell_clipboard_read: true, shell_quit_request: true, shell_close_window: true,
      shell_onboarding_set_active: true, shell_shortcuts_get: true, shell_shortcuts_edit: true,
      shell_shortcuts_recording: true, runtime_boot_ready: true, runtime_boot_failed: true,
      runtime_status: true, runtime_restart: true, runtime_quit_inspection: true,
      settings_get: true, settings_set: true, settings_list: true, settings_reset: true,
      credential_list: true, credential_has: true, credential_store: true, credential_delete: true,
      shell_pick_directory: true, update_status: true, update_open: true, update_check: true,
      guest_browser_acquire: true, guest_browser_release: true, guest_browser_set_bounds: true,
      guest_browser_navigate: true, guest_browser_command: true, guest_browser_state: true,
      guest_platform_open: true, guest_platform_set_bounds: true, guest_platform_close: true,
      guest_platform_status: true, shell_host_paths: true, shell_host_paths_consume: true,
      shell_caption_menu: true, shell_caption_palette: true, shell_renderer_console: true,
      policy_presented: true, policy_retry: true, policy_update: true, policy_quit: true,
    }
    const events: Record<DshEventName, true> = {
      'dsh://runtime/state': true, 'dsh://locale/changed': true, 'dsh://appearance/changed': true,
      'dsh://shortcuts/changed': true, 'dsh://shortcuts/recording': true, 'dsh://shortcuts/input': true,
      'dsh://update/state': true, 'dsh://shell/window': true, 'dsh://shell/window-error': true,
      'dsh://shell/quit-confirmed': true,
      'dsh://guests/browser-open': true, 'dsh://guests/browser-state': true,
    }
    expect(Object.keys(commands)).toHaveLength(56)
    expect(Object.keys(events)).toHaveLength(12)
  })
})
