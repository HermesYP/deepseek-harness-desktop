// @vitest-environment jsdom
/**
 * Regression tests for the native-theme mirror
 * (`port/ui/desktop-bridge/markers.ts` → `syncNativeTheme`).
 *
 * The reference shell forwards the theme presenter's resolved preference to
 * `nativeTheme.themeSource` from a preload script. The port has no preload, so
 * the mirror must observe the value the presenter actually publishes —
 * `html[data-ds-theme-source]` — and drive the real `shell_theme_set` command.
 *
 * These cases pin the properties a plausible-but-wrong implementation gets
 * wrong:
 *
 * * it forwards the INITIAL attribute, not only later changes (the presenter
 *   writes before this glue runs);
 * * it observes a real `MutationObserver` on the root attribute — there is no
 *   `dsh://theme/changed` event in the contract, so an implementation that
 *   waits for one would never fire;
 * * each value is sent once (the shell writes the attribute back, so a
 *   re-send would be a loop);
 * * a value that is not one of the three preferences is not forwarded, because
 *   the port cannot express a registered theme id natively;
 * * a REFUSED update is reported and the value is forgotten, so the next write
 *   retries instead of being deduplicated against a value the shell never
 *   accepted;
 * * `dispose()` removes the observer — a test or page teardown must not leave
 *   one watching a document it no longer owns — and is idempotent;
 * * while the document is still loading, the mirror waits for
 *   `DOMContentLoaded` instead of reading a root that does not exist yet.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { THEME_SOURCE_ATTRIBUTE, syncNativeTheme } from '../markers.ts'
import type { DshDesktopApi } from '../index.ts'

/** A facade stub recording `shell_theme_set`, with one controllable refusal. */
function createBridge() {
  const calls: { theme: unknown }[] = []
  const failures: unknown[] = []
  let refuseNext = false
  const bridge = {
    async shellThemeSet(request: { theme: unknown }): Promise<void> {
      calls.push(request)
      if (refuseNext) {
        refuseNext = false
        throw { kind: 'other', detail: { code: 'theme_unavailable', message: 'no native theme' } }
      }
    },
  } as unknown as DshDesktopApi
  return {
    bridge, calls, failures,
    /** Make the next `shell_theme_set` reject. */
    refuseNextCall(): void { refuseNext = true },
  }
}

/** Let the mutation-observer microtask and its delivery run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
  await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  for (let index = 0; index < 4; index += 1) await Promise.resolve()
}

function setSource(value: string | null): void {
  if (value === null) document.documentElement.removeAttribute(THEME_SOURCE_ATTRIBUTE)
  else document.documentElement.setAttribute(THEME_SOURCE_ATTRIBUTE, value)
}

afterEach(() => {
  setSource(null)
  vi.restoreAllMocks()
})

describe('native theme mirror', () => {
  it('forwards the value already on the root, not only later changes', async () => {
    // The presenter writes before this glue runs; jsdom's document is settled,
    // so the mirror must read the attribute immediately rather than wait for an
    // event the contract does not define.
    expect(document.readyState).not.toBe('loading')
    setSource('dark')
    const { bridge, calls } = createBridge()

    const sync = syncNativeTheme(bridge)
    await settle()

    expect(calls).toEqual([{ theme: 'dark' }])
    sync.dispose()
  })

  it('observes the root attribute, sending each new preference exactly once', async () => {
    setSource('system')
    const { bridge, calls } = createBridge()
    const sync = syncNativeTheme(bridge)
    await settle()
    expect(calls).toEqual([{ theme: 'system' }])

    setSource('dark')
    await settle()
    expect(calls).toEqual([{ theme: 'system' }, { theme: 'dark' }])

    // The shell writes the attribute back through the same command; re-sending
    // that value would be a loop.
    setSource('dark')
    await settle()
    expect(calls).toHaveLength(2)

    setSource('light')
    await settle()
    expect(calls).toEqual([{ theme: 'system' }, { theme: 'dark' }, { theme: 'light' }])
    sync.dispose()
  })

  it('does not forward a value outside the three preferences', async () => {
    const { bridge, calls } = createBridge()
    const sync = syncNativeTheme(bridge)
    await settle()
    expect(calls).toEqual([])

    // A registered theme id is a valid palette but not a `ThemePreference` the
    // port can express natively.
    setSource('nord')
    await settle()
    expect(calls).toEqual([])

    setSource('dark')
    await settle()
    expect(calls).toEqual([{ theme: 'dark' }])
    sync.dispose()
  })

  it('reports a refused update and forgets the value so the next write retries', async () => {
    setSource('dark')
    const { bridge, calls, failures, refuseNextCall } = createBridge()
    refuseNextCall()

    const sync = syncNativeTheme(bridge, { onFailure: error => failures.push(error) })
    await settle()
    expect(calls).toEqual([{ theme: 'dark' }])
    expect(failures).toHaveLength(1)

    // An unexpressible value in between must not consume the retry.
    setSource('nord')
    setSource('dark')
    await settle()

    // The refusal was not deduplicated away: the same preference is sent again.
    expect(calls).toEqual([{ theme: 'dark' }, { theme: 'dark' }])
    expect(failures).toHaveLength(1)
    sync.dispose()
  })

  it('removes the observer on dispose, idempotently', async () => {
    setSource('dark')
    const { bridge, calls } = createBridge()
    const sync = syncNativeTheme(bridge)
    await settle()
    expect(calls).toHaveLength(1)

    sync.dispose()
    sync.dispose()
    setSource('light')
    await settle()

    // Nothing observes the root any more.
    expect(calls).toHaveLength(1)
  })

  it('waits for DOMContentLoaded while the document is still loading', async () => {
    const attributes = new Map<string, string>([[THEME_SOURCE_ATTRIBUTE, 'light']])
    const listeners = new Map<string, () => void>()
    const root = {
      readyState: 'loading',
      documentElement: { getAttribute: (name: string) => attributes.get(name) ?? null },
      defaultView: null,
      addEventListener: (type: string, listener: () => void) => { listeners.set(type, listener) },
      removeEventListener: (type: string) => { listeners.delete(type) },
    } as unknown as Document
    const { bridge, calls } = createBridge()

    const sync = syncNativeTheme(bridge, { root })
    await settle()

    // The root does not exist yet: nothing was read and nothing was sent.
    expect(calls).toEqual([])

    // The theme bootstrap ran; the deferred observation now reads it.
    listeners.get('DOMContentLoaded')?.()
    await settle()
    expect(calls).toEqual([{ theme: 'light' }])

    sync.dispose()
    expect(listeners.has('DOMContentLoaded')).toBe(false)
  })
})
