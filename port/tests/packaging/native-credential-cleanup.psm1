<#
.SYNOPSIS
  TEST-ONLY owned-namespace credential cleanup helper (provisional, frozen).

.DESCRIPTION
  Removes EXACTLY ONE Windows Credential Manager generic credential: the owned
  qualification entry the desktop shell writes for its own gateway session.

  The single permitted identity is the shell-reserved pair
  `client-connection` / `browser-session` under the owned namespace, i.e. the
  exact OS service `dsh-desktop:{namespace}:client-connection`.

  EXACT TARGET NAME (never guessed; see the report for the citations):
    * `dsh-core/src/credentials.rs:231-236` builds the scoped service
      `dsh-desktop:{namespace}:{provider}` and sets account = `{reference}`.
    * The pinned keyring 3.6.3 (`port/src-tauri/Cargo.toml:69` selects the
      `windows-native` feature) resolves the Windows target name inline in
      `WinCredential::new_with_target`, `src/windows.rs:378`:
      `target_name = format!("{user}.{service}")` — user is the account.
      Keyring 3.6.3 exposes NO symbol named `resolve_target_name`; that branch is
      the resolution rule this module reproduces.
    * Deletion is `CredDeleteW(target_name, CRED_TYPE_GENERIC = 1, 0)`
      (`src/windows.rs:159-167`); a Win32 `ERROR_NOT_FOUND` = 1168 maps to
      `ErrorCode::NoEntry` (`src/windows.rs:504-512`), i.e. already absent.

  SAFETY
    * No `CredEnumerateW`, no `CredReadW`, no `CredFree`, no `CredWriteW`, and no
      secret-blob inspection anywhere in this module. Only `CredDeleteW` with one
      exact target name.
    * No filesystem writes or deletes, no relabel, no global environment change,
      no registry access, no default/legacy namespace enumeration.
    * Every guard runs BEFORE every delete, and the C# P/Invoke bridge is
      constructed only after all guards pass, PID settlement succeeds, and the
      caller passed `-AllowOsDelete`. Unit tests inject `-DeleteBackend` and never
      bind it.
    * The result is redacted: counts, statuses, numeric Win32 codes, booleans and
      an 8-hex identity digest. No raw target name, provider, reference, index
      row, PID, or namespace is ever returned.

  This module is provisional scratch tooling. It is NOT native acceptance.
#>

Set-StrictMode -Version Latest

# ---------------------------------------------------------------------------
# Fixed contract constants (read from source; see the report for citations)
# ---------------------------------------------------------------------------

$script:DshCleanupSpec = @{
  HelperVersion         = 1
  ManifestRecord        = 'dsh-owned-credential-cleanup-manifest'
  ManifestSchemaVersion = 1
  IndexSchemaVersion    = 1
  IndexFileName         = 'credentials-index.json'
  IndexKeySeparator     = [char]0
  ScratchDirName        = '.scratch'
  OwnedRootPrefix       = 'native-'
  ServicePrefix         = 'dsh-desktop'
  WinErrorSuccess       = 0
  WinErrorNotFound      = 1168
  WinErrorSentinel      = -1
  CredTypeGeneric       = 1
  MaxIdentityLen        = 128
  WhitelistedProvider   = 'client-connection'
  WhitelistedReference  = 'browser-session'
}

# Exact Windows target-name rule of keyring 3.6.3 (src/windows.rs:378).
function Get-DshCleanupSpec {
  <# Returns a copy of the fixed contract constants. #>
  return $script:DshCleanupSpec.Clone()
}

function Get-DshWhitelistedPair {
  <# Returns the one pair this helper may ever delete. #>
  return @{
    Provider  = $script:DshCleanupSpec.WhitelistedProvider
    Reference = $script:DshCleanupSpec.WhitelistedReference
  }
}

# ---------------------------------------------------------------------------
# Small pure helpers
# ---------------------------------------------------------------------------

function Get-DshValue {
  <#
    Strict-mode-safe property read for BOTH PSCustomObject (parsed JSON) and
    Hashtable (injected probe results). `PSObject.Properties` does not expose
    Hashtable entries, so dictionaries are read explicitly; returning the
    caller's default for an absent key keeps every probe fail-closed.
  #>
  param($InputObject, [string]$Name, $Default = $null)
  if ($null -eq $InputObject) { return $Default }
  if ($InputObject -is [System.Collections.IDictionary]) {
    if ($InputObject.Contains($Name)) { return $InputObject[$Name] }
    return $Default
  }
  $property = $InputObject.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Test-DshCanonicalNonNilUuid {
  <#
    Mirrors credential_backend.rs:278-307 (parse_owned_namespace/is_canonical_uuid):
    36 characters, hyphens at 8/13/18/23, lowercase hex elsewhere, not the nil UUID.
  #>
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value) -or $Value.Length -ne 36) { return $false }
  $hyphens = @(8, 13, 18, 23)
  for ($i = 0; $i -lt 36; $i++) {
    $c = $Value[$i]
    if ($hyphens -contains $i) { if ($c -ne '-') { return $false }; continue }
    $isHex = ($c -ge '0' -and $c -le '9') -or ($c -ge 'a' -and $c -le 'f')
    if (-not $isHex) { return $false }
  }
  return $Value -ne '00000000-0000-0000-0000-000000000000'
}

