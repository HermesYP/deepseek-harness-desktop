#!/usr/bin/env node
/**
 * native-acceptance-runner.mjs — the native happy-path acceptance harness.
 *
 * WHAT THIS IS
 *   A single-file Node 22 runner that launches the ACTUAL assembled Tauri
 *   desktop candidate (dsh-desktop.exe) under the app's own owned-credential
 *   fence, drives its REAL WebView2 window over the supported native CDP
 *   surface (WebView2 remote debugging enabled for this run), and records a
 *   redacted acceptance verdict over the intended scenarios:
 *
 *     identity      candidate exe/hash/pid, native WebView2 host classification
 *     bridge        the redacted native command battery (app info, runtime,
 *                   update, credentials)
 *     onboarding    first-run onboarding completes and stays completed
 *     shell         composer, New-session sidebar action and Settings control
 *                   are usable
 *     chat          explicit clearly-labelled LOCAL fixture provider:
 *                   streaming reply, one real tool round, real cancellation
 *     settings      a marker setting survives a graceful quit + relaunch
 *     account/updates the Settings surface opens; the read-only Updates status
 *                   command resolves; the Account surface is reachable
 *
 *   It NEVER substitutes a standalone Chromium for the app: the only browser it
 *   attaches to is the WebView2 instance the candidate itself created, and the
 *   native host classification (`native-webview2`, from helpers/host-identity.mjs)
 *   is a required check.
 *
 * ISOLATION / SAFETY CONTRACT
 *   * The candidate is EXPLICIT: `--exe <path>` plus `--sha256 <hex64>`; the
 *     hash is verified before anything is launched. No globs are accepted.
 *   * The owned credential fence is honoured: a fresh canonical non-nil UUID
 *     namespace per run, `DSH_HOME` placed under the fence-derived owned root
 *     `<repo>/.scratch/native-{uuid}`, and the namespace exported as
 *     `DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE`. A release image is refused
 *     (the fence itself requires a debug build).
 *   * The live Harness home (`%USERPROFILE%\.dsh`) is never used; the live GUI
 *     port 3080 is refused for the CDP endpoint, the fixture provider and the
 *     bound gateway port alike.
 *   * The runner OWNS the processes it spawns: bounded launch/readiness/stage
 *     timeouts, an in-run watchdog that terminates the owned child, and
 *     termination only through helpers/process-authority.mjs (spawn-time
 *     identity + fresh OS identity re-verification before any kill);
 *     descendant leftovers are accounted, never killed.
 *   * Fixture credentials: one fixed, clearly-labelled, non-secret key string
 *     exported into the run's child environment only. No test credential is
 *     ever written to the report, and real-platform sign-in remains a
 *     separately required REAL acceptance step (never faked here).
 *
 * VERDICT
 *   `acceptance: true` ONLY when every required check has status `pass` AND
 *   the process identity facts are complete AND no required check is missing.
 *   An action that could not be exercised is `unqualified` (or, when explicitly
 *   not requested, `not-requested` with required:false — visible, never a
 *   pass). Exit codes: 0 pass, 1 failed/unqualified check, 2 refused argument
 *   or preflight, 3 bridge missing, 4 target selection failed, 5 watchdog,
 *   6 internal error.
 *
 * Owned by: native acceptance harness lane (subagent session-185f3631942c,
 * parent session-7511a356-3bfb-4748-9d19-3a96bb7ed2e6).
 */

import { createHash, randomUUID } from 'node:crypto'
import { spawn as nodeSpawn } from 'node:child_process'
import { lstat as fsLstat, readFile, writeFile, mkdir, access, stat } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  EXIT,
  LIVE_GUI_PORT,
  NATIVE_BATTERY_EXPRESSION,
  assertCommandWhitelist,
  attach,
  boundedErrorKind,
  canonicalizeOrigin,
  findSecretLikeLeaks,
  isCanonicalNonNilUuid,
} from '../native-cdp/native-cdp-probe.mjs'
import { classifyHost, NATIVE_WEBVIEW } from '../helpers/host-identity.mjs'
import {
  captureProcessIdentity,
  captureProcessTable,
  descendantsOf,
  processIsAbsent,
  settleDescendants,
  terminateOwnedChild,
} from '../helpers/process-authority.mjs'
import {
  FIXTURE_API_KEY,
  FIXTURE_CANCEL_MARKER,
  FIXTURE_KEY_ENV,
  FIXTURE_MODEL_ID,
  FIXTURE_REPLY_TEXT,
  FIXTURE_ROUTE,
  FIXTURE_TOOL_NAME,
  createFixtureProvider,
} from './fixture-provider.mjs'

export const HARNESS_VERSION = 1

export const NUMERIC_BOUNDS = Object.freeze({
  'cdp-port': [1024, 65535, 9333],
  'fixture-port': [1024, 65535, 9471],
  'boot-timeout-ms': [5000, 300000, 150000],
  'attach-wait-ms': [0, 120000, 20000],
  'onboarding-timeout-ms': [5000, 300000, 120000],
  'stage-timeout-ms': [5000, 300000, 90000],
  'chat-timeout-ms': [5000, 300000, 90000],
  'quit-timeout-ms': [2000, 120000, 30000],
  'total-timeout-ms': [30000, 1800000, 600000],
})

const STAMP_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/

/** The exact checks whose absence makes a green verdict impossible. */
export const REQUIRED_CHECK_IDS = Object.freeze([
  'launch.readiness',
  'gateway.bound_port_safe',
  'identity.executable_hash',
  'identity.process_identity',
  'identity.native_host',
  'bridge.native_battery',
  'onboarding.first_run',
  'shell.usable',
  'chat.fixture_stream',
  'chat.fixture_tool_round',
  'chat.fixture_cancel',
  'settings.surface_opens',
  'settings.marker_set',
  'updates.status_resolves',
  'account.surface_reachable',
  'teardown.graceful_exit',
  'teardown.relaunch_ready',
  'settings.persistence',
  'onboarding.stays_completed',
  'teardown.final_exit',
])

/** Fixed, non-secret settings marker used for the persistence scenario. */
export const SETTINGS_MARKER_KEY = 'acceptance.native-marker'
export const SETTINGS_MARKER_VALUE = 'set-by-native-acceptance'

/** Messages sent to the fixture provider through the real composer. */
export const FIXTURE_CHAT_MESSAGE = 'Acceptance streaming test: reply with your fixture text.'
export const FIXTURE_CANCEL_MESSAGE = `${FIXTURE_CANCEL_MARKER}: stream slowly, the harness will stop you.`

/** Numeric exit codes for THIS runner (probe taxonomy superset). */
export const RUNNER_EXIT = Object.freeze({
  PASS: EXIT.PASS,
  FAILED: EXIT.FAILED_CHECK,
  REFUSED: EXIT.REFUSED,
  BRIDGE_MISSING: EXIT.BRIDGE_MISSING,
  TARGET_SELECTION: EXIT.TARGET_SELECTION,
  WATCHDOG: EXIT.WATCHDOG,
  INTERNAL: EXIT.INTERNAL,
})

// ---------------------------------------------------------------------------
// Pure argument parsing (unit-tested; refuses before anything is touched)
// ---------------------------------------------------------------------------

/** A typed refusal (exit 2) that never carries candidate secret material. */
function refusal(message) {
  const error = new Error(message)
  error.code = 'refused'
  return error
}

/**
 * Parse CLI arguments. Unknown flags, missing required values, out-of-range
 * numbers and a live-GUI port are refused.
 */
