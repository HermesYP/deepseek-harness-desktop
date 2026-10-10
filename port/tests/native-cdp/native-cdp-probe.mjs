#!/usr/bin/env node
/**
 * native-cdp-probe.mjs — PROVISIONAL, repeatable, DEBUG-scope CDP observation probe.
 *
 * WHAT THIS IS
 *   A single-file Node 22 probe (built-in `fetch` + built-in global `WebSocket`,
 *   NO installed dependencies, no package.json, no imports from the repository)
 *   that attaches to an ALREADY RUNNING debug desktop webview over CDP and
 *   performs one bounded, read-mostly battery of native renderer commands
 *   through `window.__TAURI_INTERNALS__.invoke`, plus one independent HTTP
 *   observation of the served shell document's CSP response header.
 *
 * WHAT THIS IS NOT
 *   * NOT native acceptance. See `nativeAcceptance: false` and `notEstablished`
 *     in the emitted record. The probe cannot attribute the CDP endpoint, the
 *     page, the runtime process, or the keyring to any child process. The
 *     parent must prove child PID / profile / image / namespace separately.
 *   * NOT a launcher. It never starts, stops, hides, or quits anything, never
 *     runs cargo/rustc, never touches the live GUI on port 3080, and never
 *     reads a credential, a tokenized URL, a cookie, or a secret value.
 *   * NOT a credential test. The only credential mutation attempted is against
 *     the SHELL-RESERVED identity (`client-connection` / `browser-session`),
 *     which the Rust surface rejects before any OS store call, and it uses a
 *     fixed dummy non-secret value that is never logged or projected.
 *
 * HARD BOUNDS (all configurable, all defaulted, all refused if out of range)
 *   --http-timeout-ms      every HTTP request (target discovery, CSP fetch)
 *   --command-timeout-ms   every CDP command
 *   --total-timeout-ms     one numeric-exit watchdog over the whole run
 *   --attach-wait-ms       bounded retry window for unique exact-origin attach
 *   --restart-timeout-ms   bounded wait for the optional single runtime_restart
 *   --refresh-attempts / --refresh-interval-ms  bounded target-refresh retries
 *   Exit codes: 0 pass, 1 failed check, 2 refused argument, 3 no Tauri bridge,
 *   4 target selection failed, 5 watchdog, 6 internal error.
 *
 * OUTPUT
 *   stdout: exactly one redacted JSON record (this is the return value).
 *   stderr: human narration, also redacted.
 *   --report <path>: the same record written to disk.
 *   Every record passes `assertNoSecrets` before it is printed or written; a
 *   leak fails closed with exit 2 and prints only the offending key path.
 *
 * OWNERSHIP / NAMESPACE
 *   --namespace is a canonical non-nil lowercase hyphenated UUID, validated with
 *   the same rule as `credential_backend.rs::parse_owned_namespace`. It is
 *   recorded as launch CONTEXT only: a UUID never proves process ownership.
 *
 * Owned by: repair lane, parent session-756ae889-6ce1-49f8-8f1f-e0f134568dc6.
 * Provisional scratch artifact; no production, source, or test file is touched.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// Constants fixed by the port's contract (read from source, not guessed)
// ---------------------------------------------------------------------------

/** The live Harness GUI port. Never targeted, never probed, never replaced. */
export const LIVE_GUI_PORT = 3080

/** `dsh_core::protocol::PROTOCOL_GENERATION` (dsh-core/src/protocol.rs:767). */
export const PROTOCOL_GENERATION = 4

/** The ONLY credential identity this probe may attempt to mutate. */
export const RESERVED_CREDENTIAL = Object.freeze({
  provider: 'client-connection',
  reference: 'browser-session',
})

/** Fixed, non-secret dummy. Never logged, never projected, never a real secret. */
export const DUMMY_NON_SECRET = 'probe-dummy-non-secret-value'

/** `DesktopUpdatePhase` (protocol.rs:386-394). */
export const UPDATE_PHASES = Object.freeze([
  'idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'ready', 'error',
])

/** Commands this probe may ever invoke; `runtime_restart` only behind its flag. */
export const ALLOWED_COMMANDS = Object.freeze([
  'shell_app_info',
  'runtime_status',
  'update_status',
  'credential_list',
  'credential_has',
  'credential_store',
  'credential_delete',
])

/** Commands/domains that must never appear in an observed invocation list. */
export const FORBIDDEN_COMMANDS = Object.freeze([
  'runtime_quit_inspection', 'runtime_boot_ready', 'runtime_boot_failed',
  'shell_quit_request', 'shell_close_window', 'shell_window_chrome_action',
  'shell_window_set_fullscreen', 'shell_window_resize_dragging',
  'shell_window_toggle_devtools', 'shell_open_external', 'shell_clipboard_read',
  'shell_clipboard_write', 'shell_pick_directory', 'shell_host_paths',
  'shell_host_paths_consume', 'shell_menu_action', 'shell_locale_set',
  'shell_locale_apply', 'shell_theme_set', 'shell_onboarding_set_active',
  'settings_get', 'settings_set', 'settings_list', 'settings_reset',
  'update_check', 'update_open',
])

/** CSP directive names the served shell document must carry (gateway lib.rs:178). */
export const REQUIRED_CSP_DIRECTIVES = Object.freeze([
  'default-src', 'script-src', 'connect-src', 'base-uri', 'object-src',
  'form-action', 'frame-ancestors',
])

/** Numeric exit codes. */
export const EXIT = Object.freeze({
  PASS: 0,
  FAILED_CHECK: 1,
  REFUSED: 2,
  BRIDGE_MISSING: 3,
  TARGET_SELECTION: 4,
  WATCHDOG: 5,
  INTERNAL: 6,
})

export const NUMERIC_BOUNDS = Object.freeze({
  'http-timeout-ms': [100, 60000, 5000],
  'command-timeout-ms': [100, 120000, 15000],
  'total-timeout-ms': [1000, 600000, 90000],
  'attach-wait-ms': [0, 120000, 8000],
  'refresh-attempts': [1, 60, 6],
  'refresh-interval-ms': [0, 10000, 500],
  'restart-timeout-ms': [1000, 300000, 45000],
})

// ---------------------------------------------------------------------------
// Typed probe error (never carries page content, values, or expressions)
// ---------------------------------------------------------------------------

export class ProbeError extends Error {
  /**
   * @param {string} code Stable machine code.
   * @param {string} message Human message with no page/credential content.
   */
  constructor(code, message) {
    super(message)
    this.name = 'ProbeError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Pure argument guards and URL canonicalization
// ---------------------------------------------------------------------------

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost'])

/** Strip the brackets a URL parser puts around an IPv6 literal. */
function bareHost(hostname) {
  const lower = String(hostname ?? '').toLowerCase()
  return lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower
}

/**
 * Whether a parsed URL's host is exact loopback. `127.0.0.2`, `0.0.0.0`, and any
 * DNS name other than `localhost` are refused: "exact" is the requirement.
 */
export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(bareHost(hostname))
}

/** Canonical host spelling used for exact origin comparison. */
function canonicalHost(hostname) {
  const bare = bareHost(hostname)
  if (bare === '::1') return '[::1]'
  return bare === 'localhost' ? '127.0.0.1' : bare
}

/** Effective port of a parsed URL (explicit ports only; `''` maps to the default). */
export function effectivePort(url) {
  if (url.port !== '') return Number(url.port)
  return url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80
}

/**
 * Canonical `scheme://host:port` origin, or `null` when unparseable/non-http(s).
 * `localhost` canonicalizes to `127.0.0.1` so the two loopback spellings compare
 * exactly; the canonicalization is recorded in the report.
 */
export function canonicalizeOrigin(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return `${url.protocol}//${canonicalHost(url.hostname)}:${effectivePort(url)}`
}

/**
 * Parse and gate a loopback endpoint URL argument.
 *
 * Refuses: missing/unparseable values, non-loopback hosts, embedded credentials,
 * a query or fragment (a query is where a launch token lives), a path deeper than
 * `/`, a missing explicit port, and port 3080.
 *
 * @param {string} raw The argument value.
 * @param {{label: string}} options Label used in refusal messages.
 * @returns {{raw: string, protocol: string, hostname: string, port: number, origin: string}}
 */
export function parseLoopbackEndpoint(raw, { label }) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new ProbeError('arg_invalid', `${label} is required`)
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ProbeError('arg_invalid', `${label} is not a parseable URL`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProbeError('arg_invalid', `${label} must use http: or https:`)
  }
  if (url.username !== '' || url.password !== '') {
    throw new ProbeError('arg_invalid', `${label} must not carry credentials`)
  }
  if (url.search !== '' || url.hash !== '') {
    throw new ProbeError('arg_invalid', `${label} must not carry a query or fragment`)
  }
  if (url.pathname !== '' && url.pathname !== '/') {
    throw new ProbeError('arg_invalid', `${label} must not carry a path`)
  }
  if (!isLoopbackHost(url.hostname)) {
    throw new ProbeError('arg_invalid', `${label} host must be exact loopback (127.0.0.1, ::1, localhost)`)
  }
  if (url.port === '') {
    throw new ProbeError('arg_invalid', `${label} must name an explicit port`)
  }
  const port = Number(url.port)
  if (port === LIVE_GUI_PORT) {
    throw new ProbeError('arg_invalid', `${label} must not target port ${LIVE_GUI_PORT}: that is the live Harness GUI`)
  }
  return {
    raw,
    protocol: url.protocol,
    hostname: canonicalHost(url.hostname),
    port,
    origin: `${url.protocol}//${canonicalHost(url.hostname)}:${port}`,
  }
}

