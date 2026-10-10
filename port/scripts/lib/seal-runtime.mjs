#!/usr/bin/env node
/** Seal or verify the final payload with upstream's descriptor APIs and the pinned interpreter bytes. */
import { createHash } from 'node:crypto'
import { readFileSync, lstatSync, readdirSync } from 'node:fs'
import { resolve, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

const DSH = '@deepseek-ai/dsh'
const HOST = '@deepseek-ai/dsh-desktop-host'
const TARGETS = { 'win32-x64': 'win-x64', 'win32-arm64': 'win-arm64', 'darwin-x64': 'darwin-x64', 'darwin-arm64': 'darwin-arm64', 'linux-x64': 'linux-x64', 'linux-arm64': 'linux-arm64' }

const IDENTITY_JSON_LIMIT = 1024 * 1024
const SHA256 = /^[0-9a-f]{64}$/u
// The pinned interpreter is ~86 MiB today; a bounded ceiling still refuses a
// stream that keeps growing while it is read.
const INTERPRETER_LIMIT = 512 * 1024 * 1024
// A shipped file inventory is much larger than an identity/package document.
// Match the native descriptor-loader budget without relaxing small inputs.
const INVENTORY_JSON_LIMIT = 64 * IDENTITY_JSON_LIMIT
function json(path, label, limit = IDENTITY_JSON_LIMIT) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('expected a bounded regular file')
    const body = readFileSync(path)
    if (body.length > limit) throw new Error('file grew beyond the limit')
    return JSON.parse(body.toString('utf8'))
  } catch (error) { throw new Error(`${label}: cannot read valid JSON (${error.message})`) }
}

function record(value) { return typeof value === 'object' && value !== null && !Array.isArray(value) }

function rejectLinks(root) {
  const rootStat = lstatSync(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('payload root must be a materialized directory')
  const visit = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      const stat = lstatSync(file)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error(`unsupported payload entry ${relative(root, file)}`)
      if (stat.isDirectory()) visit(file)
    }
  }
  visit(root)
}

/**
 * Hash one regular, non-symlink interpreter file while it is read.
 * @param {string} path - Candidate interpreter path.
 * @param {string} label - Caller-facing name used in refusals.
 * @returns {string} Lowercase SHA-256 of the bytes that were read.
 */
function executableSha256(path, label) {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > INTERPRETER_LIMIT) {
      throw new Error('expected a bounded nonempty regular file')
    }
    const body = readFileSync(path)
    if (body.length !== stat.size) throw new Error('file changed size while it was read')
    return createHash('sha256').update(body).digest('hex')
  } catch (error) { throw new Error(`${label}: cannot hash interpreter bytes (${error.message})`) }
}

/**
 * Validate staging identity against one observed interpreter; no build-host version fallback.
 *
 * The pinned interpreter is accepted by its final bytes, never by where the process
 * image happens to live: the Windows build executes a trusted, byte-identical copy
 * outside the Low-labelled workspace (see `Resolve-DshTrustedExecutionNode`), so a
 * path-equality rule would refuse the very interpreter the payload ships. The payload
 * file and the running executable must therefore hash to each other, and the pinned
 * version, target, platform/architecture and relative executable path must still hold.
 *
 * `Sha256` in the staged Node identity is the digest of the archive the interpreter was
 * extracted from (`Install-DshPinnedNode` records the archive digest), so it is compared
 * against the payload manifest's own archive record rather than against the binary.
 * When an identity ALSO carries `ExecutableSha256`, both observed files must equal it.
 *
 * @param {object} input - Records, actual dsh payload directory, and trusted process observation.
 * @returns {object} Release and target facts; production callers use the default current process.
 */
export function validateIdentity({ stage, node, payloadRoot, processInfo = process }) {
  if (!record(stage) || stage.schemaVersion !== 1 || typeof stage.version !== 'string' || typeof stage.pnpmVersion !== 'string'
    || !Number.isSafeInteger(stage.hostProtocolVersion) || typeof stage.platform !== 'string' || typeof stage.arch !== 'string') {
    throw new Error('invalid stage identity')
  }
  if (!record(node) || typeof node.NodeVersion !== 'string' || typeof node.Target !== 'string'
    || typeof node.Executable !== 'string' || !SHA256.test(node.Sha256 ?? '')) throw new Error('invalid pinned Node identity')
  for (const field of ['RecordSha', 'ExecutableSha256']) {
    if (node[field] !== undefined && !SHA256.test(node[field])) throw new Error('invalid pinned Node identity')
  }
  // A fixture that records the observation hash must agree with the pin it backs; two
  // independently carried digests of the same file may never disagree.
  if (node.RecordSha !== undefined && node.RecordSha !== node.Sha256) {
    throw new Error('pinned Node identity records an observation hash that does not match its pinned hash')
  }
  if (processInfo.versions.node !== node.NodeVersion) throw new Error(`running Node ${processInfo.versions.node} does not match pinned ${node.NodeVersion}`)
  if (processInfo.platform !== stage.platform || processInfo.arch !== stage.arch) throw new Error('running platform/architecture does not match stage identity')
  if (node.Target !== TARGETS[`${processInfo.platform}-${processInfo.arch}`]) throw new Error('pinned Node target does not match running platform/architecture')
  const executable = processInfo.platform === 'win32' ? 'node/node.exe' : 'node/bin/node'
  if (node.Executable !== `dsh/${executable}`) throw new Error('unsafe or unexpected pinned Node executable path')
  const expected = resolve(payloadRoot, executable)
  const payloadHash = executableSha256(expected, 'pinned payload interpreter')
  const runningHash = executableSha256(processInfo.execPath, 'running executable')
  if (runningHash !== payloadHash) throw new Error('running executable bytes do not match the pinned payload interpreter')
  if (node.ExecutableSha256 !== undefined && payloadHash !== node.ExecutableSha256) {
    throw new Error('pinned payload interpreter bytes do not match the pinned executable digest')
  }
  return { version: stage.version, nodeVersion: node.NodeVersion, pnpmVersion: stage.pnpmVersion,
    hostProtocolVersion: stage.hostProtocolVersion, platform: stage.platform, arch: stage.arch }
}

