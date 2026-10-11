import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const SHA256 = /^[0-9a-f]{64}$/u
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u
const TARBALL = /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u

function fail(message) {
  throw new Error(`runtime lock inputs: ${message}`)
}

function readRegularFile(path, label) {
  let stat
  try { stat = lstatSync(path) } catch (error) { fail(`${label} is missing or unreadable (${error.message})`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular, non-linked file`)
  return readFileSync(path)
}

function assertRealDirectory(path, label) {
  let stat
  try { stat = lstatSync(path) } catch (error) { fail(`${label} is missing or unreadable (${error.message})`) }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${label} must be a real directory`)
}

function assertInputLayout(inputRoot) {
  assertRealDirectory(inputRoot, 'reviewed input root')
  const expected = ['descriptor.json', 'desktop-packages', 'desktop-packages.json', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']
  const actual = readdirSync(inputRoot).sort()
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail('reviewed input directory has missing or unexpected entries')
  assertRealDirectory(join(inputRoot, 'desktop-packages'), 'reviewed desktop-packages directory')
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function sha512Integrity(bytes) {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')) } catch (error) { fail(`${label} is invalid JSON (${error.message})`) }
}

function relativeTarball(record) {
  if (!record || typeof record.file !== 'string' || !TARBALL.test(record.file)) {
    fail('package metadata contains an unsafe local tarball name')
  }
  return `desktop-packages/${record.file}`
}

function inspectProject(projectRoot, { requireLock = true } = {}) {
  const lockPath = join(projectRoot, 'pnpm-lock.yaml')
  const lockBytes = existsSync(lockPath) ? readRegularFile(lockPath, 'pnpm-lock.yaml') : null
  if (requireLock && lockBytes === null) fail('pnpm-lock.yaml is missing')
  const policyBytes = readRegularFile(join(projectRoot, 'pnpm-workspace.yaml'), 'pnpm-workspace.yaml')
  const packageBytes = readRegularFile(join(projectRoot, 'package.json'), 'package.json')
  const packageSetBytes = readRegularFile(join(projectRoot, 'desktop-packages.json'), 'desktop-packages.json')
  const packageRoot = parseJson(packageBytes, 'package.json')
  const packageSet = parseJson(packageSetBytes, 'desktop-packages.json')
  if (!packageRoot || typeof packageRoot !== 'object' || !packageRoot.dependencies || typeof packageRoot.dependencies !== 'object') {
    fail('package.json must declare a dependencies object')
  }
  if (!packageSet || packageSet.schemaVersion !== 1 || !Array.isArray(packageSet.packages)) {
    fail('desktop-packages.json is invalid')
  }

  const records = [...packageSet.packages].sort((left, right) => left.name.localeCompare(right.name))
  if (JSON.stringify(records) !== JSON.stringify(packageSet.packages)) fail('desktop package records must be sorted by package name')
  const names = new Set()
  const files = new Set()
  const tarballs = []
  for (const record of records) {
    if (!record || typeof record.name !== 'string' || typeof record.version !== 'string'
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !SHA512_INTEGRITY.test(record.integrity ?? '')) {
      fail('desktop package metadata has an invalid record')
    }
    const path = relativeTarball(record)
    if (names.has(record.name) || files.has(record.file)) fail('desktop package metadata has duplicate names or tarballs')
    names.add(record.name)
    files.add(record.file)
    if (packageRoot.dependencies[record.name] !== `file:./${path}`) {
      fail(`package.json does not use the stable relative tarball path ${path}`)
    }
    const projectTarball = readRegularFile(join(projectRoot, path), path)
    if (projectTarball.byteLength !== record.bytes || sha512Integrity(projectTarball) !== record.integrity) {
      fail(`local tarball integrity mismatch: ${path}`)
    }
    if (lockBytes && !lockBytes.includes(record.file)) fail(`lockfile omits local tarball ${record.file}`)
    tarballs.push({ path, name: record.name, version: record.version, bytes: record.bytes, integrity: record.integrity })
  }
  if (names.size !== Object.keys(packageRoot.dependencies).length) {
    fail('package.json dependency names do not match the local package set')
  }
  const packageFiles = readdirSync(join(projectRoot, 'desktop-packages')).sort()
  if (JSON.stringify(packageFiles) !== JSON.stringify([...files].sort())) {
    fail('desktop-packages directory does not exactly match desktop-packages.json')
  }
  if (/(?:^|[\s"'=])(?:[A-Za-z]:[\\/]|\\\\)/mu.test(lockBytes?.toString('utf8') ?? '')) {
    fail('lockfile contains a machine-specific absolute path')
  }
  return { lockBytes, policyBytes, packageBytes, packageSetBytes, tarballs }
}

function buildPolicyEntries(policyText) {
  if (!/^strictDepBuilds:\s*true\s*$/mu.test(policyText)) fail('workspace policy must set strictDepBuilds: true')
  if (!/^nodeLinker:\s*hoisted\s*$/mu.test(policyText) || !/^autoInstallPeers:\s*false\s*$/mu.test(policyText)) {
    fail('workspace policy lost upstream hoisted-linker settings')
  }
  const block = policyText.match(/^allowBuilds:\s*\r?\n(?<body>(?:[ \t]{2}.+\r?\n)+)/mu)?.groups?.body
  if (!block) fail('workspace policy has no explicit allowBuilds map')
  const entries = new Map()
  for (const line of block.trimEnd().split(/\r?\n/u)) {
    const pair = line.match(/^  (?:"([^"]+)"|'([^']+)'|([^:]+)):\s*(true|false)\s*$/u)
    if (!pair) fail('workspace allowBuilds map contains an unsupported entry')
    const key = pair[1] ?? pair[2] ?? pair[3].trim()
    if (entries.has(key)) fail(`workspace allowBuilds repeats ${key}`)
    entries.set(key, pair[4] === 'true')
  }
  const required = new Map([
    ['node-pty', true], ['koffi', true], ['fs-ext', true],
    ['@google/genai', false], ['protobufjs', false], ['node-addon-require-builtin', false],
  ])
  for (const [key, expected] of required) {
    if (entries.get(key) !== expected) fail(`workspace allowBuilds policy must set ${key}: ${expected}`)
  }
  const nativeCore = [...entries].filter(([key, allowed]) => key.startsWith('@deepseek-ai/dsh-subprocess-local') && allowed)
  if (nativeCore.length !== 1 || entries.size !== required.size + 1) {
    fail('workspace allowBuilds must preserve exactly the upstream native allow-list and known denials')
  }
  const coreKey = nativeCore[0][0]
  if (coreKey !== '@deepseek-ai/dsh-subprocess-local' && !coreKey.startsWith('@deepseek-ai/dsh-subprocess-local@file:desktop-packages/')) {
    fail('workspace allowBuilds has an unstable core native-build key')
  }
}

/** Create a portable candidate descriptor; this never marks an input reviewed. */
export function createRuntimeLockDescriptor({ projectRoot, target, upstreamCommit, pnpmVersion }) {
  const project = inspectProject(projectRoot)
  buildPolicyEntries(project.policyBytes.toString('utf8'))
  if (!/^[0-9a-f]{40}$/u.test(upstreamCommit ?? '')) fail('upstream commit must be a full lowercase Git object id')
  if (!/^\d+\.\d+\.\d+$/u.test(pnpmVersion ?? '')) fail('pnpm version must be an exact semantic version')
  if (target !== 'win-x64') fail(`no reviewed lock target exists for ${target}; only win-x64 may be qualified`)
  return {
    schemaVersion: 1,
    reviewStatus: 'CANDIDATE',
    target,
    upstreamCommit,
    pnpmVersion,
    lockSha256: sha256(project.lockBytes),
    workspacePolicySha256: sha256(project.policyBytes),
    packageJsonSha256: sha256(project.packageBytes),
    packageSetSha256: sha256(project.packageSetBytes),
    tarballs: project.tarballs,
  }
}

/** Validate every reviewed identity, then copy its unchanged lock into a fresh project. */
export function validateRuntimeLockInputs({ inputRoot, projectRoot, target, upstreamCommit, pnpmVersion }) {
  if (target !== 'win-x64') fail(`target ${target} is explicitly unqualified; only win-x64 is reviewed`)
  assertInputLayout(inputRoot)
  const descriptorBytes = readRegularFile(join(inputRoot, 'descriptor.json'), 'descriptor.json')
  const descriptor = parseJson(descriptorBytes, 'descriptor.json')
  if (!descriptor || descriptor.schemaVersion !== 1 || descriptor.reviewStatus !== 'REVIEWED') {
    fail('descriptor is not REVIEWED; candidate inputs cannot be consumed by normal staging')
  }
  if (descriptor.target !== target) fail(`target mismatch (expected ${target}, found ${descriptor.target})`)
  if (descriptor.upstreamCommit !== upstreamCommit) fail(`upstream commit mismatch (expected ${upstreamCommit}, found ${descriptor.upstreamCommit})`)
  if (descriptor.pnpmVersion !== pnpmVersion) fail(`pnpm version mismatch (expected ${pnpmVersion}, found ${descriptor.pnpmVersion})`)

  const project = inspectProject(projectRoot, { requireLock: false })
  const lockBytes = readRegularFile(join(inputRoot, 'pnpm-lock.yaml'), 'pnpm-lock.yaml')
  const policyBytes = readRegularFile(join(inputRoot, 'pnpm-workspace.yaml'), 'pnpm-workspace.yaml')
  const packageBytes = readRegularFile(join(inputRoot, 'package.json'), 'package.json')
  const packageSetBytes = readRegularFile(join(inputRoot, 'desktop-packages.json'), 'desktop-packages.json')
  if (sha256(lockBytes) !== descriptor.lockSha256) fail('lockfile digest does not match the descriptor')
  if (sha256(policyBytes) !== descriptor.workspacePolicySha256) fail('workspace policy digest does not match the descriptor')
  if (sha256(packageBytes) !== descriptor.packageJsonSha256) fail('package metadata digest does not match the descriptor')
  if (sha256(packageSetBytes) !== descriptor.packageSetSha256) fail('dependency metadata digest does not match the descriptor')
  if (!policyBytes.equals(project.policyBytes) || !packageBytes.equals(project.packageBytes) || !packageSetBytes.equals(project.packageSetBytes)) {
    fail('generated project metadata differs from reviewed lock inputs')
  }
  if (JSON.stringify(descriptor.tarballs) !== JSON.stringify(project.tarballs)) {
    fail('local tarball identities differ from the reviewed descriptor')
  }
  for (const record of project.tarballs) {
    const bytes = readRegularFile(join(inputRoot, record.path), record.path)
    if (bytes.byteLength !== record.bytes || sha512Integrity(bytes) !== record.integrity) {
      fail(`reviewed local tarball integrity mismatch: ${record.path}`)
    }
  }
  const expectedTarballFiles = project.tarballs.map(record => record.path.slice('desktop-packages/'.length)).sort()
  const actualTarballFiles = readdirSync(join(inputRoot, 'desktop-packages')).sort()
  if (JSON.stringify(actualTarballFiles) !== JSON.stringify(expectedTarballFiles)) {
    fail('reviewed tarball directory does not exactly match the descriptor')
  }
  buildPolicyEntries(policyBytes.toString('utf8'))

  const projectLockPath = join(projectRoot, 'pnpm-lock.yaml')
  if (existsSync(projectLockPath)) fail('fresh project unexpectedly already has a lockfile')
  copyFileSync(join(inputRoot, 'pnpm-lock.yaml'), projectLockPath)
  const copiedLock = readRegularFile(projectLockPath, 'copied pnpm-lock.yaml')
  if (!copiedLock.equals(lockBytes)) fail('copied lockfile differs from the reviewed bytes')
  return {
    descriptorSha256: sha256(descriptorBytes),
    lockSha256: sha256(lockBytes),
    workspacePolicySha256: sha256(policyBytes),
    packageJsonSha256: sha256(packageBytes),
    packageSetSha256: sha256(packageSetBytes),
    target,
    upstreamCommit,
    pnpmVersion,
    tarballCount: project.tarballs.length,
  }
}

/** Copy a generated resolution into an empty candidate directory without blessing it. */
export function writeRuntimeLockCandidate({ projectRoot, candidateRoot, target, upstreamCommit, pnpmVersion }) {
  if (existsSync(candidateRoot)) fail(`candidate output already exists and is preserved: ${candidateRoot}`)
  const descriptor = createRuntimeLockDescriptor({ projectRoot, target, upstreamCommit, pnpmVersion })
  mkdirSync(candidateRoot)
  mkdirSync(join(candidateRoot, 'desktop-packages'))
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'desktop-packages.json']) {
    copyFileSync(join(projectRoot, name), join(candidateRoot, name))
  }
  for (const record of descriptor.tarballs) {
    copyFileSync(join(projectRoot, record.path), join(candidateRoot, record.path))
  }
  writeFileSync(join(candidateRoot, 'descriptor.json'), `${JSON.stringify(descriptor, null, 2)}\n`, { flag: 'wx' })
  return descriptor
}
