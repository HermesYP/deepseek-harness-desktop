// Opt-in owned Host integration. By default this uses the source adapter and
// retained dependencies. DSH_ADAPTER_INTEGRATION_PAYLOAD selects a scratch-owned
// sealed artifact or EXACTLY port/runtime-payload/dsh, read-only. The normal lane
// requires explicit DSH_ADAPTER_INTEGRATION_STAGE_IDENTITY and
// DSH_ADAPTER_INTEGRATION_NODE_IDENTITY from one retained sibling dsh.s-<8hex>.
// Its actual adapter/interpreter run without copying/linking dependencies; the
// seal is checked before/after execution. UUID naming alone does not prove the
// stage was used for this publication: the build owner must provide that proof.
// No lane is native/installed acceptance. Profiles, sockets, processes and
// HTTP requests belong to fixtures; no supplied payload is written by this test.
//
// ENVIRONMENT ISOLATION: the spawned Host does not inherit this process's
// environment. Inherited `DSH_*`, `WEBVIEW2_*`, API-key/token/credential, proxy
// and runtime/interpreter-override variables are stripped by name, and every
// path variable the child sees (HOME, USERPROFILE, APPDATA, LOCALAPPDATA, TEMP,
// TMP, DSH_HOME and the platform config roots) is written to a fixture-owned
// directory. The finished environment is re-asserted before each spawn, so the
// report's isolation claim is a fact about the spawned process rather than an
// intention. See helpers/fixture-isolation.mjs.
//
// TERMINATION AUTHORITY: a timeout force-kill is preceded by a fresh operating
// system identity check (pid, executable and process creation time). A reused
// pid, a changed executable, an unreadable executable name or an unavailable
// identity all mean NOTHING is killed; the handle is unref'd and the root is
// reported unresolved. See helpers/process-authority.mjs.
//
// DESCENDANTS: the fixture does NOT tree-kill. Each Host is SAMPLED WHILE IT IS
// ALIVE — after `ready` for a controlled launch, and a short bounded moment
// after spawn otherwise — and that live sample is compared against one read-only
// process-table snapshot taken after teardown. Two snapshots are required: a
// single post-teardown table cannot reconstruct the tree, because once an
// intermediary in the chain has exited its children still name it as parent but
// it has no row left to walk through, so anything below it becomes invisible.
// Survivors become unresolved roots and fail the run; a Host with no live sample
// is `not-verified` and also fails. The verdict covers exactly the processes in
// the live sample — a descendant created after it is outside coverage, and that
// limit is reported verbatim rather than asserted away. Nothing is ever
// terminated on a descendant's behalf: it carries no spawn-time identity of its
// own, so the argument that authorises killing the direct child does not reach
// it. A clean shutdown that leaves a backend or gateway running therefore fails
// this fixture rather than passing it. Note for the reviewer: the product
// Host is expected to own and settle its gateway on a clean shutdown, but an
// isolated fixture gateway may legitimately outlive the Host; the first run will
// establish which of those this actually is, and the outcome is recorded either
// way.
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { userInfo } from 'node:os'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { BUNDLE_ID, classifyUpdatesArtifact } from './helpers/updates-contract.mjs'
import { assertMaterializedPath, materializedPathChain, qualificationPaths, qualifyUpdatesGraph, updatesExpectation } from './host-fallback-controls.mjs'
import {
  assertFixtureDirectoryAcls, assertFixtureEnvironment, assertNoSecrets, buildFixtureEnvironment,
  createRedactor, defaultAclRunner, describeEnvironmentGuarantee,
} from './helpers/fixture-isolation.mjs'
import {
  captureProcessIdentity, captureProcessTable, descendantsOf, settleDescendants, summariseTermination,
  terminateOwnedChild,
} from './helpers/process-authority.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Lifecycle generation the private transport preamble pins (`PROTOCOL_GENERATION`). */
const DESKTOP_HOST_PROTOCOL_GENERATION = '4'
/**
 * Fixture-owned launch barrier (test-only mediation, never shipped). It starts
 * the real adapter from its actual bytes as its direct child, forwards stdio,
 * attests the argv and exit code, and holds the tree open for this many
 * milliseconds so the fixture can sample it while it is alive. The argument-
 * validation launches exit faster than one identity read plus one process-table
 * read, and a Host with no live sample is `not-verified` rather than a pass.
 */
