/**
 * Contract tests for the Phase-1 qualification gate and its declared surfaces.
 *
 * These are TEXT-level assertions, deliberately: they pin the properties that a
 * future edit can silently weaken, on a host where running the native suites is
 * not possible. The executable proof is `port/tests/packaging/preflight-unit.ps1`
 * (read-only unit checks) and `port/tests/run-verification-gate.ps1` (the gate
 * itself); what is asserted here is that those two keep the contract that makes a
 * green run meaningful:
 *
 *   * the UI test script runs `native-guests/tests` and `build:verify` invokes the
 *     build AND the affected tests (finding 19: the native guest adapters were
 *     never run by any gate, and no gate invoked vitest at all);
 *   * a skipped suite can never be reported as a pass: the gate exits 3 for a
 *     precondition skip and refuses `-AllowPreconditionSkip` for the packaging lane
 *     only if it is passed explicitly (finding P1: four NSIS suites exited 0 when
 *     they skipped, so `passed=6 failed=0` could mean zero NSIS qualification);
 *   * the seven packaging suites are declared by name, not discovered by a glob;
 *   * the fixture helpers never mutate the caller's TEMP/TMP for the rest of the
 *     session: the child's environment is set on its own ProcessStartInfo;
 *   * the preflight module contains no relabel or ACL-reset call;
 *   * every new PowerShell file is pure ASCII with no BOM, because Windows
 *     PowerShell 5.1 decodes a BOM-less file as ANSI (finding F-27).
 */

import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const portRoot = join(here, '..', '..')
const repoRoot = join(portRoot, '..')

const read = relative => readFileSync(join(portRoot, relative), 'utf8')

const windowsOnly = { skip: process.platform !== 'win32' }
const powershell = process.env.DSH_PACKAGING_POWERSHELL
  ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
const uiBuildModule = join(portRoot, 'tests', 'packaging', 'ui-build-qualification.psm1')

/**
 * Run one Windows PowerShell 5.1 script and return its combined output.
 *
 * The behavioural assertions below EXECUTE the real module in real PS 5.1. Source
 * text alone missed two defects: the build helper accepted an existing EMPTY
 * output directory (and a plain file, and a link) before running Vite with
 * `--emptyOutDir`, and the gate's Node lanes inherited the ambient
 * `DSH_ADAPTER_INTEGRATION_NODE`. Both are only observable by running the code.
 */
const runPowerShell = lines => {
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('\n')], {
    encoding: 'utf8',
  })
  return {
    status: result.status,
    error: result.error,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}


test('the UI test script runs the native guest adapter suite and the type projects', () => {
  const manifest = JSON.parse(read(join('ui', 'package.json')))
  assert.match(manifest.scripts.test, /desktop-bridge\/tests/, 'the bridge suite runs')
  assert.match(manifest.scripts.test, /client-updates\/tests/, 'the updates suite runs')
  assert.match(manifest.scripts.test, /native-guests\/tests/, 'the native guest adapter suite runs (finding 19)')
  assert.match(manifest.scripts['test:types'], /native-guests\/tsconfig\.json/, 'the guest adapters are type-checked')
  assert.match(manifest.scripts['test:types'], /desktop-bridge\/tsconfig\.json/)
  assert.match(manifest.scripts['test:types'], /client-updates\/tsconfig\.json/)
})

test('build:verify invokes the build and the affected tests rather than trusting a green build', () => {
  const manifest = JSON.parse(read(join('ui', 'package.json')))
  const buildVerify = manifest.scripts['build:verify']
  assert.ok(buildVerify, 'build:verify exists')
  assert.match(buildVerify, /vite\.js build/, 'it builds')
  assert.match(buildVerify, /native-guests\/tests/, 'it invokes the affected guest tests')
  assert.match(buildVerify, /desktop-bridge\/tests/)
  assert.match(buildVerify, /client-updates\/tests/)
  assert.match(buildVerify, /tsc/, 'it type-checks the affected projects')
})

test('the qualification gate declares exactly seven packaging suites by name', () => {
  const module = read(join('tests', 'packaging', 'suite-result.psm1'))
  const declared = [...module.matchAll(/Id = '([a-z0-9-]+)';\s+File = '([a-z0-9.-]+)'/g)]
  assert.equal(declared.length, 7, `seven declared suites, found ${declared.length}`)
  const files = declared.map(match => match[2])
  for (const required of ['lib-modules.ps1', 'stage-guards.ps1', 'nsis-hooks-compile.ps1',
    'nsis-strings-messages.ps1', 'nsis-instance-guard.ps1', 'nsis-hook-behavior.ps1',
    'verify-installed-guards.ps1']) {
    assert.ok(files.includes(required), `${required} is declared, so deleting it fails the gate`)
    assert.ok(existsSync(join(portRoot, 'tests', 'packaging', required)), `${required} exists`)
  }
  // Four of the seven are the NSIS suites, which are the ones that can
  // precondition-skip; the gate must therefore distinguish that from a pass.
  assert.equal(declared.filter(match => module.includes(`Id = '${match[1]}'`)).length, 7)
})

test('a precondition skip is never a pass and the packaging lane refuses to skip the preflight', () => {
  const gate = read(join('tests', 'run-verification-gate.ps1'))
  assert.match(gate, /GATE_RESULT=SKIP \(not a pass\)/, 'a skip says so in the verdict')
  assert.match(gate, /exit 3/, 'a skip exits 3, not 0')
  assert.match(gate, /precondition-failed and -AllowPreconditionSkip was not passed/,
    'a precondition skip fails the gate unless it was explicitly tolerated')
  assert.match(gate, /refuses -SkipPreflight/, 'the packaging lane never starts native fixtures without a preflight')
  assert.match(gate, /REFUSED: native qualification will not run without a known-integrity attested interpreter/)
  assert.match(gate, /Assert-DshQualificationPreflight/, 'the gate runs the preflight')
  assert.match(gate, /Assert-DshNodeTestCounts/, 'the Node lanes assert nonempty counts')
})

