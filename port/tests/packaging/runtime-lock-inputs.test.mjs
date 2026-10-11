import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { createRuntimeLockDescriptor, validateRuntimeLockInputs, writeRuntimeLockCandidate } from '../../scripts/lib/runtime-locks.mjs'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const integrity = bytes => `sha512-${createHash('sha512').update(bytes).digest('base64')}`
const policy = `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  '@deepseek-ai/dsh-subprocess-local': true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\nstrictDepBuilds: true\n`

function fixture() {
  const root = mkdtempSync(join(process.env.TMPDIR ?? process.env.TEMP ?? '.', 'dsh-runtime-lock-'))
  const project = join(root, 'project')
  const inputs = join(root, 'reviewed-inputs')
  const packageDir = join(project, 'desktop-packages')
  mkdirSync(packageDir, { recursive: true })
  mkdirSync(join(inputs, 'desktop-packages'), { recursive: true })
  const tarball = Buffer.from('stable local package tarball')
  const packageRecord = { name: 'dep', version: '1.0.0', file: 'dep-1.0.0.tgz', bytes: tarball.length, integrity: integrity(tarball) }
  const packageSet = { schemaVersion: 1, packages: [packageRecord] }
  writeFileSync(join(project, 'package.json'), JSON.stringify({ dependencies: { dep: 'file:./desktop-packages/dep-1.0.0.tgz' } }))
  writeFileSync(join(project, 'pnpm-workspace.yaml'), policy)
  writeFileSync(join(project, 'desktop-packages.json'), JSON.stringify(packageSet))
  writeFileSync(join(packageDir, packageRecord.file), tarball)
  writeFileSync(join(project, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      dep:\n        specifier: file:./desktop-packages/dep-1.0.0.tgz\n        version: file:desktop-packages/dep-1.0.0.tgz\n`)
  for (const name of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'package.json', 'desktop-packages.json']) {
    copyFileSync(join(project, name), join(inputs, name))
  }
  copyFileSync(join(packageDir, packageRecord.file), join(inputs, 'desktop-packages', packageRecord.file))
  const descriptor = createRuntimeLockDescriptor({
    projectRoot: project,
    target: 'win-x64',
    upstreamCommit: 'a'.repeat(40),
    pnpmVersion: '11.7.0',
  })
  writeFileSync(join(inputs, 'descriptor.json'), JSON.stringify(descriptor, null, 2) + '\n')
  // Normal staging generates metadata but does not generate a lockfile.
  rmSync(join(project, 'pnpm-lock.yaml'))
  return { root, project, inputs, packageRecord }
}

function markReviewed(inputs) {
  const descriptorPath = join(inputs, 'descriptor.json')
  const descriptor = JSON.parse(readFileSync(descriptorPath, 'utf8'))
  descriptor.reviewStatus = 'REVIEWED'
  writeFileSync(descriptorPath, JSON.stringify(descriptor, null, 2) + '\n')
  return descriptor
}

const common = f => ({
  inputRoot: f.inputs,
  projectRoot: f.project,
  target: 'win-x64',
  upstreamCommit: 'a'.repeat(40),
  pnpmVersion: '11.7.0',
})

test('candidate inputs are never accepted by normal staging and do not write a lockfile', () => {
  const f = fixture()
  try {
    assert.throws(() => validateRuntimeLockInputs(common(f)), /not REVIEWED/)
    assert.equal(readFileSync(join(f.inputs, 'descriptor.json'), 'utf8').includes('CANDIDATE'), true)
    assert.throws(() => readFileSync(join(f.project, 'pnpm-lock.yaml')), /ENOENT/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('refresh writes a portable CANDIDATE descriptor and never overwrites an existing output', () => {
  const f = fixture()
  const candidateRoot = join(f.root, 'candidate')
  try {
    const lockBytes = readFileSync(join(f.inputs, 'pnpm-lock.yaml'))
    writeFileSync(join(f.project, 'pnpm-lock.yaml'), lockBytes)
    const descriptor = writeRuntimeLockCandidate({
      projectRoot: f.project,
      candidateRoot,
      target: 'win-x64',
      upstreamCommit: 'a'.repeat(40),
      pnpmVersion: '11.7.0',
    })
    assert.equal(descriptor.reviewStatus, 'CANDIDATE')
    assert.deepEqual(JSON.parse(readFileSync(join(candidateRoot, 'descriptor.json'), 'utf8')), descriptor)
    assert.deepEqual(readFileSync(join(candidateRoot, 'pnpm-lock.yaml')), lockBytes)
    assert.equal(descriptor.tarballs[0].path, `desktop-packages/${f.packageRecord.file}`)
    assert.equal(descriptor.tarballs[0].integrity, f.packageRecord.integrity)
    assert.throws(() => writeRuntimeLockCandidate({
      projectRoot: f.project, candidateRoot, target: 'win-x64',
      upstreamCommit: 'a'.repeat(40), pnpmVersion: '11.7.0',
    }), /already exists and is preserved/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('reviewed portable inputs validate, copy the exact lock and report sealed identities', () => {
  const f = fixture()
  try {
    markReviewed(f.inputs)
    const expectedLock = readFileSync(join(f.inputs, 'pnpm-lock.yaml'))
    const identity = validateRuntimeLockInputs(common(f))
    assert.deepEqual(readFileSync(join(f.project, 'pnpm-lock.yaml')), expectedLock)
    assert.equal(identity.lockSha256, digest(expectedLock))
    assert.equal(identity.workspacePolicySha256, digest(readFileSync(join(f.inputs, 'pnpm-workspace.yaml'))))
    assert.equal(identity.descriptorSha256, digest(readFileSync(join(f.inputs, 'descriptor.json'))))
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('missing or malformed reviewed files fail before project lock publication', () => {
  for (const mutate of [
    f => rmSync(join(f.inputs, 'pnpm-lock.yaml')),
    f => writeFileSync(join(f.inputs, 'descriptor.json'), '{not json'),
  ]) {
    const f = fixture()
    try {
      markReviewed(f.inputs)
      mutate(f)
      assert.throws(() => validateRuntimeLockInputs(common(f)))
      assert.throws(() => readFileSync(join(f.project, 'pnpm-lock.yaml')), /ENOENT/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('wrong target, upstream commit and package-manager pins are refused', () => {
  const f = fixture()
  try {
    markReviewed(f.inputs)
    assert.throws(() => validateRuntimeLockInputs({ ...common(f), target: 'win-arm64' }), /target/)
    assert.throws(() => validateRuntimeLockInputs({ ...common(f), upstreamCommit: 'b'.repeat(40) }), /upstream commit/)
    assert.throws(() => validateRuntimeLockInputs({ ...common(f), pnpmVersion: '11.9.0' }), /pnpm version/)
    assert.throws(() => readFileSync(join(f.project, 'pnpm-lock.yaml')), /ENOENT/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('changed policy, dependency metadata, or tarball bytes are refused', () => {
  for (const mutate of [
    f => writeFileSync(join(f.project, 'pnpm-workspace.yaml'), policy.replace('strictDepBuilds: true', 'strictDepBuilds: false')),
    f => writeFileSync(join(f.project, 'desktop-packages.json'), '{"schemaVersion":1,"packages":[]}'),
    f => writeFileSync(join(f.project, 'desktop-packages', f.packageRecord.file), 'changed tarball bytes'),
  ]) {
    const f = fixture()
    try {
      markReviewed(f.inputs)
      mutate(f)
      assert.throws(() => validateRuntimeLockInputs(common(f)))
      assert.throws(() => readFileSync(join(f.project, 'pnpm-lock.yaml')), /ENOENT/)
    } finally { rmSync(f.root, { recursive: true, force: true }) }
  }
})

test('changed frozen lock bytes fail without refreshing the expected digest', () => {
  const f = fixture()
  try {
    markReviewed(f.inputs)
    writeFileSync(join(f.inputs, 'pnpm-lock.yaml'), 'lockfileVersion: stale\n')
    assert.throws(() => validateRuntimeLockInputs(common(f)), /lock.*digest|lockfile.*hash/i)
    assert.throws(() => readFileSync(join(f.project, 'pnpm-lock.yaml')), /ENOENT/)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

test('descriptor uses stable relative tarball paths and pins local tarball integrity', () => {
  const f = fixture()
  try {
    const descriptor = JSON.parse(readFileSync(join(f.inputs, 'descriptor.json'), 'utf8'))
    assert.deepEqual(descriptor.tarballs.map(item => item.path), [`desktop-packages/${f.packageRecord.file}`])
    assert.equal(descriptor.tarballs[0].integrity, f.packageRecord.integrity)
    assert.ok(!JSON.stringify(descriptor).includes(f.root), 'descriptor contains no machine-specific stage path')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
