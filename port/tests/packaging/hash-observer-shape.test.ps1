#requires -Version 5.1
<#
  hash-observer-shape.test.ps1 — regression test for
  `Assert-HashObserverOverrideShape` in port/scripts/build.ps1.

  AST EXTRACTION ONLY: build.ps1 is parsed and the single function definition is
  defined in this process. The script is NEVER executed and never dot-sourced, so
  no stage, no Cargo, no registry and no app process can run.

  Regression: the override `cmd` comparison must be CASE-INSENSITIVE
  (String.Equals(..., OrdinalIgnoreCase)). The PowerShell generator derives the
  recorder path from %SystemRoot% (`C:\WINDOWS\...`), while the fixture writes
  `C:\Windows\...`; a `-cne` comparison used to fail there.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$buildPath = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'scripts\build.ps1'
if (-not (Test-Path -LiteralPath $buildPath -PathType Leaf)) { throw "build.ps1 not found at $buildPath" }
$buildHashBefore = (Get-FileHash -LiteralPath $buildPath -Algorithm SHA256).Hash

$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($buildPath, [ref]$tokens, [ref]$parseErrors)
if (@($parseErrors).Count -gt 0) { throw "build.ps1 did not parse: $(@($parseErrors)[0].Message)" }

$found = @($ast.FindAll({
  param($node)
  $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq 'Assert-HashObserverOverrideShape'
}, $true))
if ($found.Count -ne 1) { throw "expected exactly one Assert-HashObserverOverrideShape definition, found $($found.Count)" }

# Define ONLY that function in this scope. Nothing from build.ps1 executes.
$definition = [scriptblock]::Create($found[0].Extent.Text)
. $definition