export function parseArgs(argv) {
  const values = new Map()
  const flags = new Set()
  const valueNames = new Set([
    'exe', 'sha256', 'repo', 'report', 'stamp', 'runtime-dir', 'shell-dir', 'node-exe',
    ...Object.keys(NUMERIC_BOUNDS),
  ])
  const flagNames = new Set(['without-fixture-chat', 'dry-run', 'help'])

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (typeof token !== 'string' || !token.startsWith('--')) {
      throw refusal(`unexpected positional argument #${index + 1}`)
    }
    const name = token.slice(2)
    if (flagNames.has(name)) {
      if (flags.has(name)) throw refusal(`--${name} was supplied twice`)
      flags.add(name)
      continue
    }
    if (!valueNames.has(name)) throw refusal(`unknown argument --${name}`)
    if (values.has(name)) throw refusal(`--${name} was supplied twice`)
    const next = argv[index + 1]
    if (typeof next !== 'string' || next.startsWith('--')) {
      throw refusal(`--${name} requires a value`)
    }
    values.set(name, next)
    index += 1
  }

  if (flags.has('help')) return { help: true }

  const exe = values.get('exe')
  if (typeof exe !== 'string' || exe.trim() === '') {
    throw refusal('--exe is required: the exact candidate executable path (no globs are accepted)')
  }
  if (!isAbsolute(exe)) throw refusal('--exe must be an absolute path')

  const sha256 = (values.get('sha256') ?? '').toLowerCase()
  if (!/^[0-9a-f]{64}$/u.test(sha256)) {
    throw refusal('--sha256 is required and must be the 64-hex-digit SHA-256 of the candidate executable')
  }

  const bounds = {}
  for (const [name, [min, max, fallback]] of Object.entries(NUMERIC_BOUNDS)) {
    const raw = values.has(name) ? values.get(name) : String(fallback)
    if (!/^\d+$/u.test(raw)) throw refusal(`--${name} must be a non-negative integer`)
    const parsed = Number(raw)
    if (parsed < min || parsed > max) throw refusal(`--${name} must be within [${min}, ${max}]`)
    bounds[name] = parsed
  }
  if (bounds['cdp-port'] === LIVE_GUI_PORT) throw refusal(`--cdp-port must not be ${LIVE_GUI_PORT}: that is the live Harness GUI`)
  if (bounds['fixture-port'] === LIVE_GUI_PORT) throw refusal(`--fixture-port must not be ${LIVE_GUI_PORT}: that is the live Harness GUI`)
  if (bounds['cdp-port'] === bounds['fixture-port']) throw refusal('--cdp-port and --fixture-port must differ')

  const stamp = values.get('stamp') ?? `${new Date().toISOString().replace(/[-:]/gu, '').replace(/\..*$/u, '')}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
  if (!STAMP_PATTERN.test(stamp)) throw refusal('--stamp must match [A-Za-z0-9][A-Za-z0-9-]{0,63}')

  return {
    help: false,
    exe: resolve(exe),
    sha256,
    repo: values.has('repo') ? resolve(values.get('repo')) : null,
    reportPath: values.has('report') ? resolve(values.get('report')) : null,
    stamp,
    runtimeDir: values.has('runtime-dir') ? resolve(values.get('runtime-dir')) : null,
    shellDir: values.has('shell-dir') ? resolve(values.get('shell-dir')) : null,
    nodeExe: values.has('node-exe') ? resolve(values.get('node-exe')) : null,
    withFixtureChat: !flags.has('without-fixture-chat'),
    dryRun: flags.has('dry-run'),
    bounds: Object.freeze(bounds),
  }
}

// ---------------------------------------------------------------------------
// Pure preflight / staging helpers (unit-tested)
// ---------------------------------------------------------------------------

/** Truncate a hash for refusal messages: never emit a secret-shaped 64-hex run. */
export function truncateHash(hash) {
  const text = String(hash ?? '')
  return text.length <= 16 ? `${text}…` : `${text.slice(0, 16)}…`
}

/** SHA-256 over a file's bytes. */
async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Resolve the runtime interpreter for this run.
 *
 * Default (no `--node-exe`): the payload's own pinned interpreter — the
 * published-layout behaviour, unchanged.
 *
 * With `--node-exe <ABS path>`: an ATTESTED COPY of the payload interpreter —
 * never a relabel and never a different interpreter. The copy must be a
 * regular non-linked file (symlink/junction/reparse refused) that is not the
 * same underlying file as the reference (hardlinks share the reference's
 * integrity label and are refused), and its SHA-256 must EXACTLY equal the
 * reference `runtimeDir/node/node.exe` bytes — so a different interpreter,
 * version or architecture can never be accepted. Both paths and both hashes
 * are recorded.
 */
export async function resolveExecutionNode({ payloadNodePath, nodeExe, lstatImpl = fsLstat, hashImpl = sha256File }) {
  if (nodeExe === undefined || nodeExe === null || nodeExe === '') {
    const referenceSha256 = await hashImpl(payloadNodePath)
    return { source: 'payload', referencePath: payloadNodePath, referenceSha256, executionPath: payloadNodePath, executionSha256: referenceSha256 }
  }
  if (typeof nodeExe !== 'string' || !isAbsolute(nodeExe)) {
    throw refusal('--node-exe must be an absolute path to a byte-identical trusted copy of the runtime interpreter')
  }
  let trustedInfo
  let referenceInfo
  try {
    trustedInfo = await lstatImpl(nodeExe)
    referenceInfo = await lstatImpl(payloadNodePath)
  } catch {
    throw refusal(`--node-exe or its payload reference could not be stat-ed; nothing was launched`)
  }
  if (!trustedInfo.isFile() || trustedInfo.isSymbolicLink()) {
    throw refusal(`--node-exe must be a regular non-linked file (no symlink, junction or reparse point)`)
  }
  if (!referenceInfo.isFile()) {
    throw refusal(`the runtime interpreter reference is not a regular file`)
  }
  if (trustedInfo.dev === referenceInfo.dev && trustedInfo.ino === referenceInfo.ino) {
    throw refusal(`--node-exe is the SAME underlying file as the payload interpreter (hardlink or identical path); it must be an independent byte-identical copy`)
  }
  const referenceSha256 = await hashImpl(payloadNodePath)
  const executionSha256 = await hashImpl(nodeExe)
  if (executionSha256 !== referenceSha256) {
    throw refusal(`--node-exe is not byte-identical to the payload interpreter: expected ${truncateHash(referenceSha256)}, observed ${truncateHash(executionSha256)}`)
  }
  return {
    source: 'trusted-copy',
    referencePath: payloadNodePath,
    referenceSha256,
    executionPath: nodeExe,
    executionSha256,
  }
}

/**
 * The candidate preflight: existence, size, debug-image requirement and the
 * exact SHA-256 match. A `\release\` path segment is refused because the owned
 * credential fence requires a debug build; the app itself refuses a namespace
 * on a release image, so launching one could only produce a confusing startup
 * failure. The hash is verified over the file bytes BEFORE anything launches.
 */
export async function preflightCandidate(candidate) {
  if (typeof candidate?.exe !== 'string' || !isAbsolute(candidate.exe)) {
    throw refusal('candidate exe must be an absolute path')
  }
  if (/(?:^|[\\/])release(?:[\\/]|$)/iu.test(candidate.exe)) {
    throw refusal(`candidate '${candidate.exe}' is a RELEASE image; the owned credential-namespace fence requires a debug build. Nothing was launched.`)
  }
  let info
  try {
    info = await stat(candidate.exe)
  } catch {
    throw refusal(`candidate executable not found: ${candidate.exe}`)
  }
  if (!info.isFile()) throw refusal(`candidate is not a regular file: ${candidate.exe}`)
  const bytes = await readFile(candidate.exe)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== candidate.sha256) {
    throw refusal(`candidate hash mismatch: expected ${truncateHash(candidate.sha256)}, observed ${truncateHash(sha256)} for ${candidate.exe}`)
  }
  return { exePath: candidate.exe, sha256, sizeBytes: info.size }
}

/**
 * Derive the run's isolation paths from the repository root and namespace.
 * The owned root MUST be the fence's compile-time derivation
 * `<repo>/.scratch/native-{uuid}` and the home MUST live under it.
 */
export function deriveIsolationPaths({ repoRoot, namespace, stamp, portRoot = 'port' }) {
  if (!isCanonicalNonNilUuid(namespace)) {
    throw refusal('the owned credential namespace must be a canonical non-nil lowercase UUID')
  }
  const ownedRoot = join(repoRoot, '.scratch', `native-${namespace}`)
  const runRoot = join(repoRoot, portRoot, '.scratch', `native-acceptance-${stamp}`)
  return {
    namespace,
    ownedRoot,
    runRoot,
    home: join(ownedRoot, 'home'),
    userData: join(ownedRoot, 'home', 'userdata'),
    profileDir: join(ownedRoot, 'home', 'profiles', 'desktop'),
    reportPath: join(runRoot, 'acceptance-record.json'),
  }
}

/** Fresh roots must not exist: a reused home would adopt previous state. */
export async function assertFreshRoots(paths) {
  for (const [label, path] of [
    ['owned root', paths.ownedRoot],
    ['run root', paths.runRoot],
  ]) {
    try {
      await access(path, fsConstants.F_OK)
      throw refusal(`${label} already exists: ${path}. A fresh root is required; nothing was deleted or launched.`)
    } catch (error) {
      if (error.code === 'refused') throw error
      if (error.code !== 'ENOENT') {
        throw refusal(`${label} existence could not be established (${boundedErrorKind(error)})`)
      }
    }
  }
}

/**
 * The staged provider patch for the isolated home (`$DSH_HOME/cordis.patch.yml`).
 * The content is clearly labelled, references ONLY the local fixture origin and
 * the fixed non-secret env-var NAME (never a key value), and overrides the
 * default agent model so the composer's first message routes to the fixture.
 */
export function buildFixturePatch({ fixtureOrigin }) {
  return [
    '# Staged by the native acceptance harness (port/tests/native-acceptance).',
    '# LOCAL TEST FIXTURE for acceptance only — NOT a real provider, NOT production.',
    '# Remove this file to restore the default model routing.',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${FIXTURE_ROUTE}`,
    `    model: ${FIXTURE_MODEL_ID}`,
    '',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    `      ${FIXTURE_ROUTE}:`,
    `        apiKeyEnv: ${FIXTURE_KEY_ENV}`,
    '        displayName: Fixture Provider (acceptance)',
    '        api: openai-completions',
    `        baseURL: ${fixtureOrigin}/v1`,
    '        models:',
    `          - id: ${FIXTURE_MODEL_ID}`,
    '            name: Fixture Model (acceptance)',
    '            contextWindow: 8192',
    '            maxTokens: 1024',
    '',
  ].join('\n')
}

/**
 * Parse the dev-handoff gateway URL. Returns the origin and whether a launch
 * token is present. The token value is NEVER returned, never logged, and its
 * length is the only fact about it that is recorded.
 */
export function parseGatewayUrl(raw) {
  const text = String(raw ?? '').trim()
  let url
  try {
    url = new URL(text)
  } catch {
    throw refusal('the gateway URL handoff file is not a parseable URL')
  }
  const host = url.hostname.toLowerCase()
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1' && host !== '[::1]') {
    throw refusal('the gateway URL is not loopback; refusing to accept it')
  }
  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port)
  if (port === LIVE_GUI_PORT) {
    throw refusal(`the gateway bound port ${LIVE_GUI_PORT}: that is the live Harness GUI. Refusing.`)
  }
  const token = url.searchParams.get('token')
  return {
    origin: `${url.protocol}//${host === 'localhost' ? '127.0.0.1' : host}:${port}`,
    boundPort: port,
    authenticatedUrlSeen: typeof token === 'string' && token.length > 0,
    authenticatedUrlLength: typeof token === 'string' ? token.length : 0,
  }
}

/** Whether a parsed boot payload establishes host readiness. */
export function isBootReady(payload) {
  return payload !== null
    && typeof payload === 'object'
    && typeof payload.streamBaseUrl === 'string'
    && payload.streamBaseUrl.length > 0
}

