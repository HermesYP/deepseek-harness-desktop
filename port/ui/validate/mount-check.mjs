// Mount + inventory check for the packaged web-client shell (`port/ui/dist`).
//
// The built output is served exactly as the shell-owned path describes
// (docs/contracts/ui-backend-protocol.md §7.3): `port/ui/dist` statics plus the
// Host injection table (`bootInjections(graph)` from the built
// @deepseek-ai/dsh-client-modules) rendered into index.html with the upstream
// `renderIndexInjections` row placement, and plugin bundles served from the
// built workspace `lib/client.js` artifacts at their `/plugins/...` combo URLs —
// the same bytes the real Host serves. A real Chromium then loads the page and
// the check asserts the client mounts (plugin styles injected, no boot
// failure), and every shipped asset answers 200 at its exact path.
//
// Run from `port/ui/`:
//   node validate/mount-check.mjs
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

const here = dirname(fileURLToPath(import.meta.url))
const uiRoot = resolve(here, '..')
const repoRoot = resolve(uiRoot, '..', '..')
const upstream = join(repoRoot, '_upstream')
const dist = join(uiRoot, 'dist')
const PORT = Number(process.env.DSH_MOUNT_CHECK_PORT ?? 3086)

// --- compose the assembled plugin graph (mirrors apps/web/tests/assembled-boot.ts) ---