/** Same rules as `credential_backend.rs::parse_owned_namespace`. */
export function isCanonicalNonNilUuid(raw) {
  if (typeof raw !== 'string' || raw.length !== 36) return false
  const hyphens = [8, 13, 18, 23]
  for (const index of hyphens) if (raw[index] !== '-') return false
  for (let index = 0; index < 36; index += 1) {
    if (hyphens.includes(index)) continue
    const code = raw.charCodeAt(index)
    const hex = (code >= 48 && code <= 57) || (code >= 97 && code <= 102)
    if (!hex) return false
  }
  return raw !== '00000000-0000-0000-0000-000000000000'
}

/**
 * Parse CLI arguments into a frozen, fully validated configuration.
 * Unknown flags, duplicate flags, and out-of-range numbers are refused.
 */
export function parseArgs(argv) {
  const valueNames = new Set([
    'cdp', 'gateway-origin', 'namespace', 'report',
    ...Object.keys(NUMERIC_BOUNDS),
  ])
  const flagNames = new Set(['runtime-restart', 'allow-new-target-on-restart', 'help'])
  const values = new Map()
  const flags = new Set()

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw new ProbeError('arg_invalid', `unexpected positional argument #${index + 1}`)
    }
    const name = token.slice(2)
    if (flagNames.has(name)) {
      if (flags.has(name)) throw new ProbeError('arg_invalid', `--${name} was supplied twice`)
      flags.add(name)
      continue
    }
    if (!valueNames.has(name)) throw new ProbeError('arg_invalid', `unknown argument --${name}`)
    if (values.has(name)) throw new ProbeError('arg_invalid', `--${name} was supplied twice`)
    const next = argv[index + 1]
    if (typeof next !== 'string' || next.startsWith('--')) {
      throw new ProbeError('arg_invalid', `--${name} requires a value`)
    }
    values.set(name, next)
    index += 1
  }

  if (flags.has('help')) return Object.freeze({ help: true })
  if (argv.length === 0) {
    throw new ProbeError('arg_invalid', 'no arguments; --cdp, --gateway-origin and --namespace are required')
  }

  for (const required of ['cdp', 'gateway-origin', 'namespace']) {
    if (!values.has(required)) throw new ProbeError('arg_invalid', `--${required} is required`)
  }

  const namespace = values.get('namespace')
  if (!isCanonicalNonNilUuid(namespace)) {
    throw new ProbeError(
      'arg_invalid',
      '--namespace must be a canonical, non-nil, lowercase hyphenated UUID (8-4-4-4-12)',
    )
  }

  const bounds = {}
  for (const [name, [min, max, fallback]] of Object.entries(NUMERIC_BOUNDS)) {
    if (!values.has(name)) {
      bounds[name] = fallback
      continue
    }
    const raw = values.get(name)
    if (!/^\d+$/u.test(raw)) throw new ProbeError('arg_invalid', `--${name} must be a non-negative integer`)
    const parsed = Number(raw)
    if (parsed < min || parsed > max) {
      throw new ProbeError('arg_invalid', `--${name} must be within [${min}, ${max}]`)
    }
    bounds[name] = parsed
  }
  if (bounds['total-timeout-ms'] < bounds['command-timeout-ms']) {
    throw new ProbeError('arg_invalid', '--total-timeout-ms must be >= --command-timeout-ms')
  }

  return Object.freeze({
    help: false,
    cdp: Object.freeze(parseLoopbackEndpoint(values.get('cdp'), { label: '--cdp' })),
    gatewayOrigin: Object.freeze(parseLoopbackEndpoint(values.get('gateway-origin'), { label: '--gateway-origin' })),
    namespace,
    reportPath: values.has('report') ? resolve(values.get('report')) : null,
    runtimeRestart: flags.has('runtime-restart'),
    allowNewTargetOnRestart: flags.has('allow-new-target-on-restart'),
    bounds: Object.freeze(bounds),
  })
}

// ---------------------------------------------------------------------------
// Pure CDP target selection (exact owned origin only)
// ---------------------------------------------------------------------------

/** A target is usable only when it is a page with a loopback ws debugger URL. */
export function isUsablePageTarget(target) {
  if (!target || typeof target !== 'object' || target.type !== 'page') return false
  if (typeof target.id !== 'string' || target.id.length === 0) return false
  if (typeof target.url !== 'string') return false
  if (typeof target.webSocketDebuggerUrl !== 'string' || target.webSocketDebuggerUrl === '') return false
  let ws
  try {
    ws = new URL(target.webSocketDebuggerUrl)
  } catch {
    return false
  }
  if (ws.protocol !== 'ws:' && ws.protocol !== 'wss:') return false
  if (!isLoopbackHost(ws.hostname)) return false
  if (ws.port !== '' && Number(ws.port) === LIVE_GUI_PORT) return false
  if (ws.username !== '' || ws.password !== '') return false
  return true
}

/**
 * Select the ONE page target whose document origin is exactly the owned gateway
 * origin. There is no `pages[0]` fallback: zero matches and ambiguous matches
 * both fail closed.
 *
 * @returns {{ok: true, target: object, canonicalOrigin: string}
 *   | {ok: false, code: string, candidates: number, ids: string[]}}
 */
export function selectTarget(targets, canonicalOwnedOrigin) {
  const pages = (Array.isArray(targets) ? targets : []).filter(isUsablePageTarget)
  const matched = pages.filter(target => canonicalizeOrigin(target.url) === canonicalOwnedOrigin)
  if (matched.length === 1) {
    return { ok: true, target: matched[0], canonicalOrigin: canonicalOwnedOrigin }
  }
  return {
    ok: false,
    code: matched.length === 0 ? 'no_target_with_owned_origin' : 'ambiguous_target_with_owned_origin',
    candidates: matched.length,
    ids: matched.slice(0, 4).map(target => String(target.id).slice(0, 24)),
  }
}

/**
 * Bounded tolerance for a target URL refresh during runtime_restart.
 *
 * Mode `same-id`: the SAME target id is re-found and its document origin has
 * changed. Accepted only when the new origin is exact loopback and not the live
 * GUI port. The refreshed origin is recorded and explicitly marked as NOT
 * ownership-re-verified.
 *
 * Mode `new-id` (opt-in, `--allow-new-target-on-restart`): the previous target id
 * is gone and exactly one page target that was absent from the previous snapshot
 * exists, is loopback, not the live GUI port, and not the owned origin.
 *
 * @returns {{ok: boolean, code: string, refreshed?: boolean, target?: object,
 *   canonicalOrigin?: string, mode?: string}}
 */