/** Whether the recorded process identity facts are complete and consistent. */
export function identityIsComplete({ candidate, process: proc }) {
  if (typeof candidate?.sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(candidate.sha256)) return false
  if (!Number.isInteger(proc?.pid) || proc.pid <= 0) return false
  if (typeof proc?.creationTicks !== 'string' || proc.creationTicks === '') return false
  if (proc?.identityStatus !== 'present') return false
  const expected = String(candidate.exe ?? '').replace(/\//gu, '\\').toLowerCase()
  const observed = String(proc?.exeObserved ?? '').replace(/\//gu, '\\').toLowerCase()
  return observed !== '' && observed === expected
}

/**
 * The verdict core: acceptance is true ONLY when every required check passed,
 * no required check id is missing, and the process identity is complete.
 * `unqualified` and `not-requested` are never passes; an empty check list is
 * never a pass.
 */
export function computeVerdict({ checks, identityComplete }) {
  const list = Array.isArray(checks) ? checks : []
  const byId = new Map(list.map(check => [check.id, check]))
  const missing = REQUIRED_CHECK_IDS.filter(id => {
    const check = byId.get(id)
    if (check === undefined) return true
    return check.required === true && check.status === 'not-requested'
  })
  const failedRequired = list
    .filter(check => check.required === true && check.status !== 'pass')
    .map(check => check.id)
  const counts = {
    total: list.length,
    pass: list.filter(check => check.status === 'pass').length,
    fail: list.filter(check => check.status === 'fail').length,
    unqualified: list.filter(check => check.status === 'unqualified').length,
    notRequested: list.filter(check => check.status === 'not-requested').length,
  }
  const acceptance = list.length > 0
    && identityComplete === true
    && missing.length === 0
    && failedRequired.length === 0
  return {
    acceptance,
    identityComplete: identityComplete === true,
    missingRequiredChecks: missing,
    failedRequiredChecks: failedRequired,
    counts,
  }
}

// ---------------------------------------------------------------------------
// Page-side expressions (fixed constants; never interpolated)
// ---------------------------------------------------------------------------

/** Host/landmark facts read from the REAL webview document. */
export const HOST_FACTS_EXPRESSION = `(() => {
  const root = document.querySelector('#root');
  const text = (document.body && document.body.innerText) || '';
  const elements = [...document.querySelectorAll('#root button, #root a, #root [role="button"]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const has = (re) => elements.some((el) => re.test(label(el)));
  const onboarding = document.querySelector('[data-desktop-onboarding]');
  const textareas = [...document.querySelectorAll('#root textarea, #root [contenteditable="true"]')];
  return {
    record: 'host-facts',
    invokeIsFunction: !!(globalThis.__TAURI_INTERNALS__ && typeof globalThis.__TAURI_INTERNALS__.invoke === 'function'),
    hasTauriInternals: '__TAURI_INTERNALS__' in globalThis,
    hasDesktopBoot: typeof globalThis.dshDesktopBoot === 'object' && globalThis.dshDesktopBoot !== null,
    hasDesktopMarker: 'dshDesktop' in globalThis,
    hasHostPaths: '__DSH_HOST_PATHS__' in globalThis,
    platformMarker: document.documentElement.dataset.platform ?? null,
    rootChildren: root ? root.childElementCount : 0,
    pluginStyles: document.querySelectorAll('style[data-plugin]').length,
    documentOrigin: (typeof location !== 'undefined') ? location.origin : null,
    composerHintPresent: /Describe what you want to build|Message or run a task/u.test(text) || textareas.length > 0,
    newSessionPresent: has(/new session/i) || has(/\\u65b0\\u5efa\\u4f1a\\u8bdd|\\u65b0\\u4f1a\\u8bdd/u),
    settingsPresent: has(/(^|\\s)settings($|\\s)/i) || has(/^\\u8bbe\\u7f6e$/u),
    onboardingPresent: onboarding !== null,
    onboardingBusy: onboarding ? onboarding.getAttribute('aria-busy') === 'true' : null,
    bootFailureShown: /is missing or not an object|bootstrap facade is missing/u.test(text),
    textLength: text.length
  };
})()`

/**
 * Click ONE onboarding action, state-aware against the actual 0.2.1-alpha.2
 * flow (packages/client/ui-settings-account/src/client/DesktopOnboarding.tsx):
 * welcome → credit → purpose → process, with confirmation dialogs rendered
 * OUTSIDE the region, purpose/process continue buttons that only exist after a
 * selection, and a credit step whose PRIMARY button is the recharge action.
 * Commercial/recharge actions are never clicked; the footer back/skip buttons
 * are never generically clicked (skip opens a dialog).
 */
export const ONBOARDING_ACTION_CLICK_EXPRESSION = `(() => {
  const forbidden = /\\u5145\\u503c|\\u524d\\u5f80\\u5145\\u503c|recharge|top.?up|add credits|\\u8d2d\\u4e70|buy|pay|\\u4ed8\\u6b3e/iu;
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const visible = (el) => { const style = getComputedStyle(el); return style.display !== 'none' && style.visibility !== 'hidden'; };
  const click = (el, matched) => { el.click(); return { record: 'onboarding-click', clicked: true, matched }; };

  // 0. A confirmation dialog is open (rendered outside [data-desktop-onboarding]).
  const dialogButtons = [...document.querySelectorAll('[class*="dialogButton"]')].filter((el) => visible(el) && el.disabled !== true);
  if (dialogButtons.length > 0) {
    const safe = dialogButtons.find((el) => !forbidden.test(label(el)));
    if (safe) return click(safe, 'dialog');
  }

  const region = document.querySelector('[data-desktop-onboarding]');
  if (!region) return { record: 'onboarding-click', clicked: false, reason: 'absent' };
  if (region.getAttribute('aria-busy') === 'true') return { record: 'onboarding-click', clicked: false, reason: 'busy' };
  const step = region.getAttribute('data-desktop-onboarding');

  // 1. welcome: the single start button.
  if (step === 'welcome') {
    const start = [...region.querySelectorAll('button, [role="button"]')].find((el) => visible(el) && /\\u5f00\\u59cb\\u8bbe\\u7f6e|get started/iu.test(label(el)));
    if (start) return click(start, 'welcome-start');
  }

  // 2. credit: NEVER the primary (recharge); take continue/next or the outline later action.
  if (step === 'credit') {
    const buttons = [...region.querySelectorAll('button, [role="button"]')].filter((el) => visible(el) && el.disabled !== true && !forbidden.test(label(el)));
    const preferred = buttons.find((el) => /\\u4e0b\\u4e00\\u6b65|next|\\u7ee7\\u7eed|continue/iu.test(label(el)))
      ?? buttons.find((el) => /[class*="laterAction"]/u.test(el.className))
      ?? buttons[buttons.length - 1];
    if (preferred) return click(preferred, 'credit-next');
  }

  // 3. purpose: the continue button does not exist until a card is checked.
  if (step === 'purpose') {
    const boxes = [...region.querySelectorAll('input[type="checkbox"]')];
    const unchecked = boxes.find((el) => el.checked !== true);
    if (unchecked) return click(unchecked, 'purpose-select');
    const primary = [...region.querySelectorAll('[class*="primaryAction"] button')].find((el) => visible(el));
    if (primary) return click(primary, 'purpose-continue');
  }

  // 4. process: the complete button does not exist until a radio is chosen.
  if (step === 'process') {
    const radios = [...region.querySelectorAll('[data-process]')];
    const chosen = radios.find((el) => el.getAttribute('aria-checked') === 'true');
    if (!chosen && radios.length > 0) return click(radios[0], 'process-select');
    const primary = [...region.querySelectorAll('[class*="primaryAction"] button')].find((el) => visible(el));
    if (primary) return click(primary, 'process-complete');
  }

  // 5. Generic fallback over non-footer, non-commercial buttons.
  const buttons = [...region.querySelectorAll('button, [role="button"]')].filter((el) => {
    if (!visible(el) || el.disabled === true || forbidden.test(label(el))) return false;
    if (el.closest('footer') !== null) return false;
    return true;
  });
  const priorities = [
    /\\u8fdb\\u5165\\u5e94\\u7528|enter (the )?(app|workspace)|open app|get started|finish|done|\\u5b8c\\u6210/iu,
    /\\u7ee7\\u7eed|continue|\\u4e0b\\u4e00\\u6b65|next/iu,
    /\\u5f00\\u59cb|start/iu,
    /got it|understood|\\u77e5\\u9053\\u4e86/iu,
  ];
  for (const re of priorities) {
    const match = buttons.find((el) => re.test(label(el)));
    if (match) return click(match, 'generic');
  }
  const fallback = buttons[buttons.length - 1];
  if (fallback) return click(fallback, 'generic-last');
  return { record: 'onboarding-click', clicked: false, reason: 'no-action-button' };
})()`

/** Click the New-session sidebar action. */
export const NEW_SESSION_CLICK_EXPRESSION = `(() => {
  const elements = [...document.querySelectorAll('#root button, #root a, #root [role="button"]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
  const match = elements.find((el) => /new session/iu.test(label(el)) || /\\u65b0\\u5efa\\u4f1a\\u8bdd|\\u65b0\\u4f1a\\u8bdd/u.test(label(el)));
  if (match) { match.click(); return { record: 'new-session-click', clicked: true }; }
  return { record: 'new-session-click', clicked: false };
})()`

/** Focus the composer input (last visible editable element in #root). */
export const COMPOSER_FOCUS_EXPRESSION = `(() => {
  const areas = [...document.querySelectorAll('#root textarea, #root [contenteditable="true"]')].filter((el) => {
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  });
  const target = areas[areas.length - 1] ?? null;
  if (!target) return { record: 'composer-focus', focused: false };
  target.focus();
  return { record: 'composer-focus', focused: document.activeElement === target };
})()`

/** Click the composer send button (fallback alongside the Enter path). */
export const SEND_BUTTON_CLICK_EXPRESSION = `(() => {
  const elements = [...document.querySelectorAll('#root button, #root [role="button"]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const match = elements.find((el) => /^send$|\\u53d1\\u9001/iu.test(label(el).trim()));
  if (match) { match.click(); return { record: 'send-click', clicked: true }; }
  return { record: 'send-click', clicked: false };
})()`

/** Click the composer stop control (anchored labels only). */
export const STOP_BUTTON_CLICK_EXPRESSION = `(() => {
  const elements = [...document.querySelectorAll('#root button, #root [role="button"]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const match = elements.find((el) => /^(stop|abort|cancel generation|stop generating|\\u505c\\u6b62|\\u4e2d\\u65ad)$/iu.test(label(el).trim()));
  if (match) { match.click(); return { record: 'stop-click', clicked: true }; }
  return { record: 'stop-click', clicked: false };
})()`

/** Open the Settings surface from the workspace. */
export const SETTINGS_OPEN_EXPRESSION = `(() => {
  const elements = [...document.querySelectorAll('#root button, #root a, #root [role="button"]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const match = elements.find((el) => /(^|\\s)settings($|\\s)/iu.test(label(el).trim()) || /^\\u8bbe\\u7f6e$/u.test(label(el).trim()));
  if (match) { match.click(); return { record: 'settings-open', clicked: true }; }
  return { record: 'settings-open', clicked: false };
})()`

/** Facts about the opened Settings surface (text markers only). */
export const SURFACE_FACTS_EXPRESSION = `(() => {
  const text = (document.body && document.body.innerText) || '';
  return {
    record: 'surface-facts',
    textLength: text.length,
    accountSurfaceMentioned: /account|\\u8d26\\u6237|\\u8d26\\u53f7/u.test(text),
    updatesSurfaceMentioned: /updates|\\u66f4\\u65b0/u.test(text),
    settingsSurfaceMounted: /general|theme|language|appearance|\\u901a\\u7528|\\u4e3b\\u9898|\\u8bed\\u8a00|account|\\u8d26\\u6237|updates|\\u66f4\\u65b0/u.test(text)
  };
})()`

/** Reply-visibility facts for the chat scenario (text presence only). */
export const CHAT_OBSERVE_EXPRESSION = `(function () {
  var text = (document.body && document.body.innerText) || '';
  return {
    record: 'chat-observe',
    fixtureReplyVisible: text.indexOf(${JSON.stringify(FIXTURE_REPLY_TEXT)}) !== -1,
    composerEnabled: [...document.querySelectorAll('#root textarea')].some(function (el) { return !el.disabled; })
  };
})()`

/** The settings marker round-trip through the REAL bridge (fixed constants). */
export const SETTINGS_MARKER_SET_EXPRESSION = `(async () => {
  const KEY = 'acceptance.native-marker';
  const VALUE = 'set-by-native-acceptance';
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { record: 'settings-marker', bridge: false, setResolved: false, getResolved: false, valueMatches: false };
  }
  const out = { record: 'settings-marker', bridge: true, setResolved: false, getResolved: false, valueMatches: false };
  try { await internals.invoke('settings_set', { key: KEY, value: VALUE }); out.setResolved = true; }
  catch (error) { out.setErrorKind = (error && typeof error.kind === 'string') ? error.kind.slice(0, 32) : 'rejected'; }
  try {
    const value = await internals.invoke('settings_get', { key: KEY });
    out.getResolved = true;
    out.valueMatches = value === VALUE;
  } catch (error) { out.getErrorKind = (error && typeof error.kind === 'string') ? error.kind.slice(0, 32) : 'rejected'; }
  return out;
})()`

/** Read the marker back after the graceful restart (fixed constants). */
export const SETTINGS_MARKER_GET_EXPRESSION = `(async () => {
  const KEY = 'acceptance.native-marker';
  const VALUE = 'set-by-native-acceptance';
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { record: 'settings-marker-read', bridge: false, resolved: false, valueMatches: false };
  }
  try {
    const value = await internals.invoke('settings_get', { key: KEY });
    return { record: 'settings-marker-read', bridge: true, resolved: true, valueMatches: value === VALUE };
  } catch (error) {
    return { record: 'settings-marker-read', bridge: true, resolved: false, valueMatches: false, errorKind: (error && typeof error.kind === 'string') ? error.kind.slice(0, 32) : 'rejected' };
  }
})()`

/** Read-only update status through the bridge. */
export const UPDATE_STATUS_EXPRESSION = `(async () => {
  const PHASES = ['idle', 'checking', 'available', 'downloading', 'verifying', 'installing', 'ready', 'error'];
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { record: 'update-status', bridge: false, resolved: false, phase: null, phaseKnown: false };
  }
  try {
    const value = await internals.invoke('update_status');
    return {
      record: 'update-status', bridge: true, resolved: true,
      phase: (value && typeof value.phase === 'string') ? value.phase.slice(0, 16) : null,
      phaseKnown: !!value && PHASES.indexOf(value.phase) !== -1,
    };
  } catch (error) {
    return { record: 'update-status', bridge: true, resolved: false, phase: null, phaseKnown: false, errorKind: 'rejected' };
  }
})()`

/** The graceful quit request through the bridge. */
export const QUIT_EXPRESSION = `(async () => {
  const internals = globalThis.__TAURI_INTERNALS__;
  if (!internals || typeof internals.invoke !== 'function') {
    return { record: 'quit', bridge: false, invoked: false, resolved: false };
  }
  try {
    await internals.invoke('shell_quit_request');
    return { record: 'quit', bridge: true, invoked: true, resolved: true };
  } catch (error) {
    return { record: 'quit', bridge: true, invoked: true, resolved: false, errorKind: (error && typeof error.kind === 'string') ? error.kind.slice(0, 32) : 'threw' };
  }
})()`

// ---------------------------------------------------------------------------
// Bounded waits and the child-process handle
// ---------------------------------------------------------------------------

const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms))

