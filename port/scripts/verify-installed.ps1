<#
.SYNOPSIS
  Acceptance test for the INSTALLED application, with no development overrides.

.DESCRIPTION
  This is the test the independent review asked for and that nothing in this
  repository performed: install the built application, launch it on a clean
  environment, and require it to reach a working state **without** any
  `DSH_DESKTOP_*` variable being set.

  That distinction is the whole point. Every previous "it works" result came from
  the dev path, where `dev-e2e.ps1` points the shell at a staged runtime under
  `port\.scratch\` and `port\ui\dist`. Those runs say nothing about what a user
  gets after installing. Findings F-11, F-12, F-15 and F-17 were all invisible to
  the dev path and only appear here.

  ---------------------------------------------------------------------------
  FAIL-CLOSED ISOLATION CONTRACT (group6 remediation)
  ---------------------------------------------------------------------------
  This script is guard-only from the outside in. It refuses BEFORE it installs,
  before it launches, and before it removes anything, and it never repairs,
  restores or overwrites a same-product footprint it finds.

  1. FRESH ROOT. The qualification root is a NEW directory under
     `port\.scratch\`, named with a fresh UUID per run. `-InstallDir` /
     `-ExtractedRoot` may be supplied, but must resolve inside a fresh
     `port\.scratch\installed-qualification-<uuid>` root that does not yet
     exist. `-AllowRoot` is REMOVED: it was the hole that let a run target
     `%TEMP%` and therefore a registered installation.

  2. SAME-PRODUCT FOOTPRINT -> REFUSE (exit 2), nothing mutated. Detected:
       * `HKCU/HKLM/HKLM-WOW64 ...\CurrentVersion\Uninstall\DeepSeek Harness`
         (the product-identity uninstall registration - `/D=` cannot redirect
         it, so a second install would repoint the live one);
       * the `DeepSeek Harness` Start-menu folder;
       * the product app-data directories `%APPDATA%\DeepSeek Harness`,
         `%LOCALAPPDATA%\DeepSeek Harness`,
         `%LOCALAPPDATA%\Programs\DeepSeek Harness`;
       * the identifier-derived WebView2 profile
         `%LOCALAPPDATA%\ai.deepseek.harness.desktop`;
       * a populated live desktop profile `%USERPROFILE%\.dsh\profiles\desktop`;
       * any running `dsh-desktop.exe` / `DeepSeek Harness.exe` /
         `DeepSeekHarness.exe`, which the stock image-name check would kill.
     The script does not offer a flag, environment variable or switch to
     proceed past any of these. There is no override.

  3. A SAME-USER RELEASE LAUNCH CANNOT BE ISOLATED, SO IT IS GATED. A release
     build cannot be pointed at an owned credential namespace: the namespace
     opt-in is `cfg!(debug_assertions)`-gated
     (`port/src-tauri/app/src/credential_backend.rs`), and boot unconditionally
     reads or CREATES the shared `dsh-desktop:*` OS credential through
     `load_or_create_secret` (`dsh-gateway/src/auth.rs`). `DSH_HOME` relocation
     does not fence secrets, because the OS store is per USER ACCOUNT. So the
     launch lane additionally requires `-Launch` AND `-CleanAccountAttestation`,
     and both are reachable only after every check in (2) has passed - which is
     false on any machine that has ever run this product. `-CleanAccountAttestation`
     is recorded as an UNVERIFIED HUMAN CLAIM, never as a machine proof.

  4. OWNED ENVIRONMENT ONLY. Inherited `DSH_*`, `WEBVIEW2_*` and
     token/secret/password/credential/key-shaped variables are removed from the
     child environment and the removal is recorded. Only then are the owned
     values set: `DSH_HOME`, `DSH_DESKTOP_USER_DATA_DIR` and
     `WEBVIEW2_USER_DATA_FOLDER`, all inside the fresh root. The development
     runtime overrides are asserted ABSENT immediately before launch.

  5. NO LIVE LOG FALLBACKS. Readiness is read only from the owned
     `<root>\user-data\logs`. The previous `%APPDATA%` / `%LOCALAPPDATA%`
     fallbacks read the LIVE installation's log, so a run could false-PASS on
     another run's readiness line.

  6. NO GENERIC FORCED KILL. Shutdown by `Stop-Process -Force` is removed. A
     safe graceful quit for a release artifact needs the reviewed owned native
     UIA authority, which this script does not have, so destructive cleanup is
     DISABLED: the run records the exact owned process identities it could not
     shut down, and reports INCOMPLETE rather than PASS. Product close
     (`WM_CLOSE`, `shell_window_chrome_action`) only hides to the tray; the real
     quit is `shell_quit_request` on the owned gateway origin or a scoped
     UIA `Exit` InvokePattern.

  7. `-ReadOnlyExtractedLayout` IS A SEPARATE, WEAKER LANE. It inspects an
     externally produced extraction and performs read-only layout assertions
     only. It never installs, extracts, launches or uninstalls, and its result
     is EXPLICITLY NOT installed acceptance: it establishes nothing about
     registry registration, Start-menu shortcuts, updater hooks, `/UPDATE`
     relaunch or uninstaller behaviour.

.PARAMETER InstallerPath
  The NSIS installer. Defaults to the newest under
  port\src-tauri\target\release\bundle\nsis. Not used by
  -ReadOnlyExtractedLayout except as an optional size gate.

.PARAMETER InstallDir
  Install target for the install lane. Defaults to `<fresh root>\app`. Must
  contain no spaces (NSIS `/D=` cannot be quoted) and must be inside a fresh
  qualification root.

.PARAMETER ExtractedRoot
  Root of an externally produced extraction, for -ReadOnlyExtractedLayout.
  This script never creates or extracts it.

.PARAMETER Launch
  Opt in to the cold-launch phase. Requires -CleanAccountAttestation and a
  footprint-free host. Even then the run cannot finish as PASS, because safe
  graceful shutdown is out of scope for this script.

.PARAMETER CleanAccountAttestation
  The caller's assertion that the current OS user account holds NO real
  `dsh-desktop:*` credentials and is a disposable qualification account. This
  is a human claim that the script records and cannot verify.

.PARAMETER WaitSeconds
  How long to wait for the gateway to bind.

.PARAMETER RequireNoSystemNode
  Remove every system Node directory from PATH for the launch and require the
  application to reach readiness anyway.

.PARAMETER UpgradeFromProfile
  Seed the isolated home with a profile directory. The source must itself be
  inside a scratch root and must NOT be the live `$DSH_HOME`.

.PARAMETER Uninstall
  Run the uninstaller from the fresh qualification root and verify removal.
  Refused outside a fresh scratch root.

.PARAMETER GuardSelfTest
  Run the guard decision logic against synthetic probes and exit. Touches no
  filesystem, registry, or process. Used by
  port\tests\packaging\verify-installed-guards.ps1.
#>
[CmdletBinding()]
param(
  [string]$InstallerPath,
  [string]$InstallDir,
  [string]$ExtractedRoot,
  [int]$WaitSeconds = 120,
  [switch]$RequireNoSystemNode,
  [string]$UpgradeFromProfile,
  [switch]$Uninstall,
  [switch]$Launch,
  [switch]$CleanAccountAttestation,
  [switch]$ReadOnlyExtractedLayout,
  [switch]$GuardSelfTest
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# ASCII-ONLY (finding F-27): Windows PowerShell 5.1 decodes a BOM-less .ps1 as
# ANSI, so a single em-dash breaks parsing mid-line.
$ProductName = 'DeepSeek Harness'
$ProductIdentifier = 'ai.deepseek.harness.desktop'
$MainBinaryName = 'dsh-desktop'
$DesktopProcessNames = @('dsh-desktop.exe', 'DeepSeek Harness.exe', 'DeepSeekHarness.exe')

$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
$TauriDir = Join-Path $PortRoot 'src-tauri'
$Scratch = Join-Path $PortRoot '.scratch'
# The live Harness home. Never read, never written, never launched against.
$LiveHome = Join-Path $env:USERPROFILE '.dsh'
$LiveProfile = Join-Path $LiveHome 'profiles\desktop'
# The credential vault inside the live home. Named separately because a host can
# carry production secrets here while carrying no desktop profile at all, and
# probing only the profile would read such a host as clean.
$LiveVault = Join-Path $LiveHome 'vault'
# The second WebView2 runtime: a different product identity gets its own
# identifier-derived data directory, and so does any SDK/beta side-by-side.
$OtherWebViewProfiles = @(
  (Join-Path $env:LOCALAPPDATA ($ProductIdentifier + '.WebView2')),
  (Join-Path $env:LOCALAPPDATA ($ProductIdentifier + '.SDK')),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\EdgeWebView\Application')
)

# ===========================================================================
# PURE GUARD LOGIC (no I/O). Extracted so it can be unit tested with synthetic
# probes by -GuardSelfTest, and so the contract is reviewable as logic rather
# than as a sequence of statements buried in a run.
# ===========================================================================

function Resolve-FullPath([string]$Path) {
  # Resolve without requiring the leaf to exist yet, so a not-yet-created target
  # is still validated against its parent.
  $full = [System.IO.Path]::GetFullPath($Path)
  return $full.TrimEnd('\', '/')
}

function Test-Under([string]$Path, [string]$Root) {
  $p = (Resolve-FullPath $Path).ToLowerInvariant()
  $r = (Resolve-FullPath $Root).ToLowerInvariant()
  return $p -eq $r -or $p.StartsWith($r + '\')
}

function Test-FreshQualificationRoot([string]$Path, [string]$ScratchRoot) {
  # Returns @(<ok>, <reason>). A qualification root is FRESH: it must be inside
  # the repository scratch tree and must not already exist. Reuse is refused
  # because a reused root can hold a previous install, and clobbering it is the
  # exact damage this contract exists to prevent.
  if (-not (Test-Under $Path $ScratchRoot)) {
    return @($false, "not inside the scratch tree $ScratchRoot")
  }
  if (Test-Under $Path $LiveHome) {
    return @($false, "inside the live Harness home $LiveHome")
  }
  if (Test-Path $Path) {
    return @($false, "already exists; a qualification root must be fresh")
  }
  return @($true, '')
}

function Get-SameProductFootprintFindings {
  <#
    .SYNOPSIS
      Decide whether the host carries a same-product footprint.
    .DESCRIPTION
      Pure: every input arrives in -Probes, nothing is read from the machine.
      Returns a list of finding strings; an empty list means the host is clean
      AND the census was able to look at everything it needed to look at.

      An INCOMPLETE census is itself a finding. A lookup that could not be
      performed - access denied, a registry view that would not enumerate, a
      process query that threw - must never be reported as "nothing found",
      because "I could not see it" and "it is not there" are different answers
      and only the first one is true.
  #>
  param([hashtable]$Probes)

  $findings = @()

  # Fail-closed FIRST: an incomplete census outranks every other finding,
  # because every other finding is drawn from a partial picture.
  if ($Probes.ContainsKey('LookupFailures')) {
    foreach ($failure in @($Probes['LookupFailures'])) {
      if ($failure) { $findings += "footprint census incomplete: $failure" }
    }
  }

  foreach ($entry in $Probes['UninstallKeys']) {
    $findings += ("same-product uninstall registration exists: {0} -> {1}" -f $entry['Path'], $entry['InstallLocation'])
  }
  if ($Probes['StartMenuFolderExists']) {
    $findings += ("Start-menu folder exists: {0}" -f $Probes['StartMenuFolderPath'])
  }
  foreach ($path in $Probes['ProductDataPaths']) {
    if ($Probes['ProductDataPresent'] -contains $path) {
      $findings += ("product app-data exists: {0}" -f $path)
    }
  }
  if ($Probes['WebViewProfileExists']) {
    $findings += ("identifier-derived WebView2 profile exists: {0}" -f $Probes['WebViewProfilePath'])
  }
  if ($Probes['LiveProfileExists']) {
    $findings += ("live desktop profile exists: {0}" -f $Probes['LiveProfilePath'])
  }
  # Domain membership gates the CLEAN-ACCOUNT ARGUMENT, not the footprint.
  # 'Joined' invalidates the whole premise: Windows Credential Manager entries
  # can roam with a domain profile, so "this local account holds no real
  # credentials" stops being true the moment the machine is on a domain. 'Unknown'
  # is refused for the same reason the rest of the census is: a machine that
  # would not answer cannot be assumed to be the safe case. Neither is
  # overridable by the caller's attestation, which is a human claim.
  if ($Probes.ContainsKey('DomainState')) {
    switch ($Probes['DomainState']) {
      'Joined' {
        $findings += 'this host is joined to an Active Directory domain; credential roaming makes a local clean-account claim unsafe, so a qualification run must use a workgroup or standalone host'
      }
      'Unknown' {
        $findings += 'the domain-joined state could not be determined; a local, non-roaming account cannot be assumed, so the run is refused'
      }
    }
  }
  if ($Probes.ContainsKey('LiveVaultExists') -and $Probes['LiveVaultExists']) {
    $findings += ("live credential vault exists: {0}" -f $Probes['LiveVaultPath'])
  }
  if ($Probes.ContainsKey('OtherWebViewProfilesPresent')) {
    foreach ($path in @($Probes['OtherWebViewProfilesPresent'])) {
      $findings += ("a second WebView2 data directory exists: {0}" -f $path)
    }
  }
  foreach ($process in $Probes['RunningDesktopProcesses']) {
    $findings += ("same-product process running: {0} (pid {1})" -f $process, $Probes['RunningProcessDetail'])
  }

  # Wrapped so an empty result is an empty ARRAY, not $null: PowerShell
  # enumerates `@()` away on return, and `.Count` on $null is a StrictMode error.
  return ,$findings
}

function Test-LaunchAuthorized {
  <#
    .SYNOPSIS
      Whether the cold-launch phase may proceed at all.
    .DESCRIPTION
      Pure. Two independent conditions, both mandatory:
        1. no same-product footprint anywhere (already refused upstream, but
           re-asserted here so this function is safe to call on its own);
        2. an explicit clean-account attestation, because a RELEASE build cannot
           be fenced from the shared per-user OS credential store.
      There is deliberately no third condition and no environment override.
  #>
  param(
    [string[]]$FootprintFindings,
    [bool]$WantsLaunch,
    [bool]$Attested
  )
  $reasons = @()
  $findingCount = 0
  if ($FootprintFindings) { $findingCount = @($FootprintFindings).Count }
  if ($findingCount -gt 0) {
    $reasons += 'a same-product footprint is present on this host'
  }
  if ($WantsLaunch -and -not $Attested) {
    $reasons += 'a release build reads the shared per-user OS credential store on boot, so a launch requires -CleanAccountAttestation'
  }
  $authorized = ($reasons.Count -eq 0)
  return [pscustomobject]@{ Authorized = $authorized; Reasons = $reasons }
}

function Test-ExtractedLayoutLaneAccepts {
  <#
    .SYNOPSIS
      Whether the read-only extracted-layout lane is internally consistent.
    .DESCRIPTION
      Pure. The weaker lane must never be able to install, extract, launch or
      uninstall, and must require an explicit extraction root.
  #>
  param([string]$Root, [bool]$Uninstall, [bool]$Launch)
  $reasons = @()
  if ([string]::IsNullOrWhiteSpace($Root)) { $reasons += '-ExtractedRoot is required' }
  if ($Uninstall) { $reasons += '-Uninstall is not available in the read-only extracted-layout lane' }
  if ($Launch) { $reasons += '-Launch is not available in the read-only extracted-layout lane; it never runs a release binary' }
  return [pscustomobject]@{ Accepts = ($reasons.Count -eq 0); Reasons = $reasons }
}

function Get-EnvKeysToStrip {
  <#
    .SYNOPSIS
      Environment variable names that must not reach a qualification child.
    .DESCRIPTION
      Pure. Four families, each with a concrete way of re-pointing the run at
      live or non-representative state:

        1. `DSH_*`     - every product override, including the development
                         runtime overrides this test exists to prove are absent.
        2. `WEBVIEW2_*`- the WebView2 profile and browser arguments, which would
                         otherwise attach to the live identifier profile.
        3. proxy      - HTTP(S)_PROXY / ALL_PROXY / NO_PROXY / npm_config_proxy.
                         A qualification run routed through a corporate proxy
                         is not evidence about the shipped configuration, and a
                         proxy that fails open can silently answer for the app.
        4. Node and
           toolchain  - NODE_OPTIONS and friends can inject a `--require`,
                         redirect a resolver, or point at a different
                         certificate/CA store, none of which a shipped
                         installation does.

      The child receives ONLY the owned values set afterwards, so a stale
      variable can never silently re-point the run at live state.
  #>
  param([string[]]$Names)
  $strip = @()
  $secretish = '(?i:(?:TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|(?:API|ACCESS|PRIVATE|SIGNING)[_-]?KEY|_KEY$))'
  $proxyish = '(?i:^(?:HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|PROXY|FTP_PROXY|npm_config_(?:proxy|https_proxy|strict_ssl)|NPM_CONFIG_(?:PROXY|HTTPS_PROXY|STRICT_SSL))$)'
  $nodeish = '(?i:^(?:NODE_(?:OPTIONS|PATH|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED|REPLACEMENT|OPTIONS_ALLOW_UNSUPPORTED_ESM|DEBUG|NO_WARNINGS|COMPILE_CACHE|AMARO|INSTANCE_ID|_MODULES|ENABLE_SOURCE_MAPS|PRESERVE_SYMLINKS|PENDING_DEPRECATION)|ESBUILD_BINARY_PATH|TSX_TSCONFIG_PATH|NPM_CONFIG_(?:USERCONFIG|GLOBALCONFIG|CACHE|PREFIX|REGISTRY))$)'
  foreach ($name in $Names) {
    if ($name -match '^(?i:DSH_|WEBVIEW2_)') { $strip += $name; continue }
    if ($name -match $proxyish) { $strip += $name; continue }
    if ($name -match $nodeish) { $strip += $name; continue }
    if ($name -match $secretish) { $strip += $name; continue }
  }
  return ,@($strip | Sort-Object -Unique)
}

function Test-OwnedEnvironmentComplete {
  <#
    .SYNOPSIS
      Whether the owned environment declares exactly the required variable set.
    .DESCRIPTION
      Pure. A partial owned environment is a silent isolation failure: the run
      would pass every DSH_* assertion and still write logs, caches and temp
      files into the live Windows profile.
  #>
  param([string[]]$Expected, [string[]]$Actual)
  $missing = @($Expected | Where-Object { $Actual -notcontains $_ })
  $extra = @($Actual | Where-Object { $Expected -notcontains $_ })
  return [pscustomobject]@{
    Complete = (($missing.Count -eq 0) -and ($extra.Count -eq 0))
    Missing = $missing
    Extra = $extra
  }
}

function Get-OwnedEnvironment {
  <#
    .SYNOPSIS
      The complete owned environment for a qualification child, rooted at $Root.
    .DESCRIPTION
      One function, used by both the self-test and the launch, so the contract
      cannot drift between what is asserted and what is set.

      DSH_HOME and DSH_DESKTOP_USER_DATA_DIR are what the Rust core actually
      resolves (dsh-core/src/paths.rs honours both explicitly, so the
      SHGetKnownFolderPath default does not apply). WEBVIEW2_USER_DATA_FOLDER
      is what moves the identifier-derived WebView2 profile. HOME, USERPROFILE,
      HOMEDRIVE, HOMEPATH, APPDATA, LOCALAPPDATA, TEMP and TMP are what the Node
      host, WebView2 and any spawned tool read for caches, config, temp files
      and logs; leaving those inherited is how a "clean" qualification run ends
      up writing into the live account profile.
  #>
  param([string]$Root)
  $profile = Join-Path $Root 'profile'
  $full = Resolve-FullPath $profile
  # HOMEDRIVE is conventionally 'C:' with NO trailing separator, and HOMEPATH
  # carries the leading one. GetPathRoot returns 'C:\', so it is trimmed here or
  # the concatenation yields a doubled separator.
  $drive = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')
  $tail = $full.Substring($drive.Length)
  if (-not $tail.StartsWith('\')) { $tail = '\' + $tail }
  return [ordered]@{
    DSH_HOME = (Join-Path $Root 'home')
    DSH_DESKTOP_USER_DATA_DIR = (Join-Path $Root 'user-data')
    WEBVIEW2_USER_DATA_FOLDER = (Join-Path $Root 'user-data\webview')
    HOME = $profile
    USERPROFILE = $profile
    HOMEDRIVE = $drive
    HOMEPATH = $tail
    APPDATA = (Join-Path $Root 'appdata')
    LOCALAPPDATA = (Join-Path $Root 'localappdata')
    TEMP = (Join-Path $Root 'temp')
    TMP = (Join-Path $Root 'temp')
  }
}

$DevOverrides = @(
  'DSH_DESKTOP_RUNTIME_DIR', 'DSH_DESKTOP_RUNTIME_ADAPTER', 'DSH_DESKTOP_SHELL_DIR',
  'DSH_DESKTOP_NODE', 'DSH_DESKTOP_DEV_URL_FILE', 'DSH_DESKTOP_DEV_BOOT_FILE',
  'DSH_DESKTOP_PRIMARY_RUNTIME_DIR'
)

# ===========================================================================
# READ-ONLY PROBES. These observe; they never create, repair, move or delete
# anything. Each returns data that the pure guard functions above decide on.
# ===========================================================================

function Get-PathState([string]$Path) {
  <#
    .SYNOPSIS
      Tri-state existence check: 'Present', 'Absent' or 'Unknown'.
    .DESCRIPTION
      `Test-Path` is deliberately NOT used for the census. `Test-Path` returns
      $false both for "does not exist" and for "I was not allowed to look", and
      a protected location must not be allowed to read as a clean host. Only an
      explicit item-not-found is 'Absent'; anything else is 'Unknown' and the
      caller records a lookup failure, which refuses the run.
  #>
  try {
    $null = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    return 'Present'
  } catch [System.Management.Automation.ItemNotFoundException] {
    return 'Absent'
  } catch {
    return 'Unknown'
  }
}

function Get-DomainState {
  <#
    .SYNOPSIS
      Read-only domain-membership state: 'Joined', 'Workgroup' or 'Unknown'.
    .DESCRIPTION
      One CIM read of Win32_ComputerSystem.PartOfDomain. Nothing is written and
      nothing is configured; this observes, it does not enrol or leave.

      'Unknown' is a FAILURE state and never a pass. The entire clean-account
      argument rests on credentials not roaming, and a machine that will not
      answer cannot be assumed to be the safe case. There is deliberately no
      default-to-workgroup path, because that default would be a bypass.
  #>
  try {
    $system = @(Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop)
    if ($system.Count -ne 1) { return 'Unknown' }
    # Under Set-StrictMode a property the class did not publish throws rather
    # than returning $null, so it is looked up the non-throwing way.
    $property = $system[0].PSObject.Properties['PartOfDomain']
    if ($null -eq $property) { return 'Unknown' }
    if ($property.Value) { return 'Joined' }
    return 'Workgroup'
  } catch {
    return 'Unknown'
  }
}

function Get-LiveFootprintProbes {
  <#
    .SYNOPSIS
      Read-only census of every same-product location on this host.
    .DESCRIPTION
      Deliberately observation only. The contract is that a contaminated host
      is REFUSED, not cleaned: a script that repaired the footprint would be a
      script that had already decided the live installation was disposable.

      Every lookup that cannot complete is captured in LookupFailures rather
      than swallowed. An empty result and a failed lookup are different
      answers, and conflating them would make an unreadable location look clean.
  #>
  $lookupFailures = @()

  $uninstallKeys = @()
  $uninstallRoots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $uninstallRoots) {
    # A registry view that does not exist on this host is NOT APPLICABLE, not a
    # failure: WOW6432Node is absent on a 32-bit Windows. A view that exists but
    # refuses to enumerate IS a failure, because then a live registration could
    # be hiding in it.
    $viewState = Get-PathState -Path $root
    if ($viewState -eq 'Absent') { continue }
    if ($viewState -eq 'Unknown') {
      $lookupFailures += "the uninstall registry view '$root' could not be inspected"
      continue
    }
    try {
      foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
        # Under Set-StrictMode, reading a value the key does not have THROWS
        # rather than returning $null. Most uninstall keys have no DisplayName,
        # so a direct property read would abort the whole enumeration - and the
        # previous version swallowed exactly that, silently skipping real
        # uninstall keys and reading as a clean host. PSObject.Properties is
        # the non-throwing lookup.
        $name = ''
        $installLocation = ''
        $readable = $true
        try {
          $props = Get-ItemProperty $key.PSPath -ErrorAction Stop
          $nameProperty = $props.PSObject.Properties['DisplayName']
          if ($nameProperty) { $name = [string]$nameProperty.Value }
          $locationProperty = $props.PSObject.Properties['InstallLocation']
          if ($locationProperty) { $installLocation = [string]$locationProperty.Value }
        } catch {
          $readable = $false
          $lookupFailures += "uninstall key '$($key.PSPath)' could not be read: $($_.Exception.Message)"
        }
        if (-not $readable) { continue }
        if ($name -ieq $ProductName -or $key.PSChildName -ieq $ProductName) {
          $uninstallKeys += @{ Path = $key.PSPath; InstallLocation = $installLocation }
        }
      }
    } catch {
      $lookupFailures += "the uninstall registry view '$root' could not be enumerated: $($_.Exception.Message)"
    }
  }

  $startMenu = Join-Path $env:APPDATA ('Microsoft\Windows\Start Menu\Programs\' + $ProductName)
  $productData = @(
    (Join-Path $env:APPDATA $ProductName),
    (Join-Path $env:LOCALAPPDATA $ProductName),
    (Join-Path $env:LOCALAPPDATA ('Programs\' + $ProductName))
  )
  $present = @()
  $states = @{}
  foreach ($path in $productData) {
    $state = Get-PathState -Path $path
    $states[$path] = $state
    if ($state -eq 'Present') { $present += $path }
    if ($state -eq 'Unknown') { $lookupFailures += "product app-data location '$path' could not be inspected" }
  }

  $webView = Join-Path $env:LOCALAPPDATA $ProductIdentifier
  $webViewState = Get-PathState -Path $webView
  if ($webViewState -eq 'Unknown') { $lookupFailures += "WebView2 profile '$webView' could not be inspected" }

  $profileState = Get-PathState -Path $LiveProfile
  if ($profileState -eq 'Unknown') { $lookupFailures += "live desktop profile '$LiveProfile' could not be inspected" }

  $vaultState = Get-PathState -Path $LiveVault
  if ($vaultState -eq 'Unknown') { $lookupFailures += "live credential vault '$LiveVault' could not be inspected" }

  # A second WebView2 data directory means another product identity has run on
  # this account. Probing only the shipped identifier would miss it.
  $otherWebView = @()
  foreach ($path in $OtherWebViewProfiles) {
    $state = Get-PathState -Path $path
    if ($state -eq 'Present') { $otherWebView += $path }
    if ($state -eq 'Unknown') { $lookupFailures += "WebView2 data directory '$path' could not be inspected" }
  }

  $domainState = Get-DomainState

  $running = @()
  $detail = ''
  try {
    $rows = @(Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object { $DesktopProcessNames -contains $_.Name })
    $running = @($rows | ForEach-Object { $_.Name })
    if ($rows.Count -gt 0) {
      $detail = (@($rows | ForEach-Object { "$($_.ProcessId)@$($_.ExecutablePath)" }) -join ', ')
    }
  } catch {
    $lookupFailures += "the running-process census could not be completed: $($_.Exception.Message)"
  }

  return @{
    UninstallKeys = $uninstallKeys
    StartMenuFolderExists = ((Get-PathState -Path $startMenu) -eq 'Present')
    StartMenuFolderPath = $startMenu
    ProductDataPaths = $productData
    ProductDataPresent = $present
    ProductDataStates = $states
    WebViewProfileExists = ($webViewState -eq 'Present')
    WebViewProfilePath = $webView
    LiveProfileExists = ($profileState -eq 'Present')
    LiveProfilePath = $LiveProfile
    LiveVaultExists = ($vaultState -eq 'Present')
    LiveVaultPath = $LiveVault
    OtherWebViewProfilesPresent = $otherWebView
    # Carried explicitly rather than folded into LookupFailures: this one is a
    # DECISION input, and the finding text has to be able to say why a
    # workgroup host is acceptable and a domain host is not.
    DomainState = $domainState
    RunningDesktopProcesses = $running
    RunningProcessDetail = $detail
    LookupFailures = $lookupFailures
  }
}

function Get-InstallerPayloadListing {
  <#
    .SYNOPSIS
      Text listing of an NSIS installer's payload, read WITHOUT running it.
    .DESCRIPTION
      Uses 7-Zip if present. Listing is what makes the payload gate honest: a
      real stale build passed the 40 MB size gate while carrying neither the
      pinned Node nor the @dsh-port packages, so size alone is not evidence.
  #>
  param([string]$Path)
  if (-not $Path -or -not (Test-Path $Path)) { return $null }
  $sevenZip = @(
    (Join-Path $env:ProgramFiles '7-Zip\7z.exe'),
    (Join-Path ${env:ProgramFiles(x86)} '7-Zip\7z.exe')
  ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if (-not $sevenZip) {
    $command = Get-Command 7z -ErrorAction SilentlyContinue
    if ($command) { $sevenZip = $command.Source }
  }
  if (-not $sevenZip) { return $null }
  try {
    return (& $sevenZip l $Path 2>&1 | Out-String)
  } catch {
    return $null
  }
}

function Test-InstallerArtifact {
  <#
    .SYNOPSIS
      Size gate for an installer that this script is NOT about to run.
  #>
  param([string]$Path)
  $rows = @()
  if (-not $Path -or -not (Test-Path $Path)) {
    return @([pscustomobject]@{ Name = 'installer exists'; Status = 'FAIL'; Detail = "not found: $Path" })
  }
  $file = Get-Item $Path
  $sizeMb = [math]::Round($file.Length / 1MB, 1)
  $rows += [pscustomobject]@{ Name = 'installer exists'; Status = 'PASS'; Detail = "$($file.Name), $sizeMb MB, $($file.LastWriteTime)" }
  $rows += [pscustomobject]@{
    Name = 'installer is not the stale empty artifact'
    Status = $(if ($sizeMb -lt 40) { 'FAIL' } else { 'PASS' })
    Detail = "$sizeMb MB (threshold 40 MB; necessary, not sufficient)"
  }
  return $rows
}

function Test-InstalledLayout {
  <#
    .SYNOPSIS
      Layout assertions for a runtime tree. Strictly read-only.
    .DESCRIPTION
      Works unchanged for an INSTALLED tree and for an externally produced
      EXTRACTION. It proves nothing about registry, shortcuts, updater hooks or
      the uninstaller; it is the payload-completeness half of the evidence only.
  #>
  param([string]$AppDir)

  $rows = @()
  if (-not (Test-Path $AppDir)) {
    return @([pscustomobject]@{ Name = 'application tree present'; Status = 'FAIL'; Detail = "not found: $AppDir" })
  }

  $appExe = Get-ChildItem $AppDir -Filter "$MainBinaryName.exe" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $appExe) {
    return @([pscustomobject]@{ Name = 'application executable present'; Status = 'FAIL'; Detail = "no $MainBinaryName.exe under $AppDir" })
  }
  $rows += [pscustomobject]@{ Name = 'application executable present'; Status = 'PASS'; Detail = $appExe.FullName }
  $exDir = $appExe.DirectoryName

  $adapter = Join-Path $exDir 'dsh\adapter.mjs'
  $rows += [pscustomobject]@{
    Name = 'runtime adapter present'
    Status = $(if (Test-Path $adapter) { 'PASS' } else { 'FAIL' })
    Detail = $adapter
  }

  foreach ($anchor in @('dsh', 'cordis-plugin-group', 'dsh-base', 'dsh-web-app')) {
    $pkgDir = Join-Path $exDir "dsh\node_modules\@deepseek-ai\$anchor"
    $marker = Join-Path $pkgDir 'package.json'
    if (-not (Test-Path $marker)) {
      $rows += [pscustomobject]@{ Name = "runtime package $anchor"; Status = 'FAIL'; Detail = "$marker missing" }
      continue
    }
    # `Test-Path` FOLLOWS links, so existence alone does not prove a real
    # directory (F-15, F-20).
    $item = Get-Item $pkgDir -Force -ErrorAction SilentlyContinue
    $isLink = $item -and [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    $rows += [pscustomobject]@{
      Name = "runtime package $anchor"
      Status = $(if ($isLink) { 'FAIL' } else { 'PASS' })
      Detail = $(if ($isLink) { 'present but is a junction/symlink, not a real directory' } else { 'real directory' })
    }
  }

  # The port-owned packages the desktop profile selects and the browser row it
  # serves. Without both, a fresh profile composes an unresolved bundle.
  $portPackages = @(
    @{ Dir = '@dsh-port\dsh-desktop-updates-bundle'; Files = @('package.json', 'cordis.patch.yml') },
    @{ Dir = '@dsh-port\dsh-client-ui-updates'; Files = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js') }
  )
  foreach ($package in $portPackages) {
    $pkgDir = Join-Path $exDir ('dsh\node_modules\' + $package.Dir)
    $missing = @($package.Files | Where-Object { -not (Test-Path (Join-Path $pkgDir $_)) })
    $item = Get-Item $pkgDir -Force -ErrorAction SilentlyContinue
    $isLink = $item -and [bool]($item.Attributes -band [IO.FileAttributes]::ReparsePoint)
    if ($missing.Count -gt 0) {
      $rows += [pscustomobject]@{ Name = "port package $($package.Dir)"; Status = 'FAIL'; Detail = "missing: $($missing -join ', ')" }
    } elseif ($isLink) {
      $rows += [pscustomobject]@{ Name = "port package $($package.Dir)"; Status = 'FAIL'; Detail = 'present but is a junction/symlink, not a real directory' }
    } else {
      $rows += [pscustomobject]@{ Name = "port package $($package.Dir)"; Status = 'PASS'; Detail = 'real directory with all shipped files' }
    }
  }

  $assets = Join-Path $exDir 'ui\assets'
  $rows += [pscustomobject]@{
    Name = 'UI assets present'
    Status = $(if (Test-Path $assets) { 'PASS' } else { 'FAIL' })
    Detail = $assets
  }

  # The decisive F-15 check: a junction farm copies into the bundle as nothing.
  $nm = Join-Path $exDir 'dsh\node_modules'
  if (Test-Path $nm) {
    $links = @(Get-ChildItem $nm -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    $deepLinks = @(Get-ChildItem $nm -Recurse -Force -Directory -ErrorAction SilentlyContinue -Depth 3 |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
    $all = @($links + $deepLinks | Select-Object -Unique FullName)
    $rows += [pscustomobject]@{
      Name = 'no reparse points under node_modules'
      Status = $(if ($all.Count -eq 0) { 'PASS' } else { 'FAIL' })
      Detail = $(if ($all.Count -eq 0) { 'all real directories' } else { "$($all.Count) junction(s)/symlink(s), e.g. $($all[0])" })
    }
  } else {
    $rows += [pscustomobject]@{ Name = 'no reparse points under node_modules'; Status = 'FAIL'; Detail = 'node_modules missing entirely' }
  }

  $bundledNode = Join-Path $exDir 'dsh\node\node.exe'
  $rows += [pscustomobject]@{
    Name = 'pinned Node travels inside the payload'
    Status = $(if (Test-Path $bundledNode) { 'PASS' } else { 'FAIL' })
    Detail = $(if (Test-Path $bundledNode) { $bundledNode } else { 'dsh\node\node.exe missing; the payload is not self-contained' })
  }

  $deepest = 0
  if (Test-Path $nm) {
    Get-ChildItem $nm -Recurse -Force -File -ErrorAction SilentlyContinue |
      ForEach-Object { if ($_.FullName.Length -gt $deepest) { $deepest = $_.FullName.Length } }
  }
  $rows += [pscustomobject]@{
    Name = 'paths under MAX_PATH'
    Status = $(if ($deepest -lt 260) { 'PASS' } else { 'FAIL' })
    Detail = "deepest path $deepest chars"
  }

  return $rows
}

function Get-NodeOnPath {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  return $null
}
function Get-PathWithoutNode {
  $kept = @()
  foreach ($entry in ($env:PATH -split ';')) {
    if ([string]::IsNullOrWhiteSpace($entry)) { continue }
    $hasNode = Test-Path (Join-Path $entry 'node.exe') -ErrorAction SilentlyContinue
    if (-not $hasNode) { $kept += $entry }
  }
  return ($kept -join ';')
}

# ===========================================================================
# SELF TEST: pure, no filesystem, no registry, no process. Exits before any
# other work so it can never install, launch or remove anything.
# ===========================================================================
if ($GuardSelfTest) {
  $failures = @()
  function SelfAssert([string]$Name, [bool]$Condition) {
    if ($Condition) { Write-Host ("  [PASS] {0}" -f $Name) }
    else { Write-Host ("  [FAIL] {0}" -f $Name); $script:failures += $Name }
  }
  function Clean-Probes {
    return @{
      UninstallKeys = @()
      StartMenuFolderExists = $false
      StartMenuFolderPath = ''
      ProductDataPaths = @()
      ProductDataPresent = @()
      ProductDataStates = @{}
      WebViewProfileExists = $false
      WebViewProfilePath = ''
      LiveProfileExists = $false
      LiveProfilePath = ''
      LiveVaultExists = $false
      LiveVaultPath = ''
      OtherWebViewProfilesPresent = @()
      DomainState = 'Workgroup'
      RunningDesktopProcesses = @()
      RunningProcessDetail = ''
      LookupFailures = @()
    }
  }

  # 1. A clean host produces no finding, and any single contamination does.
  SelfAssert 'clean host produces no footprint finding' `
    ((Get-SameProductFootprintFindings -Probes (Clean-Probes)).Count -eq 0)

  $case = Clean-Probes
  $case['UninstallKeys'] = @(@{ Path = 'HKCU\...\Uninstall\DeepSeek Harness'; InstallLocation = 'C:\x' })
  SelfAssert 'an existing uninstall registration is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  $case = Clean-Probes
  $case['StartMenuFolderExists'] = $true
  $case['StartMenuFolderPath'] = 'C:\Start\DeepSeek Harness'
  SelfAssert 'an existing Start-menu folder is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  $case = Clean-Probes
  $case['ProductDataPaths'] = @('C:\a', 'C:\b')
  $case['ProductDataPresent'] = @('C:\b')
  SelfAssert 'product app-data is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  $case = Clean-Probes
  $case['WebViewProfileExists'] = $true
  $case['WebViewProfilePath'] = 'C:\Users\u\AppData\Local\ai.deepseek.harness.desktop'
  SelfAssert 'the identifier WebView2 profile is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  $case = Clean-Probes
  $case['LiveProfileExists'] = $true
  $case['LiveProfilePath'] = 'C:\Users\u\.dsh\profiles\desktop'
  SelfAssert 'a populated live desktop profile is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  # A host can carry production secrets and no desktop profile at all, so the
  # vault is probed in its own right rather than inferred from the profile.
  $case = Clean-Probes
  $case['LiveVaultExists'] = $true
  $case['LiveVaultPath'] = 'C:\Users\u\.dsh\vault'
  SelfAssert 'a populated credential vault is a finding even with no profile' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)
  SelfAssert 'the vault finding names the vault path' `
    ((Get-SameProductFootprintFindings -Probes $case)[0] -match 'credential vault')

  $case = Clean-Probes
  $case['OtherWebViewProfilesPresent'] = @('C:\Users\u\AppData\Local\ai.deepseek.harness.desktop.WebView2')
  SelfAssert 'a second WebView2 data directory is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  # 1c. DOMAIN MEMBERSHIP. The clean-account argument is only valid on a
  # workgroup/standalone host: on a domain, credential roaming makes "this
  # local account holds no real credentials" false. A machine that will not
  # answer is refused too, and neither is overridable by the attestation.
  $case = Clean-Probes
  $case['DomainState'] = 'Joined'
  $joinedFindings = Get-SameProductFootprintFindings -Probes $case
  SelfAssert 'a domain-joined host is a finding' ($joinedFindings.Count -eq 1)
  SelfAssert 'the domain finding names credential roaming' `
    ($joinedFindings[0] -match 'domain' -and $joinedFindings[0] -match 'roam')
  $case = Clean-Probes
  $case['DomainState'] = 'Unknown'
  $unknownFindings = Get-SameProductFootprintFindings -Probes $case
  SelfAssert 'an undetermined domain state is a finding, not a pass' ($unknownFindings.Count -eq 1)
  SelfAssert 'an undetermined domain state is named as such' `
    ($unknownFindings[0] -match 'could not be determined')
  SelfAssert 'a workgroup host produces no domain finding' `
    ((Get-SameProductFootprintFindings -Probes (Clean-Probes)).Count -eq 0)
  # The decisive pair: an attestation is a HUMAN claim and must not buy a way
  # past either state.
  $joinedAttested = Test-LaunchAuthorized -FootprintFindings @(Get-SameProductFootprintFindings -Probes `
    (@{ DomainState = 'Joined' })) -WantsLaunch $true -Attested $true
  SelfAssert 'a domain-joined host is refused EVEN WITH a clean-account attestation' `
    (-not $joinedAttested.Authorized)
  $unknownAttested = Test-LaunchAuthorized -FootprintFindings @(Get-SameProductFootprintFindings -Probes `
    (@{ DomainState = 'Unknown' })) -WantsLaunch $true -Attested $true
  SelfAssert 'an undetermined domain state is refused EVEN WITH a clean-account attestation' `
    (-not $unknownAttested.Authorized)
  $workgroupAttested = Test-LaunchAuthorized -FootprintFindings @(Get-SameProductFootprintFindings -Probes `
    (@{ DomainState = 'Workgroup' })) -WantsLaunch $true -Attested $true
  SelfAssert 'a workgroup host with an attestation is still authorized' $workgroupAttested.Authorized

  $case = Clean-Probes
  $case['RunningDesktopProcesses'] = @('dsh-desktop.exe')
  $case['RunningProcessDetail'] = 'pid 1234'
  SelfAssert 'a running same-product process is a finding' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)

  $case = Clean-Probes
  $case['UninstallKeys'] = @(@{ Path = 'k1'; InstallLocation = 'p1' })
  $case['LiveProfileExists'] = $true
  $case['LiveProfilePath'] = 'p2'
  SelfAssert 'multiple contaminations all report' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 2)

  # 1b. AN INCOMPLETE CENSUS IS A FINDING. "I could not look" must never be
  # reported as "it is not there": a swallowed lookup returns an empty list,
  # which is indistinguishable from a clean host unless this is explicit.
  $case = Clean-Probes
  $case['LookupFailures'] = @('the uninstall registry view HKLM could not be enumerated')
  SelfAssert 'an incomplete census is reported, not swallowed' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 1)
  SelfAssert 'an incomplete census is named as such' `
    ((Get-SameProductFootprintFindings -Probes $case)[0] -match 'census incomplete')
  SelfAssert 'an empty LookupFailures list is still a clean host' `
    ((Get-SameProductFootprintFindings -Probes (Clean-Probes)).Count -eq 0)
  $case = Clean-Probes
  $case['LookupFailures'] = @('a', 'b')
  SelfAssert 'every incomplete lookup is reported' `
    ((Get-SameProductFootprintFindings -Probes $case).Count -eq 2)
  SelfAssert 'an incomplete census refuses the launch gate' `
    (-not (Test-LaunchAuthorized -FootprintFindings @('footprint census incomplete: x') -WantsLaunch $true -Attested $true).Authorized)

  # 2. The launch gate. There is no third condition and no override.
  SelfAssert 'launch is refused with no attestation' `
    (-not (Test-LaunchAuthorized -FootprintFindings @() -WantsLaunch $true -Attested $false).Authorized)
  SelfAssert 'launch is refused when a footprint exists even if attested' `
    (-not (Test-LaunchAuthorized -FootprintFindings @('x') -WantsLaunch $true -Attested $true).Authorized)
  SelfAssert 'launch is authorized only with attestation and a clean host' `
    ((Test-LaunchAuthorized -FootprintFindings @() -WantsLaunch $true -Attested $true).Authorized)
  SelfAssert 'not asking to launch needs no attestation' `
    ((Test-LaunchAuthorized -FootprintFindings @() -WantsLaunch $false -Attested $false).Authorized)

  # 3. The read-only lane can never install, extract, launch or uninstall.
  SelfAssert 'read-only lane accepts an explicit root' `
    ((Test-ExtractedLayoutLaneAccepts -Root 'C:\x' -Uninstall $false -Launch $false).Accepts)
  SelfAssert 'read-only lane requires a root' `
    (-not (Test-ExtractedLayoutLaneAccepts -Root '' -Uninstall $false -Launch $false).Accepts)
  SelfAssert 'read-only lane refuses -Uninstall' `
    (-not (Test-ExtractedLayoutLaneAccepts -Root 'C:\x' -Uninstall $true -Launch $false).Accepts)
  SelfAssert 'read-only lane refuses -Launch' `
    (-not (Test-ExtractedLayoutLaneAccepts -Root 'C:\x' -Uninstall $false -Launch $true).Accepts)

  # 4. Environment hygiene.
  $stripped = Get-EnvKeysToStrip -Names @('PATH', 'DSH_HOME', 'DSH_DESKTOP_NODE', 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS', 'MY_API_KEY', 'GH_TOKEN', 'UserProfile', 'DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE')
  SelfAssert 'DSH_ and WEBVIEW2_ and secret-shaped keys are stripped' `
    (($stripped -contains 'DSH_HOME') -and ($stripped -contains 'DSH_DESKTOP_NODE') -and `
     ($stripped -contains 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS') -and ($stripped -contains 'MY_API_KEY') -and `
     ($stripped -contains 'GH_TOKEN'))
  SelfAssert 'ordinary variables are preserved' `
    (($stripped -notcontains 'PATH') -and ($stripped -notcontains 'UserProfile'))

  $proxyAndNode = Get-EnvKeysToStrip -Names @(
    'HTTP_PROXY', 'https_proxy', 'ALL_PROXY', 'NO_PROXY', 'npm_config_proxy',
    'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED',
    'ESBUILD_BINARY_PATH', 'TSX_TSCONFIG_PATH', 'NPM_CONFIG_USERCONFIG', 'NPM_CONFIG_CACHE')
  SelfAssert 'every proxy variable is rejected' `
    (($proxyAndNode -contains 'HTTP_PROXY') -and ($proxyAndNode -contains 'https_proxy') -and `
     ($proxyAndNode -contains 'ALL_PROXY') -and ($proxyAndNode -contains 'NO_PROXY') -and `
     ($proxyAndNode -contains 'npm_config_proxy'))
  SelfAssert 'Node and toolchain overrides are rejected' `
    (($proxyAndNode -contains 'NODE_OPTIONS') -and ($proxyAndNode -contains 'NODE_PATH') -and `
     ($proxyAndNode -contains 'NODE_EXTRA_CA_CERTS') -and ($proxyAndNode -contains 'ESBUILD_BINARY_PATH') -and `
     ($proxyAndNode -contains 'TSX_TSCONFIG_PATH') -and ($proxyAndNode -contains 'NPM_CONFIG_USERCONFIG'))

  # The owned environment must be complete. A partial set is the bug this
  # assertion exists for: DSH_HOME alone leaves %APPDATA%, %TEMP% and the
  # Windows profile pointing at the live account.
  $ownedKeys = @('DSH_HOME', 'DSH_DESKTOP_USER_DATA_DIR', 'WEBVIEW2_USER_DATA_FOLDER',
    'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP')
  $ownedEnv = Get-OwnedEnvironment -Root (Join-Path $env:TEMP 'dsh-owned-env-self-test')
  $completeness = Test-OwnedEnvironmentComplete -Expected $ownedKeys -Actual @($ownedEnv.Keys)
  SelfAssert 'every owned environment variable is declared' `
    ($completeness.Complete -and $completeness.Missing.Count -eq 0) `
    $(if ($completeness.Missing.Count -eq 0) { "$($ownedEnv.Keys.Count) variables" } else { "missing: $($completeness.Missing -join ', ')" })
  $outsideRoot = @($ownedEnv.GetEnumerator() | Where-Object {
    $_.Key -ne 'HOMEDRIVE' -and $_.Key -ne 'HOMEPATH' -and
    -not (Test-Under $_.Value (Join-Path $env:TEMP 'dsh-owned-env-self-test'))
  })
  SelfAssert 'every owned path variable points inside the fresh root' `
    ($outsideRoot.Count -eq 0) `
    $(if ($outsideRoot.Count -eq 0) { 'no owned variable escapes the root' } else { "escaped: $(@($outsideRoot | ForEach-Object { $_.Key }) -join ', ')" })
  SelfAssert 'HOMEDRIVE and HOMEPATH reconstruct the owned profile' `
    ((($ownedEnv['HOMEDRIVE'] + $ownedEnv['HOMEPATH']).TrimEnd('\') -ieq (Join-Path $env:TEMP 'dsh-owned-env-self-test\profile').TrimEnd('\')))

  Write-Host ''
  if ($failures.Count -gt 0) {
    Write-Host ('RESULT: FAIL - {0} guard self-test assertion(s) failed.' -f $failures.Count) -ForegroundColor Red
    exit 1
  }
  Write-Host 'RESULT: PASS - guard decision logic verified; nothing was touched.' -ForegroundColor Green
  exit 0
}

# ===========================================================================
# REPORTING AND REFUSAL
# ===========================================================================
$results = @()
$report = [ordered]@{
  schemaVersion = 2
  product = $ProductName
  identifier = $ProductIdentifier
  lane = ''
  startedAt = (Get-Date).ToString('o')
  strippedEnvKeys = @()
  ownedEnvironment = [ordered]@{}
  launchRequested = [bool]$Launch
  cleanAccountAttested = [bool]$CleanAccountAttestation
  cleanAccountAttestationIsMachineVerified = $false
  footprintFindings = @()
  ownedProcessesNotShutDown = @()
  checks = @()
  qualified = $false
  notInstalledAcceptance = $false
}

function Record([string]$Name, [string]$Status, [string]$Detail) {
  $script:results += [pscustomobject]@{ Name = $Name; Status = $Status; Detail = $Detail }
  $mark = switch ($Status) { 'PASS' { 'PASS' } 'SKIP' { 'SKIP' } 'INFO' { 'INFO' } default { 'FAIL' } }
  Write-Host ("  [{0}] {1}{2}" -f $mark, $Name, $(if ($Detail) { " - $Detail" } else { '' }))
}
function Step([string]$Title) { Write-Host ''; Write-Host "==> $Title" -ForegroundColor Cyan }
function Save-Report {
  try {
    if ($script:EvidenceDir -and (Test-Path $script:EvidenceDir)) {
      $script:report.checks = @($script:results)
      $script:report.finishedAt = (Get-Date).ToString('o')
      $script:report | ConvertTo-Json -Depth 6 |
        Set-Content -Path (Join-Path $script:EvidenceDir 'verify-installed-report.json') -Encoding UTF8
    }
  } catch {
    Write-Host ("  [WARN] could not write the evidence report: {0}" -f $_.Exception.Message) -ForegroundColor Yellow
  }
}
function Refuse([string]$Message) {
  Write-Host ''
  Write-Host "REFUSED: $Message" -ForegroundColor Red
  Write-Host 'Nothing was installed, launched, removed, repaired or restored.' -ForegroundColor Red
  Write-Host 'This script has no override for a same-product footprint and will not touch one.' -ForegroundColor Red
  Save-Report
  exit 2
}

# ===========================================================================
# LANE SELECTION
# ===========================================================================
$evidenceId = [guid]::NewGuid().ToString()
$QualificationRoot = Join-Path $Scratch "installed-qualification-$evidenceId"
$appDir = Join-Path $QualificationRoot 'app'
$runHome = Join-Path $QualificationRoot 'home'
$userDataDir = Join-Path $QualificationRoot 'user-data'
$webViewProfile = Join-Path $userDataDir 'webview'
$logDir = Join-Path $userDataDir 'logs'
$script:EvidenceDir = Join-Path $QualificationRoot 'evidence'

# A caller-supplied -InstallDir/-ExtractedRoot may re-root the qualification
# directory, but ONLY inside a fresh scratch root.
if ($InstallDir) {
  $appDir = Resolve-FullPath $InstallDir
  $QualificationRoot = Split-Path -Parent $appDir
}

if ($ReadOnlyExtractedLayout) {
  $report.lane = 'read-only-extracted-layout'
  $report.notInstalledAcceptance = $true

  Step 'Read-only extracted-layout lane'
  Write-Host '  This lane is NOT installed acceptance. It installs nothing, extracts nothing,' -ForegroundColor Yellow
  Write-Host '  launches nothing and uninstalls nothing. It establishes payload and layout only.' -ForegroundColor Yellow

  $lane = Test-ExtractedLayoutLaneAccepts -Root $ExtractedRoot -Uninstall ([bool]$Uninstall) -Launch ([bool]$Launch)
  if (-not $lane.Accepts) { Refuse ($lane.Reasons -join '; ') }

  $fresh = Test-FreshQualificationRoot -Path $QualificationRoot -ScratchRoot $Scratch
  if (-not $fresh[0]) { Refuse "qualification root '$QualificationRoot' is unusable: $($fresh[1])" }

  $null = New-Item -ItemType Directory -Force -Path $script:EvidenceDir
  $report.qualificationRoot = $QualificationRoot
  $report.extractedRoot = (Resolve-FullPath $ExtractedRoot)

  # --- footprint: informational only, nothing is mutated --------------------
  Step 'Same-product footprint (informational; this lane mutates nothing)'
  $probes = Get-LiveFootprintProbes
  $findings = Get-SameProductFootprintFindings -Probes $probes
  $report.footprintFindings = $findings
  if ($findings.Count -eq 0) {
    Record 'same-product footprint' 'INFO' 'none detected on this host'
  } else {
    Record 'same-product footprint' 'INFO' ("{0} found; recorded, not touched: {1}" -f $findings.Count, ($findings -join ' | '))
  }

  # --- optional installer size gate ----------------------------------------
  if ($InstallerPath) {
    Step 'Installer artifact (size gate only; not run)'
    $sizeGate = Test-InstallerArtifact -Path $InstallerPath
    foreach ($row in $sizeGate) { Record $row.Name $row.Status $row.Detail }
  }

  # --- layout assertions ---------------------------------------------------
  Step 'Extracted layout assertions (read-only)'
  $layout = Test-InstalledLayout -AppDir (Resolve-FullPath $ExtractedRoot)
  foreach ($row in $layout) { Record $row.Name $row.Status $row.Detail }

  Save-Report
  Write-Host ''
  Write-Host 'RESULT: extracted-bundle LAYOUT qualification only.' -ForegroundColor Green
  Write-Host '        This is NOT installed acceptance: no installer ran, no registry, shortcut,' -ForegroundColor Yellow
  Write-Host '        updater hook or uninstaller behaviour was exercised, and no binary was launched.' -ForegroundColor Yellow
  $fails = @($results | Where-Object { $_.Status -eq 'FAIL' })
  if ($fails.Count -gt 0) { exit 1 }
  if (@($results | Where-Object { $_.Status -eq 'PASS' }).Count -eq 0) {
    Write-Host 'RESULT: FAIL - no check passed; the run verified nothing.' -ForegroundColor Red
    exit 1
  }
  exit 0
}

# ===========================================================================
# INSTALL / LAUNCH LANE
# ===========================================================================
$report.lane = 'installed-acceptance'

# --- 0. Fresh, isolated, disposable root ------------------------------------
Step 'Isolation gate: fresh qualification root'
$fresh = Test-FreshQualificationRoot -Path $QualificationRoot -ScratchRoot $Scratch
if (-not $fresh[0]) { Refuse "qualification root '$QualificationRoot' is unusable: $($fresh[1])" }
Record 'qualification root is fresh and inside the scratch tree' 'PASS' $QualificationRoot

# Created only AFTER freshness is proven, so a refusal on a contaminated or
# reused root never writes into a directory this script does not own.
$null = New-Item -ItemType Directory -Force -Path $script:EvidenceDir
$report.qualificationRoot = $QualificationRoot

if ($appDir -match '\s') {
  Refuse "-InstallDir '$appDir' contains a space; NSIS /D= cannot be quoted, so the install would target the wrong path."
}
Record 'install target contains no spaces' 'PASS' $appDir

foreach ($reserved in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE)) {
  if ([string]::IsNullOrEmpty($reserved)) { continue }
  if ($appDir -ieq (Resolve-FullPath $reserved)) { Refuse "-InstallDir resolves to $reserved itself." }
}
Record 'install target is not a well-known user or system root' 'PASS'

if ($UpgradeFromProfile) {
  $seed = Resolve-FullPath $UpgradeFromProfile
  if (Test-Under $seed $LiveHome) {
    Refuse "-UpgradeFromProfile '$seed' is inside the live Harness home '$LiveHome'. This script never reads the live profile."
  }
  if (-not (Test-Under $seed $Scratch)) {
    Refuse "-UpgradeFromProfile '$seed' is not inside the scratch tree. Seed a fixture profile, never a real one."
  }
  Record 'seed profile is a scratch fixture, not the live profile' 'PASS' $seed
}

# --- 1. Same-product footprint: fail closed BEFORE anything is installed ----
Step 'Same-product footprint gate (fail closed, nothing is repaired)'
$probes = Get-LiveFootprintProbes
$findings = Get-SameProductFootprintFindings -Probes $probes
$report.footprintFindings = $findings
if ($findings.Count -gt 0) {
  foreach ($finding in $findings) { Write-Host ("    - {0}" -f $finding) -ForegroundColor Yellow }
  Refuse ("this host already carries a same-product footprint ({0} finding(s)). A second install would repoint the shared uninstall registration and Start-menu folder, and a launch would write into the live app-data and WebView2 profile. Run on a clean qualification account instead." -f $findings.Count)
}
Record 'no same-product footprint on this host' 'PASS' 'registry, Start menu, app data, WebView2 profile, live profile, running processes'

# --- 2. Installer present and plausibly sized ------------------------------
Step 'Installer artifact'
if (-not $InstallerPath) {
  $nsis = Join-Path $TauriDir 'target\release\bundle\nsis'
  $candidate = Get-ChildItem $nsis -Filter *.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($candidate) { $InstallerPath = $candidate.FullName }
}
$installerReady = $false
if (-not $InstallerPath -or -not (Test-Path $InstallerPath)) {
  Record 'installer exists' 'FAIL' 'no installer found; build it first (cargo tauri build)'
} else {
  $file = Get-Item $InstallerPath
  $sizeMb = [math]::Round($file.Length / 1MB, 1)
  Record 'installer exists' 'PASS' "$($file.Name), $sizeMb MB, $($file.LastWriteTime)"
  # A size above 40 MB is necessary, not sufficient. The authoritative evidence
  # that the payload arrived is the installed-layout section.
  if ($sizeMb -lt 40) {
    Record 'installer is not the stale empty artifact' 'FAIL' "$sizeMb MB is in the range of the stale UI-only build (finding F-16); treat as non-deliverable"
  } else {
    Record 'installer is not the stale empty artifact' 'PASS' "$sizeMb MB (payload-carrying)"
    $installerReady = $true
  }
  # A payload-carrying installer must carry the pinned Node and both port
  # packages. A size gate alone passed a real stale build (F-16 regression).
  $listing = Get-InstallerPayloadListing -Path $InstallerPath
  if ($listing) {
    $required = @(
      'dsh\adapter.mjs',
      'ui\assets',
      'dsh\node\node.exe',
      'dsh\node_modules\@deepseek-ai\dsh\package.json',
      'dsh\node_modules\@deepseek-ai\cordis-plugin-group\package.json',
      'dsh\node_modules\@deepseek-ai\dsh-base\package.json',
      'dsh\node_modules\@deepseek-ai\dsh-web-app\package.json',
      'dsh\node_modules\@dsh-port\dsh-desktop-updates-bundle\package.json',
      'dsh\node_modules\@dsh-port\dsh-client-ui-updates\lib\client.js'
    )
    foreach ($needle in $required) {
      $present = $listing -match [regex]::Escape($needle)
      Record "installer carries $needle" $(if ($present) { 'PASS' } else { 'FAIL' }) `
        $(if ($present) { 'present in the archive listing' } else { 'absent from the archive listing; this installer cannot produce a working installation' })
    }
  } else {
    Record 'installer payload listing' 'SKIP' 'no archive reader available; payload completeness is then proven only by the installed-layout section'
  }
}

# --- 3. Launch authorization ----------------------------------------------
$auth = Test-LaunchAuthorized -FootprintFindings $findings -WantsLaunch ([bool]$Launch) -Attested ([bool]$CleanAccountAttestation)
if (-not $auth.Authorized) { Refuse ($auth.Reasons -join '; ') }
if ($Launch) {
  Step 'Clean-account attestation'
  Record 'clean-account attestation recorded' 'PASS' `
    'UNVERIFIED HUMAN CLAIM: the caller asserts the current account is a LOCAL, NON-DOMAIN-JOINED, disposable account holding no real dsh-desktop:* credentials. Not machine verified. Credential roaming is not checked, which is why a domain-joined host is refused outright rather than attested around.'
}

$report.qualificationRoot = $QualificationRoot
# The complete owned environment. DSH_HOME and the WebView2 folder cover the
# paths the Rust core actually resolves (dsh-core/src/paths.rs honours both
# explicitly), but the Windows profile and roaming/local variables are what the
# Node host, WebView2, and any spawned tool read for caches, config, temp files
# and logs. Leaving them inherited means a qualification run writes telemetry
# and scratch state into the live profile.
$ownedEnv = Get-OwnedEnvironment -Root $QualificationRoot
$runHome = $ownedEnv['DSH_HOME']
$userDataDir = $ownedEnv['DSH_DESKTOP_USER_DATA_DIR']
$webViewProfile = $ownedEnv['WEBVIEW2_USER_DATA_FOLDER']
$logDir = Join-Path $userDataDir 'logs'
$profileRoot = $ownedEnv['HOME']
$roamingAppData = $ownedEnv['APPDATA']
$localAppData = $ownedEnv['LOCALAPPDATA']
$ownedTemp = $ownedEnv['TEMP']
$homeDrive = $ownedEnv['HOMEDRIVE']
$homePathTail = $ownedEnv['HOMEPATH']
$report.ownedEnvironment = $ownedEnv

# Every owned directory is created BEFORE the installer runs, so an installer or
# application that writes to %TEMP%, %APPDATA% or the profile cannot fall back
# to a live location.
$null = New-Item -ItemType Directory -Force -Path $appDir
foreach ($owned in @($runHome, $logDir, $webViewProfile, $script:EvidenceDir, $profileRoot, $roamingAppData, $localAppData, $ownedTemp)) {
  $null = New-Item -ItemType Directory -Force -Path $owned
}
$missingOwned = @($ownedEnv.GetEnumerator() | Where-Object {
    $_.Key -ne 'HOMEDRIVE' -and $_.Key -ne 'HOMEPATH' -and -not (Test-Path $_.Value)
  } | ForEach-Object { $_.Key })
Record 'every owned environment directory exists before install' $(if ($missingOwned.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
  $(if ($missingOwned.Count -eq 0) { "$($ownedEnv.Count) variables rooted at $QualificationRoot" } else { "absent: $($missingOwned -join ', ')" })
$escapedOwned = @($ownedEnv.GetEnumerator() | Where-Object {
    $_.Key -ne 'HOMEDRIVE' -and $_.Key -ne 'HOMEPATH' -and -not (Test-Under $_.Value $QualificationRoot)
  } | ForEach-Object { $_.Key })
Record 'no owned environment variable escapes the fresh root' $(if ($escapedOwned.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
  $(if ($escapedOwned.Count -eq 0) { 'profile, appdata, localappdata, temp and home are all inside the root' } else { "escaped: $($escapedOwned -join ', ')" })

# --- 4. Silent install -----------------------------------------------------
Step 'Silent install'
$appExe = $null
if ($installerReady) {
  try {
    # NSIS: /D must be last and unquoted.
    $proc = Start-Process -FilePath $InstallerPath -ArgumentList '/S', "/D=$appDir" -PassThru -Wait
    if ($proc.ExitCode -eq 0) { Record 'installer exits 0' 'PASS' "exit $($proc.ExitCode)" }
    else { Record 'installer exits 0' 'FAIL' "exit $($proc.ExitCode)" }
  } catch {
    Record 'installer exits 0' 'FAIL' $_.Exception.Message
  }
} else {
  Record 'installer exits 0' 'SKIP' 'no usable installer'
}

# --- 5. Installed layout, with no reparse points --------------------------
Step 'Installed layout'
$appExe = Get-ChildItem $appDir -Filter "$MainBinaryName.exe" -Recurse -ErrorAction SilentlyContinue |
  Select-Object -First 1
$layout = Test-InstalledLayout -AppDir $appDir
foreach ($row in $layout) { Record $row.Name $row.Status $row.Detail }

# --- 6. Cold launch (opt-in) ----------------------------------------------
$restoreEnv = @{}
if ($Launch) {
  if (-not $appExe) { Refuse 'no application executable under the qualification root; refusing to launch.' }

  Step 'Owned environment (strip inherited, then set owned only)'
  $present = @(Get-ChildItem Env: | ForEach-Object { $_.Name })
  $toStrip = Get-EnvKeysToStrip -Names $present
  foreach ($name in $toStrip) {
    $restoreEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    Remove-Item "Env:$name" -ErrorAction SilentlyContinue
  }
  $report.strippedEnvKeys = $toStrip
  Record 'inherited DSH_/WEBVIEW2_/proxy/Node/secret-shaped variables stripped' 'PASS' `
    ("{0} removed: {1}" -f $toStrip.Count, ($(if ($toStrip.Count -gt 0) { $toStrip -join ', ' } else { '(none present)' })))

  # The whole owned set, not just the three product variables. HOME/USERPROFILE/
  # APPDATA/LOCALAPPDATA/TEMP/TMP are what the Node host, WebView2 and any
  # spawned tool read for config, caches, temp files and logs.
  foreach ($name in $ownedEnv.Keys) {
    [Environment]::SetEnvironmentVariable($name, $ownedEnv[$name], 'Process')
  }
  $env:RUST_LOG = 'dsh_runtime=debug,dsh_gateway=debug,dsh_desktop=debug'

  # Re-read the live process environment and prove the child will inherit only
  # owned values. This is the check that would have caught the earlier gap.
  $stillSet = @($toStrip | Where-Object { -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, 'Process')) })
  Record 'no stripped variable survived into the launch environment' $(if ($stillSet.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
    $(if ($stillSet.Count -eq 0) { 'verified by re-reading the process environment' } else { "survived: $($stillSet -join ', ')" })

  $wrongOwned = @($ownedEnv.GetEnumerator() | Where-Object {
      [Environment]::GetEnvironmentVariable($_.Key, 'Process') -ne $_.Value
    } | ForEach-Object { $_.Key })
  Record 'every owned variable is set to its owned value' $(if ($wrongOwned.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
    $(if ($wrongOwned.Count -eq 0) { ($ownedEnv.Keys -join ', ') } else { "wrong or unset: $($wrongOwned -join ', ')" })

  $leaked = @($DevOverrides | Where-Object { -not [string]::IsNullOrEmpty([Environment]::GetEnvironmentVariable($_, 'Process')) })
  Record 'no DSH_DESKTOP_* development override is set' $(if ($leaked.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
    $(if ($leaked.Count -eq 0) { 'the point of this test' } else { "leaked: $($leaked -join ', ')" })

  if ($RequireNoSystemNode) {
    $systemNode = Get-NodeOnPath
    $restorePath = $env:PATH
    if ($null -ne $systemNode) {
      $env:PATH = Get-PathWithoutNode
      $stillThere = Get-NodeOnPath
      Record 'system Node removed from PATH for the launch' $(if ($null -ne $stillThere) { 'FAIL' } else { 'PASS' }) `
        $(if ($null -eq $stillThere) { "was $systemNode" } else { "node still resolves at $stillThere" })
    } else {
      Record 'system Node removed from PATH for the launch' 'PASS' 'no system node was on PATH'
    }
  } else {
    $systemNode = Get-NodeOnPath
    Record 'payload self-containment verified (no system Node)' 'SKIP' `
      $(if ($null -ne $systemNode) { "system node present at $systemNode; pass -RequireNoSystemNode to verify the payload is self-contained" } else { 'no system node on PATH; pass -RequireNoSystemNode to record this as verified' })
  }

  if ($UpgradeFromProfile) {
    Step 'Profile upgrade'
    $sourceProfile = Resolve-FullPath $UpgradeFromProfile
    $targetProfile = Join-Path $runHome 'profiles\desktop'
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $targetProfile) | Out-Null
    Copy-Item $sourceProfile $targetProfile -Recurse -Force
    $script:BeforeUpgrade = @{}
    $settingsCandidates = Get-ChildItem $targetProfile -Recurse -File -Include '*.json', '*.yaml', '*.yml' -ErrorAction SilentlyContinue
    $script:BeforeUpgrade.Files = @($settingsCandidates | ForEach-Object { $_.FullName.Substring($targetProfile.Length) })
    $script:BeforeUpgrade.SettingsHash = @{}
    foreach ($file in $settingsCandidates) {
      $script:BeforeUpgrade.SettingsHash[$file.FullName] = (Get-FileHash $file.FullName -Algorithm SHA256).Hash
    }
    Record 'seed profile copied into the isolated home' 'PASS' "$($script:BeforeUpgrade.Files.Count) file(s) from $sourceProfile"
  }

  Step 'Cold launch, no development overrides'
  $before = Get-Date
  $proc = Start-Process -FilePath $appExe.FullName -PassThru
  Write-Host "    pid $($proc.Id)" -ForegroundColor DarkGray
  $report.launchedPid = $proc.Id

  $deadline = (Get-Date).AddSeconds($WaitSeconds)
  $exitEarly = $false
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { $exitEarly = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if ($exitEarly) {
    Record 'application stays running (no early exit)' 'FAIL' "exited with code $($proc.ExitCode)"
  } else {
    Record 'application stays running (no early exit)' 'PASS' "alive after ${WaitSeconds}s"
  }

  $listeners = @(Get-NetTCPConnection -State Listen -OwningProcess $proc.Id -ErrorAction SilentlyContinue)
  if ($listeners.Count -gt 0) {
    $port = ($listeners | Select-Object -First 1).LocalPort
    Record 'gateway binds a loopback port' 'PASS' "port $port"
    Record 'gateway did not take the live GUI port' $(if ($port -eq 3080) { 'FAIL' } else { 'PASS' }) `
      $(if ($port -eq 3080) { 'the application bound 3080, which belongs to the running Harness GUI' } else { "port $port" })
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
      Record 'unauthenticated request is refused' 'FAIL' "got $($response.StatusCode), expected 401"
    } catch {
      $code = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
      Record 'unauthenticated request is refused' $(if ($code -eq 401) { 'PASS' } else { 'FAIL' }) "status $code"
    }
  } else {
    Record 'gateway binds a loopback port' 'FAIL' 'no listening socket owned by the process'
  }

  # Readiness is read ONLY from the owned log directory. The previous
  # %APPDATA%/%LOCALAPPDATA% fallbacks read the LIVE installation's log, so a
  # run could false-PASS on another run's readiness line.
  $logRoots = @($logDir)

  function Read-DiagnosticLog {
    $text = ''
    foreach ($root in $logRoots) {
      if (-not (Test-Path $root)) { continue }
      Get-ChildItem $root -Recurse -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*.log*' -and $_.LastWriteTime -ge $before } |
        ForEach-Object { $text += (Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue) }
    }
    return $text
  }

  $pollDeadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $pollDeadline -and -not $proc.HasExited) {
    if ((Read-DiagnosticLog) -match 'host authentication completed') { break }
    Start-Sleep -Seconds 2
  }

  # --- 7. Teardown: NO generic forced kill ---------------------------------
  Step 'Teardown'
  $stillRunning = -not $proc.HasExited
  $owned = @()
  try {
    $owned = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object { $_.ProcessId -eq $proc.Id -or $_.ParentProcessId -eq $proc.Id } |
      Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate)
  } catch { }
  $script:report.ownedProcessesNotShutDown = @($owned | ForEach-Object {
      [ordered]@{ pid = $_.ProcessId; parent = $_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath; created = [string]$_.CreationDate }
    })

  if ($stillRunning) {
    # Product close (WM_CLOSE / shell_window_chrome_action) only hides to the
    # tray. A true quit is shell_quit_request on the owned gateway origin, or a
    # scoped UIA Exit InvokePattern, and driving either needs the reviewed owned
    # native UIA authority this script does not have. Destructive cleanup is
    # therefore DISABLED rather than approximated with Stop-Process -Force,
    # which can orphan node.exe children and skip credential cleanup.
    Record 'application shut down gracefully' 'FAIL' `
      'NOT PERFORMED. Destructive cleanup is disabled by design; see evidence/verify-installed-report.json -> ownedProcessesNotShutDown. Shut the run down under the reviewed owned native UIA lane (shell_quit_request, or a scoped Exit InvokePattern), never WM_CLOSE.'
  } else {
    Record 'application exited on its own' 'PASS' "exit $($proc.ExitCode)"
  }
  Record 'destructive cleanup stayed disabled' 'PASS' 'no Stop-Process, no taskkill, no image-name kill'
  Start-Sleep -Seconds 5

  $logText = Read-DiagnosticLog
  if ($logText -match 'host authentication completed') {
    Record 'host reached readiness (owned log only)' 'PASS' 'log evidences host authentication'
  } elseif ($logText -match 'ERR_MODULE_NOT_FOUND|Cannot find package|node is not recognized|not recognized as an internal') {
    $hit = ($logText -split "`n" | Where-Object { $_ -match 'Cannot find package|ERR_MODULE_NOT_FOUND|not recognized' } | Select-Object -First 1)
    Record 'host reached readiness (owned log only)' 'FAIL' "no readiness evidence; first diagnostic: $($hit -replace '\s+$', '')"
  } else {
    Record 'host reached readiness (owned log only)' 'FAIL' 'no readiness evidence in the owned diagnostic log'
  }

  $crashes = @()
  if (Test-Path $logDir) {
    $crashes = @(Get-ChildItem $logDir -Filter 'crash-*.log' -File -ErrorAction SilentlyContinue |
      Where-Object { $_.LastWriteTime -ge $before })
  }
  Record 'no crash report written' $(if ($crashes.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
    $(if ($crashes.Count -eq 0) { 'none in the owned log directory' } else { "$($crashes.Count): $($crashes[0].Name)" })

  # --- 8. Profile retention ------------------------------------------------
  if ($UpgradeFromProfile -and $script:BeforeUpgrade -and $script:BeforeUpgrade.Files.Count -gt 0) {
    Step 'Profile retention after upgrade'
    $targetProfile = Join-Path $runHome 'profiles\desktop'
    $lost = @()
    $changed = @()
    foreach ($file in $script:BeforeUpgrade.Files) {
      $full = "$targetProfile$file"
      if (-not (Test-Path $full)) { $lost += $file; continue }
      $now = (Get-FileHash $full -Algorithm SHA256).Hash
      if ($now -ne $script:BeforeUpgrade.SettingsHash[$full]) { $changed += $file }
    }
    Record 'every seeded profile file survived the launch' $(if ($lost.Count -eq 0) { 'PASS' } else { 'FAIL' }) `
      $(if ($lost.Count -eq 0) { "$($script:BeforeUpgrade.Files.Count) file(s) present" } else { "lost: $($lost -join ', ')" })
    Record 'no seeded profile file was rewritten unexpectedly' $(if ($changed.Count -gt 0) { 'FAIL' } else { 'PASS' }) `
      $(if ($changed.Count -eq 0) { 'all file hashes unchanged' } else { "rewritten: $($changed -join ', ')" })
  }

  # Restore the caller's environment.
  if ($restoreEnv.Count -gt 0) {
    foreach ($name in $restoreEnv.Keys) {
      [Environment]::SetEnvironmentVariable($name, $restoreEnv[$name], 'Process')
    }
  }
  if ($RequireNoSystemNode -and $null -ne $restorePath) { $env:PATH = $restorePath }
} elseif ($Uninstall) {
  Refuse '-Uninstall requires a completed install in this run; the qualification root must be fresh.'
}

# --- 9. Optional uninstall -------------------------------------------------
if ($Uninstall) {
  Step 'Uninstall'
  $uninstaller = Get-ChildItem $appDir -Filter 'Uninstall*.exe' -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $uninstaller) {
    Record 'uninstaller present' 'FAIL' 'not found'
  } else {
    Record 'uninstaller present' 'PASS' $uninstaller.Name
    Start-Process -FilePath $uninstaller.FullName -ArgumentList '/S' -Wait
    Start-Sleep -Seconds 5
    Record 'application removed' $(if (Test-Path $appDir) { 'FAIL' } else { 'PASS' }) $appDir
    Record 'isolated Harness home retained' $(if (Test-Path $runHome) { 'PASS' } else { 'FAIL' }) $runHome
  }
}

# --- Summary ---------------------------------------------------------------
$fails = @($results | Where-Object { $_.Status -eq 'FAIL' })
Write-Host ''
Write-Host ("Summary: {0} PASS, {1} FAIL, {2} SKIP" -f `
    @($results | Where-Object { $_.Status -eq 'PASS' }).Count, $fails.Count, `
    @($results | Where-Object { $_.Status -eq 'SKIP' }).Count)
$skipped = @($results | Where-Object { $_.Status -eq 'SKIP' })
if ($skipped.Count -gt 0) {
  Write-Host 'Skipped checks are NOT evidence of correctness:' -ForegroundColor Yellow
  $skipped | ForEach-Object { Write-Host "  - $($_.Name): $($_.Detail)" -ForegroundColor Yellow }
}
Save-Report
if ($fails.Count -gt 0) {
  Write-Host 'RESULT: FAIL - the run did not satisfy every required step.' -ForegroundColor Red
  Write-Host "Evidence: $(Join-Path $script:EvidenceDir 'verify-installed-report.json')" -ForegroundColor Red
  $fails | ForEach-Object { Write-Host "  - $($_.Name): $($_.Detail)" -ForegroundColor Red }
  exit 1
}
if (@($results | Where-Object { $_.Status -eq 'PASS' }).Count -eq 0) {
  Write-Host 'RESULT: FAIL - no check passed; the run verified nothing.' -ForegroundColor Red
  exit 1
}
Write-Host 'RESULT: PASS - installed layout and install-time checks satisfied.' -ForegroundColor Green
exit 0
