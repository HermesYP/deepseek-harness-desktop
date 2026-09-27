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
  DesktopShortcutInput, DesktopUpdatePresentation, DshError, IndexInjection,
  LocaleApplyRequest, LocaleCode, ShortcutConfigSnapshot, ShortcutDefinition, ShortcutEdit,
  ShortcutRevision, ShortcutSaveResult,
} from './protocol.ts'
import type { DshDesktopApi, Unlisten } from './index.ts'

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
}

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

// ---------------------------------------------------------------------------
// Install / read accessors.
// ---------------------------------------------------------------------------

type GlobalKey =
  | '__DSH_BOOT_READY__' | 'dshDesktopBoot' | '__DSH_TRANSPORT__' | '__DSH_HOST_PATHS__'
  | '__DSH_DIRECTORY_PICKER__' | '__DSH_LOCALE__' | 'dshOnboarding' | 'dshDesktop'

interface MarkerGlobals {
  __DSH_BOOT_READY__?: DshBootReadyGate
  dshDesktopBoot?: DshDesktopBoot
  __DSH_TRANSPORT__?: DshTransportHooks
  __DSH_HOST_PATHS__?: DshHostPaths
  __DSH_DIRECTORY_PICKER__?: DshDirectoryPicker
  __DSH_LOCALE__?: DshLocaleBridge
  dshOnboarding?: DshOnboardingBridge
  dshDesktop?: DshDesktopProductApi | DshDesktopPartialApi
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
  let unlistenInput: Unlisten | undefined
  let unlistenChanged: Unlisten | undefined
  let unlistenRecording: Unlisten | undefined
  let sourcesLive = false

  const resetHeldKeys = (): void => { heldKeys.clear() }
  inputState.reset = resetHeldKeys
  const modifierCode = (code: string): boolean => /^(Control|Shift|Alt|Meta)(Left|Right)$/u.test(code)

  const deliver = (input: DesktopShortcutInput): void => {
    for (const listener of [...listeners]) listener(input)
  }

  const installSources = (): void => {
    sourcesLive = true
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
    if (unlistenInput === undefined) {
      void bridge.onShortcutsInput(deliver).then((stop) => {
        if (sourcesLive) unlistenInput = stop
        else stop()
      })
    }
    if (unlistenChanged === undefined) {
      void bridge.onShortcutsChanged(() => {
        resetHeldKeys()
        const definitions = revisions.definitions()
        void bridge.shellShortcutsGet({ definitions }).then(
          snapshot => revisions.noteGet(definitions, snapshot),
          (error: unknown) => { console.error('dsh desktop keyboard: revision refresh failed', error) })
      }).then((stop) => {
        if (sourcesLive) unlistenChanged = stop
        else stop()
      })
    }
    if (unlistenRecording === undefined) {
      void bridge.onShortcutsRecording(({ recording }) => {
        inputState.active = recording
        resetHeldKeys()
      }).then((stop) => {
        if (sourcesLive) unlistenRecording = stop
        else stop()
      })
    }
  }

  return {
    subscribe(listener: (input: DesktopShortcutInput) => void): () => void {
      listeners.add(listener)
      installSources()
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        sourcesLive = false
        if (keydown !== undefined) { window.removeEventListener('keydown', keydown, true); keydown = undefined }
        if (keyup !== undefined) { window.removeEventListener('keyup', keyup, true); keyup = undefined }
        if (blur !== undefined) { window.removeEventListener('blur', blur); blur = undefined }
        resetHeldKeys()
        unlistenInput?.()
        unlistenInput = undefined
        unlistenChanged?.()
        unlistenChanged = undefined
        unlistenRecording?.()
        unlistenRecording = undefined
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
 * @returns the rejecting browser bridge.
 */
export function createBrowserUnavailableBridge(): DesktopBrowserBridge {
  const error: DshError = {
    kind: 'other',
    detail: { code: 'browser_guest_unavailable', message: 'embedded browser guests are unavailable in this shell' },
  }
  return {
    acquire: () => Promise.reject(error),
    release: () => Promise.reject(error),
    onOpenRequested: () => { throw error },
  }
}

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
