// @vitest-environment jsdom
/**
 * Regression tests for the native guest navigation frame
 * (`port/ui/native-guests/src/frame.ts`).
 *
 * The adapter exists to reproduce the `<webview>` element surface the preserved
 * `ElectronWebViewImpl` drives, so every case asserts one of the exact members
 * or events that preserved class reads. A regression here is not cosmetic: a
 * missing method or a mis-repeated event breaks the preserved Browser tab, not
 * this adapter.
 */
import { describe, expect, it, vi } from 'vitest'
import { applyGuestState, createNativeGuestElement, refreshGuestState } from '../src/frame.ts'
import type { NativeGuestNavigation, NativeGuestState } from '../src/frame.ts'

/** A native navigation recorder with per-command refusal control. */
function createNavigation() {
  const calls: { command: string; lease: string; url?: string }[] = []
  const refusals = new Map<string, unknown>()
  let observed: NativeGuestState | undefined
  const record = (command: string) => async (lease: string): Promise<void> => {
    calls.push({ command, lease })
    const refusal = refusals.get(command)
    if (refusal !== undefined) throw refusal
  }
  const navigation: NativeGuestNavigation = {
    async load(lease, url) { calls.push({ command: 'load', lease, url }) },
    reload: record('reload'),
    goBack: record('goBack'),
    goForward: record('goForward'),
    clearHistory: record('clearHistory'),
    async observe(lease) {
      calls.push({ command: 'observe', lease })
      if (observed === undefined) throw new Error('no observation configured')
      return observed
    },
  }
  return {
    calls,
    refuse: (command: string, reason: unknown) => { refusals.set(command, reason) },
    /** Configure the document the shell reports on the next `observe`. */
    report: (next: NativeGuestState) => { observed = next },
    navigation,
  }
}

const LEASE = 'lease-1'

/** A state row with the fields a case does not care about filled in. */
function state(overrides: Partial<NativeGuestState>): NativeGuestState {
  return {
    lease: LEASE, url: `about:blank#${LEASE}`, title: '', loading: false,
    canGoBack: false, canGoForward: false, gone: false, error: null, ...overrides,
  }
}

/** Collect one event type, preserving its fields. */
function collect(element: HTMLElement, type: string): Event[] {
  const seen: Event[] = []
  element.addEventListener(type, event => { seen.push(event) })
  return seen
}

describe('native guest element surface', () => {
  it('exposes every method the preserved ElectronWebViewImpl calls', async () => {
    const { calls, navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    for (const method of ['loadURL', 'getURL', 'getTitle', 'canGoBack', 'canGoForward',
      'clearHistory', 'goBack', 'goForward', 'reload', 'isLoading'] as const) {
      expect(typeof element[method]).toBe('function')
    }

    expect(element.getURL()).toBe(`about:blank#${LEASE}`)
    expect(element.getTitle()).toBe('')
    expect(element.canGoBack()).toBe(false)
    expect(element.canGoForward()).toBe(false)
    expect(element.isLoading()).toBe(false)

    await element.loadURL('https://example.com/a')
    element.goBack()
    element.goForward()
    element.reload()
    element.clearHistory()
    expect(calls).toEqual([
      { command: 'load', lease: LEASE, url: 'https://example.com/a' },
      { command: 'goBack', lease: LEASE },
      { command: 'goForward', lease: LEASE },
      { command: 'reload', lease: LEASE },
      { command: 'clearHistory', lease: LEASE },
    ])
  })

  it('marks the port carrier and labels the guest with its lease', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    expect(element.dataset.sidebarBrowserFrame).toBe('tauri')
    expect(element.getAttribute('name')).toBe(LEASE)
  })
})

