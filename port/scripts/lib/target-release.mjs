/**
 * The single recorded identity of the upstream release this port targets.
 *
 * Every other file that needs the release version, the upstream commit, the
 * pnpm version, or a protocol/format generation reads it from here or from a
 * real checkout through {@link assertUpstreamRelease}. Nothing infers the
 * target from a tag name, a publication date, or a version-string ordering.
 *
 * The values are a RECORD of the release this port moves to, not a claim that
 * the port's built artifacts already carry it. The staged runtime payload, the
 * runtime-lock descriptors under `port/runtime-locks/`, and the account
 * transformation reviews remain at the previous reviewed release until they are
 * genuinely re-materialized from a built checkout of `upstreamCommit`.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Schema version of {@link TARGET_RELEASE}. */
export const TARGET_RELEASE_SCHEMA_VERSION = 1

/**
 * The supported target release.
 *
 * `uiEsbuildVersion` is the esbuild release the target's own Web build resolves.
 * It is NOT the root lockfile's newest esbuild and is never inferred from one:
 * the target's `apps/web` declares `vite: ^6.4.3`, the linked Vite package
 * declares `esbuild: ^0.25.0`, and exactly one `@esbuild/win32-x64` entry in the
 * target's installed set satisfies that range. The UI qualification derives the
 * resolved release from the linked Vite package at build time and refuses an
 * ambiguous or unsatisfiable resolution; this field records that derivation for
 * the target and is cross-checked on every use rather than trusted.
 */
export const TARGET_RELEASE = Object.freeze({
  schemaVersion: TARGET_RELEASE_SCHEMA_VERSION,
  release: '0.2.1-alpha.3',
  channel: 'alpha',
  upstreamTag: 'dsh-v0.2.1-alpha.3',
  upstreamCommit: '2fbf4359b82fb94c03dcce0b831660d87f12ea5c',
  pnpmVersion: '11.28.5',
  nodeVersion: '22.20.0',
  enginesRange: '^22.19.0 || >=24.0.0',
  hostProtocolVersion: 4,
  sessionFormatVersion: 4,
  uiEsbuildVersion: '0.25.12',
  optionalBundleCount: 11,
})

const COMMIT = /^[0-9a-f]{40}$/u
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u

function fail(message) {
  throw new Error(`target release: ${message}`)
}

function requireString(record, field, pattern, description) {
  const value = record[field]
  if (typeof value !== 'string' || !pattern.test(value)) fail(`${field} must be ${description}`)
  return value
}

function requireInteger(record, field) {
  const value = record[field]
  if (!Number.isSafeInteger(value) || value < 0) fail(`${field} must be a non-negative safe integer`)
  return value
}

/**
 * Validate a release record, rejecting malformed or partial identities.
 *
 * @param value - candidate release record.
 * @returns the validated record.
 */
export function parseTargetRelease(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('record must be an object')
  if (value.schemaVersion !== TARGET_RELEASE_SCHEMA_VERSION) {
    fail(`schemaVersion must be ${TARGET_RELEASE_SCHEMA_VERSION}`)
  }
  return {
    schemaVersion: TARGET_RELEASE_SCHEMA_VERSION,
    release: requireString(value, 'release', SEMVER, 'an exact semantic version'),
    channel: requireString(value, 'channel', /^[a-z]+$/u, 'a lowercase channel name'),
    upstreamTag: requireString(value, 'upstreamTag', /^dsh-v/u, 'an upstream dsh tag'),
    upstreamCommit: requireString(value, 'upstreamCommit', COMMIT, 'a full lowercase Git object id'),
    pnpmVersion: requireString(value, 'pnpmVersion', EXACT_SEMVER, 'an exact semantic version'),
    nodeVersion: requireString(value, 'nodeVersion', EXACT_SEMVER, 'an exact semantic version'),
    enginesRange: requireString(value, 'enginesRange', /^.+$/u, 'a non-empty range'),
    hostProtocolVersion: requireInteger(value, 'hostProtocolVersion'),
    sessionFormatVersion: requireInteger(value, 'sessionFormatVersion'),
    uiEsbuildVersion: requireString(value, 'uiEsbuildVersion', EXACT_SEMVER, 'an exact semantic version'),
    optionalBundleCount: requireInteger(value, 'optionalBundleCount'),
  }
}

/** Extract `DESKTOP_HOST_PROTOCOL_VERSION` from `apps/desktop/src/host-protocol.ts`. */
export function extractHostProtocolVersion(source) {
  const match = source.match(/export const DESKTOP_HOST_PROTOCOL_VERSION\s*=\s*(\d+)\s+as const/u)
  if (match === null) fail('apps/desktop/src/host-protocol.ts declares no DESKTOP_HOST_PROTOCOL_VERSION literal')
  return Number(match[1])
}

