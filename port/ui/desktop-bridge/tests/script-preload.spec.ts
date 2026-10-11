// @vitest-environment jsdom
/**
 * Port sidecar `shell/src/script-preload.ts` — honoring application
 * `script-preload` rows in the desktop boot path. Proves, against the REAL
 * `bootInjections` table, the REAL registration facade, and the REAL
 * `applyIndexInjections` interpreter: the prefetch starts the moment
 * `dshDesktopBoot.ready()` resolves (before the preserved entry could apply the
 * table), deduplicates per exact URL, is consumed exactly ONCE through the
 * merged `__DSH_TRANSPORT__.loadBundle` (no second download; the batch text
 * registers through `window.__ModuleLoader__.load`), and every un-prefetched or
 * failed URL falls back to the default `<script src>` transport with no extra
 * fetch. jsdom executes no scripts, so inline rows run through the same
 * MutationObserver+eval harness `boot-rows.spec.ts` established.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bootInjections } from '@deepseek-ai/dsh-client-modules'
import { markers, type DshDesktopBoot, type DshTransportHooks } from '../markers.ts'
import type { IndexInjection } from '../protocol.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'
const APP_ID = '@deepseek-ai/dsh-client-ui-layout'
const BOOTSTRAP_URL = `plugins/??${BOOTSTRAP_ID}/client.js&rev=fx`
const APPLICATION_URL = `plugins/??${APP_ID}/client.js&rev=fx`
const APP_BUNDLE_TEXT = `window.__ModuleLoader__.load({id:${JSON.stringify(APP_ID)},factory:()=>({tag:"app"})})`

type Graph = Parameters<typeof bootInjections>[0]

const graph: Graph = {
  rev: 'fx',
  entries: [
    { id: BOOTSTRAP_ID, url: BOOTSTRAP_URL, rev: 'fx' },
    { id: APP_ID, url: APPLICATION_URL, rev: 'fx', immediately: true },
  ],
  batches: [
    { phase: 'bootstrap', url: BOOTSTRAP_URL, rev: 'fx', entries: [BOOTSTRAP_ID] },
    { phase: 'application', url: APPLICATION_URL, rev: 'fx', entries: [APP_ID] },
  ],
}

interface FetchCall { url: string; init: RequestInit | undefined }
let fetchCalls: FetchCall[] = []

/** Replace global fetch with a counting stub; `undefined` from `respond` rejects (prefetch failure). */
function stubFetch(respond: (url: string) => { status: number; body: string } | undefined): void {
  fetchCalls = []
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    fetchCalls.push({ url, init })
    const answer = respond(url)
    if (answer === undefined) return Promise.reject(new Error(`no response configured for ${url}`))
    return Promise.resolve(new Response(answer.body, { status: answer.status }))
  })
}

function bootBridge(injections: readonly IndexInjection[]): DshDesktopBoot {
  return {
    ready: async () => ({ injections, streamBaseUrl: 'http://127.0.0.1:3080' }),
    failed: async () => undefined,
  }
}

/** Fresh sidecar module state (prefetch map, install flag) per test. */
async function importSidecar(): Promise<void> {
  await import('../../shell/src/script-preload.ts')
}

/** jsdom never executes inline scripts; queue their text through eval like boot-rows.spec.ts does. */
function executeInlineScripts(): () => void {
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node instanceof HTMLScriptElement && node.textContent !== '') (0, eval)(node.textContent)
      }
    }
  })
  observer.observe(document.head, { childList: true })
  return () => observer.disconnect()
}

/** Let MutationObserver microtasks (the eval harness) run. */
async function flushTasks(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/**
 * The appended script whose `src` ATTRIBUTE is the verbatim URL. jsdom resolves
 * the `src` property against the document base, so only the attribute carries
 * the relative form the transport set.
 */
function headScriptBySrc(src: string): HTMLScriptElement | undefined {
  return [...document.head.querySelectorAll('script')].find(el => el.getAttribute('src') === src)
}

/** The preserved entry's assignment (`web-main.ts:25-26`): replaces the global whole. */
function assignTransportLikePreservedEntry(): DshTransportHooks | undefined {
  ;(globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__ = { ownsHost: true, streamBaseUrl: 'http://127.0.0.1:3080' }
  return markers.readTransport()
}

function requireTransport(): DshTransportHooks & Required<Pick<DshTransportHooks, 'loadBundle'>> {
  const hooks = markers.readTransport()
  const { loadBundle } = hooks ?? {}
  if (hooks === undefined || loadBundle === undefined) throw new Error('no merged __DSH_TRANSPORT__.loadBundle')
  return { ...hooks, loadBundle }
}

beforeEach(() => {
  delete (globalThis as { __DSH_TRANSPORT__?: unknown }).__DSH_TRANSPORT__
  delete (globalThis as { dshDesktopBoot?: unknown }).dshDesktopBoot
  delete (window as { __ModuleLoader__?: unknown }).__ModuleLoader__
})

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  for (const el of [...document.head.querySelectorAll('script')]) el.remove()
})

