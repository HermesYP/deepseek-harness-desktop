<#
.SYNOPSIS
  Unit tests for the packaging helper modules under port/scripts/lib.

.DESCRIPTION
  Exercises `publish.psm1`, `payload-manifest.psm1` and `node-runtime.psm1`
  against real temporary trees. These modules implement the two properties the
  audit asked for and that are easiest to get quietly wrong:

    * atomic publication - the published path is never observably absent or
      half-written, and an interrupted swap restores the last known-good tree
      (findings F-41 and F-46 both came from in-place removal);
    * pinned inputs - a payload whose bytes differ from the recorded manifest is
      reported as drift, and an interpreter whose digest does not match the pin
      is refused rather than packaged.

  Everything runs under a scratch tree; nothing is published outside it.

.NOTES
  Windows PowerShell 5.1 and PowerShell 7 compatible. Pure ASCII.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$LibDir = Join-Path $PortRoot 'scripts\lib'
Import-Module (Join-Path $PSScriptRoot 'fixture-safety.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
# Any terminating failure still reports a structured FAIL, so the gate never has
# to infer an outcome from a stack trace or an exit code.
trap { exit (Write-DshSuiteResult -Id 'packaging-helpers' -Status 'FAIL' -Detail $_.Exception.Message) }
$Scratch = New-PackagingFixtureRoot -PortRoot $PortRoot -Prefix 'packaging-module-tests'

$script:Passed = 0
$script:Failed = 0

function Assert-True([bool]$Condition, [string]$Message) {
    if ($Condition) {
        $script:Passed++
        Write-Host "    ok  $Message" -ForegroundColor Green
    } else {
        $script:Failed++
        Write-Host "    FAIL $Message" -ForegroundColor Red
    }
}

function Assert-Throws([scriptblock]$Block, [string]$MessagePattern, [string]$Message) {
    $threw = $false
    try { & $Block } catch {
        $threw = $true
        if ($MessagePattern -and $_.Exception.Message -notmatch $MessagePattern) {
            $script:Failed++
            Write-Host "    FAIL $Message (message was: $($_.Exception.Message))" -ForegroundColor Red
            return
        }
    }
    if ($threw) {
        $script:Passed++
        Write-Host "    ok  $Message" -ForegroundColor Green
    } else {
        $script:Failed++
        Write-Host "    FAIL $Message (nothing was thrown)" -ForegroundColor Red
    }
}

# Every invocation owns a protected new tree; preserve fixtures and transcripts.

Import-Module (Join-Path $LibDir 'publish.psm1') -Force
Import-Module (Join-Path $LibDir 'payload-manifest.psm1') -Force
Import-Module (Join-Path $LibDir 'node-runtime.psm1') -Force

# ---------------------------------------------------------------- publish ----
Write-Host '==> publish.psm1' -ForegroundColor Cyan

$published = Join-Path $Scratch 'payload\dsh'
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $published)

# First publication: nothing there yet.
$stage1 = New-DshStageRoot -PublishedPath $published -Name 'dsh.stage-a'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $stage1 'node_modules')
Set-Content -Path (Join-Path $stage1 'package.json') -Value '{"name":"first"}' -Encoding Ascii
Set-Content -Path (Join-Path $stage1 'adapter.mjs') -Value '// adapter' -Encoding Ascii

