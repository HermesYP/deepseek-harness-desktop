#requires -Version 5.1
<#
  Pure unit tests for native-credential-cleanup.psm1.

  NOTHING here touches the OS credential store, the registry, the process table,
  the network or the filesystem: every probe (manifest reader, index reader, path
  probe, process probe, delete backend, host probe, sleep) is injected. The C#
  CredDeleteW bridge is never compiled or bound; that fact is asserted at the end.

  Run:  powershell.exe -NoProfile -ExecutionPolicy Bypass -File native-credential-cleanup.tests.ps1
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Import-Module (Join-Path $PSScriptRoot 'native-credential-cleanup.psm1') -Force -ErrorAction Stop

$script:Total = 0
$script:Passed = 0
$script:Failed = New-Object System.Collections.ArrayList

function It {
  param([string]$Name, [scriptblock]$Body)
  $script:Total++
  try {
    & $Body
    $script:Passed++
    Write-Host ('ok   {0}' -f $Name)
  } catch {
    $script:Failed.Add(('{0} :: {1}' -f $Name, $_.Exception.Message)) | Out-Null
    Write-Host ('FAIL {0} :: {1}' -f $Name, $_.Exception.Message)
  }
}

function Assert-True { param($Value, [string]$Why = 'expected true') if (-not $Value) { throw "$Why (got: $Value)" } }
function Assert-False { param($Value, [string]$Why = 'expected false') if ($Value) { throw "$Why (got: $Value)" } }
function Assert-Eq { param($Expected, $Actual, [string]$Why = '') if ($Expected -ne $Actual) { throw "$Why expected=[$Expected] actual=[$Actual]" } }
function Assert-Ceq { param($Expected, $Actual, [string]$Why = '') if ($Expected -cne $Actual) { throw "$Why expected=[$Expected] actual=[$Actual]" } }
function Assert-Match { param([string]$Text, [string]$Pattern, [string]$Why = '') if ($Text -notmatch $Pattern) { throw "$Why pattern=[$Pattern]" } }
function Assert-NotMatch { param([string]$Text, [string]$Pattern, [string]$Why = '') if ($Text -match $Pattern) { throw "$Why pattern=[$Pattern] matched" } }

# ---------------------------------------------------------------------------
# Fixtures (all in memory)
# ---------------------------------------------------------------------------

$script:Repo = 'C:\dsh-fixture'
$script:Ns = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
$script:Root = 'C:\dsh-fixture\.scratch\native-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0'
$script:IndexPath = 'C:\dsh-fixture\.scratch\native-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\home\userdata\credentials-index.json'
$script:ImageHash = ('a' * 64)
$script:Nonce = 'deadbeefdeadbeefdeadbeefdeadbeef'
$script:ProcId = 987654

function New-Fx {
  $script:Fx = @{
    ManifestText       = $null
    ManifestThrows     = $false
    IndexText          = $null
    IndexThrows        = $false
    RootMissing        = $false
    RootReparse        = $false
    RootFullOverride   = $null
    ReparseOnRootCall  = 0
    ReparseAbove       = @()
    IndexReparse       = $false
    RootCalls          = 0
    ProcessAliveCalls  = 0
    AliveUntilCall     = 0
    DeleteCode         = 0
    DeleteThrows       = $false
    DeleteGarbage      = $false
    DeleteCalls        = New-Object System.Collections.ArrayList
    HostOk             = $true
    SleepCalls         = 0
  }
}

function New-IndexText {
  param([bool]$IncludePair = $true, [int]$Schema = 1, [string]$RowsJson = $null)
  $rows = New-Object System.Collections.ArrayList
  if ($IncludePair) {
    $rows.Add('"client-connection\u0000browser-session":{"provider":"client-connection","reference":"browser-session","hasSecret":true,"updatedAt":"2026-10-10T07:00:00+00:00"}') | Out-Null
  }
  $rows.Add('"openai\u0000default":{"provider":"openai","reference":"default","hasSecret":false,"updatedAt":"2026-10-10T07:00:00+00:00"}') | Out-Null
  if (-not [string]::IsNullOrEmpty($RowsJson)) { $rows.Add($RowsJson) | Out-Null }
  return ('{"schemaVersion":' + $Schema + ',"entries":{' + ($rows -join ',') + '}}')
}

