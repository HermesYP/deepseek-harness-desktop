/**
 * The Updates plugin's advertised identity (lane V).
 *
 * WHY THIS EXISTS: `verify-chrome-and-updates.mjs` decided "the Updates section
 * is in Settings" by running `/Updates/i` over `document.body.innerText`. That is
 * true of any page that merely *mentions* the word — including the Plugins list,
 * an error banner, or the section's own nav label rendered while its content
 * failed to mount. It never checked the exact URL the Host advertises for the
 * plugin, nor that the plugin's browser module actually applied, nor that the
 * section rendered. The gate could therefore pass with no Updates plugin at all.
 *
 * This module states the exact entry identity the Host must advertise and the
 * observable facts that prove the module applied and the section rendered.
 */

/** The package id of the port-owned Updates client plugin. */
export const PLUGIN_ID = '@dsh-port/dsh-client-ui-updates'

/** The row id the desktop bundle patch inserts. */
export const PLUGIN_ROW_ID = 'dsh-port-ui-updates'

/** The bundle layer that inserts the row and disables the account surface. */
export const BUNDLE_ID = '@dsh-port/dsh-desktop-updates-bundle'

/**
 * The upstream package the port deliberately disables.
 *
 * The port replaces its launcher (which owns the signed-out "Contact us" and
 * "Sign in" rows) with one that keeps only Settings, which is also the surface
 * carrying the Updates section.
 */
export const DISABLED_ID = '@deepseek-ai/dsh-client-ui-settings-account'

/** The locale namespace the plugin registers its copy under. */
export const LOCALE_NAMESPACE = 'settings.updates'

/** The two Settings slots the plugin must register into. */
export const SETTINGS_SLOTS = ['settings.section', 'settings.launcher']

/** The nav id the section registers under. */
export const SECTION_ID = 'updates'

/** The stable class/id marker the launcher button carries for identification. */
export const SETTINGS_LAUNCHER_MENU_LABELS = ['More', 'More menu']

/** The settings store key holding the selected release channel. */
export const CHANNEL_KEY = 'updates.channel'

/** The settings store keys holding the per-channel feed URLs. */
export const FEED_KEYS = { stable: 'updates.feed-url', beta: 'updates.feed-url-beta' }

/**
 * Build the combo row URL the Host advertises for one or more plugin ids.
 *
 * The doubled `??` and the query-position specifier are upstream's own format
 * (`comboSearch()`/`comboUrl()` emit `plugins/??<spec>&rev=<rev>`), and the
 * `rev` is the resource revision advertised by its entry or batch descriptor,
 * not the whole graph revision. A wrong resource revision answers 404.
 *
 * @param {string[]} ids Plugin package ids to combine.
 * @param {string} rev The advertised resource revision.
 * @returns {string} The relative row URL.
 */
export function comboRowUrl(ids, rev) {
  if (typeof rev !== 'string' || rev.trim() === '') {
    throw new Error('comboRowUrl: an advertised resource revision is required; a guessed revision can only produce a misleading 404')
  }
  return `plugins/??${ids.map(id => `${id}/client.js`).join(',')}&rev=${encodeURIComponent(rev)}`
}

/**
 * Select the exact advertised Updates resource without borrowing graph/batch revisions.
 * Invalid or cross-origin rows are never request targets.
 * @param {object} graph Boot graph received by the browser.
 * @param {string} documentUrl Application document URL.
 * @returns {object} Entry/batch evidence, URL comparison and safe request target.
 */
export function decideUpdatesResource(graph, documentUrl) {
  const entry = graph.entries?.find(row => row.id === PLUGIN_ID)
  const batches = (graph.batches ?? []).filter(batch => Array.isArray(batch.entries) && batch.entries.includes(PLUGIN_ID))
  const validEntryRev = typeof entry?.rev === 'string' && entry.rev.trim() !== ''
  const expectedUrl = validEntryRev ? new URL(comboRowUrl([PLUGIN_ID], entry.rev), documentUrl).href : null
  let advertisedUrl = null
  try {
    if (typeof entry?.url === 'string' && entry.url.trim() !== '') advertisedUrl = new URL(entry.url, documentUrl).href
  } catch { /* Malformed advertised URLs remain invalid evidence, not thrown requests. */ }
  const urlMatches = advertisedUrl !== null && advertisedUrl === expectedUrl
  const sameOrigin = advertisedUrl !== null && new URL(advertisedUrl).origin === new URL(documentUrl).origin
  return { entry, batches, validEntryRev, expectedUrl, advertisedUrl, urlMatches,
    requestUrl: urlMatches && sameOrigin ? advertisedUrl : null }
}

/**
 * Classify an HTTP artifact response without claiming browser execution.
 * @param {{status: number, contentType: string, body: string}} response Observed HTTP response.
 * @returns {{servedJavaScript: boolean, mentionsPluginId: boolean, artifactAccepted: boolean}} Artifact-only evidence.
 */
export function classifyUpdatesArtifact({ status, contentType, body }) {
  const mime = contentType.split(';', 1)[0].trim().toLowerCase()
  const servedJavaScript = status === 200 && /^(text|application)\/(javascript|ecmascript)$/u.test(mime)
  const mentionsPluginId = body.includes(PLUGIN_ID)
  return { servedJavaScript, mentionsPluginId, artifactAccepted: servedJavaScript && mentionsPluginId }
}

/**
 * The affirmatives the section's own locale namespace supplies.
 *
 * These are matched against section-local rendered text, alongside selected
 * navigation and controls. Text alone does not establish module execution.
 */
export const SECTION_MARKERS = {
  releaseChannel: /Release channel/u,
  currentVersion: /Current version/u,
  check: /Check for updates/u,
  securityNote: /SHA-256/u,
}

/**
 * Classify whether the rendered Settings panel contains the Updates section.
 *
 * @param {object} facts Facts read from the live Settings panel.
 * @param {string|null} facts.sectionText Text of the rendered section element.
 * @param {string|null} facts.navLabel Text of the section's nav entry.
 * @param {boolean} facts.navEntryPresent The section's nav entry is rendered.
 * @param {boolean} facts.navSelected The actual Updates nav button is selected.
 * @returns {{rendered: boolean, matched: string[], missing: string[], reasons: string[]}}
 */
export function classifyUpdatesSection(facts) {
  const matched = []
  const missing = []
  const reasons = []
  const text = facts.sectionText ?? ''
  for (const [name, pattern] of Object.entries(SECTION_MARKERS)) {
    if (pattern.test(text)) matched.push(name)
    else missing.push(name)
  }
  if (!facts.navEntryPresent) reasons.push('the Updates nav entry is not rendered in the Settings navigation')
  if (facts.navSelected !== true) reasons.push('the Updates navigation button is not selected')
  if (text === '') reasons.push('the section content element is absent or empty')
  for (const name of missing) reasons.push(`the rendered section text is missing the "${name}" marker`)
  return { rendered: reasons.length === 0, matched, missing, reasons }
}
