/**
 * The runtime staging child's esbuild compiler is resolved, not assumed.
 *
 * The staging program loads upstream TypeScript through `--import tsx/esm`, so it
 * runs tsx's OWN esbuild — a different release from the UI child's. One
 * process-wide ESBUILD_BINARY_PATH cannot serve both, which is why a manual
 * environment was needed at all.
 *
 * These run the real PowerShell resolver against a real checkout and assert:
 *   * the version comes from tsx's OWN resolved dependency link;
 *   * tsx's declared range is ambiguous in a real store (it matches several
 *     installed releases), so range-matching could not have produced this answer;
 *   * the copy is byte-identical, Medium, and reports the resolved version;
 *   * a byte-tampered override is refused as a substituted compiler.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const modulePath = join(port, 'tests', 'packaging', 'runtime-esbuild-qualification.psm1')
const powershell = process.env.DSH_PACKAGING_POWERSHELL
  ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const checkout = process.env.DSH_UPSTREAM_ROOT
  ? resolve(process.env.DSH_UPSTREAM_ROOT)
  : resolve(port, '..', '_upstream')
const hasStore = existsSync(join(checkout, 'node_modules', '.pnpm'))

/** Run a PowerShell probe that emits `KEY=value` lines. */
function probe(script, extraEnv = {}) {
  const result = spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], {
    encoding: 'utf8',
    env: { ...process.env, DSH_PROBE_MODULE: modulePath, DSH_PROBE_ROOT: checkout, ...extraEnv },
  })
  const fields = new Map()
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line)
    if (match !== null) fields.set(match[1], match[2])
  }
  return { status: result.status, fields, stdout: result.stdout, stderr: result.stderr }
}

test('the runtime compiler is the release tsx actually resolves, despite an ambiguous range',
  { skip: !hasStore }, () => {
    const result = probe(`
$ErrorActionPreference = 'Stop'
Import-Module $env:DSH_PROBE_MODULE -Force
$root = $env:DSH_PROBE_ROOT
$resolution = Get-DshTsxEsbuildResolution -UpstreamRoot $root
$reference = Get-DshRuntimeEsbuildReference -UpstreamRoot $root
$tsxManifest = Get-Content (Join-Path $root 'node_modules\\.pnpm\\tsx@4.23.13\\node_modules\\tsx\\package.json') -Raw | ConvertFrom-Json
$range = [string]$tsxManifest.dependencies.esbuild
# Which installed win32-x64 releases satisfy tsx's declared range?
$installed = @()
foreach ($dir in Get-ChildItem (Join-Path $root 'node_modules\\.pnpm') -Directory -Filter '@esbuild+win32-x64@*') {
  $installed += $dir.Name.Substring('@esbuild+win32-x64@'.Length)
}
# Explicit tilde comparison (major.minor equal, patch >= base): a tilde range
# such as ~0.28.0 admits every 0.28.x, so a real store can hold more than one
# admissible release. No backticks here: this text lives inside a JS template.
$satisfying = @()
$base = $range.TrimStart('~').Split('.')
foreach ($version in $installed) {
  $parts = $version.Split('.')
  if ($parts.Count -ne 3) { continue }
  if ([int]$parts[0] -eq [int]$base[0] -and [int]$parts[1] -eq [int]$base[1] -and [int]$parts[2] -ge [int]$base[2]) {
    $satisfying += $version
  }
}
Write-Output "RESOLVED=$($resolution.Version)"
Write-Output "REFERENCE=$($reference.Version)"
Write-Output "RANGE=$range"
Write-Output "INSTALLED=$($installed -join ',')"
Write-Output "SATISFYING=$($satisfying -join ',')"
`)
    assert.equal(result.status, 0, `the probe must succeed: ${result.stdout}${result.stderr}`)
    const resolved = result.fields.get('RESOLVED')
    const installed = (result.fields.get('INSTALLED') ?? '').split(',').filter(Boolean)
    const satisfying = (result.fields.get('SATISFYING') ?? '').split(',').filter(Boolean)

    assert.ok(installed.includes(resolved), `the resolved version ${resolved} must be installed`)
    assert.ok(satisfying.length > 1,
      `tsx's declared range must genuinely be ambiguous here, so range matching could not have produced the answer; satisfying=${satisfying.join(',')}`)
    assert.ok(satisfying.includes(resolved),
      'the resolved version must be one of the versions the range admits')
    // The ambiguity is only resolvable through tsx's own dependency link.
    assert.equal(result.fields.get('REFERENCE'), resolved,
      'the reference package and the resolved version must agree')
  })