const LAUNCH_BARRIER_MS = 2500
const launchBarrierPath = join(port, 'tests', 'helpers', 'launch-barrier.mjs')
const payload = process.env.DSH_ADAPTER_INTEGRATION_PAYLOAD
const node = process.env.DSH_ADAPTER_INTEGRATION_NODE ?? (payload ? process.execPath : undefined)
const source = join(port, 'src-tauri', 'runtime', 'adapter.mjs')
const dependencies = join(port, 'runtime-payload', 'dsh', 'node_modules')

// Filesystem-only inspection: Windows lstat alone does not exclude every reparse
// type. Query Attributes too, once for the selected paths and ALL ancestors.
function requireMaterializedQualification(selection) {
  const leaves = [[selection.artifact, 'directory'], [selection.stageIdentityPath, 'file'], [selection.nodeIdentityPath, 'file']]
  const paths = [...new Set(leaves.flatMap(([path]) => materializedPathChain(path)))]
  let attributes = []
  if (process.platform === 'win32') {
    const literals = paths.map(path => `'${path.replaceAll("'", "''")}'`).join(',')
    const command = `$ErrorActionPreference='Stop'; try { foreach ($p in @(${literals})) { $item=Get-Item -LiteralPath $p -Force -ErrorAction Stop; [int]$item.Attributes } } catch { Write-Error $_; exit 1 }`
    const observed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', windowsHide: true, timeout: 15_000 })
    assert.ok(!observed.error && observed.status === 0, 'qualification reparse attributes must be positively verified')
    attributes = observed.stdout.trim().split(/\r?\n/u)
    assert.equal(attributes.length, paths.length, 'qualification attribute inspection must cover all selected paths and ancestors')
    assert.ok(attributes.every(value => /^\d+$/u.test(value)), 'qualification attributes must be numeric filesystem evidence')
  }
  const facts = new Map(paths.map((path, index) => {
    const stat = lstatSync(path)
    return [path, { realpath: realpathSync(path), kind: stat.isFile() ? 'file' : stat.isDirectory() ? 'directory' : 'other',
      reparse: stat.isSymbolicLink() || (process.platform === 'win32' && (Number(attributes[index]) & 0x400) !== 0) }]
  }))
  for (const [path, kind] of leaves) assertMaterializedPath(path, kind, candidate => facts.get(candidate))
}

async function within(promise, milliseconds, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds)
    })])
  } finally { clearTimeout(timer) }
}

