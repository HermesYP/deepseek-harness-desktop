<#
.SYNOPSIS
  Source-contract and behavioural tests for the installed-artifact acceptance
  guard in port\scripts\verify-installed.ps1.

.DESCRIPTION
  group6 remediation contract. The acceptance script is the only instrument that
  can damage a real installation, so its guards are asserted here as a CONTRACT
  rather than trusted to a run nobody will repeat.

  Two kinds of assertion:

    1. SOURCE CONTRACT (static). The order in which the script does things is
       itself the safety property, so ordering is asserted by position, not by
       intent: the footprint gate must appear before the installer process is
       started, and before the application is started. Destructive APIs must be
       absent, not merely unused. Bypass affordances must be absent from the
       parameter block.

    2. BEHAVIOUR (executed). `-GuardSelfTest` runs the pure decision functions
       against synthetic probes. It touches no filesystem, no registry and no
       process, so it is safe to run anywhere, including on a host that carries
       a live installation.

  Windows only. SKIPs, rather than fails, when the target script is absent, so
  a partial checkout does not produce a false failure.

  Invoked directly (it is deliberately not wired into build.ps1, which the lead
  owns):

    powershell -NoProfile -ExecutionPolicy Bypass -File port\tests\packaging\verify-installed-guards.ps1
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Import-Module (Join-Path $PSScriptRoot 'suite-result.psm1') -Force
trap { exit (Write-DshSuiteResult -Id 'installed-qualification-guards' -Status 'FAIL' -Detail $_.Exception.Message) }
$Script = Join-Path $PortRoot 'scripts\verify-installed.ps1'
$failures = @()
$passes = 0

function Assert-True([bool]$Condition, [string]$Name, [string]$Detail) {
  if ($Condition) {
    $script:passes++
    Write-Host ("  [PASS] {0}{1}" -f $Name, $(if ($Detail) { " - $Detail" } else { '' })) -ForegroundColor DarkGray
  } else {
    $script:failures += $Name
    Write-Host ("  [FAIL] {0}{1}" -f $Name, $(if ($Detail) { " - $Detail" } else { '' })) -ForegroundColor Red
  }
}

# A required guard gate must never be able to go green by not finding its
# subject. A partial checkout that omits the acceptance script is a MISSING
# GATE, not a passing run, so this FAILS rather than skipping.
if (-not (Test-Path $Script)) {
  Write-Host ("  [FAIL] the acceptance script under guard is present - not found: {0}" -f $Script) -ForegroundColor Red
  Write-Host ''
  Write-Host 'RESULT: FAIL - the guard suite cannot verify a script that is not here.' -ForegroundColor Red
  Write-Host '        A missing target must never report success.' -ForegroundColor Red
  exit (Write-DshSuiteResult -Id 'installed-qualification-guards' -Status 'FAIL' -Detail "the guarded acceptance script is absent: $Script")
}

# `$IsWindows` only exists in PowerShell 6+; under StrictMode on 5.1, touching an
# undefined variable is an error, so it is probed rather than referenced blindly.
$onWindows = $true
if (Get-Variable -Name 'IsWindows' -ErrorAction SilentlyContinue) { $onWindows = [bool]$IsWindows }
if (-not $onWindows) {
  Write-Host 'SKIP: Windows only.' -ForegroundColor Yellow
  exit (Write-DshSuiteResult -Id 'installed-qualification-guards' -Status 'SKIP' -Reason 'not-applicable' -Detail 'the guarded acceptance script is Windows-only')
}

$code = Get-Content $Script -Raw