# The function reads the script-scope canonical path. The generator derives it
# from %SystemRoot% (upper case on this host); the fixture uses mixed case.
$ObserverCanonicalPowerShell = 'C:\WINDOWS\System32\WindowsPowerShell\v1.0\powershell.exe'
$fixturePowerShell = 'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
if ($ObserverCanonicalPowerShell -ceq $fixturePowerShell) { throw 'fixture must differ in case from the canonical path' }
if (-not [string]::Equals($ObserverCanonicalPowerShell, $fixturePowerShell, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw 'fixture must still be the same path case-insensitively'
}

$pass = 0
$fail = 0
function Assert-Outcome {
  param([string]$Name, [scriptblock]$Body, [bool]$ShouldThrow)
  $message = ''
  $threw = $false
  try { & $Body } catch { $threw = $true; $message = $_.Exception.Message }
  if ($threw -eq $ShouldThrow) {
    $script:pass += 1
    Write-Host "PASS  $Name"
  } else {
    $script:fail += 1
    Write-Host "FAIL  $Name (expected throw=$ShouldThrow actual=$threw) $message"
  }
}

# Fenced fixture tree: new GUID directory under the OS temp root, removed at the end.
$fence = Join-Path ([System.IO.Path]::GetTempPath()) ('dsh-hash-observer-shape-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fence | Out-Null

try {
  $observer = Join-Path $fence 'recorder-observer.ps1'
  Set-Content -LiteralPath $observer -Value '# fixture observer (never executed)' -Encoding ASCII
  $otherObserver = Join-Path $fence 'other-observer.ps1'
  Set-Content -LiteralPath $otherObserver -Value '# fixture observer (never executed)' -Encoding ASCII
  $receiptRoot = Join-Path $fence 'receipt-root'
  New-Item -ItemType Directory -Path $receiptRoot | Out-Null
  $otherRoot = Join-Path $fence 'other-root'
  New-Item -ItemType Directory -Path $otherRoot | Out-Null
  $overridePath = Join-Path $fence 'override.json'

  function New-OverrideJson {
    param(
      $Cmd,
      $ArgList,
      [string]$Schema = 'https://schema.tauri.app/config/2',
      [string]$ExtraTopName = '',
      [switch]$BundleExtra,
      [switch]$WindowsExtra
    )
    $signCommand = @{ cmd = $Cmd; args = $ArgList }
    if ($WindowsExtra) { $signCommand['unexpected'] = 'x' }
    $windows = @{ signCommand = $signCommand }
    $bundle = @{ windows = $windows }
    if ($BundleExtra) { $bundle['macos'] = @{} }
    $document = @{ '$schema' = $Schema; bundle = $bundle }
    if ($ExtraTopName -ne '') { $document[$ExtraTopName] = 'x' }
    return ($document | ConvertTo-Json -Depth 10 -Compress)
  }
  function Set-OverrideJson {
    param([string]$Json)
    Set-Content -LiteralPath $overridePath -Value $Json -Encoding UTF8
  }
  function Invoke-ShapeCheck {
    Assert-HashObserverOverrideShape -OverridePath $overridePath -ExpectedObserverPath $observer -ExpectedReceiptRoot $receiptRoot
  }
  function New-CanonicalArgs {
    param([string]$CmdObserver = $observer, [string]$Root = $receiptRoot)
    return @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $CmdObserver, '%1', $Root)
  }

  # 1. CASE REGRESSION: canonical upper-case SystemRoot vs mixed-case generator path.
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs))
  Assert-Outcome 'case-only cmd difference is accepted (OrdinalIgnoreCase)' { Invoke-ShapeCheck } $false

  # 2. A different binary must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd 'C:\Windows\System32\cmd.exe' -ArgList @(New-CanonicalArgs))
  Assert-Outcome 'wrong binary refuses' { Invoke-ShapeCheck } $true

  # 3. Bare PowerShell (not the canonical full path) must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd 'powershell.exe' -ArgList @(New-CanonicalArgs))
  Assert-Outcome 'bare PowerShell name refuses' { Invoke-ShapeCheck } $true

  # 4. Non-string cmd must refuse rather than coerce.
  Set-OverrideJson (New-OverrideJson -Cmd 42 -ArgList @(New-CanonicalArgs))
  Assert-Outcome 'non-string cmd refuses' { Invoke-ShapeCheck } $true

  # 5. Wrong argument count must refuse (7 and 9). The FIXTURE IS PARSED FIRST so
  #    the rejection is proven to come from the count itself, never from an
  #    argument list that a typo silently swallowed.
  foreach ($count in @(7, 9)) {
    $candidateArgs = @(New-CanonicalArgs)
    if ($count -eq 7) { $candidateArgs = $candidateArgs[0..6] } else { $candidateArgs = $candidateArgs + 'extra' }
    Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList $candidateArgs)
    $parsedFixture = Get-Content -LiteralPath $overridePath -Raw | ConvertFrom-Json
    $parsedArgs = @($parsedFixture.bundle.windows.signCommand.args)
    if ($parsedArgs.Count -ne $count) { throw "fixture argument list is $($parsedArgs.Count), expected $count" }
    Assert-Outcome "arg count $count refuses" { Invoke-ShapeCheck } $true
  }

  # 6. Extra top-level member must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs) -ExtraTopName 'unexpected')
  Assert-Outcome 'extra top-level member refuses' { Invoke-ShapeCheck } $true

  # 7. Wrong schema key must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs) -Schema 'https://example.invalid/config/2')
  Assert-Outcome 'wrong schema value refuses' { Invoke-ShapeCheck } $true

  # 8. Extra bundle member and extra windows member must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs) -BundleExtra)
  Assert-Outcome 'extra bundle member refuses' { Invoke-ShapeCheck } $true
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs) -WindowsExtra)
  Assert-Outcome 'extra bundle.windows member refuses' { Invoke-ShapeCheck } $true

  # 9. Wrong observer file (existing, but not the expected one) must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs -CmdObserver $otherObserver))
  Assert-Outcome 'wrong observer path refuses' { Invoke-ShapeCheck } $true

  # 10. Correct path but absent observer file must refuse.
  $absentObserver = Join-Path $fence 'absent-observer.ps1'
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs -CmdObserver $absentObserver))
  Assert-Outcome 'absent observer file refuses' { Invoke-ShapeCheck } $true

  # 11. Wrong receipt root must refuse.
  Set-OverrideJson (New-OverrideJson -Cmd $fixturePowerShell -ArgList @(New-CanonicalArgs -Root $otherRoot))
  Assert-Outcome 'wrong receipt root refuses' { Invoke-ShapeCheck } $true

  # 12. Unparseable override JSON must refuse.
  Set-OverrideJson '{ not json'
  Assert-Outcome 'unparseable override refuses' { Invoke-ShapeCheck } $true
} finally {
  if (Test-Path -LiteralPath $fence) {
    $resolvedFence = [System.IO.Path]::GetFullPath($fence)
    $tempBoundary = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if (-not $resolvedFence.StartsWith($tempBoundary, [System.StringComparison]::OrdinalIgnoreCase) -or
        [System.IO.Path]::GetFileName($resolvedFence) -cnotmatch '^dsh-hash-observer-shape-[0-9a-f]{32}$' -or
        ((Get-Item -LiteralPath $resolvedFence -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'Fixture cleanup target refused: expected the fresh owned non-reparse temp leaf'
    }
    Remove-Item -LiteralPath $resolvedFence -Recurse -Force
  }
}

# Cleanup guard: the fenced tree must be gone and nothing may remain beside it.
if (Test-Path -LiteralPath $fence) {
  $fail += 1
  Write-Host 'FAIL  fenced fixture tree was not removed'
} else {
  $pass += 1
  Write-Host 'PASS  fenced fixture tree removed (empty)'
}
if ((Test-Path -LiteralPath $buildPath -PathType Leaf) -and
    (Get-FileHash -LiteralPath $buildPath -Algorithm SHA256).Hash -ceq $buildHashBefore) {
  $pass += 1
  Write-Host 'PASS  build.ps1 byte-identical (SHA256 before/after; AST-parsed only)'
} else {
  $fail += 1
  Write-Host 'FAIL  build.ps1 missing or changed during the test'
}

Write-Host ("hash-observer-shape: pass={0} fail={1}" -f $pass, $fail)
if ($fail -ne 0) { exit 1 }
exit 0
