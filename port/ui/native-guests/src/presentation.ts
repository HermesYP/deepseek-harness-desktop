/**
 * `NativeGuestPresentation` — the Sidebar Browser presentation adapter for a
 * Tauri child webview.
 *
 * ## What it replaces, and why it is not a copy
 *
 * The preserved client selects its Browser provider from
 * `globalThis.dshDesktop.browser` (`ui-sidebar-browser/src/client/index.ts:69-101`)
 * and, when present, composes `ElectronWebViewImpl` with
 * `ElectronWebviewPresentation`. That presentation appends a `<webview>` element
 * into the Browser body's `viewport` container
 * (`.../electron/ElectronWebviewPresentation.ts:52-73`) and stops there: the
 * platform's layout engine sizes and clips the guest, and the tag's own events
 * report navigation.
 *
 * A Tauri child webview has neither property. It is a native overlay above the
 * page, so:
 *
 * * its rectangle must be **measured in the page** (the container's
 *   `getBoundingClientRect()`) and relayed to the shell — this module owns that
 *   loop, and it is the whole reason the adapter exists;
 * * it is not clipped by CSS ancestors, so visibility must be driven
 *   explicitly: a container that is display-hidden, scrolled out of a clipped
 *   ancestor, or covered by another layer must hide the guest rather than leave
 *   it floating above the application;
 * * it emits no DOM events, so navigation observation is *not* here — it belongs
 *   to the navigation adapter, which receives the shell's `dsh://` guest events.
 *
 * ## Interface parity with the preserved presentation
 *
 * The object implements the same three members the preserved
 * `BrowserPresentation` face declares (`mount(viewportId)` returning an
 * attachment disposer) plus the lifecycle callbacks
 * `ElectronWebviewPresentation` raises (`mounted`/`unmounted`), so it composes
 * with the preserved `ElectronWebViewImpl` unchanged.
 *
 * ## Deliberate deviations, each one named
 *
 * * `createElement` has no analogue: there is no guest DOM. Instead the adapter
 *   exposes the lease it is presenting, and the navigation adapter uses it.
 * * `clear()` is `hide()` — the child webview is destroyed by the shell when the
 *   lease is released, never by detaching DOM.
 * * `show(title)` stores the accessible label for diagnostics; a native overlay
 *   has no `aria-label` to set on a DOM node. The Browser *body* keeps the real
 *   accessible name, because the preserved chrome still renders it.
 *
 * ## Hide, retire, dispose
 *
 * The three teardown steps are ordered by what each one owns:
 *
 * * `hide()` cancels the queued measurement FIRST, then sends the zero
 *   rectangle. Without the cancellation a frame scheduled before the hide would
 *   place the guest again after it — the native overlay is not clipped by CSS,
 *   so it would float over whatever replaced the Browser body.
 * * `retire()` additionally releases the container observation and drops the
 *   lease binding, and it is `await`-ed before the lease is released: a retired
 *   lease cannot be resurrected by a stale frame or a late observation, because
 *   by then this adapter no longer knows it.
 * * `dispose()` is the idempotent terminal form of `retire()`: every call
 *   returns the same promise, and a placement refusal is reported through the
 *   failure hook instead of rejecting an owner that does not await it.
 */

import { setGuestBounds, type GuestBounds } from '../../desktop-bridge/guests.ts'

/** The presentation face the preserved `ElectronWebViewImpl` consumes. */
export interface NativeGuestPresentationEvents {
  /** A committed content container became the presentation target. */
  readonly mounted: () => void
  /** The content container was released; a later mount may reload the guest. */
  readonly unmounted: () => void
}

/** Native placement commands this adapter drives. */
export interface NativeGuestPlacement {
  /**
   * Move and show or hide the guest behind `lease`.
   * @param lease - opaque main-issued reservation identity.
   * @param bounds - measured rectangle in CSS pixels.
   * @returns after the native bounds update.
   */
  setBounds(lease: string, bounds: GuestBounds): Promise<void>
}

