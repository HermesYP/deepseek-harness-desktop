/**
 * Reference capture harness for the port's parity work.
 *
 * Drives the ORIGINAL DeepSeek Harness web application through Playwright and
 * captures application-content screenshots (never desktop screenshots) at a
 * fixed viewport, plus an interaction trace. Run against a live `dsh web`.
 *
 * Usage:
 *   node scripts/capture-reference.mjs --url <base> --out <dir> [--kind <kind>]
 *
 * FAILING HONESTLY: this harness used to `if (await el.count())` around every
 * click, so a renamed or missing control silently stopped being exercised while
 * the step still reported a clean capture. It also never checked WHICH page it
 * had captured, and any action error was recorded and then ignored downstream.
 * Now:
 *   - a required step whose action cannot be performed records `action-error`
 *     and the process exits nonzero;
 *   - a step that must reach a surface (settings, plugins) asserts the observed
 *     surface and fails when it is somewhere else;
 *   - the run identity (viewport, theme, locale, host kind, artifact revision)
 *     is written into `index.json` and each `trace.json`, because two capture
 *     trees may only be compared when their identities match;
 *   - zero captures is a failure.
 *
 * `--kind` records what is being captured (`reference-web`, `port-webview`, ...)
 * so a report cannot present a plain-browser capture as native desktop evidence.
 *
 * Owned by: parity lane V.
 */
import { createRequire } from 'node:module'
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Verdict, usageError, hashFile } from '../port/tests/helpers/verdict.mjs'
import { SEQUENCE, indexSteps } from '../port/tests/helpers/capture-sequence.mjs'
import { classifyHost, assertNotLiveGui } from '../port/tests/helpers/host-identity.mjs'

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

/** Capture identity applied to every context, and asserted by the comparison. */
export const CAPTURE_LOCALE = 'en-US'
export const CAPTURE_TIMEZONE = 'Asia/Shanghai'

/**
 * Default backend. Deliberately NOT the live GUI port: the live Harness GUI owns
 * 3080 and must never be driven by a gate. Pass --url explicitly for a real run.
 */
const baseUrl = arg('url', 'http://127.0.0.1:3085')
const outRoot = resolve(arg('out', 'port/.scratch/capture'))
const kind = arg('kind', 'reference-web')
const version = arg('version', 'unknown')

assertNotLiveGui(baseUrl)

/** Read the page identity a step must be able to observe. */
const READ_PAGE = () => {
  const text = document.body.innerText
  // The Settings panel is a dialog owned by the settings shell; the Plugins page
  // is a panel row. Both are distinguishable by role rather than by styling.
  const dialog = document.querySelector('[role="dialog"]')
  const dialogLabel = dialog?.getAttribute('aria-label') ?? dialog?.textContent?.slice(0, 120) ?? ''
  const pluginsRow = [...document.querySelectorAll('#root button,#root a')]
    .some(el => el.getAttribute('aria-label') === 'Plugins')
  return {
    title: document.title,
    lang: document.documentElement.lang,
    platformMarker: document.documentElement.dataset.platform ?? null,
    settingsOpen: dialog !== null && /\bsettings\b/iu.test(dialogLabel),
    pluginsVisible: pluginsRow,
    surface: dialog !== null && /\bsettings\b/iu.test(dialogLabel)
      ? 'settings'
      : (text.includes('Plugins') && !text.includes('New Session') ? 'plugins' : 'app'),
    hasComposer: /Describe what you want to build|Message or run a task/u.test(text),
  }
}

/** Read the deterministic DOM facts compared for state parity. */
const READ_DOM = () => ({
  title: document.title,
  lang: document.documentElement.lang,
  textSample: document.body.innerText.slice(0, 1500),
  landmarkCount: document.querySelectorAll('[role],button,a,input,textarea,[contenteditable]').length,
  fonts: [...new Set([...document.fonts].map(f => `${f.family} ${f.weight} ${f.style}`))].sort(),
})

/**
 * Resolve the first selector in a list that matches at least one element.
 *
 * @param {import('playwright').Page} page The page under capture.
 * @param {string[]} selectors Candidate selectors, most specific first.
 * @returns {Promise<{locator: object, selector: string}|null>} The match, or null.
 */
async function firstMatch(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first()
    if (await locator.count() > 0) return { locator, selector }
  }
  return null
}

/**
 * Capture one viewport/theme combination.
 *
 * @returns {Promise<{records: object[], consoleErrors: string[], identity: object}>}
 */