$fact = Assert-DshStagedTree -Path $stage1 -Required @('package.json', 'adapter.mjs') `
    -ExpectedTopLevel @('adapter.mjs', 'node_modules', 'package.json')
Assert-True ($fact.FileCount -eq 2) "staged tree inventory counts 2 files (got $($fact.FileCount))"
Assert-True ($fact.ReparsePointCount -eq 0) 'staged tree has no reparse points'

$result = Publish-DshStagedTree -StagedPath $stage1 -PublishedPath $published
Assert-True ($result.HadPrevious -eq $false) 'first publication reports no previous tree'
Assert-True (Test-Path (Join-Path $published 'package.json')) 'the published path holds the new tree'
Assert-True (-not (Test-Path $stage1)) 'the staging path is gone after publication'
Complete-DshPublishedTree -PublishedPath $published
Assert-True (-not (Test-Path "$published.previous")) 'commit removes the retained previous tree'

# Second publication: the previous tree must be retained until commit.
$stage2 = New-DshStageRoot -PublishedPath $published -Name 'dsh.stage-b'
Set-Content -Path (Join-Path $stage2 'package.json') -Value '{"name":"second"}' -Encoding Ascii
Set-Content -Path (Join-Path $stage2 'adapter.mjs') -Value '// adapter' -Encoding Ascii

$result = Publish-DshStagedTree -StagedPath $stage2 -PublishedPath $published
Assert-True ($result.HadPrevious -eq $true) 'second publication reports a previous tree'
Assert-True (Test-Path "$published.previous") 'the previous tree is retained until commit'
$publishedBody = Get-Content (Join-Path $published 'package.json') -Raw
Assert-True ($publishedBody -match 'second') 'the published path holds the new tree before commit'
$previousBody = Get-Content (Join-Path "$published.previous" 'package.json') -Raw
Assert-True ($previousBody -match 'first') 'the retained previous tree still holds the old bytes'

# Rollback before commit restores the previous tree.
Restore-DshPublishedTree -PublishedPath $published
$restored = Get-Content (Join-Path $published 'package.json') -Raw
Assert-True ($restored -match 'first') 'rollback restores the previous tree'
Assert-True (-not (Test-Path "$published.previous")) 'rollback consumes the retained tree'

# Interrupted publication with the published tree ABSENT is repaired by restoring.
#
# The sequence matters and is easy to misread. Publishing "third" moves whatever
# is *currently* published to `.previous`; after the rollback above, that is
# "first". So when the crash simulation deletes the published tree, the last
# known-good copy on disk is "first", and that is what must come back. Asserting
# "third" here would be asserting that a tree which never reached `.previous`
# survives -- the opposite of the guarantee.
$stage3 = New-DshStageRoot -PublishedPath $published -Name 'dsh.stage-c'
Set-Content -Path (Join-Path $stage3 'package.json') -Value '{"name":"third"}' -Encoding Ascii
Set-Content -Path (Join-Path $stage3 'adapter.mjs') -Value '// adapter' -Encoding Ascii
$null = Publish-DshStagedTree -StagedPath $stage3 -PublishedPath $published
$publishedBefore = Get-Content (Join-Path $published 'package.json') -Raw
Assert-True ($publishedBefore -match 'third') 'the published tree is the newly staged one'
$previousBefore = Get-Content (Join-Path "$published.previous" 'package.json') -Raw
Assert-True ($previousBefore -match 'first') 'the retained tree is the one that was published before'

# Simulate a crash between the two renames: the published tree is gone and only
# `.previous` survives.
$null = Assert-PackagingFixturePath -Root $Scratch -Path $published
Remove-Item -LiteralPath $published -Recurse -Force

$repair = Repair-DshInterruptedPublication -PublishedPath $published -Required @('package.json')
Assert-True ($repair.Action -eq 'restored') "an interrupted publication is restored (action=$($repair.Action))"
$repaired = Get-Content (Join-Path $published 'package.json') -Raw
Assert-True ($repaired -match 'first') 'the restored tree is the retained last known-good one'
Assert-True (Test-Path (Join-Path $published 'adapter.mjs')) 'the restored tree is complete, not partially copied'

# A published tree that validates is committed instead of restored.
$stage4 = New-DshStageRoot -PublishedPath $published -Name 'dsh.stage-d'
Set-Content -Path (Join-Path $stage4 'package.json') -Value '{"name":"fourth"}' -Encoding Ascii
Set-Content -Path (Join-Path $stage4 'adapter.mjs') -Value '// adapter' -Encoding Ascii
$null = Publish-DshStagedTree -StagedPath $stage4 -PublishedPath $published
$repair = Repair-DshInterruptedPublication -PublishedPath $published -Required @('package.json')
Assert-True ($repair.Action -eq 'committed') "a complete published tree is committed (action=$($repair.Action))"
$kept = Get-Content (Join-Path $published 'package.json') -Raw
Assert-True ($kept -match 'fourth') 'the complete published tree is kept'

# Rejected trees.
$badStage = New-DshStageRoot -PublishedPath $published -Name 'dsh.stage-bad'
Set-Content -Path (Join-Path $badStage 'package.json') -Value '{}' -Encoding Ascii
# A stray top-level entry is exactly how debug debris shipped (finding F-26).
Set-Content -Path (Join-Path $badStage 'probe-debris.txt') -Value 'x' -Encoding Ascii
Assert-Throws { Assert-DshStagedTree -Path $badStage -ExpectedTopLevel @('adapter.mjs', 'node_modules', 'package.json') } `
    'unexpectedTopLevel' 'a stray top-level entry is rejected'

