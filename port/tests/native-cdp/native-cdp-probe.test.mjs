#!/usr/bin/env node
/**
 * native-cdp-probe.test.mjs — PURE unit tests for the provisional probe.
 *
 * No live endpoint, no GUI, no Tauri, no native process, no keyring, no network
 * socket: every dependency is a mock or a fixed expression string evaluated
 * in-process. Run with the qualified pinned interpreter:
 *
 *   & "%USERPROFILE%\AppData\Local\eperm-bin-f71340a9144f466a824fa99f1ff3f9ad\pinnednode.exe" \
 *       --test native-cdp-probe.test.mjs
 *
 * Covered: argument guards (endpoint/port/loopback/UUID/bounds), URL and record
 * redaction, DshError classification, target selection incl. bounded refresh
 * tolerance, CDP request timeout/close/cleanup shapes, the redacted page-side
 * projections against a mocked Tauri bridge, check evaluation, and exit codes.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ALLOWED_COMMANDS,
  CdpConnection,
  CSP_PAGE_EXPRESSION,
  DUMMY_NON_SECRET,
  EXIT,
  LIVE_GUI_PORT,
  NATIVE_BATTERY_EXPRESSION,
  PAGE_FACTS_EXPRESSION,
  ProbeError,
  RESERVED_CREDENTIAL,
  RESTART_EXPRESSION,
  assertCommandWhitelist,
  attach,
  boundedErrorKind,
  canonicalizeOrigin,
  classifyDshError,
  cli,
  deriveReadyGeneration,
  evaluateChecks,
  exitCodeFor,
  findSecretLikeLeaks,
  isCanonicalNonNilUuid,
  isUsablePageTarget,
  matchRefreshedTarget,
  parseArgs,
  parseLoopbackEndpoint,
  runProbe,
  selectTarget,
} from './native-cdp-probe.mjs'

const UUIDS = {
  good: '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
  good2: '573300d2-0000-4000-8000-000000000001',
  nil: '00000000-0000-0000-0000-000000000000',
}

const OWNED = 'http://127.0.0.1:3085'
const CDP = 'http://127.0.0.1:9222'

/** Evaluate a page-side expression string in-process (no CDP, no live page). */
const evaluateExpression = expression => new Function(`return ${expression}`)()

/** Run the battery with a mocked bridge installed on globalThis. */
async function withBridge(invoke, body) {
  const previous = globalThis.__TAURI_INTERNALS__
  globalThis.__TAURI_INTERNALS__ = invoke === null ? undefined : { invoke }
  if (invoke === null) delete globalThis.__TAURI_INTERNALS__
  try {
    return await body()
  } finally {
    if (previous === undefined) delete globalThis.__TAURI_INTERNALS__
    else globalThis.__TAURI_INTERNALS__ = previous
  }
}

// ---------------------------------------------------------------------------
// A. Argument guards
// ---------------------------------------------------------------------------

test('A1: a fully specified argument set parses into exact loopback endpoints', () => {
  const args = parseArgs(['--cdp', CDP, '--gateway-origin', `${OWNED}/`, '--namespace', UUIDS.good])
  assert.equal(args.cdp.origin, CDP)
  assert.equal(args.cdp.port, 9222)
  assert.equal(args.gatewayOrigin.origin, OWNED)
  assert.equal(args.namespace, UUIDS.good)
  assert.equal(args.runtimeRestart, false)
  assert.equal(args.allowNewTargetOnRestart, false)
  assert.equal(args.reportPath, null)
  assert.equal(args.bounds['total-timeout-ms'], 90000)
  assert.ok(Object.isFrozen(args))
})

test('A2: localhost canonicalizes to 127.0.0.1 for exact comparison', () => {
  const endpoint = parseLoopbackEndpoint('http://localhost:3085', { label: '--gateway-origin' })
  assert.equal(endpoint.origin, OWNED)
  assert.equal(canonicalizeOrigin('http://localhost:3085/?token=abcdef'), OWNED)
})

test('A3: port 3080 is refused for both endpoint arguments', () => {
  for (const label of ['--cdp', '--gateway-origin']) {
    assert.throws(
      () => parseLoopbackEndpoint(`http://127.0.0.1:${LIVE_GUI_PORT}`, { label }),
      error => error instanceof ProbeError && error.code === 'arg_invalid' && /3080/u.test(error.message),
    )
  }
})

test('A4: non-loopback hosts are refused, including near-miss loopback', () => {
  for (const host of ['127.0.0.2', '0.0.0.0', 'example.com', '10.0.0.5', '[::2]']) {
    assert.throws(
      () => parseLoopbackEndpoint(`http://${host}:9222`, { label: '--cdp' }),
      error => error instanceof ProbeError && error.code === 'arg_invalid',
      `${host} must be refused`,
    )
  }
})

test('A5: a tokenized query is refused and the refusal never echoes it', () => {
  const secret = 'SUPER-SECRET-LAUNCH-TOKEN-VALUE'
  try {
    parseLoopbackEndpoint(`http://127.0.0.1:3085/?token=${secret}`, { label: '--gateway-origin' })
    assert.fail('a query must be refused')
  } catch (error) {
    assert.equal(error.code, 'arg_invalid')
    assert.ok(!error.message.includes(secret), 'the refusal must not echo the query value')
    assert.ok(!error.message.includes('token='), 'the refusal must not echo the query name')
  }
})

test('A6: credentials, deep paths, and a missing port are refused', () => {
  for (const raw of ['http://user:pw@127.0.0.1:9222', 'http://127.0.0.1:9222/devtools/page/x', 'http://127.0.0.1', 'ws://127.0.0.1:9222', 'file:///tmp/x']) {
    assert.throws(() => parseLoopbackEndpoint(raw, { label: '--cdp' }), ProbeError, `${raw} must be refused`)
  }
})