const BUNDLE_LAYERS = ['packages/bundle/base', 'packages/bundle/web-app'].map(dir => ({
  dir: join(upstream, dir),
  manifest: join(upstream, dir, 'package.json'),
}))
const bundleResolvers = BUNDLE_LAYERS.map(layer => createRequire(layer.manifest))
const webBundleResolver = bundleResolvers[1]
const workspacePackageManifests = new Map(
  readdirSync(join(upstream, 'packages'), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap((group) => {
      const groupDir = join(upstream, 'packages', group.name)
      return readdirSync(groupDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map((pkg) => {
          const manifestPath = join(groupDir, pkg.name, 'package.json')
          return existsSync(manifestPath) ? [JSON.parse(readFileSync(manifestPath, 'utf8')).name, manifestPath] : undefined
        })
        .filter(Boolean)
    }),
)
const appBoot = await import(pathToFileURL(webBundleResolver.resolve('@deepseek-ai/dsh-app-boot')).href)
const { bootInjections, orderByModuleGraph } = await import('@deepseek-ai/dsh-client-modules')

const comboReference = (ids, rev) => `plugins/??${ids.map(id => `${id}/client.js`).join(',')}&rev=${rev}`

function loadAssembledPlugins() {
  const entries = appBoot.composeEntries(BUNDLE_LAYERS.map(layer =>
    appBoot.bundlePatchPaths(layer.dir, JSON.parse(readFileSync(layer.manifest, 'utf8')).dsh.bundle)
      .flatMap(patch => appBoot.loadOverlayPatches('mount-check', patch))))
  const plugins = new Map()
  for (const entry of entries) {
    if (entry.disabled === true || typeof entry.name !== 'string') continue
    const packagePath = workspacePackageManifests.get(entry.name)
    if (packagePath === undefined) continue
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'))
    const declaration = pkg.dsh?.client
    if (declaration?.platform !== 'web') continue
    const declared = pkg.exports?.['./client']
    const relative = typeof declared === 'string' ? declared : declared?.default
    if (relative === undefined) throw new Error(`mount-check: ${entry.name} declares dsh.client without ./client`)
    plugins.set(entry.name, {
      id: entry.name,
      bundlePath: resolve(dirname(packagePath), relative),
      url: comboReference([entry.name], 'fx'),
      rev: 'fx',
      ...(declaration.inject === undefined ? {} : { inject: declaration.inject }),
      ...(declaration.external === undefined ? {} : { external: declaration.external }),
      ...(declaration.immediately === true ? { immediately: true } : {}),
    })
  }
  return orderByModuleGraph([...plugins.values()]).map(({ id }) => plugins.get(id))
}

const plugins = loadAssembledPlugins()
const BOOTSTRAP_IDS = ['@deepseek-ai/dsh-client-modules']

function bootGraph() {
  const bootstrapEntries = plugins.map(p => p.id).filter(id => BOOTSTRAP_IDS.includes(id))
  const applicationEntries = plugins.map(p => p.id).filter(id => !BOOTSTRAP_IDS.includes(id))
  return {
    rev: 'fx',
    entries: plugins.map(({ bundlePath: _bundlePath, ...entry }) => entry),
    batches: [
      ...(bootstrapEntries.length === 0 ? [] : [{ phase: 'bootstrap', url: comboReference(bootstrapEntries, 'fx'), rev: 'fx', entries: bootstrapEntries }]),
      ...(applicationEntries.length === 0 ? [] : [{ phase: 'application', url: comboReference(applicationEntries, 'fx'), rev: 'fx', entries: applicationEntries }]),
    ],
  }
}

const graph = bootGraph()
const bundles = new Map(plugins.map(p => [p.url, readFileSync(p.bundlePath, 'utf8')]))
for (const batch of graph.batches) {
  bundles.set(batch.url, batch.entries.map(id => bundles.get(plugins.find(p => p.id === id).url)).join('\n;\n'))
}

// --- render index.html with the Host injection rows (upstream row placement) ---

let renderIndexInjections
try {
  ({ renderIndexInjections } = await import('@deepseek-ai/dsh-host-webserver'))
} catch {
  renderIndexInjections = undefined
}
if (typeof renderIndexInjections !== 'function') {
  // Fallback: the row placement of packages/host/webserver/src/injections.ts:96-119.
  renderIndexInjections = (html, rows) => {
    let head = ''
    let body = ''
    for (const row of rows) {
      const placement = row.kind === 'global' || row.kind === 'style' || row.kind === 'script-preload' ? 'head' : row.placement
      let markup = ''
      if (row.kind === 'global') markup = `<script>globalThis[${JSON.stringify(row.name)}] = ${row.value === undefined ? 'undefined' : JSON.stringify(row.value)}</script>`
      else if (row.kind === 'script') markup = `<script>${row.text}</script>`
      else if (row.kind === 'script-src') markup = `<script src="${row.src}"></script>`
      else if (row.kind === 'script-preload') markup = `<link rel="preload" as="script" href="${row.src}">`
      else if (row.kind === 'style') markup = `<style>${row.text}</style>`
      else markup = row.html
      if (placement === 'head') head += markup
      else body += markup
    }
    body += '<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>'
    const headAt = /<head(?:\s[^>]*)?>/i.exec(html)
    let out = headAt === null ? head + html : html.slice(0, headAt.index + headAt[0].length) + head + html.slice(headAt.index + headAt[0].length)
    const bodyAt = /<body(?:\s[^>]*)?>/i.exec(out)
    return bodyAt === null ? out + body : out.slice(0, bodyAt.index + bodyAt[0].length) + body + out.slice(bodyAt.index + bodyAt[0].length)
  }
}

const rawIndex = readFileSync(join(dist, 'index.html'), 'utf8')
const servedIndex = renderIndexInjections(rawIndex, bootInjections(graph))

// --- serve dist + /plugins exactly at their contract paths ---

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.png': 'image/png',
}
const served = []
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  const send = (status, type, body) => {
    served.push({ path: req.url, status })
    res.writeHead(status, { 'content-type': type })
    res.end(body)
  }
  try {
    if (req.url.startsWith('/plugins/')) {
      const query = req.url.slice('/plugins/'.length)
      const names = query.replace(/^[?]+/u, '').split('&')[0].split(',')
      const code = names.map((name) => {
        const id = name.replace(/\/client\.js$/u, '')
        const body = bundles.get(`plugins/??${id}/client.js&rev=fx`)
        if (body === undefined) throw new Error(`mount-check: unknown bundle ${name}`)
        return body
      }).join('\n;\n')
      send(200, MIME['.js'], code)
      return
    }
    const pathname = decodeURIComponent(url.pathname)
    const target = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`)
    if (target !== dist && !target.startsWith(dist + sep)) return send(403, 'text/plain', 'forbidden')
    if (pathname === '/' || pathname === '/index.html') return send(200, MIME['.html'], servedIndex)
    if (!existsSync(target) || !statSync(target).isFile()) return send(404, 'text/plain', 'not found')
    send(200, MIME[extname(target)] ?? 'application/octet-stream', readFileSync(target))
  } catch (error) {
    send(500, 'text/plain', String(error))
  }
})

await new Promise(resolveListen => server.listen(PORT, '127.0.0.1', resolveListen))
console.log(`mount-check: serving port/ui/dist on http://127.0.0.1:${PORT} (${plugins.length} client plugin bundles)`)

// 1. Inventory: every file in dist must answer 200 at its exact path.
const failures = []
const inventory = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else inventory.push(`/${full.slice(dist.length + 1).replaceAll(sep, '/')}`)
  }
}
walk(dist)
for (const path of inventory) {
  const response = await fetch(`http://127.0.0.1:${PORT}${path}`)
  if (response.status !== 200) failures.push(`${path} -> HTTP ${response.status}`)
  await response.arrayBuffer()
}
console.log(`mount-check: inventory ${inventory.length} files, ${failures.length} failures`)

