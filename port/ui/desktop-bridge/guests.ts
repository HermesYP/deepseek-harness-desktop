/**
 * Guest bridges: `dshDesktop.browser` (Sidebar Browser guests) and
 * `dshPlatform` (the embedded Platform document), over the Rust guest commands
 * in `port/src-tauri/app/src/guests/`.
 *
 * These are the two product surfaces the reference Electron shell backs with a
 * real child view rather than an iframe. Both bridges therefore:
 *
 * * never fall back to an iframe — a shell without the guest commands rejects
 *   with the ratified machine code ({@link BROWSER_GUEST_UNAVAILABLE} /
 *   {@link PLATFORM_VIEW_UNAVAILABLE}), so the retained UI shows its own failure
 *   state instead of silently rendering something that is not a guest;
 * * keep the exact upstream interfaces the preserved client already reads
 *   (`DesktopBrowserBridge` of `ui-sidebar-browser/src/types.ts`,
 *   `PlatformBridge` of `ui-settings-account/src/client/PlatformOverlay.tsx`),
 *   so no preserved file is edited;
 * * hand the renderer nothing but opaque ids and numbers — no IPC, no path, no
 *   token, no partition beyond the one the caller was issued.
 *
 * ## Wiring is explicit, never automatic
 *
 * Neither bridge is what the shell installs by default: `shell-boot.ts` fills
 * `dshDesktop.browser` and `dshPlatform` only when a composed artifact supplies
 * them, because this build's guest registry admits nothing
 * (`GuestViews::new(false, false)` in `port/src-tauri/app/src/lib.rs`) and an
 * installed bridge would make a preserved consumer prefer a surface the shell
 * refuses. The bridges stay here as the typed, tested capability a future
 * admitted build composes.
 *
 * ## Lease identity is main-issued
 *
 * `acquire` returns the lease the Rust registry minted. `release` and
 * `onOpenRequested` only ever name a lease the caller already holds, and the
 * Rust side refuses a lease that belongs to another window. Popup policy is also
 * decided there: a `window.open` in a guest becomes the
 * `dsh://guests/browser-open` event, and this module routes it to the one
 * listener registered for that lease — the reference's `browserOpenRequested`.
 *
 * ## Navigation is driven by commands, not simulated
 *
 * The preserved `ElectronWebViewImpl` drives a `<webview>` element; a Tauri
 * child webview has no such element, so `port/ui/native-guests/` supplies one.
 * That element's methods must **actually reach the shell**, which is what the
 * graph below is for:
 *
 * ```
 * loadURL(url)          → guest_browser_navigate   → navigate_browser()
 * goBack()/goForward()  → guest_browser_command    → GoBack/GoForward steps
 * reload()              → guest_browser_command    → ReloadBrowserGuest
 * clearHistory()        → guest_browser_command    → ClearBrowserHistory
 * getURL()/getTitle()/…  ← dsh://guests/browser-state ← the live child webview
 * ```
 *
 * Every navigation command re-validates the address in Rust against the same
 * policy the native WebView2 navigation hook applies, so this module is a
 * transport, never a second opinion about what is allowed.
 *
 * ## State reports are observations, and a missing one is a gap
 *
 * {@link GuestBrowserStateEvent} is `guests::GuestBrowserState` verbatim: eight
 * camelCase fields the shell observed, `error` explicitly `null` when the
 * current document did not fail. {@link readStateEvent} accepts that complete
 * object and nothing less — a partial payload is dropped rather than completed
 * with invented defaults, because a report that omits `loading`/`canGoBack`
 * is not evidence that the guest settled.
 *
 * `port/src-tauri/app/src/guests/observation.rs` is the producer:
 * one `ObservationSink` per guest turns WebView2's document events
 * (`NavigationStarting`, `DocumentTitleChanged`, `HistoryChanged`,
 * `NavigationCompleted`, `ProcessFailed`) into that eight-field struct, and
 * `guests/native.rs` emits it on `dsh://guests/browser-state`.
 * `commands.rs::guest_browser_state` reads the same observation and refuses with
 * `guest_state_unavailable` while the document has not been observed, so neither
 * channel answers a settled-looking default.
 *
 * That is source wiring, not native acceptance. `guests/mod.rs` records the
 * current gate: `GuestViews::new(false, false)` is what `AppState` installs, the
 * Platform credential hooks have no acknowledgement, and no run against a live
 * WebView2 has been recorded — so the observed fields are **not
 * native-qualified** and Browser parity still depends on that acceptance. This
 * module subscribes to the declared event and pulls `guest_browser_state`; it
 * fabricates no emitter and no field of its own.
 *
 * ## Why the upstream browser interface has no geometry member
 *
 * {@link DesktopBrowserBridge} is exactly upstream's three members. Under
 * Electron the guest's rectangle came from CSS: the presentation appended a
 * `<webview>` element inside the Browser body's `viewport` container and the
 * layout engine sized it. A Tauri child webview is a **native overlay** that CSS
 * cannot position, so the rectangle has to be measured in the page and relayed.
 * That relay is deliberately *not* a fourth member here — adding one would
 * change the interface the preserved `ElectronWebViewImpl` implements — and it
 * lives in `port/ui/native-guests/`, the presentation adapter this module is
 * designed to be composed with. {@link setGuestBounds} is the command-level
 * hook that adapter calls, and {@link createNativeGuestNavigation} is the
 * command-level navigation face.
 *
 * ## Transport
 *
 * Guest commands and events are members of the shared {@link DshCommandMap} /
 * {@link DshEventMap}; every command travels under its declared snake_case name
 * with its payload nested under `request` (the single-struct form the Rust
 * `guest_*` commands declare), and every payload this module receives is
 * validated before it is forwarded.
 */