test('A7: unknown, duplicated, and valueless arguments are refused', () => {
  const base = ['--cdp', CDP, '--gateway-origin', OWNED, '--namespace', UUIDS.good]
  assert.throws(() => parseArgs([...base, '--nope']), /unknown argument/u)
  assert.throws(() => parseArgs([...base, '--cdp', CDP]), /supplied twice/u)
  assert.throws(() => parseArgs(['--cdp', '--gateway-origin', OWNED, '--namespace', UUIDS.good]), /requires a value/u)
  assert.throws(() => parseArgs([...base, 'stray']), /positional/u)
  assert.throws(() => parseArgs([]), /no arguments/u)
  assert.throws(() => parseArgs(['--cdp', CDP, '--gateway-origin', OWNED]), /--namespace is required/u)
})

test('A8: numeric bounds are validated, not clamped', () => {
  const base = ['--cdp', CDP, '--gateway-origin', OWNED, '--namespace', UUIDS.good]
  assert.throws(() => parseArgs([...base, '--command-timeout-ms', '5']), /within \[100, 120000\]/u)
  assert.throws(() => parseArgs([...base, '--command-timeout-ms', 'abc']), /non-negative integer/u)
  assert.throws(() => parseArgs([...base, '--total-timeout-ms', '1000', '--command-timeout-ms', '2000']), /must be >=/u)
  const ok = parseArgs([...base, '--command-timeout-ms', '250', '--http-timeout-ms', '250', '--total-timeout-ms', '5000'])
  assert.equal(ok.bounds['command-timeout-ms'], 250)
})

test('A9: --runtime-restart is explicit and defaults to false', () => {
  const base = ['--cdp', CDP, '--gateway-origin', OWNED, '--namespace', UUIDS.good]
  assert.equal(parseArgs(base).runtimeRestart, false)
  assert.equal(parseArgs([...base, '--runtime-restart']).runtimeRestart, true)
  assert.equal(parseArgs(base).allowNewTargetOnRestart, false)
  assert.equal(parseArgs([...base, '--allow-new-target-on-restart']).allowNewTargetOnRestart, true)
})

test('A10: the namespace must be a canonical non-nil lowercase UUID', () => {
  assert.equal(isCanonicalNonNilUuid(UUIDS.good), true)
  const base = ['--cdp', CDP, '--gateway-origin', OWNED]
  for (const rejected of [
    UUIDS.nil,
    UUIDS.good.toUpperCase(),
    UUIDS.good.replace(/-/gu, ''),
    `{${UUIDS.good}}`,
    `${UUIDS.good} `,
    UUIDS.good.slice(0, -1),
    `${UUIDS.good}0`,
    UUIDS.good.replace('a', 'g'),
    '',
  ]) {
    assert.equal(isCanonicalNonNilUuid(rejected), false, `${rejected} must be rejected`)
    assert.throws(() => parseArgs([...base, '--namespace', rejected]), ProbeError)
  }
  assert.equal(parseArgs([...base, '--namespace', UUIDS.good2]).namespace, UUIDS.good2)
})

test('A11: --help exits clean and bad arguments refuse with exit 2', async () => {
  assert.equal(await cli(['--help']), EXIT.PASS)
  assert.equal(await cli([]), EXIT.REFUSED)
  assert.equal(await cli(['--cdp', `http://127.0.0.1:${LIVE_GUI_PORT}`, '--gateway-origin', OWNED, '--namespace', UUIDS.good]), EXIT.REFUSED)
})

// ---------------------------------------------------------------------------
// B. Redaction
// ---------------------------------------------------------------------------

test('B1: canonicalizeOrigin strips path, query and fragment', () => {
  assert.equal(canonicalizeOrigin('http://127.0.0.1:3085/'), OWNED)
  assert.equal(canonicalizeOrigin('http://127.0.0.1:3085/devtools/page/ABC?token=zzz#frag'), OWNED)
  assert.equal(canonicalizeOrigin('http://[::1]:9222/devtools/page/ABC'), 'http://[::1]:9222')
  assert.equal(canonicalizeOrigin('https://127.0.0.1:443/x'), 'https://127.0.0.1:443')
  assert.equal(canonicalizeOrigin('devtools://devtools/bundled/x'), null)
  assert.equal(canonicalizeOrigin('not a url'), null)
  assert.equal(canonicalizeOrigin(undefined), null)
})

test('B2: findSecretLikeLeaks flags secret-shaped keys and values with paths', () => {
  assert.deepEqual(findSecretLikeLeaks({ a: 1, b: 'plain' }), [])
  assert.deepEqual(findSecretLikeLeaks({ url: 'http://127.0.0.1:9/x' }), ['$.url'])
  assert.deepEqual(findSecretLikeLeaks({ nested: { webSocketDebuggerUrl: 'ws://x' } }), ['$.nested.webSocketDebuggerUrl'])
  // Any key naming an expression is refused, because expression contents are never emitted.
  assert.deepEqual(findSecretLikeLeaks({ expressions: ['a'] }), ['$.expressions'])
  assert.deepEqual(findSecretLikeLeaks({ j: 'img', ids: ['a'] }), [])
  assert.deepEqual(findSecretLikeLeaks({ leak: 'probe?token=abc' }), ['$.leak'])
  assert.deepEqual(findSecretLikeLeaks({ leak: 'dsh-auth-v1.abc' }), ['$.leak'])
  assert.deepEqual(findSecretLikeLeaks({ leak: 'Ab3'.repeat(20) }), ['$.leak'])
  // Word-like, digit-free long identifiers are NOT secret-shaped: check ids such
  // as this one must survive the gate or no real record could ever be emitted.
  assert.deepEqual(findSecretLikeLeaks({ id: 'csp.direct_unauthenticated_refused_without_policy' }), [])
  assert.deepEqual(findSecretLikeLeaks({ id: 'runtime_restart.new_ready_generation_is_old_plus_one' }), [])
  const digest = 'fdddbf4581e046b8102815d56208d6a248950bb554570b81519a8a5dacfee95d'
  assert.deepEqual(findSecretLikeLeaks({ digest }), ['$.digest'])
  assert.deepEqual(findSecretLikeLeaks({ digest }, { allowedStrings: [digest] }), [])
})