# ---------------------------------------------------------------------------
# 0. The script must remain loadable and ASCII-only.
# ---------------------------------------------------------------------------
# F-27: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI, so a single
# em-dash in the guard text would break parsing and disable the guard entirely.
$parseErrors = $null
$parseTokens = $null
$null = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$parseTokens, [ref]$parseErrors)
Assert-True (@($parseErrors).Count -eq 0) 'the acceptance script parses' `
  $(if (@($parseErrors).Count -eq 0) { 'no parser errors' } else { (@($parseErrors) | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Message)" }) -join '; ' })

$nonAscii = @([System.IO.File]::ReadAllBytes($Script) | Where-Object { $_ -gt 127 })
Assert-True ($nonAscii.Count -eq 0) 'the acceptance script stays ASCII-only (F-27)' `
  $(if ($nonAscii.Count -eq 0) { 'no byte above 127' } else { "$($nonAscii.Count) non-ASCII byte(s)" })

# ---------------------------------------------------------------------------
# 1. ORDER IS THE SAFETY PROPERTY.
# ---------------------------------------------------------------------------
$gateIndex = $code.IndexOf("Step 'Same-product footprint gate")
$installIndex = $code.IndexOf('Start-Process -FilePath $InstallerPath')
$launchIndex = $code.IndexOf('Start-Process -FilePath $appExe.FullName')
$readOnlyLaneIndex = $code.IndexOf('if ($ReadOnlyExtractedLayout)')

Assert-True ($gateIndex -gt 0) 'the same-product footprint gate exists'
Assert-True ($installIndex -gt 0) 'the installer process start exists'
Assert-True ($launchIndex -gt 0) 'the application launch exists'
Assert-True ($gateIndex -lt $installIndex) 'the footprint gate runs BEFORE the installer is started' `
  "gate at offset $gateIndex, installer at $installIndex"
Assert-True ($gateIndex -lt $launchIndex) 'the footprint gate runs BEFORE the application is launched' `
  "gate at offset $gateIndex, launch at $launchIndex"
Assert-True ($readOnlyLaneIndex -gt 0 -and $readOnlyLaneIndex -lt $installIndex) `
  'the read-only extracted-layout lane is handled before any installer path' `
  "lane at offset $readOnlyLaneIndex, installer at $installIndex"

$authIndex = $code.IndexOf('Test-LaunchAuthorized -FootprintFindings $findings')
Assert-True ($authIndex -gt 0 -and $authIndex -lt $launchIndex) `
  'launch authorization is decided before the application is launched' `
  "authorization at offset $authIndex, launch at $launchIndex"

# ---------------------------------------------------------------------------
# 2. NO GENERIC DESTRUCTIVE CLEANUP.
# ---------------------------------------------------------------------------
# Stop-Process -Force was the previous teardown. It can orphan node.exe children
# and skip graceful shutdown, and it is not scoped to an owned process identity.
$lines = [System.IO.File]::ReadAllLines($Script)
$stopProcessCalls = @($lines | Where-Object { $_ -match '^\s*(Stop-Process|Remove-Item\s+\$proc|taskkill)' })
Assert-True ($stopProcessCalls.Count -eq 0) 'no Stop-Process or taskkill call remains' `
  $(if ($stopProcessCalls.Count -eq 0) { 'teardown is evidence-only' } else { ($stopProcessCalls -join ' | ') })

$removeItemCalls = @($lines | Where-Object { $_ -match '^\s*Remove-Item' -and $_ -notmatch 'Env:' })
Assert-True ($removeItemCalls.Count -eq 0) 'every Remove-Item targets an environment variable, not a path' `
  $(if ($removeItemCalls.Count -eq 0) { 'no filesystem or registry deletion' } else { ($removeItemCalls -join ' | ') })

$registryWrites = @($lines | Where-Object { $_ -match 'Set-ItemProperty|New-ItemProperty|Remove-ItemProperty|reg\s+(add|delete)|reg\.exe' })
Assert-True ($registryWrites.Count -eq 0) 'the guard never writes, repairs or removes a registry value' `
  $(if ($registryWrites.Count -eq 0) { 'a contaminated host is refused, not cleaned' } else { ($registryWrites -join ' | ') })

Assert-True ($code -match "Record 'destructive cleanup stayed disabled'") `
  'the disabled destructive cleanup is itself a reported check'