test('the preflight refuses unknown visibility and never relabels or resets an ACL', () => {
  const module = read(join('tests', 'packaging', 'qualification-preflight.psm1'))
  const code = module.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  for (const banned of ['/setintegritylevel', 'Set-Acl', 'SetSecurityInfo', 'icacls', 'takeown']) {
    assert.ok(!code.includes(banned), `the preflight code never calls ${banned}`)
  }
  assert.match(code, /TokenIntegritySid/, 'the parent and child tokens are read through a native API')
  assert.match(code, /FileLabelSid/, 'the image label is read through a native API')
  assert.match(code, /refusing unknown visibility/, 'unknown visibility is refused rather than assumed')
  assert.match(code, /Copy-DshTrustedPlainCopy/, 'the trusted plain copy helper exists for outside-workspace runs')
  assert.match(code, /Get-FileHash/, 'each copied file is hash-verified')
})

test('fixture TEMP/TMP are per child, with an exact absent-vs-empty restore for direct runs', () => {
  const module = read(join('tests', 'packaging', 'fixture-safety.psm1'))
  // The defect: `$env:TEMP = $temp` at root creation, never restored.
  assert.doesNotMatch(module, /^\s*\$env:TEMP\s*=/m, 'root creation does not mutate the caller TEMP')
  assert.doesNotMatch(module, /^\s*\$env:TMP\s*=/m, 'root creation does not mutate the caller TMP')
  assert.match(module, /EnvironmentVariables\['TEMP'\] = \$temp/, 'the child TEMP is set on its own process')
  assert.match(module, /EnvironmentVariables\['TMP'\] = \$temp/, 'the child TMP is set on its own process')
  assert.match(module, /function Push-PackagingFixtureEnvironment/, 'a scoped override exists for direct runs')
  assert.match(module, /function Pop-PackagingFixtureEnvironment/, 'the scoped override can be undone')
  assert.match(module, /Remove-Item -LiteralPath "Env:\$name"/, 'a variable that was absent is removed again, not set empty')
  assert.match(module, /MaxPathLength/, 'fixture roots are bounded in length')
})

test('every new PowerShell surface is ASCII with no BOM', () => {
  const files = [
    join('tests', 'run-verification-gate.ps1'),
    join('tests', 'packaging', 'native-quoting.psm1'),
    join('tests', 'packaging', 'suite-result.psm1'),
    join('tests', 'packaging', 'qualification-preflight.psm1'),
    join('tests', 'packaging', 'ui-build-qualification.psm1'),
    join('tests', 'packaging', 'preflight-unit.ps1')
  ]
  for (const relative of files) {
    const bytes = readFileSync(join(portRoot, relative))
    assert.equal([...bytes].filter(byte => byte > 127).length, 0, `${relative} is pure ASCII`)
    assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), `${relative} has no UTF-8 BOM`)
  }
})