function Get-DshFullPath {
  <# Logical full path with trailing separators trimmed. Never resolves links. #>
  param([string]$Path)
  if ([string]::IsNullOrEmpty($Path)) { throw 'path is empty' }
  return ([System.IO.Path]::GetFullPath($Path)).TrimEnd('\', '/')
}

function Test-DshStrictlyBeneath {
  <#
    Component-wise strict containment (credential_backend.rs:346-352): a shared
    name prefix is not containment, and the root itself is not beneath itself.
  #>
  param([string]$Root, [string]$Candidate)
  if ([string]::IsNullOrEmpty($Root) -or [string]::IsNullOrEmpty($Candidate)) { return $false }
  $r = Get-DshFullPath $Root
  $c = Get-DshFullPath $Candidate
  if ($c.Length -le $r.Length) { return $false }
  return $c.StartsWith($r + '\', [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-DshCanonicalOwnedRoot {
  <# <repositoryRoot>\.scratch\native-{uuid} (credential_backend.rs:266-275). #>
  param([string]$RepositoryRoot, [string]$Namespace)
  if (-not (Test-DshCanonicalNonNilUuid $Namespace)) { throw 'namespace is not a canonical non-nil UUID' }
  $scratch = Join-Path (Get-DshFullPath $RepositoryRoot) $script:DshCleanupSpec.ScratchDirName
  return (Get-DshFullPath (Join-Path $scratch ($script:DshCleanupSpec.OwnedRootPrefix + $Namespace)))
}

function Get-DshScratchRoot {
  <# The canonical .scratch directory of a repository root. #>
  param([string]$RepositoryRoot)
  return (Get-DshFullPath (Join-Path (Get-DshFullPath $RepositoryRoot) $script:DshCleanupSpec.ScratchDirName))
}

function Get-DshCanonicalIndexPath {
  <#
    The dev-e2e owned layout (port/scripts/dev-e2e.ps1:122-125): DSH_HOME is
    <ownedRoot>\home and DSH_DESKTOP_USER_DATA_DIR is <ownedRoot>\home\userdata,
    so the metadata index (credential_backend.rs:261-264) is
    <ownedRoot>\home\userdata\credentials-index.json.
  #>
  param([string]$OwnedRoot)
  return (Get-DshFullPath (Join-Path (Get-DshFullPath $OwnedRoot) 'home\userdata\credentials-index.json'))
}

function Test-DshSegment {
  <# Mirrors dsh-core/src/credentials.rs:341-353 (validate_segment). #>
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return $false }
  if ($Value.Length -gt $script:DshCleanupSpec.MaxIdentityLen) { return $false }
  foreach ($ch in $Value.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -eq 0 -or $code -eq 13 -or $code -eq 10 -or $code -eq 58 -or $code -eq 92) { return $false }
    $isGraphic = $code -ge 33 -and $code -le 126
    if (-not ($isGraphic -or $code -eq 32)) { return $false }
  }
  return $true
}

function Resolve-DshCredentialTargetName {
  <#
    The EXACT Windows Credential Manager TargetName for one owned identity.

    service = "dsh-desktop:{namespace}:{provider}"   (credentials.rs:231-236)
    account = "{reference}"                          (credentials.rs:219)
    TargetName = "{account}.{service}"               (keyring-3.6.3 windows.rs:378)

    By default only the single whitelisted pair is accepted.
  #>
  param(
    [string]$Namespace,
    [string]$Provider,
    [string]$Reference,
    [switch]$AllowAnyValidatedPair
  )
  if (-not (Test-DshCanonicalNonNilUuid $Namespace)) { throw 'namespace is not a canonical non-nil UUID' }
  if (-not (Test-DshSegment $Provider)) { throw 'provider is not a valid credential segment' }
  if (-not (Test-DshSegment $Reference)) { throw 'reference is not a valid credential segment' }
  if (-not $AllowAnyValidatedPair) {
    if ($Provider -cne $script:DshCleanupSpec.WhitelistedProvider -or $Reference -cne $script:DshCleanupSpec.WhitelistedReference) {
      throw 'identity is not the single whitelisted pair'
    }
  }
  $service = '{0}:{1}:{2}' -f $script:DshCleanupSpec.ServicePrefix, $Namespace, $Provider
  return ('{0}.{1}' -f $Reference, $service)
}

function Get-DshIdentityDigest8 {
  <# FNV-1a 32-bit over the target name: correlation without the raw identity. #>
  param([string]$Text)
  if ($null -eq $Text) { $Text = '' }
  $mask = [int64]4294967295
  $hash = [int64]2166136261
  foreach ($ch in $Text.ToCharArray()) {
    $hash = $hash -bxor [int64][int]$ch
    $hash = ($hash * [int64]16777619) -band $mask
  }
  return ([uint32]$hash).ToString('x8')
}

function Get-DshWinErrorClass {
  <# Status for one numeric Win32 code. #>
  param([int]$WinError)
  if ($WinError -eq $script:DshCleanupSpec.WinErrorSuccess) { return 'deleted' }
  if ($WinError -eq $script:DshCleanupSpec.WinErrorNotFound) { return 'already_absent' }
  return 'failed'
}

function New-DshCleanupRefusal {
  param([string]$Code, [string]$Detail = '')
  return @{ Refused = $true; Code = $Code; Detail = $Detail }
}

# ---------------------------------------------------------------------------
# Index parsing (exact known schema; read-only, pure)
# ---------------------------------------------------------------------------

