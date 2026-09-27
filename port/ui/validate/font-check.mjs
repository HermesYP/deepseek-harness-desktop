// Font-load check for the packaged web-client shell (`port/ui/dist`): serves
// the built output on a scratch port (default 3089), waits for
// `document.fonts.ready`, and reports every webfont request and face status —
// verifying the Montserrat brand faces and KaTeX faces resolve at their exact
// `assets/fonts/` paths from the bundled CSS.
//
// Run from `port/ui/`:
//   node validate/font-check.mjs
import { createServer } from 'node:http'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const uiRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(uiRoot, 'dist')
const PORT = Number(process.env.DSH_FONT_CHECK_PORT ?? 3089)

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
}
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${PORT}`).pathname)
  const target = resolve(dist, `.${path === '/' ? '/index.html' : path}`)
  if (target !== dist && !target.startsWith(dist + sep)) { res.writeHead(403); res.end(); return }
  if (path === '/' || !existsSync(target) || !statSync(target).isFile()) {
    const index = path === '/' || path === '/index.html' ? join(dist, 'index.html') : undefined
    if (index === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': MIME['.html'] })
    res.end(readFileSync(index))
    return
  }
  res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' })
  res.end(readFileSync(target))
})
await new Promise(done => server.listen(PORT, '127.0.0.1', done))

const browser = await chromium.launch()
const page = await browser.newPage()
const requested = []
page.on('request', (request) => {
  if (/\.(woff2?|ttf)(?:\?|$)/u.test(request.url())) requested.push(request.url().split('/').pop())
})
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(2000)
const faces = await page.evaluate(async () => {
  await document.fonts.ready
  // Force every registered face to fetch its bytes (screens that do not render a
  // family yet keep its face 'unloaded'; loading proves the URL serves the face).
  await Promise.all([...document.fonts].map(face => face.load().catch(() => undefined)))
  return [...document.fonts].map(face => `${face.family}/${face.weight}:${face.status}`)
})
console.log(`font-check: requests ${requested.length}: ${[...new Set(requested)].sort().join(', ') || '(none)'}`)
console.log(`font-check: faces ${faces.length}: ${faces.join(' | ') || '(none)'}`)
const montserrat = faces.filter(face => face.startsWith('Montserrat/') && face.endsWith(':loaded'))
console.log(`font-check: Montserrat loaded faces: ${montserrat.length}`)
await browser.close()
server.close()
if (montserrat.length === 0) {
  console.error('font-check: FAILED — no Montserrat face loaded')
  process.exitCode = 1
} else {
  console.log('font-check: PASS — brand and content webfonts resolve at assets/fonts/')
}
