/**
 * Marker globals read by the preserved upstream client (`globalThis`), with the
 * exact shapes each consumer reads (`docs/contracts/tauri-contract.md` "Marker
 * globals the Rust core must install" and `docs/contracts/ui-backend-protocol.md`
 * §8), plus typed install/read accessors and bridge-backed factories.
 *
 * The authoritative desktop marker is `globalThis.dshDesktop` (the upstream
 * `DshDesktopProductApi` of `apps/desktop/src/ipc.ts:71-81`, mirrored verbatim
 * below). `__DSH_DESKTOP__` does not exist upstream and is not implemented.
 *
 * `window.__DSH_BOOT__` and `window.__ModuleLoader__` are NOT shell-owned: they
 * arrive through the Host injection table (`runtime_boot_ready.injections`) and
 * boot fails loudly without them (`ui-backend-protocol.md` §7.3).
 */
import type {
  DesktopShortcutInput, DesktopUpdatePresentation, GuestBounds, HostPaths, IndexInjection,
  LocaleApplyRequest, LocaleCode, PlatformPage, ShortcutConfigSnapshot, ShortcutDefinition,
  ShortcutEdit, ShortcutRevision, ShortcutSaveResult, ThemePreference,
} from './protocol.ts'
import type { DshDesktopApi, Unlisten } from './index.ts'
import { createUnavailableBrowserBridge } from './guests.ts'

// ---------------------------------------------------------------------------
// Sub-bridge mirrors (upstream names and shapes verbatim).
// ---------------------------------------------------------------------------

/** Main-issued guest lease identity (`Branded<'DesktopBrowserLeaseId'>` upstream). */
export type DesktopBrowserLeaseId = string

/** A guest's approved, process-local storage partition (`DesktopBrowserReservation` upstream). */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest (`DesktopBrowserOpenRequest` upstream). */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

/** Origin-scoped guest operations (`DesktopBrowserBridge` upstream). */
export interface DesktopBrowserBridge {
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** @param lease - originating guest. @param listener - approved URL consumer. @returns unsubscribe callback. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}

/** Window-scoped input capabilities (`DesktopKeyboardApi` upstream). */
export interface DesktopKeyboardApi {
  /** @param listener - current document consumer. @returns listener disposer. */
  subscribe(listener: (input: DesktopShortcutInput) => void): () => void
  /**
   * Close the owning window if its configuration is still current.
   * @param revision - accepted configuration identity.
   * @returns IPC completion.
   */
  closeWindow(revision: ShortcutRevision): Promise<void>
}

/** Restricted shortcuts storage API (`DesktopShortcutsApi` upstream). */
export interface DesktopShortcutsApi {
  get(definitions: readonly ShortcutDefinition[]): Promise<ShortcutConfigSnapshot>
  edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult>
  subscribe(listener: (snapshot: ShortcutConfigSnapshot) => void): () => void
  recording(active: boolean): Promise<void>
}

/** Update presentation bridge (`DshDesktopProductApi['updates']` upstream). */
export interface DesktopUpdatesApi {
  status(): Promise<DesktopUpdatePresentation>
  open(): Promise<void>
  subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
}

/**
 * The desktop product bridge — upstream `DshDesktopProductApi`
 * (`apps/desktop/src/ipc.ts:71-81`) verbatim. Installed as `globalThis.dshDesktop`.
 */
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  readonly updates: DesktopUpdatesApi
}

/**
 * Partial form the consumers structurally read: upstream installs
 * `{ protocolVersion: 1 }` outside the owned application document
 * (`apps/desktop/src/preload-app.ts:99`) and every member is optional at the
 * read sites, so a missing member degrades that surface to Web mode
 * (`desktop-shell-features.md` rule 2).
 */
export interface DshDesktopPartialApi {
  readonly protocolVersion: 1
  readonly browser?: DesktopBrowserBridge
  readonly keyboard?: DesktopKeyboardApi
  readonly shortcuts?: DesktopShortcutsApi
  readonly updates?: DesktopUpdatesApi
}

// ---------------------------------------------------------------------------
// Marker shapes (exactly what the preserved client reads).
// ---------------------------------------------------------------------------

/** Boot-readiness deferred (`PromiseWithResolvers<void>`); the entry awaits `.promise` before reading injected state. */
export interface DshBootReadyGate {
  readonly promise: Promise<void>
  resolve: () => void
  reject: (reason: unknown) => void
}

/** Result of `dshDesktopBoot.ready()` — the fields `apps/web/src/main.ts:24` destructures. */
export interface DshDesktopBootReady {
  readonly injections: readonly IndexInjection[]
  readonly streamBaseUrl: string
}

/** Desktop boot bridge (`apps/web/src/main.ts:5-10`). */
export interface DshDesktopBoot {
  ready(): Promise<DshDesktopBootReady>
  failed(message: string): Promise<void>
}

/**
 * Page-global transport hooks (`ClientTransportHooks` in
 * `packages/client/connection/src/client/index.ts:79-107`): the entry sets
 * `{ ownsHost: true, streamBaseUrl }`; the module stage may read `loadBundle`.
 * The worker/test carriers (`rpc`, `fetch`, `openStream`) are absent here.
 */
export interface DshTransportHooks {
  ownsHost: boolean
  streamBaseUrl: string
  loadBundle?(url: string): Promise<void>
}

