/**
 * Host identity for parity and desktop gates (lane V).
 *
 * WHY THIS EXISTS: the desktop gates attach over CDP. A Chromium instance
 * launched with `--remote-debugging-port` and a Tauri WebView2 instance expose
 * the SAME protocol, so a probe cannot tell from the endpoint alone whether it
 * is looking at the installed native application or at a plain browser that
 * happens to serve the same page. The old scripts named this risk in prose and
 * then accepted either, which means a "native proof" could have been produced
 * against a headless Chromium and nobody would have known from the evidence.
 *
 * This module makes the distinction a recorded, asserted fact. A gate that
 * claims native behavior must observe the native markers; a gate that only had a
 * browser available records `chromium-probe` and must not be reported as native
 * desktop evidence.
 */

import { posix, win32 } from 'node:path'

/** The native Tauri/WebView2 host. */
export const NATIVE_WEBVIEW = 'native-webview2'

/** A plain Chromium/Playwright browser, which is NOT native desktop. */
export const CHROMIUM_PROBE = 'chromium-probe'

/** No host was attached. */
export const NONE = 'none'

/**
 * Classify an attached page's host from facts it can actually observe.
 *
 * The markers are the ones the port's own page-side code sets: the Tauri IPC
 * bridge global, the desktop boot/marker globals the shell injects, and the
 * platform dataset attribute the preserved client stamps on the document root.
 * A plain browser has none of them, because Tauri IPC only exists inside the
 * Tauri webview.
 *
 * @param {object} facts Facts read from the page.
 * @param {boolean} [facts.hasTauriInternals] `__TAURI_INTERNALS__` is present.
 * @param {boolean} [facts.hasDesktopBoot] `dshDesktopBoot` is present.
 * @param {boolean} [facts.hasDesktopMarker] `dshDesktop` is present.
 * @param {boolean} [facts.hasHostPaths] `__DSH_HOST_PATHS__` is present.
 * @param {string|null} [facts.platformMarker] `documentElement.dataset.platform`.
 * @param {string|null} [facts.userAgent] `navigator.userAgent`.
 * @returns {{kind: string, evidence: string[]}} The classification and why.
 */
export function classifyHost(facts) {
  const evidence = []
  if (facts.hasTauriInternals === true) evidence.push('__TAURI_INTERNALS__')
  if (facts.hasDesktopBoot === true) evidence.push('dshDesktopBoot')
  if (facts.hasDesktopMarker === true) evidence.push('dshDesktop')
  if (facts.hasHostPaths === true) evidence.push('__DSH_HOST_PATHS__')
  if (typeof facts.platformMarker === 'string' && facts.platformMarker.length > 0) {
    evidence.push(`data-platform=${facts.platformMarker}`)
  }
  // Product markers and data-platform also exist in browser-mounted fixtures.
  // Only the native transport together with the composed desktop boot/bridge
  // qualifies this heuristic. Process ownership must still be recorded by the
  // launcher; renderer globals alone are not a cryptographic host attestation.
  if (facts.hasTauriInternals === true && facts.hasDesktopBoot === true
      && facts.hasDesktopMarker === true && facts.hasHostPaths === true) {
    return { kind: NATIVE_WEBVIEW, evidence }
  }
  const ua = facts.userAgent ?? ''
  return {
    kind: CHROMIUM_PROBE,
    evidence: [ua.includes('Edg/') ? 'user-agent carries Edg/ but no Tauri or desktop markers' : 'no native markers observed'],
  }
}

/**
 * Assert that an observation is admissible as native desktop evidence.
 *
 * @param {object} facts Same facts as classifyHost.
 * @param {object} verdict A Verdict instance from helpers/verdict.mjs.
 * @param {string} label Check name to record.
 * @returns {{kind: string, evidence: string[]}} The classification.
 */
export function assertNativeHost(facts, verdict, label) {
  const classification = classifyHost(facts)
  verdict.assert(
    classification.kind === NATIVE_WEBVIEW,
    label,
    `${classification.kind} (${classification.evidence.join(', ')})`,
  )
  return classification
}

/**
 * Fail a gate with a usage error: exit 2, no stack trace.
 *
 * A refusal is not a crash. The gate was configured with a target these gates
 * must never drive (the live GUI, a non-loopback host, a non-isolated home), so
 * the run ends before it touches anything, with the reason printed plainly.
 *
 * @param {string} message The refusal to report.
 * @returns {never} Always exits.
 */
export function refuse(message) {
  console.error(`REFUSED: ${message}`)
  process.exit(2)
}

/**
 * The advertised backend port must never be the live GUI port.
 *
 * The live Harness GUI owns 3080 and must not be driven, restarted or probed by
 * these gates; a run that resolves to it is a configuration error, not a test.
 *
 * @param {string} base URL under test.
 * @param {number[]} forbidden Ports that must never be targeted.
 * @returns {URL} The parsed, accepted URL.
 */
export function assertNotLiveGui(base, forbidden = [3080]) {
  let url
  try {
    url = new URL(base)
  } catch {
    refuse(`the target URL is not parseable: ${base}`)
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (forbidden.includes(port)) {
    refuse(`refusing to run against port ${port}: that is the live Harness GUI. Use an isolated port in the 3085+ range.`)
  }
  const host = url.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    refuse(`refusing to run against non-loopback host ${host}: these gates only drive isolated local instances.`)
  }
  return url
}

/**
 * Refuse to run against the live Harness home.
 *
 * @param {string|undefined} home The DSH_HOME the run would use.
 * @param {string} scratchRoot The workspace scratch root isolated homes live under.
 * @returns {void}
 */
export function assertIsolatedHome(home, scratchRoot) {
  if (typeof home !== 'string' || home.trim() === '') {
    refuse('refusing to run with an unset DSH_HOME: these gates require an explicitly isolated home.')
  }
  // Resolve dot segments and require a directory boundary, not a string prefix:
  // .scratch-escape and .scratch/../live are not descendants of .scratch.
  const pathApi = /^[A-Za-z]:[\\/]/u.test(scratchRoot) ? win32 : posix
  const normalize = value => pathApi.resolve(value).replace(/[\\/]+$/u, '').toLowerCase()
  const target = normalize(home)
  const root = normalize(scratchRoot)
  if (!pathApi.isAbsolute(home) || !target.startsWith(`${root}${pathApi.sep}`)) {
    refuse(`refusing to use DSH_HOME ${home}: it is outside the isolated scratch root ${scratchRoot}. The live home %USERPROFILE%\\.dsh must never be touched by these gates.`)
  }
}
