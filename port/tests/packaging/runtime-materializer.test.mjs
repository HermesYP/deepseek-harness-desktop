/**
 * Regression tests for the runtime materializer's staging program.
 *
 * `port/scripts/lib/runtime-payload.psm1` carries the Node staging program as a
 * here-string, and `build.ps1` writes it to disk and runs it. These tests assert
 * the properties of that program that the packaging audit asked for and that a
 * compile or a syntax check cannot show:
 *
 *   * the program imports upstream's own selection, project and file-policy
 *     modules rather than restating their logic, so the payload cannot drift
 *     from the product it reproduces;
 *   * no step silently substitutes a different package manager, linker or
 *     registry;
 *   * the install is frozen and integrity-checked, which is what makes the
 *     closure reproducible;
 *   * the hoisted-linker shape assumptions the later dereferencing copy depends
 *     on are asserted rather than assumed (finding F-21);
 *   * a missing Office engine fails the stage (the parity matrix lists Office
 *     conversion as blocked on exactly this);
 *   * the adapter probe requires the specific expected diagnostic, the exit
 *     code, and rejects the failure signatures that previously passed (F-20).
 *
 * The program is parsed and inspected as text because running it requires the
 * reference checkout, a pinned pnpm and network access. The lane report states
 * that limitation plainly: this suite proves the program's stated contract, not
 * that a payload was materialized.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const portRoot = join(here, '..', '..')
const modulePath = join(portRoot, 'scripts', 'lib', 'runtime-payload.psm1')
const moduleText = readFileSync(modulePath, 'utf8')

/**
 * Extract the embedded staging program.
 *
 * The module stores it in a single-quoted here-string (`@'` .. `'@`), which does
 * not interpolate, so its bytes are exactly what is written to disk.
 * @returns {string} The Node staging program source.
 */
function stagingProgram() {
  const start = moduleText.indexOf("@'\n")
  assert.notEqual(start, -1, 'the module must contain a single-quoted here-string')
  const end = moduleText.indexOf("\n'@", start)
  assert.notEqual(end, -1, 'the here-string must be terminated')
  return moduleText.slice(start + 3, end)
}

const program = stagingProgram()

test('the staging program is substantial JavaScript and not a stub', () => {
  assert.ok(program.length > 4000, `program is ${program.length} characters`)
  assert.match(program, /^import /m, 'program uses ESM imports')
})

test('upstream selection, project and file-policy modules are imported, not reimplemented', () => {
  // Each of these is the upstream source of truth for one decision. Restating any
  // of them here is how the payload drifts from the product.
  const required = [
    'apps/desktop/scripts/prepare-package-set.ts',
    'apps/desktop/src/project-manager.ts',
    'apps/desktop/scripts/runtime-file-policy.ts',
    'scripts/libreoffice-packages.mjs',
    'apps/desktop/src/host-protocol.ts',
  ]
  for (const path of required) {
    assert.ok(program.includes(path), `imports ${path}`)
  }
  assert.match(program, /const importUpstream = /, 'imports resolve through the reference checkout')
})

test('the package closure is rooted at both dsh and the private desktop host', () => {
  assert.match(program, /const roots = \['@deepseek-ai\/dsh', '@deepseek-ai\/dsh-desktop-host'\]/)
})

test('the closure walks dependencies, peer dependencies and platform-filtered optional dependencies', () => {
  // autoInstallPeers is false in the runtime project, so peers absent from the
  // walk are absent from the payload (finding F-21).
  assert.match(program, /\['dependencies', 'peerDependencies', 'optionalDependencies'\]/)
  assert.match(program, /compatible\(candidate\.manifest\.os, process\.platform\)/)
  assert.match(program, /compatible\(candidate\.manifest\.cpu, process\.arch\)/)
})

test('a package the closure omits is a hard failure, not a silent gap', () => {
  assert.match(program, /throw new Error\(`workspace package closure omits \$\{name\}`\)/)
})

test('the install is frozen, integrity-checked and isolated from a developer npmrc', () => {
  assert.match(program, /pnpm\('install', '--lockfile-only'\)/)
  assert.match(program, /pnpm\('install', '--prod', '--frozen-lockfile', '--trust-lockfile'\)/)
  // An empty user config stops a developer's ~/.npmrc redirecting the registry or
  // injecting a token into a build that ships.
  assert.match(program, /writeFileSync\(userConfig, ''\)/)
  assert.match(program, /NPM_CONFIG_USERCONFIG: userConfig/)
})

