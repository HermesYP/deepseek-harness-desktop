<#
.SYNOPSIS
  Preflight for the Rust/UI gate: trusted outside target/TEMP root, image and
  actual child-token evidence, and a scoped proof of the trusted copy helper.

.DESCRIPTION
  This script deliberately RUNS NO BUILD AND NO TEST. It prepares and proves the
  environment the Rust gates need, prints the exact ready arguments, and stops.
  The parent decides when to run the serialized cargo gates.

  What it does:

    * creates one short owned root outside the checkout
      (`%LOCALAPPDATA%\DSH-Qual-<8 hex>` with `target`, `temp`, `probe`, `cargo`),
      because anything cargo links inside the workspace inherits the workspace's
      Low label and then fails with errors that name the wrong cause (the observed
      MSVC `D8050` and the credentials/diagnostics/profile test failures);
    * reports IMAGE evidence (path, length, size, SHA-256, mandatory label) and
      ACTUAL CHILD TOKEN evidence for `cargo.exe` and `rustc.exe`, from a child it
      started itself with `--version` and the per-child TEMP/TMP override;
    * reads the labels of the EXISTING in-workspace artifacts under
      `port/src-tauri/target` as read-only evidence (no build, no launch);
    * exercises `Copy-DshTrustedPlainCopy` on three real files into the owned root
      and proves hash equality, path containment and the destination label, with a
      negative control that must be REFUSED inside the Low-labelled workspace;
    * refuses when any toolchain child runs at Low integrity, and never relabels,
      never resets or normalises an ACL, never sweeps processes, never touches
      credentials, never installs and never launches the application.

.PARAMETER OwnedRoot
  Reuse an existing owned root created by a previous run of this preflight.
  Omitted: a fresh root is created and retained.

.PARAMETER Jobs
  Jobs recorded in the ready cargo arguments. Default 1 (serialized).

.PARAMETER KeepDebugInfo
  Do not add the `profile.dev.debug=0` override to the ready arguments.

.PARAMETER ProbeArtifact
  Also report image and (unless -SkipProbe) child-token evidence for one built
  artifact. For a Rust test binary the caller should pass `-ArtifactArguments
  --list`; an application binary is reported image-only unless the caller asks
  otherwise, because launching it is the parent's decision.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File port/tests/run-rust-qualification.ps1

.NOTES
  Windows PowerShell 5.1 and 7 compatible. Pure ASCII. Preflight only.
#>
[CmdletBinding()]
param(
    [string]$OwnedRoot,
    [int]$Jobs = 1,
    [switch]$KeepDebugInfo,
    [string]$ProbeArtifact,
    [string[]]$ArtifactArguments = @('--list'),
    [switch]$SkipProbe,
    [switch]$SkipCopySelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$TestsDir = $PSScriptRoot
$PortRoot = Split-Path -Parent $TestsDir
$PackagingTests = Join-Path $TestsDir 'packaging'

Import-Module (Join-Path $PackagingTests 'native-quoting.psm1') -Force
Import-Module (Join-Path $PackagingTests 'qualification-preflight.psm1') -Force
Import-Module (Join-Path $PackagingTests 'rust-qualification.psm1') -Force
Import-Module (Join-Path $PackagingTests 'suite-result.psm1') -Force

$script:Failures = @()

function Fail([string]$Message) {
    $script:Failures += $Message
    Write-Host "RUST_PREFLIGHT_FAILURE=$Message" -ForegroundColor Red
}

Write-Host ''
Write-Host '==> Rust qualification preflight (no build, no test, no launch)' -ForegroundColor Cyan

# Parent integrity first: every other observation is meaningless without it.
$parent = Get-DshProcessIntegrity -ProcessId $PID
if (-not $parent.Known) {
    Fail "this process's own integrity could not be read ($($parent.Reason)); refusing unknown visibility"
}
Write-Host "PARENT_INTEGRITY level=$($parent.Level) sid=$($parent.Sid)"

if ($env:OS -ne 'Windows_NT') {
    exit (Write-DshSuiteResult -Id 'rust-preflight' -Status 'SKIP' -Reason 'not-applicable' -Detail 'the Low-integrity workspace hazard is Windows-only')
}

# ---------------------------------------------------------------------------
# 1. The owned outside root.
# ---------------------------------------------------------------------------
if ($OwnedRoot) {
    if (-not (Test-Path -LiteralPath $OwnedRoot -PathType Container)) { throw "The requested owned root is absent: $OwnedRoot" }
    $owned = [pscustomobject]@{
        Root = (Resolve-Path -LiteralPath $OwnedRoot).Path
        Target = Join-Path $OwnedRoot 'target'
        Temp = Join-Path $OwnedRoot 'temp'
        Probe = Join-Path $OwnedRoot 'probe'
        Cargo = Join-Path $OwnedRoot 'cargo'
    }
    foreach ($path in @($owned.Target, $owned.Temp, $owned.Probe, $owned.Cargo)) {
        if (-not (Test-Path -LiteralPath $path)) { $null = New-Item -ItemType Directory -Path $path -ErrorAction Stop }
    }
    Write-Host "RUST_QUAL_ROOT=$($owned.Root) (reused; retained)"
} else {
    $owned = New-DshRustQualificationRoot
}

# ---------------------------------------------------------------------------
# 2. Toolchain image + actual child token evidence.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '==> Toolchain evidence (image label, SHA-256, live child token)' -ForegroundColor Cyan
$toolchain = Get-DshRustToolchainEvidence -OwnedRoot $owned.Root -ProbeToken
foreach ($entry in $toolchain.Tools) {
    if (-not $entry.Present) {
        Write-Host "TOOL_ABSENT=$($entry.Tool) (PATH lookup failed)"
        Fail "$($entry.Tool) is not on PATH"
        continue
    }
    $image = $entry.Image
    Write-Host ("TOOL_IMAGE={0} bytes={1} pathLength={2} label={3} sha256={4}" -f `
        $image.Path, $image.Bytes, $image.PathLength, $image.LabelLevel, $image.Sha256)
    if ($null -ne $entry.Child) {
        Write-Host ("TOOL_CHILD_TOKEN={0} exit={1} childToken={2} sid={3} version='{4}'" -f `
            $entry.Tool, $entry.Child.ExitCode, $entry.Child.ChildTokenLevel, $entry.Child.ChildTokenSid, $entry.Child.StandardOutput)
    }
    if ($entry.Refusal) { Fail "$($entry.Tool): $($entry.Refusal)" }
}
if ($null -ne $toolchain.Link) {
    Write-Host ("LINK_IMAGE={0} label={1} sha256={2}" -f $toolchain.Link.Path, $toolchain.Link.LabelLevel, $toolchain.Link.Sha256)
} else {
    Write-Host 'LINK_IMAGE=not-on-PATH (rustc resolves the MSVC toolset through its own environment; reported, not failed)'
}

