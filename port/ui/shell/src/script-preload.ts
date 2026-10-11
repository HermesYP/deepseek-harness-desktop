/**
 * Port delta: honor application `script-preload` rows in the desktop boot path.
 *
 * The Host composes application batches as `script-preload` rows that precede
 * the blocking bootstrap scripts (`_upstream/packages/client/modules/src/index.ts`
 * `bootInjections()`), so the browser could download the application bundles
 * while the bootstrap still loads. Upstream's page-side interpreter ignores the
 * row kind (`_upstream/packages/client/web/src/apply-injections.ts:36-38`), and
 * the preserved entry (`./web-main.ts`, byte-identical copy of
 * `_upstream/apps/web/src/main.ts`) therefore first requests an application
 * batch only when the module system arrives it — after the bootstrap phase. The
 * eventual request is a plain `<script src>` (`defaultLoadBundle`,
 * `_upstream/packages/client/modules/src/client/system.ts:16-29`), so a bare
 * prefetch would download every batch twice under the gateway's no-store
 * override. This sidecar closes the gap without touching any preserved file:
 *
 * 1. `dshDesktopBoot.ready()` (installed by `desktop-bridge/shell-boot.ts`) is
 *    wrapped so the injection table is scanned for `script-preload` rows the
 *    moment the boot payload arrives — before the preserved entry's
 *    `applyIndexInjections` executes its first row. Each unique batch URL
 *    starts one `fetch(url, { credentials: 'same-origin' })` — the exact
 *    document-relative URL (revisioned `/plugins` combo route) and credentials
 *    mode of the eventual script request — into a module-scoped map keyed by
 *    the exact URL.
 *
 * 2. `globalThis.__DSH_TRANSPORT__` becomes a merging accessor. The preserved
 *    entry REPLACES the global with `{ ownsHost, streamBaseUrl }`
 *    (`web-main.ts:25-26`), so a pre-installed `loadBundle` would be dropped;
 *    the accessor merges the port transport into every assignment instead. The
 *    module stage reads `__DSH_TRANSPORT__.loadBundle` when the entry creates
 *    the module system (`_upstream/packages/client/web/src/boot.ts:68-76`), and
 *    the loader's per-URL in-flight map (`pendingArrival`,
 *    `.../modules/src/client/system.ts:175-185`) runs one transport per URL as
 *    before — the map here only deduplicates the prefetch itself.
 *
 * The consumer makes the prefetched URL ONE effective download with zero
 * cache-header dependency: `loadPrefetchedBundle` consumes the stored response
 * text and executes it as an inline classic script — the same execution class
 * as the queue `script` row (`apply-injections.ts:27-31`), which already boots
 * this client, so no new CSP class is introduced — instead of inserting a
 * second `<script src>` that would re-download. The batch text calls
 * `window.__ModuleLoader__.load` itself, so the registration wrapper, the
 * loader's arrival order, and its per-URL deduplication are unchanged, and the
 * batch still executes only when the module system arrives it. Inline
 * execution runs synchronously at insertion, matching the after-execution
 * guarantee the `<script src>` load event gives the loader, and the bundles'
 * root-relative `//# sourceMappingURL=/plugins/...` trailers resolve to the
 * same map routes as the script-src path.
 *
 * Failure handling keeps the hint advisory: a failed or missing prefetch —
 * every URL the map does not hold (one-resource fallbacks, HMR reload targets,
 * package-local chunks) and every URL whose fetch rejected — falls through to
 * the default same-origin `<script src>` transport mirrored from
 * `defaultLoadBundle`, so the loader's retry-once and one-resource-fallback
 * ladder behave exactly as before. Prefetch failures are silently ignored; the
 * real load path re-fetches and reports errors as today.
 */
import { markers, type DshDesktopBoot, type DshTransportHooks } from '../../desktop-bridge/markers.ts'
import type { IndexInjection } from '../../desktop-bridge/protocol.ts'

/** Prefetched bundle text per exact batch URL; a rejected promise marks a failed prefetch. */
const prefetchedBundles = new Map<string, Promise<string>>()

/** Marker string embedded in this sidecar's error messages; greps the built bundle for the port delta. */
const SIDE_CAR_MARKER = 'dsh-port-script-preload'

/**
 * Start one same-origin prefetch per unique `script-preload` URL.
 * @param rows - the injection table exactly as `dshDesktopBoot.ready()` returned it.
 */