function New-ManifestText {
  param(
    [string]$Namespace = $script:Ns,
    [string]$OwnedRoot = $script:Root,
    [string]$IndexPath = $script:IndexPath,
    $Processes = $null,
    $Nonce = $script:Nonce,
    [string]$Record = 'dsh-owned-credential-cleanup-manifest',
    [int]$SchemaVersion = 1,
    $Approved = $null,
    $Identities = $null,
    [hashtable]$Extra = @{}
  )
  if ($null -eq $Processes) {
    $Processes = @(@{ pid = $script:ProcId; role = 'desktop'; imageSha256 = $script:ImageHash })
  }
  if ($null -eq $Approved) { $Approved = @($script:ImageHash) }
  if ($null -eq $Identities) {
    $Identities = @(@{ provider = 'client-connection'; reference = 'browser-session' })
  }
  $manifest = [ordered]@{
    schemaVersion       = $SchemaVersion
    record              = $Record
    namespace           = $Namespace
    ownedRoot           = $OwnedRoot
    indexPath           = $IndexPath
    approvedImageSha256 = $Approved
    processes           = $Processes
    expectedIdentities  = $Identities
  }
  if ($null -ne $Nonce -and -not [string]::IsNullOrEmpty([string]$Nonce)) { $manifest['nonce'] = [string]$Nonce }
  $manifest['createdAtUtc'] = '2026-10-10T07:00:00Z'
  foreach ($key in $Extra.Keys) { $manifest[$key] = $Extra[$key] }
  return (ConvertTo-Json -InputObject $manifest -Depth 8 -Compress)
}

function Get-FxManifestText { param([string]$Path) if ($script:Fx.ManifestThrows) { throw 'manifest read failed' }; return $script:Fx.ManifestText }
function Get-FxIndexText { param([string]$Path) if ($script:Fx.IndexThrows) { throw 'index read failed' }; return $script:Fx.IndexText }

function Get-FxPathFacts {
  param([string]$Path, [string]$StopAt)
  $full = $Path
  if ($Path -ieq $script:Root) {
    $script:Fx.RootCalls++
    if ($script:Fx.ReparseOnRootCall -gt 0 -and $script:Fx.RootCalls -ge $script:Fx.ReparseOnRootCall) {
      return @{ Full = $script:Root; Exists = $true; IsDirectory = $true; ReparseAtOrBelow = @($script:Root); ReparseAbove = @(); Error = $null }
    }
    if ($script:Fx.RootMissing) {
      return @{ Full = $script:Root; Exists = $false; IsDirectory = $false; ReparseAtOrBelow = @(); ReparseAbove = @(); Error = 'not_found' }
    }
    $reparse = @()
    if ($script:Fx.RootReparse) { $reparse = @($script:Root) }
    $resolved = $script:Root
    if (-not [string]::IsNullOrEmpty([string]$script:Fx.RootFullOverride)) { $resolved = [string]$script:Fx.RootFullOverride }
    return @{ Full = $resolved; Exists = $true; IsDirectory = $true; ReparseAtOrBelow = $reparse; ReparseAbove = @($script:Fx.ReparseAbove); Error = $null }
  }
  $indexReparse = @()
  if ($script:Fx.IndexReparse) { $indexReparse = @($Path) }
  return @{ Full = $full; Exists = $true; IsDirectory = $false; ReparseAtOrBelow = $indexReparse; ReparseAbove = @(); Error = $null }
}

function Get-FxProcessFacts {
  param([int]$ProcessId)
  $script:Fx.ProcessAliveCalls++
  return @{ Alive = ($script:Fx.ProcessAliveCalls -le $script:Fx.AliveUntilCall); Error = $null }
}

function Invoke-FxDelete {
  param([string]$TargetName)
  $script:Fx.DeleteCalls.Add($TargetName) | Out-Null
  if ($script:Fx.DeleteThrows) { throw 'backend failure' }
  if ($script:Fx.DeleteGarbage) { return 'not-a-number' }
  return $script:Fx.DeleteCode
}

function Invoke-Fx {
  param(
    [hashtable]$Override = @{},
    [switch]$PlanOnly,
    [switch]$AllowOsDelete,
    [string]$Namespace,
    [string]$ExpectedNonce,
    [switch]$RequireNonce
  )
  $effectiveNamespace = $script:Ns
  if (-not [string]::IsNullOrEmpty($Namespace)) { $effectiveNamespace = $Namespace }
  $parameters = @{
    RepositoryRoot     = $script:Repo
    Namespace          = $effectiveNamespace
    ManifestPath       = 'C:\dsh-fixture\manifest.json'
    ManifestReader     = { param([string]$p) Get-FxManifestText -Path $p }
    IndexReader        = { param([string]$p) Get-FxIndexText -Path $p }
    PathProbe          = { param([string]$p, [string]$s) Get-FxPathFacts -Path $p -StopAt $s }
    ProcessProbe       = { param([int]$id) Get-FxProcessFacts -ProcessId $id }
    DeleteBackend      = { param([string]$t) Invoke-FxDelete -TargetName $t }
    HostProbe          = { return [bool]$script:Fx.HostOk }
    Sleep              = { param([int]$ms) $script:Fx.SleepCalls++ }
    SettlementAttempts = 3
    SettlementWaitMs   = 0
  }
  if ($PlanOnly) { $parameters['PlanOnly'] = $true }
  if ($AllowOsDelete) { $parameters['AllowOsDelete'] = $true }
  if (-not [string]::IsNullOrEmpty($ExpectedNonce)) { $parameters['ExpectedNonce'] = $ExpectedNonce }
  if ($RequireNonce) { $parameters['RequireNonce'] = $true }
  foreach ($key in $Override.Keys) { $parameters[$key] = $Override[$key] }
  return (Invoke-DshOwnedCredentialCleanup @parameters)
}

