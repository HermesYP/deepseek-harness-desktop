// @vitest-environment jsdom
/**
 * Regression tests for the native guest bridges
 * (`port/ui/desktop-bridge/guests.ts`).
 *
 * These are the behaviours the audit's lane-G gate names, each asserted against
 * a transport stub implementing the real Tauri 2 `plugin:event` contract:
 *
 * * a shell with no guest commands refuses with the ratified machine code — the
 *   bridge is never an iframe and never a silent no-op;
 * * `acquire` returns the shell's lease and partition verbatim and never
 *   fabricates one;
 * * a popup approved by the shell reaches only the listener registered for that
 *   lease (never another tab's), and a malformed emission is dropped;
 * * `release` drops the lease's listeners even when the shell refuses, so a late
 *   popup cannot reach a disposed page;
 * * the Platform bridge sends exactly the three upstream `PlatformBridge`
 *   operations with the caller's rectangle untouched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BROWSER_GUEST_UNAVAILABLE, GUEST_BROWSER_OPEN_EVENT, GUEST_BROWSER_STATE_EVENT,
  PLATFORM_VIEW_UNAVAILABLE, createGuestBrowserBridge, createGuestPlatformBridge,
  createNativeGuestNavigation, createUnavailableBrowserBridge, guestRefusalCode,
  platformViewIsOpen, readStateEvent, setGuestBounds,
} from '../guests.ts'
import type { DesktopBrowserLeaseId } from '../markers.ts'

interface ListenerRegistration {
  readonly eventId: number
  readonly handlerId: number
}

/** Tauri 2 core `plugin:event` transport contract plus a guest command table. */
function createTransportStub() {
  const listeners = new Map<string, ListenerRegistration[]>()
  const commands = new Map<string, unknown>()
  const calls: { command: string; args: Record<string, unknown> | undefined }[] = []
  let eventSequence = 0
  let handlerSequence = 0
  const globals = globalThis as unknown as Record<string, unknown>

  const stub = {
    calls,
    /**
     * Answer one guest command, recording it.
     * @param command - command name.
     * @param answer - value returned, or a function producing it (throwing to
     *   simulate a shell refusal). `undefined` is a valid answer for a `void`
     *   command, so answers are stored in a Map and matched with `has`.
     */
    answer(command: string, answer: unknown | ((args: Record<string, unknown>) => unknown)): void {
      commands.set(command, answer)
    },
    /** Emit one event as the Rust `emit` path delivers it (with the envelope). */
    emit(event: string, payload: unknown): void {
      for (const registration of listeners.get(event) ?? []) {
        const callback = globals[`_${registration.handlerId}`]
        if (typeof callback !== 'function') continue
        ;(callback as (envelope: { event: string; id: number; payload: unknown }) => void)(
          { event, id: registration.eventId, payload },
        )
      }
    },
    /** Whether any listener is registered for one event. */
    listening(event: string): number {
      return (listeners.get(event) ?? []).length
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
          listeners.set(String(args?.event),
            (listeners.get(String(args?.event)) ?? []).filter(row => row.eventId !== Number(args?.eventId)))
          return undefined
        }
        calls.push({ command, args })
        // `has`, not a truthiness check: a `void` command's legitimate answer IS
        // `undefined`, so an undefined value must not mean "unanswered".
        if (!commands.has(command)) {
          throw { kind: 'other', detail: { code: 'unknown_guest_command', message: command } }
        }
        const answer = commands.get(command)
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
  return stub
}

let transport: ReturnType<typeof createTransportStub>
let savedInternals: unknown

beforeEach(() => {
  transport = createTransportStub()
  const globals = globalThis as unknown as Record<string, unknown>
  savedInternals = globals.__TAURI_INTERNALS__
  globals.__TAURI_INTERNALS__ = transport.internals
})

afterEach(() => {
  const globals = globalThis as unknown as Record<string, unknown>
  if (savedInternals === undefined) delete globals.__TAURI_INTERNALS__
  else globals.__TAURI_INTERNALS__ = savedInternals
  vi.restoreAllMocks()
})

const RESERVATION = { lease: 'lease-1', partition: 'dsh-sidebar-browser-0000000000000000' }

describe('guest browser bridge', () => {
  it('returns the shell-issued lease and partition verbatim', async () => {
    transport.answer('guest_browser_acquire', RESERVATION)
    const bridge = createGuestBrowserBridge()
    await expect(bridge.acquire('cwd:C:\\work')).resolves.toEqual(RESERVATION)
    expect(transport.calls.at(-1)?.command).toBe('guest_browser_acquire')
    const request = transport.calls.at(-1)?.args?.request as Record<string, unknown>
    expect(request.workspace).toBe('cwd:C:\\work')
    // A guest is created hidden; the presentation places it.
    expect(request.bounds).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('refuses a malformed reservation instead of fabricating a guest', async () => {
    transport.answer('guest_browser_acquire', { lease: 'lease-1' })
    const bridge = createGuestBrowserBridge()
    await expect(bridge.acquire('cwd:C:\\work')).rejects.toMatchObject({
      kind: 'other', detail: { code: 'guest_protocol' },
    })
    transport.answer('guest_browser_acquire', { lease: 7, partition: 'p' })
    await expect(bridge.acquire('cwd:C:\\work')).rejects.toMatchObject({
      kind: 'other', detail: { code: 'guest_protocol' },
    })
  })

  it('routes an approved popup only to the listener of that lease', async () => {
    transport.answer('guest_browser_acquire', RESERVATION)
    const bridge = createGuestBrowserBridge()
    const mine = vi.fn()
    const other = vi.fn()
    const stopMine = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, mine)
    const stopOther = bridge.onOpenRequested('lease-2' as DesktopBrowserLeaseId, other)
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })

    transport.emit(GUEST_BROWSER_OPEN_EVENT, { lease: 'lease-1', url: 'https://example.com/next' })
    expect(mine).toHaveBeenCalledExactlyOnceWith('https://example.com/next')
    expect(other).not.toHaveBeenCalled()

    transport.emit(GUEST_BROWSER_OPEN_EVENT, { lease: 'lease-9', url: 'https://example.com/orphan' })
    expect(mine).toHaveBeenCalledTimes(1)
    expect(other).not.toHaveBeenCalled()
    stopMine()
    stopOther()
  })

  it('drops a malformed popup emission rather than forwarding it', async () => {
    const bridge = createGuestBrowserBridge()
    const listener = vi.fn()
    const stop = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, listener)
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })

    for (const payload of [null, 'x', { lease: 'lease-1' }, { url: 'https://example.com' }, { lease: '', url: 'https://example.com' }]) {
      transport.emit(GUEST_BROWSER_OPEN_EVENT, payload)
    }
    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it('contains a throwing listener instead of stranding the others', async () => {
    const bridge = createGuestBrowserBridge()
    const boom = vi.fn(() => { throw new Error('listener exploded') })
    const after = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stopBoom = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, boom)
    const stopAfter = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, after)
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })

    transport.emit(GUEST_BROWSER_OPEN_EVENT, { lease: 'lease-1', url: 'https://example.com/a' })
    expect(boom).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(1)
    stopBoom()
    stopAfter()
  })

  it('drops a released lease listeners even when the shell refuses the release', async () => {
    transport.answer('guest_browser_release', () => {
      throw { kind: 'other', detail: { code: 'guest_unavailable_now', message: 'gone' } }
    })
    const bridge = createGuestBrowserBridge()
    const listener = vi.fn()
    bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, listener)
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })

    await expect(bridge.release('lease-1' as DesktopBrowserLeaseId)).rejects.toMatchObject({
      kind: 'other',
    })
    transport.emit(GUEST_BROWSER_OPEN_EVENT, { lease: 'lease-1', url: 'https://example.com/late' })
    expect(listener).not.toHaveBeenCalled()
  })

  it('stops subscribing once the last lease is released', async () => {
    transport.answer('guest_browser_release', undefined)
    const bridge = createGuestBrowserBridge()
    const stop = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, vi.fn())
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })
    await bridge.release('lease-1' as DesktopBrowserLeaseId)
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(0) })
    stop()
  })
})

