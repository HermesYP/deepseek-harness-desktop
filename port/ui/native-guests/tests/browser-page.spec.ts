// @vitest-environment jsdom
/**
 * Regression tests for the native Browser page assembly
 * (`port/ui/native-guests/src/browser-page.ts`).
 *
 * A Tauri child webview is a native overlay, so closing a tab is "hide, then
 * release", never "detach a DOM node". These cases pin the two properties a
 * composition can plausibly get wrong:
 *
 * * the presentation's observation, its queued layout and the session's
 *   subscription are all released BEFORE the native hide, and the hide is
 *   awaited before the lease is released — including when the subscription's
 *   `subscribe()` round trip is still in flight and the teardown lands inside
 *   it;
 * * the teardown happens exactly once per leased guest, however many times
 *   `clear()`, `dispose()` or a re-entrant `createElement` ask for it.
 */
import { describe, expect, it, vi } from 'vitest'
import { createBrowserPageFactory } from '../src/browser-page.ts'
import { createNativeGuestElement } from '../src/frame.ts'
import type { BrowserFrame, BrowserPageOptions } from '../src/browser-page.ts'
import type { GuestNavigation, GuestBounds } from '../../desktop-bridge/guests.ts'

/** A complete shell observation; a partial one is refused by the bridge. */
function guestState(lease: string) {
  return {
    lease, url: '', title: '', loading: false,
    canGoBack: false, canGoForward: false, gone: false, error: null,
  }
}

function setup() {
  const operations: string[] = []
  /** The answer of the next hide command; a case controls when it settles. */
  let hidePending: Promise<void> = Promise.resolve()
  /** The state subscription's round trip; a case controls when it settles. */
  let subscribePending: Promise<void> | undefined
  const navigation: GuestNavigation = {
    async navigate(lease) { operations.push(`navigate:${lease}`) },
    async command(lease, command) { operations.push(`${command}:${lease}`) },
    async state(lease) { return guestState(lease) },
    async onState() {
      if (subscribePending !== undefined) await subscribePending
      return () => { operations.push('unlisten') }
    },
  }
  let attached = 0
  let detached = 0
  const frame: BrowserFrame<string, { value: number }> = {
    getSnapshot: () => ({ value: 0 }), subscribe: () => () => undefined,
    loadUrl: () => undefined, goBack: () => undefined, goForward: () => undefined, reload: () => undefined,
    attach: () => { attached += 1 }, detach: () => { detached += 1 }, async dispose() {},
  }
  const createFrame = vi.fn((_options: BrowserPageOptions<undefined>, _navigation: GuestNavigation) => frame)
  const factory = createBrowserPageFactory<undefined, string, { value: number }>({
    navigation: () => navigation, createFrame,
    setBounds: (lease: string, bounds: GuestBounds) => {
      operations.push(`setBounds:${lease}:${bounds.width}x${bounds.height}`)
      return hidePending
    },
    release: async (lease) => { operations.push(`release:${lease}`) },
    onError: vi.fn(),
    measurements: { observe: () => () => { operations.push('unobserve') } },
  })
  return {
    factory, frame, operations, createFrame,
    counts: () => ({ attached, detached }),
    /** Make the next hide command wait until the returned resolver runs. */
    holdHide(): () => void {
      let resolve!: () => void
      hidePending = new Promise<void>(done => { resolve = done })
      return resolve
    },
    /** Make the next subscribe round trip wait until the returned resolver runs. */
    holdSubscribe(): () => void {
      let resolve!: () => void
      subscribePending = new Promise<void>(done => { resolve = done })
      return resolve
    },
  }
}

/** Let every already-scheduled microtask run. */
async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

