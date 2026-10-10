/**
 * The decisive check the review corrected us to: read the BROWSER BOOT GRAPH and
 * fetch the URL it actually advertises.
 *
 * A 404 from a hand-constructed `/plugins/??<package>/client.js&rev=<rev>` URL
 * proves nothing: the modules server advertises specific revisioned URLs and is
 * not obliged to serve an arbitrary per-package one. So the questions are:
 *
 *   1. does the boot graph contain a row for the port plugin, and on what URL;
 *   2. does THAT url return 200 with JavaScript;
 *   3. did the plugin actually activate (its two slot contributions)?
 *
 * Usage (app already running with CDP):
 *   node scripts/boot-graph-probe.mjs --cdp http://127.0.0.1:9222 --out docs/evidence/port-updates
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const requireFromReference = createRequire(new URL('../_upstream/apps/web/package.json', import.meta.url))
const { chromium } = requireFromReference('playwright')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const cdp = arg('cdp', 'http://127.0.0.1:9222')
const outDir = resolve(arg('out', 'docs/evidence/port-updates'))
await mkdir(outDir, { recursive: true })

const browser = await chromium.connectOverCDP(cdp)
const pages = browser.contexts().flatMap((c) => c.pages())
const page = pages.find((p) => /^https?:\/\/127\.0\.0\.1:\d+\//.test(p.url())) ?? pages[0]
if (!page) { console.error('no page attached'); process.exit(1) }
console.log(`attached: ${page.url()}`)

const graph = await page.evaluate(() => {
  const boot = globalThis.__DSH_BOOT__
  if (boot === undefined || boot === null) return { present: false }
  const entries = Array.isArray(boot) ? boot : (boot.entries ?? boot.rows ?? [])
  return {
    present: true,
    shape: Array.isArray(boot) ? 'array' : Object.keys(boot).join(','),
    count: entries.length,
    entries: entries.map((e) => ({
      id: e?.id ?? null,
      url: e?.url ?? e?.src ?? null,
      kind: e?.kind ?? null,
      immediately: e?.immediately ?? null,
      keys: Object.keys(e ?? {}).join(','),
    })),
  }
})

console.log('boot graph present :', graph.present)
console.log('boot graph shape   :', graph.shape)
console.log('boot graph entries :', graph.count)

const OURS = '@dsh-port/dsh-client-ui-updates'
const ours = (graph.entries ?? []).filter((e) => String(e.id).includes('dsh-port') || String(e.id).includes('ui-updates'))
console.log('rows mentioning the port plugin :', ours.length)
for (const row of ours) console.log('   ', JSON.stringify(row))

const reference = (graph.entries ?? []).filter((e) => String(e.id).includes('ui-settings-models'))
console.log('rows for a known-good client plugin (ui-settings-models):', reference.length)
for (const row of reference) console.log('   ', JSON.stringify(row))

// Fetch the advertised URL(s) exactly as the page would.
const urls = []
for (const row of [...ours, ...reference]) if (row.url) urls.push(row.url)
const fetched = []
for (const url of urls) {
  const absolute = new URL(url, page.url()).href
  const outcome = await page.evaluate(async (target) => {
    try {
      const response = await fetch(target, { credentials: 'include' })
      const text = await response.text()
      return {
        status: response.status,
        type: response.headers.get('content-type'),
        bytes: text.length,
        first: text.slice(0, 80),
        registersPlugin: text.includes('__ModuleLoader__'),
      }
    } catch (error) {
      return { error: String(error) }
    }
  }, absolute)
  fetched.push({ url: absolute, ...outcome })
  console.log(`  FETCH ${absolute}\n     -> ${JSON.stringify(outcome)}`)
}

// Did the plugin activate? Its contributions are the Updates section and the
// replacement settings launcher.
await page.evaluate(() => {
  const el = [...document.querySelectorAll('button,a,[role="button"],[role="menuitem"]')]
    .find((node) => /more/i.test(node.textContent ?? '') || /more/i.test(node.getAttribute('aria-label') ?? ''))
  el?.click()
})
await page.waitForTimeout(1500)
const surface = await page.evaluate(() => {
  const text = document.body.innerText
  return {
    hasUpdates: /updates/i.test(text),
    hasSettings: /\bSettings\b/.test(text),
    hasContactUs: /Contact us/i.test(text),
    hasSignIn: /\bSign in\b/i.test(text),
  }
})
console.log('surface after opening More:', JSON.stringify(surface))

const verdict = {
  bootGraphPresent: graph.present,
  bootGraphEntries: graph.count,
  portRowsInGraph: ours.length,
  referenceRowsInGraph: reference.length,
  fetched,
  served200: fetched.some((f) => f.status === 200 && f.registersPlugin === true),
  surface,
}
console.log('=== VERDICT ===')
console.log(JSON.stringify(verdict, null, 2))

await page.screenshot({ path: resolve(outDir, 'boot-graph.png') })
await writeFile(resolve(outDir, 'boot-graph.json'), JSON.stringify({ graph, verdict }, null, 2))
await browser.close()
