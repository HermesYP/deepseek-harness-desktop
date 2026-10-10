/**
 * Regression tests for the Host fixture's isolation guarantees.
 *
 * WHY THESE EXIST: the opt-in Host integration spawns a real product process and
 * used to hand it the operator's entire environment with three keys overridden,
 * force-killed it on a bare `ChildProcess` handle, and reported "isolated" in
 * both cases. Those are claims about a running process, so they need coverage
 * that does not require running one — and a claim nobody asserts is a claim
 * nobody maintains.
 *
 * WHAT THESE DO NOT DO: they never spawn the Host, never bind a port, and never
 * touch a live Harness home. The one real operating-system call here is `icacls`
 * against a throwaway directory under the port scratch tree, used to prove the
 * hardening command actually works; nothing in the repository, in an install
 * directory or in a user profile is named. The integration contract itself is
 * unchanged: this file asserts the helper behaviour, never relaxes it.
 *
 * Run with: node --test port/tests/fixture-isolation.test.mjs
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { userInfo } from 'node:os'

import {
  assertFixtureDirectoryAcls, assertFixtureEnvironment, assertNoSecrets, buildFixtureEnvironment,
  classifyFixtureEnvName, createRedactor, defaultAclRunner, describeEnvironmentGuarantee,
  ENV_DENY_RULES, isInsideRoot, readFixtureDirectoryAcls, splitHomeDrive,
} from './helpers/fixture-isolation.mjs'
import {
  ABSENCE_REASON, ABSENT_SENTINEL, assessDescendants, buildIdentityQuery, buildProcessTableQuery,
  captureProcessIdentity, captureProcessTable, compareProcessIdentity, descendantsOf, epochMillisToTicks,
  IDENTITY_STATUS, MAX_TABLE_ROWS, nowUtcTicks, parseProcessIdentity, parseProcessTable, processIsAbsent,
  settleDescendants, summariseTermination, survivingDescendants, terminateOwnedChild,
} from './helpers/process-authority.mjs'

const SCRATCH = resolve(import.meta.dirname, '..', '.scratch', 'fixture-isolation-tests')
const ROOT = '/fixture/adapter-launch-abc'

// ---------------------------------------------------------------------------
// Deny classification: the ambient state that must never reach a spawned Host.
// ---------------------------------------------------------------------------

test('every product, webview, proxy, secret and runtime-override name is denied', () => {
  // Each name here is one that, if inherited, would let a spawned Host read or
  // impersonate the operator's live state. None may survive the filter.
  const mustDeny = [
    'DSH_HOME', 'DSH_DESKTOP_CONTROL_SOCKET', 'DSH_DESKTOP_CONTROL_TOKEN',
    'DSH_DESKTOP_RUNTIME_DIR', 'DSH_ADAPTER_INTEGRATION_PAYLOAD',
    'WEBVIEW2_USER_DATA_FOLDER', 'WEBVIEW2_BROWSER_EXECUTABLE_FOLDER', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'DEEPSEEK_API_KEY', 'MY_SERVICE_APIKEY',
    'GITHUB_TOKEN', 'NPM_TOKEN', 'DSH_OAUTH',
    'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'SERVICE_CREDENTIALS', 'TLS_PRIVATE_KEY', 'SIGNING_KEY',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'npm_config_proxy',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'ELECTRON_RUN_AS_NODE', 'COREPACK_HOME',
    'NPM_CONFIG_PREFIX', 'npm_config_registry',
    'SSL_CERT_FILE', 'CURL_CA_BUNDLE', 'NODE_TLS_REJECT_UNAUTHORIZED',
  ]
  for (const name of mustDeny) {
    assert.notEqual(classifyFixtureEnvName(name), null, `${name} must be denied, not inherited`)
  }
})

test('ordinary operating-system variables are not denied', () => {
  // Over-stripping is its own defect: a Host with no SystemRoot or PATH is not
  // the product, so a green result would measure a different program.
  for (const name of ['Path', 'PATH', 'SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'NumberOfProcessors', 'PROCESSOR_ARCHITECTURE', 'OS', 'ProgramData', 'LANG']) {
    assert.equal(classifyFixtureEnvName(name), null, `${name} is not a secret and must pass through`)
  }
})

test('a mixed-case package-manager or launch override is denied like its upper-case twin', () => {
  // Windows environment names are case-insensitive: `Npm_Config_Registry` and
  // `NPM_CONFIG_REGISTRY` are the same variable. A case-sensitive pattern would
  // have let the mixed-case spelling carry a registry or interpreter override
  // straight into the spawned Host.
  for (const name of ['Npm_Config_Registry', 'NpM_config_prefix', 'PnPm_home', 'PNPm_store_path', 'COREpack_home', 'cOrEpAcK_home', 'Yarn_cache_folder', 'Electron_Enable_Logging', 'Azure_ClientId']) {
    assert.notEqual(classifyFixtureEnvName(name), null, `${name} must be denied regardless of spelling`)
  }
  // ...and the same names actually leave the built environment.
  const mixed = buildFixtureEnvironment({
    inherited: { Npm_Config_Registry: 'https://evil.invalid/', PnPm_home: 'C:\\other', COREPACK_HOME: 'C:\\other', Electron_Enable_Logging: '1' },
    root: ROOT, home: `${ROOT}/home`, control: null,
  })
  for (const name of ['Npm_Config_Registry', 'PnPm_home', 'COREPACK_HOME', 'Electron_Enable_Logging']) {
    assert.ok(!(name in mixed.env), `${name} must not reach the spawned Host`)
  }
  assert.ok(!JSON.stringify(mixed.env).includes('evil.invalid'))
})

test('every deny rule is exercised by at least one name', () => {
  const covered = new Set([
    'DSH_HOME', 'WEBVIEW2_USER_DATA_FOLDER', 'HTTP_PROXY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN',
    'NODE_OPTIONS', 'npm_config_registry', 'SSL_CERT_FILE', 'ELECTRON_ENABLE_LOGGING',
  ].map(name => classifyFixtureEnvName(name)))
  for (const rule of ENV_DENY_RULES) assert.ok(covered.has(rule.id), `deny rule ${rule.id} matches no test name`)
})

// ---------------------------------------------------------------------------
// Environment construction
// ---------------------------------------------------------------------------

const INHERITED = Object.freeze({
  Path: 'C:\\Windows\\system32',
  SystemRoot: 'C:\\Windows',
  DSH_HOME: 'C:\\Users\\operator\\.dsh\\production',
  DSH_DESKTOP_CONTROL_TOKEN: 'inherited-control-token',
  WEBVIEW2_USER_DATA_FOLDER: 'C:\\Users\\operator\\AppData\\webview2',
  ANTHROPIC_API_KEY: 'sk-inherited-value',
  HTTPS_PROXY: 'http://proxy.internal:8080',
  NODE_OPTIONS: '--require C:\\evil\\inject.js',
  USERPROFILE: 'C:\\Users\\operator',
  APPDATA: 'C:\\Users\\operator\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\operator\\AppData\\Local',
  TEMP: 'C:\\Users\\operator\\AppData\\Local\\Temp',
  TMP: 'C:\\Users\\operator\\AppData\\Local\\Temp',
  HOME: '/home/operator',
})

function fixture({ root = '/fixture/adapter-launch-abc', home = `${root}/home`, control = null } = {}) {
  return buildFixtureEnvironment({ inherited: INHERITED, root, home, control })
}

test('no inherited product, secret or proxy value survives into the child environment', () => {
  const { env } = fixture()
  // DSH_HOME is a denied NAME, so the inherited value goes; the fixture then
  // writes its own back. Asserting only "absent" would miss the real defect,
  // which is the operator's home still being the one in play.
  assert.equal(env.DSH_HOME, `${ROOT}/home`, 'the inherited DSH_HOME must be replaced, not merely overwritten in place')
  assert.notEqual(env.DSH_HOME, 'C:\\Users\\operator\\.dsh\\production')
  for (const name of ['DSH_DESKTOP_CONTROL_TOKEN', 'WEBVIEW2_USER_DATA_FOLDER', 'ANTHROPIC_API_KEY', 'HTTPS_PROXY', 'NODE_OPTIONS']) {
    assert.ok(!(name in env), `${name} must not reach the spawned Host`)
  }
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
})

test('an inherited control token does not survive as a VALUE under another name', () => {
  // Stripping by name is not enough if the same value is re-introduced under a
  // name the rules do not cover; the value itself must vanish.
  const { env } = fixture({ control: { socket: '\\\\.\\pipe\\dsh-adapter-test-new', token: 'fixture-owned-token-value' } })
  assert.ok(!Object.values(env).includes('inherited-control-token'))
  assert.ok(!JSON.stringify(env).includes('inherited-control-token'))
  assert.ok(!JSON.stringify(env).includes('C:\\Users\\operator\\.dsh\\production'))
})

test('the report records denied NAMES and categories, never denied values', () => {
  const { stripped } = fixture()
  const serialized = JSON.stringify(stripped)
  assert.ok(serialized.includes('ANTHROPIC_API_KEY'), 'the name must be recorded so the claim is auditable')
  assert.ok(!serialized.includes('sk-inherited-value'), 'a denied value must never be recorded')
  assert.ok(!serialized.includes('proxy.internal'), 'a denied value must never be recorded')
})

test('every path the child sees points inside the fixture root, never the operator home', () => {
  const { env } = fixture()
  for (const [name, value] of Object.entries(env)) {
    if (!['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'DSH_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'].includes(name)) continue
    assert.ok(isInsideRoot(value, ROOT), `${name}=${value} escaped the fixture root`)
  }
  assert.equal(env.HOME, `${ROOT}/home`)
  assert.equal(env.DSH_HOME, `${ROOT}/home`)
  assert.equal(env.TEMP, ROOT, 'temp files land in the owned fixture, not the operator temp directory')
  assert.equal(env.TMP, ROOT)
})

test('the owned-variable assertion passes on a correctly built environment', () => {
  const built = fixture()
  assert.deepEqual(assertFixtureEnvironment(built.env, {
    root: ROOT, controlled: false, ownedKeys: built.ownedKeys, inherited: INHERITED,
  }), [])
})

test('an operator home leaking back into the environment is caught', () => {
  // The specific regression: an edit that copies the parent environment again
  // and only overrides three keys would look correct at the call site.
  const built = fixture()
  const leaked = { ...built.env, USERPROFILE: 'C:\\Users\\operator', APPDATA: 'C:\\Users\\operator\\AppData\\Roaming' }
  const violations = assertFixtureEnvironment(leaked, { root: ROOT, controlled: false, ownedKeys: built.ownedKeys })
  assert.ok(violations.some(v => /USERPROFILE .* outside the fixture root/u.test(v)), violations.join('; '))
  assert.ok(violations.some(v => /APPDATA .* outside the fixture root/u.test(v)), violations.join('; '))
})

test('a relative or absent path variable is caught, not accepted as "unset"', () => {
  const built = fixture()
  for (const [name, value] of [['TEMP', 'relative/temp'], ['TMP', undefined]]) {
    const candidate = { ...built.env }
    if (value === undefined) delete candidate[name]
    else candidate[name] = value
    const violations = assertFixtureEnvironment(candidate, { root: ROOT, controlled: false, ownedKeys: built.ownedKeys })
    assert.ok(violations.some(v => v.includes(name)), `${name}: ${violations.join('; ')}`)
  }
})

test('a secret variable that survives filtering is caught even when it looks owned', () => {
  const built = fixture()
  const contaminated = { ...built.env, ANTHROPIC_API_KEY: 'sk-leaked' }
  const violations = assertFixtureEnvironment(contaminated, { root: ROOT, controlled: false, ownedKeys: built.ownedKeys })
  assert.ok(violations.some(v => /ANTHROPIC_API_KEY survived stripping/u.test(v)), violations.join('; '))
})

test('the control channel is present only for a controlled launch', () => {
  const uncontrolled = fixture()
  assert.ok(!('DSH_DESKTOP_CONTROL_SOCKET' in uncontrolled.env))
  assert.ok(!('DSH_DESKTOP_CONTROL_TOKEN' in uncontrolled.env))
  assert.deepEqual(assertFixtureEnvironment(uncontrolled.env, { root: ROOT, controlled: false, ownedKeys: uncontrolled.ownedKeys }), [])

  const controlled = fixture({ control: { socket: '\\\\.\\pipe\\dsh-adapter-test-xyz', token: 'token-value' } })
  assert.equal(controlled.env.DSH_DESKTOP_CONTROL_SOCKET, '\\\\.\\pipe\\dsh-adapter-test-xyz')
  assert.equal(controlled.env.DSH_DESKTOP_CONTROL_TOKEN, 'token-value')
  assert.deepEqual(assertFixtureEnvironment(controlled.env, { root: ROOT, controlled: true, ownedKeys: controlled.ownedKeys }), [])

  // A controlled launch that lost its token is a failure, not a "no control needed" run.
  const broken = { ...controlled.env }
  delete broken.DSH_DESKTOP_CONTROL_TOKEN
  assert.ok(assertFixtureEnvironment(broken, { root: ROOT, controlled: true, ownedKeys: controlled.ownedKeys })
    .some(v => /missing owned DSH_DESKTOP_CONTROL_TOKEN/u.test(v)))
})

test('the environment guarantee summary stays value-free', () => {
  const built = fixture()
  const summary = describeEnvironmentGuarantee({ ...built, violations: [] })
  const serialized = JSON.stringify(summary)
  assert.ok(!serialized.includes('sk-inherited-value'))
  assert.ok(!serialized.includes('C:\\Users\\operator'))
  assert.ok(summary.inheritedNamesStripped >= 6)
  assert.equal(summary.containmentViolations.length, 0)
})

test('a scratch-shaped sibling is not inside the root', () => {
  assert.ok(!isInsideRoot('/fixture/adapter-launch-abc-evil', ROOT))
  assert.ok(!isInsideRoot('/fixture', ROOT))
  assert.ok(isInsideRoot(`${ROOT}/home/deep`, ROOT))
  assert.ok(isInsideRoot(ROOT, ROOT))
  assert.ok(!isInsideRoot('', ROOT))
})

test('the Windows home drive split produces values os.UserInfo would accept', () => {
  assert.deepEqual(splitHomeDrive('C:\\fixture\\home', 'win32'), { drive: 'C:', path: '\\fixture\\home' })
  assert.equal(splitHomeDrive('/fixture/home', 'linux'), null)
})

// ---------------------------------------------------------------------------
// Secrets never reach a report or a summary.
// ---------------------------------------------------------------------------

test('the redactor erases owned secrets from arbitrary text', () => {
  const { redact, add, secrets } = createRedactor(['0123456789abcdef-token', undefined, 'short'])
  assert.deepEqual(secrets(), ['0123456789abcdef-token'], 'only non-trivial secrets are treated as redactable')
  const output = redact('token=0123456789abcdef-token end')
  assert.ok(!output.includes('0123456789abcdef-token'))
  assert.match(output, /<redacted>/u)
})

test('a secret learned mid-run is registered and redacted by later writes', () => {
  // A snapshot redactor would miss exactly these: the gateway URL and its token
  // do not exist until the Host has booted.
  const { redact, add, secrets } = createRedactor()
  const url = 'http://127.0.0.1:41234/?token=live-session-token-abcdef'
  assert.equal(redact(`requesting ${url}`), `requesting ${url}`, 'not registered yet, so not redacted')
  add(url, new URL(url).searchParams.get('token'))
  const output = redact(`requesting ${url} with token live-session-token-abcdef`)
  assert.ok(!output.includes('live-session-token-abcdef'))
  assert.ok(!output.includes('41234'), 'the whole URL is registered, so the port does not survive either')
  assert.match(output, /<redacted>/u)
  assert.equal(secrets().length, 2)
})

test('registration is idempotent and ignores values too short to redact safely', () => {
  const { add, secrets } = createRedactor()
  assert.equal(add('abcdefgh'), 1)
  assert.equal(add('abcdefgh'), 0, 'a duplicate is not added twice')
  assert.equal(add('short'), 0)
  assert.equal(add(undefined, null, ''), 0)
  assert.deepEqual(secrets(), ['abcdefgh'])
})

test('a report that still contains a secret is refused, not written', () => {
  const { secrets } = createRedactor(['0123456789abcdef-token'])
  const clean = JSON.stringify({ checks: [{ exit: { code: 0 } }] }, null, 2)
  assert.doesNotThrow(() => assertNoSecrets(clean, secrets(), 'report.json'))
  const leaked = JSON.stringify({ checks: [{ env: { DSH_DESKTOP_CONTROL_TOKEN: '0123456789abcdef-token' } }] })
  assert.throws(() => assertNoSecrets(leaked, secrets(), 'report.json'), /contains a fixture secret/u)
})

// ---------------------------------------------------------------------------
// Process identity and termination authority
// ---------------------------------------------------------------------------

const IDENTITY = Object.freeze({ available: true, status: IDENTITY_STATUS.PRESENT, pid: 4242, exe: 'C:\\node\\node.exe', creationTicks: '638000000000000000', reason: '' })

test('the identity query addresses one pid through the CIM provider', () => {
  const query = buildIdentityQuery(4242)
  assert.match(query, /-Filter "ProcessId = 4242"/u)
  assert.match(query, /CreationDate/u)
  assert.ok(!query.includes('Get-Process'), 'Get-Process cannot distinguish a denied pid from a missing one')
  assert.ok(!query.includes('StartTime'), 'Get-Process StartTime is not part of the CIM contract')
  assert.equal(buildIdentityQuery(0), '""', 'pid 0 is never a process to inspect')
  assert.equal(buildIdentityQuery('abc'), '""')
})

test('every emitted PowerShell fragment separates its statements', () => {
  // PowerShell needs a newline or `;` before a block keyword. Joining with
  // spaces produces `$ErrorActionPreference='Stop' try {`, which is a PARSER
  // ERROR and exits 1 with no output — which is byte-identical to the "no rows"
  // case this query is meant to distinguish. These fragments are mocked in the
  // unit tests, so only a real parse catches this.
  for (const [label, query] of [['identity', buildIdentityQuery(4242)], ['table', buildProcessTableQuery()]]) {
    assert.match(query, /'\n/m, `${label} query must join its statements with newlines`)
    assert.doesNotMatch(query, /Stop' try/u, `${label} query would not parse if its statements were space-joined`)
    assert.doesNotMatch(query, /Stop' \{/u, `${label} query would not parse if its statements were space-joined`)
  }
})

test('identity output that proves nothing parses as unknown, never as absence', () => {
  for (const output of ['', '\n', 'Get-Process : denied', '4242|only-two-fields', 'notanumber|node.exe|638000000000000000', '4242|node.exe|notatick']) {
    const identity = parseProcessIdentity(output)
    assert.equal(identity.available, false, JSON.stringify(output))
    assert.equal(identity.status, IDENTITY_STATUS.UNKNOWN, JSON.stringify(output))
    assert.equal(processIsAbsent(identity), false, JSON.stringify(output))
  }
  assert.match(parseProcessIdentity('').reason, /failed read, not an absence/u)
})

test('a well-formed identity parses', () => {
  assert.deepEqual(parseProcessIdentity(`\n4242|C:\\node\\node.exe|638000000000000000\n`), IDENTITY)
})

test('a failed identity query is missing authority, not proof of absence', async () => {
  // The distinction the force-kill path depends on: "I could not look" must not
  // be collapsed into "there is nothing there".
  const identity = await captureProcessIdentity(4242, {
    run: async () => { throw Object.assign(new Error('Access is denied'), { code: 'EPERM' }) },
  })
  assert.equal(identity.available, false)
  assert.match(identity.reason, /identity query failed/u)
  assert.equal(identity.status, IDENTITY_STATUS.UNKNOWN)
  assert.equal(processIsAbsent(identity), false, 'a failed query must never read as absence')
})

test('empty query output is a failed read, never an absence', () => {
  // The renderer-lane finding: `Get-Process -Id N` under SilentlyContinue emits
  // EMPTY stdout both when there is no such process AND when it cannot read one.
  // Reading that as absence turned a denial into a clean teardown.
  const identity = parseProcessIdentity('')
  assert.equal(identity.status, IDENTITY_STATUS.UNKNOWN)
  assert.equal(processIsAbsent(identity), false)
  assert.match(identity.reason, /failed read, not an absence/u)
  assert.equal(parseProcessIdentity('   \n  ').status, IDENTITY_STATUS.UNKNOWN)
})

test('absence is stated by the query sentinel, never inferred from emptiness', () => {
  const identity = parseProcessIdentity(ABSENT_SENTINEL)
  assert.equal(identity.status, IDENTITY_STATUS.ABSENT)
  assert.equal(identity.reason, ABSENCE_REASON)
  assert.equal(processIsAbsent(identity), true)
  assert.ok(buildIdentityQuery(4242).includes(ABSENT_SENTINEL), 'the query must emit the sentinel explicitly')
})

test('the identity query stops on error instead of swallowing a denial', () => {
  const query = buildIdentityQuery(4242)
  assert.match(query, /-ErrorAction Stop/u)
  assert.match(query, /try \{/u)
  assert.match(query, /exit 4/u)
  assert.ok(!query.includes('SilentlyContinue'), 'a swallowed error is indistinguishable from absence')
  // A filtered CIM query, not Get-Process: the pid is resolved by the provider.
  assert.match(query, /Get-CimInstance/u)
  assert.match(query, /-Filter "ProcessId = 4242"/u)
})

test('a present process whose metadata is denied or unreadable is unknown, not absent', () => {
  const denied = parseProcessIdentity('4242||638000000000000000')
  assert.equal(denied.status, IDENTITY_STATUS.PRESENT)
  assert.equal(denied.exe, null, 'an unreadable image path is recorded, not invented')
  const noStart = parseProcessIdentity('4242|C:\\node\\node.exe|')
  assert.equal(noStart.status, IDENTITY_STATUS.UNKNOWN, 'a missing start time is not an absence')
  assert.equal(processIsAbsent(noStart), false)
})

test('an unreadable pid query is unknown, and never reads as absence', async () => {
  const cases = [
    ['unparseable output', parseProcessIdentity('Access is denied')],
    ['truncated output', parseProcessIdentity('4242|node.exe')],
    ['non-numeric pid', parseProcessIdentity('x|node.exe|638000000000000000')],
    ['non-numeric ticks', parseProcessIdentity('4242|node.exe|soon')],
    ['no pid at all', await captureProcessIdentity(0)],
  ]
  for (const [label, identity] of cases) {
    assert.equal(identity.status, IDENTITY_STATUS.UNKNOWN, `${label} must be unknown, not absent`)
    assert.equal(processIsAbsent(identity), false, `${label} must never read as absence`)
  }
})

test('only a positive OS "no such process" reads as absence', () => {
  assert.equal(processIsAbsent(parseProcessIdentity(ABSENT_SENTINEL)), true)
  // The predicate is narrow: it will not accept `available: false` on its own,
  // which is exactly what the renderer lane was doing.
  assert.equal(processIsAbsent({ available: false, reason: 'Access is denied' }), false)
  assert.equal(processIsAbsent({ available: false, reason: 'query failed: EPERM' }), false)
  assert.equal(processIsAbsent({ available: false, reason: 'the identity query produced no output at all, which is a failed read, not an absence' }), false)
  assert.equal(processIsAbsent(null), false)
  assert.equal(processIsAbsent(undefined), false)
  assert.equal(processIsAbsent(IDENTITY), false)
})

test('an identity without a status is unknown unless it carries the exact absence reason', () => {
  // Tolerated for an identity produced by an older caller, but only narrowly:
  // the absence reason string is the sole evidence, and nothing else qualifies.
  assert.equal(processIsAbsent({ available: false, reason: ABSENCE_REASON }), true)
  assert.equal(processIsAbsent({ available: false, reason: 'no process with that pid exists, probably' }), false)
  assert.equal(processIsAbsent({ available: false, reason: 'the process exited' }), false)
  assert.equal(processIsAbsent({ available: false, reason: '' }), false)
})

test('an absent pid is never reported as owned, and is told apart from unknown', () => {
  const verdict = compareProcessIdentity(IDENTITY, parseProcessIdentity(ABSENT_SENTINEL))
  assert.equal(verdict.owned, false)
  assert.equal(verdict.absent, true, 'absence is a distinct finding, not a generic refusal')

  const unknown = { available: false, status: IDENTITY_STATUS.UNKNOWN, pid: null, exe: null, creationTicks: null, reason: 'Access is denied' }
  const refusal = compareProcessIdentity(IDENTITY, unknown)
  assert.equal(refusal.owned, false)
  assert.equal(refusal.absent, false, 'an unanswered query must not claim absence')
  assert.match(refusal.reason, /refusing to terminate an unidentified process/u)
})

test('an OS-confirmed absent pid leaves no unresolved root, an unreadable one does', async () => {
  const gone = fakeChild({ pid: 4242 })
  const absentOutcome = await terminateOwnedChild({ child: gone, identityAtSpawn: IDENTITY, label: 'host', capture: async () => parseProcessIdentity(ABSENT_SENTINEL) })
  assert.equal(absentOutcome.alreadyAbsent, true, 'a pid the OS says is gone is a finding, not a failure')
  assert.equal(absentOutcome.terminated, false)
  assert.deepEqual(absentOutcome.unresolvedRoots, [])
  assert.equal(gone.killed, false, 'there is nothing there to kill')

  // An empty result — the shape a denied Get-Process produces — must land on the
  // unresolved side, not the clean one.
  const silent = fakeChild({ pid: 4242 })
  const silentOutcome = await terminateOwnedChild({ child: silent, identityAtSpawn: IDENTITY, label: 'host', capture: async () => '' })
  assert.equal(silentOutcome.alreadyAbsent, false, 'empty output is not absence')
  assert.equal(silentOutcome.unresolvedRoots.length, 1)
  assert.match(silentOutcome.unresolvedRoots[0].reason, /failed read, not an absence/u)

  const unknown = fakeChild({ pid: 4242 })
  const unknownOutcome = await terminateOwnedChild({
    child: unknown, identityAtSpawn: IDENTITY, label: 'host',
    capture: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) },
  })
  assert.equal(unknownOutcome.alreadyAbsent, false, 'a query failure must never be reported as absence')
  assert.equal(unknownOutcome.unresolvedRoots.length, 1)
  assert.match(unknownOutcome.unresolvedRoots[0].reason, /identity query failed/u)
  assert.equal(unknown.killed, false)
})

test('a reused pid is not the process this fixture spawned', () => {
  const fresh = { ...IDENTITY, creationTicks: '638000000000000999' }
  const verdict = compareProcessIdentity(IDENTITY, fresh)
  assert.equal(verdict.owned, false)
  assert.match(verdict.reason, /pid was reused/u)
})

test('a different executable under the same pid and creation time is still refused', () => {
  const verdict = compareProcessIdentity(IDENTITY, { ...IDENTITY, exe: 'C:\\other\\thing.exe' })
  assert.equal(verdict.owned, false)
  assert.match(verdict.reason, /not C:\\node\\node.exe/u)
})

test('two unknown executables are NOT a match', () => {
  // The review finding: with both exe fields null and no `expectedExe`, the
  // comparison passed on the sole ground that the two sides were equally empty.
  // "No evidence either way" must never authorise a termination.
  const anonymous = { available: true, status: IDENTITY_STATUS.PRESENT, pid: 4242, exe: null, creationTicks: '638000000000000000', reason: '' }
  const verdict = compareProcessIdentity(anonymous, { ...anonymous })
  assert.equal(verdict.owned, false)
  assert.match(verdict.reason, /no readable executable name/u)
  // ...and with an expectedExe supplied it is refused for the same reason.
  assert.equal(compareProcessIdentity(anonymous, { ...anonymous }, { expectedExe: 'C:\\node\\node.exe' }).owned, false)
  // A spawn-time observation with no name has nothing to compare against.
  assert.equal(compareProcessIdentity({ ...IDENTITY, exe: null }, IDENTITY).owned, false)
  // ...and a readable name on both sides still passes.
  assert.equal(compareProcessIdentity(IDENTITY, { ...IDENTITY }).owned, true)
})

test('an unresolvable current identity refuses termination', () => {
  const verdict = compareProcessIdentity(IDENTITY, { available: false, pid: null, exe: null, creationTicks: null, reason: 'Access is denied' })
  assert.equal(verdict.owned, false)
  assert.match(verdict.reason, /refusing to terminate an unidentified process/u)
})

test('a child handle without a spawn-time identity is not kill authority', () => {
  // This is the exact shape of the old code path: a live ChildProcess object and
  // no exit event. It must never authorise a kill.
  const verdict = compareProcessIdentity(null, IDENTITY)
  assert.equal(verdict.owned, false)
  assert.match(verdict.reason, /child handle alone does not prove/u)
  assert.equal(compareProcessIdentity(undefined, IDENTITY).owned, false)
})

test('a matching fresh identity is the only case that authorises termination', () => {
  assert.equal(compareProcessIdentity(IDENTITY, IDENTITY).owned, true)
  assert.equal(compareProcessIdentity(IDENTITY, { ...IDENTITY, exe: 'c:\\NODE\\NODE.EXE' }).owned, true)
  assert.equal(compareProcessIdentity(IDENTITY, IDENTITY, { expectedExe: 'C:\\node\\node.exe' }).owned, true)
  assert.equal(compareProcessIdentity(IDENTITY, IDENTITY, { expectedExe: 'C:\\other\\node.exe' }).owned, false)
  assert.equal(compareProcessIdentity(IDENTITY, IDENTITY).absent, false)
})

function fakeChild({ pid, exitCode = null, autoExit = true } = {}) {
  const listeners = new Map()
  return {
    pid,
    exitCode,
    signalCode: null,
    killed: false,
    unreffed: false,
    kill() {
      this.killed = true
      // A real terminated process reports its exit asynchronously; emitting it
      // synchronously would be missed by a caller that registers just after.
      if (autoExit) setImmediate(() => { this.exitCode = 0; this.emit('exit', 0, null) })
    },
    unref() { this.unreffed = true },
    once(event, handler) { listeners.set(event, handler) },
    emit(event, ...args) { listeners.get(event)?.(...args) },
  }
}

test('an unverified process is never killed and is reported as an unresolved root', async () => {
  for (const [label, identityAtSpawn, fresh] of [
    ['no spawn-time identity', null, IDENTITY],
    ['identity unavailable at kill time', IDENTITY, { available: false, pid: null, exe: null, creationTicks: null, reason: 'denied' }],
    ['pid reused before kill', IDENTITY, { ...IDENTITY, creationTicks: '638000000000000999' }],
  ]) {
    const child = fakeChild({ pid: 4242 })
    const outcome = await terminateOwnedChild({ child, identityAtSpawn, label: 'host', capture: async () => fresh })
    assert.equal(outcome.terminated, false, label)
    assert.equal(child.killed, false, `${label}: nothing may be killed without proof`)
    assert.equal(child.unreffed, true, `${label}: the handle must be released, not leaked`)
    assert.equal(outcome.unresolvedRoots.length, 1, label)
    assert.match(outcome.unresolvedRoots[0].reason, /\S/u)
    assert.match(outcome.unresolvedRoots[0].action, /not terminated/u)
  }
})

test('a verified owned process is terminated', async () => {
  const child = fakeChild({ pid: 4242 })
  const outcome = await terminateOwnedChild({ child, identityAtSpawn: IDENTITY, capture: async () => IDENTITY })
  assert.equal(child.killed, true)
  assert.equal(outcome.terminated, true)
  assert.deepEqual(outcome.unresolvedRoots, [])
  assert.match(outcome.note, /after identity verification/u)
})

test('a child that already exited is not terminated at all', async () => {
  const child = fakeChild({ pid: 4242, exitCode: 0 })
  const outcome = await terminateOwnedChild({ child, identityAtSpawn: IDENTITY, capture: async () => IDENTITY })
  assert.equal(outcome.alreadyExited, true)
  assert.equal(child.killed, false)
  assert.deepEqual(outcome.unresolvedRoots, [])
})

test('a verification that never observes an exit is reported, not retried blindly', async () => {
  const child = fakeChild({ pid: 4242, autoExit: false })
  const outcome = await terminateOwnedChild({
    child, identityAtSpawn: IDENTITY, capture: async () => IDENTITY, terminationTimeoutMs: 10,
  })
  assert.equal(outcome.terminated, false)
  assert.equal(child.killed, true, 'the verified process was terminated')
  assert.equal(child.unreffed, true)
  assert.equal(outcome.unresolvedRoots.length, 1)
  assert.match(outcome.unresolvedRoots[0].reason, /did not report an exit/u)
})

test('the termination summary states its policy and carries every unresolved root', () => {
  const summary = summariseTermination([
    { terminated: true, unresolvedRoots: [] },
    { terminated: false, unresolvedRoots: [{ label: 'a', pid: 1, reason: 'r1' }] },
    { terminated: false, unresolvedRoots: [{ label: 'b', pid: 2, reason: 'r2' }] },
  ])
  assert.equal(summary.attempted, 3)
  assert.equal(summary.terminated, 1)
  assert.equal(summary.unresolvedRoots.length, 2)
  assert.match(summary.policy, /pid, exe and creation time/u)
})

// ---------------------------------------------------------------------------
// Descendant accounting: read-only, bounded, never a kill
// ---------------------------------------------------------------------------

const HOST_TICKS = 638000000000000000n

/** One snapshot row as `captureProcessTable` would emit it. */
function row(pid, parentPid, name, exe, creationTicks) {
  return `${pid}|${parentPid}|${name}|${exe}|${creationTicks}`
}

