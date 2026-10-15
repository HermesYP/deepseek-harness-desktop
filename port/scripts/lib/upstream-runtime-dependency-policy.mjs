// Carry the reviewed upstream runtime dependency patches into the generated
// runtime project.
//
// At `dsh-v0.2.1-alpha.3` (2fbf4359b82fb94c03dcce0b831660d87f12ea5c) upstream's
// own workspace declares eight `patchedDependencies`, but the generated Desktop
// project policy (`apps/desktop/src/project-manager.ts` `workspaceFile()`) still
// carries none of them and pins none of their versions. Six declare packaging
// and tooling releases absent from the desktop runtime closure; exactly two are
// runtime-relevant, and without carrying them the port would silently lose
// reviewed behaviour:
//
//   * `@earendil-works/pi-ai@1.1.0`  upstream itself now patches 1.1.0 (the
//     0.2.1-alpha.3 workspace and lock record the patch), and the reviewed patch
//     carries the SAME fix as the alpha.2-era 1.0.2 patch: it removes the
//     per-delta `parseStreamingJson(...)` assignment to `block.arguments` in six
//     provider adapters, so a partially streamed tool-call JSON is no longer
//     reparsed on every delta. The override pins the resolution to exactly
//     1.1.0 so the declared range cannot drift past the patched release.
//   * `node-pty@1.2.0-beta.15`  the patch is byte-identical to the
//     0.2.1-alpha.2 reviewed bytes (same sha256), and its Windows hunk disposes
//     the ConPTY output socket worker immediately after `kill()`. Without it, a
//     process that exits silently never produces the `data` event the disposer
//     waits for, so the worker stays alive.
//
// The patch bytes are reviewed and asserted, not trusted by name. Each recorded
// `sha256` is also the `patch_hash` pnpm wrote in the upstream lockfile for that
// dependency, so the reviewed bytes and upstream's own resolution record agree.
//
// Nothing here edits the existing lockfile or resolves anything by hand. This
// module only (a) copies the two patch files, (b) amends the GENERATED project
// policy so the reviewed versions and their patches are honoured, and (c) records
// what it did. Seeding the fresh project with upstream's own lockfile is a
// separate, explicit step (`seedProjectLockfileFromUpstream`).

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Name of the record this module writes into the runtime project. */
export const RUNTIME_DEPENDENCY_POLICY_RECORD = 'runtime-dependency-policy.json'

/**
 * The reviewed upstream runtime patches, sorted by selector.
 *
 * `sha256` and `bytes` describe the exact reviewed source bytes.
 */
export const REVIEWED_UPSTREAM_RUNTIME_PATCHES = Object.freeze([
  Object.freeze({
    selector: '@earendil-works/pi-ai@1.1.0',
    name: '@earendil-works__pi-ai@1.1.0.patch',
    bytes: 4477,
    sha256: '66eaf960054f10441b93ac3857114e96c1901f6d183713e2f21437b007111644',
  }),
  Object.freeze({
    selector: 'node-pty@1.2.0-beta.15',
    name: 'node-pty@1.2.0-beta.15.patch',
    bytes: 2110,
    sha256: '9d30053266d0f39d3debe894c675867f6782da6bcadbc94a693b3cfb9eff8ed0',
  }),
])

