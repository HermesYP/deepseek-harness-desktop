/**
 * Regressions for the recorded target release and its fail-closed checkout probe.
 *
 * The probe is the only supported way to claim that a checkout is the release
 * this port targets. It must accept exactly the recorded identity, reject every
 * partial or drifted one, and name the drifted field.
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'
import {
  TARGET_RELEASE,
  assertUpstreamRelease,
  extractHostProtocolVersion,
  extractOptionalBundleCount,
  extractSessionFormatVersion,
  parseTargetRelease,
  probeUpstreamRelease,
  readUpstreamFacts,
} from '../scripts/lib/target-release.mjs'

const checkout = resolve(process.cwd(), '..', '_upstream')

const HOST_PROTOCOL = 'export const DESKTOP_HOST_PROTOCOL_VERSION = 4 as const\n'
const SESSION_TYPES = 'export const SESSION_FORMAT_VERSION = 4\n'
const PROFILE = `export const OPTIONAL_BUNDLES: readonly string[] = [
  '@deepseek-ai/dsh-experimental-one',
  '@deepseek-ai/dsh-experimental-two',
  '@deepseek-ai/dsh-experimental-three',
  '@deepseek-ai/dsh-experimental-four',
  '@deepseek-ai/dsh-experimental-five',
  '@deepseek-ai/dsh-experimental-six',
  '@deepseek-ai/dsh-experimental-seven',
  '@deepseek-ai/dsh-experimental-eight',
  '@deepseek-ai/dsh-experimental-nine',
  '@deepseek-ai/dsh-experimental-ten',
  '@deepseek-ai/dsh-experimental-eleven',
  '@deepseek-ai/dsh-experimental-twelve',
]
`

/** A readFile seam over an in-memory checkout, keyed by the path suffix. */
function reader(files) {
  return path => {
    const normalized = path.split('\\').join('/')
    const key = Object.keys(files).find(candidate => normalized.endsWith(candidate))
    if (key === undefined) throw new Error(`ENOENT: ${path}`)
    return files[key]
  }
}

function checkoutFiles(overrides = {}) {
  return {
    'package.json': JSON.stringify({
      version: '0.2.1-rc.2',
      packageManager: 'pnpm@11.28.5',
      engines: { node: '^22.19.0 || >=24.0.0' },
    }),
    'apps/desktop/src/host-protocol.ts': HOST_PROTOCOL,
    'packages/core/session/src/types.ts': SESSION_TYPES,
    'packages/boot/app-boot/src/profile.ts': PROFILE,
    ...overrides,
  }
}

test('the recorded target is itself a valid release identity', () => {
  assert.deepEqual(parseTargetRelease(TARGET_RELEASE), { ...TARGET_RELEASE })
})

test('a malformed release identity is rejected rather than coerced', () => {
  const cases = [
    [{ ...TARGET_RELEASE, upstreamCommit: 'd743267' }, /upstreamCommit/],
    [{ ...TARGET_RELEASE, upstreamCommit: 'D743267388641BC76F17C45CE8B4C231AED1D32C' }, /upstreamCommit/],
    [{ ...TARGET_RELEASE, release: '0.2' }, /release/],
    [{ ...TARGET_RELEASE, pnpmVersion: '11.28' }, /pnpmVersion/],
    [{ ...TARGET_RELEASE, uiEsbuildVersion: '^0.28.2' }, /uiEsbuildVersion/],
    [{ ...TARGET_RELEASE, hostProtocolVersion: '4' }, /hostProtocolVersion/],
    [{ ...TARGET_RELEASE, optionalBundleCount: -1 }, /optionalBundleCount/],
    [{ ...TARGET_RELEASE, schemaVersion: 2 }, /schemaVersion/],
    [null, /record must be an object/],
    [[], /record must be an object/],
  ]
  for (const [value, expected] of cases) {
    assert.throws(() => parseTargetRelease(value), expected)
  }
})