/**
 * Spawn the candidate with the run's environment. The child is owned: its
 * spawn-time OS identity is captured immediately, and every termination goes
 * through helpers/process-authority.mjs.
 */
async function launchCandidate({ exe, env, log }) {
  const child = nodeSpawn(exe, [], {
    env,
    cwd: dirname(exe),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const identityAtSpawn = await captureProcessIdentity(child.pid)
  log(`spawned pid ${child.pid} identity=${identityAtSpawn.status}`)
  return { child, identityAtSpawn }
}

/** Bounded wait for the owned child to exit. Resolves {exited, exitCode}. */
function waitForExit(child, timeoutMs) {
  return new Promise(resolveWait => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolveWait({ exited: true, exitCode: child.exitCode })
      return
    }
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; resolveWait({ exited: false, exitCode: null }) }
    }, timeoutMs)
    child.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveWait({ exited: true, exitCode: code })
    })
  })
}

/** Live descendant sample for the accounting (read-only, bounded). */
async function liveSubtreeOf({ identityAtSpawn, tableImpl }) {
  try {
    if (!identityAtSpawn?.available) return null
    const snapshot = await tableImpl()
    if (!snapshot.available) return null
    return descendantsOf({ host: identityAtSpawn, table: snapshot.rows, observedAtTicks: snapshot.observedAtTicks })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The orchestration (injectable for tests; probes the REAL app when run)
// ---------------------------------------------------------------------------

/**
 * Run the acceptance. Returns the full record; never throws for a check
 * failure. `inject` mirrors the probe's test seam: fetchImpl, sleepImpl,
 * spawnImpl, identityImpl, tableImpl, fixtureFactory, cdpAttach.
 *
 * @param {object} args Parsed arguments (`parseArgs`).
 * @param {object} [inject] Test seams.
 */
export async function runAcceptance(args, inject = {}) {
  const fetchImpl = inject.fetchImpl ?? ((url, options) => fetch(url, options))
  const sleepImpl = inject.sleepImpl ?? sleep
  const identityImpl = inject.identityImpl ?? captureProcessIdentity
  const tableImpl = inject.tableImpl ?? captureProcessTable
  const fixtureFactory = inject.fixtureFactory ?? createFixtureProvider
  const attachImpl = inject.cdpAttach ?? attach
  const spawnImpl = inject.spawnImpl ?? launchCandidate
  const log = inject.log ?? (() => {})
  const signal = { watchdogTripped: false }

  const startedAt = new Date().toISOString()
  const startedAtMs = Date.parse(startedAt)
  const repoRoot = args.repo ?? fileURLToPath(new URL('../../..', import.meta.url))
  const namespace = randomUUID().toLowerCase()
  const checks = []
  const push = (id, required, status, detail) => {
    checks.push({ id, required, status, detail: String(detail ?? '').slice(0, 240) })
  }

  let paths
  try {
    paths = deriveIsolationPaths({ repoRoot, namespace, stamp: args.stamp })
  } catch (error) {
    return refusedRecord(startedAt, error, args)
  }

  const record = {
    record: 'native-acceptance',
    harnessVersion: HARNESS_VERSION,
    kind: 'native-acceptance',
    nativeAcceptance: false,
    acceptanceStatement: 'This record IS the native acceptance artifact: the real candidate executable was launched under the owned credential fence and its real WebView2 was driven over native CDP. Fixture-provider chat is clearly labelled and never production traffic.',
    startedAt,
    candidate: { exe: args.exe, sha256: args.sha256, sizeBytes: null, imageKind: 'debug-required' },
    isolation: { ...paths, repoRoot },
    runtime: { runtimeDir: args.runtimeDir, shellDir: args.shellDir, nodePath: null, adapterPath: null },
    cdp: { port: args.bounds['cdp-port'], origin: `http://127.0.0.1:${args.bounds['cdp-port']}`, endpointReachable: null, browserProduct: null },
    gateway: { origin: null, boundPort: null, authenticatedUrlSeen: null, authenticatedUrlLength: null },
    boot: { ready: false, streamBaseUrlPresent: false, bootstrapBatchPresent: false, graphRevisionPresent: false },
    process: { pid: null, creationTicks: null, exeObserved: null, identityStatus: null, exitObserved: null, exitCode: null, terminatedByHarness: false, unresolvedRoots: [], hosts: [] },
    fixture: { requested: args.withFixtureChat, staged: false, patchPath: null, origin: null, port: null, facts: null },
    scenarios: { onboarding: null, surface: null, chat: null, persistence: null, accountUpdates: null, restart: null },
    checks,
    verdict: 'internal-error',
    exitCode: RUNNER_EXIT.INTERNAL,
    notEstablished: [
      'Real-platform (DeepSeek) sign-in: separately required REAL acceptance step; never faked or invented here.',
      'The candidate executable\'s own integrity attestation beyond its verified SHA-256 and observed OS process identity.',
    ],
    durationMs: null,
  }

  let child = null
  let identityAtSpawn = null
  let fixture = null
  let connection = null
  let internalErrorKind = null
  let internalErrorMessage = null

  /** Terminate the owned child on abnormal paths, with identity authority. */
  const teardownProcess = async reason => {
    if (child === null) return
    try {
      const outcome = await terminateOwnedChild({ child, identityAtSpawn, label: 'dsh-desktop', capture: identityImpl })
      record.process.terminatedByHarness = record.process.terminatedByHarness || outcome.terminated
      record.process.unresolvedRoots.push(...outcome.unresolvedRoots)
      log(`teardown (${reason}): ${outcome.note}`)
    } catch (error) {
      log(`teardown (${reason}) failed: ${boundedErrorKind(error)}`)
    }
  }

  // The in-run watchdog: bounded process lifetime for the whole harness run.
  const watchdog = setTimeout(() => {
    signal.watchdogTripped = true
    log(`WATCHDOG: total timeout ${args.bounds['total-timeout-ms']} ms exceeded; terminating the owned candidate`)
    void teardownProcess('watchdog').finally(() => {
      setTimeout(() => process.exit(RUNNER_EXIT.WATCHDOG), 1000).unref()
    })
  }, args.bounds['total-timeout-ms'])
  watchdog.unref?.()

  try {
    // -- 0. Candidate preflight -------------------------------------------------
    const candidate = await preflightCandidate({ exe: args.exe, sha256: args.sha256 })
    record.candidate.sizeBytes = candidate.sizeBytes
    push('identity.executable_hash', true, 'pass', `sha256 verified for ${candidate.sizeBytes} bytes`)

    // -- 1. Runtime payload preflight + attested interpreter ----------------------
    const runtimeDir = args.runtimeDir ?? join(repoRoot, 'port', 'runtime-payload', 'dsh')
    const shellDir = args.shellDir ?? join(repoRoot, 'port', 'ui', 'dist')
    const nodePath = join(runtimeDir, 'node', 'node.exe')
    const adapterPath = join(runtimeDir, 'adapter.mjs')
    record.runtime = { runtimeDir, shellDir, nodePath, adapterPath, executionNode: null }
    for (const [label, path] of [
      ['runtime adapter', adapterPath],
      ['pinned interpreter', nodePath],
      ['shell assets (index.html)', join(shellDir, 'index.html')],
    ]) {
      try {
        await access(path, fsConstants.F_OK)
      } catch {
        throw refusal(`${label} is missing at ${path}; assemble the candidate payload first. Nothing was launched.`)
      }
    }
    const executionNode = await resolveExecutionNode({ payloadNodePath: nodePath, nodeExe: args.nodeExe })
    record.runtime.executionNode = executionNode
    log(`interpreter: ${executionNode.source} -> ${executionNode.executionPath} (sha256 ${truncateHash(executionNode.executionSha256)})`)

    // -- 2. Fresh isolation roots (checked read-only; nothing is created yet) ----
    await assertFreshRoots(paths)

    // -- 2b. Dry run: report preflight readiness and stop BEFORE anything is
    //        created or launched. The owned root must stay fresh for the real
    //        run, so no directory is made, nothing is staged, nothing spawns.
    if (args.dryRun === true) {
      return {
        ...record,
        dryRun: true,
        verdict: 'dry-run-ok',
        exitCode: RUNNER_EXIT.PASS,
        dryRunChecks: {
          candidateHashVerified: true,
          runtimePayloadPresent: true,
          shellAssetsPresent: true,
          ownedRootFresh: true,
          runRootFresh: true,
          fixtureChatPlanned: args.withFixtureChat,
          cdpPort: args.bounds['cdp-port'],
          fixturePort: args.bounds['fixture-port'],
        },
        durationMs: Date.now() - startedAtMs,
      }
    }

    await mkdir(paths.userData, { recursive: true })
    await mkdir(paths.runRoot, { recursive: true })
    await mkdir(join(paths.ownedRoot, 'handoff-1'), { recursive: true })
    await mkdir(join(paths.ownedRoot, 'handoff-2'), { recursive: true })

    // -- 3. Fixture provider ---------------------------------------------------------
    if (args.withFixtureChat) {
      fixture = await fixtureFactory({ port: args.bounds['fixture-port'] })
      record.fixture.origin = fixture.origin
      record.fixture.port = fixture.port
      const patchPath = join(paths.home, 'cordis.patch.yml')
      await writeFile(patchPath, buildFixturePatch({ fixtureOrigin: fixture.origin }), 'utf8')
      record.fixture.patchPath = patchPath
      record.fixture.staged = true
      log(`fixture provider listening at ${fixture.origin}; patch staged at ${patchPath}`)
    }

    // -- 4. Launch (first run) ----------------------------------------------------------
    const env = buildChildEnvironment({ args, paths, nodePath: executionNode.executionPath, adapterPath, runtimeDir, shellDir, handoffIndex: 1 })
    const launched = await spawnImpl({ exe: args.exe, env, log })
    child = launched.child
    identityAtSpawn = launched.identityAtSpawn
    record.process.pid = child.pid
    record.process.creationTicks = identityAtSpawn.creationTicks
    record.process.exeObserved = identityAtSpawn.exe
    record.process.identityStatus = identityAtSpawn.status
    const firstHost = { label: 'dsh-desktop#1', pid: child.pid, identity: identityAtSpawn, exited: false, liveSubtree: null }
    record.process.hosts.push(firstHost)
    push('identity.process_identity', true, identityIsComplete({ candidate: record.candidate, process: record.process }) ? 'pass' : 'fail',
      `pid=${child.pid} status=${identityAtSpawn.status} exe observed=${identityAtSpawn.exe ?? 'unknown'}`)

    // -- 5. Readiness ---------------------------------------------------------------------
    const readiness = await waitForBoot({
      bootFile: env.DSH_DESKTOP_DEV_BOOT_FILE,
      urlFile: env.DSH_DESKTOP_DEV_URL_FILE,
      child,
      timeoutMs: args.bounds['boot-timeout-ms'],
      sleepImpl,
      log,
    })
    record.boot = readiness.boot
    if (!readiness.ready) {
      push('launch.readiness', true, 'fail',
        readiness.exitedEarly
          ? `candidate exited early with code ${readiness.exitCode} before host readiness`
          : `host did not reach readiness within ${args.bounds['boot-timeout-ms']} ms (boot.json incomplete)`)
      record.verdict = 'launch-failed'
      return finishRecord(record, { startedAtMs })
    }
    push('launch.readiness', true, 'pass', 'boot payload written; host ready and gateway attached')
    const gateway = parseGatewayUrl(readiness.gatewayUrl)
    record.gateway = {
      origin: gateway.origin,
      boundPort: gateway.boundPort,
      authenticatedUrlSeen: gateway.authenticatedUrlSeen,
      authenticatedUrlLength: gateway.authenticatedUrlLength,
    }
    push('gateway.bound_port_safe', true, gateway.boundPort !== LIVE_GUI_PORT ? 'pass' : 'fail', `bound port ${gateway.boundPort}`)

    // -- 6. CDP attach + native host identity ----------------------------------------------
    const attachOutcome = await attachWithRetry({ args, gateway, fetchImpl, sleepImpl, attachImpl, log, signal })
    connection = attachOutcome.connection
    record.cdp.endpointReachable = attachOutcome.connection !== null
    record.cdp.browserProduct = attachOutcome.browserProduct
    if (connection === null) {
      push('identity.native_host', true, 'fail', `no unique page target with the owned gateway origin (${attachOutcome.reason})`)
      record.verdict = 'target-selection-failed'
      return finishRecord(record, { startedAtMs })
    }

    const hostFacts = await connection.evaluate(HOST_FACTS_EXPRESSION, { awaitPromise: false })
    const host = classifyHost(hostFacts)
    record.scenarios.surface = { hostKind: host.kind, hostEvidence: host.evidence, ...pickFacts(hostFacts) }
    push('identity.native_host', true, host.kind === NATIVE_WEBVIEW ? 'pass' : 'fail', `${host.kind} (${host.evidence.join(', ')})`)

    const battery = await connection.evaluate(NATIVE_BATTERY_EXPRESSION)
    const whitelist = assertCommandWhitelist(battery.commandsInvoked ?? [])
    const batteryOk = battery.bridge === true
      && battery.shellAppInfo?.resolved === true
      && battery.shellAppInfo?.protocolGeneration === 4
      && battery.runtimeStatus?.state === 'ready'
      && battery.updateStatus?.phaseKnown === true
      && whitelist.ok === true
    push('bridge.native_battery', true, batteryOk ? 'pass' : 'fail',
      batteryOk ? 'app info (protocol 4), runtime ready, update phase known' : 'the native battery did not fully resolve')
    if (battery.bridge !== true) {
      record.verdict = 'bridge-missing'
      return finishRecord(record, { startedAtMs })
    }

    // -- 7. Onboarding (first run) ------------------------------------------------------------
    const onboarding = await runOnboardingScenario({ connection, timeoutMs: args.bounds['onboarding-timeout-ms'], sleepImpl, log })
    record.scenarios.onboarding = onboarding
    push('onboarding.first_run', true, onboarding.status, onboarding.detail)

    // -- 8. Shell usability ---------------------------------------------------------------------
    const usable = evaluateShellUsability(hostFacts, await connection.evaluate(HOST_FACTS_EXPRESSION, { awaitPromise: false }))
    push('shell.usable', true, usable.status, usable.detail)

    // -- 9. Fixture chat ---------------------------------------------------------------------------
    if (args.withFixtureChat && fixture !== null) {
      firstHost.liveSubtree = await liveSubtreeOf({ identityAtSpawn, tableImpl })
      const chat = await runChatScenario({ connection, fixture, timeoutMs: args.bounds['chat-timeout-ms'], sleepImpl, log })
      record.scenarios.chat = chat.facts
      push('chat.fixture_stream', true, chat.streamStatus, chat.streamDetail)
      push('chat.fixture_tool_round', true, chat.toolStatus, chat.toolDetail)
      push('chat.fixture_cancel', true, chat.cancelStatus, chat.cancelDetail)
    } else {
      push('chat.fixture_stream', false, 'not-requested', 'fixture chat not requested (--without-fixture-chat)')
      push('chat.fixture_tool_round', false, 'not-requested', 'fixture chat not requested (--without-fixture-chat)')
      push('chat.fixture_cancel', false, 'not-requested', 'fixture chat not requested (--without-fixture-chat)')
    }

    // -- 10. Settings surface + marker + updates/account ----------------------------------------------
    const surface = await runSettingsScenario({ connection, sleepImpl, log })
    record.scenarios.accountUpdates = surface
    push('settings.surface_opens', true, surface.settingsStatus, surface.settingsDetail)
    push('updates.status_resolves', true, surface.updatesStatus, surface.updatesDetail)
    push('account.surface_reachable', true, surface.accountStatus, surface.accountDetail)

    const marker = await connection.evaluate(SETTINGS_MARKER_SET_EXPRESSION)
    record.scenarios.persistence = {
      setResolved: marker.setResolved === true,
      getResolved: marker.getResolved === true,
      valueMatches: marker.valueMatches === true,
    }
    push('settings.marker_set', true, marker.setResolved && marker.getResolved && marker.valueMatches ? 'pass' : 'fail',
      `set=${marker.setResolved} get=${marker.getResolved} valueMatches=${marker.valueMatches}`)

    // -- 11. Graceful quit #1 ---------------------------------------------------------------------------
    firstHost.liveSubtree = firstHost.liveSubtree ?? await liveSubtreeOf({ identityAtSpawn, tableImpl })
    const quit1 = await gracefulQuit({ connection, child, identityAtSpawn, identityImpl, timeoutMs: args.bounds['quit-timeout-ms'], log })
    firstHost.exited = quit1.exited
    record.process.exitObserved = quit1.exited
    record.process.exitCode = quit1.exitCode
    push('teardown.graceful_exit', true, quit1.status, quit1.detail)
    try { await connection.close() } catch { /* bounded */ }
    connection = null
    if (quit1.status !== 'pass') await teardownProcess('first-quit-incomplete')

    // -- 12. Relaunch (same home/namespace, fresh handoff paths) --------------------------------------------
    const relaunch = await relaunchAndVerify({ args, paths, record, fetchImpl, sleepImpl, attachImpl, identityImpl, tableImpl, spawnImpl, log, env1: env })
    child = relaunch.child
    identityAtSpawn = relaunch.identityAtSpawn
    connection = relaunch.connection
    if (relaunch.child !== null) {
      record.process.pid = relaunch.child.pid
      record.process.creationTicks = relaunch.identityAtSpawn.creationTicks
      record.process.exeObserved = relaunch.identityAtSpawn.exe
      record.process.identityStatus = relaunch.identityAtSpawn.status
      record.process.hosts.push(relaunch.host)
    }
    record.scenarios.restart = relaunch.facts
    push('teardown.relaunch_ready', true, relaunch.readyStatus, relaunch.readyDetail)
    push('settings.persistence', true, relaunch.persistenceStatus, relaunch.persistenceDetail)
    push('onboarding.stays_completed', true, relaunch.onboardingStatus, relaunch.onboardingDetail)

    // -- 13. Final teardown ------------------------------------------------------------------------------------
    if (connection !== null) {
      const quit2 = await gracefulQuit({ connection, child, identityAtSpawn, identityImpl, timeoutMs: args.bounds['quit-timeout-ms'], log })
      if (relaunch.host !== null) relaunch.host.exited = quit2.exited
      record.process.exitObserved = quit2.exited
      record.process.exitCode = quit2.exitCode
      push('teardown.final_exit', true, quit2.status, quit2.detail)
      try { await connection.close() } catch { /* bounded */ }
      connection = null
      if (quit2.status !== 'pass') await teardownProcess('final-quit-incomplete')
    } else {
      push('teardown.final_exit', true, 'unqualified', 'no connection after relaunch; final exit could not be exercised gracefully')
      await teardownProcess('no-connection-after-relaunch')
    }

    // -- 14. Descendant accounting (read-only; never a kill) ------------------------------------------------------
    try {
      const finalSnapshot = await tableImpl()
      const settled = await settleDescendants({
        hosts: record.process.hosts.map(hostEntry => ({
          label: hostEntry.label,
          pid: hostEntry.pid,
          identity: hostEntry.identity,
          exited: hostEntry.exited,
          liveSubtree: hostEntry.liveSubtree,
          samplePhase: hostEntry.liveSubtree === null ? 'not-sampled' : 'pre-quit',
        })),
        capture: () => Promise.resolve(finalSnapshot),
        attempts: 2,
        delayMs: 500,
        sleep: sleepImpl,
      })
      record.process.descendantAccounting = {
        verified: settled.assessment.verified,
        reason: settled.assessment.reason,
        survivors: settled.assessment.survivors.length,
        perHost: settled.assessment.perHost,
      }
    } catch (error) {
      record.process.descendantAccounting = { verified: false, reason: boundedErrorKind(error) }
    }
  } catch (error) {
    if (error?.code === 'refused') {
      return refusedRecord(startedAt, error, args, { checksSoFar: checks, paths })
    }
    internalErrorKind = boundedErrorKind(error)
    internalErrorMessage = String(error?.message ?? '').slice(0, 200)
    record.internalErrorKind = internalErrorKind
    log(`internal error: ${internalErrorKind}`)
  } finally {
    if (connection !== null) {
      try { await connection.close() } catch { /* bounded */ }
    }
    if (fixture !== null) {
      try { await fixture.close() } catch { /* bounded */ }
      record.fixture.facts = fixture.facts()
    }
    if (child !== null && child.exitCode === null && child.signalCode === null) {
      await teardownProcess('end-of-run')
    }
    clearTimeout(watchdog)
  }

  record.internalErrorMessage = internalErrorMessage
  return finishRecord(record, { startedAtMs })
}

/** Assemble the child environment for launch `handoffIndex` (1 or 2). */
export function buildChildEnvironment({ args, paths, nodePath, adapterPath, runtimeDir, shellDir, handoffIndex }) {
  const env = { ...process.env }
  env.DSH_HOME = paths.home
  env.DSH_DESKTOP_USER_DATA_DIR = paths.userData
  env.DSH_DESKTOP_RUNTIME_DIR = runtimeDir
  env.DSH_DESKTOP_SHELL_DIR = shellDir
  env.DSH_DESKTOP_NODE = nodePath
  env.DSH_DESKTOP_RUNTIME_ADAPTER = adapterPath
  env.DSH_DESKTOP_DEV_URL_FILE = join(paths.ownedRoot, `handoff-${handoffIndex}`, 'gateway-url.txt')
  env.DSH_DESKTOP_DEV_BOOT_FILE = join(paths.ownedRoot, `handoff-${handoffIndex}`, 'boot.json')
  env.DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE = paths.namespace
  env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = `--remote-debugging-port=${args.bounds['cdp-port']} --remote-allow-origins=*`
  env.DSH_ACCEPTANCE_FIXTURE_KEY = FIXTURE_API_KEY
  env.RUST_LOG = 'info'
  return env
}

/** Bounded boot-payload wait. Readiness = boot.json with streamBaseUrl. */
export async function waitForBoot({ bootFile, urlFile, child, timeoutMs, sleepImpl, log }) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      return { ready: false, exitedEarly: true, exitCode: child.exitCode, boot: { ready: false }, gatewayUrl: '' }
    }
    try {
      const raw = await readFile(bootFile, 'utf8')
      const payload = JSON.parse(raw)
      if (isBootReady(payload)) {
        let gatewayUrl = ''
        try { gatewayUrl = (await readFile(urlFile, 'utf8')).trim() } catch { gatewayUrl = '' }
        return {
          ready: true,
          exitedEarly: false,
          boot: {
            ready: true,
            streamBaseUrlPresent: typeof payload.streamBaseUrl === 'string' && payload.streamBaseUrl.length > 0,
            bootstrapBatchPresent: typeof payload.bootstrapBatchUrl === 'string' && payload.bootstrapBatchUrl.length > 0,
            graphRevisionPresent: typeof payload.graphRevision === 'string' && payload.graphRevision.length > 0,
          },
          gatewayUrl,
        }
      }
    } catch {
      // not written yet (or a partial write): keep waiting, bounded
    }
    await sleepImpl(500)
  }
  void log
  return { ready: false, exitedEarly: false, boot: { ready: false }, gatewayUrl: '' }
}