test(payload ? 'sealed artifact adapter contract and isolated owned-control Host boot'
  : 'source adapter launch contract and isolated owned-control Host boot', {
  skip: !node && 'set DSH_ADAPTER_INTEGRATION_NODE to the pinned Node executable',
  timeout: 180_000,
}, async (t) => {
  assert.ok(existsSync(node), 'configured interpreter must exist')
  let artifact, selection, expectedUpdates
  if (payload) {
    artifact = realpathSync(payload)
    selection = qualificationPaths({ port, payload, artifact,
      stageIdentityPath: process.env.DSH_ADAPTER_INTEGRATION_STAGE_IDENTITY,
      nodeIdentityPath: process.env.DSH_ADAPTER_INTEGRATION_NODE_IDENTITY })
    if (selection.lane === 'normal-sealed-read-only') requireMaterializedQualification(selection)
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value
    assert.equal(fold(realpathSync(node)), fold(realpathSync(process.execPath)), 'seal verifier and Host must use the same actual payload interpreter')
  } else {
    assert.ok(existsSync(dependencies), 'retained payload dependency tree must exist')
  }
  const scratch = join(port, '.scratch', 'integration-review-20261001')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'adapter-launch-'))
  // Contain the fresh fixture directory before anything is written into it, and
  // before it exists for longer than a moment with a repository-inherited DACL.
  // Only THIS directory is touched: no repository, install or user directory is
  // ever named. Failure is fatal rather than a warning, because a run that
  // reports isolation while its scratch tree is readable by every local principal
  // has not established what its report claims.
  const acl = assertFixtureDirectoryAcls(root, { run: defaultAclRunner, account: userInfo().username })
  const fixtureRuntime = join(root, 'runtime')
  const runtime = artifact ?? fixtureRuntime
  const profile = join(root, 'profile')
  const home = join(root, 'home')
  for (const directory of [fixtureRuntime, profile, home]) mkdirSync(directory)
  const adapter = join(runtime, 'adapter.mjs')
  if (!artifact) {
    symlinkSync(dependencies, join(runtime, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    copyFileSync(source, adapter)
  }
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'isolated-desktop-integration-profile', private: true,
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', BUNDLE_ID,
    ] } },
  }, null, 2))
  // No listener override is written. The adapter itself invokes the Host with
  // `--host 127.0.0.1 --port 0`, so the lane exercises that production invocation
  // directly instead of overriding it. That also avoids the hazard a listener patch
  // carries now: a patch REPLACES the matched row's whole `config`, so a partial
  // `host`/`port` patch silently drops the target's tls and gzip settings.
  const report = {
    scope: artifact
      ? 'sealed payload adapter, interpreter and dependencies; adapter-requested loopback ephemeral port; not native or installed acceptance'
      : 'source adapter with retained dependency tree; adapter-requested loopback ephemeral port; not sealed or installed acceptance',
    sourceSha256: createHash('sha256').update(readFileSync(source)).digest('hex'),
    interpreter: node,
    interpreterSha256: createHash('sha256').update(readFileSync(node)).digest('hex'),
    launchBarrier: {
      wrapper: launchBarrierPath,
      wrapperSha256: createHash('sha256').update(readFileSync(launchBarrierPath)).digest('hex'),
      scheme: 'dsh-fixture-launch-barrier/1',
      barrierMs: LAUNCH_BARRIER_MS,
      mediator: 'fixture-owned launch barrier (test-only; port/tests/helpers/launch-barrier.mjs)',
      purpose: 'hold the spawned tree open long enough to sample it while it is alive, because the argument-validation launches exit sooner than one identity read plus one process-table read',
      attestation: 'the barrier records the exact command and argv it launched, the Host pid, and the exit code/signal it forwards; the lane asserts all of them per launch',
      productionAcceptance: 'NOT CLAIMED: a barrier-mediated launch is fixture mediation. This lane remains a source/sealed-adapter contract lane, not native or installed acceptance, and the barrier is not part of the product.',
    },
    root, checks: [],
    containment: {
      fixtureDirectory: {
        policy: 'icacls /inheritance:r then current-user + SYSTEM (OI)(CI)F, applied to this fresh fixture directory only',
        applicable: acl.applicable,
        principals: acl.principals,
        inherited: acl.inherited,
        unexpectedPrincipals: acl.unexpected,
        contained: acl.contained,
      },
      environment: [],
      termination: null,
      descendants: null,
    },
    unresolvedRoots: [],
  }
  // A live registry: report writes after any failed packaged-composition check
  // must still have a redactor even though no Host has launched yet.
  const fixtureSecrets = createRedactor()
  // Fail before any Host is spawned: a report that claims isolation must not be
  // produced by a run whose scratch tree was readable by other local principals.
  assert.deepEqual(acl.errors, [], `fixture directory ACL containment failed: ${acl.errors.join('; ')}`)
  if (artifact) {
    const { sealRuntime } = await import('../scripts/lib/seal-runtime.mjs')
    const verify = () => {
      if (selection.lane === 'normal-sealed-read-only') requireMaterializedQualification(selection)
      return sealRuntime({ upstreamRoot: join(port, '..', '_upstream'), payloadRoot: artifact,
        stageIdentityPath: selection.stageIdentityPath, nodeIdentityPath: selection.nodeIdentityPath, verify: true })
    }
    const descriptor = await verify()
    assert.equal(descriptor.release.version, '0.1.7-rc.2', 'qualification must retain the requested release')
    assert.equal(descriptor.release.nodeVersion, '22.20.0', 'qualification must retain the pinned interpreter')
    const manifest = JSON.parse(readFileSync(join(artifact, 'runtime-payload.json'), 'utf8'))
    assert.equal(manifest.upstreamCommit, '477b4f420553e8a52c2fbccc464d7561b239c443', 'qualification must retain the immutable upstream reference')
    const descriptorHash = () => createHash('sha256').update(readFileSync(join(artifact, 'desktop-runtime.json'))).digest('hex')
    assert.equal(createHash('sha256').update(readFileSync(adapter)).digest('hex'), report.sourceSha256, 'sealed adapter must match current source')
    report.artifact = { runtime: artifact, lane: selection.lane,
      stageIdentityPath: selection.stageIdentityPath, nodeIdentityPath: selection.nodeIdentityPath,
      publicationFreshnessQualified: false,
      publicationFreshnessLimitation: 'Caller-selected stage identities verify release/interpreter/payload bytes, not the build instance that published them. UUID naming and mtimes are not freshness evidence; the build owner must record build-instance publication separately.',
      upstreamCommit: manifest.upstreamCommit, release: descriptor.release,
      descriptorSha256: descriptorHash(), verifiedBeforeHost: true }
    t.after(async () => {
      await verify()
      assert.equal(descriptorHash(), report.artifact.descriptorSha256, 'Host execution must not rewrite the descriptor')
      report.artifact.verifiedAfterHost = true
      writeReport()
    })
    // Inspect the actual sealed package, never workspace source or an env bypass.
    const yamlRoot = join(port, '..', '_upstream', 'node_modules', '.pnpm', 'yaml@2.9.0', 'node_modules', 'yaml')
    assert.equal(JSON.parse(readFileSync(join(yamlRoot, 'package.json'), 'utf8')).version, '2.9.0', 'qualification YAML parser must be pinned')
    const { parse } = await import(pathToFileURL(join(yamlRoot, 'dist', 'index.js')).href)
    const patchPath = join(artifact, 'node_modules', BUNDLE_ID, 'cordis.patch.yml')
    const patchBytes = readFileSync(patchPath)
    const patchSha256 = createHash('sha256').update(patchBytes).digest('hex')
    expectedUpdates = updatesExpectation(parse(patchBytes.toString('utf8')), patchSha256)
    report.updatesComposition = { package: BUNDLE_ID, patchPath, patchSha256, expected: expectedUpdates,
      evidence: 'sealed packaged source composition only; not visible Settings proof', activationQualified: false }
  }

  const terminations = []
  // One entry per spawned Host, plus the subtree sampled while it was alive.
  const spawnedHosts = []

  /**
   * Serialize the report with every owned secret removed, and refuse to write a
   * leak at all rather than publishing one.
   */
  function writeReport() {
    const serialized = fixtureSecrets.redact(JSON.stringify(report, null, 2))
    assertNoSecrets(serialized, fixtureSecrets.secrets(), 'report.json')
    writeFileSync(join(root, 'report.json'), serialized)
  }

  /**
   * Read the subtree under a Host while it is still running and store it on the
   * host record. Read-only: the only thing this does to processes is look at
   * them. A failed read leaves `liveSubtree` null, which the assessment reports
   * as `not-verified` — never as "nothing was there".
   *
   * @param {object|null} record The host record.
   * @param {string} phase When this sample was taken.
   * @returns {Promise<Array<object>|null>}
   */
  async function sampleSubtree(record, phase) {
    if (!record || record.identity?.available !== true) return null
    const snapshot = await captureProcessTable()
    const fold = value => process.platform === 'win32' ? value.toLowerCase() : value
    const liveHostObserved = snapshot.available && snapshot.rows.some(row => row.pid === record.pid
      && String(row.creationTicks) === String(record.identity.creationTicks)
      && typeof row.exe === 'string' && fold(row.exe) === fold(record.identity.exe))
    const subtree = liveHostObserved
      ? descendantsOf({
        host: { pid: record.pid, creationTicks: record.identity.creationTicks },
        table: snapshot.rows,
        observedAtTicks: snapshot.observedAtTicks,
      })
      : null
    record.liveSubtree = subtree
    record.sampleObservation = { available: snapshot.available, liveHostObserved, observedAtTicks: String(snapshot.observedAtTicks ?? ''),
      processesObserved: snapshot.rows.length, rejected: snapshot.rejected, truncated: snapshot.truncated }
    record.samplePhase = phase
    record.sampleReason = !snapshot.available ? snapshot.reason : !liveHostObserved
      ? 'the same Host pid/executable/creation time was not observed alive in this sample' : ''
    return subtree
  }

  async function launch(name, args, controlled, inspectReady) {
    const stdoutPath = join(root, `${name}.stdout.log`)
    const stderrPath = join(root, `${name}.stderr.log`)
    const stdout = openSync(stdoutPath, 'w')
    const stderr = openSync(stderrPath, 'w')
    const socketName = process.platform === 'win32'
      ? `\\\\.\\pipe\\dsh-adapter-test-${randomUUID()}` : join(root, `${name}.sock`)
    const token = randomUUID()
    fixtureSecrets.add(token, socketName)
    const frames = []
    let socket, authenticated = false, child, exited = false, exitPromise, identityAtSpawn = null
    let preamble = null
    let terminalResolve
    const terminal = new Promise((resolveTerminal) => { terminalResolve = resolveTerminal })
    const server = controlled === true ? createServer((connection) => {
      socket = connection
      connection.setEncoding('utf8')
      let buffer = ''
      connection.on('data', (chunk) => {
        buffer += chunk
        if (buffer.length > 1_048_576) { connection.destroy(); return }
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n')
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          if (!authenticated) {
            // Private transport preamble: `<token> <generation>`. It is strict,
            // and the Host does not boot until this one-line acknowledgement
            // arrives, so a token-only line is a refusal rather than a match.
            const [presentedToken, presentedGeneration] = line.trimEnd().split(' ')
            preamble = line
            authenticated = presentedToken === token && presentedGeneration === DESKTOP_HOST_PROTOCOL_GENERATION
            if (!authenticated) { connection.destroy(); continue }
            connection.write('\n')
            continue
          }
          try {
            const frame = JSON.parse(line)
            frames.push(frame)
            if (frame.type === 'ready' || frame.type === 'fatal') terminalResolve(frame)
          } catch { connection.destroy() }
        }
      })
      connection.on('error', () => {})
    }) : null
    try {
      if (server) await new Promise((done, reject) => {
        server.once('error', reject)
        server.listen(socketName, () => { server.off('error', reject); done() })
      })
      const built = buildFixtureEnvironment({
        inherited: process.env, root, home,
        control: controlled ? { socket: socketName, token } : null,
      })
      // Fixture-owned variables this launch adds: the pinned generation (the
      // Rust supervisor always sets it) and the launch-barrier window plus its
      // attestation path. All three are registered as owned so the environment
      // re-assertion below validates the object that is actually spawned.
      const barrierRecordPath = join(root, `${name}.barrier.json`)
      const ownedExtras = {
        ...(controlled ? { DSH_DESKTOP_CONTROL_GENERATION: DESKTOP_HOST_PROTOCOL_GENERATION } : {}),
        DSH_FIXTURE_LAUNCH_BARRIER_MS: String(LAUNCH_BARRIER_MS),
        DSH_FIXTURE_LAUNCH_RECORD: barrierRecordPath,
      }
      for (const [key, value] of Object.entries(ownedExtras)) {
        built.env[key] = value
        built.owned[key] = value
        if (!built.ownedKeys.includes(key)) built.ownedKeys.push(key)
      }
      // Re-assert the finished environment against the fixture root before it is
      // spawned. This reads only the object that will be spawned, so it catches a
      // later edit that forgets a strip or overwrites an owned path. A launch
      // that carries the owned control channel IS a controlled launch, whatever
      // the mode string says.
      const violations = assertFixtureEnvironment(built.env, {
        root, controlled: Boolean(controlled), ownedKeys: built.ownedKeys, inherited: process.env,
      })
      const guarantee = describeEnvironmentGuarantee({ ...built, violations })
      report.containment.environment.push({ ...guarantee, launch: name })
      assert.deepEqual(violations, [], `Host environment is not contained for ${name}: ${violations.join('; ')}`)
      const env = built.env
      // Barrier-mediated launch (test-only fixture mediation, recorded in the
      // report): the barrier starts the real adapter from its actual bytes with
      // the configured interpreter as its direct child, forwards stdio, and
      // holds the tree open long enough for the live sample below. Without it the
      // argument-validation launches exit before their tree can be sampled and
      // the post-teardown verdict is `not-verified`.
      child = spawn(node, [launchBarrierPath, node, '--expose-internals', adapter, ...args], {
        cwd: profile, env, windowsHide: true, stdio: ['ignore', stdout, stderr],
      })
      // Observe even a fast diagnostic exit before asynchronous OS sampling.
      exitPromise = new Promise((done, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => {
          exited = true
          const hostRecord = spawnedHosts.find(entry => entry.pid === child.pid)
          if (hostRecord) hostRecord.exited = true
          done({ code, signal })
        })
      })
      // The main launch path awaits this promise below; keep a failed spawn
      // observed while identity/table reads are still pending.
      void exitPromise.catch(() => {})
      // Establish spawn-time identity immediately, while the pid is known to be
      // ours. A later force-kill is only permitted against this observation. The
      // identity is the barrier's: it is the process this fixture spawned, and
      // the Host adapter is its direct child (attested below).
      identityAtSpawn = await captureProcessIdentity(child.pid)
      const record = {
        label: name, pid: child.pid, identity: identityAtSpawn, exited, liveSubtree: null,
        samplePhase: 'none', reachedReady: false,
        identitySubject: 'fixture launch barrier (test-only wrapper); the Host adapter runs as its direct child',
      }
      spawnedHosts.push(record)
      // First live sample, taken while the Host is still alive. A launch that
      // reaches `ready` re-samples afterwards, which supersedes this one; a
      // launch that never boots keeps this sample and its `samplePhase`, so a
      // reader can see exactly when each verdict's tree was taken.
      await sampleSubtree(record, 'post-spawn')
      let first = null
      if (controlled === true) {
        first = await within(Promise.race([
          terminal, exitPromise.then((exit) => { throw new Error(`Host exited before ready/fatal: ${JSON.stringify(exit)}; ${fixtureSecrets.redact(readFileSync(stderrPath, 'utf8')).slice(-3000)}`) }),
        ]), 45_000, `${name} Host boot`)
        if (first.type === 'ready') {
          const record = spawnedHosts.find(entry => entry.pid === child.pid)
          if (record) record.reachedReady = true
          // The Host has just told the fixture where its private gateway is and
          // handed it a session token in the URL query. Register BOTH with the
          // redactor before anything else touches them, so the URL, the token and
          // any later log or frame carrying either is erased at write time. This
          // is why the redactor is a live registry rather than a snapshot.
          const advertised = String(first.url ?? '')
          fixtureSecrets.add(advertised, new URL(advertised).searchParams.get('token'))
          await inspectReady?.(first)
          // Sample the subtree NOW, while the Host is alive and its intermediaries
          // are still in the table. This is the only moment the tree can be walked
          // end to end; after teardown it cannot be reconstructed.
          await sampleSubtree(record ?? null, 'post-ready')
          socket.write(`${JSON.stringify({ type: 'shutdown' })}\n`)
        }
      }
      const exit = await within(exitPromise, 15_000, `${name} process exit`)
      const hostRecord = spawnedHosts.find(entry => entry.pid === child.pid)
      if (hostRecord) hostRecord.exited = true
      const stderrText = readFileSync(stderrPath, 'utf8')
      // The barrier attests the launch it mediated: the exact command, argv and
      // forwarded exit code. A wrapper that launched something else, or dropped
      // the Host's exit code, must fail here rather than pass as a Host launch.
      const barrier = JSON.parse(readFileSync(barrierRecordPath, 'utf8'))
      assert.equal(barrier.scheme, 'dsh-fixture-launch-barrier/1')
      assert.equal(barrier.command, node, `${name}: the barrier must launch the configured interpreter`)
      assert.deepEqual(barrier.args.slice(0, 2), ['--expose-internals', adapter], `${name}: the barrier must launch the fixture adapter from its actual bytes`)
      assert.deepEqual(barrier.args.slice(2), args, `${name}: the barrier must pass the launch argv through unchanged`)
      if (barrier.exit === null) {
        // No attestation means the fixture itself had to force-kill the barrier
        // (already recorded as a termination / unresolved root). Claiming the
        // exit was forwarded would be fabricating evidence, so the forwarding
        // assertion only applies to a barrier that exited on its own.
        assert.notEqual(exit.signal, null, `${name}: an un-attested barrier exit must be a signal, not a clean code`)
      } else {
        assert.equal(barrier.exit.code ?? null, exit.code, `${name}: the barrier must forward the Host exit code`)
        assert.equal(barrier.exit.signal ?? null, exit.signal, `${name}: the barrier must forward the Host exit signal`)
      }
      const preambleShape = preamble === null
        ? null
        : (preamble.trimEnd().split(' ')[1] === DESKTOP_HOST_PROTOCOL_GENERATION
          ? `token+generation:${DESKTOP_HOST_PROTOCOL_GENERATION}`
          : 'legacy-token-only')
      const result = { exit, first, frames, authenticated, preamble, preambleShape, barrier, stderr: stderrText }
      report.checks.push({
        name, exit, authenticated, preambleShape,
        launchBarrier: { mediator: barrier.scheme, barrierPid: barrier.barrierPid, hostPid: barrier.childPid, argvAttested: true, exitForwarded: true },
        frames: frames.map((frame) => frame.type === 'ready' ? { ...frame, url: '<fixture authenticated URL redacted>', injections: '<omitted>' } : frame),
        stdoutPath, stderrPath,
      })
      return result
    } finally {
      // Force-kill is authority-checked, never assumed. Anything that cannot be
      // proven to be the process this fixture spawned is left alone, unref'd, and
      // recorded as an unresolved root for the report to fail on.
      if (child && !exited) {
        const outcome = await terminateOwnedChild({ child, identityAtSpawn, label: name, expectedExe: node })
        terminations.push(outcome)
        for (const unresolved of outcome.unresolvedRoots) {
          report.unresolvedRoots.push(unresolved)
        }
        await within(exitPromise.catch(() => {}), 5_000, 'owned child cleanup').catch(() => {})
      }
      report.containment.termination = summariseTermination(terminations)
      socket?.destroy()
      if (server?.listening) await new Promise((done) => server.close(done))
      closeSync(stdout)
      closeSync(stderr)
      writeReport()
    }
  }

  await t.test('materializer no-control diagnostic is preserved', async () => {
    const result = await launch('no-control', [], false)
    assert.equal(result.exit.code, 1)
    assert.match(result.stderr, /DSH_DESKTOP_CONTROL_SOCKET \/ DSH_DESKTOP_CONTROL_TOKEN are required/)
    assert.doesNotMatch(result.stderr, /ReferenceError/)
  })
  for (const [name, args, diagnostic] of [
    ['missing-runtime', [], /runtimeDir must be an absolute directory/],
    ['relative-runtime', ['relative', profile], /runtimeDir must be an absolute directory/],
    ['missing-project', [runtime], /projectDir must be an absolute directory/],
    ['whitespace-primary', [runtime, profile, '   '], /primaryRuntime must be an absolute directory/],
  ]) {
    await t.test(name, async () => {
      const result = await launch(name, args, 'credentials-only')
      assert.equal(result.exit.code, 1)
      assert.match(result.stderr, diagnostic)
      assert.doesNotMatch(result.stderr, /ReferenceError/)
    })
  }
  for (const [name, args] of [
    ['default-primary', [runtime, profile]],
    ['empty-primary-placeholder', [runtime, profile, '']],
  ]) {
    await t.test(`${name}: authenticated ready, HTTP and clean shutdown`, async () => {
      const result = await launch(name, args, true, async (ready) => {
        const url = new URL(ready.url)
        assert.equal(url.protocol, 'http:')
        assert.equal(url.hostname, '127.0.0.1')
        assert.ok(url.port && !['19387', '3080'].includes(url.port), 'fixture must not address occupied/live listeners')
        assert.ok(url.searchParams.get('token'), 'ready URL must carry the fixture authentication token')
        const authentication = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
        assert.equal(authentication.status, 303)
        const cookies = authentication.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0])
        assert.ok(cookies.length > 0, 'authentication must issue a session cookie')
        // The cookie is a live credential the run just produced; register it with
        // the redactor so no log, frame or report line can carry it.
        fixtureSecrets.add(...cookies, authentication.headers.getSetCookie())
        const location = authentication.headers.get('location')
        assert.ok(location, 'authentication must redirect to the clean index')
        const index = new URL(location, url)
        assert.equal(index.origin, url.origin, 'only follow redirects within the owned fixture')
        assert.equal(index.searchParams.has('token'), false)
        const response = await fetch(index, {
          redirect: 'manual', headers: { Cookie: cookies.join('; ') }, signal: AbortSignal.timeout(10_000),
        })
        assert.equal(response.status, 200)
        const html = await response.text()
        assert.match(html, /__DSH_BOOT__/)
        writeFileSync(join(root, `${name}.html`), html)
        if (artifact) {
          const graph = ready.injections?.find(row => row.kind === 'global' && row.name === '__DSH_BOOT__')?.value
          const { updatesActivation, resource } = qualifyUpdatesGraph(graph, expectedUpdates, index.href)
          report.checks.push({ launch: name, graphRevision: graph.rev, updatesActivation,
            evidence: 'Host advertisement and optional HTTP artifact only; not renderer activation or visible Settings proof' })
          if (resource) {
            const pluginResponse = await fetch(resource.requestUrl, {
              redirect: 'manual', headers: { Cookie: cookies.join('; ') }, signal: AbortSignal.timeout(10_000),
            })
            const facts = { status: pluginResponse.status, contentType: pluginResponse.headers.get('content-type') ?? '', body: await pluginResponse.text() }
            const classification = classifyUpdatesArtifact(facts)
            assert.ok(classification.artifactAccepted, `advertised Updates artifact rejected: HTTP ${facts.status}, ${facts.contentType}`)
            report.checks.push({ updatesArtifactServing: { requestedUrl: resource.requestUrl,
              graphRevision: graph.rev, entryRevision: resource.entry.rev,
              batchRevisions: resource.batches.map(batch => batch.rev),
              status: facts.status, contentType: facts.contentType, ...classification, activationQualified: false } })
          }
        }
      })
      assert.equal(result.authenticated, true)
      // Evidence that the fixture and the Host agree on the *current* private
      // handshake: the strict preamble, acknowledged before any profile boot.
      assert.equal(result.preambleShape, `token+generation:${DESKTOP_HOST_PROTOCOL_GENERATION}`)
      assert.equal(result.first.type, 'ready')
      assert.ok(result.frames.some((frame) => frame.type === 'shutdown-complete'))
      assert.equal(result.exit.code, 0)
      assert.match(result.stderr, /Office workspace dependencies unavailable/)
      assert.doesNotMatch(result.stderr, /ReferenceError|load_workspace_dependencies is registered/)
    })
  }
  await t.test('explicit primary directory without metadata refuses before ready', async () => {
    const primary = join(root, 'explicit-primary')
    mkdirSync(primary)
    const result = await launch('explicit-primary-missing-metadata', [runtime, profile, primary], true)
    assert.equal(result.authenticated, true)
    assert.equal(result.preambleShape, `token+generation:${DESKTOP_HOST_PROTOCOL_GENERATION}`)
    assert.equal(result.first.type, 'fatal')
    assert.match(result.first.message, /primaryRuntime has no runtime.json/)
    assert.ok(!result.frames.some((frame) => frame.type === 'ready'))
    assert.equal(result.exit.code, 1)
  })
  t.after(async () => {
    // One read-only snapshot per attempt, after every Host has run. Nothing here
    // terminates anything: survivors are attributed and reported, and an
    // unprovable result is recorded as `not verified` rather than quietly read
    // as clean. Re-reading is bounded so a console host outliving its parent by
    // a moment is not mistaken for a product leftover.
    const settled = await settleDescendants({ hosts: spawnedHosts })
    const descendants = settled.assessment
    report.containment.descendants = {
      policy: 'read-only Win32_Process snapshot; attribution by parent id AND creation time; no tree kill, ever',
      snapshotAvailable: settled.snapshot.available,
      snapshotReason: settled.snapshot.reason,
      processesObserved: settled.snapshot.rows.length,
      settleAttempts: settled.attempts,
      verified: descendants.verified,
      reason: descendants.reason,
      coverage: descendants.coverage,
      fullOrphanProof: false,
      finalSample: { observedAtTicks: String(settled.snapshot.observedAtTicks ?? ''),
        rejected: settled.snapshot.rejected, truncated: settled.snapshot.truncated },
      liveSamples: spawnedHosts.map(host => ({ label: host.label, pid: host.pid,
        phase: host.samplePhase, reason: host.sampleReason, observation: host.sampleObservation ?? null,
        sampledDescendants: Array.isArray(host.liveSubtree) ? host.liveSubtree.length : null })),
      perHost: descendants.perHost,
    }
    for (const survivor of descendants.survivors) report.unresolvedRoots.push(survivor)
    writeReport()
    assert.deepEqual(report.unresolvedRoots, [],
      `fixture left unresolved process roots: ${report.unresolvedRoots.map(entry => `${entry.label} pid ${entry.pid}: ${entry.reason}`).join('; ')}`)
    // The negative half of the same fact: a run must not report descendant
    // cleanup as fine when it never proved it.
    assert.ok(descendants.verified,
      `descendant cleanup not verified: ${descendants.reason}${settled.snapshot.rows.length ? '' : ' (snapshot returned nothing)'}`)
  })
  t.diagnostic(`Evidence retained at ${join(root, 'report.json')}`)
})
