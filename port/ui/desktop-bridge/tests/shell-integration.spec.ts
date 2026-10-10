// @vitest-environment jsdom
/**
 * Shared-integration tests for the desktop bridge glue.
 *
 * These cover the behaviours a bridge *definition* cannot establish on its own,
 * each through a transport stub implementing the real Tauri 2 `plugin:event`
 * contract:
 *
 * 1. **Marker installation is real.** `installDesktopShellMarkers()` actually
 *    writes the absent TypeScript-bridge globals, and leaves every Rust-owned
 *    or already-installed one byte-for-byte identical (A11: one writer per
 *    global per run).
 * 2. **`dshDesktop.browser` and `dshPlatform` are guest-backed, not stubs.**
 *    The installed `browser.acquire` issues the real `guest_browser_acquire`
 *    command and returns the shell's lease; `openPlatformPage` issues the real
 *    `guest_platform_open`. A bridge that merely *exists* would pass a presence
 *    check and fail here.
 * 3. **The typed wiring is the documented wire form.** Every port-addition
 *    command travels under its declared snake_case name with its request fields
 *    as top-level arguments, and both guest events deliver their domain payload
 *    (never the `{event,id,payload}` envelope) to a typed listener.
 * 4. **A missing transport is a typed refusal**, not a silent no-op and not an
 *    `undefined` field read.
 * 5. **Event cleanup is real.** A subscription disposer calls
 *    `plugin:event|unlisten`; a browser-bridge popup subscription that is
 *    released inside the subscribe round trip is cancelled rather than leaked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserOpenRequestEvent, DshError, GuestBrowserState, HostPaths } from '../protocol.ts'
import type { DshDesktopApi } from '../index.ts'

interface ListenerRegistration {
  readonly eventId: number
  readonly handlerId: number
}

/**
 * Tauri 2 core `plugin:event` transport contract, driven exactly as the shell
 * does it: `transformCallback` mints handler ids, `plugin:event|listen` returns
 * an event id, and every emission hands the callback the `{event,id,payload}`
 * envelope.
 */
function createTransportStub() {
  const listeners = new Map<string, ListenerRegistration[]>()
  const unlistens: { event: string; eventId: number }[] = []
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = []
  const answers = new Map<string, unknown>()
  let eventSequence = 0
  let handlerSequence = 0
  const globals = globalThis as unknown as Record<string, unknown>

  type Answer = unknown | ((args: Record<string, unknown>) => unknown)

  return {
    calls,
    unlistens,
    /** @param command - command name. @param answer - value or producer; a thrower refuses. */
    answer(command: string, answer: Answer): void { answers.set(command, answer) },
    /** Emit one event the way the Rust `emit` path delivers it. */
    emit(event: string, payload: unknown): void {
      for (const registration of listeners.get(event) ?? []) {
        const callback = globals[`_${registration.handlerId}`]
        if (typeof callback !== 'function') continue
        ;(callback as (envelope: { event: string; id: number; payload: unknown }) => void)(
          { event, id: registration.eventId, payload },
        )
      }
    },
    /** @param event - event name. @returns how many listeners are registered for it. */
    listening(event: string): number { return (listeners.get(event) ?? []).length },
    /** @returns the arguments of the last call to one command, if any. */
    lastArgs(command: string): Record<string, unknown> | undefined {
      return [...calls].reverse().find(call => call.command === command)?.args
    },
    internals: {
      async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
        if (command === 'plugin:event|listen') {
          eventSequence += 1
          const registrations = listeners.get(String(args?.event)) ?? []
          registrations.push({ eventId: eventSequence, handlerId: Number(args?.handler) })
          listeners.set(String(args?.event), registrations)
          return eventSequence
        }
        if (command === 'plugin:event|unlisten') {
          unlistens.push({ event: String(args?.event), eventId: Number(args?.eventId) })
          listeners.set(String(args?.event),
            (listeners.get(String(args?.event)) ?? []).filter(row => row.eventId !== Number(args?.eventId)))
          return undefined
        }
        calls.push({ command, args })
        if (!answers.has(command)) {
          throw { kind: 'other', detail: { code: 'unregistered_command', message: command } }
        }
        const answer = answers.get(command)
        if (typeof answer === 'function') return (answer as (args: Record<string, unknown>) => unknown)(args ?? {})
        return answer
      },
      transformCallback(callback: unknown): number {
        handlerSequence += 1
        globals[`_${handlerSequence}`] = callback
        return handlerSequence
      },
    },
  }
}

