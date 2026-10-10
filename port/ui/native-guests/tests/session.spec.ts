// @vitest-environment jsdom
/**
 * Regression tests for the live guest session
 * (`port/ui/native-guests/src/session.ts`).
 *
 * The session is what makes the reproduced `<webview>` element report real
 * values: without a subscription the element answers from its constructor
 * defaults forever, which is precisely the "simulated state" the adapter exists
 * to prevent. Each case therefore drives the subscription the session installs
 * and asserts what the preserved `ElectronWebViewImpl` would then read.
 */
import { describe, expect, it, vi } from 'vitest'
import { NativeGuestSession, createNativeGuestSession } from '../src/session.ts'
import type { NativeGuestStateSource } from '../src/session.ts'
import type { NativeGuestNavigation, NativeGuestState } from '../src/frame.ts'

const LEASE = 'lease-1'

/** A state row with the fields a case does not care about filled in. */
function state(overrides: Partial<NativeGuestState>): NativeGuestState {
  return {
    lease: LEASE, url: `about:blank#${LEASE}`, title: '', loading: false,
    canGoBack: false, canGoForward: false, gone: false, error: null, ...overrides,
  }
}

/**
 * A driven state source: it records the subscription, lets a case push a
 * report, and answers `observe` with a configured document.
 */
function createSource(initial?: NativeGuestState) {
  let listener: ((state: NativeGuestState) => void) | undefined
  const observed: string[] = []
  let current = initial
  let unsubscribeCount = 0
  let subscribeFailure: unknown
  return {
    observed,
    get subscribed(): boolean { return listener !== undefined },
    get unsubscribeCount(): number { return unsubscribeCount },
    /** Push one shell report as the `dsh://` transport would. */
    push(next: NativeGuestState): void { listener?.(next) },
    failSubscription(reason: unknown): void { subscribeFailure = reason },
    source: {
      async observe(lease: string): Promise<NativeGuestState> {
        observed.push(lease)
        if (current === undefined) throw new Error('no document configured')
        return current
      },
      async subscribe(next: (state: NativeGuestState) => void): Promise<() => void> {
        if (subscribeFailure !== undefined) throw subscribeFailure
        listener = next
        return () => { unsubscribeCount += 1; listener = undefined }
      },
    } satisfies NativeGuestStateSource,
    /** Configure what `observe` answers. */
    configure(next: NativeGuestState | undefined): void { current = next },
  }
}

/** A navigation recorder; the session only passes it through to the element. */
function createNavigation(): NativeGuestNavigation {
  const calls: string[] = []
  return {
    async load(lease, url) { calls.push(`load:${lease}:${url}`) },
    async reload(lease) { calls.push(`reload:${lease}`) },
    async goBack(lease) { calls.push(`back:${lease}`) },
    async goForward(lease) { calls.push(`forward:${lease}`) },
    async clearHistory(lease) { calls.push(`clear:${lease}`) },
    async observe(lease) { calls.push(`observe:${lease}`); throw new Error('unused') },
  }
}

/** Let the session's asynchronous installation settle. */
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

