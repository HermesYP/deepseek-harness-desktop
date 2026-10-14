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
 *   * The child environment is NOT the operator's. It is built through
 *     helpers/fixture-isolation.mjs — every ambient secret, endpoint, proxy,
 *     package-manager, network-trust, runtime/interpreter and WebView2 override
 *     is dropped BY NAME, and the home, app-data, temp and XDG roots become
 *     fixture-owned paths under the fence root — and the finished object is
 *     re-asserted, so only the runner's intentional `DSH_DESKTOP_*` handoff keys
 *     and its single `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` switch reach the
 *     candidate.
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
  RUNTIME_DIGEST_EXPRESSION,
  assertCommandWhitelist,
  attach,
  boundedErrorKind,
  canonicalizeOrigin,
  findSecretLikeLeaks,
  isCanonicalNonNilUuid,
} from '../native-cdp/native-cdp-probe.mjs'
import { classifyHost, NATIVE_WEBVIEW } from '../helpers/host-identity.mjs'
import {
  CONTAINED_PATH_KEYS,
  assertFixtureEnvironment,
  buildFixtureEnvironment,
  isInsideRoot,
} from '../helpers/fixture-isolation.mjs'
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
  'pty-open-timeout-ms': [3000, 120000, 20000],
  'pty-settle-timeout-ms': [2000, 60000, 15000],
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
  'payload.pty_terminate_fix_present',
  'runtime.default_node_executed',
  'pty.lane_executed',
  'pty.terminated_cleanly',
  'pty.app_healthy_after',
  'teardown.graceful_exit',
  'teardown.relaunch_ready',
  'settings.persistence',
  'onboarding.stays_completed',
  'teardown.final_exit',
])

/** Fixed, non-secret settings marker used for the persistence scenario. */
export const SETTINGS_MARKER_KEY = 'acceptance.native-marker'
export const SETTINGS_MARKER_VALUE = 'set-by-native-acceptance'

/**
 * Remove comments and string/template bodies from one line so brace counting and
 * callback detection read code only. `state` carries block-comment and quote state
 * across lines.
 */
function codeOnly(line, state) {
  let out = ''
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    const next = line[index + 1]
    if (state.blockComment === true) {
      if (char === '*' && next === '/') { state.blockComment = false; index += 1 }
      continue
    }
    if (state.quote !== null) {
      if (char === '\\') { index += 1; continue }
      if (char === state.quote) state.quote = null
      continue
    }
    if (char === '/' && next === '*') { state.blockComment = true; index += 1; continue }
    if (char === '/' && next === '/') break
    if (char === '"' || char === "'" || char === '`') { state.quote = char; continue }
    out += char
  }
  return out
}