/**
 * Wrap the shared transport so the next `refuse` `plugin:event|listen` calls
 * reject, counting every attempt the bridge makes.
 *
 * A subscription that is refused is the case a bridge most plausibly gets
 * wrong: it can retry forever, give up after the first refusal, or leave the
 * demand registered against a subscription that was never established.
 * @param refuse - how many listen attempts fail before the transport recovers.
 * @returns the attempt/refusal counter for assertions.
 */
function refuseEventListens(refuse: number) {
  const state = { attempts: 0, refusals: 0 }
  const internals = {
    ...transport.internals,
    async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
      if (command !== 'plugin:event|listen') return transport.internals.invoke(command, args)
      state.attempts += 1
      if (state.refusals < refuse) {
        state.refusals += 1
        throw { kind: 'other', detail: { code: 'event_transport_unavailable', message: 'no event transport' } }
      }
      return transport.internals.invoke(command, args)
    },
  }
  ;(globalThis as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = internals
  return state
}

describe('guest popup subscription (bounded retry and rejection safety)', () => {
  it('retries a refused subscription up to the configured attempts, reporting each refusal', async () => {
    const failures: unknown[] = []
    const gate = refuseEventListens(3)
    const bridge = createGuestBrowserBridge({
      maxAttempts: 3, delayMs: 0, onEventTransportFailure: error => failures.push(error),
    })
    const stop = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, vi.fn())

    await vi.waitFor(() => { expect(failures).toHaveLength(3) })
    // The budget is spent: exactly three attempts, and nothing registered
    // against a subscription that was never established.
    await new Promise(resolve => { setTimeout(resolve, 5) })
    expect(gate.attempts).toBe(3)
    expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(0)
    stop()
  })

  it('re-arms the retry budget when a later demand arrives', async () => {
    const failures: unknown[] = []
    const gate = refuseEventListens(3)
    const bridge = createGuestBrowserBridge({
      maxAttempts: 3, delayMs: 0, onEventTransportFailure: error => failures.push(error),
    })
    const stop = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, vi.fn())
    await vi.waitFor(() => { expect(failures).toHaveLength(3) })

    // The transport recovered. A later demand — here `acquire`, which also
    // demands the popup subscription — must establish it rather than join a
    // subscription that does not exist.
    transport.answer('guest_browser_acquire', RESERVATION)
    await bridge.acquire('cwd:C:\\work')
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })
    expect(gate.attempts).toBe(4)
    stop()
  })

  it('stops retrying when the last listener goes away during the retry window', async () => {
    const failures: unknown[] = []
    const gate = refuseEventListens(3)
    const bridge = createGuestBrowserBridge({
      maxAttempts: 3, delayMs: 1000, onEventTransportFailure: error => failures.push(error),
    })
    const stop = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, vi.fn())
    await vi.waitFor(() => { expect(failures).toHaveLength(1) })

    // The demand disappears while a retry is scheduled; the timer goes with it.
    stop()
    await new Promise(resolve => { setTimeout(resolve, 30) })
    expect(gate.attempts).toBe(1)
    expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(0)
  })

  it('contains a throwing failure hook and still retries the subscription', async () => {
    const gate = refuseEventListens(1)
    const bridge = createGuestBrowserBridge({
      maxAttempts: 2,
      delayMs: 0,
      onEventTransportFailure: () => { throw new Error('reporter exploded') },
    })
    const stop = bridge.onOpenRequested('lease-1' as DesktopBrowserLeaseId, vi.fn())

    // The first refusal is reported by a hook that throws; the demand still gets
    // its second attempt, which establishes the subscription.
    await vi.waitFor(() => { expect(transport.listening(GUEST_BROWSER_OPEN_EVENT)).toBe(1) })
    expect(gate.attempts).toBe(2)
    stop()
  })
})