Assert-True ($code -match 'ownedProcessesNotShutDown') `
  'unresolved owned process identities are recorded as evidence'
Assert-True ($code -match 'shell_quit_request') `
  'the real quit transport is named, so a forced kill is not mistaken for one'
Assert-True ($code -match 'hides to the tray|WM_CLOSE') `
  'the close-hides-to-tray distinction is stated for the reviewer'

# ---------------------------------------------------------------------------
# 3. NO BYPASS AFFORDANCE.
# ---------------------------------------------------------------------------
$paramBlock = [regex]::Match($code, '(?s)param\(\s*(?<body>.*?)\)\s*\r?\n\r?\n\$ErrorActionPreference').Groups['body'].Value
Assert-True ($paramBlock.Length -gt 0) 'the parameter block was located'
Assert-True ($paramBlock -notmatch '(?i)Force|Bypass|Ignore|Skip|Allow') `
  'the parameter block exposes no force, bypass, ignore, skip or allow override' `
  $(if ($paramBlock -notmatch '(?i)Force|Bypass|Ignore|Skip|Allow') { 'clean' } else { 'override-shaped parameter present' })

Assert-True ($code -notmatch '\$AllowRoot') `
  '-AllowRoot is gone as a parameter: it is what let a run target %TEMP% and a registered installation'
Assert-True ($code -notmatch 'dsh-installed-smoke') `
  'the old shared default target %TEMP%\dsh-installed-smoke is not referenced'

# The launch gate must be reachable only through an explicit attestation, and
# the attestation must be recorded as unverified rather than as a proof.
Assert-True ($code -match 'CleanAccountAttestation') 'an explicit clean-account attestation is required'
Assert-True ($code -match 'cleanAccountAttestationIsMachineVerified\s*=\s*\$false') `
  'the attestation is recorded as NOT machine verified'
Assert-True ($code -match 'UNVERIFIED HUMAN CLAIM') 'the report says the claim is unverified'
Assert-True ($code -match 'WantsLaunch -and -not \$Attested') `
  'the launch gate refuses an un-attested launch'

# ---------------------------------------------------------------------------
# 4. FRESH, DISPOSABLE ROOT.
# ---------------------------------------------------------------------------
Assert-True ($code -match '\[guid\]::NewGuid\(\)') 'the qualification root is UUID-scoped per run'
Assert-True ($code -match 'installed-qualification-\$evidenceId') 'the root lives under the repository scratch tree'
Assert-True ($code -match 'already exists; a qualification root must be fresh') `
  'a reused qualification root is refused rather than clobbered'
Assert-True ($code -match 'Test-FreshQualificationRoot') 'the freshness decision is a named, testable function'
Assert-True ($code -notmatch '\$InstallDir\s*=\s*\$env:TEMP') 'the install target is never derived from %TEMP%'
Assert-True ($code -match 'Join-Path \$Scratch "installed-qualification-') `
  'the qualification root is derived from the repository scratch tree, not from a user temp directory'

# ---------------------------------------------------------------------------
# 5. OWNED ENVIRONMENT ONLY.
# ---------------------------------------------------------------------------
Assert-True ($code -match 'Get-EnvKeysToStrip') 'inherited overrides are stripped by a named policy function'
Assert-True ($code -match 'strippedEnvKeys') 'the stripped variable list is recorded as evidence'
Assert-True ($code -match '\$DevOverrides') 'the development overrides are named and re-asserted absent before launch'

# The complete owned set. DSH_HOME alone was the earlier gap: the Windows
# profile, roaming/local app data and temp are what the Node host, WebView2 and
# spawned tools actually write through.
foreach ($owned in @('DSH_HOME', 'DSH_DESKTOP_USER_DATA_DIR', 'WEBVIEW2_USER_DATA_FOLDER',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')) {
  Assert-True ($code -match ("(?m)^\s*{0}\s*=" -f [regex]::Escape($owned))) "the owned environment declares $owned"
}
Assert-True ($code -match 'function Get-OwnedEnvironment') `
  'the owned environment is built by one shared function, so the contract cannot drift'