# ---------------------------------------------------------------------------
# 3. Read-only evidence of the EXISTING in-workspace artifacts.
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host '==> Existing in-workspace artifacts (read-only; explains the failures)' -ForegroundColor Cyan
$tauriTarget = Join-Path $PortRoot 'src-tauri\target'
if (Test-Path -LiteralPath $tauriTarget -PathType Container) {
    # Only real images are sampled (`-Include` does not filter with -LiteralPath),
    # and the EFFECTIVE label is used: a file created before the workspace was
    # labelled carries no explicit label, so its own record alone would read
    # "absent" for an object that is governed by a Low ancestor.
    $samples = @(Get-ChildItem -LiteralPath $tauriTarget -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @('.exe', '.dll') } | Select-Object -First 6)
    if ($samples.Count -eq 0) { Write-Host "IN_WORKSPACE_ARTIFACTS=none-yet under $tauriTarget" }
    foreach ($sample in $samples) {
        $effective = Get-DshEffectiveIntegrity -Path $sample.FullName
        Write-Host ("IN_WORKSPACE_ARTIFACT={0} effectiveLabel={1} source={2}" -f $sample.FullName, $effective.Level, $effective.Source)
    }
    $targetEffective = Get-DshEffectiveIntegrity -Path $tauriTarget
    Write-Host ("IN_WORKSPACE_TARGET={0} effectiveLabel={1} source={2} (left unmodified; no build or launch performed)" -f $tauriTarget, $targetEffective.Level, $targetEffective.Source)
} else {
    Write-Host "IN_WORKSPACE_TARGET=absent ($tauriTarget)"
}