const FUNCTION_OPENER = /function\s*[\w$]*\s*\(|\(function\b|=>\s*\{/u

/** Brace depth before and after each line, plus whether the line opens a function body. */
function codeShape(sourceText) {
  const lines = String(sourceText ?? '').split(/\r?\n/u)
  const state = { blockComment: false, quote: null }
  const code = lines.map(line => codeOnly(line, state))
  const depthBefore = new Array(code.length)
  const depthAfter = new Array(code.length)
  const opensFunction = new Array(code.length)
  let depth = 0
  for (let index = 0; index < code.length; index += 1) {
    depthBefore[index] = depth
    opensFunction[index] = FUNCTION_OPENER.test(code[index])
    let delta = 0
    for (const char of code[index]) {
      if (char === '{') delta += 1
      else if (char === '}') delta -= 1
    }
    depth += delta
    depthAfter[index] = depth
  }
  return { code, depthBefore, depthAfter, opensFunction }
}

/**
 * Whether the payload's node-pty Windows agent carries the upstream patch's
 * kill/drain fix: EVERY native kill site must reach a `_conoutSocketWorker.dispose()`
 * before the first-data listener and within the kill's own enclosing function body.
 *
 * The scan is deliberately structural rather than line-adjacent:
 *   - comment and blank lines are skipped, and a `try`/`catch` boundary is stepped
 *     over, because the real artifact puts the dispose after `catch { }` at two
 *     sites and after a comment at the patched one;
 *   - the scan stops when the enclosing function body closes, so a SIBLING
 *     method's disposal can never be credited to a kill that has none;
 *   - a disposal inside a nested function body (the first-data callback) is never
 *     accepted, because that is exactly the unpatched shape: `kill()` followed by
 *     `on('data', function () { dispose() })`, where a silently exiting process
 *     never produces the event that would drain.
 *
 * Pure over the file text.
 */
export function ptyTerminateFixPresent(sourceText) {
  const { code, depthBefore, depthAfter, opensFunction } = codeShape(sourceText)
  const killPattern = /this\._ptyNative\.kill\(this\._pty,\s*this\._useConptyDll\);/u
  const disposePattern = /_conoutSocketWorker\.dispose\(\)/u
  const sites = []
  let sitesWithImmediateDispose = 0
  for (let index = 0; index < code.length; index += 1) {
    if (!killPattern.test(code[index])) continue
    sites.push(index + 1)
    // The enclosing function body bounds the scan.
    let stopDepth = 0
    for (let above = index - 1; above >= 0; above -= 1) {
      if (opensFunction[above] === true && depthAfter[above] <= depthBefore[index]) {
        stopDepth = depthAfter[above]
        break
      }
    }
    let nestedFunctions = 0
    let drained = false
    for (let forward = index + 1; forward < code.length; forward += 1) {
      if (depthBefore[forward] < stopDepth) break
      if (opensFunction[forward] === true) nestedFunctions += 1
      if (nestedFunctions === 0 && disposePattern.test(code[forward])) { drained = true; break }
      if (depthAfter[forward] < stopDepth) break
    }
    if (drained) sitesWithImmediateDispose += 1
  }
  return {
    ok: sites.length > 0 && sitesWithImmediateDispose === sites.length,
    sites: sites.length,
    sitesWithImmediateDispose,
    killSiteLines: sites,
  }
}

const normalizeExePath = path => String(path ?? '').replace(/\//gu, '\\').toLowerCase()

/**
 * The descendant row that proves the packaged interpreter actually executed:
 * exact case-insensitive exe-path match against the exe-relative payload node.
 */
export function findNodeDescendant(rows, expectedExePath) {
  const expected = normalizeExePath(expectedExePath)
  return (Array.isArray(rows) ? rows : []).find(row => normalizeExePath(row.exe) === expected) ?? null
}

/** A single-token executable name: no spaces, no path, no localized sentence. */
const SHELL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/u

/**
 * The plain shell name the terminal TAB advertises.
 *
 * `TerminalTitle` renders the terminal's own `info.title`, and the host sets
 * `info.title = shell.name` (terminal-controller: the executable it resolved, e.g.
 * `cmd.exe` from `%ComSpec%`). Deriving the expected name from that title is what
 * lets attribution stay exact instead of guessing a shell list: a title that is
 * not a single executable-shaped token (a localized word, a renamed tab, an empty
 * or multi-word label) yields `null`, and the lane then refuses to attribute at
 * all rather than inventing a match.
 *
 * @param {unknown} title The terminal tab chip's text.
 * @returns {string|null} Lowercase name without a trailing `.exe`, or null.
 */
export function derivePlainShellName(title) {
  if (typeof title !== 'string') return null
  const value = title.trim()
  if (value === '' || !SHELL_NAME_PATTERN.test(value)) return null
  const plain = value.toLowerCase().replace(/\.exe$/u, '')
  return SHELL_NAME_PATTERN.test(plain) ? plain : null
}

/** Normalize a process row's name/exe to its comparable plain shell name. */
function plainRowName(row) {
  const raw = String(row?.name ?? row?.exe ?? '')
  const base = raw.split(/[\\/]/u).pop() ?? ''
  return derivePlainShellName(base)
}

/**
 * The PTY terminal child: a NEW descendant (pid+creationTicks not in the
 * baseline) whose process name AND executable basename both equal the shell name
 * the terminal tab reported. Name equality — not a candidate list — is what keeps
 * an unrelated one-shot `powershell.exe` probe, or any other new descendant, from
 * being adopted as the terminal shell. An unusable expected name attributes
 * nothing.
 *
 * @param {unknown} rows Descendant rows from the process table.
 * @param {unknown} baselineRows Rows sampled before the terminal was opened.
 * @param {unknown} expectedShellName `derivePlainShellName` of the tab title.
 * @returns {object|null} The matching row, or null.
 */
export function findShellChild(rows, baselineRows, expectedShellName) {
  const expected = typeof expectedShellName === 'string' ? expectedShellName : null
  if (expected === null || expected === '') return null
  const baseline = new Set((Array.isArray(baselineRows) ? baselineRows : []).map(row => `${row.pid}:${row.creationTicks}`))
  const candidates = (Array.isArray(rows) ? rows : [])
    .filter(row => !baseline.has(`${row.pid}:${row.creationTicks}`))
    .filter(row => plainRowName(row) === expected)
    .filter(row => {
      const exeBase = String(row?.exe ?? '').split(/[\\/]/u).pop() ?? ''
      return exeBase === '' ? false : derivePlainShellName(exeBase) === expected
    })
  return candidates[0] ?? null
}

/**
 * The terminal tab's own close hook: the ONE tab-close id that newly appeared
 * while the terminal session opened. The guide chip can be replaced in place (the
 * id then does not change) and other tabs can open alongside, so zero or several
 * new ids are ambiguous and select nothing; the caller then falls back to the
 * terminal-titled chip and must reject an ambiguous match there too.
 *
 * @param {unknown} beforeIds Close-hook ids mounted before the terminal entry.
 * @param {unknown} afterIds Close-hook ids mounted after the session opened.
 * @returns {{id: string|null, reason: string}} The unique new id, or why none.
 */
export function findNewTabCloseId(beforeIds, afterIds) {
  const usable = value => typeof value === 'string' && value !== ''
  const before = new Set((Array.isArray(beforeIds) ? beforeIds : []).filter(usable))
  const added = [...new Set((Array.isArray(afterIds) ? afterIds : []).filter(usable).filter(id => !before.has(id)))]
  if (added.length === 1) return { id: added[0], reason: 'exactly one new tab-close hook appeared' }
  return {
    id: null,
    reason: added.length === 0
      ? 'no new tab-close hook appeared (the entry may have replaced the guide tab in place)'
      : `${added.length} new tab-close hooks appeared`,
  }
}

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

/**
 * A typed refusal (exit 2) that never carries candidate secret material.
 *
 * @param {string} message Human-readable reason (bounded, no secrets).
 * @param {string|null} refusalCode Optional stable machine code for the specific
 *   preflight that refused, surfaced verbatim as `refusalCode` in the record.
 */
function refusal(message, refusalCode = null) {
  const error = new Error(message)
  error.code = 'refused'
  error.refusalCode = refusalCode
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
  const flagNames = new Set(['without-fixture-chat', 'without-pty-lane', 'dry-run', 'help'])

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
    withPtyLane: !flags.has('without-pty-lane'),
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

/**
 * Where the client UI comes from for one run.
 *
 * `exe-relative-default` is the packaged proof: the app must resolve its OWN
 * bundled UI beside the executable, so the child environment carries NO UI
 * override at all and the harness only reads `<exe_dir>/ui` for evidence. An
 * explicit `--shell-dir` is the development/override lane and is passed through
 * unchanged. `explicit-payload` keeps the repository default it always had.
 *
 * @param {{explicitShellDir?: string|null, runtimeMode?: string, repoRoot: string, exe: string}} options
 * @returns {{source: string, shellDir: string, envOverride: boolean}} The plan.
 */
export function resolveShellDirPlan({ explicitShellDir = null, runtimeMode = 'explicit-payload', repoRoot, exe }) {
  if (typeof explicitShellDir === 'string' && explicitShellDir !== '') {
    return { source: 'explicit-arg', shellDir: explicitShellDir, envOverride: true }
  }
  if (runtimeMode === 'exe-relative-default') {
    return { source: 'exe-relative', shellDir: join(dirname(exe), 'ui'), envOverride: false }
  }
  return { source: 'repo-default', shellDir: join(repoRoot, 'port', 'ui', 'dist'), envOverride: true }
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

/** Open the terminal surface (the client's node-pty-backed terminal lane). */
export const TERMINAL_OPEN_EXPRESSION = `(() => {
  const elements = [...document.querySelectorAll('#root button, #root a, #root [role="button"], #root [aria-label]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const match = elements.find((el) => /(^|\\s)terminal($|\\s)/iu.test(label(el).trim()) || /^\\u7ec8\\u7aef$/u.test(label(el).trim()));
  if (match) { match.click(); return { record: 'terminal-open', clicked: true }; }
  return { record: 'terminal-open', clicked: false };
})()`

/**
 * Terminal surface presence facts: the terminal surface lives ONLY in the right
 * sidebar panel (`ui-sidebar-terminal` registers the `sidebar.right.pane.tab`
 * seat), and a mounted session renders `section[data-sidebar-terminal]` whose
 * body is the xterm screen (`terminal.tsx`: `xterm.open(node)` mounts `.xterm`
 * with the `xterm-helper-textarea` input). A `[class*="terminal"]` match alone is
 * not proof: tool cards and other chrome can carry the word in a class name.
 */
export const TERMINAL_STATE_EXPRESSION = `(() => {
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  const section = panel === null ? null : panel.querySelector('[data-sidebar-terminal]');
  const screen = section === null ? null : section.querySelector('.xterm');
  const input = screen === null ? null : (screen.querySelector('textarea.xterm-helper-textarea') ?? screen.querySelector('textarea'));
  return {
    record: 'terminal-state',
    panelPresent: panel !== null,
    surfacePresent: section !== null && screen !== null,
    inputPresent: input !== null,
  };
})()`

/**
 * The tab-close hooks currently mounted in the right sidebar panel, read BEFORE
 * and AFTER the terminal entry is clicked so the terminal's own tab can be
 * identified by what newly appeared (each chip's close hook carries its tab id:
 * `ui-dockkit` TabPanel `data-dockkit-tab-close={tabId}`).
 */
export const TERMINAL_TAB_IDS_EXPRESSION = `(() => {
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  if (panel === null) return { record: 'terminal-tab-ids', panelPresent: false, ids: [] };
  const ids = [...panel.querySelectorAll('[data-dockkit-tab-close]')]
    .map((el) => el.getAttribute('data-dockkit-tab-close'))
    .filter((id) => typeof id === 'string' && id !== '');
  return { record: 'terminal-tab-ids', panelPresent: true, ids };
})()`

/** A tab id is an opaque branded id; this bounds the one embedding site. */
const MAX_TAB_ID_LENGTH = 128

/**
 * The terminal TAB CHIP for one captured tab id: its title is the terminal's own
 * `info.title` (= the host-resolved shell name, e.g. `cmd.exe`) and its close hook
 * is the control the lane later clicks. `ui-dockkit` TabPanel renders the chip as
 * `[data-dockkit-tab={tabId}]` with the close hook nested inside.
 *
 * @param {unknown} tabId The tab id captured from the panel's close hooks.
 * @returns {string|null} A page-side expression, or null for an unusable id.
 */
export function terminalTabTitleExpressionForTab(tabId) {
  if (typeof tabId !== 'string' || tabId === '' || tabId.length > MAX_TAB_ID_LENGTH) return null
  const literal = JSON.stringify(tabId)
  return `(() => {
  const target = ${literal};
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  const chip = panel === null ? null : [...panel.querySelectorAll('[data-dockkit-tab]')]
    .find((el) => el.getAttribute('data-dockkit-tab') === target) ?? null;
  if (chip === null) return { record: 'terminal-tab-title', tabId: target, chipPresent: false, title: null, closeHookId: null };
  const close = chip.querySelector('[data-dockkit-tab-close]');
  return {
    record: 'terminal-tab-title',
    tabId: target,
    chipPresent: true,
    title: (chip.textContent || '').trim(),
    closeHookId: close === null ? null : close.getAttribute('data-dockkit-tab-close')
  };
})()`
}

/** Focus the mounted terminal's own input (the xterm helper textarea). */
export const TERMINAL_FOCUS_EXPRESSION = `(() => {
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  const section = panel === null ? null : panel.querySelector('[data-sidebar-terminal]');
  const input = section === null ? null : (section.querySelector('textarea.xterm-helper-textarea') ?? section.querySelector('textarea'));
  if (input === null) return { record: 'terminal-focus', focused: false, reason: 'no-terminal-input' };
  input.focus();
  return { record: 'terminal-focus', focused: document.activeElement === input };
})()`

/**
 * EVERY visible xterm row, in order. The buffer keeps blank spacer rows below the
 * prompt, so a reader that takes the last N rows can miss the output row it is
 * looking for; this reads all of them.
 */
export const TERMINAL_ROWS_EXPRESSION = `(() => {
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  const section = panel === null ? null : panel.querySelector('[data-sidebar-terminal]');
  const rows = section === null ? null : section.querySelector('.xterm-rows');
  if (rows === null) return { record: 'terminal-rows', rowsPresent: false, rowCount: 0, texts: [] };
  const texts = [...rows.children].map((row) => (row.textContent || '').replace(/\\u00a0/gu, ' ').replace(/[ \\t]+$/u, ''));
  return { record: 'terminal-rows', rowsPresent: true, rowCount: texts.length, texts };
})()`

/**
 * The close-hook expression for ONE known tab id. The id is embedded as a JSON
 * string literal, so a DOM-supplied value is data and can never inject code; an
 * unusable id returns `null` and the caller falls back to the title-scoped
 * expression.
 *
 * @param {unknown} tabId The tab id captured from the panel's close hooks.
 * @returns {string|null} A page-side expression, or null for an unusable id.
 */
export function terminalCloseExpressionForTab(tabId) {
  if (typeof tabId !== 'string' || tabId === '' || tabId.length > MAX_TAB_ID_LENGTH) return null
  const literal = JSON.stringify(tabId)
  return `(() => {
  const target = ${literal};
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  if (panel === null) return { record: 'terminal-close', clicked: false, reason: 'no-right-sidebar-panel', tabId: target };
  const control = [...panel.querySelectorAll('[data-dockkit-tab-close]')]
    .find((el) => el.getAttribute('data-dockkit-tab-close') === target);
  if (control === undefined) return { record: 'terminal-close', clicked: false, reason: 'terminal-tab-id-not-found', tabId: target };
  control.click();
  return { record: 'terminal-close', clicked: true, matched: 'data-dockkit-tab-close', via: 'captured-new-tab-id', tabId: target };
})()`
}

/**
 * Close/terminate the terminal session through its OWN tab chip.
 *
 * The panel can hold several chips (the guide chip, other session tabs), and
 * collapsing the right panel would NOT terminate the PTY session, so only a
 * terminal-titled chip's dockkit tab-close hook is clicked; zero or several
 * matching chips are never guessed at. This is the locale-titled fallback used
 * when no single new tab-close hook appeared (`findNewTabCloseId`).
 */
export const TERMINAL_CLOSE_EXPRESSION = `(() => {
  const panel = document.querySelector('[data-sidebar-right-session]') ?? document.querySelector('[data-sidebar-right-open]');
  if (panel === null) return { record: 'terminal-close', clicked: false, reason: 'no-right-sidebar-panel' };
  const chips = [...panel.querySelectorAll('[data-dockkit-tab]')];
  const label = (chip) => {
    const span = chip.querySelector('[data-dockkit-tab-title]');
    return ((chip.getAttribute('aria-label') || '') + ' ' + (chip.textContent || '') + ' ' + (span === null ? '' : (span.textContent || ''))).trim();
  };
  const terminal = chips.filter((chip) => /terminal|\\u7ec8\\u7aef/iu.test(label(chip)));
  if (terminal.length !== 1) {
    return { record: 'terminal-close', clicked: false, reason: terminal.length === 0 ? 'no-terminal-tab' : 'ambiguous-terminal-tab', tabs: chips.length, matches: terminal.length };
  }
  const control = terminal[0].querySelector('[data-dockkit-tab-close]');
  if (control === null) return { record: 'terminal-close', clicked: false, reason: 'no-terminal-tab-close', tabs: chips.length };
  control.click();
  return { record: 'terminal-close', clicked: true, matched: 'terminal-tab-title', via: 'title-scoped', tabId: control.getAttribute('data-dockkit-tab-close') };
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
      // `terminateOwnedChild` injects `capture` as the RAW identity QUERY runner
      // (process-authority `captureProcessIdentity(pid, { run: capture })`), while
      // this runner's identity source takes a PID. Adapt at the call site so the
      // helper still performs every identity check on the real pid.
      const ownedChild = child
      const outcome = await terminateOwnedChild({
        child: ownedChild,
        identityAtSpawn,
        label: 'dsh-desktop',
        capture: () => identityImpl(ownedChild.pid),
      })
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

    // -- 1. Runtime mode, payload preflight + attested interpreter -----------------
    // Two modes:
    //   * explicit-payload (--runtime-dir given): the payload is preflighted and
    //     its paths are exported to the child (previous behaviour).
    //   * exe-relative-default (no --runtime-dir): the runner exports NO runtime
    //     overrides, so the app must resolve `exe_dir/dsh` itself — the true
    //     packaged default. The proof applies ONLY when the build actually
    //     placed the payload beside the exe (packagedCandidate.present).
    const runtimeMode = args.runtimeDir === null ? 'exe-relative-default' : 'explicit-payload'
    // The UI source is labelled and, in the packaged proof, NEVER exported to the
    // child: a repo-source UI would prove nothing about the assembled product.
    const shellDirPlan = resolveShellDirPlan({ explicitShellDir: args.shellDir, runtimeMode, repoRoot, exe: args.exe })
    const shellDir = shellDirPlan.shellDir
    const shellDirExists = async path => {
      try { await access(path, fsConstants.F_OK); return true } catch { return false }
    }
    const shellAssets = {
      source: shellDirPlan.source,
      dir: shellDir,
      envOverride: shellDirPlan.envOverride,
      indexHtmlPresent: await shellDirExists(join(shellDir, 'index.html')),
    }
    if (shellDirPlan.source === 'exe-relative') {
      log(`exe-relative UI: ${shellDir} (index.html present: ${shellAssets.indexHtmlPresent}); the child env carries NO UI override`)
      if (shellAssets.indexHtmlPresent === false) {
        // The packaged default is a proof about the ASSEMBLED product. If the build
        // did not place `<exe_dir>/ui` beside the executable, the app could only
        // fall back to some other UI, so this refuses at preflight — before any
        // directory is created, anything is spawned or a dry run reports readiness
        // — instead of recording a fact and letting a repo-source UI stand in.
        // An explicit `--shell-dir` and the explicit-payload source-UI lane are
        // deliberately unaffected: they are development lanes, not the proof.
        throw refusal(
          `the packaged default UI is missing: no index.html at ${join(shellDir, 'index.html')} beside the candidate. `
          + 'The assembled candidate must carry its own <exe_dir>/ui; nothing was launched.',
          'packaged-ui-missing',
        )
      }
    }
    const packagedCandidate = { present: false, adapterPath: null, nodePath: null, manifestPath: null, nodeSha256: null }
    let runtimeDir
    let nodePath
    let adapterPath
    if (runtimeMode === 'exe-relative-default') {
      runtimeDir = join(dirname(args.exe), 'dsh')
      nodePath = join(runtimeDir, 'node', 'node.exe')
      adapterPath = join(runtimeDir, 'adapter.mjs')
      const manifestPath = join(runtimeDir, 'desktop-runtime.json')
      const exists = async path => {
        try { await access(path, fsConstants.F_OK); return true } catch { return false }
      }
      packagedCandidate.present = (await exists(adapterPath)) && (await exists(nodePath)) && (await exists(manifestPath))
      packagedCandidate.adapterPath = adapterPath
      packagedCandidate.nodePath = nodePath
      packagedCandidate.manifestPath = manifestPath
      packagedCandidate.nodeSha256 = packagedCandidate.present ? await sha256File(nodePath) : null
    } else {
      runtimeDir = args.runtimeDir
      nodePath = join(runtimeDir, 'node', 'node.exe')
      adapterPath = join(runtimeDir, 'adapter.mjs')
    }
    record.runtime = {
      mode: runtimeMode,
      runtimeDir, shellDir, shellDirSource: shellAssets.source, shellAssets, nodePath, adapterPath,
      executionNode: null,
      packagedCandidate,
      defaultNodeProven: null,
    }
    if (runtimeMode === 'explicit-payload') {
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
    } else if (packagedCandidate.present === false) {
      log(`exe-relative payload absent at ${runtimeDir}: the app must still resolve its own runtime; the default-node proof will be not-requested`)
    }
    let executionNode = null
    if (runtimeMode === 'explicit-payload' || packagedCandidate.present) {
      executionNode = await resolveExecutionNode({ payloadNodePath: nodePath, nodeExe: args.nodeExe })
      record.runtime.executionNode = executionNode
      log(`interpreter: ${executionNode.source} -> ${executionNode.executionPath} (sha256 ${truncateHash(executionNode.executionSha256)})`)
    }

    // The node-pty Windows kill/drain fix is a REQUIRED payload fact whenever
    // the payload carries node-pty (the staging policy pins it; a missing fix
    // is a product finding, detected before any launch).
    const nodePtyAgentPath = join(runtimeDir, 'node_modules', 'node-pty', 'lib', 'windowsPtyAgent.js')
    try {
      const ptyAgentSource = await readFile(nodePtyAgentPath, 'utf8')
      const ptyFix = ptyTerminateFixPresent(ptyAgentSource)
      record.runtime.payloadNodePty = { path: nodePtyAgentPath, ...ptyFix }
      push('payload.pty_terminate_fix_present', true, ptyFix.ok ? 'pass' : 'fail',
        ptyFix.ok
          ? `all ${ptyFix.sites} native kill site(s) drain immediately (node-pty Windows agent)`
          : `only ${ptyFix.sitesWithImmediateDispose} of ${ptyFix.sites} kill site(s) drain immediately; the ConPTY-DLL branch leaks its output worker on kill`)
    } catch {
      record.runtime.payloadNodePty = { path: nodePtyAgentPath, present: false }
      push('payload.pty_terminate_fix_present', false, 'not-requested', 'the payload carries no node-pty Windows agent; the fix fact does not apply')
    }

    // The child environment is assembled HERE, before anything is created: it is
    // part of preflight, so a containment violation refuses the run (dry run
    // included) instead of surfacing after the owned root exists. The exact same
    // object is then spawned below.
    const env = buildChildEnvironment({
      args, paths,
      nodePath: executionNode?.executionPath ?? null,
      adapterPath: executionNode !== null ? adapterPath : null,
      runtimeDir: runtimeMode === 'explicit-payload' ? runtimeDir : null,
      shellDir, shellDirSource: shellAssets.source, runtimeMode, handoffIndex: 1,
    })

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
          // Truthful in EVERY mode: explicit/repo payloads already refused above
          // when index.html was missing, and the packaged default must report the
          // real `<exe_dir>/ui` it will ask the app to resolve.
          shellAssetsPresent: shellAssets.indexHtmlPresent,
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
    // Every path the child environment hands the app must EXIST before the native
    // window is created: WebView2 will not create a profile root that is missing,
    // and a real product process must not fall back to a real operator directory
    // because the fixture-owned one was absent. Each value is re-checked to be
    // inside the fence-derived owned root BEFORE creation, so the operator's real
    // home, app-data or temp directory is never created and never touched.
    for (const name of CONTAINED_PATH_KEYS) {
      const directory = env[name]
      if (typeof directory !== 'string' || directory === '') continue
      if (!isInsideRoot(directory, paths.ownedRoot)) continue
      await mkdir(directory, { recursive: true })
    }

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
    // The UI source travelled with the plan (see the preflight assembly above):
    // `exe-relative` removed every inherited override so the app must resolve its
    // own bundled UI, while an explicit `--shell-dir` was exported unchanged.
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

    // Default-packaged-node proof: in exe-relative mode with a real candidate,
    // a host descendant must actually EXECUTE the packaged interpreter.
    if (runtimeMode === 'exe-relative-default' && packagedCandidate.present) {
      const subtree = await liveSubtreeOf({ identityAtSpawn, tableImpl })
      firstHost.liveSubtree = subtree
      const nodeRow = findNodeDescendant(subtree, packagedCandidate.nodePath)
      record.runtime.defaultNodeProven = nodeRow === null
        ? { observed: false, expectedPath: packagedCandidate.nodePath }
        : { observed: true, expectedPath: packagedCandidate.nodePath, pid: nodeRow.pid, creationTicks: String(nodeRow.creationTicks), exe: nodeRow.exe }
      push('runtime.default_node_executed', true, nodeRow !== null ? 'pass' : 'fail',
        nodeRow !== null
          ? `a host descendant executes the exe-relative packaged interpreter (pid ${nodeRow.pid})`
          : `no descendant executes the packaged interpreter at ${packagedCandidate.nodePath}`)
    } else if (runtimeMode === 'exe-relative-default') {
      push('runtime.default_node_executed', false, 'not-requested', 'no exe-relative payload candidate beside the exe; the packaged-default proof does not apply')
    } else {
      push('runtime.default_node_executed', false, 'not-requested', 'explicit payload mode: the interpreter is attested separately (payload preflight / --node-exe)')
    }

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
    // Settings navigation is QUALIFIED POSITIVELY before it is used as evidence:
    // open the surface through the registered shortcut, require the mounted modal,
    // then close it positively so no later hotkey runs under an open modal.
    const settingsNavigation = await openSettings({ connection, sleepImpl })
    const settingsClose = await closeSettings({ connection, sleepImpl })
    record.scenarios.settingsNavigation = { ...settingsNavigation, ...settingsClose }
    const usable = evaluateShellUsability(hostFacts, await connection.evaluate(HOST_FACTS_EXPRESSION, { awaitPromise: false }), settingsNavigation)
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

    // -- 10b. Real PTY termination lane (client terminal UI → node-pty) --------------
    // The registered model tool (pwsh) spawns ORDINARY subprocesses; node-pty is
    // exercised by the client TERMINAL surface. The lane opens it, attributes the
    // spawned shell as a host descendant, closes the session through its own
    // control, and requires positive absence — the missing kill/drain fix would
    // leave the shell alive.
    if (args.withPtyLane) {
      const pty = await runPtyTerminationLane({ connection, tableImpl, identityAtSpawn, args, sleepImpl, log })
      record.scenarios.pty = pty.facts
      push('pty.lane_executed', true, pty.laneStatus, pty.laneDetail)
      push('pty.terminated_cleanly', true, pty.terminateStatus, pty.terminateDetail)
      push('pty.app_healthy_after', true, pty.healthStatus, pty.healthDetail)
    } else {
      push('pty.lane_executed', false, 'not-requested', 'pty lane not requested (--without-pty-lane)')
      push('pty.terminated_cleanly', false, 'not-requested', 'pty lane not requested (--without-pty-lane)')
      push('pty.app_healthy_after', false, 'not-requested', 'pty lane not requested (--without-pty-lane)')
    }

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
    const relaunch = await relaunchAndVerify({ args, paths, record, fetchImpl, sleepImpl, attachImpl, identityImpl, tableImpl, spawnImpl, log, env1: env, initialOnboarding: onboarding })
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

/**
 * Endpoint overrides the shared fixture-isolation deny rules do not name.
 *
 * The shared policy denies secrets, proxies, package-manager, network-trust and
 * runtime/interpreter overrides by NAME, but the shipping endpoint overrides —
 * `DEEPSEEK_BASE_URL`, its search sibling `DEEPSEEK_SEARCH_BASE_URL`, and
 * `SEARCH_BASE_URL` — match none of those patterns: an ambient value would point
 * a fixture run at a real service, or bypass the staged fixture patch that is
 * supposed to be its only network target. They are removed here by NAME as well;
 * no value is ever read, and nothing but the name is recorded.
 */
const RUNNER_ENDPOINT_DENY_PATTERN = /^(?:DEEPSEEK(?:_SEARCH)?|SEARCH)_(?:BASE_?URL|API_?URL|ENDPOINT)$/iu

/**
 * Classify one environment variable NAME against the runner-only deny rules.
 *
 * @param {string} name Variable name. Windows names are case-insensitive, so the
 *   match is case-insensitive too.
 * @returns {string|null} The runner-only deny category, or null.
 */
export function classifyRunnerOnlyEnvName(name) {
  return RUNNER_ENDPOINT_DENY_PATTERN.test(String(name)) ? 'endpoint-override' : null
}

/** Runner-only denied names that reached the finished env without being owned. */
function runnerOnlyEnvViolations(env, ownedNames) {
  const violations = []
  for (const name of Object.keys(env)) {
    const category = classifyRunnerOnlyEnvName(name)
    if (category !== null && !ownedNames.has(name)) {
      violations.push(`env ${name} reached the child (${category}) without an intentional fixture value`)
    }
  }
  return violations
}

/**
 * Assemble the child environment for launch `handoffIndex` (1 or 2).
 *
 * The environment is NOT `process.env` with a few keys overwritten. It is built
 * through the shared fixture-isolation policy first (helpers/fixture-isolation.mjs):
 * every ambient secret, endpoint, proxy, package-manager, network-trust and
 * runtime/interpreter override is dropped BY NAME, and the home, app-data, temp
 * and XDG roots become fixture-owned paths under `paths.ownedRoot`. Only the
 * runner's own intentional values — the controlled `DSH_DESKTOP_*` handoff,
 * namespace and fixture keys plus the one `WEBVIEW2_*` debugging switch — are
 * written back, and the finished object is re-asserted before it can be spawned.
 * A violation is a refusal, so an ambient value can never quietly accompany the
 * run, and the packaged default still removes every runtime and UI override while
 * an explicit source override is preserved.
 *
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.inherited] The parent environment to
 *   sanitize. Defaults to `process.env`; tests inject a fake envelope instead.
 * @returns {Record<string,string>} The contained child environment.
 */
export function buildChildEnvironment({
  args, paths, nodePath, adapterPath, runtimeDir, shellDir, runtimeMode = 'explicit-payload', handoffIndex,
  shellDirSource = runtimeMode === 'exe-relative-default' ? 'exe-relative' : 'repo-default',
  inherited = process.env,
}) {
  const built = buildFixtureEnvironment({ inherited, root: paths.ownedRoot, home: paths.home })
  const env = built.env
  const ownedNames = new Set(built.ownedKeys)
  // Endpoint overrides the shared rules do not name are removed here too.
  for (const name of Object.keys(env)) {
    const category = classifyRunnerOnlyEnvName(name)
    if (category === null || ownedNames.has(name)) continue
    delete env[name]
    built.stripped.push({ name, reason: category })
    built.categories[category] = (built.categories[category] ?? 0) + 1
  }
  /** Write one intentional fixture value and register it as owned. */
  const own = (name, value) => {
    if (value === undefined || value === null || value === '') return
    env[name] = value
    ownedNames.add(name)
  }
  own('DSH_HOME', paths.home)
  own('DSH_DESKTOP_USER_DATA_DIR', paths.userData)
  // Runtime and UI overrides are never INHERITED: they exist only in the mode
  // that intentionally exports them, and the packaged default exports neither.
  for (const name of ['DSH_DESKTOP_RUNTIME_DIR', 'DSH_DESKTOP_NODE', 'DSH_DESKTOP_RUNTIME_ADAPTER', 'DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'DSH_DESKTOP_SHELL_DIR']) {
    delete env[name]
  }
  if (runtimeMode !== 'exe-relative-default') {
    own('DSH_DESKTOP_RUNTIME_DIR', runtimeDir)
    own('DSH_DESKTOP_NODE', nodePath)
    own('DSH_DESKTOP_RUNTIME_ADAPTER', adapterPath)
  }
  if (shellDirSource !== 'exe-relative') own('DSH_DESKTOP_SHELL_DIR', shellDir)
  own('DSH_DESKTOP_DEV_URL_FILE', join(paths.ownedRoot, `handoff-${handoffIndex}`, 'gateway-url.txt'))
  own('DSH_DESKTOP_DEV_BOOT_FILE', join(paths.ownedRoot, `handoff-${handoffIndex}`, 'boot.json'))
  own('DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE', paths.namespace)
  own('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', `--remote-debugging-port=${args.bounds['cdp-port']} --remote-allow-origins=*`)
  own('DSH_ACCEPTANCE_FIXTURE_KEY', FIXTURE_API_KEY)
  own('RUST_LOG', 'info')
  const violations = [
    ...assertFixtureEnvironment(env, {
      root: paths.ownedRoot,
      controlled: false,
      ownedKeys: [...ownedNames],
      inherited,
    }),
    ...runnerOnlyEnvViolations(env, ownedNames),
  ]
  if (violations.length > 0) {
    throw refusal(`the child environment is not contained: ${violations.join('; ')}`, 'env-containment')
  }
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
/**
 * Positive Settings mount probe. The settings surface is a shortcut modal
 * (`[data-shortcut-modal='settings']`, role=dialog, aria-modal) and is the ONLY
 * honest evidence that Settings navigation worked: the sidebar's trigger is an
 * ICON-ONLY button whose text label renders solely in the wide sidebar
 * (`ui-settings-general/src/client/chrome.tsx:22-29`: `{wide && <span …>}`), so a
 * label-based or text-presence test can neither find nor rule out the surface.
 */
export const SETTINGS_MOUNTED_EXPRESSION = `(() => {
  const modal = document.querySelector("[data-shortcut-modal='settings'][role='dialog'][aria-modal='true']");
  return { record: 'settings-mounted', mounted: modal !== null };
})()`

/** Move focus off the composer before dispatching a page-region shortcut. */
export const BLUR_ACTIVE_EXPRESSION = `(() => {
  const active = document.activeElement;
  if (active && typeof active.blur === 'function') active.blur();
  if (document.body && typeof document.body.focus === 'function') document.body.focus();
  return { record: 'blur-active', blurred: true };
})()`

/** Right-sidebar state: the terminal lives only inside it (see TERMINAL_ENTRY). */
export const SIDEBAR_RIGHT_STATE_EXPRESSION = `(() => ({
  record: 'sidebar-right-state',
  open: document.querySelector('[data-sidebar-right-open]') !== null,
  expandAvailable: document.querySelector('[data-sidebar-right-expand]') !== null,
  session: document.querySelector('[data-sidebar-right-session]') !== null
}))()`

/** Open the right sidebar through its own header-corner control. */
export const SIDEBAR_RIGHT_OPEN_EXPRESSION = `(() => {
  if (document.querySelector('[data-sidebar-right-open]') !== null) {
    return { record: 'sidebar-right-open', clicked: false, alreadyOpen: true };
  }
  const expand = document.querySelector('[data-sidebar-right-expand]');
  if (expand === null) return { record: 'sidebar-right-open', clicked: false, alreadyOpen: false, reason: 'no-expand-control' };
  expand.click();
  return { record: 'sidebar-right-open', clicked: true, alreadyOpen: false };
})()`

/**
 * Click the terminal entry INSIDE the right sidebar. `ui-sidebar-terminal`
 * registers only right-sidebar seats (`sidebar.right.tab.guide.entry`,
 * `sidebar.right.pane.tab`); there is no top-level terminal control, so the
 * panel must already be open.
 */
export const TERMINAL_ENTRY_EXPRESSION = `(() => {
  const scope = document.querySelector('[data-sidebar-right-session]')
    ?? document.querySelector('[data-sidebar-right-open]') ?? document;
  const elements = [...scope.querySelectorAll('button, [role="button"], a, [aria-label]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  const match = elements.find((el) => /new terminal|new shell|\\u65b0\\u5efa\\u7ec8\\u7aef/iu.test(label(el)))
    ?? elements.find((el) => /(^|\\s)terminal($|\\s)/iu.test(label(el).trim()));
  if (match) { match.click(); return { record: 'terminal-open', clicked: true, via: 'right-sidebar-entry' }; }
  return { record: 'terminal-open', clicked: false, via: 'right-sidebar-entry' };
})()`

/**
 * Open Settings through the REGISTERED `settings.open` shortcut (desktop default
 * `primary+Comma`, `ui-settings-general/src/client/index.ts:179-187`). The
 * shortcut is locale-free and independent of sidebar width, which the icon-only
 * trigger is not. A dispatched key is never itself a pass: the caller must still
 * observe `SETTINGS_MOUNTED_EXPRESSION`.
 */
export async function openSettings({ connection, sleepImpl, timeoutMs = 8000 }) {
  const already = await connection.evaluate(SETTINGS_MOUNTED_EXPRESSION, { awaitPromise: false })
  if (already.mounted === true) return { opened: true, dispatched: false, how: 'already-mounted' }
  await connection.evaluate(BLUR_ACTIVE_EXPRESSION, { awaitPromise: false })
  await sleepImpl(150)
  for (const type of ['rawKeyDown', 'keyUp']) {
    await connection.send('Input.dispatchKeyEvent', {
      type, key: ',', code: 'Comma', windowsVirtualKeyCode: 188, nativeVirtualKeyCode: 188, modifiers: 2,
      ...(type === 'rawKeyDown' ? { text: ',' } : {}),
    })
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await connection.evaluate(SETTINGS_MOUNTED_EXPRESSION, { awaitPromise: false })
    if (probe.mounted === true) return { opened: true, dispatched: true, how: 'shortcut-primary+Comma' }
    if (Date.now() >= deadline) return { opened: false, dispatched: true, how: 'shortcut-primary+Comma' }
    await sleepImpl(200)
  }
}

/** Close Settings positively (Escape) so no hotkey is dispatched under a modal. */
export async function closeSettings({ connection, sleepImpl, timeoutMs = 6000 }) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await connection.evaluate(SETTINGS_MOUNTED_EXPRESSION, { awaitPromise: false })
    if (probe.mounted !== true) return { closed: true }
    if (Date.now() >= deadline) return { closed: false }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await connection.send('Input.dispatchKeyEvent', {
        type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      })
    }
    await sleepImpl(250)
  }
}

/**
 * Whether onboarding completion persisted across the restart.
 *
 * Absence of the first-run region on the SECOND launch proves nothing on its own:
 * a run that never displayed onboarding also shows nothing after the restart. The
 * fact is only qualified when the FIRST run positively appeared and completed.
 */
export function evaluateStaysCompleted({ firstRunAppeared, firstRunCompleted, reappeared }) {
  if (firstRunAppeared !== true || firstRunCompleted !== true) {
    return {
      status: 'unqualified',
      detail: 'the first run did not positively appear and complete first-run onboarding'
        + ` (appeared=${firstRunAppeared === true} completed=${firstRunCompleted === true}),`
        + ' so absence after the restart cannot evidence persistence;'
        + ' the visual first-run flow needs a real signed-in account action',
    }
  }
  if (reappeared === false) return { status: 'pass', detail: 'onboarding did not reappear after the restart; completion persisted' }
  if (reappeared === true) return { status: 'fail', detail: 'onboarding reappeared after the restart; completion did not persist' }
  return { status: 'unqualified', detail: 'the restart did not report whether onboarding reappeared' }
}

/**
 * Shell usability. The Settings term is a POSITIVE navigation outcome, never the
 * presence of the word "settings" in page text: the trigger is icon-only in the
 * collapsed sidebar, so text presence neither proves nor disproves that Settings
 * can be reached.
 */
export function evaluateShellUsability(first, second, settingsNavigation = null) {
  const merged = { ...first }
  for (const [key, value] of Object.entries(second ?? {})) {
    if (value !== null && value !== undefined && value !== false) merged[key] = value
  }
  const composer = merged.composerHintPresent === true
  const newSession = merged.newSessionPresent === true
  const settings = settingsNavigation !== null && settingsNavigation.opened === true
  const all = composer && newSession && settings
  return {
    status: all ? 'pass' : 'fail',
    detail: `composer=${composer} newSession=${newSession} settings=${settings}`
      + (settingsNavigation === null ? ' (settings navigation was not attempted)' : ` (via ${settingsNavigation.how})`),
    composer, newSession, settings,
    settingsNavigation,
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

/**
 * The real PTY termination lane: open the client's terminal surface, attribute
 * the spawned shell as a NEW host descendant (read-only CIM attribution; the
 * harness never terminates the shell itself), require the MOUNTED terminal
 * surface (its xterm screen and input) inside the right sidebar, close the
 * session through its own tab chip, and require the shell's POSITIVE absence
 * within a bounded settle window. The shell must be provably alive when the close
 * is requested, and the tab-close control must be provably clicked: absence alone
 * could be a natural exit. A node-pty Windows agent missing the kill/drain fix
 * leaves the shell alive and fails this lane.
 */
export async function runPtyTerminationLane({ connection, tableImpl, identityAtSpawn, args, sleepImpl, log }) {
  const facts = {
    openClicked: false,
    openVia: null,
    sidebarRightClicked: false,
    sidebarRightOpen: false,
    panelPresent: null,
    surfacePresent: null,
    inputPresent: null,
    child: null,
    tabIdsBefore: [],
    tabIdsAfter: [],
    newTabCloseId: null,
    newTabCloseReason: null,
    terminalTabId: null,
    terminalTabTitle: null,
    expectedShellName: null,
    terminalInputFocused: null,
    echoTyped: false,
    echoRowsPresent: null,
    echoRowCount: null,
    echoOutputRowObserved: false,
    echoOutputRowIndex: -1,
    echoCommandRowIndex: -1,
    closeTabId: null,
    closeVia: null,
    presentBeforeClose: null,
    closeClicked: false,
    closeReason: null,
    terminatedCleanly: false,
    tableAvailable: true,
    appStateAfter: null,
  }
  let baselineChildren = []
  try {
    const baseline = await tableImpl()
    facts.tableAvailable = baseline.available === true
    if (baseline.available === true) {
      baselineChildren = descendantsOf({ host: identityAtSpawn, table: baseline.rows, observedAtTicks: baseline.observedAtTicks })
    }
  } catch (error) {
    facts.tableAvailable = false
    facts.baselineErrorKind = boundedErrorKind(error)
  }

  // The terminal lives ONLY inside the right sidebar: `ui-sidebar-terminal`
  // registers `sidebar.right.tab.guide.entry` / `sidebar.right.pane.tab` and its
  // header-action and overlay registrations are commented out. So open the panel
  // through its own control first, then click the entry INSIDE it. No top-level
  // terminal control exists, and none is guessed at.
  const sidebar = await connection.evaluate(SIDEBAR_RIGHT_OPEN_EXPRESSION, { awaitPromise: false })
  let sidebarState = { open: false, session: false }
  const sidebarDeadline = Date.now() + 8000
  for (;;) {
    sidebarState = await connection.evaluate(SIDEBAR_RIGHT_STATE_EXPRESSION, { awaitPromise: false })
    if (sidebarState.open === true || Date.now() >= sidebarDeadline) break
    await sleepImpl(250)
  }
  facts.sidebarRightClicked = sidebar.clicked === true
  facts.sidebarRightOpen = sidebarState.open === true
  // Baseline tab-close hooks, read with the panel open and BEFORE the entry is
  // clicked: the terminal tab is then the one whose close hook newly appeared.
  const tabIdsBefore = await connection.evaluate(TERMINAL_TAB_IDS_EXPRESSION, { awaitPromise: false }).catch(() => ({ ids: [] }))
  facts.tabIdsBefore = Array.isArray(tabIdsBefore.ids) ? tabIdsBefore.ids : []
  let open = await connection.evaluate(TERMINAL_ENTRY_EXPRESSION, { awaitPromise: false })
  if (open.clicked !== true && facts.sidebarRightOpen === true) {
    // Documented alternative entry: the registered `terminal.new` shortcut
    // (Ctrl+Backquote under the current session).
    for (const type of ['rawKeyDown', 'keyUp']) {
      await connection.send('Input.dispatchKeyEvent', {
        type, key: '`', code: 'Backquote', windowsVirtualKeyCode: 192, nativeVirtualKeyCode: 192, modifiers: 2,
      })
    }
    await sleepImpl(800)
    open = { clicked: true, via: 'shortcut-terminal.new' }
  }
  facts.openClicked = open.clicked === true
  // A failed entry click has no mechanism to report: `openVia` names how the
  // terminal was actually opened, or null when it was not.
  facts.openVia = open.clicked === true ? (open.via ?? 'right-sidebar-entry') : null

  // The terminal's OWN tab must positively appear, and its chip title names the
  // shell the host resolved (`info.title = shell.name`). That title is the ONLY
  // attribution authority: no candidate shell list is consulted, and a title that
  // is not a single executable-shaped name attributes nothing.
  const openWaitMs = Math.min(args.bounds['pty-open-timeout-ms'], 15000)
  const tabDeadline = Date.now() + openWaitMs
  for (;;) {
    facts.tabIdsAfter = await connection.evaluate(TERMINAL_TAB_IDS_EXPRESSION, { awaitPromise: false })
      .then(ids => (Array.isArray(ids.ids) ? ids.ids : []))
      .catch(() => facts.tabIdsAfter)
    const appeared = findNewTabCloseId(facts.tabIdsBefore, facts.tabIdsAfter)
    facts.newTabCloseId = appeared.id
    facts.newTabCloseReason = appeared.reason
    if (appeared.id !== null) {
      const titleExpression = terminalTabTitleExpressionForTab(appeared.id)
      if (titleExpression !== null) {
        const chip = await connection.evaluate(titleExpression, { awaitPromise: false }).catch(() => null)
        if (chip !== null && chip.chipPresent === true) {
          facts.terminalTabId = appeared.id
          facts.terminalTabTitle = typeof chip.title === 'string' ? chip.title : null
          break
        }
      }
    }
    if (Date.now() >= tabDeadline) break
    await sleepImpl(400)
  }
  const expectedShell = derivePlainShellName(facts.terminalTabTitle)
  facts.expectedShellName = expectedShell
  void log

  let child = null
  const openDeadline = Date.now() + openWaitMs
  while (Date.now() < openDeadline && child === null && expectedShell !== null) {
    try {
      const snapshot = await tableImpl()
      if (snapshot.available === true) {
        const subtree = descendantsOf({ host: identityAtSpawn, table: snapshot.rows, observedAtTicks: snapshot.observedAtTicks })
        child = findShellChild(subtree, baselineChildren, expectedShell)
      }
    } catch { /* bounded retry */ }
    if (child === null) await sleepImpl(500)
  }

  // Positive UI qualification: an attributed shell descendant is not a mounted
  // terminal surface, so the xterm screen and its input must be observed inside
  // the right sidebar before this lane may pass.
  let state = { panelPresent: false, surfacePresent: false, inputPresent: false }
  const uiDeadline = Date.now() + args.bounds['pty-open-timeout-ms']
  for (;;) {
    state = await connection.evaluate(TERMINAL_STATE_EXPRESSION, { awaitPromise: false })
    if ((state.surfacePresent === true && state.inputPresent === true) || Date.now() >= uiDeadline) break
    await sleepImpl(400)
  }
  facts.panelPresent = state.panelPresent === true
  facts.surfacePresent = state.surfacePresent === true
  facts.inputPresent = state.inputPresent === true
  if (child !== null) {
    facts.child = { pid: child.pid, exe: child.exe, creationTicks: String(child.creationTicks) }
  }

  // The shell must have EXECUTED, not merely existed: one harmless `echo` of a
  // generated nonce must come back as its OWN output row. The echoed command line
  // contains the same nonce, so only an exact whole-row match evidences execution.
  let echoRowIndex = -1
  let echoCommandRowIndex = -1
  if (child !== null && facts.inputPresent === true) {
    const nonce = `DSHACC${randomUUID().replace(/-/gu, '').slice(0, 8)}`
    const command = `echo ${nonce}`
    const focus = await connection.evaluate(TERMINAL_FOCUS_EXPRESSION, { awaitPromise: false }).catch(() => ({ focused: false }))
    facts.terminalInputFocused = focus.focused === true
    if (focus.focused === true) {
      await connection.send('Input.insertText', { text: command })
      // The live-verified key sequence for the xterm input: rawKeyDown + keyUp
      // only (a `char` event would deliver the carriage return twice).
      for (const type of ['rawKeyDown', 'keyUp']) {
        await connection.send('Input.dispatchKeyEvent', {
          type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        })
      }
      facts.echoTyped = true
      const echoDeadline = Date.now() + openWaitMs
      for (;;) {
        const rows = await connection.evaluate(TERMINAL_ROWS_EXPRESSION, { awaitPromise: false })
          .catch(() => ({ rowsPresent: false, rowCount: 0, texts: [] }))
        facts.echoRowsPresent = rows.rowsPresent === true
        const texts = Array.isArray(rows.texts) ? rows.texts : []
        facts.echoRowCount = Number.isInteger(rows.rowCount) ? rows.rowCount : texts.length
        echoRowIndex = texts.findIndex(text => String(text).trim() === nonce)
        echoCommandRowIndex = texts.findIndex(text => String(text).includes(command))
        if (echoRowIndex >= 0 || Date.now() >= echoDeadline) break
        await sleepImpl(200)
      }
    }
  }
  facts.echoOutputRowObserved = echoRowIndex >= 0
  facts.echoOutputRowIndex = echoRowIndex
  facts.echoCommandRowIndex = echoCommandRowIndex

  if (child === null) {
    const health = await connection.evaluate(RUNTIME_DIGEST_EXPRESSION).catch(() => ({ resolved: false, state: null }))
    facts.appStateAfter = health.state ?? null
    const reason = facts.terminalTabId === null
      ? `no new terminal tab appeared within ${openWaitMs} ms (${facts.newTabCloseReason ?? 'no tab-close hook'})`
      : expectedShell === null
        ? `the terminal tab title ${JSON.stringify(facts.terminalTabTitle)} is not a single executable shell name, so no descendant can be attributed without guessing`
        : `no new descendant matching the terminal's own shell name "${expectedShell}" appeared within ${openWaitMs} ms`
    return {
      facts,
      laneStatus: 'fail',
      laneDetail: `terminal entry opened=${facts.openClicked} (${facts.openVia ?? 'no-entry'}, baselineTable=${facts.tableAvailable === true}); ${reason} (surface present: ${facts.surfacePresent}, input present: ${facts.inputPresent})`,
      terminateStatus: 'unqualified',
      terminateDetail: 'no terminal child was attributed, so termination could not be exercised',
      healthStatus: health.resolved === true && health.state === 'ready' ? 'pass' : 'fail',
      healthDetail: `app state after lane: ${health.state ?? 'unknown'}`,
    }
  }

  // The terminal's OWN tab, identified by the unique close hook that appeared,
  // whose chip title named the shell. A replaced guide chip or a second new tab
  // makes the id ambiguous, so the close falls back to the terminal-TITLED chip,
  // which itself refuses several matches.
  facts.closeTabId = facts.terminalTabId
  const scopedClose = terminalCloseExpressionForTab(facts.terminalTabId)
  const closeExpression = scopedClose ?? TERMINAL_CLOSE_EXPRESSION

  // The shell must be POSITIVELY present at the moment the close is requested:
  // a later absence only evidences tab-close teardown when it provably started
  // alive, and an unreadable table is never proof of anything.
  try {
    const beforeClose = await tableImpl()
    facts.presentBeforeClose = beforeClose.available !== true
      ? null
      : beforeClose.rows.some(row => row.pid === child.pid && String(row.creationTicks) === String(child.creationTicks))
  } catch { facts.presentBeforeClose = null }

  // The terminal tab is closed even when the UI qualification failed: the shell
  // this lane owns must never be leaked just because the lane cannot pass.
  const close = await connection.evaluate(closeExpression, { awaitPromise: false })
  facts.closeClicked = close.clicked === true
  facts.closeReason = close.clicked === true ? null : (close.reason ?? 'no-close-control')
  facts.closeVia = close.clicked === true
    ? (close.via ?? (scopedClose === null ? 'title-scoped' : 'captured-new-tab-id'))
    : null
  if (typeof close.tabId === 'string' && close.tabId !== '') facts.closeTabId = close.tabId

  let terminated = false
  let lastTableAvailable = true
  const settleDeadline = Date.now() + args.bounds['pty-settle-timeout-ms']
  while (Date.now() < settleDeadline) {
    let stillAlive = null
    try {
      const snapshot = await tableImpl()
      lastTableAvailable = snapshot.available === true
      if (snapshot.available === true) {
        stillAlive = snapshot.rows.some(row => row.pid === child.pid && String(row.creationTicks) === String(child.creationTicks))
      }
    } catch { lastTableAvailable = false }
    if (lastTableAvailable === true && stillAlive === false) { terminated = true; break }
    await sleepImpl(400)
  }
  facts.terminatedCleanly = terminated

  const health = await connection.evaluate(RUNTIME_DIGEST_EXPRESSION).catch(() => ({ resolved: false, state: null }))
  facts.appStateAfter = health.state ?? null

  // The lane may pass ONLY when it positively opened the terminal, knew the
  // pre-open descendant baseline, observed the mounted terminal surface with its
  // input inside the right sidebar, attributed a descendant by the shell name the
  // tab itself reported, and saw that shell execute the harmless echo nonce as its
  // own output row. An unknown baseline cannot tell a NEW shell from one that
  // pre-existed; a terminal the lane never opened is not evidence the client can
  // open one; and a descendant that never executed is not a working terminal.
  const uiQualified = facts.panelPresent === true && facts.surfacePresent === true && facts.inputPresent === true
  const openQualified = facts.openClicked === true && facts.tableAvailable === true
  const shellQualified = facts.expectedShellName !== null && facts.child !== null
  const echoQualified = facts.echoOutputRowObserved === true
  const laneStatus = openQualified && uiQualified && shellQualified && echoQualified ? 'pass' : 'fail'
  const laneDetail = laneStatus === 'pass'
    ? `terminal opened (${facts.openVia ?? 'entry'}) against a known pre-open baseline; the child matching the tab's own shell name "${facts.expectedShellName}" was attributed (pid ${child.pid}, ${child.exe ?? 'unknown exe'}) and executed the echo nonce as its own output row (row ${facts.echoOutputRowIndex} of ${facts.echoRowCount})`
    : `the terminal lane was not positively qualified: open=${facts.openClicked === true} (${facts.openVia ?? 'no-entry'}) baselineTable=${facts.tableAvailable === true} panel=${facts.panelPresent === true} surface=${facts.surfacePresent === true} input=${facts.inputPresent === true} shellName=${facts.expectedShellName ?? 'unusable'} echoOutputRow=${facts.echoOutputRowObserved === true} (attributed shell pid ${child.pid})`

  let terminateStatus
  let terminateDetail
  if (facts.presentBeforeClose !== true) {
    terminateStatus = 'unqualified'
    terminateDetail = facts.presentBeforeClose === null
      ? `the process table could not positively confirm the terminal shell (pid ${child.pid}) before the close request, so its later absence cannot evidence tab-close teardown`
      : `the terminal shell (pid ${child.pid}) had already exited before the close request; a natural exit cannot evidence tab-close teardown`
  } else if (facts.closeClicked !== true) {
    terminateStatus = 'fail'
    terminateDetail = `the terminal tab close control was never positively clicked (${facts.closeReason ?? 'unknown reason'}; ${facts.newTabCloseReason ?? 'no tab-close id'}), so the shell's ${terminated ? 'disappearance' : 'survival'} cannot evidence tab-close teardown`
  } else if (terminated) {
    terminateStatus = 'pass'
    terminateDetail = `the terminal tab close control (${facts.closeVia ?? 'tab-close'}${facts.closeTabId === null ? '' : `, tab ${facts.closeTabId}`}) was clicked with the shell positively alive (pid ${child.pid}) and it reached positive absence within ${args.bounds['pty-settle-timeout-ms']} ms (last table available: ${lastTableAvailable})`
  } else {
    terminateStatus = 'fail'
    terminateDetail = `the terminal shell (pid ${child.pid}) survived the settle window after the tab close control was clicked${lastTableAvailable ? '' : ' (process table unreadable)'}`
  }

  return {
    facts,
    laneStatus,
    laneDetail,
    terminateStatus,
    terminateDetail,
    healthStatus: health.resolved === true && health.state === 'ready' ? 'pass' : 'fail',
    healthDetail: `app state after lane: ${health.state ?? 'unknown'}`,
  }
}

/** Settings surface + read-only update status + account reachability. */
/** Click the Account entry in the Settings navigation (inside the open modal). */
export const ACCOUNT_NAV_CLICK_EXPRESSION = `(() => {
  const modal = document.querySelector("[data-shortcut-modal='settings'][role='dialog'][aria-modal='true']");
  if (modal === null) return { record: 'account-nav', clicked: false, reason: 'no-settings-modal' };
  const elements = [...modal.querySelectorAll('button, [role="tab"], [role="button"], a, [aria-label]')];
  const label = (el) => (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.textContent || '');
  // The entry's own nav copy: t('nav') = 'Account' / '\\u8d26\\u53f7\\u4e0e\\u4f59\\u989d'.
  const ACCOUNT_ENTRY = /^(account|\\u8d26\\u53f7\\u4e0e\\u4f59\\u989d)$/iu;
  const match = elements.find((el) => ACCOUNT_ENTRY.test(label(el).trim()))
    ?? elements.find((el) => /(^|\\s)account($|\\s)/iu.test(label(el).trim()));
  if (match) { match.click(); return { record: 'account-nav', clicked: true }; }
  return { record: 'account-nav', clicked: false, reason: 'no-account-entry' };
})()`

/**
 * Identify the mounted Account panel by a REAL ACTION AFFORDANCE, never by the
 * word "account" or by prose. A signed-out surface exposes an enabled control
 * whose label is the source's sign-in copy (`AccountSection.tsx:149-150`,
 * `t('signIn')` = 'Sign in' / '登录', inside `section[aria-label={t('nav')}]`).
 * A signed-in surface exposes a sign-out control (`t('signOut')` = 'Sign out' /
 * '退出登录') or the documented signed-in identity marker (`t('signedIn')` =
 * 'Signed in to DeepSeek' / '已登录 DeepSeek'). Prose that merely mentions signing
 * in is not an affordance, and an unidentified panel is never a pass.
 */
export const ACCOUNT_PANEL_EXPRESSION = `(() => {
  const modal = document.querySelector("[data-shortcut-modal='settings'][role='dialog'][aria-modal='true']");
  const text = modal ? (modal.innerText || '') : '';
  const base = {
    record: 'account-panel',
    modalPresent: modal !== null,
    textLength: text.length,
    signedOutActionPresent: false,
    signedInActionPresent: false,
    signedInMarkerPresent: false,
    signedOutAffordance: false,
    signedInAffordance: false,
    affordance: null
  };
  if (modal === null) return base;
  const ACCOUNT_NAV = /^(account|\\u8d26\\u53f7\\u4e0e\\u4f59\\u989d)$/iu;
  const section = [...modal.querySelectorAll('section[aria-label]')]
    .find((el) => ACCOUNT_NAV.test((el.getAttribute('aria-label') || '').trim())) ?? null;
  if (section === null) return base;
  const controls = [...section.querySelectorAll('button, [role="button"], a[href]')];
  const enabled = (el) => el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
  const label = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
  const SIGN_IN = /^(sign in|log in|\\u767b\\u5f55)$/iu;
  const SIGN_OUT = /^(sign out|log out|\\u9000\\u51fa\\u767b\\u5f55)$/iu;
  // Signed-in only (AccountSection.tsx:164-166): the account-information link.
  const ACCOUNT_INFO = /^(more account information|\\u66f4\\u591a\\u8d26\\u53f7\\u4fe1\\u606f)$/iu;
  const signIn = controls.find((el) => enabled(el) && SIGN_IN.test(label(el))) ?? null;
  const signOut = controls.find((el) => enabled(el) && SIGN_OUT.test(label(el))) ?? null;
  const accountInfo = controls.find((el) => enabled(el) && ACCOUNT_INFO.test(label(el))) ?? null;
  const sectionText = section.innerText || '';
  // The signed-out copy reads "You are NOT signed in to DeepSeek Harness", so the
  // marker must not be read out of that negation.
  const signedInMarker = /(?<!not )signed in to deepseek|\\u5df2\\u767b\\u5f55 deepseek/iu.test(sectionText);
  return {
    ...base,
    signedOutActionPresent: signIn !== null,
    signedInActionPresent: signOut !== null,
    signedInAccountInfoPresent: accountInfo !== null,
    signedInMarkerPresent: signedInMarker,
    signedOutAffordance: signIn !== null,
    signedInAffordance: signOut !== null || accountInfo !== null || signedInMarker,
    affordance: signIn !== null
      ? 'sign-in-control'
      : (signOut !== null
        ? 'sign-out-control'
        : (accountInfo !== null ? 'account-info-control' : (signedInMarker ? 'signed-in-identity-marker' : null)))
  };
})()`

/**
 * The Account reachability verdict from the panel facts. Only a positively
 * identified ACTION affordance passes: a modal that merely TALKS about signing in
 * leaves the panel unidentified (`unqualified`), and a mounted panel whose Account
 * entry could not be clicked is a failure.
 *
 * @param {boolean} navClicked Whether the Account navigation entry was clicked.
 * @param {object} panel The `ACCOUNT_PANEL_EXPRESSION` result.
 * @returns {{status: string, how: string, detail: string}} The check outcome.
 */
export function evaluateAccountPanel(navClicked, panel) {
  if (navClicked !== true) {
    return panel?.modalPresent === true
      ? { status: 'fail', how: 'no-account-entry', detail: 'the mounted Settings panel exposed no clickable Account entry' }
      : { status: 'unqualified', how: 'no-settings-panel', detail: 'no mounted Settings panel, so the Account panel could not be identified' }
  }
  if (panel?.signedOutActionPresent === true) {
    return { status: 'pass', how: 'sign-in-control', detail: 'an enabled sign-in control is present in the Account panel (signed out)' }
  }
  if (panel?.signedInActionPresent === true) {
    return { status: 'pass', how: 'sign-out-control', detail: 'an enabled sign-out control is present in the Account panel (signed in)' }
  }
  if (panel?.signedInAccountInfoPresent === true) {
    return { status: 'pass', how: 'account-info-control', detail: 'the signed-in-only account-information control is present in the Account panel' }
  }
  if (panel?.signedInMarkerPresent === true) {
    return { status: 'pass', how: 'signed-in-identity-marker', detail: 'the documented signed-in identity marker is present in the Account panel (signed in)' }
  }
  return {
    status: 'unqualified',
    how: 'no-action-affordance',
    detail: 'the Account panel showed no enabled sign-in/sign-out control and no documented signed-in marker; prose alone is not an affordance',
  }
}

/**
 * Open the UNSIGNED account launcher: `settings.launcher` is occupied by
 * `ui-settings-account`'s AccountMenu, which `ui-settings-general` SettingsRoot
 * renders in its always-mounted trigger row beside the Settings panel, so it
 * exists without a stored credential. Its trigger is the signed-out launcher
 * button (`data-signed-out`, `aria-haspopup="menu"`, `aria-label={t('menu')}`),
 * and the popover it opens offers the sign-in row. The harness never activates a
 * row: sign-in itself is an external authorization step.
 */
export const ACCOUNT_MENU_OPEN_EXPRESSION = `(() => {
  const trigger = document.querySelector("button[data-signed-out='true'][aria-haspopup='menu']");
  if (trigger === null) return { record: 'account-menu-open', triggerPresent: false, clicked: false, alreadyOpen: false, ariaLabel: null };
  const alreadyOpen = trigger.getAttribute('aria-expanded') === 'true';
  if (!alreadyOpen) trigger.click();
  return { record: 'account-menu-open', triggerPresent: true, clicked: !alreadyOpen, alreadyOpen, ariaLabel: trigger.getAttribute('aria-label') };
})()`

/**
 * Read the open account popover. It is identified as the SOURCE's menu, never as
 * whichever `[role="menu"]` happens to be mounted: the list must carry the
 * account menu's own copy (its `t('settings')` + `t('contactUs')` rows, or a
 * sign-in/sign-out row beside one of them). Only visibility and enablement are
 * read — `ui-primitives` Menu rows are `button[role="menuitem"]` and none is
 * clicked here.
 */
export const ACCOUNT_MENU_EXPRESSION = `(() => {
  const label = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).trim();
  const enabled = (el) => el.disabled !== true && el.getAttribute('aria-disabled') !== 'true';
  const SIGN_IN = /^(?:sign in|log in|\\u767b\\u5f55)$/iu;
  const SIGN_OUT = /^(?:sign out|log out|\\u9000\\u51fa\\u767b\\u5f55)$/iu;
  const SETTINGS_ITEM = /^(?:settings|\\u8bbe\\u7f6e)$/iu;
  const FEEDBACK_ITEM = /^(?:feedback|\\u610f\\u89c1\\u53cd\\u9988)$/iu;
  const pick = (items, pattern) => items.find((el) => enabled(el) && pattern.test(label(el))) ?? null;
  const read = (menu) => {
    const items = [...menu.querySelectorAll('button[role="menuitem"]')];
    const labels = items.map((el) => label(el));
    const signIn = pick(items, SIGN_IN);
    const signOut = pick(items, SIGN_OUT);
    const settingsRow = labels.some((value) => SETTINGS_ITEM.test(value));
    const feedbackRow = labels.some((value) => FEEDBACK_ITEM.test(value));
    // Two independent source rows (or one of them plus the account action) name
    // this list; anything else is not the account menu.
    const isAccount = (settingsRow && feedbackRow) || (feedbackRow && (signIn !== null || signOut !== null));
    return { isAccount, labels, signIn, signOut };
  };
  const menus = [...document.querySelectorAll('[role="menu"]')].map(read).filter((entry) => entry.isAccount === true);
  if (menus.length === 0) {
    return { record: 'account-menu', accountMenuPresent: false, itemCount: 0, itemLabels: [], signInItemPresent: false, signInItemLabel: null, signOutItemPresent: false };
  }
  const found = menus[0];
  return {
    record: 'account-menu',
    accountMenuPresent: true,
    itemCount: found.labels.length,
    itemLabels: found.labels.slice(0, 6),
    signInItemPresent: found.signIn !== null,
    signInItemLabel: found.signIn === null ? null : label(found.signIn),
    signOutItemPresent: found.signOut !== null
  };
})()`

/** Dismiss the account popover through its own trigger (never through a row). */
export const ACCOUNT_MENU_CLOSE_EXPRESSION = `(() => {
  const trigger = document.querySelector("button[data-signed-out='true'][aria-haspopup='menu']");
  if (trigger === null) return { record: 'account-menu-close', closed: false, reason: 'no-account-menu-trigger' };
  if (trigger.getAttribute('aria-expanded') !== 'true') return { record: 'account-menu-close', closed: true, reason: 'already-collapsed' };
  trigger.click();
  return { record: 'account-menu-close', closed: true, reason: 'trigger-toggled' };
})()`

/**
 * Dismiss the account popover positively: Escape first (the Menu primitive closes
 * on Escape), then its own trigger as a fallback. No menu row is ever activated.
 *
 * `closed` is reported ONLY for an EXPLICIT `accountMenuPresent === false` probe.
 * An unanswered or unreadable probe is unknown, never a close, so a failed probe
 * can no longer be laundered into a positive dismissal.
 *
 * @param {{connection: object, sleepImpl: Function, timeoutMs?: number}} options
 * @returns {Promise<{closed: boolean, how: string}>} Whether the popover is gone.
 */
export async function closeAccountMenu({ connection, sleepImpl, timeoutMs = 4000 }) {
  const probeMenu = () => connection.evaluate(ACCOUNT_MENU_EXPRESSION, { awaitPromise: false })
    .then(value => (value !== null && typeof value === 'object' ? value : { accountMenuPresent: null }))
    .catch(() => ({ accountMenuPresent: null }))
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const probe = await probeMenu()
    if (probe.accountMenuPresent === false) return { closed: true, how: 'explicitly-closed' }
    if (Date.now() >= deadline) {
      const toggle = await connection.evaluate(ACCOUNT_MENU_CLOSE_EXPRESSION, { awaitPromise: false })
        .catch(() => ({ reason: 'close-control-unavailable' }))
      const after = await probeMenu()
      if (after.accountMenuPresent === false) return { closed: true, how: toggle.reason ?? 'trigger-toggled' }
      return {
        closed: false,
        how: after.accountMenuPresent === true ? 'still-open' : 'dismissal-unverified',
      }
    }
    for (const type of ['rawKeyDown', 'keyUp']) {
      await connection.send('Input.dispatchKeyEvent', {
        type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
      })
    }
    await sleepImpl(200)
  }
}

/**
 * The credential-free account-surface verdict from the account MENU route: the
 * always-mounted launcher must actually open its popover, and that popover must
 * offer an enabled sign-in row. A launcher that cannot be opened, a popover that
 * cannot be identified, or a popover with no enabled account action is
 * unqualified, never a pass. The sign-in row is observed only.
 *
 * @param {{openOutcome?: object, probe?: object}} evidence
 * @returns {{status: string, how: string, detail: string}} The check outcome.
 */
export function evaluateAccountMenu({ openOutcome, probe }) {
  if (openOutcome?.triggerPresent !== true) {
    return { status: 'unqualified', how: 'no-account-menu-trigger', detail: 'no unsigned account-menu launcher is mounted, so the account surface could not be identified' }
  }
  if (openOutcome.clicked !== true) {
    return { status: 'unqualified', how: 'account-menu-not-opened', detail: `the account launcher (aria-label ${openOutcome.ariaLabel ?? 'unknown'}) did not open` }
  }
  if (probe?.accountMenuPresent !== true) {
    return { status: 'unqualified', how: 'no-account-menu', detail: 'the account launcher opened no positively identified account menu' }
  }
  if (probe.signInItemPresent === true) {
    return {
      status: 'pass',
      how: 'account-menu-sign-in-item',
      detail: `the account menu offers an enabled sign-in row (${probe.signInItemLabel ?? 'unknown label'}) without any stored credential; the row was observed, never activated`,
    }
  }
  if (probe.signOutItemPresent === true) {
    return { status: 'pass', how: 'account-menu-sign-out-item', detail: 'the account menu offers an enabled sign-out row; the row was observed, never activated' }
  }
  return { status: 'unqualified', how: 'no-account-menu-action', detail: 'the account menu exposed neither an enabled sign-in nor an enabled sign-out row' }
}

/**
 * Settings surface, marker round-trip and the Account panel.
 *
 * Settings is opened through the registered shortcut and must POSITIVELY MOUNT:
 * a dispatched key is never accepted as a pass on its own, and the surface is
 * closed positively afterwards so no later hotkey runs under an open modal.
 */
export async function runSettingsScenario({ connection, sleepImpl, log }) {
  const open = await openSettings({ connection, sleepImpl })
  const mounted = await connection.evaluate(SETTINGS_MOUNTED_EXPRESSION, { awaitPromise: false })
  await sleepImpl(600)
  const facts = await connection.evaluate(SURFACE_FACTS_EXPRESSION, { awaitPromise: false })
  const update = await connection.evaluate(UPDATE_STATUS_EXPRESSION)
  const nav = await connection.evaluate(ACCOUNT_NAV_CLICK_EXPRESSION, { awaitPromise: false })
  await sleepImpl(600)
  const panel = await connection.evaluate(ACCOUNT_PANEL_EXPRESSION, { awaitPromise: false })
  const closed = await closeSettings({ connection, sleepImpl })
  const settingsStatus = (open.opened === true && mounted.mounted === true && closed.closed === true) ? 'pass' : 'fail'
  const updatesStatus = update.resolved === true && update.phaseKnown === true ? 'pass' : 'fail'
  const account = evaluateAccountPanel(nav.clicked === true, panel)
  // The Settings Account SECTION exists only while a credential is stored, so a
  // credential-free environment falls back to the always-mounted account launcher:
  // open its popover, observe an enabled sign-in row, then dismiss it. The
  // popover's rows are never activated (sign-in is an external authorization step).
  let accountOpen = null
  let accountMenuProbe = null
  let accountMenuClose = null
  let accountMenu = null
  if (account.status !== 'pass') {
    accountOpen = await connection.evaluate(ACCOUNT_MENU_OPEN_EXPRESSION, { awaitPromise: false })
    await sleepImpl(500)
    accountMenuProbe = await connection.evaluate(ACCOUNT_MENU_EXPRESSION, { awaitPromise: false }).catch(() => null)
    accountMenuClose = await closeAccountMenu({ connection, sleepImpl })
    accountMenu = evaluateAccountMenu({ openOutcome: accountOpen, probe: accountMenuProbe })
  }
  // The menu route may only carry the check when its popover was POSITIVELY
  // dismissed: an observed sign-in row on a popover left open (or whose closure
  // could not be established) does not satisfy the harness's positive-UI cleanup
  // contract. The section route above is unaffected.
  const accountRoute = account.status === 'pass'
    ? account
    : accountMenu.status === 'pass' && accountMenuClose?.closed === true
      ? accountMenu
      : accountMenu.status === 'pass'
        ? {
            status: 'unqualified',
            how: 'account-menu-not-dismissed',
            detail: `${accountMenu.detail}, but the popover dismissal could not be positively established (${accountMenuClose?.how ?? 'unknown'}), so the account surface stays unqualified`,
          }
        : accountMenu
  const accountStatus = accountRoute.status
  void log
  return {
    settingsOpened: open.opened === true,
    settingsOpenHow: open.how,
    settingsSurfaceMounted: mounted.mounted === true,
    settingsClosed: closed.closed === true,
    accountNavClicked: nav.clicked === true,
    accountSignedOutAffordance: panel.signedOutActionPresent === true,
    accountSignedInAffordance: panel.signedInActionPresent === true || panel.signedInAccountInfoPresent === true || panel.signedInMarkerPresent === true,
    accountAffordance: account.how,
    accountMenuTriggerLabel: accountOpen === null ? null : accountOpen.ariaLabel,
    accountMenuItems: accountMenuProbe === null ? [] : accountMenuProbe.itemLabels,
    accountMenuSignInLabel: accountMenuProbe === null ? null : accountMenuProbe.signInItemLabel,
    accountMenuDismissed: accountMenuClose === null ? null : accountMenuClose.closed === true,
    accountHow: accountRoute.how,
    accountSurfaceMentioned: facts.accountSurfaceMentioned === true,
    updatesSurfaceMentioned: facts.updatesSurfaceMentioned === true,
    updatePhase: update.phase,
    settingsStatus,
    settingsDetail: `opened=${open.opened} (${open.how}) mounted=${mounted.mounted === true} closed=${closed.closed === true}`,
    updatesStatus,
    updatesDetail: `update_status phase=${update.phase ?? 'null'} (read-only; no update_check performed)`,
    accountStatus,
    accountDetail: account.status === 'pass'
      ? `route=settings-account-section affordance=${account.how} navClicked=${nav.clicked === true} signInControl=${panel.signedOutActionPresent === true} signOutControl=${panel.signedInActionPresent === true} accountInfoControl=${panel.signedInAccountInfoPresent === true} signedInMarker=${panel.signedInMarkerPresent === true} (identified by a real action affordance, never by the word "account" or prose)`
      : `route=account-menu affordance=${accountRoute.how} trigger=${accountOpen === null ? 'none' : (accountOpen.ariaLabel ?? 'unknown')} items=${accountMenuProbe === null ? 0 : accountMenuProbe.itemCount} signInRow=${accountMenuProbe?.signInItemPresent === true} dismissed=${accountMenuClose?.closed === true} — ${accountRoute.detail} (settings Account section unavailable: ${account.detail})`,
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
  args, paths, record, fetchImpl, sleepImpl, attachImpl, identityImpl, tableImpl, spawnImpl, log, env1, initialOnboarding = null,
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
  // Absence on restart is only qualified when the FIRST run positively appeared
  // and completed first-run onboarding; otherwise it is UNQUALIFIED, never a pass.
  const persisted = evaluateStaysCompleted({
    firstRunAppeared: initialOnboarding?.appeared === true,
    firstRunCompleted: initialOnboarding?.completed === true,
    reappeared: facts.onboardingReappeared,
  })
  facts.onboardingPersistence = persisted
  void record
  return {
    child, identityAtSpawn, host, connection, facts,
    readyStatus: 'pass',
    readyDetail: `second launch reached readiness (gateway ${gateway.origin})`,
    persistenceStatus: facts.markerOnDisk && facts.markerRoundTrip ? 'pass' : 'fail',
    persistenceDetail: `on-disk=${facts.markerOnDisk} bridge-round-trip=${facts.markerRoundTrip} (settings.json inside the isolated home; same owned namespace across the restart)`,
    onboardingStatus: persisted.status,
    onboardingDetail: persisted.detail,
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
  // The generated isolation paths are published evidence. `reportPath` is the
  // record's own output path UNDER `runRoot`; a long stamp can push its directory
  // name over the long-run rule, so the exact generated string is listed too.
  for (const key of ['ownedRoot', 'home', 'userData', 'profileDir', 'runRoot', 'reportPath']) {
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
    refusalCode: error.refusalCode ?? null,
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
  --runtime-dir <path>      materialized runtime payload. When omitted, the
                            PACKAGED DEFAULT is exercised: no runtime override is
                            exported and the app must resolve <exe_dir>/dsh itself
  --shell-dir <path>        explicit shell assets override (exported unchanged).
                            When omitted: the packaged default asks the app to
                            resolve <exe_dir>/ui (no override exported), while an
                            explicit --runtime-dir keeps <repo>/port/ui/dist.
                            A packaged default with NO <exe_dir>/ui/index.html is
                            REFUSED at preflight (refusalCode packaged-ui-missing)
  --node-exe <ABS path>     OPTIONAL byte-identical trusted copy of the payload
                            interpreter (regular non-linked file; SHA-256 must
                            exactly equal runtimeDir/node/node.exe). Used as
                            DSH_DESKTOP_NODE when the published payload image
                            inherits a problematic integrity label. Never a
                            relabel; a mismatch refuses the run.
  --cdp-port <1024-65535>   WebView2 remote-debugging port for THIS run (default 9333)
  --fixture-port <...>      local fixture-provider port (default 9471)
  --without-fixture-chat    record the chat checks as not-requested (never a pass)
  --without-pty-lane        record the terminal PTY termination checks as
                            not-requested (never a pass)
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