Assert-True ($code -match 'every owned environment directory exists before install') `
  'owned directories are created BEFORE the installer runs'
Assert-True ($code -match 'no owned environment variable escapes the fresh root') `
  'every owned path variable is asserted to be inside the fresh root'
Assert-True ($code -match 'no stripped variable survived into the launch environment') `
  'the strip is verified by re-reading the environment, not assumed'
Assert-True ($code -match 'every owned variable is set to its owned value') `
  'the owned values are read back and compared'

# Proxy and Node/toolchain overrides must be rejected with the same policy.
Assert-True ($code -match '(?i)HTTP_PROXY\|HTTPS_PROXY\|ALL_PROXY\|NO_PROXY') `
  'proxy variables are in the strip policy'
Assert-True ($code -match '(?i)NODE_OPTIONS') 'NODE_OPTIONS is in the strip policy'
Assert-True ($code -match '(?i)NODE_EXTRA_CA_CERTS') 'NODE_EXTRA_CA_CERTS is in the strip policy'
Assert-True ($code -match '(?i)npm_config_') 'the npm proxy and registry variables are in the strip policy'
Assert-True ($code -match '(?i)TSX_TSCONFIG_PATH|ESBUILD_BINARY_PATH') `
  'toolchain overrides are in the strip policy'

# ---------------------------------------------------------------------------
# 6. NO LIVE LOG FALLBACK.
# ---------------------------------------------------------------------------
# The previous version read %APPDATA%\DeepSeek Harness\logs, i.e. the LIVE
# installation's log, so a run could false-PASS on another run's readiness line.
Assert-True ($code -match '\$logRoots\s*=\s*@\(\$logDir\)') 'readiness is read only from the owned log directory'

# %APPDATA% / %LOCALAPPDATA% MUST still be named - that is how the footprint
# census finds a contaminated host. What is forbidden is WRITING through them.
# The previous version failed the other way: it never wrote there, but it READ
# the live installation's log, so a run could false-PASS on another run's
# readiness line.
$livePathLines = @($lines | Where-Object { $_ -match '\$env:(APPDATA|LOCALAPPDATA)' })
$livePathWrites = @($livePathLines | Where-Object {
  $_ -match '(?i)^\s*(Set-Content|Out-File|Add-Content|Copy-Item|Move-Item|New-Item|Remove-Item|Set-ItemProperty|New-ItemProperty|Remove-ItemProperty)\b'
})
Assert-True ($livePathWrites.Count -eq 0) 'no live %APPDATA%/%LOCALAPPDATA% path is ever written to' `
  $(if ($livePathWrites.Count -eq 0) { "$($livePathLines.Count) reference(s), all read-only census" } else { ($livePathWrites -join ' | ') })
Assert-True ($livePathLines.Count -gt 0) 'the live paths are still probed, so contamination is detectable' `
  "$($livePathLines.Count) reference(s)"

# ---------------------------------------------------------------------------
# 7. THE READ-ONLY LANE IS NOT INSTALLED ACCEPTANCE.
# ---------------------------------------------------------------------------
Assert-True ($code -match 'ReadOnlyExtractedLayout') 'a separate read-only extracted-layout lane exists'
Assert-True ($code -match 'notInstalledAcceptance\s*=\s*\$true') 'the lane is flagged as NOT installed acceptance'
Assert-True ($code -match 'NOT installed acceptance') 'the operator is told so in the output'
Assert-True ($code -match 'Test-ExtractedLayoutLaneAccepts') 'the lane has its own admission check'
Assert-True ($code -match 'Uninstall is not available in the read-only extracted-layout lane') `
  'the read-only lane cannot uninstall'
Assert-True ($code -match 'Launch is not available in the read-only extracted-layout lane') `
  'the read-only lane cannot launch a release binary'