/** Attach to the exact owned gateway origin, bounded, with version evidence. */
async function attachWithRetry({ args, gateway, fetchImpl, sleepImpl, attachImpl, log, signal }) {
  let browserProduct = null
  try {
    const versionResponse = await fetchImpl(`http://127.0.0.1:${args.bounds['cdp-port']}/json/version`, {
      signal: AbortSignal.timeout(3000),
    })
    const version = await versionResponse.json().catch(() => null)
    browserProduct = typeof version?.Browser === 'string' ? version.Browser.split('/')[0].slice(0, 32) : null
  } catch { /* recorded as null */ }
  void log

  const deadline = Date.now() + args.bounds['attach-wait-ms']
  for (;;) {
    if (signal.watchdogTripped) return { connection: null, reason: 'watchdog', browserProduct }
    try {
      const attached = await attachImpl({
        cdpOrigin: `http://127.0.0.1:${args.bounds['cdp-port']}`,
        canonicalOwnedOrigin: gateway.origin,
        httpTimeoutMs: 3000,
        attachWaitMs: Math.min(2000, Math.max(0, deadline - Date.now())),
        refreshIntervalMs: 300,
        commandTimeoutMs: 15000,
        webSocketImpl: undefined,
      })
      return { connection: attached.connection, reason: 'attached', browserProduct }
    } catch (error) {
      if (Date.now() >= deadline) {
        return { connection: null, reason: boundedErrorKind(error), browserProduct }
      }
      await sleepImpl(400)
    }
  }
}

