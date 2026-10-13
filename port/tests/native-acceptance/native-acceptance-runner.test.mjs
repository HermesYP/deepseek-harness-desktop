#!/usr/bin/env node
/**
 * native-acceptance-runner.test.mjs — focused unit tests for the native
 * acceptance harness.
 *
 * No real application, no real keyring, no live port, no CDP endpoint and no
 * real provider is touched: every external dependency is mocked through the
 * runner's inject seam, and every filesystem interaction happens inside a
 * fresh temporary repository root. The one integration-style test drives
 * `runAcceptance` end to end against a mocked candidate (fake spawn, fake CDP
 * connection, fake fixture provider, fake process identity) to prove that the
 * happy path computes a green verdict ONLY with every required check present,
 * and that identity, redaction and refusal contracts hold.
 *
 * Covered: argument and preflight refusals (including release images, hash
 * mismatch, glob-shaped candidates and live-GUI ports), isolation derivation,
 * fixture-patch staging (labelled, key-free), gateway-URL parsing (token never
 * escapes), readiness gating, verdict math (no false green; unqualified and
 * not-requested are never passes; missing required checks block acceptance),
 * identity completeness, scenario evaluators against mocked pages, graceful
 * quit semantics, and the full mocked acceptance run including its redaction
 * gate.
 *
 * Run with the qualified pinned interpreter:
 *
 *   & "<pinned node>" --test native-acceptance-runner.test.mjs
 */

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FIXTURE_API_KEY, FIXTURE_KEY_ENV, FIXTURE_MODEL_ID, FIXTURE_ROUTE, parseFixturePort } from './fixture-provider.mjs'
import {
  CHAT_OBSERVE_EXPRESSION,
  HOST_FACTS_EXPRESSION,
  REQUIRED_CHECK_IDS,
  SETTINGS_MARKER_KEY,
  SETTINGS_MARKER_VALUE,
  buildChildEnvironment,
  buildFixturePatch,
  computeVerdict,
  deriveIsolationPaths,
  evaluateShellUsability,
  gracefulQuit,
  identityIsComplete,
  isBootReady,
  parseArgs,
  parseGatewayUrl,
  preflightCandidate,
  redactionAllowList,
  runAcceptance,
  runOnboardingScenario,
} from './native-acceptance-runner.mjs'
import { findSecretLikeLeaks } from '../native-cdp/native-cdp-probe.mjs'

const UUID = randomUUID()
const EXE = 'C:\\qual\\candidates\\dsh-desktop.exe'
const SHA = 'a'.repeat(64)

// ---------------------------------------------------------------------------
// A. Argument guards — refusals happen before anything is touched
// ---------------------------------------------------------------------------

test('A1: the candidate is explicit and absolute, with a well-formed sha256', () => {
  assert.throws(() => parseArgs([]), /--exe is required/u)
  assert.throws(() => parseArgs(['--exe', EXE]), /--sha256 is required/u)
  assert.throws(() => parseArgs(['--exe', 'relative\\dsh.exe', '--sha256', SHA]), /absolute path/u)
  assert.throws(() => parseArgs(['--exe', EXE, '--sha256', 'abc']), /64-hex-digit/u)
  // Upper-case hex is NORMALIZED, not refused (asserted below).
  const ok = parseArgs(['--exe', EXE, '--sha256', SHA.toUpperCase()])
  assert.equal(ok.sha256, SHA)
  assert.equal(ok.exe, EXE)
  assert.equal(ok.withFixtureChat, true)
})

test('A2: no globs and no positional arguments are accepted', () => {
  assert.throws(() => parseArgs(['C:\\qual\\*.exe', '--sha256', SHA]), /positional/u)
  assert.throws(() => parseArgs(['--exe', EXE, '--sha256', SHA, 'stray']), /positional/u)
  assert.throws(() => parseArgs(['--exe', EXE, '--sha256', SHA, '--candidates', 'C:\\x\\*.exe']), /unknown argument/u)
})

test('A3: the live Harness GUI port is refused for both owned ports', () => {
  for (const name of ['cdp-port', 'fixture-port']) {
    assert.throws(
      () => parseArgs(['--exe', EXE, '--sha256', SHA, `--${name}`, '3080']),
      /3080.*live Harness GUI|live Harness GUI.*3080/u,
      `${name} must refuse 3080`,
    )
  }
  assert.throws(
    () => parseArgs(['--exe', EXE, '--sha256', SHA, '--cdp-port', '9333', '--fixture-port', '9333']),
    /must differ/u,
  )
})