import { invokeCommand, invokeRequestCommand, isDesktop, listenEvent, type Unlisten } from './index.ts'
import type {
  BrowserOpenRequestEvent, BrowserReservation, DshCommandMap, DshError, DshRequestCommandName,
  GuestBrowserFailure, GuestBrowserState, GuestBounds, GuestNavigationCommand, PlatformPage,
} from './protocol.ts'
import type {
  DesktopBrowserBridge, DesktopBrowserLeaseId, DesktopBrowserReservation,
} from './markers.ts'

/** Stable machine code of a shell with no embeddable browser guest surface. */
export const BROWSER_GUEST_UNAVAILABLE = 'browser_guest_unavailable'

/** Stable machine code of a shell with no embedded Platform document surface. */
export const PLATFORM_VIEW_UNAVAILABLE = 'platform_view_unavailable'

/** Event carrying an approved guest popup to the client (`browserOpenRequested`). */
export const GUEST_BROWSER_OPEN_EVENT = 'dsh://guests/browser-open' as const

/** Event carrying one guest's observed document state. */
export const GUEST_BROWSER_STATE_EVENT = 'dsh://guests/browser-state' as const

/** `dsh://guests/browser-open` payload (`guests::BrowserOpenRequest`). */
export type GuestBrowserOpenEvent = BrowserOpenRequestEvent

/** One guest's observed document (`guests::GuestBrowserState`), verbatim. */
export type GuestBrowserStateEvent = GuestBrowserState

/** Destinations the embedded Platform document supports (`platform-pages.ts`). */
export type { PlatformPage }

/** Rectangle in CSS pixels, as the retained `PlatformOverlay` measures it. */
export type { GuestBounds }

/** The navigation verbs one guest accepts (`guests::registry::command_browser`). */
export type { GuestNavigationCommand }

/**
 * The `dshPlatform` bridge — upstream `PlatformBridge`
 * (`ui-settings-account/src/client/PlatformOverlay.tsx:10-17`) verbatim.
 *
 * Only `openPlatformPage` is injected by the preserved account plugin, and only
 * when `globalThis.dshPlatform` exists, so installing this object is what turns
 * the account Settings page, the quota notice and the onboarding recharge step
 * into real embedded documents instead of `window.open` links.
 */
export interface PlatformBridge {
  /** @param page - supported Platform destination. @param bounds - viewport rectangle. @returns after document load. */
  open(this: void, page: PlatformPage, bounds: GuestBounds): Promise<void>
  /** @param bounds - viewport rectangle. @returns after native bounds update. */
  setBounds(this: void, bounds: GuestBounds): Promise<void>
  /** @returns after the native document is destroyed. */
  close(this: void): Promise<void>
}

/**
 * One guest's navigation face — the command side of the preserved
 * `WebviewElement` methods.
 *
 * `port/ui/native-guests/` implements the element itself over this; keeping the
 * commands behind a named interface is what lets the adapter be tested without a
 * transport.
 */