function ConvertFrom-DshOwnedCredentialIndexJson {
  <#
    Validate the metadata-only index written by CredentialStore::save_index
    (dsh-core/src/credentials.rs:355-372, 486-491). No secret material exists in
    this file by contract, and none is read out even if it did.

    Returns @{ Ok; RefusalCode; SchemaVersion; EntryCount; TrackedPairs; Problems }
  #>
  param([string]$RawJson)
  $result = @{
    Ok            = $false
    RefusalCode   = $null
    SchemaVersion = $null
    EntryCount    = 0
    TrackedPairs  = @()
    Problems      = @()
  }
  if ([string]::IsNullOrWhiteSpace($RawJson)) {
    $result.RefusalCode = 'index_missing'
    $result.Problems += 'index JSON was empty or absent'
    return $result
  }
  $parsed = $null
  try {
    $parsed = ConvertFrom-Json -InputObject $RawJson -ErrorAction Stop
  } catch {
    $result.RefusalCode = 'index_schema_invalid'
    $result.Problems += 'index JSON did not parse'
    return $result
  }
  $schema = Get-DshValue $parsed 'schemaVersion' $null
  if ($null -eq $schema -or -not ($schema -is [int]) -or [int]$schema -ne $script:DshCleanupSpec.IndexSchemaVersion) {
    $result.RefusalCode = 'index_schema_invalid'
    $result.Problems += 'schemaVersion must be the known version 1'
    return $result
  }
  $result.SchemaVersion = [int]$schema
  $entries = Get-DshValue $parsed 'entries' $null
  if ($null -eq $entries) {
    $result.RefusalCode = 'index_schema_invalid'
    $result.Problems += 'entries is missing'
    return $result
  }
  $entryProperties = @($entries.PSObject.Properties)
  if ($entries -is [string] -or $entries -is [int] -or $entries -is [bool] -or $entries -is [System.Array]) {
    $result.RefusalCode = 'index_schema_invalid'
    $result.Problems += 'entries is not an object'
    return $result
  }
  $separator = [string]([char]$script:DshCleanupSpec.IndexKeySeparator)
  $seen = @{}
  foreach ($property in $entryProperties) {
    $key = [string]$property.Name
    $row = $property.Value
    $provider = Get-DshValue $row 'provider' $null
    $reference = Get-DshValue $row 'reference' $null
    $hasSecret = Get-DshValue $row 'hasSecret' $null
    $updatedAt = Get-DshValue $row 'updatedAt' $null
    if (-not (Test-DshSegment $provider) -or -not (Test-DshSegment $reference)) {
      $result.RefusalCode = 'index_schema_invalid'
      $result.Problems += 'a row has an invalid provider or reference'
      return $result
    }
    if (-not ($hasSecret -is [bool])) {
      $result.RefusalCode = 'index_schema_invalid'
      $result.Problems += 'a row has a non-boolean hasSecret'
      return $result
    }
    if ([string]::IsNullOrEmpty($updatedAt)) {
      $result.RefusalCode = 'index_schema_invalid'
      $result.Problems += 'a row has no updatedAt'
      return $result
    }
    # Duplicate fixture identities are refused before the key is trusted.
    $pairId = $provider + $separator + $reference
    if ($seen.ContainsKey($pairId)) {
      $result.RefusalCode = 'index_schema_invalid'
      $result.Problems += 'a provider/reference pair appears more than once'
      return $result
    }
    $seen[$pairId] = $true
    $expectedKey = $provider + $separator + $reference
    if ($key -cne $expectedKey) {
      $result.RefusalCode = 'index_schema_invalid'
      $result.Problems += 'a row key is not provider<NUL>reference'
      return $result
    }
    $result.TrackedPairs += @{ Provider = $provider; Reference = $reference; HasSecret = [bool]$hasSecret }
  }
  $result.EntryCount = $result.TrackedPairs.Count
  $result.Ok = $true
  return $result
}

function Test-DshIndexTracksPair {
  <# Whether the validated index carries the exact pair. #>
  param($Index, [string]$Provider, [string]$Reference)
  if ($null -eq $Index -or -not $Index.Ok) { return $false }
  foreach ($pair in $Index.TrackedPairs) {
    if ($pair.Provider -ceq $Provider -and $pair.Reference -ceq $Reference) { return $true }
  }
  return $false
}

# ---------------------------------------------------------------------------
# Manifest validation (exact known schema; pure over the raw JSON text)
# ---------------------------------------------------------------------------

$script:DshManifestRequiredKeys = @(
  'schemaVersion', 'record', 'namespace', 'ownedRoot', 'indexPath',
  'approvedImageSha256', 'processes', 'expectedIdentities'
)
$script:DshManifestOptionalKeys = @('createdAtUtc', 'nonce')
$script:DshSha256Pattern = '^[0-9a-f]{64}$'

function Test-DshSha256Hex {
  param([string]$Value)
  if ([string]::IsNullOrEmpty($Value)) { return $false }
  return [bool]($Value -cmatch $script:DshSha256Pattern)
}