test('B3: a probe-shaped record with no secrets passes the leak gate', () => {
  const record = {
    record: 'native-cdp-probe',
    nativeAcceptance: false,
    target: { cdpPort: 9222, gatewayOrigin: OWNED, targetId: 'a'.repeat(32) },
    ownership: { namespaceUuid: UUIDS.good, namespaceProvesProcessOwnership: false },
    csp: { requiredDirectives: ['default-src'], direct: { status: 401, cspPresent: false } },
    checks: [{ id: 'bridge.tauri_invoke_present', ok: true, detail: 'invoke is a function' }],
  }
  assert.deepEqual(findSecretLikeLeaks(record), [])
})

// ---------------------------------------------------------------------------
// C. Command error handling
// ---------------------------------------------------------------------------

test('C1: credential_reserved classifies with the code and no message text', () => {
  const rejection = {
    kind: 'other',
    detail: {
      code: 'credential_reserved',
      message: 'That credential identity belongs to the desktop shell and cannot be written or deleted through the renderer bridge.',
    },
  }
  const classified = classifyDshError(rejection)
  assert.deepEqual(classified, { rejected: true, kind: 'other', codePresent: true, code: 'credential_reserved', detailShape: 'object' })
  assert.ok(!JSON.stringify(classified).includes('belongs to'), 'no message text may be carried')
})

test('C2: other rejection shapes classify safely and carry no values', () => {
  assert.deepEqual(classifyDshError({ kind: 'not_found', detail: { entity: 'setting', id: 'x.y' } }), {
    rejected: true, kind: 'not_found', codePresent: false, code: null, detailShape: 'object',
  })
  assert.deepEqual(classifyDshError({ kind: 'credential_store', detail: { operation: 'read', message: 'boom' } }), {
    rejected: true, kind: 'credential_store', codePresent: false, code: null, detailShape: 'object',
  })
  assert.deepEqual(classifyDshError(new Error('SECRET-VALUE')), {
    rejected: true, kind: null, codePresent: false, code: null, detailShape: 'message',
  })
  assert.deepEqual(classifyDshError('opaque'), { rejected: true, kind: null, codePresent: false, code: null, detailShape: 'string' })
  assert.deepEqual(classifyDshError(undefined), { rejected: true, kind: null, codePresent: false, code: null, detailShape: 'none' })
  assert.ok(!JSON.stringify(classifyDshError(new Error('SECRET-VALUE'))).includes('SECRET-VALUE'))
})

test('C3: boundedErrorKind never returns free text', () => {
  assert.equal(boundedErrorKind(new ProbeError('cdp_command_timeout', 'x')), 'cdp_command_timeout')
  assert.equal(boundedErrorKind(new TypeError('page said SUPERSECRET')), 'TypeError')
  assert.equal(boundedErrorKind('raw string'), 'error')
  assert.equal(boundedErrorKind(undefined), 'error')
})

test('C4: the command whitelist is enforced for the battery and the restart flag', () => {
  assert.equal(assertCommandWhitelist([...ALLOWED_COMMANDS]).ok, true)
  const noRestart = assertCommandWhitelist(['runtime_restart'])
  assert.equal(noRestart.ok, false)
  assert.deepEqual(noRestart.offenders, ['runtime_restart'])
  assert.equal(assertCommandWhitelist(['runtime_restart'], { runtimeRestart: true }).ok, true)
  const quit = assertCommandWhitelist(['shell_quit_request'])
  assert.equal(quit.ok, false)
  assert.deepEqual(quit.forbidden, ['shell_quit_request'])
})

// ---------------------------------------------------------------------------
// D. Target selection and bounded refresh tolerance
// ---------------------------------------------------------------------------

const page = (id, url, extra = {}) => ({
  id, type: 'page', url, webSocketDebuggerUrl: `ws://127.0.0.1:9222/devtools/page/${id}`, ...extra,
})

test('D1: exactly one exact-origin page target is required', () => {
  const unique = [page('AAA', `${OWNED}/?token=t`), page('BBB', 'http://127.0.0.1:3999/'), page('CCC', 'devtools://x')]
  const ok = selectTarget(unique, OWNED)
  assert.equal(ok.ok, true)
  assert.equal(ok.target.id, 'AAA')
  assert.equal(ok.canonicalOrigin, OWNED)

  const none = selectTarget([page('BBB', 'http://127.0.0.1:3999/')], OWNED)
  assert.equal(none.ok, false)
  assert.equal(none.code, 'no_target_with_owned_origin')

  const many = selectTarget([page('AAA', OWNED), page('BBB', `${OWNED}/index.html`)], OWNED)
  assert.equal(many.ok, false)
  assert.equal(many.code, 'ambiguous_target_with_owned_origin')
  assert.equal(many.candidates, 2)
})

test('D2: unusable targets never match, including a live-GUI websocket', () => {
  assert.equal(isUsablePageTarget(page('AAA', OWNED)), true)
  assert.equal(isUsablePageTarget({ ...page('AAA', OWNED), type: 'service_worker' }), false)
  assert.equal(isUsablePageTarget({ ...page('AAA', OWNED), webSocketDebuggerUrl: '' }), false)
  assert.equal(isUsablePageTarget({ ...page('AAA', OWNED), webSocketDebuggerUrl: 'ws://10.0.0.5:9222/x' }), false)
  assert.equal(isUsablePageTarget({ ...page('AAA', OWNED), webSocketDebuggerUrl: `ws://127.0.0.1:${LIVE_GUI_PORT}/x` }), false)
  assert.equal(selectTarget([{ ...page('AAA', OWNED), webSocketDebuggerUrl: `ws://127.0.0.1:${LIVE_GUI_PORT}/x` }], OWNED).ok, false)
})