test('the process-table query is read-only and asks for the attribution fields', () => {
  const query = buildProcessTableQuery()
  assert.match(query, /Win32_Process/u)
  assert.match(query, /ParentProcessId/u)
  assert.match(query, /CreationDate/u)
  // No operation of any kind on any process: this query may only read.
  for (const forbidden of ['Stop-Process', 'taskkill', 'TerminateProcess', 'Remove-', 'Start-Process', 'Invoke-Command', 'Stop-Service']) {
    assert.ok(!query.includes(forbidden), `${forbidden} must never appear in a read-only snapshot query`)
  }
})

test('process rows parse, and an unreadable row is counted, not dropped', () => {
  const parsed = parseProcessTable([
    row(100, 4, 'System', '', '638000000000000001'),
    row(200, 100, 'node.exe', 'C:\\node\\node.exe', '638000000000000010'),
    'garbage line',
    'notanumber|100|node.exe|C:\\node\\node.exe|638000000000000010',
    '201|100|node.exe|C:\\node\\node.exe|notatick',
  ].join('\r\n'))
  assert.equal(parsed.rows.length, 2)
  assert.equal(parsed.rejected, 3, 'a row that cannot be parsed must be counted, never silently discarded')
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.rows[0], { pid: 100, parentPid: 4, name: 'System', exe: null, creationTicks: 638000000000000001n })
  assert.equal(parsed.rows[1].exe, 'C:\\node\\node.exe')
})