test('declared source constants are read, and an absent constant fails closed', () => {
  assert.equal(extractHostProtocolVersion(HOST_PROTOCOL), 4)
  assert.equal(extractSessionFormatVersion(SESSION_TYPES), 4)
  assert.equal(extractOptionalBundleCount(PROFILE), 12)

  assert.throws(() => extractHostProtocolVersion('// no constant here\n'), /DESKTOP_HOST_PROTOCOL_VERSION/)
  assert.throws(() => extractHostProtocolVersion('export const DESKTOP_HOST_PROTOCOL_VERSION = 4\n'), /DESKTOP_HOST_PROTOCOL_VERSION/)
  assert.throws(() => extractSessionFormatVersion('export const SESSION_FORMAT_VERSION: number = 4\n'), /SESSION_FORMAT_VERSION/)
  assert.throws(() => extractOptionalBundleCount('export const OPTIONAL_BUNDLES: readonly string[] = []\n'), /OPTIONAL_BUNDLES/)
  assert.throws(
    () => extractOptionalBundleCount('export const OPTIONAL_BUNDLES: string[] = [\n  "@x",\n]\n'),
    /OPTIONAL_BUNDLES/,
    'a differently declared list is not silently accepted')
})

test('the facts a checkout declares are read from the checkout, not assumed', () => {
  const facts = readUpstreamFacts('ignored', { readFile: reader(checkoutFiles()) })
  assert.deepEqual(facts, {
    release: '0.2.1-rc.2',
    pnpmVersion: '11.28.5',
    enginesRange: '^22.19.0 || >=24.0.0',
    hostProtocolVersion: 4,
    sessionFormatVersion: 4,
    optionalBundleCount: 12,
  })
  assert.throws(() => readUpstreamFacts('ignored', { readFile: reader({}) }), /cannot read package\.json/)
})

test('a checkout that matches the target probes clean', () => {
  const report = probeUpstreamRelease('ignored', { readFile: reader(checkoutFiles()) })
  assert.equal(report.ok, true)
  assert.deepEqual(report.mismatches, [])
  assert.deepEqual(assertUpstreamRelease('ignored', { readFile: reader(checkoutFiles()) }), report.facts)
})

test('every drifted field is named with both values, and the probe does not pass', () => {
  const drifted = checkoutFiles({ 'package.json': JSON.stringify({
    version: '0.2.1-alpha.2',
    packageManager: 'pnpm@11.28.5',
    engines: { node: '^22.19.0 || >=24.0.0' },
  }) })
  const report = probeUpstreamRelease('/checkout', { readFile: reader(drifted) })
  assert.equal(report.ok, false)
  assert.deepEqual(report.mismatches, [
    { field: 'release', expected: '0.2.1-rc.2', found: '0.2.1-alpha.2' },
  ])
  assert.throws(
    () => assertUpstreamRelease('/checkout', { readFile: reader(drifted) }),
    /not the recorded target 0\.2\.1-rc\.2: release: expected 0\.2\.1-rc\.2, found 0\.2\.1-alpha\.2/)
})

test('a drifted protocol generation or bundle count is caught', () => {
  const generation = probeUpstreamRelease('ignored', {
    readFile: reader(checkoutFiles({ 'apps/desktop/src/host-protocol.ts': 'export const DESKTOP_HOST_PROTOCOL_VERSION = 5 as const\n' })),
  })
  assert.deepEqual(generation.mismatches, [{ field: 'hostProtocolVersion', expected: 4, found: 5 }])

  const bundles = probeUpstreamRelease('ignored', {
    readFile: reader(checkoutFiles({ 'packages/boot/app-boot/src/profile.ts': PROFILE.replace("  '@deepseek-ai/dsh-experimental-eleven',\n", '') })),
  })
  assert.deepEqual(bundles.mismatches, [{ field: 'optionalBundleCount', expected: 12, found: 11 }])
})

test('the shipped checkout is the recorded target when it is present', { skip: !existsSync(join(checkout, 'package.json')) }, () => {
  const facts = assertUpstreamRelease(checkout)
  assert.equal(facts.release, TARGET_RELEASE.release)
  assert.equal(facts.hostProtocolVersion, TARGET_RELEASE.hostProtocolVersion)
  assert.equal(facts.sessionFormatVersion, TARGET_RELEASE.sessionFormatVersion)
})
