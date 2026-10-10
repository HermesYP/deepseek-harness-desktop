import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, renameSync, truncateSync, symlinkSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { validateIdentity, sealRuntime } from '../../scripts/lib/seal-runtime.mjs'

const workspace = resolve(fileURLToPath(new URL('../../../', import.meta.url)))
const upstream = join(workspace, '_upstream')
const cli = join(workspace, 'port/scripts/lib/seal-runtime.mjs')
const nodeVersion = process.versions.node
const relativeExecutable = process.platform === 'win32' ? 'node/node.exe' : 'node/bin/node'
const targetName = ({ win32: 'win', darwin: 'darwin', linux: 'linux' }[process.platform] ?? process.platform) + '-' + process.arch
const stubSha256 = 'a'.repeat(64)

/**
 * Locate the trusted interpreter the Windows build executes: a byte-identical copy
 * of the archive-pinned Node outside the Low-labelled workspace. `-` result means no
 * such copy is present, so byte-identity cases skip instead of asserting on a machine
 * that cannot express them.
 */
function findTrustedPinnedNode() {
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = []
  if (local) {
    try {
      for (const entry of readdirSync(local)) {
        if (entry.startsWith('eperm-bin-')) candidates.push(join(local, entry, 'pinnednode.exe'))
      }
    } catch { /* the local directory may not be listable; the fallbacks below still apply */ }
  }
  candidates.push(join(workspace, 'port/runtime-payload/dsh/node/node.exe'))
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch { /* try the next candidate */ }
  }
  return null
}

const sha256Of = path => createHash('sha256').update(readFileSync(path)).digest('hex')
const pinnedNode = process.platform === 'win32' ? findTrustedPinnedNode() : null
const pinnedSha256 = pinnedNode ? sha256Of(pinnedNode) : null
// Read the pinned interpreter's own version so the fixture never hard-codes a build
// number that could drift from the bytes it copies.
const pinnedNodeVersion = pinnedNode ? spawnSync(pinnedNode, ['--version'], { encoding: 'utf8' }).stdout?.trim().replace(/^v/u, '') : null

/**
 * Build one payload fixture. `pinned` copies the real pinned interpreter bytes so
 * identity validation reaches the byte comparison; otherwise the interpreter is a
 * small stand-in that can never hash to the recorded digest.
 */
function fixture({ pinned = false } = {}) {
  const scratch = join(workspace, 'port/.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'runtime-seal-'))
  const payload = join(root, 'dsh')
  const executable = join(payload, relativeExecutable)
  mkdirSync(join(payload, 'node', 'bin'), { recursive: true })
  const source = pinned ? pinnedNode : null
  if (source) copyFileSync(source, executable)
  else writeFileSync(executable, 'interpreter fixture')
  const executableSha256 = source ? pinnedSha256 : stubSha256
  // A payload declares the pinned interpreter's version; a sealing process must then
  // be a build of those same pinned bytes.
  const declaredVersion = pinnedNodeVersion ?? nodeVersion
  const stage = { schemaVersion: 1, version: '0.1.7-rc.2', hostProtocolVersion: 4, pnpmVersion: '10.0.0',
    buildNodeVersion: declaredVersion, platform: process.platform, arch: process.arch }
  // `Sha256` is the archive digest the build records; `ExecutableSha256` and `RecordSha`
  // pin the extracted binary. The stand-in fixture keeps all three consistent with its
  // own bytes so the identity record is never self-contradictory.
  const node = { NodeVersion: declaredVersion, Target: targetName, Executable: `dsh/${relativeExecutable}`,
    Sha256: executableSha256, RecordSha: executableSha256, ExecutableSha256: executableSha256 }
  const stagePath = join(root, 'stage.json'), nodePath = join(root, 'node.json')
  writeFileSync(stagePath, JSON.stringify(stage)); writeFileSync(nodePath, JSON.stringify(node))
  for (const [name, version] of [['@deepseek-ai/dsh', '0.1.7-rc.2'], ['@deepseek-ai/dsh-desktop-host', '0.1.7-rc.2'], ['port-addon', '9.1.0']]) {
    const dir = join(payload, 'node_modules', ...name.split('/')); mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version }))
  }
  writeFileSync(join(payload, 'package.json'), JSON.stringify({ version: '0.1.7-rc.2', dependencies: {
    '@deepseek-ai/dsh': '0.1.7-rc.2', '@deepseek-ai/dsh-desktop-host': '0.1.7-rc.2', 'port-addon': '9.1.0',
  } }))
  writeFileSync(join(payload, 'runtime-payload.json'), JSON.stringify({ schemaVersion: 1, version: '0.1.7-rc.2',
    hostProtocolVersion: 4, node: { version: declaredVersion, target: targetName, sha256: executableSha256 } }))
  writeFileSync(join(payload, 'NODE-LICENSE.txt'), 'Node license')
  writeFileSync(join(payload, 'adapter.mjs'), 'export {}\n')
  return { root, payload, stage, node, stagePath, nodePath, executable, executableSha256, declaredVersion }
}

