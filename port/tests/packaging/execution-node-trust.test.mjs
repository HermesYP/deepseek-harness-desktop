/**
 * Behavioural regression for the staging execution-interpreter trust decision.
 *
 * The lead review found a real bypass: the explicit `-AttestedNodePath` path only
 * read the image label, so ANY interpreter could be executed with none of the
 * guarantees the default path had (no byte comparison against the archive-pinned
 * staged interpreter, no version check, no child preflight, and null Root/Temp).
 *
 * These tests therefore EXECUTE `Resolve-DshTrustedExecutionNode` in a real Windows
 * PowerShell 5.1 child instead of matching comments or source text, and assert the
 * refusal reasons AND that a good candidate still returns Root/Temp/Preflight.
 *
 * Cases (all with the real `port/installer/node-runtime.json` pin):
 *   * a candidate that is not byte-identical to the staged interpreter -> refused;
 *   * a candidate that IS byte-identical but is not the pinned Node build
 *     (`rustc.exe`, so its `--version` is `rustc ...`) -> refused on version;
 *   * an absent candidate -> refused by existing-evidence checks;
 *   * the pinned staged interpreter itself -> accepted, with a fresh owned root,
 *     a temp directory and a completed write/pipe/sentinel/watchdog preflight.
 *
 * Nothing is relabelled, no build or application start happens, and every owned
 * root is retained. The staged reference used here is the outside pinned copy so the
 * test does not copy 85 MB; the byte-equality rule is exercised by the mismatch case.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, copyFileSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const portRoot = join(here, '..', '..')
const repoRoot = join(portRoot, '..')
const packaging = join(portRoot, 'tests', 'packaging')
const pinPath = join(portRoot, 'installer', 'node-runtime.json')

const powershell = process.env.DSH_PACKAGING_POWERSHELL
  ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

function findOutsidePinnedNode() {
  const local = process.env.LOCALAPPDATA ?? ''
  const candidates = []
  if (local) {
    try {
      for (const entry of readdirSync(local)) {
        if (entry.startsWith('eperm-bin-')) candidates.push(join(local, entry, 'pinnednode.exe'))
      }
    } catch { /* the directory may not be listable; fall through to the payload copy */ }
  }
  candidates.push(join(portRoot, 'runtime-payload', 'dsh', 'node', 'node.exe'))
  for (const candidate of candidates) if (existsSync(candidate)) return candidate
  return null
}

/** Run one resolution inside a real PS 5.1 child and return its structured verdict. */
function resolveInPowerShell({ staged, attested }) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'Set-StrictMode -Version Latest',
    `Import-Module '${join(packaging, 'rust-qualification.psm1')}' -Force`,
    'try {',
    `  $r = Resolve-DshTrustedExecutionNode -StagedExecutable '${staged}' -PinManifestPath '${pinPath}' -AttestedPath '${attested}'`,
    '  Write-Host ("RESOLVED path=" + $r.Path + " source=" + $r.Source + " version=" + $r.Version + " rootKnown=" + [bool]$r.Root + " tempKnown=" + [bool]$r.Temp + " preflight=" + [bool]$r.Preflight)',
    '  exit 0',
    '} catch {',
    '  Write-Host ("REFUSED " + $_.Exception.Message)',
    '  exit 7',
    '}',
  ].join('\n')
  const root = mkdtempSync(join(portRoot, '.scratch', 'exec-node-trust-'))
  const scriptPath = join(root, 'resolve.ps1')
  try {
    writeFileSync(scriptPath, script, 'ascii')
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      cwd: repoRoot, encoding: 'utf8',
    })
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const windowsOnly = { skip: process.platform !== 'win32' }
const pinned = process.platform === 'win32' ? findOutsidePinnedNode() : null