/** Extract `SESSION_FORMAT_VERSION` from `packages/core/session/src/types.ts`. */
export function extractSessionFormatVersion(source) {
  const match = source.match(/export const SESSION_FORMAT_VERSION\s*=\s*(\d+)\b/u)
  if (match === null) fail('packages/core/session/src/types.ts declares no SESSION_FORMAT_VERSION literal')
  return Number(match[1])
}

/** Count the entries of `OPTIONAL_BUNDLES` in `packages/boot/app-boot/src/profile.ts`. */
export function extractOptionalBundleCount(source) {
  const block = source.match(/export const OPTIONAL_BUNDLES:\s*readonly string\[\]\s*=\s*\[(?<body>[\s\S]*?)\n\]/u)
  if (block === null || block.groups === undefined) {
    fail('packages/boot/app-boot/src/profile.ts declares no OPTIONAL_BUNDLES list')
  }
  const entries = block.groups.body.match(/'[^']+'/gu) ?? []
  if (entries.length === 0) fail('OPTIONAL_BUNDLES is empty; an empty shipped optional list was never reviewed')
  return entries.length
}

function readText(root, relative, readFile) {
  try {
    return readFile(join(root, relative), 'utf8')
  } catch (error) {
    fail(`cannot read ${relative} under ${root} (${error.message})`)
  }
}

/**
 * Read the release facts a checkout actually declares.
 *
 * @param upstreamRoot - an upstream checkout root; never written to.
 * @param options.readFile - test seam replacing `node:fs` `readFileSync`.
 * @returns the facts read from the checkout.
 */
export function readUpstreamFacts(upstreamRoot, { readFile = readFileSync } = {}) {
  const rootManifest = JSON.parse(readText(upstreamRoot, 'package.json', readFile))
  if (rootManifest === null || typeof rootManifest !== 'object') fail('root package.json must be an object')
  const packageManager = rootManifest.packageManager
  if (typeof packageManager !== 'string' || !packageManager.startsWith('pnpm@')) {
    fail('root package.json must declare a pnpm packageManager')
  }
  const engines = rootManifest.engines
  if (engines === null || typeof engines !== 'object' || typeof engines.node !== 'string') {
    fail('root package.json must declare engines.node')
  }
  return {
    release: requireString(rootManifest, 'version', SEMVER, 'an exact semantic version'),
    pnpmVersion: packageManager.replace(/^pnpm@/u, '').split('+')[0],
    enginesRange: engines.node,
    hostProtocolVersion: extractHostProtocolVersion(
      readText(upstreamRoot, join('apps', 'desktop', 'src', 'host-protocol.ts'), readFile)),
    sessionFormatVersion: extractSessionFormatVersion(
      readText(upstreamRoot, join('packages', 'core', 'session', 'src', 'types.ts'), readFile)),
    optionalBundleCount: extractOptionalBundleCount(
      readText(upstreamRoot, join('packages', 'boot', 'app-boot', 'src', 'profile.ts'), readFile)),
  }
}

/**
 * Compare a checkout against the recorded target without mutating anything.
 *
 * @param upstreamRoot - an upstream checkout root.
 * @param options.expected - the release record to compare against.
 * @param options.readFile - test seam replacing `node:fs` `readFileSync`.
 * @returns `{ ok, facts, mismatches }`, where each mismatch names the field and both values.
 */
export function probeUpstreamRelease(upstreamRoot, { expected = TARGET_RELEASE, readFile = readFileSync } = {}) {
  const target = parseTargetRelease(expected)
  const facts = readUpstreamFacts(upstreamRoot, { readFile })
  const mismatches = []
  // ONLY keys the checkout declares. `nodeVersion` and `uiEsbuildVersion` are
  // port-side choices and are deliberately not compared here.
  for (const field of [
    'release', 'pnpmVersion', 'enginesRange', 'hostProtocolVersion', 'sessionFormatVersion', 'optionalBundleCount',
  ]) {
    if (facts[field] !== target[field]) {
      mismatches.push({ field, expected: target[field], found: facts[field] })
    }
  }
  return { ok: mismatches.length === 0, facts, mismatches }
}

/**
 * Throw unless the checkout declares exactly the recorded target release.
 *
 * @param upstreamRoot - an upstream checkout root.
 * @param options.expected - the release record to compare against.
 * @param options.readFile - test seam replacing `node:fs` `readFileSync`.
 * @returns the facts read from the checkout.
 */
export function assertUpstreamRelease(upstreamRoot, { expected = TARGET_RELEASE, readFile = readFileSync } = {}) {
  const report = probeUpstreamRelease(upstreamRoot, { expected, readFile })
  if (!report.ok) {
    const detail = report.mismatches
      .map(mismatch => `${mismatch.field}: expected ${String(mismatch.expected)}, found ${String(mismatch.found)}`)
      .join('; ')
    fail(`checkout ${upstreamRoot} is not the recorded target ${TARGET_RELEASE.release}: ${detail}`)
  }
  return report.facts
}
