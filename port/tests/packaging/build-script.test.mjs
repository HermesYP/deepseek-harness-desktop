/**
 * Regression tests for `port/scripts/build.ps1`.
 *
 * The build script is the artifact the packaging audit holds responsible for four
 * distinct defects, each of which produced a failure that named the wrong cause:
 *
 *   * in-place removal of a published resource root, which made every concurrent
 *     `cargo` command fail with a resource-path error (F-41), and which a running
 *     application could block outright by holding a native module open (F-46);
 *   * the two resource roots not being produced before the compile that validates
 *     them;
 *   * a scratch variable named `$home`, which PowerShell silently refuses to
 *     assign because `$HOME` is read-only, so an application once ran with
 *     `DSH_HOME=C:\Users\<user>` (F-36);
 *   * a build that packaged whichever Node.js happened to be on the build
 *     machine, so the installer was not self-contained (F-20, P9).
 *
 * These tests read the script text and assert the contract. They are not a
 * substitute for running a build; the lane report says so explicitly.
 */

import { readFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync, rmSync, openSync, closeSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import assert from 'node:assert/strict'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const portRoot = join(here, '..', '..')
const scriptPath = join(portRoot, 'scripts', 'build.ps1')
const script = readFileSync(scriptPath, 'utf8')

/** The script with comment-only lines removed, so prose about a defect is not read as the defect. */
const code = script
  .split(/\r?\n/)
  .filter(line => !/^\s*#/.test(line))
  .join('\n')

test('fresh client artifacts are accepted only for owned runtime qualification and recorded before sealing', () => {
  assert.match(code, /\$Stage -ne 'runtime' -or -not \$RuntimeQualificationName/)
  assert.match(code, /\$qualificationClientBuild = Join-Path \$Scratch \$ClientUpdatesQualificationBuildName/)
  assert.match(code, /Qualification plugin input is not a materialized/)
  assert.match(code, /\$from = Join-Path \$qualificationClientBuild \(Split-Path \$file -Leaf\)/)
  assert.match(code, /qualificationClientBuild:\$name/)
})

test('the script parses as ASCII with no BOM', () => {
  const bytes = readFileSync(scriptPath)
  // Windows PowerShell 5.1 decodes a BOM-less file as ANSI, so a non-ASCII byte
  // silently changes the script (finding F-27).
  const nonAscii = [...bytes].filter(byte => byte > 127)
  assert.equal(nonAscii.length, 0, 'every byte is ASCII')
  assert.ok(!(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf), 'no UTF-8 BOM')
})

test('no scratch variable is named home or HOME', () => {
  // `$HOME` is read-only and variable names are case-insensitive, so the
  // assignment fails silently and the caller exports whatever `$home` held
  // (finding F-36).
  assert.doesNotMatch(code, /\$home\b/i, 'the script never uses $home/$HOME')
  assert.doesNotMatch(code, /^\s*\$home\s*=/im, 'the script never assigns $home')
})

test('the isolated harness home is asserted to be under the scratch root before export', () => {
  assert.match(code, /Use-IsolatedHarnessHome/, 'an isolation helper exists')
  assert.match(code, /StartsWith\(\$scratchRoot/, 'the resolved home is checked against the scratch root')
  assert.match(code, /Refusing to use an isolated home outside the scratch root/)
})

test('the published runtime payload is never removed in place', () => {
  // The defect: `Remove-Item $payload -Recurse -Force` followed by a rebuild.
  assert.doesNotMatch(code, /Remove-Item\s+\$PayloadDsh\b/, 'the published payload is not removed directly')
  assert.doesNotMatch(code, /Remove-Item\s+\$payload\b/, 'no payload root is removed directly')
  // The fix: stage beside it and swap by rename.
  assert.match(code, /Publish-DshStagedPayload -StageRoot \$stageRoot -PublishedPath \$PayloadDsh/)
  assert.match(code, /Repair-DshInterruptedPublication/, 'an interrupted publication is repaired first')
  assert.match(code, /Complete-DshPublishedTree/, 'publication is committed explicitly')
  assert.match(code, /Restore-DshPublishedTree/, 'a failed publication rolls back')
})

test('each runtime stage owns a fresh sibling and preserves prior and failed evidence', () => {
  const stage = code.slice(code.indexOf('function Stage-Runtime {'), code.indexOf('function Stage-RuntimeInto'))
  assert.match(stage, /\$stageRoot = Join-Path \$PayloadRoot \('dsh\.s-' \+ \[guid\]::NewGuid\(\)/)
  assert.match(stage, /if \(Test-Path -LiteralPath \$stageRoot\) \{ throw/)
  assert.doesNotMatch(stage, /Remove-Item\s+\$stageRoot\b/)
  assert.match(stage, /preserved runtime build workspace/)
})

test('the staged tree is validated before publication and the published tree after', () => {
  const before = code.indexOf('Assert-DshStagedTree -Path $stageRoot')
  const publish = code.indexOf('Publish-DshStagedPayload -StageRoot $stageRoot')
  const after = code.indexOf('Assert-DshStagedTree -Path $PayloadDsh')
  assert.notEqual(before, -1, 'the staged tree is validated')
  assert.notEqual(publish, -1, 'publication happens')
  assert.notEqual(after, -1, 'the published tree is validated too')
  assert.ok(before < publish, 'validation precedes publication')
  assert.ok(publish < after, 'the published tree is re-validated after the swap')
})

test('the staging root and the payload root are validated against DIFFERENT contracts', () => {
  // The blocker: the payload top-level set was asserted against the staging root,
  // which legitimately holds `packed/`, `work/`, `node/`, the staging program and
  // the identity record. That rejected every correct stage, so `-Stage runtime`
  // could never complete and no payload manifest was ever written.
  assert.match(code, /Get-DshStagingTopLevel/, 'the staging root has its own declared top level')
  assert.match(code, /Get-DshStagedPayloadPath/, 'the inner payload path is named explicitly')

  // The staging assertion must NOT use the payload set.
  const stageAssert = code.slice(
    code.indexOf('Assert-DshStagedTree -Path $stageRoot'),
    code.indexOf('Assert-DshStagedTree -Path $stagedPayload') === -1
      ? code.indexOf('Assert-DshStagedTree -Path $PayloadDsh')
      : code.indexOf('Assert-DshStagedTree -Path $stagedPayload'))
  assert.match(stageAssert, /Get-DshStagingTopLevel/, 'the staging root is checked against the staging set')
  assert.doesNotMatch(stageAssert, /Get-DshPayloadTopLevel/,
    'the staging root is NEVER checked against the payload set')

  // The payload assertion must use the payload set, against the inner tree.
  const payloadAssert = code.slice(code.indexOf('Assert-DshStagedTree -Path $stagedPayload'),
    code.indexOf('Assert-DshStagedTree -Path $PayloadDsh'))
  assert.match(payloadAssert, /Get-DshPayloadTopLevel/, 'the staged payload is checked against the payload set')
  assert.match(payloadAssert, /-Required \$anchors/, 'the payload anchors are required')
  assert.match(payloadAssert, /-RequiredDirectories \$requiredDirectories/,
    'the payload anchor directories must be real directories')
})

test('the payload manifest is built over the published tree, not the workspace', () => {
  // Inventorying the staging root would fold the build's workspace into the
  // record and make every build differ, so the manifest must describe the shipped
  // tree only.
  assert.match(code, /New-DshPayloadManifest -Root \$stagedPayload/)
  assert.doesNotMatch(code, /New-DshPayloadManifest -Root \$stageRoot/)
  assert.match(code, /runtime-payload\.json/, 'the identity record travels inside the payload')
  assert.match(code, /Get-StagedHostProtocolVersion/,
    'the host protocol version is read back rather than left null')
  assert.match(code, /-HostProtocolVersion \(Get-StagedHostProtocolVersion -StageRoot \$stageRoot\)/)
})

test('the file count compared across the swap is the payload count, not the workspace count', () => {
  // Comparing a payload-root count against a staging-root count could never match.
  assert.match(code, /\$publishedFact\.FileCount -ne \$fact\.FileCount/)
  const factAssignment = code.slice(code.indexOf('$fact = Assert-DshStagedTree'),
    code.indexOf('$fact = Assert-DshStagedTree') + 300)
  assert.match(factAssignment, /stagedPayload/, 'the compared fact is the payload fact')
})

test('the resource stages run before any compile that validates their paths', () => {
  // Both roots are `bundle.resources` sources, and Tauri validates them at
  // build-script time, so an absent root fails cargo with a resource-path error
  // that names the wrong cause (finding F-41).
  assert.match(code, /function Assert-ResourceRootsForCompile/)
  assert.match(code, /The bundled UI resource root is absent or incomplete/)
  assert.match(code, /The bundled runtime resource root is absent/)

  const buildCore = code.indexOf('function Build-Core')
  const assertInCore = code.indexOf('Assert-ResourceRootsForCompile', buildCore)
  const cargoBuild = code.indexOf("Invoke-Checked 'cargo' $cargoArgs", buildCore)
  assert.ok(assertInCore > buildCore && assertInCore < cargoBuild,
    'core asserts its resource roots before running cargo')

  // The default `all` path stages ui and runtime before core in the dispatch tail.
  const dispatch = code.slice(code.indexOf('$doAll = $Stage -eq'))
  const uiIndex = dispatch.indexOf("if ($doAll -or $Stage -eq 'ui') { Build-Ui }")
  const runtimeIndex = dispatch.indexOf("if ($doAll -or $Stage -eq 'runtime') { Stage-Runtime }")
  const coreIndex = dispatch.indexOf("if ($doAll -or $Stage -eq 'core') { Build-Core }")
  assert.ok(uiIndex !== -1 && runtimeIndex !== -1 && coreIndex !== -1, 'the dispatch covers ui, runtime and core')
  assert.ok(uiIndex < coreIndex, 'the UI stage precedes core')
  assert.ok(runtimeIndex < coreIndex, 'the runtime stage precedes core')
})

test('core keeps locked dependency resolution and strict offline verification gates', () => {
  const core = code.slice(code.indexOf('function Build-Core'), code.indexOf('function Stage-Runtime'))
  assert.match(core, /\$cargoArgs = @\('build', '--workspace', '--locked'\)/)
  assert.match(core, /Invoke-Checked 'cargo' @\('test', '--workspace', '--locked', '--offline'\)/)
  assert.match(core, /Invoke-Checked 'cargo' @\('clippy', '--workspace', '--all-targets', '--locked', '--offline', '--', '-D', 'warnings'\)/)
})

test('workspace-only path allowance does not relax shipped payload limits', () => {
  const stage = code.slice(code.indexOf('function Stage-Runtime {'), code.indexOf('function Stage-RuntimeInto'))
  assert.match(stage, /Assert-DshStagedTree -Path \$stageRoot -MaxPathLength 32767/)
  for (const root of ['$stagedPayload', '$PayloadDsh']) {
    const calls = stage.split('\n').filter(line => line.includes(`Assert-DshStagedTree -Path ${root}`))
    assert.ok(calls.length > 0, `${root} is independently validated`)
    for (const call of calls) assert.ok(!call.includes('-MaxPathLength'), 'shipped roots keep the default 260-character limit')
  }
})

test('interface fixture verification uses the locked offline workspace', () => {
  const fixtures = code.slice(code.indexOf('function Test-InterfaceFixtures'), code.indexOf('function Test-Packaging'))
  assert.match(fixtures, /Invoke-Checked 'cargo' @\('test', '--workspace', '--locked', '--offline', '--test', 'protocol_fixtures'\)/)
})

test('a bundling build refuses to run concurrently with another cargo process', () => {
  // Cargo writes the binary at the end of the link step, so a concurrent release
  // build deletes it and the bundler fails with `os error 2` (finding F-25).
  assert.match(code, /A bundling build needs the target directory to itself/)
  assert.match(code, /ProcessName -in @\('cargo', 'cargo-tauri', 'rustc'\)/)
})

test('the runtime payload carries a pinned, checksum-verified Node interpreter', () => {
  assert.match(code, /Install-DshPinnedNode -ManifestPath \$pinPath/)
  assert.match(code, /node-runtime\.json/, 'the pin is a source-controlled file')
  // The stage must not silently accept whatever `node` resolves to.
  assert.doesNotMatch(code, /DSH_DESKTOP_NODE\s*=\s*\(Get-Command node\)/, 'the system node is never exported as the runtime interpreter')
  assert.match(code, /AllowDownload:\$AllowNodeDownload/, 'downloading is opt-in')
})

test('materialization executes the staging program with a trusted interpreter, never the staged Low image', () => {
  const staging = code.slice(code.indexOf('function Stage-RuntimeInto'), code.indexOf('function Copy-PortPackages'))
  const pin = staging.indexOf('$stagingNode = Install-DshPinnedNode')
  // Execution now goes through a trusted outside copy (or an explicit attested
  // override). The staged interpreter inside the workspace is a LOW image: a Low Node
  // cannot open a named pipe or write to the Medium temp the staging program needs,
  // which is exactly how `-Stage runtime` failed. The shipped bytes are unaffected.
  const resolveExecution = staging.indexOf('Resolve-DshStagingExecutionNode -StagedExecutable $stagingNode.Executable')
  const materialize = staging.indexOf('Invoke-Checked $executionNode.Path $nodeArgs $Upstream')
  const publishNode = staging.indexOf('Install-PinnedNodeInto -StageRoot $StageRoot -PayloadRoot $materialized -Identity $stagingNode')
  assert.ok(pin >= 0, 'the pinned interpreter is still installed first')
  assert.ok(resolveExecution > pin, 'the execution interpreter is resolved from the pinned one')
  assert.ok(materialize > resolveExecution, 'the staging program runs only after the execution interpreter is resolved')
  assert.ok(publishNode > materialize, 'the SHIPPED pinned bytes are still installed into the payload afterwards')

  // The staged Low image is never executed, and a bare `node` from PATH is never used.
  assert.doesNotMatch(staging, /Invoke-Checked \$stagingNode\.Executable/)
  assert.doesNotMatch(staging, /Invoke-Checked 'node' \$nodeArgs/)

  // The execution safeguards live in the SHARED module, because the explicit
  // -AttestedNodePath path once satisfied only a label read while the default copy
  // path did the real work. build.ps1 must delegate BOTH wrappers to the one checked
  // resolver, and the pin must come from the source manifest.
  const trustModule = readFileSync(join(portRoot, 'tests', 'packaging', 'rust-qualification.psm1'), 'utf8')
  assert.match(code, /function Get-DshTrustedNodeExecutionCopy/)
  assert.match(code, /Resolve-DshTrustedExecutionNode -StagedExecutable \$Executable/, 'the copy wrapper delegates')
  assert.match(code, /function Resolve-DshStagingExecutionNode/)
  assert.match(code, /Resolve-DshTrustedExecutionNode -StagedExecutable \$StagedExecutable/, 'the override wrapper delegates')
  assert.match(code, /-PinManifestPath \(Join-Path \$InstallerDir 'node-runtime\.json'\)/, 'the source pin is passed in')
  assert.match(code, /\$AttestedNodePath/)
  // The checks themselves: byte equality against the archive-pinned staged
  // interpreter, the pinned version on a real child, and the real preflight - on
  // BOTH paths, with nothing delegated to a comment.
  for (const required of [
    'candidate.Sha256 -ne $staged.Sha256',
    'observedVersion -ne "v$expectedVersion"',
    'Test-DshChildPreflight -NodePath $candidatePath',
    'Copy-DshTrustedPlainCopy -SourceRoot (Split-Path -Parent $staged.Path)',
    'Temp = $temp',
  ]) {
    assert.ok(trustModule.includes(required), `the shared resolver contains: ${required}`)
  }
  // The old bypass string is gone.
  assert.doesNotMatch(code, /TRUSTED_NODE_EXECUTION=attested path=/)

  // The scoped PATH points at the EXECUTION interpreter, and every override is
  // restored in the finally; TEMP/TMP are restored exactly (absent stays absent).
  assert.match(staging, /\$env:PATH = \(Split-Path -Parent \$executionNode\.Path\) \+ \[IO\.Path\]::PathSeparator \+ \$oldPath/)
  assert.match(staging, /finally\s*\{[\s\S]*?\$env:npm_execpath = \$oldNpmExecPath[\s\S]*?\$env:PATH = \$oldPath/)
  assert.match(staging, /\$hadTemp = Test-Path -LiteralPath 'Env:TEMP'/)
  assert.match(staging, /if \(\$hadTemp\) \{ \$env:TEMP = \$oldTemp \} else \{ Remove-Item -LiteralPath 'Env:TEMP'/)
  assert.match(staging, /if \(\$hadTmp\) \{ \$env:TMP = \$oldTmp \} else \{ Remove-Item -LiteralPath 'Env:TMP'/)
})

test('the payload manifest gates dependency drift and records the pinned inputs', () => {
  assert.match(code, /Assert-PayloadManifestMatches/)
  assert.match(code, /This is dependency drift/)
  assert.match(code, /-UpdatePayloadManifest/, 'accepting a new record is explicit')
  // The inputs a human chose are recorded, so a difference names the input.
  assert.match(code, /runtimeAdapter/)
  assert.match(code, /upstreamPackageManager/)
  assert.match(code, /portPackage:/)
})

test('the runtime stage refuses a payload that cannot resolve a profile bundle', () => {
  assert.match(code, /Assert-ProfileBundlesResolve/)
  assert.match(code, /DESKTOP_PROFILE_BUNDLES/)
  assert.match(code, /A fresh profile would compose without them/)
})

test('the runtime stage declares the top-level shape, so debris cannot ship', () => {
  // The payload directory maps wholesale into the installer, so a stray staged
  // entry ships (finding F-26). The allowed set is explicit.
  assert.match(code, /Get-DshPayloadTopLevel/)
  assert.match(code, /Get-DshPayloadAnchors/)
})

test('every tool call is judged by exit code, not by stderr', () => {
  // `ErrorActionPreference = 'Stop'` turns a native command's stderr into a
  // terminating error, which aborted successful builds (finding F-38). The
  // runner scopes the preference down around the call and restores it in a
  // `finally`, so a tool that writes warnings to stderr is judged only by its
  // exit code.
  assert.match(code, /function Invoke-Checked/)
  assert.match(code, /\$exitCode = \$LASTEXITCODE/)
  assert.match(code, /if \(\$exitCode -ne 0\) \{ throw/)
  assert.match(code, /\$ErrorActionPreference = 'Continue'/, 'the preference is scoped down for the call')
  assert.match(code, /\$ErrorActionPreference = \$previousPreference/, 'the preference is restored')

  // The `Continue` scope must enclose the call and its exit-code read, so the
  // preference cannot leak into the throw that follows.
  const runner = code.slice(code.indexOf('function Invoke-Checked'))
  const runnerBody = runner.slice(0, runner.indexOf('\n}\n') + 3)
  const continueIndex = runnerBody.indexOf("$ErrorActionPreference = 'Continue'")
  const exitCodeIndex = runnerBody.indexOf('$exitCode = $LASTEXITCODE')
  const throwIndex = runnerBody.indexOf('if ($exitCode -ne 0) { throw')
  assert.ok(continueIndex !== -1 && exitCodeIndex !== -1 && throwIndex !== -1,
    'the runner scopes the preference, reads the exit code and throws on failure')
  assert.ok(continueIndex < exitCodeIndex, 'the preference is scoped before the call')
  assert.ok(exitCodeIndex < throwIndex, 'the exit code is read before the failure is raised')
})

test('the declared stage set and the dispatch tail agree', () => {
  const stageMatch = script.match(/\[ValidateSet\(([^)]*)\)\]/)
  assert.ok(stageMatch, 'the Stage parameter declares a ValidateSet')
  const declared = [...stageMatch[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  for (const stage of ['ui', 'core', 'runtime', 'bundle', 'verify', 'packaging-tests', 'all']) {
    assert.ok(declared.includes(stage), `Stage accepts '${stage}'`)
  }
  assert.match(code, /Test-Packaging/, 'the packaging test stage is implemented')
})

test('packaging verification includes installed qualification safety guards as a required suite', () => {
  const packaging = code.slice(code.indexOf('function Test-Packaging'), code.indexOf('\nTest-Prerequisites', code.indexOf('function Test-Packaging')))
  assert.match(packaging, /Name = 'installed qualification safety guards'; Path = \(Join-Path \$PackagingTests 'verify-installed-guards\.ps1'\)/)
  assert.match(packaging, /Packaging test suite is missing:/)
})

test('signing and update delivery are not implied by a successful build', () => {
  assert.match(script, /Signing and update delivery are NOT part of this build/)
})

test('copied port packages are declared before sealing and compile guards require sealed metadata', () => {
  const copy = code.slice(code.indexOf('function Copy-PortPackages'), code.indexOf('function Assert-ProfileBundlesResolve'))
  assert.match(copy, /Register-DshPayloadPackages -Root \$PayloadRoot/)
  assert.match(copy, /-Names @\(\$portPackages \| ForEach-Object/)
  const guard = code.slice(code.indexOf('function Assert-ResourceRootsForCompile'), code.indexOf('function Stage-Runtime'))
  for (const name of ['desktop-policy-bootstrap.json', 'runtime-payload.json', 'desktop-runtime.json', 'NODE-LICENSE.txt']) {
    assert.ok(guard.includes(name), `compile resource guards require ${name}`)
  }
})

test('neither materialization nor the seal/verify path executes the Low shipped interpreter', () => {
  // The sealing function was the LAST place that ran `$bundledNode` directly - the
  // shipped interpreter inside the workspace, whose image is Low-labelled. It must go
  // through the same trusted resolver as materialization, for BOTH seal and
  // verify-only, with PATH/TEMP/TMP scoped and restored exactly.
  const seal = code.slice(code.indexOf('function Resolve-DshTrustedExecutionNodeCached'), code.indexOf('function Get-StagedHostProtocolVersion'))
  assert.ok(seal.length > 0, 'the seal section is present')
  assert.match(seal, /Resolve-DshTrustedExecutionNodeCached -StagedExecutable \$bundledNode/, 'the sealer resolves a trusted interpreter from the bundled bytes')
  assert.match(seal, /-AttestedPath \$AttestedNodePath/, 'an explicit attested override is honoured here too')
  assert.match(seal, /Invoke-Checked \$executionNode\.Path \$arguments \$Upstream/, 'the sealer executes the trusted Path')
  assert.doesNotMatch(seal, /Invoke-Checked \$bundledNode/, 'the shipped interpreter is never executed directly')
  assert.doesNotMatch(seal, /Invoke-Checked \$stageNode/, 'no other in-workspace interpreter is executed either')
  // Exact per-invocation env scoping and restoration, on the same pattern as staging.
  assert.match(seal, /\$env:PATH = \(Split-Path -Parent \$executionNode\.Path\) \+ \[IO\.Path\]::PathSeparator \+ \$oldPath/)
  assert.match(seal, /\$hadTemp = Test-Path -LiteralPath 'Env:TEMP'/)
  assert.match(seal, /if \(\$hadTemp\) \{ \$env:TEMP = \$oldTemp \} else \{ Remove-Item -LiteralPath 'Env:TEMP'/)
  assert.match(seal, /if \(\$hadTmp\) \{ \$env:TMP = \$oldTmp \} else \{ Remove-Item -LiteralPath 'Env:TMP'/)
  // The identity/hash inputs and the sealed tree are unchanged by this repair.
  assert.match(seal, /\$identity\.Sha256 -ne \$pinTarget\.sha256/, 'the identity is still checked against the archive pin')
  assert.match(seal, /\$identity\.Executable -cne "dsh\/\$relativeExecutable"/, 'the executable location is still checked')
  assert.match(seal, /\(Join-Path \$StageRoot 'node-identity\.json'\)/, 'the identity record is still passed to the sealer')
  // Cached reuse must re-verify the copy before it is executed.
  assert.match(seal, /Get-FileHash -LiteralPath \$cached\.Path -Algorithm SHA256/, 'a cached execution copy is re-hashed before reuse')

  // The materialization path is the same rule, and the regression there stays.
  const staging = code.slice(code.indexOf('function Stage-RuntimeInto'), code.indexOf('function Copy-PortPackages'))
  assert.doesNotMatch(staging, /Invoke-Checked \$stagingNode\.Executable/)
  assert.match(staging, /Invoke-Checked \$executionNode\.Path \$nodeArgs \$Upstream/)
})

test('metadata sealing precedes the final file count and post-swap verification never reseals', () => {
  const manifest = code.indexOf('Write-DshPayloadManifest -Manifest $manifest')
  const seal = code.indexOf('Invoke-StagedRuntimeSeal -StageRoot $stageRoot -DshRoot $stagedPayload')
  const fact = code.indexOf('$fact = Assert-DshStagedTree -Path $stagedPayload')
  const publish = code.indexOf('Publish-DshStagedPayload -StageRoot $stageRoot')
  const verify = code.indexOf('Invoke-StagedRuntimeSeal -StageRoot $stageRoot -DshRoot $PayloadDsh -VerifyOnly')
  const commit = code.indexOf('Complete-DshPublishedTree -PublishedPath $PayloadDsh')
  assert.ok([manifest, seal, fact, publish, verify, commit].every(index => index >= 0))
  assert.ok(manifest < seal && seal < fact && fact < publish && publish < verify && verify < commit)
  assert.match(code, /\$anchors \+= @\('runtime-payload.json', 'desktop-runtime.json'\)/)
})

test('sealing launches the pinned payload interpreter through tsx/esm via the trusted resolver', () => {
  const helper = code.slice(code.indexOf('function Invoke-StagedRuntimeSeal'), code.indexOf('function Get-StagedHostProtocolVersion'))
  assert.match(helper, /\$identity.NodeVersion -ne \$pin.nodeVersion/)
  assert.match(helper, /\$identity.Sha256 -ne \$pinTarget.sha256/)
  assert.match(helper, /\$identity.Target -ne \$targetName/)
  assert.match(helper, /\$bundledNode = Join-Path \$DshRoot \$relativeExecutable/)
  assert.match(helper, /@\('--import', 'tsx\/esm'/)
  // The pinned payload bytes are the REFERENCE for the resolver, never the process
  // that is executed: the shipped image is Low-labelled, so it cannot write the temp
  // and pipes the sealing program needs.
  assert.match(helper, /Resolve-DshTrustedExecutionNodeCached -StagedExecutable \$bundledNode -AttestedPath \$AttestedNodePath/)
  assert.match(helper, /Invoke-Checked \$executionNode\.Path \$arguments \$Upstream/)
  assert.doesNotMatch(helper, /Invoke-Checked \$bundledNode/)
  assert.match(code, /Name = 'final runtime descriptor'.*runtime-seal.test.mjs/)
  assert.match(code, /Name = 'staging execution-node trust'.*execution-node-trust.test.mjs/)
  assert.match(code, /packagingHelper:/)
})

test('runtime qualification isolates payload, manifest and interpreter observations', () => {
  assert.match(code, /\[ValidatePattern\('\^\[A-Za-z0-9\]\[A-Za-z0-9_\-\]\{0,63\}\$'\)\]/)
  assert.match(code, /\$qualificationRoot = Join-Path \$Scratch "rq-\$RuntimeQualificationName"/)
  assert.match(code, /\$PayloadRoot = Join-Path \$qualificationRoot 'rt'/)
  assert.match(code, /\$projectName = if \(\$qualificationRoot\) \{ 'p' \} else \{ 'runtime-project' \}/)
  const record = code.slice(code.indexOf('function Get-PayloadManifestRecordPath'), code.indexOf('function Assert-PayloadManifestMatches'))
  assert.match(record, /if \(\$qualificationRoot\)/)
  assert.match(record, /return \(Join-Path \$qualificationRoot 'runtime-payload.json'\)/)
  assert.match(record, /return \(Join-Path \$InstallerDir 'runtime-payload.json'\)/)
  assert.match(code, /Join-Path \$qualificationRoot 'stage-identity.json'/)
  assert.match(code, /Join-Path \$qualificationRoot 'node-identity.json'/)
})

const windowsOnly = { skip: process.platform !== 'win32' }
const invokeQualification = (stage, name) => {
  const scratch = join(portRoot, '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'build-script-rejection-'))
  const output = join(root, 'output.txt')
  const fd = openSync(output, 'w')
  try {
    const powershell = process.env.DSH_PACKAGING_POWERSHELL ?? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
      '-Stage', stage, '-RuntimeQualificationName', name], { cwd: portRoot, stdio: ['ignore', fd, fd] })
    return { ...result, output: readFileSync(output, 'utf8') }
  } finally {
    closeSync(fd)
    rmSync(root, { recursive: true, force: true })
  }
}

test('qualification rejects path-like names and non-runtime stages before writing', windowsOnly, () => {
  const name = `stage-guard-${process.pid}`
  const root = join(portRoot, '.scratch', `rq-${name}`)
  assert.equal(existsSync(root), false)
  for (const [stage, value] of [['runtime', '../escape'], ['runtime', 'C:\\escape'], ['ui', name], ['all', name]]) {
    const result = invokeQualification(stage, value)
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.output, value === name
      ? /RuntimeQualificationName is allowed only with -Stage runtime/
      : /RuntimeQualificationName/)
    assert.equal(existsSync(root), false, 'reject before creating output or building the UI')
  }
})

test('qualification refuses an existing owned output without changing it', windowsOnly, () => {
  const scratch = join(portRoot, '.scratch')
  mkdirSync(scratch, { recursive: true })
  const root = mkdtempSync(join(scratch, 'rq-existing-'))
  const name = root.slice(join(scratch, 'rq-').length)
  try {
    writeFileSync(join(root, 'preserve.txt'), 'prior owned fixture')
    const result = invokeQualification('runtime', name)
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.output, /Refusing to overwrite an existing qualification root/)
    assert.deepEqual(readdirSync(root), ['preserve.txt'])
    assert.equal(readFileSync(join(root, 'preserve.txt'), 'utf8'), 'prior owned fixture')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
