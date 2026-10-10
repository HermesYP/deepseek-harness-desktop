// @vitest-environment jsdom
/**
 * Real-transport event test: Tauri's `plugin:event|listen` invokes registered
 * callbacks with the `Event<T>` envelope `{ event, id, payload }`, not the
 * domain payload. This suite drives the bridge through a transport stub that
 * implements the Tauri 2 core event-plugin contract exactly (callback ids via
 * `transformCallback`, `plugin:event|listen`/`unlisten`, envelope delivery on
 * emit) and asserts `dsh://` listeners receive the DOMAIN payload — the
 * regression the envelope unwrap in `index.ts` fixes cannot be caught by type
 * or fixture round-trip tests. It also pins the single-authority rule: the
 * shell glue fills only absent marker globals and never overwrites the
 * Rust-installed bridge.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopShortcutInput, LocaleState, DesktopUpdatePresentation, QuitReason } from '../protocol.ts'

interface TauriEventEnvelope {
  readonly event: string
  readonly id: number
  readonly payload: unknown
}

interface ListenerRegistration {
  readonly eventId: number
  readonly handlerId: number
}

/** Tauri 2 core `plugin:event` transport contract (mirrors `@tauri-apps/api` v2 internals). */
function createTransportStub() {
  const listeners = new Map<string, ListenerRegistration[]>()
  const unlistens: { event: string; eventId: number }[] = []
  const commands: Record<string, unknown> = {}
  let eventSequence = 0
  let handlerSequence = 0
  const globals = globalThis as unknown as Record<string, unknown>
  return {
    unlistens,
    commands,
    /**
     * Emit one event the way the Rust `emit` path delivers it: every
     * registered callback receives the `Event<T>` envelope.
     */
    emit(event: string, payload: unknown): void {
      for (const registration of listeners.get(event) ?? []) {
        const callback = globals[`_${registration.handlerId}`]
        if (typeof callback !== 'function') continue
        const envelope: TauriEventEnvelope = { event, id: registration.eventId, payload }
        ;(callback as (envelope: TauriEventEnvelope) => void)(envelope)
      }
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
        return commands[command]
      },
      transformCallback(callback: unknown): number {
        handlerSequence += 1
        globals[`_${handlerSequence}`] = callback
        return handlerSequence
      },
    },
  }
}

async function freshBridge(stub: ReturnType<typeof createTransportStub> | undefined) {
  vi.resetModules()
  if (stub === undefined) vi.unstubAllGlobals()
  else vi.stubGlobal('__TAURI_INTERNALS__', stub.internals)
  const index = await import('../index.ts')
  return { index, boot: await import('../shell-boot.ts') }
}

const KEYBOARD_INPUT: DesktopShortcutInput = {
  revision: 'rev-1', kind: 'keyboard', frameName: '', code: 'KeyP', secondCode: 'KeyK',
  control: true, alt: false, shift: true, meta: false, repeat: false,
}