test('the actual Windows PID-zero kernel row is table data, never Host or kill authority', async () => {
  const output = [
    '0|0|System Idle Process||639255348502771840',
    row(4242, 0, 'node.exe', 'C:\\node\\node.exe', '639255348502771841'),
    row(5000, 0, 'unrelated.exe', '', '639255348502771842'),
    row(4243, 4242, 'node.exe', 'C:\\node\\node.exe', '639255348502771843'),
  ].join('\r\n')
  const parsed = parseProcessTable(output)
  assert.equal(parsed.rejected, 0)
  assert.equal(parsed.truncated, false)
  assert.deepEqual(parsed.rows[0], { pid: 0, parentPid: 0, name: 'System Idle Process', exe: null, creationTicks: 639255348502771840n })
  const snapshot = await captureProcessTable({ run: async () => output })
  assert.equal(snapshot.available, true, snapshot.reason)
  const subtree = descendantsOf({ host: parsed.rows[1], table: parsed.rows, observedAtTicks: 639255348502771844n })
  assert.deepEqual(subtree.map(entry => entry.pid), [4243], 'ParentPid 0 does not attach the kernel or unrelated root to the Host')
  assert.equal(compareProcessIdentity({ ...IDENTITY, exe: null }, { ...IDENTITY, exe: null }).owned, false, 'empty executable paths cannot confer ownership')
  assert.equal(buildIdentityQuery(0), '""')
  assert.equal(parseProcessIdentity('0||639255348502771840').status, IDENTITY_STATUS.UNKNOWN)
  let queried = false
  const identity = await captureProcessIdentity(0, { run: async () => { queried = true; return output } })
  assert.equal(identity.status, IDENTITY_STATUS.UNKNOWN)
  assert.equal(queried, false, 'PID 0 must not be queried for direct identity')
  const child = fakeChild({ pid: 0 })
  const outcome = await terminateOwnedChild({ child, identityAtSpawn: identity, capture: async () => { queried = true; return identity } })
  assert.equal(child.killed, false)
  assert.equal(outcome.terminated, false)
  assert.equal(queried, false, 'PID 0 must not enter the direct termination identity query')
  const invalid = parseProcessTable('-1|0|invalid||1\n1.5|0|invalid||1\nbroken')
  assert.equal(invalid.rejected, 3)
})

