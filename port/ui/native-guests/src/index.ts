/**
 * `@dsh-port/native-guests` — carrier adapters that give the preserved Sidebar
 * Browser and embedded Platform surfaces a real native guest view.
 *
 * The package exists because two preserved contracts assume a platform the port
 * does not have:
 *
 * * `BrowserPresentation` / `WebviewElement` assume a DOM-attached guest the
 *   layout engine positions. A Tauri child webview is a native overlay, so
 *   {@link NativeGuestPresentation} measures the preserved `viewport` container
 *   and relays its rectangle, and {@link createNativeGuestElement} reproduces the
 *   element surface the preserved `ElectronWebViewImpl` drives.
 * * `PlatformBridge`'s `open(page, bounds)`/`setBounds`/`close` is already
 *   geometry-explicit, so the Platform side needs no adapter: the bridge in
 *   `port/ui/desktop-bridge/guests.ts` satisfies it directly, and the preserved
 *   `PlatformOverlay` measures its own rectangle.
 *
 * The three pieces compose in one order:
 *
 * ```
 * createNativeGuestSession(lease, bridge, bridge)   // commands + live state
 *   → session.element                                // the WebviewElement
 *   → presentation.mount(viewportId)                 // the rectangle relay
 * ```
 *
 * {@link createNativeGuestPresentation} builds the presentation over
 * {@link setGuestBounds}, so a caller wires the whole Browser surface with two
 * constructors and no knowledge of the command names.
 *
 * Nothing in this package renders an iframe or claims a guest exists when the
 * shell refused to create one; every failure keeps the preserved UI's own error
 * state.
 */
export {
  createBrowserPageFactory,
  type BrowserFrame,
  type BrowserPage,
  type BrowserPageFactoryOptions,
  type BrowserPageOptions,
  type BrowserPresentation,
  type GuestNavigationFactory,
  type RetainedFrameFactory,
} from './browser-page.ts'

export {
  containerIsVisible,
  createNativeGuestPresentation,
  HIDDEN_BOUNDS,
  measureContainer,
  NativeGuestPresentation,
  type NativeGuestMeasurements,
  type NativeGuestPlacement,
  type NativeGuestPresentationEvents,
} from './presentation.ts'

export {
  applyGuestState,
  createNativeGuestElement,
  refreshGuestState,
  type LoadFailureEvent,
  type NativeGuestElement,
  type NativeGuestNavigation,
  type NativeGuestState,
} from './frame.ts'

export {
  createNativeGuestSession,
  NativeGuestSession,
  type NativeGuestStateSource,
  type NativeGuestSubscriptionFailure,
  type NativeGuestUnlisten,
} from './session.ts'

export {
  BROWSER_GUEST_UNAVAILABLE,
  createGuestBrowserBridge,
  createGuestPlatformBridge,
  createNativeGuestNavigation,
  createUnavailableBrowserBridge,
  GUEST_BROWSER_OPEN_EVENT,
  GUEST_BROWSER_STATE_EVENT,
  guestRefusalCode,
  platformViewIsOpen,
  PLATFORM_VIEW_UNAVAILABLE,
  readStateEvent,
  setGuestBounds,
  type GuestBounds,
  type GuestBrowserOpenEvent,
  type GuestBrowserStateEvent,
  type GuestNavigation,
  type GuestNavigationCommand,
  type PlatformBridge,
  type PlatformPage,
} from '../../desktop-bridge/guests.ts'