test('D3: a same-id URL refresh is tolerated only to another loopback non-3080 origin', () => {
  const refreshed = matchRefreshedTarget([page('AAA', 'http://127.0.0.1:3099/?token=zzz')], 'AAA', OWNED)
  assert.equal(refreshed.ok, true)
  assert.equal(refreshed.refreshed, true)
  assert.equal(refreshed.mode, 'same-id')
  assert.equal(refreshed.canonicalOrigin, 'http://127.0.0.1:3099')

  const unchanged = matchRefreshedTarget([page('AAA', `${OWNED}/`)], 'AAA', OWNED)
  assert.equal(unchanged.ok, true)
  assert.equal(unchanged.refreshed, false)

  assert.equal(matchRefreshedTarget([page('AAA', `http://127.0.0.1:${LIVE_GUI_PORT}/`)], 'AAA', OWNED).code, 'refresh_live_gui')
  assert.equal(matchRefreshedTarget([page('AAA', 'http://10.0.0.5:3099/')], 'AAA', OWNED).code, 'refresh_non_loopback')
  assert.equal(matchRefreshedTarget([page('BBB', 'http://127.0.0.1:3099/')], 'AAA', OWNED).code, 'refresh_target_missing')
})

test('D4: a brand-new target id requires the explicit opt-in', () => {
  const targets = [page('BBB', 'http://127.0.0.1:3099/')]
  assert.equal(matchRefreshedTarget(targets, 'AAA', OWNED).ok, false)
  const allowed = matchRefreshedTarget(targets, 'AAA', OWNED, { allowNewTargetOnRestart: true, previousIds: ['AAA'] })
  assert.equal(allowed.ok, true)
  assert.equal(allowed.mode, 'new-id')
  const ambiguous = matchRefreshedTarget(
    [page('BBB', 'http://127.0.0.1:3099/'), page('CCC', 'http://127.0.0.1:3098/')],
    'AAA', OWNED, { allowNewTargetOnRestart: true, previousIds: ['AAA'] },
  )
  assert.equal(ambiguous.ok, false)
  assert.equal(ambiguous.code, 'refresh_new_id_ambiguous')
})

// ---------------------------------------------------------------------------
// E. CDP request timeout, close, and cleanup shapes
// ---------------------------------------------------------------------------

class FakeSocket {
  static instances = []
  static autoOpen = true
  static onSend = null

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    this.listeners = new Map()
    FakeSocket.instances.push(this)
    if (FakeSocket.autoOpen) queueMicrotask(() => this.emit('open', {}))
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? []
    list.push(handler)
    this.listeners.set(type, list)
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  send(data) {
    const parsed = JSON.parse(data)
    this.sent.push(parsed)
    if (FakeSocket.onSend) FakeSocket.onSend(this, parsed)
  }

  reply(payload) {
    this.emit('message', { data: JSON.stringify(payload) })
  }

  close() {
    this.readyState = 3
    queueMicrotask(() => this.emit('close', {}))
  }
}

function resetFake() {
  FakeSocket.instances = []
  FakeSocket.autoOpen = true
  FakeSocket.onSend = null
}

async function openFake(options = {}) {
  resetFake()
  return CdpConnection.open('ws://127.0.0.1:9222/devtools/page/AAA', {
    webSocketImpl: FakeSocket, commandTimeoutMs: 60, connectTimeoutMs: 60, ...options,
  })
}

test('E1: a command that never answers rejects on its own timeout and clears the slot', async () => {
  const connection = await openFake()
  FakeSocket.onSend = () => { /* never answer */ }
  const started = Date.now()
  await assert.rejects(
    () => connection.send('Runtime.evaluate', { expression: 'fixed' }),
    error => error instanceof ProbeError && error.code === 'cdp_command_timeout',
  )
  assert.ok(Date.now() - started >= 50)
  assert.equal(connection.pendingCount, 0)
  await connection.close()
})

test('E2: a matched reply resolves and leaves no pending slot', async () => {
  const connection = await openFake()
  FakeSocket.onSend = (socket, message) => socket.reply({ id: message.id, result: { result: { value: { ok: true } } } })
  assert.deepEqual(await connection.evaluate('fixed expression'), { ok: true })
  assert.equal(connection.pendingCount, 0)
  await connection.close()
})

test('E3: close rejects in-flight work, is idempotent, and empties the map', async () => {
  const connection = await openFake()
  FakeSocket.onSend = () => { /* never answer */ }
  const inFlight = connection.send('Runtime.evaluate', { expression: 'fixed' })
  const closing = connection.close()
  await assert.rejects(() => inFlight, error => error.code === 'cdp_closed')
  await closing
  assert.equal(connection.pendingCount, 0)
  await connection.close()
  await connection.close()
  await assert.rejects(() => connection.send('Runtime.evaluate', {}), error => error.code === 'cdp_closed')
})

test('E4: a remote close rejects pending commands', async () => {
  const connection = await openFake()
  FakeSocket.onSend = () => { /* never answer */ }
  const inFlight = connection.send('Runtime.evaluate', { expression: 'fixed' })
  FakeSocket.instances[0].emit('close', {})
  await assert.rejects(() => inFlight, error => error.code === 'cdp_closed')
  assert.equal(connection.pendingCount, 0)
})

test('E5: the connect handshake is bounded and reports a stable code', async () => {
  resetFake()
  FakeSocket.autoOpen = false
  const started = Date.now()
  await assert.rejects(
    () => CdpConnection.open('ws://127.0.0.1:9222/devtools/page/AAA', { webSocketImpl: FakeSocket, connectTimeoutMs: 40 }),
    error => error instanceof ProbeError && error.code === 'cdp_connect_timeout',
  )
  assert.ok(Date.now() - started >= 30)
})