Assert-Throws { Assert-DshStagedTree -Path $badStage -Required @('adapter.mjs') } `
    'missingOrLinked' 'a missing required file is rejected'

# A reparse point is not a materialized directory (findings F-15/F-20).
$linkStage = New-DshStageRoot -PublishedPath $published -Name 'dsh.stage-link'
$realDir = Join-Path $Scratch 'real-dir'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $realDir 'pkg')
Set-Content -Path (Join-Path $realDir 'pkg\package.json') -Value '{}' -Encoding Ascii
$null = New-Item -ItemType Directory -Force -Path (Join-Path $linkStage 'node_modules')
$linked = $false
try {
    $null = New-Item -ItemType Junction -Path (Join-Path $linkStage 'node_modules\pkg') -Target (Join-Path $realDir 'pkg') -ErrorAction Stop
    $linked = $true
} catch {
    Write-Host "    skip: this host could not create a junction ($($_.Exception.Message))" -ForegroundColor DarkYellow
}
if ($linked) {
    Assert-True (Test-DshReparsePoint -Path (Join-Path $linkStage 'node_modules\pkg')) 'a junction is reported as a reparse point'
    Assert-Throws { Assert-DshStagedTree -Path $linkStage -RequiredDirectories @('node_modules/pkg') } `
        'reparse point' 'a junction is rejected where a real directory is required'
}

# ------------------------------------------------------- payload manifest ----
Write-Host '==> payload-manifest.psm1' -ForegroundColor Cyan

$manifestRoot = Join-Path $Scratch 'manifest-payload'
$null = New-Item -ItemType Directory -Force -Path (Join-Path $manifestRoot 'node_modules\dep')
Set-Content -Path (Join-Path $manifestRoot 'package.json') `
    -Value '{"name":"@deepseek-ai/dsh-desktop-runtime","version":"1.0.0","dependencies":{"dep":"1.0.0"}}' -Encoding Ascii
Set-Content -Path (Join-Path $manifestRoot 'node_modules\dep\package.json') -Value '{"name":"dep"}' -Encoding Ascii
Set-Content -Path (Join-Path $manifestRoot 'NODE-LICENSE.txt') -Value 'MIT License' -Encoding Ascii
Set-Content -Path (Join-Path $manifestRoot 'node_modules\dep\runtime-payload.json') -Value 'nested port metadata' -Encoding Ascii
Set-Content -Path (Join-Path $manifestRoot 'node_modules\dep\desktop-runtime.json') -Value 'nested upstream metadata' -Encoding Ascii

$nodeIdentity = [pscustomobject]@{
    NodeVersion = '22.20.0'; Target = 'win-x64'; Url = 'https://example.invalid/node.zip'
    Sha256 = ('a' * 64); Source = 'supplied'; License = 'NODE-LICENSE.txt'; LicenseSpdx = 'MIT'
}
$manifest = New-DshPayloadManifest -Root $manifestRoot -Inputs @{ upstreamCommit = 'abc123' } `
    -UpstreamCommit 'abc123' -Version '1.0.0' -NodeIdentity $nodeIdentity `
    -RequiredLicenses @('NODE-LICENSE.txt')
Assert-True ($manifest.fileCount -eq 5) "the manifest inventories payload files including nested metadata (count=$($manifest.fileCount))"
Assert-True (@($manifest.files | Where-Object { $_.path -eq 'node_modules/dep/runtime-payload.json' }).Count -eq 1) 'nested port metadata is not excluded'
Assert-True (@($manifest.files | Where-Object { $_.path -eq 'node_modules/dep/desktop-runtime.json' }).Count -eq 1) 'nested upstream metadata is not excluded'
Assert-True ($manifest.packages.Count -eq 1) 'the manifest records the dependency closure'
Assert-True ($manifest.node.sha256 -eq ('a' * 64)) 'the manifest records the pinned interpreter digest'

$manifestPath = Join-Path $Scratch 'payload-manifest.json'
Write-DshPayloadManifest -Manifest $manifest -Path $manifestPath
Assert-True (Test-Path $manifestPath) 'the manifest is written'
$reread = Read-DshPayloadManifest -Path $manifestPath
$same = Compare-DshPayloadManifest -Expected $reread -Actual $manifest
Assert-True ($same.Matches) 'a manifest compares equal to itself'

# The upstream descriptor hashes this completed manifest, not the reverse.
Set-Content -Path (Join-Path $manifestRoot 'runtime-payload.json') -Value '{"metadata":"port"}' -Encoding Ascii
Set-Content -Path (Join-Path $manifestRoot 'desktop-runtime.json') -Value '{"metadata":"upstream"}' -Encoding Ascii
$sealed = New-DshPayloadManifest -Root $manifestRoot -Inputs @{ upstreamCommit = 'abc123' } `
    -UpstreamCommit 'abc123' -Version '1.0.0' -NodeIdentity $nodeIdentity `
    -RequiredLicenses @('NODE-LICENSE.txt') -Exclude @()
Assert-True ((Compare-DshPayloadManifest -Expected $reread -Actual $sealed).Matches) 'both root metadata files are intrinsically excluded, avoiding a hash cycle'
Set-Content -Path (Join-Path $manifestRoot 'desktop-runtime.json') -Value '{"metadata":"changed"}' -Encoding Ascii
$resealed = New-DshPayloadManifest -Root $manifestRoot -Inputs @{ upstreamCommit = 'abc123' } `
    -UpstreamCommit 'abc123' -Version '1.0.0' -NodeIdentity $nodeIdentity -RequiredLicenses @('NODE-LICENSE.txt')
