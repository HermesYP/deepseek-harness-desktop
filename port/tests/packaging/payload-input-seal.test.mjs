/**
 * The payload input seal must cover every packaging helper the runtime payload
 * is actually produced by -- including transitive ones.
 *
 * `target-release.mjs` is a transitive input of the account transforms: each
 * imports `TARGET_RELEASE` from it to decide which release's reviewed hashes
 * apply. Sealing the transforms without it would leave the input that governs
 * the accepted target version outside the manifest, so a release could change
 * the accepted version without moving any sealed digest.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TARGET_RELEASE } from '../../scripts/lib/target-release.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const build = readFileSync(join(port, 'scripts', 'build.ps1'), 'utf8')

/** The helper names the payload input seal digests. */
function sealedHelpers() {
  const block = /foreach \(\$helper in @\((?<body>[^)]*)\)\)/.exec(build)
  assert.ok(block?.groups, 'the payload input seal must declare a helper list')
  return [...block.groups.body.matchAll(/'([^']+)'/gu)].map(match => match[1])
}

test('the payload input seal digests target-release.mjs', () => {
  const helpers = sealedHelpers()
  assert.ok(helpers.includes('target-release.mjs'),
    'the release descriptor the account transforms import must be a sealed input')
  assert.ok(helpers.includes('account-data-runtime.mjs'), 'the account transforms stay sealed')
  assert.ok(helpers.includes('account-login-runtime.mjs'))
  assert.ok(helpers.includes('account-profile-runtime.mjs'))
  assert.ok(helpers.includes('seal-runtime.mjs'), 'the previous sealing inputs are not dropped')
  assert.ok(helpers.includes('runtime-locks.mjs'))
  assert.equal(new Set(helpers).size, helpers.length, 'no helper is listed twice')
})

test('every sealed helper exists under port/scripts/lib', () => {
  for (const helper of sealedHelpers()) {
    assert.ok(existsSync(join(port, 'scripts', 'lib', helper)),
      `the sealed input ${helper} must exist, or the seal digests a path that is not there`)
  }
})

test('the sealed release descriptor is the one this port records', () => {
  // A guard against sealing a descriptor that disagrees with the version pins.
  assert.match(build, /Get-PayloadInputs/, 'the payload inputs are computed in one place')
  const tauri = JSON.parse(readFileSync(join(port, 'src-tauri', 'app', 'tauri.conf.json'), 'utf8'))
  assert.equal(tauri.version, TARGET_RELEASE.release,
    'the sealed descriptor and the shipped product version must name the same release')
})

test('the seal program needs no TypeScript loader, and the stage program keeps one', () => {
  // Justification for dropping tsx from the seal invocation: the program is plain
  // JavaScript over Node builtins. If a later edit adds a `.ts` import or an
  // upstream package here, this fails and says the loader became necessary again.
  const seal = readFileSync(join(port, 'scripts', 'lib', 'seal-runtime.mjs'), 'utf8')
  const specifiers = [...seal.matchAll(/^\s*import[^\n]*?from\s+'([^']+)'/gmu)].map(match => match[1])
  assert.ok(specifiers.length > 0, 'the seal program has imports to check')
  for (const specifier of specifiers) {
    assert.ok(specifier.startsWith('node:'),
      `seal-runtime.mjs must import only Node builtins so it can run without tsx, found '${specifier}'`)
  }
  assert.match(build, /\$arguments = @\(\(Join-Path \$PSScriptRoot 'lib\\seal-runtime\.mjs'\)\)/,
    'the seal program is launched without a loader')
  assert.ok(!/\$arguments = @\('--import', 'tsx\/esm'/.test(build),
    'the seal invocation no longer routes through tsx')

  // The STAGING program still requires tsx: it imports upstream sources at runtime,
  // and project-manager.ts uses a constructor parameter property that Node's
  // strip-only TypeScript mode rejects (ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX).
  assert.match(build, /\$nodeArgs = @\('--import', 'tsx\/esm', \$nodeProgram/,
    'the staging program still runs through tsx for the non-erasable upstream sources')
})