test('A4: numeric bounds are validated, not clamped; unknown and duplicate flags refuse', () => {
  const base = ['--exe', EXE, '--sha256', SHA]
  assert.throws(() => parseArgs([...base, '--boot-timeout-ms', '100']), /within \[5000, 300000\]/u)
  assert.throws(() => parseArgs([...base, '--boot-timeout-ms', 'soon']), /non-negative integer/u)
  assert.throws(() => parseArgs([...base, '--nope']), /unknown argument/u)
  assert.throws(() => parseArgs([...base, '--exe', EXE]), /supplied twice/u)
  assert.throws(() => parseArgs([...base, '--stamp', 'bad stamp!']), /--stamp must match/u)
  const ok = parseArgs([...base, '--stamp', 'run-1'])
  assert.equal(ok.stamp, 'run-1')
  assert.equal(ok.bounds['cdp-port'], 9333)
  assert.equal(ok.bounds['fixture-port'], 9471)
})

// ---------------------------------------------------------------------------
// B. Candidate preflight — debug image, existence, exact hash
// ---------------------------------------------------------------------------

test('B1: a release image is refused before anything is launched', async () => {
  await assert.rejects(
    () => preflightCandidate({ exe: 'C:\\qual\\target\\release\\dsh-desktop.exe', sha256: SHA }),
    /RELEASE image.*debug build/su,
  )
  await assert.rejects(
    () => preflightCandidate({ exe: 'C:/qual/target/release/dsh-desktop.exe', sha256: SHA }),
    /RELEASE image/su,
  )
})

test('B2: a missing or non-regular candidate is refused', async () => {
  await assert.rejects(
    () => preflightCandidate({ exe: 'C:\\qual\\absent\\dsh-desktop.exe', sha256: SHA }),
    /not found/u,
  )
})

test('B3: the hash is verified over the file bytes before anything launches', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acc-'))
  try {
    const exe = join(dir, 'dsh-desktop.exe')
    const bytes = Buffer.from('MZ fake candidate image')
    await writeFile(exe, bytes)
    const observed = createHash('sha256').update(bytes).digest('hex')
    const ok = await preflightCandidate({ exe, sha256: observed })
    assert.equal(ok.sha256, observed)
    assert.equal(ok.sizeBytes, bytes.length)
    await assert.rejects(
      () => preflightCandidate({ exe, sha256: 'b'.repeat(64) }),
      error => error.code === 'refused' && /hash mismatch.*expected/su.test(error.message)
        && !error.message.includes('MZ fake'),
      'the refusal must not echo candidate bytes',
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// C. Isolation derivation — the owned credential fence, fresh roots
// ---------------------------------------------------------------------------

test('C1: the home always lives under the fence-derived owned root', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: 's1' })
  assert.ok(paths.ownedRoot.toLowerCase().startsWith('c:\\repo\\.scratch\\native-'))
  assert.ok(paths.ownedRoot.endsWith(`native-${UUID}`))
  assert.ok(paths.home.toLowerCase().startsWith(paths.ownedRoot.toLowerCase()))
  assert.ok(paths.userData.toLowerCase().startsWith(paths.home.toLowerCase()))
  assert.ok(paths.runRoot.toLowerCase().includes('port\\.scratch\\native-acceptance-s1'))
})

test('C2: the namespace must be canonical and non-nil', () => {
  assert.throws(
    () => deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: '00000000-0000-0000-0000-000000000000', stamp: 's' }),
    /canonical non-nil/u,
  )
  assert.throws(
    () => deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID.toUpperCase(), stamp: 's' }),
    /canonical non-nil/u,
  )
})