test('E6: evaluate refuses a non-object result and never reads exception text', async () => {
  const connection = await openFake()
  FakeSocket.onSend = (socket, message) => socket.reply({ id: message.id, result: { result: { type: 'undefined' } } })
  await assert.rejects(() => connection.evaluate('fixed'), error => error.code === 'cdp_evaluate_shape')

  FakeSocket.onSend = (socket, message) => socket.reply({
    id: message.id,
    result: { exceptionDetails: { exception: { className: 'TypeError', description: 'PAGE-TEXT-SHOULD-NOT-APPEAR' } } },
  })
  await assert.rejects(
    () => connection.evaluate('fixed'),
    error => error.code === 'cdp_evaluate_threw' && !error.message.includes('PAGE-TEXT-SHOULD-NOT-APPEAR'),
  )
  await connection.close()
})

// ---------------------------------------------------------------------------
// F. Page-side projections against a mocked bridge
// ---------------------------------------------------------------------------

const TOKENIZED_RUNTIME_URL = 'http://127.0.0.1:3999/?token=RUNTIME-SECRET-TOKEN'

const happyInvoke = async (command, payload) => {
  switch (command) {
    case 'shell_app_info':
      return {
        productName: 'DeepSeek Harness', version: '0.0.0', protocolGeneration: 4, runtimeVersion: '0.0.0',
        platform: 'win32', arch: 'x64', locale: 'en', credentialRef: { provider: 'official', reference: 'default' },
      }
    case 'runtime_status':
      return { state: 'ready', url: TOKENIZED_RUNTIME_URL, startedAt: '2026-10-10T06:45:00.000Z', lastError: null }
    case 'update_status':
      return { phase: 'idle' }
    case 'credential_list':
      return [{ provider: 'openai', reference: 'default', hasSecret: true, updatedAt: '2026-10-10T06:00:00.000Z' }]
    case 'credential_has':
      if (payload.provider === RESERVED_CREDENTIAL.provider && payload.reference === RESERVED_CREDENTIAL.reference) {
        return { present: false }
      }
      return { present: true }
    case 'credential_store':
    case 'credential_delete':
      if (payload.provider === RESERVED_CREDENTIAL.provider && payload.reference === RESERVED_CREDENTIAL.reference) {
        throw {
          kind: 'other',
          detail: {
            code: 'credential_reserved',
            message: 'That credential identity belongs to the desktop shell and cannot be written or deleted through the renderer bridge.',
          },
        }
      }
      throw new Error('the probe must only mutate the reserved identity')
    default:
      throw new Error(`unexpected command ${command}`)
  }
}

const happyCsp = {
  direct: { status: 401, cspPresent: false, directiveCount: 0 },
  page: { status: 200, cspPresent: true, directives: ['default-src', 'script-src', 'connect-src', 'base-uri', 'object-src', 'form-action', 'frame-ancestors'] },
}

function happyCheckInput(battery) {
  return {
    pageFacts: { invokeIsFunction: true },
    battery,
    target: { selectedByExactOrigin: true },
    documentOriginMatches: true,
    csp: happyCsp,
    restart: { attempted: false },
    commandWhitelist: assertCommandWhitelist(battery.commandsInvoked),
  }
}

