/**
 * The reviewed upstream runtime dependency patches must reach the generated
 * project as exact bytes, with the reviewed versions pinned and the patch table
 * present, while every key the stage already relies on survives unchanged.
 *
 * The patch sources are real: the fixtures point at the reference checkout's own
 * `patches/` directory, and the reviewed digests are cross-checked against the
 * `patch_hash` values pnpm recorded in that checkout's lockfile.
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  REVIEWED_UPSTREAM_RUNTIME_PATCHES,
  RUNTIME_DEPENDENCY_POLICY_RECORD,
  applyUpstreamRuntimeDependencyPolicy,
  seedProjectLockfileFromUpstream,
} from '../../scripts/lib/upstream-runtime-dependency-policy.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const checkout = process.env.DSH_UPSTREAM_ROOT
  ? resolve(process.env.DSH_UPSTREAM_ROOT)
  : resolve(port, '..', '_upstream')
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** A generated project policy in the exact shape upstream's workspaceFile emits. */
function generatedPolicy({ overrides = true, extra = '' } = {}) {
  const block = overrides
    ? 'overrides:\n'
      + '  "@deepseek-ai/cordis": "file:./desktop-packages/deepseek-ai-cordis-4.0.5-alpha.1.tgz"\n'
      + '  "@deepseek-ai/dsh-config-editor": "file:./desktop-packages/deepseek-ai-dsh-config-editor-0.2.1-alpha.2.tgz"\n'
      + '  "@deepseek-ai/schemastery": "file:./desktop-packages/deepseek-ai-schemastery-3.18.5-alpha.1.tgz"\n'
    : ''
  return 'packages:\n  - .\n\n'
    + block
    + 'nodeLinker: hoisted\nautoInstallPeers: false\n'
    + 'allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n'
    + '  "@deepseek-ai/dsh-subprocess-local@file:desktop-packages/deepseek-ai-dsh-subprocess-local-0.2.1-alpha.2.tgz": true\n'
    + "  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n"
    + 'strictDepBuilds: true\n'
    + extra
}

function project(policy = generatedPolicy()) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-policy-'))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), policy)
  return root
}