/** Host paths of dragged/pasted files (`__DSH_HOST_PATHS__`, `apps/desktop/src/preload-app.ts:81-83`). */
export interface DshHostPaths {
  /** @param file - dropped, picked, or pasted file. @returns host path, or '' when the file has none. */
  pathFor(file: File): string
  /**
   * Port extension: adopt the absolute paths of one native OS drop, in drop
   * order. The shell calls it from a `dsh-host-paths` document event after the
   * window observed a real drag-and-drop; `pathFor` answers from this batch and
   * from nothing else. Never present in upstream (upstream's preload reads the
   * path out of Chromium's drag payload); a client that only knows `pathFor`
   * ignores it and uploads, which is exactly upstream's absent-bridge path.
   * @param paths - absolute host paths, newest drop only.
   */
  adopt?(paths: readonly string[]): void
  /** @returns the adopted paths the page has not consumed yet, oldest first. */
  pending?(): readonly string[]
  /** @returns whether this call retired a pending batch, so a re-import is skipped. */
  consume?(): boolean
}

/**
 * Response of `shell_host_paths` (port extension): the absolute paths the shell
 * adopted from the most recent native drop.
 *
 * The wire type keeps one home in `protocol.ts` (`native_paths::HostPaths`);
 * this module only re-exports it, so the intake code below and the typed facade
 * can never disagree about its fields.
 */
export type { HostPaths }

/** `dsh-host-paths` document event detail: one native drop the shell observed. */
export interface HostPathsDropDetail {
  readonly paths: readonly string[]
}

/** Document event name the shell dispatches after adopting a native drop. */
export const HOST_PATHS_EVENT = 'dsh-host-paths'

/** Native directory flow (`__DSH_DIRECTORY_PICKER__`, `apps/desktop/src/preload-app.ts:75-77`). */
export interface DshDirectoryPicker {
  /** @returns the picked directory, or null on cancellation (retryable). */
  pick(): Promise<string | null>
}

/** System languages and the existing Host preference (`LocaleBootstrap`, `packages/client/locale/src/client/bootstrap.ts:4-9`). */
export interface LocaleBootstrap {
  /** Operating-system language tags in preference order. */
  readonly languages: readonly string[]
  /** Stored locale.preference; null preserves automatic language selection. */
  readonly preference: string | null
}

/** Locale bridge (`__DSH_LOCALE__`, `packages/client/locale/src/client/bootstrap.ts:12-17`). */
export interface DshLocaleBridge {
  /** @returns language initialization with no persistence side effects. */
  read(): Promise<LocaleBootstrap>
  /** Publish the resolved Client locale without writing another preference. @param locale - active registered locale id. */
  onChange(locale: string): void
}

/** Desktop login bridge (`dshOnboarding`, `apps/desktop/src/preload-app.ts:61-64`). */
export interface DshOnboardingBridge {
  /** @returns configured API-key presence; rejects when the bridge is unavailable. */
  hasApiKey(): Promise<boolean>
  /** Report onboarding-activity state to the shell. @param active - whether onboarding is showing. */
  setActive(active: boolean): void
}

/**
 * Embedded Platform document bridge — upstream `PlatformBridge`
 * (`_upstream/packages/client/ui-settings-account/src/client/PlatformOverlay.tsx:10-17`)
 * verbatim, installed as `globalThis.dshPlatform`.
 *
 * The preserved account plugin reads the global only to decide whether its
 * Settings entry, quota notice and onboarding recharge step can open a real
 * embedded document (`ui-settings-account/src/client/index.ts:135`); when the
 * global is absent they fall back to `window.open`. The three members are
 * already geometry-explicit, so no adapter sits between this bridge and the
 * preserved `PlatformOverlay`, which measures its own viewport rectangle.
 */
export interface DshPlatformBridge {
  /**
   * @param page - supported Platform destination.
   * @param bounds - viewport rectangle in CSS pixels.
   * @returns after the document load settles.
   */
  open(page: PlatformPage, bounds: GuestBounds): Promise<void>
  /** @param bounds - viewport rectangle in CSS pixels. @returns after the native bounds update. */
  setBounds(bounds: GuestBounds): Promise<void>
  /** @returns after the native document is destroyed. */
  close(): Promise<void>
}

/** The embedded Platform document's bridge, as installed on `globalThis`. */
export type DshPlatformMarker = DshPlatformBridge

// ---------------------------------------------------------------------------
// Install / read accessors.
// ---------------------------------------------------------------------------

type GlobalKey =
  | '__DSH_BOOT_READY__' | 'dshDesktopBoot' | '__DSH_TRANSPORT__' | '__DSH_HOST_PATHS__'
  | '__DSH_DIRECTORY_PICKER__' | '__DSH_LOCALE__' | 'dshOnboarding' | 'dshDesktop' | 'dshPlatform'

interface MarkerGlobals {
  __DSH_BOOT_READY__?: DshBootReadyGate
  dshDesktopBoot?: DshDesktopBoot
  __DSH_TRANSPORT__?: DshTransportHooks
  __DSH_HOST_PATHS__?: DshHostPaths
  __DSH_DIRECTORY_PICKER__?: DshDirectoryPicker
  __DSH_LOCALE__?: DshLocaleBridge
  dshOnboarding?: DshOnboardingBridge
  dshDesktop?: DshDesktopProductApi | DshDesktopPartialApi
  dshPlatform?: DshPlatformMarker
}

const globals = (): MarkerGlobals => globalThis as MarkerGlobals

function install<K extends GlobalKey>(name: K, value: MarkerGlobals[K]): void {
  ;(globals() as Record<string, unknown>)[name] = value
}