/**
 * Stand in for the trusted process observation of a fixture. The CLI always reads the
 * real `process`; only fixtures inject one, and it declares the pinned interpreter's
 * version for the same reason the payload record does. `execPath` defaults to the
 * fixture's own interpreter and may be pointed at any other path the caller hashed.
 */
const observedPinnedProcess = (f, execPath = f.executable) =>
  ({ ...process, versions: { ...process.versions, node: f.declaredVersion }, execPath })

/**
 * Bytes that are deliberately NOT the pinned interpreter. A negative built on
 * `process.execPath` silently becomes a positive whenever the suite runs under the pinned
 * build itself (the qualified Medium executor), so every byte mismatch is expressed with
 * this copy instead. It is only ever hashed or written into a payload, never executed.
 */
function alteredCopy(source, destination) {
  copyFileSync(source, destination)
  truncateSync(destination, statSync(destination).size - 1)
  return destination
}

/**
 * A qualified interpreter whose bytes differ from the pinned one, when this machine has
 * one; `null` means the CLI negatives must be carried by a wrong-claim record and by
 * altered payload bytes instead of by a second build.
 */
function findDifferentBuildNode() {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [process.env.DSH_RUNTIME_SEAL_DIFFERENT_NODE, process.execPath,
    join(programFiles, 'nodejs', 'node.exe'), '/usr/local/bin/node', '/usr/bin/node']
  if (pinnedNode) candidates.push(join(pinnedNode, '..', 'sysnode.exe'))
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      if (!statSync(candidate).isFile() || sha256Of(candidate) === pinnedSha256) continue
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
      if (probe.status !== 0 || !/^v\d+\.\d+\.\d+/u.test((probe.stdout ?? '').trim())) continue
      return candidate
    } catch { /* not a usable candidate; try the next one */ }
  }
  return null
}