function Initialize-GoodFixture {
  New-Fx
  $script:Fx.ManifestText = New-ManifestText
  $script:Fx.IndexText = New-IndexText
}

function Read-Manifest {
  param([string]$Text, [string]$Nonce, [bool]$RequireNonce = $false, [bool]$AllowNoProcesses = $false)
  return (Read-DshCleanupManifest -RawJson $Text -Namespace $script:Ns -OwnedRoot $script:Root -IndexPath $script:IndexPath -ExpectedNonce $Nonce -RequireNonce $RequireNonce -AllowNoRecordedProcesses $AllowNoProcesses)
}

# ---------------------------------------------------------------------------
# A. pure argument, path, identity and code guards
# ---------------------------------------------------------------------------

It 'A1 namespace guard accepts canonical lowercase non-nil UUIDs only' {
  Assert-True (Test-DshCanonicalNonNilUuid $script:Ns)
  Assert-True (Test-DshCanonicalNonNilUuid '573300d2-0000-4000-8000-000000000001')
  foreach ($bad in @(
      '', 'native', 'qual-1',
      '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0',
      '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
      '{0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0}',
      '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 ',
      '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f',
      '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0g',
      '0f1e2d3c-4b5a-6978-8796-agb4c3d2e1f0',
      '00000000-0000-0000-0000-000000000000'
    )) {
    Assert-False (Test-DshCanonicalNonNilUuid $bad) "must reject [$bad]"
  }
}

It 'A2 strict containment is component-wise, not a string prefix' {
  Assert-True (Test-DshStrictlyBeneath 'C:\r\.scratch' 'C:\r\.scratch\native-x')
  Assert-True (Test-DshStrictlyBeneath 'C:\r\.scratch' 'c:\R\.SCRATCH\native-x\home')
  Assert-False (Test-DshStrictlyBeneath 'C:\r\.scratch' 'C:\r\.scratch')
  Assert-False (Test-DshStrictlyBeneath 'C:\r\.scratch' 'C:\r\.scratchX')
  Assert-False (Test-DshStrictlyBeneath 'C:\r\.scratch\native-x' 'C:\r\.scratch')
  Assert-False (Test-DshStrictlyBeneath 'C:\r\.scratch' 'D:\r\.scratch\native-x')
  Assert-False (Test-DshStrictlyBeneath 'C:\r\.scratch' '')
  Assert-True (Test-DshStrictlyBeneath 'C:\r\.scratch' 'C:\r\.scratch\native-x\..\native-y')
}

It 'A3 the expected owned root and canonical index path match the dev-e2e layout' {
  Assert-Eq $script:Root (Get-DshCanonicalOwnedRoot -RepositoryRoot $script:Repo -Namespace $script:Ns)
  Assert-Eq 'C:\dsh-fixture\.scratch' (Get-DshScratchRoot -RepositoryRoot $script:Repo)
  Assert-Eq $script:IndexPath (Get-DshCanonicalIndexPath -OwnedRoot $script:Root)
  Assert-True (Test-DshStrictlyBeneath (Get-DshScratchRoot -RepositoryRoot $script:Repo) $script:Root)
  Assert-True (Test-DshStrictlyBeneath $script:Root $script:IndexPath)
  Assert-Eq 'credentials-index.json' ([System.IO.Path]::GetFileName($script:IndexPath))
  $threw = $false
  try { Get-DshCanonicalOwnedRoot -RepositoryRoot $script:Repo -Namespace 'not-a-uuid' | Out-Null } catch { $threw = $true }
  Assert-True $threw 'a bad namespace must not yield a root'
}

It 'A4 the target name is exactly keyring 3.6.3 account.service' {
  $expected = 'browser-session.dsh-desktop:' + $script:Ns + ':client-connection'
  $actual = Resolve-DshCredentialTargetName -Namespace $script:Ns -Provider 'client-connection' -Reference 'browser-session'
  Assert-Ceq $expected $actual
  Assert-Match $actual '^browser-session\.dsh-desktop:'
  Assert-Match $actual ':client-connection$'
  Assert-True ((($actual -split ':').Count) -eq 3) 'the scoped service carries exactly two namespace boundaries'
}