test('F1: the battery projects only redacted facts and never a URL, secret, or metadata', async () => {
  const battery = await withBridge(happyInvoke, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  assert.equal(battery.bridge, true)
  assert.deepEqual(battery.commandsInvoked, [
    'shell_app_info', 'runtime_status', 'update_status', 'credential_list', 'credential_has', 'credential_store', 'credential_delete',
  ])
  assert.equal(battery.shellAppInfo.protocolGeneration, 4)
  assert.equal(battery.shellAppInfo.versionNonEmpty, true)
  assert.equal(battery.runtimeStatus.state, 'ready')
  assert.equal(battery.runtimeStatus.lastErrorPresent, false)
  assert.equal(battery.runtimeStatus.urlOriginIsLoopback, true)
  assert.equal(battery.runtimeStatus.urlPresent, true)
  assert.equal(typeof battery.runtimeStatus.startedAtDigest, 'string')
  assert.equal(battery.updateStatus.phaseKnown, true)
  assert.equal(battery.credentialList.reservedPairPresent, false)
  assert.equal(battery.credentialList.rowCount, 1)
  assert.equal(battery.credentialHasReserved.present, false)
  assert.equal(battery.credentialStoreReserved.code, 'credential_reserved')
  assert.equal(battery.credentialDeleteReserved.code, 'credential_reserved')

  const serialized = JSON.stringify(battery)
  for (const forbidden of [
    TOKENIZED_RUNTIME_URL, 'RUNTIME-SECRET-TOKEN', 'token=',
    RESERVED_CREDENTIAL.provider, RESERVED_CREDENTIAL.reference,
    DUMMY_NON_SECRET, 'openai', 'updatedAt', '2026-10-10T06:00:00.000Z', 'belongs to',
  ]) {
    assert.ok(!serialized.includes(forbidden), `the projection must not carry ${forbidden}`)
  }
  assert.equal(serialized.includes('"url"'), false)
})

test('F2: a missing bridge invokes no command and fails closed', async () => {
  const facts = await withBridge(null, () => evaluateExpression(PAGE_FACTS_EXPRESSION))
  assert.equal(facts.invokeIsFunction, false)
  assert.equal(facts.documentOrigin, null)
  const battery = await withBridge(null, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  assert.equal(battery.bridge, false)
  assert.deepEqual(battery.commandsInvoked, [])
  const checks = evaluateChecks({
    pageFacts: { invokeIsFunction: false },
    battery,
    target: { selectedByExactOrigin: true },
    documentOriginMatches: false,
    csp: { direct: {}, page: {} },
    restart: { attempted: false },
    commandWhitelist: assertCommandWhitelist([]),
  })
  assert.equal(checks.find(check => check.id === 'bridge.tauri_invoke_present').ok, false)
  assert.equal(exitCodeFor({ bridgeMissing: true, checks }), EXIT.BRIDGE_MISSING)
})

test('F3: the happy battery passes every check except the ones needing a live target', async () => {
  const battery = await withBridge(happyInvoke, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  const checks = evaluateChecks(happyCheckInput(battery))
  const failed = checks.filter(check => check.ok !== true)
  assert.deepEqual(failed, [], `unexpected failures: ${JSON.stringify(failed)}`)
  assert.equal(exitCodeFor({ checks }), EXIT.PASS)
  assert.ok(checks.length >= 19)
})

test('F4: a reserved row in credential_list fails the hiding check', async () => {
  const leaky = async (command, payload) => {
    if (command === 'credential_list') {
      return [{ provider: RESERVED_CREDENTIAL.provider, reference: RESERVED_CREDENTIAL.reference, hasSecret: true, updatedAt: 'x' }]
    }
    return happyInvoke(command, payload)
  }
  const battery = await withBridge(leaky, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  assert.equal(battery.credentialList.reservedPairPresent, true)
  const checks = evaluateChecks(happyCheckInput(battery))
  assert.equal(checks.find(check => check.id === 'credential_list.hides_reserved_identity').ok, false)
  assert.equal(exitCodeFor({ checks }), EXIT.FAILED_CHECK)
})

test('F5: a reserved store that resolves, a wrong protocol, and a non-ready runtime each fail', async () => {
  const storeResolves = async (command, payload) => (command === 'credential_store' ? undefined : happyInvoke(command, payload))
  const stored = await withBridge(storeResolves, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  assert.equal(stored.credentialStoreReserved.rejected, false)
  assert.equal(evaluateChecks(happyCheckInput(stored)).find(check => check.id === 'credential_store.reserved_rejected').ok, false)

  const wrongProtocol = async (command, payload) => (command === 'shell_app_info'
    ? { version: '1', protocolGeneration: 3, runtimeVersion: '1', platform: 'win32', arch: 'x64', credentialRef: null }
    : happyInvoke(command, payload))
  const protocol = await withBridge(wrongProtocol, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  assert.equal(evaluateChecks(happyCheckInput(protocol)).find(check => check.id === 'shell_app_info.protocol_generation_4').ok, false)

  const notReady = async (command, payload) => (command === 'runtime_status'
    ? { state: 'failed', url: null, startedAt: null, lastError: 'host died' }
    : happyInvoke(command, payload))
  const runtime = await withBridge(notReady, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  const runtimeChecks = evaluateChecks(happyCheckInput(runtime))
  assert.equal(runtimeChecks.find(check => check.id === 'runtime_status.state_ready').ok, false)
  assert.equal(runtimeChecks.find(check => check.id === 'runtime_status.no_last_error').ok, false)
  assert.equal(runtime.lastErrorPresent, undefined)
  assert.ok(!JSON.stringify(runtime).includes('host died'))
})

test('F6: the CSP page expression reads only status and directive names', async () => {
  const policy = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; connect-src 'self' ipc: http://ipc.localhost; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'"
  const previousFetch = globalThis.fetch
  globalThis.fetch = async () => ({ status: 200, headers: { get: name => (name === 'content-security-policy' ? policy : null) }, body: null })
  try {
    const observed = await evaluateExpression(CSP_PAGE_EXPRESSION)
    assert.equal(observed.resolved, true)
    assert.equal(observed.status, 200)
    assert.equal(observed.cspPresent, true)
    for (const name of ['default-src', 'script-src', 'connect-src', 'base-uri', 'object-src', 'form-action', 'frame-ancestors']) {
      assert.ok(observed.directives.includes(name), `${name} must be observed`)
    }
    assert.ok(!JSON.stringify(observed).includes('unsafe-inline'))
  } finally {
    globalThis.fetch = previousFetch
  }

  globalThis.fetch = async () => ({ status: 401, headers: { get: () => null }, body: null })
  try {
    const refused = await evaluateExpression(CSP_PAGE_EXPRESSION)
    assert.equal(refused.status, 401)
    assert.equal(refused.cspPresent, false)
    assert.deepEqual(refused.directives, [])
  } finally {
    globalThis.fetch = previousFetch
  }
})

test('F7: CSP checks require the authenticated header and the unauthenticated refusal', () => {
  const base = happyCheckInput({ commandsInvoked: [], bridge: true })
  const noHeader = evaluateChecks({ ...base, csp: { direct: { status: 401, cspPresent: false }, page: { status: 200, cspPresent: false, directives: [] } } })
  assert.equal(noHeader.find(check => check.id === 'csp.served_header_present').ok, false)
  const partial = evaluateChecks({ ...base, csp: { direct: { status: 401, cspPresent: false }, page: { status: 200, cspPresent: true, directives: ['default-src'] } } })
  assert.equal(partial.find(check => check.id === 'csp.served_header_carries_required_directives').ok, false)
  const served = evaluateChecks({ ...base, csp: { direct: { status: 200, cspPresent: true }, page: happyCsp.page } })
  assert.equal(served.find(check => check.id === 'csp.direct_unauthenticated_refused_without_policy').ok, false)
})

test('F8: every emitted check id and detail survives the leak gate in both modes', async () => {
  const battery = await withBridge(happyInvoke, () => evaluateExpression(NATIVE_BATTERY_EXPRESSION))
  const checks = evaluateChecks(happyCheckInput(battery))
  const restartChecks = evaluateChecks({
    ...happyCheckInput(battery),
    restart: {
      attempted: true, invokedCount: 1, baselineDigestPresent: true, baselineGeneration: 1,
      observedGeneration: 2, generationAdvancedByOne: true, newReadyLastErrorPresent: false,
    },
  })
  assert.deepEqual(findSecretLikeLeaks({ checks, restartChecks, failedChecks: checks.map(check => check.id) }), [])
})

// ---------------------------------------------------------------------------
// G. Restart generation and exit-code ordering
// ---------------------------------------------------------------------------

test('G1: readiness epochs are counted by distinct startedAt digests', () => {
  assert.deepEqual(deriveReadyGeneration([]), { readyGenerations: 0, currentDigest: null, digests: [] })
  assert.deepEqual(
    deriveReadyGeneration([
      { state: 'ready', startedAtDigest: 'aaaa1111' },
      { state: 'ready', startedAtDigest: 'aaaa1111' },
      { state: 'starting', startedAtDigest: null },
      { state: 'ready', startedAtDigest: 'bbbb2222' },
    ]),
    { readyGenerations: 2, currentDigest: 'bbbb2222', digests: ['aaaa1111', 'bbbb2222'] },
  )
})

test('G2: the restart checks require one invocation, a known baseline, old+1, and no error', () => {
  const base = happyCheckInput({ commandsInvoked: [], bridge: true })
  const good = evaluateChecks({
    ...base,
    restart: { attempted: true, invokedCount: 1, baselineDigestPresent: true, baselineGeneration: 1, observedGeneration: 2, generationAdvancedByOne: true, newReadyLastErrorPresent: false },
  })
  assert.deepEqual(good.filter(check => check.id.startsWith('runtime_restart.') && !check.ok), [])

  const bad = evaluateChecks({
    ...base,
    restart: { attempted: true, invokedCount: 2, baselineDigestPresent: false, baselineGeneration: 0, observedGeneration: 0, generationAdvancedByOne: false, newReadyLastErrorPresent: true },
  })
  assert.deepEqual(
    bad.filter(check => check.id.startsWith('runtime_restart.')).map(check => check.id),
    ['runtime_restart.invoked_once', 'runtime_restart.baseline_generation_known', 'runtime_restart.new_ready_generation_is_old_plus_one', 'runtime_restart.new_ready_has_no_last_error'],
  )
  assert.equal(bad.filter(check => check.id.startsWith('runtime_restart.')).every(check => check.ok === false), true)
})

test('G3: exit codes are ordered bridge > target > internal > checks', () => {
  assert.equal(exitCodeFor({ bridgeMissing: true, targetFailed: true, internalError: true, checks: [{ ok: false }] }), EXIT.BRIDGE_MISSING)
  assert.equal(exitCodeFor({ targetFailed: true, internalError: true, checks: [{ ok: false }] }), EXIT.TARGET_SELECTION)
  assert.equal(exitCodeFor({ internalError: true, checks: [{ ok: false }] }), EXIT.INTERNAL)
  assert.equal(exitCodeFor({ checks: [{ ok: false }] }), EXIT.FAILED_CHECK)
  assert.equal(exitCodeFor({ checks: [{ ok: true }, { ok: true }] }), EXIT.PASS)
})

test('G4: attach picks the exact-origin target, tolerates one same-id refresh, and never the live GUI', async () => {
  resetFake()
  const previousFetch = globalThis.fetch
  let phase = 'initial'
  const targetsFor = () => {
    if (phase === 'refreshed') {
      return [{ id: 'AAA', type: 'page', url: 'http://127.0.0.1:3099/?token=x', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/AAA' }]
    }
    if (phase === 'live') {
      return [{ id: 'AAA', type: 'page', url: `http://127.0.0.1:${LIVE_GUI_PORT}/`, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/AAA' }]
    }
    return [
      { id: 'AAA', type: 'page', url: `${OWNED}/?token=x`, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/AAA' },
      { id: 'BBB', type: 'page', url: `http://127.0.0.1:${LIVE_GUI_PORT}/`, webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/BBB' },
    ]
  }
  globalThis.fetch = async url => {
    assert.ok(String(url).endsWith('/json/list'), 'only the bounded target-list request is made')
    return { ok: true, status: 200, json: async () => targetsFor() }
  }
  const options = {
    cdpOrigin: CDP,
    canonicalOwnedOrigin: OWNED,
    httpTimeoutMs: 200,
    attachWaitMs: 150,
    refreshIntervalMs: 10,
    commandTimeoutMs: 60,
    webSocketImpl: FakeSocket,
  }
  try {
    const first = await attach(options)
    assert.equal(first.targetId, 'AAA')
    assert.equal(first.selectedByExactOrigin, true)
    assert.equal(first.refreshed, false)
    await first.connection.close()

    phase = 'refreshed'
    const refreshed = await attach({ ...options, previousTargetId: 'AAA', previousIds: first.targetIds })
    assert.equal(refreshed.refreshed, true)
    assert.equal(refreshed.canonicalOrigin, 'http://127.0.0.1:3099')
    assert.equal(refreshed.selectedByExactOrigin, false)
    await refreshed.connection.close()

    phase = 'live'
    await assert.rejects(
      () => attach({ ...options, previousTargetId: 'AAA' }),
      error => error instanceof ProbeError && error.code === 'target_selection_failed',
    )
  } finally {
    globalThis.fetch = previousFetch
  }
})

// ---------------------------------------------------------------------------
// H. Full runProbe against a mocked CDP endpoint and a fake socket
// ---------------------------------------------------------------------------

/**
 * Stub the three HTTP surfaces runProbe uses (browser version, target list, and
 * the tokenless direct CSP fetch) with no network at all, and answer CDP
 * evaluations by computing the fixed expression in-process against a mocked
 * Tauri bridge installed on globalThis.
 */
const MOCK_SHELL_CSP = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval' blob:; style-src 'self' 'unsafe-inline' blob:; img-src 'self' data: blob:; font-src 'self' data:; media-src 'self' data: blob:; connect-src 'self' ipc: http://ipc.localhost; frame-src 'self' blob: data: about:; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; object-src 'none'; form-action 'none'; frame-ancestors 'none'"

async function withMockedEndpoint(invoke, restartEnabled, body) {
  const previousFetch = globalThis.fetch
  const previousInternals = globalThis.__TAURI_INTERNALS__
  const previousLocation = globalThis.location
  const previousWrite = process.stderr.write
  process.stderr.write = () => true
  globalThis.__TAURI_INTERNALS__ = { invoke }
  // A document has a location origin (never its href, which carries the token).
  globalThis.location = { origin: OWNED }
  let phase = 'initial'
  globalThis.fetch = async url => {
    const text = String(url)
    if (text.endsWith('/json/version')) {
      return { ok: true, status: 200, json: async () => ({ Browser: 'Edg/120.0.0.0' }) }
    }
    if (text.endsWith('/json/list')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{
          id: 'AAA',
          type: 'page',
          url: `${OWNED}/?token=DOCUMENT-TOKEN-MUST-NOT-LEAK`,
          webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/AAA',
        }],
      }
    }
    if (text === `${OWNED}/`) {
      // Tokenless, cookie-less direct fetch: the gateway refuses the index.
      return { status: 401, ok: false, headers: { get: () => null }, body: null }
    }
    if (text === '/') {
      // Same-origin fetch from the owned document: authenticated by the browser's
      // own cookie, and only the directive NAMES are read out.
      return { status: 200, ok: true, headers: { get: name => (name === 'content-security-policy' ? MOCK_SHELL_CSP : null) }, body: null }
    }
    throw new Error(`unexpected fetch in test: ${text}`)
  }
  FakeSocket.instances = []
  FakeSocket.autoOpen = true
  FakeSocket.onSend = (socket, message) => {
    if (!restartEnabled && message.params?.expression === RESTART_EXPRESSION) {
      socket.reply({ id: message.id, result: { exceptionDetails: { exception: { className: 'Error' } } } })
      return
    }
    Promise.resolve()
      .then(() => new Function(`return ${message.params.expression}`)())
      .then(value => socket.reply({ id: message.id, result: { result: { value } } }))
      .catch(() => socket.reply({ id: message.id, result: { exceptionDetails: { exception: { className: 'Error' } } } }))
  }
  try {
    const args = parseArgs([
      '--cdp', CDP,
      '--gateway-origin', OWNED,
      '--namespace', UUIDS.good,
      '--http-timeout-ms', '1000',
      '--command-timeout-ms', '2000',
      '--total-timeout-ms', '10000',
      '--attach-wait-ms', '200',
      '--refresh-interval-ms', '10',
      '--restart-timeout-ms', '2000',
      ...(restartEnabled ? ['--runtime-restart'] : []),
    ])
    return await body(args)
  } finally {
    globalThis.fetch = previousFetch
    if (previousInternals === undefined) delete globalThis.__TAURI_INTERNALS__
    else globalThis.__TAURI_INTERNALS__ = previousInternals
    if (previousLocation === undefined) delete globalThis.location
    else globalThis.location = previousLocation
    process.stderr.write = previousWrite
    FakeSocket.onSend = null
    void phase
  }
}

test('H1: a full mocked run passes every check, emits one redacted record, and leaks nothing', async () => {
  const record = await withMockedEndpoint(happyInvoke, false, args => runProbe(args, { webSocketImpl: FakeSocket }))
  assert.equal(record.verdict, 'pass')
  assert.equal(record.exitCode, EXIT.PASS)
  assert.equal(record.nativeAcceptance, false)
  assert.equal(record.checks.every(check => check.ok === true), true, JSON.stringify(record.checks.filter(check => !check.ok)))
  assert.deepEqual(record.nativeCommandsInvoked, [
    'shell_app_info', 'runtime_status', 'update_status', 'credential_list', 'credential_has', 'credential_store', 'credential_delete',
  ])
  assert.equal(record.document.originMatchesOwnedGateway, true)
  assert.equal(record.target.selectedByExactOrigin, true)
  assert.equal(record.target.browserProduct, 'Edg')
  assert.equal(record.csp.direct.status, 401)
  assert.equal(record.csp.page.cspPresent, true)
  assert.equal(record.restart.attempted, false)
  assert.deepEqual(findSecretLikeLeaks(record), [])
  const serialized = JSON.stringify(record)
  for (const forbidden of ['DOCUMENT-TOKEN-MUST-NOT-LEAK', 'token=', TOKENIZED_RUNTIME_URL, DUMMY_NON_SECRET, RESERVED_CREDENTIAL.provider, RESERVED_CREDENTIAL.reference]) {
    assert.ok(!serialized.includes(forbidden), `the record must not carry ${forbidden}`)
  }
})

test('H2: the flag-gated restart observes a new ready generation = baseline + 1', async () => {
  let restarted = false
  const invoke = async (command, payload) => {
    if (command === 'runtime_restart') {
      restarted = true
      return { state: 'starting', url: null, startedAt: null, lastError: null }
    }
    if (command === 'runtime_status') {
      return restarted
        ? { state: 'ready', url: TOKENIZED_RUNTIME_URL, startedAt: '2026-10-10T07:00:00.000Z', lastError: null }
        : happyInvoke(command, payload)
    }
    return happyInvoke(command, payload)
  }
  const record = await withMockedEndpoint(invoke, true, args => runProbe(args, { webSocketImpl: FakeSocket }))
  assert.equal(record.restart.attempted, true)
  assert.equal(record.restart.invokedCount, 1)
  assert.equal(record.restart.baselineDigestPresent, true)
  assert.equal(record.restart.baselineGeneration, 1)
  assert.equal(record.restart.observedGeneration, 2)
  assert.equal(record.restart.generationAdvancedByOne, true)
  assert.equal(record.restart.newReadyLastErrorPresent, false)
  assert.ok(record.nativeCommandsInvoked.includes('runtime_restart'))
  const restartChecks = record.checks.filter(check => check.id.startsWith('runtime_restart.'))
  assert.equal(restartChecks.length, 4)
  assert.equal(restartChecks.every(check => check.ok === true), true, JSON.stringify(restartChecks))
  assert.equal(record.verdict, 'pass')
  assert.deepEqual(findSecretLikeLeaks(record), [])
})

test('G5: fixed expressions are single expressions with no interpolation or stray escapes', () => {
  for (const expression of [PAGE_FACTS_EXPRESSION, NATIVE_BATTERY_EXPRESSION, CSP_PAGE_EXPRESSION]) {
    assert.equal(typeof expression, 'string')
    assert.ok(!expression.includes('${'), 'no interpolation is allowed in a page expression')
    assert.ok(!expression.includes('\\'), 'no escapes are allowed in a page expression')
    assert.doesNotThrow(() => new Function(`return ${expression}`))
  }
})