/** A throwaway upstream root whose `patches/` holds the real reviewed bytes. */
function upstreamWithPatches({ tamper = null, symlink = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-runtime-upstream-'))
  mkdirSync(join(root, 'patches'), { recursive: true })
  for (const record of REVIEWED_UPSTREAM_RUNTIME_PATCHES) {
    const source = join(checkout, 'patches', record.name)
    const destination = join(root, 'patches', record.name)
    if (record.name === symlink) {
      // A directory junction is the portable way to make the patch PATH a link on
      // Windows; a file symlink requires elevation. If the host denies even this,
      // the caller falls back to a plain directory, which exercises the same
      // `isFile()` branch of the guard.
      try {
        symlinkSync(join(checkout, 'patches'), destination, 'junction')
      } catch (error) {
        if (error.code !== 'EPERM' && error.code !== 'EACCES') throw error
        mkdirSync(destination, { recursive: true })
      }
      continue
    }
    const bytes = readFileSync(source)
    if (record.name === tamper) bytes[bytes.length - 1] ^= 0xff
    writeFileSync(destination, bytes)
  }
  return root
}

const allowBuildsOf = text => /^allowBuilds:\r?\n(?<body>(?:[ \t]+.*\r?\n)*)/mu.exec(text)?.groups?.body

test('the reviewed patch bytes match the checkout and its recorded patch hashes', {
  skip: !existsSync(join(checkout, 'patches')),
}, () => {
  const lock = readFileSync(join(checkout, 'pnpm-lock.yaml'), 'utf8')
  const patchHashes = new Set([...lock.matchAll(/patch_hash=([0-9a-f]{64})/gu)].map(match => match[1]))
  for (const record of REVIEWED_UPSTREAM_RUNTIME_PATCHES) {
    const bytes = readFileSync(join(checkout, 'patches', record.name))
    assert.equal(bytes.length, record.bytes, `${record.name} must be the reviewed length`)
    assert.equal(sha256(bytes), record.sha256, `${record.name} must be the reviewed bytes`)
    assert.ok(patchHashes.has(record.sha256),
      `${record.name}: pnpm's own lockfile must record this patch_hash, tying the reviewed bytes to upstream's resolution`)
  }
  assert.deepEqual(
    REVIEWED_UPSTREAM_RUNTIME_PATCHES.map(record => record.selector),
    [...REVIEWED_UPSTREAM_RUNTIME_PATCHES.map(record => record.selector)].sort((l, r) => l.localeCompare(r)),
    'reviewed patches are recorded in selector order')
})

test('applying the policy pins the reviewed releases and copies the exact patches', {
  skip: !existsSync(join(checkout, 'patches')),
}, () => {
  const root = project()
  const before = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  const result = applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: checkout, projectRoot: root })
  assert.equal(result.changed, true)

  const policy = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  for (const [name, spec] of Object.entries({ '@earendil-works/pi-ai': '1.1.0', 'node-pty': '1.2.0-beta.15' })) {
    assert.ok(policy.includes(`"${name}": "${spec}"`), `${name} must be pinned to ${spec}`)
  }
  assert.match(policy, /^patchedDependencies:$/mu)
  assert.match(policy, /^ {2}'@earendil-works\/pi-ai@1\.1\.0': patches\/@earendil-works__pi-ai@1\.1\.0\.patch$/mu)
  assert.match(policy, /^ {2}'node-pty@1\.2\.0-beta\.15': patches\/node-pty@1\.2\.0-beta\.15\.patch$/mu)

  // Everything the stage and the descriptor rely on survives unchanged.
  assert.match(policy, /^packages:\n {2}- \.\n/mu)
  assert.match(policy, /^nodeLinker: hoisted$/mu)
  assert.match(policy, /^autoInstallPeers: false$/mu)
  assert.match(policy, /^strictDepBuilds: true$/mu)
  assert.equal(allowBuildsOf(policy), allowBuildsOf(before), 'the native allowBuilds policy must be byte-identical')
  for (const local of ['deepseek-ai-cordis-4.0.5-alpha.1.tgz', 'deepseek-ai-dsh-config-editor-0.2.1-alpha.2.tgz']) {
    assert.ok(policy.includes(local), `the local override ${local} must survive`)
  }

  // The copied patches are the reviewed bytes, at the path the policy names.
  for (const patch of result.patches) {
    const copied = readFileSync(join(root, patch.path))
    assert.equal(copied.length, patch.bytes)
    assert.equal(sha256(copied), patch.sha256)
    assert.equal(sha256(copied), sha256(readFileSync(join(checkout, patch.path))))
  }

  const record = JSON.parse(readFileSync(join(root, RUNTIME_DEPENDENCY_POLICY_RECORD), 'utf8'))
  assert.equal(record.schemaVersion, 1)
  assert.equal(record.sourcePolicySha256, sha256(readFileSync(join(checkout, 'pnpm-workspace.yaml'))))
  assert.equal(record.sourceLockSha256, sha256(readFileSync(join(checkout, 'pnpm-lock.yaml'))))
  assert.deepEqual(record.patches.map(entry => entry.selector),
    ['@earendil-works/pi-ai@1.1.0', 'node-pty@1.2.0-beta.15'], 'patches are recorded in selector order')
  for (const entry of record.patches) {
    assert.deepEqual(Object.keys(entry).sort(), ['bytes', 'path', 'selector', 'sha256'])
    assert.match(entry.path, /^patches\/[^/]+\.patch$/u)
  }
})