// 2. Mount: real Chromium over the served page.
const browser = await chromium.launch()
const page = await browser.newPage()
const consoleErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(String(error)))
const requestedFonts = []
page.on('request', (request) => {
  if (request.url().includes('/assets/fonts/')) requestedFonts.push(request.url().split('/').pop())
})
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
await page.waitForFunction(() => (document.querySelector('#root')?.childElementCount ?? 0) > 0, undefined, { timeout: 30_000 })
await page.waitForTimeout(5000)
const state = await page.evaluate(() => ({
  rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
  pluginStyles: document.head.querySelectorAll('style[data-plugin]').length,
  bodyText: document.body.textContent ?? '',
  bootReady: typeof globalThis.__DSH_BOOT_READY__ === 'object',
  bootGraph: typeof globalThis.__DSH_BOOT__ === 'object',
  moduleLoader: typeof globalThis.__ModuleLoader__ === 'object' || typeof globalThis.__ModuleLoader__ === 'function',
}))
console.log(`mount-check: root children=${state.rootChildren}, plugin styles=${state.pluginStyles}, `
  + `__DSH_BOOT_READY__=${state.bootReady}, __DSH_BOOT__=${state.bootGraph}, __ModuleLoader__=${state.moduleLoader}`)
console.log(`mount-check: font requests: ${[...new Set(requestedFonts)].sort().join(', ') || '(none)'}`)
if (/is missing or not an object/u.test(state.bodyText)) failures.push('boot failure text rendered: window.__DSH_BOOT__ is missing')
if (/bootstrap facade is missing/u.test(state.bodyText)) failures.push('boot failure text rendered: __ModuleLoader__ facade missing')
if (state.rootChildren === 0) failures.push('#root stayed empty')
if (state.pluginStyles === 0) failures.push('no plugin styles injected (client did not activate)')
if (consoleErrors.length > 0) console.log(`mount-check: console errors (expected /api noise while unconnected): ${consoleErrors.slice(0, 5).join(' | ')}`)
await page.screenshot({ path: join(repoRoot, 'port', '.scratch', 'mount-check.png') }).catch(() => undefined)
await browser.close()
server.close()

if (failures.length > 0) {
  console.error(`mount-check: FAILED\n${failures.join('\n')}`)
  process.exitCode = 1
} else {
  console.log('mount-check: PASS — built output serves at its exact paths and the client mounts')
}