const MARKER_NAMES = [
  '__DSH_BOOT_READY__', 'dshDesktopBoot', '__DSH_TRANSPORT__', '__DSH_HOST_PATHS__',
  '__DSH_DIRECTORY_PICKER__', '__DSH_LOCALE__', 'dshOnboarding', 'dshDesktop', 'dshPlatform',
] as const

/** Every marker this suite may install; cleared between cases so each starts bare. */
function clearMarkers(): void {
  for (const name of MARKER_NAMES) Reflect.deleteProperty(globalThis, name)
  // The DOM markers are Rust-owned and this glue never writes them, so a case
  // that sets them for its own assertions must clean up after itself.
  delete document.documentElement.dataset.platform
  document.documentElement.removeAttribute('data-windows-titlebar')
  document.documentElement.style.removeProperty('--dsh-windows-titlebar-height')
}

let transport: ReturnType<typeof createTransportStub>

beforeEach(() => {
  // Reset the module registry FIRST: the loader versions every project source by
  // a generation counter, so a module imported after this point re-evaluates
  // against whatever `__TAURI_INTERNALS__` is installed next.
  vi.resetModules()
  transport = createTransportStub()
  vi.stubGlobal('__TAURI_INTERNALS__', transport.internals)
  clearMarkers()
})

afterEach(() => {
  clearMarkers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

/**
 * Import one of this package's modules against the CURRENT transport.
 *
 * Each call site writes a literal specifier: vitest's module reset is applied to
 * a module's own `import()` expression, so a computed specifier would resolve
 * through the ordinary cache and return a module bound to an earlier transport.
 * The dependency is re-evaluated only when the loader can see the expression.
 */

/** Import the glue fresh against the current transport. */
async function freshGlue() {
  return await import('../shell-boot.ts')
}

/** Import the typed facade against the current transport. */
async function freshIndex() {
  return await import('../index.ts')
}

/** Import the guest bridges fresh against the current transport. */
async function freshGuests() {
  return await import('../guests.ts')
}

const RESERVATION = {
  lease: '3f1c0a1e-5b8f-4a5f-9e2c-6d7a8b9c0d1e',
  partition: 'dsh-sidebar-browser-9a1b2c3d',
}

const GUEST_STATE: GuestBrowserState = {
  lease: RESERVATION.lease, url: 'https://example.com/', title: 'Example', loading: false,
  canGoBack: true, canGoForward: false, gone: false, error: null,
}

describe('marker installation actually installs (A11 fill-if-absent)', () => {
  it('writes every absent TypeScript-bridge global and returns the DOM markers it read', async () => {
    // The Rust script ran first and installed its own DOM markers.
    document.documentElement.dataset.platform = 'win32'
    document.documentElement.setAttribute('data-windows-titlebar', '')
    document.documentElement.style.setProperty('--dsh-windows-titlebar-height', '40px')

    const glue = await freshGlue()
    const observed = glue.installDesktopShellMarkers()

    // The glue WROTE the absent globals (this is the difference between a
    // definition and an installation).
    expect(Reflect.get(globalThis, 'dshDesktopBoot')).toBeDefined()
    expect(Reflect.get(globalThis, '__DSH_LOCALE__')).toBeDefined()
    expect(Reflect.get(globalThis, 'dshOnboarding')).toBeDefined()
    expect(Reflect.get(globalThis, 'dshDesktop')).toBeDefined()
    // `dshPlatform` stays ABSENT: this build's guest registry admits nothing, and
    // the preserved account plugin selects its embedded document from the mere
    // presence of the global. Omitting it keeps the account Settings entry and
    // the recharge step on their `window.open` route.
    expect(Reflect.get(globalThis, 'dshPlatform')).toBeUndefined()
    // The Rust-owned DOM markers were read and left exactly as installed.
    expect(observed).toEqual({ platform: 'win32', windowsTitlebar: true })
    expect(document.documentElement.dataset.platform).toBe('win32')
    expect(document.documentElement.style.getPropertyValue('--dsh-windows-titlebar-height')).toBe('40px')
    // Rust-owned globals stay absent: this glue never writes them.
    expect(Reflect.get(globalThis, '__DSH_HOST_PATHS__')).toBeUndefined()
  })

  it('installs an explicitly supplied Platform bridge with its three upstream members', async () => {
    const glue = await freshGlue()
    const { desktop } = await freshIndex()
    const { createGuestPlatformBridge } = await freshGuests()
    glue.installDesktopShellMarkers(desktop, { platform: createGuestPlatformBridge() })

    const platform = Reflect.get(globalThis, 'dshPlatform') as Record<string, unknown>
    expect(typeof platform.open).toBe('function')
    expect(typeof platform.setBounds).toBe('function')
    expect(typeof platform.close).toBe('function')
    // Exactly upstream's three members, no geometry or lifecycle extras.
    expect(Object.keys(platform).sort()).toEqual(['close', 'open', 'setBounds'])
  })

  it('never overwrites a marker the Rust script already installed (object identity)', async () => {
    const rustBoot = { ready: async () => ({ injections: [], streamBaseUrl: '' }), failed: async () => undefined }
    const rustProduct = { protocolVersion: 1 as const }
    const rustPlatform = { open: async () => undefined, setBounds: async () => undefined, close: async () => undefined }
    const rustHostPaths = { pathFor: () => 'C:\\native\\x.txt' }
    const rustPicker = { pick: async () => 'C:\\native' }
    Reflect.set(globalThis, 'dshDesktopBoot', rustBoot)
    Reflect.set(globalThis, 'dshDesktop', rustProduct)
    Reflect.set(globalThis, 'dshPlatform', rustPlatform)
    Reflect.set(globalThis, '__DSH_HOST_PATHS__', rustHostPaths)
    Reflect.set(globalThis, '__DSH_DIRECTORY_PICKER__', rustPicker)

    await freshGlue()

    expect(Reflect.get(globalThis, 'dshDesktopBoot')).toBe(rustBoot)
    expect(Reflect.get(globalThis, 'dshDesktop')).toBe(rustProduct)
    expect(Reflect.get(globalThis, 'dshPlatform')).toBe(rustPlatform)
    expect(Reflect.get(globalThis, '__DSH_HOST_PATHS__')).toBe(rustHostPaths)
    expect(Reflect.get(globalThis, '__DSH_DIRECTORY_PICKER__')).toBe(rustPicker)
  })

  it('installs nothing at all outside the desktop shell', async () => {
    vi.unstubAllGlobals()
    vi.resetModules()
    // The document still carries a Rust-installed platform marker from an
    // earlier case; only the globals are under test here, so the DOM read is
    // not asserted beyond the globals staying absent.
    await freshGlue()
    for (const name of MARKER_NAMES) {
      expect(Reflect.get(globalThis, name), name).toBeUndefined()
    }
  })
})

describe('browser activation is explicit until its retained consumer is composed', () => {
  it('omits browser by default so retained Sidebar does not construct an Electron element', async () => {
    await freshGlue()
    const product = Reflect.get(globalThis, 'dshDesktop')
    expect(product.browser).toBeUndefined()
    expect(product.keyboard).toBeDefined()
    expect(product.shortcuts).toBeDefined()
    expect(product.updates).toBeDefined()
    expect(transport.calls.some(call => call.command === 'guest_browser_acquire')).toBe(false)
  })
  it('an explicitly composed browser facade issues the guest command and returns the lease', async () => {
    transport.answer('guest_browser_acquire', RESERVATION)
    const glue = await freshGlue()
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    const { desktop } = await freshIndex()
    const { createGuestBrowserBridge } = await freshGuests()
    glue.installDesktopShellMarkers(desktop, { browser: createGuestBrowserBridge() })
    const product = Reflect.get(globalThis, 'dshDesktop') as { browser: { acquire(w: string): Promise<unknown> } }

    await expect(product.browser.acquire('cwd:C:\\work')).resolves.toEqual(RESERVATION)

    const request = transport.lastArgs('guest_browser_acquire')?.request as Record<string, unknown>
    expect(request.workspace).toBe('cwd:C:\\work')
    // A guest is created hidden until the presentation places it.
    expect(request.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('a shell that refuses guest creation reaches the caller as the ratified refusal', async () => {
    transport.answer('guest_browser_acquire', () => {
      throw { kind: 'other', detail: { code: 'browser_guest_unavailable', message: 'no guest surface' } }
    })
    const glue = await freshGlue()
    Reflect.deleteProperty(globalThis, 'dshDesktop')
    const { desktop } = await freshIndex()
    const { createGuestBrowserBridge } = await freshGuests()
    glue.installDesktopShellMarkers(desktop, { browser: createGuestBrowserBridge() })
    const product = Reflect.get(globalThis, 'dshDesktop') as { browser: { acquire(w: string): Promise<unknown> } }

    await expect(product.browser.acquire('cwd:C:\\work')).rejects.toMatchObject({
      kind: 'other', detail: { code: 'browser_guest_unavailable' },
    })
  })

  it('an explicitly supplied Platform bridge issues the real Platform guest command', async () => {
    transport.answer('guest_platform_open', undefined)
    const glue = await freshGlue()
    const { desktop } = await freshIndex()
    const { createGuestPlatformBridge } = await freshGuests()
    glue.installDesktopShellMarkers(desktop, { platform: createGuestPlatformBridge() })
    const platform = Reflect.get(globalThis, 'dshPlatform') as {
      open(page: string, bounds: { x: number; y: number; width: number; height: number }): Promise<void>
    }

    await platform.open('usage', { x: 120, y: 64, width: 480, height: 720 })

    const request = transport.lastArgs('guest_platform_open')?.request as Record<string, unknown>
    expect(request.page).toBe('usage')
    expect(request.bounds).toEqual({ x: 120, y: 64, width: 480, height: 720 })
  })

  it('an explicitly supplied Platform bridge forwards setBounds and close unchanged', async () => {
    transport.answer('guest_platform_set_bounds', undefined)
    transport.answer('guest_platform_close', undefined)
    const glue = await freshGlue()
    const { desktop } = await freshIndex()
    const { createGuestPlatformBridge } = await freshGuests()
    glue.installDesktopShellMarkers(desktop, { platform: createGuestPlatformBridge() })
    const platform = Reflect.get(globalThis, 'dshPlatform') as {
      setBounds(b: { x: number; y: number; width: number; height: number }): Promise<void>
      close(): Promise<void>
    }

    await platform.setBounds({ x: 1, y: 2, width: 3, height: 4 })
    await platform.close()

    expect(transport.lastArgs('guest_platform_set_bounds')?.request).toEqual({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
    })
    expect(transport.calls.some(call => call.command === 'guest_platform_close')).toBe(true)
  })
})

describe('typed wiring uses the declared wire names and field spelling', () => {
  /**
   * Every port-addition command with the arguments a caller supplies and the
   * exact invoke payload the shell expects.
   *
   * The two wire forms are both present, because the Rust side declares both:
   * a `guest_*` command takes ONE `request: <Struct>` parameter, so its payload
   * is nested under `request`; `shell_caption_menu` and
   * `shell_renderer_console` take flat parameters.
   */
  const CASES: readonly { command: string; call(api: DshDesktopApi): Promise<unknown>; invoke: unknown }[] = [
    {
      command: 'guest_browser_release',
      call: api => api.guestBrowserRelease({ lease: RESERVATION.lease }),
      invoke: { request: { lease: RESERVATION.lease } },
    },
    {
      command: 'guest_browser_set_bounds',
      call: api => api.guestBrowserSetBounds({ lease: RESERVATION.lease, bounds: { x: 8, y: 8, width: 300, height: 200 } }),
      invoke: { request: { lease: RESERVATION.lease, bounds: { x: 8, y: 8, width: 300, height: 200 } } },
    },
    {
      command: 'guest_browser_navigate',
      call: api => api.guestBrowserNavigate({ lease: RESERVATION.lease, url: 'https://example.com/' }),
      invoke: { request: { lease: RESERVATION.lease, url: 'https://example.com/' } },
    },
    {
      command: 'guest_browser_command',
      call: api => api.guestBrowserCommand({ lease: RESERVATION.lease, command: 'clear-history' }),
      invoke: { request: { lease: RESERVATION.lease, command: 'clear-history' } },
    },
    {
      command: 'guest_platform_set_bounds',
      call: api => api.guestPlatformSetBounds({ bounds: { x: 0, y: 0, width: 900, height: 600 } }),
      invoke: { request: { bounds: { x: 0, y: 0, width: 900, height: 600 } } },
    },
    {
      command: 'shell_caption_menu',
      call: api => api.shellCaptionMenu({ name: 'application', x: 12.5, y: 40 }),
      invoke: { name: 'application', x: 12.5, y: 40 },
    },
    {
      command: 'shell_renderer_console',
      call: api => api.shellRendererConsole({
        lines: [{ sourceId: 'http://127.0.0.1:3080', line: 42, message: 'TypeError: x' }],
      }),
      invoke: { lines: [{ sourceId: 'http://127.0.0.1:3080', line: 42, message: 'TypeError: x' }] },
    },
  ]

  for (const testCase of CASES) {
    it(`${testCase.command} travels under its contract name with the declared fields`, async () => {
      transport.answer(testCase.command, undefined)
      const { desktop } = await freshIndex()
      expect(desktop.available, 'the fresh facade must see the live transport').toBe(true)
      await testCase.call(desktop)
      expect(transport.lastArgs(testCase.command)).toEqual(testCase.invoke)
    })
  }

  it('the void commands send no request payload', async () => {
    transport.answer('guest_platform_close', undefined)
    transport.answer('guest_platform_status', true)
    transport.answer('shell_host_paths_consume', undefined)
    const { desktop } = await freshIndex()

    await expect(desktop.guestPlatformClose()).resolves.toBeUndefined()
    await expect(desktop.guestPlatformStatus()).resolves.toBe(true)
    await expect(desktop.shellHostPathsConsume()).resolves.toBeUndefined()

    for (const command of ['guest_platform_close', 'guest_platform_status', 'shell_host_paths_consume']) {
      expect(transport.lastArgs(command), command).toBeUndefined()
    }
  })

  it('guest_browser_state returns the shell observation with its camelCase fields', async () => {
    transport.answer('guest_browser_state', GUEST_STATE)
    const { desktop } = await freshIndex()

    const state = await desktop.guestBrowserState({ lease: RESERVATION.lease })

    expect(state).toEqual(GUEST_STATE)
    expect(state.canGoBack).toBe(true)
    expect(transport.lastArgs('guest_browser_state')).toEqual({ request: { lease: RESERVATION.lease } })
  })

  it('shell_host_paths returns the adopted batch the shell observed', async () => {
    const paths: HostPaths = { paths: ['C:\\drop\\a.txt'], consumed: false }
    transport.answer('shell_host_paths', paths)
    const { desktop } = await freshIndex()

    await expect(desktop.shellHostPaths()).resolves.toEqual(paths)
    expect(transport.lastArgs('shell_host_paths')).toBeUndefined()
  })
})

describe('guest events deliver typed domain payloads and clean up', () => {
  it('onGuestBrowserOpen delivers the payload, never the envelope', async () => {
    const { desktop } = await freshIndex()
    const seen: BrowserOpenRequestEvent[] = []
    await desktop.onGuestBrowserOpen(event => seen.push(event))

    const payload: BrowserOpenRequestEvent = { lease: RESERVATION.lease, url: 'https://example.com/b' }
    transport.emit('dsh://guests/browser-open', payload)

    expect(seen).toEqual([payload])
    expect(seen[0]?.url).toBe('https://example.com/b')
    // A field read must not be `undefined` through an envelope.
    expect(Object.hasOwn(seen[0] as object, 'payload')).toBe(false)
  })

  it('onGuestBrowserState delivers the observation with its typed members', async () => {
    const { desktop } = await freshIndex()
    const seen: GuestBrowserState[] = []
    await desktop.onGuestBrowserState(state => seen.push(state))

    transport.emit('dsh://guests/browser-state', GUEST_STATE)

    expect(seen).toEqual([GUEST_STATE])
    expect(seen[0]?.lease).toBe(RESERVATION.lease)
    expect(seen[0]?.error).toBeNull()
  })

  it('the disposer unlistens through the event plugin', async () => {
    const { desktop } = await freshIndex()
    const seen: GuestBrowserState[] = []
    const unlisten = await desktop.onGuestBrowserState(state => seen.push(state))

    transport.emit('dsh://guests/browser-state', GUEST_STATE)
    unlisten()
    transport.emit('dsh://guests/browser-state', { ...GUEST_STATE, url: 'https://example.com/late' })
    await Promise.resolve()

    expect(seen).toHaveLength(1)
    expect(transport.unlistens).toEqual([{ event: 'dsh://guests/browser-state', eventId: 1 }])
    expect(transport.listening('dsh://guests/browser-state')).toBe(0)
  })

  it('a window failure is its own channel and never fabricates a presentation state', async () => {
    const { desktop } = await freshIndex()
    const states: { state: string }[] = []
    const errors: DshError[] = []
    await desktop.onShellWindow(state => states.push(state))
    await desktop.onShellWindowError(error => errors.push(error))

    transport.emit('dsh://shell/window', { state: 'shown' })
    // The shell refused the hide: the failure arrives on its own event, and the
    // last observed presentation state stays `shown` rather than becoming a
    // `hidden` the shell never reported.
    transport.emit('dsh://shell/window-error', {
      kind: 'other', detail: { code: 'window_hide_denied', message: 'policy denied' },
    })
    transport.emit('dsh://shell/window', { state: 'focused' })

    expect(errors).toEqual([{
      kind: 'other', detail: { code: 'window_hide_denied', message: 'policy denied' },
    }])
    expect(states).toEqual([{ state: 'shown' }, { state: 'focused' }])
    // The failure carries no presentation state at all.
    expect(Object.hasOwn(errors[0] as object, 'state')).toBe(false)
  })

  it('releasing a guest inside the subscribe round trip cancels the popup subscription', async () => {
    transport.answer('guest_browser_acquire', RESERVATION)
    transport.answer('guest_browser_release', undefined)
    const { createGuestBrowserBridge } = await freshGuests()
    const bridge = createGuestBrowserBridge()

    // One listener is registered, so the popup subscription startsâ€¦
    const stop = bridge.onOpenRequested('lease-1', () => undefined)
    // â€¦and is released before the asynchronous `plugin:event|listen` resolves.
    stop()
    await bridge.release('lease-1').catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()

    // Nothing is left registered for the event.
    expect(transport.listening('dsh://guests/browser-open')).toBe(0)
  })
})

describe('a missing transport is a typed refusal', () => {
  it('every port-addition command throws not_desktop outside the shell', async () => {
    vi.unstubAllGlobals()
    // The generation must move on its own: without a bump, this import would
    // resolve to the URL an earlier case already loaded with a live transport.
    vi.resetModules()
    const { desktop, NotDesktopError } = await freshIndex()

    expect(desktop.available).toBe(false)
    const calls: Promise<unknown>[] = [
      desktop.guestBrowserAcquire({ workspace: 'w', bounds: { x: 0, y: 0, width: 0, height: 0 } }),
      desktop.guestBrowserRelease({ lease: 'l' }),
      desktop.guestBrowserSetBounds({ lease: 'l', bounds: { x: 0, y: 0, width: 0, height: 0 } }),
      desktop.guestBrowserNavigate({ lease: 'l', url: 'https://example.com/' }),
      desktop.guestBrowserCommand({ lease: 'l', command: 'reload' }),
      desktop.guestBrowserState({ lease: 'l' }),
      desktop.guestPlatformOpen({ page: 'usage', bounds: { x: 0, y: 0, width: 0, height: 0 } }),
      desktop.guestPlatformSetBounds({ bounds: { x: 0, y: 0, width: 0, height: 0 } }),
      desktop.guestPlatformClose(),
      desktop.guestPlatformStatus(),
      desktop.shellHostPaths(),
      desktop.shellHostPathsConsume(),
      desktop.shellCaptionMenu({ name: 'edit', x: 0, y: 0 }),
      desktop.shellRendererConsole({ lines: [] }),
    ]
    for (const call of calls) {
      await expect(call).rejects.toBeInstanceOf(NotDesktopError)
    }
  })

  it('the guest event subscriptions refuse outside the shell instead of hanging', async () => {
    vi.unstubAllGlobals()
    vi.resetModules()
    const { desktop, NotDesktopError } = await freshIndex()

    await expect(desktop.onGuestBrowserOpen(() => undefined)).rejects.toBeInstanceOf(NotDesktopError)
    await expect(desktop.onGuestBrowserState(() => undefined)).rejects.toBeInstanceOf(NotDesktopError)
  })

  it('the glue installs no guest bridge when the desktop transport is absent', async () => {
    vi.unstubAllGlobals()
    vi.resetModules()
    const glue = await freshGlue()

    // `installDesktopShellMarkers` returns the (empty) DOM marker read, and the
    // product globals stay absent: no half-installed bridge.
    expect(glue.installDesktopShellMarkers()).toEqual({ windowsTitlebar: false })
    expect(Reflect.get(globalThis, 'dshPlatform')).toBeUndefined()
    expect(Reflect.get(globalThis, 'dshDesktop')).toBeUndefined()
    // No command was attempted.
    expect(transport.calls).toEqual([])
  })
})