describe('preserved event translation', () => {
  it('fires dom-ready once, before any commit', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    const ready = collect(element, 'dom-ready')
    const navigated = collect(element, 'did-navigate')

    applyGuestState(element, state({}))
    expect(ready).toHaveLength(1)
    expect(navigated).toHaveLength(0)

    applyGuestState(element, state({ url: 'https://example.com/a', title: 'Example', canGoBack: true }))
    expect(ready).toHaveLength(1)
    expect(navigated).toHaveLength(1)
  })

  it('raises the preserved loading, navigation and title events', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    const started = collect(element, 'did-start-loading')
    const stopped = collect(element, 'did-stop-loading')
    const navigated = collect(element, 'did-navigate')
    const titled = collect(element, 'page-title-updated')

    applyGuestState(element, state({}))
    applyGuestState(element, state({ url: '', loading: true }))
    expect(started).toHaveLength(1)
    expect(navigated).toHaveLength(0)

    applyGuestState(element, state({ url: 'https://example.com/a', title: 'Example', canGoBack: true }))
    expect(stopped).toHaveLength(1)
    expect(navigated).toHaveLength(1)
    expect(titled).toHaveLength(1)
  })

  it('reports history and loading state to the preserved chrome', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    applyGuestState(element, state({
      url: 'https://example.com/b', title: 'B', loading: true, canGoBack: true, canGoForward: true,
    }))
    expect(element.getURL()).toBe('https://example.com/b')
    expect(element.getTitle()).toBe('B')
    expect(element.canGoBack()).toBe(true)
    expect(element.canGoForward()).toBe(true)
    expect(element.isLoading()).toBe(true)
  })

  it('raises did-fail-load with the fields the preserved listener reads', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    const failed = collect(element, 'did-fail-load')
    const error = { code: -105, description: 'ERR_NAME_NOT_RESOLVED' }

    applyGuestState(element, state({ url: 'https://example.com/missing', error }))
    expect(failed).toHaveLength(1)
    expect((failed[0] as Event & { isMainFrame: boolean }).isMainFrame).toBe(true)
    expect((failed[0] as Event & { errorCode: number }).errorCode).toBe(-105)
    expect((failed[0] as Event & { errorDescription: string }).errorDescription).toBe('ERR_NAME_NOT_RESOLVED')

    // The shell serializes a fresh object per report; an unrelated change that
    // repeats the same failure must not re-raise the event.
    applyGuestState(element, state({ url: 'https://example.com/missing', title: 'Missing', error: { ...error } }))
    expect(failed).toHaveLength(1)
  })

  it('raises render-process-gone and destroyed when the guest loses its document', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    const gone = collect(element, 'render-process-gone')
    const destroyed = collect(element, 'destroyed')

    applyGuestState(element, state({ url: 'https://example.com/a', title: 'A' }))
    applyGuestState(element, state({ url: 'https://example.com/a', title: 'A', gone: true }))
    expect(gone).toHaveLength(1)
    expect(destroyed).toHaveLength(1)
  })

  it('moves the current document into the element when the shell reports one', async () => {
    const { navigation, report } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    report(state({ url: 'https://example.com/live', title: 'Live', loading: true, canGoBack: true }))
    await refreshGuestState(element)
    expect(element.getURL()).toBe('https://example.com/live')
    expect(element.getTitle()).toBe('Live')
    expect(element.isLoading()).toBe(true)
    expect(element.canGoBack()).toBe(true)
    expect(element.canGoForward()).toBe(false)
  })

  it('keeps the last observation when a refresh is refused', async () => {
    const { navigation, report } = createNavigation()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const element = createNativeGuestElement(LEASE, navigation)
    report(state({ url: 'https://example.com/a', title: 'A' }))
    await refreshGuestState(element)
    const callsBefore = navigation.observe.name
    // The next observe has no configured document, so it rejects.
    const { navigation: bare } = createNavigation()
    const other = createNativeGuestElement(LEASE, bare)
    await refreshGuestState(other)
    expect(other.getURL()).toBe(`about:blank#${LEASE}`)
    expect(callsBefore).toBe('observe')
  })

  it('validates reports against the immutable lease, not the mutable name attribute', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    element.setAttribute('name', 'lease-2')
    expect(applyGuestState(element, state({ lease: 'lease-2', url: 'https://wrong.example/' }))).toBe(false)
    expect(element.getURL()).toBe(`about:blank#${LEASE}`)
    expect(applyGuestState(element, state({ url: 'https://right.example/' }))).toBe(true)
    expect(element.getURL()).toBe('https://right.example/')
  })

  it('drops a state report addressed to another lease', () => {
    const { navigation } = createNavigation()
    const element = createNativeGuestElement(LEASE, navigation)
    const navigated = collect(element, 'did-navigate')
    expect(applyGuestState(element, state({ lease: 'lease-2', url: 'https://example.com/other' }))).toBe(false)
    expect(navigated).toHaveLength(0)
    expect(element.getURL()).toBe(`about:blank#${LEASE}`)
  })

  it('contains a refused navigation command instead of stranding the guest', async () => {
    const { navigation, refuse } = createNavigation()
    refuse('reload', { kind: 'other', detail: { code: 'guest_navigation', message: 'refused' } })
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const element = createNativeGuestElement(LEASE, navigation)
    element.reload()
    await vi.waitFor(() => { expect(console.error).toHaveBeenCalledTimes(1) })
  })
})