export function matchRefreshedTarget(targets, previousTargetId, canonicalOwnedOrigin, options = {}) {
  const { allowNewTargetOnRestart = false, previousIds = [] } = options
  const pages = (Array.isArray(targets) ? targets : []).filter(isUsablePageTarget)
  const sameId = pages.filter(target => target.id === previousTargetId)
  if (sameId.length > 1) return { ok: false, code: 'refresh_ambiguous_same_id' }
  if (sameId.length === 1) {
    const target = sameId[0]
    const origin = canonicalizeOrigin(target.url)
    if (origin === null) return { ok: false, code: 'refresh_url_unparseable' }
    if (origin === canonicalOwnedOrigin) {
      return { ok: true, refreshed: false, mode: 'same-id', target, canonicalOrigin: origin }
    }
    const parsed = new URL(target.url)
    if (!isLoopbackHost(parsed.hostname)) return { ok: false, code: 'refresh_non_loopback' }
    if (effectivePort(parsed) === LIVE_GUI_PORT) return { ok: false, code: 'refresh_live_gui' }
    return { ok: true, refreshed: true, mode: 'same-id', target, canonicalOrigin: origin }
  }
  if (!allowNewTargetOnRestart) return { ok: false, code: 'refresh_target_missing' }
  const known = new Set(previousIds)
  const appeared = pages.filter(target => !known.has(target.id))
  if (appeared.length !== 1) return { ok: false, code: 'refresh_new_id_ambiguous', candidates: appeared.length }
  const target = appeared[0]
  const parsed = new URL(target.url)
  if (!isLoopbackHost(parsed.hostname)) return { ok: false, code: 'refresh_non_loopback' }
  if (effectivePort(parsed) === LIVE_GUI_PORT) return { ok: false, code: 'refresh_live_gui' }
  const origin = canonicalizeOrigin(target.url)
  if (origin === null) return { ok: false, code: 'refresh_url_unparseable' }
  return { ok: true, refreshed: true, mode: 'new-id', target, canonicalOrigin: origin }
}

// ---------------------------------------------------------------------------
// Pure redaction and leak assertions
// ---------------------------------------------------------------------------

/** Forbidden key names in any emitted record. */
const FORBIDDEN_KEY_PATTERN = /(token|secret|password|passphrase|cookie|authorization|bearer|credentialref|^provider$|^reference$|updatedat|websocketdebuggerurl|expression|href|^url$|wsurl|^message$|^last_error$|lastError$)/iu

/**
 * Secret-shaped values: tokenized queries, cookies, provider keys, and
 * HIGH-ENTROPY long runs. The long-run alternative requires a digit inside the
 * run so that word-like identifiers (check ids such as
 * `csp.direct_unauthenticated_refused_without_policy`, which carry no digit)
 * are not mistaken for a base64url launch token. Every real launch token and
 * every hex digest carries digits; a 40+ character token with no digit at all
 * is cryptographically negligible.
 */
const FORBIDDEN_VALUE_PATTERN = /(?:token=|Bearer[\s]|dsh-auth-|sk-[A-Za-z0-9]{12,}|(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,})/u

/**
 * Walk a record and return the paths of anything secret-shaped. Pure; used both
 * as the pre-emit gate and as a unit-tested invariant.
 *
 * @param {unknown} root Value to scan.
 * @param {{allowedStrings?: string[]}} [options] Exact strings that are known-safe
 *   (for example a published interpreter digest).
 * @returns {string[]} Offending paths, e.g. `observations.runtimeStatus.url`.
 */