describe('dsh:// event transport (Tauri plugin:event envelope contract)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
    delete document.documentElement.dataset.platform
    for (const name of ['__DSH_BOOT_READY__', 'dshDesktopBoot', '__DSH_TRANSPORT__', '__DSH_HOST_PATHS__',
      '__DSH_DIRECTORY_PICKER__', '__DSH_LOCALE__', 'dshOnboarding', 'dshDesktop']) {
      Reflect.deleteProperty(globalThis, name)
    }
  })

  it('listeners receive the domain payload, not the {event,id,payload} envelope', async () => {
    const stub = createTransportStub()
    const { index } = await freshBridge(stub)

    const inputs: DesktopShortcutInput[] = []
    const updates: DesktopUpdatePresentation[] = []
    const locales: LocaleState[] = []
    const quits: QuitReason[] = []
    await index.desktop.onShortcutsInput(input => inputs.push(input))
    await index.desktop.onUpdateState(state => updates.push(state))
    await index.desktop.onLocaleChanged(state => locales.push(state))
    await index.desktop.onShellQuitConfirmed(payload => quits.push(payload.reason))

    stub.emit('dsh://shortcuts/input', KEYBOARD_INPUT)
    stub.emit('dsh://update/state', { phase: 'downloading', version: '0.1.8', percent: 42 })
    stub.emit('dsh://locale/changed', { preference: null, effective: 'zh', source: 'default', languages: ['zh-CN', 'en'] })
    stub.emit('dsh://shell/quit-confirmed', { reason: 'update' })

    // Field reads must be the payload's fields — the envelope regression made
    // every one of these `undefined`.
    expect(inputs).toEqual([KEYBOARD_INPUT])
    const firstInput = inputs[0]
    if (firstInput?.kind !== 'keyboard') throw new TypeError('expected a keyboard input')
    expect(firstInput.code).toBe('KeyP')
    expect(updates[0]?.phase).toBe('downloading')
    expect(updates[0]?.percent).toBe(42)
    expect(locales[0]?.languages).toEqual(['zh-CN', 'en'])
    expect(quits).toEqual(['update'])
    // Nothing received the envelope itself.
    for (const received of [...inputs, ...updates, ...locales]) {
      expect(Object.hasOwn(received as object, 'payload')).toBe(false)
    }
  })

  it('needs only __TAURI_INTERNALS__: the global Tauri API stays off', async () => {
    const stub = createTransportStub()
    stub.commands.shell_app_info = { version: '0.1.7-rc.2' }
    const { index } = await freshBridge(stub)

    // `withGlobalTauri: false` (port/src-tauri/app/tauri.conf.json) injects no
    // `window.__TAURI__`; Tauri 2 always injects the internal channel, and the
    // bridge resolves that first, so no desktop capability depends on the
    // global API surface being present.
    expect(Reflect.get(globalThis, '__TAURI__')).toBeUndefined()
    expect(index.isDesktop()).toBe(true)
    await expect(index.desktop.shellAppInfo()).resolves.toEqual({ version: '0.1.7-rc.2' })
  })

  it('the disposer unlistens through the event plugin', async () => {
    const stub = createTransportStub()
    const { index } = await freshBridge(stub)
    const seen: DesktopUpdatePresentation[] = []
    const unlisten = await index.desktop.onUpdateState(state => seen.push(state))
    stub.emit('dsh://update/state', { phase: 'idle' })
    unlisten()
    stub.emit('dsh://update/state', { phase: 'ready', version: '0.1.8' })
    await Promise.resolve()
    expect(seen).toHaveLength(1)
    expect(stub.unlistens).toEqual([{ event: 'dsh://update/state', eventId: 1 }])
  })

  it('the shell glue fills absent markers and never overwrites Rust-owned or Rust-installed ones (A11)', async () => {
    const stub = createTransportStub()
    const rustBoot = { ready: async () => ({ injections: [], streamBaseUrl: '' }), failed: async () => undefined }
    const rustProduct = { protocolVersion: 1 as const }
    const rustHostPaths = { pathFor: () => '/native/path' }
    const rustPicker = { pick: async () => '/native/pick' }
    vi.resetModules()
    vi.stubGlobal('__TAURI_INTERNALS__', stub.internals)
    Reflect.set(globalThis, 'dshDesktopBoot', rustBoot)
    Reflect.set(globalThis, 'dshDesktop', rustProduct)
    Reflect.set(globalThis, '__DSH_HOST_PATHS__', rustHostPaths)
    Reflect.set(globalThis, '__DSH_DIRECTORY_PICKER__', rustPicker)
    document.documentElement.dataset.platform = 'win32'
    await import('../shell-boot.ts')

    // Rust-owned and Rust-installed surfaces survive untouched (identity).
    expect(Reflect.get(globalThis, 'dshDesktopBoot')).toBe(rustBoot)
    expect(Reflect.get(globalThis, 'dshDesktop')).toBe(rustProduct)
    expect(Reflect.get(globalThis, '__DSH_HOST_PATHS__')).toBe(rustHostPaths)
    expect(Reflect.get(globalThis, '__DSH_DIRECTORY_PICKER__')).toBe(rustPicker)
    expect(document.documentElement.dataset.platform).toBe('win32')
    // Absent TypeScript-bridge markers are filled by the fallback glue.
    expect(Reflect.get(globalThis, '__DSH_LOCALE__')).toBeDefined()
    expect(Reflect.get(globalThis, 'dshOnboarding')).toBeDefined()
  })

  it('the glue never writes the Rust-owned __DSH_HOST_PATHS__ or DOM markers', async () => {
    const stub = createTransportStub()
    await freshBridge(stub)
    // Both are absent here and must stay absent: A11 assigns them to Rust.
    expect(Reflect.get(globalThis, '__DSH_HOST_PATHS__')).toBeUndefined()
    expect(document.documentElement.dataset.platform).toBeUndefined()
  })

  it('the fallback glue composes dshDesktop with a producer-backed keyboard but no native browser', async () => {
    const stub = createTransportStub()
    await freshBridge(stub)
    const product = Reflect.get(globalThis, 'dshDesktop') as Record<string, unknown>
    expect(product.protocolVersion).toBe(1)
    expect(product.shortcuts).toBeDefined()
    expect(product.updates).toBeDefined()
    // Retained Sidebar must use its iframe path until native presentation is composed.
    expect(product.browser).toBeUndefined()
    // keyboard is mandatory in the desktop runtime (upstream throws when it is
    // absent) and must carry the in-page physical-input producer — its presence
    // without a producer would disable upstream's DOM shortcut dispatch.
    expect(product.keyboard).toBeDefined()
    expect(typeof (product.keyboard as { subscribe: unknown }).subscribe).toBe('function')
  })

  it('the shell glue installs nothing outside the desktop shell', async () => {
    await freshBridge(undefined)
    for (const name of ['dshDesktopBoot', '__DSH_DIRECTORY_PICKER__', '__DSH_LOCALE__', 'dshOnboarding', 'dshDesktop']) {
      expect(Reflect.get(globalThis, name), name).toBeUndefined()
    }
  })
})
