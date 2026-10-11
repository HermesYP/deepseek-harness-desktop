<#
.SYNOPSIS
  Resolve a Windows x64 runtime lock in a fresh owned root and emit a review-only candidate.
.DESCRIPTION
  This maintenance command never updates port/runtime-locks/windows-x64 and never stages or publishes a runtime payload. Each run writes its candidate and inventory diff under a fresh external qualification root so the review artifact remains outside linked workspaces until manually adopted.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')][string]$CandidateName,
  [string]$NodeArchivePath,
  [switch]$AllowNodeDownload
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
$Packaging = Join-Path $PortRoot 'tests\packaging'
Import-Module (Join-Path $Packaging 'qualification-preflight.psm1') -Force
$CandidateBase = New-DshQualificationRoot -Prefix 'runtime-lock-candidate'
$CandidateRoot = Join-Path $CandidateBase $CandidateName
$DiffPath = Join-Path $CandidateBase "$CandidateName.diff"
if (Test-Path -LiteralPath $CandidateRoot) { throw "Runtime lock candidate already exists and is preserved: $CandidateRoot" }
if (Test-Path -LiteralPath $DiffPath) { throw "Runtime lock diff already exists and is preserved: $DiffPath" }
$StageRoot = New-DshQualificationRoot -Prefix 'runtime-lock'
$BuildScript = Join-Path $PSScriptRoot 'build.ps1'
$PowerShell = Join-Path $PSHOME 'powershell.exe'
$Arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $BuildScript,
  '-Stage', 'runtime-lock-refresh', '-RuntimeLockCandidateName', $CandidateName,
  '-RuntimeLockStageRoot', $StageRoot, '-RuntimeLockCandidateRoot', $CandidateRoot)
if ($NodeArchivePath) { $Arguments += @('-NodeArchivePath', $NodeArchivePath) }
if ($AllowNodeDownload) { $Arguments += '-AllowNodeDownload' }
& $PowerShell @Arguments
if ($LASTEXITCODE -ne 0) { throw "Runtime lock refresh stage failed with exit code $LASTEXITCODE; retained root: $StageRoot" }

$ReviewedRoot = Join-Path $PortRoot 'runtime-locks\windows-x64'
$oldFiles = @{}
if (Test-Path -LiteralPath $ReviewedRoot -PathType Container) {
  foreach ($file in Get-ChildItem -LiteralPath $ReviewedRoot -Recurse -File -Force) {
    $relative = $file.FullName.Substring($ReviewedRoot.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar).Replace([System.IO.Path]::DirectorySeparatorChar, '/')
    $oldFiles[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}
$newFiles = @{}
foreach ($file in Get-ChildItem -LiteralPath $CandidateRoot -Recurse -File -Force) {
  $relative = $file.FullName.Substring($CandidateRoot.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar).Replace([System.IO.Path]::DirectorySeparatorChar, '/')
  $newFiles[$relative] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
}
$diff = New-Object System.Collections.Generic.List[string]
$diff.Add("Runtime lock input inventory diff; candidate is NOT reviewed or activated.")
$diff.Add("Baseline: $ReviewedRoot")
$diff.Add("Candidate: $CandidateRoot")
$added = 0; $removed = 0; $changed = 0; $same = 0
foreach ($relative in @(@($oldFiles.Keys) + @($newFiles.Keys) | Sort-Object -Unique)) {
  $hasOld = $oldFiles.ContainsKey($relative)
  $hasNew = $newFiles.ContainsKey($relative)
  if (-not $hasOld) { $added++; $diff.Add("ADDED   $relative  sha256=$($newFiles[$relative])") }
  elseif (-not $hasNew) { $removed++; $diff.Add("REMOVED $relative  sha256=$($oldFiles[$relative])") }
  elseif ($oldFiles[$relative] -ne $newFiles[$relative]) {
    $changed++; $diff.Add("CHANGED $relative  sha256=$($oldFiles[$relative]) -> $($newFiles[$relative])")
  } else { $same++ }
}
$diff.Add("Totals: added=$added changed=$changed removed=$removed unchanged=$same")
$diff.Add("Review descriptor.json, pnpm-workspace.yaml, pnpm-lock.yaml, desktop-packages.json and every desktop-packages/*.tgz integrity before any manual adoption.")
$stream = [System.IO.File]::Open($DiffPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
try {
  $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
  try { $writer.WriteLine(($diff -join [Environment]::NewLine)) } finally { $writer.Dispose() }
} finally { if ($stream) { $stream.Dispose() } }

$descriptor = Get-Content -LiteralPath (Join-Path $CandidateRoot 'descriptor.json') -Raw | ConvertFrom-Json
if ($descriptor.reviewStatus -ne 'CANDIDATE' -or $descriptor.target -ne 'win-x64') {
  throw 'Refresh output did not retain the required CANDIDATE status and Windows x64 target.'
}
Write-Host "RUNTIME_LOCK_CANDIDATE=$CandidateRoot"
Write-Host "RUNTIME_LOCK_DESCRIPTOR=$(Join-Path $CandidateRoot 'descriptor.json')"
Write-Host "RUNTIME_LOCK_DIFF=$DiffPath"
Write-Host 'REVIEW_STATUS=CANDIDATE (not consumed by normal staging; manual review/adoption required)'
Write-Host "RUNTIME_LOCK_STAGE_ROOT=$StageRoot"