export function findSecretLikeLeaks(root, { allowedStrings = [] } = {}) {
  const allowed = new Set(allowedStrings)
  const problems = []
  const walk = (value, path) => {
    if (typeof value === 'string') {
      if (allowed.has(value)) return
      if (FORBIDDEN_VALUE_PATTERN.test(value)) problems.push(path)
      return
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`))
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (FORBIDDEN_KEY_PATTERN.test(key)) {
          problems.push(`${path}.${key}`)
          continue
        }
        walk(entry, `${path}.${key}`)
      }
    }
  }
  walk(root, '$')
  return problems
}

/** Narrow an unknown thrown value to a bounded, content-free kind. */
export function boundedErrorKind(error) {
  if (error && typeof error === 'object') {
    if (typeof error.code === 'string' && error.code !== '') return error.code.slice(0, 48)
    if (typeof error.name === 'string' && error.name !== '') return error.name.slice(0, 32)
  }
  return 'error'
}

/**
 * Classify a rejected `invoke` value into the contract taxonomy WITHOUT carrying
 * any message text. `{kind:'other', detail:{code:'credential_reserved', ...}}`
 * reduces to `{rejected:true, kind:'other', codePresent:true, code:'credential_reserved'}`.
 */
export function classifyDshError(error) {
  const classification = { rejected: true, kind: null, codePresent: false, code: null, detailShape: 'none' }
  if (error && typeof error === 'object') {
    if (typeof error.kind === 'string') classification.kind = error.kind.slice(0, 32)
    const detail = error.detail
    if (detail && typeof detail === 'object') {
      classification.detailShape = 'object'
      if (typeof detail.code === 'string') {
        classification.codePresent = true
        classification.code = detail.code.slice(0, 48)
      }
    } else if (typeof error.message === 'string') {
      classification.detailShape = 'message'
    }
  } else if (typeof error === 'string') {
    classification.detailShape = 'string'
  }
  return classification
}

/** Whether an observed invocation list stayed inside the allowed command set. */
export function assertCommandWhitelist(observed, { runtimeRestart = false } = {}) {
  const allowed = new Set(ALLOWED_COMMANDS)
  if (runtimeRestart) allowed.add('runtime_restart')
  const offenders = (Array.isArray(observed) ? observed : []).filter(command => !allowed.has(command))
  const forbidden = (Array.isArray(observed) ? observed : []).filter(command => FORBIDDEN_COMMANDS.includes(command))
  return { ok: offenders.length === 0 && forbidden.length === 0, offenders, forbidden }
}

/** Count distinct readiness epochs from ordered `runtime_status` samples. */
export function deriveReadyGeneration(samples) {
  const digests = []
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (!sample || sample.state !== 'ready') continue
    if (typeof sample.startedAtDigest !== 'string' || sample.startedAtDigest === '') continue
    if (!digests.includes(sample.startedAtDigest)) digests.push(sample.startedAtDigest)
  }
  return {
    readyGenerations: digests.length,
    currentDigest: digests.length > 0 ? digests[digests.length - 1] : null,
    digests,
  }
}

// ---------------------------------------------------------------------------
// Pure check evaluation (tested against constructed observations)
// ---------------------------------------------------------------------------

/**
 * Evaluate the named checks over the collected observations.
 * Pure: takes the record fragment, returns `[{id, ok, detail}]`.
 */
export function evaluateChecks(input) {
  const checks = []
  const push = (id, ok, detail) => checks.push({ id, ok: ok === true, detail: String(detail).slice(0, 160) })
  const facts = input?.pageFacts ?? {}
  const battery = input?.battery ?? {}
  const app = battery.shellAppInfo ?? {}
  const runtime = battery.runtimeStatus ?? {}
  const update = battery.updateStatus ?? {}
  const list = battery.credentialList ?? {}
  const has = battery.credentialHasReserved ?? {}
  const store = battery.credentialStoreReserved ?? {}
  const del = battery.credentialDeleteReserved ?? {}
  const target = input?.target ?? {}
  const direct = input?.csp?.direct ?? {}
  const page = input?.csp?.page ?? {}
  const restart = input?.restart ?? { attempted: false }

  push('bridge.tauri_invoke_present', facts.invokeIsFunction === true, 'window.__TAURI_INTERNALS__.invoke must be a function')
  push('shell_app_info.resolved', app.resolved === true, `resolved=${app.resolved === true}`)
  push('shell_app_info.version_present', app.versionNonEmpty === true, `versionNonEmpty=${app.versionNonEmpty === true}`)
  push('shell_app_info.protocol_generation_4', app.protocolGeneration === PROTOCOL_GENERATION, `protocolGeneration=${app.protocolGeneration}`)
  push('runtime_status.resolved', runtime.resolved === true, `resolved=${runtime.resolved === true}`)
  push('runtime_status.state_ready', runtime.state === 'ready', `state=${runtime.state}`)
  push('runtime_status.no_last_error', runtime.lastErrorPresent === false, `lastErrorPresent=${runtime.lastErrorPresent}`)
  push('update_status.read_only_phase_known', update.resolved === true && update.phaseKnown === true, `phase=${update.phase}`)
  push('credential_list.resolved_and_well_formed', list.resolved === true && list.wellFormed === true, `rows=${list.rowCount}`)
  push('credential_list.hides_reserved_identity', list.reservedPairPresent === false, `reservedPairPresent=${list.reservedPairPresent}`)
  push('credential_has.reserved_answers_false', has.resolved === true && has.present === false, `present=${has.present}`)
  push('credential_store.reserved_rejected', store.rejected === true && store.code === 'credential_reserved', `kind=${store.kind} code=${store.code}`)
  push('credential_delete.reserved_rejected', del.rejected === true && del.code === 'credential_reserved', `kind=${del.kind} code=${del.code}`)
  push('document.origin_is_owned_gateway', input?.documentOriginMatches === true, `originMatches=${input?.documentOriginMatches === true}`)
  push('target.unique_exact_owned_origin', target.selectedByExactOrigin === true, `selectedByExactOrigin=${target.selectedByExactOrigin === true}`)
  push('csp.direct_unauthenticated_refused_without_policy', direct.status === 401 && direct.cspPresent === false, `status=${direct.status ?? null} cspHeader=${direct.cspPresent ?? null}`)
  push('csp.served_header_present', page.status === 200 && page.cspPresent === true, `status=${page.status ?? null} cspHeader=${page.cspPresent ?? null}`)
  const missingDirectives = REQUIRED_CSP_DIRECTIVES.filter(name => !(page.directives ?? []).includes(name))
  push('csp.served_header_carries_required_directives', missingDirectives.length === 0, missingDirectives.length === 0 ? 'all required directive names present' : `missing=${missingDirectives.join(',')}`)
  const whitelist = input?.commandWhitelist ?? { ok: false }
  push('commands.within_whitelist', whitelist.ok === true, whitelist.ok === true ? 'no forbidden command observed' : `offenders=${(whitelist.offenders ?? []).join(',')}`)
  if (restart.attempted === true) {
    push('runtime_restart.invoked_once', restart.invokedCount === 1, `invokedCount=${restart.invokedCount}`)
    push('runtime_restart.baseline_generation_known', restart.baselineDigestPresent === true, `baselineDigestPresent=${restart.baselineDigestPresent}`)
    push('runtime_restart.new_ready_generation_is_old_plus_one', restart.generationAdvancedByOne === true, `baseline=${restart.baselineGeneration} observed=${restart.observedGeneration}`)
    push('runtime_restart.new_ready_has_no_last_error', restart.newReadyLastErrorPresent === false, `lastErrorPresent=${restart.newReadyLastErrorPresent}`)
  }
  return checks
}

// ---------------------------------------------------------------------------
// Page-side expressions (fixed constants; never logged, never interpolated)
// ---------------------------------------------------------------------------

/** Page facts: bridge presence and the document ORIGIN only (never `href`). */
export const PAGE_FACTS_EXPRESSION = `(() => {
  const internals = globalThis.__TAURI_INTERNALS__;
  const core = globalThis.__TAURI__ && globalThis.__TAURI__.core;
  return {
    record: 'page-facts',
    hasTauriInternals: !!internals,
    invokeIsFunction: !!(internals && typeof internals.invoke === 'function'),
    hasTauriGlobalCoreInvoke: !!(core && typeof core.invoke === 'function'),
    documentOrigin: (typeof location !== 'undefined' && typeof location.origin === 'string') ? location.origin : null
  };
})()`

/**
 * The one native command battery. It resolves NO command if the Tauri bridge is
 * absent, projects ONLY redacted booleans/enums/short digests, and never returns
 * a URL, a provider/reference string, an updated-at timestamp, a secret, or an
 * error message.
 */
export const NATIVE_BATTERY_EXPRESSION = `(async () => {
  const RESERVED_PROVIDER = 'client-connection';
  const RESERVED_REFERENCE = 'browser-session';
  const DUMMY_NON_SECRET = 'probe-dummy-non-secret-value';
  const PHASES = ['idle','checking','available','downloading','verifying','installing','ready','error'];
  const out = {
    record: 'native-battery',
    bridge: false,
    commandsInvoked: [],
    shellAppInfo: null,
    runtimeStatus: null,
    updateStatus: null,
    credentialList: null,
    credentialHasReserved: null,
    credentialStoreReserved: null,
    credentialDeleteReserved: null
  };
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') return out;
  out.bridge = true;
  const invoke = internals.invoke.bind(internals);
  const digest = (value) => {
    if (typeof value !== 'string' || value.length === 0) return null;
    let h = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, '0');
  };
  const classify = (error) => {
    const c = { rejected: true, kind: null, codePresent: false, code: null, detailShape: 'none' };
    if (error && typeof error === 'object') {
      if (typeof error.kind === 'string') c.kind = error.kind.slice(0, 32);
      const detail = error.detail;
      if (detail && typeof detail === 'object') {
        c.detailShape = 'object';
        if (typeof detail.code === 'string') { c.codePresent = true; c.code = detail.code.slice(0, 48); }
      } else if (typeof error.message === 'string') { c.detailShape = 'message'; }
    } else if (typeof error === 'string') { c.detailShape = 'string'; }
    return c;
  };
  const call = async (command, payload) => {
    out.commandsInvoked.push(command);
    try { return { resolved: true, value: await invoke(command, payload), error: null }; }
    catch (error) { return { resolved: false, value: null, error: classify(error) }; }
  };
  const isLoopbackOrigin = (raw) => {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
      const host = new URL(raw).hostname.toLowerCase();
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
    } catch (error) { return null; }
  };
  const errorKind = (outcome) => (outcome.error ? (outcome.error.code || outcome.error.kind || 'rejected') : 'shape');

  const info = await call('shell_app_info');
  out.shellAppInfo = (info.resolved && info.value && typeof info.value === 'object') ? {
    resolved: true,
    versionNonEmpty: typeof info.value.version === 'string' && info.value.version.length > 0 && info.value.version.length <= 64,
    protocolGeneration: Number.isInteger(info.value.protocolGeneration) ? info.value.protocolGeneration : null,
    runtimeVersionNonEmpty: typeof info.value.runtimeVersion === 'string' && info.value.runtimeVersion.length > 0,
    platform: typeof info.value.platform === 'string' ? info.value.platform.slice(0, 16) : null,
    arch: typeof info.value.arch === 'string' ? info.value.arch.slice(0, 16) : null,
    officialReferenceConfigured: info.value.credentialRef !== null && info.value.credentialRef !== undefined
  } : { resolved: false, errorKind: errorKind(info) };

  const runtime = await call('runtime_status');
  out.runtimeStatus = (runtime.resolved && runtime.value && typeof runtime.value === 'object') ? {
    resolved: true,
    state: typeof runtime.value.state === 'string' ? runtime.value.state.slice(0, 16) : null,
    lastErrorPresent: runtime.value.lastError !== null && runtime.value.lastError !== undefined,
    urlPresent: typeof runtime.value.url === 'string' && runtime.value.url.length > 0,
    urlOriginIsLoopback: isLoopbackOrigin(runtime.value.url),
    startedAtDigest: digest(runtime.value.startedAt)
  } : { resolved: false, errorKind: errorKind(runtime) };

  const update = await call('update_status');
  out.updateStatus = (update.resolved && update.value && typeof update.value === 'object') ? {
    resolved: true,
    phase: typeof update.value.phase === 'string' ? update.value.phase.slice(0, 16) : null,
    phaseKnown: typeof update.value.phase === 'string' && PHASES.indexOf(update.value.phase) !== -1,
    versionPresent: update.value.version !== null && update.value.version !== undefined,
    percentPresent: update.value.percent !== null && update.value.percent !== undefined,
    failurePresent: update.value.failure !== null && update.value.failure !== undefined
  } : { resolved: false, errorKind: errorKind(update) };

  const list = await call('credential_list');
  out.credentialList = Array.isArray(list.value) ? {
    resolved: true,
    rowCount: list.value.length,
    reservedPairPresent: list.value.some(function (row) {
      return !!row && row.provider === RESERVED_PROVIDER && row.reference === RESERVED_REFERENCE;
    }),
    wellFormed: list.value.every(function (row) {
      return !!row && typeof row.provider === 'string' && typeof row.reference === 'string' && typeof row.hasSecret === 'boolean';
    }),
    anyCredentialPresent: list.value.some(function (row) { return !!row && row.hasSecret === true; })
  } : { resolved: false, errorKind: errorKind(list) };

  const has = await call('credential_has', { provider: RESERVED_PROVIDER, reference: RESERVED_REFERENCE });
  out.credentialHasReserved = (has.resolved && has.value && typeof has.value === 'object') ? {
    resolved: true,
    present: has.value.present === true
  } : { resolved: false, present: null, errorKind: errorKind(has) };

  const store = await call('credential_store', { provider: RESERVED_PROVIDER, reference: RESERVED_REFERENCE, secret: DUMMY_NON_SECRET });
  out.credentialStoreReserved = store.resolved
    ? { attempted: true, usedFixedDummyValue: true, rejected: false, kind: null, codePresent: false, code: null, detailShape: 'none' }
    : Object.assign({ attempted: true, usedFixedDummyValue: true }, store.error);

  const del = await call('credential_delete', { provider: RESERVED_PROVIDER, reference: RESERVED_REFERENCE });
  out.credentialDeleteReserved = del.resolved
    ? { attempted: true, rejected: false, kind: null, codePresent: false, code: null, detailShape: 'none' }
    : Object.assign({ attempted: true }, del.error);

  return out;
})()`

/** One `runtime_status` sample for the bounded restart wait. */
export const RUNTIME_DIGEST_EXPRESSION = `(async () => {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { record: 'runtime-digest', bridge: false, resolved: false, state: null, lastErrorPresent: null, startedAtDigest: null };
  }
  try {
    const value = await internals.invoke('runtime_status');
    const startedAt = value && typeof value.startedAt === 'string' && value.startedAt.length > 0 ? value.startedAt : null;
    let digest = null;
    if (startedAt) {
      let h = 0x811c9dc5;
      for (let i = 0; i < startedAt.length; i++) { h ^= startedAt.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
      digest = h.toString(16).padStart(8, '0');
    }
    return {
      record: 'runtime-digest',
      bridge: true,
      resolved: true,
      state: typeof value.state === 'string' ? value.state.slice(0, 16) : null,
      lastErrorPresent: value.lastError !== null && value.lastError !== undefined,
      startedAtDigest: digest
    };
  } catch (error) {
    return {
      record: 'runtime-digest', bridge: true, resolved: false, state: null, lastErrorPresent: null, startedAtDigest: null,
      errorKind: (error && typeof error === 'object' && typeof error.kind === 'string') ? error.kind.slice(0, 32) : 'threw'
    };
  }
})()`

/** The single permitted `runtime_restart` invocation (flag-gated). */
export const RESTART_EXPRESSION = `(async () => {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { record: 'runtime-restart', bridge: false, invoked: false, resolved: false, state: null };
  }
  try {
    const value = await internals.invoke('runtime_restart');
    return {
      record: 'runtime-restart', bridge: true, invoked: true, resolved: true,
      state: (value && typeof value.state === 'string') ? value.state.slice(0, 16) : null
    };
  } catch (error) {
    return {
      record: 'runtime-restart', bridge: true, invoked: true, resolved: false, state: null,
      errorKind: (error && typeof error === 'object' && typeof error.kind === 'string') ? error.kind.slice(0, 32) : 'threw'
    };
  }
})()`

/**
 * Same-origin `GET /` from the owned document. The browser attaches the
 * HttpOnly session cookie itself; the probe never reads the cookie, the body,
 * or the response beyond the CSP directive NAMES.
 */
export const CSP_PAGE_EXPRESSION = `(async () => {
  const out = { record: 'csp-page', resolved: false, status: null, cspPresent: false, directives: [], ruleCount: 0, errorKind: null };
  try {
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin', redirect: 'follow' });
    out.status = response.status;
    const value = response.headers.get('content-security-policy');
    if (typeof value === 'string' && value.length > 0) {
      out.cspPresent = true;
      const names = [];
      const rules = value.split(';');
      for (let i = 0; i < rules.length; i++) {
        const parts = rules[i].trim().split(' ').filter(Boolean);
        if (parts.length > 0) {
          const name = parts[0].toLowerCase();
          if (names.indexOf(name) === -1) names.push(name);
        }
      }
      names.sort();
      out.directives = names;
      out.ruleCount = names.length;
    }
    try { if (response.body && typeof response.body.cancel === 'function') await response.body.cancel(); } catch (ignored) {}
    out.resolved = true;
  } catch (error) {
    out.errorKind = (error && typeof error.name === 'string') ? error.name.slice(0, 40) : 'error';
  }
  return out;
})()`

// ---------------------------------------------------------------------------
// Bounded CDP client over the built-in global WebSocket
// ---------------------------------------------------------------------------

/** Bounded CDP connection: id-matched commands, per-command timeout, clean close. */
export class CdpConnection {
  #ws = null
  #pending = new Map()
  #nextId = 1
  #closed = false
  #impl
  #commandTimeoutMs
  #connectTimeoutMs

  constructor(wsUrl, { webSocketImpl = globalThis.WebSocket, commandTimeoutMs = 15000, connectTimeoutMs = 5000 } = {}) {
    this.wsUrl = wsUrl
    this.#impl = webSocketImpl
    this.#commandTimeoutMs = commandTimeoutMs
    this.#connectTimeoutMs = connectTimeoutMs
  }

  /** Open and await the WebSocket handshake, bounded by `connectTimeoutMs`. */
  static async open(wsUrl, options = {}) {
    const connection = new CdpConnection(wsUrl, options)
    await connection.#awaitOpen()
    return connection
  }

  get pendingCount() {
    return this.#pending.size
  }

  get closed() {
    return this.#closed
  }

  async #awaitOpen() {
    if (typeof this.#impl !== 'function') {
      throw new ProbeError('websocket_unavailable', 'this Node runtime exposes no global WebSocket; a Node 22 built-in WebSocket is required')
    }
    await new Promise((resolveOpen, rejectOpen) => {
      let settled = false
      let socket
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { socket?.close() } catch { /* bounded */ }
        rejectOpen(new ProbeError('cdp_connect_timeout', `CDP WebSocket did not open within ${this.#connectTimeoutMs} ms`))
      }, this.#connectTimeoutMs)
      try {
        socket = new this.#impl(this.wsUrl)
      } catch {
        clearTimeout(timer)
        settled = true
        rejectOpen(new ProbeError('cdp_connect_failed', 'CDP WebSocket could not be constructed'))
        return
      }
      this.#ws = socket
      socket.addEventListener('open', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveOpen()
      })
      socket.addEventListener('error', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.#failPending('cdp_connect_error')
        rejectOpen(new ProbeError('cdp_connect_error', 'CDP WebSocket reported an error before opening'))
      })
      socket.addEventListener('message', event => this.#onMessage(event))
      socket.addEventListener('close', () => this.#onClose())
    })
  }

  #onMessage(event) {
    let parsed
    try {
      parsed = JSON.parse(typeof event?.data === 'string' ? event.data : '')
    } catch {
      return
    }
    if (!parsed || typeof parsed.id !== 'number') return
    const entry = this.#pending.get(parsed.id)
    if (!entry) return
    this.#pending.delete(parsed.id)
    clearTimeout(entry.timer)
    if (parsed.error) {
      // Only the numeric/string protocol code is carried; never the message text.
      const code = parsed.error && (parsed.error.code ?? parsed.error.data)
      entry.reject(new ProbeError('cdp_error', `${entry.method} failed with CDP code ${String(code).slice(0, 24)}`))
      return
    }
    entry.resolve(parsed.result)
  }

  #onClose() {
    this.#closed = true
    this.#failPending('cdp_closed')
  }

  #failPending(code) {
    for (const [id, entry] of this.#pending) {
      clearTimeout(entry.timer)
      entry.reject(new ProbeError(code, `${entry.method} aborted: connection closed`))
      this.#pending.delete(id)
    }
  }

  /** Send one CDP command, bounded by the per-command timeout. */
  send(method, params = {}) {
    if (this.#closed) return Promise.reject(new ProbeError('cdp_closed', `${method} refused: connection is closed`))
    const id = this.#nextId
    this.#nextId += 1
    return new Promise((resolveCommand, rejectCommand) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        rejectCommand(new ProbeError('cdp_command_timeout', `${method} exceeded ${this.#commandTimeoutMs} ms`))
      }, this.#commandTimeoutMs)
      this.#pending.set(id, { resolve: resolveCommand, reject: rejectCommand, timer, method })
      try {
        this.#ws.send(JSON.stringify({ id, method, params }))
      } catch {
        clearTimeout(timer)
        this.#pending.delete(id)
        rejectCommand(new ProbeError('cdp_send_failed', `${method} could not be written to the socket`))
      }
    })
  }

  /** Evaluate one fixed expression and return its by-value result. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const response = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: false,
    })
    const details = response?.exceptionDetails
    if (details) {
      const className = details.exception && typeof details.exception.className === 'string'
        ? details.exception.className.slice(0, 32)
        : 'exception'
      throw new ProbeError('cdp_evaluate_threw', `Runtime.evaluate threw ${className} (expression content not read)`)
    }
    const value = response?.result?.value
    if (value === undefined || value === null || typeof value !== 'object') {
      throw new ProbeError('cdp_evaluate_shape', 'Runtime.evaluate returned no by-value object')
    }
    return value
  }

  /** Idempotent bounded close; always safe to call in a `finally`. */
  async close() {
    if (this.#closed) {
      this.#failPending('cdp_closed')
      return
    }
    this.#closed = true
    this.#failPending('cdp_closed')
    const socket = this.#ws
    if (!socket) return
    if (socket.readyState === 3) return
    await new Promise(resolveClose => {
      const timer = setTimeout(resolveClose, 1000)
      try {
        socket.addEventListener('close', () => { clearTimeout(timer); resolveClose() }, { once: true })
      } catch { /* the fake or closed socket may not accept listeners */ }
      try { socket.close() } catch { clearTimeout(timer); resolveClose() }
    })
  }
}