describe('script-preload sidecar (application batch early download)', () => {
  it('starts one same-origin prefetch per unique preload URL as soon as ready() resolves', async () => {
    stubFetch(url => ({ status: 200, body: `// bundle ${url}` }))
    markers.installDesktopBoot(bootBridge(bootInjections(graph)))
    await importSidecar()
    const boot = markers.readDesktopBoot()
    if (boot === undefined) throw new Error('no desktop boot bridge')
    await boot.ready()
    // Exactly the application batch: the application preload URL, verbatim, with
    // the credentials mode of the eventual classic-script request. The bootstrap
    // batch is not prefetched (it arrives through its blocking script-src row).
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0]?.url).toBe(APPLICATION_URL)
    expect(fetchCalls[0]?.init).toMatchObject({ credentials: 'same-origin' })
    // A repeated ready() deduplicates through the prefetch map.
    await boot.ready()
    expect(fetchCalls).toHaveLength(1)
  })

  it('the merged __DSH_TRANSPORT__ consumes the prefetch once and registers through the real facade', async () => {
    stubFetch(url => ({ status: 200, body: url === APPLICATION_URL ? APP_BUNDLE_TEXT : `// bundle ${url}` }))
    const rows = bootInjections(graph)
    markers.installDesktopBoot(bootBridge(rows))
    await importSidecar()
    await markers.readDesktopBoot()?.ready()
    // The preserved entry replaces the global; the accessor must merge loadBundle in.
    const hooks = assignTransportLikePreservedEntry()
    expect(hooks?.ownsHost).toBe(true)
    expect(hooks?.streamBaseUrl).toBe('http://127.0.0.1:3080')
    expect(typeof hooks?.loadBundle).toBe('function')
    const stopInline = executeInlineScripts()
    try {
      // The REAL queue script row installs the REAL registration facade.
      const [queue] = rows
      if (queue === undefined) throw new Error('no queue row')
      const { applyIndexInjections } = await import('@deepseek-ai/dsh-client-web/injections')
      await applyIndexInjections([queue], () => Promise.resolve())
      await requireTransport().loadBundle(APPLICATION_URL)
      await flushTasks()
      const loader = (window as { __ModuleLoader__?: { pendingQueue: { id: string }[] } }).__ModuleLoader__
      // The prefetched batch text registered through window.__ModuleLoader__.load.
      expect(loader?.pendingQueue.map(registration => registration.id)).toEqual([APP_ID])
      // ONE download: the transport consumed the prefetch, no second request.
      expect(fetchCalls.map(call => call.url)).toEqual([APPLICATION_URL])
    } finally {
      stopInline()
    }
  })

  it('un-prefetched URLs take the default script-src transport with no fetch', async () => {
    stubFetch(url => ({ status: 200, body: `// bundle ${url}` }))
    markers.installDesktopBoot(bootBridge(bootInjections(graph)))
    await importSidecar()
    await markers.readDesktopBoot()?.ready()
    assignTransportLikePreservedEntry()
    const other = 'plugins/??@dsh-port/other/client.js&rev=r'
    void requireTransport().loadBundle(other)
    await flushTasks()
    const appended = headScriptBySrc(other)
    expect(appended).not.toBeUndefined()
    expect(appended?.async).toBe(true)
    // Only the application prefetch was fetched; the fallback does not fetch.
    expect(fetchCalls.map(call => call.url)).toEqual([APPLICATION_URL])
  })

  it('a failed prefetch stays silent and the real load falls back to the script-src transport', async () => {
    stubFetch(url => url === APPLICATION_URL ? undefined : { status: 200, body: `// bundle ${url}` })
    markers.installDesktopBoot(bootBridge(bootInjections(graph)))
    await importSidecar()
    // ready() still resolves; the prefetch rejection is handled inside the sidecar.
    await expect(markers.readDesktopBoot()?.ready()).resolves.toMatchObject({ streamBaseUrl: 'http://127.0.0.1:3080' })
    assignTransportLikePreservedEntry()
    void requireTransport().loadBundle(APPLICATION_URL)
    await flushTasks()
    // The real load path re-requests the URL through the default transport.
    expect(headScriptBySrc(APPLICATION_URL)).not.toBeUndefined()
  })

  it('outside the desktop shell nothing is wrapped and nothing is fetched', async () => {
    stubFetch(url => ({ status: 200, body: `// bundle ${url}` }))
    await importSidecar()
    expect(markers.readDesktopBoot()).toBeUndefined()
    const hooks = assignTransportLikePreservedEntry()
    expect(typeof hooks?.loadBundle).toBe('function')
    const other = 'plugins/??@dsh-port/other/client.js&rev=r'
    void requireTransport().loadBundle(other)
    await flushTasks()
    expect(headScriptBySrc(other)).not.toBeUndefined()
    expect(fetchCalls).toHaveLength(0)
  })
})