export interface GuestNavigation {
  /**
   * Load one address in the guest behind `lease`.
   * @param lease - the guest's reservation.
   * @param url - address; re-validated by the shell against the guest policy.
   * @returns after the shell accepted the navigation.
   */
  navigate(lease: DesktopBrowserLeaseId, url: string): Promise<void>
  /**
   * Apply one navigation verb to the guest behind `lease`.
   * @param lease - the guest's reservation.
   * @param command - one of `back`, `forward`, `reload`, `clear-history`.
   * @returns after the shell applied it.
   */
  command(lease: DesktopBrowserLeaseId, command: GuestNavigationCommand): Promise<void>
  /**
   * Read the guest's current document state from the shell.
   * @param lease - the guest's reservation.
   * @returns the live observation.
   * @throws {DshError} `guest_protocol` when the answer is not a complete observation.
   */
  state(lease: DesktopBrowserLeaseId): Promise<GuestBrowserStateEvent>
  /**
   * Subscribe to every guest's state reports.
   * @param listener - state consumer.
   * @returns the subscription disposer.
   */
  onState(listener: (state: GuestBrowserStateEvent) => void): Promise<Unlisten>
}

/** Typed refusal shape shared with the Rust `DshError::Other` variant. */
function refusal(code: string, message: string): DshError {
  return { kind: 'other', detail: { code, message } }
}

/**
 * Read the machine code of a guest refusal.
 * @param reason - rejected value from a guest call.
 * @returns the code, or `undefined` when the value is not a refusal.
 */
export function guestRefusalCode(reason: unknown): string | undefined {
  const error = asDshErrorLike(reason)
  return error?.kind === 'other' ? error.detail.code : undefined
}

/**
 * Narrow an unknown rejection to the contract error taxonomy.
 *
 * Local to this module so the guest bridges never depend on `index.ts`'s
 * transport helpers for validation.
 * @param reason - rejected value.
 * @returns the `DshError` payload, or undefined when the value is not one.
 */
function asDshErrorLike(reason: unknown): DshError | undefined {
  if (typeof reason !== 'object' || reason === null) return undefined
  const kind: unknown = Reflect.get(reason, 'kind')
  const detail: unknown = Reflect.get(reason, 'detail')
  if (typeof kind !== 'string' || typeof detail !== 'object' || detail === null) return undefined
  return reason as DshError
}

/**
 * Reject one guest call because this shell has no native guest surface.
 * @param code - ratified machine code.
 * @returns a rejected promise carrying that refusal.
 */
function unavailable(code: string): Promise<never> {
  return Promise.reject(refusal(code, `this shell has no native guest surface (${code})`))
}

/** Default report for a failed guest-event subscription. */
function defaultTransportFailure(error: unknown): void {
  console.error('dsh desktop browser: guest event subscription failed', error)
}

/** Retry policy for the guest popup subscription. */
export interface GuestSubscriptionRetry {
  /**
   * Consecutive subscription attempts before automatic retrying stops. A new
   * listener (or a new `acquire`) re-arms the budget, because that is evidence
   * the transport may have recovered. Defaults to 3.
   */
  readonly maxAttempts?: number
  /** Delay before one retry, in milliseconds. Defaults to 250. */
  readonly delayMs?: number
}

/** Options of {@link createGuestBrowserBridge}. */
export interface GuestBrowserBridgeOptions extends GuestSubscriptionRetry {
  /**
   * Reports a failed `dsh://guests/browser-open` subscription. A browser
   * without a popup subscription is still usable (navigation works through
   * commands), so this is reported rather than thrown — but it is never
   * silent, because a missing subscription means `onOpenRequested` listeners
   * would never fire.
   */
  readonly onEventTransportFailure?: (error: unknown) => void
}

/** Bounded-retry defaults of the popup subscription. */
const DEFAULT_SUBSCRIBE_ATTEMPTS = 3
const DEFAULT_RETRY_DELAY_MS = 250

/**
 * Build `dshDesktop.browser` over the Rust guest commands.
 *
 * @param options - retry policy and subscription-failure reporting.
 * @returns the guest-backed browser bridge.
 */
