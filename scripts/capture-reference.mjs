/**
 * Reference capture harness for the port's parity work.
 *
 * Drives the ORIGINAL DeepSeek Harness web application through Playwright and
 * captures application-content screenshots (never desktop screenshots) at a
 * fixed viewport, plus an interaction trace. Run against a live `dsh web`.
 *
 * Usage:
 *   node scripts/capture-reference.mjs --url <base> --out <dir> [--trace]
 *
 * Owned by: lead (evidence collection). Do not edit in an implementation lane.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

// Playwright is a devDependency of the reference application (apps/web). Resolve
// it from the pinned reference checkout so this harness needs no node_modules of
// its own and cannot drift from the browser build under test.
const requireFromReference = createRequire(new URL('../_upstream/apps/web/package.json', import.meta.url))
const { chromium } = requireFromReference('playwright')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

/** Viewports matched exactly between the reference and the port. */
export const VIEWPORTS = [
  { id: 'desktop-1280x800', width: 1280, height: 800, dsf: 1 },
  { id: 'desktop-1600x1000', width: 1600, height: 1000, dsf: 1 },
]

/** Themes matched exactly between the reference and the port. */
export const THEMES = ['light', 'dark']

const outRoot = resolve(arg('out', 'reference-capture'))
const baseUrl = arg('url', 'http://127.0.0.1:3080')

/**
 * One recorded interaction step: a label, an optional selector to act on, and
 * an optional keyboard chord. Screenshots are taken after each step.
 */
const SEQUENCE = [
  { id: '00-boot', label: 'Application boot / loading page' },
  { id: '01-onboarding-notice', label: 'First-run Internal Testing Notice modal' },
  { id: '02-notice-dismissed', label: 'Workspace after dismissing the notice', click: 'button:has-text("Continue")' },
  { id: '03-empty-session', label: 'New session / empty state' },
  { id: '04-focus-composer', label: 'Focus the composer', focus: '#root textarea, #root [contenteditable="true"]' },
  { id: '05-composer-typed', label: 'Composer with draft text', type: 'Hello from the reference capture harness' },
  { id: '06-mode-menu', label: 'Open the permission-mode menu', click: 'button:has-text("Workspace Write")' },
  { id: '07-mode-dismiss', label: 'Dismiss the mode menu', press: 'Escape' },
  { id: '08-model-picker', label: 'Open the model picker', click: ':has-text("DeepSeek-V41-Flash")' },
  { id: '09-model-dismiss', label: 'Dismiss the model picker', press: 'Escape' },
  { id: '10-plugins-page', label: 'Plugins page', click: 'button:has-text("Plugins"), a:has-text("Plugins")' },
  { id: '11-sidebar-new-session', label: 'Back to a new session', click: 'button:has-text("New Session")' },
  { id: '12-settings-open', label: 'Settings surface', click: 'button:has-text("Settings"), a:has-text("Settings")' },
  { id: '13-settings-dismiss', label: 'Close Settings', press: 'Escape' },
  { id: '14-sidebar-toggle', label: 'Toggle the sidebar', press: 'Control+B' },
  { id: '15-sidebar-restore', label: 'Restore the sidebar', press: 'Control+B' },
  { id: '16-command-palette', label: 'Command palette / slash command hint', press: 'Control+K' },
  { id: '17-palette-dismiss', label: 'Dismiss the palette', press: 'Escape' },
  { id: '18-shortcut-hint', label: 'New Session shortcut (Ctrl+Alt+N)', press: 'Control+Alt+N' },
]

async function captureOne(browser, viewport, theme, outDir) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dsf,
    colorScheme: theme,
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'Asia/Shanghai',
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  const trace = []
  await mkdir(outDir, { recursive: true })

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  for (const step of SEQUENCE) {
    try {
      if (step.click) {
        const el = page.locator(step.click).first()
        if (await el.count()) await el.click({ timeout: 2500 })
      }
      if (step.focus) {
        const el = page.locator(step.focus).first()
        if (await el.count()) await el.focus({ timeout: 2000 })
      }
      if (step.type) await page.keyboard.type(step.type, { delay: 12 })
      if (step.press) await page.keyboard.press(step.press)
    } catch (error) {
      trace.push({ step: step.id, actionError: String(error) })
    }
    await page.waitForTimeout(900)
    await page.screenshot({ path: resolve(outDir, `${step.id}.png`), fullPage: false })
    const dom = await page.evaluate(() => ({
      title: document.title,
      lang: document.documentElement.lang,
      textSample: document.body.innerText.slice(0, 1500),
      landmarkCount: document.querySelectorAll('[role],button,a,input,textarea,[contenteditable]').length,
      fonts: [...new Set([...document.fonts].map((f) => `${f.family} ${f.weight} ${f.style}`))].sort(),
    }))
    trace.push({ step: step.id, label: step.label, dom })
  }
  await writeFile(resolve(outDir, 'trace.json'), JSON.stringify({ viewport, theme, baseUrl, trace, consoleErrors }, null, 2))
  await writeFile(resolve(outDir, 'dom-snapshot.html'), await page.content())
  await context.close()
  return { viewport: viewport.id, theme, consoleErrors: consoleErrors.length }
}

const browser = await chromium.launch()
// Evidence integrity: a capture run must own its whole output tree, so frames
// from an earlier sequence can never be mistaken for this run's states.
await rm(outRoot, { recursive: true, force: true })
const results = []
for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    const outDir = resolve(outRoot, viewport.id, theme)
    results.push(await captureOne(browser, viewport, theme, outDir))
    // eslint-disable-next-line no-console
    console.log(`captured ${viewport.id}/${theme}`)
  }
}
await browser.close()
await writeFile(resolve(outRoot, 'index.json'), JSON.stringify({ capturedAt: new Date().toISOString(), baseUrl, results }, null, 2))
// eslint-disable-next-line no-console
console.log(JSON.stringify(results, null, 2))
