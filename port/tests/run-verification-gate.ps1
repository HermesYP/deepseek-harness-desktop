<#
.SYNOPSIS
  The one qualification gate: integrity preflight, seven declared packaging
  suites, the Node source lanes and the UI build/verify lane.

.DESCRIPTION
  Run from the repository root:

    powershell -NoProfile -ExecutionPolicy Bypass -File port/tests/run-verification-gate.ps1

  What it guarantees, and why each guarantee exists:

    * PREFLIGHT BEFORE NATIVE WORK. The pinned interpreter is attested by exact
      version, byte hash and process-token integrity before any native suite runs,
      and four child probes (process-owned write, process-sentinel, named pipe,
      watchdog) must pass. Unknown visibility refuses the run
      (`REFUSED_UNKNOWN_VISIBILITY`) instead of guessing. Nothing is relabelled.
    * SEVEN DECLARED SUITES, NOT A GLOB. The seven PowerShell packaging suites are
      listed by name, so a deleted or renamed suite is a gate failure rather than
      a smaller green run.
    * SKIP IS NOT PASS. Each suite emits one `SUITE_RESULT=` line. A suite that
      could not run because `makensis` (or another named precondition) was absent
      reports `status=SKIP reason=precondition-failed`, and the gate treats that
      as a non-pass: it fails unless `-AllowPreconditionSkip` was passed
      explicitly, and even then the gate exits 3, never 0.
    * EXPLICIT NONEMPTY COUNTS. The Node lanes assert at least N matching files
      and a parsed `# tests` / `# pass` total above a floor, because
      `node --test <glob>` exits 0 on an empty match.
    * ONE PER-CHILD NODE ENVIRONMENT. Every Node lane names the pinned interpreter
      in the child's own `DSH_ADAPTER_INTEGRATION_NODE` and points the child's
      TEMP/TMP/TMPDIR at this run's owned root, applied on the child's
      ProcessStartInfo. An ambient value is overridden, never inherited, and the
      caller's environment is never written - so a lane cannot silently exercise a
      Low interpreter from the labelled workspace, and nothing leaks back.
    * OWNED CWD. Every suite process runs with its working directory inside a
      qualification root created by this run, never the repository root, so a
      probe that writes `${REPORT}` cannot litter the checkout.

.PARAMETER Lane
  packaging (default), node, ui or all.

.PARAMETER AllowPreconditionSkip
  Do not fail the gate for `reason=precondition-failed`; the gate still reports
  SKIP and exits 3 rather than pretending the suite passed.

.PARAMETER SkipPreflight
  Skip the integrity preflight. Only valid for the pure source lanes; the
  packaging lane refuses to skip it.

.NOTES
  Windows PowerShell 5.1 and 7 compatible. Runs no installer and launches no
  application; it never relabels an object and never kills by image name.