test('C3: fresh roots are required; an existing owned or run root is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acc-'))
  const { assertFreshRoots } = await import('./native-acceptance-runner.mjs')
  try {
    const ns = randomUUID()
    const paths = deriveIsolationPaths({ repoRoot: dir, namespace: ns, stamp: 'fresh' })
    await assertFreshRoots(paths) // fresh paths must pass
    await mkdir(paths.ownedRoot, { recursive: true })
    await assert.rejects(() => assertFreshRoots(paths), /owned root already exists.*nothing was deleted/u)
    const other = deriveIsolationPaths({ repoRoot: dir, namespace: randomUUID(), stamp: 'other' })
    await mkdir(other.runRoot, { recursive: true })
    await assert.rejects(() => assertFreshRoots(other), /run root already exists/u)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// D. Fixture staging — clearly labelled, key-free, origin-bound
// ---------------------------------------------------------------------------

test('D1: the staged patch is labelled, references the fixture route, and never carries the key value', () => {
  const origin = 'http://127.0.0.1:9471'
  const patch = buildFixturePatch({ fixtureOrigin: origin })
  assert.ok(patch.includes('LOCAL TEST FIXTURE'))
  assert.ok(patch.includes('acceptance only'))
  assert.ok(patch.includes(`provider: ${FIXTURE_ROUTE}`))
  assert.ok(patch.includes(`model: ${FIXTURE_MODEL_ID}`))
  assert.ok(patch.includes(`apiKeyEnv: ${FIXTURE_KEY_ENV}`))
  assert.ok(patch.includes(`baseURL: ${origin}/v1`))
  assert.ok(patch.includes('id: llm-pi-ai'))
  assert.ok(patch.includes('id: agent-default-model'))
  assert.ok(!patch.includes(FIXTURE_API_KEY), 'the key VALUE must never be staged into the home; only its env-var name')
  assert.ok(!patch.includes('undefined'), 'no undefined placeholder may be staged')
})

test('D2: the fixture port guard refuses the live GUI port and out-of-range values', () => {
  assert.throws(() => parseFixturePort(3080), /3080/u)
  assert.throws(() => parseFixturePort(80), /within \[1024, 65535\]/u)
  assert.throws(() => parseFixturePort('x'), /within/u)
  assert.equal(parseFixturePort(9471), 9471)
})

// ---------------------------------------------------------------------------
// E. Gateway URL parsing — the launch token never escapes
// ---------------------------------------------------------------------------

test('E1: the gateway URL is parsed to an origin; the token value is never returned', () => {
  const token = 't'.repeat(48) + '1' // secret-shaped length, never emitted
  const parsed = parseGatewayUrl(`http://localhost:3099/?token=${token}`)
  assert.equal(parsed.origin, 'http://127.0.0.1:3099')
  assert.equal(parsed.boundPort, 3099)
  assert.equal(parsed.authenticatedUrlSeen, true)
  assert.equal(parsed.authenticatedUrlLength, token.length)
  assert.equal(JSON.stringify(parsed).includes(token), false, 'the token value must not appear in the parsed record')
})

test('E2: non-loopback, live-GUI, and unparseable gateway URLs are refused', () => {
  assert.throws(() => parseGatewayUrl('http://10.0.0.5:3099/?token=x'), /not loopback/u)
  assert.throws(() => parseGatewayUrl(`http://127.0.0.1:3080/?token=x`), /3080.*live Harness GUI|live Harness GUI.*3080/u)
  assert.throws(() => parseGatewayUrl('not a url'), /not a parseable URL/u)
  assert.throws(() => parseGatewayUrl(undefined), /not a parseable URL/u)
})

// ---------------------------------------------------------------------------
// F. Readiness gating
// ---------------------------------------------------------------------------

test('F1: readiness requires a boot payload with a non-empty streamBaseUrl', () => {
  assert.equal(isBootReady(null), false)
  assert.equal(isBootReady({}), false)
  assert.equal(isBootReady({ streamBaseUrl: '' }), false)
  assert.equal(isBootReady({ streamBaseUrl: 'http://127.0.0.1:3099' }), true)
})

// ---------------------------------------------------------------------------
// G. Verdict math — no false green, unqualified is never a pass
// ---------------------------------------------------------------------------

/** Build a full passing check set with every required id. */
function passingChecks() {
  return REQUIRED_CHECK_IDS.map(id => ({ id, required: true, status: 'pass', detail: 'test' }))
}

test('G1: acceptance is true only for a complete passing run with complete identity', () => {
  const good = computeVerdict({ checks: passingChecks(), identityComplete: true })
  assert.equal(good.acceptance, true)
  assert.deepEqual(good.missingRequiredChecks, [])
  assert.deepEqual(good.failedRequiredChecks, [])
})

test('G2: a missing required check blocks acceptance even when the rest passed', () => {
  const checks = passingChecks().filter(check => check.id !== 'onboarding.first_run')
  const verdict = computeVerdict({ checks, identityComplete: true })
  assert.equal(verdict.acceptance, false)
  assert.deepEqual(verdict.missingRequiredChecks, ['onboarding.first_run'])
})

test('G3: fail and unqualified statuses are never passes', () => {
  for (const status of ['fail', 'unqualified']) {
    const checks = passingChecks().map(check => (check.id === 'shell.usable' ? { ...check, status } : check))
    const verdict = computeVerdict({ checks, identityComplete: true })
    assert.equal(verdict.acceptance, false, `${status} must block acceptance`)
    assert.deepEqual(verdict.failedRequiredChecks, ['shell.usable'])
  }
})

test('G4: a required check reported not-requested counts as missing; an empty list is never green', () => {
  const checks = passingChecks().map(check => (check.id === 'chat.fixture_cancel' ? { ...check, status: 'not-requested' } : check))
  const verdict = computeVerdict({ checks, identityComplete: true })
  assert.equal(verdict.acceptance, false)
  assert.deepEqual(verdict.missingRequiredChecks, ['chat.fixture_cancel'])
  const empty = computeVerdict({ checks: [], identityComplete: true })
  assert.equal(empty.acceptance, false)
  assert.equal(empty.counts.total, 0)
})

test('G5: incomplete identity facts block acceptance regardless of checks', () => {
  const verdict = computeVerdict({ checks: passingChecks(), identityComplete: false })
  assert.equal(verdict.acceptance, false)
  assert.equal(verdict.identityComplete, false)
})

test('G6: identity completeness requires pid, creation ticks, present status and the exact exe', () => {
  const candidate = { exe: EXE, sha256: SHA }
  const base = { pid: 42, creationTicks: '133900000000000000', identityStatus: 'present', exeObserved: EXE }
  assert.equal(identityIsComplete({ candidate, process: base }), true)
  assert.equal(identityIsComplete({ candidate, process: { ...base, pid: 0 } }), false)
  assert.equal(identityIsComplete({ candidate, process: { ...base, identityStatus: 'unknown' } }), false)
  assert.equal(identityIsComplete({ candidate, process: { ...base, creationTicks: '' } }), false)
  assert.equal(identityIsComplete({ candidate, process: { ...base, exeObserved: 'C:\\other\\dsh-desktop.exe' } }), false, 'a different exe path is an identity mismatch')
  assert.equal(identityIsComplete({ candidate, process: { ...base, exeObserved: undefined } }), false)
  assert.equal(identityIsComplete({ candidate: { exe: EXE }, process: base }), false)
})

// ---------------------------------------------------------------------------
// H. Scenario evaluators against mocked pages
// ---------------------------------------------------------------------------

const fakeConnection = evaluations => ({ evaluate: async expression => evaluations(expression) })

test('H1: onboarding that appears and completes passes', async () => {
  let stage = 0
  const connection = fakeConnection(expression => {
    if (expression === HOST_FACTS_EXPRESSION) {
      stage += 1
      return stage === 1
        ? { onboardingPresent: true, onboardingBusy: false, composerHintPresent: false, bootFailureShown: false, textLength: 300 }
        : { onboardingPresent: false, composerHintPresent: true, bootFailureShown: false, textLength: 900 }
    }
    if (expression.includes('onboarding-click')) return { clicked: true, matched: 'test' }
    throw new Error('unexpected expression')
  })
  const outcome = await runOnboardingScenario({ connection, timeoutMs: 5000, sleepImpl: async () => {} })
  assert.equal(outcome.status, 'pass')
  assert.equal(outcome.appeared, true)
  assert.equal(outcome.clicks >= 1, true)
})

test('H2: a workspace that mounts with no onboarding on a fresh home is unqualified, never a pass', async () => {
  const connection = fakeConnection(expression => {
    if (expression === HOST_FACTS_EXPRESSION) {
      return { onboardingPresent: false, composerHintPresent: true, bootFailureShown: false, textLength: 900 }
    }
    if (expression.includes('onboarding-click')) return { clicked: false, reason: 'absent' }
    throw new Error('unexpected expression')
  })
  const outcome = await runOnboardingScenario({ connection, timeoutMs: 3000, sleepImpl: async () => {} })
  assert.equal(outcome.status, 'unqualified')
  assert.equal(outcome.completed, false)
})

test('H3: onboarding that appears but never completes fails', async () => {
  const connection = fakeConnection(expression => {
    if (expression === HOST_FACTS_EXPRESSION) {
      return { onboardingPresent: true, onboardingBusy: false, composerHintPresent: false, bootFailureShown: false, textLength: 300 }
    }
    if (expression.includes('onboarding-click')) return { clicked: false, reason: 'no-action-button' }
    throw new Error('unexpected expression')
  })
  const outcome = await runOnboardingScenario({ connection, timeoutMs: 1200, sleepImpl: async () => {} })
  assert.equal(outcome.status, 'fail')
  assert.equal(outcome.appeared, true)
})

test('H4: shell usability requires composer, new-session AND settings', () => {
  const base = { composerHintPresent: true, newSessionPresent: true, settingsPresent: true }
  assert.equal(evaluateShellUsability(base, base).status, 'pass')
  const noSettings = evaluateShellUsability({ ...base, settingsPresent: false }, { ...base, settingsPresent: false })
  assert.equal(noSettings.status, 'fail')
  assert.equal(/settings=false/u.test(noSettings.detail), true)
})

test('H5: a graceful quit requires BOTH the process exit and a positive absence', async () => {
  const exitedChild = { pid: 7, exitCode: 0, signalCode: null }
  const present = { available: true, status: 'present', pid: 7, exe: EXE, creationTicks: '1' }
  const absent = { available: false, status: 'absent', pid: null, exe: null, creationTicks: null, reason: 'no process with that pid exists' }
  const unknown = { available: false, status: 'unknown', pid: null, exe: null, creationTicks: null, reason: 'query failed' }
  const connection = fakeConnection(expression => (expression.includes('shell_quit_request') ? { invoked: true, resolved: true } : {}))

  const pass = await gracefulQuit({ connection, child: exitedChild, identityImpl: async () => absent, timeoutMs: 500 })
  assert.equal(pass.status, 'pass')

  const unverifiable = await gracefulQuit({ connection, child: exitedChild, identityImpl: async () => unknown, timeoutMs: 500 })
  assert.equal(unverifiable.status, 'fail', 'an unanswered identity query is never a clean exit')

  const aliveChild = { pid: 8, exitCode: null, signalCode: null, once() { /* never exits during the bound */ } }
  const notExited = await gracefulQuit({ connection, child: aliveChild, identityImpl: async () => present, timeoutMs: 100 })
  assert.equal(notExited.status, 'fail')
  assert.equal(notExited.exited, false)
})

// ---------------------------------------------------------------------------
// I. Full mocked acceptance run — happy path is only green when complete
// ---------------------------------------------------------------------------

const FAKE_TOKEN = `tok${'e'.repeat(40)}9x` // 45+ chars with digits: secret-shaped by design

/**
 * Build the mock environment for one full `runAcceptance` pass: a temporary
 * repository with candidate exe, runtime payload and shell assets; fake spawn
 * that writes the dev-handoff artifacts; a fake CDP connection whose canned
 * page answers follow the real scenario order.
 */
async function buildMockRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-acc-repo-'))
  const exeDir = join(repo, 'candidate')
  await mkdir(exeDir, { recursive: true })
  const exePath = join(exeDir, 'dsh-desktop.exe')
  const bytes = Buffer.from('MZ mocked debug candidate')
  await writeFile(exePath, bytes)
  const sha256 = createHash('sha256').update(bytes).digest('hex')

  const runtimeDir = join(repo, 'port', 'runtime-payload', 'dsh')
  await mkdir(join(runtimeDir, 'node'), { recursive: true })
  await writeFile(join(runtimeDir, 'adapter.mjs'), 'export default 1\n')
  await writeFile(join(runtimeDir, 'node', 'node.exe'), 'mock node')
  const shellDir = join(repo, 'port', 'ui', 'dist')
  await mkdir(shellDir, { recursive: true })
  await writeFile(join(shellDir, 'index.html'), '<html></html>')
  return { repo, exePath, sha256 }
}