/** Install/read pairs, one per marker global the shell or Rust core owns. */
export const markers = {
  /** @param gate - fresh deferred created before the entry module runs. */
  installBootReadyGate(gate: DshBootReadyGate): void { install('__DSH_BOOT_READY__', gate) },
  /** @returns the gate, or undefined on a page no bootstrap owns. */
  readBootReadyGate(): DshBootReadyGate | undefined { return globals().__DSH_BOOT_READY__ },
  /** Create the deferred exactly as `apps/desktop/src/web-document.ts:10` does. */
  createBootReadyGate(): DshBootReadyGate {
    const deferred = Promise.withResolvers<void>()
    return { promise: deferred.promise, resolve: deferred.resolve, reject: deferred.reject }
  },
  installDesktopBoot(boot: DshDesktopBoot): void { install('dshDesktopBoot', boot) },
  readDesktopBoot(): DshDesktopBoot | undefined { return globals().dshDesktopBoot },
  installTransport(hooks: DshTransportHooks): void { install('__DSH_TRANSPORT__', hooks) },
  readTransport(): DshTransportHooks | undefined { return globals().__DSH_TRANSPORT__ },
  installHostPaths(api: DshHostPaths): void { install('__DSH_HOST_PATHS__', api) },
  readHostPaths(): DshHostPaths | undefined { return globals().__DSH_HOST_PATHS__ },
  installDirectoryPicker(api: DshDirectoryPicker): void { install('__DSH_DIRECTORY_PICKER__', api) },
  readDirectoryPicker(): DshDirectoryPicker | undefined { return globals().__DSH_DIRECTORY_PICKER__ },
  installLocaleBridge(api: DshLocaleBridge): void { install('__DSH_LOCALE__', api) },
  readLocaleBridge(): DshLocaleBridge | undefined { return globals().__DSH_LOCALE__ },
  installOnboarding(api: DshOnboardingBridge): void { install('dshOnboarding', api) },
  readOnboarding(): DshOnboardingBridge | undefined { return globals().dshOnboarding },
  installDesktopProductApi(api: DshDesktopProductApi | DshDesktopPartialApi): void { install('dshDesktop', api) },
  readDesktopProductApi(): DshDesktopProductApi | DshDesktopPartialApi | undefined { return globals().dshDesktop },
  installPlatformBridge(api: DshPlatformMarker): void { install('dshPlatform', api) },
  readPlatformBridge(): DshPlatformMarker | undefined { return globals().dshPlatform },
} as const

// ---------------------------------------------------------------------------
// Bridge-backed factories (contract-backed members only; never fabricate).
// ---------------------------------------------------------------------------

/**
 * `dshDesktopBoot` over `runtime_boot_ready` / `runtime_boot_failed`. `ready()`
 * resolves once the host control channel has reported `ready` and projects the
 * BootPayload to the exact `{injections, streamBaseUrl}` shape the entry reads.
 * @param bridge - typed desktop facade.
 * @returns the boot bridge the entry consumes.
 */
export function createDesktopBoot(bridge: DshDesktopApi): DshDesktopBoot {
  return {
    async ready(): Promise<DshDesktopBootReady> {
      const payload = await bridge.runtimeBootReady()
      return { injections: payload.injections, streamBaseUrl: payload.streamBaseUrl }
    },
    async failed(message: string): Promise<void> {
      await bridge.runtimeBootFailed({ message })
    },
  }
}

/**
 * `__DSH_DIRECTORY_PICKER__` over `shell_pick_directory`.
 *
 * The command is the single owner of the native dialog: Rust shares one open
 * dialog across concurrent requests and retires it when it settles
 * (`directory_picker.rs`, mirroring `apps/desktop/src/directory-picker.ts`).
 * This factory therefore forwards every call and adds no in-page de-duplication
 * — a second `pick()` while one is open joins it in Rust rather than opening a
 * second modal, and a page-level guard on top would wrongly turn a legitimate
 * retry after cancellation into a no-op.
 * @param bridge - typed desktop facade.
 * @returns the native directory flow.
 */
export function createDirectoryPicker(bridge: DshDesktopApi): DshDirectoryPicker {
  return {
    async pick(): Promise<string | null> {
      return (await bridge.shellPickDirectory({ title: null, defaultPath: null })).path
    },
  }
}

/**
 * `__DSH_HOST_PATHS__` intake over the shell's native-drop handoff.
 *
 * The shell owns `pathFor`: it is installed by the Rust initialization script
 * from real native drag-and-drop paths, and no TypeScript can recover a path
 * from a WebView2 `File`. This module owns the *intake* half only — carrying
 * the paths the shell adopted into the composer's ordinary file intake, so a
 * real OS drop is treated exactly like a `<input type="file">` pick.
 *
 * ## Native versus DOM evidence, stated plainly
 *
 * Two different facts are involved and they are not interchangeable:
 *
 * * the shell observed one native OS drop and recorded its **absolute paths**
 *   (a native fact; `__DSH_HOST_PATHS__.adopt`, relayed from
 *   `WindowEvent::DragDrop`);
 * * the webview produced the drop's **`File` objects** (a DOM fact; the
 *   browser's own `drop` event).
 *
 * Nothing joins them authoritatively. The shell cannot key a Rust map by a
 * JS `File`, and the page cannot read a path off a `File`. The only shared
 * value is the base name, so {@link matchDropPaths} resolves a file only when
 * that name is unique on both sides and reports ambiguity as "no path". A
 * caller that needs a path for a `File` the shell did observe should ask
 * `__DSH_HOST_PATHS__.pathFor(file)` directly — that answer comes from the
 * shell's own drop binding and is authoritative where it exists.
 */
