/**
 * Verifies the port's window chrome and its Updates/Settings surface, in the
 * application's OWN webview via CDP:
 *
 *   1. The port-drawn caption controls are legible in BOTH themes, and restyle
 *      LIVE when the theme changes (not only at launch).
 *   2. The port-owned updates plugin is ADVERTISED by the Host at its exact row
 *      URL and entry revision, with its initial batch recorded separately.
 *      Artifact serving is distinct from activation, assessed through actual
 *      More → Settings → Updates navigation and rendered section controls.
 *      No private loader registry or independent factory-delivery verdict is used.
 *
 * Usage (app must already be running with --remote-debugging-port=9222):
 *   node scripts/verify-chrome-and-updates.mjs --cdp http://127.0.0.1:9222 --out <dir> \
 *     [--rev <live graph revision>] [--require-native]
 *
 * WHAT WAS WRONG, AND WHY EACH FIX MATTERS
 *
 *   1. IT NEVER FAILED. The script collected a `results.verdict` object, wrote
 *      it to verify.json and exited 0 unconditionally. A verdict nobody checks
 *      is a log line. Every fact is now a named check on a Verdict that sets the
 *      exit code, and a run that verified nothing fails.
 *   2. CLICKS WERE SWALLOWED. `loc.click(...).catch(() => {})` turned a failed
 *      click into a silent no-op, so "Settings" could fail to open and the run
 *      would still report on whatever page it was already showing. Failures are
 *      now propagated and reported; a helper returning null (nothing matched) is
 *      distinguished from a click that was attempted and threw.
 *   3. "UPDATES IN SETTINGS" WAS A SUBSTRING. `/Updates/i` over body text passes
 *      on the Plugins page, on an error banner, or on a nav label whose content
 *      failed to mount. The section is now identified by its registered id AND
 *      its rendered content markers, and the plugin's exact advertised row URL
 *      and entry revision are asserted (helpers/updates-contract.mjs). A 200
 *      response proves only that the Host serves the row; it does not establish
 *      module application or Settings activation.
 *   4. WRONG-PAGE FALLBACK. `?? pages[0]` inspected an arbitrary tab when no
 *      loopback page was found. The target page is now identified positively.
 *   5. NATIVE HOST NOT PROVEN. Everything here is claimed "in the application's
 *      OWN webview"; a plain Chromium on the same CDP port would look identical.
 *      The host kind is classified and recorded, and `--require-native` makes it
 *      required evidence.
 *
 * Owned by: parity lane V. Never prints the launch token.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Verdict, usageError } from '../port/tests/helpers/verdict.mjs'
import { classifyHost, NATIVE_WEBVIEW, assertNotLiveGui } from '../port/tests/helpers/host-identity.mjs'
import {
  PLUGIN_ID,
  decideUpdatesResource, classifyUpdatesArtifact, classifyUpdatesSection,
} from '../port/tests/helpers/updates-contract.mjs'

const requireFromReference = createRequire(new URL('../_upstream/apps/web/package.json', import.meta.url))
const { chromium } = requireFromReference('playwright')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const has = name => process.argv.includes(`--${name}`)

const cdp = arg('cdp', 'http://127.0.0.1:9222')
const outDir = resolve(arg('out', 'docs/evidence/port-updates'))
const liveRev = arg('rev', undefined)
const requireNative = has('require-native')

assertNotLiveGui(cdp)
await mkdir(outDir, { recursive: true })

const verdict = new Verdict('chrome and updates verification')

let browser
try {
  browser = await chromium.connectOverCDP(cdp)
} catch (error) {
  usageError(`could not attach to the CDP endpoint ${cdp}: ${String(error).slice(0, 300)}`)
}

const safePageLabel = (url) => {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}` }
  catch { return '(unparseable page URL)' }
}
const pages = browser.contexts().flatMap(c => c.pages())
const candidates = pages.filter(p => /^https?:\/\/127\.0\.0\.1:\d+\//u.test(p.url()))
verdict.assert(
  candidates.length === 1,
  'exactly one application document is attached',
  candidates.length === 1 ? safePageLabel(candidates[0].url()) : `${candidates.length} candidate(s); attached: ${pages.map(p => safePageLabel(p.url())).join(', ') || '(none)'}`,
)
if (candidates.length !== 1) {
  await browser.close()
  verdict.finish()
  process.exit(process.exitCode ?? 1)
}
const page = candidates[0]
// A safe CDP port does not imply its attached application uses a safe port.
assertNotLiveGui(page.url())
console.log(`attached: ${safePageLabel(page.url())}`)

const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push(`pageerror: ${e.message}`))

// --- The advertised Updates entry: exact URL and revision -------------------

/**
 * Read the boot payload the client received, which carries the graph revision
 * and the injection rows advertising every client plugin.
 *
 * Graph revision is recorded independently; resource requests require their
 * advertised entry revision even when --rev supplies graph metadata.
 */