test('strict table guards count malformed and duplicate rows and invalidate the snapshot', async () => {
  const kernel = '0|0|System Idle Process||639255348502771840'
  const valid = row(4242, 0, 'node.exe', 'C:\\node\\node.exe', '639255348502771841')
  const cases = [
    ['blank PID', '|0|x.exe||1'],
    ['blank parent PID', '7||x.exe||1'],
    ['blank ticks', '7|0|x.exe||'],
    ['negative PID', '-7|0|x.exe||1'],
    ['negative parent PID', '7|-1|x.exe||1'],
    ['negative ticks', '7|0|x.exe||-1'],
    ['noninteger PID', '7.5|0|x.exe||1'],
    ['noninteger parent PID', '7|0.5|x.exe||1'],
    ['nondecimal PID', '0x7|0|x.exe||1'],
    ['noncanonical PID', '07|0|x.exe||1'],
    ['noncanonical parent PID', '7|00|x.exe||1'],
    ['PID above UINT32', '4294967296|0|x.exe||1'],
    ['parent PID above UINT32', '7|4294967296|x.exe||1'],
    ['unsafe PID', '9007199254740993|0|x.exe||1'],
    ['unsafe parent PID', '7|9007199254740993|x.exe||1'],
    ['nondecimal ticks', '7|0|x.exe||0x1'],
    ['signed ticks', '7|0|x.exe||+1'],
    ['blank name', '7|0| ||1'],
    ['extra field', '7|0|x.exe||1|extra'],
    ['truncated row', '7|0|x.exe|'],
    ['duplicate nonzero PID', valid],
    ['duplicate kernel PID', kernel],
  ]
  for (const [label, invalid] of cases) {
    const output = [kernel, valid, invalid].join('\n')
    const parsed = parseProcessTable(output)
    assert.equal(parsed.rejected, 1, label)
    assert.equal(parsed.rows.length, 2, label)
    assert.equal(parsed.truncated, false, label)
    const captured = await captureProcessTable({ run: async () => output })
    assert.equal(captured.available, false, label)
    assert.match(captured.reason, /could not be parsed/u, label)
  }
  const boundary = parseProcessTable('4294967295|4294967295|protected.exe||0')
  assert.equal(boundary.rejected, 0, 'UINT32 boundary and zero creation ticks remain valid table data')
  assert.equal(boundary.rows[0].exe, null, 'an unreadable path is table data, not kill authority')
})