describe('guest navigation commands', () => {
  it('sends a real navigate command instead of simulating history', async () => {
    transport.answer('guest_browser_navigate', undefined)
    const navigation = createNativeGuestNavigation()
    await navigation.navigate('lease-1' as DesktopBrowserLeaseId, 'https://example.com/a')
    expect(transport.calls.at(-1)?.command).toBe('guest_browser_navigate')
    expect(transport.calls.at(-1)?.args?.request).toEqual({
      lease: 'lease-1', url: 'https://example.com/a',
    })
  })

  it('maps every navigation verb to its own command value', async () => {
    transport.answer('guest_browser_command', undefined)
    const navigation = createNativeGuestNavigation()
    await navigation.command('lease-1' as DesktopBrowserLeaseId, 'back')
    await navigation.command('lease-1' as DesktopBrowserLeaseId, 'forward')
    await navigation.command('lease-1' as DesktopBrowserLeaseId, 'reload')
    await navigation.command('lease-1' as DesktopBrowserLeaseId, 'clear-history')
    expect(transport.calls.map(call => call.args?.request)).toEqual([
      { lease: 'lease-1', command: 'back' },
      { lease: 'lease-1', command: 'forward' },
      { lease: 'lease-1', command: 'reload' },
      { lease: 'lease-1', command: 'clear-history' },
    ])
  })

  it('reads the guest document from the shell and validates the answer', async () => {
    transport.answer('guest_browser_state', {
      lease: 'lease-1', url: 'https://example.com/a', title: 'A', loading: true,
      canGoBack: true, canGoForward: false, gone: false, error: null,
    })
    const navigation = createNativeGuestNavigation()
    await expect(navigation.state('lease-1' as DesktopBrowserLeaseId)).resolves.toEqual({
      lease: 'lease-1', url: 'https://example.com/a', title: 'A', loading: true,
      canGoBack: true, canGoForward: false, gone: false, error: null,
    })

    transport.answer('guest_browser_state', { url: 'https://example.com/a' })
    await expect(navigation.state('lease-1' as DesktopBrowserLeaseId)).rejects.toMatchObject({
      kind: 'other', detail: { code: 'guest_protocol' },
    })
  })

  it('refuses a partial observation instead of completing it with settled defaults', async () => {
    // The shell's own state struct carries all eight fields, and its producer
    // (`guests/observation.rs`) only ever publishes a document it observed. A
    // payload that omits `loading`/`canGoBack`/`canGoForward`/`error` is
    // therefore not evidence that the guest settled, so it is dropped rather
    // than defaulted — the exact fabrication this reader must not perform.
    const navigation = createNativeGuestNavigation()
    const complete = {
      lease: 'lease-1', url: 'https://example.com/a', title: 'A', loading: false,
      canGoBack: false, canGoForward: false, gone: false, error: null,
    }
    for (const partial of [
      { ...complete, loading: undefined },
      { ...complete, canGoBack: undefined },
      { ...complete, canGoForward: undefined },
      { ...complete, gone: undefined },
      { ...complete, error: undefined },
      { ...complete, url: 7 },
      { ...complete, error: { code: 'nope', description: 1 } },
      { ...complete, error: 'failed' },
    ]) {
      transport.answer('guest_browser_state', partial)
      await expect(navigation.state('lease-1' as DesktopBrowserLeaseId))
        .rejects.toMatchObject({ kind: 'other', detail: { code: 'guest_protocol' } })
    }

    // The complete observation (including the explicit `null` that means "no
    // failure") is the one accepted form.
    transport.answer('guest_browser_state', complete)
    await expect(navigation.state('lease-1' as DesktopBrowserLeaseId)).resolves.toEqual(complete)
  })

  it('refuses an empty lease before it reaches the shell', async () => {
    transport.answer('guest_browser_navigate', undefined)
    const navigation = createNativeGuestNavigation()
    await expect(navigation.navigate('' as DesktopBrowserLeaseId, 'https://example.com/a'))
      .rejects.toMatchObject({ kind: 'other', detail: { code: 'guest_protocol' } })
    expect(transport.calls).toHaveLength(0)
  })

  it('delivers only well-formed guest state reports to subscribers', async () => {
    const navigation = createNativeGuestNavigation()
    const states: unknown[] = []
    const stop = await navigation.onState(state => { states.push(state) })

    transport.emit(GUEST_BROWSER_STATE_EVENT, {
      lease: 'lease-1', url: 'https://example.com/a', title: 'A', loading: false,
      canGoBack: false, canGoForward: false, gone: false,
      error: { code: -105, description: 'ERR_NAME_NOT_RESOLVED' },
    })
    transport.emit(GUEST_BROWSER_STATE_EVENT, { lease: '', url: 'https://example.com/a' })
    transport.emit(GUEST_BROWSER_STATE_EVENT, null)

    expect(states).toHaveLength(1)
    expect(readStateEvent(states[0])?.error).toEqual({ code: -105, description: 'ERR_NAME_NOT_RESOLVED' })
    stop()
  })

  it('sends the placement command the presentation adapter calls', async () => {
    transport.answer('guest_browser_set_bounds', undefined)
    await setGuestBounds('lease-1' as DesktopBrowserLeaseId, { x: 1, y: 2, width: 3, height: 4 })
    expect(transport.calls.at(-1)?.command).toBe('guest_browser_set_bounds')
    expect(transport.calls.at(-1)?.args?.request).toEqual({
      lease: 'lease-1', bounds: { x: 1, y: 2, width: 3, height: 4 },
    })
  })
})

