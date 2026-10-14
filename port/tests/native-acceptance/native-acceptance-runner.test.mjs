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
import { access, mkdtemp, mkdir, writeFile, rm, readdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'

import { FIXTURE_API_KEY, FIXTURE_KEY_ENV, FIXTURE_MODEL_ID, FIXTURE_ROUTE, parseFixturePort } from './fixture-provider.mjs'
import {
  ACCOUNT_MENU_CLOSE_EXPRESSION,
  ACCOUNT_MENU_EXPRESSION,
  ACCOUNT_MENU_OPEN_EXPRESSION,
  ACCOUNT_NAV_CLICK_EXPRESSION,
  ACCOUNT_PANEL_EXPRESSION,
  CHAT_OBSERVE_EXPRESSION,
  HOST_FACTS_EXPRESSION,
  ONBOARDING_ACTION_CLICK_EXPRESSION,
  REQUIRED_CHECK_IDS,
  SETTINGS_MARKER_KEY,
  SETTINGS_MARKER_VALUE,
  SIDEBAR_RIGHT_OPEN_EXPRESSION,
  SIDEBAR_RIGHT_STATE_EXPRESSION,
  TERMINAL_CLOSE_EXPRESSION,
  TERMINAL_ENTRY_EXPRESSION,
  TERMINAL_FOCUS_EXPRESSION,
  TERMINAL_OPEN_EXPRESSION,
  TERMINAL_ROWS_EXPRESSION,
  TERMINAL_STATE_EXPRESSION,
  TERMINAL_TAB_IDS_EXPRESSION,
  buildChildEnvironment,
  buildFixturePatch,
  classifyRunnerOnlyEnvName,
  computeVerdict,
  deriveIsolationPaths,
  derivePlainShellName,
  evaluateAccountMenu,
  evaluateAccountPanel,
  evaluateStaysCompleted,
  evaluateShellUsability,
  findNewTabCloseId,
  findNodeDescendant,
  findShellChild,
  gracefulQuit,
  identityIsComplete,
  isBootReady,
  parseArgs,
  parseGatewayUrl,
  preflightCandidate,
  redactionAllowList,
  resolveExecutionNode,
  resolveShellDirPlan,
  runAcceptance,
  runOnboardingScenario,
  runPtyTerminationLane,
  runSettingsScenario,
  closeAccountMenu,
  terminalCloseExpressionForTab,
  terminalTabTitleExpressionForTab,
  truncateHash,
  ptyTerminateFixPresent,
} from './native-acceptance-runner.mjs'
import { findSecretLikeLeaks } from '../native-cdp/native-cdp-probe.mjs'
import { classifyFixtureEnvName } from '../helpers/fixture-isolation.mjs'

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
  // The SOURCE-tree UI lane: what the repo carries and what an explicit
  // `--shell-dir` / explicit-payload run exports.
  const shellDir = join(repo, 'port', 'ui', 'dist')
  await mkdir(shellDir, { recursive: true })
  await writeFile(join(shellDir, 'index.html'), '<html></html>')
  // The PACKAGED default lane: an assembled candidate carries its UI BESIDE the
  // executable, and a packaged-default run refuses preflight without it.
  const packagedShellDir = join(exeDir, 'ui')
  await mkdir(packagedShellDir, { recursive: true })
  await writeFile(join(packagedShellDir, 'index.html'), '<html><body>packaged-ui</body></html>')
  return { repo, exePath, sha256, packagedShellDir }
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
  if (pty.typed === undefined) pty.typed = null
  if (pty.entered === undefined) pty.entered = false
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
  // events instead of answering "mounted" unconditionally. The account launcher's
  // popover is tracked the same way (the real one closes on Escape too).
  let settingsModalOpen = false
  let accountMenuOpen = false
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
      // The always-mounted account launcher (`settings.launcher` AccountMenu): its
      // popover is openable without any stored credential and carries the sign-in row.
      if (expression.includes('account-menu-open')) {
        const alreadyOpen = accountMenuOpen
        accountMenuOpen = true
        return { record: 'account-menu-open', triggerPresent: true, clicked: !alreadyOpen, alreadyOpen, ariaLabel: 'Account menu' }
      }
      if (expression.includes('account-menu-close')) {
        const wasOpen = accountMenuOpen
        accountMenuOpen = false
        return { record: 'account-menu-close', closed: true, reason: wasOpen ? 'trigger-toggled' : 'already-collapsed' }
      }
      if (expression.includes('account-menu')) {
        return accountMenuOpen
          ? { record: 'account-menu', accountMenuPresent: true, itemCount: 3, itemLabels: ['Settings', 'Feedback', 'Sign in'], signInItemPresent: true, signInItemLabel: 'Sign in', signOutItemPresent: false }
          : { record: 'account-menu', accountMenuPresent: false, itemCount: 0, itemLabels: [], signInItemPresent: false, signInItemLabel: null, signOutItemPresent: false }
      }
      // Terminal records are answered BEFORE the sidebar ones: the entry, state,
      // tab-id and close expressions all name the right-sidebar panel attributes.
      if (expression.includes('terminal-tab-ids')) return { record: 'terminal-tab-ids', panelPresent: true, ids: [...pty.tabIds] }
      if (expression.includes('terminal-tab-title')) {
        const literal = /const target = (.+);/u.exec(expression)?.[1] ?? null
        let tabId = null
        if (literal !== null) { try { tabId = JSON.parse(literal) } catch { tabId = null } }
        const present = pty.visible === true && tabId !== null && pty.tabIds.includes(tabId)
        // The live 0.2.1-alpha.2 chip title IS the host-resolved shell name.
        return { record: 'terminal-tab-title', tabId, chipPresent: present, title: present ? 'cmd.exe' : null, closeHookId: present ? tabId : null }
      }
      if (expression.includes('terminal-open')) {
        openTerminalSession()
        return { record: 'terminal-open', clicked: true, via: expression.includes('right-sidebar-entry') ? 'right-sidebar-entry' : 'entry' }
      }
      if (expression.includes('terminal-state')) {
        return { record: 'terminal-state', panelPresent: true, surfacePresent: pty.visible, inputPresent: pty.visible }
      }
      if (expression.includes('terminal-focus')) {
        return pty.visible ? { record: 'terminal-focus', focused: true } : { record: 'terminal-focus', focused: false, reason: 'no-terminal-input' }
      }
      if (expression.includes('terminal-rows')) {
        // Emulate a real cmd session: the typed command is echoed on its own row and
        // its output returns as a separate row, with blank spacer rows after it.
        const echoed = pty.typed === null ? [] : [`C:\\Windows\\system32>${pty.typed}`]
        const output = pty.typed !== null && pty.entered === true ? [pty.typed.replace(/^echo /u, '')] : []
        const rows = ['Microsoft Windows [Version 10.0.19045.3803]', ...echoed, ...output, '', '', '']
        return { record: 'terminal-rows', rowsPresent: true, rowCount: rows.length, texts: rows }
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
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Escape') { settingsModalOpen = false; accountMenuOpen = false }
      // The registered `terminal.new` shortcut (Ctrl+Backquote) opens a session
      // too, so the lane's documented alternative entry is faithful here.
      if (method === 'Input.dispatchKeyEvent' && params?.code === 'Backquote') openTerminalSession()
      if (method === 'Input.insertText' && typeof params?.text === 'string') pty.typed = params.text
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Enter') pty.entered = true
      return {}
    },
    close: async () => {},
  }
}

