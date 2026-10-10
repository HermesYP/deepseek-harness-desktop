// Hermetic transport lane for the shipped Node adapter
// (`port/src-tauri/runtime/adapter.mjs`).
//
// SCOPE AND BOUNDS. This lane drives the real adapter as a child process and
// asserts only the *transport contract* the Rust shell owns, so it needs no
// profile boot, no HTTP, no gateway and no product credentials:
//
//   * `DSH_DESKTOP_CONTROL_GENERATION` must be the pinned supported generation
//     (4). A parent that pins anything else is refused before a profile loads;
//     a launch with no generation at all is refused the same way.
//   * The private transport preamble is `<token> <generation>`, and the profile
//     must not boot until the shell has acknowledged it with one empty line —
//     within a finite deadline.
//   * A malformed or unknown shell→Host frame is a protocol violation: the
//     adapter reports a generation-4 `fatal` frame, releases the socket and
//     exits non-zero instead of dropping the line silently.
//   * Every teardown path consumes its rejections and exits with a code, so no
//     run can leave an unhandled rejection or an open control socket behind.
//
// The deps, the interpreter and the control socket all belong to fixtures. The
// adapter is COPIED into a fixture runtime whose `node_modules` is a read-only
// junction onto the retained staged dependency tree, so nothing in
// `port/runtime-payload/dsh` is ever written. The profile is never booted here:
// every case below ends before `runProfile`.
//
// WHAT THIS LANE IS NOT: it is not the sealed-artifact lane and not installed
// acceptance. Seal verification and the spawned-Host readiness/shutdown path
// live in `adapter-staged-lane.test.mjs`, and the full isolated Host boot in
// `adapter-launch.integration.test.mjs`.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertFixtureEnvironment, buildFixtureEnvironment, describeEnvironmentGuarantee,
} from './helpers/fixture-isolation.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceAdapter = join(port, 'src-tauri', 'runtime', 'adapter.mjs')
const dependencies = join(port, 'runtime-payload', 'dsh', 'node_modules')
const node = process.env.DSH_ADAPTER_INTEGRATION_NODE ?? process.execPath
const PINNED_GENERATION = '4'

const skip = existsSync(sourceAdapter) ? (!existsSync(dependencies)
  ? 'retained staged dependency tree port/runtime-payload/dsh/node_modules is absent' : false)
  : 'the shipped adapter source is absent'

/** Run `scenario` and fail if it does not settle inside its own bound. */
async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

/**
 * The shell-side twin of the private transport handshake.
 *
 * It is deliberately *not* a generation-4 fixture: it records the preamble the
 * adapter presents, optionally acknowledges it, and can then send whatever bytes
 * a scenario needs. Nothing here interprets a Host→Shell frame.
 */
class TransportTwin {
  #server
  #connections = new Set()

  constructor({ socketName, token, generation = PINNED_GENERATION, mode = 'ack' }) {
    this.socketName = socketName
    this.expectedPreamble = `${token} ${generation}`
    this.mode = mode
    this.accepted = 0
    this.preamble = null
    this.preambleCount = 0
    this.buffer = ''
    this.frames = []
    this.errors = []
    this.#server = createServer((connection) => this.#onConnection(connection))
    // A late server-level error (a torn-down pipe, a close race) must not become
    // an unhandled 'error' event that takes the worker down mid-lane.
    this.#server.on('error', () => {})
  }

