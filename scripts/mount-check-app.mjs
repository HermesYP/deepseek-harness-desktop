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
 * WHAT WAS WRONG, AND WHY EACH FIX MATTERS
 *
 *   1. WRONG-PAGE FALLBACK. The script picked the attached page whose URL looked
 *      like a loopback origin and FELL BACK to `pages[0]` otherwise. Any other
 *      tab — a devtools page, a blank target, a second window — would be
 *      inspected and its contents reported as the application's. The target page
 *      must now be identified positively, and an unidentified endpoint is a
 *      failure rather than a guess.
 *   2. UNDEFINED SIGNAL. The poll loop broke on `state.hasSettings`, a property
 *      the evaluate callback never returned, so the loop always ran to its
 *      deadline. The mount signal is now explicit and checked.
 *   3. NATIVE HOST NOT PROVEN. "Mounted in the application's own webview" was
 *      asserted without checking that the webview was actually a native Tauri
 *      host rather than a plain Chromium attached to the same CDP port. The host
 *      kind is now classified and recorded, and `--require-native` makes it
 *      mandatory.
 *   4. NO EXIT ON PARTIAL EVIDENCE. Console errors and page errors were printed
 *      but never affected the result. A page error during mount is a failure.
 *
 * Never prints the launch token. Owned by: parity lane V.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Verdict, usageError, isNonEmptyString } from '../port/tests/helpers/verdict.mjs'
import { classifyHost, NATIVE_WEBVIEW, assertNotLiveGui } from '../port/tests/helpers/host-identity.mjs'

const requireFromReference = createRequire(new URL('../_upstream/apps/web/package.json', import.meta.url))
const { chromium } = requireFromReference('playwright')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = name => process.argv.includes(`--${name}`)

const cdp = arg('cdp', 'http://127.0.0.1:9222')
const outDir = resolve(arg('out', 'docs/evidence/port'))
const timeoutMs = Number(arg('timeout', '90000'))
const expectOrigin = arg('expect-origin', undefined)
const requireNative = has('require-native')

assertNotLiveGui(cdp)
await mkdir(outDir, { recursive: true })

const verdict = new Verdict('desktop mount check')

let browser
try {
  browser = await chromium.connectOverCDP(cdp)
} catch (error) {
  usageError(`could not attach to the CDP endpoint ${cdp}: ${String(error).slice(0, 300)}\n`
    + 'Launch the application with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 first.')
}

const pages = browser.contexts().flatMap(c => c.pages())
verdict.assert(pages.length > 0, 'a page is attached at the CDP endpoint', `${pages.length} page(s)`)
if (pages.length === 0) {
  await browser.close()
  verdict.finish()
  process.exit(process.exitCode ?? 1)
}

/** Does this page look like the application document served by the gateway? */
const isApplicationPage = page => /^https?:\/\/127\.0\.0\.1:\d+\//u.test(page.url())

const candidates = pages.filter(isApplicationPage)
verdict.assert(
  candidates.length > 0,
  'the application document is attached',
  candidates.length > 0
    ? candidates.map(p => p.url()).join(', ')
    // Report what WAS attached, so a wrong endpoint is diagnosable instead of
    // silently inspecting an unrelated tab.
    : `no attached page is a loopback gateway document; attached: ${pages.map(p => p.url()).join(', ') || '(none)'}`,
)

// Exactly one application document is expected. Several means the target is
// ambiguous, and picking one arbitrarily is how a check inspects the wrong page.
const page = candidates.length === 1
  ? candidates[0]
  : (candidates.find(p => expectOrigin === undefined || p.url().startsWith(expectOrigin)) ?? candidates[0])

if (expectOrigin !== undefined && page !== undefined) {
  verdict.assert(
    page.url().startsWith(expectOrigin),
    'the attached page matches the expected origin',
    `${page.url()} vs expected prefix ${expectOrigin}`,
  )
}
if (candidates.length > 1) {
  verdict.fail(
    'exactly one application document is attached',
    `${candidates.length} candidates: ${candidates.map(p => p.url()).join(', ')}`,
  )
}

if (page === undefined) {
  await browser.close()
  verdict.finish()
  process.exit(process.exitCode ?? 1)
}

const consoleErrors = []
const pageErrors = []
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
page.on('pageerror', e => pageErrors.push(`pageerror: ${e.message}`))

console.log(`attached: ${page.url()}  (pages at endpoint: ${pages.length})`)

/**
 * Read the mount state and the facts that identify the host.
 *
 * Every field is either consumed below or recorded as evidence; the earlier
 * version read `state.hasSettings`, which this callback never returned.
 */