test('the snapshot row count is bounded and the truncation is reported', () => {
  const many = Array.from({ length: MAX_TABLE_ROWS + 500 }, (_, index) => row(index + 1, 1, 'x.exe', 'C:\\x.exe', '1')).join('\r\n')
  const parsed = parseProcessTable(many)
  assert.equal(parsed.rows.length, MAX_TABLE_ROWS)
  assert.equal(parsed.truncated, true, 'a cut-short table cannot support an absence claim')
})

test('the table query stops on error instead of swallowing a denial', () => {
  const query = buildProcessTableQuery()
  assert.match(query, /-ErrorAction Stop/u)
  assert.match(query, /exit 4/u)
  assert.ok(!query.includes('SilentlyContinue'), 'empty output from a fault must not be mistaken for an empty system')
})

test('a query that exits non-zero is unavailable, not an empty system', async () => {
  const snapshot = await captureProcessTable({ run: async () => ({ status: 4, stdout: '', stderr: 'Invalid class' }) })
  assert.equal(snapshot.available, false)
  assert.match(snapshot.reason, /exited 4/u)
  assert.match(snapshot.reason, /Invalid class/u)
})

test('an empty process table is a failed read, never "nothing is alive"', async () => {
  // The query helper is itself a process, so an empty table is a fault. Reading
  // it as an absence would let a broken read pass as a clean machine.
  const snapshot = await captureProcessTable({ run: async () => '' })
  assert.equal(snapshot.available, false)
  assert.match(snapshot.reason, /failed read, not an absence/u)
})