export function createGuestBrowserBridge(
  options: GuestBrowserBridgeOptions = {},
): DesktopBrowserBridge {
  const onEventTransportFailure = options.onEventTransportFailure ?? defaultTransportFailure
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_SUBSCRIBE_ATTEMPTS)
  const retryDelayMs = Math.max(0, options.delayMs ?? DEFAULT_RETRY_DELAY_MS)
  /** One subscription set per lease, created when a listener registers. */
  const listeners = new Map<DesktopBrowserLeaseId, Set<(url: string) => void>>()
  /** Disposer of the live popup subscription, once it has been established. */
  let unlistenOpen: Unlisten | undefined
  /**
   * Whether a subscription is still wanted.
   *
   * The subscription is asynchronous, so `installSource` may resolve after the
   * last listener has already gone. `wanted` is the durable intent; `live` only
   * says a subscription object currently exists. Without this split, a release
   * that lands inside the subscribe round-trip left the listener registered
   * forever — a leak the harness caught.
   */
  let wanted = false
  let live = false
  let subscribing = false
  /** Consecutive attempts of the current demand; reset on success and on teardown. */
  let attempts = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  const clearRetry = (): void => {
    if (retryTimer === undefined) return
    globalThis.clearTimeout(retryTimer)
    retryTimer = undefined
  }

  const deliver = (event: GuestBrowserOpenEvent): void => {
    const callbacks = listeners.get(event.lease)
    if (callbacks === undefined) return
    for (const callback of [...callbacks]) {
      try {
        callback(event.url)
      } catch (error) {
        console.error('dsh desktop browser: guest link handler failed', error)
      }
    }
  }

  const established = (stop: Unlisten): void => {
    subscribing = false
    if (!wanted) {
      // Every listener left while the subscription was in flight: keep nothing
      // registered.
      stop()
      return
    }
    live = true
    attempts = 0
    unlistenOpen = stop
  }

  const refused = (error: unknown): void => {
    // Both in-flight and live state are cleared before anything else: a
    // rejected subscription owns no listener, and a later demand must be able
    // to establish one instead of joining a subscription that does not exist.
    subscribing = false
    live = false
    unlistenOpen = undefined
    // The report is observational. This runs inside the listen promise's
    // rejection handler, so a hook that throws would otherwise skip the retry
    // below AND reject a chain nobody awaits — one bad reporter must not cost
    // the demand its subscription.
    try {
      onEventTransportFailure(error)
    } catch { /* a failure hook's own failure is not the bridge's to escalate */ }
    if (!wanted || attempts >= maxAttempts) return
    retryTimer = globalThis.setTimeout(() => {
      retryTimer = undefined
      if (!wanted || subscribing || live) return
      startAttempt()
    }, retryDelayMs)
  }

  const startAttempt = (): void => {
    if (subscribing || live) return
    clearRetry()
    subscribing = true
    attempts += 1
    void listenGuestOpen(deliver).then(established, refused)
  }

  /**
   * Demand the popup subscription.
   *
   * Called from `acquire` and from every `onOpenRequested`, so a refused
   * subscription is retried a bounded number of times and a later demand
   * re-arms the budget rather than being swallowed by the durable `wanted`
   * flag.
   */
  const installSource = (): void => {
    wanted = true
    if (subscribing || live || retryTimer !== undefined) return
    if (attempts >= maxAttempts) attempts = 0
    startAttempt()
  }

  const stopSource = (): void => {
    if (listeners.size > 0) return
    wanted = false
    attempts = 0
    clearRetry()
    if (!live) return
    live = false
    const stop = unlistenOpen
    unlistenOpen = undefined
    stop?.()
  }

  return {
    async acquire(workspace: string): Promise<DesktopBrowserReservation> {
      // The retained `ElectronWebViewImpl` resolves the workspace identity and
      // calls `acquire(workspace)` before any DOM exists; the guest is created
      // hidden and placed by the first `setBounds`.
      installSource()
      const reservation = await invokeGuest('guest_browser_acquire', {
        workspace, bounds: HIDDEN_BOUNDS,
      })
      const lease: unknown = Reflect.get(reservation as object, 'lease')
      const partition: unknown = Reflect.get(reservation as object, 'partition')
      if (typeof lease !== 'string' || typeof partition !== 'string') {
        throw refusal('guest_protocol', 'the shell returned a malformed guest reservation')
      }
      return { lease: lease as DesktopBrowserLeaseId, partition }
    },
    async release(lease: DesktopBrowserLeaseId): Promise<void> {
      try {
        await invokeGuest('guest_browser_release', { lease: requireLease(lease) })
      } finally {
        // The lease is gone either way: dropping its listeners here stops a late
        // popup event from reaching a disposed page.
        listeners.delete(lease)
        stopSource()
      }
    },
    onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void {
      installSource()
      let callbacks = listeners.get(lease)
      if (callbacks === undefined) {
        callbacks = new Set()
        listeners.set(lease, callbacks)
      }
      callbacks.add(listener)
      return () => {
        callbacks.delete(listener)
        if (callbacks.size === 0 && listeners.get(lease) === callbacks) listeners.delete(lease)
        stopSource()
      }
    },
  }
}