test('I1: the full mocked run is green only on the complete happy path, leaks nothing, and records no token', async () => {
  const { repo, exePath, sha256 } = await buildMockRepo()
  try {
    const identityRegistry = new Map()
    const envCaptures = []
    let nextPid = 4200
    const spawnImpl = async ({ exe, env }) => {
      envCaptures.push({ ...env })
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

    const explicitShellDir = join(repo, 'port', 'ui', 'dist')
    const args = parseArgs(['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'mock1', '--without-pty-lane', '--shell-dir', explicitShellDir])
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
    // The explicit --shell-dir is the override lane: it is labelled as such and
    // exported UNCHANGED to every launch (both handoffs), never dropped in favour
    // of the packaged default.
    assert.equal(record.runtime.shellDirSource, 'explicit-arg')
    assert.equal(record.runtime.shellDir, explicitShellDir)
    assert.equal(record.runtime.shellAssets.envOverride, true)
    assert.equal(envCaptures.length, 2, 'both handoffs must be captured')
    for (const env of envCaptures) {
      assert.equal(env.DSH_DESKTOP_SHELL_DIR, explicitShellDir, 'an explicit UI override must be preserved, not deleted')
    }
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
  assert.equal(env.DSH_DESKTOP_DEV_CDP_PORT, '9333')
  assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined, 'no ambient browser-argument channel is exported')
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
  // A stale inherited UI override must be DELETED, never passed through: pollute
  // the parent environment so the packaged-default lane has to remove it. An
  // ambient endpoint override is polluted too: it is not covered by the shared
  // deny rules, so the runner's own rule is what must keep it out of the child.
  const inheritedShellDir = process.env.DSH_DESKTOP_SHELL_DIR
  const inheritedEndpoint = process.env.DEEPSEEK_BASE_URL
  process.env.DSH_DESKTOP_SHELL_DIR = 'C:\\inherited-stale-ui'
  process.env.DEEPSEEK_BASE_URL = 'https://operator-endpoint.invalid'
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
    // The packaged layout the build assembles in the Medium target root: the UI
    // must sit BESIDE the executable (`<exe_dir>/ui`), never in the repo source
    // tree — a repo-source UI would prove nothing about the assembled product.
    const shellDir = join(candidateDir, 'ui')
    await mkdir(shellDir, { recursive: true })
    await writeFile(join(shellDir, 'index.html'), '<html><body>packaged-ui</body></html>')

    const identityRegistry = new Map()
    const envCaptures = []
    // Every fixture-owned root the child is handed must already EXIST when the
    // native window is created; a missing one would push the app back to a real
    // operator directory. Recorded at spawn time, asserted after the run.
    const missingOwnedRoots = []
    const HOST_PID = 5100
    const NODE_PID = 5101
    const SHELL_PID = 5102
    const ptyState = { visible: false, tabIds: [] }
    const spawnImpl = async ({ exe, env }) => {
      envCaptures.push({ ...env })
      for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
        try { await access(env[name]) } catch { missingOwnedRoots.push(name) }
      }
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
        // The live default: the host resolves %ComSpec% -> cmd.exe, and the tab
        // chip title carries that same resolved name.
        rows.push({ pid: SHELL_PID, parentPid: HOST_PID, creationTicks: '133900000000005102', exe: 'C:\\Windows\\system32\\cmd.exe', name: 'cmd.exe' })
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
    // The recorded UI source is the EXE-SIBLING one, labelled as such, with no
    // exported override — the whole point of the packaged proof.
    assert.equal(record.runtime.shellDirSource, 'exe-relative')
    assert.equal(record.runtime.shellDir, join(candidateDir, 'ui'))
    assert.equal(record.runtime.shellAssets.source, 'exe-relative')
    assert.equal(record.runtime.shellAssets.envOverride, false)
    assert.equal(record.runtime.shellAssets.indexHtmlPresent, true, 'the fixture provisions the exe-sibling ui the run records')
    assert.equal(record.runtime.packagedCandidate.present, true)
    assert.equal(record.runtime.packagedCandidate.nodeSha256, createHash('sha256').update(nodeBytes).digest('hex'))
    assert.equal(record.runtime.defaultNodeProven.observed, true)
    assert.equal(record.runtime.defaultNodeProven.pid, NODE_PID)
    assert.equal(record.runtime.payloadNodePty.ok, true)
    assert.equal(record.scenarios.pty.child.pid, SHELL_PID)
    assert.equal(record.scenarios.pty.terminatedCleanly, true)
    // The lane PASSED on a POSITIVELY MOUNTED terminal surface (xterm screen and
    // input) that the guide entry opened, on a descendant attributed by the shell
    // name the tab itself reported, and on a positively clicked terminal-tab close
    // control while the shell was provably alive.
    assert.equal(record.scenarios.pty.openClicked, true)
    assert.equal(record.scenarios.pty.openVia, 'right-sidebar-entry')
    assert.equal(record.scenarios.pty.surfacePresent, true)
    assert.equal(record.scenarios.pty.inputPresent, true)
    assert.equal(record.scenarios.pty.terminalTabTitle, 'cmd.exe')
    assert.equal(record.scenarios.pty.expectedShellName, 'cmd')
    assert.equal(record.scenarios.pty.echoTyped, true)
    assert.equal(record.scenarios.pty.terminalInputFocused, true)
    assert.equal(record.scenarios.pty.echoRowsPresent, true)
    assert.equal(record.scenarios.pty.echoOutputRowObserved, true, 'the shell executed the echo nonce as its own output row')
    assert.ok(record.scenarios.pty.echoOutputRowIndex >= 0)
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
      assert.equal(env.DSH_DESKTOP_SHELL_DIR, undefined, 'the inherited stale UI override must be deleted, not exported')
      assert.equal(env.DEEPSEEK_BASE_URL, undefined, 'an ambient endpoint override must never reach the real child env')
      assert.equal(env.DEEPSEEK_SEARCH_BASE_URL, undefined, 'the search shipping endpoint must never reach the real child env')
      assert.equal(env.DSH_DESKTOP_DEV_CDP_PORT, '9333', 'the real child env carries the controlled CDP port')
      assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined, 'the real child env carries no browser-argument text')
    }
    // The four fixture-owned roots were PHYSICALLY created before the launch the
    // mock recorded, so the real app can never fall back to an operator directory.
    assert.deepEqual(missingOwnedRoots, [], 'every fixture-owned root must exist before the native window is created')
    const ptyCheck = check => record.checks.find(entry => entry.id === check)
    for (const id of ['payload.pty_terminate_fix_present', 'runtime.default_node_executed', 'pty.lane_executed', 'pty.terminated_cleanly', 'pty.app_healthy_after']) {
      assert.equal(ptyCheck(id).status, 'pass', `${id} must pass`)
      assert.equal(ptyCheck(id).required, true, `${id} must be required in this mode`)
    }
    assert.deepEqual(findSecretLikeLeaks(record, {
      allowedStrings: [...redactionAllowList(record), 'Fixture acceptance reply.', 'todo_write', 'fixture-model', 'fixture-acceptance'],
    }), [])
  } finally {
    if (inheritedShellDir === undefined) delete process.env.DSH_DESKTOP_SHELL_DIR
    else process.env.DSH_DESKTOP_SHELL_DIR = inheritedShellDir
    if (inheritedEndpoint === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = inheritedEndpoint
    await rm(repo, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// I6/I7. UI-source plan: the packaged default is exe-relative and NEVER exported
// ---------------------------------------------------------------------------

test('I6: the UI source plan records <exe_dir>/ui by default and labels explicit overrides', () => {
  const exe = 'C:\\qual\\candidate\\dsh-desktop.exe'
  const explicit = resolveShellDirPlan({ explicitShellDir: 'C:\\explicit\\ui', runtimeMode: 'exe-relative-default', repoRoot: 'C:\\repo', exe })
  assert.equal(explicit.source, 'explicit-arg')
  assert.equal(explicit.shellDir, 'C:\\explicit\\ui')
  assert.equal(explicit.envOverride, true)
  // The packaged default: THE RECORDED PATH IS BESIDE THE EXE and nothing is exported.
  const packaged = resolveShellDirPlan({ runtimeMode: 'exe-relative-default', repoRoot: 'C:\\repo', exe })
  assert.equal(packaged.source, 'exe-relative')
  assert.equal(packaged.shellDir, join('C:\\qual\\candidate', 'ui'))
  assert.equal(packaged.envOverride, false)
  // The explicit-payload lane keeps the repository source tree it always had.
  const repoDefault = resolveShellDirPlan({ runtimeMode: 'explicit-payload', repoRoot: 'C:\\repo', exe })
  assert.equal(repoDefault.source, 'repo-default')
  assert.equal(repoDefault.shellDir, join('C:\\repo', 'port', 'ui', 'dist'))
  assert.equal(repoDefault.envOverride, true)
  // An empty string is not an override; absent/null stays on the default lane.
  assert.equal(resolveShellDirPlan({ explicitShellDir: '', runtimeMode: 'exe-relative-default', repoRoot: 'C:\\repo', exe }).source, 'exe-relative')
  assert.equal(resolveShellDirPlan({ explicitShellDir: null, runtimeMode: 'explicit-payload', repoRoot: 'C:\\repo', exe }).source, 'repo-default')
})

test('I7: the packaged-default child env DELETES an inherited UI override; explicit lanes keep theirs', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: 'shellplan' })
  const args = parseArgs(['--exe', EXE, '--sha256', SHA, '--cdp-port', '9333'])
  const previous = process.env.DSH_DESKTOP_SHELL_DIR
  process.env.DSH_DESKTOP_SHELL_DIR = 'C:\\inherited-stale-ui'
  try {
    const packagedDefault = buildChildEnvironment({
      args, paths, nodePath: null, adapterPath: null, runtimeDir: null, shellDir: 'C:\\candidate\\ui',
      runtimeMode: 'exe-relative-default', shellDirSource: 'exe-relative', handoffIndex: 1,
    })
    assert.equal(packagedDefault.DSH_DESKTOP_SHELL_DIR, undefined, 'an inherited UI override must be deleted, never exported, in the packaged-default lane')

    const explicit = buildChildEnvironment({
      args, paths, nodePath: null, adapterPath: null, runtimeDir: null, shellDir: 'C:\\explicit\\ui',
      runtimeMode: 'exe-relative-default', shellDirSource: 'explicit-arg', handoffIndex: 1,
    })
    assert.equal(explicit.DSH_DESKTOP_SHELL_DIR, 'C:\\explicit\\ui', 'an explicit --shell-dir must win over an inherited value')

    const repoDefault = buildChildEnvironment({
      args, paths, nodePath: 'C:\\payload\\node\\node.exe', adapterPath: 'C:\\payload\\adapter.mjs',
      runtimeDir: 'C:\\payload', shellDir: 'C:\\repo\\port\\ui\\dist', runtimeMode: 'explicit-payload', handoffIndex: 1,
    })
    assert.equal(repoDefault.DSH_DESKTOP_SHELL_DIR, 'C:\\repo\\port\\ui\\dist', 'the explicit-payload lane keeps the repo source UI exported')

    // With no source supplied, the legacy default follows the runtime mode.
    const legacyDefault = buildChildEnvironment({
      args, paths, nodePath: null, adapterPath: null, runtimeDir: null, shellDir: 'C:\\candidate\\ui',
      runtimeMode: 'exe-relative-default', handoffIndex: 1,
    })
    assert.equal(legacyDefault.DSH_DESKTOP_SHELL_DIR, undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_DESKTOP_SHELL_DIR
    else process.env.DSH_DESKTOP_SHELL_DIR = previous
  }
})

// ---------------------------------------------------------------------------
// I8. The packaged default REFUSES when the assembled UI is missing
// ---------------------------------------------------------------------------

test('I8: a packaged default with no <exe_dir>/ui refuses preflight — even with a repo UI present — and can never dry-run green', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-acc-repo-'))
  try {
    const exeDir = join(repo, 'candidate')
    await mkdir(exeDir, { recursive: true })
    const exePath = join(exeDir, 'dsh-desktop.exe')
    const bytes = Buffer.from('MZ mocked debug candidate (packaged UI deliberately absent)')
    await writeFile(exePath, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    // The runtime payload IS beside the exe, so the ONLY missing packaged resource
    // is the UI: the refusal must name the UI, never mask it behind another fact.
    await mkdir(join(exeDir, 'dsh', 'node'), { recursive: true })
    await writeFile(join(exeDir, 'dsh', 'adapter.mjs'), 'export default 1\n')
    await writeFile(join(exeDir, 'dsh', 'node', 'node.exe'), 'mock node')
    await writeFile(join(exeDir, 'dsh', 'desktop-runtime.json'), JSON.stringify({ node: { version: '22.20.0', target: 'x86_64-pc-windows-msvc' } }))
    // A tempting, PRESENT repo-source UI must never become a silent fallback: the
    // packaged default is a claim about the ASSEMBLED product, so the run has to
    // refuse rather than borrow <repo>/port/ui/dist.
    await mkdir(join(repo, 'port', 'ui', 'dist'), { recursive: true })
    await writeFile(join(repo, 'port', 'ui', 'dist', 'index.html'), '<html><body>repo-source-ui</body></html>')

    let spawnCalls = 0
    const inject = {
      spawnImpl: async () => { spawnCalls += 1; throw new Error('must never spawn') },
      sleepImpl: async () => {},
    }
    const base = ['--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'noui']
    const record = await runAcceptance(parseArgs(base), inject)
    assert.equal(record.verdict, 'refused')
    assert.equal(record.exitCode, 2, 'a preflight refusal uses the existing refused exit')
    assert.equal(record.refusalCode, 'packaged-ui-missing', 'the refusal must carry its specific machine code')
    assert.ok(/packaged default UI is missing/u.test(record.refusalReason))
    assert.ok(record.refusalReason.includes(join(exeDir, 'ui', 'index.html')), 'the refusal names the exact missing UI path')
    assert.ok(!record.refusalReason.includes(join(repo, 'port', 'ui', 'dist')), 'a present repo-source UI is never offered as the missing packaged UI')
    assert.equal(record.nativeAcceptance, false)

    // The dry run is a PREFLIGHT report: it must refuse identically rather than
    // return dry-run-ok while the shell assets it would need do not exist.
    const dry = await runAcceptance(parseArgs([...base, '--dry-run']), inject)
    assert.equal(dry.verdict, 'refused')
    assert.equal(dry.exitCode, 2)
    assert.equal(dry.refusalCode, 'packaged-ui-missing')
    assert.equal(dry.dryRun, undefined)
    assert.equal(dry.dryRunChecks, undefined)

    // Nothing was created and nothing was launched in either preflight.
    assert.equal(spawnCalls, 0)
    const { access } = await import('node:fs/promises')
    const { constants } = await import('node:fs')
    await assert.rejects(() => access(record.isolation.ownedRoot, constants.F_OK), 'the owned root must not exist after a refused preflight')
    await assert.rejects(() => access(record.isolation.runRoot, constants.F_OK), 'the run root must not exist after a refused preflight')

    // The SAME candidate with its packaged UI present proceeds past preflight and
    // reports the exe-relative source truthfully: the refusal was about the UI.
    await mkdir(join(exeDir, 'ui'), { recursive: true })
    await writeFile(join(exeDir, 'ui', 'index.html'), '<html><body>packaged-ui</body></html>')
    const dryOk = await runAcceptance(parseArgs([...base, '--dry-run']), inject)
    assert.equal(dryOk.verdict, 'dry-run-ok')
    assert.equal(dryOk.dryRunChecks.shellAssetsPresent, true)
    assert.equal(dryOk.runtime.shellDirSource, 'exe-relative')
    assert.equal(dryOk.runtime.shellDir, join(exeDir, 'ui'))
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
// O. Known-safe isolation allowlist — the EXACT generated report path only
// ---------------------------------------------------------------------------

/** A stamp long enough to push the generated run root past the long-run rule. */
const LONG_STAMP = 'short021-native-b-1818'

test('O1: the generated isolation report path is known-safe; launch and API tokens are still refused', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: LONG_STAMP })
  const isolation = { ...paths, repoRoot: 'C:\\repo' }
  // The real-run shape: `native-acceptance-<stamp>` is 40 [A-Za-z0-9_-] characters
  // with digits, so every generated path carries a high-entropy-looking run.
  assert.ok(isolation.reportPath.endsWith('acceptance-record.json'))
  assert.ok(isolation.reportPath.includes(LONG_STAMP))
  assert.deepEqual(findSecretLikeLeaks({ isolation: { reportPath: isolation.reportPath } }), ['$.isolation.reportPath'],
    'the generated report path IS secret-shaped to the heuristic; that is why it must be allow-listed')

  const record = { isolation, candidate: { sha256: SHA } }
  // Reproduce the real refusal exactly: with the other generated paths allow-listed
  // but the report path NOT, the report path is the only offender.
  const withoutReportPath = redactionAllowList(record).filter(value => value !== isolation.reportPath)
  assert.deepEqual(findSecretLikeLeaks(record, { allowedStrings: withoutReportPath }), ['$.isolation.reportPath'])

  // With the record's own allowlist the published paths are known safe.
  assert.deepEqual(findSecretLikeLeaks(record, { allowedStrings: redactionAllowList(record) }), [])

  // Nothing else became acceptable: an unrelated launch token and an API-key-shaped
  // value are still refused, wherever they sit.
  const contaminated = structuredClone(record)
  contaminated.gateway = { authenticatedUrlSeen: `http://127.0.0.1:3099/?token=${FAKE_TOKEN}` }
  assert.deepEqual(
    findSecretLikeLeaks(contaminated, { allowedStrings: redactionAllowList(contaminated) }),
    ['$.gateway.authenticatedUrlSeen'],
  )
  const keyShaped = structuredClone(record)
  keyShaped.fixture = { stagedHeader: `Bearer ${FIXTURE_API_KEY}` }
  assert.deepEqual(
    findSecretLikeLeaks(keyShaped, { allowedStrings: redactionAllowList(keyShaped) }),
    ['$.fixture.stagedHeader'],
  )

  // The allowlist is an EXACT whole-string match: a report path that merely looks
  // like the generated one is refused, so no substring/regex policy was widened.
  const lookalike = { isolation: { reportPath: `${isolation.reportPath}.bak` } }
  assert.deepEqual(
    findSecretLikeLeaks(lookalike, { allowedStrings: redactionAllowList(record) }),
    ['$.isolation.reportPath'],
  )
})

test('O2: the allowed report path is the one the record actually carries, not a caller-supplied overflow', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: LONG_STAMP })
  // `--report` changes the WRITE destination only; the record keeps the generated
  // path under the run root, so an arbitrary external path never enters the
  // allowlist (it is not part of the record) and stays gate-worthy if it appears.
  const args = parseArgs(['--exe', EXE, '--sha256', SHA, '--repo', 'C:\\repo', '--stamp', LONG_STAMP,
    '--report', 'C:\\elsewhere\\custom-report.json'])
  assert.equal(args.reportPath, 'C:\\elsewhere\\custom-report.json')
  const record = { isolation: { ...paths, repoRoot: 'C:\\repo' } }
  const allowed = redactionAllowList(record)
  assert.ok(allowed.includes(record.isolation.reportPath))
  assert.equal(allowed.includes(args.reportPath), false, 'a caller-supplied report path is never allow-listed')
  const tokenShapedExternal = { isolation: { reportPath: `C:\\elsewhere\\${FAKE_TOKEN}.json` } }
  assert.deepEqual(
    findSecretLikeLeaks(tokenShapedExternal, { allowedStrings: allowed }),
    ['$.isolation.reportPath'],
  )
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
    assert.equal(env.DSH_DESKTOP_SHELL_DIR, undefined, 'the packaged default exports no UI override at all')
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

test('N2b: the child env is sanitized from a fake parent envelope, never inherited verbatim', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: 'env3' })
  const args = parseArgs(['--exe', EXE, '--sha256', SHA, '--cdp-port', '9333'])
  const inherited = {
    // Windows environment NAMES are case-insensitive: every spelling is denied.
    Dsh_Desktop_Shell_Dir: 'C:\\operator\\ui',
    dsh_home: 'C:\\Users\\operator\\.dsh',
    DsH_Desktop_Runtime_Dir: 'C:\\operator\\runtime',
    npM_config_prefix: 'C:\\operator\\npm',
    // Secrets, endpoints and proxies an ambient shell must never hand over.
    // The shipping endpoint overrides are DEEPSEEK_BASE_URL, its search sibling
    // DEEPSEEK_SEARCH_BASE_URL, and SEARCH_BASE_URL — all three, in mixed case.
    DEEPSEEK_API_KEY: 'operator-secret-value-0001',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.example.invalid',
    DEEPSEEK_SEARCH_BASE_URL: 'https://search.deepseek.example.invalid',
    deepseek_search_base_url: 'https://search.other.example.invalid',
    SEARCH_BASE_URL: 'https://search.example.invalid',
    HTTPS_PROXY: 'http://operator-proxy.invalid:8080',
    GITHUB_TOKEN: 'operator-token-value-0001',
    NODE_OPTIONS: '--require C:\\operator\\hook.js',
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=61234',
    dsh_desktop_dev_cdp_port: '9123',
    // Ordinary platform variables are still passed through: the candidate is a
    // real product process and must keep the platform itself working.
    SystemRoot: 'C:\\Windows',
    PATH: 'C:\\Windows\\system32',
  }
  const env = buildChildEnvironment({
    args, paths, inherited,
    nodePath: 'C:\\payload\\node\\node.exe', adapterPath: 'C:\\payload\\adapter.mjs',
    runtimeDir: 'C:\\payload', shellDir: 'C:\\candidate\\ui', runtimeMode: 'explicit-payload', handoffIndex: 1,
  })
  for (const name of ['Dsh_Desktop_Shell_Dir', 'dsh_home', 'DsH_Desktop_Runtime_Dir', 'npM_config_prefix']) {
    assert.equal(env[name], undefined, `${name} must be denied by NAME regardless of case`)
  }
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL', 'deepseek_search_base_url', 'SEARCH_BASE_URL', 'HTTPS_PROXY', 'GITHUB_TOKEN', 'NODE_OPTIONS']) {
    assert.equal(env[name], undefined, `${name} must never be inherited`)
  }
  // No ambient browser-argument channel survives, and the ONLY CDP input is the
  // runner-owned port variable carrying the validated CLI value.
  assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined, 'an ambient WebView2 argument string must never be exported')
  assert.equal(env.DSH_DESKTOP_DEV_CDP_PORT, '9333', 'the runner-owned CDP port is the CLI value')
  assert.equal(env.dsh_desktop_dev_cdp_port, undefined, 'the ambient mixed-case CDP port must be denied, not merged')
  assert.equal(env.SystemRoot, 'C:\\Windows', 'the platform environment still passes through')
  assert.equal(env.PATH, 'C:\\Windows\\system32')
  // Every path the child can see is fixture-owned, absolute and inside the fence.
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) {
    const value = env[name]
    assert.equal(typeof value, 'string', `${name} must be owned by the fixture`)
    assert.ok(isAbsolute(value), `${name} must be absolute: ${value}`)
    assert.ok(value.toLowerCase().startsWith(paths.ownedRoot.toLowerCase()), `${name} must stay inside the owned root: ${value}`)
  }
  assert.equal(env.DSH_HOME, paths.home)
  // The intentional fixture values are exactly the controlled set.
  assert.equal(env.DSH_DESKTOP_SHELL_DIR, 'C:\\candidate\\ui')
  assert.equal(env.DSH_DESKTOP_RUNTIME_DIR, 'C:\\payload')
  assert.equal(env.DSH_DESKTOP_DEV_URL_FILE, join(paths.ownedRoot, 'handoff-1', 'gateway-url.txt'))
  assert.equal(env.DSH_DESKTOP_DEV_BOOT_FILE, join(paths.ownedRoot, 'handoff-1', 'boot.json'))
  assert.equal(env.DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE, UUID)
  assert.equal(env.DSH_ACCEPTANCE_FIXTURE_KEY, FIXTURE_API_KEY)
  assert.ok(Number.isInteger(Number(env.DSH_DESKTOP_DEV_CDP_PORT)), 'the app receives an integer CDP port, not argument text')
  assert.ok(Number(env.DSH_DESKTOP_DEV_CDP_PORT) >= 1024 && Number(env.DSH_DESKTOP_DEV_CDP_PORT) <= 65535, 'the port is inside the unprivileged range the app accepts')
  assert.equal(env.DSH_DESKTOP_CONTROL_SOCKET, undefined)
  assert.equal(env.DSH_DESKTOP_CONTROL_TOKEN, undefined)
})

