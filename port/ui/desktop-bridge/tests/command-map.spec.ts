/**
 * Exhaustive source mapping test for the typed facade (`index.ts`).
 *
 * Every other suite checks one behaviour at a time and therefore leaves the
 * question this file answers open: *does every single member of
 * {@link DshDesktopApi} travel under its declared wire name, with its declared
 * fields, in its declared form?* A facade can pass 190 focused tests while one
 * of its sixty-odd wrappers invokes the wrong `snake_case` command, forgets to
 * nest a `guest_*` struct under `request`, or subscribes to a `dsh://` event
 * that no Rust `emit` ever sends.
 *
 * The check is exhaustive by construction rather than by diligence:
 *
 * * `COMMAND_CASES` is typed `Record<CommandMember, …>` and `EVENT_CASES` is
 *   typed `Record<EventMember, DshEventName>`, where the key unions are derived
 *   from {@link DshDesktopApi} itself. Adding a member to the facade without
 *   adding its row here is a COMPILE error, and a row for a member that does
 *   not exist is an excess-property error.
 * * each row names the command as a member of {@link DshCommandName}, so a row
 *   cannot name a command the contract does not declare;
 * * the name in the row is cross-checked against the method name itself
 *   (`shellAppInfo` ⇄ `shell_app_info`), which is the naming rule the contract
 *   and the Rust `#[tauri::command]`s follow;
 * * the runtime member set of the facade object is compared with the table, so
 *   a member that is present but untested (or absent but typed) also fails.
 *
 * Both wire forms are asserted literally, because the Rust side declares them
 * differently: a `guest_*` command takes ONE `request: <Struct>` parameter, so
 * its payload is nested; every other command takes flat parameters (or none at
 * all, in which case `invoke` receives `undefined` — not `{}`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DshDesktopApi } from '../index.ts'
import type { DshCommandName, DshEventName } from '../protocol.ts'

interface ListenerRegistration {
  readonly eventId: number
  readonly handlerId: number
}

/**
 * The Tauri 2 core `plugin:event` transport, recording every non-event command
 * verbatim (`args` included, so a void command that sends `{}` is visible).
 */
function createTransportStub() {
  const listeners = new Map<string, ListenerRegistration[]>()
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = []
  const listens: { event: string; target: unknown; once: unknown }[] = []
  const unlistens: { event: string; eventId: number }[] = []
  const handlers: unknown[] = []
  let eventSequence = 0
  let handlerSequence = 0
  const globals = globalThis as unknown as Record<string, unknown>

  return {
    calls,
    listens,
    unlistens,
    handlers,
    internals: {
      async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
        if (command === 'plugin:event|listen') {
          eventSequence += 1
          listens.push({ event: String(args?.event), target: args?.target, once: args?.once })
          handlers.push(args?.handler)
          const registrations = listeners.get(String(args?.event)) ?? []
          registrations.push({ eventId: eventSequence, handlerId: Number(args?.handler) })
          listeners.set(String(args?.event), registrations)
          return eventSequence
        }
        if (command === 'plugin:event|unlisten') {
          unlistens.push({ event: String(args?.event), eventId: Number(args?.eventId) })
          return undefined
        }
        calls.push({ command, args })
        return undefined
      },
      transformCallback(callback: unknown): number {
        handlerSequence += 1
        globals[`_${handlerSequence}`] = callback
        return handlerSequence
      },
    },
  }
}

/** A method that invokes one command: not a subscription, not `available`. */
type CommandMember = {
  [K in keyof DshDesktopApi]: K extends `on${string}`
    ? never
    : DshDesktopApi[K] extends (request: never) => Promise<unknown> ? K : never
}[keyof DshDesktopApi]

/** A subscription method (`on*`). */
type EventMember = {
  [K in keyof DshDesktopApi]: K extends `on${string}` ? K : never
}[keyof DshDesktopApi]

/** One command row: the declared name, the exact `invoke` args, and the caller. */
interface CommandCase {
  readonly command: DshCommandName
  /** Exact second argument to `invoke`; `undefined` when the command declares no request. */
  readonly args: Record<string, unknown> | undefined
  readonly call: (api: DshDesktopApi) => Promise<unknown>
}