It 'A5 non-whitelisted and invalid identities are refused by the resolver' {
  foreach ($pair in @(
      @{ p = 'openai'; r = 'browser-session' },
      @{ p = 'client-connection'; r = 'other' },
      @{ p = 'Client-Connection'; r = 'browser-session' },
      @{ p = 'client-connection'; r = 'Browser-Session' }
    )) {
    $threw = $false
    try { Resolve-DshCredentialTargetName -Namespace $script:Ns -Provider $pair.p -Reference $pair.r | Out-Null } catch { $threw = $true }
    Assert-True $threw "must refuse [$($pair.p)/$($pair.r)]"
  }
  foreach ($pair in @(
      @{ p = ''; r = 'browser-session' },
      @{ p = 'client:connection'; r = 'browser-session' },
      @{ p = 'client-connection'; r = 'browser\session' },
      @{ p = 'client-connection'; r = "browser`nsession" },
      @{ p = ('x' * 129); r = 'browser-session' }
    )) {
    $threw = $false
    try { Resolve-DshCredentialTargetName -Namespace $script:Ns -Provider $pair.p -Reference $pair.r -AllowAnyValidatedPair | Out-Null } catch { $threw = $true }
    Assert-True $threw 'an invalid segment must be refused'
  }
}

It 'A6 segment validation mirrors validate_segment' {
  Assert-True (Test-DshSegment 'client-connection')
  Assert-True (Test-DshSegment 'with space')
  Assert-False (Test-DshSegment '')
  Assert-False (Test-DshSegment 'a:b')
  Assert-False (Test-DshSegment 'a\b')
  Assert-False (Test-DshSegment "a`0b")
  Assert-False (Test-DshSegment ('x' * 129))
  Assert-True (Test-DshSegment ('x' * 128))
}

It 'A7 the identity digest is FNV-1a 32-bit (standard vectors)' {
  Assert-Ceq '811c9dc5' (Get-DshIdentityDigest8 '')
  Assert-Ceq 'e40c292c' (Get-DshIdentityDigest8 'a')
  Assert-Ceq 'bf9cf968' (Get-DshIdentityDigest8 'foobar')
  Assert-Match (Get-DshIdentityDigest8 'browser-session.dsh-desktop:x:client-connection') '^[0-9a-f]{8}$'
}

It 'A8 Win32 codes classify with 1168 as already absent' {
  Assert-Ceq 'deleted' (Get-DshWinErrorClass 0)
  Assert-Ceq 'already_absent' (Get-DshWinErrorClass 1168)
  Assert-Ceq 'failed' (Get-DshWinErrorClass 5)
  Assert-Ceq 'failed' (Get-DshWinErrorClass -1)
}

It 'A9 the derived owned root uses the REPO root, never the port subdirectory' {
  # Regression: a launcher that tested a repo/.scratch-owned root against
  # port/.scratch. The derivation must use the repository root that contains
  # both `port\` and `.scratch\`, exactly as dev-e2e.ps1:108-109 does.
  $repoScratch = Get-DshScratchRoot -RepositoryRoot $script:Repo
  Assert-Ceq 'C:\dsh-fixture\.scratch' $repoScratch
  $portRoot = Join-Path $script:Repo 'port'
  $portScratch = Get-DshScratchRoot -RepositoryRoot $portRoot
  Assert-Ceq 'C:\dsh-fixture\port\.scratch' $portScratch
  $portOwned = Get-DshCanonicalOwnedRoot -RepositoryRoot $portRoot -Namespace $script:Ns
  Assert-Ceq ('C:\dsh-fixture\port\.scratch\native-' + $script:Ns) $portOwned
  Assert-False (Test-DshStrictlyBeneath $repoScratch $portOwned) 'a port-derived root is not beneath the repo scratch root'
  Assert-True (Test-DshStrictlyBeneath $portScratch $portOwned)
  # A manifest built on the port-derived root can never satisfy the repo-derived run.
  $mismatched = Read-Manifest -Text (New-ManifestText -OwnedRoot $portOwned -IndexPath (Get-DshCanonicalIndexPath -OwnedRoot $portOwned)) -Nonce $null
  Assert-Eq 'manifest_root_mismatch' $mismatched.RefusalCode
}

# ---------------------------------------------------------------------------
# B. index schema
# ---------------------------------------------------------------------------

It 'B1 a valid index with the reserved pair validates and tracks it' {
  $index = ConvertFrom-DshOwnedCredentialIndexJson -RawJson (New-IndexText)
  Assert-True $index.Ok
  Assert-Eq 1 $index.SchemaVersion
  Assert-Eq 2 $index.EntryCount
  Assert-True (Test-DshIndexTracksPair $index 'client-connection' 'browser-session')
  Assert-False (Test-DshIndexTracksPair $index 'client-connection' 'other')
}

It 'B2 a missing or unparseable index fails closed' {
  Assert-Eq 'index_missing' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson '').RefusalCode
  Assert-Eq 'index_missing' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson $null).RefusalCode
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson 'not json').RefusalCode
}

It 'B3 an unknown schema version fails closed' {
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson (New-IndexText -Schema 2)).RefusalCode
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson '{"entries":{}}').RefusalCode
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson '{"schemaVersion":1}').RefusalCode
}

