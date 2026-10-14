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
import { mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FIXTURE_API_KEY, FIXTURE_KEY_ENV, FIXTURE_MODEL_ID, FIXTURE_ROUTE, parseFixturePort } from './fixture-provider.mjs'
import {
  ACCOUNT_NAV_CLICK_EXPRESSION,
  ACCOUNT_PANEL_EXPRESSION,
  CHAT_OBSERVE_EXPRESSION,
  HOST_FACTS_EXPRESSION,
  ONBOARDING_ACTION_CLICK_EXPRESSION,
  REQUIRED_CHECK_IDS,
  SETTINGS_MARKER_KEY,
  SETTINGS_MARKER_VALUE,
  TERMINAL_CLOSE_EXPRESSION,
  TERMINAL_OPEN_EXPRESSION,
  TERMINAL_STATE_EXPRESSION,
  TERMINAL_TAB_IDS_EXPRESSION,
  buildChildEnvironment,
  buildFixturePatch,
  computeVerdict,
  deriveIsolationPaths,
  evaluateAccountPanel,
  evaluateStaysCompleted,
  evaluateShellUsability,
  findNewTabCloseId,
  findNodeDescendant,
  findPtyChild,
  gracefulQuit,
  identityIsComplete,
  isBootReady,
  parseArgs,
  parseGatewayUrl,
  preflightCandidate,
  redactionAllowList,
  resolveExecutionNode,
  runAcceptance,
  runOnboardingScenario,
  runPtyTerminationLane,
  terminalCloseExpressionForTab,
  truncateHash,
  ptyTerminateFixPresent,
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

test('H4: shell usability requires composer, new-session AND positively-qualified settings', () => {
  const base = { composerHintPresent: true, newSessionPresent: true, settingsPresent: true }
  const opened = { opened: true, dispatched: true, how: 'shortcut-primary+Comma' }
  assert.equal(evaluateShellUsability(base, base, opened).status, 'pass')
  // Text presence alone is NOT evidence: the sidebar trigger is icon-only when the
  // sidebar is collapsed, so the word "settings" neither proves nor disproves that
  // the surface can be reached.
  assert.equal(evaluateShellUsability(base, base, null).status, 'fail', 'unattempted navigation must not pass')
  const notOpened = { opened: false, dispatched: true, how: 'shortcut-primary+Comma' }
  const failed = evaluateShellUsability(base, base, notOpened)
  assert.equal(failed.status, 'fail', 'a dispatched key is never itself a pass')
  assert.equal(/settings=false/u.test(failed.detail), true)
  const noComposer = evaluateShellUsability({ ...base, composerHintPresent: false }, { ...base, composerHintPresent: false }, opened)
  assert.equal(noComposer.status, 'fail')
})

test('H6: onboarding persistence is qualified only by a positively completed first run', () => {
  // The negative shared-mock case: when first-run onboarding never appeared, the
  // restart's absence of the region CANNOT be read as persistence.
  const absent = evaluateStaysCompleted({ firstRunAppeared: false, firstRunCompleted: false, reappeared: false })
  assert.equal(absent.status, 'unqualified', 'absence on restart must never pass')
  assert.match(absent.detail, /cannot evidence persistence/u)
  assert.equal(evaluateStaysCompleted({ firstRunAppeared: true, firstRunCompleted: false, reappeared: false }).status, 'unqualified')
  assert.equal(evaluateStaysCompleted({ firstRunAppeared: false, firstRunCompleted: true, reappeared: false }).status, 'unqualified')

  // Positively completed: the restart outcome is then meaningful.
  assert.equal(evaluateStaysCompleted({ firstRunAppeared: true, firstRunCompleted: true, reappeared: false }).status, 'pass')
  assert.equal(evaluateStaysCompleted({ firstRunAppeared: true, firstRunCompleted: true, reappeared: true }).status, 'fail')
  assert.equal(evaluateStaysCompleted({ firstRunAppeared: true, firstRunCompleted: true, reappeared: null }).status, 'unqualified')

  // The gate is a REQUIRED check, so an unqualified value can never be dropped
  // from acceptance: nativeAcceptance cannot be true on this fact alone.
  const gate = REQUIRED_CHECK_IDS.find(entry => entry === 'onboarding.stays_completed' || entry?.id === 'onboarding.stays_completed')
  assert.ok(gate !== undefined, 'onboarding.stays_completed must stay a required check')
  // Composed end to end: an absent first run yields UNQUALIFIED here, and that
  // status blocks acceptance even with every other required check passing.
  const absentVerdict = computeVerdict({
    checks: passingChecks().map(check => (check.id === 'onboarding.stays_completed' ? { ...check, status: absent.status } : check)),
    identityComplete: true,
  })
  assert.equal(absentVerdict.acceptance, false, 'an absent first run can never produce nativeAcceptance true')
  assert.deepEqual(absentVerdict.failedRequiredChecks, ['onboarding.stays_completed'])
})

/**
 * A minimal document for `ACCOUNT_PANEL_EXPRESSION`: a mounted Settings modal
 * holding one or more `section[aria-label]` panels, each with real controls.
 */
function fakeAccountPanelDom({ navLabel = 'Account', sectionText = '', controls = [], modalPresent = true, sectionPresent = true } = {}) {
  const nodes = controls.map(({ label, disabled = false, ariaDisabled = false }) => ({
    disabled,
    textContent: label,
    getAttribute: name => (name === 'aria-disabled' ? (ariaDisabled ? 'true' : null) : null),
  }))
  const section = {
    innerText: sectionText,
    getAttribute: name => (name === 'aria-label' ? navLabel : null),
    querySelectorAll: () => nodes,
  }
  const modal = {
    innerText: sectionText,
    querySelectorAll: selector => (selector === 'section[aria-label]' && sectionPresent ? [section] : []),
  }
  return { document: { querySelector: () => (modalPresent ? modal : null) }, controls: nodes }
}

const evaluateAccountPanelExpression = dom => new Function('document', `return ${ACCOUNT_PANEL_EXPRESSION}`)(dom.document)

test('H7: the Account panel is identified by a real action affordance, never by prose', () => {
  // Prose only: the signed-out copy MENTIONS signing in, but exposes no control.
  const prose = evaluateAccountPanelExpression(fakeAccountPanelDom({
    sectionText: 'You are not signed in to DeepSeek Harness Sign in to DeepSeek Harness to get your dedicated API Key',
  }))
  assert.equal(prose.signedOutActionPresent, false)
  assert.equal(prose.signedInActionPresent, false)
  assert.equal(prose.signedInMarkerPresent, false)
  assert.equal(prose.affordance, null)
  assert.equal(evaluateAccountPanel(true, prose).status, 'unqualified', 'prose is not an affordance')

  // The signed-out copy in either locale is never read as the signed-in marker.
  for (const text of ['You are not signed in to DeepSeek Harness', '当前未登录 DeepSeek Harness 账号']) {
    const signedOutCopy = evaluateAccountPanelExpression(fakeAccountPanelDom({ sectionText: text }))
    assert.equal(signedOutCopy.signedInMarkerPresent, false, `the signed-out copy must not read as signed in: ${text}`)
    assert.equal(evaluateAccountPanel(true, signedOutCopy).status, 'unqualified')
  }

  // The real signed-out panel button (`t('signIn')`), in either locale.
  for (const [label, navLabel] of [['Sign in', 'Account'], ['登录', '账号与余额']]) {
    const signedOut = evaluateAccountPanelExpression(fakeAccountPanelDom({ controls: [{ label }], navLabel }))
    assert.equal(signedOut.signedOutActionPresent, true)
    assert.equal(signedOut.affordance, 'sign-in-control')
    assert.equal(evaluateAccountPanel(true, signedOut).status, 'pass')
  }

  // A word inside longer copy is NOT the source's action label.
  assert.equal(evaluateAccountPanel(true, evaluateAccountPanelExpression(fakeAccountPanelDom({ controls: [{ label: 'Sign in to view' }] }))).status, 'unqualified')

  // Disabled (or aria-disabled) controls are not affordances.
  assert.equal(evaluateAccountPanel(true, evaluateAccountPanelExpression(fakeAccountPanelDom({ controls: [{ label: 'Sign in', disabled: true }] }))).status, 'unqualified')
  assert.equal(evaluateAccountPanel(true, evaluateAccountPanelExpression(fakeAccountPanelDom({ controls: [{ label: 'Sign in', ariaDisabled: true }] }))).status, 'unqualified')

  // Signed in: a real sign-out control, the signed-in-only account-information
  // control (present even when the identity shows a PROFILE NAME, not the marker
  // copy), or the documented signed-in marker.
  assert.equal(evaluateAccountPanel(true, evaluateAccountPanelExpression(fakeAccountPanelDom({ controls: [{ label: 'Sign out' }] }))).status, 'pass')
  const accountInfo = evaluateAccountPanelExpression(fakeAccountPanelDom({ sectionText: 'Ada Lovelace', controls: [{ label: 'More account information' }] }))
  assert.equal(accountInfo.signedInAccountInfoPresent, true)
  assert.equal(accountInfo.affordance, 'account-info-control')
  assert.equal(evaluateAccountPanel(true, accountInfo).status, 'pass')
  const marker = evaluateAccountPanelExpression(fakeAccountPanelDom({ sectionText: 'Signed in to DeepSeek' }))
  assert.equal(marker.signedInMarkerPresent, true)
  assert.equal(evaluateAccountPanel(true, marker).status, 'pass')

  // Another Settings section is never mistaken for the Account panel.
  const otherSection = evaluateAccountPanelExpression(fakeAccountPanelDom({ navLabel: 'General', controls: [{ label: 'Sign in' }] }))
  assert.equal(otherSection.signedOutActionPresent, false)
  assert.equal(evaluateAccountPanel(true, otherSection).status, 'unqualified')

  // Identification gating: no panel is unqualified; an unclickable entry fails.
  assert.equal(evaluateAccountPanel(true, evaluateAccountPanelExpression(fakeAccountPanelDom({ modalPresent: false }))).status, 'unqualified')
  assert.equal(evaluateAccountPanel(false, evaluateAccountPanelExpression(fakeAccountPanelDom({}))).status, 'fail')

  // The check stays REQUIRED, so an unqualified account surface can never be green.
  assert.ok(REQUIRED_CHECK_IDS.includes('account.surface_reachable'), 'account.surface_reachable must stay required')
})

/** A minimal Settings modal holding only the navigation entries. */
function fakeSettingsNavDom(labels) {
  const nodes = labels.map(label => ({ textContent: label, getAttribute: () => null, clicked: 0, click() { this.clicked += 1 } }))
  return { document: { querySelector: () => ({ querySelectorAll: () => nodes }) }, nodes }
}

const evaluateNavExpression = dom => new Function('document', `return ${ACCOUNT_NAV_CLICK_EXPRESSION}`)(dom.document)

test('H8: the Account navigation entry is clicked by its own nav label in either locale', () => {
  for (const label of ['Account', '账号与余额']) {
    const dom = fakeSettingsNavDom([label])
    const outcome = evaluateNavExpression(dom)
    assert.equal(outcome.clicked, true, `the settings nav entry "${label}" must be clicked`)
    assert.equal(dom.nodes[0].clicked, 1)
  }
  // The localized CHARACTERS alone are not the entry: the full nav label is.
  const absent = evaluateNavExpression(fakeSettingsNavDom(['General', 'Appearance', '账号']))
  assert.equal(absent.clicked, false)
  assert.equal(absent.reason, 'no-account-entry')
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
function makeFakeConnection({ gatewayOrigin, child, identityRegistry, variant, fixtureState, ptyState, onboardingFirstRun = (variant === 1) }) {
  let onboardingStage = 0
  // The terminal lane's DOM contract: the right sidebar panel is open, its guide
  // entry (or the registered `terminal.new` shortcut) mounts a terminal session —
  // `section[data-sidebar-terminal]` with an xterm screen and input, plus ONE new
  // dockkit tab-close hook for the terminal chip. The close hook is what the lane
  // clicks; removing it is the tab close.
  const pty = ptyState ?? { visible: false, tabIds: [] }
  if (!Array.isArray(pty.tabIds)) pty.tabIds = []
  const openTerminalSession = () => {
    pty.visible = true
    if (!pty.tabIds.includes('tab-terminal-1')) pty.tabIds.push('tab-terminal-1')
  }
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
    // First-run onboarding presence is controlled EXPLICITLY, not by an incidental
    // attach counter: a happy-path fixture must positively show and complete the
    // visual flow, and the negative fixture must be able to withhold it so the
    // persistence gate is exercised in both directions.
    onboardingPresent: onboardingFirstRun && onboardingStage < 2,
    onboardingBusy: false,
    bootFailureShown: false,
    textLength: 1200,
  })
  let sendsSeen = 0
  // The settings surface is a shortcut modal: the registered `settings.open`
  // (primary+Comma) opens it and Escape closes it, so the mock tracks the key
  // events instead of answering "mounted" unconditionally.
  let settingsModalOpen = false
  return {
    evaluate: async expression => {
      if (expression === HOST_FACTS_EXPRESSION) {
        return hostFacts()
      }
      if (expression.includes('settings-mounted')) return { record: 'settings-mounted', mounted: settingsModalOpen }
      if (expression.includes('blur-active')) return { record: 'blur-active', blurred: true }
      if (expression.includes('account-nav')) return { record: 'account-nav', clicked: settingsModalOpen }
      if (expression.includes('account-panel')) {
        // The signed-out Account panel exposes its real sign-in control; the check
        // now requires that affordance, not prose.
        return {
          record: 'account-panel', modalPresent: settingsModalOpen, textLength: 64,
          signedOutActionPresent: settingsModalOpen, signedInActionPresent: false, signedInMarkerPresent: false,
          signedOutAffordance: settingsModalOpen, signedInAffordance: false,
          affordance: settingsModalOpen ? 'sign-in-control' : null,
        }
      }
      // Terminal records are answered BEFORE the sidebar ones: the entry, state,
      // tab-id and close expressions all name the right-sidebar panel attributes.
      if (expression.includes('terminal-tab-ids')) return { record: 'terminal-tab-ids', panelPresent: true, ids: [...pty.tabIds] }
      if (expression.includes('terminal-open')) {
        openTerminalSession()
        return { record: 'terminal-open', clicked: true, via: expression.includes('right-sidebar-entry') ? 'right-sidebar-entry' : 'entry' }
      }
      if (expression.includes('terminal-state')) {
        return { record: 'terminal-state', panelPresent: true, surfacePresent: pty.visible, inputPresent: pty.visible }
      }
      if (expression.includes('terminal-close')) {
        // The scoped close expression embeds its captured tab id as a JSON literal;
        // the title-scoped fallback clicks the single terminal chip. A close is only
        // ever reported when the terminal session it names is actually mounted.
        const literal = /const target = (.+);/u.exec(expression)?.[1] ?? null
        let target = null
        if (literal !== null) { try { target = JSON.parse(literal) } catch { target = null } }
        if (target !== null ? !pty.tabIds.includes(target) : pty.tabIds.length === 0) {
          return { record: 'terminal-close', clicked: false, reason: target === null ? 'no-terminal-tab' : 'terminal-tab-id-not-found' }
        }
        const closed = target ?? pty.tabIds[0]
        pty.tabIds = pty.tabIds.filter(id => id !== closed)
        pty.visible = false
        return { record: 'terminal-close', clicked: true, matched: 'data-dockkit-tab-close', via: target === null ? 'title-scoped' : 'captured-new-tab-id', tabId: closed }
      }
      if (expression.includes('sidebar-right-state')) return { record: 'sidebar-right-state', open: true, expandAvailable: true, session: pty.visible === true }
      if (expression.includes('sidebar-right-open')) return { record: 'sidebar-right-open', clicked: false, alreadyOpen: true }
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
      if (expression.includes('runtime-digest')) {
        return { record: 'runtime-digest', bridge: true, resolved: true, state: 'ready', lastErrorPresent: false, startedAtDigest: 'aaaa1111' }
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
    send: async (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params?.key === ',') settingsModalOpen = true
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Escape') settingsModalOpen = false
      // The registered `terminal.new` shortcut (Ctrl+Backquote) opens a session
      // too, so the lane's documented alternative entry is faithful here.
      if (method === 'Input.dispatchKeyEvent' && params?.code === 'Backquote') openTerminalSession()
      return {}
    },
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

    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'mock1', '--without-pty-lane'])
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
    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'mock3', '--runtime-dir', join(repo, 'absent-payload')])
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

