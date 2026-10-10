<#
.SYNOPSIS
  Launch the assembled desktop port for development and acceptance testing.

.DESCRIPTION
  This is the repeatable flow the independent review asked for:
  installed/assembled app -> cold startup -> native command/event -> session
  and streaming -> host failure -> recovery -> clean shutdown.

  It stages everything the Rust supervisor needs, then launches the Tauri
  application with an ISOLATED Harness home. It never touches a user's real
  `$DSH_HOME`, and it never prints a launch token; the token is handed to the
  verifier through a dev-only file that the app writes only when asked.

  Run `scripts/verify-assembled.mjs` against the printed URL afterwards, or pass
  -Verify to do it automatically.

.PARAMETER Build
  Run `cargo build` for the shell first. Requires CARGO_TARGET_DIR to point outside
  the checkout (see port/tests/run-rust-qualification.ps1): images linked inside the
  workspace inherit its Low integrity label. -AllowWorkspaceTarget accepts the
  hazard explicitly.

.PARAMETER RunStamp
  Name the per-run evidence root (`port\.scratch\dev-e2e-<RunStamp>`). Omitted, a
  UTC timestamp plus a random suffix is used. An existing root is REFUSED, never
  reused or cleared.

.PARAMETER AllowWorkspaceTarget
  Allow a build whose target directory is inside the checkout (Low images).

.PARAMETER AllowLowIntegrityImage
  Allow launching an application image, or a runtime interpreter, that carries Low
  integrity while this process is Medium.

.PARAMETER Verify
  After launch, wait for the dev URL file and run scripts/verify-assembled.mjs.

