/**
 * `NativeGuestFrame` — the navigation face for a Tauri child webview.
 *
 * ## Why a carrier-neutral frame, and not a reimplementation
 *
 * The preserved `ElectronWebViewImpl`
 * (`ui-sidebar-browser/src/client/electron/ElectronWebViewImpl.ts`) is written
 * against the **`<webview>` element API**: it calls `element.loadURL`,
 * `element.getURL()`, `element.canGoBack()`, `element.clearHistory()` and reads
 * the DOM events `dom-ready`, `did-navigate`, `did-navigate-in-page`,
 * `did-start-navigation`, `did-start/stop-loading`, `page-title-updated`,
 * `did-fail-load`, `render-process-gone` and `destroyed`. None of those exist for
 * a Tauri child webview, which is a separate top-level document reached only
 * through the shell's commands and `dsh://` events.
 *
 * Reimplementing the browser tab against Tauri would duplicate the entire
 * preserved navigation model — history, checkpoint persistence, revision
 * tracking, address validation — and drift from it. Instead this module
 * reproduces **exactly the element surface** `ElectronWebViewImpl` consumes and
 * drives it from the shell. The preserved class is then the only navigation
 * implementation, and the port supplies the carrier underneath it.
 *
 * ## Every method is a command, every event is an observation
 *
 * `loadURL`, `goBack`, `goForward`, `reload` and `clearHistory` call
 * {@link NativeGuestNavigation}, whose production implementation issues the Rust
 * guest commands. The shell re-validates each address against the same policy
 * the native WebView2 navigation hook applies, so this adapter never decides what
 * is allowed.
 *
 * The element observes by *subscribing*: {@link applyGuestState} applies any
 * report that arrives, and `refresh()` pulls the current document on demand.
 * The element does not poll; it is driven by the shell's
 * `dsh://guests/browser-state` emissions, exactly as the `<webview>` tag was
 * driven by Chromium's own events.
 *
 * ## Event translation
 *
 * | Preserved listener | Native source |
 * | --- | --- |
 * | `dom-ready` | the first state report for the lease |
 * | `did-start-loading` / `did-stop-loading` | `state.loading` transitions |
 * | `did-navigate` | `state.url` changed to a different document |
 * | `did-navigate-in-page` | `state.url` changed only in its fragment |
 * | `page-title-updated` | `state.title` change |
 * | `did-fail-load` | `state.error` |
 * | `render-process-gone` / `destroyed` | `state.gone` |
 *
 * The in-page arm is the one the shell cannot report directly: a fragment-only
 * change is a same-document navigation, and the preserved
 * `ElectronWebViewImpl` treats it exactly like a commit (it re-reads the
 * element's state). The two URLs are compared with the fragment removed, which
 * is the only same-document change an observation can distinguish; a
 * `history.pushState` that keeps the whole URL unchanged is invisible to both
 * carriers and is not claimed.
 *
 * Every emitted event carries the same fields the preserved listeners read
 * (`isMainFrame`, `errorCode`, `errorDescription`), so no preserved branch is
 * dead.
 */

import type { GuestBrowserFailure, GuestBrowserState } from '../../desktop-bridge/protocol.ts'

/**
 * One shell-reported guest state — `guests::GuestBrowserState` verbatim, so the
 * bridge and this adapter cannot drift about a field or its nullability.
 */
export type NativeGuestState = GuestBrowserState

/** Native navigation commands this frame issues. */
export interface NativeGuestNavigation {
  /**
   * Load one validated address in the guest behind `lease`.
   * @param lease - the guest's reservation.
   * @param url - canonical `http`/`https` address.
   */
  load(lease: string, url: string): Promise<void>
  /** @param lease - the guest's reservation. */
  reload(lease: string): Promise<void>
  /** @param lease - the guest's reservation. */
  goBack(lease: string): Promise<void>
  /** @param lease - the guest's reservation. */
  goForward(lease: string): Promise<void>
  /**
   * Drop the bootstrap document's history entry so the lease-bearing
   * `about:blank#<lease>` seed is not a user-visible history entry — the same
   * operation the preserved `observeReady` performs via `clearHistory()`.
   * @param lease - the guest's reservation.
   */
  clearHistory(lease: string): Promise<void>
  /**
   * Read the guest's current document state.
   *
   * The `<webview>` tag answered `getURL()`/`getTitle()`/`canGoBack()`/… from
   * its own synchronous state; a child webview is in another process, so the
   * element keeps the last observed state and refreshes it through this call.
   * @param lease - the guest's reservation.
   * @returns the live observation.
   */
  observe(lease: string): Promise<NativeGuestState>
}

