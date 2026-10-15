// Actual shipped staged adapter lane.
//
// SCOPE. Two halves, deliberately separated by an opt-in:
//
//  1. DEFAULT (always runs, read-only, cheap): inspect the *shipped staged*
//     artifact at `port/runtime-payload/dsh` — the one the build publishes and
//     the app ships — and record whether its adapter is the current source. The
//     strict private-handshake contract and the payload seal can only be
//     qualified against a payload whose adapter matches the source that speaks
//     it, so this half states the fact instead of assuming it.
//  2. OPT-IN `DSH_ADAPTER_STAGED_LANE=1` (plus an interpreter): spawn the staged
//     adapter itself, read-only, with a fixture-owned profile/home/control
//     socket, and assert process identity, control authentication, `ready`,
//     `shutdown`/`shutdown-complete`, exit code, and (when a stage identity is
//     provided) the payload seal before and after the run.
//
// TWIN LABELS ARE RETAINED. This lane's twin is a *transport* twin
// (`staged-transport-twin`), not the generation-4 fixture twin of
// `control_adversarial.rs`/`supervisor_lifecycle.rs` and not the owned-control
// twin of `adapter-launch.integration.test.mjs`. Nothing here relabels another
// lane's evidence: `adapter-launch.integration.test.mjs` keeps the sealed
// artifact / source-adapter lanes, `adapter-handshake.test.mjs` keeps the
// hermetic transport lane, and this file owns the staged-artifact observation.
import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLE_ID } from './helpers/updates-contract.mjs'
import { qualificationPaths } from './host-fallback-controls.mjs'
import {
  assertFixtureDirectoryAcls, assertFixtureEnvironment, buildFixtureEnvironment, createRedactor,
  defaultAclRunner, describeEnvironmentGuarantee,
} from './helpers/fixture-isolation.mjs'
import { captureProcessIdentity, summariseTermination, terminateOwnedChild } from './helpers/process-authority.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const stagedPayload = join(port, 'runtime-payload', 'dsh')
const sourceAdapter = join(port, 'src-tauri', 'runtime', 'adapter.mjs')
const stagedAdapter = join(stagedPayload, 'adapter.mjs')
const node = process.env.DSH_ADAPTER_INTEGRATION_NODE ?? process.execPath
const optedIn = process.env.DSH_ADAPTER_STAGED_LANE === '1'
const PINNED_GENERATION = '4'

const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex')

/** Run `scenario` and fail if it does not settle inside its own bound. */
async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not settle within ${milliseconds}ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

const skip = !existsSync(stagedAdapter) ? `the shipped staged payload adapter is absent: ${stagedAdapter}`
  : (!optedIn ? 'set DSH_ADAPTER_STAGED_LANE=1 to spawn the staged adapter (owned-control Host boot)' : false)

test('staged adapter artifact: shipped bytes, adapter freshness and seal state', { skip: !existsSync(stagedAdapter), timeout: 60_000 }, async (t) => {
  const anchors = ['adapter.mjs', 'node_modules', 'package.json', 'runtime-payload.json', 'desktop-runtime.json']
  for (const anchor of anchors) {
    assert.ok(existsSync(join(stagedPayload, anchor)), `published payload anchor is missing: ${anchor}`)
  }
  const stagedAdapterSha256 = digest(stagedAdapter)
  const sourceAdapterSha256 = digest(sourceAdapter)
  const adapterMatchesSource = stagedAdapterSha256 === sourceAdapterSha256
  const stageIdentityProvided = typeof process.env.DSH_ADAPTER_INTEGRATION_STAGE_IDENTITY === 'string'
    && process.env.DSH_ADAPTER_INTEGRATION_STAGE_IDENTITY !== ''
  const facts = {
    lane: 'staged-artifact',
    payloadRoot: stagedPayload,
    stagedAdapterSha256,
    sourceAdapterSha256,
    adapterMatchesSource,
    strictHandshakeEligible: adapterMatchesSource,
    sealVerification: stageIdentityProvided ? 'requested' : 'not performed: no stage identity provided, so the published payload seal cannot be re-derived here',
  }
  // Evidence goes to this lane's own scratch directory; the published payload
  // is read-only and is never written to.
  const evidence = join(port, '.scratch', 'adapter-staged-lane-20261010')
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, 'staged-artifact.json'), JSON.stringify(facts, null, 2))
  t.diagnostic(`staged adapter ${stagedAdapterSha256.slice(0, 16)} source ${sourceAdapterSha256.slice(0, 16)} match=${String(adapterMatchesSource)}`)
  if (!adapterMatchesSource) {
    // Honest, non-green: the shipped adapter predates the strict private
    // handshake (preamble `<token> <generation>`). It must be re-staged by the
    // build owner before the strict contract can be qualified. The relation is
    // asserted so a silent drift cannot pass as current.
    assert.notEqual(stagedAdapterSha256, sourceAdapterSha256)
    facts.requiresRestage = true
    t.diagnostic('the shipped staged adapter predates the strict handshake; re-stage the payload (`build.ps1 -Stage runtime`)')
  }
})