test('N2c: both ambient endpoint overrides are suppressed, and the packaged default exports no override', () => {
  const paths = deriveIsolationPaths({ repoRoot: 'C:\\repo', namespace: UUID, stamp: 'env4' })
  const args = parseArgs(['--exe', EXE, '--sha256', SHA, '--cdp-port', '9333'])
  // The shared rules alone would let an endpoint override through; the runner
  // closes exactly that gap for BOTH fixed shipping names (and their search
  // sibling), case-insensitively.
  assert.equal(classifyFixtureEnvName('DEEPSEEK_BASE_URL'), null, 'the shared policy does not name endpoint overrides')
  assert.equal(classifyFixtureEnvName('DEEPSEEK_SEARCH_BASE_URL'), null)
  assert.equal(classifyFixtureEnvName('SEARCH_BASE_URL'), null)
  assert.equal(classifyRunnerOnlyEnvName('DEEPSEEK_BASE_URL'), 'endpoint-override')
  assert.equal(classifyRunnerOnlyEnvName('DEEPSEEK_SEARCH_BASE_URL'), 'endpoint-override', 'the search shipping name is covered, not just DEEPSEEK_BASE_URL')
  assert.equal(classifyRunnerOnlyEnvName('deepseek_search_base_url'), 'endpoint-override', 'names are case-insensitive')
  assert.equal(classifyRunnerOnlyEnvName('deepseek_base_url'), 'endpoint-override')
  assert.equal(classifyRunnerOnlyEnvName('SEARCH_BASE_URL'), 'endpoint-override')
  assert.equal(classifyRunnerOnlyEnvName('DEEPSEEK_SEARCH_API_URL'), 'endpoint-override')
  assert.equal(classifyRunnerOnlyEnvName('DEEPSEEK_SEARCH_ENDPOINT'), 'endpoint-override')
  assert.equal(classifyRunnerOnlyEnvName('PATH'), null)
  assert.equal(classifyRunnerOnlyEnvName('DEEPSEEK_SEARCH_MODEL'), null, 'a non-endpoint search variable is not denied')
  const env = buildChildEnvironment({
    args, paths, handoffIndex: 1,
    inherited: {
      DSH_DESKTOP_RUNTIME_DIR: 'C:\\operator\\runtime',
      DSH_DESKTOP_NODE: 'C:\\operator\\node.exe',
      DSH_DESKTOP_RUNTIME_ADAPTER: 'C:\\operator\\adapter.mjs',
      DSH_DESKTOP_PRIMARY_RUNTIME_DIR: 'C:\\operator\\primary',
      DSH_DESKTOP_SHELL_DIR: 'C:\\operator\\ui',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.example.invalid',
      DEEPSEEK_SEARCH_BASE_URL: 'https://search.deepseek.example.invalid',
      SEARCH_BASE_URL: 'https://search.example.invalid',
    },
    nodePath: null, adapterPath: null, runtimeDir: null, shellDir: 'C:\\candidate\\ui',
    runtimeMode: 'exe-relative-default', shellDirSource: 'exe-relative',
  })
  for (const name of ['DSH_DESKTOP_RUNTIME_DIR', 'DSH_DESKTOP_NODE', 'DSH_DESKTOP_RUNTIME_ADAPTER', 'DSH_DESKTOP_PRIMARY_RUNTIME_DIR', 'DSH_DESKTOP_SHELL_DIR', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL', 'SEARCH_BASE_URL']) {
    assert.equal(env[name], undefined, `${name} must not reach the packaged-default child`)
  }
  assert.equal(env.DSH_DESKTOP_DEV_URL_FILE, join(paths.ownedRoot, 'handoff-1', 'gateway-url.txt'))
  assert.equal(env.DSH_DESKTOP_DEV_CDP_PORT, '9333', 'the CDP port is exported in packaged-default mode too (the app gates it)')
  assert.equal(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, undefined, 'no browser-argument string is exported in any mode')
})

test('R1: the debug CDP port is consumed only through the owned-debug builder lane', async () => {
  const source = await readFile(new URL('../../src-tauri/app/src/lib.rs', import.meta.url), 'utf8')
  // The dedicated variable is the only CDP input, and ambient browser-argument
  // TEXT is never read by the app.
  assert.ok(source.includes('DSH_DESKTOP_DEV_CDP_PORT'), 'the dedicated owned-debug variable must exist')
  assert.ok(source.includes('const DEV_CDP_PORT_ENV'), 'the variable name must be a single declared constant')
  assert.ok(!source.includes('WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS'), 'the app must never read ambient WebView2 argument text')
  // The gates: debug build, the validated namespace fence, plain digits, u16 range.
  assert.ok(source.includes('fn dev_cdp_browser_args('), 'the decision must live in one pure helper')
  assert.ok(source.includes('cfg!(debug_assertions)'), 'the port is gated on a debug build')
  assert.ok(source.includes('owned_namespace.as_deref()'), 'the port is gated on the validated owned-credential fence')
  assert.ok(source.includes('is_ascii_digit()'), 'the port must be plain decimal digits')
  assert.ok(source.includes('(1024..=65535).contains(&port)'), 'the port bounds must be enforced')
  // The builder keeps wry's defaults and adds only loopback debugging.
  assert.ok(source.includes('const WRY_DEFAULT_BROWSER_ARGS'), 'wry`s default arguments must be preserved verbatim')
  assert.ok(source.includes('--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection'))
  assert.ok(source.includes('--remote-debugging-address=127.0.0.1'), 'the port must stay loopback-only')
  assert.ok(source.includes('--remote-debugging-port={port}'), 'only the validated port is interpolated')
  assert.ok(source.includes('.additional_browser_args(additional_args)'), 'the arguments must be applied to the window builder')
})

test('N3: shell attribution matches the tab-reported name exactly, never a candidate list', () => {
  const rows = [
    { pid: 10, parentPid: 0, creationTicks: '1', exe: 'C:\\app\\dsh-desktop.exe', name: 'dsh-desktop.exe' },
    { pid: 11, parentPid: 10, creationTicks: '2', exe: 'C:\\app\\dsh\\node\\node.exe', name: 'node.exe' },
    { pid: 12, parentPid: 10, creationTicks: '3', exe: 'C:\\Windows\\system32\\cmd.exe', name: 'cmd.exe' },
    { pid: 13, parentPid: 10, creationTicks: '4', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', name: 'pwsh.exe' },
  ]
  assert.equal(findNodeDescendant(rows, 'C:/app/dsh/node/node.exe')?.pid, 11, 'path comparison normalizes separators and case')
  assert.equal(findNodeDescendant(rows, 'C:\\other\\node.exe'), null)
  // The tab reported `cmd.exe`: only that descendant is adopted.
  assert.equal(findShellChild(rows, [], 'cmd')?.pid, 12)
  // A pwsh descendant is NOT adopted when the terminal reported cmd: no guess-list.
  assert.equal(findShellChild(rows, [], 'pwsh')?.pid, 13)
  assert.equal(findShellChild(rows, [{ pid: 12, creationTicks: '3' }], 'cmd'), null, 'a baseline child is never the terminal shell')
  // An unusable expected name attributes nothing, even when a plausible shell exists.
  assert.equal(findShellChild(rows, [], null), null)
  assert.equal(findShellChild(rows, [], ''), null)
  assert.equal(findShellChild(rows, [], 'my shell'), null)
  // A one-shot `powershell.exe` probe can never be adopted as a cmd terminal.
  assert.equal(
    findShellChild([{ pid: 14, parentPid: 10, creationTicks: '5', exe: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', name: 'powershell.exe' }], [], 'cmd'),
    null,
    'an unrelated powershell probe is never the cmd terminal shell',
  )
})

test('N3b: every PTY DOM expression returns an OBJECT, never a primitive', () => {
  // The CDP evaluate seam is by-value-object only: a primitive (or null) return
  // fails the evaluate with a shape error, so each expression must answer an object
  // in EVERY branch, including the empty-document branch.
  const emptyDocument = {
    querySelector: () => null,
    querySelectorAll: () => [],
    activeElement: null,
  }
  const expressions = [
    TERMINAL_OPEN_EXPRESSION, TERMINAL_STATE_EXPRESSION, TERMINAL_TAB_IDS_EXPRESSION, TERMINAL_CLOSE_EXPRESSION,
    TERMINAL_FOCUS_EXPRESSION, TERMINAL_ROWS_EXPRESSION, SIDEBAR_RIGHT_OPEN_EXPRESSION, SIDEBAR_RIGHT_STATE_EXPRESSION,
    TERMINAL_ENTRY_EXPRESSION, ACCOUNT_MENU_OPEN_EXPRESSION, ACCOUNT_MENU_EXPRESSION, ACCOUNT_MENU_CLOSE_EXPRESSION,
  ]
  for (const expression of expressions) {
    const result = new Function('document', 'getComputedStyle', `return ${expression}`)(emptyDocument, () => ({ display: 'block', visibility: 'visible' }))
    assert.equal(typeof result, 'object', `${expression.slice(0, 40)}… must return an object`)
    assert.notEqual(result, null)
  }
  assert.equal(typeof terminalCloseExpressionForTab('tab3'), 'string')
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
  sessionAppearsWithoutOpen = false,
  shellTitle = 'cmd.exe', shellProcessName = null, echoWorks = true, focusInput = true,
  tabIdsBefore = ['guide-tab'], newTabIds = ['terminal-tab'],
} = {}) {
  const HOST_PID = 9000
  const SHELL_PID = 9001
  // The terminal tab chip and the process row share the shell name the host
  // resolved (`info.title = shell.name`), exactly like the live capture.
  const shellName = shellProcessName ?? shellTitle
  const state = {
    terminalOpen: preexistingSession,
    shellAlive: false,
    tabIds: preexistingSession ? [...tabIdsBefore, ...newTabIds] : [...tabIdsBefore],
    shortcutDispatches: 0,
    closeRequested: false,
    typed: null,
    entered: false,
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
      if (expression.includes('terminal-tab-title')) {
        const target = /const target = (.+);/u.exec(expression)?.[1] ?? null
        let tabId = null
        if (target !== null) { try { tabId = JSON.parse(target) } catch { tabId = null } }
        const present = state.terminalOpen && tabId !== null && state.tabIds.includes(tabId)
        return { record: 'terminal-tab-title', tabId, chipPresent: present, title: present ? shellTitle : null, closeHookId: present ? tabId : null }
      }
      if (expression.includes('terminal-open')) {
        if (shortcutOnly || !entryOpens) {
          // A terminal can appear without this lane's own click succeeding (another
          // actor opened one). That is exactly the false-qualification the open gate
          // exists for: the tab, the shell and the echo all become positive while
          // `openClicked` stays false.
          if (sessionAppearsWithoutOpen) openSession()
          return { record: 'terminal-open', clicked: false, via: 'right-sidebar-entry' }
        }
        openSession()
        return { record: 'terminal-open', clicked: true, via: 'right-sidebar-entry' }
      }
      if (expression.includes('terminal-state')) {
        return { record: 'terminal-state', panelPresent: true, surfacePresent: state.terminalOpen && surface, inputPresent: state.terminalOpen && input }
      }
      if (expression.includes('terminal-focus')) {
        const focused = state.terminalOpen && input && focusInput
        return { record: 'terminal-focus', focused, ...(focused ? {} : { reason: 'no-terminal-input' }) }
      }
      if (expression.includes('terminal-rows')) {
        // A real shell echoes the typed command and then prints its output as its
        // own row. The buffer keeps blank spacer rows after it, so this answers
        // EVERY row (never a tail slice).
        const echoed = state.typed === null ? [] : [`C:\\app>${state.typed}`]
        const output = state.typed !== null && state.entered && echoWorks ? [state.typed.replace(/^echo /u, '')] : []
        const rows = ['', 'Microsoft Windows [Version 10.0]', ...echoed, ...output, '', '', '']
        return { record: 'terminal-rows', rowsPresent: true, rowCount: rows.length, texts: rows }
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
      if (method === 'Input.insertText' && typeof params?.text === 'string') state.typed = params.text
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Enter') state.entered = true
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
      rows.push({ pid: SHELL_PID, parentPid: HOST_PID, creationTicks: '101', exe: `C:\\Windows\\system32\\${shellName}`, name: shellName })
    }
    return { available: true, rows, rejected: 0, truncated: false, observedAtTicks: 500n }
  }
  const identityAtSpawn = { available: true, status: 'present', pid: HOST_PID, exe: 'C:\\app\\dsh-desktop.exe', creationTicks: '100' }
  return { connection, tableImpl, identityAtSpawn, state, HOST_PID, SHELL_PID, shellTitle, shellName }
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
  // dispatched; a terminal tab, its matching shell descendant, the mounted surface
  // and the echo all became positive anyway. Attribution plus UI plus execution
  // must still not qualify the lane when the lane itself never opened the terminal.
  const harness = ptyLaneHarness({
    sidebarOpen: false,
    entryOpens: false,
    sessionAppearsWithoutOpen: true,
  })
  const lane = await runLane(harness)
  assert.equal(lane.facts.openClicked, false)
  assert.equal(lane.facts.openVia, null)
  assert.equal(harness.state.shortcutDispatches, 0, 'no terminal.new shortcut may be sent when the sidebar is not open')
  assert.equal(lane.facts.tableAvailable, true)
  assert.equal(lane.facts.terminalTabTitle, 'cmd.exe')
  assert.equal(lane.facts.child.pid, 9001, 'the new shell was attributed')
  assert.equal(lane.facts.surfacePresent, true)
  assert.equal(lane.facts.inputPresent, true)
  assert.equal(lane.facts.echoOutputRowObserved, true)
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

test('N14: the expected shell name is derived from the tab title, and implausible titles are refused', () => {
  // The live 0.2.1-alpha.2 shape: the chip reads `cmd.exe`.
  assert.equal(derivePlainShellName('cmd.exe'), 'cmd')
  assert.equal(derivePlainShellName('CMD.EXE'), 'cmd')
  assert.equal(derivePlainShellName(' cmd '), 'cmd')
  assert.equal(derivePlainShellName('pwsh.exe'), 'pwsh')
  assert.equal(derivePlainShellName('powershell'), 'powershell')
  assert.equal(derivePlainShellName('bash'), 'bash')
  // Titles that are not one executable-shaped token are refused rather than guessed.
  assert.equal(derivePlainShellName(''), null)
  assert.equal(derivePlainShellName('   '), null)
  assert.equal(derivePlainShellName('my shell'), null)
  assert.equal(derivePlainShellName('Terminal (cmd.exe)'), null)
  assert.equal(derivePlainShellName('C:\\Windows\\system32\\cmd.exe'), null)
  assert.equal(derivePlainShellName(null), null)
  assert.equal(derivePlainShellName(undefined), null)
  assert.equal(derivePlainShellName('a'.repeat(65)), null)
})

test('N15: a cmd terminal qualifies the lane through the tab-reported shell name and a real echo', async () => {
  const harness = ptyLaneHarness({ shellTitle: 'cmd.exe' })
  const lane = await runLane(harness)
  assert.equal(lane.laneStatus, 'pass')
  assert.equal(lane.facts.terminalTabTitle, 'cmd.exe')
  assert.equal(lane.facts.expectedShellName, 'cmd')
  assert.equal(lane.facts.child.pid, harness.SHELL_PID)
  assert.equal(lane.facts.child.exe.toLowerCase().endsWith('cmd.exe'), true)
  assert.equal(lane.facts.terminalInputFocused, true)
  assert.equal(lane.facts.echoTyped, true)
  assert.equal(lane.facts.echoOutputRowObserved, true)
  // The exact-row reader saw the whole buffer (the live viewport keeps blank
  // spacer rows below the banner), not a fixed tail slice.
  assert.equal(lane.facts.echoRowCount > 4, true)
  assert.equal(lane.facts.echoOutputRowIndex >= 0, true)
  assert.equal(lane.facts.closeClicked, true)
  assert.equal(lane.terminateStatus, 'pass')
})

test('N16: the lane never adopts a descendant whose name differs from the tab-reported shell', async () => {
  // The tab says cmd.exe while the only new descendant is a one-shot
  // powershell.exe probe (the documents-directory resolution spawns exactly that):
  // nothing may be attributed — no candidate list and no guessing.
  const harness = ptyLaneHarness({ shellTitle: 'cmd.exe', shellProcessName: 'powershell.exe' })
  const lane = await runLane(harness)
  assert.equal(lane.facts.expectedShellName, 'cmd')
  assert.equal(lane.facts.child, null)
  assert.equal(lane.laneStatus, 'fail')
  assert.match(lane.laneDetail, /no new descendant matching the terminal's own shell name "cmd"/u)
  assert.equal(lane.terminateStatus, 'unqualified')
})

test('N17: a custom or implausible tab title attributes nothing and never passes', async () => {
  const harness = ptyLaneHarness({ shellTitle: 'my build shell' })
  const lane = await runLane(harness)
  assert.equal(lane.facts.terminalTabTitle, 'my build shell')
  assert.equal(lane.facts.expectedShellName, null)
  assert.equal(lane.facts.child, null)
  assert.equal(lane.laneStatus, 'fail')
  assert.match(lane.laneDetail, /not a single executable shell name/u)
  assert.equal(lane.terminateStatus, 'unqualified')
})

test('N18: a shell that does not execute the echo nonce cannot pass the lane, and is still cleaned up', async () => {
  const harness = ptyLaneHarness({ echoWorks: false })
  const lane = await runLane(harness)
  assert.equal(lane.facts.echoTyped, true)
  assert.equal(lane.facts.echoOutputRowObserved, false, 'the echoed command row is NOT execution evidence')
  assert.equal(lane.facts.echoCommandRowIndex >= 0, true, 'the command WAS echoed, so the input reached the surface')
  assert.equal(lane.laneStatus, 'fail')
  assert.match(lane.laneDetail, /echoOutputRow=false/u)
  // Cleanup, termination and health are unaffected by the failed qualification.
  assert.equal(lane.facts.closeClicked, true)
  assert.equal(lane.terminateStatus, 'pass')
  assert.equal(lane.healthStatus, 'pass')
})

test('N19: the terminal DOM readers are object-shaped and read EVERY row, banner and spacers', () => {
  // A mounted terminal: the section holds the xterm screen, its helper textarea
  // and the row container, exactly as the real DOM does.
  const rows = ['cmd.exe', 'C:\\app>echo DSHACC1234abcd', 'DSHACC1234abcd', '', '', '']
  const active = { current: null }
  const input = { focus() { active.current = input } }
  const rowNodes = rows.map(text => ({ textContent: text }))
  const rowsContainer = { children: rowNodes }
  const screen = {
    querySelector: selector => (selector.includes('textarea') || selector === 'textarea' ? input : null),
  }
  const section = {
    querySelector: selector => (selector === '.xterm'
      ? screen
      : selector === '.xterm-rows'
        ? rowsContainer
        : (selector.includes('textarea') ? input : null)),
  }
  const panel = { querySelector: selector => (selector === '[data-sidebar-terminal]' ? section : null) }
  const document = { querySelector: () => panel, get activeElement() { return active.current } }
  const evaluate = expression => new Function('document', `return ${expression}`)(document)

  const state = evaluate(TERMINAL_STATE_EXPRESSION)
  assert.equal(state.panelPresent, true)
  assert.equal(state.surfacePresent, true)
  assert.equal(state.inputPresent, true)

  const focus = evaluate(TERMINAL_FOCUS_EXPRESSION)
  assert.equal(typeof focus, 'object')
  assert.equal(focus.focused, true, 'focus is reported as {focused:boolean}, never a bare primitive')

  const read = evaluate(TERMINAL_ROWS_EXPRESSION)
  assert.equal(read.rowsPresent, true)
  assert.equal(read.rowCount, rows.length, 'every row is read, including the blank spacers')
  assert.deepEqual(read.texts, rows)
  assert.equal(read.texts.findIndex(text => text === 'DSHACC1234abcd') >= 0, true)

  // A title reader is only built for a usable captured id, and answers an object.
  const chip = { textContent: 'cmd.exe', querySelector: () => ({ getAttribute: () => 'tab3' }) }
  const titleDocument = {
    querySelector: () => ({ querySelectorAll: () => [{ getAttribute: name => (name === 'data-dockkit-tab' ? 'tab3' : null), ...chip }] }),
  }
  const title = new Function('document', `return ${terminalTabTitleExpressionForTab('tab3')}`)(titleDocument)
  assert.equal(typeof title, 'object')
  assert.equal(title.chipPresent, true)
  assert.equal(title.title, 'cmd.exe')
  assert.equal(terminalTabTitleExpressionForTab(''), null)
})

// ---------------------------------------------------------------------------
// P. Forced teardown uses the identity source with the REAL helper semantics
// ---------------------------------------------------------------------------

/** A child whose kill() settles the exit event on a microtask, as an OS kill does. */
function makeKillableFakeChild(pid) {
  const child = makeFakeChild(pid)
  const kills = { count: 0 }
  child.kill = () => {
    kills.count += 1
    queueMicrotask(() => child.simulateExit(0))
  }
  return { child, kills }
}

/**
 * A PID-keyed identity source shaped like the runner's real one. The shared
 * helper injects its `capture` as the RAW identity QUERY runner, which hands it a
 * PowerShell script string; this source refuses anything that is not a process
 * identifier, so the pre-fix call site (`capture: identityImpl`) surfaces as a
 * refusal instead of a silent termination.
 */
function pidIdentitySource(registry, calls) {
  return async pid => {
    calls.push(pid)
    if (!Number.isInteger(pid) || pid <= 0) {
      return { available: false, status: 'unknown', pid: null, exe: null, creationTicks: null, reason: `pid ${String(pid)} is not a process identifier` }
    }
    const entry = registry.get(pid)
    if (entry === undefined) {
      return { available: false, status: 'absent', pid: null, exe: null, creationTicks: null, reason: 'no process with that pid exists' }
    }
    return { available: true, status: 'present', pid, exe: entry.exe, creationTicks: entry.creationTicks, reason: '' }
  }
}

const ATTACH_FAIL_TICKS = '133900000000006100'

/**
 * Drive the runner into an early CDP-attach failure, which forces owned cleanup.
 * The spawn-time identity always carries the candidate's REAL path; `registry`
 * (when given) is populated with the same path so a PID-keyed identity source
 * answers with the exe the fixture actually launched.
 */
async function runAttachFailure({ identityImpl, child, pid, registry = null, registryTicks = ATTACH_FAIL_TICKS }) {
  const { repo, exePath, sha256 } = await buildMockRepo()
  try {
    const spawnImpl = async ({ exe, env }) => {
      await writeFile(env.DSH_DESKTOP_DEV_URL_FILE, `http://127.0.0.1:3099/?token=${FAKE_TOKEN}\n`, 'utf8')
      await writeFile(env.DSH_DESKTOP_DEV_BOOT_FILE, JSON.stringify({
        streamBaseUrl: 'http://127.0.0.1:3099', bootstrapBatchUrl: 'http://127.0.0.1:3099/x.js?rev=abc', graphRevision: 'abc',
      }), 'utf8')
      if (registry !== null) registry.set(pid, { exe, creationTicks: registryTicks })
      return { child, identityAtSpawn: { available: true, status: 'present', pid, exe, creationTicks: ATTACH_FAIL_TICKS } }
    }
    const args = parseArgs([
      '--exe', exePath, '--sha256', sha256, '--repo', repo, '--stamp', 'attachfail',
      '--without-fixture-chat', '--attach-wait-ms', '0',
    ])
    return await runAcceptance(args, {
      spawnImpl,
      identityImpl,
      fetchImpl: async () => ({ json: async () => ({ Browser: 'Edg/120.0' }) }),
      cdpAttach: async () => { throw new Error('no unique page target with the owned gateway origin') },
      sleepImpl: async () => {},
    })
  } finally {
    await rm(repo, { recursive: true, force: true })
  }
}

test('P1: the forced cleanup identifies and terminates the owned child with the real capture semantics', async () => {
  const pid = 6100
  const calls = []
  const registry = new Map()
  const { child, kills } = makeKillableFakeChild(pid)
  const record = await runAttachFailure({ identityImpl: pidIdentitySource(registry, calls), child, pid, registry })
  assert.equal(record.verdict, 'target-selection-failed')
  assert.equal(record.process.terminatedByHarness, true, 'the forced cleanup must identify and terminate the owned child')
  assert.deepEqual(record.process.unresolvedRoots, [])
  assert.ok(calls.length > 0, 'the identity source must be consulted')
  assert.ok(calls.every(Number.isInteger), `the identity source takes a PID, but was called with ${JSON.stringify(calls.slice(0, 2))}`)
  assert.equal(kills.count, 1)
})

test('P2: an unidentified child is never terminated: the forced cleanup records an unresolved root', async () => {
  const pid = 6101
  const { child, kills } = makeKillableFakeChild(pid)
  const unanswered = async value => ({
    available: false, status: 'unknown', pid: null, exe: null, creationTicks: null,
    reason: `identity query failed for ${typeof value === 'string' ? 'a query string' : 'the pid'}: EPERM`,
  })
  const record = await runAttachFailure({ identityImpl: unanswered, child, pid })
  assert.equal(record.process.terminatedByHarness, false, 'an unanswered identity query never authorises a kill')
  assert.equal(record.process.unresolvedRoots.length, 1)
  assert.match(record.process.unresolvedRoots[0].reason, /not established/u)
  assert.equal(kills.count, 0)
})

test('P3: a reused pid is never terminated: the forced cleanup refuses the mismatched identity', async () => {
  const pid = 6102
  const calls = []
  const registry = new Map()
  const { child, kills } = makeKillableFakeChild(pid)
  const record = await runAttachFailure({
    identityImpl: pidIdentitySource(registry, calls), child, pid, registry, registryTicks: '133900000000009999',
  })
  assert.equal(record.process.terminatedByHarness, false)
  assert.equal(record.process.unresolvedRoots.length, 1)
  assert.match(record.process.unresolvedRoots[0].reason, /pid was reused/u)
  assert.equal(kills.count, 0)
})

// ---------------------------------------------------------------------------
// Q. Credential-free account surface through the always-mounted launcher menu
// ---------------------------------------------------------------------------

/** A fake `[role="menu"]` document with real source rows and click counters. */
function fakeAccountMenuDom({ items = [], accountMenu = true } = {}) {
  const nodes = items.map(({ label, disabled = false }) => ({
    disabled,
    textContent: label,
    getAttribute: () => null,
    clicked: 0,
    click() { this.clicked += 1 },
  }))
  const menu = { querySelectorAll: selector => (selector === 'button[role="menuitem"]' ? nodes : []) }
  const menus = accountMenu ? [menu] : []
  return { document: { querySelectorAll: selector => (selector === '[role="menu"]' ? menus : []) }, nodes }
}

test('Q1: the account popover is identified by its own source rows, and no row is ever activated', () => {
  const account = fakeAccountMenuDom({ items: [{ label: 'Settings' }, { label: 'Feedback' }, { label: 'Sign in' }] })
  const probe = evaluatePanelExpression(ACCOUNT_MENU_EXPRESSION, account)
  assert.equal(probe.accountMenuPresent, true)
  assert.equal(probe.signInItemPresent, true)
  assert.equal(probe.signInItemLabel, 'Sign in')
  assert.equal(probe.signOutItemPresent, false)
  assert.deepEqual(account.nodes.map(node => node.clicked), [0, 0, 0], 'the sign-in row is observed, never clicked')

  // The Chinese copy is the same surface.
  const zh = fakeAccountMenuDom({ items: [{ label: '设置' }, { label: '意见反馈' }, { label: '登录' }] })
  const zhProbe = evaluatePanelExpression(ACCOUNT_MENU_EXPRESSION, zh)
  assert.equal(zhProbe.accountMenuPresent, true)
  assert.equal(zhProbe.signInItemLabel, '登录')
  assert.deepEqual(zh.nodes.map(node => node.clicked), [0, 0, 0])

  // Another menu (a model picker) is never mistaken for the account menu.
  const other = fakeAccountMenuDom({ items: [{ label: 'Opus' }, { label: 'Sonnet' }] })
  assert.equal(evaluatePanelExpression(ACCOUNT_MENU_EXPRESSION, other).accountMenuPresent, false)

  // A disabled sign-in row is not an affordance.
  const disabled = fakeAccountMenuDom({ items: [{ label: 'Settings' }, { label: 'Feedback' }, { label: 'Sign in', disabled: true }] })
  const disabledProbe = evaluatePanelExpression(ACCOUNT_MENU_EXPRESSION, disabled)
  assert.equal(disabledProbe.accountMenuPresent, true)
  assert.equal(disabledProbe.signInItemPresent, false)

  // The expressions that DO click only ever click the launcher trigger.
  assert.ok(!ACCOUNT_MENU_EXPRESSION.includes('.click('), 'probing the popover must never activate anything')
  for (const expression of [ACCOUNT_MENU_OPEN_EXPRESSION, ACCOUNT_MENU_CLOSE_EXPRESSION]) {
    assert.equal((expression.match(/trigger\.click\(\)/gu) ?? []).length, 1)
    assert.ok(!expression.includes('menuitem'), 'the launcher expressions never address a menu row')
  }
})

test('Q2: the account-surface verdict is unqualified without a positively observed action row', () => {
  const opened = { triggerPresent: true, clicked: true, ariaLabel: 'Account menu' }
  const pass = evaluateAccountMenu({ openOutcome: opened, probe: { accountMenuPresent: true, signInItemPresent: true, signInItemLabel: 'Sign in', signOutItemPresent: false } })
  assert.equal(pass.status, 'pass')
  assert.equal(pass.how, 'account-menu-sign-in-item')

  assert.equal(evaluateAccountMenu({ openOutcome: { triggerPresent: false }, probe: null }).status, 'unqualified')
  assert.equal(evaluateAccountMenu({ openOutcome: { triggerPresent: true, clicked: false }, probe: null }).status, 'unqualified')
  assert.equal(evaluateAccountMenu({ openOutcome: opened, probe: { accountMenuPresent: false } }).status, 'unqualified')
  const noAction = evaluateAccountMenu({ openOutcome: opened, probe: { accountMenuPresent: true, signInItemPresent: false, signOutItemPresent: false } })
  assert.equal(noAction.status, 'unqualified', 'a popover with no enabled account action is never a pass')
  assert.equal(noAction.how, 'no-account-menu-action')
  const signedInMenu = evaluateAccountMenu({ openOutcome: opened, probe: { accountMenuPresent: true, signInItemPresent: false, signOutItemPresent: true } })
  assert.equal(signedInMenu.status, 'pass')
  assert.equal(signedInMenu.how, 'account-menu-sign-out-item')
})

/**
 * The Settings/account surface of a credential-free run: the modal with or
 * without its credential-gated Account section, plus the always-mounted launcher.
 */
function settingsScenarioHarness({ sectionAvailable = false, menuOpens = true, signInItem = true, menuProbeFailsAfter = null } = {}) {
  let settingsOpen = false
  let menuOpen = false
  let menuProbes = 0
  const connection = {
    evaluate: async expression => {
      if (expression.includes('settings-mounted')) return { record: 'settings-mounted', mounted: settingsOpen }
      if (expression.includes('blur-active')) return { record: 'blur-active', blurred: true }
      if (expression.includes('account-nav')) return { record: 'account-nav', clicked: settingsOpen && sectionAvailable }
      if (expression.includes('account-panel')) {
        return {
          record: 'account-panel', modalPresent: settingsOpen, textLength: 64,
          signedOutActionPresent: settingsOpen && sectionAvailable, signedInActionPresent: false,
          signedInAccountInfoPresent: false, signedInMarkerPresent: false, affordance: null,
        }
      }
      if (expression.includes('account-menu-open')) {
        const alreadyOpen = menuOpen
        if (menuOpens) menuOpen = true
        return { record: 'account-menu-open', triggerPresent: true, clicked: menuOpens && !alreadyOpen, alreadyOpen, ariaLabel: 'Account menu' }
      }
      if (expression.includes('account-menu-close')) {
        const wasOpen = menuOpen
        menuOpen = false
        return { record: 'account-menu-close', closed: true, reason: wasOpen ? 'trigger-toggled' : 'already-collapsed' }
      }
      if (expression.includes('account-menu')) {
        menuProbes += 1
        if (menuProbeFailsAfter !== null && menuProbes > menuProbeFailsAfter) throw new Error('the account-menu probe is unavailable')
        return menuOpen
          ? { record: 'account-menu', accountMenuPresent: true, itemCount: 3, itemLabels: ['Settings', 'Feedback', 'Sign in'], signInItemPresent: signInItem, signInItemLabel: signInItem ? 'Sign in' : null, signOutItemPresent: false }
          : { record: 'account-menu', accountMenuPresent: false, itemCount: 0, itemLabels: [], signInItemPresent: false, signInItemLabel: null, signOutItemPresent: false }
      }
      if (expression.includes('surface-facts')) {
        return { record: 'surface-facts', textLength: 4000, accountSurfaceMentioned: true, updatesSurfaceMentioned: true, settingsSurfaceMounted: true }
      }
      if (expression.includes('update-status')) return { record: 'update-status', bridge: true, resolved: true, phase: 'idle', phaseKnown: true }
      throw new Error(`unexpected expression in the settings scenario harness: ${expression}`)
    },
    send: async (method, params) => {
      if (method === 'Input.dispatchKeyEvent' && params?.key === ',') settingsOpen = true
      if (method === 'Input.dispatchKeyEvent' && params?.key === 'Escape') { settingsOpen = false; menuOpen = false }
      return {}
    },
    close: async () => {},
  }
  return { connection, menuOpen: () => menuOpen }
}

test('Q3: with no stored credential the account surface is qualified through the launcher popover and dismissed', async () => {
  const harness = settingsScenarioHarness({ sectionAvailable: false })
  const facts = await runSettingsScenario({ connection: harness.connection, sleepImpl: async () => {}, log: () => {} })
  assert.equal(facts.settingsStatus, 'pass')
  assert.equal(facts.accountStatus, 'pass', 'the always-mounted launcher menu qualifies the account surface')
  assert.equal(facts.accountHow, 'account-menu-sign-in-item')
  assert.equal(facts.accountMenuTriggerLabel, 'Account menu')
  assert.deepEqual(facts.accountMenuItems, ['Settings', 'Feedback', 'Sign in'])
  assert.equal(facts.accountMenuSignInLabel, 'Sign in')
  assert.equal(facts.accountMenuDismissed, true, 'the popover must be dismissed after observation')
  assert.equal(harness.menuOpen(), false)
  assert.match(facts.accountDetail, /route=account-menu/u)
})

test('Q4: the signed-in Settings section route is unchanged and takes precedence', async () => {
  const harness = settingsScenarioHarness({ sectionAvailable: true })
  const facts = await runSettingsScenario({ connection: harness.connection, sleepImpl: async () => {}, log: () => {} })
  assert.equal(facts.accountStatus, 'pass')
  assert.equal(facts.accountHow, 'sign-in-control')
  assert.equal(facts.accountMenuTriggerLabel, null, 'the section route must not open the launcher popover')
  assert.match(facts.accountDetail, /route=settings-account-section/u)
})

test('Q5: a launcher that cannot open, or a popover with no action row, is never a pass', async () => {
  const closed = settingsScenarioHarness({ sectionAvailable: false, menuOpens: false })
  const closedFacts = await runSettingsScenario({ connection: closed.connection, sleepImpl: async () => {}, log: () => {} })
  assert.equal(closedFacts.accountStatus, 'unqualified')

  const noAction = settingsScenarioHarness({ sectionAvailable: false, signInItem: false })
  const noActionFacts = await runSettingsScenario({ connection: noAction.connection, sleepImpl: async () => {}, log: () => {} })
  assert.equal(noActionFacts.accountStatus, 'unqualified')
  assert.equal(noActionFacts.accountHow, 'no-account-menu-action')
})

test('Q6: an unknown menu probe is never a positive dismissal (bounded retry, explicit false only)', async () => {
  // The probe always throws: the dismissal stays UNVERIFIED, and the trigger
  // fallback is still attempted before giving up.
  let closeAttempts = 0
  const unavailable = {
    evaluate: async expression => {
      if (expression.includes('account-menu-close')) { closeAttempts += 1; return { record: 'account-menu-close', closed: false, reason: 'trigger-toggled' } }
      if (expression.includes('account-menu')) throw new Error('the account-menu probe is unavailable')
      throw new Error(`unexpected expression: ${expression}`)
    },
    send: async () => ({}),
  }
  const unverified = await closeAccountMenu({ connection: unavailable, sleepImpl: async () => {}, timeoutMs: 150 })
  assert.equal(unverified.closed, false, 'an unreadable probe can never be reported as a close')
  assert.equal(unverified.how, 'dismissal-unverified')
  assert.equal(closeAttempts, 1, 'the trigger fallback is attempted before giving up')

  // An explicit false is a positive dismissal, and a null answer is retried rather than trusted.
  let probes = 0
  const eventuallyClosed = {
    evaluate: async expression => {
      if (expression.includes('account-menu')) {
        probes += 1
        return probes === 1 ? { record: 'account-menu', accountMenuPresent: null } : { record: 'account-menu', accountMenuPresent: false }
      }
      throw new Error(`unexpected expression: ${expression}`)
    },
    send: async () => ({}),
  }
  const closed = await closeAccountMenu({ connection: eventuallyClosed, sleepImpl: async () => {}, timeoutMs: 500 })
  assert.equal(closed.closed, true)
  assert.equal(closed.how, 'explicitly-closed')
  assert.ok(probes >= 2)
})

test('Q7: the menu route cannot carry the check unless the popover was positively dismissed', async () => {
  // The popover opens and shows its sign-in row, but every later probe is
  // unavailable: the affordance was observed, yet the cleanup contract failed.
  const harness = settingsScenarioHarness({ sectionAvailable: false, menuProbeFailsAfter: 1 })
  const facts = await runSettingsScenario({ connection: harness.connection, sleepImpl: async () => {}, log: () => {} })
  assert.equal(facts.accountMenuSignInLabel, 'Sign in', 'the sign-in row was positively observed')
  assert.equal(facts.accountMenuDismissed, false)
  assert.equal(facts.accountStatus, 'unqualified', 'an undismissed popover must not count as a pass')
  assert.equal(facts.accountHow, 'account-menu-not-dismissed')
  assert.match(facts.accountDetail, /dismissal could not be positively established/u)
})