test('the Rust target-trust check fails closed on unknown evidence', () => {
  const module = read(join('tests', 'packaging', 'rust-qualification.psm1'))
  const code = module.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  // "writable and not Low" was not trust: an unreadable label or an unknown or
  // unrecognised parent level must refuse and NAME the reason.
  assert.match(code, /is not a recognised level; refusing unknown visibility/)
  assert.match(code, /this process's integrity could not be read \(.*\); refusing unknown visibility/)
  assert.match(code, /the target root's label could not be read \(.*\); refusing unknown visibility/)
  assert.match(code, /\$trusted = \$writable -and \$effective\.Enforced -ne 'low' -and \$parent -ne 'low'/)
  // The clarification lives in a comment, so it is checked against the raw text.
  assert.ok(module.includes('write is performed by the CURRENT process, not by a child'),
    'the write probe is documented as a current-process proof, not a child proof')
})

test('the dev launcher fences credentials with a fresh owned namespace and never launches the app here', () => {
  const launcher = readFileSync(join(portRoot, 'scripts', 'dev-e2e.ps1'), 'utf8')
  // The launcher reads the REAL script text; this suite never starts the application.
  assert.match(launcher, /DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE/, 'the namespace variable the app fence reads is set')
  assert.match(launcher, /\$Namespace = \[guid\]::NewGuid\(\)\.ToString\('D'\)\.ToLowerInvariant\(\)/,
    'a fresh canonical lowercase hyphenated UUID is generated per run')
  assert.match(launcher, /native-\$Namespace/, 'the owned root uses the fence\'s native-{UUID} form')
  assert.match(launcher, /\$OwnedScratch = Join-Path \$RepoRoot '\.scratch'/, 'credentials are fenced by repository scratch, not port evidence scratch')
  assert.match(launcher, /Test-Under \$OwnedRoot \$OwnedScratch/, 'the credential containment guard checks the same root the compiled DEBUG fence requires')
  assert.doesNotMatch(launcher, /Test-Under \$OwnedRoot \$Scratch\)/, 'repository credential roots must not be refused by the separate port evidence fence')
  assert.match(launcher, /'DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE'\)\) \{/, 'the namespace is added to the restore list')
  assert.match(launcher, /\$env:DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE = \$Namespace/, 'it is exported to the child explicitly')
  assert.match(launcher, /the owned credential namespace root already exists/, 'a reused namespace root is refused')
  assert.match(launcher, /RELEASE build/, 'a release image is refused because the fence requires a debug build')
  // No arbitrary system interpreter, and no unguarded launch: one try/finally covers
  // the launch AND the verify path so the environment is always restored.
  assert.doesNotMatch(launcher, /Get-Command node/, 'there is no system-node fallback')
  assert.match(launcher, /Resolve-DshTrustedExecutionNode -StagedExecutable \$payloadNode/, 'the runtime interpreter is resolved by the EXPORTED module function')
  assert.match(launcher, /-PinManifestPath \(Join-Path \$PortRoot 'installer\\node-runtime\.json'\)/, 'the source pin is passed to the resolver')
  // Comments NAME the build.ps1-only wrapper to explain why it is not used; only the
  // executable lines must be free of it.
  const launcherCode = launcher.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(launcherCode, /Resolve-DshStagingExecutionNode/, 'the build.ps1-only wrapper is never called from the launcher')
  assert.match(launcher, /did not export Resolve-DshTrustedExecutionNode/, 'a missing export fails closed instead of at the call site')
  assert.match(launcher, /this process's integrity could not be read \(.*\); refusing to launch under unknown visibility/)
  assert.match(launcher, /the application image's label could not be read \(.*\); refusing to launch an image whose integrity is unknown/)
  assert.match(launcher, /\} finally \{[\s\S]*?Restore-CallerEnvironment[\s\S]*?\n\}/, 'an enclosing finally restores the environment')
  // Optional overrides exist for a parent-rebuilt image and qualified sealed payload.
  for (const parameter of ['$ExecutablePath', '$RuntimeDirectory', '$ShellDirectory']) {
    assert.ok(launcher.includes(parameter), `the launcher exposes ${parameter}`)
  }
})

test('build.ps1 verify asserts the affected UI tests and the seven declared suites', () => {
  const script = readFileSync(join(portRoot, 'scripts', 'build.ps1'), 'utf8')
  const code = script.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.match(code, /native-guests\/tests/, 'the verify stage asserts the guest tests are in the UI test script')
  assert.match(code, /build:verify/, 'the verify stage asserts a build:verify script exists')
  assert.match(code, /Declared packaging suite is missing/, 'a deleted declared suite fails the build')
  // The pre-existing locked/offline contract must survive.
  assert.match(code, /Invoke-Checked 'cargo' @\('test', '--workspace', '--locked', '--offline', '--test', 'protocol_fixtures'\)/)
})

test('the Rust preflight prepares an outside root and runs no build, test or launch', () => {
  const runner = read(join('tests', 'run-rust-qualification.ps1'))
  assert.match(runner, /New-DshRustQualificationRoot/, 'it creates the outside target/TEMP root')
  assert.match(runner, /READY_ENV=/, 'it prints the ready per-child environment')
  assert.match(runner, /READY_CARGO_ARGS=/, 'it prints the ready cargo arguments')
  assert.match(runner, /READY_CONTEXT_JSON=/, 'it persists the context the parent consumes')
  assert.match(runner, /profile\.dev\.debug=0/, 'the D8050 mitigation is part of the ready arguments')
  assert.match(runner, /Get-DshRustToolchainEvidence/, 'cargo/rustc are evidenced')
  assert.match(runner, /Invoke-DshTrustedCopySelfTest/, 'the copy helper is exercised on a scoped fixture')
  const code = runner.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(code, /&\s*cargo\b/, 'it never invokes cargo')
  // The ready notes NAME Start-Process to warn that its -PassThru exit code can be
  // null on PS 5.1; what must be absent is an actual Start-Process invocation.
  assert.doesNotMatch(code, /Start-Process -FilePath|Start-Process \$/, 'it never starts a process')
})

test('the Rust helper keeps the parent environment intact, reads labels and never relabels', () => {
  const module = read(join('tests', 'packaging', 'rust-qualification.psm1'))
  const code = module.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  for (const banned of ['/setintegritylevel', 'Set-Acl', 'SetSecurityInfo', 'icacls', 'takeown']) {
    assert.ok(!code.includes(banned), `the Rust helper never calls ${banned}`)
  }
  assert.match(code, /EnvironmentVariables\[\$key\] = \[string\]\$Environment\[\$key\]/, 'overrides are applied per child')
  assert.match(code, /CARGO_TARGET_DIR = \$target/, 'the outside target directory is an override, not a global')
  assert.match(code, /TEMP = \$temp/, 'the owned TEMP is an override, not a global')
  assert.match(code, /ChildTokenKnown/, 'the actual child token is recorded')
  assert.match(code, /Refusing it rather than relabelling anything/, 'a Low toolchain is refused, not relabelled')
  assert.match(code, /Test-DshRustTargetTrust/, 'the target root trust is re-checkable')
  assert.match(code, /New-DshRustCheckpoint/, 'each gate gets a fresh checkpoint directory')
  assert.match(code, /Get-DshRustPreflightContext/, 'one call returns env, args, checkpoint and trust')
})

test('the integrity reader checks the ACE type and its flags, not just the first ACE', () => {
  // Two real misreads were found and fixed while preparing the Rust gates: reading
  // the first SACL ACE blindly reported a High label for C:\ (an audit ACE came
  // first), and comparing the ACE WORD to 0x11 skipped every INHERITED label, which
  // made an explicitly Low file read as "absent".
  const module = read(join('tests', 'packaging', 'qualification-preflight.psm1'))
  const code = module.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.match(code, /0x11/, 'the mandatory-label ACE type is matched explicitly')
  assert.match(code, /&\s*0xFF/, 'the AceFlags byte is masked off before comparing the type')
  assert.match(code, /aceCount/, 'the SACL is scanned for the label ACE rather than assuming index 0')
  assert.match(code, /InheritedLabel/, 'the enforced level and the inherited level are reported separately')
})

test('dev-e2e owns a fresh per-run root and never deletes a previous run', () => {
  const launcher = readFileSync(join(portRoot, 'scripts', 'dev-e2e.ps1'), 'utf8')
  assert.match(launcher, /dev-e2e-\$RunName/, 'the run root is per-run')
  assert.match(launcher, /ValidatePattern\('\^\[A-Za-z0-9\]\[A-Za-z0-9-\]\{0,31\}\$'\)/, 'a caller may name the run, within a strict pattern')
  assert.match(launcher, /the per-run root already exists/, 'an existing run root is refused (the handoff create is exclusive)')
  assert.match(launcher, /CREATE_NEW/, 'the exclusive-create requirement is documented in the launcher')
  const code = launcher.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  assert.doesNotMatch(code, /Remove-Item \$RunHome -Recurse/, 'the run home is never removed')
  assert.doesNotMatch(code, /Remove-Item \$UrlFile/, 'the handoff file is never deleted')
  assert.doesNotMatch(code, /Remove-Item \$BootFile/, 'the boot file is never deleted')
  assert.match(code, /CARGO_TARGET_DIR/, 'the build honours an outside target directory')
  assert.match(code, /Get-DshPinnedQualificationNode|Get-DshFileIntegrityLabel/, 'interpreter and image labels are read')
  assert.doesNotMatch(code, /DSH_DESKTOP_NODE = \(Get-Command node\)\.Source/, 'the runtime interpreter is not taken blindly from PATH')
})

test('the exported resolver really resolves in Windows PowerShell 5.1', async () => {
  // A source-text assertion cannot catch an undefined command: the launcher called a
  // helper that exists only inside build.ps1. This EXECUTES a PS 5.1 child that imports
  // JUST the module and asks for the command, so an unexported or misspelled function
  // fails here instead of at launch time.
  if (process.platform !== 'win32') return
  const { spawnSync } = await import('node:child_process')
  const powershell = process.env.DSH_PACKAGING_POWERSHELL
    ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    `Import-Module '${join(portRoot, 'tests', 'packaging', 'rust-qualification.psm1')}' -Force`,
    '$exported = Get-Command -Name Resolve-DshTrustedExecutionNode -ErrorAction SilentlyContinue',
    'if ($null -eq $exported) { Write-Host "MISSING-EXPORT"; exit 9 }',
    'if (-not $exported.Parameters.ContainsKey("PinManifestPath")) { Write-Host "MISSING-PARAM"; exit 9 }',
    '$wrapper = Get-Command -Name Resolve-DshStagingExecutionNode -ErrorAction SilentlyContinue',
    'if ($null -ne $wrapper) { Write-Host "UNEXPECTED-WRAPPER-EXPORT"; exit 9 }',
    'Write-Host "EXPORT-OK"; exit 0',
  ].join('\n')
  const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  assert.equal(result.status, 0, `the exported resolver must load in PS 5.1: ${output}`)
  assert.match(output, /EXPORT-OK/, 'the resolver and its -PinManifestPath parameter are exported')
})