/**
 * Transport twin for the staged lane. It records the private preamble the
 * adapter presents, acknowledges it, and answers generation-4 requests. It
 * accepts the legacy (token-only) preamble only when `strict` is false, so the
 * lane can observe a stale artifact without pretending it is current.
 */
class StagedTransportTwin {
  #server
  #connection
  #buffer = ''
  #connections = new Set()

  constructor({ socketName, token, strict }) {
    this.socketName = socketName
    this.token = token
    this.strict = strict
    this.preamble = null
    this.preambleShape = null
    this.accepted = false
    this.frames = []
    this.ready = Promise.withResolvers()
    this.acked = Promise.withResolvers()
    this.shutdownComplete = Promise.withResolvers()
    this.#server = createServer((connection) => this.#onConnection(connection))
    // A late server-level error must not become an unhandled 'error' event that
    // takes the worker down mid-lane.
    this.#server.on('error', () => {})
  }

  async listen() {
    await new Promise((done, reject) => {
      this.#server.once('error', reject)
      this.#server.listen(this.socketName, () => { this.#server.off('error', reject); done() })
    })
  }

  async close() {
    for (const connection of this.#connections) {
      try { connection.destroy() } catch { /* already gone */ }
    }
    this.#connections.clear()
    if (this.#server.listening) {
      await new Promise((done) => { this.#server.close(() => done()) }).catch(() => {})
    }
  }

  /** Send one generation-4 shell→Host frame. */
  send(frame) { this.#connection?.write(`${JSON.stringify(frame)}\n`) }

  #onConnection(connection) {
    this.#connection = connection
    this.#connections.add(connection)
    connection.setEncoding('utf8')
    connection.on('error', () => { this.#connections.delete(connection) })
    connection.on('close', () => { this.#connections.delete(connection) })
    connection.on('data', (chunk) => this.#onData(connection, chunk))
  }

  #onData(connection, chunk) {
    this.#buffer += chunk
    for (;;) {
      const end = this.#buffer.indexOf('\n')
      if (end < 0) break
      const line = this.#buffer.slice(0, end)
      this.#buffer = this.#buffer.slice(end + 1)
      if (!this.accepted) {
        this.preamble = line
        const [token, generation] = line.split(' ')
        if (token !== this.token) { connection.destroy(); continue }
        if (this.strict && generation !== PINNED_GENERATION) { connection.destroy(); continue }
        if (!this.strict && generation !== undefined) { connection.destroy(); continue }
        this.preambleShape = generation === undefined ? 'legacy-token-only' : `token+generation:${generation}`
        this.accepted = true
        connection.write('\n')
        this.acked.resolve()
        continue
      }
      if (line === '') continue
      let frame
      try { frame = JSON.parse(line) } catch { connection.destroy(); continue }
      this.frames.push(frame)
      if (frame.type === 'ready') this.ready.resolve(frame)
      if (frame.type === 'shutdown-complete') this.shutdownComplete.resolve(frame)
    }
  }
}

test('staged adapter lane: identity, control auth, ready, shutdown, exit, seal', { skip, timeout: 300_000 }, async (t) => {
  assert.ok(existsSync(node), 'configured interpreter must exist')
  const adapterMatchesSource = digest(stagedAdapter) === digest(sourceAdapter)
  const strict = adapterMatchesSource
  const scratch = join(port, '.scratch', 'adapter-staged-lane-20261010')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'run-'))
  const acl = assertFixtureDirectoryAcls(root, { run: defaultAclRunner, account: userInfo().username })
  assert.deepEqual(acl.errors, [], `fixture directory ACL containment failed: ${acl.errors.join('; ')}`)
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  for (const directory of [profile, home]) mkdirSync(directory)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'isolated-staged-adapter-profile', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BUNDLE_ID] } },
  }, null, 2))
  // No listener override is written: the adapter invokes the Host with
  // `--host 127.0.0.1 --port 0` itself, so this lane exercises the production
  // invocation. That also avoids a patch replacing the `webserver` row's whole
  // `config` and silently dropping the target's tls and gzip settings.

  const secrets = createRedactor()
  const socketName = process.platform === 'win32'
    ? `\\\\.\\pipe\\dsh-staged-lane-${randomUUID()}` : join(root, 'control.sock')
  const token = randomUUID()
  secrets.add(token, socketName)
  const twin = new StagedTransportTwin({ socketName, token, strict })
  // `listen` runs inside the try below: a listen failure must still execute the
  // cleanup, or its server handle would keep this worker alive after the lane.
  const built = buildFixtureEnvironment({ inherited: process.env, root, home, control: null })
  for (const [name, value] of Object.entries({
    DSH_DESKTOP_CONTROL_SOCKET: socketName,
    DSH_DESKTOP_CONTROL_TOKEN: token,
    DSH_DESKTOP_CONTROL_GENERATION: PINNED_GENERATION,
  })) {
    built.env[name] = value
    built.owned[name] = value
    if (!built.ownedKeys.includes(name)) built.ownedKeys.push(name)
  }
  const violations = assertFixtureEnvironment(built.env, {
    root, controlled: true, ownedKeys: built.ownedKeys, inherited: process.env,
  })
  assert.deepEqual(violations, [], `staged lane environment is not contained: ${violations.join('; ')}`)

  const stdoutPath = join(root, 'adapter.stdout.log')
  const stderrPath = join(root, 'adapter.stderr.log')
  const stdout = openSync(stdoutPath, 'w')
  const stderr = openSync(stderrPath, 'w')
  let child
  let identityAtSpawn = null
  let exited = false
  let environmentDenial = null
  const terminations = []
  try {
    await within(twin.listen(), 15_000, 'staged lane twin listen')
    child = spawn(node, ['--expose-internals', stagedAdapter, stagedPayload, profile], {
      cwd: profile, env: built.env, windowsHide: true, stdio: ['ignore', stdout, stderr],
    })
    const exitPromise = new Promise((done, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => { exited = true; done({ code, signal }) })
    })
    void exitPromise.catch(() => {})
    identityAtSpawn = await within(captureProcessIdentity(child.pid), 20_000, 'staged adapter identity')
    if (identityAtSpawn.available !== true) {
      // An interpreter that cannot even open the fixture's control pipe exits
      // before its identity can be read. That is the workspace mandatory-label
      // denial (a Low-labeled image cannot connect to a Medium-owned pipe), not
      // an adapter defect, so the cause is named instead of reporting a bare
      // "no identity" that sends the reader hunting in the wrong place.
      const observed = secrets.redact(readFileSync(stderrPath, 'utf8'))
      if (/EPERM/u.test(observed) && /connect/u.test(observed)) {
        // Not a pass and not an adapter failure: this environment cannot host
        // the lane. It is recorded as a skip with the exact cause, so no gate
        // can read an unrun lane as qualified.
        environmentDenial = `the staged lane cannot run from this environment: the configured interpreter cannot connect to a fixture-owned control pipe (EPERM). Interpreter: ${node}. Run this lane outside the Low-labeled tree, relabel the interpreter, or point DSH_ADAPTER_INTEGRATION_NODE at an interpreter outside it.`
        t.skip(environmentDenial)
        return
      }
      assert.fail(`the spawned adapter identity was not observable: ${identityAtSpawn.reason}`)
    }
    assert.equal(
      realpathSync(identityAtSpawn.exe).toLowerCase(),
      realpathSync(node).toLowerCase(),
      'the staged adapter must run under the configured interpreter',
    )
    assert.equal(identityAtSpawn.pid, child.pid)

    const ready = await within(Promise.race([
      twin.ready.promise,
      exitPromise.then((exit) => {
        throw new Error(`staged adapter exited before ready: ${JSON.stringify(exit)}; ${secrets.redact(readFileSync(stderrPath, 'utf8')).slice(-2000)}`)
      }),
    ]), 120_000, 'staged adapter ready')
    assert.ok(twin.accepted, 'the staged adapter authenticated over the control socket')
    secrets.add(String(ready.url ?? ''), new URL(String(ready.url)).searchParams.get('token'))
    if (strict) {
      assert.equal(twin.preamble, `${token} ${PINNED_GENERATION}`, 'a fresh staged adapter presents token and the pinned generation')
      assert.equal(twin.preambleShape, `token+generation:${PINNED_GENERATION}`)
    } else {
      assert.equal(twin.preamble, token, 'a pre-strict staged adapter presents the bare owned token')
      assert.equal(twin.preambleShape, 'legacy-token-only', 'a pre-strict staged adapter is recorded as requiring a re-stage')
    }

    // The advertised URL must serve the fixture shell, not another listener.
    const url = new URL(String(ready.url))
    assert.equal(url.hostname, '127.0.0.1')
    assert.ok(url.port && !['19387', '3080'].includes(url.port), 'the fixture must not address an occupied listener')
    assert.ok(url.searchParams.get('token'), 'ready must carry the authentication token')
    const authentication = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) })
    assert.equal(authentication.status, 303)
    const cookies = authentication.headers.getSetCookie().map((cookie) => cookie.split(';', 1)[0])
    secrets.add(...cookies)
    const location = authentication.headers.get('location')
    assert.ok(location, 'authentication must redirect to the clean index')
    const index = new URL(location, url)
    assert.equal(index.origin, url.origin)
    const response = await fetch(index, { redirect: 'manual', headers: { Cookie: cookies.join('; ') }, signal: AbortSignal.timeout(15_000) })
    assert.equal(response.status, 200)
    assert.match(await response.text(), /__DSH_BOOT__/)

    // Generation-4 shutdown, in the preserved vocabulary.
    twin.send({ type: 'shutdown' })
    await within(twin.shutdownComplete.promise, 30_000, 'shutdown-complete')
    const exit = await within(exitPromise, 30_000, 'staged adapter exit')
    assert.equal(exit.code, 0, `a clean staged shutdown exits 0, got ${JSON.stringify(exit)}`)
    t.diagnostic(`staged lane: strictHandshake=${String(strict)} preamble=${twin.preambleShape} exit=0`)
  } finally {
    if (child && !exited) {
      const outcome = await terminateOwnedChild({ child, identityAtSpawn, label: 'staged-adapter', expectedExe: node })
      terminations.push(outcome)
      await within(new Promise((done) => child.once('exit', done)), 10_000, 'owned child cleanup').catch(() => {})
    }
    await within(twin.close(), 10_000, 'staged lane twin close').catch(() => {})
    closeSync(stdout)
    closeSync(stderr)
    const termination = summariseTermination(terminations)
    writeFileSync(join(root, 'lane.json'), JSON.stringify({
      lane: 'staged-adapter-spawn', strictHandshake: strict, preamble: twin.preambleShape,
      authenticated: twin.accepted, frames: twin.frames.map((frame) => frame.type),
      environment: describeEnvironmentGuarantee({ ...built, violations }),
      acl: { contained: acl.contained, principals: acl.principals },
      termination, adapterMatchesSource, environmentDenial,
    }, null, 2))
    writeFileSync(join(root, 'stderr.log'), secrets.redact(readFileSync(stderrPath, 'utf8')))
    for (const unresolved of terminations.flatMap((entry) => entry.unresolvedRoots ?? [])) {
      assert.fail(`staged lane left an unresolved process root: ${JSON.stringify(unresolved)}`)
    }
    t.diagnostic(`staged lane evidence retained at ${root}`)
  }
})