/** How the adapter observes its container. */
export interface NativeGuestMeasurements {
  /**
   * Run `listener` whenever the container's rectangle may have changed.
   * @param container - the measured element.
   * @param listener - called after any change.
   * @returns a disposer that stops the observation.
   */
  observe(container: HTMLElement, listener: () => void): () => void
}

/** Alias kept explicit for callers that pass a custom observation source. */
export type NativeGuestMeasurementSource = NativeGuestMeasurements

/** A zero rectangle, used whenever the guest must not be visible. */
export const HIDDEN_BOUNDS: GuestBounds = { x: 0, y: 0, width: 0, height: 0 }

/** What the adapter does with a placement refusal. */
export type NativeGuestPlacementFailure = (error: unknown) => void

/**
 * Default placement-failure reporting: log once per failure.
 *
 * A refused placement is not ignored — it is reported — but it must not throw
 * into a `ResizeObserver` callback, where the exception would be swallowed by
 * the observation loop and the guest would silently keep its previous rectangle.
 */
function reportPlacementFailure(error: unknown): void {
  console.error('native guest presentation: placement failed', error)
}

/**
 * Production measurements: `ResizeObserver` plus the window events that move an
 * element without resizing it.
 *
 * `ResizeObserver` alone is not sufficient — the Sidebar docks, the window
 * scrolls and the layout animates, and each of those changes the container's
 * viewport-relative position without changing its box. `scroll` is captured so a
 * scroll inside any ancestor is seen.
 * @param container - the measured element.
 * @param listener - called on every change.
 * @returns a disposer removing every source.
 */
function observeWithResizeObserver(container: HTMLElement, listener: () => void): () => void {
  const view = container.ownerDocument.defaultView
  if (view === null) return () => undefined
  const observer = new view.ResizeObserver(listener)
  observer.observe(container)
  // `scroll` does not bubble from a container's ancestors, so the listener is
  // registered in the capture phase on the document.
  view.document.addEventListener('scroll', listener, { capture: true, passive: true })
  view.addEventListener('resize', listener)
  return () => {
    observer.disconnect()
    view.document.removeEventListener('scroll', listener, { capture: true })
    view.removeEventListener('resize', listener)
  }
}

/**
 * Whether a container can show a native guest at all.
 *
 * A hidden container (`display: none`, a zero-area box, or a detached element)
 * must hide the guest: the native overlay is not subject to those CSS rules, so
 * this check is what stops an orphaned guest floating over another surface.
 * @param container - the measured element.
 * @returns whether its rectangle has area and it is still connected.
 */