describe('native browser page factory', () => {
  it('passes retained options and shared navigation to the frame', () => {
    const { factory, createFrame } = setup()
    const options: BrowserPageOptions<undefined> = { initial: undefined, persist: () => undefined, openRequested: () => undefined }
    const page = factory(options)
    expect(page.frame.getSnapshot()).toEqual({ value: 0 })
    expect(createFrame).toHaveBeenCalledOnce()
    expect(createFrame.mock.calls[0]?.[0]).toBe(options)
  })

  it('routes presentation attachment to retained frame lifecycle', () => {
    const { factory, counts } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    const viewport = document.createElement('div')
    viewport.id = 'viewport'
    document.body.append(viewport)
    const detach = page.presentation.mount('viewport')
    detach()
    expect(counts()).toEqual({ attached: 1, detached: 1 })
  })

  it('only presents the page-owned element and disposes its session', async () => {
    const { factory, operations } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    const element = page.presentation.createElement({ lease: 'lease-a', partition: 'partition' })
    expect(() => page.presentation.present(element)).not.toThrow()
    expect(() => page.presentation.present(createNativeGuestElement('foreign', {
      load: async () => undefined, reload: async () => undefined, goBack: async () => undefined,
      goForward: async () => undefined, clearHistory: async () => undefined,
      observe: async (lease) => guestState(lease),
    }))).toThrow(/not owned/)
    page.presentation.clear()
    await settle()
    // This lease was adopted and retired in the same turn: it was never bound to
    // the presentation, so it was never placed and never subscribed. The
    // teardown is just the release of a guest the shell already created hidden.
    expect(operations).not.toContain('unlisten')
    expect(operations.some(operation => operation.startsWith('setBounds:lease-a'))).toBe(false)
    expect(operations).toContain('release:lease-a')
    page.presentation.dispose()
  })

  it('awaits the native hide before releasing the lease', async () => {
    const { factory, operations, holdHide } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    page.presentation.createElement({ lease: 'lease-a', partition: 'partition' })
    // The session's subscription is installed before the hide starts.
    await settle()
    const resolveHide = holdHide()

    page.presentation.clear()
    await settle()

    // The hide is in flight: the session's listener is already gone and the
    // lease must still be live.
    expect(operations).toContain('unlisten')
    expect(operations.some(operation => operation.startsWith('setBounds:lease-a:0x0'))).toBe(true)
    expect(operations).not.toContain('release:lease-a')

    resolveHide()
    await settle()
    expect(operations).toContain('release:lease-a')
  })

  it('awaits an in-flight unsubscribe before hiding and releasing the lease', async () => {
    const { factory, operations, holdHide, holdSubscribe } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    const resolveSubscribe = holdSubscribe()
    page.presentation.createElement({ lease: 'lease-a', partition: 'partition' })
    // The adoption ran and its subscribe round trip is still open.
    await settle()
    expect(operations).not.toContain('unlisten')

    const resolveHide = holdHide()
    page.presentation.clear()
    await settle()

    // Nothing has been unsubscribed, placed or released yet: disposal is waiting
    // for the round trip, and both the hide and the release are behind it.
    expect(operations).toEqual([])

    resolveSubscribe()
    await settle()

    // The listener is released before the guest is hidden.
    expect(operations).toEqual(['unlisten', 'setBounds:lease-a:0x0'])

    resolveHide()
    await settle()
    expect(operations).toEqual(['unlisten', 'setBounds:lease-a:0x0', 'release:lease-a'])
  })

  it('retires each guest once however many callers ask', async () => {
    const { factory, operations } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    page.presentation.createElement({ lease: 'lease-a', partition: 'partition' })
    await settle()

    page.presentation.clear()
    page.presentation.clear()
    page.presentation.dispose()
    page.presentation.dispose()
    await settle()

    expect(operations.filter(operation => operation === 'release:lease-a')).toHaveLength(1)
    expect(operations.filter(operation => operation === 'unlisten')).toHaveLength(1)
    expect(operations.filter(operation => operation.startsWith('setBounds:lease-a:0x0'))).toHaveLength(1)
  })

  it('refuses to adopt an element after disposal instead of resurrecting a guest', async () => {
    const { factory } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    page.presentation.createElement({ lease: 'lease-a', partition: 'partition' })
    await settle()
    page.presentation.dispose()
    await settle()

    expect(() => page.presentation.createElement({ lease: 'lease-b', partition: 'partition' }))
      .toThrow(/disposed/)
  })

  it('releases a lease adopted while the previous one was still hiding, once the page disposes', async () => {
    const { factory, operations, holdHide } = setup()
    const page = factory({ initial: undefined, persist: () => undefined, openRequested: () => undefined })
    page.presentation.createElement({ lease: 'lease-a', partition: 'partition' })
    await settle()

    const resolveHide = holdHide()
    page.presentation.clear()
    await settle()
    // The next tab is adopted while lease-a is still hiding, then the page
    // retires before that adoption runs.
    page.presentation.createElement({ lease: 'lease-b', partition: 'partition' })
    page.presentation.dispose()
    resolveHide()
    await settle()

    // Both guests are released exactly once: lease-a by its own teardown,
    // lease-b by the adoption path that found the page disposed.
    expect(operations.filter(operation => operation === 'release:lease-a')).toHaveLength(1)
    expect(operations.filter(operation => operation === 'release:lease-b')).toHaveLength(1)
  })
})