export interface HostPathDropIntake {
  /**
   * Resolve one native drop for the composer: read the shell's adopted batch
   * once and pair it with the DOM `File`s.
   * @param files - the drop's `File` objects, in drop order.
   * @param api - the shell-installed `__DSH_HOST_PATHS__`, when present.
   * @returns one path per file, `undefined` where the correlation is ambiguous.
   */
  resolve(files: readonly File[], api: DshHostPaths | undefined): readonly (string | undefined)[]
}

/**
 * Production intake: the shell's adopted batch against the DOM drop.
 *
 * Reads the pending batch through {@link takePendingHostPaths}, so one native
 * drop is consumed once even when both a `dsh-host-paths` listener and a DOM
 * `drop` handler run for it. When the shell installed no batch (a picker or
 * paste, or a shell without the extension) every file resolves to `undefined`
 * and the composer uploads — upstream's behavior for a pathless `File`.
 */
export const hostPathDropIntake: HostPathDropIntake = {
  resolve(files: readonly File[], api: DshHostPaths | undefined): readonly (string | undefined)[] {
    if (files.length === 0) return []
    return matchDropPaths(files, takePendingHostPaths(api))
  },
}

/**
 * Match one adopted drop's paths to the `File` objects the browser produced.
 *
 * ## Why this refuses more than it resolves
 *
 * A WebView2 drag payload exposes only `name`, `size`, `type` and `lastModified`
 * for each `File`; a host path is a separate fact the shell observed. The two
 * lists are therefore correlated only by base name, and a name is **not** an
 * identity: two different directories can hold `report.pdf`, and the browser's
 * `File` order is not a documented function of the shell's drop order. Mapping
 * the *n*-th name match to the *n*-th `File` of that name would silently cite
 * the wrong absolute path — an `@mention` pointing at a file the user never
 * dropped, which is worse than uploading the bytes.
 *
 * The rule here is accordingly fail-closed. A file resolves to a path only when
 * that base name is **unambiguous on both sides**: exactly one adopted path ends
 * with it and exactly one dropped `File` carries it. Every other file yields
 * `undefined`, which the composer treats exactly as upstream treats a `File`
 * with no host path — it uploads. The shell's own installed `pathFor`
 * (`native_paths.rs` `HOST_PATHS_SCRIPT`) applies the same uniqueness test, so
 * the two never disagree about which file has a path.
 *
 * A caller that already holds an authoritative path for a `File` (from
 * `pathFor`) does not need this helper at all; it exists for the drop-intake
 * path, where the batch is the only evidence available.
 * @param files - the `File`s the drop produced, in drop order.
 * @param paths - the absolute paths the shell adopted, in drop order.
 * @returns one entry per file: its resolved path, or undefined when ambiguous.
 */
export function matchDropPaths(
  files: readonly File[],
  paths: readonly string[],
): readonly (string | undefined)[] {
  const byName = new Map<string, string[]>()
  for (const path of paths) {
    const name = hostPathBaseName(path)
    if (name === '') continue
    const bucket = byName.get(name)
    if (bucket === undefined) byName.set(name, [path])
    else bucket.push(path)
  }
  const fileCounts = new Map<string, number>()
  for (const file of files) fileCounts.set(file.name, (fileCounts.get(file.name) ?? 0) + 1)
  return files.map((file) => {
    // Both sides must be unambiguous: one path with this base name, one File.
    if (fileCounts.get(file.name) !== 1) return undefined
    const bucket = byName.get(file.name)
    if (bucket === undefined || bucket.length !== 1) return undefined
    return bucket[0]
  })
}

/**
 * The base name of one host path, for correlation only.
 *
 * Handles both separators because a drop may report either convention and the
 * shell stores the path verbatim. This is a name extraction for matching, never
 * a path transformation: no caller may rebuild a path from its result.
 * @param path - one adopted absolute path.
 * @returns the final segment, or `''` when the path has none.
 */