const boot = await page.evaluate(() => {
  const graph = globalThis.__DSH_BOOT__ ?? null
  const entries = Array.isArray(graph?.entries) ? graph.entries : []
  const batches = Array.isArray(graph?.batches) ? graph.batches : []
  return {
    rev: typeof graph?.rev === 'string' ? graph.rev : null,
    entries: entries.map(e => ({ id: e?.id ?? null, url: e?.url ?? null, rev: e?.rev ?? null })),
    batches: batches.map(b => ({ phase: b?.phase ?? null, url: b?.url ?? null, rev: b?.rev ?? null, entries: b?.entries ?? [] })),
  }
})

const rev = boot.rev ?? liveRev ?? null
verdict.assert(
  typeof rev === 'string' && rev.length > 0,
  'the live graph revision is known',
  typeof rev === 'string' && rev.length > 0
    ? `rev=${rev} (source: ${boot.rev !== null ? 'boot payload' : '--rev'})`
    : 'neither the boot payload nor --rev supplied graph metadata; entry-resource decisions remain independent',
)

// The plugin must be advertised as a real row. Without the row the Host never
// serves the bundle, the client never loads the plugin, and no section appears
// (finding F-47: a top-level `- id:` patch row does not create an entry).
const resource = decideUpdatesResource(boot, page.url())
const advertised = resource.entry
const artifact = { requestUrl: resource.requestUrl, requested: false, status: null,
  contentType: null, servedJavaScript: false, mentionsPluginId: false, artifactAccepted: false, error: null }
verdict.assert(
  advertised !== undefined,
  `the Host advertises ${PLUGIN_ID} as a client row`,
  advertised === undefined
    ? `not present among ${boot.entries.length} advertised entr(ies): ${boot.entries.map(e => e.id).join(', ')}`
    : `row url ${advertised.url}`,
)

// Entry, batch, and graph revisions are independent build identities. Validate
// the row URL against its own revision and fetch exactly what the Host advertised.
if (advertised !== undefined) {
  verdict.assert(resource.validEntryRev, 'the advertised Updates entry has its own revision', `entry rev=${advertised.rev}`)
  const resolvedAdvertised = resource.advertisedUrl
  const resolvedExpected = resource.expectedUrl
  verdict.assert(
    resource.urlMatches,
    'the advertised Updates row URL matches its entry revision',
    `advertised ${resolvedAdvertised ?? '(none)'} expected ${resolvedExpected ?? '(unavailable)'}`,
  )
  const initialBatch = resource.batches[0]
  verdict.assert(
    resource.batches.length === 1,
    'the Updates entry is assigned to exactly one advertised initial batch',
    initialBatch ? `${initialBatch.phase} batch ${initialBatch.url} rev=${initialBatch.rev}` : 'no batch includes the plugin entry',
  )
  if (initialBatch !== undefined) {
    verdict.assert(
      typeof initialBatch.url === 'string' && typeof initialBatch.rev === 'string' && initialBatch.rev.length > 0,
      'the Updates initial batch descriptor has URL and revision',
      `batch url=${initialBatch.url} rev=${initialBatch.rev}`,
    )
  }

  // Fetch the exact advertised URL; a successful response proves serving only.
  try {
    if (resource.requestUrl === null) throw new Error('advertised row is not a valid same-origin entry-revision URL')
    artifact.requested = true
    const response = await page.request.get(resource.requestUrl, { maxRedirects: 0 })
    artifact.status = response.status()
    artifact.contentType = response.headers()['content-type'] ?? ''
    const body = await response.text()
    Object.assign(artifact, classifyUpdatesArtifact({ status: artifact.status, contentType: artifact.contentType, body }))
    const isJavaScript = artifact.servedJavaScript
    verdict.assert(
      isJavaScript,
      'the Host serves the Updates client bundle as JavaScript at its advertised row URL',
      `HTTP ${artifact.status} content-type=${JSON.stringify(artifact.contentType)}`,
    )
    if (isJavaScript) {
      verdict.assert(
        artifact.mentionsPluginId,
        'the served JavaScript mentions the expected plugin id (artifact evidence only)',
        artifact.mentionsPluginId ? `found ${PLUGIN_ID}` : `the served bundle does not mention ${PLUGIN_ID}`,
      )
    }
  } catch (error) {
    artifact.error = String(error).slice(0, 200)
    verdict.fail('the Host serves the Updates client bundle at its advertised row URL', artifact.error)
  }
}