function Read-DshCleanupManifest {
  <#
    Validate the parent-owned ownership manifest.

    The manifest is the ONLY ownership input. A namespace UUID alone never proves
    ownership, so the manifest must bind the same namespace AND the same owned
    root AND at least one exact PID with an approved image hash, and the caller
    may additionally bind a private nonce.

    Returns @{ Ok; RefusalCode; Problems; Manifest }.
  #>
  param(
    [string]$RawJson,
    [string]$Namespace,
    [string]$OwnedRoot,
    [string]$IndexPath,
    [string]$ExpectedNonce,
    [bool]$RequireNonce,
    [bool]$AllowNoRecordedProcesses = $false
  )
  $result = @{ Ok = $false; RefusalCode = $null; Problems = @(); Manifest = $null }
  if ([string]::IsNullOrWhiteSpace($RawJson)) {
    $result.RefusalCode = 'manifest_missing'
    $result.Problems += 'manifest JSON was empty or absent'
    return $result
  }
  $parsed = $null
  try {
    $parsed = ConvertFrom-Json -InputObject $RawJson -ErrorAction Stop
  } catch {
    $result.RefusalCode = 'manifest_schema_invalid'
    $result.Problems += 'manifest JSON did not parse'
    return $result
  }
  $present = @{}
  foreach ($property in $parsed.PSObject.Properties) { $present[[string]$property.Name] = $true }
  foreach ($key in $present.Keys) {
    if (-not ($script:DshManifestRequiredKeys -contains $key) -and -not ($script:DshManifestOptionalKeys -contains $key)) {
      $result.RefusalCode = 'manifest_unknown_key'
      $result.Problems += 'manifest carries an unknown key'
      return $result
    }
  }
  foreach ($key in $script:DshManifestRequiredKeys) {
    if (-not $present.ContainsKey($key)) {
      $result.RefusalCode = 'manifest_schema_invalid'
      $result.Problems += "manifest is missing a required key ($key)"
      return $result
    }
  }
  $schemaVersion = Get-DshValue $parsed 'schemaVersion' $null
  if (-not ($schemaVersion -is [int]) -or [int]$schemaVersion -ne $script:DshCleanupSpec.ManifestSchemaVersion) {
    $result.RefusalCode = 'manifest_schema_invalid'
    $result.Problems += 'schemaVersion must be 1'
    return $result
  }
  if ([string](Get-DshValue $parsed 'record' '') -cne $script:DshCleanupSpec.ManifestRecord) {
    $result.RefusalCode = 'manifest_record_mismatch'
    $result.Problems += 'record must name the ownership manifest'
    return $result
  }
  $manifestNamespace = [string](Get-DshValue $parsed 'namespace' '')
  if (-not (Test-DshCanonicalNonNilUuid $manifestNamespace)) {
    $result.RefusalCode = 'manifest_namespace_invalid'
    $result.Problems += 'namespace is not a canonical non-nil UUID'
    return $result
  }
  if ($manifestNamespace -cne $Namespace) {
    $result.RefusalCode = 'manifest_namespace_mismatch'
    $result.Problems += 'namespace does not match the cleanup request'
    return $result
  }
  $manifestRoot = [string](Get-DshValue $parsed 'ownedRoot' '')
  if ([string]::IsNullOrWhiteSpace($manifestRoot)) {
    $result.RefusalCode = 'manifest_root_missing'
    $result.Problems += 'ownedRoot is missing'
    return $result
  }
  try { $manifestRootFull = Get-DshFullPath $manifestRoot } catch {
    $result.RefusalCode = 'manifest_root_invalid'
    $result.Problems += 'ownedRoot is not a valid path'
    return $result
  }
  if ($manifestRootFull -ine $OwnedRoot) {
    $result.RefusalCode = 'manifest_root_mismatch'
    $result.Problems += 'ownedRoot does not match the expected owned root'
    return $result
  }
  $manifestIndex = [string](Get-DshValue $parsed 'indexPath' '')
  if ([string]::IsNullOrWhiteSpace($manifestIndex)) {
    $result.RefusalCode = 'manifest_index_missing'
    $result.Problems += 'indexPath is missing'
    return $result
  }
  try { $manifestIndexFull = Get-DshFullPath $manifestIndex } catch {
    $result.RefusalCode = 'manifest_index_invalid'
    $result.Problems += 'indexPath is not a valid path'
    return $result
  }
  if ($manifestIndexFull -ine $IndexPath) {
    $result.RefusalCode = 'manifest_index_mismatch'
    $result.Problems += 'indexPath does not match the expected canonical index path'
    return $result
  }
  $approvedRaw = Get-DshValue $parsed 'approvedImageSha256' $null
  $approved = @()
  if ($null -ne $approvedRaw) { $approved = @($approvedRaw) }
  if ($approved.Count -lt 1) {
    $result.RefusalCode = 'manifest_no_approved_image'
    $result.Problems += 'approvedImageSha256 must carry at least one hash'
    return $result
  }
  foreach ($hash in $approved) {
    if (-not (Test-DshSha256Hex ([string]$hash))) {
      $result.RefusalCode = 'manifest_approved_image_invalid'
      $result.Problems += 'an approved image hash is not 64 lowercase hex'
      return $result
    }
  }
  $processesRaw = Get-DshValue $parsed 'processes' $null
  $processes = @()
  if ($null -ne $processesRaw) { $processes = @($processesRaw) }
  if ($processes.Count -lt 1 -and -not $AllowNoRecordedProcesses) {
    $result.RefusalCode = 'manifest_no_recorded_process'
    $result.Problems += 'processes must record at least one exact PID'
    return $result
  }
  $recorded = @()
  foreach ($process in $processes) {
    $pidValue = Get-DshValue $process 'pid' $null
    if (-not ($pidValue -is [int]) -or [int]$pidValue -le 0) {
      $result.RefusalCode = 'manifest_process_pid_invalid'
      $result.Problems += 'a recorded process pid is not a positive integer'
      return $result
    }
    $image = [string](Get-DshValue $process 'imageSha256' '')
    if (-not (Test-DshSha256Hex $image)) {
      $result.RefusalCode = 'manifest_process_image_invalid'
      $result.Problems += 'a recorded process imageSha256 is not 64 lowercase hex'
      return $result
    }
    if (-not ($approved -contains $image)) {
      $result.RefusalCode = 'manifest_process_image_unapproved'
      $result.Problems += 'a recorded process image hash is not approved'
      return $result
    }
    $recorded += @{ Pid = [int]$pidValue; ImageSha256 = $image }
  }
  $identitiesRaw = Get-DshValue $parsed 'expectedIdentities' $null
  $identities = @()
  if ($null -ne $identitiesRaw) { $identities = @($identitiesRaw) }
  if ($identities.Count -lt 1) {
    $result.RefusalCode = 'manifest_identity_missing'
    $result.Problems += 'expectedIdentities must carry exactly the whitelisted pair'
    return $result
  }
  $identitySeen = @{}
  $identityList = @()
  foreach ($identity in $identities) {
    $provider = [string](Get-DshValue $identity 'provider' '')
    $reference = [string](Get-DshValue $identity 'reference' '')
    if ($provider -cne $script:DshCleanupSpec.WhitelistedProvider -or $reference -cne $script:DshCleanupSpec.WhitelistedReference) {
      $result.RefusalCode = 'manifest_identity_not_whitelisted'
      $result.Problems += 'an expected identity is not the single whitelisted pair'
      return $result
    }
    $identityId = $provider + [string]([char]0) + $reference
    if ($identitySeen.ContainsKey($identityId)) {
      $result.RefusalCode = 'manifest_identity_duplicate'
      $result.Problems += 'an expected identity is duplicated'
      return $result
    }
    $identitySeen[$identityId] = $true
    $identityList += @{ Provider = $provider; Reference = $reference }
  }
  if ($identityList.Count -ne 1) {
    $result.RefusalCode = 'manifest_identity_not_whitelisted'
    $result.Problems += 'expectedIdentities must carry exactly one whitelisted pair'
    return $result
  }
  $nonce = [string](Get-DshValue $parsed 'nonce' '')
  if ($RequireNonce -and [string]::IsNullOrWhiteSpace($nonce)) {
    $result.RefusalCode = 'manifest_nonce_missing'
    $result.Problems += 'a nonce is required but the manifest carries none'
    return $result
  }
  $nonceBound = $false
  if (-not [string]::IsNullOrWhiteSpace($ExpectedNonce)) {
    if ([string]::IsNullOrWhiteSpace($nonce)) {
      $result.RefusalCode = 'manifest_nonce_missing'
      $result.Problems += 'a nonce was expected but the manifest carries none'
      return $result
    }
    if ($nonce -cne $ExpectedNonce) {
      $result.RefusalCode = 'manifest_nonce_mismatch'
      $result.Problems += 'the manifest nonce does not match the offered nonce'
      return $result
    }
    $nonceBound = $true
  }
  $result.Ok = $true
  $result.Manifest = @{
    Namespace           = $manifestNamespace
    OwnedRoot           = $manifestRootFull
    IndexPath           = $manifestIndexFull
    ApprovedImageSha256 = $approved
    Processes           = $recorded
    ExpectedIdentities  = $identityList
    NoncePresent        = -not [string]::IsNullOrWhiteSpace($nonce)
    NonceBound          = $nonceBound
  }
  return $result
}