// ---------------------------------------------------------------------------
// Bounded HTTP observations
// ---------------------------------------------------------------------------

/** Bounded `GET {endpoint}/json/list`. */
export async function listTargets(endpointOrigin, httpTimeoutMs) {
  if (typeof globalThis.fetch !== 'function') {
    throw new ProbeError('fetch_unavailable', 'this Node runtime exposes no global fetch')
  }
  const response = await fetch(`${endpointOrigin}/json/list`, {
    signal: AbortSignal.timeout(httpTimeoutMs),
    cache: 'no-store',
    redirect: 'manual',
    headers: { accept: 'application/json' },
  })
  if (!response.ok) throw new ProbeError('cdp_http_status', `CDP target list returned HTTP ${response.status}`)
  const payload = await response.json().catch(() => null)
  if (!Array.isArray(payload)) throw new ProbeError('cdp_http_shape', 'CDP target list was not a JSON array')
  return payload
}

/** Bounded browser product string from `/json/version` (evidence only). */
export async function readBrowserProduct(endpointOrigin, httpTimeoutMs) {
  try {
    const response = await fetch(`${endpointOrigin}/json/version`, {
      signal: AbortSignal.timeout(httpTimeoutMs),
      cache: 'no-store',
      redirect: 'manual',
      headers: { accept: 'application/json' },
    })
    if (!response.ok) return { ok: false, status: response.status, product: null }
    const payload = await response.json().catch(() => null)
    const raw = payload && typeof payload.Browser === 'string' ? payload.Browser : ''
    return { ok: true, status: response.status, product: raw === '' ? null : raw.split('/')[0].slice(0, 32) }
  } catch (error) {
    return { ok: false, status: null, product: null, errorKind: boundedErrorKind(error) }
  }
}