// The public loader facade has no registry introspection API. Artifact requests
// below never execute scripts. Activation is assessed only from the actual
// More → Settings → Updates surface, not from loader fields or HTTP success.

// --- Caption strip ----------------------------------------------------------

const readCaption = () => page.evaluate(() => {
  const chrome = document.getElementById('dsh-native-chrome')
  if (!chrome) return { present: false }
  const cs = getComputedStyle(chrome)
  const btn = chrome.querySelector('button')
  const bs = btn ? getComputedStyle(btn) : null
  return {
    present: true,
    fillVar: cs.getPropertyValue('--dsh-caption-fill').trim(),
    symbolVar: cs.getPropertyValue('--dsh-caption-symbol').trim(),
    stripBackground: cs.backgroundColor,
    buttonColor: bs ? bs.color : null,
    buttonCount: chrome.querySelectorAll('button').length,
    grips: chrome.querySelectorAll('.dsh-grip').length,
    docTheme: document.documentElement.dataset.dsThemeSource ?? document.documentElement.getAttribute('data-theme') ?? null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }
})

/** Contrast ratio between two rgb()/rgba() strings, for legibility evidence. */
const parseRgb = (s) => {
  const m = /rgba?\(([^)]+)\)/u.exec(s ?? '')
  if (!m) return null
  const [r, g, b] = m[1].split(',').map(v => Number.parseFloat(v))
  return [r, g, b]
}
const luminance = ([r, g, b]) => {
  const f = (c) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const la = luminance(a), lb = luminance(b)
  return la > lb ? (la + 0.05) / (lb + 0.05) : (lb + 0.05) / (la + 0.05)
}

const results = { steps: [], boot, resource, artifact, evidencePlanes: {
  artifactServing: 'HTTP and source-text checks only; no script execution',
  settingsActivation: 'actual launcher, section navigation and rendered DOM checks',
} }
const step = (name, data) => { results.steps.push({ name, ...data }); console.log(`--- ${name}`); console.log(JSON.stringify(data, null, 2)) }

const initial = await readCaption()
initial.contrast = (() => {
  const f = parseRgb(initial.stripBackground), s = parseRgb(initial.buttonColor)
  return f && s ? Number(contrast(f, s).toFixed(2)) : null
})()
step('caption: initial state', initial)
await page.screenshot({ path: resolve(outDir, '01-initial.png') })

/**
 * Click a visible element whose trimmed text matches, trying several selectors.
 *
 * Returns the selector that was clicked, or null when nothing matched. A click
 * that is attempted and THROWS propagates: swallowing it is how a broken
 * Settings route silently became "the page we were already on".
 *
 * @param {string} text Accessible text to match.
 * @returns {Promise<string|null>} The selector used, or null when unmatched.
 */