# ---------------------------------------------------------------------------
# Default probes (injectable; the tests never let these touch the OS)
# ---------------------------------------------------------------------------

function Get-DshDefaultPathFacts {
  <#
    Facts about one path, walking up to and INCLUDING -StopAt.

    Reparse points strictly above the repository (for example OneDrive folder
    redirection) are recorded as AboveStopAt: the application fence canonicalizes
    both the scratch root and the owned root, so such components cancel out. Only
    components at or beneath -StopAt can redirect the owned root itself.
  #>
  param([string]$Path, [string]$StopAt)
  $facts = @{
    Full            = $null
    Exists          = $false
    IsDirectory     = $false
    ReparseAtOrBelow = @()
    ReparseAbove    = @()
    Error           = $null
  }
  try {
    $full = Get-DshFullPath $Path
    $facts.Full = $full
  } catch {
    $facts.Error = 'invalid_path'
    return $facts
  }
  $item = $null
  try {
    $item = Get-Item -LiteralPath $facts.Full -Force -ErrorAction Stop
  } catch {
    $facts.Error = 'not_found'
    return $facts
  }
  $facts.Exists = $true
  $facts.IsDirectory = [bool]$item.PSIsContainer
  $stopFull = $null
  if (-not [string]::IsNullOrWhiteSpace($StopAt)) { $stopFull = Get-DshFullPath $StopAt }
  $cursor = if ($item.PSIsContainer) { $item } else { $item.Directory }
  while ($null -ne $cursor) {
    if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      if ($null -ne $stopFull -and -not (Test-DshStrictlyBeneath $stopFull $cursor.FullName) -and $cursor.FullName -ine $stopFull) {
        $facts.ReparseAbove += $cursor.FullName
      } else {
        $facts.ReparseAtOrBelow += $cursor.FullName
      }
    }
    if ($null -ne $stopFull -and $cursor.FullName -ieq $stopFull) { break }
    $cursor = $cursor.Parent
  }
  return $facts
}

function Get-DshDefaultProcessFacts {
  <# Whether a PID is still alive. Never reads the process image. #>
  param([int]$ProcessId)
  $facts = @{ Alive = $false; Error = $null }
  try {
    $process = [System.Diagnostics.Process]::GetProcessById($ProcessId)
    if ($null -ne $process -and -not $process.HasExited) { $facts.Alive = $true }
  } catch [System.ArgumentException] {
    $facts.Alive = $false
  } catch {
    $facts.Error = $_.Exception.GetType().Name
    $facts.Alive = $true
  }
  return $facts
}

function Get-DshDefaultTextReader {
  <# Reads a file as raw text; throws when absent. #>
  param([string]$Path)
  return [System.IO.File]::ReadAllText($Path)
}

# ---------------------------------------------------------------------------
# The C# P/Invoke bridge (only ever constructed after every guard, and only
# with -AllowOsDelete; the unit tests never call this function)
# ---------------------------------------------------------------------------

