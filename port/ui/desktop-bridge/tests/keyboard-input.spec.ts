// @vitest-environment jsdom
/**
 * End-to-end keyboard input tests (lead ruling, keyboard decision): the
 * `dshDesktop.keyboard` producer must feed the client's shortcut engine real
 * physical input. These tests dispatch REAL `KeyboardEvent`s in jsdom and
 * assert the listener receives upstream `DesktopShortcutInput` verbatim,
 * stamped with the accepted revision obtained through the transport
 * (`shell_shortcuts_get`), plus the Rust-side `kind: 'menu'` arm delivered
 * through an actual emitted `dsh://shortcuts/input` event (the Tauri
 * `plugin:event` envelope contract).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DesktopShortcutInput, ShortcutConfigSnapshot, ShortcutDefinition,
} from '../protocol.ts'
import { ShortcutRegistry } from '../../../../_upstream/packages/client/shortcuts/src/client/registry.ts'

interface TauriEventEnvelope {
  readonly event: string
  readonly id: number
  readonly payload: unknown
}

const DEFINITIONS: readonly ShortcutDefinition[] = [{ id: 'a.one', defaults: {} }]

function snapshotWithRevision(revision: string): ShortcutConfigSnapshot {
  return {
    revision, sequence: 1, document: { schemaVersion: 2, profiles: {} },
    status: 'ready', error: null, usingDefaults: true,
  }
}

/** Minimal Tauri 2 core `plugin:event` transport (envelope contract of `@tauri-apps/api` v2). */
function createTransportStub() {
  const listeners = new Map<string, number[]>()
  const globals = globalThis as unknown as Record<string, unknown>
  let eventSequence = 0
  let handlerSequence = 0
  let shortcutSnapshot: ShortcutConfigSnapshot = snapshotWithRevision('rev-7')
  return {
    /** Change what `shell_shortcuts_get` answers (for revision-refresh tests). */
    setSnapshot(snapshot: ShortcutConfigSnapshot): void { shortcutSnapshot = snapshot },
    emit(event: string, payload: unknown): void {
      for (const handlerId of listeners.get(event) ?? []) {
        const callback = globals[`_${handlerId}`]
        if (typeof callback === 'function') {
          const envelope: TauriEventEnvelope = { event, id: handlerId, payload }
          ;(callback as (envelope: TauriEventEnvelope) => void)(envelope)
        }
      }
    },
    internals: {
      async invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
        if (command === 'plugin:event|listen') {
          eventSequence += 1
          const ids = listeners.get(String(args?.event)) ?? []
          ids.push(Number(args?.handler))
          listeners.set(String(args?.event), ids)
          return eventSequence
        }
        if (command === 'plugin:event|unlisten') {
          listeners.set(String(args?.event),
            (listeners.get(String(args?.event)) ?? []).filter(id => id !== Number(args?.handler)))
          return undefined
        }
        if (command === 'shell_shortcuts_get') return shortcutSnapshot
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

const flush = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** Physical `code`s of the keyboard-arm inputs (the union's menu arm has none). */
const codesOf = (inputs: readonly DesktopShortcutInput[]): string[] =>
  inputs.flatMap(input => input.kind === 'keyboard' ? [input.code] : [])

async function setup() {
  const stub = createTransportStub()
  vi.resetModules()
  vi.stubGlobal('__TAURI_INTERNALS__', stub.internals)
  const index = await import('../index.ts')
  const markers = await import('../markers.ts')
  const revisions = markers.createShortcutRevisionCache()
  const shortcuts = markers.createShortcutsApi(index.desktop, revisions)
  const keyboard = markers.createKeyboardApi(index.desktop, revisions)
  return { stub, index, markers, revisions, shortcuts, keyboard }
}

describe('dshDesktop.keyboard physical-input producer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('a real key event yields upstream DesktopShortcutInput stamped with the accepted revision', async () => {
    const { shortcuts, keyboard } = await setup()
    await shortcuts.get(DEFINITIONS) // records accepted revision 'rev-7' through the transport

    const received: DesktopShortcutInput[] = []
    keyboard.subscribe(input => received.push(input))
    const event = new KeyboardEvent('keydown', {
      code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true,
    })
    document.body.dispatchEvent(event)
    await flush()

    expect(received).toEqual([{
      revision: 'rev-7', kind: 'keyboard', frameName: '', code: 'KeyP',
      control: true, alt: false, shift: true, meta: false, repeat: false,
    }])
  })

  it('dispatches a saved two-key binding to its registered command', async () => {
    const { shortcuts, keyboard, stub } = await setup()
    const snapshot: ShortcutConfigSnapshot = {
      ...snapshotWithRevision('rev-7'),
      usingDefaults: false,
      document: {
        schemaVersion: 2,
        profiles: { 'desktop:windows': {
          'app.test-chord': { code: 'KeyA', secondCode: 'KeyB', modifiers: ['control'] },
        } },
      },
    }
    stub.setSnapshot(snapshot)
    // The accepted snapshot enters through the same storage facade used after a save.
    const accepted = await shortcuts.get(DEFINITIONS)
    expect(accepted.revision).toBe('rev-7')

    const registry = new ShortcutRegistry('desktop', 'windows', snapshot as never)
    let invoked = 0
    registry.register({
      id: 'app.test-chord', label: () => 'Test chord', aliases: [], defaults: {},
      regions: ['page'], modals: [],
      resolve: () => ({ status: 'handled', run: () => { invoked += 1 } }),
    } as never)
    registry.configure(snapshot as never)
    keyboard.subscribe((input) => {
      if (input.kind !== 'keyboard' || input.revision !== registry.config.getSnapshot().revision) return
      registry.dispatch({ ...input, composing: false, defaultPrevented: false },
        { region: 'page', modal: null, target: document.body }, () => undefined)
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ControlLeft', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', ctrlKey: true, bubbles: true }))
    expect(invoked).toBe(1)
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', ctrlKey: true, bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', ctrlKey: true, bubbles: true }))
  })

  it('tracks key release and clears held keys on blur', async () => {
    const { shortcuts, keyboard } = await setup()
    await shortcuts.get(DEFINITIONS)
    const received: DesktopShortcutInput[] = []
    keyboard.subscribe(input => received.push(input))

    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyA', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyB', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyD', bubbles: true }))
    window.dispatchEvent(new Event('blur'))
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE', bubbles: true }))

    expect(received.filter((input): input is Exclude<DesktopShortcutInput, { kind: 'menu' }> => input.kind !== 'menu')
      .map(input => [input.code, input.secondCode])).toEqual([
      ['KeyA', undefined], ['KeyB', 'KeyA'], ['KeyC', undefined], ['KeyD', 'KeyC'], ['KeyE', undefined],
    ])
  })

  it('does not deliver keys while shortcut recording is active', async () => {
    const { index, markers } = await setup()
    const product = markers.createDesktopProductApi(index.desktop)
    await product.shortcuts.get(DEFINITIONS)
    const received: DesktopShortcutInput[] = []
    product.keyboard.subscribe(input => received.push(input))
    await product.shortcuts.recording(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    await product.shortcuts.recording(false)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }))
    expect(codesOf(received)).toEqual(['KeyB'])
  })

  it('input before the first accepted revision is dropped, not stamped stale', async () => {
    const { keyboard } = await setup()
    const received: DesktopShortcutInput[] = []
    keyboard.subscribe(input => received.push(input))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', ctrlKey: true, bubbles: true }))
    await flush()
    expect(received).toEqual([])
  })

  it('IME composition and AltGraph input are skipped', async () => {
    const { shortcuts, keyboard } = await setup()
    await shortcuts.get(DEFINITIONS)
    const received: DesktopShortcutInput[] = []
    keyboard.subscribe(input => received.push(input))

    const composing = new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true })
    Object.defineProperty(composing, 'isComposing', { value: true })
    document.body.dispatchEvent(composing)

    const altGraph = new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true })
    Object.defineProperty(altGraph, 'getModifierState', { value: (key: string) => key === 'AltGraph' })
    document.body.dispatchEvent(altGraph)

    await flush()
    expect(received).toEqual([])
  })

  it('the producer never suppresses default actions (K4 gap; editing chords must keep working)', async () => {
    const { shortcuts, keyboard } = await setup()
    await shortcuts.get(DEFINITIONS)
    keyboard.subscribe(() => undefined)
    const event = new KeyboardEvent('keydown', { code: 'KeyC', ctrlKey: true, bubbles: true, cancelable: true })
    document.body.dispatchEvent(event)
    await flush()
    expect(event.defaultPrevented).toBe(false)
  })

  it('the Rust kind:menu arm arrives through an emitted event, envelope unwrapped', async () => {
    const { keyboard, stub } = await setup()
    const received: DesktopShortcutInput[] = []
    keyboard.subscribe(input => received.push(input))
    await flush() // let the plugin:event|listen registration settle

    const menuInput: DesktopShortcutInput = {
      revision: 'rev-7', kind: 'menu', commandId: 'close_page_or_window',
    }
    stub.emit('dsh://shortcuts/input', menuInput)
    await flush()

    expect(received).toEqual([menuInput])
    expect(received[0]?.kind).toBe('menu')
  })

  it('dsh://shortcuts/changed refreshes the stamped revision', async () => {
    const { shortcuts, keyboard, stub } = await setup()
    await shortcuts.get(DEFINITIONS) // rev-7
    const received: DesktopShortcutInput[] = []
    keyboard.subscribe(input => received.push(input))
    await flush()

    stub.setSnapshot(snapshotWithRevision('rev-8'))
    stub.emit('dsh://shortcuts/changed', { bindings: [] })
    await flush()
    await flush()

    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyK', bubbles: true }))
    await flush()
    expect(received.map(input => input.revision)).toEqual(['rev-8'])
  })

  it('the disposer removes the listener and the DOM listener', async () => {
    const { shortcuts, keyboard } = await setup()
    await shortcuts.get(DEFINITIONS)
    const received: DesktopShortcutInput[] = []
    const dispose = keyboard.subscribe(input => received.push(input))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyA', bubbles: true }))
    await flush()
    dispose()
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyB', bubbles: true }))
    await flush()
    expect(codesOf(received)).toEqual(['KeyA'])

    // A later subscription re-installs the DOM listener.
    keyboard.subscribe(input => received.push(input))
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyC', bubbles: true }))
    await flush()
    expect(codesOf(received)).toEqual(['KeyA', 'KeyC'])
  })
})