# ---------------------------------------------------------------------------
# 8. FOOTPRINT COVERAGE.
# ---------------------------------------------------------------------------
foreach ($probe in @(
    'UninstallKeys', 'StartMenuFolderExists', 'ProductDataPaths',
    'WebViewProfileExists', 'LiveProfileExists', 'LiveVaultExists',
    'OtherWebViewProfilesPresent', 'RunningDesktopProcesses')) {
  Assert-True ($code -match [regex]::Escape($probe)) "the footprint census covers $probe"
}
# The credential vault is probed in its own right: a host can hold production
# secrets under .dsh\vault while carrying no desktop profile at all.
Assert-True ($code -match "\.dsh'?\\?vault|vault'") 'the live credential vault is a probed location'
Assert-True ($code -match 'LiveVaultExists') 'a populated vault is its own footprint finding'
Assert-True ($code -match 'OtherWebViewProfiles') `
  'a second WebView2/SDK data directory is probed, not only the shipped identifier'
foreach ($location in @('Uninstall', 'Start Menu', 'StartMenu', 'appdata', 'WebView2', 'desktop profile', 'process')) {
  Assert-True ($code -match [regex]::Escape($location)) "the refusal text names the $location location"
}
Assert-True ($code -match 'WOW6432Node') 'the uninstall census also covers the 32-bit registry view'
Assert-True ($code -match 'ai\.deepseek\.harness\.desktop') 'the identifier-derived WebView2 profile is probed by identifier'

# ---------------------------------------------------------------------------
# 8a. DOMAIN MEMBERSHIP GATES THE CLEAN-ACCOUNT ARGUMENT. Policy: a qualification
# run is valid only on a NON-DOMAIN-JOINED local, disposable account. On a
# domain, credential roaming makes "this account holds no real credentials"
# false. An undetermined state is refused too. Neither is overridable by the
# caller's attestation, which is a human claim.
# ---------------------------------------------------------------------------
Assert-True ($code -match 'function Get-DomainState') 'domain membership is decided by a named function'
Assert-True ($code -match 'Win32_ComputerSystem') 'domain membership is read from Win32_ComputerSystem'
Assert-True ($code -match 'PartOfDomain') 'the read is specifically PartOfDomain'
Assert-True ($code -match "'Joined'") 'a domain-joined host has its own state'
Assert-True ($code -match "'Unknown'") 'an undetermined state is a named state'
Assert-True ($code -match "'Workgroup'") 'a workgroup host is the only clean state'
Assert-True ($code -match 'DomainState') 'the domain state reaches the decision function'
Assert-True ($code -match 'credential roaming|credential roaming') `
  'the refusal explains credential roaming, not just that a flag was set'
# The lookup must be read-only: it observes, it does not enrol or leave.
$domainMutations = @($lines | Where-Object { $_ -match '(?i)\b(JoinDomain|LeaveDomain|Add-Computer|Set-ItemProperty\s+HKLM.*Domain|netdom|net\s+join)' })
Assert-True ($domainMutations.Count -eq 0) 'the domain probe is read-only and joins nothing' `
  $(if ($domainMutations.Count -eq 0) { 'observation only' } else { ($domainMutations -join ' | ') })
# No default-to-workgroup path: the catch body of the domain probe must return
# the UNKNOWN state. This is checked on the catch body specifically, because the
# success path legitimately returns 'Workgroup' just before the catch.
$domainFn = [regex]::Match($code, '(?s)function Get-DomainState \{.*?\n\}').Value
$catchBody = ''
if ($domainFn -match '(?s)\}\s*catch\s*\{(.*)$') { $catchBody = $Matches[1] }
Assert-True ($catchBody -match "'Unknown'") `
  'a failed domain query returns Unknown, never the safe state' `
  $(if ($catchBody -match "'Unknown'") { 'fail-closed default' } else { 'the catch does not return Unknown' })
Assert-True ($catchBody -notmatch 'Workgroup') `
  'there is no catch that defaults a failed domain query to Workgroup' `
  $(if ($catchBody -notmatch 'Workgroup') { 'no assume-safe default' } else { 'the catch defaults to Workgroup' })
# The attestation wording must be the local, non-roaming, unverified claim.
Assert-True ($code -match 'LOCAL, NON-DOMAIN-JOINED') `
  'the attestation names LOCAL, NON-DOMAIN-JOINED'