test('a rejected row makes the whole snapshot unavailable', async () => {
  const snapshot = await captureProcessTable({ run: async () => `${row(1, 0, 'System', '', '1')}\nbroken\n` })
  assert.equal(snapshot.available, false)
  assert.match(snapshot.reason, /could not be parsed/u)
})

test('epoch milliseconds convert to .NET ticks the way Windows reports creation times', () => {
  // 2020-01-01T00:00:00Z is 637134336000000000 .NET ticks. Getting this epoch
  // wrong would attribute every process on the machine to the fixture.
  assert.equal(epochMillisToTicks(Date.UTC(2020, 0, 1)), 637134336000000000n)
  assert.equal(epochMillisToTicks(0), 621355968000000000n)
  const now = nowUtcTicks()
  assert.ok(now > epochMillisToTicks(Date.UTC(2000, 0, 1)), 'the current time must be after 2000 in tick terms')
})

test('descendants are attributed by parent id AND creation time', () => {
  const live = parseProcessTable([
    row(1, 0, 'System', '', '600000000000000000'),
    row(4242, 1, 'node.exe', 'C:\\node\\node.exe', HOST_TICKS.toString()),
    // Real children, created after the Host.
    row(4243, 4242, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 1000n).toString()),
    row(4244, 4243, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 2000n).toString()),
    // A process that predates the Host but claims the same parent pid: a recycled
    // pid, or an unrelated process. It is NOT the Host's descendant.
    row(4245, 4242, 'unrelated.exe', 'C:\\other\\unrelated.exe', (HOST_TICKS - 5000n).toString()),
    // A process born after the snapshot was read.
    row(4246, 4242, 'future.exe', 'C:\\other\\future.exe', (HOST_TICKS + 9_000_000n).toString()),
    // Unrelated branch.
    row(5000, 1, 'other.exe', 'C:\\other\\other.exe', (HOST_TICKS + 3000n).toString()),
  ].join('\r\n')).rows
  const observedAtTicks = HOST_TICKS + 3000n
  const found = descendantsOf({ host: { pid: 4242, creationTicks: HOST_TICKS.toString() }, table: live, observedAtTicks })
  assert.deepEqual(found.map(entry => entry.pid), [4243, 4244], 'only the parent chain rooted at the Host, inside its lifetime')
  assert.equal(found[1].depth, 2)
  assert.equal(found[1].exe, 'C:\\node\\node.exe')
  assert.deepEqual(descendantsOf({ host: null, table: live, observedAtTicks }), [])
})