/**
 * Tokenless direct `GET {ownedOrigin}/` from Node. The gateway authenticates the
 * index before serving the shell document, so an unauthenticated caller must be
 * refused and must learn no policy. This is the independent half of the CSP
 * observation; the authenticated half runs from the owned document.
 */
export async function observeDirectCsp(ownedOrigin, httpTimeoutMs) {
  const observation = { attempted: true, requestPath: '/', unauthenticated: true, status: null, cspPresent: false, directiveCount: 0, errorKind: null }
  try {
    const response = await fetch(`${ownedOrigin}/`, {
      signal: AbortSignal.timeout(httpTimeoutMs),
      cache: 'no-store',
      redirect: 'manual',
      headers: { accept: 'text/html' },
    })
    observation.status = response.status
    const value = response.headers.get('content-security-policy')
    observation.cspPresent = typeof value === 'string' && value.length > 0
    observation.directiveCount = observation.cspPresent ? value.split(';').filter(part => part.trim() !== '').length : 0
    try { if (response.body && typeof response.body.cancel === 'function') await response.body.cancel() } catch { /* bounded */ }
  } catch (error) {
    observation.errorKind = boundedErrorKind(error)
  }
  return observation
}

/** Bounded sleep clamped to the remaining budget. */
function sleep(ms) {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

// ---------------------------------------------------------------------------
// Attach with bounded retries
// ---------------------------------------------------------------------------

/**
 * Attach to the unique page target whose origin is exactly the owned gateway
 * origin, retrying boundedly (the webview may still be booting). Afterwards, if
 * a previous target id is supplied, a URL refresh on that SAME target id is
 * tolerated boundedly.
 */
export async function attach({
  cdpOrigin,
  canonicalOwnedOrigin,
  httpTimeoutMs,
  attachWaitMs,
  refreshIntervalMs,
  commandTimeoutMs,
  webSocketImpl,
  previousTargetId = null,
  previousIds = [],
  allowNewTargetOnRestart = false,
}) {
  const deadline = Date.now() + attachWaitMs
  let lastFailure = { code: 'no_target_with_owned_origin', candidates: 0, ids: [] }
  for (;;) {
    let targets = []
    try {
      targets = await listTargets(cdpOrigin, httpTimeoutMs)
    } catch (error) {
      lastFailure = { code: boundedErrorKind(error), candidates: 0, ids: [] }
    }
    if (targets.length > 0) {
      const selection = previousTargetId === null
        ? selectTarget(targets, canonicalOwnedOrigin)
        : matchRefreshedTarget(targets, previousTargetId, canonicalOwnedOrigin, {
            allowNewTargetOnRestart,
            previousIds,
          })
      if (selection.ok) {
        const connection = await CdpConnection.open(selection.target.webSocketDebuggerUrl, {
          webSocketImpl,
          commandTimeoutMs,
        })
        return {
          connection,
          targetId: selection.target.id,
          canonicalOrigin: selection.canonicalOrigin,
          refreshed: selection.refreshed === true,
          refreshMode: selection.mode ?? 'exact',
          selectedByExactOrigin: previousTargetId === null || selection.refreshed !== true,
          targetIds: targets.map(target => target.id).slice(0, 32),
        }
      }
      lastFailure = { code: selection.code, candidates: selection.candidates ?? 0, ids: selection.ids ?? [] }
    }
    if (Date.now() >= deadline) {
      throw new ProbeError(
        'target_selection_failed',
        `no unique page target for the owned gateway origin within ${attachWaitMs} ms (${lastFailure.code})`,
      )
    }
    await sleep(Math.min(refreshIntervalMs, Math.max(0, deadline - Date.now())))
  }
}

// ---------------------------------------------------------------------------
// Verdict, exit code, and the report
// ---------------------------------------------------------------------------

/**
 * Map the collected state to a numeric exit code. An incomplete observation
 * (internal error) is reported as 6 rather than as a failed check: the probe did
 * not establish a contract violation, it failed to observe.
 */
export function exitCodeFor({ bridgeMissing = false, targetFailed = false, internalError = false, checks = [] } = {}) {
  if (bridgeMissing) return EXIT.BRIDGE_MISSING
  if (targetFailed) return EXIT.TARGET_SELECTION
  if (internalError) return EXIT.INTERNAL
  const failed = checks.filter(check => check.ok !== true)
  return failed.length === 0 ? EXIT.PASS : EXIT.FAILED_CHECK
}

function human(line) {
  process.stderr.write(`${line}\n`)
}

const NOT_ESTABLISHED = Object.freeze([
  'CDP endpoint ownership: this probe never attributes the debug endpoint, the page, or the runtime to a child process.',
  'Launch namespace: the canonical UUID is launch context only; it does not prove process ownership. The parent must prove child PID, profile, image, and namespace separately.',
  'Native host kind: page globals and a WebView2 user agent are heuristics; native attribution needs process attestation outside CDP.',
  'CSP enforcement: only the emitted response header bytes are observed; that WebView2 accepted or enforced the policy is unproven.',
  'Authenticated HTTP observation: the tokenless direct fetch observes the refusal branch only; the authenticated observation is made from the owned document so that neither the session cookie nor a tokenized URL is ever read.',
  'Owned-namespace keyring effect: the reserved-identity rejections are expected to run before any OS store call, but this probe does not inspect the keyring.',
])

/**
 * Run the probe. Returns the redacted record; never throws for a check failure.
 * @param {object} args Parsed arguments (`parseArgs`).
 * @param {{webSocketImpl?: Function, deps?: object}} [inject] Test seam.
 */
export async function runProbe(args, inject = {}) {
  const startedAt = new Date()
  const bounds = args.bounds
  const nowMs = () => Date.now()
  const startedMs = nowMs()
  const record = {
    record: 'native-cdp-probe',
    probeVersion: 1,
    kind: 'debug-observation',
    nativeAcceptance: false,
    acceptanceStatement:
      'This record is NOT native acceptance and NOT an installer/qualification artifact. It observes one debug webview over CDP; process ownership and native attribution remain the parent\'s evidence.',
    startedAt: startedAt.toISOString(),
    target: {
      cdpHost: args.cdp.hostname,
      cdpPort: args.cdp.port,
      gatewayOrigin: args.gatewayOrigin.origin,
      gatewayOriginCanonicalization: 'localhost -> 127.0.0.1; explicit port required',
      originRefreshed: false,
      refreshMode: 'exact',
      refreshCount: 0,
      selectedByExactOrigin: false,
      targetId: null,
      targetOrigin: null,
    },
    ownership: {
      namespaceUuid: args.namespace,
      namespaceIsCanonicalNonNilUuid: isCanonicalNonNilUuid(args.namespace),
      namespaceProvesProcessOwnership: false,
      requiredParentEvidence: ['child PID', 'profile/home path', 'application image and integrity label', 'owned credential namespace'],
    },
    bridge: { hasTauriInternals: null, invokeIsFunction: null, hasTauriGlobalCoreInvoke: null },
    document: { origin: null, originMatchesOwnedGateway: null },
    observations: null,
    csp: { direct: null, page: null, requiredDirectives: [...REQUIRED_CSP_DIRECTIVES] },
    restart: { attempted: false, enabled: args.runtimeRestart === true },
    bounds: {
      totalTimeoutMs: bounds['total-timeout-ms'],
      commandTimeoutMs: bounds['command-timeout-ms'],
      httpTimeoutMs: bounds['http-timeout-ms'],
      attachWaitMs: bounds['attach-wait-ms'],
      restartTimeoutMs: bounds['restart-timeout-ms'],
      refreshAttempts: bounds['refresh-attempts'],
      refreshIntervalMs: bounds['refresh-interval-ms'],
      watchdogTripped: false,
    },
    nativeCommandsInvoked: [],
    excludedOperations: [
      'shell_quit_request', 'shell_close_window', 'shell_window_chrome_action',
      'runtime_quit_inspection', 'runtime_boot_ready', 'runtime_boot_failed',
      'update_check', 'update_open', 'settings_*', 'plugin:event|*',
      'any credential mutation outside the reserved identity',
    ],
    notEstablished: [...NOT_ESTABLISHED],
    checks: [],
    verdict: 'incomplete',
    exitCode: EXIT.INTERNAL,
    durationMs: null,
  }

  let connection = null
  let bridgeMissing = false
  let targetFailed = false
  let restartState = null
  try {
    human(`attach: cdp=${args.cdp.origin} gateway=${args.gatewayOrigin.origin} namespace=<uuid>`)

    const product = await readBrowserProduct(args.cdp.origin, bounds['http-timeout-ms'])
    record.target.browserProduct = product.product

    let attached
    try {
      attached = await attach({
        cdpOrigin: args.cdp.origin,
        canonicalOwnedOrigin: args.gatewayOrigin.origin,
        httpTimeoutMs: bounds['http-timeout-ms'],
        attachWaitMs: bounds['attach-wait-ms'],
        refreshIntervalMs: bounds['refresh-interval-ms'],
        commandTimeoutMs: bounds['command-timeout-ms'],
        webSocketImpl: inject.webSocketImpl,
      })
    } catch (error) {
      targetFailed = true
      record.target.failureCode = boundedErrorKind(error)
      human(`target selection failed: ${record.target.failureCode}`)
      throw error
    }
    connection = attached.connection
    record.target.targetId = String(attached.targetId).slice(0, 32)
    record.target.targetOrigin = attached.canonicalOrigin
    record.target.selectedByExactOrigin = attached.selectedByExactOrigin === true
    record.target.refreshMode = attached.refreshMode
    let previousIds = attached.targetIds
    human(`attached: target=<id> origin=${attached.canonicalOrigin}`)

    const pageFacts = await connection.evaluate(PAGE_FACTS_EXPRESSION, { awaitPromise: false })
    record.bridge = {
      hasTauriInternals: pageFacts.hasTauriInternals === true,
      invokeIsFunction: pageFacts.invokeIsFunction === true,
      hasTauriGlobalCoreInvoke: pageFacts.hasTauriGlobalCoreInvoke === true,
    }
    record.document.origin = canonicalizeOrigin(pageFacts.documentOrigin)
    record.document.originMatchesOwnedGateway = record.document.origin === args.gatewayOrigin.origin

    const battery = await connection.evaluate(NATIVE_BATTERY_EXPRESSION)
    record.observations = battery
    record.nativeCommandsInvoked = Array.isArray(battery.commandsInvoked) ? [...battery.commandsInvoked] : []

    if (battery.bridge !== true) {
      bridgeMissing = true
      human('bridge: window.__TAURI_INTERNALS__.invoke is absent; failing closed without invoking any command')
    } else {
      record.csp.page = await connection.evaluate(CSP_PAGE_EXPRESSION)
      human(`csp(page): status=${record.csp.page.status} header=${record.csp.page.cspPresent} rules=${record.csp.page.ruleCount}`)
    }

    record.csp.direct = await observeDirectCsp(args.gatewayOrigin.origin, bounds['http-timeout-ms'])
    human(`csp(direct tokenless): status=${record.csp.direct.status} header=${record.csp.direct.cspPresent}`)

    if (args.runtimeRestart === true && bridgeMissing === false) {
      restartState = await runRestartPhase(record, args, {
        getConnection: () => connection,
        setConnection: next => { connection = next },
        previousIds: () => previousIds,
        setPreviousIds: next => { previousIds = next },
        webSocketImpl: inject.webSocketImpl,
      })
    }
  } catch (error) {
    record.internalErrorKind = boundedErrorKind(error)
    if (!targetFailed) {
      if (error instanceof ProbeError && error.code === 'target_selection_failed') targetFailed = true
    }
    human(`probe aborted: ${record.internalErrorKind}`)
  } finally {
    if (connection) {
      try { await connection.close() } catch { /* bounded */ }
    }
  }

  const commandWhitelist = assertCommandWhitelist(record.nativeCommandsInvoked, { runtimeRestart: args.runtimeRestart })
  record.checks = evaluateChecks({
    pageFacts: { invokeIsFunction: record.bridge.invokeIsFunction },
    battery: record.observations ?? {},
    target: record.target,
    documentOriginMatches: record.document.originMatchesOwnedGateway,
    csp: { direct: record.csp.direct ?? {}, page: record.csp.page ?? {} },
    restart: restartState ?? { attempted: false },
    commandWhitelist,
  })
  record.exitCode = exitCodeFor({
    bridgeMissing,
    targetFailed,
    internalError: typeof record.internalErrorKind === 'string',
    checks: record.checks,
  })
  const failed = record.checks.filter(check => check.ok !== true)
  record.verdict = record.exitCode === EXIT.PASS
    ? 'pass'
    : bridgeMissing
      ? 'bridge-missing'
      : targetFailed
        ? 'target-selection-failed'
        : record.internalErrorKind
          ? 'internal-error'
          : 'failed-check'
  record.failedChecks = failed.map(check => check.id)
  record.durationMs = nowMs() - startedMs
  return record
}

/** The single permitted restart invocation plus its bounded generation wait. */
async function runRestartPhase(record, args, io) {
  const bounds = args.bounds
  const baseline = deriveReadyGeneration([
    { state: record.observations?.runtimeStatus?.state, startedAtDigest: record.observations?.runtimeStatus?.startedAtDigest },
  ])
  const state = {
    attempted: true,
    enabled: true,
    invokedCount: 0,
    baselineGeneration: baseline.readyGenerations,
    baselineDigest: baseline.currentDigest,
    baselineDigestPresent: typeof baseline.currentDigest === 'string',
    observedGeneration: baseline.readyGenerations,
    generationAdvancedByOne: false,
    newReadyLastErrorPresent: null,
    samples: 0,
    refreshCount: 0,
    targetOriginAfter: null,
    elapsedMs: 0,
  }
  record.restart = state
  const startedMs = Date.now()
  const deadline = startedMs + bounds['restart-timeout-ms']

  let invocation
  try {
    invocation = await io.getConnection().evaluate(RESTART_EXPRESSION)
  } catch (error) {
    state.invocationErrorKind = boundedErrorKind(error)
    human(`runtime_restart evaluation failed: ${state.invocationErrorKind}`)
    return state
  }
  state.invokedCount = invocation.invoked === true ? 1 : 0
  state.invocationResolved = invocation.resolved === true
  state.invocationState = invocation.state ?? null
  if (state.invokedCount === 1) record.nativeCommandsInvoked.push('runtime_restart')
  human(`runtime_restart: invoked=${state.invokedCount} resolved=${state.invocationResolved} state=${state.invocationState}`)
  if (state.invokedCount !== 1) return state

  const samples = []
  let newDigestSeen = 0
  let lastErrorPresent = null
  const interval = Math.max(1, bounds['refresh-interval-ms'])
  const maxSamples = Math.min(120, Math.max(4, Math.ceil(bounds['restart-timeout-ms'] / interval) + 2))
  for (let attempt = 0; attempt < maxSamples; attempt += 1) {
    if (Date.now() >= deadline) break
    let sample
    try {
      sample = await io.getConnection().evaluate(RUNTIME_DIGEST_EXPRESSION)
    } catch (error) {
      // The execution context may be torn down by the restart: re-resolve the
      // target with bounded refresh tolerance and continue.
      try { await io.getConnection().close() } catch { /* bounded */ }
      const reattach = await reattachAfterRestart(record, args, io)
      if (!reattach) break
      sample = reattach
    }
    state.samples += 1
    if (sample && sample.resolved === true) {
      samples.push({ state: sample.state, startedAtDigest: sample.startedAtDigest })
      if (sample.state === 'ready' && typeof sample.startedAtDigest === 'string'
        && sample.startedAtDigest !== baseline.currentDigest) {
        newDigestSeen += 1
        lastErrorPresent = sample.lastErrorPresent === true
      }
    }
    if (newDigestSeen >= 2) break
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())))
  }

  const generation = deriveReadyGeneration(samples)
  const observed = baseline.readyGenerations + (newDigestSeen > 0 ? 1 : 0)
  state.observedGeneration = observed
  state.readyDigestsObserved = generation.digests.length
  state.generationAdvancedByOne = newDigestSeen > 0
    && state.baselineDigestPresent === true
    && observed === baseline.readyGenerations + 1
  state.newReadyLastErrorPresent = lastErrorPresent
  state.elapsedMs = Date.now() - startedMs
  state.targetOriginAfter = record.target.targetOrigin
  state.refreshCount = record.target.refreshCount
  return state
}