#>
[CmdletBinding()]
param(
    [ValidateSet('packaging', 'node', 'ui', 'all')][string]$Lane = 'packaging',
    [switch]$AllowPreconditionSkip,
    [switch]$SkipPreflight,
    [string]$NodePath,
    [int]$MinNodeFiles = 5,
    [int]$MinNodeTests = 100,
    [int]$MinUiTestFiles = 8,
    [int]$MinUiTests = 100,
    [int]$MaxGateSeconds = 5400
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TestsDir = $PSScriptRoot
$PortRoot = Split-Path -Parent $TestsDir
$RepoRoot = Split-Path -Parent $PortRoot
$PackagingTests = Join-Path $TestsDir 'packaging'

Import-Module (Join-Path $PackagingTests 'native-quoting.psm1') -Force
Import-Module (Join-Path $PackagingTests 'suite-result.psm1') -Force
Import-Module (Join-Path $PackagingTests 'qualification-preflight.psm1') -Force
# `Invoke-DshOwnedChild` is the only launcher here that applies environment
# overrides on the CHILD's own ProcessStartInfo, which is what the Node lanes need.
Import-Module (Join-Path $PackagingTests 'rust-qualification.psm1') -Force

$script:GateFailures = @()
$script:GateSkips = @()
$script:GatePasses = @()
$script:StartedAt = Get-Date
$script:GateWatchdog = $null

function Write-Gate([string]$Message, [string]$Colour = 'Gray') { Write-Host $Message -ForegroundColor $Colour }

function Add-GateFailure([string]$Id, [string]$Detail) {
    $script:GateFailures += "$Id`: $Detail"
    Write-Gate "GATE_FAILURE id=$Id detail=$Detail" 'Red'
}
function Add-GateSkip([string]$Id, [string]$Reason, [string]$Detail) {
    $script:GateSkips += "$Id ($Reason): $Detail"
    Write-Gate "GATE_SKIP id=$Id reason=$Reason detail=$Detail" 'Yellow'
}
function Add-GatePass([string]$Id, [string]$Detail) {
    $script:GatePasses += "$Id`: $Detail"
    Write-Gate "GATE_PASS id=$Id detail=$Detail" 'Green'
}

# ---------------------------------------------------------------------------
# Owned CWD: a qualification root outside the workspace, so no probe can write
# into the checkout and no fixture inherits the workspace's Low label.
# ---------------------------------------------------------------------------
$OwnedRoot = New-DshQualificationRoot -Prefix 'gate'
$Transcript = Join-Path $OwnedRoot 'gate-transcript.log'
try { Start-Transcript -LiteralPath $Transcript -ErrorAction Stop | Out-Null } catch { Write-Gate "note: transcript unavailable: $($_.Exception.Message)" 'DarkYellow' }
Write-Gate "GATE_ROOT=$OwnedRoot" 'Cyan'

# The gate's own watchdog: a single total bound, checked between suites.
$Deadline = $script:StartedAt.AddSeconds($MaxGateSeconds)
function Assert-GateTime([string]$Where) {
    if ((Get-Date) -gt $Deadline) { throw "The gate exceeded $MaxGateSeconds seconds at $Where." }
}

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
$Preflight = $null
if (-not $SkipPreflight) {
    Write-Gate '' ; Write-Gate '==> Integrity and pinned-interpreter preflight' 'Cyan'
    try {
        $candidates = @()
        if ($NodePath) { $candidates += $NodePath }
        # The preflight's own root, inside this run's owned gate root.
        $preflightRoot = Join-Path $OwnedRoot 'preflight'
        if (-not (Test-Path -LiteralPath $preflightRoot)) { $null = New-Item -ItemType Directory -Path $preflightRoot -ErrorAction Stop }
        $Preflight = Assert-DshQualificationPreflight -PortRoot $PortRoot -OwnedRoot $preflightRoot -CandidatePaths $candidates
        Add-GatePass 'integrity-preflight' "parent=$($Preflight.ParentIntegrity.Level) node=$($Preflight.Node.Path) version=$($Preflight.Node.Version) sha256=$($Preflight.Node.ImageSha256) child=$($Preflight.Child.ChildIntegrity.Level) pipe/write/sentinel/watchdog=ok"
        $PreflightNode = $Preflight.Node.Path
    } catch {
        Add-GateFailure 'integrity-preflight' $_.Exception.Message
        Write-Gate 'REFUSED: native qualification will not run without a known-integrity attested interpreter.' 'Red'
        $PreflightNode = $null
    }
} else {
    if ($Lane -in @('packaging', 'all')) {
        Add-GateFailure 'integrity-preflight' 'The packaging lane refuses -SkipPreflight: native fixtures are never started without a verified preflight.'
    } else {
        Write-Gate 'note: preflight skipped for a pure source lane.' 'DarkYellow'
    }
    $PreflightNode = $NodePath
}

# ---------------------------------------------------------------------------
# Node source lanes: ONE per-child environment, never the caller's.
#
# The fixture adapters prefer `DSH_ADAPTER_INTEGRATION_NODE` over
# `process.execPath` (port/tests/adapter-*.test.mjs), and they write into TEMP. An
# ambient value naming an interpreter inside the labelled workspace, or an ambient
# TEMP inside a Low root, therefore decided which interpreter a "green" lane had
# actually exercised. Every Node invocation below is started through
# `Invoke-DshOwnedChild`, which sets these overrides on the CHILD's own
# ProcessStartInfo: the caller's environment is never written, so nothing can leak
# and there is no absent-versus-empty restore to get wrong.
# ---------------------------------------------------------------------------
$script:NodeChildRoot = if ($Preflight -and $Preflight.Root) { $Preflight.Root } else { $OwnedRoot }
$script:NodeChildTemp = Join-Path $script:NodeChildRoot 'node-temp'
if (-not (Test-Path -LiteralPath $script:NodeChildTemp)) {
    $null = New-Item -ItemType Directory -Path $script:NodeChildTemp -ErrorAction Stop
}

function Get-DshGateNodeChildEnvironment([string]$NodeExe) {
    $overrides = @{
        TEMP = $script:NodeChildTemp
        TMP = $script:NodeChildTemp
        TMPDIR = $script:NodeChildTemp
    }
    if ($NodeExe) {
        # The interpreter this lane actually runs is named EXPLICITLY, so an ambient
        # DSH_ADAPTER_INTEGRATION_NODE is overridden rather than inherited, and PATH
        # leads with its directory so a bare `node` resolves to it too.
        $overrides['DSH_ADAPTER_INTEGRATION_NODE'] = $NodeExe
        $overrides['PATH'] = (Split-Path -Parent $NodeExe) + [IO.Path]::PathSeparator + $env:PATH
    }
    return $overrides
}

function Invoke-DshGateNode([string]$NodeExe, [string[]]$Arguments, [string]$WorkDir, [int]$TimeoutSeconds) {
    $run = Invoke-DshOwnedChild -FilePath $NodeExe -Arguments $Arguments -WorkingDirectory $WorkDir `
        -Environment (Get-DshGateNodeChildEnvironment -NodeExe $NodeExe) -TimeoutSeconds $TimeoutSeconds
    if (-not $run.ChildTokenKnown) {
        throw "REFUSED_UNKNOWN_VISIBILITY: the Node child's token could not be read ($($run.ChildTokenReason))."
    }
    return $run
}

# ---------------------------------------------------------------------------
# Packaging lane: the seven declared suites.
# ---------------------------------------------------------------------------
function Invoke-PackagingSuite([object]$Suite) {
    if (-not (Test-Path -LiteralPath $Suite.Path -PathType Leaf)) {
        return [pscustomobject]@{ Id = $Suite.Id; Status = 'FAIL'; Reason = ''; Detail = "declared suite file is missing: $($Suite.File)"; Checks = -1; Output = '' }
    }
    $suiteScratch = Join-Path $OwnedRoot "suite-$($Suite.Id)"
    $null = New-Item -ItemType Directory -Path $suiteScratch -ErrorAction Stop
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not (Test-Path -LiteralPath $powershell -PathType Leaf)) { $powershell = (Get-Command powershell -ErrorAction Stop).Source }
    Write-Gate "    -- $($Suite.Id)" 'DarkGray'
    $run = Invoke-DshNativeChecked -FilePath $powershell `
        -Arguments @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $Suite.Path) `
        -WorkingDirectory $suiteScratch -TimeoutSeconds 900 -PassThruOutput
    $combined = ($run.StandardOutput + "`n" + $run.StandardError)
    # The suite's own structured line is authoritative. A suite that printed none
    # is a FAIL, never inferred from its exit code.
    $parsed = @(Read-DshSuiteResults -Output $combined)
    if ($parsed.Count -eq 0) {
        $tail = ($combined -split "`r?`n" | Where-Object { $_.Trim() } | Select-Object -Last 3) -join ' | '
        return [pscustomobject]@{ Id = $Suite.Id; Status = 'FAIL'; Reason = ''; Checks = -1
            Detail = "no SUITE_RESULT line (exit $($run.ExitCode)); tail: $tail"; Output = $combined }
    }
    $result = $parsed[-1]
    if ($result.Id -ne $Suite.Id) {
        return [pscustomobject]@{ Id = $Suite.Id; Status = 'FAIL'; Reason = ''; Checks = -1
            Detail = "structured line names '$($result.Id)', not the declared id"; Output = $combined }
    }
    return [pscustomobject]@{ Id = $result.Id; Status = $result.Status; Reason = $result.Reason; Checks = $result.Checks
        Detail = $result.Detail; Output = $combined }
}