test('a parent-chain cycle cannot make attribution loop forever', () => {
  const live = parseProcessTable([
    row(1, 2, 'a.exe', 'C:\\a.exe', HOST_TICKS.toString()),
    row(2, 1, 'b.exe', 'C:\\b.exe', (HOST_TICKS + 1n).toString()),
  ].join('\r\n')).rows
  const found = descendantsOf({ host: { pid: 1, creationTicks: HOST_TICKS.toString() }, table: live, observedAtTicks: HOST_TICKS + 10n })
  assert.deepEqual(found.map(entry => entry.pid), [2], 'the walk terminates and each pid is visited once')
})

test('a clean exit with nothing left behind is proven empty', () => {
  const live = parseProcessTable([row(4242, 1, 'node.exe', 'C:\\node\\node.exe', HOST_TICKS.toString()),
    row(4243, 4242, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 1000n).toString())].join('\r\n'))
  const subtree = descendantsOf({ host: { pid: 4242, creationTicks: HOST_TICKS.toString() }, table: live.rows, observedAtTicks: HOST_TICKS + 2000n })
  assert.deepEqual(subtree.map(entry => entry.pid), [4243])
  const finalSnapshot = { available: true, rows: parseProcessTable([row(1, 0, 'System', '', '1')].join('\r\n')).rows, reason: '' }
  const result = assessDescendants({
    hosts: [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: subtree, samplePhase: 'post-ready' }], finalSnapshot,
  })
  assert.equal(result.verified, true, result.reason)
  assert.deepEqual(result.survivors, [])
  assert.equal(result.perHost[0].status, 'proven-empty')
  assert.equal(result.perHost[0].samplePhase, 'post-ready')
})

test('a leftover backend or gateway is reported and never terminated', () => {
  const liveRows = parseProcessTable([row(4242, 1, 'node.exe', 'C:\\node\\node.exe', HOST_TICKS.toString()),
    row(4300, 4242, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 1000n).toString())].join('\r\n'))
  const subtree = descendantsOf({ host: { pid: 4242, creationTicks: HOST_TICKS.toString() }, table: liveRows.rows, observedAtTicks: HOST_TICKS + 2000n })
  const finalSnapshot = { available: true, rows: liveRows.rows, reason: '' }
  const result = assessDescendants({
    hosts: [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: subtree, samplePhase: 'post-ready' }], finalSnapshot,
  })
  assert.equal(result.verified, false, 'a surviving descendant must not qualify as clean cleanup')
  assert.equal(result.perHost[0].status, 'left-behind')
  assert.equal(result.survivors.length, 1)
  assert.equal(result.survivors[0].pid, 4300)
  assert.match(result.survivors[0].action, /NOT terminated/u)
})

test('a recycled pid is not the sampled process surviving', () => {
  const sampled = [{ pid: 4300, parentPid: 4242, name: 'node.exe', exe: 'C:\\node\\node.exe', depth: 1, creationTicks: (HOST_TICKS + 1000n).toString() }]
  const afterReuse = parseProcessTable([row(4300, 1, 'other.exe', 'C:\\other\\other.exe', (HOST_TICKS + 99_000n).toString())].join('\r\n'))
  assert.deepEqual(survivingDescendants(sampled, afterReuse.rows), [], 'a different process on the same pid is not the sampled one')
})

test('an orphan below an exited intermediary is invisible to a single post-teardown walk', () => {
  // The structural limit that forced the two-snapshot design: after the middle
  // process exits, its child still names it as parent but it has no row left to
  // walk through, so a walk of the final table finds nothing at depth 2.
  const liveRows = parseProcessTable([
    row(4242, 1, 'node.exe', 'C:\\node\\node.exe', HOST_TICKS.toString()),
    row(4300, 4242, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 1000n).toString()),
    row(4301, 4300, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 2000n).toString()),
  ].join('\r\n'))
  const subtree = descendantsOf({ host: { pid: 4242, creationTicks: HOST_TICKS.toString() }, table: liveRows.rows, observedAtTicks: HOST_TICKS + 3000n })
  assert.deepEqual(subtree.map(entry => entry.pid), [4300, 4301], 'the live sample sees the whole tree')

  const finalRows = parseProcessTable([row(4301, 4300, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 2000n).toString())].join('\r\n'))
  assert.deepEqual(
    descendantsOf({ host: { pid: 4242, creationTicks: HOST_TICKS.toString() }, table: finalRows.rows, observedAtTicks: HOST_TICKS + 9000n }),
    [], 'the final table alone sees nothing: 4300 is gone and 4301 is hidden behind it')
  assert.deepEqual(survivingDescendants(subtree, finalRows.rows).map(entry => entry.pid), [4301],
    'comparing the live sample to the final snapshot still catches it')
})

test('a Host with no live sample is not signed off, however clean the final table looks', () => {
  const finalSnapshot = { available: true, rows: [], reason: '' }
  const result = assessDescendants({
    hosts: [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: null, samplePhase: 'none' }], finalSnapshot,
  })
  assert.equal(result.verified, false)
  assert.equal(result.perHost[0].status, 'not-verified')
  assert.match(result.perHost[0].reason, /exited intermediary/u)
})

test('an unavailable final snapshot is not verified, and says so', () => {
  const finalSnapshot = { available: false, rows: [], observedAtTicks: 1n, reason: 'CIM access denied' }
  const result = assessDescendants({
    hosts: [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: [], samplePhase: 'post-spawn' }], finalSnapshot,
  })
  assert.equal(result.verified, false)
  assert.match(result.reason, /not verified/u)
  assert.match(result.reason, /CIM access denied/u)
  assert.equal(result.perHost[0].status, 'not-verified')
})

test('a snapshot that reads nothing is not a pass either', () => {
  const result = assessDescendants({ hosts: [], finalSnapshot: { available: true, rows: [], reason: '', observedAtTicks: 1n } })
  assert.equal(result.verified, false, 'zero recorded Hosts proves nothing')
  assert.match(result.reason, /no Host was recorded/u)
})

test('the coverage limit is stated, not left to be assumed', () => {
  const result = assessDescendants({
    hosts: [{ label: 'h', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: [], samplePhase: 'post-spawn' }],
    finalSnapshot: { available: true, rows: [], reason: '' },
  })
  assert.equal(result.verified, true)
  assert.ok(result.coverage.some(line => /outside coverage/u.test(line)), result.coverage.join(' | '))
  assert.ok(result.coverage.some(line => /its own entry/u.test(line)), 'a browser must be accounted separately from a Host')
})

test('a Host whose identity was never established cannot be signed off as clean', () => {
  const finalSnapshot = { available: true, rows: [], reason: '', observedAtTicks: HOST_TICKS + 5000n }
  const result = assessDescendants({
    hosts: [{ label: 'default-primary', pid: 4242, identity: { available: false, reason: 'denied' }, exited: true, liveSubtree: [], samplePhase: 'post-spawn' }], finalSnapshot,
  })
  assert.equal(result.verified, false)
  assert.equal(result.perHost[0].status, 'not-verified')
  assert.match(result.perHost[0].reason, /identity was never established/u)
})

test('a Host that never exited is not signed off as clean', () => {
  const finalSnapshot = { available: true, rows: [], reason: '', observedAtTicks: HOST_TICKS + 5000n }
  const result = assessDescendants({
    hosts: [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: false, liveSubtree: [], samplePhase: 'post-spawn' }], finalSnapshot,
  })
  assert.equal(result.verified, false)
  assert.match(result.perHost[0].reason, /never settled/u)
})