/**
 * Invoke one guest command through the shared typed command map.
 *
 * The commands in {@link DshRequestCommandName} declare a single
 * `request: <Struct>` parameter, so {@link invokeRequestCommand} nests the
 * payload; the command names and both payloads come from `protocol.ts`, which
 * is the one home of the wire form. `guest_platform_close` and
 * `guest_platform_status` declare no request struct and are invoked directly.
 * @param command - guest command name from {@link DshRequestCommandName}.
 * @param request - the command's request struct.
 * @returns the typed command response.
 * @throws {NotGuestDesktopError} outside the desktop shell.
 */
async function invokeGuest<K extends DshRequestCommandName>(
  command: K,
  request: DshCommandMap[K]['request'],
): Promise<DshCommandMap[K]['response']> {
  if (!isDesktop()) throw new NotGuestDesktopError()
  return await invokeRequestCommand(command, request)
}

/** The bridge ran outside the Tauri shell. */
class NotGuestDesktopError extends Error {
  /** Stable discriminant shared with the facade's `not_desktop` refusal. */
  readonly kind = 'not_desktop' as const

  constructor() {
    super('dsh desktop guests: not running inside the desktop shell')
    this.name = 'NotGuestDesktopError'
  }
}

/** A guest is created hidden until its presentation places it. */
const HIDDEN_BOUNDS: GuestBounds = { x: 0, y: 0, width: 0, height: 0 }

/** Validate one popup payload the Rust side emitted. */
function readOpenEvent(payload: unknown): GuestBrowserOpenEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const lease: unknown = Reflect.get(payload, 'lease')
  const url: unknown = Reflect.get(payload, 'url')
  if (typeof lease !== 'string' || lease.length === 0 || typeof url !== 'string') return undefined
  return { lease: lease as DesktopBrowserLeaseId, url }
}

/**
 * Validate one guest-state payload the shell sent.
 *
 * The eight fields of `guests::GuestBrowserState` are all required and are read
 * as the shell reported them: a payload that omits a field, or whose `error` is
 * neither `null` nor `{code, description}`, is not an observation and is
 * dropped. Completing a partial report with defaults would assert a settled
 * guest the shell never observed. Unknown extra fields are ignored, so a future
 * additive field does not invalidate a valid observation.
 * @param payload - the `guest_browser_state` response or `dsh://guests/browser-state` payload.
 * @returns the observation, or `undefined` when the payload is not one.
 */
export function readStateEvent(payload: unknown): GuestBrowserStateEvent | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const lease: unknown = Reflect.get(payload, 'lease')
  if (typeof lease !== 'string' || lease.length === 0) return undefined
  const url: unknown = Reflect.get(payload, 'url')
  const title: unknown = Reflect.get(payload, 'title')
  const loading: unknown = Reflect.get(payload, 'loading')
  const canGoBack: unknown = Reflect.get(payload, 'canGoBack')
  const canGoForward: unknown = Reflect.get(payload, 'canGoForward')
  const gone: unknown = Reflect.get(payload, 'gone')
  const failure: unknown = Reflect.get(payload, 'error')
  if (typeof url !== 'string' || typeof title !== 'string') return undefined
  if (typeof loading !== 'boolean' || typeof canGoBack !== 'boolean') return undefined
  if (typeof canGoForward !== 'boolean' || typeof gone !== 'boolean') return undefined
  const error = readFailure(failure)
  if (failure !== null && error === undefined) return undefined
  return {
    lease: lease as DesktopBrowserLeaseId,
    url,
    title,
    loading,
    canGoBack,
    canGoForward,
    gone,
    error: error ?? null,
  }
}

/** Read one main-frame failure object, or undefined when it is not one. */
function readFailure(value: unknown): GuestBrowserFailure | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const code: unknown = Reflect.get(value, 'code')
  const description: unknown = Reflect.get(value, 'description')
  if (typeof code !== 'number' || typeof description !== 'string') return undefined
  return { code, description }
}

/**
 * Subscribe to the guest popup event.
 *
 * The event is a member of the shared `DshEventMap`; the payload is validated
 * here so a malformed emission is dropped rather than forwarded.
 * @param listener - approved-URL consumer.
 * @returns the subscription disposer.
 */