.SAFETY
  This launcher drives a real assembled application, so it enforces isolation
  before it does anything:
    * every run owns a FRESH root `port\.scratch\dev-e2e-<stamp>\`; an existing root
      is refused rather than reused, and NOTHING is ever deleted, so a previous
      run's evidence survives;
    * the dev handoff paths inside that root are fresh by construction, which the
      handoff's exclusive create (`CREATE_NEW`, `development_handoff_exists`)
      requires - a fixed path would be blocked by the previous run's file;
    * the Harness home is always an isolated directory under that root; the live
      home `C:\Users\<user>\.dsh` is never read or written. NOTE: redirecting the
      home alone does NOT protect credentials -- the app's credential backend reads
      `DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE`, and without it the run uses the real
      Windows Credential Manager. This launcher therefore generates a fresh
      canonical UUID namespace per run, places the home under the fence's own
      `<repo>\.scratch\native-{UUID}` root, sets that variable for the child, and
      restores it (with every other override) in a `finally` on all paths. The fence
      requires a DEBUG image, so a release candidate is refused;
    * the launcher never targets the live GUI port 3080 - it reads the port the
      application actually bound from the boot payload;
    * the application image, the runtime interpreter and the resolved target
      directory are READ for their integrity label; a Low image under a Medium
      parent is refused with that diagnosis rather than launched, and nothing is
      ever relabelled;
    * the caller's environment is restored on exit, so a later command in the
      same shell does not silently inherit a redirected DSH_HOME.
  A run that cannot satisfy these refuses with exit 2 and changes nothing.

.EXAMPLE
  .\port\scripts\dev-e2e.ps1 -Build -Verify
#>
[CmdletBinding()]
param(
  [switch]$Build,
  [switch]$Verify,
  [int]$WaitSeconds = 60,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9-]{0,31}$')][string]$RunStamp,
  [switch]$AllowWorkspaceTarget,
  [switch]$AllowLowIntegrityImage,
  # Overrides for a parent-rebuilt image and a qualified sealed payload. Defaults are
  # the in-checkout staging/payload locations; passing these does not change any
  # safety rule.
  [string]$ExecutablePath,
  [string]$RuntimeDirectory,
  [string]$ShellDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
$Upstream = Join-Path $RepoRoot '_upstream'
$TauriDir = Join-Path $PortRoot 'src-tauri'
$Scratch = Join-Path $PortRoot '.scratch'
# Credential fencing is compile-time repository scratch; evidence remains port scratch.
$OwnedScratch = Join-Path $RepoRoot '.scratch'

# --- owned credential namespace (REQUIRED) ----------------------------------
# Redirecting `DSH_HOME` alone does NOT protect the production credential service:
# the desktop app's own fence is what selects an owned namespace, and it reads
# `DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE`. Without it the app uses the real Windows
# Credential Manager and can write or delete real user credentials during a
# qualification run.
#
# The fence (`app/src/credential_backend.rs`) accepts ONLY a canonical, non-nil,
# lowercase hyphenated UUID, requires a DEBUG build, and places the owned root at
# `<repository>/.scratch/native-{UUID}`. A release image is therefore refused by the
# app itself, so this launcher prefers the debug candidate and refuses a release one
# early with that diagnosis rather than discovering it at runtime.
$Namespace = [guid]::NewGuid().ToString('D').ToLowerInvariant()
$OwnedRoot = Join-Path (Join-Path $RepoRoot '.scratch') "native-$Namespace"

# --- fresh, per-run evidence root -------------------------------------------
# The dev handoff is written with an EXCLUSIVE create (`CREATE_NEW` /
# `O_CREAT|O_EXCL`): an existing file of any kind is never truncated or replaced,
# the request fails with `development_handoff_exists`, and the handoff therefore
# REQUIRES a path that does not exist yet. An earlier version of this launcher
# used fixed paths and deleted whatever was there first, which both destroyed the
# previous run's evidence and left a window in which a crashed run's file blocked
# the next launch. Every run now owns a fresh root and nothing is ever deleted.
$RunName = if ($RunStamp) { $RunStamp } else { (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8) }
$RunRoot = Join-Path $Scratch "dev-e2e-$RunName"
# The Harness home lives under the OWNED ROOT the credential fence validates, so the
# profile and the owned credential namespace cannot be separated by a later edit.
# The handoff files stay in the per-run root; only the home moves.
$RunHome = Join-Path $OwnedRoot 'home'
$Profile = Join-Path $RunHome 'profiles\desktop'
$UserData = Join-Path $RunHome 'userdata'
$HandoffDir = Join-Path $RunRoot 'handoff'
$UrlFile = Join-Path $HandoffDir 'gateway-url.txt'
$BootFile = Join-Path $HandoffDir 'boot.json'
# The app writes this ONLY when `runtime_boot_ready` RESOLVES - host ready AND
# gateway attached. The URL file above is published EARLIER (app/src/lib.rs
# publishes it before `set_host`), so it is NOT a readiness signal: gating on it
# reported "gateway is up" while the host had already died on a module error.
$RunLog = Join-Path $RunRoot 'launch.log'

# The live Harness home and the live GUI port. Neither is ever used by this
# launcher; both are asserted against below.
$LiveHome = Join-Path $env:USERPROFILE '.dsh'
$LiveGuiPort = 3080

if (-not (Get-Command -Name 'Get-DshFileIntegrityLabel' -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PortRoot 'tests\packaging\qualification-preflight.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'ConvertTo-DshNativeArgumentList' -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PortRoot 'tests\packaging\native-quoting.psm1') -Global -ErrorAction Stop
}
if (-not (Get-Command -Name 'Resolve-DshTrustedExecutionNode' -ErrorAction SilentlyContinue)) {
  Import-Module (Join-Path $PortRoot 'tests\packaging\rust-qualification.psm1') -Global -ErrorAction Stop
}
# Fail closed on a missing EXPORT rather than at the call site. `Resolve-DshStagingExecutionNode`
# exists only inside build.ps1 (it is not a module export), so calling it here would fail
# with an undefined-command error at launch time. Only the exported module function is used.
if (-not (Get-Command -Name 'Resolve-DshTrustedExecutionNode' -ErrorAction SilentlyContinue)) {
  throw 'rust-qualification.psm1 did not export Resolve-DshTrustedExecutionNode; refusing to launch without the trusted-interpreter resolver.'
}

function Write-Step([string]$Message) { Write-Host ''; Write-Host "==> $Message" -ForegroundColor Cyan }
function Refuse([string]$Message) {
  Write-Host ''
  Write-Host "REFUSED: $Message" -ForegroundColor Red
  Write-Host 'Nothing was launched and no environment was changed.' -ForegroundColor Red
  exit 2
}
function Resolve-FullPath([string]$Path) { return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/') }
function Test-Under([string]$Path, [string]$Root) {
  $p = (Resolve-FullPath $Path).ToLowerInvariant()
  $r = (Resolve-FullPath $Root).ToLowerInvariant()
  return $p -eq $r -or $p.StartsWith($r + '\')
}

# --- 0. Isolation gate ------------------------------------------------------
# Establish that the state this launcher will create is disposable BEFORE it
# creates anything. Nothing is removed on any path: a fresh root is required
# instead, because the handoff's exclusive create needs an absent path and a
# previous run's evidence must survive.
if (-not (Test-Under $RunRoot $Scratch)) {
  Refuse "the per-run root '$RunRoot' is not under '$Scratch'."
}
if (Test-Under $RunRoot $LiveHome) {
  Refuse "the per-run root resolves inside the live Harness home '$LiveHome'."
}
if (Test-Path -LiteralPath $RunRoot) {
  Refuse "the per-run root already exists: $RunRoot. The handoff is created exclusively (CREATE_NEW), so it needs a fresh path; pass a different -RunStamp or omit it. Nothing was deleted."
}
# The owned credential namespace root must be FRESH too: reusing it would adopt a
# previous run's owned credentials, which is exactly what the fence exists to prevent.
if (Test-Path -LiteralPath $OwnedRoot) {
  Refuse "the owned credential namespace root already exists: $OwnedRoot. A fresh namespace UUID is generated per run; nothing was deleted."
}
if (-not (Test-Under $OwnedRoot $OwnedScratch)) {
  Refuse "the owned credential namespace root '$OwnedRoot' is not under repository scratch '$OwnedScratch'."
}
if (Test-Under $OwnedRoot $LiveHome) {
  Refuse "the owned credential namespace root resolves inside the live Harness home '$LiveHome'."
}
Write-Host "isolation: DSH_HOME -> $RunHome (live home $LiveHome is not used)" -ForegroundColor DarkGray
Write-Host "namespace : $Namespace (owned credential namespace; fence requires a debug image)" -ForegroundColor DarkGray
Write-Host "owned root: $OwnedRoot (fresh; retained as evidence)" -ForegroundColor DarkGray
Write-Host "run root : $RunRoot (fresh; retained as evidence)" -ForegroundColor DarkGray
Write-Host "handoff  : $HandoffDir (fresh paths required by the exclusive create)" -ForegroundColor DarkGray

# --- 1. Locate the materialized runtime payload ----------------------------
# The runtime must be the SAME materialized tree the installer ships, NOT a
# junction farm over the reference checkout. An earlier version of this script
# staged a junction to `_upstream/apps/desktop-host/node_modules`, whose closure
# covers only that package's own dependencies: it contains neither the profile
# bundles (`dsh-base`, `dsh-web-app`) nor the peer `cordis-plugin-group`. The host
# therefore died during profile boot and this launcher never reached readiness,
# even though the installed application did (finding F-13, and F-33 for the
# launcher divergence).
Write-Step 'Locating the materialized runtime payload'
$payloadDsh = if ($RuntimeDirectory) { Resolve-FullPath $RuntimeDirectory } else { Join-Path $PortRoot 'runtime-payload\dsh' }
$payloadAdapter = Join-Path $payloadDsh 'adapter.mjs'
$payloadNode = Join-Path $payloadDsh 'node\node.exe'
if (-not (Test-Path $payloadAdapter)) {
  throw "Runtime payload missing at $payloadDsh. Build it first with: & `"$PSScriptRoot\build.ps1`" -Stage runtime"
}
if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf)) {
  throw "The payload carries no pinned interpreter at $payloadNode; the launcher never falls back to a system node."
}
foreach ($anchorName in @('dsh', 'cordis-plugin-group', 'dsh-base', 'dsh-web-app')) {
  if (-not (Test-Path (Join-Path $payloadDsh "node_modules\@deepseek-ai\$anchorName\package.json"))) {
    throw "Runtime payload is incomplete: missing @deepseek-ai/$anchorName. Re-run: & `"$PSScriptRoot\build.ps1`" -Stage runtime"
  }
}
Write-Host "    payload -> $payloadDsh" -ForegroundColor DarkGray

# --- 2. Prepare a FRESH empty isolated Harness home ------------------------
# Deliberately do NOT hand-stage the profile. The shell's own initializer creates
# `profiles/desktop` on every launch, before it spawns the host; staging it here
# would mask a broken initializer again -- precisely the trap that hid the missing
# profile initialisation until an installed run exposed it (finding F-23).
# Nothing is removed: the root did not exist before this run (step 0 proves it).
Write-Step 'Preparing a fresh empty isolated Harness home'
$null = New-Item -ItemType Directory -Path $OwnedRoot -ErrorAction Stop
$null = New-Item -ItemType Directory -Path $RunRoot -ErrorAction Stop
$null = New-Item -ItemType Directory -Path $RunHome -ErrorAction Stop
$null = New-Item -ItemType Directory -Path $UserData -ErrorAction Stop
$null = New-Item -ItemType Directory -Path $HandoffDir -ErrorAction Stop
Write-Host "    DSH_HOME -> $RunHome (profile intentionally left for the app to create)" -ForegroundColor DarkYellow
Write-Host "    userdata -> $UserData (under the owned home)" -ForegroundColor DarkGray
Write-Host "    profile  -> $Profile" -ForegroundColor DarkGray
Write-Host "    handoff  -> $HandoffDir (no file here yet; the app creates them exclusively)" -ForegroundColor DarkGray

# --- 3. Build ---------------------------------------------------------------
# The target root matters: anything cargo links inside the workspace inherits the
# workspace's Low integrity label, and a Low image then fails in ways that name
# the wrong cause (the observed MSVC D8050 and the credentials/diagnostics/profile
# test failures). Run `port/tests/run-rust-qualification.ps1` first and use the
# READY_* environment it prints.
$TargetDir = $env:CARGO_TARGET_DIR
if ($Build) {
  Write-Step 'Building the Tauri shell'
  if ([string]::IsNullOrWhiteSpace($TargetDir)) {
    if (-not $AllowWorkspaceTarget) {
      Refuse "no CARGO_TARGET_DIR is set, so the build would write into the workspace target (Low integrity images). Run port/tests/run-rust-qualification.ps1 and use its READY_ENV, or pass -AllowWorkspaceTarget to accept the hazard explicitly."
    }
    $TargetDir = Join-Path $TauriDir 'target'
    Write-Host "    WARNING: building into the workspace target: $TargetDir" -ForegroundColor Yellow
  } elseif (Test-Under $TargetDir $PortRoot) {
    if (-not $AllowWorkspaceTarget) {
      Refuse "CARGO_TARGET_DIR '$TargetDir' is inside the checkout, so every linked image would be Low. Use the outside root from port/tests/run-rust-qualification.ps1, or pass -AllowWorkspaceTarget."
    }
    Write-Host "    WARNING: CARGO_TARGET_DIR is inside the checkout: $TargetDir" -ForegroundColor Yellow
  } else {
    Write-Host "    CARGO_TARGET_DIR -> $TargetDir (outside the checkout)" -ForegroundColor DarkGray
  }
  Push-Location $TauriDir
  try {
    $buildArguments = @('build', '-p', 'dsh-desktop', '--jobs', '1')
    $build = & cargo @buildArguments
    if ($LASTEXITCODE -ne 0) { throw "cargo build -p dsh-desktop failed with exit code $LASTEXITCODE" }
  } finally { Pop-Location }
}

# --- 4. Resolve the executable ---------------------------------------------
Write-Step 'Resolving the executable'
# The owned credential namespace requires a DEBUG image: the fence refuses a release
# build outright, so a release candidate is refused here with that diagnosis instead
# of failing at startup. Debug candidates are preferred; -ExecutablePath overrides
# the search for a parent-rebuilt image.
if ($ExecutablePath) {
  $exe = Get-Item -LiteralPath (Resolve-FullPath $ExecutablePath) -ErrorAction Stop
} else {
  $candidateRoots = @()
  if (-not [string]::IsNullOrWhiteSpace($TargetDir)) { $candidateRoots += $TargetDir }
  $candidateRoots += @((Join-Path $TauriDir 'target\debug'), (Join-Path $TauriDir 'target\release'))
  $exe = $null
  foreach ($root in $candidateRoots) {
    $found = Get-ChildItem (Join-Path $root 'dsh-desktop.exe') -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($null -ne $found) { $exe = $found; break }
  }
}
if ($null -eq $exe) { throw "No dsh-desktop.exe under any candidate root. Build it first (use -Build with an outside CARGO_TARGET_DIR), or pass -ExecutablePath." }
Write-Host "    $($exe.FullName)" -ForegroundColor DarkGray
if ($exe.FullName -match '\\release\\') {
  Refuse "the resolved image '$($exe.FullName)' is a RELEASE build. The owned credential-namespace fence requires a debug build, so the app would reject the namespace and this run would silently use the production credential service. Pass a debug (or, with -ExecutablePath, a debug) candidate."
}

# The image label is READ, never changed. A Low application image cannot write up
# to the user's Medium profile/temp, which is the whole confusing failure class.
$parentIntegrity = Get-DshProcessIntegrity -ProcessId $PID
$exeLabel = Get-DshFileIntegrityLabel -Path $exe.FullName
# FAIL CLOSED on unknown visibility: "not known to be Low" is not the same as "known
# to be trustworthy", and a launch under an unknown label is exactly the confusing
# failure class this guard exists for. Both must be KNOWN before anything starts.
if (-not $parentIntegrity.Known) {
  Refuse "this process's integrity could not be read ($($parentIntegrity.Reason)); refusing to launch under unknown visibility."
}
if (-not $exeLabel.Known) {
  Refuse "the application image's label could not be read ($($exeLabel.Reason)); refusing to launch an image whose integrity is unknown. No relabel was attempted."
}
Write-Host "    image label: $($exeLabel.Level) (parent: $($parentIntegrity.Level))" -ForegroundColor DarkGray
if ($exeLabel.Known -and $exeLabel.Level -eq 'low' -and $parentIntegrity.Known -and $parentIntegrity.Level -eq 'medium') {
  if (-not $AllowLowIntegrityImage) {
    Refuse "the application image '$($exe.FullName)' carries Low integrity while this process is Medium, so the app cannot write up to its own profile or temp. Rebuild with an outside CARGO_TARGET_DIR, or pass -AllowLowIntegrityImage to launch anyway. No relabel was attempted."
  }
  Write-Host '    WARNING: launching a Low-integrity application image.' -ForegroundColor Yellow
}

# Point the supervisor at the MATERIALIZED payload's adapter. Node resolves bare
# specifiers relative to the importing file, so the adapter must live inside the
# payload tree itself: copying it beside the executable fails with
# ERR_MODULE_NOT_FOUND, and the old `host-stage` junction tree lacked the profile
# closure entirely (finding F-13).
$adapter = $payloadAdapter
Write-Host "    adapter -> $adapter" -ForegroundColor DarkGray

# --- 5. Launch with isolated state ----------------------------------------
Write-Step 'Launching the assembled application'
# No deletion: the handoff paths are fresh by construction (step 0 refused an
# existing run root), and the app creates them with CREATE_NEW so a leftover file
# could only ever be a real error rather than something to clean away.

# Remember the caller's environment so it can be restored on every exit path.
# Leaving DSH_HOME or the DSH_DESKTOP_* overrides set would silently change the
# behaviour of every later command in this shell.
$RestoreEnv = @{}
foreach ($name in @('DSH_HOME', 'DSH_DESKTOP_USER_DATA_DIR', 'DSH_DESKTOP_RUNTIME_DIR',
    'DSH_DESKTOP_SHELL_DIR', 'DSH_DESKTOP_NODE', 'DSH_DESKTOP_RUNTIME_ADAPTER',
    'DSH_DESKTOP_DEV_URL_FILE', 'DSH_DESKTOP_DEV_BOOT_FILE', 'RUST_LOG', 'TEMP', 'TMP',
    'DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE')) {
  $RestoreEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
function Restore-CallerEnvironment {
  foreach ($name in $RestoreEnv.Keys) {
    if ($null -eq $RestoreEnv[$name]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $RestoreEnv[$name], 'Process') }
  }
}

# The runtime interpreter is the PAYLOAD's own pinned interpreter, resolved through the
# shared trusted resolver: it proves byte equality with the payload bytes, reads the
# pinned `--version` from a real child, refuses unknown parent/image evidence and runs
# the write/pipe/sentinel/watchdog preflight from an outside owned root. There is NO
# system-node fallback: an arbitrary PATH node is never used, and a failure here
# refuses the run rather than degrading.
try {
  $executionNode = Resolve-DshTrustedExecutionNode -StagedExecutable $payloadNode `
    -PinManifestPath (Join-Path $PortRoot 'installer\node-runtime.json')
} catch {
  Refuse "could not resolve a trusted runtime interpreter from the payload interpreter '$payloadNode': $($_.Exception.Message)"
}
$nodePath = $executionNode.Path
Write-Host "    DSH_DESKTOP_NODE -> $nodePath (trusted copy of the payload interpreter; source=$($executionNode.Source))" -ForegroundColor DarkGray

$env:DSH_HOME = $RunHome
$env:DSH_DESKTOP_USER_DATA_DIR = $UserData
$env:DSH_DESKTOP_RUNTIME_DIR = $payloadDsh
$env:DSH_DESKTOP_SHELL_DIR = if ($ShellDirectory) { Resolve-FullPath $ShellDirectory } else { Join-Path $PortRoot 'ui\dist' }
$env:DSH_DESKTOP_NODE = $nodePath
$env:DSH_DESKTOP_RUNTIME_ADAPTER = $adapter
$env:DSH_DESKTOP_DEV_URL_FILE = $UrlFile
$env:DSH_DESKTOP_DEV_BOOT_FILE = $BootFile
# The owned credential namespace. Without this the app uses the PRODUCTION Windows
# Credential Manager, and a qualification run can read, write or delete real user
# credentials. The fence validates it (debug build only, canonical UUID, owned root
# `<repo>\.scratch\native-{UUID}`) and rejects it rather than degrading.
$env:DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE = $Namespace
$env:RUST_LOG = 'dsh_runtime=debug,dsh_gateway=debug,dsh_desktop=debug'
Write-Host "    DSH_DESKTOP_RUNTIME_DIR = $payloadDsh" -ForegroundColor DarkGray
Write-Host "    DSH_DESKTOP_SHELL_DIR   = $env:DSH_DESKTOP_SHELL_DIR" -ForegroundColor DarkGray
Write-Host "    DSH_DESKTOP_DEV_URL_FILE= $UrlFile" -ForegroundColor DarkGray
Write-Host "    DSH_DESKTOP_DEV_BOOT_FILE= $BootFile" -ForegroundColor DarkGray
Write-Host "    DSH_DESKTOP_OWNED_CREDENTIAL_NAMESPACE = $Namespace" -ForegroundColor DarkGray

# Everything from the launch to the verdict runs inside ONE try/finally, so the
# caller's environment (including the namespace) is restored on EVERY path: a refusal,
# an early exit, a verify failure and an exception all restore it.
$result = 0
try {
  $proc = Start-Process -FilePath $exe.FullName -PassThru
  Write-Host "    pid $($proc.Id)" -ForegroundColor DarkGray

  if (-not $Verify) {
    Write-Host ''
    Write-Host "Launched. Diagnostic log and crash reports under $RunHome" -ForegroundColor Green
    Write-Host "Dev gateway URL file: $UrlFile" -ForegroundColor Green
    # The launcher exits, but the environment it set was for the CHILD process; the
    # caller's shell must not inherit it. The enclosing finally restores it too, so
    # this path is covered whether or not `exit` unwinds through the finally here.
    Restore-CallerEnvironment
    exit 0
  }

# --- 6. Verify the assembled flow -----------------------------------------
Write-Step "Waiting up to ${WaitSeconds}s for host readiness (boot-payload handoff)"
$boot = $null
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ((Get-Date) -lt $deadline) {
  if (Test-Path $BootFile) {
    try {
      $candidate = Get-Content $BootFile -Raw | ConvertFrom-Json
      if ($null -ne $candidate.streamBaseUrl) { $boot = $candidate; break }
    } catch {
      # The file exists but is not yet complete JSON: keep waiting rather than
      # failing, because the write is not atomic from the reader's perspective.
    }
  }
  if ($proc.HasExited) { throw "The application exited early with code $($proc.ExitCode). Check the crash reports under $RunHome." }
  Start-Sleep -Milliseconds 500
}
if ($null -eq $boot) {
  throw "The host never reached 'ready' within ${WaitSeconds}s. The gateway URL file may exist - it is published BEFORE host authentication - but no boot payload was written, which means the host did not boot. Read the crash report's structured host-diagnostic section under $RunHome."
}
Write-Host '    host ready and gateway attached' -ForegroundColor Green
Write-Host "    streamBaseUrl     : $($boot.streamBaseUrl)" -ForegroundColor DarkGray
Write-Host "    bootstrapBatchUrl : $($boot.bootstrapBatchUrl)" -ForegroundColor DarkGray
Write-Host "    graphRevision     : $($boot.graphRevision)" -ForegroundColor DarkGray

# The launch token stays in the URL file and is deliberately absent from the
# boot JSON; read it only now that readiness is established.
$url = (Get-Content $UrlFile -Raw).Trim()
if ([string]::IsNullOrEmpty($url)) { throw 'The boot payload arrived but the dev gateway URL file is empty.' }

$base = [uri]::new($url)
# Parse the launch token without System.Web (not loaded by default on PS 5.1).
$token = $null
foreach ($pair in $base.Query.TrimStart('?').Split('&')) {
  if ($pair -like 'token=*') { $token = [uri]::UnescapeDataString($pair.Substring(6)); break }
}
if ([string]::IsNullOrEmpty($token)) { throw 'The dev gateway URL carried no token; cannot run the assembled check.' }
$origin = "{0}://{1}" -f $base.Scheme, $base.Authority

# The application must never have taken the live GUI port. Report the port it
# actually bound rather than assuming one, and refuse to probe 3080: that port
# belongs to the user's running Harness.
$boundPort = if ([string]::IsNullOrEmpty($base.Port)) { 80 } else { [int]$base.Port }
Write-Host "    bound port        : $boundPort" -ForegroundColor DarkGray
if ($boundPort -eq $LiveGuiPort) {
  Restore-CallerEnvironment
  Refuse "the application bound port $LiveGuiPort, which belongs to the live Harness GUI. Not probing it."
}

# The verifier runs under the SAME trusted interpreter the host was given, so a Low
# interpreter cannot make the verification step fail for an unrelated reason.
& $nodePath (Join-Path $RepoRoot 'scripts\verify-assembled.mjs') --base $origin --token $token
$result = $LASTEXITCODE
} finally {
  # Restore on EVERY path: refusal, early exit, verify failure and exception.
  Restore-CallerEnvironment
}

Write-Host ''
if ($result -eq 0) { Write-Host 'ASSEMBLED FLOW: PASS' -ForegroundColor Green }
else { Write-Host 'ASSEMBLED FLOW: FAIL (see steps above and the logs)' -ForegroundColor Red }
Write-Host "The application is still running (pid $($proc.Id)). Close it from the tray to test clean shutdown." -ForegroundColor Yellow
exit $result