Assert-True ((Compare-DshPayloadManifest -Expected $reread -Actual $resealed).Matches) 'root descriptor bytes do not recursively alter the port inventory'

# Drift: a changed file byte must be reported, not ignored.
Set-Content -Path (Join-Path $manifestRoot 'node_modules\dep\package.json') `
    -Value '{"name":"dep","extra":true}' -Encoding Ascii
$drifted = New-DshPayloadManifest -Root $manifestRoot -Inputs @{ upstreamCommit = 'abc123' } `
    -UpstreamCommit 'abc123' -Version '1.0.0' -NodeIdentity $nodeIdentity `
    -RequiredLicenses @('NODE-LICENSE.txt')
$comparison = Compare-DshPayloadManifest -Expected $reread -Actual $drifted
Assert-True (-not $comparison.Matches) 'a changed file byte is reported as drift'
Assert-True ($comparison.ChangedFiles.Count -eq 1) "the changed file is named (count=$($comparison.ChangedFiles.Count))"

# Drift: a removed license is a redistribution defect.
Set-Content -Path (Join-Path $manifestRoot 'node_modules\dep\package.json') -Value '{"name":"dep"}' -Encoding Ascii
$licenseTarget = Assert-PackagingFixturePath -Root $Scratch -Path (Join-Path $manifestRoot 'NODE-LICENSE.txt')
Remove-Item -LiteralPath $licenseTarget -Force
Assert-Throws { New-DshPayloadManifest -Root $manifestRoot -Inputs @{} -UpstreamCommit 'abc123' `
        -Version '1.0.0' -NodeIdentity $nodeIdentity -RequiredLicenses @('NODE-LICENSE.txt') } `
    'license' 'a missing required license text is rejected'

# A reparse point cannot be inventoried, because it cannot be proven to ship.
Set-Content -Path (Join-Path $manifestRoot 'NODE-LICENSE.txt') -Value 'MIT License' -Encoding Ascii
if ($linked) {
    $linkRoot = Join-Path $Scratch 'manifest-link'
    $null = New-Item -ItemType Directory -Force -Path $linkRoot
    Set-Content -Path (Join-Path $linkRoot 'package.json') -Value '{"dependencies":{}}' -Encoding Ascii
    $null = New-Item -ItemType Junction -Path (Join-Path $linkRoot 'linked') -Target (Join-Path $realDir 'pkg') -ErrorAction SilentlyContinue
    Assert-Throws { Get-DshPayloadFileInventory -Root $linkRoot } `
        'reparse point' 'the inventory refuses a reparse point'
}

