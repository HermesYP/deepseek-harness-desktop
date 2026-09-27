// @vitest-environment jsdom
/**
 * Boot-row application tests (assembled-run failure `client-modules: HTML did
 * not preload @deepseek-ai/dsh-client-modules/client.js`): proves the
 * shell-boot half of the pipeline. Drives the REAL `bootInjections` table
 * (built `@deepseek-ai/dsh-client-modules`) through the REAL page-side
 * interpreter (`applyIndexInjections`) with real HTTP fetches of the bootstrap
 * bundle, then calls the REAL `__ModuleLoader__.create()` — the exact code
 * that produced the crash string. Two server modes distinguish the remaining
 * failure causes: JavaScript bundle responses boot, while a gateway that
 * answers bundle paths with the shell document reproduces the exact crash.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootInjections } from '@deepseek-ai/dsh-client-modules'
import { applyIndexInjections } from '@deepseek-ai/dsh-client-web/injections'
import { getStaticModules } from '@deepseek-ai/dsh-client-web'
import type { DshEventMap } from '../protocol.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'
const BOOTSTRAP_URL = `plugins/??${BOOTSTRAP_ID}/client.js&rev=fx`
const APPLICATION_URL = 'plugins/??@deepseek-ai/dsh-client-ui-layout/client.js&rev=fx'
const CRASH = `client-modules: HTML did not preload ${BOOTSTRAP_ID}/client.js`

type Graph = Parameters<typeof bootInjections>[0]

const graph: Graph = {
  rev: 'fx',
  entries: [
    { id: BOOTSTRAP_ID, url: BOOTSTRAP_URL, rev: 'fx' },
    { id: '@deepseek-ai/dsh-client-ui-layout', url: APPLICATION_URL, rev: 'fx', immediately: true },
  ],
  batches: [
    { phase: 'bootstrap', url: BOOTSTRAP_URL, rev: 'fx', entries: [BOOTSTRAP_ID] },
    { phase: 'application', url: APPLICATION_URL, rev: 'fx', entries: ['@deepseek-ai/dsh-client-ui-layout'] },
  ],
}

const BUNDLE = readFileSync(
  createRequire(import.meta.url).resolve(`${BOOTSTRAP_ID}/client`), 'utf8')

const SHELL_DOCUMENT = '<!doctype html>\n<html lang="en"><head><title>DSH Local Build</title></head><body><div id="root"></div></body></html>'

/** Serve `/plugins/...` either as real JavaScript or as the shell document (gateway fallback). */
async function serve(mode: 'javascript' | 'shell-fallback'): Promise<{ port: number; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = []
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? '')
    if (mode === 'javascript') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(BUNDLE)
    } else {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(SHELL_DOCUMENT)
    }
  })
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { port: address.port, requests, close: () => new Promise(done => server.close(() => done())) }
}

/**
 * The `loadScript` seam of `apps/web/src/main.ts:27-33` (which awaits each
 * script through the page owner's asset transport), over real fetches. HTML
 * responses "load" the way a classic `<script>` loading a document does — the
 * load event fires but no registration executes — which is exactly why the
 * fallback case surfaces as the crash instead of a network error.
 */
function makeLoadScript(port: number, served: { type: string; body: string }[]) {
  return async (src: string): Promise<void> => {
    const response = await fetch(`http://127.0.0.1:${port}/${src}`)
    const body = await response.text()
    served.push({ type: response.headers.get('content-type') ?? '', body })
    try {
      (0, eval)(body)
    } catch (error) {
      // HTML has no script semantics; the load still completed (script.onload
      // fires in the browser too). Anything else is a real failure.
      if (!(error instanceof SyntaxError)) throw error
    }
  }
}

/**
 * Execute inline `script` rows the way a browser does. This harness's jsdom
 * does not run inline scripts (verified: insertion leaves `window.__X__`
 * undefined despite `runScripts: 'dangerously'`), and upstream's own assembled
 * harness evals the facade row for the same reason
 * (`_upstream/apps/web/tests/assembled-boot.ts:293`).
 */
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

