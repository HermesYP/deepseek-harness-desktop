/**
 * Port-owned Browser page assembly for a caller-supplied retained frame.
 *
 * ## What this file owns
 *
 * The preserved `ElectronWebViewImpl` picks the guest provider from
 * `globalThis.dshDesktop.browser` and drives the returned element; the port
 * supplies that provider here, plus the physical presentation a Tauri child
 * webview needs. Three lifetimes are bound together per tab occurrence:
 *
 * * the {@link NativeGuestSession} — the `dsh://guests/browser-state`
 *   subscription and the synthetic element;
 * * the {@link NativeGuestPresentation} — the measured rectangle relay;
 * * the main-issued lease — released through the injected `release`.
 *
 * ## Teardown order, and why it matters
 *
 * A Tauri child webview is a native overlay, so "close the tab" is not "detach a
 * DOM node": it is hide, then release. This factory is the single release owner
 * for a lease, and it performs those steps in one order:
 *
 * 1. **await** the session's disposal — its listeners released, and a
 *    subscription still in flight cancelled — so no later state report reaches
 *    an element that is going away and no listener outlives the lease;
 * 2. `retire()` the presentation, which disconnects the container observation,
 *    cancels queued layout and awaits the native hide — a stale frame must not
 *    re-place a lease that is about to be released;
 * 3. release the lease, awaiting the shell's acknowledgement.
 *
 * The whole teardown is coalesced into one promise, so `clear()`, `dispose()` and
 * a re-entrant `createElement` for the next tab all join it instead of issuing a
 * second hide or a second release. The release is attempted exactly once per
 * retired lease even when the hide or the release is refused: the lease is gone
 * either way, and an orphaned guest is worse than a reported refusal.
 */
import type { DesktopBrowserReservation } from '../../desktop-bridge/markers.ts'
import type { GuestNavigation, GuestBounds } from '../../desktop-bridge/guests.ts'
import type { NativeGuestElement } from './frame.ts'
import { createNativeGuestSession } from './session.ts'
import { NativeGuestPresentation, type NativeGuestMeasurements } from './presentation.ts'

/** Options consumed by the retained Sidebar Browser frame. */
export interface BrowserPageOptions<State> {
  readonly initial: State | undefined
  readonly persist: (state: State) => void
  readonly openRequested: (url: string) => void
}

/** Retained frame operations and physical attachment lifecycle. */
export interface BrowserFrame<Target, Snapshot> {
  readonly getSnapshot: () => Snapshot
  readonly subscribe: (listener: () => void) => () => void
  loadUrl(target: Target): void
  goBack(): void
  goForward(): void
  reload(): void
  attach(): void
  detach(): void
  dispose(): Promise<void>
}

/** Native presentation operations supplied to the retained frame constructor. */
export interface BrowserPresentation {
  mount(viewportId: string): () => void
  createElement(reservation: DesktopBrowserReservation): NativeGuestElement
  present(element: NativeGuestElement): void
  clear(): void
  show(title: string): void
  dispose(): void
}

/** The page shape returned by the retained Browser provider. */
export interface BrowserPage<Target, Snapshot> {
  readonly frame: BrowserFrame<Target, Snapshot>
  readonly presentation: BrowserPresentation
}

/** Creates the bridge used by one guest session or retained frame. */
export type GuestNavigationFactory = () => GuestNavigation

/** Retained frame constructor which consumes the native page presentation. */
export type RetainedFrameFactory<State, Target, Snapshot> = (
  options: BrowserPageOptions<State>, navigation: GuestNavigation, presentation: BrowserPresentation,
) => BrowserFrame<Target, Snapshot>

/** Inputs required to assemble one native Browser page. */
export interface BrowserPageFactoryOptions<State, Target, Snapshot> {
  readonly navigation: () => GuestNavigation
  readonly createFrame: RetainedFrameFactory<State, Target, Snapshot>
  readonly setBounds: (lease: string, bounds: GuestBounds) => Promise<void>
  readonly release: (lease: string) => Promise<void>
  readonly onError: (error: unknown) => void
  readonly measurements?: NativeGuestMeasurements
}