export function hostPathBaseName(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  if (normalized.endsWith('/')) return ''
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

/**
 * Read the adopted drop the shell published, once.
 *
 * Returns the batch only when the shell has one and the page has not consumed
 * it. Marking it consumed is what prevents one drop from attaching twice when
 * both the `dsh-host-paths` event and a handler run.
 * @param api - the shell-installed `__DSH_HOST_PATHS__`, when present.
 * @returns the pending absolute paths, or an empty list.
 */
export function takePendingHostPaths(api: DshHostPaths | undefined): readonly string[] {
  if (api?.pending === undefined || api.consume === undefined) return []
  const pending = api.pending()
  if (pending.length === 0) return []
  api.consume()
  return pending
}

/**
 * `dshDesktop.updates` over `update_status` / `update_open` / `dsh://update/state`.
 * @param bridge - typed desktop facade.
 * @returns the update presentation bridge.
 */
export function createUpdatesApi(bridge: DshDesktopApi): DesktopUpdatesApi {
  return {
    status: () => bridge.updateStatus(),
    open: () => bridge.updateOpen(),
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void {
      let unlisten: Unlisten | undefined
      let active = true
      void bridge.onUpdateState((state) => { if (active) listener(state) }).then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      return () => { active = false; unlisten?.() }
    },
  }
}

/**
 * Accepted-configuration revision cache shared by the shortcuts and keyboard
 * bridges. Upstream `native.ts:18` drops any input whose `revision` is not the
 * client's current accepted revision, so produced input is stamped from the
 * revision observed on `shell_shortcuts_get` / `shell_shortcuts_edit`
 * responses and refreshed on `dsh://shortcuts/changed`. Before any revision is
 * known, produced events are dropped: native input is meaningless until the
 * configuration loads.
 */
interface ShortcutInputState {
  active: boolean
  reset(): void
}

function createShortcutInputState(): ShortcutInputState {
  return { active: false, reset: () => undefined }
}

export interface ShortcutRevisionCache {
  /** Record the catalog and accepted revision observed on a `shell_shortcuts_get` response. */
  noteGet(definitions: readonly ShortcutDefinition[], snapshot: ShortcutConfigSnapshot): void
  /** Record the accepted revision observed on a `shell_shortcuts_edit` response. */
  noteEdit(result: ShortcutSaveResult): void
  /** @returns the last accepted revision, or undefined before configuration loads. */
  current(): ShortcutRevision | undefined
  /** @returns the catalog of the last `shell_shortcuts_get`, for refreshes. */
  definitions(): readonly ShortcutDefinition[]
}

/** @returns an empty shared revision cache. */
export function createShortcutRevisionCache(): ShortcutRevisionCache {
  let revision: ShortcutRevision | undefined
  let definitions: readonly ShortcutDefinition[] = []
  return {
    noteGet(next: readonly ShortcutDefinition[], snapshot: ShortcutConfigSnapshot): void {
      definitions = next
      revision = snapshot.revision
    },
    noteEdit(result: ShortcutSaveResult): void { revision = result.snapshot.revision },
    current: () => revision,
    definitions: () => definitions,
  }
}

/** Default report for a listener that threw while handling shortcut input. */
function reportInputListenerFailure(error: unknown): void {
  console.error('dsh desktop keyboard: shortcut input listener failed', error)
}

/**
 * `dshDesktop.keyboard` over `dsh://shortcuts/input`, `shell_close_window`, and
 * an in-page physical-input producer (`desktop-shell-features.md` §3,
 * amendments A2/A9). Upstream disables its ordinary DOM shortcut dispatch
 * whenever this bridge is present (`client/dom.ts:87`) and throws when it is
 * absent in the desktop runtime (`client/index.ts:44-46`), so the bridge MUST
 * carry a real input source. `subscribe` registers `listener` and installs one
 * capture-phase `keydown` listener on `window` that emits each physical code,
 * plus `secondCode` when another non-modifier code is held. `keyup` releases
 * held codes; `blur`, recording changes, IME composition and AltGraph reset
 * pending state. Recording input is not forwarded. Inputs carry accepted
 * revisions; Rust-side input (`menu`, `iframe`, `webview`) is forwarded as it
 * arrives. The returned disposer
 * removes the listener and, at zero listeners, uninstalls the DOM listener and
 * the transport subscriptions. `closeWindow` forwards the
 * accepted-configuration revision over `shell_close_window`.
 *
 * Deliberate difference (the recorded K4 gap): Tauri cannot consume keys
 * before the page sees them as Electron does, so the event has already
 * dispatched by the time a chord matches. This producer never calls
 * `preventDefault`: blanket suppression would break editing chords
 * (Ctrl+C/Ctrl+V) in the composer, and upstream's native path passes a no-op
 * consume callback (`native.ts:17-31`).
 *
 * Delivery is contained per listener: a subscriber that throws is reported and
 * skipped, so the remaining subscribers still receive the same input and the
 * fault never escapes into the key handler or the Rust event callback.
 * @param bridge - typed desktop facade.
 * @param revisions - shared accepted-revision cache (created once per product API).
 * @returns the keyboard bridge.
 */
export function createKeyboardApi(
  bridge: DshDesktopApi,
  revisions: ShortcutRevisionCache,
  inputState: ShortcutInputState = createShortcutInputState(),
): DesktopKeyboardApi {
  const listeners = new Set<(input: DesktopShortcutInput) => void>()
  const heldKeys = new Set<string>()
  let keydown: ((event: KeyboardEvent) => void) | undefined
  let keyup: ((event: KeyboardEvent) => void) | undefined
  let blur: (() => void) | undefined
  const sources = new Map<string, { stop?: Unlisten }>()

  const installSource = (name: string, start: (owns: () => boolean) => Promise<Unlisten>): void => {
    if (sources.has(name)) return
    const source: { stop?: Unlisten } = {}
    sources.set(name, source)
    const owns = (): boolean => sources.get(name) === source
    void (async () => {
      try {
        const stop = await start(owns)
        if (owns()) source.stop = stop
        else stop()
      } catch (error) {
        if (owns()) sources.delete(name)
        console.error(`dsh desktop keyboard: ${name} subscription failed`, error)
      }
    })()
  }

  const resetHeldKeys = (): void => { heldKeys.clear() }
  inputState.reset = resetHeldKeys
  const modifierCode = (code: string): boolean => /^(Control|Shift|Alt|Meta)(Left|Right)$/u.test(code)

  const deliver = (input: DesktopShortcutInput): void => {
    // One listener's fault stays that listener's fault: a throw must not starve
    // the listeners after it, and it must not escape into the Tauri event
    // callback (Rust-side input) or the capture-phase key handler.
    for (const listener of [...listeners]) {
      try {
        listener(input)
      } catch (error) {
        reportInputListenerFailure(error)
      }
    }
  }

  const installSources = (): void => {
    if (keydown === undefined) {
      keydown = (event: KeyboardEvent): void => {
        if (event.isComposing || event.getModifierState('AltGraph')) { resetHeldKeys(); return }
        if (modifierCode(event.code)) return
        const revision = revisions.current()
        if (revision === undefined || inputState.active) { resetHeldKeys(); return }
        const otherCode = [...heldKeys].find(code => code !== event.code)
        heldKeys.add(event.code)
        deliver({
          revision, kind: 'keyboard', frameName: '', code: event.code,
          ...(otherCode === undefined ? {} : { secondCode: otherCode }),
          control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey,
          repeat: event.repeat,
        })
      }
      keyup = (event: KeyboardEvent): void => { heldKeys.delete(event.code) }
      blur = resetHeldKeys
      window.addEventListener('keydown', keydown, true)
      window.addEventListener('keyup', keyup, true)
      window.addEventListener('blur', blur)
    }
    installSource('input', owns => bridge.onShortcutsInput(input => {
      if (owns()) deliver(input)
    }))
    installSource('changed', owns => bridge.onShortcutsChanged(() => {
      if (!owns()) return
      resetHeldKeys()
      const definitions = revisions.definitions()
      void bridge.shellShortcutsGet({ definitions }).then(
        snapshot => revisions.noteGet(definitions, snapshot),
        (error: unknown) => { console.error('dsh desktop keyboard: revision refresh failed', error) })
    }))
    installSource('recording', owns => bridge.onShortcutsRecording(({ recording }) => {
      if (!owns()) return
      inputState.active = recording
      resetHeldKeys()
    }))
  }

  return {
    subscribe(listener: (input: DesktopShortcutInput) => void): () => void {
      listeners.add(listener)
      installSources()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        if (keydown !== undefined) { window.removeEventListener('keydown', keydown, true); keydown = undefined }
        if (keyup !== undefined) { window.removeEventListener('keyup', keyup, true); keyup = undefined }
        if (blur !== undefined) { window.removeEventListener('blur', blur); blur = undefined }
        resetHeldKeys()
        const retired = [...sources.values()]
        sources.clear()
        for (const source of retired) source.stop?.()
      }
    },
    async closeWindow(revision: ShortcutRevision): Promise<void> {
      await bridge.shellCloseWindow({ revision })
    },
  }
}