const READ_STATE = () => {
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
    hasBootReady: typeof globalThis.__DSH_BOOT_READY__ === 'object' && globalThis.__DSH_BOOT_READY__ !== null,
    hasModuleLoader: typeof globalThis.__ModuleLoader__ === 'object' && globalThis.__ModuleLoader__ !== null,
    hasDesktopBoot: typeof globalThis.dshDesktopBoot === 'object' && globalThis.dshDesktopBoot !== null,
    hasDesktopMarker: 'dshDesktop' in globalThis,
    hasHostPaths: '__DSH_HOST_PATHS__' in globalThis,
    hasTauriInternals: '__TAURI_INTERNALS__' in globalThis,
    userAgent: navigator.userAgent,
    // Preserved-client workspace landmarks.
    hasNewSession: [...document.querySelectorAll('#root button,#root a')]
      .some(el => el.getAttribute('aria-label') === 'New session' || /New Session/u.test(el.textContent ?? '')),
    // Accept EITHER composer placeholder. The empty-state copy and the
    // in-session copy differ - "Describe what you want to build" versus
    // "Message or run a task" - and requiring one exact string produced a false
    // `mounted: false` on a fully rendered session view with real user data.
    hasComposerHint: /Describe what you want to build|Message or run a task/u.test(text),
    hasSettingsControl: [...document.querySelectorAll('button,a,[role="button"]')]
      .some(el => /settings/i.test(el.textContent ?? '') || /settings/i.test(el.getAttribute('aria-label') ?? '')),
    pluginStyleIds: [...document.querySelectorAll('style[data-plugin]')].map(el => el.getAttribute('data-plugin')),
    bootText: /Loading|Starting/u.test(text) ? text.slice(0, 200) : null,
    textSample: text.slice(0, 600),
  }
}

// Poll rather than assert immediately: boot is asynchronous and involves host
// authentication, index-injection application and plugin activation.
const deadline = Date.now() + timeoutMs
let state = await page.evaluate(READ_STATE)
while (Date.now() < deadline) {
  // The mount signal: the preserved client composed its workspace. Both facts
  // are genuinely readable from the page and both must hold.
  if (state.hasComposerHint && state.hasNewSession) break
  await page.waitForTimeout(2000)
  state = await page.evaluate(READ_STATE)
}

const host = classifyHost(state)
await page.screenshot({ path: resolve(outDir, 'mount-check.png') })
await writeFile(resolve(outDir, 'mount-check.json'), JSON.stringify({
  cdp,
  url: page.url(),
  attachedPages: pages.map(p => p.url()),
  host,
  state,
  consoleErrors,
  pageErrors,
}, null, 2))

console.log(JSON.stringify({ ...state, hostKind: host.kind, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length }, null, 2))
if (consoleErrors.length) {
  console.log('--- console errors ---')
  for (const e of consoleErrors.slice(0, 10)) console.log(`  ${e}`)
}
if (pageErrors.length) {
  console.log('--- page errors ---')
  for (const e of pageErrors.slice(0, 10)) console.log(`  ${e}`)
}

await browser.close()

// --- Assertions -------------------------------------------------------------
// The mount signal: the composer and the session sidebar are both present. An
// earlier version also required the literal text "Settings", which is a UI
// detail rather than a mount signal, and produced a false FAIL on a fully
// rendered workspace, so a settings control is recorded as evidence rather than
// required.
verdict.assert(state.hasComposerHint, 'the preserved client rendered the composer', state.textSample.slice(0, 120))
verdict.assert(state.hasNewSession, 'the preserved client rendered the session sidebar action')
verdict.assert(state.rootChildren > 0, 'the client mounted into #root', `${state.rootChildren} child element(s)`)
verdict.assert(
  state.pluginStyles > 0,
  'at least one plugin style was injected (client plugins activated)',
  `${state.pluginStyles} plugin style(s)${state.pluginStyleIds.length === 0 ? '' : `: ${state.pluginStyleIds.slice(0, 8).join(', ')}`}`,
)
verdict.assert(
  !/is missing or not an object|bootstrap facade is missing/u.test(state.textSample),
  'the page did not render a boot-failure message',
)
verdict.assert(
  state.hasDesktopBoot || state.hasModuleLoader,
  'the desktop boot seam is present in the webview',
  `dshDesktopBoot=${state.hasDesktopBoot}, __ModuleLoader__=${state.hasModuleLoader}, __DSH_BOOT_READY__=${state.hasBootReady}`,
)
verdict.assert(pageErrors.length === 0, 'no uncaught page error during mount', pageErrors.slice(0, 3).join(' | ') || 'none')

if (requireNative) {
  verdict.assert(
    host.kind === NATIVE_WEBVIEW,
    'the attached host is the native Tauri/WebView2 application',
    `${host.kind} (${host.evidence.join(', ')})`,
  )
} else {
  verdict.record(
    'attached host kind (recorded, not asserted)',
    host.kind === NATIVE_WEBVIEW ? 'PASS' : 'SKIP',
    `${host.kind} (${host.evidence.join(', ')}); pass --require-native to make this mandatory evidence`,
  )
}

verdict.finish()