const clickByText = async (text) => {
  for (const sel of ['button', 'a', '[role="button"]', '[role="menuitem"]', 'li', 'div']) {
    const loc = page.locator(`${sel}:visible`, { hasText: new RegExp(`^\\s*${text}\\s*$`, 'iu') })
    if (await loc.count() > 0) {
      await loc.first().click({ timeout: 5000 })
      return sel
    }
  }
  return null
}

/** Which sidebar surface is showing right now. */
const readSurface = () => page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"][data-shortcut-modal="settings"]')
  const label = dialog?.getAttribute('aria-label') ?? dialog?.textContent?.slice(0, 160) ?? ''
  const settingsOpen = dialog !== null
  return { settingsOpen, dialogLabel: label, bodyText: document.body.innerText }
})

// Open the More popover, then Settings, and inspect what the popover offers.
const popoverText = await page.evaluate(() => document.body.innerText)
results.morePopover = {
  hasSettings: /\bSettings\b/u.test(popoverText),
  hasContactUs: /Contact us/iu.test(popoverText),
  hasSignIn: /\bSign in\b/iu.test(popoverText),
}
step('surface: text presence before opening anything', results.morePopover)

const moreSelector = await clickByText('More')
await page.waitForTimeout(1200)
const afterMore = await page.evaluate(() => document.body.innerText)
results.afterMoreClick = {
  hasSettings: /\bSettings\b/u.test(afterMore),
  hasContactUs: /Contact us/iu.test(afterMore),
  hasSignIn: /\bSign in\b/iu.test(afterMore),
}
step('surface: after clicking More', { ...results.afterMoreClick, matchedSelector: moreSelector })
await page.screenshot({ path: resolve(outDir, '02-more-popover.png') })

// The account surface must be GONE from the launcher, and Settings must be
// reachable from it. Both are asserted: the plugin's whole purpose is to keep
// Settings while dropping the signed-out account rows.
verdict.assert(
  moreSelector !== null,
  'the sidebar More launcher is present and clickable',
  moreSelector === null ? 'no visible element matched "More"' : `clicked ${moreSelector}`,
)
verdict.assert(
  results.afterMoreClick.hasSettings,
  'the More launcher offers Settings',
  `after opening More, Settings present=${results.afterMoreClick.hasSettings}`,
)
verdict.assert(
  !results.afterMoreClick.hasContactUs && !results.afterMoreClick.hasSignIn,
  'the account-only entries (Contact us / Sign in) are absent from the More launcher',
  `Contact us=${results.afterMoreClick.hasContactUs}, Sign in=${results.afterMoreClick.hasSignIn}`,
)

const settingsSelector = await clickByText('Settings')
await page.waitForTimeout(2500)
const afterSettings = await readSurface()
verdict.assert(
  settingsSelector !== null,
  'the Settings action is present and clickable from the launcher',
  settingsSelector === null ? 'no visible element matched "Settings"' : `clicked ${settingsSelector}`,
)
verdict.assert(
  afterSettings.settingsOpen,
  'clicking Settings actually opened the Settings panel',
  `settingsOpen=${afterSettings.settingsOpen}, dialog=${JSON.stringify(afterSettings.dialogLabel.slice(0, 80))}`,
)

const updatesNav = page.locator('[role="dialog"][data-shortcut-modal="settings"] nav button')
  .filter({ hasText: /^(Updates|更新)$/u })
if (await updatesNav.count() === 1) {
  await updatesNav.click({ timeout: 5000 })
  await page.waitForTimeout(300)
} else {
  verdict.fail('the Settings Updates navigation button is uniquely reachable', 'no unique Updates button in the actual Settings dialog')
}

// --- The Updates section, identified by selected navigation and content ---

/**
 * Read the actual Settings dialog's navigation selection and section controls.
 */