function makeFakeChild(pid) {
  const child = {
    pid,
    exitCode: null,
    signalCode: null,
    exited: false,
    listeners: new Map(),
    once(event, handler) { this.listeners.set(event, handler) },
    simulateExit(code) {
      if (this.exited) return
      this.exited = true
      this.exitCode = code
      this.listeners.get('exit')?.(code)
    },
    unref() {},
    kill() {},
  }
  return child
}

/**
 * A fake CDP connection whose canned answers follow the real scenario order.
 * `variant` 1 walks the onboarding flow; variant 2 (post-restart) has no
 * onboarding region and answers the marker read.
 */
function makeFakeConnection({ gatewayOrigin, child, identityRegistry, variant, fixtureState }) {
  let onboardingStage = 0
  const hostFacts = () => ({
    record: 'host-facts',
    invokeIsFunction: true,
    hasTauriInternals: true,
    hasDesktopBoot: true,
    hasDesktopMarker: true,
    hasHostPaths: true,
    platformMarker: 'windows',
    rootChildren: 3,
    pluginStyles: 2,
    documentOrigin: gatewayOrigin,
    composerHintPresent: true,
    newSessionPresent: true,
    settingsPresent: true,
    onboardingPresent: variant === 1 && onboardingStage < 2,
    onboardingBusy: false,
    bootFailureShown: false,
    textLength: 1200,
  })
  let sendsSeen = 0
  return {
    evaluate: async expression => {
      if (expression === HOST_FACTS_EXPRESSION) {
        return hostFacts()
      }
      if (expression.includes('onboarding-click')) {
        onboardingStage = 2
        return { record: 'onboarding-click', clicked: true, matched: 'test-priority' }
      }
      if (expression.includes('composer-focus')) {
        // Each typed message becomes one provider request; the first carries tools.
        if (sendsSeen < 2) {
          sendsSeen += 1
          fixtureState.requestCount += 1
          fixtureState.toolRoundAnswers = Math.max(fixtureState.toolRoundAnswers, sendsSeen === 1 ? 1 : 0)
        }
        return { record: 'composer-focus', focused: true }
      }
      if (expression.includes('native-battery')) {
        return {
          record: 'native-battery',
          bridge: true,
          commandsInvoked: ['shell_app_info', 'runtime_status', 'update_status', 'credential_list', 'credential_has', 'credential_store', 'credential_delete'],
          shellAppInfo: { resolved: true, versionNonEmpty: true, protocolGeneration: 4, runtimeVersionNonEmpty: true, platform: 'win32', arch: 'x64', officialReferenceConfigured: false },
          runtimeStatus: { resolved: true, state: 'ready', lastErrorPresent: false, urlPresent: true, urlOriginIsLoopback: true, startedAtDigest: 'aaaa1111' },
          updateStatus: { resolved: true, phase: 'idle', phaseKnown: true, versionPresent: false, percentPresent: false, failurePresent: false },
          credentialList: { resolved: true, rowCount: 0, reservedPairPresent: false, wellFormed: true, anyCredentialPresent: false },
          credentialHasReserved: { resolved: true, present: false },
          credentialStoreReserved: { attempted: true, usedFixedDummyValue: true, rejected: true, kind: 'other', codePresent: true, code: 'credential_reserved', detailShape: 'object' },
          credentialDeleteReserved: { attempted: true, rejected: true, kind: 'other', codePresent: true, code: 'credential_reserved', detailShape: 'object' },
        }
      }
      if (expression.includes('new-session-click')) return { record: 'new-session-click', clicked: true }
      if (expression.includes('composer-focus')) return { record: 'composer-focus', focused: true }
      if (expression.includes('send-click')) return { record: 'send-click', clicked: false }
      if (expression.includes('stop-click')) {
        // The fixture observes the client abort when the harness clicks stop.
        fixtureState.cancelledCount += 1
        return { record: 'stop-click', clicked: true }
      }
      if (expression.includes('chat-observe')) return { record: 'chat-observe', fixtureReplyVisible: true, composerEnabled: true }
      if (expression.includes('settings-open')) return { record: 'settings-open', clicked: true }
      if (expression.includes('surface-facts')) {
        return { record: 'surface-facts', textLength: 4000, accountSurfaceMentioned: true, updatesSurfaceMentioned: true, settingsSurfaceMounted: true }
      }
      if (expression.includes('update-status')) {
        return { record: 'update-status', bridge: true, resolved: true, phase: 'idle', phaseKnown: true }
      }
      if (expression.includes('settings-marker') && expression.includes('read')) {
        return { record: 'settings-marker-read', bridge: true, resolved: true, valueMatches: true }
      }
      if (expression.includes('settings-marker')) {
        return { record: 'settings-marker', bridge: true, setResolved: true, getResolved: true, valueMatches: true }
      }
      if (expression.includes('shell_quit_request')) {
        queueMicrotask(() => {
          identityRegistry.get(child.pid).exited = true
          child.simulateExit(0)
        })
        return { record: 'quit', bridge: true, invoked: true, resolved: true }
      }
      throw new Error('unexpected expression in fake connection')
    },
    send: async () => ({}),
    close: async () => {},
  }
}