function createModuleSystem(): unknown {
  const loader = window.__ModuleLoader__
  if (loader === undefined) throw new Error('no __ModuleLoader__')
  return loader.create({ boot: graph, staticModules: getStaticModules() })
}

declare global {
  interface Window {
    __ModuleLoader__?: { create(options: { boot: unknown; staticModules: unknown }): unknown }
    __DSH_BOOT__?: unknown
  }
}

afterEach(() => {
  delete window.__ModuleLoader__
  delete window.__DSH_BOOT__
  vi.resetModules()
  vi.unstubAllGlobals()
})

describe('boot rows and the bootstrap bundle (assembled-run failure analysis)', () => {
  it('bootInjections emits the bootstrap batch as a blocking script-src row, never a preload', () => {
    const rows = bootInjections(graph)
    const [queue, ...rest] = rows
    expect(queue?.kind).toBe('script')
    if (queue?.kind === 'script') expect(queue.text).toContain('mode:"queue"')
    // Application batches are advisory preloads…
    expect(rows.filter(row => row.kind === 'script-preload').map(row => (row as { src: string }).src))
      .toEqual([APPLICATION_URL])
    // …while the bootstrap batch is a BLOCKING script-src row — the only row
    // kind whose execution can register the module-system bundle.
    const bootstrapRows = rows.filter(row => row.kind === 'script-src')
    expect(bootstrapRows).toEqual([{ kind: 'script-src', placement: 'head', src: BOOTSTRAP_URL }])
    expect(rows[rows.length - 1]).toEqual({ kind: 'global', name: '__DSH_BOOT__', value: graph })
    // The preload row is a different row than the bootstrap row.
    expect(rest.some(row => row.kind === 'script-preload' && row.src === BOOTSTRAP_URL)).toBe(false)
  })

  it('dshDesktopBoot.ready() returns the injection table verbatim, unfiltered, in order', async () => {
    const rows = bootInjections(graph)
    vi.stubGlobal('__TAURI_INTERNALS__', {
      invoke: async (command: string) => {
        if (command === 'runtime_boot_ready') return { injections: rows, streamBaseUrl: 'http://127.0.0.1:3080', authenticatedUrl: 'http://127.0.0.1:3080/?token=x' }
        return undefined
      },
    })
    vi.resetModules()
    const { desktop } = await import('../index.ts')
    const { createDesktopBoot } = await import('../markers.ts')
    const ready = await createDesktopBoot(desktop).ready()
    expect(ready.injections).toEqual(rows)
    expect(ready.injections.map(row => row.kind)).toEqual(rows.map(row => row.kind))
    expect(ready.streamBaseUrl).toBe('http://127.0.0.1:3080')
  })

  it('applying the table with JavaScript bundle responses boots the REAL create()', async () => {
    const { port, requests, close } = await serve('javascript')
    const stopInline = executeInlineScripts()
    try {
      const rows = bootInjections(graph)
      const served: { type: string; body: string }[] = []
      await applyIndexInjections(rows, makeLoadScript(port, served))
      // The awaited script-src was fetched and executed before the table
      // settled: the registration is already queued (the create() precondition).
      expect(requests).toEqual([`/${BOOTSTRAP_URL}`])
      expect(served[0]?.type).toContain('javascript')
      expect(() => createModuleSystem()).not.toThrow()
    } finally {
      stopInline()
      await close()
    }
  })

  it('a gateway answering bundle paths with the shell document reproduces the exact crash', async () => {
    const { port, requests, close } = await serve('shell-fallback')
    const stopInline = executeInlineScripts()
    try {
      const rows = bootInjections(graph)
      const served: { type: string; body: string }[] = []
      await applyIndexInjections(rows, makeLoadScript(port, served))
      // The discriminator behind the crash: the bootstrap src answered with the
      // SHELL DOCUMENT. `script.onload` fires, the table settles, and the
      // registration never arrives.
      expect(requests).toEqual([`/${BOOTSTRAP_URL}`])
      expect(served[0]?.type).toContain('text/html')
      expect(served[0]?.body.startsWith('<!doctype')).toBe(true)
      expect(() => createModuleSystem()).toThrow(CRASH)
    } finally {
      stopInline()
      await close()
    }
  })
})