const settingsFacts = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"][data-shortcut-modal="settings"]')
  if (dialog === null) return { present: false }
  const navEntries = [...dialog.querySelectorAll('[role="tab"],[role="menuitem"],nav button,nav a,li button,li a')]
    .map(el => (el.textContent ?? '').trim())
    .filter(text => text.length > 0 && text.length < 60)
  const navLabels = [...dialog.querySelectorAll('[role="tab"],[role="menuitem"],nav button,nav a,li button,li a')]
    .map(el => el.getAttribute('aria-label') ?? '')
    .filter(Boolean)
  const allText = dialog.innerText
  // Source UpdatesSection owns the radio fieldset and its immediate parent.
  const sectionPanel = dialog.querySelector('input[name="dsh-update-channel"]')?.closest('fieldset')?.parentElement ?? null
  const selectedNav = [...dialog.querySelectorAll('nav button')].find(el => /^(Updates|更新)$/u.test((el.textContent ?? '').trim()))
  return {
    present: true,
    navEntries,
    navLabels,
    navEntryPresent: navEntries.some(t => /^Updates$|^更新$/u.test(t)) || navLabels.some(t => /^Updates$|^更新$/u.test(t)),
    navSelected: selectedNav?.getAttribute('aria-current') === 'true',
    sectionText: sectionPanel === null ? null : sectionPanel.textContent ?? '',
    allText,
    hasCheckButton: [...dialog.querySelectorAll('button')].some(b => /Check for updates|检查更新/u.test(b.textContent ?? '')),
    hasChannelRadios: dialog.querySelectorAll('input[name="dsh-update-channel"]').length,
    legacyAccountText: /Contact us|\bSign in\b/iu.test(allText),
  }
})

results.settings = settingsFacts
step('settings: structural facts', {
  ...settingsFacts,
  sectionText: settingsFacts.sectionText === null ? null : settingsFacts.sectionText.slice(0, 400),
  allText: undefined,
})
await page.screenshot({ path: resolve(outDir, '03-settings.png') })

verdict.assert(settingsFacts.present === true, 'the Settings panel is present in the DOM')

// The section is identified by its selected nav entry AND its own
// rendered copy. A nav label alone would pass even if the content never mounted.
const sectionState = classifyUpdatesSection({
  sectionText: settingsFacts.sectionText,
  navLabel: null,
  navEntryPresent: settingsFacts.navEntryPresent === true,
  navSelected: settingsFacts.navSelected === true,
})
results.sectionState = sectionState
verdict.assert(
  sectionState.rendered,
  'the Updates section is rendered inside Settings with its own content markers',
  sectionState.rendered
    ? `matched ${sectionState.matched.join(', ')}`
    : sectionState.reasons.join('; '),
)
verdict.assert(
  settingsFacts.hasChannelRadios === 2,
  'the Updates section rendered both release-channel slots',
  `${settingsFacts.hasChannelRadios} radio input(s) named dsh-update-channel`,
)
verdict.assert(
  settingsFacts.hasCheckButton === true,
  'the Updates section rendered its update action',
)

// --- Module application -----------------------------------------------------

verdict.note('No independent factory-delivery introspection was attempted; activation evidence is the rendered Settings surface.')
// Selected navigation, section-local controls and copy are activation evidence;
// they do not expose the loader's internal factory or registration lifecycle.
verdict.assert(
  sectionState.rendered && settingsFacts.hasChannelRadios === 2 && settingsFacts.hasCheckButton === true,
  'the Updates module activation is evidenced by its fully rendered Settings surface',
  `matched markers: ${sectionState.matched.join(', ') || '(none)'}`,
)

// --- Runtime theme switch ---------------------------------------------------

verdict.assert(initial.present === true, 'the port-drawn caption strip is present', 'element #dsh-native-chrome')
if (initial.present === true) {
  verdict.assert(initial.buttonCount > 0, 'the caption strip renders its controls', `${initial.buttonCount} button(s)`)
  verdict.assert(initial.grips > 0, 'the caption strip renders its resize grips', `${initial.grips} grip(s)`)
}

// Appearance is owned by settings.general.item, not the Updates section.
const generalNav = page.locator('[role="dialog"][data-shortcut-modal="settings"] nav button')
  .filter({ hasText: /^(General|通用设置)$/u })