/**
 * `dshDesktop.shortcuts` over `shell_shortcuts_get` / `shell_shortcuts_edit` /
 * `shell_shortcuts_recording` and `dsh://shortcuts/changed` (`### Shortcut
 * configuration`, amendments A1/A3). Subscribers receive a full
 * `ShortcutConfigSnapshot` refreshed from the Rust core on every accepted
 * change; the snapshot is never reconstructed from the binding rows. Every
 * response records its accepted revision in the shared `revisions` cache that
 * stamps produced keyboard input.
 * @param bridge - typed desktop facade.
 * @param revisions - shared accepted-revision cache (created once per product API).
 * @returns the shortcuts storage bridge.
 */
export function createShortcutsApi(
  bridge: DshDesktopApi,
  revisions: ShortcutRevisionCache,
  inputState: ShortcutInputState = createShortcutInputState(),
): DesktopShortcutsApi {
  return {
    async get(definitions: readonly ShortcutDefinition[]): Promise<ShortcutConfigSnapshot> {
      const snapshot = await bridge.shellShortcutsGet({ definitions })
      revisions.noteGet(definitions, snapshot)
      return snapshot
    },
    async edit(edit: ShortcutEdit, revision: ShortcutRevision): Promise<ShortcutSaveResult> {
      const result = await bridge.shellShortcutsEdit({ edit, revision })
      revisions.noteEdit(result)
      return result
    },
    async recording(active: boolean): Promise<void> {
      await bridge.shellShortcutsRecording({ active })
      inputState.active = active
      inputState.reset()
    },
    subscribe(listener: (snapshot: ShortcutConfigSnapshot) => void): () => void {
      let unlisten: Unlisten | undefined
      let active = true
      void bridge.onShortcutsChanged(() => {
        const definitions = revisions.definitions()
        void bridge.shellShortcutsGet({ definitions }).then((snapshot) => {
          revisions.noteGet(definitions, snapshot)
          if (active) listener(snapshot)
        }, (error: unknown) => { console.error('dsh desktop shortcuts: refresh failed', error) })
      }).then((stop) => {
        if (active) unlisten = stop
        else stop()
      })
      return () => { active = false; unlisten?.() }
    },
  }
}

/**
 * `dshDesktop.browser` stub for builds without a guest webview surface
 * (`desktop-shell-features.md` §2): every member rejects with the typed
 * `DshError::Other { code: "browser_guest_unavailable" }` — never a silent
 * no-op, never a fake guest.
 *
 * The implementation lives in `guests.ts` next to the bridge it replaces, so
 * the ratified machine code is declared once; this is the name product
 * composition uses.
 * @returns the rejecting browser bridge.
 */
export const createBrowserUnavailableBridge: () => DesktopBrowserBridge = createUnavailableBrowserBridge

/** Send one authenticated unary call through the Host's existing `/api` RPC carrier. */
async function hostRpc<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const transport = (globalThis as typeof globalThis & { __DSH_TRANSPORT__?: DshTransportHooks }).__DSH_TRANSPORT__
  const base = transport?.streamBaseUrl ?? globalThis.location?.origin
  if (base === undefined || base === 'null') throw new Error('desktop onboarding: Host RPC origin unavailable')
  const rpcId = globalThis.crypto.randomUUID()
  const response = await globalThis.fetch(new URL(`/api/${method}`, base), {
    method: 'POST', credentials: 'include', redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
  })
  if (!response.ok) throw new Error('desktop onboarding: Host RPC request failed')
  const envelope: unknown = await response.json()
  if (typeof envelope !== 'object' || envelope === null
    || Reflect.get(envelope, 'type') !== 'server-response' || Reflect.get(envelope, 'rpcId') !== rpcId) {
    throw new Error('desktop onboarding: invalid Host RPC response')
  }
  const result: unknown = Reflect.get(envelope, 'result')
  if (typeof result !== 'object' || result === null || Reflect.get(result, 'ok') !== true) {
    throw new Error('desktop onboarding: Host RPC failed')
  }
  return Reflect.get(result, 'value') as T
}