test('I5: exe-relative default mode proves the packaged node and the PTY termination lane end to end', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-acc-repo-'))
  try {
    // The candidate exe BESIDE its packaged payload: <exeDir>/dsh/... (the
    // resources the build copies into the Medium target root).
    const candidateDir = join(repo, 'candidate')
    const payloadDir = join(candidateDir, 'dsh')
    const exePath = join(candidateDir, 'dsh-desktop.exe')
    const bytes = Buffer.from('MZ mocked debug candidate (packaged beside payload)')
    await mkdir(candidateDir, { recursive: true })
    await writeFile(exePath, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    await mkdir(join(payloadDir, 'node'), { recursive: true })
    await writeFile(join(payloadDir, 'adapter.mjs'), 'export default 1\n')
    const nodeBytes = Buffer.from('mock packaged interpreter')
    await writeFile(join(payloadDir, 'node', 'node.exe'), nodeBytes)
    await writeFile(join(payloadDir, 'desktop-runtime.json'), JSON.stringify({ node: { version: '22.20.0', target: 'x86_64-pc-windows-msvc' } }))
    // A node-pty Windows agent in the PATCHED shape (every kill drains).
    await mkdir(join(payloadDir, 'node_modules', 'node-pty', 'lib'), { recursive: true })
    await writeFile(join(payloadDir, 'node_modules', 'node-pty', 'lib', 'windowsPtyAgent.js'), [
      'function conpty() {',
      '  this._ptyNative.kill(this._pty, this._useConptyDll);',
      '  this._conoutSocketWorker.dispose();',
      '}',
    ].join('\n'))
    const shellDir = join(repo, 'port', 'ui', 'dist')
    await mkdir(shellDir, { recursive: true })
    await writeFile(join(shellDir, 'index.html'), '<html></html>')

    const identityRegistry = new Map()
    const envCaptures = []
    const HOST_PID = 5100
    const NODE_PID = 5101
    const PWSH_PID = 5102
    const ptyState = { visible: false, tabIds: [] }
    const spawnImpl = async ({ exe, env }) => {
      envCaptures.push({ ...env })
      const child = makeFakeChild(HOST_PID)
      identityRegistry.set(child.pid, { exited: false })
      await writeFile(env.DSH_DESKTOP_DEV_URL_FILE, `http://127.0.0.1:3099/?token=${FAKE_TOKEN}\n`, 'utf8')
      await writeFile(env.DSH_DESKTOP_DEV_BOOT_FILE, JSON.stringify({
        streamBaseUrl: 'http://127.0.0.1:3099', bootstrapBatchUrl: 'http://127.0.0.1:3099/x.js?rev=abc', graphRevision: 'abc',
      }), 'utf8')
      await mkdir(env.DSH_DESKTOP_USER_DATA_DIR, { recursive: true })
      await writeFile(join(env.DSH_DESKTOP_USER_DATA_DIR, 'settings.json'), JSON.stringify({
        schemaVersion: 1, settings: { [SETTINGS_MARKER_KEY]: SETTINGS_MARKER_VALUE },
      }), 'utf8')
      return {
        child,
        identityAtSpawn: { available: true, status: 'present', pid: child.pid, exe, creationTicks: '133900000000005100' },
      }
    }
    const identityImpl = async pid => {
      const entry = identityRegistry.get(pid)
      if (!entry || !entry.exited) {
        return { available: true, status: 'present', pid, exe: exePath, creationTicks: '133900000000005100' }
      }
      return { available: false, status: 'absent', pid: null, exe: null, creationTicks: null, reason: 'no process with that pid exists' }
    }
    const tableImpl = async () => {
      const rows = [
        { pid: HOST_PID, parentPid: 0, creationTicks: '133900000000005100', exe: exePath, name: 'dsh-desktop.exe' },
        { pid: NODE_PID, parentPid: HOST_PID, creationTicks: '133900000000005101', exe: join(payloadDir, 'node', 'node.exe'), name: 'node.exe' },
      ]
      if (ptyState.visible) {
        rows.push({ pid: PWSH_PID, parentPid: HOST_PID, creationTicks: '133900000000005102', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh.exe' })
      }
      return { available: true, rows, rejected: 0, truncated: false, observedAtTicks: 134000000000000000n }
    }
    const fixtureState = {
      requestCount: 0, authAcceptedCount: 2, badAuthCount: 0, toolRoundAnswers: 0,
      finalReplies: 1, cancelMarkerRequests: 1, cancelledCount: 0, completedSlowStreamCount: 0,
      lastFinishReason: 'stop', lastModelWasFixture: true, errorCount: 0, closed: false,
      providerLabel: 'fixture-acceptance (LOCAL TEST FIXTURE)', protocol: 'openai-completions',
    }
    const fixtureFactory = async () => ({
      origin: 'http://127.0.0.1:9471', port: 9471, facts: () => ({ ...fixtureState }), close: async () => {},
    })
    let attachCalls = 0
    const firstChildRef = { current: null }
    const secondChildRef = { current: null }
    const cdpAttach = async ({ canonicalOwnedOrigin }) => {
      attachCalls += 1
      assert.equal(canonicalOwnedOrigin, 'http://127.0.0.1:3099')
      const child = attachCalls === 1 ? firstChildRef.current : secondChildRef.current
      return {
        connection: makeFakeConnection({ gatewayOrigin: 'http://127.0.0.1:3099', child, identityRegistry, variant: attachCalls, fixtureState, ptyState }),
        targetId: `t${attachCalls}`,
      }
    }

    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'mock5'])
    const record = await runAcceptance(args, {
      fetchImpl: async () => ({ json: async () => ({ Browser: 'Edg/120.0' }) }),
      sleepImpl: async () => {},
      spawnImpl: async options => {
        const launched = await spawnImpl(options)
        if (firstChildRef.current === null) firstChildRef.current = launched.child
        else secondChildRef.current = launched.child
        return launched
      },
      identityImpl, tableImpl, fixtureFactory, cdpAttach,
    })

    assert.equal(record.verdict, 'pass', `expected pass, got ${record.verdict}; failed=${JSON.stringify(record.failedRequiredChecks)} missing=${JSON.stringify(record.missingRequiredChecks)}`)
    assert.equal(record.runtime.mode, 'exe-relative-default')
    assert.equal(record.runtime.packagedCandidate.present, true)
    assert.equal(record.runtime.packagedCandidate.nodeSha256, createHash('sha256').update(nodeBytes).digest('hex'))
    assert.equal(record.runtime.defaultNodeProven.observed, true)
    assert.equal(record.runtime.defaultNodeProven.pid, NODE_PID)
    assert.equal(record.runtime.payloadNodePty.ok, true)
    assert.equal(record.scenarios.pty.child.pid, PWSH_PID)
    assert.equal(record.scenarios.pty.terminatedCleanly, true)
    // The lane PASSED on a POSITIVELY MOUNTED terminal surface (xterm screen and
    // input) that the guide entry opened, and on a positively clicked terminal-tab
    // close control while the shell was provably alive.
    assert.equal(record.scenarios.pty.openClicked, true)
    assert.equal(record.scenarios.pty.openVia, 'right-sidebar-entry')
    assert.equal(record.scenarios.pty.surfacePresent, true)
    assert.equal(record.scenarios.pty.inputPresent, true)
    assert.equal(record.scenarios.pty.presentBeforeClose, true)
    assert.equal(record.scenarios.pty.closeClicked, true)
    assert.equal(record.scenarios.pty.closeVia, 'captured-new-tab-id')
    assert.equal(record.scenarios.pty.closeTabId, 'tab-terminal-1')
    assert.equal(record.scenarios.pty.newTabCloseId, 'tab-terminal-1')
    assert.deepEqual(record.scenarios.pty.tabIdsAfter, ['tab-terminal-1'])
    assert.equal(record.scenarios.pty.appStateAfter, 'ready')
    // The child env carried NO runtime overrides: the app had to resolve its own.
    assert.equal(envCaptures.length, 2)
    for (const env of envCaptures) {
      assert.equal(env.DSH_DESKTOP_RUNTIME_DIR, undefined)
      assert.equal(env.DSH_DESKTOP_NODE, undefined)
      assert.equal(env.DSH_DESKTOP_RUNTIME_ADAPTER, undefined)
    }
    const ptyCheck = check => record.checks.find(entry => entry.id === check)
    for (const id of ['payload.pty_terminate_fix_present', 'runtime.default_node_executed', 'pty.lane_executed', 'pty.terminated_cleanly', 'pty.app_healthy_after']) {
      assert.equal(ptyCheck(id).status, 'pass', `${id} must pass`)
      assert.equal(ptyCheck(id).required, true, `${id} must be required in this mode`)
    }
    assert.deepEqual(findSecretLikeLeaks(record, {
      allowedStrings: [...redactionAllowList(record), 'Fixture acceptance reply.', 'todo_write', 'fixture-model', 'fixture-acceptance'],
    }), [])
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// L. Onboarding clicker decision table (0.2.1-alpha.2 flow, fake DOM)
// ---------------------------------------------------------------------------

/**
 * A minimal DOM covering exactly the selectors the click expression uses.
 * Nodes: { tag, attrs, className, text, children, checked, disabled,
 * inPrimaryAction, footer } — the walker matches the expression's fixed
 * selector strings, nothing more.
 */
function fakeNode({ tag = 'button', attrs = {}, className = '', text = '', children = [], checked, disabled, inPrimaryAction = false, footer = false } = {}) {
  const node = {
    tag, attrs, className, textContent: text, children, checked, disabled, inPrimaryAction,
    clicked: 0,
    click() { node.clicked += 1 },
    getAttribute(name) { return attrs[name] ?? null },
    closest(selector) { return selector === 'footer' && footer ? { tag: 'footer' } : null },
    querySelectorAll(selector) { return fakeQueryAll(selector, [node]).filter(candidate => candidate !== node) },
  }
  return node
}

function fakeMatches(selector, node, ancestors) {
  if (selector.startsWith('[class*="dialogButton"]')) return node.className.includes('dialogButton')
  if (selector === 'button, [role="button"]') return node.tag === 'button' || node.attrs.role === 'button'
  if (selector === 'input[type="checkbox"]') return node.tag === 'input' && node.attrs.type === 'checkbox'
  if (selector === '[data-process]') return 'data-process' in node.attrs
  if (selector === '[class*="primaryAction"] button') {
    return node.tag === 'button' && (node.inPrimaryAction === true || ancestors.some(parent => parent.className.includes('primaryAction')))
  }
  return false
}

function fakeQueryAll(selector, nodes) {
  const out = []
  const walk = (children, ancestors) => {
    for (const child of children) {
      if (fakeMatches(selector, child, ancestors)) out.push(child)
      walk(child.children, [...ancestors, child])
    }
  }
  walk(nodes, [])
  return out
}

/** Evaluate the click expression against a fake document. */
function runOnboardingClick({ step, regionChildren, dialogButtons = [] }) {
  const region = step === null ? null : fakeNode({ tag: 'section', attrs: { 'data-desktop-onboarding': step }, children: regionChildren })
  const document = {
    querySelector: selector => (selector === '[data-desktop-onboarding]' ? region : null),
    querySelectorAll: selector => (selector === '[class*="dialogButton"]' ? dialogButtons : []),
  }
  const outcome = new Function('document', 'getComputedStyle', `return ${ONBOARDING_ACTION_CLICK_EXPRESSION}`)(
    document,
    () => ({ display: 'block', visibility: 'visible' }),
  )
  const allClicked = [...dialogButtons, ...fakeQueryAll('button, [role="button"]', region === null ? [] : [region]), ...fakeQueryAll('input[type="checkbox"]', region === null ? [] : [region])]
  const hit = allClicked.find(node => node.clicked > 0)
  return { outcome, hit }
}

test('L1: welcome clicks the start button', () => {
  const { outcome, hit } = runOnboardingClick({
    step: 'welcome',
    regionChildren: [fakeNode({ text: '开始设置', className: 'action start' }), fakeNode({ text: 'Back', footer: true })],
  })
  assert.equal(outcome.clicked, true)
  assert.equal(outcome.matched, 'welcome-start')
  assert.equal(hit.textContent, '开始设置')
})

test('L2: credit never clicks the recharge primary; it takes Next/Later', () => {
  const recharge = fakeNode({ text: '去充值', className: 'action' })
  const next = fakeNode({ text: '下一步', className: 'action laterAction' })
  const { outcome, hit } = runOnboardingClick({ step: 'credit', regionChildren: [recharge, next] })
  assert.equal(outcome.clicked, true)
  assert.equal(outcome.matched, 'credit-next')
  assert.equal(hit, next, 'the recharge primary must never be clicked')
  assert.equal(recharge.clicked, 0)
})

test('L3: credit English copy also avoids "Add credits" and takes "Next"', () => {
  const addCredits = fakeNode({ text: 'Add credits', className: 'action' })
  const next = fakeNode({ text: 'Next', className: 'action laterAction' })
  const { outcome, hit } = runOnboardingClick({ step: 'credit', regionChildren: [addCredits, next] })
  assert.equal(outcome.matched, 'credit-next')
  assert.equal(hit, next)
  assert.equal(addCredits.clicked, 0)
})

test('L4: purpose selects a checkbox before the continue button exists, then continues', () => {
  const office = fakeNode({ tag: 'input', attrs: { type: 'checkbox', 'aria-label': '办公与创作' }, checked: false })
  const development = fakeNode({ tag: 'input', attrs: { type: 'checkbox', 'aria-label': '代码与开发' }, checked: false })
  const first = runOnboardingClick({ step: 'purpose', regionChildren: [office, development] })
  assert.equal(first.outcome.matched, 'purpose-select')
  assert.ok(first.hit === office || first.hit === development, 'a purpose card must be selected first')
  const developmentChecked = fakeNode({ tag: 'input', attrs: { type: 'checkbox' }, checked: true })
  const primary = fakeNode({ text: '继续', inPrimaryAction: true })
  const second = runOnboardingClick({ step: 'purpose', regionChildren: [developmentChecked, primary] })
  assert.equal(second.outcome.matched, 'purpose-continue')
  assert.equal(second.hit, primary)
})

test('L5: process selects a radio before the complete button exists, then completes', () => {
  const radio = (value, checked) => fakeNode({ attrs: { 'data-process': value, 'aria-checked': String(checked) }, text: value })
  const first = runOnboardingClick({ step: 'process', regionChildren: [radio('compact', false), radio('standard', false), radio('detailed', false)] })
  assert.equal(first.outcome.matched, 'process-select')
  const complete = fakeNode({ text: '进入应用', inPrimaryAction: true })
  const second = runOnboardingClick({ step: 'process', regionChildren: [radio('compact', false), radio('standard', true), radio('detailed', false), complete] })
  assert.equal(second.outcome.matched, 'process-complete')
  assert.equal(second.hit, complete)
})

test('L6: a confirmation dialog is answered outside the region, never via recharge', () => {
  const goToRecharge = fakeNode({ text: '前往充值', className: 'dialogButton' })
  const understood = fakeNode({ text: '我知道了', className: 'dialogButton' })
  const { outcome, hit } = runOnboardingClick({
    step: 'credit',
    regionChildren: [fakeNode({ text: '下一步' })],
    dialogButtons: [goToRecharge, understood],
  })
  assert.equal(outcome.clicked, true)
  assert.equal(outcome.matched, 'dialog')
  assert.equal(hit, understood, 'the dialog must be answered, and never via the recharge action')
  assert.equal(goToRecharge.clicked, 0)
})

test('L7: footer skip/back are never generically clicked', () => {
  const { outcome } = runOnboardingClick({
    step: 'purpose',
    regionChildren: [
      fakeNode({ tag: 'input', attrs: { type: 'checkbox' }, checked: true }),
      fakeNode({ text: '跳过', footer: true }),
      fakeNode({ text: '上一步', footer: true }),
    ],
  })
  assert.equal(outcome.clicked, false, 'no non-footer action exists: nothing may be clicked')
  assert.equal(outcome.reason, 'no-action-button')
})

// ---------------------------------------------------------------------------
// M. Attested interpreter copy (--node-exe) — byte identity or refusal
// ---------------------------------------------------------------------------

const lstatOf = map => async path => {
  const entry = map.get(path)
  if (entry === undefined) throw Object.assign(new Error('not found'), { code: 'ENOENT' })
  return entry
}

test('M1: default resolution uses the payload interpreter and records its hash', async () => {
  const payload = await mkdtemp(join(tmpdir(), 'dsh-acc-node-'))
  try {
    const payloadNode = join(payload, 'node.exe')
    const bytes = Buffer.from('mock interpreter 22.20.0 x64')
    await writeFile(payloadNode, bytes)
    const resolved = await resolveExecutionNode({ payloadNodePath: payloadNode, nodeExe: null })
    assert.equal(resolved.source, 'payload')
    assert.equal(resolved.executionPath, payloadNode)
    assert.equal(resolved.executionSha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(resolved.referenceSha256, resolved.executionSha256)
  } finally {
    await rm(payload, { recursive: true, force: true })
  }
})

test('M2: a byte-identical trusted copy is accepted and recorded as the execution path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acc-node-'))
  try {
    const payloadNode = join(dir, 'payload-node.exe')
    const trusted = join(dir, 'trusted-node.exe')
    const bytes = Buffer.from('mock interpreter 22.20.0 x64')
    await writeFile(payloadNode, bytes)
    await writeFile(trusted, bytes) // independent copy, same bytes
    const resolved = await resolveExecutionNode({ payloadNodePath: payloadNode, nodeExe: trusted })
    assert.equal(resolved.source, 'trusted-copy')
    assert.equal(resolved.executionPath, trusted)
    assert.equal(resolved.referencePath, payloadNode)
    assert.equal(resolved.executionSha256, resolved.referenceSha256)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('M3: a copy with different bytes is refused (never a different interpreter/version/arch)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acc-node-'))
  try {
    const payloadNode = join(dir, 'payload-node.exe')
    const trusted = join(dir, 'other-node.exe')
    await writeFile(payloadNode, Buffer.from('mock interpreter 22.20.0 x64'))
    await writeFile(trusted, Buffer.from('mock interpreter 24.0.0 arm64'))
    await assert.rejects(
      () => resolveExecutionNode({ payloadNodePath: payloadNode, nodeExe: trusted }),
      error => error.code === 'refused' && /not byte-identical.*expected.*observed/su.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('M4: a symlink/junction/reparse point is refused even with identical bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acc-node-'))
  try {
    const payloadNode = join(dir, 'payload-node.exe')
    const trusted = join(dir, 'linked-node.exe')
    const bytes = Buffer.from('mock interpreter 22.20.0 x64')
    await writeFile(payloadNode, bytes)
    await writeFile(trusted, bytes)
    const linkMap = new Map([
      [trusted, { isFile: () => true, isSymbolicLink: () => true, dev: 1, ino: 1 }],
      [payloadNode, { isFile: () => true, isSymbolicLink: () => false, dev: 2, ino: 2 }],
    ])
    await assert.rejects(
      () => resolveExecutionNode({ payloadNodePath: payloadNode, nodeExe: trusted, lstatImpl: lstatOf(linkMap) }),
      error => error.code === 'refused' && /regular non-linked file.*symlink, junction or reparse/su.test(error.message),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('M5: the same underlying file (hardlink) is refused: it shares the reference label', async () => {
  const payloadNode = 'C:\\payload\\node\\node.exe'
  const trusted = 'C:\\trusted\\node.exe'
  const sameFile = { isFile: () => true, isSymbolicLink: () => false, dev: 7, ino: 42 }
  await assert.rejects(
    () => resolveExecutionNode({
      payloadNodePath: payloadNode,
      nodeExe: trusted,
      lstatImpl: lstatOf(new Map([[trusted, sameFile], [payloadNode, sameFile]])),
      hashImpl: async () => 'a'.repeat(64),
    }),
    error => error.code === 'refused' && /SAME underlying file.*hardlink/su.test(error.message),
  )
})

test('M6: refusal messages never carry a full 64-hex hash; the truncation passes the leak gate', () => {
  const full = 'ef722d887efcebf23392bff68cef3988f74d460c3bf478f2299f9f55196f674c'
  const truncated = truncateHash(full)
  assert.ok(truncated.length < 20)
  assert.ok(truncated.endsWith('…'))
  // The gate's value rule requires a 40+ alnum run with a digit; 16 chars cannot trip it.
  assert.deepEqual(findSecretLikeLeaks({ refusalReason: `hash mismatch: expected ${truncated}, observed ${truncated}` }), [])
  assert.deepEqual(findSecretLikeLeaks({ refusalReason: `hash mismatch: expected ${full}, observed ${full}` }, { allowedStrings: [full] }).length >= 1, true,
    'the observed (non-allow-listed) hash must remain gate-worthy, so refusals must truncate')
})

// ---------------------------------------------------------------------------
// N. Packaged-node proof + PTY termination lane primitives
// ---------------------------------------------------------------------------

test('N1: the pty fix fact requires EVERY native kill site to drain immediately', () => {
  const patched = [
    'function kill() {',
    '  this._ptyNative.kill(this._pty, this._useConptyDll);',
    '  this._conoutSocketWorker.dispose();',
    '}',
    'function otherBranch() {',
    '  this._ptyNative.kill(this._pty, this._useConptyDll);',
    '',
    '  this._conoutSocketWorker.dispose();',
    '}',
  ].join('\n')
  const patchedResult = ptyTerminateFixPresent(patched)
  assert.equal(patchedResult.ok, true)
  assert.equal(patchedResult.sites, 2)
  assert.equal(patchedResult.sitesWithImmediateDispose, 2)

  // The actual staged 0.2.1-alpha.2 shape: the ConPTY-DLL branch disposes only
  // inside the first-data listener, so a no-output kill never drains.
  const unpatched = [
    'function conpty() {',
    '  this._inSocket.destroy();',
    '  this._ptyNative.kill(this._pty, this._useConptyDll);',
    "  this._outSocket.on('data', function () {",
    '    _this._conoutSocketWorker.dispose();',
    '  });',
    '}',
  ].join('\n')
  const result = ptyTerminateFixPresent(unpatched)
  assert.equal(result.ok, false)
  assert.equal(result.sites, 1)
  assert.equal(result.sitesWithImmediateDispose, 0)
})

// ---------------------------------------------------------------------------
// N1b–N1g: the REAL artifact shapes. The earlier N1 fixture was synthetically
// clean (no comment, one kill site); the reviewed artifact has FOUR kill sites,
// two of them with a `catch { }` boundary and the patched one with a comment
// between the kill and the dispose. The detector must accept that and must still
// reject the exact pre-image, a sibling method's disposal and a callback-only
// disposal.
// ---------------------------------------------------------------------------

/** The line the reviewed patch inserts before the dispose, used to derive the pre-image. */
const PATCH_COMMENT = '            // Start draining even when the exited process has no more output.'

/** The reviewed patched agent's four kill sites, transcribed from the real artifact. */
const REAL_AGENT_LINES = [
  'var WindowsPtyAgent = /** @class */ (function () {',
  '    function WindowsPtyAgent() { }',
  '    WindowsPtyAgent.prototype._completePtyConnection = function () {',
  '        try {',
  '            this._ptyNative.kill(this._pty, this._useConptyDll);',
  '        }',
  '        catch ( /* already gone */_c) { /* already gone */ }',
  '        this._conoutSocketWorker.dispose();',
  '        this._inSocket.destroy();',
  '    };',
  '    WindowsPtyAgent.prototype._failPtyConnection = function (error) {',
  '        try {',
  '            this._ptyNative.kill(this._pty, this._useConptyDll);',
  '        }',
  '        catch ( /* already gone */_a) { /* already gone */ }',
  '        this._conoutSocketWorker.dispose();',
  '        this._inSocket.destroy();',
  '    };',
  '    WindowsPtyAgent.prototype.kill = function () {',
  '        if (this._useConptyDll) {',
  '            this._ptyNative.kill(this._pty, this._useConptyDll);',
  '            this._conoutSocketWorker.dispose();',
  '        }',
  '        else {',
  '            // Close the input write handle to signal the end of session.',
  '            this._inSocket.destroy();',
  '            this._ptyNative.kill(this._pty, this._useConptyDll);',
  PATCH_COMMENT,
  '            this._conoutSocketWorker.dispose();',
  "            this._outSocket.on('data', function () {",
  '                _this._conoutSocketWorker.dispose();',
  '            });',
  '        }',
  '    };',
  '    return WindowsPtyAgent;',
  '}());',
]

/** The exact pre-image: the same file minus the patch's two added lines. */
function preimageOf(lines) {
  const at = lines.indexOf(PATCH_COMMENT)
  assert.ok(at > 0, 'the fixture carries the patch comment')
  return [...lines.slice(0, at), ...lines.slice(at + 2)].join('\n')
}

test('N1b: the REAL four-site patched agent is accepted across comment and catch boundaries', () => {
  const result = ptyTerminateFixPresent(REAL_AGENT_LINES.join('\n'))
  assert.equal(result.ok, true, 'the reviewed patch must be recognised on its real shape')
  assert.equal(result.sites, 4)
  assert.equal(result.sitesWithImmediateDispose, 4)
})

test('N1c: the exact pre-image of the reviewed patch is rejected', () => {
  const result = ptyTerminateFixPresent(preimageOf(REAL_AGENT_LINES))
  assert.equal(result.ok, false, 'the unpatched ConPTY-DLL branch must not be accepted')
  assert.equal(result.sites, 4)
  assert.equal(result.sitesWithImmediateDispose, 3, 'only the ConPTY-DLL branch loses its drain')
})

test('N1d: a sibling method disposal never covers a kill that has none', () => {
  const sibling = [
    '    WindowsPtyAgent.prototype.kill = function () {',
    '        this._ptyNative.kill(this._pty, this._useConptyDll);',
    '    };',
    '    WindowsPtyAgent.prototype.other = function () {',
    '        this._conoutSocketWorker.dispose();',
    '    };',
  ].join('\n')
  const result = ptyTerminateFixPresent(sibling)
  assert.equal(result.ok, false, 'the brace boundary must stop the scan before the next method')
  assert.equal(result.sites, 1)
  assert.equal(result.sitesWithImmediateDispose, 0)
})

test('N1e: a disposal inside a callback body is never proof of draining', () => {
  const callbackOnly = [
    '    WindowsPtyAgent.prototype.kill = function () {',
    '        this._ptyNative.kill(this._pty, this._useConptyDll);',
    "        this._outSocket.on('data', function () {",
    '            _this._conoutSocketWorker.dispose();',
    '        });',
    '    };',
  ].join('\n')
  assert.equal(ptyTerminateFixPresent(callbackOnly).ok, false)
})

/**
 * Read a file, treating ONLY `ENOENT` as "absent". A permission or sharing
 * failure must never be reported as an optional absence, because that would turn
 * a real environment problem into a silent pass.
 */
async function readIfPresent(url) {
  try {
    return await readFile(url, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

test('N1f: the reviewed patch bytes yield an accepted post-image and a rejected pre-image', async () => {
  // The upstream checkout is optional; the reviewed patch is also a TRACKED
  // adopted input under port/runtime-locks, so this case runs against real patch
  // bytes even when no upstream checkout has been built.
  const upstreamPatch = await readIfPresent(new URL('../../../_upstream/patches/node-pty@1.2.0-beta.15.patch', import.meta.url))
  const trackedPatch = await readIfPresent(new URL('../../runtime-locks/windows-x64/patches/node-pty@1.2.0-beta.15.patch', import.meta.url))
  const patch = upstreamPatch ?? trackedPatch
  assert.ok(patch !== null,
    'the reviewed node-pty patch bytes must be available: neither the upstream checkout nor the tracked reviewed input was readable')
  if (upstreamPatch !== null && trackedPatch !== null) {
    assert.equal(trackedPatch, upstreamPatch,
      'the tracked reviewed patch must be byte-identical to the upstream patch it was adopted from')
  }
  const lines = patch.split(/\r?\n/u)
  const start = lines.findIndex(line => line.startsWith('diff --git') && line.includes('windowsPtyAgent.js'))
  assert.ok(start >= 0, 'the reviewed patch carries the Windows agent hunk')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('diff --git'))
  const pre = []
  const post = []
  for (const line of lines.slice(start, end < 0 ? lines.length : end)) {
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('index ')) continue
    if (line.startsWith('+')) post.push(line.slice(1))
    else if (line.startsWith('-')) pre.push(line.slice(1))
    else if (line.startsWith(' ')) { pre.push(line.slice(1)); post.push(line.slice(1)) }
  }
  assert.equal(ptyTerminateFixPresent(post.join('\n')).ok, true, 'the patch post-image must be accepted')
  assert.equal(ptyTerminateFixPresent(pre.join('\n')).ok, false, 'the patch pre-image must be rejected')
})

test('N1g: the installed patched agent, when present, is accepted', async (t) => {
  const store = new URL('../../../_upstream/node_modules/.pnpm/', import.meta.url)
  let entries
  try {
    entries = await readdir(store)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      t.skip('the upstream checkout has no installed .pnpm store, so the installed patched agent cannot be exercised')
      return
    }
    throw error
  }
  const directory = entries.find(name => name.startsWith('node-pty@1.2.0-beta.15') && name.includes('_patc'))
  if (directory === undefined) {
    t.skip('the upstream store holds no patched node-pty@1.2.0-beta.15 install (the _patc variant)')
    return
  }
  const agent = await readIfPresent(new URL(`${directory}/node_modules/node-pty/lib/windowsPtyAgent.js`, store))
  if (agent === null) {
    t.skip(`the installed patched node-pty (${directory}) has no lib/windowsPtyAgent.js`)
    return
  }
  const result = ptyTerminateFixPresent(agent)
  assert.equal(result.ok, true, 'the actually installed patched agent must be recognised')
  assert.equal(result.sites, 4)
  assert.equal(result.sitesWithImmediateDispose, 4)
})

test('N2: exe-relative default mode strips every runtime override from the child env', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: 'env2' })
  const args = parseArgs(['--exe', EXE, '--sha256', SHA, '--cdp-port', '9333'])
  const previousNode = process.env.DSH_DESKTOP_NODE
  const previousPrimary = process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
  process.env.DSH_DESKTOP_NODE = 'C:\\inherited\\node.exe'
  process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR = 'C:\\inherited'
  try {
    const env = buildChildEnvironment({
      args, paths, nodePath: null, adapterPath: null, runtimeDir: null, shellDir: 'C:\\shell',
      runtimeMode: 'exe-relative-default', handoffIndex: 1,
    })
    assert.equal(env.DSH_DESKTOP_RUNTIME_DIR, undefined)
    assert.equal(env.DSH_DESKTOP_NODE, undefined)
    assert.equal(env.DSH_DESKTOP_RUNTIME_ADAPTER, undefined)
    assert.equal(env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR, undefined, 'inherited overrides must be deleted, not kept')
    assert.equal(env.DSH_HOME, paths.home)
  } finally {
    if (previousNode === undefined) delete process.env.DSH_DESKTOP_NODE
    else process.env.DSH_DESKTOP_NODE = previousNode
    if (previousPrimary === undefined) delete process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR
    else process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR = previousPrimary
  }
  const explicit = buildChildEnvironment({
    args, paths, nodePath: 'C:\\payload\\node\\node.exe', adapterPath: 'C:\\payload\\adapter.mjs',
    runtimeDir: 'C:\\payload', shellDir: 'C:\\shell', runtimeMode: 'explicit-payload', handoffIndex: 1,
  })
  assert.equal(explicit.DSH_DESKTOP_NODE, 'C:\\payload\\node\\node.exe')
  assert.equal(explicit.DSH_DESKTOP_RUNTIME_DIR, 'C:\\payload')
})

test('N3: node and PTY child attribution match only the right descendants', () => {
  const rows = [
    { pid: 10, parentPid: 0, creationTicks: '1', exe: 'C:\\app\\dsh-desktop.exe', name: 'dsh-desktop.exe' },
    { pid: 11, parentPid: 10, creationTicks: '2', exe: 'C:\\app\\dsh\\node\\node.exe', name: 'node.exe' },
    { pid: 12, parentPid: 10, creationTicks: '3', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh.exe' },
  ]
  assert.equal(findNodeDescendant(rows, 'C:/app/dsh/node/node.exe')?.pid, 11, 'path comparison normalizes separators and case')
  assert.equal(findNodeDescendant(rows, 'C:\\other\\node.exe'), null)
  assert.equal(findPtyChild(rows, []).pid, 12)
  assert.equal(findPtyChild(rows, [{ pid: 12, creationTicks: '3' }]), null, 'a baseline child is never the PTY child')
  assert.equal(
    findPtyChild([{ pid: 13, parentPid: 10, creationTicks: '4', exe: 'C:\\Windows\\notepad.exe', name: 'notepad.exe' }], []),
    null,
    'non-shell processes are never the PTY child',
  )
})

test('N4: the terminal and account expressions are fixed constants without interpolation', () => {
  for (const expression of [TERMINAL_OPEN_EXPRESSION, TERMINAL_STATE_EXPRESSION, TERMINAL_TAB_IDS_EXPRESSION, TERMINAL_CLOSE_EXPRESSION, ACCOUNT_PANEL_EXPRESSION]) {
    assert.ok(!expression.includes('${'))
    assert.doesNotThrow(() => new Function(`return ${expression}`))
  }
})

test('N5: the terminal tab close hook is selected only from ONE newly appeared id', () => {
  assert.deepEqual(findNewTabCloseId(['guide-1'], ['guide-1', 'terminal-1']), {
    id: 'terminal-1',
    reason: 'exactly one new tab-close hook appeared',
  })
  // The entry replaced the guide chip in place: no new hook, nothing is guessed at.
  const replaced = findNewTabCloseId(['guide-1'], ['guide-1'])
  assert.equal(replaced.id, null)
  assert.match(replaced.reason, /no new tab-close hook/u)
  // Several new tabs are ambiguous.
  const several = findNewTabCloseId([], ['a', 'b'])
  assert.equal(several.id, null)
  assert.match(several.reason, /2 new tab-close hooks/u)
  // Degenerate inputs never invent an id.
  assert.equal(findNewTabCloseId([], []).id, null)
  assert.equal(findNewTabCloseId(undefined, undefined).id, null)
  assert.equal(findNewTabCloseId([], ['', null, 'x']).id, 'x', 'empty hooks are never ids')
  assert.equal(findNewTabCloseId([], ['x', 'x']).id, 'x', 'the same hook reported twice is still one hook')
})

/** A minimal dockkit panel: chips with a title span and their own close hooks. */
function fakeTerminalPanelDom(chips) {
  const controls = []
  const chipNodes = chips.map(({ id, title }) => {
    const control = {
      clicked: 0,
      getAttribute: name => (name === 'data-dockkit-tab-close' ? id : null),
      click() { this.clicked += 1 },
    }
    controls.push(control)
    const titleNode = { textContent: title }
    return {
      textContent: title,
      getAttribute: () => null,
      querySelector: selector => (selector === '[data-dockkit-tab-title]' ? titleNode : (selector === '[data-dockkit-tab-close]' ? control : null)),
    }
  })
  const panel = {
    querySelectorAll: selector => (selector === '[data-dockkit-tab]' ? chipNodes : (selector === '[data-dockkit-tab-close]' ? controls : [])),
  }
  return {
    document: { querySelector: selector => (selector === '[data-sidebar-right-session]' || selector === '[data-sidebar-right-open]' ? panel : null) },
    controls,
  }
}

const evaluatePanelExpression = (expression, dom) => new Function('document', `return ${expression}`)(dom.document)

test('N6: the tab-close expressions only ever click the terminal chip, and refuse ambiguity', () => {
  // A guide chip and a terminal chip: only the terminal chip's close is clicked.
  const dom = fakeTerminalPanelDom([{ id: 'guide-1', title: 'Guide' }, { id: 'terminal-1', title: 'Terminal' }])
  const outcome = evaluatePanelExpression(TERMINAL_CLOSE_EXPRESSION, dom)
  assert.equal(outcome.clicked, true)
  assert.equal(outcome.via, 'title-scoped')
  assert.equal(outcome.tabId, 'terminal-1')
  assert.deepEqual(dom.controls.map(control => control.clicked), [0, 1], 'the guide chip must never be closed')

  // The localized terminal title is recognized too.
  const zh = fakeTerminalPanelDom([{ id: 't-zh', title: '终端' }])
  assert.equal(evaluatePanelExpression(TERMINAL_CLOSE_EXPRESSION, zh).tabId, 't-zh')

  // Two terminal chips are ambiguous: nothing is clicked.
  const two = fakeTerminalPanelDom([{ id: 'a', title: 'Terminal' }, { id: 'b', title: 'Terminal' }])
  const ambiguous = evaluatePanelExpression(TERMINAL_CLOSE_EXPRESSION, two)
  assert.equal(ambiguous.clicked, false)
  assert.equal(ambiguous.reason, 'ambiguous-terminal-tab')
  assert.deepEqual(two.controls.map(control => control.clicked), [0, 0])

  // No terminal chip: nothing is clicked.
  const none = fakeTerminalPanelDom([{ id: 'g', title: 'Guide' }])
  const absent = evaluatePanelExpression(TERMINAL_CLOSE_EXPRESSION, none)
  assert.equal(absent.clicked, false)
  assert.equal(absent.reason, 'no-terminal-tab')

  // The captured-id expression addresses exactly that tab, even among several.
  const scoped = fakeTerminalPanelDom([{ id: 'guide-1', title: 'Guide' }, { id: 'terminal-1', title: 'Terminal' }, { id: 'terminal-2', title: 'Terminal' }])
  const exact = evaluatePanelExpression(terminalCloseExpressionForTab('terminal-2'), scoped)
  assert.equal(exact.clicked, true)
  assert.equal(exact.tabId, 'terminal-2')
  assert.deepEqual(scoped.controls.map(control => control.clicked), [0, 0, 1])

  // A vanished id is never redirected to another tab.
  const gone = evaluatePanelExpression(terminalCloseExpressionForTab('terminal-9'), scoped)
  assert.equal(gone.clicked, false)
  assert.equal(gone.reason, 'terminal-tab-id-not-found')
  assert.deepEqual(scoped.controls.map(control => control.clicked), [0, 0, 1])

  // A DOM-supplied id is DATA: it is embedded as a JSON string literal and can
  // never inject code, and it is still matched exactly.
  const hostileId = "x'; globalThis.pwned = true; //"
  const hostile = terminalCloseExpressionForTab(hostileId)
  assert.ok(hostile !== null)
  const hostileDom = fakeTerminalPanelDom([{ id: hostileId, title: 'Terminal' }])
  const hostileOutcome = evaluatePanelExpression(hostile, hostileDom)
  assert.equal(hostileOutcome.clicked, true, 'the hostile id matches as data')
  assert.equal(hostileOutcome.tabId, hostileId)
  assert.equal(globalThis.pwned, undefined, 'no injected code ran')

  // Only a bounded, non-empty id is ever embedded.
  assert.equal(terminalCloseExpressionForTab(''), null)
  assert.equal(terminalCloseExpressionForTab(null), null)
  assert.equal(terminalCloseExpressionForTab('a'.repeat(129)), null)
  assert.ok(terminalCloseExpressionForTab('tab:0a1b-2').includes('"tab:0a1b-2"'))
})

/**
 * The minimal lane collaborators: a fake connection answering exactly the
 * terminal lane's expressions, over a mutable process table whose shell row is
 * owned by the terminal session.
 */
function ptyLaneHarness({
  surface = true, input = true, shortcutOnly = false, closeClicked = true,
  vanishBeforeClose = false, tableUnavailableAtClose = false, baselineUnavailable = false,
  sidebarOpen = true, entryOpens = true, preexistingSession = false, shellAppearsLater = false,
  tabIdsBefore = ['guide-tab'], newTabIds = ['terminal-tab'],
} = {}) {
  const HOST_PID = 9000
  const SHELL_PID = 9001
  const state = {
    terminalOpen: preexistingSession,
    shellAlive: false,
    tabIds: preexistingSession ? [...tabIdsBefore, ...newTabIds] : [...tabIdsBefore],
    shortcutDispatches: 0,
    closeRequested: false,
  }
  let reads = 0
  const openSession = () => {
    state.terminalOpen = true
    state.shellAlive = true
    state.tabIds = [...tabIdsBefore, ...newTabIds]
  }
  const connection = {
    evaluate: async expression => {
      if (expression.includes('terminal-tab-ids')) return { record: 'terminal-tab-ids', panelPresent: true, ids: [...state.tabIds] }
      if (expression.includes('terminal-open')) {
        if (shortcutOnly || !entryOpens) return { record: 'terminal-open', clicked: false, via: 'right-sidebar-entry' }
        openSession()
        return { record: 'terminal-open', clicked: true, via: 'right-sidebar-entry' }
      }
      if (expression.includes('terminal-state')) {
        return { record: 'terminal-state', panelPresent: true, surfacePresent: state.terminalOpen && surface, inputPresent: state.terminalOpen && input }
      }
      if (expression.includes('terminal-close')) {
        if (!closeClicked) return { record: 'terminal-close', clicked: false, reason: 'no-terminal-tab' }
        state.closeRequested = true
        state.shellAlive = false
        state.tabIds = state.tabIds.filter(id => !newTabIds.includes(id))
        return { record: 'terminal-close', clicked: true, matched: 'data-dockkit-tab-close', via: 'captured-new-tab-id', tabId: newTabIds[0] ?? null }
      }
      if (expression.includes('sidebar-right-state')) return { record: 'sidebar-right-state', open: sidebarOpen, expandAvailable: true, session: state.terminalOpen }
      if (expression.includes('sidebar-right-open')) return { record: 'sidebar-right-open', clicked: false, alreadyOpen: sidebarOpen }
      if (expression.includes('runtime-digest')) {
        return { record: 'runtime-digest', bridge: true, resolved: true, state: 'ready', lastErrorPresent: false, startedAtDigest: 'aaaa1111' }
      }
      throw new Error(`unexpected expression in the pty lane harness: ${expression}`)
    },
    send: async (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params?.code === 'Backquote') {
        state.shortcutDispatches += 1
        if (shortcutOnly) openSession()
      }
      return {}
    },
    close: async () => {},
  }
  const tableImpl = async () => {
    reads += 1
    if (baselineUnavailable && reads === 1) {
      return { available: false, rows: [], rejected: 0, truncated: false, observedAtTicks: 500n }
    }
    if (tableUnavailableAtClose && reads >= 3) {
      return { available: false, rows: [], rejected: 0, truncated: false, observedAtTicks: 500n }
    }
    if (vanishBeforeClose && reads >= 3) state.shellAlive = false
    // A shell that shows up after the unknown/stale baseline: it stays alive until
    // the tab close actually removes it, so absence after the close is meaningful.
    if (shellAppearsLater && reads >= 2 && state.closeRequested !== true) state.shellAlive = true
    const rows = [{ pid: HOST_PID, parentPid: 0, creationTicks: '100', exe: 'C:\\app\\dsh-desktop.exe', name: 'dsh-desktop.exe' }]
    if (state.shellAlive) {
      rows.push({ pid: SHELL_PID, parentPid: HOST_PID, creationTicks: '101', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh.exe' })
    }
    return { available: true, rows, rejected: 0, truncated: false, observedAtTicks: 500n }
  }
  const identityAtSpawn = { available: true, status: 'present', pid: HOST_PID, exe: 'C:\\app\\dsh-desktop.exe', creationTicks: '100' }
  return { connection, tableImpl, identityAtSpawn, state, HOST_PID, SHELL_PID }
}

const runLane = harness => runPtyTerminationLane({
  connection: harness.connection,
  tableImpl: harness.tableImpl,
  identityAtSpawn: harness.identityAtSpawn,
  args: parseArgs([
    '--exe', EXE, '--sha256', SHA,
    '--pty-open-timeout-ms', '3000',
    '--pty-settle-timeout-ms', '2000',
  ]),
  sleepImpl: async () => {},
  log: () => {},
})

test('N7: the lane qualifies the terminal through the documented terminal.new shortcut too', async () => {
  const lane = await runLane(ptyLaneHarness({ shortcutOnly: true }))
  assert.equal(lane.laneStatus, 'pass')
  assert.equal(lane.facts.openVia, 'shortcut-terminal.new')
  assert.equal(lane.facts.surfacePresent, true)
  assert.equal(lane.facts.inputPresent, true)
  assert.equal(lane.facts.closeClicked, true)
  assert.equal(lane.terminateStatus, 'pass')
  assert.equal(lane.healthStatus, 'pass')
})

test('N8: an attributed shell with NO mounted terminal surface must never pass the lane, and is still cleaned up', async () => {
  const lane = await runLane(ptyLaneHarness({ surface: false, input: false }))
  assert.equal(lane.laneStatus, 'fail', 'a shell descendant alone is not a mounted terminal surface')
  assert.match(lane.laneDetail, /not positively qualified/u)
  assert.match(lane.laneDetail, /surface=false/u)
  assert.equal(lane.facts.surfacePresent, false)
  assert.equal(lane.facts.inputPresent, false)
  assert.equal(lane.facts.closeClicked, true, 'the lane still closes the tab it opened: the shell must not leak')
  assert.equal(lane.terminateStatus, 'pass', 'the owned shell is still proven terminated')
  assert.equal(lane.healthStatus, 'pass')
})

test('N9: absence alone is never termination: an unclicked tab close cannot pass', async () => {
  const lane = await runLane(ptyLaneHarness({ closeClicked: false }))
  assert.equal(lane.laneStatus, 'pass')
  assert.equal(lane.facts.presentBeforeClose, true)
  assert.equal(lane.facts.closeClicked, false)
  assert.equal(lane.terminateStatus, 'fail')
  assert.match(lane.terminateDetail, /never positively clicked/u)
})

test('N10: a shell that exited before the close request cannot evidence tab-close teardown', async () => {
  const lane = await runLane(ptyLaneHarness({ vanishBeforeClose: true }))
  assert.equal(lane.facts.presentBeforeClose, false)
  assert.equal(lane.facts.terminatedCleanly, true, 'the shell is absent afterwards')
  assert.equal(lane.terminateStatus, 'unqualified', 'a natural exit is never proof of tab-close teardown')
  assert.match(lane.terminateDetail, /already exited before the close request/u)
})

test('N11: an unreadable process table before the close is never a qualified termination', async () => {
  const lane = await runLane(ptyLaneHarness({ tableUnavailableAtClose: true }))
  assert.equal(lane.facts.presentBeforeClose, null)
  assert.equal(lane.facts.closeClicked, true)
  assert.equal(lane.terminateStatus, 'unqualified')
  assert.match(lane.terminateDetail, /could not positively confirm/u)
})

test('N12: a NEW shell with a mounted terminal but NO positively opened terminal must not pass the lane', async () => {
  // The sidebar never opened and the entry click failed, so the shortcut was never
  // dispatched; a terminal session was already mounted and a new shell appeared
  // under the host anyway. Attribution plus UI alone must not qualify the lane.
  const harness = ptyLaneHarness({
    sidebarOpen: false,
    entryOpens: false,
    preexistingSession: true,
    shellAppearsLater: true,
  })
  const lane = await runLane(harness)
  assert.equal(lane.facts.openClicked, false)
  assert.equal(lane.facts.openVia, null)
  assert.equal(harness.state.shortcutDispatches, 0, 'no terminal.new shortcut may be sent when the sidebar is not open')
  assert.equal(lane.facts.tableAvailable, true)
  assert.equal(lane.facts.child.pid, 9001, 'the new shell was attributed')
  assert.equal(lane.facts.surfacePresent, true)
  assert.equal(lane.facts.inputPresent, true)
  assert.equal(lane.laneStatus, 'fail', 'a terminal the lane never opened is not evidence that the client can open one')
  assert.match(lane.laneDetail, /open=false/u)
  // Cleanup, termination and health are unaffected by the failed qualification.
  assert.equal(lane.facts.closeClicked, true)
  assert.equal(lane.terminateStatus, 'pass')
  assert.equal(lane.healthStatus, 'pass')
})

test('N13: an unknown pre-open baseline cannot qualify a later shell, even with the UI mounted', async () => {
  // The very first descendant read failed, so an already-running shell would be
  // indistinguishable from a new one: no positive attribution is possible.
  const lane = await runLane(ptyLaneHarness({ baselineUnavailable: true }))
  assert.equal(lane.facts.tableAvailable, false)
  assert.equal(lane.facts.openClicked, true)
  assert.equal(lane.facts.child.pid, 9001)
  assert.equal(lane.facts.surfacePresent, true)
  assert.equal(lane.facts.inputPresent, true)
  assert.equal(lane.laneStatus, 'fail', 'an unknown baseline can never qualify a shell as newly spawned')
  assert.match(lane.laneDetail, /baselineTable=false/u)
  assert.equal(lane.facts.closeClicked, true)
  assert.equal(lane.terminateStatus, 'pass', 'the termination gates themselves stay intact')
  assert.equal(lane.healthStatus, 'pass')
})