/** The onboarding scenario: bounded click-through, then workspace mount. */
export async function runOnboardingScenario({ connection, timeoutMs, sleepImpl, log }) {
  const deadline = Date.now() + timeoutMs
  let appeared = false
  let clicks = 0
  let stuckReason = null
  while (Date.now() < deadline) {
    const facts = await connection.evaluate(HOST_FACTS_EXPRESSION, { awaitPromise: false })
    if (facts.onboardingPresent === true) appeared = true
    const mounted = facts.composerHintPresent === true && facts.onboardingPresent !== true && facts.bootFailureShown !== true
    if (appeared && mounted) {
      return {
        status: 'pass',
        detail: `onboarding completed after ${clicks} action(s); workspace mounted`,
        appeared, clicks, completed: true, workspaceMounted: true,
      }
    }
    if (!appeared && mounted && facts.textLength > 0) {
      // No onboarding region on a FRESH first-run home: the first-run onboarding
      // could not be exercised. Honest unqualified, never a pass.
      return {
        status: 'unqualified',
        detail: 'the workspace mounted without any first-run onboarding region appearing; first-run onboarding could not be exercised',
        appeared: false, clicks: 0, completed: false, workspaceMounted: true,
      }
    }
    if (facts.bootFailureShown === true) {
      return { status: 'fail', detail: 'the page rendered a boot-failure message during onboarding', appeared, clicks, completed: false, workspaceMounted: false }
    }
    if (facts.onboardingPresent === true && facts.onboardingBusy !== true) {
      const click = await connection.evaluate(ONBOARDING_ACTION_CLICK_EXPRESSION, { awaitPromise: false })
      if (click.clicked === true) clicks += 1
      else stuckReason = click.reason ?? 'no-action'
    }
    await sleepImpl(700)
  }
  void log
  return {
    status: appeared ? 'fail' : 'unqualified',
    detail: appeared
      ? `onboarding did not complete within ${timeoutMs} ms (${clicks} clicks, last obstacle: ${stuckReason ?? 'timeout'})`
      : 'no onboarding region and no mounted workspace within the bound',
    appeared, clicks, completed: false, workspaceMounted: false, stuckReason,
  }
}

