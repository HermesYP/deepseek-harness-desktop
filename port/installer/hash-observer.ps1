#requires -Version 5.1
<#
.SYNOPSIS
  hash-observer - NON-MUTATING tauri-bundler `bundle.windows.signCommand` hash
  observer. Runs wherever the bundler's signing surface invokes the configured
  command, including the NSIS `!uninstfinalize` hook during the owned bundle.
  It hashes every invoked PE file (read-only), appends one JSONL receipt per
  invocation under the owned receipt root, and PRESERVES a copy of the NSIS
  uninstaller temp file ONLY when the returned path is identifiable as one
  (%1 basename uninstall.exe / un.exe). Any other classification is 'unknown';
  nothing is guessed, no signature is claimed or produced - unsigned bytes stay
  unsigned and receipts carry mode 'observer-only', signatureClaimed: false.

.NOTES
  Node/build context only: stdout stays empty on success so the bundler log
  stays clean; failures exit nonzero so the owned bundle fails loud. The
  observed file is never written. Receipt values contain file paths + digests
  only (no platform URLs, no credentials, no auth material).

.PARAMETERS (invocation shape)
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File <this file> %1 <receiptRoot>
  Tauri substitutes %1 with the observed binary path (custom sign command
  placeholder, tauri-bundler 2.9.4 sign.rs:135-159; the NSIS !uninstfinalize
  hook substitutes it with the freshly compiled uninstaller at build time).

.EXIT CODES
  0 receipt appended | 1 observed file absent (fail loud) | 2 contract refusal.
#>

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ObservedPath,
  [Parameter(Mandatory = $true)][string]$ReceiptRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($ObservedPath) -or [string]::IsNullOrWhiteSpace($ReceiptRoot)) { exit 2 }
if ([regex]::IsMatch($ObservedPath, '"')) { exit 2 }
$observed = [System.IO.Path]::GetFullPath($ObservedPath)
$root = [System.IO.Path]::GetFullPath($ReceiptRoot)
if ($observed -ceq $ObservedPath -and $observed -cmatch '[\u0000-\u001f]') { exit 2 }
if (-not [System.IO.Path]::IsPathRooted($root)) { exit 2 }
if (-not (Test-Path -LiteralPath $root -PathType Container)) { exit 2 }

$observedUtc = [DateTime]::UtcNow.ToString('o')
if (-not (Test-Path -LiteralPath $observed -PathType Leaf)) {
  @{ kind = 'hash-observer'; mode = 'observer-only'; signatureClaimed = $false
     observedUtc = $observedUtc; observedPath = $observed
     error = 'observed-file-absent' } |
    ConvertTo-Json -Compress |
    Add-Content -LiteralPath (Join-Path $root 'receipts.jsonl') -Encoding UTF8
  exit 1
}

$sha256 = (Get-FileHash -LiteralPath $observed -Algorithm SHA256).Hash.ToLowerInvariant()
$file = Get-Item -LiteralPath $observed -Force
$stream = [System.IO.File]::OpenRead($observed)
try {
  $byte0 = $stream.ReadByte(); $byte1 = $stream.ReadByte()
} finally { $stream.Close() }
$mzHeader = ($byte0 -eq 0x4D -and $byte1 -eq 0x5A)

$class = 'unknown'
$preservedCopy = $null
$baseName = $file.Name
if ($baseName -imatch '^(un\.exe|uninstall\.exe)$') {
  $class = 'nsis-uninstaller'
  $preservedDir = Join-Path $root 'preserved'
  if (-not (Test-Path -LiteralPath $preservedDir)) {
    New-Item -ItemType Directory -Path $preservedDir -Force | Out-Null
  }
  $preservedCopy = Join-Path $preservedDir ("{0}-{1}" -f
    ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ')), $baseName)
  Copy-Item -LiteralPath $observed -Destination $preservedCopy -ErrorAction Stop
}

@{
  kind = 'hash-observer'
  mode = 'observer-only'
  signatureClaimed = $false
  observedUtc = $observedUtc
  observedPath = $observed
  fileName = $baseName
  sizeBytes = $file.Length
  sha256 = $sha256
  mzHeader = $mzHeader
  classification = $class
  preservedCopy = $preservedCopy
} | ConvertTo-Json -Compress |
  Add-Content -LiteralPath (Join-Path $root 'receipts.jsonl') -Encoding UTF8
exit 0