function Get-DshCredDeleteBridgeSource {
  <# The exact bridge source, published so tests can assert on it without binding. #>
  return @'
using System;
using System.Runtime.InteropServices;
namespace DshCredentialCleanup {
    public static class CredDeleteBridge {
        // The ONLY Windows credential API this helper may call.
        [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CredDeleteW(string targetName, uint type, uint flags);
        // CRED_TYPE_GENERIC = 1 (windows-sys-0.52.0 Win32/Security/Credentials/mod.rs).
        // Returns the numeric Win32 error code: 0 on success, 1168 when absent.
        public static uint DeleteGeneric(string targetName) {
            if (string.IsNullOrEmpty(targetName)) { return 87u; }
            if (CredDeleteW(targetName, 1u, 0u)) { return 0u; }
            return (uint)Marshal.GetLastWin32Error();
        }
    }
}
'@
}

function New-DshCredDeleteBackend {
  <#
    Compile and bind the CredDeleteW bridge, then return a scriptblock backend.

    Called ONLY after all guards pass, PID settlement succeeds, and the caller
    passed -AllowOsDelete. Performs no credential operation itself.
  #>
  param([switch]$AllowOsDelete)
  if (-not $AllowOsDelete) { throw 'New-DshCredDeleteBackend requires -AllowOsDelete' }
  Add-Type -TypeDefinition (Get-DshCredDeleteBridgeSource) -Language CSharp -ErrorAction Stop
  return {
    param([string]$TargetName)
    return [int][DshCredentialCleanup.CredDeleteBridge]::DeleteGeneric($TargetName)
  }.GetNewClosure()
}

# ---------------------------------------------------------------------------
# Per-delete re-validation
# ---------------------------------------------------------------------------

function Test-DshDeletePreconditions {
  <#
    The complete guard set, re-evaluated immediately BEFORE every delete:
    namespace, owned-root containment and reparse freedom, index path, index
    schema, tracked pair, whitelisted identity, uniqueness.
  #>
  param(
    $State,
    [scriptblock]$PathProbe,
    [scriptblock]$IndexReader
  )
  $namespace = [string]$State.Namespace
  $expectedRoot = [string]$State.OwnedRoot
  $scratchRoot = [string]$State.ScratchRoot
  $expectedIndex = [string]$State.IndexPath
  $provider = [string]$State.Provider
  $reference = [string]$State.Reference

  if (-not (Test-DshCanonicalNonNilUuid $namespace)) { return (New-DshCleanupRefusal 'namespace_invalid') }
  if (-not (Test-DshStrictlyBeneath $scratchRoot $expectedRoot)) { return (New-DshCleanupRefusal 'owned_root_not_strictly_beneath_scratch') }
  if (-not (Test-DshStrictlyBeneath $expectedRoot $expectedIndex)) { return (New-DshCleanupRefusal 'index_path_outside_owned_root') }
  if ([System.IO.Path]::GetFileName($expectedIndex) -ine $script:DshCleanupSpec.IndexFileName) { return (New-DshCleanupRefusal 'index_path_basename_mismatch') }
  if ($provider -cne $script:DshCleanupSpec.WhitelistedProvider -or $reference -cne $script:DshCleanupSpec.WhitelistedReference) {
    return (New-DshCleanupRefusal 'identity_not_whitelisted')
  }
  $rootFacts = & $PathProbe $expectedRoot $scratchRoot
  if (-not $rootFacts.Exists -or -not $rootFacts.IsDirectory) { return (New-DshCleanupRefusal 'owned_root_missing') }
  if (@($rootFacts.ReparseAtOrBelow).Count -gt 0) { return (New-DshCleanupRefusal 'owned_root_reparse_point') }
  if ([string]$rootFacts.Full -ine $expectedRoot) { return (New-DshCleanupRefusal 'owned_root_mismatch') }
  $indexFacts = & $PathProbe $expectedIndex $expectedRoot
  if (-not $indexFacts.Exists) { return (New-DshCleanupRefusal 'index_missing') }
  if (@($indexFacts.ReparseAtOrBelow).Count -gt 0) { return (New-DshCleanupRefusal 'index_reparse_point') }
  $raw = $null
  try { $raw = & $IndexReader $expectedIndex } catch { return (New-DshCleanupRefusal 'index_unreadable') }
  $index = ConvertFrom-DshOwnedCredentialIndexJson -RawJson $raw
  if (-not $index.Ok) { return (New-DshCleanupRefusal $index.RefusalCode) }
  if (-not (Test-DshIndexTracksPair $index $provider $reference)) { return (New-DshCleanupRefusal 'index_entry_not_tracked') }
  return @{ Refused = $false; Code = $null; IndexEntryCount = $index.EntryCount }
}

# ---------------------------------------------------------------------------
# Result projection (redacted)
# ---------------------------------------------------------------------------

function ConvertTo-DshRedactedCleanupResult {
  param($State)
  return [pscustomobject]@{
    record         = 'dsh-owned-credential-cleanup'
    helperVersion  = $script:DshCleanupSpec.HelperVersion
    nativeAcceptance = $false
    outcome        = $State.Outcome
    refusalCode    = $State.RefusalCode
    counts         = [pscustomobject]@{
      requested    = $State.Counts.Requested
      attempted    = $State.Counts.Attempted
      deleted      = $State.Counts.Deleted
      alreadyAbsent = $State.Counts.AlreadyAbsent
      failed       = $State.Counts.Failed
      refused      = $State.Counts.Refused
    }
    results        = @($State.Results)
    guards         = [pscustomobject]$State.Guards
    redaction      = 'no raw target name, provider, reference, index row, PID or namespace is returned'
  }
}

function ConvertTo-DshCleanupJson {
  param($Result, [int]$Depth = 8)
  return (ConvertTo-Json -InputObject $Result -Depth $Depth -Compress)
}

# ---------------------------------------------------------------------------
# Orchestration
# ---------------------------------------------------------------------------

function Invoke-DshOwnedCredentialCleanup {
  <#
    Delete the single whitelisted owned credential, or refuse without touching
    anything. Returns the redacted result object; never throws for a refusable
    input.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryRoot,
    [Parameter(Mandatory = $true)][string]$Namespace,
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [string]$ExpectedNonce,
    [switch]$RequireNonce,
    [switch]$AllowNoRecordedProcesses,
    [switch]$AllowNonCanonicalIndexLayout,
    [switch]$PlanOnly,
    [switch]$AllowOsDelete,
    [scriptblock]$ManifestReader,
    [scriptblock]$IndexReader,
    [scriptblock]$PathProbe,
    [scriptblock]$ProcessProbe,
    [scriptblock]$DeleteBackend,
    [scriptblock]$HostProbe,
    [scriptblock]$Sleep,
    [int]$SettlementAttempts = 1,
    [int]$SettlementWaitMs = 0
  )

  if ($null -eq $ManifestReader) { $ManifestReader = ${function:Get-DshDefaultTextReader} }
  if ($null -eq $IndexReader) { $IndexReader = ${function:Get-DshDefaultTextReader} }
  if ($null -eq $PathProbe) { $PathProbe = ${function:Get-DshDefaultPathFacts} }
  if ($null -eq $ProcessProbe) { $ProcessProbe = ${function:Get-DshDefaultProcessFacts} }
  if ($null -eq $HostProbe) { $HostProbe = { return [System.Environment]::OSVersion.Platform -eq [System.PlatformID]::Win32NT } }
  if ($null -eq $Sleep) { $Sleep = { param([int]$Milliseconds) Start-Sleep -Milliseconds $Milliseconds } }
  if ($SettlementAttempts -lt 1) { $SettlementAttempts = 1 }

  $guards = [ordered]@{
    hostWindows                    = $false
    namespaceCanonicalNonNil       = $false
    namespaceProvesOwnership       = $false
    ownedRootStrictlyBeneathScratch = $false
    ownedRootReparseFree           = $false
    manifestSchemaValid            = $false
    manifestNamespaceMatched       = $false
    manifestRootMatched            = $false
    manifestNonceBound             = $false
    manifestNonceRequired          = [bool]$RequireNonce
    approvedImageCount             = 0
    recordedProcessCount           = 0
    pidsAliveAtStart               = 0
    pidsAliveAfterSettlement       = 0
    settlementAttempts             = 0
    indexPathStrictlyBeneathRoot   = $false
    indexCanonicalLayout           = $false
    indexSchemaVersion             = $null
    indexEntryCount                = 0
    indexEntryTracked              = $false
    whitelistedPairOnly            = $false
    deleteBackend                  = 'none'
    reparseAboveRepository         = 0
  }
  $counts = [ordered]@{ Requested = 0; Attempted = 0; Deleted = 0; AlreadyAbsent = 0; Failed = 0; Refused = 0 }
  $results = New-Object System.Collections.ArrayList
  $outcome = 'refused'
  $refusalCode = $null

  # --- 1. host ---------------------------------------------------------------
  $hostOk = $false
  try { $hostOk = [bool](& $HostProbe) } catch { $hostOk = $false }
  $guards.hostWindows = $hostOk
  if (-not $hostOk) { $refusalCode = 'cleanup_unsupported_host' }
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }

  # --- 2. namespace ----------------------------------------------------------
  $guards.namespaceProvesOwnership = $false
  if (-not (Test-DshCanonicalNonNilUuid $Namespace)) { $refusalCode = 'namespace_invalid' }
  else { $guards.namespaceCanonicalNonNil = $true; $counts.Requested = 1 }
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }

  # --- 3. expected paths -----------------------------------------------------
  $ownedRoot = $null; $scratchRoot = $null; $expectedIndex = $null
  try {
    $ownedRoot = Get-DshCanonicalOwnedRoot -RepositoryRoot $RepositoryRoot -Namespace $Namespace
    $scratchRoot = Get-DshScratchRoot -RepositoryRoot $RepositoryRoot
    $expectedIndex = Get-DshCanonicalIndexPath -OwnedRoot $ownedRoot
  } catch {
    $refusalCode = 'owned_root_invalid'
  }
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }
  if (Test-DshStrictlyBeneath $scratchRoot $ownedRoot) { $guards.ownedRootStrictlyBeneathScratch = $true }
  else { $refusalCode = 'owned_root_not_strictly_beneath_scratch' }
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }
  if (Test-DshStrictlyBeneath $ownedRoot $expectedIndex) { $guards.indexPathStrictlyBeneathRoot = $true }
  else { $refusalCode = 'index_path_outside_owned_root' }
  $guards.indexCanonicalLayout = -not [bool]$AllowNonCanonicalIndexLayout
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }

  # --- 4. owned root facts ---------------------------------------------------
  $rootFacts = & $PathProbe $ownedRoot $scratchRoot
  if (-not $rootFacts.Exists -or -not $rootFacts.IsDirectory) { $refusalCode = 'owned_root_missing' }
  elseif (@($rootFacts.ReparseAtOrBelow).Count -gt 0) { $refusalCode = 'owned_root_reparse_point' }
  elseif (@($rootFacts.ReparseAbove).Count -gt 0) {
    $guards.reparseAboveRepository = @($rootFacts.ReparseAbove).Count
  }
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }
  if ([string]$rootFacts.Full -ine $ownedRoot) { $refusalCode = 'owned_root_mismatch' }
  else { $guards.ownedRootReparseFree = $true }
  if ($null -ne $refusalCode) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $refusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }

  # --- 5. manifest -----------------------------------------------------------
  $manifestRaw = $null
  try { $manifestRaw = & $ManifestReader $ManifestPath } catch { $manifestRaw = $null }
  $manifest = Read-DshCleanupManifest -RawJson $manifestRaw -Namespace $Namespace -OwnedRoot $ownedRoot `
    -IndexPath $expectedIndex -ExpectedNonce $ExpectedNonce -RequireNonce ([bool]$RequireNonce) `
    -AllowNoRecordedProcesses ([bool]$AllowNoRecordedProcesses)
  if (-not $manifest.Ok) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $manifest.RefusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }
  $guards.manifestSchemaValid = $true
  $guards.manifestNamespaceMatched = $true
  $guards.manifestRootMatched = $true
  $guards.manifestNonceBound = [bool]$manifest.Manifest.NonceBound
  $guards.approvedImageCount = @($manifest.Manifest.ApprovedImageSha256).Count
  $guards.recordedProcessCount = @($manifest.Manifest.Processes).Count

  # --- 6. index --------------------------------------------------------------
  $indexBeneath = Test-DshStrictlyBeneath $ownedRoot $expectedIndex
  $indexBasenameOk = ([System.IO.Path]::GetFileName($expectedIndex) -ieq $script:DshCleanupSpec.IndexFileName)
  if (-not $indexBeneath -or -not $indexBasenameOk) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = 'index_path_basename_mismatch'; Counts = $counts; Results = $results; Guards = $guards }
  }
  $indexRaw = $null
  try { $indexRaw = & $IndexReader $expectedIndex } catch { $indexRaw = $null }
  $index = ConvertFrom-DshOwnedCredentialIndexJson -RawJson $indexRaw
  if (-not $index.Ok) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $index.RefusalCode; Counts = $counts; Results = $results; Guards = $guards }
  }
  $guards.indexSchemaVersion = $index.SchemaVersion
  $guards.indexEntryCount = $index.EntryCount
  $pair = Get-DshWhitelistedPair
  if (-not (Test-DshIndexTracksPair $index $pair.Provider $pair.Reference)) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = 'index_entry_not_tracked'; Counts = $counts; Results = $results; Guards = $guards }
  }
  $guards.indexEntryTracked = $true
  $guards.whitelistedPairOnly = $true

  # --- 7. PID settlement -----------------------------------------------------
  $aliveStart = 0
  foreach ($process in $manifest.Manifest.Processes) {
    $facts = $null
    try { $facts = & $ProcessProbe $process.Pid } catch { $facts = @{ Alive = $true; Error = 'probe_failed' } }
    if ([bool](Get-DshValue $facts 'Alive' $true)) { $aliveStart++ }
  }
  $guards.pidsAliveAtStart = $aliveStart
  $attempt = 0
  $aliveNow = $aliveStart
  while ($aliveNow -gt 0 -and $attempt -lt $SettlementAttempts) {
    $attempt++
    if ($SettlementWaitMs -gt 0) { & $Sleep $SettlementWaitMs | Out-Null }
    $aliveNow = 0
    foreach ($process in $manifest.Manifest.Processes) {
      $facts = $null
      try { $facts = & $ProcessProbe $process.Pid } catch { $facts = @{ Alive = $true; Error = 'probe_failed' } }
      if ([bool](Get-DshValue $facts 'Alive' $true)) { $aliveNow++ }
    }
  }
  $guards.settlementAttempts = $attempt
  $guards.pidsAliveAfterSettlement = $aliveNow
  if ($aliveNow -gt 0) {
    return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = 'process_still_alive'; Counts = $counts; Results = $results; Guards = $guards }
  }

  # --- 8. plan ---------------------------------------------------------------
  $targetName = Resolve-DshCredentialTargetName -Namespace $Namespace -Provider $pair.Provider -Reference $pair.Reference
  $plan = @(@{ Provider = $pair.Provider; Reference = $pair.Reference; TargetName = $targetName })
  if ($PlanOnly) {
    return ConvertTo-DshRedactedCleanupResult @{
      Outcome = 'plan-only'; RefusalCode = $null; Counts = $counts
      Results = @([pscustomobject]@{ identityDigest8 = Get-DshIdentityDigest8 $targetName; winError = $null; status = 'planned' })
      Guards = $guards
    }
  }

  # --- 9. delete (guards re-run before EVERY delete) -------------------------
  $backend = $DeleteBackend
  if ($null -eq $backend) {
    if (-not $AllowOsDelete) {
      return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = 'delete_backend_missing'; Counts = $counts; Results = $results; Guards = $guards }
    }
    try {
      $backend = New-DshCredDeleteBackend -AllowOsDelete
      $guards.deleteBackend = 'pinvoke-bridge'
    } catch {
      return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = 'delete_backend_unavailable'; Counts = $counts; Results = $results; Guards = $guards }
    }
  } else {
    $guards.deleteBackend = 'injected'
  }

  foreach ($entry in $plan) {
    $recheck = Test-DshDeletePreconditions -State @{
      Namespace = $Namespace; OwnedRoot = $ownedRoot; ScratchRoot = $scratchRoot
      IndexPath = $expectedIndex; Provider = $entry.Provider; Reference = $entry.Reference
    } -PathProbe $PathProbe -IndexReader $IndexReader
    if ($recheck.Refused) {
      $counts.Refused++
      return ConvertTo-DshRedactedCleanupResult @{ Outcome = 'refused'; RefusalCode = $recheck.Code; Counts = $counts; Results = $results; Guards = $guards }
    }
    $counts.Attempted++
    $winError = $script:DshCleanupSpec.WinErrorSentinel
    $status = 'backend_error'
    try {
      $raw = & $backend $entry.TargetName
      $candidate = Get-DshValue $raw 'WinError' $raw
      if ($candidate -is [int] -or $candidate -is [uint32] -or $candidate -is [long]) {
        $winError = [int]$candidate
        $status = Get-DshWinErrorClass $winError
      }
    } catch {
      $winError = $script:DshCleanupSpec.WinErrorSentinel
      $status = 'backend_error'
    }
    $results.Add([pscustomobject]@{
      identityDigest8 = Get-DshIdentityDigest8 $entry.TargetName
      winError        = $winError
      status          = $status
    }) | Out-Null
    switch ($status) {
      'deleted' { $counts.Deleted++ }
      'already_absent' { $counts.AlreadyAbsent++ }
      default { $counts.Failed++ }
    }
  }

  $outcome = if ($counts.Failed -gt 0) { 'failed' } elseif ($counts.Deleted -eq 0 -and $counts.AlreadyAbsent -gt 0) { 'already-absent' } else { 'completed' }
  return ConvertTo-DshRedactedCleanupResult @{ Outcome = $outcome; RefusalCode = $null; Counts = $counts; Results = $results; Guards = $guards }
}

Export-ModuleMember -Function @(
  'Get-DshCleanupSpec', 'Get-DshWhitelistedPair',
  'Test-DshCanonicalNonNilUuid', 'Get-DshFullPath', 'Test-DshStrictlyBeneath',
  'Get-DshCanonicalOwnedRoot', 'Get-DshScratchRoot', 'Get-DshCanonicalIndexPath',
  'Test-DshSegment', 'Resolve-DshCredentialTargetName', 'Get-DshIdentityDigest8',
  'Get-DshWinErrorClass', 'ConvertFrom-DshOwnedCredentialIndexJson',
  'Test-DshIndexTracksPair', 'Read-DshCleanupManifest',
  'Test-DshSha256Hex', 'Get-DshDefaultPathFacts', 'Get-DshDefaultProcessFacts',
  'Get-DshDefaultTextReader', 'Get-DshCredDeleteBridgeSource', 'New-DshCredDeleteBackend',
  'Test-DshDeletePreconditions', 'ConvertTo-DshRedactedCleanupResult', 'ConvertTo-DshCleanupJson',
  'Invoke-DshOwnedCredentialCleanup'
)