/** Shell usability from two host-facts samples (first + post-onboarding). */
export function evaluateShellUsability(first, second) {
  const merged = { ...first }
  for (const [key, value] of Object.entries(second ?? {})) {
    if (value !== null && value !== undefined && value !== false) merged[key] = value
  }
  const composer = merged.composerHintPresent === true
  const newSession = merged.newSessionPresent === true
  const settings = merged.settingsPresent === true
  const all = composer && newSession && settings
  return {
    status: all ? 'pass' : 'fail',
    detail: `composer=${composer} newSession=${newSession} settings=${settings}`,
    composer, newSession, settings,
  }
}

/** The chat scenario: real composer input, streaming, tool round, cancel. */
export async function runChatScenario({ connection, fixture, timeoutMs, sleepImpl, log }) {
  const facts = {
    newSessionClicked: false,
    messageSent: false,
    sendPath: null,
    providerRequestSeen: false,
    authAccepted: false,
    toolRoundObserved: false,
    replyVisible: false,
    cancelRequested: false,
    stopClicked: false,
    cancelObserved: false,
    completedSlowStream: false,
  }
  const deadline = Date.now() + timeoutMs
  const before = fixture.facts().requestCount

  // New session, then type + send the fixture message through the REAL composer.
  const click = await connection.evaluate(NEW_SESSION_CLICK_EXPRESSION, { awaitPromise: false })
  facts.newSessionClicked = click.clicked === true
  await sleepImpl(700)
  const sent = await typeAndSend({ connection, text: FIXTURE_CHAT_MESSAGE, sleepImpl })
  facts.messageSent = sent.sent
  facts.sendPath = sent.path

  // Bounded wait: provider request, tool round, streamed reply visible.
  let replyAt = null
  while (Date.now() < deadline) {
    const snapshot = fixture.facts()
    if (snapshot.requestCount > before) {
      facts.providerRequestSeen = true
      facts.authAccepted = snapshot.authAcceptedCount > 0
      if (snapshot.toolRoundAnswers > 0) facts.toolRoundObserved = true
    }
    const observe = await connection.evaluate(CHAT_OBSERVE_EXPRESSION, { awaitPromise: false })
    if (observe.fixtureReplyVisible === true && replyAt === null) replyAt = Date.now()
    facts.replyVisible = observe.fixtureReplyVisible === true
    if (facts.replyVisible && (facts.toolRoundObserved || Date.now() - replyAt > 20000)) break
    await sleepImpl(600)
  }
  const finalSnapshot = fixture.facts()
  if (finalSnapshot.requestCount > before) {
    facts.providerRequestSeen = true
    facts.authAccepted = finalSnapshot.authAcceptedCount > 0
    if (finalSnapshot.toolRoundAnswers > 0) facts.toolRoundObserved = true
  }
  const streamStatus = facts.replyVisible ? 'pass' : 'fail'
  const streamDetail = facts.replyVisible
    ? 'fixture reply streamed and rendered in the real webview'
    : `no streamed reply became visible within ${timeoutMs} ms (provider requests seen: ${finalSnapshot.requestCount - before})`
  const toolStatus = facts.toolRoundObserved ? 'pass' : 'fail'
  const toolDetail = facts.toolRoundObserved
    ? `fixture requested ${FIXTURE_TOOL_NAME} and the agent executed a real tool round`
    : `no ${FIXTURE_TOOL_NAME} tool round was observed`

  // Cancel: slow stream, then a real stop click; the fixture records the abort.
  const cancelledBefore = finalSnapshot.cancelledCount
  await sleepImpl(300)
  const cancelSent = await typeAndSend({ connection, text: FIXTURE_CANCEL_MESSAGE, sleepImpl })
  facts.cancelRequested = cancelSent.sent
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleepImpl(500)
    const stop = await connection.evaluate(STOP_BUTTON_CLICK_EXPRESSION, { awaitPromise: false })
    if (stop.clicked === true) { facts.stopClicked = true; break }
  }
  const cancelDeadline = Date.now() + 15000
  while (Date.now() < cancelDeadline) {
    const snapshot = fixture.facts()
    if (snapshot.cancelledCount > cancelledBefore) { facts.cancelObserved = true; break }
    if (snapshot.completedSlowStreamCount > finalSnapshot.completedSlowStreamCount) {
      facts.completedSlowStream = true
      break
    }
    await sleepImpl(400)
  }
  const cancelStatus = facts.cancelObserved ? 'pass' : 'fail'
  const cancelDetail = facts.cancelObserved
    ? `stop control clicked (${facts.stopClicked ? 'explicit button' : 'fallback polling'}); the fixture observed the client abort`
    : `the fixture never observed an abort (stop clicked: ${facts.stopClicked}, slow stream completed instead: ${facts.completedSlowStream})`
  void log
  return { facts, streamStatus, streamDetail, toolStatus, toolDetail, cancelStatus, cancelDetail }
}

/** Type into the focused composer and send (CDP Input domain, then fallback). */
export async function typeAndSend({ connection, text, sleepImpl }) {
  const focus = await connection.evaluate(COMPOSER_FOCUS_EXPRESSION, { awaitPromise: false })
  if (focus.focused !== true) return { sent: false, path: 'no-composer' }
  await connection.send('Input.insertText', { text })
  await sleepImpl(400)
  for (const type of ['rawKeyDown', 'char', 'keyUp']) {
    await connection.send('Input.dispatchKeyEvent', {
      type,
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      ...(type === 'char' ? { text: '\r' } : {}),
    })
  }
  await sleepImpl(400)
  const fallback = await connection.evaluate(SEND_BUTTON_CLICK_EXPRESSION, { awaitPromise: false })
  return { sent: true, path: fallback.clicked === true ? 'enter+send-button' : 'enter' }
}

/** Settings surface + read-only update status + account reachability. */
export async function runSettingsScenario({ connection, sleepImpl, log }) {
  const open = await connection.evaluate(SETTINGS_OPEN_EXPRESSION, { awaitPromise: false })
  await sleepImpl(1200)
  const facts = await connection.evaluate(SURFACE_FACTS_EXPRESSION, { awaitPromise: false })
  const update = await connection.evaluate(UPDATE_STATUS_EXPRESSION)
  const settingsStatus = (open.clicked === true && facts.settingsSurfaceMounted === true) ? 'pass' : 'fail'
  const updatesStatus = update.resolved === true && update.phaseKnown === true ? 'pass' : 'fail'
  const accountStatus = facts.accountSurfaceMentioned === true ? 'pass' : 'fail'
  void log
  return {
    settingsClicked: open.clicked === true,
    settingsSurfaceMounted: facts.settingsSurfaceMounted === true,
    accountSurfaceMentioned: facts.accountSurfaceMentioned === true,
    updatesSurfaceMentioned: facts.updatesSurfaceMentioned === true,
    updatePhase: update.phase,
    settingsStatus,
    settingsDetail: `clicked=${open.clicked} surfaceMounted=${facts.settingsSurfaceMounted === true}`,
    updatesStatus,
    updatesDetail: `update_status phase=${update.phase ?? 'null'} (read-only; no update_check performed)`,
    accountStatus,
    accountDetail: `account surface text marker present=${facts.accountSurfaceMentioned === true}`,
  }
}

/** Graceful quit through the bridge, with identity-verified outcome. */
export async function gracefulQuit({ connection, child, identityImpl, timeoutMs, log }) {
  let quit = { invoked: false, resolved: false }
  try {
    quit = await connection.evaluate(QUIT_EXPRESSION)
  } catch (error) {
    log(`quit evaluate failed: ${boundedErrorKind(error)}`)
  }
  const wait = await waitForExit(child, timeoutMs)
  const identity = await identityImpl(child.pid)
  const absent = processIsAbsent(identity)
  if (wait.exited && absent) {
    return { status: 'pass', detail: `graceful quit accepted; pid ${child.pid} positively absent`, exited: true, exitCode: wait.exitCode }
  }
  if (wait.exited) {
    return { status: 'fail', detail: `process exited but absence could not be positively verified (${identity.reason ?? 'unknown'})`, exited: true, exitCode: wait.exitCode }
  }
  return { status: 'fail', detail: `the process did not exit within ${timeoutMs} ms after shell_quit_request (invoked=${quit.invoked})`, exited: false, exitCode: null }
}

