# Regression suite for named build.ps1 resource-guard functions (PS 5.1 target).
#
# CONTRACT OF THIS FILE:
#   * NEVER dispatches (dot-sources or executes) build.ps1. It parses the file,
#     AST-extracts EXACTLY the named top-level function DEFINITIONS, and
#     materialises only those definitions into a throwaway scope. No top-level
#     script statement of build.ps1 is ever evaluated.
#   * All fixtures live inside ONE newly-created directory under the user's
#     temp root ("fenced owned": fixture-owned paths only). No repository
#     source, user profile, credential store, network or ACL state is touched.
#   * Case expectations encode the parser/generator CONTRACTS, independent of
#     where build.ps1 currently puts those functions, so the suite survives
#     concurrent parent edits (function bodies are re-extracted at run time).
#
# REQUIRED TARGET FUNCTIONS (missing or ambiguous definitions fail closed):
#   Get-ArtifactExeFromCargoJson     (group A; Stream param + finished checks)
#   Get-ResourceTreePhysicalMetadata (group B; canonical paths, no './' prefix)
#   Write-CombinedResourcePhysicalMetadata (group B)
#   Assert-BundleGuardConfiguration  (group C; hook/overlay refusals)
#
# RUN (Windows PowerShell 5.1):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
#     port\tests\packaging\resource-guard-functions.test.ps1
# Exit code 0 = a nonempty set of cases passed with no skips; 1 = a case
# failed/skipped or no cases ran; extraction/setup errors fail nonzero.

[CmdletBinding()]
param(
    # Restrict to groups, e.g. -Groups A,B. Default: all.
    [ValidateSet('A', 'B', 'C')]
    [string[]]$Groups = @('A', 'B', 'C'),
    # Diagnostics only: keep the fixture tree after the run (contents are
    # fixture-synthetic, never private data).
    [switch]$KeepFixtures
)

$ErrorActionPreference = 'Stop'
$suiteStartedAt = Get-Date

# ---------------------------------------------------------------------------
# Results
# ---------------------------------------------------------------------------

$script:CaseResults = New-Object System.Collections.Generic.List[object]

function Add-CaseResult([string]$Id, [string]$Name, [string]$Outcome, [string]$Detail) {
    $script:CaseResults.Add([pscustomobject]@{
        Id      = $Id
        Name    = $Name
        Outcome = $Outcome   # PASS | FAIL | SKIP
        Detail  = $Detail
    })
    if ($Outcome -eq 'PASS') {
        Write-Host  ("  [PASS] {0} {1}" -f $Id, $Name) -ForegroundColor Green
    }
    elseif ($Outcome -eq 'SKIP') {
        Write-Host  ("  [SKIP] {0} {1} :: {2}" -f $Id, $Name, $Detail) -ForegroundColor Yellow
    }
    else {
        Write-Host  ("  [FAIL] {0} {1} :: {2}" -f $Id, $Name, $Detail) -ForegroundColor Red
    }
}

function Invoke-Case([string]$Id, [string]$Name, [scriptblock]$Body) {
    try {
        & $Body
        Add-CaseResult $Id $Name 'PASS' ''
    }
    catch {
        Add-CaseResult $Id $Name 'FAIL' ($_.Exception.Message -replace '\r?\n', ' | ')
    }
}