It 'B4 malformed rows fail closed: non-boolean hasSecret, bad key, invalid segment' {
  $bad1 = '{"schemaVersion":1,"entries":{"client-connection\u0000browser-session":{"provider":"client-connection","reference":"browser-session","hasSecret":"yes","updatedAt":"t"}}}'
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson $bad1).RefusalCode
  $bad2 = '{"schemaVersion":1,"entries":{"wrong-key":{"provider":"client-connection","reference":"browser-session","hasSecret":true,"updatedAt":"t"}}}'
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson $bad2).RefusalCode
  $bad3 = '{"schemaVersion":1,"entries":{"a:b\u0000r":{"provider":"a:b","reference":"r","hasSecret":true,"updatedAt":"t"}}}'
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson $bad3).RefusalCode
  $bad4 = '{"schemaVersion":1,"entries":{"p\u0000r":{"provider":"p","reference":"r","hasSecret":true}}}'
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson $bad4).RefusalCode
}

It 'B5 duplicate fixture identities in the index fail closed' {
  $duplicate = '{"schemaVersion":1,"entries":{' +
    '"client-connection\u0000browser-session":{"provider":"client-connection","reference":"browser-session","hasSecret":true,"updatedAt":"t"},' +
    '"otherkey":{"provider":"client-connection","reference":"browser-session","hasSecret":false,"updatedAt":"t"}}}'
  Assert-Eq 'index_schema_invalid' (ConvertFrom-DshOwnedCredentialIndexJson -RawJson $duplicate).RefusalCode
}

It 'B6 an empty index is valid but tracks nothing' {
  $index = ConvertFrom-DshOwnedCredentialIndexJson -RawJson '{"schemaVersion":1,"entries":{}}'
  Assert-True $index.Ok
  Assert-Eq 0 $index.EntryCount
  Assert-False (Test-DshIndexTracksPair $index 'client-connection' 'browser-session')
}

# ---------------------------------------------------------------------------
# C. manifest schema and ownership binding
# ---------------------------------------------------------------------------

It 'C1 a minimal manifest binds namespace, root, PIDs and image hashes' {
  $result = Read-Manifest -Text (New-ManifestText -Nonce $null) -Nonce $null
  Assert-True $result.Ok
  Assert-Eq 1 $result.Manifest.Processes.Count
  Assert-Eq $script:ProcId $result.Manifest.Processes[0].Pid
  Assert-Eq 1 $result.Manifest.ExpectedIdentities.Count
  Assert-False $result.Manifest.NoncePresent
  Assert-False $result.Manifest.NonceBound
}