function startApplicationBatchPreloads(rows: readonly IndexInjection[]): void {
  for (const row of rows) {
    if (row.kind !== 'script-preload' || prefetchedBundles.has(row.src)) continue
    const download = fetch(row.src, { credentials: 'same-origin' }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`${SIDE_CAR_MARKER}: bundle script ${row.src} answered HTTP ${String(response.status)}`)
      }
      return response.text()
    })
    prefetchedBundles.set(row.src, download)
    // Advisory prefetch: the rejection is recorded for the consumer and marked
    // handled here, so the page never reports it as an unhandled error.
    download.catch(() => undefined)
  }
}

/**
 * The default same-origin classic-script transport, mirroring `defaultLoadBundle`
 * (`.../modules/src/client/system.ts:16-29`) for every URL this sidecar does not
 * serve from a prefetch.
 * @param url - bundle URL as the loader resolved it.
 * @returns resolves after the script executed (the `load` event), rejects on a transport error.
 */
function defaultScriptTransport(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.async = true
    el.src = url
    el.addEventListener('load', () => {
      el.remove()
      resolve()
    }, { once: true })
    el.addEventListener('error', () => {
      el.remove()
      reject(new Error(`${SIDE_CAR_MARKER}: bundle script ${url} failed to load`))
    }, { once: true })
    document.head.append(el)
  })
}

/**
 * Execute one fetched bundle as an inline classic script (the `script` row
 * mechanism of `apply-injections.ts:27-31`). Inline scripts run synchronously at
 * insertion, so the batch's registrations are submitted before the caller's
 * promise continues. A parse or runtime error inside the batch is reported to
 * the window like any inline script; the loader observes the missing
 * registration and applies its fallback ladder unchanged.
 * @param text - the exact bundle text the prefetch downloaded.
 */
function executeBundleText(text: string): void {
  const el = document.createElement('script')
  el.textContent = text
  document.head.append(el)
  el.remove()
}

/**
 * The `loadBundle` transport the module system runs for every bundle URL.
 * A prefetched URL consumes its stored response exactly once (one effective
 * download); every other URL — and a URL whose prefetch failed — takes the
 * default script-src transport, so fallbacks, HMR reloads and package-local
 * chunks behave exactly as before this sidecar.
 * @param url - bundle URL as the loader resolved it.
 * @returns resolves after the bundle executed; rejects only through the default transport.
 */
async function loadPrefetchedBundle(url: string): Promise<void> {
  const prefetch = prefetchedBundles.get(url)
  if (prefetch !== undefined) {
    // One-shot consumption: the initial batch URL is served from the prefetch
    // once; any later request for the same string takes the network path, like
    // the un-prefetched case.
    prefetchedBundles.delete(url)
    const text = await prefetch.catch(() => undefined)
    if (text !== undefined) {
      executeBundleText(text)
      return
    }
  }
  return defaultScriptTransport(url)
}

/**
 * Merge the port transport into the preserved entry's `__DSH_TRANSPORT__`
 * assignment, which replaces the global whole (`web-main.ts:25-26`).
 */
function installMergingTransportAccessor(): void {
  const owner = globalThis as { __DSH_TRANSPORT__?: unknown }
  let hooks: DshTransportHooks | undefined
  // Remember a plain pre-existing value, then take the property over.
  const existing = Object.getOwnPropertyDescriptor(owner, '__DSH_TRANSPORT__')
  if (existing !== undefined && existing.get === undefined) {
    hooks = existing.value as DshTransportHooks | undefined
  }
  Object.defineProperty(owner, '__DSH_TRANSPORT__', {
    configurable: true,
    enumerable: true,
    get: () => hooks,
    set: (value: DshTransportHooks | undefined) => {
      hooks = value === undefined ? undefined : { ...value, loadBundle: loadPrefetchedBundle }
    },
  })
}

/**
 * Wrap the desktop boot bridge so the prefetches start inside `ready()` — after
 * the payload exists, before the preserved entry's `await` resumes and
 * `applyIndexInjections` executes its first row. Repeat `ready()` calls
 * deduplicate through the prefetch map.
 * @param boot - the bridge `desktop-bridge/shell-boot.ts` installed.
 */
function wrapDesktopBootReady(boot: DshDesktopBoot): void {
  const ready = boot.ready.bind(boot)
  boot.ready = async () => {
    const payload = await ready()
    startApplicationBatchPreloads(payload.injections)
    return payload
  }
}

let installed = false

/**
 * Install the sidecar: the merging `__DSH_TRANSPORT__` accessor plus, when the
 * desktop boot bridge exists, the `ready()` prefetch wrap. Outside the desktop
 * shell nothing is wrapped and the accessor stays inert (the preserved entry
 * never assigns the global there).
 */
export function installScriptPreloadSidecar(): void {
  if (installed) return
  installed = true
  installMergingTransportAccessor()
  const boot = markers.readDesktopBoot()
  if (boot !== undefined) wrapDesktopBootReady(boot)
}

installScriptPreloadSidecar()