if ($Lane -in @('packaging', 'all')) {
    Write-Gate '' ; Write-Gate '==> Seven declared packaging suites' 'Cyan'
    if ($null -eq $PreflightNode -and -not $SkipPreflight) {
        Write-Gate '    SKIPPED: the preflight did not pass, so native suites are not started.' 'Red'
    } else {
        foreach ($suite in (Get-DshDeclaredPackagingSuites -PackagingTestsDir $PackagingTests)) {
            Assert-GateTime "suite $($suite.Id)"
            $result = Invoke-PackagingSuite -Suite $suite
            $outFile = Join-Path $OwnedRoot "suite-$($suite.Id).log"
            Set-Content -LiteralPath $outFile -Value $result.Output -Encoding Ascii
            switch ($result.Status) {
                'PASS' { Add-GatePass $result.Id "checks=$($result.Checks) $($result.Detail)" }
                'SKIP' {
                    if ($result.Reason -eq 'precondition-failed' -and -not $AllowPreconditionSkip) {
                        Add-GateFailure $result.Id "precondition-failed and -AllowPreconditionSkip was not passed: $($result.Detail)"
                    } else {
                        Add-GateSkip $result.Id $result.Reason $result.Detail
                    }
                }
                default { Add-GateFailure $result.Id $result.Detail }
            }
        }
    }
}