async function listenGuestOpen(
  listener: (event: GuestBrowserOpenEvent) => void,
): Promise<Unlisten> {
  return await listenEvent(GUEST_BROWSER_OPEN_EVENT, (payload) => {
    const event = readOpenEvent(payload)
    if (event !== undefined) listener(event)
  })
}

/** Validate one lease the client holds before it reaches the shell. */
function requireLease(lease: DesktopBrowserLeaseId): DesktopBrowserLeaseId {
  if (typeof lease !== 'string' || lease.length === 0) {
    throw refusal('guest_protocol', 'a guest lease is required')
  }
  return lease
}

/**
 * Move and show or hide one existing browser guest.
 *
 * The command-level geometry hook: `DesktopBrowserBridge` has no geometry
 * member (see the module documentation), so the presentation adapter in
 * `port/ui/native-guests/` calls this with the measured rectangle of the
 * Browser body's `viewport` container.
 * @param lease - the caller's reservation.
 * @param bounds - measured rectangle in CSS pixels; a zero extent hides the
 *   guest without destroying it.
 * @returns after the native bounds update.
 */
export function setGuestBounds(lease: DesktopBrowserLeaseId, bounds: GuestBounds): Promise<void> {
  return invokeGuest('guest_browser_set_bounds', { lease: requireLease(lease), bounds })
}

/**
 * Build the guest's navigation face over the Rust guest commands.
 *
 * @returns the command-backed navigation face consumed by the
 *   `port/ui/native-guests/` element adapter.
 */
export function createNativeGuestNavigation(): GuestNavigation {
  return {
    async navigate(lease, url): Promise<void> {
      await invokeGuest('guest_browser_navigate', { lease: requireLease(lease), url })
    },
    async command(lease, command): Promise<void> {
      await invokeGuest('guest_browser_command', { lease: requireLease(lease), command })
    },
    async state(lease): Promise<GuestBrowserStateEvent> {
      const payload = await invokeGuest('guest_browser_state', { lease: requireLease(lease) })
      const state = readStateEvent(payload)
      if (state === undefined) {
        throw refusal('guest_protocol', 'the shell returned an incomplete guest observation')
      }
      return state
    },
    onState(listener): Promise<Unlisten> {
      return listenEvent(GUEST_BROWSER_STATE_EVENT, (payload) => {
        const state = readStateEvent(payload)
        if (state !== undefined) listener(state)
      })
    },
  }
}

/**
 * Build `dshPlatform` over the Rust Platform guest commands.
 *
 * Installed as `globalThis.dshPlatform`; the preserved account plugin reads it
 * there and only then offers `openPlatformPage`.
 * @returns the Platform bridge.
 */
export function createGuestPlatformBridge(): PlatformBridge {
  return {
    async open(page: PlatformPage, bounds: GuestBounds): Promise<void> {
      await invokeGuest('guest_platform_open', { page, bounds })
    },
    async setBounds(bounds: GuestBounds): Promise<void> {
      await invokeGuest('guest_platform_set_bounds', { bounds })
    },
    async close(): Promise<void> {
      // Declares no request struct, so it is invoked with no payload at all.
      if (!isDesktop()) throw new NotGuestDesktopError()
      await invokeCommand('guest_platform_close')
    },
  }
}

/**
 * Whether the embedded Platform document is currently open.
 *
 * The preserved `PlatformOverlay` measures its own rectangle, so it never needs
 * the geometry back; what a client cannot learn locally is whether the
 * credential-bearing document survived a Host restart.
 * @returns whether the shell reports a live Platform document.
 */
export async function platformViewIsOpen(): Promise<boolean> {
  if (!isDesktop()) throw new NotGuestDesktopError()
  return await invokeCommand('guest_platform_status')
}

/**
 * The browser bridge to install when the shell cannot create guests.
 *
 * Every member rejects with {@link BROWSER_GUEST_UNAVAILABLE}; this is the
 * documented `desktop-shell-features.md` §2 behaviour, kept as an explicit
 * capability decision rather than a silent iframe.
 * @returns the rejecting browser bridge.
 */
export function createUnavailableBrowserBridge(): DesktopBrowserBridge {
  return {
    acquire: () => unavailable(BROWSER_GUEST_UNAVAILABLE),
    release: () => unavailable(BROWSER_GUEST_UNAVAILABLE),
    onOpenRequested: () => {
      throw refusal(BROWSER_GUEST_UNAVAILABLE, 'this shell has no native guest surface')
    },
  }
}

/** The facade, re-exported so consumers read one import site. */
export { desktop } from './index.ts'
