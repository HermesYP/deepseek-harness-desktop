/**
 * `NativeGuestSession` — the live binding between one guest lease, its element
 * and the shell's state reports.
 *
 * `frame.ts` reproduces the `<webview>` element surface and `presentation.ts`
 * owns the rectangle; neither owns the *subscription*, and without one the
 * element would answer `getURL()`, `canGoBack()` and `isLoading()` from its
 * initial values forever — the exact "simulated state" failure this adapter
 * exists to avoid.
 *
 * The session is that owner. It:
 *
 * * subscribes to `dsh://guests/browser-state` through a
 *   {@link NativeGuestNavigation} implementation that can also `observe()`;
 * * routes each report to the element whose lease it names, and drops a report
 *   for a lease this session does not own;
 * * pulls the current document once on {@link NativeGuestSession.start} so the
 *   preserved `dom-ready` path reads real values rather than defaults;
 * * reports a failed subscription with the error it received, so a shell that
 *   cannot deliver state is visible rather than silently inert.
 *
 * A guest with no state subscription is still navigable — every command works —
 * so a subscription failure is reported, never thrown.
 */

import {
  applyGuestState, createNativeGuestElement,
  type NativeGuestElement, type NativeGuestNavigation, type NativeGuestState,
} from './frame.ts'

/** One subscription disposer. */
export type NativeGuestUnlisten = () => void

/**
 * The navigation face plus the state subscription a session needs.
 *
 * {@link NativeGuestNavigation} is required by the element; this adds the two
 * observations the driver makes.
 */
export interface NativeGuestStateSource {
  /** @param lease - the guest's reservation. @returns its current document. */
  observe(lease: string): Promise<NativeGuestState>
  /**
   * @param listener - receives every guest's report.
   * @returns the subscription disposer.
   */
  subscribe(listener: (state: NativeGuestState) => void): Promise<NativeGuestUnlisten>
}

/** How a session reports a failed state subscription. */
export type NativeGuestSubscriptionFailure = (error: unknown) => void

/** Default subscription-failure report: log once. */
function reportSubscriptionFailure(error: unknown): void {
  console.error('native guest session: state subscription failed', error)
}

/**
 * Owns one guest's element, its commands and its live state.
 *
 * The instance is created per tab occurrence and disposed with it; the lease it
 * carries is main-issued and never reused.
 */
export class NativeGuestSession {
  /** The element the preserved `ElectronWebViewImpl` drives. */
  readonly element: NativeGuestElement
  private stop: NativeGuestUnlisten | undefined
  private starting: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private disposed = false

  /**
   * @param lease - opaque main-issued reservation identity.
   * @param commands - navigation commands over the shell's guest commands.
   * @param source - the state observations the driver needs.
   * @param onSubscriptionFailure - reports a failed subscription.
   */
  constructor(
    readonly lease: string,
    commands: NativeGuestNavigation,
    private readonly source: NativeGuestStateSource,
    private readonly onSubscriptionFailure: NativeGuestSubscriptionFailure = reportSubscriptionFailure,
  ) {
    this.element = createNativeGuestElement(lease, commands)
  }

  /**
   * Subscribe to the guest's state and pull its current document once.
   *
   * @returns after the subscription is installed and the first observation
   *   applied; repeated calls join the first.
   * @throws never — a failed subscription is reported through the configured
   *   failure hook, because command navigation still works without it.
   */
  start(): Promise<void> {
    if (this.starting !== undefined) return this.starting
    // Publish the shared promise before subscribe can synchronously reenter.
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const starting = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    this.starting = starting
    try {
      void this.install().then(resolve, reject)
    } catch (error: unknown) {
      reject(error)
    }
    return starting
  }

  /**
   * Record the observed document title for the presentation's diagnostics.
   * @returns the last observed title, or `''` before the first report.
   */
  observedTitle(): string {
    return this.element.getTitle()
  }

  /**
   * End the subscription and report when it is actually gone.
   *
   * The element keeps its last observed state, and the listener is released
   * exactly once. Disposal is attempted once even when the transport disposer
   * throws.
   *
   * The returned promise is what makes the release ORDER real rather than
   * eventual: a `subscribe()` round trip that is still in flight when disposal
   * lands has had no disposer to call yet, so awaiting this resolves only after
   * that round trip settled and its listener was released. A caller that
   * releases the lease (or hides the child webview) without awaiting would
   * otherwise leave `dsh://guests/browser-state` registered behind it.
   *
   * It never rejects: teardown is best-effort and must not block the owning
   * lease release. Every call returns the same promise, so repeated and
   * concurrent disposals join one teardown.
   * @returns after an installed or in-flight subscription has been released.
   */
  dispose(): Promise<void> {
    if (!this.disposed) {
      this.disposed = true
      const stop = this.stop
      this.stop = undefined
      try { stop?.() } catch { /* disposal is terminal; do not retry */ }
    }
    // `starting` settles only after `install()` handled the disposal — including
    // the in-flight case, where `install()` invokes the late disposer itself.
    this.disposal ??= this.starting?.then(() => undefined, () => undefined) ?? Promise.resolve()
    return this.disposal
  }

  /** Install the subscription and pull one observation. */
  private async install(): Promise<void> {
    if (this.disposed) return
    let stateRevision = 0
    // The initial pull is only a fallback: even an event delivered while
    // subscribe() is installing takes precedence over its unrevisioned snapshot.
    const revisionBeforeSubscribe = stateRevision
    try {
      const stop = await this.source.subscribe((state) => {
        if (this.disposed || state.lease !== this.lease) return
        stateRevision += 1
        applyGuestState(this.element, state)
      })
      if (this.disposed) {
        try { stop() } catch { /* disposal is terminal; do not retry */ }
        return
      }
      this.stop = stop
    } catch (error: unknown) {
      if (!this.disposed) this.reportFailure(error)
    }
    // Rejection and the failure hook can both race or synchronously end ownership.
    if (this.disposed) return
    try {
      const observed = await this.source.observe(this.lease)
      if (!this.disposed && stateRevision === revisionBeforeSubscribe) {
        applyGuestState(this.element, observed)
      }
    } catch (error: unknown) {
      if (!this.disposed) this.reportFailure(error)
    }
  }

  /** Failure hooks are observational and cannot break session cleanup. */
  private reportFailure(error: unknown): void {
    try { this.onSubscriptionFailure(error) } catch { /* never escape the hook */ }
  }
}

/**
 * Build one session for a lease.
 *
 * @param lease - the guest's reservation.
 * @param commands - navigation commands over the shell's guest commands.
 * @param source - the state observations the driver needs.
 * @param onSubscriptionFailure - reports a failed subscription.
 * @returns the session, not yet subscribed.
 */
export function createNativeGuestSession(
  lease: string,
  commands: NativeGuestNavigation,
  source: NativeGuestStateSource,
  onSubscriptionFailure?: NativeGuestSubscriptionFailure,
): NativeGuestSession {
  return new NativeGuestSession(lease, commands, source, onSubscriptionFailure)
}