test('identity rejects malformed data, wrong target, wrong Node and unsafe or tampered interpreters', { skip: pinnedNode === null }, () => {
  const f = fixture({ pinned: true })
  try {
    const args = { stage: f.stage, node: f.node, payloadRoot: f.payload, processInfo: observedPinnedProcess(f) }
    assert.equal(validateIdentity(args).nodeVersion, f.declaredVersion)
    assert.throws(() => validateIdentity({ ...args, stage: { ...f.stage, schemaVersion: 2 } }), /invalid stage identity/)
    assert.throws(() => validateIdentity({ ...args, node: { ...f.node, Target: 'wrong' } }), /target/)
    assert.throws(() => validateIdentity({ ...args, stage: { ...f.stage, arch: 'unsupported' } }), /architecture/)
    assert.throws(() => validateIdentity({ ...args, stage: { ...f.stage, hostProtocolVersion: '4' } }), /invalid stage identity/)
    assert.throws(() => validateIdentity({ ...args, node: { ...f.node, Executable: 'dsh/node/../node.exe' } }), /unsafe or unexpected/)
    assert.throws(() => validateIdentity({ ...args, node: { ...f.node, NodeVersion: '0.0.0' } }), /does not match pinned/)
    assert.throws(() => validateIdentity({ ...args, node: { ...f.node, RecordSha: 'b'.repeat(64) } }), /does not match its pinned hash/)
    assert.throws(() => validateIdentity({ ...args, node: { ...f.node, RecordSha: 'nonsense' } }), /invalid pinned Node identity/)
    assert.throws(() => validateIdentity({ ...args, node: { ...f.node, ExecutableSha256: 'c'.repeat(64) } }), /pinned executable digest/)
    // A byte-identical interpreter at a DIFFERENT absolute path is the trusted outside
    // copy the Windows build executes, so differing paths are no rejection reason: when
    // the executing build is the pinned one this exact observation must be ACCEPTED.
    const outside = resolve(process.execPath)
    assert.notEqual(outside.toLowerCase(), resolve(f.executable).toLowerCase(), 'the fixture keeps the pinned bytes elsewhere')
    if (sha256Of(process.execPath) === f.executableSha256) {
      assert.equal(validateIdentity({ ...args, processInfo: observedPinnedProcess(f, outside) }).nodeVersion, f.declaredVersion)
    } else {
      assert.throws(() => validateIdentity({ ...args, processInfo: observedPinnedProcess(f, outside) }),
        /running executable bytes do not match the pinned payload interpreter/)
    }
    // Bytes that differ are refused whatever build executes the suite.
    const altered = alteredCopy(f.executable, join(f.root, 'altered-node.exe'))
    assert.notEqual(sha256Of(altered), f.executableSha256, 'the altered copy is not the pinned interpreter')
    assert.throws(() => validateIdentity({ ...args, processInfo: observedPinnedProcess(f, altered) }),
      /running executable bytes do not match the pinned payload interpreter/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('identity refuses a symlinked payload interpreter', t => {
  const f = fixture()
  const real = join(f.root, 'node-real.exe')
  try {
    writeFileSync(real, 'interpreter fixture')
    rmSync(f.executable, { force: true })
    let linked = true
    try { symlinkSync(real, f.executable) } catch { linked = false }
    // Windows refuses file symlinks without Developer Mode or elevation, but a
    // directory junction is the same reparse-point class the payload guard rejects.
    if (!linked) {
      const container = join(f.root, 'link-container')
      mkdirSync(container, { recursive: true })
      rmSync(join(f.payload, 'node'), { recursive: true, force: true })
      try { symlinkSync(container, join(f.payload, 'node'), 'junction') } catch (error) { t.skip(`link creation unavailable: ${error.code}`); return }
    }
    assert.ok(lstatSync(linked ? f.executable : join(f.payload, 'node')).isSymbolicLink(), 'the fixture carries a reparse point')
    assert.throws(() => validateIdentity({ stage: f.stage, node: f.node, payloadRoot: f.payload,
      processInfo: observedPinnedProcess(f) }), /cannot hash interpreter bytes|expected a bounded nonempty regular file/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('upstream writer inventories final additions and verifies without resealing', async () => {
  const f = fixture({ pinned: true })
  try {
    const processInfo = observedPinnedProcess(f)
    const first = await sealRuntime({ upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo })
    const descriptorPath = join(f.payload, 'desktop-runtime.json')
    const descriptorText = readFileSync(descriptorPath, 'utf8')
    assert.ok(first.files.some(file => file.path === 'NODE-LICENSE.txt'))
    assert.ok(first.files.some(file => file.path === 'runtime-payload.json'))
    assert.ok(first.files.some(file => file.path === 'node_modules/port-addon/package.json'))
    assert.equal(first.sharedPackages.find(item => item.name === 'port-addon').version, '9.1.0')
    const second = await sealRuntime({ upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo })
    assert.deepEqual(second, first)
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptorText)
    await sealRuntime({ upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, verify: true, processInfo })
    writeFileSync(join(f.payload, 'adapter.mjs'), 'changed')
    await assert.rejects(sealRuntime({ upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, verify: true, processInfo }), /integrity verification failed/)
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptorText, 'verify mode never rewrites damaged descriptor')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('release-owned package manifests must match the stage release before writing', async () => {
  const f = fixture({ pinned: true })
  try {
    writeFileSync(join(f.payload, 'node_modules/@deepseek-ai/dsh-desktop-host/package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-desktop-host', version: '8.0.0' }))
    await assert.rejects(sealRuntime({ upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo: observedPinnedProcess(f) }), /mismatched release-owned package/)
    assert.equal(existsSync(join(f.payload, 'desktop-runtime.json')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('verify-only rejects other release fields and omitted shared dependencies without rewriting', async () => {
  const f = fixture({ pinned: true })
  try {
    const args = { upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo: observedPinnedProcess(f) }
    const descriptor = await sealRuntime(args)
    const descriptorPath = join(f.payload, 'desktop-runtime.json')
    for (const [alter, expected] of [
      [value => { value.release.pnpmVersion = '99.0.0' }, /release identity mismatch/],
      [value => { value.sharedPackages = value.sharedPackages.filter(entry => entry.name !== 'port-addon') }, /shared package set mismatch/],
    ]) {
      const value = structuredClone(descriptor)
      alter(value)
      const tampered = JSON.stringify(value)
      writeFileSync(descriptorPath, tampered)
      await assert.rejects(sealRuntime({ ...args, verify: true }), expected)
      assert.equal(readFileSync(descriptorPath, 'utf8'), tampered)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('an empty license or mismatched archive identity produces no descriptor', { skip: pinnedNode === null }, async () => {
  const f = fixture({ pinned: true })
  try {
    const args = { upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo: observedPinnedProcess(f) }
    writeFileSync(join(f.payload, 'NODE-LICENSE.txt'), '')
    await assert.rejects(sealRuntime(args), /nonempty regular file/)
    assert.equal(existsSync(join(f.payload, 'desktop-runtime.json')), false)
    writeFileSync(join(f.payload, 'NODE-LICENSE.txt'), 'Node license')
    const manifestPath = join(f.payload, 'runtime-payload.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.node.sha256 = 'f'.repeat(64)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    await assert.rejects(sealRuntime(args), /runtime-payload.json release or pinned Node identity mismatch/)
    assert.equal(existsSync(join(f.payload, 'desktop-runtime.json')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('payload interpreter bytes are pinned: tampering is refused', async () => {
  const f = fixture()
  try {
    const args = { upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo: observedPinnedProcess(f) }
    writeFileSync(f.executable, 'tampered interpreter')
    await assert.rejects(sealRuntime(args), /running executable bytes do not match the pinned payload interpreter|pinned executable digest/)
    assert.equal(existsSync(join(f.payload, 'desktop-runtime.json')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('a payload node that differs from the pinned interpreter bytes produces no descriptor', { skip: pinnedNode === null }, async () => {
  const f = fixture({ pinned: true })
  try {
    const args = { upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo: observedPinnedProcess(f) }
    writeFileSync(f.executable, 'a different interpreter build')
    await assert.rejects(sealRuntime(args), /running executable bytes do not match the pinned payload interpreter|pinned executable digest/)
    assert.equal(existsSync(join(f.payload, 'desktop-runtime.json')), false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('large real-file inventory seals while identity and inventory documents retain distinct limits', async () => {
  const f = fixture({ pinned: true })
  try {
    const args = { upstreamRoot: upstream, payloadRoot: f.payload, stageIdentityPath: f.stagePath,
      nodeIdentityPath: f.nodePath, processInfo: observedPinnedProcess(f) }
    const directory = join(f.payload, 'node_modules/port-addon/data')
    mkdirSync(directory, { recursive: true })
    const inventory = []
    for (let index = 0; index < 7000; index++) {
      const name = `asset-${String(index).padStart(5, '0')}-${'x'.repeat(65)}.txt`
      writeFileSync(join(directory, name), '')
      inventory.push({ Path: `node_modules/port-addon/data/${name}`, Bytes: 0,
        Sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' })
    }
    const manifestPath = join(f.payload, 'runtime-payload.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.files = inventory
    const text = JSON.stringify(manifest)
    assert.ok(Buffer.byteLength(text) > 1024 * 1024, 'fixture exercises a genuinely large inventory')
    writeFileSync(manifestPath, text)
    const descriptor = await sealRuntime(args)
    assert.ok(descriptor.files.length >= 7000)
    const descriptorPath = join(f.payload, 'desktop-runtime.json')
    const sealed = readFileSync(descriptorPath, 'utf8')
    await sealRuntime({ ...args, verify: true })
    assert.equal(readFileSync(descriptorPath, 'utf8'), sealed)
    writeFileSync(f.nodePath, JSON.stringify({ ...f.node, extra: 'x'.repeat(1024 * 1024) }))
    await assert.rejects(sealRuntime({ ...args, verify: true }), /Node identity:.*bounded regular file/)
    writeFileSync(f.nodePath, JSON.stringify(f.node))
    truncateSync(manifestPath, 64 * 1024 * 1024 + 1)
    await assert.rejects(sealRuntime({ ...args, verify: true }), /runtime-payload.json:.*bounded regular file/)
    assert.equal(readFileSync(descriptorPath, 'utf8'), sealed, 'size rejection never rewrites sealed metadata')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('real payload interpreter seals, verifies after relocation, and refuses byte, claim and content mismatches', { skip: pinnedNode === null }, () => {
  const f = fixture({ pinned: true })
  const temporary = join(f.root, 'temp')
  mkdirSync(temporary, { recursive: true })
  try {
    // The sealing process is the pinned build; only WHERE it is executed from varies.
    const invoke = (executable, payload, verify, nodeIdentityPath = f.nodePath) => spawnSync(executable, ['--import', 'tsx/esm', cli,
      ...(verify ? ['--verify'] : []), upstream, payload, f.stagePath, nodeIdentityPath],
    { cwd: upstream, stdio: 'inherit', env: { ...process.env, TEMP: temporary, TMP: temporary } })
    assert.equal(invoke(f.executable, f.payload, false).status, 0)
    const published = join(f.root, 'published')
    renameSync(f.payload, published)
    const publishedExecutable = join(published, relativeExecutable)
    assert.equal(invoke(publishedExecutable, published, true).status, 0, 'a relocated payload verifies under its own bytes')
    const descriptorPath = join(published, 'desktop-runtime.json')
    const descriptor = readFileSync(descriptorPath, 'utf8')

    // The CLI has no process-path override. A DIFFERENT build is refused when this machine
    // has one; when the executor already IS the pinned build, that build is the accepted
    // case asserted above and the byte/claim negatives below carry the refusal proof.
    const different = findDifferentBuildNode()
    if (different) {
      assert.equal(invoke(different, published, true).status, 1, `a different interpreter build is refused (${different})`)
      assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor)
    }

    // Payload bytes that are not the interpreter the CLI runs under are refused. The
    // truncated payload is hashed only: the CLI itself runs the pinned interpreter.
    const nodeBytes = statSync(publishedExecutable).size
    truncateSync(publishedExecutable, nodeBytes - 1)
    assert.equal(invoke(pinnedNode, published, true).status, 1, 'payload interpreter bytes must match the running image')
    assert.equal(invoke(pinnedNode, published, false).status, 1, 'a refused seal leaves the sealed descriptor untouched')
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor)
    copyFileSync(pinnedNode, publishedExecutable)

    // A wrong executable claim in the staged record is refused with the bytes unchanged.
    const wrongClaim = join(f.root, 'node-identity-wrong-claim.json')
    writeFileSync(wrongClaim, JSON.stringify({ ...f.node, ExecutableSha256: 'd'.repeat(64) }))
    assert.equal(invoke(pinnedNode, published, true, wrongClaim).status, 1, 'a wrong claimed interpreter digest is refused')
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor)

    // Content tampering is still caught by the sealed inventory.
    writeFileSync(join(published, 'adapter.mjs'), 'tampered payload')
    assert.equal(invoke(publishedExecutable, published, true).status, 1)
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor, 'failed verification cannot repair the descriptor')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

/**
 * The Windows build never executes the payload copy: `Resolve-DshTrustedExecutionNode`
 * copies the archive-pinned bytes to a Medium root outside the workspace and runs
 * those. The seal must therefore accept a DIFFERENT absolute path whose bytes are the
 * pinned interpreter, and must still refuse a different build or a tampered payload.
 */
test('a byte-identical trusted copy outside the payload seals and verifies', { skip: pinnedNode === null }, () => {
  const f = fixture({ pinned: true })
  const temporary = join(f.root, 'temp')
  mkdirSync(temporary, { recursive: true })
  try {
    assert.notEqual(resolve(pinnedNode), resolve(f.executable), 'the fixture keeps the pinned bytes at a different path')
    assert.equal(sha256Of(pinnedNode), f.executableSha256, 'fixture payload bytes are the pinned interpreter')
    const invoke = (executable, payload, verify, nodeIdentityPath = f.nodePath) => spawnSync(executable, ['--import', 'tsx/esm', cli,
      ...(verify ? ['--verify'] : []), upstream, payload, f.stagePath, nodeIdentityPath],
    { cwd: upstream, stdio: 'inherit', env: { ...process.env, TEMP: temporary, TMP: temporary } })
    assert.equal(invoke(pinnedNode, f.payload, false).status, 0, 'an outside byte-identical copy seals the payload')
    const descriptorPath = join(f.payload, 'desktop-runtime.json')
    const descriptor = readFileSync(descriptorPath, 'utf8')
    assert.equal(invoke(pinnedNode, f.payload, true).status, 0, 'the same outside copy verifies without rewriting')
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor)

    // Only the bytes decide: the outside path is accepted, altered bytes are refused. The
    // direct validator call is used so the negative never depends on a second build being
    // installed, and the altered copy is hashed only, never executed.
    const args = { stage: f.stage, node: f.node, payloadRoot: f.payload, processInfo: observedPinnedProcess(f, pinnedNode) }
    assert.equal(validateIdentity(args).nodeVersion, f.declaredVersion, 'outside path with pinned bytes is accepted')
    const altered = alteredCopy(f.executable, join(f.root, 'altered-outside-node.exe'))
    assert.notEqual(sha256Of(altered), f.executableSha256, 'the altered outside copy is not the pinned interpreter')
    assert.throws(() => validateIdentity({ ...args, processInfo: observedPinnedProcess(f, altered) }),
      /running executable bytes do not match the pinned payload interpreter/)

    // A wrong executable claim in the staged record is refused with the bytes unchanged.
    const wrongClaim = join(f.root, 'node-identity-wrong-claim.json')
    writeFileSync(wrongClaim, JSON.stringify({ ...f.node, ExecutableSha256: 'd'.repeat(64) }))
    assert.equal(invoke(pinnedNode, f.payload, true, wrongClaim).status, 1, 'a wrong claimed interpreter digest is refused')
    assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor)

    // A second, genuinely different build is refused when this machine has one.
    const different = findDifferentBuildNode()
    if (different) {
      assert.equal(invoke(different, f.payload, true).status, 1, `a different interpreter build is refused by bytes (${different})`)
      assert.equal(readFileSync(descriptorPath, 'utf8'), descriptor)
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