async function captureOne(browser, viewport, theme) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dsf,
    colorScheme: theme,
    reducedMotion: 'reduce',
    locale: CAPTURE_LOCALE,
    timezoneId: CAPTURE_TIMEZONE,
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()) })
  page.on('pageerror', e => consoleErrors.push(`pageerror: ${e.message}`))

  const outDir = resolve(outRoot, viewport.id, theme)
  await mkdir(outDir, { recursive: true })

  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  // Boot is asynchronous: host authentication, index-injection application and
  // plugin activation all precede a usable workspace. Give the client a bounded
  // chance to render before step 00 rather than screenshotting the boot gate.
  await page.waitForFunction(
    () => (document.querySelector('#root')?.childElementCount ?? 0) > 0,
    undefined,
    { timeout: 45_000 },
  ).catch(() => undefined)
  await page.waitForTimeout(2500)

  const records = []
  for (const step of SEQUENCE) {
    const required = step.optional !== true
    let actionError

    try {
      if (step.click) {
        const match = await firstMatch(page, step.click)
        if (match === null) {
          // A required action that matches nothing is a FAILURE. The old
          // `if (await el.count())` skipped it and reported a clean capture.
          if (required) actionError = `no element matched any of: ${step.click.join(' | ')}`
        } else {
          await match.locator.click({ timeout: 5000, trial: false })
        }
      }
      if (step.focus) {
        const match = await firstMatch(page, step.focus)
        if (match === null) {
          if (required) actionError = `no focusable element matched any of: ${step.focus.join(' | ')}`
        } else {
          await match.locator.focus({ timeout: 4000 })
        }
      }
      if (step.type && actionError === undefined) await page.keyboard.type(step.type, { delay: 12 })
      if (step.press && actionError === undefined) await page.keyboard.press(step.press)
    } catch (error) {
      actionError = String(error).split('\n').slice(0, 8).join('\n')
    }

    await page.waitForTimeout(900)
    const pageState = await page.evaluate(READ_PAGE)

    // A step that claims to reach a surface must actually be on it. Without this
    // the harness happily captured the workspace for both "12-settings-open" and
    // "13-settings-dismiss", so a broken Settings route looked like parity.
    if (actionError === undefined && step.expectedPage !== undefined) {
      const observed = pageState.surface
      const expected = step.expectedPage
      const satisfied = expected === 'app'
        ? observed !== 'settings'
        : observed === expected
      if (!satisfied) {
        actionError = `expected surface "${expected}" but observed "${observed}" (title ${JSON.stringify(pageState.title)})`
      }
    }

    await page.screenshot({ path: resolve(outDir, `${step.id}.png`), fullPage: false })

    if (actionError !== undefined) {
      records.push({ step: step.id, label: step.label, actionError, page: pageState })
    } else if (step.optional === true && step.click !== undefined) {
      // An optional action that found nothing: recorded as not-applicable so the
      // comparison can SEE that it was not exercised, instead of it silently
      // looking like a successful state capture.
      records.push({ step: step.id, label: step.label, notApplicable: true, dom: await page.evaluate(READ_DOM), page: pageState })
    } else {
      records.push({ step: step.id, label: step.label, dom: await page.evaluate(READ_DOM), page: pageState })
    }
  }

  const hostFacts = await page.evaluate(() => ({
    hasTauriInternals: '__TAURI_INTERNALS__' in globalThis,
    hasDesktopBoot: typeof globalThis.dshDesktopBoot === 'object' && globalThis.dshDesktopBoot !== null,
    hasDesktopMarker: 'dshDesktop' in globalThis,
    hasHostPaths: '__DSH_HOST_PATHS__' in globalThis,
    platformMarker: document.documentElement.dataset.platform ?? null,
    userAgent: navigator.userAgent,
  }))
  const host = classifyHost(hostFacts)

  const identity = {
    viewport: viewport.id,
    theme,
    baseUrl,
    locale: CAPTURE_LOCALE,
    timezoneId: CAPTURE_TIMEZONE,
    deviceScaleFactor: viewport.dsf,
    capturedWith: `capture-reference.mjs/${kind}`,
    hostKind: host.kind,
    appVersion: version,
    graphRevision: null,
  }

  await writeFile(
    resolve(outDir, 'trace.json'),
    JSON.stringify({ identity, host: { ...host, facts: hostFacts }, viewport, theme, baseUrl, trace: records, consoleErrors }, null, 2),
  )
  await writeFile(resolve(outDir, 'dom-snapshot.html'), await page.content())
  await context.close()
  return { records, consoleErrors, identity }
}

const verdict = new Verdict(`reference capture (${kind})`)
console.log(`capturing ${baseUrl} as ${kind}`)

const browser = await chromium.launch()
// Evidence integrity: a capture run must own its whole output tree, so frames
// from an earlier sequence can never be mistaken for this run's states.
await rm(outRoot, { recursive: true, force: true })

const results = []
let totalRecords = 0
for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    const { records, consoleErrors, identity } = await captureOne(browser, viewport, theme)
    totalRecords += records.length
    const failures = records.filter(r => r.actionError !== undefined)
    const skipped = records.filter(r => r.notApplicable === true)
    results.push({
      viewport: viewport.id,
      theme,
      identity,
      steps: records.length,
      actionErrors: failures.length,
      notApplicable: skipped.length,
      consoleErrors: consoleErrors.length,
    })
    console.log(`captured ${viewport.id}/${theme}: ${records.length} steps, ${failures.length} action error(s), ${consoleErrors.length} console error(s)`)

    verdict.record(
      `${viewport.id}/${theme}: every required action was performed`,
      failures.length === 0 ? 'PASS' : 'FAIL',
      failures.length === 0
        ? `${records.length} steps recorded (${skipped.length} not-applicable)`
        : `${failures.length} step(s) failed: ${failures.map(f => f.step).join(', ')}`,
    )
    verdict.record(
      `${viewport.id}/${theme}: no console errors during capture`,
      consoleErrors.length === 0 ? 'PASS' : 'FAIL',
      consoleErrors.length === 0 ? undefined : `${consoleErrors.length}: ${consoleErrors[0].slice(0, 160)}`,
    )
  }
}
await browser.close()

verdict.assert(totalRecords > 0, 'the run produced captures', `${totalRecords} step record(s)`)

await writeFile(resolve(outRoot, 'index.json'), JSON.stringify({
  capturedAt: new Date().toISOString(),
  baseUrl,
  kind,
  stepsPerTheme: SEQUENCE.length,
  results,
}, null, 2))

// Per-frame digests, so a later comparison can prove WHICH bytes it compared
// rather than trusting a path that may have been overwritten since.
const digests = {}
for (const result of results) {
  for (const step of SEQUENCE) {
    const path = resolve(outRoot, result.viewport, result.theme, `${step.id}.png`)
    digests[`${result.viewport}/${result.theme}/${step.id}`] = await hashFile(path)
  }
}
await writeFile(resolve(outRoot, 'digests.json'), JSON.stringify({ kind, digests }, null, 2))

verdict.finish()