test('the resolved compiler is copied byte-identically at Medium integrity',
  { skip: !hasStore }, () => {
    const result = probe(`
$ErrorActionPreference = 'Stop'
Import-Module $env:DSH_PROBE_MODULE -Force
$trusted = Resolve-DshTrustedRuntimeEsbuild -UpstreamRoot $env:DSH_PROBE_ROOT
$reference = Get-DshRuntimeEsbuildReference -UpstreamRoot $env:DSH_PROBE_ROOT
Write-Output "VERSION=$($trusted.Version)"
Write-Output "COPY_SHA=$($trusted.Sha256)"
Write-Output "REF_SHA=$($reference.Sha256)"
Write-Output "COPY_LABEL=$($trusted.CopyLabel)"
Write-Output "CHILD_TOKEN=$($trusted.ChildToken)"
Write-Output "EXISTS=$(Test-Path -LiteralPath $trusted.Path -PathType Leaf)"
Write-Output "SOURCE=$($trusted.Source)"
`)
    assert.equal(result.status, 0, `the resolver must succeed: ${result.stdout}${result.stderr}`)
    assert.equal(result.fields.get('COPY_SHA'), result.fields.get('REF_SHA'),
      'the copy must be byte-identical to the resolved compiler')
    assert.equal(result.fields.get('EXISTS'), 'True')
    assert.equal(result.fields.get('COPY_LABEL'), 'medium', 'the copy must not remain Low integrity')
    assert.equal(result.fields.get('CHILD_TOKEN'), 'medium', 'the compiler child must run at Medium integrity')
    assert.match(result.fields.get('SOURCE') ?? '', /^resolved-tsx-dependency:/u,
      'with no override the compiler comes from the resolved tsx dependency')
  })

test('a byte-tampered override is refused as a substituted compiler', { skip: !hasStore }, () => {
  const tamperRoot = mkdtempSync(join(tmpdir(), 'dsh-runtime-esbuild-'))
  const tampered = join(tamperRoot, 'esbuild.exe')
  const source = join(checkout, 'node_modules', '.pnpm',
    '@esbuild+win32-x64@0.28.1', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe')
  if (!existsSync(source)) return
  const bytes = readFileSync(source)
  bytes[bytes.length - 1] ^= 0xff
  writeFileSync(tampered, bytes)

  const result = probe(`
$ErrorActionPreference = 'Stop'
Import-Module $env:DSH_PROBE_MODULE -Force
try {
  $null = Resolve-DshTrustedRuntimeEsbuild -UpstreamRoot $env:DSH_PROBE_ROOT -OverridePath $env:DSH_PROBE_TAMPER
  Write-Output "OUTCOME=accepted"
} catch {
  Write-Output "OUTCOME=refused"
  Write-Output "REASON=$($_.Exception.Message)"
}
`, { DSH_PROBE_TAMPER: tampered })
  assert.equal(result.status, 0, `the probe must complete: ${result.stdout}${result.stderr}`)
  assert.equal(result.fields.get('OUTCOME'), 'refused', 'tampered bytes must not be accepted')
  assert.match(result.fields.get('REASON') ?? '', /substituted compiler/u,
    'the refusal must name the substituted compiler')
})