function fail(message) {
  throw new Error(`upstream runtime dependency policy: ${message}`)
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function readRegularFile(path, label) {
  let stat
  try { stat = lstatSync(path) } catch (error) { fail(`${label} is missing or unreadable (${error.message})`) }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} must be a regular, non-linked file: ${path}`)
  return readFileSync(path)
}

/** Read and verify one reviewed patch from the upstream checkout. */
function readReviewedPatch(upstreamRoot, record) {
  const path = join(upstreamRoot, 'patches', record.name)
  const bytes = readRegularFile(path, `reviewed patch ${record.name}`)
  if (bytes.length !== record.bytes) {
    fail(`reviewed patch ${record.name} is ${bytes.length} bytes, not the reviewed ${record.bytes}`)
  }
  const digest = sha256(bytes)
  if (digest !== record.sha256) {
    fail(`reviewed patch ${record.name} hashes to ${digest}, not the reviewed ${record.sha256}`)
  }
  return { bytes, digest, relative: `patches/${record.name}` }
}

/**
 * Exact external version overrides for the reviewed patched dependencies.
 *
 * An override is what moves the resolution to exactly the patched release;
 * without it the declared ranges (`^1.1.0`, `^3.1.0`) admit newer releases and
 * `patchedDependencies` would have no matching dependency to patch.
 */
export const REVIEWED_EXACT_EXTERNAL_OVERRIDES = Object.freeze({
  '@earendil-works/pi-ai': '1.1.0',
  'node-pty': '1.2.0-beta.15',
})

/** `patchedDependencies` entries, keyed by the reviewed selector. */
export const REVIEWED_PATCHED_DEPENDENCIES = Object.freeze({
  '@earendil-works/pi-ai@1.1.0': 'patches/@earendil-works__pi-ai@1.1.0.patch',
  'node-pty@1.2.0-beta.15': 'patches/node-pty@1.2.0-beta.15.patch',
})

const OVERRIDE_LINE = /^ {2}("(?:\\.|[^"\\])*"): (".*")$/u

/** Parse the generated policy's `overrides:` block into sorted name/spec pairs. */
function readOverrides(text) {
  const block = /^overrides:\r?\n(?<body>(?:[ \t]+.*\r?\n)*)/mu.exec(text)
  if (block?.groups === undefined) fail('the generated policy has no overrides block')
  const entries = []
  for (const line of block.groups.body.trimEnd().split(/\r?\n/u)) {
    const match = OVERRIDE_LINE.exec(line)
    if (match === null) fail(`the generated policy has an unsupported override entry: ${JSON.stringify(line)}`)
    entries.push([JSON.parse(match[1]), JSON.parse(match[2])])
  }
  if (entries.length === 0) fail('the generated policy has an empty overrides block')
  return { entries, whole: block[0] }
}

function renderOverrideEntries(entries) {
  const sorted = [...entries].sort(([left], [right]) => left.localeCompare(right))
  return sorted.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')
}

/**
 * Read `minimumReleaseAgeExclude` from an upstream policy as plain text.
 *
 * Deliberately not a YAML load: the helper must work against a checkout whose
 * dependencies are not installed, and this scalar sequence is the only shape it
 * consumes. The block runs until the next unindented line, so comment lines and
 * blank lines inside it are skipped rather than ending it; any other indented
 * content is refused rather than silently dropped.
 */
function readAgeExemptions(policyText) {
  const lines = policyText.split(/\r?\n/u)
  const start = lines.findIndex((line) => /^minimumReleaseAgeExclude:\s*$/u.test(line))
  if (start < 0) return []
  const entries = []
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/u.test(line)) break
    if (/^\s*$/u.test(line) || /^\s*#/u.test(line)) continue
    const match = /^ {2}- (.+)$/u.exec(line)
    if (match === null) fail(`unsupported minimumReleaseAgeExclude entry: ${JSON.stringify(line)}`)
    entries.push(match[1].trim().replace(/^'(.*)'$/u, '$1'))
  }
  return entries
}

/**
 * Apply the reviewed upstream runtime dependency policy to a generated project.
 *
 * @param upstreamRoot - the upstream checkout the runtime stages from.
 * @param projectRoot - the freshly generated runtime project to amend.
 * @returns `{ changed, policy, record, patches }`.
 */
export function applyUpstreamRuntimeDependencyPolicy({ upstreamRoot, projectRoot }) {
  const policyPath = join(projectRoot, 'pnpm-workspace.yaml')
  const originalPolicy = readRegularFile(policyPath, 'generated runtime policy').toString('utf8')

  // Invariants the stage and the descriptor rely on. They are asserted BEFORE the
  // amendment and re-asserted after it, so an amendment can never quietly drop
  // the linker settings, the native build policy, or the strict-script refusal.
  for (const required of ['nodeLinker: hoisted', 'autoInstallPeers: false', 'allowBuilds:', 'strictDepBuilds: true']) {
    if (!originalPolicy.includes(required)) fail(`the generated policy is missing '${required}'`)
  }
  const allowBuilds = /^allowBuilds:\r?\n(?<body>(?:[ \t]+.*\r?\n)*)/mu.exec(originalPolicy)?.groups?.body
  if (allowBuilds === undefined) fail('the generated policy has no allowBuilds block')
  // Applied at most once per generated project: a second application would emit a
  // duplicate `patchedDependencies` key, which is ambiguous rather than harmless.
  if (/^patchedDependencies:/mu.test(originalPolicy)) {
    fail('the generated policy already carries patchedDependencies; the policy was applied twice')
  }

  // The reviewed patches are verified and copied into the project, because
  // `patchedDependencies` resolves its paths relative to the project root.
  const patchDirectory = join(projectRoot, 'patches')
  mkdirSync(patchDirectory, { recursive: true })
  const patches = REVIEWED_UPSTREAM_RUNTIME_PATCHES.map((record) => {
    const reviewed = readReviewedPatch(upstreamRoot, record)
    const destination = join(projectRoot, reviewed.relative)
    writeFileSync(destination, reviewed.bytes)
    const copied = readFileSync(destination)
    if (copied.length !== reviewed.bytes.length || sha256(copied) !== reviewed.digest) {
      fail(`the copied patch ${reviewed.relative} is not byte-identical to the reviewed source`)
    }
    return { selector: record.selector, path: reviewed.relative, bytes: copied.length, sha256: sha256(copied) }
  })

  // Amend the GENERATED policy: keep every existing key, the local tarball
  // overrides and the native build policy; add the two exact external overrides
  // and the patch table.
  const { entries, whole } = readOverrides(originalPolicy)
  const existing = new Map(entries)
  for (const [name, spec] of Object.entries(REVIEWED_EXACT_EXTERNAL_OVERRIDES)) {
    const current = existing.get(name)
    if (current !== undefined && current !== spec) {
      fail(`the generated policy already overrides ${name} to ${JSON.stringify(current)}, not the reviewed ${JSON.stringify(spec)}`)
    }
    existing.set(name, spec)
  }
  let amended = originalPolicy.replace(whole, `overrides:\n${renderOverrideEntries([...existing])}\n`)

  const patchEntries = Object.entries(REVIEWED_PATCHED_DEPENDENCIES)
    .sort(([left], [right]) => left.localeCompare(right))
  amended = `${amended.trimEnd()}\npatchedDependencies:\n`
    + `${patchEntries.map(([selector, path]) => `  '${selector}': ${path}`).join('\n')}\n`

  // Upstream exempts specific releases from its supply-chain release-age window.
  // The exemption list is copied verbatim so the reviewed intent is visible, but
  // it is INERT here: an exemption only relaxes a gate, and no `minimumReleaseAge`
  // is configured anywhere in this repository, so it never forces a version. The
  // exact overrides above are what hold the reviewed releases.
  const upstreamPolicy = readRegularFile(join(upstreamRoot, 'pnpm-workspace.yaml'), 'upstream workspace policy')
  const declaredExemptions = readAgeExemptions(upstreamPolicy.toString('utf8'))
  if (declaredExemptions.length > 0) {
    amended = `${amended}minimumReleaseAgeExclude:\n`
      + `${declaredExemptions.map((entry) => `  - '${entry}'`).join('\n')}\n`
  }

  // Re-assert the invariants after the amendment.
  for (const required of ['nodeLinker: hoisted', 'autoInstallPeers: false', 'strictDepBuilds: true']) {
    if (!amended.includes(required)) fail(`the amendment dropped '${required}'`)
  }
  const amendedAllowBuilds = /^allowBuilds:\r?\n(?<body>(?:[ \t]+.*\r?\n)*)/mu.exec(amended)?.groups?.body
  if (amendedAllowBuilds !== allowBuilds) fail('the amendment changed the native allowBuilds policy')
  if (!amended.includes('patchedDependencies:')) fail('the amendment did not add patchedDependencies')

  writeFileSync(policyPath, amended)

  const record = {
    schemaVersion: 1,
    sourcePolicySha256: sha256(upstreamPolicy),
    sourceLockSha256: sha256(readRegularFile(join(upstreamRoot, 'pnpm-lock.yaml'), 'upstream lockfile')),
    patches: [...patches].sort((left, right) => left.selector.localeCompare(right.selector)),
  }
  writeFileSync(join(projectRoot, RUNTIME_DEPENDENCY_POLICY_RECORD), `${JSON.stringify(record, null, 2)}\n`)

  return { changed: amended !== originalPolicy, policy: amended, record, patches };
}

/**
 * Seed a FRESH runtime project with the upstream lockfile, unchanged.
 *
 * Seeding lets pnpm start from upstream's reviewed external resolution and
 * regenerate normally, instead of resolving every range from scratch. This never
 * edits a resolution by hand and never overwrites an existing lockfile.
 *
 * @param upstreamRoot - the upstream checkout.
 * @param projectRoot - a project that must not already have a lockfile.
 * @returns `{ bytes, sha256 }` of the seeded lockfile.
 */
export function seedProjectLockfileFromUpstream({ upstreamRoot, projectRoot }) {
  const destination = join(projectRoot, 'pnpm-lock.yaml')
  if (existsSync(destination)) {
    fail('the runtime project already has a lockfile; seeding requires a fresh project')
  }
  const source = join(upstreamRoot, 'pnpm-lock.yaml')
  const bytes = readRegularFile(source, 'upstream lockfile')
  copyFileSync(source, destination)
  const copied = readRegularFile(destination, 'seeded lockfile')
  if (!copied.equals(bytes)) fail('the seeded lockfile is not the upstream bytes')
  return { bytes: copied.length, sha256: sha256(copied) }
}
