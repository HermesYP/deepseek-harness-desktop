// @vitest-environment jsdom
/**
 * Regression tests for the native guest presentation adapter
 * (`port/ui/native-guests/src/presentation.ts`).
 *
 * The audit's lane-G gate requires geometry, clipping/layer visibility, focus
 * and teardown to be real, so each behaviour is asserted against a driven
 * observation instead of a described one:
 *
 * * the guest rectangle is measured from the preserved Browser body's `viewport`
 *   container and relayed rounded, matching the shell's own rounding;
 * * a burst of notifications collapses into one placement, and an unchanged
 *   rectangle sends nothing;
 * * a container that is display-hidden, zero-area or detached **hides** the
 *   guest rather than leaving the native overlay floating over the application;
 * * `detach` hides without destroying (the preserved `ElectronWebViewImpl`
 *   reuses the guest after a re-mount);
 * * a refused placement is reported, never silently swallowed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HIDDEN_BOUNDS, NativeGuestPresentation, measureContainer } from '../src/presentation.ts'
import type { NativeGuestMeasurementSource } from '../src/presentation.ts'

/** A manually driven measurement source, so no real ResizeObserver is needed. */
function createMeasurements() {
  let notify: (() => void) | undefined
  const observed: HTMLElement[] = []
  let stopped = 0
  return {
    observed,
    get stopped(): number { return stopped },
    /** Fire every registered observation callback. */
    fire(): void { notify?.() },
    source: {
      observe(container: HTMLElement, listener: () => void): () => void {
        observed.push(container)
        notify = listener
        return () => { stopped += 1; notify = undefined }
      },
    } satisfies NativeGuestMeasurementSource,
  }
}

/** A placement recorder with per-call control over the answer. */
function createPlacement() {
  const calls: { lease: string; bounds: unknown }[] = []
  let refuse: ((lease: string) => unknown) | undefined
  return {
    calls,
    refuseWith(reason: unknown): void { refuse = () => reason },
    placement: {
      async setBounds(lease: string, bounds: unknown): Promise<void> {
        calls.push({ lease, bounds })
        if (refuse !== undefined) throw refuse(lease)
      },
    },
  }
}

/** Mount a container the adapter measures, with a controllable rectangle. */
function mountContainer(rect: { x: number; y: number; width: number; height: number }) {
  const container = document.createElement('div')
  container.id = `viewport-${Math.random().toString(36).slice(2)}`
  container.getBoundingClientRect = () => ({
    x: rect.x, y: rect.y, width: rect.width, height: rect.height,
    top: rect.y, left: rect.x, right: rect.x + rect.width, bottom: rect.y + rect.height,
    toJSON: () => rect,
  } as DOMRect)
  document.body.append(container)
  return container
}

/** Let the adapter's animation-frame coalescing run. */
async function settle(): Promise<void> {
  await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve() }) })
}

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('guest measurement', () => {
  it('rounds a container rectangle the way the shell rounds it', () => {
    const container = mountContainer({ x: 10.4, y: 0.6, width: 300.5, height: 199.5 })
    expect(measureContainer(container)).toEqual({ x: 10, y: 1, width: 301, height: 200 })
  })

  it('reports a hidden rectangle for a zero-area or detached container', () => {
    expect(measureContainer(mountContainer({ x: 0, y: 0, width: 0, height: 640 }))).toEqual(HIDDEN_BOUNDS)
    expect(measureContainer(mountContainer({ x: 0, y: 0, width: 320, height: 0 }))).toEqual(HIDDEN_BOUNDS)
    const detached = document.createElement('div')
    expect(measureContainer(detached)).toEqual(HIDDEN_BOUNDS)
  })
})

