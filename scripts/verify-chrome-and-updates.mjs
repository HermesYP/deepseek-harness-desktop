/**
 * Verifies the two open items in the port's window chrome and settings surface,
 * in the application's OWN webview via CDP:
 *
 *   1. The port-drawn caption controls are legible in BOTH themes, and restyle
 *      LIVE when the theme changes (not only at launch).
 *   2. The port-owned updates plugin renders a section inside Settings, the
 *      account-only entries are gone, and Settings itself survives.
 *
 * Usage (app must already be running with --remote-debugging-port=9222):
 *   node scripts/verify-chrome-and-updates.mjs --cdp http://127.0.0.1:9222 --out docs/evidence/port-final
 *
 * Owned by: lead. Never prints the launch token.
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
const outDir = resolve(arg('out', 'docs/evidence/port-final'))
await mkdir(outDir, { recursive: true })

const browser = await chromium.connectOverCDP(cdp)
const pages = browser.contexts().flatMap((c) => c.pages())
const page = pages.find((p) => /^https?:\/\/127\.0\.0\.1:\d+\//.test(p.url())) ?? pages[0]
if (!page) { console.error('no page attached'); process.exit(1) }
console.log(`attached: ${page.url()}`)

const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))

/** Read the caption strip's resolved colours and the button glyph colour. */
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
  const m = /rgba?\(([^)]+)\)/.exec(s ?? '')
  if (!m) return null
  const [r, g, b] = m[1].split(',').map((v) => Number.parseFloat(v))
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

const results = { steps: [] }
const step = (name, data) => { results.steps.push({ name, ...data }); console.log(`--- ${name}`); console.log(JSON.stringify(data, null, 2)) }

const initial = await readCaption()
initial.contrast = (() => {
  const f = parseRgb(initial.stripBackground), s = parseRgb(initial.buttonColor)
  return f && s ? Number(contrast(f, s).toFixed(2)) : null
})()
step('caption: initial state', initial)
await page.screenshot({ path: resolve(outDir, '01-initial.png') })

/** Click a visible element whose trimmed text matches, trying several selectors. */
const clickByText = async (text) => {
  for (const sel of ['button', 'a', '[role="button"]', '[role="menuitem"]', 'li', 'div']) {
    const loc = page.locator(`${sel}:visible`, { hasText: new RegExp(`^\\s*${text}\\s*$`, 'i') })
    const n = await loc.count()
    if (n > 0) { await loc.first().click({ timeout: 4000 }).catch(() => {}); return sel }
  }
  return null
}

// Open the More popover, then Settings, and inspect what the popover offers.
const popoverText = await page.evaluate(() => document.body.innerText)
results.morePopover = {
  hasSettings: /\bSettings\b/.test(popoverText),
  hasContactUs: /Contact us/i.test(popoverText),
  hasSignIn: /\bSign in\b/i.test(popoverText),
  hasUpdates: /Updates/i.test(popoverText),
}
step('surface: text presence before opening anything', results.morePopover)

await clickByText('More')
await page.waitForTimeout(1200)
const afterMore = await page.evaluate(() => document.body.innerText)
results.afterMoreClick = {
  hasSettings: /\bSettings\b/.test(afterMore),
  hasContactUs: /Contact us/i.test(afterMore),
  hasSignIn: /\bSign in\b/i.test(afterMore),
}
step('surface: after clicking More', results.afterMoreClick)
await page.screenshot({ path: resolve(outDir, '02-more-popover.png') })

await clickByText('Settings')
await page.waitForTimeout(2500)
const settingsText = await page.evaluate(() => document.body.innerText)
results.settings = {
  hasUpdatesSection: /Updates/i.test(settingsText),
  hasGeneral: /\bGeneral\b/.test(settingsText),
  hasAppearance: /Appearance/i.test(settingsText),
  hasDark: /\bDark\b/.test(settingsText),
  hasLight: /\bLight\b/.test(settingsText),
  hasContactUs: /Contact us/i.test(settingsText),
  hasSignIn: /\bSign in\b/i.test(settingsText),
  sample: settingsText.slice(0, 500),
}
step('settings: contents', results.settings)
await page.screenshot({ path: resolve(outDir, '03-settings.png') })

// Runtime theme switch: this is the part two separate launches cannot prove.
await clickByText('Dark')
await page.waitForTimeout(2000)
const dark = await readCaption()
dark.contrast = (() => {
  const f = parseRgb(dark.stripBackground), s = parseRgb(dark.buttonColor)
  return f && s ? Number(contrast(f, s).toFixed(2)) : null
})()
step('caption: after switching to Dark at runtime', dark)
await page.screenshot({ path: resolve(outDir, '04-dark.png') })

await clickByText('Light')
await page.waitForTimeout(2000)
const light = await readCaption()
light.contrast = (() => {
  const f = parseRgb(light.stripBackground), s = parseRgb(light.buttonColor)
  return f && s ? Number(contrast(f, s).toFixed(2)) : null
})()
step('caption: after switching back to Light at runtime', light)
await page.screenshot({ path: resolve(outDir, '05-light.png') })

results.verdict = {
  captionPresent: initial.present,
  buttonsRendered: initial.buttonCount,
  resizeGrips: initial.grips,
  themeActuallyChanged: dark.bodyBg !== light.bodyBg,
  captionTrackedTheme: dark.stripBackground !== light.stripBackground,
  legibleInDark: dark.contrast !== null && dark.contrast >= 3,
  legibleInLight: light.contrast !== null && light.contrast >= 3,
  updatesSectionInSettings: results.settings.hasUpdatesSection,
  contactUsRemoved: !results.afterMoreClick.hasContactUs && !results.settings.hasContactUs,
  signInRemoved: !results.afterMoreClick.hasSignIn && !results.settings.hasSignIn,
  settingsSurvived: results.settings.hasGeneral || results.settings.hasAppearance,
  consoleErrors: errors.length,
}
step('VERDICT', results.verdict)
if (errors.length) { console.log('--- console errors ---'); for (const e of errors.slice(0, 8)) console.log(`  ${e}`) }

await writeFile(resolve(outDir, 'verify.json'), JSON.stringify(results, null, 2))
await browser.close()