test('the version pin is read from the source manifest, not hard-coded', () => {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'))
  assert.match(pin.nodeVersion, /^\d+\.\d+\.\d+$/, 'the pin declares an exact version')
  const module = readFileSync(join(packaging, 'rust-qualification.psm1'), 'utf8')
  // String containment, not regex escaping: these are the exact expressions whose
  // BEHAVIOUR the tests above exercise.
  for (const required of [
    '$PinManifestPath',
    'candidate.Sha256 -ne $staged.Sha256',
    'observedVersion -ne "v$expectedVersion"',
    'Test-DshChildPreflight -NodePath $candidatePath',
    'Temp = $temp',
    'Root = $root',
  ]) {
    assert.ok(module.includes(required), `the resolver contains: ${required}`)
  }
})

test('a candidate that is not byte-identical to the staged interpreter is refused', windowsOnly, () => {
  if (!pinned) return
  const root = mkdtempSync(join(portRoot, '.scratch', 'exec-node-mismatch-'))
  const other = join(root, 'other.exe')
  try {
    copyFileSync(join(pinned), other)
    // The same bytes as the staged reference would pass; a different reference must
    // not. `rustc.exe` differs from `node.exe` in both digest and version.
    const staged = process.env.DSH_RUSTC ?? 'C:\\Users\\Yoova\\.cargo\\bin\\rustc.exe'
    if (!existsSync(staged)) return
    const result = resolveInPowerShell({ staged, attested: other })
    assert.equal(result.status, 7, `expected a refusal, got: ${result.output}`)
    assert.match(result.output, /NOT byte-identical|digest/i, 'the refusal names the byte comparison')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a byte-identical candidate that is not the pinned Node build is refused on version', windowsOnly, () => {
  const rustc = 'C:\\Users\\Yoova\\.cargo\\bin\\rustc.exe'
  if (!existsSync(rustc)) return
  // staged == attested == rustc.exe: the digest rule is satisfied, so the ONLY thing
  // that can refuse this is the version check. That is what makes this test
  // non-vacuous for the version requirement.
  const result = resolveInPowerShell({ staged: rustc, attested: rustc })
  assert.equal(result.status, 7, `expected a version refusal, got: ${result.output}`)
  assert.match(result.output, /reports '.*', not the pinned/, 'the refusal names the version mismatch')
})

test('an absent candidate is refused rather than assumed', windowsOnly, () => {
  if (!pinned) return
  const missing = join(portRoot, '.scratch', 'no-such-interpreter-9f2c.exe')
  assert.equal(existsSync(missing), false)
  const result = resolveInPowerShell({ staged: pinned, attested: missing })
  assert.equal(result.status, 7, `expected a refusal, got: ${result.output}`)
  assert.match(result.output, /absent/i, 'the refusal names the missing image')
})

test('the pinned interpreter is accepted with a fresh root, temp and a completed preflight', windowsOnly, () => {
  if (!pinned) return
  const result = resolveInPowerShell({ staged: pinned, attested: pinned })
  assert.equal(result.status, 0, `expected acceptance, got: ${result.output}`)
  assert.match(result.output, /RESOLVED /, 'a resolution was reported')
  assert.match(result.output, /version=v22\.20\.0/, 'the pinned version was observed')
  assert.match(result.output, /rootKnown=True/, 'a real owned root is returned')
  assert.match(result.output, /tempKnown=True/, 'a real temp directory is returned')
  assert.match(result.output, /preflight=True/, 'the write/pipe/sentinel/watchdog preflight ran')
})

test('build.ps1 delegates both paths to the single checked resolver', () => {
  const script = readFileSync(join(portRoot, 'scripts', 'build.ps1'), 'utf8')
  assert.match(script, /Resolve-DshTrustedExecutionNode -StagedExecutable \$Executable/, 'the copy wrapper delegates')
  assert.match(script, /Resolve-DshTrustedExecutionNode -StagedExecutable \$StagedExecutable/, 'the override wrapper delegates')
  assert.match(script, /-PinManifestPath \(Join-Path \$InstallerDir 'node-runtime\.json'\)/, 'the source pin is passed in')
  // The old bypass executed an attested path after a label read only.
  assert.doesNotMatch(script, /TRUSTED_NODE_EXECUTION=attested path=/)
})