# --------------------------------------------------------- pinned node -------
Write-Host '==> node-runtime.psm1' -ForegroundColor Cyan

$pinPath = Join-Path $PortRoot 'installer\node-runtime.json'
$pin = Get-DshPinnedNodeManifest -ManifestPath $pinPath
Assert-True ($pin.schemaVersion -eq 1) 'the pinned Node manifest declares schema version 1'
Assert-True ($pin.nodeVersion -match '^\d+\.\d+\.\d+$') "the pinned version is explicit ($($pin.nodeVersion))"

$winTarget = Get-DshPinnedNodeTarget -Manifest $pin -Target 'win-x64'
Assert-True ($winTarget.sha256 -match '^[0-9a-f]{64}$') 'the win-x64 archive digest is a lowercase sha256'
Assert-True ($winTarget.url -match '^https://') 'the win-x64 archive URL is HTTPS'
Assert-True ($winTarget.executable -eq 'node.exe') 'the win-x64 executable name is node.exe'
Assert-True ($winTarget.archiveRoot -match '^node-v') 'the win-x64 archive root is the upstream directory name'

Assert-Throws { Get-DshPinnedNodeTarget -Manifest $pin -Target 'plan9-mips' } `
    'no entry for target' 'an unknown target is rejected with the known ones listed'

# A tampered archive must be refused, not packaged. The digest check is the
# property that matters, so it is exercised against a synthetic file rather than
# by downloading the real archive.
$fakeArchive = Join-Path $Scratch 'node-fake.zip'
Set-Content -Path $fakeArchive -Value 'not the real node archive' -Encoding Ascii
$tamperPin = [pscustomobject]@{
    schemaVersion = 1; nodeVersion = '99.0.0'
    license = [pscustomobject]@{ spdx = 'MIT'; file = 'LICENSE'; destination = 'NODE-LICENSE.txt' }
    targets = [pscustomobject]@{
        'win-x64' = [pscustomobject]@{
            url = 'https://example.invalid/node.zip'; sha256 = ('0' * 64)
            archiveRoot = 'node-v99.0.0-win-x64'; executable = 'node.exe'
        }
    }
}
Assert-Throws {
    Get-DshPinnedNodeArchive -Manifest $tamperPin -Target $tamperPin.targets.'win-x64' `
        -TargetName 'win-x64' -CacheRoot (Join-Path $Scratch 'node-cache') -ArchivePath $fakeArchive
} 'sha256' 'an archive whose digest does not match the pin is refused'