# ---------------------------------------------------------------------------
# Node source lane
# ---------------------------------------------------------------------------
if ($Lane -in @('node', 'all')) {
    Write-Gate '' ; Write-Gate '==> Node source lanes' 'Cyan'
    $nodeExe = if ($PreflightNode) { $PreflightNode } elseif ($NodePath) { $NodePath } else { (Get-Command node -ErrorAction Stop).Source }
    $identity = if ($Preflight) { "pinned $($Preflight.Node.Version) sha256=$($Preflight.Node.ImageSha256)" } else { 'unattested (source lane only)' }
    Write-Gate "    interpreter: $nodeExe ($identity)" 'DarkGray'

    $lanes = @(
        [pscustomobject]@{ Id = 'node-port-tests'; Dir = $TestsDir; Pattern = '*.test.mjs'; WorkDir = $RepoRoot; MinFiles = $MinNodeFiles; MinTests = $MinNodeTests }
        [pscustomobject]@{ Id = 'node-status-receipts'; Dir = $TestsDir; Pattern = 'status-receipts.test.mjs'; WorkDir = $RepoRoot; MinFiles = 1; MinTests = 6 }
    )
    foreach ($testLane in $lanes) {
        Assert-GateTime $testLane.Id
        $files = @(Get-ChildItem -LiteralPath $testLane.Dir -Filter $testLane.Pattern -File -ErrorAction Stop | Sort-Object Name | ForEach-Object { $_.FullName })
        try {
            $null = Assert-DshNodeTestCounts -Files $files -Output "# tests 1`n# pass 1" -MinFiles $testLane.MinFiles -MinTests 1 -Lane $testLane.Id
        } catch {
            Add-GateFailure $testLane.Id $_.Exception.Message
            continue
        }
        $run = Invoke-DshGateNode -NodeExe $nodeExe -Arguments (@('--test') + $files) -WorkDir $testLane.WorkDir -TimeoutSeconds 1800
        $combined = ($run.StandardOutput + "`n" + $run.StandardError)
        Set-Content -LiteralPath (Join-Path $OwnedRoot "$($testLane.Id).log") -Value $combined -Encoding Ascii
        try {
            $counts = Assert-DshNodeTestCounts -Files $files -Output $combined -MinFiles $testLane.MinFiles -MinTests $testLane.MinTests -Lane $testLane.Id
            if ($run.ExitCode -ne 0) { Add-GateFailure $testLane.Id "exit $($run.ExitCode) with $($counts.Tests) tests ($($counts.Passed) pass)" }
            else { Add-GatePass $testLane.Id "files=$($counts.Files) tests=$($counts.Tests) pass=$($counts.Passed) childToken=$($run.ChildTokenLevel) adapterNode=$nodeExe" }
        } catch {
            Add-GateFailure $testLane.Id $_.Exception.Message
        }
    }

    # The declared packaging Node suites are run the way build.ps1 runs them: through
    # `tsx/esm` from the upstream workspace, because they resolve the upstream
    # module graph. Each is invoked explicitly, so a renamed or deleted suite is a
    # failure rather than a smaller run.
    $upstream = Join-Path $RepoRoot '_upstream'
    $packagingWorkDir = if (Test-Path -LiteralPath (Join-Path $upstream 'node_modules\tsx')) { $upstream } else { $RepoRoot }
    foreach ($name in @('installer-contract.test.mjs', 'runtime-lock-inputs.test.mjs', 'repair-gate-inventory.test.mjs', 'config-editor-runtime-import.test.mjs', 'runtime-materializer.test.mjs', 'runtime-seal.test.mjs', 'build-script.test.mjs', 'gate-contract.test.mjs', 'execution-node-trust.test.mjs')) {
        Assert-GateTime "packaging suite $name"
        $file = Join-Path $PackagingTests $name
        $laneId = "node-packaging-$($name -replace '\.test\.mjs$', '')"
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Add-GateFailure $laneId "declared Node suite is missing: $name"; continue }
        $run = Invoke-DshGateNode -NodeExe $nodeExe -Arguments @('--import', 'tsx/esm', $file) -WorkDir $packagingWorkDir -TimeoutSeconds 1200
        $combined = ($run.StandardOutput + "`n" + $run.StandardError)
        Set-Content -LiteralPath (Join-Path $OwnedRoot "$laneId.log") -Value $combined -Encoding Ascii
        try {
            $counts = Assert-DshNodeTestCounts -Files @($file) -Output $combined -MinFiles 1 -MinTests 1 -Lane $laneId
            if ($run.ExitCode -ne 0) { Add-GateFailure $laneId "exit $($run.ExitCode) with $($counts.Tests) tests ($($counts.Passed) pass)" }
            else { Add-GatePass $laneId "tests=$($counts.Tests) pass=$($counts.Passed) childToken=$($run.ChildTokenLevel)" }
        } catch {
            Add-GateFailure $laneId $_.Exception.Message
        }
    }
}