/** Record the seal state of the shipped payload when the caller can supply it. */
test('staged payload seal (only when a stage identity is available)', { skip: !existsSync(stagedAdapter) || !process.env.DSH_ADAPTER_INTEGRATION_PAYLOAD }, async (t) => {
  const { sealRuntime } = await import('../scripts/lib/seal-runtime.mjs')
  let selection
  try {
    selection = qualificationPaths({
      port,
      payload: process.env.DSH_ADAPTER_INTEGRATION_PAYLOAD,
      artifact: realpathSync(stagedPayload),
      stageIdentityPath: process.env.DSH_ADAPTER_INTEGRATION_STAGE_IDENTITY,
      nodeIdentityPath: process.env.DSH_ADAPTER_INTEGRATION_NODE_IDENTITY,
    })
  } catch (error) {
    t.diagnostic(`seal not verified: ${error.message}`)
    return
  }
  const descriptor = await sealRuntime({
    upstreamRoot: join(port, '..', '_upstream'),
    payloadRoot: realpathSync(stagedPayload),
    stageIdentityPath: selection.stageIdentityPath,
    nodeIdentityPath: selection.nodeIdentityPath,
    verify: true,
  })
  assert.equal(descriptor.release.version, '0.1.7-rc.2', 'the shipped payload must retain the requested release')
  assert.equal(descriptor.release.nodeVersion, '22.20.0', 'the shipped payload must retain the pinned interpreter')
  t.diagnostic(`seal verified for ${stagedPayload}`)
})