describe('unavailable guest bridge', () => {
  it('refuses every member with the ratified machine code', async () => {
    const bridge = createUnavailableBrowserBridge()
    await expect(bridge.acquire('cwd:A')).rejects.toMatchObject({
      kind: 'other', detail: { code: BROWSER_GUEST_UNAVAILABLE },
    })
    await expect(bridge.release('l' as DesktopBrowserLeaseId)).rejects.toMatchObject({
      kind: 'other', detail: { code: BROWSER_GUEST_UNAVAILABLE },
    })
    expect(() => bridge.onOpenRequested('l' as DesktopBrowserLeaseId, vi.fn()))
      .toThrowError(expect.objectContaining({ kind: 'other' }))
    expect(guestRefusalCode({ kind: 'other', detail: { code: BROWSER_GUEST_UNAVAILABLE, message: '' } }))
      .toBe(BROWSER_GUEST_UNAVAILABLE)
  })

  it('never resolves a lease without a backing view', async () => {
    const bridge = createUnavailableBrowserBridge()
    await expect(bridge.acquire('cwd:A')).rejects.toBeDefined()
    expect(transport.calls).toHaveLength(0)
  })
})

describe('platform bridge', () => {
  it('sends the three upstream operations with the caller rectangle untouched', async () => {
    transport.answer('guest_platform_open', undefined)
    transport.answer('guest_platform_set_bounds', undefined)
    transport.answer('guest_platform_close', undefined)
    const bridge = createGuestPlatformBridge()
    const bounds = { x: 12.4, y: 8.6, width: 640.5, height: 480.4 }

    await bridge.open('top-up', bounds)
    await bridge.setBounds(bounds)
    await bridge.close()

    expect(transport.calls.map(call => call.command)).toEqual([
      'guest_platform_open', 'guest_platform_set_bounds', 'guest_platform_close',
    ])
    expect(transport.calls[0]?.args?.request).toEqual({ page: 'top-up', bounds })
    expect(transport.calls[1]?.args?.request).toEqual({ bounds })
  })

  it('propagates a platform refusal instead of reporting success', async () => {
    transport.answer('guest_platform_open', () => {
      throw { kind: 'other', detail: { code: 'platform_account_unavailable', message: 'no session' } }
    })
    const bridge = createGuestPlatformBridge()
    await expect(bridge.open('usage', { x: 0, y: 0, width: 1, height: 1 })).rejects.toMatchObject({
      kind: 'other', detail: { code: 'platform_account_unavailable' },
    })
  })

  it('carries the disconnected-account code the shell uses when no session exists', () => {
    expect(PLATFORM_VIEW_UNAVAILABLE).toBe('platform_view_unavailable')
  })

  it('reports whether the credential-bearing document is open', async () => {
    transport.answer('guest_platform_status', true)
    await expect(platformViewIsOpen()).resolves.toBe(true)
    expect(transport.calls.at(-1)?.command).toBe('guest_platform_status')
  })

  it('never resolves a Platform state without a shell answer', async () => {
    await expect(platformViewIsOpen()).rejects.toMatchObject({
      kind: 'other', detail: { code: 'unknown_guest_command' },
    })
  })
})