  async listen() {
    await new Promise((done, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.socketName, () => { this.#server.off('error', reject); done() })
    })
  }

  async close() {
    // Give anything the child already wrote a moment to arrive: the fatal frame
    // it reports is evidence, and destroying the connection first would discard
    // it. Bounded, so cleanup itself can never hang.
    await new Promise((done) => { setTimeout(done, 50) })
    for (const connection of this.#connections) {
      try { connection.destroy() } catch { /* already gone */ }
    }
    this.#connections.clear()
    if (this.#server.listening) {
      await new Promise((done) => { this.#server.close(() => done()) }).catch(() => {})
    }
  }

  /** Every Host→Shell frame the adapter sent, as raw lines. */
  get lines() { return this.frames }

  #onConnection(connection) {
    this.accepted += 1
    this.#connections.add(connection)
    connection.setEncoding('utf8')
    connection.on('error', () => { this.#connections.delete(connection) })
    connection.on('close', () => { this.#connections.delete(connection) })
    if (this.mode === 'close-before-ack') { connection.destroy(); return }
    connection.on('data', (chunk) => this.#onData(connection, chunk))
  }

  #onData(connection, chunk) {
    this.buffer += chunk
    for (;;) {
      const end = this.buffer.indexOf('\n')
      if (end < 0) break
      const line = this.buffer.slice(0, end)
      this.buffer = this.buffer.slice(end + 1)
      if (this.preambleCount === 0) {
        this.preambleCount += 1
        this.preamble = line
        // The acknowledgement and any follow-up are written as ONE socket write:
        // a byte-stream peer can split them, and a fixture that split them would
        // race the adapter's boot instead of testing its framing contract.
        if (this.mode === 'wrong-ack') { connection.write('hello\n'); continue }
        if (this.mode === 'no-ack') continue
        if (this.mode === 'malformed') { connection.write('\nnot json\n'); continue }
        if (this.mode === 'unknown') { connection.write(`\n${JSON.stringify({ type: 'mystery' })}\n`); continue }
        if (this.mode === 'oversized') { connection.write(`\n${'x'.repeat(1_048_577)}`); continue }
        connection.write('\n')
        continue
      }
      this.frames.push(line)
      // The shell drops a link whose child reported `fatal`; the fixture does
      // the same so the lane also proves the adapter exits on its own.
      try {
        if (JSON.parse(line).type === 'fatal') connection.destroy()
      } catch { /* not a frame this twin interprets */ }
    }
  }
}

/**
 * Build the fixture-owned environment for one launch and re-assert it, so the
 * isolation claim describes the object actually spawned.
 *
 * @param {object} options
 * @param {string} options.root Fixture root.
 * @param {string} options.home Fixture home.
 * @param {{socket: string, token: string, generation?: string|null}} options.control Owned control channel.
 * @param {Record<string,string>} [options.extra] Extra fixture-owned values.
 * @returns {Record<string,string>} The environment to spawn with.
 */
function fixtureEnvironment({ root, home, control, extra = {} }) {
  const built = buildFixtureEnvironment({ inherited: process.env, root, home, control: null })
  const owned = {
    DSH_DESKTOP_CONTROL_SOCKET: control.socket,
    DSH_DESKTOP_CONTROL_TOKEN: control.token,
    ...(control.generation === null || control.generation === undefined
      ? {} : { DSH_DESKTOP_CONTROL_GENERATION: control.generation }),
    ...extra,
  }
  for (const [name, value] of Object.entries(owned)) {
    built.env[name] = value
    built.owned[name] = value
    if (!built.ownedKeys.includes(name)) built.ownedKeys.push(name)
  }
  if (control.generation === null || control.generation === undefined) {
    delete built.env.DSH_DESKTOP_CONTROL_GENERATION
    delete built.owned.DSH_DESKTOP_CONTROL_GENERATION
  }
  const violations = assertFixtureEnvironment(built.env, {
    root, controlled: true, ownedKeys: built.ownedKeys, inherited: process.env,
  })
  assert.deepEqual(violations, [], `fixture environment is not contained: ${violations.join('; ')}`)
  assert.equal(describeEnvironmentGuarantee({ ...built, violations }).containmentViolations.length, 0)
  return built.env
}

test('shipped adapter transport contract (hermetic, no profile boot)', { skip, timeout: 120_000 }, async (t) => {
  assert.ok(existsSync(node), 'configured interpreter must exist')
  const scratch = join(port, '.scratch', 'adapter-handshake-20261010')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'run-'))
  const runtime = join(root, 'runtime')
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  for (const directory of [runtime, profile, home]) mkdirSync(directory)
  // The adapter resolves bare specifiers relative to itself, so it must live
  // beside the dependency tree it imports from. The tree itself is only read.
  copyFileSync(sourceAdapter, join(runtime, 'adapter.mjs'))
  symlinkSync(dependencies, join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'isolated-adapter-transport-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))

  /**
   * Kill an owned child and wait for it with a hard bound.
   *
   * Every path must release the child *and* its stdio pipes: a live child or an
   * open pipe keeps this worker's event loop alive, which is how a failing
   * assertion in this file turns into a hung gate instead of a failed test.
   *
   * @param {import('node:child_process').ChildProcess|null} child
   * @param {string} label Scenario label.
   * @returns {Promise<void>}
   */
  async function reap(child, label) {
    if (!child) return
    // `exitCode`/`signalCode` are already set when the exit event fired earlier;
    // registering the listener BEFORE the kill is what makes the wait race-free.
    const alreadyExited = child.exitCode !== null || child.signalCode !== null
    if (!alreadyExited) {
      const exited = new Promise((done) => child.once('exit', done))
      try { child.kill() } catch { /* already gone */ }
      const settled = await within(exited.then(() => true), 5_000, `${label} child reap`).catch(() => false)
      if (!settled) {
        // The kill did not settle the child. Detach it so a process we cannot
        // prove anything further about cannot pin this worker open.
        try { child.unref() } catch { /* not detachable */ }
      }
    }
    try { child.stdout?.destroy() } catch { /* already closed */ }
    try { child.stderr?.destroy() } catch { /* already closed */ }
  }

  /**
   * Spawn the shipped adapter against a twin and collect its observable facts.
   *
   * Cleanup is unconditional: the twin (an open listening handle) and the child
   * are released on every path, so a failed assertion here can only fail a test,
   * never hang the worker.
   *
   * @param {object} options
   * @param {'ack'|'no-ack'|'wrong-ack'|'malformed'|'unknown'|'close-before-ack'} [options.mode] Twin behaviour.
   * @param {string|null} [options.generation] Value of the pinned generation env, or null to leave it unset.
   * @param {Record<string,string>} [options.extra] Extra fixture-owned env.
   * @param {string} options.label Scenario label.
   * @returns {Promise<{exit: {code: number|null, signal: string|null}, stderr: string, stdout: string, twin: TransportTwin|null, env: Record<string,string>}>}
   */
  async function launch({ mode = 'ack', generation = PINNED_GENERATION, extra = {}, label }) {
    const socketName = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-adapter-handshake-${randomUUID()}` : join(root, `${label}.sock`)
    const token = randomUUID()
    let twin = null
    let child = null
    try {
      twin = mode === null ? null : new TransportTwin({ socketName, token, mode })
      if (twin) await within(twin.listen(), 15_000, `${label} twin listen`)
      const env = fixtureEnvironment({
        root, home,
        control: { socket: socketName, token, generation },
        extra,
      })
      child = spawn(node, ['--expose-internals', join(runtime, 'adapter.mjs'), runtime, profile], {
        cwd: profile, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const exit = await within(new Promise((done, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => done({ code, signal }))
      }), 30_000, `${label} adapter exit`)
      // Name the environment cause instead of letting every transport assertion
      // below fail with a mismatch: a Low-labeled interpreter cannot connect to
      // a Medium-owned pipe, which is a property of the machine, not the adapter.
      if (/EPERM/u.test(stderr) && /connect/u.test(stderr)) {
        throw new Error(`${label}: the configured interpreter could not connect to the fixture-owned control pipe (EPERM). This is the workspace mandatory-label denial (a Low-labeled image cannot open a Medium-owned pipe), not an adapter defect. Interpreter: ${node}. Re-run this lane with an interpreter outside the Low-labeled tree, or relabel that interpreter.`)
      }
      return { exit, stdout, stderr, twin, env }
    } finally {
      // Close the twin first so anything the child already wrote reaches it
      // before the handle is torn down, then reap the child. Both run on the
      // success path, the timeout path and the thrown-assertion path alike, and
      // both are bounded so cleanup itself cannot hang the worker.
      if (twin) await within(twin.close(), 10_000, `${label} twin close`).catch(() => {})
      await reap(child, label)
    }
  }

  await t.test('the pinned generation is required before anything else', async () => {
    const unset = await launch({ generation: null, label: 'generation-unset' })
    assert.equal(unset.exit.code, 1)
    assert.match(unset.stderr, /DSH_DESKTOP_CONTROL_GENERATION must be the pinned supported generation 4; got \(unset\)/)
    assert.equal(unset.twin.accepted, 0, 'a refused launch must not open the control socket')
    assert.doesNotMatch(unset.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)

    for (const generation of ['3', '5', '4 ', 'four']) {
      const refused = await launch({ generation, label: `generation-${generation.trim() || 'blank'}` })
      assert.equal(refused.exit.code, 1, `generation ${JSON.stringify(generation)} must be refused`)
      assert.match(refused.stderr, /DSH_DESKTOP_CONTROL_GENERATION must be the pinned supported generation 4/)
      assert.equal(refused.twin.accepted, 0)
      assert.doesNotMatch(refused.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)
    }
  })

  await t.test('the preamble carries token and generation, and boot waits for the ack', async () => {
    const result = await launch({
      mode: 'no-ack', label: 'no-ack',
      extra: { DSH_ADAPTER_AUTH_ACK_TIMEOUT_MS: '250' },
    })
    assert.equal(result.twin.accepted, 1)
    assert.equal(
      result.twin.preamble,
      `${result.env.DSH_DESKTOP_CONTROL_TOKEN} ${PINNED_GENERATION}`,
      'the child must present the private preamble with the pinned generation',
    )
    assert.equal(result.exit.code, 1, 'an unacknowledged channel must not boot a profile')
    assert.match(result.stderr, /did not acknowledge the transport preamble within 250 ms/)
    assert.deepEqual(
      result.twin.frames.map((line) => JSON.parse(line)).filter((frame) => frame.type !== 'fatal'),
      [],
      'nothing but the refusal may be sent before the acknowledgement',
    )
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)
  })

  await t.test('a non-empty acknowledgement is refused', async () => {
    const result = await launch({ mode: 'wrong-ack', label: 'wrong-ack' })
    assert.equal(result.exit.code, 1)
    assert.match(result.stderr, /acknowledgement is not the empty transport line/)
    assert.equal(result.exit.code, 1)
  })

  await t.test('a connection that closes before authenticating fails instead of booting', async () => {
    const result = await launch({ mode: 'close-before-ack', label: 'close-before-ack' })
    assert.equal(result.exit.code, 1)
    assert.deepEqual(result.twin.frames, [])
  })

  await t.test('a malformed frame is refused, reported and fatal', async () => {
    const result = await launch({ mode: 'malformed', label: 'malformed' })
    assert.equal(result.exit.code, 1)
    assert.match(result.stderr, /control frame is not valid JSON/)
    const fatal = result.twin.frames.map((line) => JSON.parse(line)).find((frame) => frame.type === 'fatal')
    assert.ok(fatal, `the refusal must be reported over the channel: ${JSON.stringify(result.twin.frames)}`)
    assert.match(fatal.message, /not valid JSON/)
    assert.equal(
      result.twin.frames.some((line) => JSON.parse(line).type === 'ready'), false,
      'a protocol violation must never be followed by readiness',
    )
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)
  })

  await t.test('an unknown frame type is refused, not ignored', async () => {
    const result = await launch({ mode: 'unknown', label: 'unknown' })
    assert.equal(result.exit.code, 1)
    assert.match(result.stderr, /control frame is not a known desktop-host request/)
    const fatal = result.twin.frames.map((line) => JSON.parse(line)).find((frame) => frame.type === 'fatal')
    assert.ok(fatal, 'the refusal must be reported over the channel')
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)
  })

  await t.test('a delimiter-free flood is refused instead of buffered', async () => {
    const result = await launch({ mode: 'oversized', label: 'oversized' })
    assert.equal(result.exit.code, 1)
    // The flood arrives in chunks, so boot may already be in flight when the cap
    // trips; the contract is the coded refusal, never a buffered flood.
    assert.match(result.stderr, /control frame exceeded 1048576 characters without a newline/)
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)
  })

  await t.test('every refusal path releases the socket and exits with a code', async () => {
    const runs = [
      await launch({ generation: null, label: 'exit-generation' }),
      await launch({ mode: 'no-ack', label: 'exit-no-ack', extra: { DSH_ADAPTER_AUTH_ACK_TIMEOUT_MS: '200' } }),
      await launch({ mode: 'malformed', label: 'exit-malformed' }),
    ]
    for (const run of runs) {
      assert.equal(run.exit.signal, null, 'a refusal must exit on its own, not be signalled')
      assert.equal(run.exit.code, 1, 'a refusal must be a non-zero, coded exit')
      assert.doesNotMatch(run.stderr, /UnhandledPromiseRejection|ERR_UNHANDLED_REJECTION/)
    }
    t.diagnostic(`fixture retained at ${root}`)
  })
})