export function containerIsVisible(container: HTMLElement): boolean {
  if (!container.isConnected) return false
  const rect = container.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/**
 * Measure one container in CSS pixels.
 *
 * The rectangle is rounded the way the shell rounds it
 * (`guests::geometry::GuestBounds::parse`), so the two sides agree on the exact
 * value rather than drifting by a fraction of a pixel.
 * @param container - the measured element.
 * @returns the container rectangle, or {@link HIDDEN_BOUNDS} when hidden.
 */
export function measureContainer(container: HTMLElement): GuestBounds {
  if (!containerIsVisible(container)) return HIDDEN_BOUNDS
  const rect = container.getBoundingClientRect()
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/**
 * Owns attachment of one committed container to one native guest.
 *
 * The instance is created per tab occurrence and reused across mounts, exactly
 * like the preserved presentation: hiding the Sidebar calls `detach()` through
 * the `unmounted` event and does **not** destroy the guest.
 */
export class NativeGuestPresentation {
  private container: HTMLElement | undefined
  private lease: string | undefined
  private stopObserving: (() => void) | undefined
  private frame: number | undefined
  private lastBounds: GuestBounds | undefined
  private title = ''
  private disposal: Promise<void> | undefined
  private attachment = 0

  /**
   * @param events - attachment notifications consumed by the navigation adapter.
   * @param placement - native placement commands.
   * @param measurements - container observation; defaults to
   *   `ResizeObserver` plus window scroll/resize.
   * @param onPlacementFailure - reports a refused placement; defaults to
   *   logging it.
   */
  constructor(
    private readonly events: NativeGuestPresentationEvents,
    private readonly placement: NativeGuestPlacement,
    private readonly measurements: NativeGuestMeasurements = { observe: observeWithResizeObserver },
    private readonly onPlacementFailure: NativeGuestPlacementFailure = reportPlacementFailure,
  ) {}

  /**
   * Bind the guest this presentation places.
   * @param lease - opaque main-issued reservation identity.
   */
  bind(lease: string): void {
    if (this.disposal !== undefined) return
    this.lease = lease
    if (this.container !== undefined) this.schedule()
  }

  /** @returns the bound reservation identity, or `undefined` before binding or after retirement. */
  boundLease(): string | undefined {
    return this.lease
  }

  /**
   * Attach the guest inside a committed content container.
   * @param viewportId - id of the Browser body's `viewport` element.
   * @returns ends physical attachment without disposing the navigation model.
   * @throws {Error} when the container is not mounted, matching the preserved
   *   presentation's refusal so a missing container is never silently ignored.
   */
  mount(viewportId: string): () => void {
    if (this.disposal !== undefined) return () => undefined
    const document = this.document()
    const container = document?.getElementById(viewportId) ?? null
    if (container === null) {
      throw new Error('native guest presentation: content container is not mounted')
    }
    if (this.container !== undefined) {
      this.events.unmounted()
      this.detachContainer()
    }
    const attachment = ++this.attachment
    this.container = container
    this.events.mounted()
    this.stopObserving = this.measurements.observe(container, () => { this.schedule() })
    this.schedule()
    return () => {
      if (this.attachment !== attachment || this.container !== container) return
      this.events.unmounted()
      this.detachContainer()
    }
  }

  /**
   * Record the observed document title.
   *
   * A native overlay carries no DOM node to label; the Browser body renders the
   * accessible name (the preserved `BrowserBody` provides it), so this is kept
   * for diagnostics and for the shell's title observation.
   * @param title - observed document title.
   */
  show(title: string): void {
    this.title = title
  }

  /** @returns the last observed document title. */
  observedTitle(): string {
    return this.title
  }

  /**
   * Hide the guest without releasing it.
   *
   * The navigation model survives: the preserved `ElectronWebViewImpl` calls
   * `detach()` when the Sidebar hides and expects a later `attach()` to reuse the
   * same guest, which is exactly what hiding the child webview preserves.
   *
   * Any queued measurement is cancelled first: a frame scheduled before the hide
   * would otherwise place the guest again after it, leaving the overlay visible
   * over whatever replaced the Browser body.
   * @returns after the native hide; rejects when the shell refuses the placement.
   */
  hide(): Promise<void> {
    this.cancelFrame()
    const lease = this.lease
    this.lastBounds = undefined
    if (lease === undefined) return Promise.resolve()
    return this.placement.setBounds(lease, HIDDEN_BOUNDS)
  }

  /**
   * Hide the guest and retire this presentation's binding to its lease.
   *
   * Every observer and queued frame is released BEFORE the hide command is
   * awaited, so nothing can re-place a lease that is about to be released — a
   * stale frame must not resurrect a retired guest. Idempotent: after the lease
   * is retired, a second call resolves without another placement command.
   * @returns after the native hide settled; a refusal is reported, never thrown
   *   into the caller releasing the lease.
   */
  async retire(): Promise<void> {
    this.stopObserving?.()
    this.stopObserving = undefined
    this.cancelFrame()
    this.container = undefined
    // Invalidate any outstanding `mount` disposer: its container is gone.
    this.attachment += 1
    const lease = this.lease
    this.lease = undefined
    this.lastBounds = undefined
    if (lease === undefined) return
    try {
      await this.placement.setBounds(lease, HIDDEN_BOUNDS)
    } catch (error) {
      this.onPlacementFailure(error)
    }
  }

  /**
   * Stop the presentation permanently.
   *
   * The child webview is destroyed by the shell when the lease is released, so
   * this releases measurement, cancels queued layout and hides the guest. The
   * returned promise is the same for every call, and is already settled by the
   * time a later call joins it; a placement refusal is reported rather than
   * rejected so an owner that does not await it cannot leak an unhandled
   * rejection.
   * @returns after the hide settled.
   */
  dispose(): Promise<void> {
    this.disposal ??= this.retire()
    return this.disposal
  }

  /** The document the current container belongs to, or the page document. */
  private document(): Document | undefined {
    const container = this.container
    if (container !== undefined) return container.ownerDocument
    // `globalThis.document` exists only in a DOM carrier; the presentation is
    // never used outside one, and returning `undefined` keeps that explicit
    // rather than throwing from a getter.
    return (globalThis as { document?: Document }).document
  }

  /** Release the container and every observation of it, hiding the guest. */
  private detachContainer(): void {
    this.stopObserving?.()
    this.stopObserving = undefined
    this.cancelFrame()
    this.container = undefined
    void this.hide().catch(this.onPlacementFailure)
  }

  /** Cancel one queued measurement, if any. */
  private cancelFrame(): void {
    const frame = this.frame
    this.frame = undefined
    if (frame === undefined) return
    // `container` may already be cleared; the page frame owner still cancels the
    // handle it minted.
    const view = this.container?.ownerDocument.defaultView
      ?? (globalThis as { document?: Document }).document?.defaultView
    view?.cancelAnimationFrame(frame)
  }

  /** Coalesce a burst of measurement notifications into one native update. */
  private schedule(): void {
    if (this.disposal !== undefined || this.lease === undefined) return
    const view = this.container?.ownerDocument.defaultView
    if (view === null || view === undefined) {
      // No animation-frame owner (a detached container): measure immediately so
      // the hide still happens.
      this.flush()
      return
    }
    if (this.frame !== undefined) return
    this.frame = view.requestAnimationFrame(() => {
      this.frame = undefined
      this.flush()
    })
  }

  /** Send the current rectangle when it differs from the last one sent. */
  private flush(): void {
    const container = this.container
    const lease = this.lease
    if (container === undefined || lease === undefined) return
    const bounds = measureContainer(container)
    const previous = this.lastBounds
    if (
      previous !== undefined
      && previous.x === bounds.x && previous.y === bounds.y
      && previous.width === bounds.width && previous.height === bounds.height
    ) {
      return
    }
    this.lastBounds = bounds
    void this.placement.setBounds(lease, bounds).catch(this.onPlacementFailure)
  }
}

/**
 * Build the presentation over the shell's real placement command.
 *
 * The one line a caller should not have to remember is which command places a
 * guest, so it is bound here rather than at every call site.
 * @param events - attachment notifications consumed by the navigation adapter.
 * @param onPlacementFailure - reports a refused placement; defaults to logging.
 * @param measurements - container observation; defaults to `ResizeObserver` plus
 *   window scroll/resize.
 * @returns the presentation for one tab occurrence.
 */
export function createNativeGuestPresentation(
  events: NativeGuestPresentationEvents,
  onPlacementFailure?: NativeGuestPlacementFailure,
  measurements?: NativeGuestMeasurements,
): NativeGuestPresentation {
  const placement: NativeGuestPlacement = {
    async setBounds(lease: string, bounds: GuestBounds): Promise<void> {
      await setGuestBounds(lease, bounds)
    },
  }
  return new NativeGuestPresentation(events, placement, measurements, onPlacementFailure)
}