describe('native guest presentation', () => {
  it('places the guest at the measured container rectangle', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const events = { mounted: vi.fn(), unmounted: vi.fn() }
    const presentation = new NativeGuestPresentation(events, placement, measurements.source)
    presentation.bind('lease-1')
    const container = mountContainer({ x: 12, y: 34, width: 560, height: 780 })

    const detach = presentation.mount(container.id)
    await settle()

    expect(events.mounted).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([{ lease: 'lease-1', bounds: { x: 12, y: 34, width: 560, height: 780 } }])
    detach()
  })

  it('replaces observation on same-container remount and ignores stale disposer', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const events = { mounted: vi.fn(), unmounted: vi.fn() }
    const presentation = new NativeGuestPresentation(events, placement, measurements.source)
    presentation.bind('lease-1')
    const container = mountContainer({ x: 1, y: 1, width: 30, height: 30 })
    const oldDetach = presentation.mount(container.id)
    const newDetach = presentation.mount(container.id)
    oldDetach()
    await settle()
    expect(measurements.stopped).toBe(1)
    expect(events.unmounted).toHaveBeenCalledTimes(1)
    expect(events.mounted).toHaveBeenCalledTimes(2)
    expect(calls.at(-1)?.bounds).toEqual({ x: 1, y: 1, width: 30, height: 30 })
    newDetach()
    expect(events.unmounted).toHaveBeenCalledTimes(2)
  })

  it('refuses a mount when the content container is absent', () => {
    const measurements = createMeasurements()
    const { placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    presentation.bind('lease-1')
    expect(() => presentation.mount('no-such-container'))
      .toThrowError('native guest presentation: content container is not mounted')
  })

  it('collapses a notification burst into one placement and skips an unchanged rectangle', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    presentation.bind('lease-1')
    const container = mountContainer({ x: 0, y: 0, width: 400, height: 300 })
    const detach = presentation.mount(container.id)
    await settle()
    expect(calls).toHaveLength(1)

    for (let index = 0; index < 5; index += 1) measurements.fire()
    await settle()
    expect(calls).toHaveLength(1)

    container.getBoundingClientRect = () => ({
      x: 5, y: 5, width: 400, height: 300,
      top: 5, left: 5, right: 405, bottom: 305, toJSON: () => ({}),
    } as DOMRect)
    measurements.fire()
    await settle()
    expect(calls).toHaveLength(2)
    expect(calls[1]?.bounds).toEqual({ x: 5, y: 5, width: 400, height: 300 })
    detach()
  })

  it('hides the guest when the container collapses instead of leaving it floating', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    presentation.bind('lease-1')
    const container = mountContainer({ x: 0, y: 0, width: 400, height: 300 })
    const detach = presentation.mount(container.id)
    await settle()

    container.getBoundingClientRect = () => ({
      x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
    } as DOMRect)
    measurements.fire()
    await settle()

    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: HIDDEN_BOUNDS })
    detach()
  })

  it('hides without destroying when the container is released, and reuses the guest', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const events = { mounted: vi.fn(), unmounted: vi.fn() }
    const presentation = new NativeGuestPresentation(events, placement, measurements.source)
    presentation.bind('lease-1')
    const container = mountContainer({ x: 1, y: 2, width: 300, height: 200 })

    const detach = presentation.mount(container.id)
    await settle()
    detach()
    await settle()

    expect(events.unmounted).toHaveBeenCalledTimes(1)
    expect(measurements.stopped).toBe(1)
    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: HIDDEN_BOUNDS })
    // No release command exists on this face: the guest survives for a re-mount.
    expect(presentation.boundLease()).toBe('lease-1')

    const again = mountContainer({ x: 7, y: 8, width: 320, height: 240 })
    const detachAgain = presentation.mount(again.id)
    await settle()
    expect(events.mounted).toHaveBeenCalledTimes(2)
    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: { x: 7, y: 8, width: 320, height: 240 } })
    detachAgain()
  })

  it('reports a refused placement instead of swallowing it', async () => {
    const measurements = createMeasurements()
    const { placement, refuseWith } = createPlacement()
    const failures = vi.fn()
    refuseWith({ kind: 'other', detail: { code: 'guest_bounds', message: 'refused' } })
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source, failures,
    )
    presentation.bind('lease-1')
    const detach = presentation.mount(mountContainer({ x: 0, y: 0, width: 10, height: 10 }).id)
    await settle()
    await settle()

    expect(failures).toHaveBeenCalled()
    detach()
  })

  it('keeps the guest hidden until a lease is bound', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    const container = mountContainer({ x: 0, y: 0, width: 400, height: 300 })
    const detach = presentation.mount(container.id)
    await settle()
    expect(calls).toEqual([])

    presentation.bind('lease-9')
    await settle()
    expect(calls).toEqual([{ lease: 'lease-9', bounds: { x: 0, y: 0, width: 400, height: 300 } }])
    detach()
  })

  it('stops measuring and hides after disposal', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    presentation.bind('lease-1')
    const detach = presentation.mount(mountContainer({ x: 0, y: 0, width: 50, height: 50 }).id)
    await settle()
    const before = calls.length

    presentation.dispose()
    await settle()
    expect(measurements.stopped).toBe(1)
    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: HIDDEN_BOUNDS })
    expect(calls.length).toBeGreaterThan(before - 1)
    // A later notification cannot move a disposed presentation.
    measurements.fire()
    await settle()
    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: HIDDEN_BOUNDS })
    detach()
  })

  it('records the observed document title for the chrome', () => {
    const measurements = createMeasurements()
    const { placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    expect(presentation.observedTitle()).toBe('')
    presentation.show('Example Domain')
    expect(presentation.observedTitle()).toBe('Example Domain')
  })

  it('cancels queued layout before hiding, so a pending measurement cannot re-show the guest', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    presentation.bind('lease-1')
    const detach = presentation.mount(mountContainer({ x: 0, y: 0, width: 120, height: 90 }).id)
    await settle()
    expect(calls).toHaveLength(1)

    // A measurement notification schedules the next placement…
    measurements.fire()
    // …and the hide lands before that frame runs.
    await presentation.hide()
    await settle()

    // The measured rectangle was never sent after the hide: no resurrect.
    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: HIDDEN_BOUNDS })
    expect(calls.filter(call => (call.bounds as { width: number }).width === 120)).toHaveLength(1)
    detach()
  })

  it('retires the lease after awaiting its hide, and a stale observation cannot place it again', async () => {
    const measurements = createMeasurements()
    const { calls, placement } = createPlacement()
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source,
    )
    presentation.bind('lease-1')
    const detach = presentation.mount(mountContainer({ x: 3, y: 4, width: 60, height: 40 }).id)
    await settle()
    measurements.fire()

    await presentation.retire()

    // The observation was disconnected and the binding dropped: the hide is the
    // last command this presentation may send for the retired lease.
    expect(measurements.stopped).toBe(1)
    expect(presentation.boundLease()).toBeUndefined()
    expect(calls.at(-1)).toEqual({ lease: 'lease-1', bounds: HIDDEN_BOUNDS })
    const afterRetire = calls.length
    measurements.fire()
    await settle()
    expect(calls).toHaveLength(afterRetire)

    // A stale mount disposer is inert. Re-binding a NEW lease is legitimate —
    // that is the next tab — but the retired lease must never be placed again,
    // and its stale frame cannot carry over into the new binding.
    detach()
    presentation.bind('lease-2')
    expect(presentation.boundLease()).toBe('lease-2')
    expect(calls.every(call => call.lease === 'lease-1')).toBe(true)
    measurements.fire()
    await settle()
    expect(calls).toHaveLength(afterRetire)
  })

  it('disposes idempotently and reports a refused hide instead of rejecting an owner that does not await it', async () => {
    const measurements = createMeasurements()
    const { placement, refuseWith } = createPlacement()
    const failures = vi.fn()
    refuseWith({ kind: 'other', detail: { code: 'guest_bounds', message: 'refused' } })
    const presentation = new NativeGuestPresentation(
      { mounted: vi.fn(), unmounted: vi.fn() }, placement, measurements.source, failures,
    )
    presentation.bind('lease-1')
    presentation.mount(mountContainer({ x: 0, y: 0, width: 30, height: 30 }).id)

    const first = presentation.dispose()
    const second = presentation.dispose()
    expect(second).toBe(first)
    await expect(first).resolves.toBeUndefined()
    expect(failures).toHaveBeenCalled()
    expect(presentation.boundLease()).toBeUndefined()

    // A disposed presentation refuses every later mount without throwing.
    const later = presentation.mount(mountContainer({ x: 0, y: 0, width: 30, height: 30 }).id)
    expect(() => later()).not.toThrow()
  })
})