test('the gate actually builds the UI and the qualified build keeps esbuild trusted', () => {
  const gate = read(join('tests', 'run-verification-gate.ps1'))
  // A text check on `build:verify` proved nothing: the gate must INVOKE the build and
  // require numeric artifact evidence.
  assert.match(gate, /Invoke-DshQualifiedUiBuild -PortRoot \$PortRoot -OwnedRoot \$uiBuildRoot -OutDir \(Join-Path \$uiBuildRoot 'dist'\)/,
    'the gate runs the real production build into a fresh path inside its own owned root')
  assert.match(gate, /fresh=\$\(\$uiBuild\.FreshOutDir\) outDir=\$\(\$uiBuild\.OutDir\)/, 'the fresh root and the published output are both reported')
  assert.match(gate, /Add-GatePass 'ui-production-build'/, 'the build is reported as its own gate id')
  assert.match(gate, /Add-GateFailure 'ui-production-build'/, 'a failed build fails the gate')
  assert.match(gate, /files=\$\(\$uiBuild\.Files\) assets=\$\(\$uiBuild\.Assets\) bytes=\$\(\$uiBuild\.Bytes\)/, 'the pass carries numeric counts')
  assert.match(gate, /\$uiBuild\.Files -le 0 -or \$uiBuild\.Assets -le 0 -or \$uiBuild\.Bytes -le 0/, 'zero counts are a failure, not a pass')

  const module = read(join('tests', 'packaging', 'ui-build-qualification.psm1'))
  assert.match(module, /@esbuild\+win32-x64@\$ExpectedVersion/, 'the esbuild package is resolved by exact version directory, never a glob')
  assert.match(module, /DefaultEsbuildVersion = '0\.25\.12'/, 'the locked version is 0.25.12')
  assert.match(module, /refusing a substituted compiler/, 'a version mismatch is refused')
  assert.match(module, /Copy-DshTrustedPlainCopy -SourceRoot \$locked\.PackageRoot/, 'the compiler is copied outside, not executed in place')
  assert.match(module, /ESBUILD_BINARY_PATH = \$copiedExe/, 'the child is given the trusted copy')
  assert.match(module, /afterSha -ne \$locked\.Sha256/, 'the copy is hashed after copying')
  assert.match(module, /refusing to build into a non-fresh output root/, 'the output root must be fresh')
  for (const artifact of ['index.html', 'policy-bootstrap', 'assets']) {
    assert.ok(module.includes(artifact), `the artifact check requires ${artifact}`)
  }
  for (const banned of ['/setintegritylevel', 'Set-Acl', 'SetSecurityInfo', 'icacls']) {
    assert.ok(!module.includes(banned), `the UI build helper never calls ${banned}`)
  }

  // The output root is now a FRESH path inside an explicitly fenced owned root,
  // and the normal `dist` is reached only by atomic publication.
  assert.match(module, /function Assert-DshUiOwnedRootFence/, 'the owned-root fence exists')
  assert.match(module, /Assert-DshNoLinkedAncestors -Path \$OwnedRoot/, 'the owned root has no linked ancestor')
  assert.match(module, /is Low integrity \(.*\) while this process is/, 'a Low owned root under a Medium parent is refused, never relabelled')
  assert.match(module, /inside the labelled upstream tree/, 'an owned root inside the labelled upstream tree is refused')
  assert.match(module, /not canonically contained in the owned root/, 'the fresh output must be canonically contained in the owned root')
  assert.match(module, /Test-DshPathContained/, 'containment is a separator-aware comparison, not a bare prefix test')
  assert.match(module, /refusing to build into a non-fresh output root: \$freshOut \(an existing \$kind\$link is present\)/,
    'ANY existing entry at the leaf is refused, not only a non-empty directory')
  assert.match(module, /'--outDir', \$freshOut, '--emptyOutDir'/, 'Vite is pointed at the fresh owned path only')
  assert.match(module, /New-DshStageRoot -PublishedPath \$target -Name \$stageName/, 'publication stages a sibling of the target')
  assert.match(module, /Publish-DshStagedTree -StagedPath \$stage -PublishedPath \$target/, 'the shared publish machinery performs the swap')
  assert.match(module, /Restore-DshPublishedTree -PublishedPath \$target/, 'a failed publication rolls back')
  assert.match(module, /UI_BUILD_RETAINED_BACKUP=/, 'a backup from an earlier run is retained under a unique name')
  // The comments NAME `Complete-DshPublishedTree` to explain why it is not called;
  // what must be absent is an actual invocation.
  assert.ok(!module.includes('Complete-DshPublishedTree -PublishedPath'), 'the UI publication never commits, so the previous tree is retained')
  assert.ok(!/Remove-Item[^\n]*\$target/.test(module), 'nothing is removed in place at the publication target')
})

