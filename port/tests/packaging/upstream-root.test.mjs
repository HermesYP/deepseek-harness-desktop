/**
 * The upstream checkout is an explicit, validated build input.
 *
 * These are source checks on the staging and toolchain scripts plus one real
 * probe of the recorded target against whatever checkout is present. They exist
 * because the port previously hardcoded `<repo>/_upstream`, the pnpm version and
 * the tsdown module loader, so an externally owned checkout of a new release
 * could not be staged without editing the scripts.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { TARGET_RELEASE, probeUpstreamRelease } from '../../scripts/lib/target-release.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = relative => readFileSync(join(port, relative), 'utf8')

test('the build script takes an explicit upstream root with a documented precedence', () => {
  const build = read(join('scripts', 'build.ps1'))
  // Optional qualification parameters may follow UpstreamRoot; it need not be last.
  const parameters = build.match(/^param\(\r?\n[\s\S]*?^\)/m)?.[0] ?? ''
  assert.match(parameters, /^\s*\[string\]\$UpstreamRoot,?\r?$/m, 'the parameter exists on the param block')
  assert.match(build, /\.PARAMETER UpstreamRoot/, 'the parameter is documented')
  assert.match(build, /\$UpstreamRequested = \$UpstreamRoot/, 'the parameter is the first source')
  assert.match(build, /\$UpstreamRequested = \$env:DSH_UPSTREAM_ROOT/, 'the environment is the second source')
  assert.match(build, /Join-Path \$RepoRoot '_upstream'/, 'the repository checkout remains the final default')
  assert.match(build, /Resolve-Path -LiteralPath \$UpstreamRequested/, 'a present root is canonicalized before use')
})

test('a checkout that cannot serve the stages is refused, not silently substituted', () => {
  const build = read(join('scripts', 'build.ps1'))
  assert.match(build, /function Assert-UpstreamCheckout/, 'the checkout assertion exists')
  assert.match(build, /apps\\desktop\\src\\host-protocol\.ts/, 'the imported protocol source is required')
  assert.match(build, /apps\\desktop\\scripts\\prepare-package-set\.ts/, 'the imported package-set preparer is required')
  assert.match(build, /it cannot serve the runtime stage/, 'a missing input is refused with the reason')
  for (const fn of ['Test-Prerequisites', 'Build-Ui', 'Stage-Runtime', 'Stage-RuntimeLockRefresh']) {
    const body = build.slice(build.indexOf(`function ${fn} {`))
    assert.ok(
      body.slice(0, body.indexOf('\nfunction ')).includes('Assert-UpstreamCheckout'),
      `${fn} validates the checkout before staging from it`)
  }
})

test('the pnpm version is read from the checkout rather than repeated as a literal', () => {
  const build = read(join('scripts', 'build.ps1'))
  assert.match(build, /function Get-UpstreamPackageManager/, 'the package manager is read from the checkout')
  assert.match(build, /refusing to guess the package manager/, 'a checkout with no pnpm packageManager is refused')
  assert.ok(!build.includes("Install pnpm 11.7.0"), 'the stale pnpm literal is gone')
  assert.match(build, /Install \$\(\(Get-UpstreamPackageManager\)\)/, 'the tool hint derives from the checkout')
})

test('the UI toolchain linker takes the same explicit root', () => {
  const linker = read(join('ui', 'link-toolchain.ps1'))
  assert.match(linker, /param\(\n\s+\[string\]\$UpstreamRoot\n\)/, 'the linker accepts the parameter')
  assert.match(linker, /\$env:DSH_UPSTREAM_ROOT/, 'the linker honours the environment')
  assert.match(linker, /pass -UpstreamRoot or set DSH_UPSTREAM_ROOT/, 'a missing checkout is refused with guidance')
  assert.match(linker, /from \$upstreamRoot/, 'the resolved root is reported')
  assert.match(read(join('scripts', 'build.ps1')), /& \$linkToolchain -UpstreamRoot \$Upstream/, 'the build passes its root through')
})

test('the UI qualification honours an explicit upstream root', () => {
  const module = read(join('tests', 'packaging', 'ui-build-qualification.psm1'))
  assert.match(module, /if \(\$env:DSH_UPSTREAM_ROOT\) \{ \$upstream = \$env:DSH_UPSTREAM_ROOT \}/,
    'the qualification resolves the same explicit root')
})

test('the port bundler runs the target module-config loader and derives its tsdown version', () => {
  const bundler = read(join('ui', 'client-updates', 'bundle.mjs'))
  assert.match(bundler, /'--config-loader', 'native'/, "the target's own bundle scripts pass --config-loader native")
  assert.match(bundler, /process\.env\.DSH_UPSTREAM_ROOT/, 'the bundler resolves the explicit root')
  assert.match(bundler, /declaredTsdownRange/, 'the tsdown version is read from the checkout')
  assert.ok(!bundler.includes('tsdown@0.22.2'), 'the hardcoded tsdown version is gone')
  assert.match(bundler, /exactly one reviewed toolchain is required/, 'an ambiguous toolchain is refused')
})

test('the recorded target probe accepts only the release the checkout declares', () => {
  const checkout = resolve(port, '..', '_upstream')
  if (!existsSync(join(checkout, 'package.json'))) return
  const report = probeUpstreamRelease(checkout)
  assert.equal(report.ok, true, `the shipped checkout must be the recorded target: ${JSON.stringify(report.mismatches)}`)
  assert.equal(TARGET_RELEASE.release, '0.2.1-rc.2')
  assert.equal(TARGET_RELEASE.upstreamCommit, '687f282e8625c6b8d11ff58211a90524be2e4317')
  assert.equal(TARGET_RELEASE.pnpmVersion, '11.28.5')
})

test('the version pins the parent approved are the recorded target release', () => {
  const tauri = JSON.parse(read(join('src-tauri', 'app', 'tauri.conf.json')))
  assert.equal(tauri.version, TARGET_RELEASE.release, 'tauri.conf.json carries the target version')
  assert.match(read(join('src-tauri', 'Cargo.toml')), new RegExp(`^version = "${TARGET_RELEASE.release}"$`, 'm'),
    'the Rust workspace version is the target version')
  assert.match(read(join('src-tauri', 'Cargo.lock')), new RegExp(`name = "dsh-core"\\nversion = "${TARGET_RELEASE.release}"`),
    'the lockfile agrees with the workspace version')
  const appInfo = JSON.parse(read(join('fixtures', 'protocol', 'app-info.json')))
  assert.equal(appInfo.version, TARGET_RELEASE.release, 'the bound protocol fixture carries the target version')
  assert.equal(appInfo.runtimeVersion, TARGET_RELEASE.release)
  assert.equal(appInfo.protocolGeneration, TARGET_RELEASE.hostProtocolVersion, 'the protocol generation is unchanged at 4')
})

test('account transforms require a recorded release AND reviewed emitted semantics', async () => {
  const modules = await Promise.all([
    import('../../scripts/lib/account-data-runtime.mjs'),
    import('../../scripts/lib/account-login-runtime.mjs'),
    import('../../scripts/lib/account-profile-runtime.mjs'),
  ])
  for (const repair of [modules[0].repairAccountDataRuntime, modules[1].repairAccountLoginRuntime, modules[2].repairAccountProfileRuntime]) {
    assert.throws(() => repair('', 'unreviewed'), /Unreviewed.*version/)
    assert.throws(() => repair('', TARGET_RELEASE.release), /Unreviewed.*shape/,
      'the target version alone cannot approve generated code')
  }
  assert.throws(() => modules[0].repairAccountDataClient('', '', TARGET_RELEASE.release), /Unreviewed.*wrapper/)
  assert.throws(() => modules[0].repairAccountDataClient('', '', 'unreviewed'), /Unreviewed.*version/)
})