test('an empty snapshot is reported unavailable rather than as proof of nothing', async () => {
  const snapshot = await captureProcessTable({ run: async () => '' })
  assert.equal(snapshot.available, false, 'a query returning nothing proves nothing')
  assert.match(snapshot.reason, /failed read, not an absence/u)
})

test('a failing process-table query is reported, not thrown', async () => {
  const snapshot = await captureProcessTable({ run: async () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) } })
  assert.equal(snapshot.available, false)
  assert.match(snapshot.reason, /process table query failed/u)
})

test('the settle loop stops as soon as the tree is clean', async () => {
  const hosts = [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: [], samplePhase: 'post-spawn' }]
  let reads = 0
  const settled = await settleDescendants({
    hosts, attempts: 5, sleep: async () => {},
    capture: async () => {
      reads += 1
      return { available: true, rows: [], reason: '', observedAtTicks: HOST_TICKS + 5000n }
    },
  })
  assert.equal(settled.verified, true)
  assert.equal(reads, 1, 'a clean tree must not cost five extra snapshots')
  assert.equal(settled.attempts, 1)
})

test('the settle loop re-reads a transient survivor and reports how many tries it took', async () => {
  // A console host can outlive its parent for a moment. Waiting for it is not
  // the same as lowering the bar: the survivor must actually go away.
  const hosts = [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, samplePhase: 'post-ready',
    liveSubtree: [{ pid: 4300, parentPid: 4242, name: 'conhost.exe', exe: null, depth: 1, creationTicks: (HOST_TICKS + 1000n).toString() }] }]
  const survivorTable = () => parseProcessTable([row(4300, 4242, 'conhost.exe', '', (HOST_TICKS + 1000n).toString())].join('\r\n')).rows
  let reads = 0
  const settled = await settleDescendants({
    hosts, attempts: 5, sleep: async () => {},
    capture: async () => {
      reads += 1
      return reads < 3
        ? { available: true, rows: survivorTable(), reason: '', observedAtTicks: HOST_TICKS + 5000n }
        : { available: true, rows: [], reason: '', observedAtTicks: HOST_TICKS + 9000n }
    },
  })
  assert.equal(settled.verified, true)
  assert.equal(settled.attempts, 3, 'a run that only passed on the third try must stay visible as such')
  assert.equal(settled.assessment.survivors.length, 0)
})

test('the settle loop gives up after a bounded number of tries and fails', async () => {
  const hosts = [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, samplePhase: 'post-ready',
    liveSubtree: [{ pid: 4300, parentPid: 4242, name: 'node.exe', exe: 'C:\\node\\node.exe', depth: 1, creationTicks: (HOST_TICKS + 1000n).toString() }] }]
  let reads = 0
  const settled = await settleDescendants({
    hosts, attempts: 3, sleep: async () => {},
    capture: async () => {
      reads += 1
      return { available: true, reason: '', observedAtTicks: HOST_TICKS + 5000n,
        rows: parseProcessTable([row(4300, 4242, 'node.exe', 'C:\\node\\node.exe', (HOST_TICKS + 1000n).toString())].join('\r\n')).rows }
    },
  })
  assert.equal(settled.verified, false, 'a survivor that never clears must not pass')
  assert.equal(reads, 3, 'the retry budget is bounded, not open-ended')
  assert.equal(settled.assessment.survivors.length, 1)
  assert.match(settled.assessment.reason, /outlived their Host/u)
})

test('an unreadable table is retried within the bounded budget and never passes', async () => {
  // A transient CIM failure is worth one more attempt; a persistent one is
  // bounded by the same budget as everything else and still fails.
  const hosts = [{ label: 'default-primary', pid: 4242, identity: IDENTITY, exited: true, liveSubtree: [], samplePhase: 'post-spawn' }]
  let reads = 0
  const settled = await settleDescendants({
    hosts, attempts: 4, sleep: async () => {},
    capture: async () => { reads += 1; return { available: false, rows: [], observedAtTicks: 1n, reason: 'CIM denied' } },
  })
  assert.equal(settled.verified, false, 'an unreadable table must never be read as a clean tree')
  assert.equal(reads, 4, 'the retry budget is bounded, not open-ended')
  assert.match(settled.assessment.reason, /CIM denied/u)
})

// ---------------------------------------------------------------------------
// Fresh-directory ACL containment (real icacls, throwaway directory only)
// ---------------------------------------------------------------------------

test('a fresh fixture directory can be hardened to the current user and SYSTEM only', { timeout: 90_000 }, () => {
  if (process.platform !== 'win32') return
  mkdirSync(SCRATCH, { recursive: true })
  const directory = mkdtempSync(join(SCRATCH, 'acl-'))
  try {
    const outcome = assertFixtureDirectoryAcls(directory, { run: defaultAclRunner, account: userInfo().username })
    assert.deepEqual(outcome.errors, [], `ACL hardening did not contain the fixture directory: ${outcome.errors.join('; ')}`)
    assert.ok(outcome.contained, 'the fixture directory must name only the current user and SYSTEM')
    assert.deepEqual(outcome.unexpected, [])
    const read = readFixtureDirectoryAcls(directory, { run: defaultAclRunner })
    assert.deepEqual(read.inherited, [], 'no inherited rule may survive /inheritance:r')
    assert.ok(read.principals.length >= 2, `expected a rule per principal, saw ${read.principals.join(', ')}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('a directory naming an extra principal is reported as not contained', () => {
  // Detection is asserted with an injected listing so no real directory is ever
  // left with a deliberately widened DACL.
  const run = (file) => (file === 'cmd'
    ? { status: 0, stdout: 'fixture-user\r\n', stderr: '' }
    : { status: 0, stdout: [
      'NT AUTHORITY\\SYSTEM|Allow|False',
      'BUILTIN\\Administrators|Allow|False',
      'fixture-user|Allow|False',
    ].join('\r\n'), stderr: '' })
  const audit = readFixtureDirectoryAcls('C:\\fixture\\root', { run })
  assert.deepEqual(audit.principals, ['NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators', 'fixture-user'])
  const outcome = assertFixtureDirectoryAcls('C:\\fixture\\root', { run, account: 'fixture-user' })
  assert.equal(outcome.contained, false)
  assert.ok(outcome.errors.some(error => /unexpected principals/u.test(error)))
})

test('a directory that still inherits its parent ACL is reported as not contained', () => {
  const run = (file) => (file === 'cmd'
    ? { status: 0, stdout: 'fixture-user\r\n', stderr: '' }
    : { status: 0, stdout: 'BUILTIN\\Users|Allow|True\r\nfixture-user|Allow|False', stderr: '' })
  const outcome = assertFixtureDirectoryAcls('C:\\fixture\\root', { run, account: 'fixture-user' })
  assert.equal(outcome.contained, false)
  assert.ok(outcome.errors.some(error => /still inherits access/u.test(error)))
})

test('an ACL command that fails is not reported as contained', () => {
  const run = () => ({ status: 5, stdout: '', stderr: 'Access is denied.' })
  const outcome = assertFixtureDirectoryAcls('C:\\fixture\\root', { run, account: 'fixture-user' })
  assert.equal(outcome.contained, false)
  assert.ok(outcome.errors.some(error => /ACL hardening failed/u.test(error)))
  assert.ok(outcome.errors.some(error => /ACL audit failed/u.test(error)))
})