/** Relaunch on the same isolated home; verify persistence + onboarding state. */
async function relaunchAndVerify({
  args, paths, record, fetchImpl, sleepImpl, attachImpl, identityImpl, tableImpl, spawnImpl, log, env1,
}) {
  const facts = { markerOnDisk: false, markerRoundTrip: false, onboardingReappeared: null }
  const env2 = { ...env1 }
  env2.DSH_DESKTOP_DEV_URL_FILE = join(paths.ownedRoot, 'handoff-2', 'gateway-url.txt')
  env2.DSH_DESKTOP_DEV_BOOT_FILE = join(paths.ownedRoot, 'handoff-2', 'boot.json')

  // On-disk settings persistence (the real settings.json in the isolated home).
  try {
    const settingsRaw = await readFile(join(paths.userData, 'settings.json'), 'utf8')
    const settings = JSON.parse(settingsRaw)
    facts.markerOnDisk = settings?.settings?.[SETTINGS_MARKER_KEY] === SETTINGS_MARKER_VALUE
  } catch { facts.markerOnDisk = false }

  const launched = await spawnImpl({ exe: args.exe, env: env2, log })
  const child = launched.child
  const identityAtSpawn = launched.identityAtSpawn
  const host = {
    label: 'dsh-desktop#2',
    pid: child.pid,
    identity: identityAtSpawn,
    exited: false,
    liveSubtree: null,
  }

  const readiness = await waitForBoot({
    bootFile: env2.DSH_DESKTOP_DEV_BOOT_FILE,
    urlFile: env2.DSH_DESKTOP_DEV_URL_FILE,
    child,
    timeoutMs: args.bounds['boot-timeout-ms'],
    sleepImpl,
    log,
  })
  if (!readiness.ready) {
    return {
      child, identityAtSpawn, host, connection: null, facts,
      readyStatus: 'fail',
      readyDetail: readiness.exitedEarly ? `second instance exited early (code ${readiness.exitCode})` : 'second instance never reached readiness',
      persistenceStatus: 'fail',
      persistenceDetail: `on-disk marker=${facts.markerOnDisk}; bridge round-trip unavailable (no readiness)`,
      onboardingStatus: 'unqualified',
      onboardingDetail: 'unavailable (no readiness)',
    }
  }
  const gateway = parseGatewayUrl(readiness.gatewayUrl)
  const attachOutcome = await attachWithRetry({ args, gateway, fetchImpl, sleepImpl, attachImpl, log, signal: { watchdogTripped: false } })
  if (attachOutcome.connection === null) {
    return {
      child, identityAtSpawn, host, connection: null, facts,
      readyStatus: 'pass',
      readyDetail: 'second launch reached readiness; CDP attach failed',
      persistenceStatus: facts.markerOnDisk ? 'unqualified' : 'fail',
      persistenceDetail: `on-disk marker=${facts.markerOnDisk}; bridge round-trip unavailable (no attach)`,
      onboardingStatus: 'unqualified',
      onboardingDetail: 'unavailable (no attach)',
    }
  }
  const connection = attachOutcome.connection
  host.liveSubtree = await liveSubtreeOf({ identityAtSpawn, tableImpl })
  const markerRead = await connection.evaluate(SETTINGS_MARKER_GET_EXPRESSION)
  facts.markerRoundTrip = markerRead.resolved === true && markerRead.valueMatches === true
  const hostFacts = await connection.evaluate(HOST_FACTS_EXPRESSION, { awaitPromise: false })
  facts.onboardingReappeared = hostFacts.onboardingPresent === true
  void record
  return {
    child, identityAtSpawn, host, connection, facts,
    readyStatus: 'pass',
    readyDetail: `second launch reached readiness (gateway ${gateway.origin})`,
    persistenceStatus: facts.markerOnDisk && facts.markerRoundTrip ? 'pass' : 'fail',
    persistenceDetail: `on-disk=${facts.markerOnDisk} bridge-round-trip=${facts.markerRoundTrip} (settings.json inside the isolated home; same owned namespace across the restart)`,
    onboardingStatus: facts.onboardingReappeared === false ? 'pass' : 'fail',
    onboardingDetail: facts.onboardingReappeared === false
      ? 'onboarding did not reappear after the graceful restart (completion persisted)'
      : 'onboarding reappeared after restart; completion did not persist',
  }
}

// ---------------------------------------------------------------------------
// Record finishing, redaction, CLI
// ---------------------------------------------------------------------------

/** Pick a bounded subset of host facts into the record. */
function pickFacts(facts) {
  return {
    documentOrigin: canonicalizeOrigin(facts.documentOrigin),
    rootChildren: facts.rootChildren,
    pluginStyles: facts.pluginStyles,
    platformMarker: facts.platformMarker,
  }
}

/**
 * The known-safe strings of one acceptance record: the verified digest, the
 * isolation paths (evidence the fence requires), and the fixture labels. The
 * leak gate is a heuristic against ACCIDENTAL secret-shaped values; these
 * recorded facts are deliberately published, so they are allow-listed by
 * exact string match — everything else (a launch token above all) must fail
 * the gate and refuse the report.
 */
export function redactionAllowList(record) {
  const allowed = []
  const add = value => { if (typeof value === 'string' && value !== '') allowed.push(value) }
  add(record?.candidate?.sha256)
  for (const key of ['ownedRoot', 'home', 'userData', 'profileDir', 'runRoot']) {
    add(record?.isolation?.[key])
  }
  add(record?.fixture?.patchPath)
  add(record?.fixture?.origin)
  add(record?.runtime?.executionNode?.referenceSha256)
  add(record?.runtime?.executionNode?.executionSha256)
  return allowed
}

function finishRecord(record, { startedAtMs }) {
  const verdict = computeVerdict({
    checks: record.checks,
    identityComplete: identityIsComplete({ candidate: record.candidate, process: record.process }),
  })
  record.checksSummary = verdict.counts
  record.missingRequiredChecks = verdict.missingRequiredChecks
  record.failedRequiredChecks = verdict.failedRequiredChecks
  record.identityComplete = verdict.identityComplete
  record.durationMs = Date.now() - startedAtMs
  if (record.internalErrorKind) {
    record.verdict = 'internal-error'
    record.exitCode = RUNNER_EXIT.INTERNAL
  } else if (verdict.acceptance) {
    record.verdict = 'pass'
    record.nativeAcceptance = true
    record.exitCode = RUNNER_EXIT.PASS
  } else if (record.verdict === 'launch-failed'
    || record.verdict === 'target-selection-failed'
    || record.verdict === 'bridge-missing') {
    record.exitCode = record.verdict === 'bridge-missing'
      ? RUNNER_EXIT.BRIDGE_MISSING
      : record.verdict === 'target-selection-failed'
        ? RUNNER_EXIT.TARGET_SELECTION
        : RUNNER_EXIT.FAILED
  } else {
    record.verdict = 'failed-check'
    record.exitCode = RUNNER_EXIT.FAILED
  }
  return record
}

function refusedRecord(startedAt, error, args, { checksSoFar = [], paths = null } = {}) {
  return {
    record: 'native-acceptance',
    harnessVersion: HARNESS_VERSION,
    kind: 'native-acceptance',
    nativeAcceptance: false,
    acceptanceStatement: 'The run was refused before or during launch; this is NOT an acceptance verdict.',
    startedAt,
    verdict: 'refused',
    exitCode: RUNNER_EXIT.REFUSED,
    refusalReason: String(error.message ?? 'refused').slice(0, 400),
    candidate: { exe: args.exe, sha256: args.sha256 },
    isolation: paths,
    checks: checksSoFar,
    durationMs: Date.now() - Date.parse(startedAt),
  }
}

const USAGE = `native-acceptance-runner.mjs — native happy-path acceptance for the assembled desktop candidate

Required:
  --exe <absolute path>     the candidate dsh-desktop.exe (DEBUG build; no globs)
  --sha256 <hex64>          the candidate executable's SHA-256 (verified pre-launch)

Optional:
  --repo <path>             repository root (default: derived from this file)
  --report <path>           where the redacted JSON record is written
  --stamp <name>            run-stamp for the evidence root
  --runtime-dir <path>      materialized runtime payload (default <repo>/port/runtime-payload/dsh)
  --shell-dir <path>        packaged shell assets (default <repo>/port/ui/dist)
  --node-exe <ABS path>     OPTIONAL byte-identical trusted copy of the payload
                            interpreter (regular non-linked file; SHA-256 must
                            exactly equal runtimeDir/node/node.exe). Used as
                            DSH_DESKTOP_NODE when the published payload image
                            inherits a problematic integrity label. Never a
                            relabel; a mismatch refuses the run.
  --cdp-port <1024-65535>   WebView2 remote-debugging port for THIS run (default 9333)
  --fixture-port <...>      local fixture-provider port (default 9471)
  --without-fixture-chat    record the chat checks as not-requested (never a pass)
  --dry-run                 verify candidate hash, payload and fresh roots, then
                            stop BEFORE creating any directory or launching
  --boot-timeout-ms --attach-wait-ms --onboarding-timeout-ms --stage-timeout-ms
  --chat-timeout-ms --quit-timeout-ms --total-timeout-ms
  --help

Isolation is mandatory: a fresh owned credential namespace per run, DSH_HOME under
the fence-derived owned root, CDP + fixture ports never 3080, bounded watchdog.
Exit codes: 0 pass, 1 failed/unqualified check, 2 refused, 3 bridge missing,
4 target selection failed, 5 watchdog, 6 internal error.
`

async function main(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n`)
    process.stderr.write(USAGE)
    return RUNNER_EXIT.REFUSED
  }
  if (args.help === true) {
    process.stderr.write(USAGE)
    return RUNNER_EXIT.PASS
  }

  const log = line => process.stderr.write(`${line}\n`)
  // Last-resort watchdog: the in-run watchdog owns the child; this one ends the
  // harness itself if everything else hung.
  const watchdog = setTimeout(() => {
    process.stderr.write(`WATCHDOG: harness total timeout ${args.bounds['total-timeout-ms']} ms exceeded\n`)
    process.exit(RUNNER_EXIT.WATCHDOG)
  }, args.bounds['total-timeout-ms'] + 15000)
  watchdog.unref?.()

  let record
  try {
    record = await runAcceptance(args, { log })
  } catch (error) {
    clearTimeout(watchdog)
    log(`INTERNAL: ${boundedErrorKind(error)}`)
    return RUNNER_EXIT.INTERNAL
  }
  clearTimeout(watchdog)

  const leaks = findSecretLikeLeaks(record, {
    allowedStrings: [...redactionAllowList(record), FIXTURE_REPLY_TEXT, FIXTURE_TOOL_NAME, FIXTURE_MODEL_ID, FIXTURE_ROUTE],
  })
  if (leaks.length > 0) {
    process.stderr.write(`REFUSED: the record would leak secret-shaped fields at: ${leaks.join(', ')}\n`)
    return RUNNER_EXIT.REFUSED
  }

  const reportPath = args.reportPath ?? (args.dryRun === true ? null : record.isolation?.reportPath)
  if (typeof reportPath === 'string') {
    try {
      await mkdir(dirname(reportPath), { recursive: true })
      await writeFile(reportPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
      log(`report written: ${reportPath}`)
    } catch (error) {
      log(`report write failed: ${boundedErrorKind(error)}`)
      return RUNNER_EXIT.INTERNAL
    }
  }

  process.stdout.write(`${JSON.stringify({
    verdict: record.verdict,
    exitCode: record.exitCode,
    acceptance: record.nativeAcceptance === true,
    checks: record.checksSummary ?? null,
    failed: record.failedRequiredChecks ?? [],
    missing: record.missingRequiredChecks ?? [],
  }, null, 2)}\n`)
  for (const check of record.checks) {
    const status = check.status === 'pass' ? 'ok  ' : check.status.slice(0, 4).padEnd(4)
    process.stderr.write(`${status} ${check.required ? '[required]' : '[optional]'} ${check.id} — ${check.detail}\n`)
  }
  process.stderr.write(`verdict: ${record.verdict} exit=${record.exitCode}\n`)
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
    process.exit(RUNNER_EXIT.INTERNAL)
  })
  main(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`INTERNAL: ${boundedErrorKind(error)}\n`)
      process.exit(RUNNER_EXIT.INTERNAL)
    },
  )
}