test('build.ps1 UI stage uses the pinned interpreter, not an arbitrary pnpm', () => {
  const script = readFileSync(join(portRoot, 'scripts', 'build.ps1'), 'utf8')
  const buildUi = script.slice(script.indexOf('function Build-Ui'), script.indexOf('function Build-Core'))
  assert.match(buildUi, /Invoke-DshQualifiedUiBuild -PortRoot \$PortRoot -OutDir \(Join-Path \$UiDir 'dist'\)/, 'the UI stage delegates to the qualified build')
  assert.doesNotMatch(buildUi, /Invoke-Checked 'pnpm' @\('run', 'build'\)/, 'no arbitrary pnpm build remains')

  // The normal `dist` is an EXISTING output tree: the stage must hand it to the
  // helper as the publication target, and the helper - never Vite - reaches it.
  assert.match(buildUi, /-StagedNodeExecutable \$AttestedNodePath -NodeArchivePath \$NodeArchivePath -AllowNodeDownload:\$AllowNodeDownload/,
    'a fresh checkout can supply an attested interpreter and the pinned archive')
  assert.match(buildUi, /published=\$\(\$uiBuild\.Published\) previous=\$\(\$uiBuild\.PreviousPath\)/,
    'the retained previous tree is reported')
  // The plugin bundling re-spawns process.execPath, so the qualified interpreter
  // must be the one that runs it - a bare `node` from PATH decided both.
  assert.doesNotMatch(buildUi, /Invoke-Checked 'node' @\('bundle\.mjs'\)/, 'the plugin bundler is not run with an arbitrary node')
  assert.match(buildUi, /Invoke-DshQualifiedNodeScript -NodePath \$uiBuild\.NodePath -TempRoot \$uiBuild\.TempDir/,
    'the plugin bundler runs on the qualified pinned interpreter with the owned temp')

  // The fresh-checkout fallback is real and fails closed: the helper acquires the
  // pinned archive only when the staged payload interpreter is absent.
  const module = read(join('tests', 'packaging', 'ui-build-qualification.psm1'))
  assert.match(module, /Install-DshPinnedNode -ManifestPath \$pinPath -TargetName \(Get-DshUiNodeTargetName\)/,
    'the pinned archive is the fresh-checkout source of the interpreter')
  assert.match(module, /-ArchivePath \$NodeArchivePath -AllowDownload:\$AllowNodeDownload/, 'the build-supplied archive and opt-in download are passed through')
  assert.match(module, /never falls back to a system Node\.js|never substitutes a system Node\.js/, 'a missing archive fails closed')
  assert.doesNotMatch(module, /Get-Command node/, 'there is no system-node lookup')
})

test('the gate Node lanes use ONE per-child environment and never mutate the caller', () => {
  const gate = read(join('tests', 'run-verification-gate.ps1'))
  const code = gate.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  // The fixture adapters prefer DSH_ADAPTER_INTEGRATION_NODE over process.execPath,
  // so an ambient value could name a Low interpreter inside the labelled workspace.
  assert.match(code, /function Invoke-DshGateNode/, 'one owned-child launcher exists for the Node lanes')
  assert.match(code, /Invoke-DshOwnedChild -FilePath \$NodeExe -Arguments \$Arguments/, 'it goes through the per-child launcher')
  assert.match(code, /\$overrides\['DSH_ADAPTER_INTEGRATION_NODE'\] = \$NodeExe/, 'the trusted interpreter is named explicitly on the child')
  assert.match(code, /TEMP = \$script:NodeChildTemp/, 'the child TEMP is the owned preflight temp')
  assert.match(code, /TMP = \$script:NodeChildTemp/, 'the child TMP is the owned preflight temp')
  assert.match(code, /TMPDIR = \$script:NodeChildTemp/, 'the child TMPDIR is the owned preflight temp')
  assert.match(code, /\$script:NodeChildRoot = if \(\$Preflight -and \$Preflight\.Root\) \{ \$Preflight\.Root \} else \{ \$OwnedRoot \}/,
    'the owned temp lives in this run\'s preflight root')
  // Every Node invocation uses it, and none of them starts a child that would
  // inherit the ambient environment.
  assert.equal((code.match(/Invoke-DshGateNode -NodeExe \$nodeExe/g) ?? []).length, 4,
    'the node, packaging, vitest and tsc lanes all use the per-child launcher')
  assert.doesNotMatch(code, /Invoke-DshNativeChecked -FilePath \$nodeExe/, 'no Node lane inherits the ambient environment')
  // The caller's environment is never written, so there is nothing to restore and
  // no absent-versus-empty question to get wrong.
  for (const banned of [/\$env:DSH_ADAPTER_INTEGRATION_NODE\s*=/, /\$env:TEMP\s*=/, /\$env:TMP\s*=/, /\$env:TMPDIR\s*=/]) {
    assert.doesNotMatch(code, banned, 'the gate never writes the caller environment')
  }
  assert.match(code, /Import-Module \(Join-Path \$PackagingTests 'rust-qualification\.psm1'\) -Force/, 'the per-child launcher is imported')
})