/** The naming rule both `protocol.ts` and the Rust commands follow. */
function snakeCase(member: string): string {
  return member.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

const LEASE = '5d0c1f6a-2b44-4f6e-9d31-7c8a9e0b1f22'
const BOUNDS = { x: 8, y: 16, width: 320, height: 200 }
const ADDRESS = { provider: 'openai', reference: 'OPENAI_API_KEY' }
const BINDING = { code: 'KeyP', modifiers: ['primary'] as const }
const DEFINITION = { id: 'command.palette', defaults: {} }
const CONSOLE_ENTRY = { sourceId: 'http://127.0.0.1:3080', line: 42, message: 'TypeError: x' }

/**
 * Every command member of the facade, with the exact wire form it must produce.
 *
 * Responses are irrelevant here and answered with `undefined`; the asserted
 * facts are the command name, the argument object, and that exactly ONE command
 * was invoked.
 */
const COMMAND_CASES: Readonly<Record<CommandMember, CommandCase>> = {
  shellAppInfo: { command: 'shell_app_info', args: undefined, call: api => api.shellAppInfo() },
  shellLocaleGet: { command: 'shell_locale_get', args: undefined, call: api => api.shellLocaleGet() },
  shellLocaleSet: {
    command: 'shell_locale_set', args: { preference: 'zh' },
    call: api => api.shellLocaleSet({ preference: 'zh' }),
  },
  shellLocaleApply: {
    command: 'shell_locale_apply', args: { locale: 'en' },
    call: api => api.shellLocaleApply({ locale: 'en' }),
  },
  shellWindowSetFullscreen: {
    command: 'shell_window_set_fullscreen', args: { enabled: true },
    call: api => api.shellWindowSetFullscreen({ enabled: true }),
  },
  shellWindowChromeAction: {
    command: 'shell_window_chrome_action', args: { action: 'close' },
    call: api => api.shellWindowChromeAction({ action: 'close' }),
  },
  shellWindowResizeDragging: {
    command: 'shell_window_resize_dragging', args: { direction: 'SouthEast' },
    call: api => api.shellWindowResizeDragging({ direction: 'SouthEast' }),
  },
  shellWindowToggleDevtools: {
    command: 'shell_window_toggle_devtools', args: undefined,
    call: api => api.shellWindowToggleDevtools(),
  },
  shellThemeSet: {
    command: 'shell_theme_set', args: { theme: 'dark' },
    call: api => api.shellThemeSet({ theme: 'dark' }),
  },
  shellAppearance: { command: 'shell_appearance', args: undefined, call: api => api.shellAppearance() },
  shellMenuAction: {
    command: 'shell_menu_action', args: { id: 'check_for_updates' },
    call: api => api.shellMenuAction({ id: 'check_for_updates' }),
  },
  shellOpenExternal: {
    command: 'shell_open_external', args: { url: 'https://example.com/a' },
    call: api => api.shellOpenExternal({ url: 'https://example.com/a' }),
  },
  shellClipboardWrite: {
    command: 'shell_clipboard_write', args: { text: 'copied text' },
    call: api => api.shellClipboardWrite({ text: 'copied text' }),
  },
  shellClipboardRead: { command: 'shell_clipboard_read', args: undefined, call: api => api.shellClipboardRead() },
  shellQuitRequest: { command: 'shell_quit_request', args: undefined, call: api => api.shellQuitRequest() },
  shellCloseWindow: {
    command: 'shell_close_window', args: { revision: 'rev-7' },
    call: api => api.shellCloseWindow({ revision: 'rev-7' }),
  },
  shellOnboardingSetActive: {
    command: 'shell_onboarding_set_active', args: { active: true },
    call: api => api.shellOnboardingSetActive({ active: true }),
  },
  shellShortcutsGet: {
    command: 'shell_shortcuts_get', args: { definitions: [DEFINITION] },
    call: api => api.shellShortcutsGet({ definitions: [DEFINITION] }),
  },
  shellShortcutsEdit: {
    command: 'shell_shortcuts_edit', args: { edit: { type: 'reset-all' }, revision: 'rev-7' },
    call: api => api.shellShortcutsEdit({ edit: { type: 'reset-all' }, revision: 'rev-7' }),
  },
  shellShortcutsRecording: {
    command: 'shell_shortcuts_recording', args: { active: false },
    call: api => api.shellShortcutsRecording({ active: false }),
  },
  runtimeBootReady: { command: 'runtime_boot_ready', args: undefined, call: api => api.runtimeBootReady() },
  runtimeBootFailed: {
    command: 'runtime_boot_failed', args: { message: 'host control channel closed' },
    call: api => api.runtimeBootFailed({ message: 'host control channel closed' }),
  },
  runtimeStatus: { command: 'runtime_status', args: undefined, call: api => api.runtimeStatus() },
  runtimeRestart: { command: 'runtime_restart', args: undefined, call: api => api.runtimeRestart() },
  runtimeQuitInspection: {
    command: 'runtime_quit_inspection', args: undefined,
    call: api => api.runtimeQuitInspection(),
  },
  settingsGet: {
    command: 'settings_get', args: { key: 'app.theme' },
    call: api => api.settingsGet({ key: 'app.theme' }),
  },
  settingsSet: {
    command: 'settings_set', args: { key: 'app.theme', value: 'dark' },
    call: api => api.settingsSet({ key: 'app.theme', value: 'dark' }),
  },
  settingsList: { command: 'settings_list', args: undefined, call: api => api.settingsList() },
  settingsReset: {
    command: 'settings_reset', args: { key: 'app.theme' },
    call: api => api.settingsReset({ key: 'app.theme' }),
  },
  credentialList: { command: 'credential_list', args: undefined, call: api => api.credentialList() },
  credentialHas: { command: 'credential_has', args: { ...ADDRESS }, call: api => api.credentialHas(ADDRESS) },
  credentialStore: {
    command: 'credential_store', args: { ...ADDRESS, secret: 'sk-test' },
    call: api => api.credentialStore({ ...ADDRESS, secret: 'sk-test' }),
  },
  credentialDelete: {
    command: 'credential_delete', args: { ...ADDRESS },
    call: api => api.credentialDelete(ADDRESS),
  },
  shellPickDirectory: {
    command: 'shell_pick_directory', args: { title: null, defaultPath: null },
    call: api => api.shellPickDirectory({ title: null, defaultPath: null }),
  },
  updateStatus: { command: 'update_status', args: undefined, call: api => api.updateStatus() },
  updateConfiguration: { command: 'update_configuration', args: undefined, call: api => api.updateConfiguration() },
  updateOpen: { command: 'update_open', args: undefined, call: api => api.updateOpen() },
  updateCheck: { command: 'update_check', args: undefined, call: api => api.updateCheck() },
  // The `guest_*` family declares ONE `request: <Struct>` parameter.
  guestBrowserAcquire: {
    command: 'guest_browser_acquire', args: { request: { workspace: 'cwd:C:\\work', bounds: BOUNDS } },
    call: api => api.guestBrowserAcquire({ workspace: 'cwd:C:\\work', bounds: BOUNDS }),
  },
  guestBrowserRelease: {
    command: 'guest_browser_release', args: { request: { lease: LEASE } },
    call: api => api.guestBrowserRelease({ lease: LEASE }),
  },
  guestBrowserSetBounds: {
    command: 'guest_browser_set_bounds', args: { request: { lease: LEASE, bounds: BOUNDS } },
    call: api => api.guestBrowserSetBounds({ lease: LEASE, bounds: BOUNDS }),
  },
  guestBrowserNavigate: {
    command: 'guest_browser_navigate', args: { request: { lease: LEASE, url: 'https://example.com/a' } },
    call: api => api.guestBrowserNavigate({ lease: LEASE, url: 'https://example.com/a' }),
  },
  guestBrowserCommand: {
    command: 'guest_browser_command', args: { request: { lease: LEASE, command: 'clear-history' } },
    call: api => api.guestBrowserCommand({ lease: LEASE, command: 'clear-history' }),
  },
  guestBrowserState: {
    command: 'guest_browser_state', args: { request: { lease: LEASE } },
    call: api => api.guestBrowserState({ lease: LEASE }),
  },
  guestPlatformOpen: {
    command: 'guest_platform_open', args: { request: { page: 'top-up', bounds: BOUNDS } },
    call: api => api.guestPlatformOpen({ page: 'top-up', bounds: BOUNDS }),
  },
  guestPlatformSetBounds: {
    command: 'guest_platform_set_bounds', args: { request: { bounds: BOUNDS } },
    call: api => api.guestPlatformSetBounds({ bounds: BOUNDS }),
  },
  // These two declare no request struct at all: no payload, not `{}`.
  guestPlatformClose: { command: 'guest_platform_close', args: undefined, call: api => api.guestPlatformClose() },
  guestPlatformStatus: {
    command: 'guest_platform_status', args: undefined,
    call: api => api.guestPlatformStatus(),
  },
  shellHostPaths: { command: 'shell_host_paths', args: undefined, call: api => api.shellHostPaths() },
  shellHostPathsConsume: {
    command: 'shell_host_paths_consume', args: undefined,
    call: api => api.shellHostPathsConsume(),
  },
  shellCaptionMenu: {
    command: 'shell_caption_menu', args: { name: 'edit', x: 12.5, y: 40 },
    call: api => api.shellCaptionMenu({ name: 'edit', x: 12.5, y: 40 }),
  },
  shellCaptionPalette: {
    command: 'shell_caption_palette', args: { palette: ['English', '#ffffff', '>'] },
    call: api => api.shellCaptionPalette({ palette: ['English', '#ffffff', '>'] }),
  },
  policyPresented: {
    command: 'policy_presented', args: { sequence: 3 },
    call: api => api.policyPresented({ sequence: 3 }),
  },
  policyRetry: { command: 'policy_retry', args: undefined, call: api => api.policyRetry() },
  policyUpdate: { command: 'policy_update', args: undefined, call: api => api.policyUpdate() },
  policyQuit: { command: 'policy_quit', args: undefined, call: api => api.policyQuit() },
  shellRendererConsole: {
    command: 'shell_renderer_console', args: { lines: [CONSOLE_ENTRY] },
    call: api => api.shellRendererConsole({ lines: [CONSOLE_ENTRY] }),
  },
}

/** Every subscription member and the one `dsh://` event it must listen to. */
const EVENT_CASES: Readonly<Record<EventMember, DshEventName>> = {
  onRuntimeState: 'dsh://runtime/state',
  onLocaleChanged: 'dsh://locale/changed',
  onAppearanceChanged: 'dsh://appearance/changed',
  onShortcutsChanged: 'dsh://shortcuts/changed',
  onShortcutsRecording: 'dsh://shortcuts/recording',
  onShortcutsInput: 'dsh://shortcuts/input',
  onUpdateState: 'dsh://update/state',
  onShellWindow: 'dsh://shell/window',
  onShellWindowError: 'dsh://shell/window-error',
  onShellQuitConfirmed: 'dsh://shell/quit-confirmed',
  onGuestBrowserOpen: 'dsh://guests/browser-open',
  onGuestBrowserState: 'dsh://guests/browser-state',
}

let transport: ReturnType<typeof createTransportStub>

/** Import the facade freshly against the current transport. */
async function freshDesktop(): Promise<DshDesktopApi> {
  vi.resetModules()
  vi.stubGlobal('__TAURI_INTERNALS__', transport.internals)
  return (await import('../index.ts')).desktop
}

beforeEach(() => {
  transport = createTransportStub()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('the facade exposes exactly the members this suite maps', () => {
  it('has one table row per command and per subscription, and nothing else', async () => {
    const desktop = await freshDesktop()

    expect(desktop.available, 'the fresh facade must see the live transport').toBe(true)
    expect(Object.keys(desktop).sort()).toEqual([
      'available', ...Object.keys(COMMAND_CASES), ...Object.keys(EVENT_CASES),
    ].sort())
  })
})

describe('every command travels under its declared name and wire form', () => {
  for (const [member, testCase] of Object.entries(COMMAND_CASES)) {
    it(`${member} → ${testCase.command}`, async () => {
      // The row's name is the method's own snake_case spelling: a row cannot
      // silently encode a name the naming rule does not produce.
      expect(snakeCase(member), `${member} must map to its snake_case command`).toBe(testCase.command)
      const desktop = await freshDesktop()

      await testCase.call(desktop)

      // Exactly one command, under the declared name, with the declared args —
      // `toStrictEqual` so a void command that sends `{}` instead of nothing
      // fails, and so an extra field is not ignored.
      expect(transport.calls).toStrictEqual([{ command: testCase.command, args: testCase.args }])
    })
  }
})

describe('every subscription listens to its declared event and disposes it', () => {
  for (const [member, event] of Object.entries(EVENT_CASES)) {
    it(`${member} → ${event}`, async () => {
      const desktop = await freshDesktop()
      const subscribe = desktop[member as EventMember] as (
        listener: (payload: never) => void,
      ) => Promise<() => void>

      const unlisten = await subscribe(() => undefined)

      // Tauri 2's listen payload: the declared event, the `Any` target, once:false.
      expect(transport.listens).toStrictEqual([{ event, target: { kind: 'Any' }, once: false }])
      // The handler id is a transport-minted callback id, never a literal.
      expect(typeof transport.handlers[0]).toBe('number')

      unlisten()
      await Promise.resolve()
      expect(transport.unlistens).toStrictEqual([{ event, eventId: 1 }])
    })
  }
})