/**
 * `dshOnboarding` discovers provider references and credential metadata through
 * the authenticated Host RPC routes already used by the preserved client.
 * @param bridge - typed desktop facade, retained for the published factory signature.
 * @returns the onboarding bridge.
 */
export function createOnboardingBridge(bridge: DshDesktopApi): DshOnboardingBridge {
  return {
    async hasApiKey(): Promise<boolean> {
      const settings = await hostRpc<{ namespaces: readonly { ns: string; value: unknown }[] }>('settings/describe', {})
      const providers = await hostRpc<readonly { settingsNs: string; settingsPath: readonly string[] }[]>(
        'llm/listConfigurableProviders', {},
      )
      const refs = new Set<string>()
      for (const provider of providers) {
        const namespace = settings.namespaces.find(item => item.ns === provider.settingsNs)
        let value = namespace?.value
        for (const key of provider.settingsPath) {
          value = typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
        }
        if (typeof value === 'object' && value !== null) {
          const ref: unknown = Reflect.get(value, 'apiKeyEnv')
          if (typeof ref === 'string' && ref.length > 0) refs.add(ref)
        }
      }
      const names = [...refs]
      for (let offset = 0; offset < names.length; offset += 64) {
        const states = await hostRpc<Record<string, { configured?: boolean }>>(
          'credentials/describe', { refs: names.slice(offset, offset + 64) },
        )
        if (Object.values(states).some(state => state.configured === true)) return true
      }
      return false
    },
    setActive(active: boolean): void {
      void bridge.shellOnboardingSetActive({ active }).catch(() => undefined)
    },
  }
}

/**
 * `__DSH_LOCALE__` over `shell_locale_get` / `shell_locale_apply`
 * (amendment A4: `onChange` never persists a preference; amendment A9:
 * `read()` returns the OS language order from `LocaleState.languages`).
 * Locale ids outside the registered `en`/`zh` set are dropped (none can be
 * active).
 * @param bridge - typed desktop facade.
 * @returns the locale bridge.
 */
export function createLocaleBridge(bridge: DshDesktopApi): DshLocaleBridge {
  return {
    async read(): Promise<LocaleBootstrap> {
      const state = await bridge.shellLocaleGet()
      return { languages: state.languages, preference: state.preference }
    },
    onChange(locale: string): void {
      const request: LocaleApplyRequest | undefined = locale === 'en' || locale === 'zh' ? { locale: locale as LocaleCode } : undefined
      if (request === undefined) return
      void bridge.shellLocaleApply(request).catch(() => undefined)
    },
  }
}

/**
 * Compose the full `DshDesktopProductApi` from the contract-backed commands
 * (amendments A2/A3). `browser` defaults to the typed
 * `browser_guest_unavailable` stub of `desktop-shell-features.md` §2.
 * `keyboard` is mandatory in the desktop runtime (upstream throws when it is
 * absent) and carries the in-page physical-input producer; it shares ONE
 * `ShortcutRevisionCache` with `shortcuts` so produced input is stamped with
 * the client's accepted revision.
 * @param bridge - typed desktop facade.
 * @param options - optional `browser` override.
 * @returns the complete product bridge.
 */
export function createDesktopProductApi(
  bridge: DshDesktopApi,
  options?: { browser?: DesktopBrowserBridge },
): DshDesktopProductApi {
  const revisions = createShortcutRevisionCache()
  const inputState = createShortcutInputState()
  return {
    protocolVersion: 1,
    browser: options?.browser ?? createBrowserUnavailableBridge(),
    keyboard: createKeyboardApi(bridge, revisions, inputState),
    shortcuts: createShortcutsApi(bridge, revisions, inputState),
    updates: createUpdatesApi(bridge),
  }
}

// ---------------------------------------------------------------------------
// DOM markers and the native-drop handoff (Rust-owned; read, never invented).
// ---------------------------------------------------------------------------

/**
 * Marker `document.documentElement` attributes the shell owns
 * (`preload-platform.ts`, `preload-windows.ts`) and the client CSS scopes on.
 */
export interface ShellDomMarkers {
  /** `html[data-platform]` — `darwin` | `win32` | `linux`. */
  readonly platform?: string
  /** `html[data-windows-titlebar]` plus `--dsh-windows-titlebar-height`. */
  readonly windowsTitlebar: boolean
}

/**
 * Read the shell-installed DOM markers.
 *
 * These are Rust-owned: the initialization script sets them before page
 * modules run, and this module only reports what is there. Outside the Windows
 * desktop shell `windowsTitlebar` is false and the shared client layout
 * applies its Web rules unchanged.
 * @param root - document root to read; defaults to the live document.
 * @returns the marker values actually present.
 */
export function readShellDomMarkers(root: Document = document): ShellDomMarkers {
  const element = root.documentElement
  const platform = element.dataset.platform
  return {
    ...(platform === undefined ? {} : { platform }),
    windowsTitlebar: element.hasAttribute('data-windows-titlebar'),
  }
}

/** Registered native-drop listener, with its disposer. */
export interface HostPathDropSubscription {
  /** @param listener - receives the adopted absolute paths of one drop. @returns listener disposer. */
  subscribe(listener: (paths: readonly string[]) => void): () => void
  /** @returns removal of every listener and of the document listener. */
  dispose(): void
}

/** Default report for a listener that threw while handling a native drop. */
function reportDropListenerFailure(error: unknown): void {
  console.error('dsh desktop shell: native drop listener failed', error)
}

