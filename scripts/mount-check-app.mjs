/**
 * Mount check for the assembled desktop application.
 *
 * Verifies that the PRESERVED CLIENT MOUNTS in the application's OWN webview —
 * i.e. the workspace renders rather than the boot page.
 *
 * WHY CDP: loading the gateway URL in a separate browser CANNOT work. Tauri IPC
 * exists only inside the Tauri webview, so outside it `dshDesktopBoot.ready()`
 * can never resolve and the client legitimately sits on its boot page. An
 * earlier version of this script did exactly that and produced a false FAIL.
 * This attaches to the real webview instead, via the WebView2 remote-debugging
 * endpoint enabled by `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`.
 *
 * Usage:
 *   # launch the app with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
 *   node scripts/mount-check-app.mjs --cdp http://127.0.0.1:9222 --out docs/evidence/port
 *
 * Never prints the launch token. Owned by: lead (acceptance).
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
const outDir = resolve(arg('out', 'docs/evidence/port'))
const timeoutMs = Number(arg('timeout', '90000'))

await mkdir(outDir, { recursive: true })

const browser = await chromium.connectOverCDP(cdp)
const contexts = browser.contexts()
const pages = contexts.flatMap((c) => c.pages())
if (pages.length === 0) {
  console.error(`MOUNT CHECK: FAIL — no page attached at ${cdp}`)
  await browser.close()
  process.exit(1)
}

// The application document is the one served by the gateway; pick it explicitly
// rather than assuming ordering, and fall back to the first page.
const page = pages.find((p) => /^https?:\/\/127\.0\.0\.1:\d+\//.test(p.url())) ?? pages[0]

const consoleErrors = []
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`))

console.log(`attached: ${page.url()}  (pages at endpoint: ${pages.length})`)

// Poll rather than assert immediately: boot is asynchronous and involves host
// authentication, index-injection application and plugin activation.
const deadline = Date.now() + timeoutMs
let state = null
while (Date.now() < deadline) {
  state = await page.evaluate(() => {
    const text = document.body.innerText
    return {
      title: document.title,
      lang: document.documentElement.lang,
      platformMarker: document.documentElement.dataset.platform ?? null,
      windowsTitlebar: document.documentElement.dataset.windowsTitlebar ?? null,
      themeSource: document.documentElement.dataset.dsThemeSource ?? null,
      rootChildren: document.querySelector('#root')?.childElementCount ?? 0,
      pluginStyles: document.querySelectorAll('style[data-plugin]').length,
      hasBootGlobal: typeof globalThis.__DSH_BOOT__ === 'object' && globalThis.__DSH_BOOT__ !== null,
      hasModuleLoader: typeof globalThis.__ModuleLoader__ === 'object' && globalThis.__ModuleLoader__ !== null,
      hasDesktopBoot: typeof globalThis.dshDesktopBoot === 'object' && globalThis.dshDesktopBoot !== null,
      hasDesktopMarker: 'dshDesktop' in globalThis,
      hasHostPaths: '__DSH_HOST_PATHS__' in globalThis,
      // Preserved-client workspace landmarks.
      hasNewSession: text.includes('New Session'),
      // Accept EITHER composer placeholder. The empty-state copy and the
      // in-session copy differ - "Describe what you want to build" versus
      // "Message or run a task" - and requiring one exact string produced a false
      // `mounted: false` on a fully rendered session view with real user data.
      hasComposerHint: /Describe what you want to build|Message or run a task/.test(text),
      // Case-insensitive, and also look for a control rather than only text: a
      // settings entry could be an icon button with an accessible name.
      hasSettingsText: /settings/i.test(text),
      hasSettingsControl: [...document.querySelectorAll('button,a,[role="button"]')]
        .some((el) => /settings/i.test(el.textContent ?? '') || /settings/i.test(el.getAttribute('aria-label') ?? '')),
      sidebarLabels: [...document.querySelectorAll('button,a,[role="button"]')]
        .map((el) => (el.textContent ?? '').trim())
        .filter((label) => label.length > 0 && label.length < 40)
        .slice(0, 24),
      bootText: /Loading|Starting/i.test(text) ? text.slice(0, 200) : null,
      textSample: text.slice(0, 600),
    }
  })
  if (state.hasComposerHint && state.hasSettings) break
  await page.waitForTimeout(2000)
}

// Mounted means the preserved client composed its workspace. The composer plus
// the session sidebar is sufficient: an earlier version also required the literal
// text "Settings", which is a UI detail rather than a mount signal, and produced
// a false FAIL on a fully rendered workspace.
const mounted = Boolean(state?.hasComposerHint && state?.hasNewSession)
await page.screenshot({ path: resolve(outDir, 'mount-check.png') })
await writeFile(resolve(outDir, 'mount-check.json'), JSON.stringify({ cdp, url: page.url(), mounted, state, consoleErrors }, null, 2))

console.log(JSON.stringify({ ...state, mounted, consoleErrors: consoleErrors.length }, null, 2))
if (consoleErrors.length) {
  console.log('--- console errors ---')
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`)
}

await browser.close()

if (!mounted) {
  console.error('MOUNT CHECK: FAIL — the preserved client did not render its workspace in the application webview.')
  process.exitCode = 1
} else {
  console.log('MOUNT CHECK: PASS — the preserved client rendered its workspace in the application webview.')
}