# Assert that a call fails and that its failure text matches the contract.
# $ExpectedSubstrings  must all appear (case-insensitive).
# $ForbiddenSubstrings must all be ABSENT (case-insensitive).
function Assert-CallFails([scriptblock]$Body, [string[]]$ExpectedSubstrings, [string[]]$ForbiddenSubstrings) {
    try {
        $null = & $Body
    }
    catch {
        $message = [string]$_.Exception.Message
        foreach ($expected in $ExpectedSubstrings) {
            if ($message.IndexOf($expected, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
                throw ("failure text is missing the expected fragment {0}; actual: {1}" -f $expected, $message)
            }
        }
        foreach ($forbidden in $ForbiddenSubstrings) {
            if ($message.IndexOf($forbidden, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
                throw ("failure text contains a forbidden fragment {0} (content must never be echoed); actual: {1}" -f $forbidden, $message)
            }
        }
        return
    }
    throw 'expected the guarded call to fail; it did not fail'
}

function Assert-NoThrow([scriptblock]$Body, [string]$Context) {
    try {
        $null = & $Body
    }
    catch {
        throw ("{0} was expected to succeed but failed: {1}" -f $Context, $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# build.ps1 AST extraction (definition materialisation only)
# ---------------------------------------------------------------------------

$BuildScriptPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\scripts\build.ps1'))
if (-not (Test-Path -LiteralPath $BuildScriptPath -PathType Leaf)) {
    Write-Error ("cannot locate build.ps1 at {0}; run from port\tests\packaging" -f $BuildScriptPath)
    exit 2
}

$functionTexts = @{}
try {
    $tokens = $null
    $parseErrors = $null
    $ast = [System.Management.Automation.Language.Parser]::ParseFile(
        $BuildScriptPath, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        throw ("build.ps1 has {0} parse errors; first: {1} (line {2})" -f
            $parseErrors.Count, $parseErrors[0].Message, $parseErrors[0].Extent.StartLineNumber)
    }

    $targetNames = @(
        'Get-ArtifactExeFromCargoJson',
        'Get-ResourceTreePhysicalMetadata',
        'Write-CombinedResourcePhysicalMetadata',
        'Assert-BundleGuardConfiguration'
    )

    $allFunctions = @($ast.FindAll(
        { param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] },
        $true))

    foreach ($name in $targetNames) {
        $candidates = @($allFunctions | Where-Object { $_.Name -eq $name })
        # Prefer the top-level definition; more than one is an extraction error.
        $topLevel = @($candidates | Where-Object {
            $_.Parent -is [System.Management.Automation.Language.ScriptBlockAst] })
        if ($topLevel.Count -gt 1) {
            throw ("{0} is defined {1} times at the top level of build.ps1; extraction refuses to guess" -f $name, $topLevel.Count)
        }
        if ($candidates.Count -ne 1) {
            throw ("{0} needs exactly one definition; found {1}; missing or ambiguous guard functions cannot be skipped" -f $name, $candidates.Count)
        }
        $chosen = $null
        if ($topLevel.Count -eq 1) { $chosen = $topLevel[0] }
        elseif ($candidates.Count -ge 1) { $chosen = $candidates[0] }
        if ($null -ne $chosen) {
            $text = $chosen.Extent.Text
            # Guard: the materialised snippet must be a pure function definition.
            if ($text -notmatch '^\s*function\s+') {
                throw ("extracted extent for {0} does not start with a function definition; extraction refuses" -f $name)
            }
            $functionTexts[$name] = $text
        }
    }
}
catch {
    Write-Error ("suite could not extract function definitions: {0}" -f $_.Exception.Message)
    exit 2
}

Write-Host ("build.ps1 parsed OK at {0}" -f $BuildScriptPath)
Write-Host ("PSVersion: {0} ; extracted functions: {1} of 4 named targets" -f
    $PSVersionTable.PSVersion, $functionTexts.Count)
foreach ($name in @('Get-ArtifactExeFromCargoJson', 'Get-ResourceTreePhysicalMetadata',
    'Write-CombinedResourcePhysicalMetadata', 'Assert-BundleGuardConfiguration')) {
    $state = if ($functionTexts.ContainsKey($name)) { 'PRESENT' } else { 'ABSENT' }
    Write-Host ("  {0} {1}" -f $state, $name)
}

# Materialise definitions. The extents AST-proved to be function definitions;
# Invoke-Expression of a definition has no side effects beyond binding the name.
foreach ($key in @($functionTexts.Keys)) {
    Invoke-Expression $functionTexts[$key]
}

# ---------------------------------------------------------------------------
# Owned fixture root (created once; every case writes under its own subdir)
# ---------------------------------------------------------------------------

function Get-CanonicalTempRoot {
    return [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
}
$script:TempRoot = Get-CanonicalTempRoot
$fixtureName = "dsh-guard-functions-{0}" -f [guid]::NewGuid().ToString('N')
$script:FixtureRoot = [System.IO.Path]::GetFullPath((Join-Path $script:TempRoot $fixtureName))

function New-CaseDir([string]$CaseId) {
    $dir = Join-Path $script:FixtureRoot $CaseId
    $null = New-Item -ItemType Directory -Force -Path $dir
    return $dir
}

function New-FixtureFile([string]$Path, [string[]]$Lines) {
    $parent = Split-Path -Parent $Path
    if ($parent) { $null = New-Item -ItemType Directory -Force -Path $parent }
    if ($null -eq $Lines -or $Lines.Count -eq 0) {
        $null = New-Item -ItemType File -Force -Path $Path
        return
    }
    Set-Content -LiteralPath $Path -Value $Lines -Encoding Ascii
}

function New-FixtureDirWithFile([string]$Dir, [string]$FileName, [string]$FileText) {
    $null = New-Item -ItemType Directory -Force -Path $Dir
    Set-Content -LiteralPath (Join-Path $Dir $FileName) -Value $FileText -Encoding Ascii
}

# Delete reparse points WITHOUT following them, then the fixture tree itself.
function Remove-ReparsePoint([string]$Path) {
    if (Test-Path -LiteralPath $Path) {
        [System.IO.Directory]::Delete([System.IO.Path]::GetFullPath($Path), $false)
    }
}

function Remove-OwnedFixtureTree {
    $full = [System.IO.Path]::GetFullPath($script:FixtureRoot)
    if (-not $full.StartsWith($script:TempRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw ("refusing to remove a fixture path outside the temp root: {0}" -f $full)
    }
    if (Test-Path -LiteralPath $full) {
        Remove-Item -LiteralPath $full -Recurse -Force
    }
}

# New junction creation helper; returns $true when the OS accepted the link.
function New-DirectoryJunction([string]$LinkPath, [string]$TargetPath) {
    $null = cmd /d /c mklink /J $LinkPath $TargetPath 2>$null
    return ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $LinkPath))
}

# Synthetic marker used ONLY to prove malformed content is never echoed.
$MalformedMarker = 'DSH-FIXTURE-MALFORMED-MARKER-7F3A9C'

# Fixture exe paths (strings only; the parser never stat's them).
$FixtureExeOne     = 'Z:\artifacts\fixture-one\dsh-desktop.exe'
$FixtureExeTwo     = 'Z:\artifacts\fixture-other\dsh-desktop.exe'
$FixtureExeAlpha   = 'Z:\artifacts\fixture-a\dsh-desktop.exe'

# PS 5.1 contract established empirically on this machine (fixture bytes +
# diag evidence, 5-element split): a '+'-concatenated expression INSIDE a
# multi-element @(...) array literal binds as SEPARATE elements. All fixture
# lines therefore materialise as standalone string variables OUTSIDE any
# array literal; array literals then reference only variables or pure
# single-quoted literals.
# JSON text escaping for one Windows path: each '\' becomes a doubled '\\'
# (replacement is a literal 2-char string, never a 4-char one).
function Convert-ToJsonEscapedPath([string]$Exe) {
    return ($Exe -replace '\\', '\\')
}
$FixtureLibLine     = '{"reason":"compiler-artifact","executable":null,"target":{"name":"some-library","kind":["lib"]}}'
$FixtureDshLine     = '{"reason":"compiler-artifact","executable":"' + (Convert-ToJsonEscapedPath $FixtureExeOne) + '","target":{"name":"dsh-desktop","kind":["bin"]}}'
$FixtureAlphaDsh    = '{"reason":"compiler-artifact","executable":"' + (Convert-ToJsonEscapedPath $FixtureExeAlpha) + '","target":{"name":"dsh-desktop","kind":["bin"]}}'
$FixtureAlphaLib    = '{"reason":"compiler-artifact","executable":"' + (Convert-ToJsonEscapedPath $FixtureExeAlpha) + '","target":{"name":"dsh-desktop","kind":["lib","rlib"]}}'
$FixtureOtherLine   = '{"reason":"compiler-artifact","executable":"' + (Convert-ToJsonEscapedPath $FixtureExeTwo) + '","target":{"name":"other-binary","kind":["bin"]}}'
$FixtureDoneLine    = '{"reason":"build-finished","success":true}'
$FixtureTruncated   = '{"reason":"compiler-artifact","secret-marker":"' + $MalformedMarker + '"'

# ---------------------------------------------------------------------------
# GROUP A — Get-ArtifactExeFromCargoJson
# ---------------------------------------------------------------------------

if ($Groups -ccontains 'A') {
    Write-Host ''
    Write-Host 'Group A: Get-ArtifactExeFromCargoJson' -ForegroundColor Cyan

    if (-not $functionTexts.ContainsKey('Get-ArtifactExeFromCargoJson')) {
        foreach ($c in @('A01','A02','A03','A04','A05','A06','A07','A08','A09','A10',
            'A11','A12','A13','A14','A15')) {
            Add-CaseResult $c 'Get-ArtifactExeFromCargoJson' 'SKIP' 'function is ABSENT from build.ps1 at run time (implementation pending); held for parent ready ping'
        }
    }
    else {
        # A01 — happy path, default Stream == 'cargo' (strict).
        Invoke-Case 'A01' 'default cargo stream is strict and resolves the exe' {
            $dir = New-CaseDir 'A01'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureLibLine, $FixtureDshLine, $FixtureDoneLine)
            $result = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path -Stream cargo
            if ($result -cne $FixtureExeOne) {
                throw ("unexpected exe resolved: {0}" -f $result)
            }
        }

        # A02 — the default parameter value behaves exactly like -Stream cargo.
        Invoke-Case 'A02' 'omitted -Stream equals -Stream cargo' {
            $dir = New-CaseDir 'A02'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureLibLine, $FixtureDshLine, $FixtureDoneLine)
            $defaulted = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path
            $explicit  = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path -Stream cargo
            if ($defaulted -cne $explicit) {
                throw ('default Stream and explicit cargo resolved different exes')
            }
        }

        # A03 — cargo mode is strict: one narration line fails the whole stream
        # and the malformed CONTENT is never echoed.
        Invoke-Case 'A03' 'cargo narration line fails and its content is never echoed' {
            $dir = New-CaseDir 'A03'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureTruncated, $FixtureDoneLine)
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path -Stream cargo } `
                @('malformed cargo JSON', 'never echoed') `
                @($MalformedMarker)
        }

        # A04 — tauri-build mode skips narration that is not JSON-looking.
        Invoke-Case 'A04' 'tauri-build narration lines are skipped' {
            $dir = New-CaseDir 'A04'
            $path = Join-Path $dir 'tauri.json'
            New-FixtureFile $path @(
                '   Compiling dsh-desktop v0.0.0 (start 00:00:01)',
                'warning: unused import (fixture narration { with brace look-alike)',
                $FixtureDshLine,
                $FixtureDoneLine
            )
            $result = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path -Stream tauri-build
            if ($result -cne $FixtureExeOne) {
                throw ("unexpected exe resolved in tauri-build mode: {0}" -f $result)
            }
        }

        # A05 — but a JSON-LOOKING invalid line fails in tauri-build mode too.
        Invoke-Case 'A05' 'tauri-build JSON-looking invalid line fails; content never echoed' {
            $dir = New-CaseDir 'A05'
            $path = Join-Path $dir 'tauri.json'
            New-FixtureFile $path @(
                'total build time 12s (fixture narration)',
                $FixtureTruncated,
                $FixtureDoneLine
            )
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path -Stream tauri-build } `
                @('malformed cargo JSON') `
                @($MalformedMarker)
        }

        # A06 — a stream without any build-finished record must fail closed.
        Invoke-Case 'A06' 'stream without build-finished fails closed' {
            $dir = New-CaseDir 'A06'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureDshLine)
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('no successful build-finished record') `
                @()
        }

        # A07 — an explicit build-finished failure refuses the stream.
        Invoke-Case 'A07' 'build-finished success=false is refused' {
            $dir = New-CaseDir 'A07'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @(
                '{"reason":"build-finished","success":false}',
                '{"reason":"compiler-artifact","executable":"' + ($FixtureExeOne -replace '\\', '\\\\') + '","target":{"name":"dsh-desktop","kind":["bin"]}}'
            )
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('did not report success') `
                @()
        }

        # A08 — success must be a real bool, not a string claiming truth.
        Invoke-Case 'A08' 'build-finished success as JSON string is refused' {
            $dir = New-CaseDir 'A08'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @(
                '{"reason":"build-finished","success":"true"}'
            )
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('did not report success') `
                @()
        }

        # A09 — bin-only: foreign targets and non-bin kinds never resolve.
        Invoke-Case 'A09' 'foreign targets and non-bin kinds are ignored' {
            $dir = New-CaseDir 'A09'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @(
                $FixtureOtherLine,
                $FixtureAlphaLib,
                '{"reason":"compiler-artifact","target":{"name":"dsh-desktop","kind":["cdylib"]}}',
                $FixtureDshLine,
                $FixtureDoneLine
            )
            $result = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path
            if ($result -cne $FixtureExeOne) {
                throw ("bin-only selection returned the wrong exe: {0}" -f $result)
            }
        }

        # A10 — relative executable paths are refused.
        Invoke-Case 'A10' 'relative executable path is refused' {
            $dir = New-CaseDir 'A10'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @(
                '{"reason":"compiler-artifact","executable":"target\\release\\dsh-desktop.exe","target":{"name":"dsh-desktop","kind":["bin"]}}',
                '{"reason":"build-finished","success":true}'
            )
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('must be an absolute path') `
                @()
        }

        # A11 — a bare drive root without a path separator is refused.
        Invoke-Case 'A11' 'drive-only executable path is refused' {
            $dir = New-CaseDir 'A11'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @(
                '{"reason":"compiler-artifact","executable":"C:","target":{"name":"dsh-desktop","kind":["bin"]}}',
                '{"reason":"build-finished","success":true}'
            )
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('must be an absolute path') `
                @()
        }

        # A12 — zero qualifying artifacts fail closed.
        Invoke-Case 'A12' 'stream without any dsh-desktop bin artifact fails' {
            $dir = New-CaseDir 'A12'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureDoneLine, $FixtureOtherLine)
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('no dsh-desktop bin artifact') `
                @()
        }

        # A13 — repeated identical artifacts are a singleton, not ambiguity.
        Invoke-Case 'A13' 'duplicate identical artifacts stay a singleton' {
            $dir = New-CaseDir 'A13'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureDshLine, $FixtureDshLine, $FixtureDshLine, $FixtureDoneLine)
            $result = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path
            if ($result -cne $FixtureExeOne) {
                throw ("singleton duplicate resolution changed the exe: {0}" -f $result)
            }
        }

        # A14 — distinct executables are ambiguous and refuse.
        Invoke-Case 'A14' 'distinct executables fail as ambiguous' {
            $dir = New-CaseDir 'A14'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @($FixtureDshLine, $FixtureAlphaDsh, $FixtureDoneLine)
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('ambiguous', '2 distinct') `
                @()
        }

        # A15 — an entirely empty stream has no build-finished record at all.
        Invoke-Case 'A15' 'empty artifact stream fails closed' {
            $dir = New-CaseDir 'A15'
            $path = Join-Path $dir 'cargo.json'
            New-FixtureFile $path @()
            Assert-CallFails { Get-ArtifactExeFromCargoJson -ArtifactJsonPath $path } `
                @('no successful build-finished record') `
                @()
        }
    }
}

# ---------------------------------------------------------------------------
# GROUP B — Get-ResourceTreePhysicalMetadata / Write-CombinedResourcePhysicalMetadata
# ---------------------------------------------------------------------------

if ($Groups -ccontains 'B') {
    Write-Host ''
    Write-Host 'Group B: resource-tree physical metadata' -ForegroundColor Cyan

    $needsBoth = ($functionTexts.ContainsKey('Get-ResourceTreePhysicalMetadata') -and
        $functionTexts.ContainsKey('Write-CombinedResourcePhysicalMetadata'))
    if (-not $needsBoth) {
        foreach ($c in @('B01','B02','B03','B04','B05','B06','B07','B08')) {
            Add-CaseResult $c 'resource-tree metadata' 'SKIP' 'generator functions ABSENT from build.ps1 at run time (implementation pending); held for parent ready ping'
        }
    }
    else {
        function New-FixTree([string]$Base) {
            New-FixtureDirWithFile $Base 'a.txt' 'fixture file content'
            $null = New-Item -ItemType Directory -Force -Path (Join-Path $Base 'sub')
            Set-Content -LiteralPath (Join-Path $Base 'sub\b.bin') -Value ([byte[]](1, 2, 3)) -Encoding Byte
        }

        function Get-TreeRows([string]$Root) {
            $rows = @()
            foreach ($entry in (Get-ResourceTreePhysicalMetadata $Root)) {
                $rows += ('{0};{1};{2}' -f $entry.path, $entry.kind, $entry.attributes)
            }
            return $rows
        }

        # B01 — canonical paths: '.', 'a.txt', 'sub', 'sub/b.bin'. No './' prefix.
        Invoke-Case 'B01' 'canonical entry paths carry no ./ prefix' {
            $dir = New-CaseDir 'B01\tree'
            New-FixTree $dir
            $entries = Get-ResourceTreePhysicalMetadata $dir
            $paths = @($entries | ForEach-Object { $_.path })
            $expected = @('.', 'a.txt', 'sub', 'sub/b.bin')
            foreach ($want in $expected) {
                if ($paths -cnotcontains $want) {
                    throw ("physical metadata is missing the canonical entry '{0}' (had: {1})" -f $want, ($paths -join ', '))
                }
            }
            if ($paths.Count -ne $expected.Count) {
                throw ("unexpected extra entries: {0}" -f ($paths -join ', '))
            }
            foreach ($p in $paths) {
                if ($p.StartsWith('./') -or $p.StartsWith('.\')) {
                    throw ("entry path carries the './' prefix: {0}" -f $p)
                }
                if ($p -ne ($p -replace '\\', '/')) {
                    throw ("entry path is not canonicalised to forward slashes: {0}" -f $p)
                }
            }
            foreach ($entry in $entries) {
                if ([string]::IsNullOrWhiteSpace($entry.attributes)) {
                    throw ("entry '{0}' has an empty attribute string" -f $entry.path)
                }
            }
        }

        # B02 — original root vs root WITH a trailing backslash are identical.
        Invoke-Case 'B02' 'root with trailing backslash yields identical metadata' {
            $dir = New-CaseDir 'B02\tree'
            New-FixTree $dir
            $plain = Get-TreeRows $dir
            $trailing = Get-TreeRows ($dir + '\')
            if ($plain.Count -ne $trailing.Count) {
                throw ('plain-root and trailing-backslash-root produced different row counts')
            }
            for ($i = 0; $i -lt $plain.Count; $i++) {
                if ($plain[$i] -cne $trailing[$i]) {
                    throw ("row {0} differs between plain root and trailing-backslash root: {1} vs {2}" -f $i, $plain[$i], $trailing[$i])
                }
            }
        }

        # B03 — the root itself must be a directory.
        Invoke-Case 'B03' 'root file is refused' {
            $dir = New-CaseDir 'B03'
            $fileRoot = Join-Path $dir 'not-a-dir.txt'
            New-FixtureFile $fileRoot @('fixture')
            Assert-CallFails { Get-ResourceTreePhysicalMetadata $fileRoot } `
                @('root must be a directory') `
                @()
        }

        # B04 — a child junction (ReparsePoint) is refused BEFORE any descent.
        Invoke-Case 'B04' 'child junction is refused before descent' {
            $dir = New-CaseDir 'B04\tree'
            $ownedTarget = Join-Path $dir 'owned-link-target'
            New-FixtureDirWithFile $ownedTarget 'inside-junction-marker.txt' 'fixture marker'
            $junction = Join-Path $dir 'junction'
            if (-not (New-DirectoryJunction $junction $ownedTarget)) {
                throw 'fixture junction creation was refused by the OS; case cannot run here'
            }
            try {
                Assert-CallFails { Get-ResourceTreePhysicalMetadata $dir } `
                    @('ReparsePoint', 'nothing was qualified') `
                    @('inside-junction-marker')
            }
            finally {
                Remove-ReparsePoint $junction
            }
        }

        # B05 — the ROOT itself being a junction is refused before any descent.
        Invoke-Case 'B05' 'root junction is refused before descent' {
            $dir = New-CaseDir 'B05'
            $ownedTarget = Join-Path $dir 'owned-root-target'
            New-FixtureDirWithFile $ownedTarget 'inside-root-junction-marker.txt' 'fixture marker'
            $rootJunction = Join-Path $dir 'root-junction'
            if (-not (New-DirectoryJunction $rootJunction $ownedTarget)) {
                throw 'fixture junction creation was refused by the OS; case cannot run here'
            }
            try {
                Assert-CallFails { Get-ResourceTreePhysicalMetadata $rootJunction } `
                    @("resource tree root", 'ReparsePoint', 'nothing was qualified') `
                    @('inside-root-junction-marker')
            }
            finally {
                Remove-ReparsePoint $rootJunction
            }
        }

        # B06 — combined manifest: schemaVersion 1, canonical roots, per-tree rows.
        Invoke-Case 'B06' 'combined manifest shape and canonical roots' {
            $dir = New-CaseDir 'B06'
            $sourceDsh = Join-Path $dir 'source-dsh'
            $sourceUi  = Join-Path $dir 'source-ui'
            $mirrorDsh = Join-Path $dir 'mirror-dsh'
            $mirrorUi  = Join-Path $dir 'mirror-ui'
            foreach ($tree in @($sourceDsh, $sourceUi, $mirrorDsh, $mirrorUi)) {
                New-FixTree $tree
            }
            $manifestPath = Join-Path $dir 'physical-metadata.json'
            Write-CombinedResourcePhysicalMetadata $sourceDsh $sourceUi $mirrorDsh $mirrorUi $manifestPath
            $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
            if ($manifest.schemaVersion -ne 1) {
                throw ('combined manifest schemaVersion is not 1')
            }
            $inputs = @{ sourceDsh = $sourceDsh; sourceUi = $sourceUi; mirrorDsh = $mirrorDsh; mirrorUi = $mirrorUi }
            foreach ($section in @('sourceDsh', 'sourceUi', 'mirrorDsh', 'mirrorUi')) {
                $sectionData = $manifest.$section
                if ([string]::IsNullOrWhiteSpace($sectionData.root)) {
                    throw ("section {0} has an empty root" -f $section)
                }
                if ($sectionData.root -cne [System.IO.Path]::GetFullPath($inputs[$section])) {
                    throw ("section {0} root is not the canonicalised input: {1} vs {2}" -f $section, $sectionData.root, [System.IO.Path]::GetFullPath($inputs[$section]))
                }
                if ($sectionData.root -ne $sectionData.root.TrimEnd('\', '/')) {
                    throw ("section {0} root is not canonical (trailing separator present): {1}" -f $section, $sectionData.root)
                }
                $rows = @($sectionData.entries | ForEach-Object { $_.path })
                if ($rows -cnotcontains '.') {
                    throw ("section {0} rows lost the root '.' entry" -f $section)
                }
                if (@($rows | Where-Object { $_.StartsWith('./') }).Count -gt 0) {
                    throw ("section {0} rows carry './' prefixes" -f $section)
                }
                $direct = @(Get-ResourceTreePhysicalMetadata $inputs[$section] | ForEach-Object { $_.path })
                if ($direct.Count -ne $rows.Count) {
                    throw ("section {0} row count differs from a direct tree read: {1} vs {2}" -f $section, $rows.Count, $direct.Count)
                }
                foreach ($row in $direct) {
                    if ($rows -cnotcontains $row) {
                        throw ("section {0} rows lost direct-read entry '{1}'" -f $section, $row)
                    }
                }
            }
        }

        # B07 — trailing-backslash inputs canonicalise to the SAME manifest roots.
        Invoke-Case 'B07' 'combined manifest canonicalises trailing-backslash inputs' {
            $dir = New-CaseDir 'B07'
            $sourceDsh = Join-Path $dir 'source-dsh'
            $sourceUi  = Join-Path $dir 'source-ui'
            $mirrorDsh = Join-Path $dir 'mirror-dsh'
            $mirrorUi  = Join-Path $dir 'mirror-ui'
            foreach ($tree in @($sourceDsh, $sourceUi, $mirrorDsh, $mirrorUi)) {
                New-FixTree $tree
            }
            $manifestPathPlain = Join-Path $dir 'plain.json'
            $manifestPathTrail = Join-Path $dir 'trailing.json'
            Write-CombinedResourcePhysicalMetadata $sourceDsh $sourceUi $mirrorDsh $mirrorUi $manifestPathPlain
            Write-CombinedResourcePhysicalMetadata ($sourceDsh + '\') ($sourceUi + '\') ($mirrorDsh + '\') ($mirrorUi + '\') $manifestPathTrail
            $plain = Get-Content -LiteralPath $manifestPathPlain -Raw | ConvertFrom-Json
            $trail = Get-Content -LiteralPath $manifestPathTrail -Raw | ConvertFrom-Json
            foreach ($section in @('sourceDsh', 'sourceUi', 'mirrorDsh', 'mirrorUi')) {
                if ($plain.$section.root -cne $trail.$section.root) {
                    throw ("section {0} root differs between plain and trailing-backslash inputs: {1} vs {2}" -f $section, $plain.$section.root, $trail.$section.root)
                }
            }
        }

        # B08 - an EMPTY tree yields exactly the root '.' entry, and in the
        # combined manifest that single entry must SERIALISE as a JSON array
        # element (caller-side @() wrap), never as a flattened bare object.
        Invoke-Case 'B08' "empty root keeps the single '.' entry as a JSON array" {
            $dir = New-CaseDir 'B08'
            $emptyDsh  = Join-Path $dir 'empty-dsh'
            $sourceUi  = Join-Path $dir 'source-ui'
            $mirrorDsh = Join-Path $dir 'mirror-dsh'
            $mirrorUi  = Join-Path $dir 'mirror-ui'
            foreach ($tree in @($emptyDsh, $sourceUi, $mirrorDsh, $mirrorUi)) {
                $null = New-Item -ItemType Directory -Force -Path $tree
            }
            New-FixTree $sourceUi
            New-FixTree $mirrorDsh
            New-FixTree $mirrorUi
            # Direct read: exactly one entry, the canonical '.'.
            $entries = @(Get-ResourceTreePhysicalMetadata $emptyDsh)
            if ($entries.Count -ne 1) {
                throw ("empty root produced {0} entries; expected exactly 1" -f $entries.Count)
            }
            if ($entries[0].path -cne '.') {
                throw ("empty root entry path is not '.': {0}" -f $entries[0].path)
            }
            # Raw-text proof, independent of Windows PowerShell 5.1's notorious
            # ConvertFrom-Json single-element-array read-back quirk: each of the
            # four sections must serialise "entries" as a JSON array.
            $manifestPath = Join-Path $dir 'empty-manifest.json'
            Write-CombinedResourcePhysicalMetadata $emptyDsh $sourceUi $mirrorDsh $mirrorUi $manifestPath
            $raw = Get-Content -LiteralPath $manifestPath -Raw
            $sectionCount = ([regex]::Matches($raw, '"entries"\s*:\s*\[')).Count
            if ($sectionCount -ne 4) {
                throw ("expected 4 JSON-array entries sections in the raw manifest; found {0}" -f $sectionCount)
            }
        }
    }
}

# ---------------------------------------------------------------------------
# GROUP C — Assert-BundleGuardConfiguration
# ---------------------------------------------------------------------------

if ($Groups -ccontains 'C') {
    # Match build.ps1: optional config properties must also work in strict mode.
    Set-StrictMode -Version Latest
    Write-Host ''
    Write-Host 'Group C: Assert-BundleGuardConfiguration' -ForegroundColor Cyan

    if (-not $functionTexts.ContainsKey('Assert-BundleGuardConfiguration')) {
        foreach ($c in @('C01','C02','C03','C04','C05','C06','C06b','C07','C08','C09')) {
            Add-CaseResult $c 'Assert-BundleGuardConfiguration' 'SKIP' 'function is ABSENT from build.ps1 at run time (implementation pending); held for parent ready ping'
        }
    }
    else {
        function New-TauriConfFixture([string]$CaseDir, [string[]]$JsonLines) {
            New-FixtureFile (Join-Path $CaseDir 'tauri.conf.json') $JsonLines
        }

        # The function under test reads $env:TAURI_CONFIG. This suite mutates
        # ONLY its own process environment and restores the previous value
        # (or restores absence) in finally.
        $previousTauriConfigPresent = ($null -ne (Get-Item -LiteralPath 'Env:TAURI_CONFIG' -ErrorAction SilentlyContinue))
        $previousTauriConfigValue = $env:TAURI_CONFIG
        try {
            function Restore-TauriConfig {
                if ($previousTauriConfigPresent) { $env:TAURI_CONFIG = $previousTauriConfigValue }
                else { Remove-Item -LiteralPath 'Env:TAURI_CONFIG' -ErrorAction SilentlyContinue }
            }

            # C01 — a non-empty TAURI_CONFIG overlay is refused.
            Invoke-Case 'C01' 'TAURI_CONFIG non-empty override is refused' {
                $dir = New-CaseDir 'C01'
                New-TauriConfFixture $dir @('{ "build": {} }')
                try {
                    $env:TAURI_CONFIG = 'fixture-nonempty-synthetic-overlay'
                    Assert-CallFails { Assert-BundleGuardConfiguration -ConfigRoot $dir } `
                        @('TAURI_CONFIG', 'clear the override') `
                        @()
                }
                finally {
                    Restore-TauriConfig
                }
            }

            # C02 — unset / empty / whitespace TAURI_CONFIG are all allowed.
            Invoke-Case 'C02' 'TAURI_CONFIG unset, empty and whitespace are allowed' {
                $dir = New-CaseDir 'C02'
                New-TauriConfFixture $dir @('{ "build": {} }')
                $savedPresent = ($null -ne (Get-Item -LiteralPath 'Env:TAURI_CONFIG' -ErrorAction SilentlyContinue))
                $savedValue = $env:TAURI_CONFIG
                try {
                    Remove-Item -LiteralPath 'Env:TAURI_CONFIG' -ErrorAction SilentlyContinue
                    Assert-NoThrow { Assert-BundleGuardConfiguration -ConfigRoot $dir } 'unset TAURI_CONFIG'
                    $env:TAURI_CONFIG = ''
                    Assert-NoThrow { Assert-BundleGuardConfiguration -ConfigRoot $dir } 'empty TAURI_CONFIG'
                    $env:TAURI_CONFIG = '   '
                    Assert-NoThrow { Assert-BundleGuardConfiguration -ConfigRoot $dir } 'whitespace-only TAURI_CONFIG'
                }
                finally {
                    if ($savedPresent) { $env:TAURI_CONFIG = $savedValue }
                    else { Remove-Item -LiteralPath 'Env:TAURI_CONFIG' -ErrorAction SilentlyContinue }
                }
            }

            # C03..C05 — platform overlays are refused (each name).
            foreach ($overlayCase in @(
                @{ Id = 'C03'; File = 'tauri.windows.conf.json' },
                @{ Id = 'C04'; File = 'tauri.windows.conf.json5' },
                @{ Id = 'C05'; File = 'Tauri.windows.toml' }
            )) {
                Invoke-Case $overlayCase.Id ("platform overlay {0} is refused" -f $overlayCase.File) {
                    $dir = New-CaseDir $overlayCase.Id
                    New-TauriConfFixture $dir @('{ "build": {} }')
                    New-FixtureFile (Join-Path $dir $overlayCase.File) @('# fixture overlay marker')
                    Assert-CallFails { Assert-BundleGuardConfiguration -ConfigRoot $dir } `
                        @('platform configuration overlays are unsupported') `
                        @()
                }
            }

            # C06 — beforeBundleCommand absent/null/empty/whitespace are allowed.
            Invoke-Case 'C06' 'beforeBundleCommand absent, null, empty and whitespace are allowed' {
                foreach ($variant in @(
                    @{ Name = 'absent'; Json = '{ "build": {} }' },
                    @{ Name = 'null'; Json = '{ "build": { "beforeBundleCommand": null } }' },
                    @{ Name = 'empty-string'; Json = '{ "build": { "beforeBundleCommand": "" } }' },
                    @{ Name = 'whitespace-string'; Json = '{ "build": { "beforeBundleCommand": "   " } }' }
                )) {
                    $dir = New-CaseDir ("C06-" + $variant.Name)
                    New-FixtureFile (Join-Path $dir 'tauri.conf.json') @($variant.Json)
                    Assert-NoThrow { Assert-BundleGuardConfiguration -ConfigRoot $dir } ("beforeBundleCommand " + $variant.Name)
                }
            }

            # Also: a config WITH no build section at all stays allowed.
            Invoke-Case 'C06b' 'tauri.conf.json without a build section is allowed' {
                $dir = New-CaseDir 'C06b'
                New-FixtureFile (Join-Path $dir 'tauri.conf.json') @('{ "productName": "fixture" }')
                Assert-NoThrow { Assert-BundleGuardConfiguration -ConfigRoot $dir } 'conf without build section'
            }

            # C07 — a non-empty hook command is refused.
            Invoke-Case 'C07' 'non-empty beforeBundleCommand is refused' {
                $dir = New-CaseDir 'C07'
                New-TauriConfFixture $dir @('{ "build": { "beforeBundleCommand": "powershell.exe -File hook.ps1" } }')
                Assert-CallFails { Assert-BundleGuardConfiguration -ConfigRoot $dir } `
                    @('beforeBundleCommand is configured', 'post-qualification hook') `
                    @()
            }

            # C08 — hook objects of ANY shape are refused (even an empty object).
            Invoke-Case 'C08' 'beforeBundleCommand objects of any shape are refused' {
                foreach ($variant in @(
                    @{ Name = 'populated-object'; Json = '{ "build": { "beforeBundleCommand": { "run": "hook.ps1" } } }' },
                    @{ Name = 'empty-object'; Json = '{ "build": { "beforeBundleCommand": {} } }' },
                    @{ Name = 'array'; Json = '{ "build": { "beforeBundleCommand": [] } }' }
                )) {
                    $dir = New-CaseDir ("C08-" + $variant.Name)
                    New-FixtureFile (Join-Path $dir 'tauri.conf.json') @($variant.Json)
                    Assert-CallFails { Assert-BundleGuardConfiguration -ConfigRoot $dir } `
                        @('beforeBundleCommand is configured') `
                        @()
                }
            }

            # C09 — a malformed tauri.conf.json must fail loudly, not pass.
            Invoke-Case 'C09' 'malformed tauri.conf.json fails loudly' {
                $dir = New-CaseDir 'C09'
                New-FixtureFile (Join-Path $dir 'tauri.conf.json') @(('{ "build": { -not-valid-json ' + $MalformedMarker))
                Assert-CallFails { Assert-BundleGuardConfiguration -ConfigRoot $dir } `
                    @() `
                    @()
            }
        }
        finally {
            if ($previousTauriConfigPresent) { $env:TAURI_CONFIG = $previousTauriConfigValue }
            else { Remove-Item -LiteralPath 'Env:TAURI_CONFIG' -ErrorAction SilentlyContinue }
        }
    }
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ''
$passed = @($script:CaseResults | Where-Object { $_.Outcome -eq 'PASS' }).Count
$failed = @($script:CaseResults | Where-Object { $_.Outcome -eq 'FAIL' }).Count
$skipped = @($script:CaseResults | Where-Object { $_.Outcome -eq 'SKIP' }).Count
$total = $script:CaseResults.Count
$elapsed = [math]::Round(((Get-Date) - $suiteStartedAt).TotalSeconds, 1)
Write-Host ("suite summary: {0} cases total - {1} passed, {2} failed, {3} skipped ({4}s)" -f
    $total, $passed, $failed, $skipped, $elapsed) -ForegroundColor Cyan

if ($failed -gt 0) {
    Write-Host 'failing cases:' -ForegroundColor Red
    foreach ($result in ($script:CaseResults | Where-Object { $_.Outcome -eq 'FAIL' })) {
        Write-Host ("  {0} {1} :: {2}" -f $result.Id, $result.Name, $result.Detail) -ForegroundColor Red
    }
}

# ---------------------------------------------------------------------------
# Fixture exit (owned, contained)
# ---------------------------------------------------------------------------

if (-not $KeepFixtures) {
    foreach ($reparse in @(
        (Join-Path $script:FixtureRoot 'B04\tree\junction'),
        (Join-Path $script:FixtureRoot 'B05\root-junction'))) {
        if (Test-Path -LiteralPath $reparse) {
            Remove-ReparsePoint $reparse
        }
    }
    Remove-OwnedFixtureTree
} else {
    Write-Host ("fixtures kept at {0}" -f $script:FixtureRoot) -ForegroundColor DarkYellow
}

if ($failed -gt 0 -or $skipped -gt 0 -or $total -eq 0) { exit 1 }
exit 0