/**
 * Build a typed retained-compatible Browser page factory.
 *
 * The factory is the single owner of each lease's release; a future retained
 * frame composed over it must not also release the same lease through the
 * bridge.
 * @param dependencies - navigation, frame, placement, release and reporting.
 * @returns a factory that assembles one Browser page per tab occurrence.
 */
export function createBrowserPageFactory<State, Target, Snapshot>(
  dependencies: BrowserPageFactoryOptions<State, Target, Snapshot>,
): (options: BrowserPageOptions<State>) => BrowserPage<Target, Snapshot> {
  return (options) => {
    let element: NativeGuestElement | undefined
    let session: ReturnType<typeof createNativeGuestSession> | undefined
    let lease: string | undefined
    let disposed = false
    /** One in-flight teardown per retired lease; every caller joins it. */
    let teardown: Promise<void> | undefined

    const native = new NativeGuestPresentation({
      mounted: () => frame.attach(),
      unmounted: () => frame.detach(),
    }, { setBounds: dependencies.setBounds }, dependencies.measurements, dependencies.onError)

    /**
     * Dispose the session, await the hide, then release the lease — once.
     *
     * The session is dropped before the hide so a state report arriving during
     * the hide cannot repopulate a retired element, and the hide is awaited
     * before the release so the shell never destroys a guest the page still
     * expects to be hidden. Disposal is AWAITED, not merely started: a
     * `subscribe` round trip still in flight has no disposer yet, and resolving
     * the unsubscribe before the hide and the release is what stops a released
     * lease from keeping a `dsh://guests/browser-state` listener behind it.
     */
    const closeSession = async (): Promise<void> => {
      const ownedLease = lease
      lease = undefined
      const owned = session
      session = undefined
      element = undefined
      await owned?.dispose()
      await native.retire()
      if (ownedLease === undefined) return
      try {
        await dependencies.release(ownedLease)
      } catch (error) {
        dependencies.onError(error)
      }
    }

    /** Start or join the one teardown of the current lease. */
    const retire = (): Promise<void> => {
      teardown ??= closeSession()
      return teardown
    }

    const presentation: BrowserPresentation = {
      mount: (id) => {
        if (disposed) return () => undefined
        return native.mount(id)
      },
      createElement: (reservation) => {
        if (disposed) throw new Error('native browser page: presentation is disposed')
        // The retiring lease finishes hiding and releasing before this one is
        // bound, so the new guest can never be placed under the old lease's
        // last rectangle.
        const previous = retire()
        teardown = undefined
        const navigation = dependencies.navigation()
        const next = createNativeGuestSession(reservation.lease, {
          load: (ownedLease, url) => navigation.navigate(ownedLease, url),
          reload: (ownedLease) => navigation.command(ownedLease, 'reload'),
          goBack: (ownedLease) => navigation.command(ownedLease, 'back'),
          goForward: (ownedLease) => navigation.command(ownedLease, 'forward'),
          clearHistory: (ownedLease) => navigation.command(ownedLease, 'clear-history'),
          observe: (ownedLease) => navigation.state(ownedLease),
        }, {
          observe: (ownedLease) => navigation.state(ownedLease),
          subscribe: (listener) => navigation.onState(listener),
        }, dependencies.onError)
        session = next
        element = next.element
        void previous.then(async () => {
          if (disposed || session !== next) {
            // The page retired while this lease was being adopted. Nothing ever
            // bound this lease to the presentation, and `acquire` created the
            // guest hidden, so dropping the subscription and releasing it leaves
            // no visible guest behind. The unsubscribe is awaited first, so the
            // release never outruns the listener it was holding.
            await next.dispose()
            return dependencies.release(reservation.lease).catch(dependencies.onError)
          }
          lease = reservation.lease
          native.bind(reservation.lease)
          return next.start().catch(dependencies.onError)
        }, dependencies.onError)
        return next.element
      },
      present: (next) => {
        if (disposed || element !== next) throw new Error('native browser page: element is not owned by this page')
      },
      clear: () => {
        // The teardown hides the bound lease itself, after cancelling queued
        // layout; a second hide call would race that sequence.
        void retire()
      },
      show: (title) => native.show(title),
      dispose: () => {
        if (disposed) return
        disposed = true
        void retire().then(() => native.dispose(), dependencies.onError)
      },
    }
    const frame = dependencies.createFrame(options, dependencies.navigation(), presentation)
    return { frame, presentation }
  }
}