if (await generalNav.count() === 1) {
  await generalNav.click({ timeout: 5000 })
} else {
  verdict.fail('the General section is reachable for the theme switch', 'no unique General navigation button')
}
const clickTheme = async (text) => {
  const control = page.locator('[role="dialog"][data-shortcut-modal="settings"] button:visible')
    .filter({ hasText: new RegExp(`^\\s*${text}\\s*$`, 'u') })
  if (await control.count() !== 1) return null
  await control.click({ timeout: 5000 })
  return `Settings theme button: ${text}`
}
const darkSelector = await clickTheme('Dark')
await page.waitForTimeout(2000)
const dark = await readCaption()
dark.contrast = (() => {
  const f = parseRgb(dark.stripBackground), s = parseRgb(dark.buttonColor)
  return f && s ? Number(contrast(f, s).toFixed(2)) : null
})()
step('caption: after switching to Dark at runtime', dark)
await page.screenshot({ path: resolve(outDir, '04-dark.png') })

const lightSelector = await clickTheme('Light')
await page.waitForTimeout(2000)
const light = await readCaption()
light.contrast = (() => {
  const f = parseRgb(light.stripBackground), s = parseRgb(light.buttonColor)
  return f && s ? Number(contrast(f, s).toFixed(2)) : null
})()
step('caption: after switching back to Light at runtime', light)
await page.screenshot({ path: resolve(outDir, '05-light.png') })

verdict.assert(darkSelector !== null, 'the Dark theme control is present and clickable', darkSelector ?? 'no visible element matched "Dark"')
verdict.assert(lightSelector !== null, 'the Light theme control is present and clickable', lightSelector ?? 'no visible element matched "Light"')

// The runtime switch is the part two separate launches cannot prove: the theme
// actually changed AND the caption strip tracked it.
const themeChanged = dark.bodyBg !== light.bodyBg
verdict.assert(themeChanged, 'switching theme at runtime changed the document background', `dark=${dark.bodyBg} light=${light.bodyBg}`)
verdict.assert(
  dark.stripBackground !== light.stripBackground,
  'the port-drawn caption strip restyled live when the theme changed',
  `dark=${dark.stripBackground} light=${light.stripBackground}`,
)
verdict.assert(
  dark.contrast !== null && dark.contrast >= 3,
  'the caption controls are legible in the dark theme',
  `contrast ${dark.contrast} (min 3)`,
)
verdict.assert(
  light.contrast !== null && light.contrast >= 3,
  'the caption controls are legible in the light theme',
  `contrast ${light.contrast} (min 3)`,
)

// --- Settings survived, account surface stayed gone -------------------------

const afterTheme = await readSurface()
verdict.assert(
  afterTheme.settingsOpen,
  'the Settings panel survived the runtime theme change',
  `settingsOpen=${afterTheme.settingsOpen}`,
)
verdict.assert(
  !settingsFacts.legacyAccountText,
  'the account-only entries are absent from the Settings panel',
)

// --- Host identity ----------------------------------------------------------

const hostFacts = await page.evaluate(() => ({
  hasTauriInternals: '__TAURI_INTERNALS__' in globalThis,
  hasDesktopBoot: typeof globalThis.dshDesktopBoot === 'object' && globalThis.dshDesktopBoot !== null,
  hasDesktopMarker: 'dshDesktop' in globalThis,
  hasHostPaths: '__DSH_HOST_PATHS__' in globalThis,
  platformMarker: document.documentElement.dataset.platform ?? null,
  userAgent: navigator.userAgent,
}))
const host = classifyHost(hostFacts)
results.host = { ...host, facts: hostFacts }

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

verdict.assert(
  !errors.some(e => /pageerror/u.test(e)),
  'no uncaught page error occurred during the run',
  errors.filter(e => /pageerror/u.test(e)).slice(0, 3).join(' | ') || 'none',
)

if (errors.length > 0) {
  console.log('--- console errors ---')
  for (const e of errors.slice(0, 8)) console.log(`  ${e}`)
}
results.consoleErrors = errors

await writeFile(resolve(outDir, 'verify.json'), JSON.stringify(results, null, 2))
await browser.close()

verdict.finish()