/** A synthetic DOM event carrying the fields the preserved listeners read. */
interface NavigationEvent extends Event {
  readonly isMainFrame: boolean
}

/** Failure variant of {@link NavigationEvent}. */
interface LoadFailureEvent extends NavigationEvent {
  readonly errorCode: number
  readonly errorDescription: string
}

/**
 * The element surface the preserved `ElectronWebViewImpl` consumes.
 *
 * Deliberately identical to `WebviewElement`
 * (`.../electron/ElectronWebviewPresentation.ts:7-18`) so the preserved class
 * needs no change; `loadURL` also accepts the `ERR_ABORTED` rejection the
 * preserved `loadPending` filters.
 */
export interface NativeGuestElement extends HTMLElement {
  /** @param url - canonical address. */
  loadURL(url: string): Promise<void>
  /** @returns the current document URL. */
  getURL(): string
  /** @returns the current document title. */
  getTitle(): string
  /** @returns whether a backward entry exists. */
  canGoBack(): boolean
  /** @returns whether a forward entry exists. */
  canGoForward(): boolean
  /** Drops the bootstrap document's history entry. */
  clearHistory(): void
  /** Moves backward in the guest's history. */
  goBack(): void
  /** Moves forward in the guest's history. */
  goForward(): void
  /** Reloads the current address. */
  reload(): void
  /** @returns whether the guest is loading. */
  isLoading(): boolean
}

/**
 * One guest's synthetic element: a detached `HTMLElement` carrying the preserved
 * `WebviewElement` methods, driven by the shell's state reports.
 */
class SyntheticGuestElement {
  readonly node: HTMLElement
  private state: NativeGuestState
  private ready = false

  constructor(
    private readonly lease: string,
    private readonly navigation: NativeGuestNavigation,
    initialUrl: string,
  ) {
    this.node = document.createElement('div')
    // The retained presentation marks its guest; the port marks the same
    // attribute with the port's own value so a capture can tell which carrier
    // produced a Browser surface.
    this.node.dataset.sidebarBrowserFrame = 'tauri'
    this.node.setAttribute('name', lease)
    this.state = {
      lease, url: initialUrl, title: '', loading: false,
      canGoBack: false, canGoForward: false, gone: false, error: null,
    }
  }

  matchesLease(lease: string): boolean {
    return lease === this.lease
  }

  async loadURL(url: string): Promise<void> {
    await this.navigation.load(this.lease, url)
  }

  getURL(): string {
    return this.state.url
  }

  getTitle(): string {
    return this.state.title
  }

  canGoBack(): boolean {
    return this.state.canGoBack
  }

  canGoForward(): boolean {
    return this.state.canGoForward
  }

  clearHistory(): void {
    void this.navigation.clearHistory(this.lease).catch((error: unknown) => {
      console.error('native guest frame: history clear failed', error)
    })
  }

  goBack(): void {
    void this.navigation.goBack(this.lease).catch((error: unknown) => {
      console.error('native guest frame: goBack failed', error)
    })
  }

  goForward(): void {
    void this.navigation.goForward(this.lease).catch((error: unknown) => {
      console.error('native guest frame: goForward failed', error)
    })
  }

  reload(): void {
    void this.navigation.reload(this.lease).catch((error: unknown) => {
      console.error('native guest frame: reload failed', error)
    })
  }

  isLoading(): boolean {
    return this.state.loading
  }

  /**
   * Pull the guest's current document from the shell.
   *
   * The preserved `observeReady` reads `getURL()`/`getTitle()`/`isLoading()`
   * synchronously; this is the call that keeps those answers current. A refusal
   * is reported like any other command failure and leaves the last observation
   * in place.
   * @returns after the element's state reflects the shell's answer.
   */
  async refresh(): Promise<void> {
    try {
      this.apply(await this.navigation.observe(this.lease))
    } catch (error: unknown) {
      console.error('native guest frame: state refresh failed', error)
    }
  }