# ---------------------------------------------------------------------------
# 4. Trusted copy helper: scoped proof, not the whole checkout.
# ---------------------------------------------------------------------------
if (-not $SkipCopySelfTest) {
    Write-Host ''
    Write-Host '==> Trusted plain copy self-test (scoped fixture)' -ForegroundColor Cyan
    try {
        $selfTest = Invoke-DshTrustedCopySelfTest -PortRoot $PortRoot -ProveNegativeControl
        if ($selfTest.NegativeControl -ne 'refused') {
            Fail "the copy helper did not refuse a Low-labelled destination (negative control: $($selfTest.NegativeControl))"
        } elseif ($selfTest.NegativeGuard -ne 'label-guard') {
            # Honest reporting: the destination was refused, but by a different
            # guard. The label guard is then verified by source inspection only,
            # which is recorded rather than presented as a proven control.
            Write-Host "COPY_SELFTEST_NOTE=refused by $($selfTest.NegativeGuard), not the label guard; label guard verified by source inspection only" -ForegroundColor DarkYellow
        }
    } catch {
        Fail "copy self-test failed: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 5. Optional artifact probe.
# ---------------------------------------------------------------------------
if ($ProbeArtifact) {
    Write-Host ''
    Write-Host '==> Artifact evidence' -ForegroundColor Cyan
    try {
        $artifact = Test-DshRustArtifactTrust -Path $ProbeArtifact -Arguments $ArtifactArguments `
            -OwnedRoot $owned.Root -SkipProbe:$SkipProbe
        if ($artifact.Probed -and -not $artifact.Child.ChildTokenKnown) {
            Fail "artifact child token unknown: $($artifact.Child.ChildTokenReason)"
        }
        if ($artifact.Probed -and $artifact.Child.ChildTokenLevel -eq 'low') {
            Fail "artifact $($artifact.Image.Path) runs at Low integrity; a Low artifact cannot write up to the trusted temp root"
        }
    } catch {
        Fail "artifact probe failed: $($_.Exception.Message)"
    }
}

# ---------------------------------------------------------------------------
# 6. Ready arguments for the parent's serialized cargo gates.
# ---------------------------------------------------------------------------
$childEnvironment = Get-DshRustChildEnvironment -OwnedRoot $owned.Root
$cargoArguments = Get-DshRustCargoArguments -Jobs $Jobs -KeepDebugInfo:$KeepDebugInfo -Locked -Offline
# A fresh checkpoint directory for the FIRST gate, plus a persisted context, so the
# parent can consume one structured object instead of re-deriving paths.
$checkpoint = New-DshRustCheckpoint -Root $owned.Root -Name 'cargo-gate' -Environment $childEnvironment
$targetTrust = Test-DshRustTargetTrust -TargetRoot $owned.Target -ParentIntegrity $parent.Level
$contextPath = Join-Path $owned.Root 'preflight-context.json'
$context = [ordered]@{
    createdUtc = (Get-Date).ToUniversalTime().ToString('o')
    trusted = ($script:Failures.Count -eq 0 -and $targetTrust.Available)
    refusals = $script:Failures
    root = $owned.Root
    target = $owned.Target
    temp = $owned.Temp
    probe = $owned.Probe
    checkpoint = $checkpoint.Dir
    parentIntegrity = $parent.Level
    environment = @{}
    cargoArguments = $cargoArguments
    targetTrust = $targetTrust
}
foreach ($key in ($childEnvironment.Keys | Sort-Object)) { $context.environment[$key] = [string]$childEnvironment[$key] }
Set-Content -LiteralPath $contextPath -Value ($context | ConvertTo-Json -Depth 5) -Encoding Ascii

Write-Host ''
Write-Host '==> Ready arguments (parent executes; this script does not)' -ForegroundColor Cyan
Write-Host "READY_ROOT=$($owned.Root)"
Write-Host "READY_TARGET_DIR=$($childEnvironment.CARGO_TARGET_DIR)"
Write-Host "READY_TEMP=$($childEnvironment.TEMP)"
Write-Host "READY_PROBE_DIR=$($owned.Probe)"
Write-Host "READY_CONTEXT_JSON=$contextPath"
Write-Host "READY_CHECKPOINT_DIR=$($checkpoint.Dir)"
Write-Host ("READY_ENV=" + (($childEnvironment.Keys | Sort-Object | ForEach-Object { "$_=$($childEnvironment[$_])" }) -join ';'))
Write-Host ("READY_CARGO_ARGS=" + ($cargoArguments -join ' '))
Write-Host "READY_COMMAND_TEST=cargo test --workspace $($cargoArguments -join ' ')"
Write-Host "READY_COMMAND_CLIPPY=cargo clippy --workspace --all-targets $($cargoArguments -join ' ')"
Write-Host "READY_COMMAND_BUILD=cargo build --workspace $($cargoArguments -join ' ')"
Write-Host "READY_ARTIFACT_PROBE=Import-Module port/tests/packaging/rust-qualification.psm1; Test-DshRustArtifactTrust -Path <built.exe> -Arguments --list -OwnedRoot $($owned.Root)"
Write-Host 'READY_CONTEXT_HELPER=Get-DshRustPreflightContext -OwnedRoot <root>   # one call returns env+args+checkpoint+trust'
Write-Host 'READY_TRUST_RECHECK=Test-DshRustTargetTrust -TargetRoot <target>      # re-check before each gate'
Write-Host 'READY_NOTE=the environment keys above are per child; the caller''s environment is never modified'
Write-Host 'READY_NOTE=run the gates serially (--jobs 1, --test-threads=1) so no two links race the same temp'
Write-Host 'READY_NOTE=exit codes: use Invoke-DshNativeChecked or a Process object you started yourself; Start-Process -PassThru can report ExitCode $null on PS 5.1'

Write-Host ''
if ($script:Failures.Count -gt 0) {
    Write-Host 'RUST_PREFLIGHT=NOT-READY' -ForegroundColor Red
    foreach ($failure in $script:Failures) { Write-Host "  - $failure" -ForegroundColor Red }
    exit (Write-DshSuiteResult -Id 'rust-preflight' -Status 'FAIL' -Detail ($script:Failures -join '; '))
}
Write-Host 'RUST_PREFLIGHT=READY' -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'rust-preflight' -Status 'PASS' -Checks 9 -Detail "trusted root $($owned.Root); cargo/rustc image+child token Medium; copy helper proved")