describe('native guest session', () => {
  it('subscribes once, applies the first observation and reports live state', async () => {
    const source = createSource(state({ url: 'https://example.com/a', title: 'A', canGoBack: true }))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)

    await session.start()
    await session.start()

    expect(source.subscribed).toBe(true)
    expect(source.observed).toEqual([LEASE])
    expect(session.element.getURL()).toBe('https://example.com/a')
    expect(session.element.getTitle()).toBe('A')
    expect(session.element.canGoBack()).toBe(true)
    expect(session.observedTitle()).toBe('A')
    session.dispose()
  })

  it('does not let a delayed initial observation overwrite a newer event', async () => {
    let resolveObservation!: (value: NativeGuestState) => void
    let listener: ((value: NativeGuestState) => void) | undefined
    const source: NativeGuestStateSource = {
      observe: () => new Promise(resolve => { resolveObservation = resolve }),
      async subscribe(next) { listener = next; return () => undefined },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    const starting = session.start()
    await settle()
    listener?.(state({ url: 'https://new.example/', title: 'New' }))
    resolveObservation(state({ url: 'https://old.example/', title: 'Old' }))
    await starting
    expect(session.element.getURL()).toBe('https://new.example/')
    session.dispose()
  })

  it('preserves an event delivered before subscribe resolves', async () => {
    const source: NativeGuestStateSource = {
      async observe() { return state({ url: 'https://old.example/', title: 'Old' }) },
      async subscribe(listener) {
        listener(state({ url: 'https://new.example/', title: 'New' }))
        return () => undefined
      },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    await session.start()
    expect(session.element.getURL()).toBe('https://new.example/')
    expect(session.element.getTitle()).toBe('New')
    session.dispose()
  })

  it('does not let another lease event suppress the initial observation', async () => {
    const source: NativeGuestStateSource = {
      async observe() { return state({ url: 'https://owned.example/', title: 'Owned' }) },
      async subscribe(listener) {
        listener(state({ lease: 'other', url: 'https://other.example/' }))
        return () => undefined
      },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    await session.start()
    expect(session.element.getURL()).toBe('https://owned.example/')
    session.dispose()
  })

  it('does not apply a delayed observation after disposal', async () => {
    let resolveObservation!: (value: NativeGuestState) => void
    let stopCount = 0
    const stop = (): void => { stopCount += 1 }
    const source: NativeGuestStateSource = {
      observe: () => new Promise(resolve => { resolveObservation = resolve }),
      async subscribe() { return stop },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    const starting = session.start()
    await settle()
    session.dispose()
    resolveObservation(state({ url: 'https://late.example/', title: 'Late' }))
    await starting
    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
    expect(stopCount).toBe(1)
  })

  it('coalesces overlapping starts and releases its subscription once', async () => {
    const source = createSource(state({}))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)
    const first = session.start()
    const second = session.start()
    expect(first).toBe(second)
    await Promise.all([first, second])
    session.dispose()
    session.dispose()
    expect(source.unsubscribeCount).toBe(1)
  })

  it('routes a later report into the element the preserved chrome reads', async () => {
    const source = createSource(state({}))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)
    await session.start()
    const navigated: Event[] = []
    session.element.addEventListener('did-navigate', event => { navigated.push(event) })

    source.push(state({
      url: 'https://example.com/b', title: 'B', loading: true, canGoForward: true,
    }))
    source.push(state({ url: 'https://example.com/b', title: 'B', loading: true, canGoForward: true }))

    expect(navigated).toHaveLength(1)
    expect(session.element.getURL()).toBe('https://example.com/b')
    expect(session.element.getTitle()).toBe('B')
    expect(session.element.isLoading()).toBe(true)
    expect(session.element.canGoForward()).toBe(true)
    session.dispose()
  })

  it('drops a report for a lease this session does not own', async () => {
    const source = createSource(state({}))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)
    await session.start()

    source.push(state({ lease: 'lease-2', url: 'https://example.com/other', title: 'Other' }))

    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
    expect(session.element.getTitle()).toBe('')
    session.dispose()
  })

  it('reports a failed subscription instead of leaving the element silently inert', async () => {
    const failures = vi.fn()
    const source = createSource(state({ url: 'https://example.com/a' }))
    source.failSubscription({ kind: 'other', detail: { code: 'guest_state', message: 'no transport' } })
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source, failures)

    await session.start()

    expect(failures).toHaveBeenCalledTimes(1)
    // The pull still happened: an unsubscribed guest is navigable, so its
    // current document must still reach the element.
    expect(session.element.getURL()).toBe('https://example.com/a')
    session.dispose()
  })

  it('reports a failed observation and keeps the bootstrap document', async () => {
    const failures = vi.fn()
    const source = createSource()
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source, failures)

    await session.start()

    expect(failures).toHaveBeenCalledTimes(1)
    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
    session.dispose()
  })

  it('stops delivering and unsubscribes after disposal', async () => {
    const source = createSource(state({}))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)
    await session.start()

    session.dispose()
    source.push(state({ url: 'https://example.com/late', title: 'Late' }))

    expect(source.unsubscribeCount).toBe(1)
    expect(session.element.getTitle()).toBe('')
    session.dispose()
    expect(source.unsubscribeCount).toBe(1)
  })

  it('unsubscribes when disposal lands inside the subscribe round trip', async () => {
    const source = createSource(state({}))
    const session = new NativeGuestSession(LEASE, createNavigation(), source.source)
    const starting = session.start()
    session.dispose()
    await starting
    await settle()

    expect(source.unsubscribeCount).toBe(1)
  })

  it('resolves disposal only after an in-flight subscribe released its listener', async () => {
    let resolveSubscribe!: (stop: () => void) => void
    let stopCount = 0
    const source: NativeGuestStateSource = {
      // Reaching `observe` would mean the session kept pulling for a guest whose
      // page already moved on.
      async observe() { throw new Error('must not observe after disposal') },
      subscribe() { return new Promise(resolve => { resolveSubscribe = resolve }) },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    const starting = session.start()
    const disposal = session.dispose()
    // Every caller joins the same teardown instead of starting a second one.
    expect(session.dispose()).toBe(disposal)

    let settled = false
    void disposal.then(() => { settled = true })
    await settle()
    // The round trip is open and there is no disposer yet: disposal must not
    // claim to be done, and the caller releasing the lease keeps waiting.
    expect(settled).toBe(false)
    expect(stopCount).toBe(0)

    resolveSubscribe(() => { stopCount += 1 })
    await Promise.all([starting, disposal])

    expect(stopCount).toBe(1)
    expect(settled).toBe(true)
    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
  })

  it('resolves disposal at once when no subscription was ever attempted', async () => {
    const source = createSource(state({}))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)

    await expect(session.dispose()).resolves.toBeUndefined()
    expect(source.unsubscribeCount).toBe(0)
    // A start after disposal installs nothing, so the resolved disposal stays
    // truthful.
    await session.start()
    expect(source.subscribed).toBe(false)
  })

  it('contains a throwing subscription-failure callback and still observes', async () => {
    const source = createSource(state({ url: 'https://still-observed.example/' }))
    source.failSubscription(new Error('subscribe failed'))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source, () => { throw new Error('hook failed') })
    await expect(session.start()).resolves.toBeUndefined()
    expect(source.observed).toEqual([LEASE])
    expect(session.element.getURL()).toBe('https://still-observed.example/')
  })

  it('coalesces reentrant start during synchronous subscribe failure', async () => {
    let session!: NativeGuestSession
    let reentrant!: Promise<void>
    const source: NativeGuestStateSource = {
      async observe() { return state({}) },
      subscribe() {
        reentrant = session.start()
        throw new Error('sync subscribe failure')
      },
    }
    session = createNativeGuestSession(LEASE, createNavigation(), source, () => { throw new Error('hook failed') })
    const first = session.start()
    expect(reentrant).toBe(first)
    await expect(first).resolves.toBeUndefined()
  })

  it('contains a throwing disposer during normal disposal', async () => {
    let stopCount = 0
    const source: NativeGuestStateSource = {
      async observe() { return state({}) },
      async subscribe() { return () => { stopCount += 1; throw new Error('stop failed') } },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    await session.start()
    expect(() => session.dispose()).not.toThrow()
    expect(() => session.dispose()).not.toThrow()
    expect(stopCount).toBe(1)
  })

  it('contains throwing disposal and late-subscribe cleanup callbacks', async () => {
    let resolveSubscribe!: (stop: () => void) => void
    let stopCount = 0
    const source: NativeGuestStateSource = {
      async observe() { throw new Error('must not observe after dispose') },
      subscribe() { return new Promise(resolve => { resolveSubscribe = resolve }) },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source)
    const starting = session.start()
    session.dispose()
    resolveSubscribe(() => { stopCount += 1; throw new Error('stop failed') })
    await expect(starting).resolves.toBeUndefined()
    expect(stopCount).toBe(1)
    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
  })

  it('does not observe or notify when subscription rejects after disposal', async () => {
    let rejectSubscribe!: (error: unknown) => void
    let observations = 0
    let failures = 0
    const source: NativeGuestStateSource = {
      async observe() { observations += 1; return state({}) },
      subscribe() { return new Promise((_, reject) => { rejectSubscribe = reject }) },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source, () => { failures += 1 })
    const starting = session.start()
    session.dispose()
    rejectSubscribe(new Error('subscription rejected after disposal'))
    await expect(starting).resolves.toBeUndefined()
    expect(observations).toBe(0)
    expect(failures).toBe(0)
    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
  })

  it('does not observe after a failure hook synchronously disposes ownership', async () => {
    let observations = 0
    let failures = 0
    const source: NativeGuestStateSource = {
      async observe() { observations += 1; return state({}) },
      async subscribe() { throw new Error('subscription failed') },
    }
    const session = createNativeGuestSession(LEASE, createNavigation(), source, () => {
      failures += 1
      session.dispose()
      throw new Error('failure hook also failed')
    })
    await expect(session.start()).resolves.toBeUndefined()
    expect(observations).toBe(0)
    expect(failures).toBe(1)
    expect(session.element.getURL()).toBe(`about:blank#${LEASE}`)
  })

  it('exposes the element the presentation and the preserved class share', async () => {
    const source = createSource(state({}))
    const session = createNativeGuestSession(LEASE, createNavigation(), source.source)
    expect(session.element.getAttribute('name')).toBe(LEASE)
    expect(session.element.dataset.sidebarBrowserFrame).toBe('tauri')
    await session.start()
    session.dispose()
  })
})