Assert-True ($code -match 'UNVERIFIED HUMAN CLAIM') 'the attestation stays an unverified human claim'
Assert-True ($code -match 'Not machine verified') 'the report says the claim is not machine verified'
Assert-True ($code -match 'Credential roaming is not checked') `
  'the attestation states that roaming is not checked'

# ---------------------------------------------------------------------------
# 8b. THE CENSUS IS FAIL-CLOSED. A swallowed lookup returns an empty list, which
# is indistinguishable from a clean host. Every failure to LOOK must become a
# finding that refuses the run.
# ---------------------------------------------------------------------------
Assert-True ($code -match 'LookupFailures') 'the census carries an explicit lookup-failure channel'
Assert-True ($code -match 'census incomplete') 'an incomplete census is reported as a finding'
Assert-True ($code -match 'function Get-PathState') 'path existence is tri-state, not Test-Path'
Assert-True ($code -notmatch 'StartMenuFolderExists\s*=\s*\(Test-Path') `
  'the Start-menu probe no longer collapses "absent" and "unreadable"'
Assert-True ($code -notmatch 'WebViewProfileExists\s*=\s*\(Test-Path') `
  'the WebView2 probe no longer collapses "absent" and "unreadable"'
Assert-True ($code -notmatch 'LiveProfileExists\s*=\s*\(Test-Path') `
  'the live-profile probe no longer collapses "absent" and "unreadable"'
Assert-True ($code -match 'Get-CimInstance Win32_Process -ErrorAction Stop') `
  'the process census throws rather than returning an empty set on error'
Assert-True ($code -match 'Get-ChildItem -LiteralPath \$root -ErrorAction Stop') `
  'the registry census throws rather than returning an empty set on error'
Assert-True ($code -match "could not be inspected|could not be enumerated|could not be completed") `
  'each incomplete lookup is described in the refusal text'
# An empty catch that discards a lookup would be the fail-open shape.
$silentCatches = @($lines | Where-Object { $_ -match '^\s*catch\s*\{\s*\}\s*$' })
Assert-True ($silentCatches.Count -eq 0) 'no catch block silently discards a lookup' `
  $(if ($silentCatches.Count -eq 0) { 'every catch records why' } else { ($silentCatches -join ' | ') })

# ---------------------------------------------------------------------------
# 9. BEHAVIOUR: the pure guard self-test.
# ---------------------------------------------------------------------------
Import-Module (Join-Path $PSScriptRoot 'native-quoting.psm1') -Force
$selfTest = Invoke-DshNativeChecked -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source `
  -Arguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $Script, '-GuardSelfTest') `
  -TimeoutSeconds 60
Assert-True ($selfTest.ExitCode -eq 0) 'the guard self-test passes' `
  "exit $($selfTest.ExitCode); pure decision logic, no filesystem, registry or process access"

Write-Host ''
if ($failures.Count -gt 0) {
  Write-Host ("RESULT: FAIL - {0} of {1} guard contract assertions failed:" -f $failures.Count, ($failures.Count + $passes)) -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit (Write-DshSuiteResult -Id 'installed-qualification-guards' -Status 'FAIL' -Detail "$($failures.Count) of $($failures.Count + $passes) guard assertions failed: $(($failures | Select-Object -First 3) -join '; ')")
}
Write-Host ("RESULT: PASS - all {0} guard contract assertions hold." -f $passes) -ForegroundColor Green
exit (Write-DshSuiteResult -Id 'installed-qualification-guards' -Status 'PASS' -Checks $passes -Detail 'the guarded acceptance script keeps its safety contract')