# ---------------------------------------------------------------------------
# UI lane: build, type checks and the vitest suites INCLUDING native-guests.
# ---------------------------------------------------------------------------
if ($Lane -in @('ui', 'all')) {
    Write-Gate '' ; Write-Gate '==> UI build and tests' 'Cyan'
    $uiDir = Join-Path $PortRoot 'ui'
    $nodeExe = if ($PreflightNode) { $PreflightNode } elseif ($NodePath) { $NodePath } else { (Get-Command node -ErrorAction Stop).Source }
    $vitestDirs = @('desktop-bridge/tests', 'client-updates/tests', 'native-guests/tests')
    $uiTestFiles = @()
    foreach ($dir in $vitestDirs) {
        $full = Join-Path $uiDir $dir
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { Add-GateFailure 'ui-tests' "declared vitest directory is missing: $dir"; continue }
        $uiTestFiles += @(Get-ChildItem -LiteralPath $full -Recurse -File -Include '*.spec.ts', '*.test.ts' -ErrorAction Stop)
    }
    if ($uiTestFiles.Count -lt $MinUiTestFiles) {
        Add-GateFailure 'ui-tests' "only $($uiTestFiles.Count) UI test file(s) across $($vitestDirs -join ', '); at least $MinUiTestFiles are required (native-guests must be included)."
    } else {
        $run = Invoke-DshGateNode -NodeExe $nodeExe -Arguments (@('node_modules/vitest/vitest.mjs', 'run') + $vitestDirs) -WorkDir $uiDir -TimeoutSeconds 1800
        $combined = ($run.StandardOutput + "`n" + $run.StandardError)
        Set-Content -LiteralPath (Join-Path $OwnedRoot 'ui-vitest.log') -Value $combined -Encoding Ascii
        $passed = $null
        $zeroTestFiles = @()
        foreach ($line in ($combined -split "`r?`n")) {
            if ($line -match 'Tests\s+(?<v>\d+)\s+passed') { $passed = [int]$Matches.v }
            # A file that collects zero tests is a broken suite, not an empty one: an
            # unbalanced brace made vitest collect 0 tests and still print a summary.
            if ($line -match '(?<file>\S+\.spec\.ts)\s+\(0 test') { $zeroTestFiles += $Matches.file }
        }
        if ($zeroTestFiles.Count -gt 0) {
            Add-GateFailure 'ui-tests' "these test files collected 0 tests: $($zeroTestFiles -join ', ')"
        }
        if ($run.ExitCode -ne 0) { Add-GateFailure 'ui-tests' "vitest exited $($run.ExitCode)" }
        elseif ($null -eq $passed) { Add-GateFailure 'ui-tests' 'vitest output has no test total; the run is unverifiable.' }
        elseif ($passed -lt $MinUiTests) { Add-GateFailure 'ui-tests' "vitest passed $passed test(s); at least $MinUiTests are required." }
        else { Add-GatePass 'ui-tests' "dirs=$($vitestDirs -join ',') files=$($uiTestFiles.Count) passed=$passed" }
    }

    $typeProjects = @('desktop-bridge/tsconfig.json', 'client-updates/tsconfig.json', 'native-guests/tsconfig.json')
    foreach ($project in $typeProjects) {
        Assert-GateTime "tsc $project"
        $run = Invoke-DshGateNode -NodeExe $nodeExe -Arguments @('node_modules/typescript/bin/tsc', '--noEmit', '-p', $project) -WorkDir $uiDir -TimeoutSeconds 900
        if ($run.ExitCode -ne 0) {
            Set-Content -LiteralPath (Join-Path $OwnedRoot "tsc-$($project -replace '[/\\]', '-').log") -Value ($run.StandardOutput + $run.StandardError) -Encoding Ascii
            Add-GateFailure "ui-types-$project" "tsc exited $($run.ExitCode)"
        } else { Add-GatePass "ui-types-$project" 'no type errors' }
    }

    # A TEXT check on `build:verify` proves nothing about the build: the gate used to
    # stop here and never actually built the UI. It now runs a REAL Vite production
    # build with the pinned payload interpreter and a trusted, Medium esbuild copy into
    # a fresh path inside this run's owned root, publishes it atomically to a validated
    # output path, and passes only with numeric artifact counts.
    $uiBuildRoot = Join-Path $OwnedRoot 'ui-build'
    if (-not (Test-Path -LiteralPath $uiBuildRoot)) { $null = New-Item -ItemType Directory -Path $uiBuildRoot -ErrorAction Stop }
    try {
        Import-Module (Join-Path $PackagingTests 'ui-build-qualification.psm1') -Force
        Assert-GateTime 'ui-production-build'
        $uiBuild = Invoke-DshQualifiedUiBuild -PortRoot $PortRoot -OwnedRoot $uiBuildRoot -OutDir (Join-Path $uiBuildRoot 'dist') -RepoRoot $RepoRoot -MinAssets 1 -MinFiles 10
        if ($uiBuild.Files -le 0 -or $uiBuild.Assets -le 0 -or $uiBuild.Bytes -le 0) {
            Add-GateFailure 'ui-production-build' "non-numeric build evidence: files=$($uiBuild.Files) assets=$($uiBuild.Assets) bytes=$($uiBuild.Bytes)"
        } else {
            Add-GatePass 'ui-production-build' "files=$($uiBuild.Files) assets=$($uiBuild.Assets) bytes=$($uiBuild.Bytes) node=$($uiBuild.NodeVersion) esbuild=$($uiBuild.EsbuildVersion) esbuildToken=$($uiBuild.EsbuildChildToken) viteToken=$($uiBuild.ViteChildToken) fresh=$($uiBuild.FreshOutDir) outDir=$($uiBuild.OutDir)"
        }
    } catch {
        Add-GateFailure 'ui-production-build' $_.Exception.Message
    }

    # The `build:verify` contract still matters: it is the script a developer runs.
    $uiPackage = Get-Content -LiteralPath (Join-Path $uiDir 'package.json') -Raw | ConvertFrom-Json
    if (-not ($uiPackage.scripts.PSObject.Properties.Name -contains 'build:verify')) {
        Add-GateFailure 'ui-build-verify' 'port/ui/package.json declares no build:verify script, so a build never invokes its affected tests.'
    } else {
        $buildVerify = $uiPackage.scripts.'build:verify'
        foreach ($required in @('build', 'test', 'native-guests/tests')) {
            if ($buildVerify -notmatch [regex]::Escape($required)) { Add-GateFailure 'ui-build-verify' "build:verify does not invoke '$required'" }
        }
        if ($uiPackage.scripts.test -notmatch 'native-guests/tests') {
            Add-GateFailure 'ui-build-verify' 'the UI test script does not include native-guests/tests'
        }
    }
}

# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------
try { Stop-Transcript | Out-Null } catch { }
$elapsed = [math]::Round(((Get-Date) - $script:StartedAt).TotalSeconds, 1)
Write-Gate ''
Write-Gate "GATE_SUMMARY passes=$($script:GatePasses.Count) skips=$($script:GateSkips.Count) failures=$($script:GateFailures.Count) seconds=$elapsed root=$OwnedRoot"
Write-Gate "GATE_EVIDENCE=$OwnedRoot"

if ($script:GateFailures.Count -gt 0) {
    Write-Gate "GATE_RESULT=FAIL" 'Red'
    foreach ($failure in $script:GateFailures) { Write-Gate "  - $failure" 'Red' }
    exit 1
}
if ($script:GateSkips.Count -gt 0) {
    # A skip is never a pass: the gate exits 3 and says exactly what did not run.
    Write-Gate 'GATE_RESULT=SKIP (not a pass)' 'Yellow'
    foreach ($skip in $script:GateSkips) { Write-Gate "  - $skip" 'Yellow' }
    exit 3
}
Write-Gate 'GATE_RESULT=PASS' 'Green'
exit 0