/**
 * Seal final bytes or verify an existing descriptor without rewriting it.
 * @param {object} input - Upstream sources, actual dsh directory, stage records, and operation mode.
 * @returns {Promise<object>} Verified upstream descriptor. Injected processInfo is for trusted fixture
 * observations only; its execPath must hold the interpreter bytes the payload ships, wherever a
 * fixture keeps them, because a byte-identical outside execution copy is what the Windows build uses.
 */
export async function sealRuntime({ upstreamRoot, payloadRoot, stageIdentityPath, nodeIdentityPath, verify = false, processInfo = process }) {
  const upstream = resolve(upstreamRoot), root = resolve(payloadRoot)
  rejectLinks(root)
  const node = json(nodeIdentityPath, 'Node identity')
  const identity = validateIdentity({ stage: json(stageIdentityPath, 'stage identity'), node, payloadRoot: root, processInfo })
  const [{ writeDesktopRuntime, verifyDesktopRuntime, runtimePath }, { parseDesktopRelease }, { DESKTOP_HOST_PACKAGE }] = await Promise.all([
    import(pathToFileURL(join(upstream, 'apps/desktop/src/runtime-tree.ts'))),
    import(pathToFileURL(join(upstream, 'apps/desktop/src/release.ts'))),
    import(pathToFileURL(join(upstream, 'apps/desktop/src/core-package-set.ts'))),
  ])
  const release = parseDesktopRelease({ schemaVersion: 1, version: identity.version,
    hostProtocolVersion: identity.hostProtocolVersion, nodeVersion: identity.nodeVersion, pnpmVersion: identity.pnpmVersion })
  if (DESKTOP_HOST_PACKAGE !== HOST) throw new Error('desktop host package authority mismatch')
  const payloadManifest = json(join(root, 'runtime-payload.json'), 'runtime-payload.json', INVENTORY_JSON_LIMIT)
  if (!record(payloadManifest) || payloadManifest.schemaVersion !== 1 || payloadManifest.version !== identity.version
    || String(payloadManifest.hostProtocolVersion) !== String(identity.hostProtocolVersion)
    || payloadManifest.node?.version !== identity.nodeVersion || payloadManifest.node?.target !== node.Target
    || payloadManifest.node?.sha256 !== node.Sha256) {
    throw new Error('runtime-payload.json release or pinned Node identity mismatch')
  }
  const license = lstatSync(join(root, 'NODE-LICENSE.txt'))
  if (!license.isFile() || license.isSymbolicLink() || license.size === 0) throw new Error('Node license must be a nonempty regular file')
  const packageRoot = json(join(root, 'package.json'), 'payload package.json')
  if (!record(packageRoot) || packageRoot.version !== identity.version || !record(packageRoot.dependencies)) throw new Error('payload package.json has no matching dependency manifest')
  const names = Object.keys(packageRoot.dependencies).sort()
  for (const name of [DSH, HOST]) {
    if (packageRoot.dependencies[name] !== identity.version) throw new Error(`missing or mismatched release-owned package ${name}`)
  }
  for (const name of names) {
    const manifest = json(runtimePath(root, `node_modules/${name}/package.json`), `${name} package.json`)
    if (!record(manifest) || manifest.name !== name || manifest.version !== packageRoot.dependencies[name]) {
      throw new Error(`missing or mismatched release-owned package ${name}`)
    }
  }
  // Upstream validates package names and SemVers, then verifies the sealed bytes.
  if (!verify) writeDesktopRuntime(root, release, names, { platform: identity.platform, arch: identity.arch })
  const descriptor = await verifyDesktopRuntime(root, identity.version, { platform: identity.platform, arch: identity.arch })
  const observedRelease = parseDesktopRelease(descriptor.release)
  for (const key of Object.keys(release)) {
    if (observedRelease[key] !== release[key]) throw new Error('desktop runtime: release identity mismatch')
  }
  if (JSON.stringify(descriptor.sharedPackages.map(entry => entry.name).sort()) !== JSON.stringify(names)) throw new Error('desktop runtime: shared package set mismatch')
  for (const entry of descriptor.sharedPackages) {
    if (entry.version !== packageRoot.dependencies[entry.name]) throw new Error(`desktop runtime: dependency version mismatch for ${entry.name}`)
  }
  return descriptor
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const verify = args[0] === '--verify'
  if (verify) args.shift()
  if (args.length !== 4) throw new Error('usage: seal-runtime.mjs [--verify] <upstreamRoot> <dshPayloadRoot> <stageIdentity.json> <nodeIdentity.json>')
  sealRuntime({ upstreamRoot: args[0], payloadRoot: args[1], stageIdentityPath: args[2], nodeIdentityPath: args[3], verify })
    .then(() => console.log(verify ? 'desktop runtime verified' : 'desktop runtime sealed'))
    .catch(error => { console.error(error); process.exitCode = 1 })
}