It 'C2 unknown keys, a wrong record and a wrong schema version fail closed' {
  Assert-Eq 'manifest_unknown_key' (Read-Manifest -Text (New-ManifestText -Extra @{ surprise = 1 }) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_record_mismatch' (Read-Manifest -Text (New-ManifestText -Record 'other') -Nonce $null).RefusalCode
  Assert-Eq 'manifest_schema_invalid' (Read-Manifest -Text (New-ManifestText -SchemaVersion 2) -Nonce $null).RefusalCode
  Assert-True (Read-Manifest -Text (New-ManifestText) -Nonce $null).Ok 'known optional keys are accepted'
  Assert-Eq 'manifest_missing' (Read-Manifest -Text '' -Nonce $null).RefusalCode
  Assert-Eq 'manifest_schema_invalid' (Read-Manifest -Text 'not json' -Nonce $null).RefusalCode
}

It 'C3 namespace and root binding are exact' {
  Assert-Eq 'manifest_namespace_invalid' (Read-Manifest -Text (New-ManifestText -Namespace 'not-a-uuid') -Nonce $null).RefusalCode
  Assert-Eq 'manifest_namespace_mismatch' (Read-Manifest -Text (New-ManifestText -Namespace '573300d2-0000-4000-8000-000000000001') -Nonce $null).RefusalCode
  Assert-Eq 'manifest_root_mismatch' (Read-Manifest -Text (New-ManifestText -OwnedRoot 'C:\dsh-fixture\.scratch\native-573300d2-0000-4000-8000-000000000001') -Nonce $null).RefusalCode
  Assert-Eq 'manifest_index_mismatch' (Read-Manifest -Text (New-ManifestText -IndexPath 'C:\dsh-fixture\.scratch\native-0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0\other.json') -Nonce $null).RefusalCode
}

It 'C4 the optional nonce binds only when offered and required' {
  Assert-Eq 'manifest_nonce_missing' (Read-Manifest -Text (New-ManifestText -Nonce $null) -Nonce $script:Nonce).RefusalCode
  Assert-Eq 'manifest_nonce_missing' (Read-Manifest -Text (New-ManifestText -Nonce $null) -Nonce $null -RequireNonce $true).RefusalCode
  Assert-Eq 'manifest_nonce_mismatch' (Read-Manifest -Text (New-ManifestText -Nonce 'ffff') -Nonce $script:Nonce).RefusalCode
  $bound = Read-Manifest -Text (New-ManifestText) -Nonce $script:Nonce
  Assert-True $bound.Ok
  Assert-True $bound.Manifest.NonceBound
  $unbound = Read-Manifest -Text (New-ManifestText) -Nonce $null -RequireNonce $true
  Assert-True $unbound.Ok
  Assert-True $unbound.Manifest.NoncePresent
  Assert-False $unbound.Manifest.NonceBound 'a present nonce without an offered value is evidence, not a hand-off proof'
}

It 'C5 image hashes and recorded PIDs are strict' {
  Assert-Eq 'manifest_no_approved_image' (Read-Manifest -Text (New-ManifestText -Approved @()) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_approved_image_invalid' (Read-Manifest -Text (New-ManifestText -Approved @('ABCDEF')) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_no_recorded_process' (Read-Manifest -Text (New-ManifestText -Processes @()) -Nonce $null).RefusalCode
  $allowed = Read-Manifest -Text (New-ManifestText -Processes @()) -Nonce $null -AllowNoProcesses $true
  Assert-True $allowed.Ok
  Assert-Eq 0 $allowed.Manifest.Processes.Count
  Assert-Eq 'manifest_process_pid_invalid' (Read-Manifest -Text (New-ManifestText -Processes @(@{ pid = 0; imageSha256 = $script:ImageHash })) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_process_pid_invalid' (Read-Manifest -Text (New-ManifestText -Processes @(@{ pid = -3; imageSha256 = $script:ImageHash })) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_process_image_invalid' (Read-Manifest -Text (New-ManifestText -Processes @(@{ pid = 10; imageSha256 = 'zz' })) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_process_image_unapproved' (Read-Manifest -Text (New-ManifestText -Processes @(@{ pid = 10; imageSha256 = ('b' * 64) })) -Nonce $null).RefusalCode
}

It 'C6 identity fixtures: empty, wrong pair, duplicate and extra all fail closed' {
  Assert-Eq 'manifest_identity_missing' (Read-Manifest -Text (New-ManifestText -Identities @()) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_identity_not_whitelisted' (Read-Manifest -Text (New-ManifestText -Identities @(@{ provider = 'openai'; reference = 'default' })) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_identity_not_whitelisted' (Read-Manifest -Text (New-ManifestText -Identities @(@{ provider = 'client-connection'; reference = 'browser-sessions' })) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_identity_duplicate' (Read-Manifest -Text (New-ManifestText -Identities @(
        @{ provider = 'client-connection'; reference = 'browser-session' },
        @{ provider = 'client-connection'; reference = 'browser-session' })) -Nonce $null).RefusalCode
  Assert-Eq 'manifest_identity_not_whitelisted' (Read-Manifest -Text (New-ManifestText -Identities @(
        @{ provider = 'client-connection'; reference = 'browser-session' },
        @{ provider = 'gateway'; reference = 'browser-session' })) -Nonce $null).RefusalCode
}

# ---------------------------------------------------------------------------
# D. the runner (all probes injected)
# ---------------------------------------------------------------------------

It 'D1 a fully guarded run deletes exactly one identity with numeric winError 0' {
  Initialize-GoodFixture
  $result = Invoke-Fx
  Assert-Ceq 'completed' $result.outcome
  Assert-Eq $null $result.refusalCode
  Assert-Eq 1 $result.counts.deleted
  Assert-Eq 0 $result.counts.failed
  Assert-Eq 1 $result.results.Count
  Assert-Eq 0 $result.results[0].winError
  Assert-Ceq 'deleted' $result.results[0].status
  Assert-Eq 1 $script:Fx.DeleteCalls.Count
  Assert-True $result.guards.hostWindows
  Assert-True $result.guards.namespaceCanonicalNonNil
  Assert-False $result.guards.namespaceProvesOwnership 'a UUID alone never proves ownership'
  Assert-True $result.guards.manifestSchemaValid
  Assert-True $result.guards.manifestRootMatched
  Assert-True $result.guards.indexEntryTracked
  Assert-True $result.guards.whitelistedPairOnly
  Assert-Ceq 'injected' $result.guards.deleteBackend
  Assert-Eq 1 $result.guards.recordedProcessCount
  Assert-Eq 0 $result.guards.pidsAliveAtStart
  Assert-Eq 0 $result.guards.pidsAliveAfterSettlement
}

It 'D2 winError 1168 is reported as already absent' {
  Initialize-GoodFixture
  $script:Fx.DeleteCode = 1168
  $result = Invoke-Fx
  Assert-Ceq 'already-absent' $result.outcome
  Assert-Eq 1 $result.counts.alreadyAbsent
  Assert-Eq 1168 $result.results[0].winError
  Assert-Ceq 'already_absent' $result.results[0].status
  Assert-Eq 0 $result.counts.deleted
}

It 'D3 any other winError is a failure with the numeric code preserved' {
  Initialize-GoodFixture
  $script:Fx.DeleteCode = 5
  $result = Invoke-Fx
  Assert-Ceq 'failed' $result.outcome
  Assert-Eq 1 $result.counts.failed
  Assert-Eq 5 $result.results[0].winError
  Assert-Ceq 'failed' $result.results[0].status
}

It 'D4 a throwing or non-numeric backend is bounded to winError -1' {
  Initialize-GoodFixture
  $script:Fx.DeleteThrows = $true
  $thrown = Invoke-Fx
  Assert-Eq -1 $thrown.results[0].winError
  Assert-Ceq 'backend_error' $thrown.results[0].status
  Assert-Ceq 'failed' $thrown.outcome
  Initialize-GoodFixture
  $script:Fx.DeleteGarbage = $true
  $garbage = Invoke-Fx
  Assert-Eq -1 $garbage.results[0].winError
  Assert-Ceq 'backend_error' $garbage.results[0].status
}

It 'D5 a recorded live PID refuses before any delete' {
  Initialize-GoodFixture
  $script:Fx.AliveUntilCall = 99
  $result = Invoke-Fx
  Assert-Ceq 'refused' $result.outcome
  Assert-Ceq 'process_still_alive' $result.refusalCode
  Assert-Eq 0 $script:Fx.DeleteCalls.Count 'no delete may happen while an owned PID is alive'
  Assert-Eq 1 $result.guards.pidsAliveAtStart
  Assert-True ($result.guards.pidsAliveAfterSettlement -gt 0)
}

It 'D6 PID settlement retries boundedly and then proceeds' {
  Initialize-GoodFixture
  $script:Fx.AliveUntilCall = 1
  $result = Invoke-Fx
  Assert-Ceq 'completed' $result.outcome
  Assert-Eq 1 $result.guards.settlementAttempts
  Assert-Eq 1 $result.guards.pidsAliveAtStart
  Assert-Eq 0 $result.guards.pidsAliveAfterSettlement
  Assert-Eq 1 $script:Fx.DeleteCalls.Count
}

It 'D7 plan-only performs no delete and returns a digest, not an identity' {
  Initialize-GoodFixture
  $result = Invoke-Fx -PlanOnly
  Assert-Ceq 'plan-only' $result.outcome
  Assert-Eq 0 $script:Fx.DeleteCalls.Count
  Assert-Ceq 'planned' $result.results[0].status
  Assert-Eq $null $result.results[0].winError
  Assert-Match $result.results[0].identityDigest8 '^[0-9a-f]{8}$'
}

It 'D8 without an injected backend and without -AllowOsDelete nothing is bound' {
  Initialize-GoodFixture
  $result = Invoke-Fx -Override @{ DeleteBackend = $null }
  Assert-Ceq 'refused' $result.outcome
  Assert-Ceq 'delete_backend_missing' $result.refusalCode
  Assert-Ceq 'none' $result.guards.deleteBackend
}

It 'D9 invalid namespace, unknown host and empty index refuse before deleting' {
  Initialize-GoodFixture
  $badNamespace = Invoke-Fx -Namespace '0F1E2D3C-4B5A-6978-8796-A5B4C3D2E1F0'
  Assert-Ceq 'namespace_invalid' $badNamespace.refusalCode
  Initialize-GoodFixture
  $script:Fx.HostOk = $false
  Assert-Ceq 'cleanup_unsupported_host' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.IndexText = '{"schemaVersion":1,"entries":{}}'
  Assert-Ceq 'index_entry_not_tracked' (Invoke-Fx).refusalCode
  Assert-Eq 0 $script:Fx.DeleteCalls.Count
}

It 'D10 index read failures, bad schema and a wrong pair refuse closed' {
  Initialize-GoodFixture
  $script:Fx.IndexThrows = $true
  Assert-Ceq 'index_missing' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.IndexText = 'not json'
  Assert-Ceq 'index_schema_invalid' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.ManifestText = New-ManifestText -Identities @(@{ provider = 'gateway'; reference = 'browser-session' })
  Assert-Ceq 'manifest_identity_not_whitelisted' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.ManifestThrows = $true
  Assert-Ceq 'manifest_missing' (Invoke-Fx).refusalCode
  Assert-Eq 0 $script:Fx.DeleteCalls.Count
}

It 'D11 owned-root and index reparse points and a resolved-elsewhere root refuse' {
  Initialize-GoodFixture
  $script:Fx.RootReparse = $true
  Assert-Ceq 'owned_root_reparse_point' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.RootMissing = $true
  Assert-Ceq 'owned_root_missing' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.RootFullOverride = 'C:\elsewhere\native-x'
  Assert-Ceq 'owned_root_mismatch' (Invoke-Fx).refusalCode
  Initialize-GoodFixture
  $script:Fx.IndexReparse = $true
  Assert-Ceq 'index_reparse_point' (Invoke-Fx).refusalCode
  Assert-Eq 0 $script:Fx.DeleteCalls.Count
}

It 'D12 guards are re-run immediately BEFORE the delete and refuse closed' {
  Initialize-GoodFixture
  # The first root probe (pre-flight) is clean; the second (pre-delete) shows a reparse point.
  $script:Fx.ReparseOnRootCall = 2
  $result = Invoke-Fx
  Assert-Ceq 'refused' $result.outcome
  Assert-Ceq 'owned_root_reparse_point' $result.refusalCode
  Assert-Eq 0 $script:Fx.DeleteCalls.Count 'the delete must not be attempted after a failed re-check'
  Assert-Eq 1 $result.counts.refused
  Assert-Eq 0 $result.counts.attempted
}

It 'D13 nonce hand-off binds only when offered and the delete still runs' {
  Initialize-GoodFixture
  $result = Invoke-Fx -ExpectedNonce $script:Nonce -RequireNonce
  Assert-Ceq 'completed' $result.outcome
  Assert-True $result.guards.manifestNonceBound
  Assert-True $result.guards.manifestNonceRequired
  Initialize-GoodFixture
  $script:Fx.ManifestText = New-ManifestText -Nonce $null
  Assert-Ceq 'manifest_nonce_missing' (Invoke-Fx -RequireNonce).refusalCode
  Assert-Eq 0 $script:Fx.DeleteCalls.Count
}

It 'D14 reparse points above the repository are recorded, not treated as an escape' {
  Initialize-GoodFixture
  $script:Fx.ReparseAbove = @('C:\Users\X\OneDrive', 'C:\Users\X', 'C:\')
  $result = Invoke-Fx
  Assert-Ceq 'completed' $result.outcome
  Assert-Eq 3 $result.guards.reparseAboveRepository
}

It 'D15 the result JSON is redacted: no target, provider, reference, namespace or PID' {
  Initialize-GoodFixture
  $result = Invoke-Fx
  $json = ConvertTo-DshCleanupJson -Result $result
  Assert-NotMatch $json 'client-connection' 'the provider must not be returned'
  Assert-NotMatch $json 'browser-session' 'the reference must not be returned'
  Assert-NotMatch $json 'dsh-desktop:' 'the service target must not be returned'
  Assert-NotMatch $json ([regex]::Escape($script:Ns)) 'the namespace must not be returned'
  Assert-NotMatch $json ([regex]::Escape($script:Root)) 'the owned root must not be returned'
  Assert-NotMatch $json ([regex]::Escape($script:ImageHash)) 'image hashes must not be returned'
  Assert-NotMatch $json ([regex]::Escape($script:Nonce)) 'the nonce must not be returned'
  Assert-NotMatch $json ([string]$script:ProcId) 'PIDs must not be returned'
  Assert-Match $json '"winError":0'
  Assert-Match $json '"nativeAcceptance":false'
  Assert-Match $json '"deleted":1'
}

# ---------------------------------------------------------------------------
# E. the P/Invoke bridge stays unbound
# ---------------------------------------------------------------------------

It 'E1 the bridge source uses only CredDeleteW with CRED_TYPE_GENERIC' {
  $source = Get-DshCredDeleteBridgeSource
  Assert-Match $source 'CredDeleteW'
  Assert-Match $source 'advapi32'
  Assert-Match $source 'CRED_TYPE_GENERIC'
  Assert-Match $source 'GetLastWin32Error'
}

It 'E2 the bridge source never enumerates, reads, frees or writes credentials' {
  $source = Get-DshCredDeleteBridgeSource
  Assert-NotMatch $source 'CredEnumerate'
  Assert-NotMatch $source 'CredRead'
  Assert-NotMatch $source 'CredFree'
  Assert-NotMatch $source 'CredWrite'
  Assert-NotMatch $source 'CredentialBlob'
  Assert-NotMatch $source 'CredParse'
}

It 'E3 the module declares exactly one DllImport and it is CredDeleteW' {
  $path = Join-Path $PSScriptRoot 'native-credential-cleanup.psm1'
  $text = [System.IO.File]::ReadAllText($path)
  $imports = [regex]::Matches($text, 'DllImport\(')
  Assert-Eq 1 $imports.Count 'exactly one P/Invoke declaration may exist'
  $importLine = [regex]::Match($text, '\[DllImport\([^\r\n]*')
  Assert-Match $importLine.Value 'CredDeleteW'
}

It 'E4 the bridge was never compiled or bound during these tests' {
  $type = 'DshCredentialCleanup.CredDeleteBridge' -as [type]
  Assert-Eq $null $type 'the P/Invoke bridge must not exist in this process'
  $threw = $false
  try { New-DshCredDeleteBackend | Out-Null } catch { $threw = $true }
  Assert-True $threw 'constructing the bridge without -AllowOsDelete must throw'
  Assert-Eq $null ('DshCredentialCleanup.CredDeleteBridge' -as [type]) 'the failed attempt must not compile anything'
}

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------

Write-Host ''
Write-Host ('tests {0}  pass {1}  fail {2}' -f $script:Total, $script:Passed, $script:Failed.Count)
if ($script:Failed.Count -gt 0) {
  foreach ($failure in $script:Failed) { Write-Host ('  {0}' -f $failure) }
  exit 1
}
exit 0