test('an age-exemption list is copied to explain, never to force a version', {
  skip: !existsSync(join(checkout, 'patches')),
}, () => {
  const root = project()
  applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: checkout, projectRoot: root })
  const policy = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  // Copied from upstream when it declares any, and inert: the repository configures
  // no minimumReleaseAge, so the list relaxes a gate rather than pinning anything.
  const declared = /^minimumReleaseAgeExclude:/mu.test(policy)
  assert.equal(declared, /^minimumReleaseAgeExclude:/mu.test(readFileSync(join(checkout, 'pnpm-workspace.yaml'), 'utf8')))
  assert.doesNotMatch(policy, /^minimumReleaseAge:/mu, 'the exemption list must not enable an age gate')
})

test('a tampered, missing or non-regular patch source is refused', {
  skip: !existsSync(join(checkout, 'patches')),
}, (t) => {
  const tampered = upstreamWithPatches({ tamper: 'node-pty@1.2.0-beta.15.patch' })
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: tampered, projectRoot: project() }),
    /hashes to [0-9a-f]{64}, not the reviewed/)

  // Not a regular file. A directory junction exercises the non-regular branch
  // without needing elevation; a file symlink needs Developer Mode on Windows, so
  // a plain directory is the fallback when even junction creation is denied.
  const linked = upstreamWithPatches({ symlink: '@earendil-works__pi-ai@1.1.0.patch' })
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: linked, projectRoot: project() }),
    /must be a regular, non-linked file/)

  const empty = mkdtempSync(join(tmpdir(), 'dsh-runtime-nopatches-'))
  mkdirSync(join(empty, 'patches'), { recursive: true })
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: empty, projectRoot: project() }),
    /is missing or unreadable/)
})

test('the amendment refuses a conflicting override and a pre-applied policy', {
  skip: !existsSync(join(checkout, 'patches')),
}, () => {
  const conflicting = project(generatedPolicy({
    extra: 'overrides:\n',
  }).replace('overrides:\n', 'overrides:\n  "@earendil-works/pi-ai": "1.0.2"\n'))
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: checkout, projectRoot: conflicting }),
    /already overrides @earendil-works\/pi-ai to "1\.0\.2"/)

  const applied = project(generatedPolicy({ extra: 'patchedDependencies:\n' }))
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: checkout, projectRoot: applied }),
    /already carries patchedDependencies/)
})

test('the amendment refuses a generated policy that is not the stage shape', () => {
  const noStrict = project('packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  node-pty: true\n')
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: checkout, projectRoot: noStrict }),
    /missing 'strictDepBuilds: true'/)
  const noOverrides = project(generatedPolicy({ overrides: false }))
  assert.throws(() => applyUpstreamRuntimeDependencyPolicy({ upstreamRoot: checkout, projectRoot: noOverrides }),
    /no overrides block/)
})

test('seeding copies the upstream lockfile unchanged into a fresh project only', {
  skip: !existsSync(join(checkout, 'pnpm-lock.yaml')),
}, () => {
  const root = project()
  const source = readFileSync(join(checkout, 'pnpm-lock.yaml'))
  const seeded = seedProjectLockfileFromUpstream({ upstreamRoot: checkout, projectRoot: root })
  assert.equal(seeded.bytes, source.length)
  assert.equal(seeded.sha256, sha256(source))
  const copied = readFileSync(join(root, 'pnpm-lock.yaml'))
  assert.ok(copied.equals(source), 'the seeded lockfile must be the upstream bytes exactly')
  assert.throws(() => seedProjectLockfileFromUpstream({ upstreamRoot: checkout, projectRoot: root }),
    /already has a lockfile/, 'seeding must never overwrite an existing lockfile')
})

test('the helper derives its module path without a new CLI argument', async () => {
  const stage = readFileSync(join(port, 'scripts', 'lib', 'runtime-payload.psm1'), 'utf8')
  assert.ok(stage.includes("new URL('./upstream-runtime-dependency-policy.mjs', pathToFileURL(lockHelper)).href"),
    'the stage must import the helper relative to the lock helper it already receives')
})