test('the pinned pnpm entry point is passed in rather than resolved from PATH', () => {
  assert.ok(program.includes('pnpmEntry'), 'the pnpm entry point is a parameter')
  assert.ok(!/spawnSync\(\s*['"]pnpm['"]/.test(program), 'pnpm is never spawned by bare name')
})

test('the hoisted-linker shape the dereferencing copy depends on is asserted', () => {
  assert.match(program, /nodeLinker: hoisted/)
  assert.match(program, /autoInstallPeers: false/)
  assert.match(program, /runtime project lost its hoisted-linker setting/)
  // A populated .pnpm means the linker fell back to isolated mode, where
  // excluding .pnpm discards the whole transitive layer (finding F-21).
  assert.match(program, /hoisted runtime has unexpected \.pnpm contents/)
  assert.match(program, /runtime \.pnpm metadata was not removed/)
})

test('materialization dereferences links and applies upstream file policy', () => {
  assert.match(program, /cpSync\(modules, materialized, \{/)
  assert.match(program, /dereference: true/)
  assert.match(program, /filter: \(source\) => desktopRuntimeFileExclusion\(/)
})

test('the Office engine is selected from the installed manifest and must be present', () => {
  assert.match(program, /selectOfficeEngine\(officeManifest, target\)/)
  assert.match(program, /runtime payload is missing the selected LibreOffice engine/)
  assert.match(program, /has no prebuilds\.json/)
})

test('the adapter probe requires the exact expected diagnostic and exit code', () => {
  // The expected text is the adapter's own missing-control-environment message.
  assert.match(program, /DSH_DESKTOP_CONTROL_SOCKET \/ DSH_DESKTOP_CONTROL_TOKEN are required/)
  assert.match(program, /probe\.status !== 1/, 'a non-1 exit fails the probe')
  assert.match(program, /probeText !== expectedProbeText/, 'the exact text is required, not a substring')
  // The signatures that previously passed a broken tree (finding F-20).
  assert.match(program, /ERR_MODULE_NOT_FOUND\|ERR_DLOPEN_FAILED\|SyntaxError\|ECONNREFUSED/)
})

test('the probe runs with a bounded timeout and without control-socket variables', () => {
  assert.match(program, /timeout: 15000/)
  assert.match(program, /DSH_DESKTOP_CONTROL_SOCKET', 'DSH_DESKTOP_CONTROL_TOKEN/)
})

test('the identity record ties the payload to its inputs', () => {
  assert.match(program, /writeFileSync\(identityFile,/)
  for (const field of ['hostProtocolVersion', 'pnpmVersion', 'packageClosureSize', 'officeEngine']) {
    assert.ok(program.includes(field), `identity records ${field}`)
  }
})

test('the staging program never writes into the published payload root itself', () => {
  // It receives `output` (the staging directory) as an argument, and clears only
  // that. Publication is the PowerShell side's job, by rename.
  assert.match(program, /rmSync\(output, \{ recursive: true, force: true \}\)/)
  assert.ok(!/rmSync\(publishedPath/.test(program))
})

test('the module exposes the payload shape contract the PowerShell side validates', () => {
  for (const fn of ['Get-DshRuntimeStageProgram', 'Write-DshRuntimeStageProgram',
    'Get-DshPayloadTopLevel', 'Get-DshStagingTopLevel', 'Get-DshStagedPayloadPath',
    'Get-DshPayloadAnchors', 'Get-DshPayloadAnchorFiles']) {
    assert.ok(moduleText.includes(`'${fn}'`), `exports ${fn}`)
  }
  // The anchors are the profile-boot closure established by findings F-13/F-22.
  for (const anchor of ['@deepseek-ai/dsh', '@deepseek-ai/cordis-plugin-group',
    '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-desktop-host']) {
    assert.ok(moduleText.includes(anchor), `anchor ${anchor}`)
  }
  // Debris shipped wholesale once (F-26), so the allowed top level is explicit.
  assert.match(moduleText, /return @\('adapter\.mjs', 'node_modules', 'package\.json'/)
})

test('the staging root and the payload root have distinct entries with shared node names', () => {
  // The staging root is the build's WORKSPACE and legitimately holds `packed/`,
  // `work/`, `node/`, the staging program and the identity record. The shipped
  // shape is the inner `dsh/` tree. Asserting one against the other made the
  // runtime stage impossible to complete, so both sets are named explicitly.
  const payloadMatch = moduleText.match(/function Get-DshPayloadTopLevel[\s\S]*?return @\(([^)]*)\)/)
  const stagingMatch = moduleText.match(/function Get-DshStagingTopLevel[\s\S]*?return @\(([^)]*)\)/)
  assert.ok(payloadMatch, 'Get-DshPayloadTopLevel returns an explicit set')
  assert.ok(stagingMatch, 'Get-DshStagingTopLevel returns an explicit set')

  const names = (text) => [...text.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort()
  const payload = names(payloadMatch[1])
  const staging = names(stagingMatch[1])

  assert.deepEqual(payload, ['NODE-LICENSE.txt', 'adapter.mjs', 'desktop-runtime.json', 'node', 'node_modules', 'package.json', 'runtime-payload.json'])
  assert.deepEqual(staging, ['dsh', 'node', 'node-identity.json', 'packed', 'stage-runtime.mjs', 'work'])

  const overlap = payload.filter((entry) => staging.includes(entry))
  assert.deepEqual(overlap, ['node'], 'extraction workspace and shipped interpreter use node at different roots')

  // The staging set must carry the payload directory it publishes.
  assert.ok(staging.includes('dsh'), 'the staging root declares the payload directory it carries')
  // The payload set must NOT carry workspace-only entries.
  for (const workspaceOnly of ['packed', 'work', 'stage-runtime.mjs', 'node-identity.json']) {
    assert.ok(!payload.includes(workspaceOnly), `the payload set does not include ${workspaceOnly}`)
  }

  assert.match(moduleText, /Get-DshStagedPayloadPath/, 'the inner payload path is computed, not restated')
})