test('the qualified UI build refuses an existing output leaf and an unfenced owned root (behavioural)', windowsOnly, () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-uiq-fresh-'))
  try {
    const owned = join(base, 'owned')
    mkdirSync(owned)
    const elsewhere = join(base, 'elsewhere')
    mkdirSync(elsewhere)
    const junctionTarget = join(base, 'junction-target')
    mkdirSync(junctionTarget)
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${uiBuildModule}' -Force -Global
$results = New-Object System.Collections.ArrayList
function Probe([string]$label, [scriptblock]$body) {
  try { $null = & $body; [void]$results.Add("$label=NO-REFUSAL") }
  catch { [void]$results.Add("$label=$($_.Exception.Message)") }
}
$leaf = Join-Path '${owned}' 'fresh-dist'
$null = New-Item -ItemType Directory -Path $leaf
Probe 'EMPTYDIR' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot '${owned}' }
Remove-Item -LiteralPath $leaf -Recurse -Force
Set-Content -LiteralPath $leaf -Value 'a plain file' -Encoding Ascii
Probe 'FILE' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot '${owned}' }
Remove-Item -LiteralPath $leaf -Force
$linked = $false
try { $null = New-Item -ItemType Junction -Path $leaf -Target '${junctionTarget}' -ErrorAction Stop; $linked = $true } catch { }
if ($linked) {
  Probe 'JUNCTION' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot '${owned}' }
  Remove-Item -LiteralPath $leaf -Force
} else {
  [void]$results.Add('JUNCTION=UNSUPPORTED')
}
Probe 'CONTAINMENT' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot '${owned}' -FreshOutDir (Join-Path '${elsewhere}' 'fresh') }
Probe 'ABSENTROOT' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot (Join-Path '${base}' 'absent-owned') }
Probe 'LOWROOT' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot '${join(repoRoot, '_upstream')}' }
Probe 'ABSENTPARENT' { Invoke-DshQualifiedUiBuild -PortRoot '${portRoot}' -OwnedRoot '${owned}' -OutDir '${join(base, 'missing-parent', 'dist')}' }
$results -join "\`n"
`
    const result = runPowerShell(script.split('\n'))
    assert.equal(result.error, undefined, `the probe script must start: ${result.output}`)
    assert.equal(result.status, 0, `the probe script must complete: ${result.output}`)
    assert.match(result.output, /^EMPTYDIR=refusing to build into a non-fresh output root: .*an existing directory is present/m,
      'an existing EMPTY directory is refused before Vite runs')
    assert.match(result.output, /^FILE=refusing to build into a non-fresh output root: .*an existing file is present/m,
      'a plain file at the output leaf is refused')
    if (!/^JUNCTION=UNSUPPORTED/m.test(result.output)) {
      assert.match(result.output, /^JUNCTION=.*(refusing to build into a non-fresh output root|traverses a reparse point)/m,
        'a junction at the output leaf is refused')
    }
    assert.match(result.output, /^CONTAINMENT=The fresh build output is not canonically contained in the owned root/m,
      'an output path outside the owned root is refused')
    assert.match(result.output, /^ABSENTROOT=The owned build root is absent/m,
      'an owned root is never created implicitly from the workspace')
    // The fence refuses a reparse-point build root before it can compare roots at
    // all, and `_upstream` is a directory junction in a linked worktree. That is
    // still this probe's required outcome (the root is refused), so the fence's
    // own refusal message belongs in the accepted set.
    assert.match(result.output, /^LOWROOT=.*(traverses a reparse point|is a reparse point|is Low integrity|inside the labelled upstream tree)/m,
      'a workspace/upstream root is refused as a build root')
    assert.match(result.output, /^ABSENTPARENT=The UI output parent directory is absent/m,
      'a publication target whose parent is absent is refused')
    assert.doesNotMatch(result.output, /=NO-REFUSAL/, 'no probe was silently accepted')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('publication retains the previous tree, is repeatable and destroys nothing (behavioural)', windowsOnly, () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-uiq-publish-'))
  try {
    const makeTree = (name, marker, assetPrefix) => {
      const root = join(base, name)
      mkdirSync(join(root, 'assets'), { recursive: true })
      writeFileSync(join(root, 'index.html'), `<html>${marker}</html>`)
      writeFileSync(join(root, 'desktop-policy-bootstrap.json'), JSON.stringify({ marker }))
      for (const n of [1, 2, 3]) writeFileSync(join(root, 'assets', `${assetPrefix}${n}.js`), `console.log(${n})`)
      return root
    }
    const freshOne = makeTree('fresh-one', 'ONE', 'a')
    const freshTwo = makeTree('fresh-two', 'TWO', 'b')
    const target = join(base, 'published')
    mkdirSync(target)
    writeFileSync(join(target, 'old-marker.txt'), 'ORIGINAL-ONE')

    const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${uiBuildModule}' -Force -Global
$first = Publish-DshUiBuildTree -FreshPath '${freshOne}' -PublishedPath '${target}' -MinAssets 1 -MinFiles 4
$second = Publish-DshUiBuildTree -FreshPath '${freshTwo}' -PublishedPath '${target}' -MinAssets 1 -MinFiles 4
$failed = 'no'
try { $null = Publish-DshUiBuildTree -FreshPath '${join(base, 'fresh-one')}' -PublishedPath '${join(base, 'no-such-parent', 'published')}' -MinAssets 1 -MinFiles 4 } catch { $failed = 'refused' }
Write-Host "FIRST_PREVIOUS=$($first.PreviousPath)"
Write-Host "SECOND_RETAINED=$($second.RetainedBackups.Count)"
Write-Host "SECOND_PREVIOUS=$($second.PreviousPath)"
Write-Host "PUBLISH_FAILED=$failed"
`
    const result = runPowerShell(script.split('\n'))
    assert.equal(result.error, undefined, `the publication probe must start: ${result.output}`)
    assert.equal(result.status, 0, `the publication probe must complete: ${result.output}`)

    // The current tree is the second fresh tree; the FIRST published tree is the
    // immediate backup, and the ORIGINAL tree was moved aside, not deleted.
    assert.equal(readFileSync(join(target, 'index.html'), 'utf8'), '<html>TWO</html>', 'the second tree is published')
    assert.equal(existsSync(join(target, 'old-marker.txt')), false, 'the original tree is no longer at the target')
    const immediate = `${target}.previous`
    assert.ok(existsSync(immediate), 'the immediately previous tree is retained at <target>.previous')
    assert.equal(readFileSync(join(immediate, 'index.html'), 'utf8'), '<html>ONE</html>', 'the retained backup is the first published tree')
    assert.match(result.output, /^SECOND_RETAINED=1$/m, 'exactly one earlier backup was moved aside')
    const archived = readdirSync(base).filter(name => name.startsWith('published.previous-'))
    assert.equal(archived.length, 1, `the ORIGINAL tree is retained under a unique name, found: ${archived.join(', ')}`)
    assert.equal(readFileSync(join(base, archived[0], 'old-marker.txt'), 'utf8'), 'ORIGINAL-ONE', 'the original content survives verbatim')
    assert.match(result.output, /^PUBLISH_FAILED=refused$/m, 'a publication whose parent is absent is refused')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('a per-child environment override is applied to the child and never leaks (behavioural)', windowsOnly, () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-uiq-env-'))
  try {
    const childTemp = join(base, 'child-temp')
    mkdirSync(childTemp)
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${uiBuildModule}' -Force -Global
$trusted = (Get-DshPinnedQualificationNode -PortRoot '${portRoot}').Path
Write-Host "TRUSTED=$trusted"
$env:DSH_ADAPTER_INTEGRATION_NODE = 'C:\\poisoned\\node.exe'
$env:TEMP = 'C:\\poisoned-temp'
$env:TMP = 'C:\\poisoned-temp'
Remove-Item -LiteralPath 'Env:DSH_UIQ_PROBE_ABSENT' -ErrorAction SilentlyContinue
$code = 'console.log([process.env.DSH_ADAPTER_INTEGRATION_NODE, process.env.TEMP, process.env.DSH_UIQ_PROBE_ABSENT === undefined ? "<absent>" : "leaked"].join("|"))'
$run = Invoke-DshOwnedChild -FilePath $trusted -Arguments @('-e', $code) -WorkingDirectory '${base}' -Environment @{ DSH_ADAPTER_INTEGRATION_NODE = 'C:\\trusted\\node.exe'; TEMP = '${childTemp}'; TMP = '${childTemp}'; TMPDIR = '${childTemp}' } -TimeoutSeconds 120
Write-Host "CHILD=$($run.StandardOutput)"
Write-Host "CHILD_TOKEN=$($run.ChildTokenKnown):$($run.ChildTokenLevel)"
Write-Host "CALLER_NODE=$env:DSH_ADAPTER_INTEGRATION_NODE"
Write-Host "CALLER_TEMP=$env:TEMP"
Write-Host "CALLER_TMP=$env:TMP"
Write-Host "CALLER_ABSENT=$($null -eq (Get-Item -LiteralPath 'Env:DSH_UIQ_PROBE_ABSENT' -ErrorAction SilentlyContinue))"
`
    const result = runPowerShell(script.split('\n'))
    assert.equal(result.error, undefined, `the environment probe must start: ${result.output}`)
    assert.equal(result.status, 0, `the environment probe must complete: ${result.output}`)
    assert.match(result.output, /^CHILD=C:\\trusted\\node\.exe\|.*child-temp\|<absent>$/m,
      'the child sees the override, the owned temp and the absent variable still absent')
    assert.match(result.output, /^CHILD_TOKEN=True:medium$/m, 'the child runs at the trusted Medium integrity')
    assert.match(result.output, /^CALLER_NODE=C:\\poisoned\\node\.exe$/m, 'the poisoned caller value is untouched')
    assert.match(result.output, /^CALLER_TEMP=C:\\poisoned-temp$/m, 'the caller TEMP is untouched')
    assert.match(result.output, /^CALLER_TMP=C:\\poisoned-temp$/m, 'the caller TMP is untouched')
    assert.match(result.output, /^CALLER_ABSENT=True$/m, 'a variable that was absent stays absent')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the fresh-checkout interpreter comes from the pinned archive or not at all (behavioural)', windowsOnly, () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-uiq-node-'))
  try {
    const owned = join(base, 'owned')
    mkdirSync(owned)
    const emptyCache = join(base, 'empty-cache')
    mkdirSync(emptyCache)
    const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${uiBuildModule}' -Force -Global
$message = 'NO-REFUSAL'
try {
  $null = Resolve-DshQualifiedUiNode -PortRoot '${portRoot}' -OwnedRoot '${owned}' -PayloadNodePath '${join(base, 'absent', 'node.exe')}' -NodeArchiveCacheRoot '${emptyCache}'
} catch { $message = $_.Exception.Message }
Write-Host "NOARCHIVE=$message"
$exported = Get-Command -Name Resolve-DshQualifiedUiNode -ErrorAction SilentlyContinue
if ($null -eq $exported) { Write-Host 'MISSING-EXPORT'; exit 9 }
foreach ($parameter in @('PortRoot', 'OwnedRoot', 'PayloadNodePath', 'StagedNodeExecutable', 'NodeArchivePath', 'NodeArchiveCacheRoot', 'AllowNodeDownload')) {
  if (-not $exported.Parameters.ContainsKey($parameter)) { Write-Host "MISSING-PARAM:$parameter"; exit 9 }
}
$build = Get-Command -Name Invoke-DshQualifiedUiBuild
foreach ($parameter in @('OwnedRoot', 'FreshOutDir', 'OutDir', 'PayloadNodePath', 'StagedNodeExecutable', 'NodeArchivePath')) {
  if (-not $build.Parameters.ContainsKey($parameter)) { Write-Host "MISSING-BUILD-PARAM:$parameter"; exit 9 }
}
Write-Host 'PARAMS-OK'
`
    const result = runPowerShell(script.split('\n'))
    assert.equal(result.error, undefined, `the interpreter probe must start: ${result.output}`)
    assert.equal(result.status, 0, `the interpreter probe must complete: ${result.output}`)
    assert.match(result.output, /^NOARCHIVE=Pinned Node .* is not available locally and download is disabled\./m,
      'a fresh checkout without a verified archive is refused with guidance')
    assert.match(result.output, /never falls back to a system Node\.js/, 'the refusal states that no system Node is substituted')
    assert.match(result.output, /^PARAMS-OK$/m, 'the module exports its new parameters in real PS 5.1')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the runtime stage records the interpreter BINARY digest beside the archive digest', () => {
  const script = readFileSync(join(portRoot, 'scripts', 'build.ps1'), 'utf8')
  const code = script.split(/\r?\n/).filter(line => !/^\s*#/.test(line)).join('\n')
  const install = code.slice(code.indexOf('function Install-PinnedNodeInto'), code.indexOf('function Write-DshNodeStagingRecord'))
  assert.ok(install.length > 0, 'the pinned-Node payload installer is present')

  // The BINARY digest is observed twice, from the verified staged bytes before the
  // move and from the shipped bytes after it, and the two must agree. Recording only
  // the staging-location digest would promise a file that no longer exists.
  assert.match(install, /\$stagedExecutable = \$Identity\.Executable/, 'the verified staged interpreter is the first source')
  assert.match(install, /\$stagedExecutableSha256 = \(Get-FileHash -LiteralPath \$stagedExecutable -Algorithm SHA256\)/, 'the staged bytes are hashed')
  assert.match(install, /\$payloadExecutable = Join-Path \$nodeTarget \$Identity\.RelativeExecutable/, 'the shipped interpreter path is derived from the payload root')
  assert.match(install, /\$executableSha256 = \(Get-FileHash -LiteralPath \$payloadExecutable -Algorithm SHA256\)/, 'the shipped bytes are hashed')
  assert.match(install, /if \(\$executableSha256 -ne \$stagedExecutableSha256\) \{/, 'a move that changed the bytes is refused')
  const move = install.indexOf('Move-Item -LiteralPath $identity.Root -Destination $nodeTarget')
  assert.ok(move > -1, 'the verified tree is installed into the payload')
  assert.ok(install.indexOf('$stagedExecutableSha256 =') < move, 'the staged digest is observed BEFORE the move')
  assert.ok(install.indexOf('$executableSha256 =') > move, 'the shipped digest is observed AFTER the move')

  // The two digests are separate facts: the archive pin is not overloaded, and the
  // field the sealer reserves for "observation equals the pinned hash" is not emitted.
  assert.match(install, /ExecutableSha256 = \$executableSha256/, 'the new record carries the binary digest')
  assert.match(install, /Sha256\s+= \$identity\.Sha256/, 'the archive digest is recorded unchanged')
  assert.doesNotMatch(install, /RecordSha/, 'RecordSha is not invented: the sealer requires it to equal the archive pin')

  // The payload metadata carries the same observation, and a legacy identity record
  // that lacks it stays valid rather than producing a null field.
  assert.match(code, /\$executableDigest = \$nodeIdentity\.PSObject\.Properties\['ExecutableSha256'\]/, 'the field is read without assuming it exists')
  assert.match(code, /\$manifest\.node \| Add-Member -NotePropertyName 'executableSha256' -NotePropertyValue \(\[string\]\$executableDigest\.Value\)/,
    'the payload node record carries executableSha256')
  assert.match(code, /New-DshPayloadManifest -Root \$stagedPayload/, 'the record still comes from the shipped tree inventory')
})

test('the recorded binary digest is exactly what the runtime sealer enforces (behavioural)', windowsOnly, async () => {
  // The producer change is only correct if the consumer accepts its output, so the
  // REAL sealer validator is executed against a record with the producer's field set.
  const { validateIdentity } = await import(pathToFileURL(join(portRoot, 'scripts', 'lib', 'seal-runtime.mjs')).href)
  const base = mkdtempSync(join(tmpdir(), 'dsh-node-identity-'))
  try {
    const payloadRoot = join(base, 'payload')
    const nodeDir = join(payloadRoot, 'node')
    mkdirSync(nodeDir, { recursive: true })
    // The validator requires a bounded, nonempty regular file whose bytes the running
    // image also has; it does not require a real Node binary for an identity check.
    const interpreter = join(nodeDir, 'node.exe')
    writeFileSync(interpreter, 'pinned interpreter fixture bytes\n')
    const executableSha256 = createHash('sha256').update(readFileSync(interpreter)).digest('hex')
    const archiveSha256 = 'b'.repeat(64)

    const stage = { schemaVersion: 1, version: '0.1.7-rc.2', pnpmVersion: '11.7.0', hostProtocolVersion: 4, platform: 'win32', arch: 'x64' }
    const node = {
      NodeVersion: '22.20.0', Target: 'win-x64',
      Url: 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip',
      Sha256: archiveSha256,
      ExecutableSha256: executableSha256,
      Source: 'cache', License: 'NODE-LICENSE.txt', LicenseSpdx: 'MIT',
      Executable: 'dsh/node/node.exe',
    }
    const processInfo = { versions: { node: '22.20.0' }, platform: 'win32', arch: 'x64', execPath: interpreter }
    const args = { stage, node, payloadRoot, processInfo }

    const accepted = validateIdentity(args)
    assert.equal(accepted.nodeVersion, '22.20.0', 'a record with the binary digest is accepted')
    assert.notEqual(archiveSha256, executableSha256, 'the archive digest and the binary digest are different facts')
    assert.throws(() => validateIdentity({ ...args, node: { ...node, ExecutableSha256: archiveSha256 } }),
      /pinned executable digest/, 'the ARCHIVE digest is refused as the binary digest, so the two cannot be conflated')
    assert.throws(() => validateIdentity({ ...args, node: { ...node, ExecutableSha256: 'c'.repeat(64) } }),
      /pinned executable digest/, 'a digest that does not describe the shipped bytes is refused')
    const legacy = { ...node }
    delete legacy.ExecutableSha256
    assert.equal(validateIdentity({ ...args, node: legacy }).nodeVersion, '22.20.0',
      'a legacy record without the field still verifies')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})

test('the gate file lives at the path the build and the docs name', () => {
  assert.ok(existsSync(join(repoRoot, 'port', 'tests', 'run-verification-gate.ps1')))
})