# Download disabled must fail loudly rather than fall back to a system Node.
Assert-Throws {
    Get-DshPinnedNodeArchive -Manifest $tamperPin -Target $tamperPin.targets.'win-x64' `
        -TargetName 'win-x64' -CacheRoot (Join-Path $Scratch 'node-cache-empty')
} 'download is disabled' 'a missing archive with download disabled is refused with guidance'

# A correctly provisioned archive passes the digest gate. The archive content is
# synthetic because extraction is a separate, independently tested step; what is
# asserted here is that the digest gate admits a match.
$goodDir = Join-Path $Scratch 'node-good'
$null = New-Item -ItemType Directory -Force -Path $goodDir
$goodArchive = Join-Path $goodDir 'node.zip'
Set-Content -Path $goodArchive -Value 'synthetic archive body' -Encoding Ascii
$goodDigest = (Get-FileHash $goodArchive -Algorithm SHA256).Hash.ToLowerInvariant()
$goodPin = [pscustomobject]@{
    schemaVersion = 1; nodeVersion = '99.0.0'
    license = [pscustomobject]@{ spdx = 'MIT'; file = 'LICENSE'; destination = 'NODE-LICENSE.txt' }
    targets = [pscustomobject]@{
        'win-x64' = [pscustomobject]@{
            url = 'https://example.invalid/node.zip'; sha256 = $goodDigest
            archiveRoot = 'node-v99.0.0-win-x64'; executable = 'node.exe'
        }
    }
}
$acquired = Get-DshPinnedNodeArchive -Manifest $goodPin -Target $goodPin.targets.'win-x64' `
    -TargetName 'win-x64' -CacheRoot (Join-Path $Scratch 'node-cache-good') -ArchivePath $goodArchive
Assert-True ($acquired.Sha256 -eq $goodDigest) 'a matching digest is admitted'
Assert-True ($acquired.Source -eq 'supplied') 'the acquisition reports which source was used'

# A one-line version probe must still wait for native completion and report its
# real exit status. The delayed fixture deterministically exposes a pipeline
# stopped by Select-Object -First (which killed the real staged Node with -1).
if ($env:OS -eq 'Windows_NT') {
    Import-Module (Join-Path $PSScriptRoot 'qualification-preflight.psm1') -Force
    # An EXPLICIT interpreter, never `(Get-Command node).Source`: PATH order could
    # select the workspace interpreter, whose image inherits the workspace's Low
    # label, and the delayed probe's write-up then fails with EPERM -4048. The
    # attested pin is byte-identical to the packaged interpreter; the fallback is a
    # real copy into the owned root (a copy lands with the destination's label).
    $nativeNode = $null
    try {
        $nativeNode = (Get-DshPinnedQualificationNode -PortRoot $PortRoot).Path
    } catch {
        Write-Host "    note: pinned interpreter unattested ($($_.Exception.Message)); staging a copy of the resolved node instead." -ForegroundColor DarkYellow
        $resolved = (Get-Command node -ErrorAction Stop).Source
        $stagedNode = Join-Path $Scratch 'interpreter\node.exe'
        $null = New-Item -ItemType Directory -Path (Split-Path -Parent $stagedNode) -Force
        Copy-Item -LiteralPath $resolved -Destination $stagedNode -Force
        $nativeNode = $stagedNode
    }
    $probeScript = Join-Path $Scratch 'delayed-version.cjs'
    $probeCommand = Join-Path $Scratch 'delayed-version.cmd'
    $completion = Join-Path $Scratch 'version-probe-completed.txt'
    $completionJson = ConvertTo-Json -InputObject $completion -Compress
    Set-Content -LiteralPath $probeScript -Encoding Ascii -Value @"
process.stdout.write('v99.0.0\n');
setTimeout(() => {
    require('node:fs').writeFileSync($completionJson, 'completed');
    process.exitCode = Number(process.env.DSH_TEST_VERSION_PROBE_EXIT || 0);
}, 250);
"@
    Set-Content -LiteralPath $probeCommand -Encoding Ascii -Value "@echo off`r`n`"$nativeNode`" `"$probeScript`" %*`r`nexit /b %errorlevel%"
    $priorProbeExit = $env:DSH_TEST_VERSION_PROBE_EXIT
    try {
        $env:DSH_TEST_VERSION_PROBE_EXIT = '0'
        $observed = Assert-DshNodeVersion -Executable $probeCommand -ExpectedVersion '99.0.0'
        Assert-True ($observed -eq '99.0.0') 'version probe waits for the real successful native exit'
        Assert-True ((Get-Content -LiteralPath $completion -Raw).Trim() -eq 'completed') 'version probe allows native work after its first output line'
        $env:DSH_TEST_VERSION_PROBE_EXIT = '5'
        Assert-Throws { Assert-DshNodeVersion -Executable $probeCommand -ExpectedVersion '99.0.0' } `
            'exit code 5' 'version probe preserves a late nonzero native exit after a valid version line'
    } finally {
        $env:DSH_TEST_VERSION_PROBE_EXIT = $priorProbeExit
    }
} else {
    Write-Host 'SKIP: delayed native version/exit probe requires Windows; this suite is not fully qualified.' -ForegroundColor Yellow
    exit (Write-DshSuiteResult -Id 'packaging-helpers' -Status 'SKIP' -Checks $script:Passed -Detail 'delayed native version/exit probe unavailable on this non-Windows host')
}

# ------------------------------------------------------------- summary -------
Write-Host ''
if ($script:Failed -gt 0) {
    Write-Host "Packaging module tests: $($script:Passed) passed, $($script:Failed) FAILED" -ForegroundColor Red
    exit (Write-DshSuiteResult -Id 'packaging-helpers' -Status 'FAIL' -Detail "$($script:Failed) assertion(s) failed of $($script:Passed + $script:Failed)")
}
Write-Host "Packaging module tests: $($script:Passed) passed, 0 failed" -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'packaging-helpers' -Status 'PASS' -Checks $script:Passed -Detail 'publication, manifest and pinned-interpreter assertions')