/**
 * Follow the shell's native OS drop handoff.
 *
 * The shell's window drag-drop handler is the only place a real absolute path
 * exists. It adopts the drop and dispatches {@link HOST_PATHS_EVENT}; this
 * subscription reads the pending batch and offers it to every listener exactly
 * once. Two ownership rules hold:
 *
 * * a listener that throws is reported and skipped, never allowed to strand the
 *   listeners after it;
 * * the subscription — not any listener — owns the batch acknowledgement, so
 *   the batch is marked consumed exactly once even when a listener throws. A
 *   listener that wants to bind the batch to `File` objects reads it through
 *   {@link hostPathDropIntake} or {@link takePendingHostPaths}, which consumes
 *   it on the caller's behalf.
 *
 * The document listener exists only while at least one listener is registered:
 * the last disposer removes it, and a later `subscribe` installs it again.
 * @returns the subscription, with its disposer.
 */
export function subscribeHostPathDrops(): HostPathDropSubscription {
  const listeners = new Set<(paths: readonly string[]) => void>()
  let attached = false
  let disposed = false
  const onEvent = (): void => {
    const api = markers.readHostPaths()
    if (api?.pending === undefined) return
    const paths = api.pending()
    if (paths.length === 0) return
    for (const listener of [...listeners]) {
      try {
        listener(paths)
      } catch (error) {
        reportDropListenerFailure(error)
      }
    }
    // The batch leaves once, after every listener was offered it. A throw above
    // must not leave the drop unacknowledged and replayed on the next event.
    try {
      api.consume?.()
    } catch (error) {
      reportDropListenerFailure(error)
    }
  }
  const attach = (): void => {
    if (attached || disposed) return
    document.addEventListener(HOST_PATHS_EVENT, onEvent)
    attached = true
  }
  const detach = (): void => {
    if (!attached) return
    document.removeEventListener(HOST_PATHS_EVENT, onEvent)
    attached = false
  }
  return {
    subscribe(listener: (paths: readonly string[]) => void): () => void {
      if (disposed) return () => undefined
      listeners.add(listener)
      attach()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) detach()
      }
    },
    dispose(): void {
      disposed = true
      listeners.clear()
      detach()
    },
  }
}

/**
 * Root attribute the preserved theme presenter writes
 * (`ui-layout/src/client/theme-presenter.ts`), and the value the Electron
 * preload forwards to `nativeTheme.themeSource`.
 */
export const THEME_SOURCE_ATTRIBUTE = 'data-ds-theme-source'

/** Handle of the native-theme mirror installed by {@link syncNativeTheme}. */
export interface NativeThemeSync {
  /** Stop observing the root attribute and cancel a pending bootstrap wait. Idempotent. */
  dispose(): void
}

/** Values `html[data-ds-theme-source]` may carry; anything else is not a preference. */
function readThemePreference(value: string | null): ThemePreference | undefined {
  return value === 'system' || value === 'light' || value === 'dark' ? value : undefined
}

/**
 * Mirror `html[data-ds-theme-source]` into the native theme through
 * `shell_theme_set`.
 *
 * The preserved client's theme presenter publishes the resolved preference
 * (`system`, or the resolved `light`/`dark`) on the document root; the Electron
 * shell forwards that value to `nativeTheme.themeSource` so native chrome,
 * renderer `prefers-color-scheme` queries and the Windows caption frame follow
 * the application palette. This is the port's half of that contract: one
 * `MutationObserver` on the root, plus the initial value.
 *
 * Each value is sent once — the shell writes the attribute back through the
 * same command, so re-sending it would be a loop. A refused command is reported
 * and the value is forgotten, so the next change (or a replayed write) retries
 * instead of being deduplicated against a value the shell never accepted. A
 * value outside the three preferences (a registered theme id, or no attribute
 * at all) is not forwarded: the port cannot express it natively.
 * @param bridge - typed desktop facade.
 * @param options - observation target and failure reporting.
 * @returns the mirror's handle, whose `dispose()` removes the observer.
 */
export function syncNativeTheme(
  bridge: DshDesktopApi,
  options: { readonly root?: Document; readonly onFailure?: (error: unknown) => void } = {},
): NativeThemeSync {
  const root = options.root ?? (globalThis as { document?: Document }).document
  if (root === undefined) return { dispose: () => undefined }
  const onFailure = options.onFailure ?? ((error: unknown) => {
    console.error('dsh desktop shell: native theme update failed', error)
  })
  let sent: ThemePreference | undefined
  let observer: MutationObserver | undefined
  let disposed = false
  const send = (): void => {
    if (disposed) return
    const preference = readThemePreference(root.documentElement.getAttribute(THEME_SOURCE_ATTRIBUTE))
    if (preference === undefined || preference === sent) return
    sent = preference
    void bridge.shellThemeSet({ theme: preference }).catch((error: unknown) => {
      if (sent === preference) sent = undefined
      onFailure(error)
    })
  }
  const observe = (): void => {
    if (disposed) return
    const view = root.defaultView
    if (view !== null) {
      observer = new view.MutationObserver(send)
      observer.observe(root.documentElement, { attributeFilter: [THEME_SOURCE_ATTRIBUTE] })
    }
    send()
  }
  if (root.readyState === 'loading') {
    // The preload-equivalent runs before the document root exists; the theme
    // bootstrap writes the attribute before DOMContentLoaded.
    root.addEventListener('DOMContentLoaded', observe, { once: true })
  } else {
    observe()
  }
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      root.removeEventListener('DOMContentLoaded', observe)
      observer?.disconnect()
      observer = undefined
    },
  }
}