test('I1: the full mocked run is green only on the complete happy path, leaks nothing, and records no token', async () => {
  const { repo, exePath, sha256 } = await buildMockRepo()
  try {
    const identityRegistry = new Map()
    let nextPid = 4200
    const spawnImpl = async ({ exe, env }) => {
      const child = makeFakeChild(++nextPid)
      identityRegistry.set(child.pid, { exited: false })
      // The mocked "app" writes the dev handoff exclusively, like the real one.
      await writeFile(env.DSH_DESKTOP_DEV_URL_FILE, `http://127.0.0.1:3099/?token=${FAKE_TOKEN}\n`, 'utf8')
      await writeFile(env.DSH_DESKTOP_DEV_BOOT_FILE, JSON.stringify({
        streamBaseUrl: 'http://127.0.0.1:3099', bootstrapBatchUrl: 'http://127.0.0.1:3099/x.js?rev=abc', graphRevision: 'abc',
      }), 'utf8')
      // The mocked app persists the marker the fake bridge reported as set.
      await mkdir(env.DSH_DESKTOP_USER_DATA_DIR, { recursive: true })
      await writeFile(join(env.DSH_DESKTOP_USER_DATA_DIR, 'settings.json'), JSON.stringify({
        schemaVersion: 1,
        settings: { [SETTINGS_MARKER_KEY]: SETTINGS_MARKER_VALUE },
      }), 'utf8')
      return {
        child,
        identityAtSpawn: { available: true, status: 'present', pid: child.pid, exe, creationTicks: `${133900000000000000n + BigInt(child.pid)}` },
      }
    }
    const identityImpl = async pid => {
      const entry = identityRegistry.get(pid)
      if (!entry || !entry.exited) {
        return { available: true, status: 'present', pid, exe: exePath, creationTicks: `${133900000000000000n + BigInt(pid)}` }
      }
      return { available: false, status: 'absent', pid: null, exe: null, creationTicks: null, reason: 'no process with that pid exists' }
    }
    const tableImpl = async () => ({ available: true, rows: [], rejected: 0, truncated: false, observedAtTicks: 134000000000000000n })
    const fixtureState = {
      requestCount: 0, authAcceptedCount: 2, badAuthCount: 0, toolRoundAnswers: 0,
      finalReplies: 1, cancelMarkerRequests: 1, cancelledCount: 0, completedSlowStreamCount: 0,
      lastFinishReason: 'stop', lastModelWasFixture: true, errorCount: 0, closed: false,
      providerLabel: 'fixture-acceptance (LOCAL TEST FIXTURE)', protocol: 'openai-completions',
    }
    const fixtureFactory = async () => ({
      origin: 'http://127.0.0.1:9471',
      port: 9471,
      facts: () => ({ ...fixtureState }),
      close: async () => {},
    })
    let attachCalls = 0
    const firstChildRef = { current: null }
    const secondChildRef = { current: null }
    const gatewayByCall = ['http://127.0.0.1:3099', 'http://127.0.0.1:3099']
    const cdpAttach = async ({ canonicalOwnedOrigin }) => {
      const gatewayOrigin = gatewayByCall[Math.min(attachCalls, gatewayByCall.length - 1)]
      assert.equal(canonicalOwnedOrigin, gatewayOrigin)
      attachCalls += 1
      const child = attachCalls === 1 ? firstChildRef.current : secondChildRef.current
      return {
        connection: makeFakeConnection({ gatewayOrigin, child, identityRegistry, variant: attachCalls, fixtureState }),
        targetId: `t${attachCalls}`,
      }
    }

    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'mock1'])
    const record = await runAcceptance(args, {
      fetchImpl: async () => ({ json: async () => ({ Browser: 'Edg/120.0' }) }),
      sleepImpl: async () => {},
      spawnImpl: async options => {
        const launched = await spawnImpl(options)
        if (firstChildRef.current === null) firstChildRef.current = launched.child
        else secondChildRef.current = launched.child
        return launched
      },
      identityImpl,
      tableImpl,
      fixtureFactory,
      cdpAttach,
    })

    // The staged patch must be on disk inside the isolated home, labelled and key-free.
    const stagedPatch = await readFile(record.fixture.patchPath, 'utf8')
    assert.ok(stagedPatch.includes('LOCAL TEST FIXTURE'))
    assert.ok(!stagedPatch.includes(FIXTURE_API_KEY), 'the fixture key value must never be staged')

    assert.equal(record.verdict, 'pass', `expected pass, got ${record.verdict}; failed=${JSON.stringify(record.failedRequiredChecks)} missing=${JSON.stringify(record.missingRequiredChecks)}`)
    assert.equal(record.nativeAcceptance, true)
    assert.equal(record.exitCode, 0)
    assert.equal(record.identityComplete, true)
    assert.equal(record.checksSummary.fail, 0)
    assert.equal(record.checksSummary.unqualified, 0)
    assert.equal(record.scenarios.onboarding.status, 'pass')
    assert.equal(record.scenarios.restart.markerOnDisk, true)
    assert.equal(record.scenarios.restart.markerRoundTrip, true)
    assert.equal(record.scenarios.restart.onboardingReappeared, false)
    assert.equal(record.process.descendantAccounting.verified, true)
    assert.equal(JSON.stringify(record).includes(FAKE_TOKEN), false, 'the launch token must never appear in the record')
    // The gate is clean with the record's own known-safe strings (digest,
    // isolation paths, fixture labels) and still catches an injected secret.
    const allowed = [...redactionAllowList(record), 'Fixture acceptance reply.', 'todo_write', 'fixture-model', 'fixture-acceptance']
    assert.deepEqual(findSecretLikeLeaks(record, { allowedStrings: allowed }), [])
    const contaminated = structuredClone(record)
    contaminated.candidate.observedNote = `attached near ${FAKE_TOKEN}`
    assert.deepEqual(
      findSecretLikeLeaks(contaminated, { allowedStrings: allowed }),
      ['$.candidate.observedNote'],
      'the gate must still refuse a token-shaped value that is not allow-listed',
    )
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('I2: a candidate whose hash does not match is refused with nothing launched', async () => {
  const { repo, exePath, sha256 } = await buildMockRepo()
  try {
    let spawnCalls = 0
    const args = parseArgs(['--exe', exePath, '--sha256', 'c'.repeat(64), '--repo', repo, '--stamp', 'mock2'])
    const record = await runAcceptance(args, {
      spawnImpl: async () => { spawnCalls += 1; throw new Error('must never spawn') },
      sleepImpl: async () => {},
    })
    assert.equal(record.verdict, 'refused')
    assert.equal(record.exitCode, 2)
    assert.equal(spawnCalls, 0)
    assert.ok(/hash mismatch/u.test(record.refusalReason))
    void sha256
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('I3: missing runtime payload is a refusal, never a launch attempt', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-acc-repo-'))
  try {
    const exePath = join(repo, 'dsh-desktop.exe')
    const bytes = Buffer.from('MZ mocked')
    await writeFile(exePath, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    let spawnCalls = 0
    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'mock3'])
    const record = await runAcceptance(args, {
      spawnImpl: async () => { spawnCalls += 1; throw new Error('must never spawn') },
      sleepImpl: async () => {},
    })
    assert.equal(record.verdict, 'refused')
    assert.equal(spawnCalls, 0)
    assert.ok(/runtime adapter is missing/u.test(record.refusalReason))
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('I4: --dry-run verifies everything and creates NOTHING, launching nothing', async () => {
  const { repo, exePath, sha256 } = await buildMockRepo()
  try {
    let spawnCalls = 0
    let fixtureCalls = 0
    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'dry1', '--dry-run'])
    const record = await runAcceptance(args, {
      spawnImpl: async () => { spawnCalls += 1; throw new Error('must never spawn') },
      fixtureFactory: async () => { fixtureCalls += 1; throw new Error('must never start the fixture') },
      sleepImpl: async () => {},
    })
    assert.equal(record.verdict, 'dry-run-ok')
    assert.equal(record.exitCode, 0)
    assert.equal(record.dryRun, true)
    assert.equal(spawnCalls, 0)
    assert.equal(fixtureCalls, 0)
    assert.equal(record.dryRunChecks.candidateHashVerified, true)
    assert.equal(record.dryRunChecks.runtimePayloadPresent, true)
    assert.equal(record.dryRunChecks.ownedRootFresh, true)
    // Nothing may have been created: the owned and run roots must still be absent.
    const { access } = await import('node:fs/promises')
    const { constants } = await import('node:fs')
    await assert.rejects(() => access(record.isolation.ownedRoot, constants.F_OK), 'the owned root must not exist after a dry run')
    await assert.rejects(() => access(record.isolation.runRoot, constants.F_OK), 'the run root must not exist after a dry run')
    void sha256
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

test('J1: the chat-observe expression embeds the fixture reply literal, not a placeholder', () => {
  assert.ok(CHAT_OBSERVE_EXPRESSION.includes('Fixture acceptance reply.'))
  assert.ok(!CHAT_OBSERVE_EXPRESSION.includes('FIXTURE_REPLY_PLACEHOLDER'))
  assert.doesNotThrow(() => new Function(`return ${CHAT_OBSERVE_EXPRESSION}`))
})

test('J2: the child environment carries the fence, the CDP switch and the fixture key NAME only', () => {
  const repoRoot = 'C:\\repo'
  const paths = deriveIsolationPaths({ repoRoot, namespace: UUID, stamp: 'env' })
  const args = parseArgs(['--exe', EXE, '--sha256', SHA, '--cdp-port', '9333'])
  const env = buildChildEnvironment({
    args, paths, nodePath: 'C:\\payload\\node\\node.exe', adapterPath: 'C:\\payload\\adapter.mjs',
    runtimeDir: 'C:\\payload', shellDir: 'C:\\shell', handoffIndex: 1,
  })
  assert.equal(env.DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE, UUID)
  assert.equal(env.DSH_HOME, paths.home)
  assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, '--remote-debugging-port=9333 --remote-allow-origins=*')
  assert.equal(env.DSH_ACCEPTANCE_FIXTURE_KEY, FIXTURE_API_KEY)
  assert.equal(env.DSH_DESKTOP_DEV_URL_FILE, join(paths.ownedRoot, 'handoff-1', 'gateway-url.txt'))
  assert.equal(env.DSH_DESKTOP_DEV_BOOT_FILE, join(paths.ownedRoot, 'handoff-1', 'boot.json'))
  assert.ok(env.DSH_HOME.toLowerCase().startsWith(paths.ownedRoot.toLowerCase()), 'the home must stay inside the owned root')
})

test('K1: the staged patch is a plain-YAML overlay bound to the fixture origin', () => {
  const patch = buildFixturePatch({ fixtureOrigin: 'http://127.0.0.1:9471' })
  const baseURLs = patch.split('\n').map(line => line.trim()).filter(line => line.startsWith('baseURL:'))
  assert.equal(baseURLs.length, 1)
  assert.equal(baseURLs[0], 'baseURL: http://127.0.0.1:9471/v1')
  assert.ok(!patch.includes(FIXTURE_API_KEY), 'the key value must never appear in staged config')
  assert.ok(patch.includes(`apiKeyEnv: ${FIXTURE_KEY_ENV}`), 'the credential reference must be the env-var NAME')
})
