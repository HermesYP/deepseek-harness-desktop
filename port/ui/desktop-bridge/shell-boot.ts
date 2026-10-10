/**
 * Desktop marker bridge glue: runs at module evaluation, before the preserved
 * upstream entry (`./web-main.ts`) reads `globalThis.dshDesktopBoot`.
 *
 * Ownership (contract amendment A11) — who OWNS producing each surface:
 *
 *   `__DSH_BOOT_READY__`                          served `index.html` literal
 *                                                 (Rust may re-assert idempotently)
 *   `html[data-platform]`, `html[data-windows-titlebar]`
 *   + `--dsh-windows-titlebar-height`,
 *     `html[data-ds-theme-source]`                Rust (DOM markers)
 *   `__DSH_HOST_PATHS__`                          Rust (native file paths; no Tauri
 *                                                 `webUtils.getPathForFile`
 *                                                 equivalent, so TypeScript cannot
 *                                                 recover a path from a `File`) —
 *                                                 this glue NEVER writes it and
 *                                                 NEVER fabricates a path
 *   `__DSH_DIRECTORY_PICKER__`                    Rust (native dialog, single
 *                                                 owner of the open dialog); this
 *                                                 glue keeps only a fill-if-absent
 *                                                 `shell_pick_directory` fallback
 *   `dshDesktop`, `dshDesktopBoot`,
 *   `__DSH_LOCALE__`, `dshOnboarding`             TypeScript bridge
 *
 * Exactly one writer per global per run: the Rust initialization script
 * executes before page modules and owns its rows above; this glue fills only
 * globals that are still ABSENT and never overwrites one. Outside the Tauri
 * shell it installs nothing, so the preserved client runs its Web path
 * unchanged.
 *
 * `__DSH_TRANSPORT__` is set by the preserved entry from
 * `dshDesktopBoot.ready()`. `dshDesktop.keyboard` is mandatory in the desktop
 * runtime (upstream throws when it is absent) and is installed with its
 * in-page physical-input producer (`markers.ts` `createKeyboardApi`), which
 * stamps produced input with the accepted shortcut revision.
 *
 * `html[data-ds-theme-source]` stays Rust-owned as a marker, but the VALUE the
 * preserved theme presenter publishes is mirrored into the native theme through
 * `shell_theme_set` by {@link syncNativeTheme} — the port's half of upstream's
 * `preload-theme.ts`.
 *
 * ## What this glue does NOT install: the two guest bridges
 *
 * `dshDesktop.browser` and `dshPlatform` are capabilities, not defaults. This
 * build's guest registry admits nothing (`GuestViews::new(false, false)` in
 * `port/src-tauri/app/src/lib.rs`), and both preserved consumers choose their
 * native surface from the mere PRESENCE of the bridge:
 *
 * * the retained Sidebar Browser otherwise constructs an Electron element this
 *   Tauri shell cannot supply;
 * * the account plugin otherwise offers an embedded Platform document that the
 *   shell would refuse (`platform_view_unavailable` /
 *   `platform_account_unavailable`).
 *
 * So neither is installed here unless a composed artifact explicitly supplies
 * it (`guests.browser` / `guests.platform`). Omitting the member is what keeps
 * the preserved Web fallbacks intact: the Sidebar keeps its iframe path and the
 * account Settings entry keeps its `window.open` route. Nothing here fabricates
 * a guest, a path, a theme, or a Platform document.
 */
import { desktop, isDesktop, type DshDesktopApi } from './index.ts'
import { createGuestBrowserBridge, type PlatformBridge } from './guests.ts'
import {
  createDesktopBoot, createDesktopProductApi, createDirectoryPicker, createLocaleBridge,
  createOnboardingBridge, markers, readShellDomMarkers, syncNativeTheme, type NativeThemeSync,
} from './markers.ts'

/**
 * The one native-theme mirror of this module instance.
 *
 * Installed once, by the first {@link installDesktopShellMarkers} call inside
 * the desktop shell; {@link disposeDesktopShellMarkers} removes it.
 */
let themeSync: NativeThemeSync | undefined

/**
 * Fill absent marker globals from the typed bridge (A11: the TypeScript-bridge
 * rows plus the `__DSH_DIRECTORY_PICKER__` fallback); never overwrite an
 * existing marker and never write `__DSH_HOST_PATHS__` or the DOM markers,
 * which are Rust-owned.
 *
 * The DOM markers are *read* here rather than written: `readShellDomMarkers`
 * reports what the initialization script installed, and the result is returned
 * so a caller (or a test) can assert the platform contract without mutating the
 * document. The theme VALUE on `html[data-ds-theme-source]` is mirrored into
 * the native theme through `shell_theme_set` (see {@link syncNativeTheme}).
 *
 * The two guest-backed surfaces are installed only when a caller supplies them.
 * Constructing the browser bridge installs no subscription until a guest
 * listener registers, and the Platform bridge is stateless, but neither is a
 * safe default while the shell admits no guest: presence alone changes which
 * surface the preserved consumer builds.
 * @param bridge - typed desktop facade used for the fallback factories.
 * @param guests - guest-backed surfaces a composed artifact supplies; omitted
 *   by default so the preserved consumers keep their Web fallbacks.
 * @returns the shell DOM markers observed on the live document.
 */
export function installDesktopShellMarkers(
  bridge: DshDesktopApi = desktop,
  guests: { browser?: ReturnType<typeof createGuestBrowserBridge>; platform?: PlatformBridge } = {},
) {
  if (!isDesktop()) return readShellDomMarkers()
  themeSync ??= syncNativeTheme(bridge)
  if (markers.readDesktopBoot() === undefined) markers.installDesktopBoot(createDesktopBoot(bridge))
  if (markers.readDirectoryPicker() === undefined) markers.installDirectoryPicker(createDirectoryPicker(bridge))
  if (markers.readLocaleBridge() === undefined) markers.installLocaleBridge(createLocaleBridge(bridge))
  if (markers.readOnboarding() === undefined) markers.installOnboarding(createOnboardingBridge(bridge))
  if (markers.readDesktopProductApi() === undefined) {
    const product = createDesktopProductApi(bridge, { browser: guests.browser })
    if (guests.browser === undefined) {
      // Presence selects ElectronPage in the unmodified Sidebar artifact. Keep
      // its maintained iframe path until the native page consumer is composed.
      const { browser: _unavailableBrowser, ...webFallbackProduct } = product
      markers.installDesktopProductApi(webFallbackProduct)
    } else {
      markers.installDesktopProductApi(product)
    }
  }
  if (guests.platform !== undefined && markers.readPlatformBridge() === undefined) {
    markers.installPlatformBridge(guests.platform)
  }
  return readShellDomMarkers()
}

/**
 * Remove the native-theme mirror installed by
 * {@link installDesktopShellMarkers}.
 *
 * The mirror is a document observer, not a marker global: this module installs
 * it once per instance and owns its lifetime. A test (or a page teardown) that
 * unmounts the shell document calls this so no observer outlives the document
 * it watched. Idempotent.
 */
export function disposeDesktopShellMarkers(): void {
  themeSync?.dispose()
  themeSync = undefined
}

installDesktopShellMarkers()