  /**
   * Apply one shell-reported state, emitting the DOM events the preserved
   * listeners consume.
   *
   * Ordering matters and mirrors Electron: loading transitions bracket
   * navigation commits, and `dom-ready` fires once, before any commit, so the
   * preserved `createGuest` installs its listeners against a ready guest.
   * @param next - the shell's current view of this guest.
   */
  apply(next: NativeGuestState): void {
    if (next.lease !== this.lease) return
    const previous = this.state
    this.state = next
    if (!this.ready) {
      this.ready = true
      this.emit('dom-ready')
    }
    if (next.loading !== previous.loading) {
      this.emit(next.loading ? 'did-start-loading' : 'did-stop-loading')
    }
    if (next.url !== previous.url && next.url !== '') {
      this.emit(isSameDocumentChange(previous.url, next.url) ? 'did-navigate-in-page' : 'did-navigate')
    }
    if (next.title !== previous.title) {
      this.emit('page-title-updated')
    }
    // Compare the failure by its fields, not by object identity: the shell
    // serializes a fresh object on every state report, so an identity check
    // would re-raise `did-fail-load` on every unrelated change and the
    // preserved browser chrome would flash its failure banner repeatedly.
    if (next.error !== null && !sameFailure(next.error, previous.error)) {
      this.emit('did-fail-load', {
        isMainFrame: true,
        errorCode: next.error.code,
        errorDescription: next.error.description,
      })
    }
    if (next.gone && !previous.gone) {
      this.emit('render-process-gone')
      this.emit('destroyed')
    }
  }

  /** Dispatch one synthetic event the preserved listeners understand. */
  private emit(type: string, fields: object = {}): void {
    const event = Object.assign(new Event(type), { isMainFrame: true }, fields)
    this.node.dispatchEvent(event)
  }
}

/**
 * Build the synthetic element for one reservation.
 *
 * @param lease - opaque main-issued reservation identity.
 * @param navigation - native navigation commands.
 * @param initialUrl - the inert bootstrap URL the shell loaded
 *   (`about:blank#<lease>`).
 * @returns a detached element implementing the preserved `WebviewElement`.
 */
const guestElements = new WeakMap<NativeGuestElement, SyntheticGuestElement>()

export function createNativeGuestElement(
  lease: string,
  navigation: NativeGuestNavigation,
  initialUrl = `about:blank#${lease}`,
): NativeGuestElement {
  const guest = new SyntheticGuestElement(lease, navigation, initialUrl)
  const element = Object.assign(guest.node, {
    loadURL: guest.loadURL.bind(guest), getURL: guest.getURL.bind(guest), getTitle: guest.getTitle.bind(guest),
    canGoBack: guest.canGoBack.bind(guest), canGoForward: guest.canGoForward.bind(guest),
    clearHistory: guest.clearHistory.bind(guest), goBack: guest.goBack.bind(guest), goForward: guest.goForward.bind(guest),
    reload: guest.reload.bind(guest), isLoading: guest.isLoading.bind(guest),
  }) as NativeGuestElement
  guestElements.set(element, guest)
  return element
}

/**
 * Apply one shell state report to the element that owns it.
 *
 * @param element - the element the state belongs to.
 * @param state - the shell's report.
 * @returns whether the element accepted it; a report for another lease is
 *   dropped so one tab can never display another tab's document.
 */
export function applyGuestState(element: NativeGuestElement, state: NativeGuestState): boolean {
  const guest = guestElements.get(element)
  if (guest === undefined) return false
  if (!guest.matchesLease(state.lease)) return false
  guest.apply(state)
  return true
}

/**
 * Pull the guest's current document from the shell.
 *
 * The preserved `observeReady` reads the element's getters synchronously after
 * each event; calling this immediately before keeps those reads current.
 * @param element - the element to refresh.
 * @returns after the element reflects the shell's answer.
 */
export async function refreshGuestState(element: NativeGuestElement): Promise<void> {
  await guestElements.get(element)?.refresh()
}

/**
 * Whether two observations name the same document.
 *
 * A fragment-only change (`#section` added, removed or replaced) is an in-page
 * navigation: Chromium raises `did-navigate-in-page` for it, and the preserved
 * `ElectronWebViewImpl` observes it the same way it observes a commit. The
 * comparison drops the fragment from both URLs; a non-empty result that is equal
 * on both sides is the same document. An empty previous URL is the bootstrap
 * document, never a same-document change.
 * @param previous - the URL before the report.
 * @param next - the URL in the report.
 * @returns whether only the fragment differs.
 */
function isSameDocumentChange(previous: string, next: string): boolean {
  if (previous === '' || next === '') return false
  const strip = (url: string): string => {
    const hash = url.indexOf('#')
    return hash === -1 ? url : url.slice(0, hash)
  }
  return strip(previous) === strip(next)
}

/**
 * Whether two load failures describe the same condition.
 *
 * The shell serializes a new object per report, so identity comparison cannot
 * tell a repeated report of one failure from a new one; the code and
 * description can.
 * @param next - the failure just reported.
 * @param previous - the failure previously reported, if any.
 * @returns whether both describe the same failure.
 */
function sameFailure(
  next: GuestBrowserFailure,
  previous: GuestBrowserFailure | null,
): boolean {
  return previous !== null && previous.code === next.code && previous.description === next.description
}

export type { NavigationEvent, LoadFailureEvent }