/** Re-resolve the target after a restart, tolerating one bounded URL refresh. */
async function reattachAfterRestart(record, args, io) {
  const bounds = args.bounds
  try {
    const attached = await attach({
      cdpOrigin: args.cdp.origin,
      canonicalOwnedOrigin: args.gatewayOrigin.origin,
      httpTimeoutMs: bounds['http-timeout-ms'],
      attachWaitMs: bounds['attach-wait-ms'],
      refreshIntervalMs: bounds['refresh-interval-ms'],
      commandTimeoutMs: bounds['command-timeout-ms'],
      webSocketImpl: io.webSocketImpl,
      previousTargetId: record.target.targetId,
      previousIds: io.previousIds(),
      allowNewTargetOnRestart: args.allowNewTargetOnRestart === true,
    })
    io.setConnection(attached.connection)
    io.setPreviousIds(attached.targetIds)
    record.target.refreshCount += 1
    record.target.originRefreshed = record.target.originRefreshed === true || attached.refreshed === true
    record.target.refreshMode = attached.refreshMode
    record.target.targetId = String(attached.targetId).slice(0, 32)
    record.target.targetOrigin = attached.canonicalOrigin
    human(`reattached after restart: origin=${attached.canonicalOrigin} refreshed=${attached.refreshed === true}`)
    return await attached.connection.evaluate(RUNTIME_DIGEST_EXPRESSION)
  } catch (error) {
    record.restart.reattachErrorKind = boundedErrorKind(error)
    human(`reattach after restart failed: ${record.restart.reattachErrorKind}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `native-cdp-probe.mjs — provisional debug-scope CDP native observation probe

Required:
  --cdp <http://127.0.0.1:PORT>        already-running debug webview CDP endpoint
  --gateway-origin <http://127.0.0.1:PORT>  exact owned gateway origin (never 3080)
  --namespace <uuid>                   canonical non-nil lowercase UUID (context only)

Optional:
  --runtime-restart                    invoke runtime_restart ONCE and check the
                                       new ready generation is baseline + 1
  --allow-new-target-on-restart        allow a new target id (default: same id only)
  --report <path>                      write the redacted record to this JSON file
  --http-timeout-ms --command-timeout-ms --total-timeout-ms
  --attach-wait-ms --restart-timeout-ms --refresh-attempts --refresh-interval-ms
  --help

Exit codes: 0 pass, 1 failed check, 2 refused argument, 3 no Tauri bridge,
4 target selection failed, 5 watchdog, 6 internal error.
stdout is one redacted JSON record; stderr is redacted narration.
`

/**
 * CLI entry point. Returns the process exit code.
 * @param {string[]} argv
 * @param {{webSocketImpl?: Function}} [inject]
 */
export async function cli(argv, inject = {}) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    const message = error instanceof ProbeError ? error.message : 'argument parsing failed'
    process.stderr.write(`REFUSED: ${message}\n`)
    process.stderr.write(USAGE)
    return EXIT.REFUSED
  }
  if (args.help === true) {
    process.stderr.write(USAGE)
    return EXIT.PASS
  }

  const watchdog = setTimeout(() => {
    process.stderr.write(`${JSON.stringify({ record: 'native-cdp-probe', verdict: 'watchdog', exitCode: EXIT.WATCHDOG, note: 'total timeout exceeded; no partial record' })}\n`)
    process.exit(EXIT.WATCHDOG)
  }, args.bounds['total-timeout-ms'])

  let record
  try {
    record = await runProbe(args, inject)
  } catch (error) {
    clearTimeout(watchdog)
    process.stderr.write(`INTERNAL: ${boundedErrorKind(error)}\n`)
    return EXIT.INTERNAL
  }
  clearTimeout(watchdog)

  const leaks = findSecretLikeLeaks(record)
  if (leaks.length > 0) {
    process.stderr.write(`REFUSED: the record would leak secret-shaped fields at: ${leaks.join(', ')}\n`)
    return EXIT.REFUSED
  }

  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  for (const check of record.checks) {
    process.stderr.write(`${check.ok ? 'ok  ' : 'FAIL'} ${check.id} — ${check.detail}\n`)
  }
  if (args.reportPath !== null) {
    try {
      await mkdir(dirname(args.reportPath), { recursive: true })
      await writeFile(args.reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      process.stderr.write(`report written: ${args.reportPath}\n`)
    } catch (error) {
      process.stderr.write(`report write failed: ${boundedErrorKind(error)}\n`)
      return EXIT.INTERNAL
    }
  }
  process.stderr.write(`verdict: ${record.verdict} exit=${record.exitCode} (NOT native acceptance)\n`)
  return record.exitCode
}

const invokedDirectly = (() => {
  const entry = process.argv[1]
  if (typeof entry !== 'string' || entry === '') return false
  try {
    return pathToFileURL(resolve(entry)).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  process.on('unhandledRejection', reason => {
    process.stderr.write(`INTERNAL: unhandled rejection ${boundedErrorKind(reason)}\n`)
    process.exit(EXIT.INTERNAL)
  })
  cli(process.argv.slice(2)).then(code => process.exit(code), error => {
    process.stderr.write(`INTERNAL: ${boundedErrorKind(error)}\n`)
    process.exit(EXIT.INTERNAL)
  })
}
