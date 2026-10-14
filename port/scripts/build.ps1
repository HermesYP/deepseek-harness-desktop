<#
.SYNOPSIS
  Build, test and package the DeepSeek Harness desktop port.

.DESCRIPTION
  Reproducible entry point for every artifact this port ships. Stages are
  independent and individually selectable; the default runs the full sequence.

  ORDER IS PART OF THE CONTRACT. `bundle` compiles the shell, and the shell's
  build script validates every `bundle.resources` source path at build-script
  time. A resource root that does not exist when `cargo` runs therefore fails the
  compile with `resource path ... doesn't exist`, which names the symptom and not
  the cause. The order below is the fix:

      ui    -> renders port/ui/dist                     (a resource root)
      runtime -> materialises port/runtime-payload/dsh  (a resource root)
      core  -> compiles; both resource roots now exist
      verify
      bundle

  `-Stage all` follows that order. Requesting `core` or `bundle` alone still
  runs the resource stages first unless `-SkipResourceStages` is passed, because
  a compile that silently depends on a previously staged tree is exactly the
  trap this ordering exists to remove.

  Publication is atomic. The runtime stage materialises into a sibling staging
  directory, validates it in full, and swaps it into place with a directory
  rename, keeping the previous tree as `<published>.previous` until the stage
  commits. `port/runtime-payload/dsh` is therefore never observably absent or
  half-written (findings F-41 and F-46).

  The runtime is self-contained: a pinned Node.js interpreter is staged from an
  archive whose SHA-256 is declared in `port/installer/node-runtime.json` and
  verified before extraction. A build never falls back to a system Node.js.

  Safety: never sets or inherits DSH_HOME from the caller's profile. Any run that
  launches a dsh process uses a throwaway home under port\.scratch\ and a port
  above 3084, because a live agent harness owns C:\Users\Yoova\.dsh and port 3080.

.PARAMETER Stage
  ui                 build the preserved web client shell
  core               cargo build + test + clippy for the Rust workspace
  runtime            stage the supervised dsh runtime payload and the pinned Node
  bundle             cargo tauri build (release + NSIS installer)
  verify             run the interface-fixture parity tests on both language sides
  packaging-tests    run the packaging helper regression tests
  all                every stage in order (default)

.PARAMETER Release
  Build with --release. Implied by the bundle stage.

.PARAMETER SkipResourceStages
  Do not implicitly run the ui and runtime stages before `core` or `bundle`. Use
  only when those roots are known to be current; the build then does not verify
  that they are.

.PARAMETER NodeArchivePath
  A locally provisioned pinned Node archive. Its SHA-256 must match
  `port/installer/node-runtime.json`; a mismatch is refused. The `ui` stage uses it
  (after the digest check and before extraction) whenever the staged payload
  interpreter is not present yet - the normal state on a fresh checkout, because
  the `ui` stage runs before the `runtime` stage. Without it, the archive is taken
  from the `port\.scratch\node-cache` cache; that cache and this parameter are the
  only two sources, and a system Node.js is never substituted.

.PARAMETER AllowNodeDownload
  Permit downloading the pinned Node archive from its declared HTTPS URL. When
  omitted, the archive must already be in the cache or supplied with
  -NodeArchivePath, and the stage fails with guidance rather than substituting a
  system Node.js.

.PARAMETER RuntimeQualificationName
  With -Stage runtime only, create a new scratch-owned output and manifest record
  under port/.scratch/rq-NAME (with a short rt/ payload parent). Existing qualification roots
  are refused. This does not replace the normal runtime or installer manifest,
  rebuild client plugins, run the desktop, install, or publicly publish anything.

.PARAMETER ClientUpdatesQualificationBuildName
  With a new runtime qualification only, use index.js, client.js and its map from
  a materialized directory named under port/.scratch. Records their digests and
  copies them before sealing. Never overwrites the tracked plugin build output.

.PARAMETER UpdatePayloadManifest
  Overwrite the recorded payload manifest with the freshly built one. Without
  this switch a payload whose bytes differ from the record fails the stage, which
  is what makes dependency drift visible instead of silent.

.PARAMETER RuntimeEsbuildPath
  An optional source for the runtime staging child's esbuild compiler. The staging
  program loads upstream TypeScript through `--import tsx/esm`, so it runs tsx's own
  esbuild, which is a different release from the UI child's. By default that release
  is resolved from the checkout's tsx dependency and copied into a trusted Medium
  root outside the labelled tree. This parameter selects WHERE those same bytes come
  from; the file must be byte-identical to the resolved compiler (otherwise the stage
  refuses a substituted compiler), must be a regular non-link file, and must produce
  a Medium child token. The override is scoped to the runtime staging child and
  restored afterwards; it is never visible to the UI stage or the seal.

.PARAMETER UpstreamRoot
  An explicitly owned upstream checkout to stage and link from, instead of the
  repository's own `_upstream` reference. Precedence is this parameter, then
  `$env:DSH_UPSTREAM_ROOT`, then `<repo>/_upstream`. The checkout is read-only:
  nothing here writes to it. A missing checkout, a checkout with no root
  `package.json`, or one without the files the runtime stage imports fails the
  stage with an actionable message rather than falling back silently.

.EXAMPLE
  .\port\scripts\build.ps1 -Stage all -Release

.EXAMPLE
  .\port\scripts\build.ps1 -Stage core

.EXAMPLE
  .\port\scripts\build.ps1 -Stage runtime -UpstreamRoot C:\owned\dsh-0.2.1-alpha.2
#>
[CmdletBinding()]
param(
  [ValidateSet('ui', 'core', 'runtime', 'runtime-lock-refresh', 'bundle', 'verify', 'packaging-tests', 'all')]
  [string]$Stage = 'all',
  [switch]$Release,
  [switch]$SkipResourceStages,
  [string]$NodeArchivePath,
  [switch]$AllowNodeDownload,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
  [string]$RuntimeQualificationName,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
  [string]$ClientUpdatesQualificationBuildName,
  [switch]$UpdatePayloadManifest,
  # An explicitly attested interpreter to EXECUTE the runtime staging program with.
  # Omitted (the normal case), a hash-equal copy of the pinned interpreter is made
  # in an outside owned root and preflighted. This never changes which bytes ship:
  # Install-PinnedNodeInto still installs the pinned archive bytes into the payload.
  [string]$AttestedNodePath,
  [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$')]
  [string]$RuntimeLockCandidateName,
  [string]$RuntimeLockStageRoot,
  [string]$RuntimeLockCandidateRoot,
  # An optional byte-identical source for the runtime staging child's esbuild.
  # See .PARAMETER RuntimeEsbuildPath.
  [string]$RuntimeEsbuildPath,
  # An explicitly owned upstream checkout. See .PARAMETER UpstreamRoot.
  [string]$UpstreamRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
# The upstream checkout is an explicit input rather than a fixed path, so an
# externally owned qualification clone is a supported staging source. Precedence:
# -UpstreamRoot, then $env:DSH_UPSTREAM_ROOT, then the repository's own checkout.
$UpstreamRequested = $UpstreamRoot
if (-not $UpstreamRequested) { $UpstreamRequested = $env:DSH_UPSTREAM_ROOT }
if (-not $UpstreamRequested) { $UpstreamRequested = Join-Path $RepoRoot '_upstream' }
# Canonicalize when it exists; otherwise keep the requested path so the failure
# names what the caller asked for.
$Upstream = $UpstreamRequested
if (Test-Path -LiteralPath $UpstreamRequested -PathType Container) {
  $Upstream = (Resolve-Path -LiteralPath $UpstreamRequested).Path
}
$UiDir = Join-Path $PortRoot 'ui'
$TauriDir = Join-Path $PortRoot 'src-tauri'
$AppDir = Join-Path $TauriDir 'app'
$Scratch = Join-Path $PortRoot '.scratch'
$InstallerDir = Join-Path $PortRoot 'installer'
$PayloadRoot = Join-Path $PortRoot 'runtime-payload'
$RuntimeLockInputs = Join-Path $PortRoot 'runtime-locks\windows-x64'
$qualificationRoot = $null
$qualificationClientBuild = $null
if ($ClientUpdatesQualificationBuildName) {
  if ($Stage -ne 'runtime' -or -not $RuntimeQualificationName) {
    throw '-ClientUpdatesQualificationBuildName requires -Stage runtime and a new -RuntimeQualificationName.'
  }
  $qualificationClientBuild = Join-Path $Scratch $ClientUpdatesQualificationBuildName
  foreach ($candidate in @($PortRoot, $Scratch, $qualificationClientBuild)) {
    $item = Get-Item -LiteralPath $candidate -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Qualification plugin input is not a materialized owned directory: $candidate"
    }
  }
  foreach ($name in @('index.js', 'client.js', 'client.js.map')) {
    $item = Get-Item -LiteralPath (Join-Path $qualificationClientBuild $name) -Force -ErrorAction Stop
    if ($item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
      throw "Qualification plugin input is not a materialized file: $name"
    }
  }
}
if ($RuntimeQualificationName) {
  if ($Stage -ne 'runtime') {
    throw '-RuntimeQualificationName is allowed only with -Stage runtime.'
  }
  # Only a simple name is accepted, not an arbitrary path. Reject reparse-point
  # parents and an existing output before any materialization or cleanup runs.
  foreach ($parent in @($PortRoot, $Scratch)) {
    if (Test-Path -LiteralPath $parent) {
      $item = Get-Item -LiteralPath $parent -Force
      if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Qualification parent is not an owned materialized directory: $parent"
      }
    }
  }
  $qualificationRoot = Join-Path $Scratch "rq-$RuntimeQualificationName"
  if (Test-Path -LiteralPath $qualificationRoot) {
    throw "Refusing to overwrite an existing qualification root: $qualificationRoot"
  }
  $null = New-Item -ItemType Directory -Path $Scratch -Force
  $null = New-Item -ItemType Directory -Path $qualificationRoot -ErrorAction Stop
  # Keep owned qualification paths short without weakening MAX_PATH checks.
  $PayloadRoot = Join-Path $qualificationRoot 'rt'
}
$PayloadDsh = Join-Path $PayloadRoot 'dsh'
$PackagingTests = Join-Path $PortRoot 'tests\packaging'
if ($Stage -eq 'runtime-lock-refresh') {
  if (-not $RuntimeLockCandidateName -or -not $RuntimeLockStageRoot -or -not $RuntimeLockCandidateRoot) {
    throw '-Stage runtime-lock-refresh requires -RuntimeLockCandidateName, a fresh -RuntimeLockStageRoot, and an outside -RuntimeLockCandidateRoot.'
  }
  if ($RuntimeQualificationName -or $ClientUpdatesQualificationBuildName) {
    throw 'Runtime lock refresh cannot be combined with payload qualification options.'
  }
} elseif ($RuntimeLockCandidateName -or $RuntimeLockStageRoot -or $RuntimeLockCandidateRoot) {
  throw 'Runtime lock candidate parameters are allowed only with -Stage runtime-lock-refresh.'
}

Import-Module (Join-Path $PSScriptRoot 'lib\publish.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib\payload-manifest.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib\node-runtime.psm1') -Force
Import-Module (Join-Path $PSScriptRoot 'lib\runtime-payload.psm1') -Force

function Write-Stage([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Tool([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required tool '$Name' was not found on PATH. $Hint"
  }
}

function Assert-UpstreamCheckout {
  <#
  .SYNOPSIS
    Fail closed unless the resolved upstream checkout can serve every stage.
  .DESCRIPTION
    Three inputs are load-bearing: the root manifest (release version and the
    pnpm packageManager every stage derives its toolchain from), the Desktop Host
    protocol source the runtime staging imports `DESKTOP_HOST_PROTOCOL_VERSION`
    from, and the package-set preparer it imports. A checkout missing any of them
    is refused here rather than failing later inside staging.
  #>
  if (-not (Test-Path -LiteralPath $Upstream -PathType Container)) {
    throw "The upstream checkout was not found at $Upstream. Pass -UpstreamRoot <path> or set DSH_UPSTREAM_ROOT, and run 'pnpm install; pnpm run build' there first (see docs/build-and-install.md section 2)."
  }
  foreach ($relative in @('package.json', 'apps\desktop\src\host-protocol.ts', 'apps\desktop\scripts\prepare-package-set.ts')) {
    if (-not (Test-Path -LiteralPath (Join-Path $Upstream $relative) -PathType Leaf)) {
      throw "The upstream checkout at $Upstream has no $relative; it cannot serve the runtime stage. Refusing to stage from a checkout that is not the supported target."
    }
  }
  Assert-UpstreamLinkMatches
}

function Get-UpstreamPackageManager {
  <#
  .SYNOPSIS
    The pnpm packageManager the upstream checkout declares, verbatim.
  .DESCRIPTION
    Staging resolves its pnpm entry point from this value, so it is read from the
    checkout rather than repeated as a literal that can drift from it.
  #>
  $manifest = Get-Content -LiteralPath (Join-Path $Upstream 'package.json') -Raw | ConvertFrom-Json
  $manager = [string]$manifest.packageManager
  if (-not $manager.StartsWith('pnpm@')) {
    throw "The upstream checkout at $Upstream declares no pnpm packageManager; refusing to guess the package manager."
  }
  return $manager
}

function Assert-UpstreamLinkMatches {
  <#
  .SYNOPSIS
    The generated `port/.upstream` junction must point at the selected root.
  .DESCRIPTION
    The shell build (`port/ui/shell/vite.config.ts`), the port's tsdown preset and
    the desktop bridge read upstream sources through that junction with STATIC
    specifiers, because esbuild inlines them when the Vite config is bundled. If
    the junction pointed at a different checkout than the one being staged from,
    the build would silently mix two revisions -- exactly the substitution the
    explicit root exists to prevent. An absent junction is not an error: it is
    created by `port/ui/link-toolchain.ps1` before the UI stage builds.
  #>
  $linkPath = Join-Path $PortRoot '.upstream'
  $item = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
  if ($null -eq $item) { return }
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "The generated upstream link path is an ordinary file or directory: $linkPath. It must be the junction link-toolchain.ps1 creates; remove it deliberately."
  }
  $linkTarget = @($item.Target)[0]
  if (-not $linkTarget) { throw "The generated upstream link exposes no target: $linkPath" }
  $linkTarget = [System.IO.Path]::GetFullPath($linkTarget)
  if (-not [string]::Equals($linkTarget, $Upstream, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The generated upstream link points at $linkTarget, but this build selected $Upstream. Re-run port/ui/link-toolchain.ps1 with the same root; the shell build would otherwise read a different checkout than the one staged from."
  }
}

function Invoke-Checked([string]$File, [string[]]$Arguments, [string]$WorkDir) {
  Write-Host "    $File $($Arguments -join ' ')" -ForegroundColor DarkGray
  Push-Location $WorkDir
  # Every tool here legitimately writes progress and warnings to stderr: cargo,
  # pnpm, vite. Under this script's ErrorActionPreference = 'Stop', PowerShell
  # turns that into a terminating NativeCommandError that ABORTS the build even
  # when the tool succeeded -- which silently killed the client build (finding
  # F-37) and made an earlier `cargo tauri build` appear to fail only to pass on
  # retry. Scope the preference down for the call and judge success purely by the
  # exit code.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $File @Arguments
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
  }
  if ($exitCode -ne 0) { throw "'$File $($Arguments -join ' ')' failed with exit code $exitCode" }
}

# Isolation: every launched dsh process gets a throwaway home. See
# docs/verification-report.md finding F-1 for why this is unconditional.
#
# The scratch variable is deliberately NOT named `$home`: PowerShell's `$HOME` is
# a read-only automatic variable, assignments to it fail, and because variable
# names are case-insensitive the failure is silent -- the caller then exports
# whatever `$home` already held. That is how the port once ran an installed
# application with `DSH_HOME=C:\Users\<user>` (finding F-36). The resolved value
# is asserted to be under the scratch root before it is exported.
# Compiled-resource qualification (built-in-only Node helper): the Tauri
# build-script resource copy is a DIRECTORY MERGE -- files left behind by a
# previous payload are never removed -- so a compile passing is not evidence
# the shipped tree is current. The guard verifies exact file membership plus
# byte identity of the compiled exe-relative `dsh` and `ui` mirrors against
# the sealed published sources and refuses on missing, EXTRA (the stale-file
# class) or content-mismatched files. Strictly read-only: no move, delete,
# rename or write of any resource tree, and no file content is ever logged.
#
# ARTIFACT AUTHORITATIVENESS: the cargo message stream is captured from the
# ORIGINAL compile itself (same arguments, workdir and features -- never a
# second rebuild, which after a tauri build would use a different feature set
# and could overwrite the very executable being qualified). Rendered compiler
# diagnostics stay visible on stderr; only the JSON message stream is captured.

function Get-CompiledResourceArtifactJson([string[]]$CargoArgs) {
  $artifactJson = Join-Path $Scratch ("cargo-artifacts-{0}.json" -f [guid]::NewGuid().ToString('N'))
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $TauriDir
  try {
    & cargo @CargoArgs --message-format=json-render-diagnostics > $artifactJson
    $cargoExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
  }
  if ($cargoExit -ne 0) { throw "cargo build failed with exit code $cargoExit" }
  return $artifactJson
}

# Parse the captured cargo JSON stream for the dsh-desktop bin executable.
# Fail-closed: zero or multiple distinct executables refuse. Malformed line
# CONTENT is never echoed (sensitive compiler/build-script text).
function Get-ArtifactExeFromCargoJson(
  [string]$ArtifactJsonPath,
  [ValidateSet('cargo', 'tauri-build')][string]$Stream = 'cargo'
) {
  $exePaths = @()
  $lineNumber = 0
  $buildFinished = $false
  foreach ($line in (Get-Content -LiteralPath $ArtifactJsonPath)) {
    $lineNumber += 1
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $trimmed = $line.Trim()
    if ($Stream -eq 'tauri-build' -and -not ($trimmed.StartsWith('{') -or $trimmed.StartsWith('['))) { continue }
    try { $entry = $line | ConvertFrom-Json } catch { throw "malformed cargo JSON at line $lineNumber; line content is never echoed" }
    if ($entry.reason -ceq 'build-finished') {
      if ($entry.success -isnot [bool] -or -not $entry.success) { throw 'cargo build-finished did not report success' }
      $buildFinished = $true
    }
    if ($entry.reason -ceq 'compiler-artifact' -and $entry.target.name -ceq 'dsh-desktop' -and
        $entry.target.kind -ccontains 'bin' -and $entry.executable) {
      if ($entry.executable -isnot [string] -or -not [System.IO.Path]::IsPathRooted($entry.executable) -or
          $entry.executable -match '^[A-Za-z]:(?:$|[^\\/])') { throw 'cargo executable must be an absolute path' }
      $exePaths += $entry.executable
    }
  }
  if (-not $buildFinished) { throw 'captured cargo JSON has no successful build-finished record' }
  if ($exePaths.Count -eq 0) { throw 'no dsh-desktop bin artifact found in the captured cargo JSON' }
  # Force @() so Select-Object -Unique on a single-element string array
  # returns an array, not the string itself (whose [0] would be a character).
  $distinct = @($exePaths | Select-Object -Unique)
  if ($distinct.Count -gt 1) { throw "ambiguous: $($distinct.Count) distinct dsh-desktop executables in the cargo JSON" }
  return $distinct[0]
}

function Assert-CompiledResourceMirrorsFromJson(
  [string]$ArtifactJsonPath,
  [ValidateSet('cargo', 'tauri-build')][string]$Stream = 'cargo'
) {
  $verifier = Join-Path $PortRoot 'scripts\verify-build-resources.mjs'
  $payloadNode = Join-Path $PortRoot 'runtime-payload\dsh\node\node.exe'
  if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf)) {
    throw "The resource guard needs the published payload interpreter at $payloadNode; run the runtime stage (or drop -SkipResourceStages) first. Nothing was qualified."
  }
  $guardNode = (Resolve-DshTrustedExecutionNodeCached -StagedExecutable $payloadNode).Path
  # Derive the artifact exe, then generate physical-metadata manifests for ALL
  # FOUR trees (sealed sources + compiled mirrors).
  $exe = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $ArtifactJsonPath -Stream $Stream
  $exeDir = Split-Path $exe
  $manifestPath = "$ArtifactJsonPath.physical-metadata.json"
  Write-CombinedResourcePhysicalMetadata `
    (Join-Path $PortRoot 'runtime-payload\dsh') `
    (Join-Path $UiDir 'dist') `
    (Join-Path $exeDir 'dsh') `
    (Join-Path $exeDir 'ui') `
    $manifestPath
  Invoke-Checked $guardNode @(
    $verifier,
    '--artifact-json', $ArtifactJsonPath,
    '--stream', $Stream,
    '--source-dsh', (Join-Path $PortRoot 'runtime-payload\dsh'),
    '--source-ui', (Join-Path $UiDir 'dist'),
    '--physical-metadata', $manifestPath
  ) $PortRoot
  Write-Host '    compiled resource mirrors qualified (exact membership + byte identity + physical metadata)' -ForegroundColor Green
}

function Assert-CompiledResourceMirrorsForExe([string]$ExePath) {
  $verifier = Join-Path $PortRoot 'scripts\verify-build-resources.mjs'
  $payloadNode = Join-Path $PortRoot 'runtime-payload\dsh\node\node.exe'
  if (-not (Test-Path -LiteralPath $payloadNode -PathType Leaf)) {
    throw "The resource guard needs the published payload interpreter at $payloadNode; run the runtime stage (or drop -SkipResourceStages) first. Nothing was qualified."
  }
  $guardNode = (Resolve-DshTrustedExecutionNodeCached -StagedExecutable $payloadNode).Path
  $exeDir = Split-Path $ExePath
  $manifestPath = "$ExePath.physical-metadata.json"
  Write-CombinedResourcePhysicalMetadata `
    (Join-Path $PortRoot 'runtime-payload\dsh') `
    (Join-Path $UiDir 'dist') `
    (Join-Path $exeDir 'dsh') `
    (Join-Path $exeDir 'ui') `
    $manifestPath
  Invoke-Checked $guardNode @(
    $verifier,
    '--exe', $ExePath,
    '--source-dsh', (Join-Path $PortRoot 'runtime-payload\dsh'),
    '--source-ui', (Join-Path $UiDir 'dist'),
    '--physical-metadata', $manifestPath
  ) $PortRoot
  Write-Host '    compiled resource mirrors qualified (exact membership + byte identity + physical metadata)' -ForegroundColor Green
}

# Read-only physical-metadata manifest generator: uses an EXPLICIT directory
# stack (no Get-ChildItem -Recurse, which can follow junctions on PS5) with
# Get-Item + attribute check BEFORE enqueueing dirs, and refuses SparseFile,
# ReparsePoint, Encrypted or any attribute token outside the allowlist.
# Generates a manifest for ONE tree; the caller combines them. No content is
# read or logged.
function Get-ResourceTreePhysicalMetadata([string]$Root) {
  $Root = [System.IO.Path]::GetFullPath($Root)
  $allowed = @('Directory', 'Archive', 'ReadOnly', 'NotContentIndexed')
  $entries = [System.Collections.Generic.List[object]]::new()
  $stack = [System.Collections.Generic.Stack[string]]::new()
  # Do not append '.': EnumerateFileSystemEntries preserves that component and
  # would emit './file' metadata keys instead of the verifier's 'file' keys.
  $stack.Push($Root)
  $rootItem = Get-Item -LiteralPath $Root -Force
  if (-not $rootItem.PSIsContainer) { throw 'resource tree root must be a directory; nothing was qualified' }
  foreach ($token in ($rootItem.Attributes.ToString().Split(','))) {
    $t = $token.Trim()
    if ($t -eq '') { continue }
    if ($allowed -notcontains $t) { throw "resource tree root '$Root' carries unknown attribute '$t' (SparseFile, ReparsePoint, Encrypted etc. are refused); nothing was qualified." }
  }
  $entries.Add(@{ path = '.'; kind = 'directory'; attributes = $rootItem.Attributes.ToString() })
  while ($stack.Count -gt 0) {
    $dir = $stack.Pop()
    foreach ($child in [System.IO.Directory]::EnumerateFileSystemEntries($dir)) {
      $item = Get-Item -LiteralPath $child -Force
      foreach ($token in ($item.Attributes.ToString().Split(','))) {
        $t = $token.Trim()
        if ($t -eq '') { continue }
        if ($allowed -notcontains $t) { throw "resource tree entry '$child' carries unknown attribute '$t' (SparseFile, ReparsePoint, Encrypted etc. are refused); nothing was qualified." }
      }
      $rel = $child.Substring($Root.Length).TrimStart('\', '/').Replace('\', '/')
      if ($item.PSIsContainer) {
        $entries.Add(@{ path = $rel; kind = 'directory'; attributes = $item.Attributes.ToString() })
        $stack.Push($child)
      } else {
        $entries.Add(@{ path = $rel; kind = 'file'; attributes = $item.Attributes.ToString() })
      }
    }
  }
  return $entries.ToArray()
}

# Generate the COMBINED physical-metadata manifest for all four trees, bound
# to canonical roots (schemaVersion 1, per-section {root, entries}).
function Write-CombinedResourcePhysicalMetadata([string]$SourceDsh, [string]$SourceUi, [string]$MirrorDsh, [string]$MirrorUi, [string]$ManifestPath) {
  $manifest = @{
    schemaVersion = 1
    sourceDsh = @{ root = [System.IO.Path]::GetFullPath($SourceDsh).TrimEnd('\', '/'); entries = @(Get-ResourceTreePhysicalMetadata $SourceDsh) }
    sourceUi = @{ root = [System.IO.Path]::GetFullPath($SourceUi).TrimEnd('\', '/'); entries = @(Get-ResourceTreePhysicalMetadata $SourceUi) }
    mirrorDsh = @{ root = [System.IO.Path]::GetFullPath($MirrorDsh).TrimEnd('\', '/'); entries = @(Get-ResourceTreePhysicalMetadata $MirrorDsh) }
    mirrorUi = @{ root = [System.IO.Path]::GetFullPath($MirrorUi).TrimEnd('\', '/'); entries = @(Get-ResourceTreePhysicalMetadata $MirrorUi) }
  }
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $ManifestPath -Encoding utf8
}

function Use-IsolatedHarnessHome([string]$Purpose) {

  $isolatedHome = Join-Path $Scratch "$Purpose-home"
  $null = New-Item -ItemType Directory -Force -Path $isolatedHome
  $resolved = (Resolve-Path -LiteralPath $isolatedHome).Path
  $scratchRoot = (Resolve-Path -LiteralPath $Scratch).Path
  if (-not $resolved.StartsWith($scratchRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to use an isolated home outside the scratch root: $resolved"
  }
  $env:DSH_HOME = $resolved
  $env:DSH_DESKTOP_USER_DATA_DIR = (Join-Path $resolved 'userdata')
  Write-Host "    DSH_HOME isolated to $resolved" -ForegroundColor DarkYellow
}

function Test-Prerequisites {
  Write-Stage 'Prerequisites'
  Assert-UpstreamCheckout
  Assert-Tool 'node' 'Install Node.js 22.19+ or 24+ (upstream engines range).'
  Assert-Tool 'pnpm' "Install $((Get-UpstreamPackageManager)) (matches the target upstream packageManager)."
  Assert-Tool 'cargo' 'Install Rust via rustup with the x86_64-pc-windows-msvc toolchain.'
  if (-not (Test-Path (Join-Path $Upstream 'apps\web\dist'))) {
    throw "The reference web client has not been built. Run 'pnpm install; pnpm run build' in $Upstream first (see docs/build-and-install.md section 2)."
  }
  Write-Host '    ok' -ForegroundColor Green
}

function Get-UpstreamCommit {
  # This script runs with ErrorActionPreference = 'Stop', and a native command
  # that writes to stderr raises a NativeCommandError under that setting. Scope
  # the preference down for the call.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $hash = (& git -C $Upstream rev-parse HEAD 2>$null | Select-Object -First 1)
  } catch {
    $hash = $null
  } finally {
    $ErrorActionPreference = $previousPreference
  }
  if ([string]::IsNullOrWhiteSpace($hash)) {
    throw "Could not read the reference checkout's commit with 'git -C $Upstream rev-parse HEAD'. The payload manifest records this identity, so it must be resolvable."
  }
  return "$hash".Trim()
}

function Build-Ui {
  Write-Stage 'Preserved web client shell (port/ui)'
  Assert-UpstreamCheckout
  Assert-Tool 'pnpm' "Install $((Get-UpstreamPackageManager))."

  # `port/ui` declares no dependencies of its own (an empty manifest and an empty
  # lockfile importer), so `pnpm install` here is a no-op at best and previously
  # risked purging the toolchain links with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR.
  # The toolchain is instead LINKED from the pinned upstream checkout by
  # `port/ui/link-toolchain.ps1`. A fresh checkout needs that step, so the
  # documented build command must perform it rather than relying on a manual run
  # (review finding 5).
  $linkToolchain = Join-Path $UiDir 'link-toolchain.ps1'
  if (-not (Test-Path $linkToolchain)) {
    throw "UI toolchain linker is missing: $linkToolchain"
  }
  & $linkToolchain -UpstreamRoot $Upstream
  # The linker is what points the shell build at the selected checkout; verify it
  # did, rather than trusting that a previous run left it right.
  Assert-UpstreamLinkMatches
  $vite = Join-Path $UiDir 'node_modules\vite\bin\vite.js'
  if (-not (Test-Path $vite)) {
    throw "UI toolchain is not linked: $vite is missing. Build the reference checkout first ('pnpm install; pnpm run build' in $Upstream), then re-run this stage."
  }

  # Build with upstream's OFFICIAL client build profile. `ui-brand-official`
  # registers ONLY when `DSH_CLIENT_BUILD_PROFILE === 'official'`
  # (`packages/client/ui-brand-official/src/client/index.ts:17`); any other value
  # leaves the shell fallbacks in place - the generic mark and the
  # `brand.localBuild` label "DSH Local Build"
  # (`packages/client/locale/src/locales/en.ts:36`) plus a version badge. Building
  # without it is why the port's sidebar did not match the released product
  # (finding F-37).
  #
  # IMPORTANT: setting only the selector `DSH_BUILD_CLIENT_PROFILE` does NOT
  # work. `apps/web`'s vite config forwards whatever `DSH_CLIENT_*` values it
  # INHERITS (`clientBuildEnvironmentDefines` -> the private
  # `clientBuildEnvironment`, which merely collects that prefix), and the profile
  # is applied one level up by the root build script, which resolves it and
  # injects the values (`_upstream/scripts/build.ts:40-41`,
  # `resolveClientBuildEnvironment` at
  # `_upstream/scripts/client-build-environment.ts:187-207`). So the RESOLVED
  # values must be set here.
  $env:DSH_CLIENT_BUILD_PROFILE = 'official'
  $env:DSH_CLIENT_TITLE = 'DeepSeek Harness'
  if (-not $env:DSH_CLIENT_VERSION) {
    $env:DSH_CLIENT_VERSION = (Get-Content (Join-Path $Upstream 'package.json') -Raw | ConvertFrom-Json).version
  }
  if (-not $env:DSH_CLIENT_COMMIT_HASH) {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $hash = (& git -C $Upstream rev-parse --short HEAD 2>$null | Select-Object -First 1)
      if ($hash) { $env:DSH_CLIENT_COMMIT_HASH = "$hash".Trim() }
    } catch {
      Write-Warning "git rev-parse failed: $($_.Exception.Message)"
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    if (-not $env:DSH_CLIENT_COMMIT_HASH) {
      throw 'The official client build profile requires DSH_CLIENT_COMMIT_HASH; set it explicitly (for example $env:DSH_CLIENT_COMMIT_HASH = "477b4f4").'
    }
  }
  Write-Host "    official profile: version $env:DSH_CLIENT_VERSION, commit $env:DSH_CLIENT_COMMIT_HASH" -ForegroundColor DarkGray

  # The UI build runs under the PINNED payload interpreter with a trusted, Medium
  # esbuild copy, never an arbitrary `pnpm`/`node` from PATH and never the Low image
  # under `_upstream/.pnpm`: Vite asks esbuild to remove files in the Medium temp, and
  # a Low esbuild child is denied (the observed `REMOVE Temp/esbuild-... AccessDenied`).
  #
  # `-OutDir port\ui\dist` is an EXISTING, non-empty output tree. The helper never
  # hands it to Vite: it builds into a fresh path inside an owned root outside the
  # labelled tree and then publishes atomically through `lib/publish.psm1` - the
  # current `dist` is RETAINED as `dist.previous` (never deleted) and the validated
  # fresh tree is renamed into place, with rollback if re-validation fails. So the
  # advertised `-Stage ui` works on a checkout that already has a built shell, and
  # on a FRESH checkout too: with no staged payload yet (`-Stage ui` runs before
  # `-Stage runtime`), the interpreter comes from the pinned archive verified and
  # extracted into the owned root, never from a system Node.js.
  Import-Module (Join-Path $PackagingTests 'ui-build-qualification.psm1') -Force
  $uiBuild = Invoke-DshQualifiedUiBuild -PortRoot $PortRoot -OutDir (Join-Path $UiDir 'dist') -RepoRoot $RepoRoot `
    -StagedNodeExecutable $AttestedNodePath -NodeArchivePath $NodeArchivePath -AllowNodeDownload:$AllowNodeDownload
  Write-Host "    vite build under node $($uiBuild.NodeVersion) with esbuild $($uiBuild.EsbuildVersion): files=$($uiBuild.Files) assets=$($uiBuild.Assets) bytes=$($uiBuild.Bytes) published=$($uiBuild.Published) previous=$($uiBuild.PreviousPath)" -ForegroundColor DarkGray

  # Regenerate the port-owned client plugin from its own source. The compiled
  # files are tracked, so a clean checkout already has them - but the advertised
  # all-stage build must not depend on tracked build output, or a source edit to
  # the plugin would only ever be built by hand (live-review finding 2, build
  # gap). `bundle.mjs` runs the pinned upstream tsdown and then verifies the
  # emitted `__ModuleLoader__` wrapper against the authentic shape.
  #
  # It runs under the SAME qualified pinned interpreter as the shell build, with a
  # per-child TEMP inside the owned root and PATH led by the interpreter's own
  # directory: `bundle.mjs` re-spawns `process.execPath` for tsdown, so a bare
  # `node` from PATH would have decided both the bundler and its children.
  $pluginDir = Join-Path $UiDir 'client-updates'
  $pluginBundler = Join-Path $pluginDir 'bundle.mjs'
  if (-not (Test-Path $pluginBundler)) {
    throw "Port client plugin bundler is missing: $pluginBundler"
  }
  $null = Invoke-DshQualifiedNodeScript -NodePath $uiBuild.NodePath -TempRoot $uiBuild.TempDir `
    -ScriptPath $pluginBundler -WorkingDirectory $pluginDir

  # The shell is a `bundle.resources` source. A build that proceeds without it
  # fails later in the Rust build script with a resource-path error, so the
  # missing root is reported here, where it can be acted on.
  $shellIndex = Join-Path $UiDir 'dist\index.html'
  if (-not (Test-Path $shellIndex)) {
    throw "The UI stage produced no shell at $shellIndex; the shell is a bundled resource and cannot be absent."
  }
}

function Build-Core {
  Write-Stage 'Rust application core and Tauri shell (port/src-tauri)'
  Assert-Tool 'cargo' 'Install Rust via rustup.'

  # Tauri's build script validates `bundle.resources` sources at build-script
  # time, so both resource roots must exist BEFORE cargo runs. Report a missing
  # root as the missing stage rather than as a resource-path error (finding F-41).
  Assert-ResourceRootsForCompile

  # Never repair the source-controlled dependency lock as a side effect of a
  # product build. The test/lint gates reuse the resolved build dependencies and
  # must remain offline and strict; a passing cargo build alone is not this gate.
  # The message stream of THIS compile (same arguments, workdir and features) is
  # the authoritative artifact source for the resource guard -- never a second
  # rebuild.
  $cargoArgs = @('build', '--workspace', '--locked')
  if ($Release) { $cargoArgs += '--release' }
  $artifactJson = Get-CompiledResourceArtifactJson $cargoArgs
  # Compiled-resource qualification: the merge-style resource copy passes even
  # when stale files from a previous payload ride along; verify the compiled
  # mirrors byte-exactly right after the compile (finding: 800 stale extras).
  Assert-CompiledResourceMirrorsFromJson $artifactJson
  Invoke-Checked 'cargo' @('test', '--workspace', '--locked', '--offline') $TauriDir
  Invoke-Checked 'cargo' @('clippy', '--workspace', '--all-targets', '--locked', '--offline', '--', '-D', 'warnings') $TauriDir
}

# Report an absent resource root as the stage that produces it.
function Assert-ResourceRootsForCompile {
  $shellDir = Join-Path $UiDir 'dist'
  if (-not (Test-Path (Join-Path $shellDir 'index.html'))) {
    throw "The bundled UI resource root is absent or incomplete: $shellDir. Run -Stage ui (the all-stage order runs it before core)."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $shellDir 'desktop-policy-bootstrap.json') -PathType Leaf)) {
    throw "The bundled UI policy metadata is absent: $shellDir. Run -Stage ui before compiling."
  }
  foreach ($relative in @('adapter.mjs', 'package.json', 'NODE-LICENSE.txt', 'runtime-payload.json', 'desktop-runtime.json')) {
    if (-not (Test-Path -LiteralPath (Join-Path $PayloadDsh $relative) -PathType Leaf)) {
      throw "The bundled runtime resource root is absent or unsealed ($relative): $PayloadDsh. Run -Stage runtime (the all-stage order runs it before core)."
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $PayloadDsh 'node') -PathType Container)) {
    throw "The bundled runtime interpreter is absent: $PayloadDsh. Run -Stage runtime before compiling."
  }
}

function Stage-Runtime {
  Write-Stage 'Supervised dsh runtime payload (staged, validated, then published atomically)'
  Assert-UpstreamCheckout
  $runtimeTarget = Get-CurrentNodeTargetName
  if ($runtimeTarget -ne 'win-x64') {
    throw "Runtime target '$runtimeTarget' is explicitly unqualified; reviewed runtime locks currently exist only for win-x64. No payload was published."
  }

  # A previously interrupted publication is resolved before anything else, so the
  # published root is in a known state and the last known-good payload is not
  # destroyed by a new attempt.
  $repair = Repair-DshInterruptedPublication -PublishedPath $PayloadDsh `
    -Required (@(Get-DshPayloadAnchorFiles) + @('adapter.mjs', 'runtime-payload.json', 'desktop-runtime.json'))
  if ($repair.Action -ne 'none') {
    Write-Host "    recovered an interrupted publication: $($repair.Detail)" -ForegroundColor DarkYellow
  }

  # Own a fresh, short SIBLING for the atomic rename. Never erase a prior stage:
  # failed materializations and successful build inputs remain audit evidence.
  $stageRoot = Join-Path $PayloadRoot ('dsh.s-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
  if (Test-Path -LiteralPath $stageRoot) { throw "Runtime staging path already exists: $stageRoot" }
  $null = New-Item -ItemType Directory -Path $stageRoot

  try {
    Stage-RuntimeInto -StageRoot $stageRoot -LockMode 'frozen' -LockInputRoot $RuntimeLockInputs -UpstreamCommit (Get-UpstreamCommit)

    # Two DIFFERENT trees are validated here, and conflating them was a blocker:
    # the staging root is the build's workspace (`packed/`, `work/`, `node/`,
    # `dsh/`, the staging program and the identity record), while the SHIPPED
    # shape is the inner `dsh/` tree. Asserting the payload set against the
    # staging root rejects a correct stage outright.
    # The pnpm work tree is not shipped. Its filesystem paths may exceed the
    # legacy bundler limit; keep that 260-character limit on the INNER payload
    # and relocated published tree below, not on discarded workspace inputs.
    $stageFact = Assert-DshStagedTree -Path $stageRoot -MaxPathLength 32767 `
      -ExpectedTopLevel (Get-DshStagingTopLevel) `
      -Required @('node-identity.json', 'stage-runtime.mjs')

    # Validate the PAYLOAD shape before publication, so a bad tree never becomes
    # the published one. This runs against the staged copy of the payload, which
    # is why the pre- and post-swap checks compare the same tree shape.
    $anchors = @(Get-DshPayloadAnchorFiles) + @('adapter.mjs', 'package.json', 'NODE-LICENSE.txt')
    $requiredDirectories = @(Get-DshPayloadAnchors) + @('node')
    $stagedPayload = Get-DshStagedPayloadPath -StageRoot $stageRoot
    $null = Assert-DshStagedTree -Path $stagedPayload -Required $anchors `
      -RequiredDirectories $requiredDirectories -StrictReparsePoints `
      -ExpectedTopLevel (Get-DshPayloadTopLevel)

    # The manifest records what shipped, tied to the pinned inputs. A payload
    # whose bytes differ from the record is drift, and drift fails the build
    # rather than shipping quietly different bytes.
    #
    # The manifest is built over the PAYLOAD tree, not the staging root: the
    # shipped tree is the only thing whose bytes are being pinned, and inventorying
    # the staging root would fold the workspace into the record and make every
    # build differ.
    $nodeIdentity = Get-StagedNodeIdentity -StageRoot $stageRoot
    $manifest = New-DshPayloadManifest -Root $stagedPayload `
      -Inputs (Get-PayloadInputs -StageRoot $stageRoot) `
      -UpstreamCommit (Get-UpstreamCommit) `
      -Version (Get-ProductVersion) `
      -HostProtocolVersion (Get-StagedHostProtocolVersion -StageRoot $stageRoot) `
      -NodeIdentity $nodeIdentity `
      -RequiredLicenses @('NODE-LICENSE.txt')
    # `node.sha256` stays the ARCHIVE digest that `installer/node-runtime.json` pins;
    # `node.executableSha256` is the observed digest of the interpreter binary the
    # payload actually ships, carried so the shipped record names its own bytes rather
    # than only the archive they came from. The sealer reads the executable digest from
    # node-identity.json, so this field is metadata for inspection, not a second
    # enforcement point, and it is absent from a legacy identity record rather than
    # invented. Read through PSObject so a record without it stays valid.
    $executableDigest = $nodeIdentity.PSObject.Properties['ExecutableSha256']
    if ($null -ne $executableDigest -and $executableDigest.Value) {
      $manifest.node | Add-Member -NotePropertyName 'executableSha256' -NotePropertyValue ([string]$executableDigest.Value)
    }
    Write-DshPayloadManifest -Manifest $manifest -Path (Join-Path $stagedPayload 'runtime-payload.json')

    # The port manifest excludes both root metadata files; the upstream descriptor
    # then hashes the completed manifest. No payload writes follow this seal.
    Invoke-StagedRuntimeSeal -StageRoot $stageRoot -DshRoot $stagedPayload
    if ($qualificationRoot) {
      # Preserve the actual observations used by the payload interpreter before
      # the staging workspace is cleaned. These are evidence, not shipped files.
      Copy-Item -LiteralPath (Join-Path $stageRoot 'work\runtime-identity.json') `
        -Destination (Join-Path $qualificationRoot 'stage-identity.json')
      Copy-Item -LiteralPath (Join-Path $stageRoot 'node-identity.json') `
        -Destination (Join-Path $qualificationRoot 'node-identity.json')
    }
    Assert-PayloadManifestMatches -Manifest $manifest
    $anchors += @('runtime-payload.json', 'desktop-runtime.json')
    $fact = Assert-DshStagedTree -Path $stagedPayload -Required $anchors `
      -RequiredDirectories $requiredDirectories -StrictReparsePoints `
      -ExpectedTopLevel (Get-DshPayloadTopLevel)
    Write-Host "    validated: stagingFiles=$($stageFact.FileCount), payloadFiles=$($fact.FileCount), reparsePoints=$($fact.ReparsePointCount), deepestPath=$($fact.DeepestPathLength) chars" -ForegroundColor Green

    $publication = Publish-DshStagedPayload -StageRoot $stageRoot -PublishedPath $PayloadDsh
    try {
      # Re-validate the PUBLISHED tree. The staging validation ran against the
      # staging path; this proves the swap produced the same tree, which is the
      # claim that matters and is not implied by the first check.
      $publishedFact = Assert-DshStagedTree -Path $PayloadDsh -Required $anchors `
        -RequiredDirectories $requiredDirectories -StrictReparsePoints `
        -ExpectedTopLevel (Get-DshPayloadTopLevel)
      if ($publishedFact.FileCount -ne $fact.FileCount) {
        throw "The published payload has $($publishedFact.FileCount) files but the staged tree had $($fact.FileCount); the swap did not preserve the tree."
      }
      Invoke-StagedRuntimeSeal -StageRoot $stageRoot -DshRoot $PayloadDsh -VerifyOnly
      Complete-DshPublishedTree -PublishedPath $PayloadDsh
    } catch {
      $restored = Restore-DshPublishedTree -PublishedPath $PayloadDsh
      if ($restored) {
        throw "Publication failed and the previous payload was restored: $($_.Exception.Message)"
      }
      throw "Publication failed and there was no previous payload to restore: $($_.Exception.Message)"
    }
    Write-Host "    published -> $PayloadDsh" -ForegroundColor DarkGray
  } finally {
    Write-Host "    preserved runtime build workspace -> $stageRoot" -ForegroundColor DarkGray
  }
}

function Stage-RuntimeLockRefresh {
  Write-Stage 'Runtime lock refresh (candidate only; no payload publication)'
  Assert-UpstreamCheckout
  if ((Get-CurrentNodeTargetName) -ne 'win-x64') {
    throw 'Runtime lock refresh is currently qualified only for win-x64.'
  }
  $root = [System.IO.Path]::GetFullPath($RuntimeLockStageRoot)
  if (-not (Test-Path -LiteralPath $root -PathType Container)) {
    throw "Runtime lock stage root must be a fresh New-DshQualificationRoot directory: $root"
  }
  Import-Module (Join-Path $PackagingTests 'qualification-preflight.psm1') -Force
  Assert-DshNoLinkedAncestors -Path $root
  $repoFull = [System.IO.Path]::GetFullPath($RepoRoot).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $comparison = [System.StringComparison]::OrdinalIgnoreCase
  if ($root.StartsWith($repoFull, $comparison)) {
    throw "Runtime lock refresh executables must be staged outside the workspace: $root"
  }
  if (@(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) {
    throw "Runtime lock stage root is not fresh and empty; preserving it: $root"
  }

  $candidateParent = Split-Path -Parent ([System.IO.Path]::GetFullPath($RuntimeLockCandidateRoot))
  $candidate = [System.IO.Path]::GetFullPath($RuntimeLockCandidateRoot)
  if (-not (Test-Path -LiteralPath $candidateParent -PathType Container)) {
    throw "Runtime lock candidate parent must be a fresh owned directory: $candidateParent"
  }
  Assert-DshNoLinkedAncestors -Path $candidateParent
  if (@(Get-ChildItem -LiteralPath $candidateParent -Force).Count -gt 0) {
    throw "Runtime lock candidate parent is not fresh and empty; preserving it: $candidateParent"
  }
  if ($candidate.StartsWith($repoFull, $comparison) -or
      $candidateParent.StartsWith($repoFull, $comparison)) {
    throw "Runtime lock candidate outputs must remain outside the workspace: $candidate"
  }
  if ((Split-Path -Leaf $candidate) -cne $RuntimeLockCandidateName) {
    throw "Runtime lock candidate directory leaf must equal its validated name: $candidate"
  }
  if (Test-Path -LiteralPath $candidate) {
    throw "Runtime lock candidate already exists and is preserved: $candidate"
  }
  $stageRootPrefix = $root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  $candidateParentPrefix = $candidateParent.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if ([string]::Equals($root, $candidateParent, $comparison) -or
      $candidate.StartsWith($stageRootPrefix, $comparison) -or
      $root.StartsWith($candidateParentPrefix, $comparison)) {
    throw 'Runtime lock candidate output and executable stage must use separate outside roots.'
  }

  Stage-RuntimeInto -StageRoot $root -LockMode 'refresh' `
    -UpstreamCommit (Get-UpstreamCommit) -LockCandidateRoot $candidate
  if (-not (Test-Path -LiteralPath (Join-Path $candidate 'descriptor.json') -PathType Leaf)) {
    throw "Runtime lock refresh produced no candidate descriptor: $candidate"
  }
  Write-Host "RUNTIME_LOCK_CANDIDATE=$candidate" -ForegroundColor Yellow
}

# Materialise the payload into an empty staging directory.
# Execute the runtime staging program with a TRUSTED interpreter image.
#
# The staged interpreter necessarily lives inside the workspace (`$StageRoot\node`),
# and a file created inside the workspace inherits its Low integrity label. Windows
# then starts that image with a Low token, and a Low Node cannot open a named pipe or
# write to the Medium temp it needs -- which is exactly how `-Stage runtime` failed
# with EPERM/EPIPE. The fix is NOT to relabel anything: a fresh, hash-equal COPY is
# made in an outside owned root (a new file in an unlabelled directory is Medium),
# and that copy must pass the real child preflight (process-owned write,
# process-sentinel, named pipe, watchdog) before it is used.
#
# The SHIPPED bytes are untouched: `Install-PinnedNodeInto` still installs the pinned
# archive bytes into the payload, the payload/sealed trees are never relabelled, and
# the global toolchain is never replaced.
function Get-DshTrustedNodeExecutionCopy {
  # Both the default copy path and the explicit-override path now share ONE
  # implementation with the SAME checks (byte equality against the archive-pinned
  # staged interpreter, pinned `--version`, known parent/image evidence, a fresh
  # owned root+temp and the real write/pipe/sentinel/watchdog child preflight).
  # This wrapper exists only so the staging call site has a stable name.
  param(
    [Parameter(Mandatory)][string]$Executable,
    [string]$RequestedRoot
  )

  Import-Module (Join-Path $PackagingTests 'rust-qualification.psm1') -Force
  return (Resolve-DshTrustedExecutionNode -StagedExecutable $Executable `
    -PinManifestPath (Join-Path $InstallerDir 'node-runtime.json') -RequestedRoot $RequestedRoot)
}

# Resolve the interpreter used to RUN the staging program. An explicit attested
# override must be BYTE-IDENTICAL to the archive-pinned staged interpreter and print
# the pinned version; otherwise a trusted outside copy is made. Both paths run the
# real child preflight and return Root/Temp/Preflight.
function Resolve-DshStagingExecutionNode {
  param(
    [Parameter(Mandatory)][string]$StagedExecutable,
    [string]$AttestedPath
  )

  Import-Module (Join-Path $PackagingTests 'rust-qualification.psm1') -Force
  $resolved = Resolve-DshTrustedExecutionNode -StagedExecutable $StagedExecutable `
    -PinManifestPath (Join-Path $InstallerDir 'node-runtime.json') -AttestedPath $AttestedPath
  Write-Host "TRUSTED_NODE_EXECUTION=ok source=$($resolved.Source) path=$($resolved.Path) sha256=$($resolved.Sha256) version=$($resolved.Version) root=$($resolved.Root) temp=$($resolved.Temp)"
  return $resolved
}

function Stage-RuntimeInto(
  [string]$StageRoot,
  [ValidateSet('frozen', 'refresh')][string]$LockMode = 'frozen',
  [string]$LockInputRoot,
  [string]$UpstreamCommit,
  [string]$LockCandidateRoot
) {
  if ((Get-CurrentNodeTargetName) -ne 'win-x64') {
    throw 'Runtime lock closure is qualified only for win-x64; refusing an unreviewed target.'
  }
  if ($LockMode -eq 'refresh' -and -not $LockCandidateRoot) {
    throw 'Runtime lock refresh requires a new candidate output path.'
  }
  if ($LockMode -eq 'frozen' -and (-not $LockInputRoot -or -not $UpstreamCommit)) {
    throw 'Frozen runtime staging requires reviewed lock inputs and the exact upstream commit.'
  }
  $packedRoot = Join-Path $StageRoot 'packed'
  $packedDsh = Join-Path $packedRoot 'dsh'
  $packedHost = Join-Path $packedRoot 'host'
  $packedVendor = Join-Path $packedRoot 'vendor'
  $packedLandlock = Join-Path $packedRoot 'landlock'
  $workRoot = Join-Path $StageRoot 'work'
  foreach ($directory in @($packedDsh, $packedHost, $packedVendor, $packedLandlock, $workRoot)) {
    $null = New-Item -ItemType Directory -Force -Path $directory
  }

  # Native dependency lifecycle scripts must use the eventual Host's pinned
  # Node/ABI, not the build machine's interpreter. Move these same verified
  # bytes into the payload once materialization finishes.
  $pinPath = Join-Path $InstallerDir 'node-runtime.json'
  $pinnedManifest = Get-DshPinnedNodeManifest -ManifestPath $pinPath
  $pinnedTarget = Get-DshPinnedNodeTarget -Manifest $pinnedManifest -Target 'win-x64'
  $archiveForStage = $NodeArchivePath
  if (-not $archiveForStage) {
    $existingArchive = Join-Path (Join-Path $Scratch 'node-archives') (Split-Path -Leaf ([uri]$pinnedTarget.url).AbsolutePath)
    if (Test-Path -LiteralPath $existingArchive -PathType Leaf) { $archiveForStage = $existingArchive }
  }
  $stagingNode = Install-DshPinnedNode -ManifestPath $pinPath -TargetName 'win-x64' `
    -Destination (Join-Path $StageRoot 'node') -CacheRoot (Join-Path $workRoot 'node-archives') `
    -LicenseDestination $workRoot -ArchivePath $archiveForStage -AllowDownload:$AllowNodeDownload

  # Pack the same inputs and select the same roots as upstream's
  # prepare-package-set.ts. Its roots are @deepseek-ai/dsh and
  # @deepseek-ai/dsh-desktop-host; required dependencies and peers (including
  # cordis-plugin-group) are traversed from their manifests, not hand-listed.
  $packageManager = Get-UpstreamPackageManager
  $pnpmVersion = ([string]$packageManager -replace '^pnpm@', '').Split('+')[0]
  $pnpmEntry = Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$pnpmVersion\bin\pnpm.mjs"
  if (-not (Test-Path $pnpmEntry)) { throw "Pinned pnpm entry point not found: $pnpmEntry" }
  $nodeProgram = Join-Path $StageRoot 'stage-runtime.mjs'
  Write-DshRuntimeStageProgram -Path $nodeProgram | Out-Null

  # Upstream uses one directory for both the package set and runtime project:
  # createRuntimeProjectMetadata verifies the package set from projectDir.
  $projectName = if ($qualificationRoot -or $LockMode -eq 'refresh') { 'p' } else { 'runtime-project' }
  $packageSet = Join-Path $workRoot $projectName
  $project = $packageSet
  $identityFile = Join-Path $workRoot 'runtime-identity.json'
  # The materialised tree goes into the staging root, NOT into the published
  # path: nothing may write to the published path except the swap.
  $materialized = Join-Path $StageRoot 'dsh'
  $probeStdout = Join-Path $workRoot 'adapter-resolution.stdout'
  $probeStderr = Join-Path $workRoot 'adapter-resolution.stderr'

  # Windows PowerShell omits null native-argument values, which shifts later
  # positional Node arguments. The unused side of either operation is an explicit
  # sentinel so the imported helper path remains in its declared slot.
  $lockInputArg = if ($LockInputRoot) { $LockInputRoot } else { '-' }
  $lockCandidateArg = if ($LockCandidateRoot) { $LockCandidateRoot } else { '-' }
  $nodeArgs = @('--import', 'tsx/esm', $nodeProgram, $Upstream, $pnpmEntry,
    $packedDsh, $packedHost, $packedVendor, $packedLandlock, $packageSet, $project, $materialized,
    (Join-Path $TauriDir 'runtime\adapter.mjs'),
    $probeStdout, $probeStderr, $identityFile,
    $LockMode, $lockInputArg, $UpstreamCommit, $lockCandidateArg,
    (Join-Path $PSScriptRoot 'lib\runtime-locks.mjs'))
  # EXECUTION interpreter: a trusted outside copy (or an explicit attested one), never
  # the Low-image interpreter staged inside the workspace. The staged bytes stay in
  # place because they are what ships.
  $executionNode = Resolve-DshStagingExecutionNode -StagedExecutable $stagingNode.Executable -AttestedPath $AttestedNodePath
  # The staging program loads upstream TypeScript through `--import tsx/esm`, so tsx
  # runs ITS OWN esbuild -- a different release from the UI child's (which is whatever
  # `apps/web`'s Vite resolves). One process-wide ESBUILD_BINARY_PATH cannot serve
  # both: pointing this child at the UI compiler makes tsx abort with "Host version
  # 0.28.1 does not match binary version 0.25.12". Resolve the release this
  # checkout's tsx ACTUALLY resolves (through its own dependency link, never by range
  # matching) into a trusted Medium copy outside the labelled tree, so a normal build
  # needs no manual environment. The seal needs none of this: it runs no TypeScript.
  Import-Module (Join-Path $PackagingTests 'runtime-esbuild-qualification.psm1') -Force
  $runtimeEsbuild = Resolve-DshTrustedRuntimeEsbuild -UpstreamRoot $Upstream -OverridePath $RuntimeEsbuildPath -RequestedRoot $qualificationRoot
  $oldNpmExecPath = $env:npm_execpath
  $oldPath = $env:PATH
  # TEMP/TMP are set per invocation and restored EXACTLY (absent stays absent, empty
  # stays empty) in the finally. A Medium child needs a Medium temp; leaving the
  # caller's TEMP pointed at a fixture root was a defect in this script's siblings.
  # ESBUILD_BINARY_PATH is scoped and restored the same way, so the UI child can
  # never inherit this compiler and this child can never inherit the UI's.
  $hadTemp = Test-Path -LiteralPath 'Env:TEMP'
  $hadTmp = Test-Path -LiteralPath 'Env:TMP'
  $oldTemp = if ($hadTemp) { $env:TEMP } else { $null }
  $oldTmp = if ($hadTmp) { $env:TMP } else { $null }
  $hadEsbuildBinaryPath = Test-Path -LiteralPath 'Env:ESBUILD_BINARY_PATH'
  $oldEsbuildBinaryPath = if ($hadEsbuildBinaryPath) { $env:ESBUILD_BINARY_PATH } else { $null }
  try {
    $env:npm_execpath = $pnpmEntry
    $env:PATH = (Split-Path -Parent $executionNode.Path) + [IO.Path]::PathSeparator + $oldPath
    if ($executionNode.Temp) {
      $env:TEMP = $executionNode.Temp
      $env:TMP = $executionNode.Temp
      Write-Host "    staging TEMP -> $($executionNode.Temp) (restored on exit)" -ForegroundColor DarkGray
    }
    $env:ESBUILD_BINARY_PATH = $runtimeEsbuild.Path
    Write-Host "    staging ESBUILD_BINARY_PATH -> $($runtimeEsbuild.Path) (esbuild $($runtimeEsbuild.Version), restored on exit)" -ForegroundColor DarkGray
    Invoke-Checked $executionNode.Path $nodeArgs $Upstream
  } finally {
    $env:npm_execpath = $oldNpmExecPath
    $env:PATH = $oldPath
    if ($hadTemp) { $env:TEMP = $oldTemp } else { Remove-Item -LiteralPath 'Env:TEMP' -ErrorAction SilentlyContinue }
    if ($hadTmp) { $env:TMP = $oldTmp } else { Remove-Item -LiteralPath 'Env:TMP' -ErrorAction SilentlyContinue }
    if ($hadEsbuildBinaryPath) { $env:ESBUILD_BINARY_PATH = $oldEsbuildBinaryPath } else { Remove-Item -LiteralPath 'Env:ESBUILD_BINARY_PATH' -ErrorAction SilentlyContinue }
  }

  if (-not (Test-Path $identityFile)) {
    throw "The runtime stage produced no identity record at $identityFile; the payload cannot be tied to its inputs."
  }
  if ($LockMode -eq 'refresh') {
    $candidateDescriptor = Get-Content -LiteralPath (Join-Path $LockCandidateRoot 'descriptor.json') -Raw | ConvertFrom-Json
    if ($candidateDescriptor.reviewStatus -ne 'CANDIDATE' -or $candidateDescriptor.target -ne 'win-x64' -or
        $candidateDescriptor.upstreamCommit -ne $UpstreamCommit) {
      throw 'Runtime lock refresh output is not a matching unreviewed candidate.'
    }
    Write-Host "RUNTIME_LOCK_CANDIDATE=$LockCandidateRoot" -ForegroundColor Yellow
    return
  }

  # Ship the port-owned packages. Upstream's package set is a dependency closure
  # rooted at @deepseek-ai/dsh and desktop-host, so a port-owned package is NOT in
  # it by construction and has to be added explicitly here.
  #
  # BOTH entries are required, and they are not interchangeable:
  #   * the BUNDLE is what `DESKTOP_PROFILE_BUNDLES` selects, so the desktop
  #     profile resolves it; its patch inserts the Updates row and disables the
  #     web-oriented account plugin.
  #   * the CLIENT PLUGIN is the browser row that bundle inserts. The bundle's
  #     manifest declares it as a dependency, which is how the Host resolves the
  #     row's bare name (`packages/client/modules/src/index.ts`, `resolveMeta`).
  # Shipping only the plugin left every fresh profile selecting an unresolved
  # bundle (live-review finding 2). Each entry therefore carries its own file
  # list: a bundle has no compiled `lib`.
  Copy-PortPackages -PayloadRoot $materialized

  # Every bundle the desktop profile selects must RESOLVE from the payload, or a
  # fresh profile quietly composes without that layer. Read the list from the same
  # constant the profile initializer uses rather than restating it here, so this
  # check cannot drift from the thing it guards.
  Assert-ProfileBundlesResolve -PayloadRoot $materialized

  # Package presence alone cannot prove an inserted row will reach the loader.
  # Measure composition with production app-boot before publishing this stage.
  $compositionProbe = Join-Path $PSScriptRoot 'lib\verify-updates-composition.mjs'
  Invoke-Checked $executionNode.Path @($compositionProbe, $materialized, (Join-Path $TauriDir 'crates\dsh-core\src\profile.rs')) $PortRoot

  # The pinned Node interpreter travels inside the payload. Its digest is
  # verified before extraction, and a build never falls back to a system Node
  # (see lib/node-runtime.psm1).
  Install-PinnedNodeInto -StageRoot $StageRoot -PayloadRoot $materialized -Identity $stagingNode

  # Node resolves bare specifiers relative to the importing file, so the adapter
  # must live INSIDE the tree, beside the node_modules it imports from. The
  # staging program copies it there; the copy is re-asserted here because the
  # resource mapping `../../runtime-payload/dsh/` -> `dsh/` ships this directory
  # wholesale and a missing adapter is a non-booting application.
  $adapter = Join-Path $materialized 'adapter.mjs'
  if (-not (Test-Path $adapter)) {
    throw "The staged payload has no adapter.mjs at $adapter; the application cannot start the Host without it."
  }
}

function Copy-PortPackages([string]$PayloadRoot) {
  $portPackages = @(
    @{ Source = (Join-Path $UiDir 'desktop-updates-bundle'); Name = '@dsh-port\dsh-desktop-updates-bundle';
      Files = @('package.json', 'cordis.patch.yml') },
    @{ Source = (Join-Path $UiDir 'client-updates'); Name = '@dsh-port\dsh-client-ui-updates';
      Files = @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'lib\client.js.map') }
  )
  foreach ($package in $portPackages) {
    $packageTarget = Join-Path $PayloadRoot (Join-Path 'node_modules' $package.Name)
    $null = New-Item -ItemType Directory -Force -Path $packageTarget
    foreach ($file in $package.Files) {
      $from = Join-Path $package.Source $file
      if ($qualificationClientBuild -and $package.Name -eq '@dsh-port\dsh-client-ui-updates' -and $file.StartsWith('lib\')) {
        $from = Join-Path $qualificationClientBuild (Split-Path $file -Leaf)
      }
      if (-not (Test-Path $from)) {
        throw "Port package file missing: $from"
      }
      $to = Join-Path $packageTarget $file
      $null = New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent)
      Copy-Item $from $to -Force
    }
    Write-Host "    port package -> $packageTarget" -ForegroundColor DarkGray
  }
  Register-DshPayloadPackages -Root $PayloadRoot `
    -Names @($portPackages | ForEach-Object { $_.Name -replace '\\', '/' })
}

function Assert-ProfileBundlesResolve([string]$PayloadRoot) {
  $profileSource = Join-Path $TauriDir 'crates\dsh-core\src\profile.rs'
  $selected = @()
  if (Test-Path $profileSource) {
    $profileText = Get-Content $profileSource -Raw
    $block = [regex]::Match($profileText, 'DESKTOP_PROFILE_BUNDLES:\s*&\[&str\]\s*=\s*&\[(?<body>[^\]]*)\]')
    if ($block.Success) {
      $selected = @([regex]::Matches($block.Groups['body'].Value, '"([^"]+)"') | ForEach-Object { $_.Groups[1].Value })
    }
  }
  if ($selected.Count -eq 0) {
    throw "Could not read DESKTOP_PROFILE_BUNDLES from $profileSource; refusing to stage a payload whose selected bundles were never validated."
  }
  $unresolved = @($selected | Where-Object {
      $relative = 'node_modules\' + ($_ -replace '/', '\') + '\package.json'
      -not (Test-Path (Join-Path $PayloadRoot $relative))
    })
  if ($unresolved.Count) {
    throw "Runtime payload cannot resolve these desktop profile bundles: $($unresolved -join ', '). A fresh profile would compose without them."
  }
  Write-Host "    profile bundles resolve: $($selected -join ', ')" -ForegroundColor DarkGray
}

function Install-PinnedNodeInto([string]$StageRoot, [string]$PayloadRoot, [object]$Identity) {
  if ($null -eq $Identity) { throw 'Pinned staging interpreter identity is required.' }
  Copy-Item -LiteralPath (Join-Path (Join-Path $StageRoot 'work') $Identity.License) `
    -Destination (Join-Path $PayloadRoot $Identity.License) -ErrorAction Stop

  Write-Host "    pinned Node $($identity.NodeVersion) for $($identity.Target) ($($identity.Source))" -ForegroundColor DarkGray

  # TWO DIFFERENT DIGESTS, NEVER CONFLATED.
  #
  #   Sha256           the digest of the ARCHIVE the interpreter was extracted from,
  #                    declared by `installer/node-runtime.json` and already verified
  #                    by `Install-DshPinnedNode` before extraction.
  #   ExecutableSha256 the digest of the interpreter BINARY that ships, observed from
  #                    the bytes that verified extraction chain produced.
  #
  # The runtime sealer enforces the second one against the running and payload images
  # when it is present, and treats its absence as the legacy record. So it is recorded
  # for NEW records only and is derived from the actual bytes - it is never a second
  # name for the archive digest, and the archive digest above is never overwritten.
  $stagedExecutable = $Identity.Executable
  if (-not (Test-Path -LiteralPath $stagedExecutable -PathType Leaf)) {
    throw "The verified staged interpreter is absent: $stagedExecutable"
  }
  $stagedExecutableSha256 = (Get-FileHash -LiteralPath $stagedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()

  # The interpreter is carried inside the payload so the installed application
  # does not depend on a system Node.js. `dsh/node/` is the location the Rust
  # side resolves; see the integration note in the lane report.
  $nodeTarget = Join-Path $PayloadRoot 'node'
  if (Test-Path $nodeTarget) { Remove-Item $nodeTarget -Recurse -Force }
  Move-Item -LiteralPath $identity.Root -Destination $nodeTarget

  # Read the digest back from the SHIPPED location and refuse a move that changed the
  # bytes: the sealer hashes the file it finds under the payload, so recording the
  # staging-location digest would be a promise about a file that no longer exists.
  $payloadExecutable = Join-Path $nodeTarget $Identity.RelativeExecutable
  if (-not (Test-Path -LiteralPath $payloadExecutable -PathType Leaf)) {
    throw "The installed payload interpreter is absent: $payloadExecutable"
  }
  $executableSha256 = (Get-FileHash -LiteralPath $payloadExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($executableSha256 -ne $stagedExecutableSha256) {
    throw "The installed payload interpreter is not byte-identical to the verified staged interpreter: $executableSha256 vs $stagedExecutableSha256"
  }

  # The identity record is read back from the payload, not from the staging
  # location, so the manifest describes where the interpreter actually is.
  # `RecordSha` is deliberately NOT emitted: the sealer requires it, when present, to
  # equal `Sha256`, which here is the archive digest rather than the binary digest.
  $record = [pscustomobject]@{
    NodeVersion      = $identity.NodeVersion
    Target           = $identity.Target
    Url              = $identity.Url
    Sha256           = $identity.Sha256
    ExecutableSha256 = $executableSha256
    Source           = $identity.Source
    License          = $identity.License
    LicenseSpdx      = $identity.LicenseSpdx
    Executable       = "dsh/node/$($identity.RelativeExecutable -replace '\\', '/')"
  }
  Write-Host "    pinned Node identity: archive=$($identity.Sha256) executable=$executableSha256" -ForegroundColor DarkGray
  Write-DshNodeStagingRecord -StageRoot $StageRoot -Record $record | Out-Null
}

function Write-DshNodeStagingRecord([string]$StageRoot, $Record) {
  $path = Join-Path $StageRoot 'node-identity.json'
  $json = $Record | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($path, "$json`n", (New-Object System.Text.UTF8Encoding($false)))
  return $path
}

function Get-StagedNodeIdentity([string]$StageRoot) {
  $path = Join-Path $StageRoot 'node-identity.json'
  if (-not (Test-Path $path)) {
    throw "The staged payload has no pinned-Node identity record at $path; refusing to describe a payload whose interpreter is unrecorded."
  }
  return (Get-Content $path -Raw | ConvertFrom-Json)
}

# Resolve (and reuse) the trusted execution interpreter for a given pinned image.
#
# The resolver makes a fresh outside copy per call, and the sealer runs twice (seal,
# then verify-only) over the SAME bundled bytes. Caching by the reference digest keeps
# that to one copy, and the cached copy's digest is RE-VERIFIED before every reuse so
# a changed file can never be executed under an old attestation. The cache is keyed by
# reference digest plus the attested override, so two different images never share an
# entry.
$script:TrustedExecutionNodeCache = @{}
function Resolve-DshTrustedExecutionNodeCached {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$StagedExecutable, [string]$AttestedPath)

  $digest = (Get-FileHash -LiteralPath $StagedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
  $key = "$digest|$AttestedPath"
  if ($script:TrustedExecutionNodeCache.ContainsKey($key)) {
    $cached = $script:TrustedExecutionNodeCache[$key]
    try {
      $now = (Get-FileHash -LiteralPath $cached.Path -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($now -eq $cached.Sha256 -and $now -eq $digest) { return $cached }
    } catch { }
    $script:TrustedExecutionNodeCache.Remove($key)
    Write-Host '    note: cached trusted execution copy no longer matches its digest; resolving a fresh one.' -ForegroundColor DarkYellow
  }
  $resolved = Resolve-DshStagingExecutionNode -StagedExecutable $StagedExecutable -AttestedPath $AttestedPath
  $script:TrustedExecutionNodeCache[$key] = $resolved
  return $resolved
}

# Invoke the upstream descriptor APIs through the supported source launcher, but
# only under the materialized, checksum-pinned payload interpreter.
function Invoke-StagedRuntimeSeal {
  [CmdletBinding()]
  param([string]$StageRoot, [string]$DshRoot, [switch]$VerifyOnly)

  $identity = Get-StagedNodeIdentity -StageRoot $StageRoot
  $targetName = Get-CurrentNodeTargetName
  $pin = Get-DshPinnedNodeManifest -ManifestPath (Join-Path $InstallerDir 'node-runtime.json')
  $pinTarget = Get-DshPinnedNodeTarget -Manifest $pin -Target $targetName
  if ($identity.Target -ne $targetName -or $identity.NodeVersion -ne $pin.nodeVersion -or
      $identity.Sha256 -ne $pinTarget.sha256) {
    throw 'Staged Node identity does not match the source-controlled interpreter pin.'
  }
  $relativeExecutable = if ($targetName.StartsWith('win-')) { 'node/node.exe' } else { 'node/bin/node' }
  if ($identity.Executable -cne "dsh/$relativeExecutable") {
    throw 'Staged Node identity has an unexpected executable location.'
  }
  $bundledNode = Join-Path $DshRoot $relativeExecutable
  # `seal-runtime.mjs` imports ONLY Node builtins (node:crypto, node:fs, node:path,
  # node:url) -- no TypeScript, no upstream package -- so it needs no loader. Running
  # it through `tsx` pulled tsx's own esbuild (0.28.1) into the runtime stage, which is
  # a compiler this step never uses and which cannot share the UI's 0.25.12 override.
  # The staging program below still REQUIRES `tsx` (it imports upstream `.ts`).
  $arguments = @((Join-Path $PSScriptRoot 'lib\seal-runtime.mjs'))
  if ($VerifyOnly) { $arguments += '--verify' }
  $arguments += @($Upstream, $DshRoot, (Join-Path $StageRoot 'work\runtime-identity.json'),
    (Join-Path $StageRoot 'node-identity.json'))

  # NEVER execute the shipped payload interpreter directly: it was created inside the
  # workspace, so its image is Low-labelled and a Low Node cannot open the pipes or
  # write the Medium temp that the sealing program needs. The trusted resolver proves
  # the execution copy is byte-identical to these pinned bytes (which are themselves
  # tied to the archive digest above), prints the pinned version, and runs the real
  # write/pipe/sentinel/watchdog preflight. The sealed tree bytes, the identity record
  # and the manifest hash inputs are untouched: only WHERE the program is executed
  # from changes.
  $executionNode = Resolve-DshTrustedExecutionNodeCached -StagedExecutable $bundledNode -AttestedPath $AttestedNodePath
  $oldNpmExecPath = $env:npm_execpath
  $oldPath = $env:PATH
  $hadTemp = Test-Path -LiteralPath 'Env:TEMP'
  $hadTmp = Test-Path -LiteralPath 'Env:TMP'
  $oldTemp = if ($hadTemp) { $env:TEMP } else { $null }
  $oldTmp = if ($hadTmp) { $env:TMP } else { $null }
  try {
    $env:PATH = (Split-Path -Parent $executionNode.Path) + [IO.Path]::PathSeparator + $oldPath
    if ($executionNode.Temp) {
      $env:TEMP = $executionNode.Temp
      $env:TMP = $executionNode.Temp
    }
    Invoke-Checked $executionNode.Path $arguments $Upstream
  } finally {
    $env:npm_execpath = $oldNpmExecPath
    $env:PATH = $oldPath
    if ($hadTemp) { $env:TEMP = $oldTemp } else { Remove-Item -LiteralPath 'Env:TEMP' -ErrorAction SilentlyContinue }
    if ($hadTmp) { $env:TMP = $oldTmp } else { Remove-Item -LiteralPath 'Env:TMP' -ErrorAction SilentlyContinue }
  }
}

# The host protocol version the staged runtime was built against.
#
# The staging program writes it into `work/runtime-identity.json` from upstream's
# own `DESKTOP_HOST_PROTOCOL_VERSION`, and the payload manifest has a
# `hostProtocolVersion` field - but nothing read the value back, so the field was
# always null. That is the one field tying the shipped runtime to the Rust control
# protocol, so it is recorded rather than left blank.
function Get-StagedHostProtocolVersion([string]$StageRoot) {
  $path = Join-Path $StageRoot 'work\runtime-identity.json'
  if (-not (Test-Path $path)) {
    throw "The runtime stage produced no identity record at $path; the payload cannot be tied to the host control protocol."
  }
  $identity = Get-Content $path -Raw | ConvertFrom-Json
  $version = "$($identity.hostProtocolVersion)"
  if ([string]::IsNullOrWhiteSpace($version) -or $version -eq '0') {
    throw "The runtime identity record at $path declares no hostProtocolVersion; refusing to record an untied payload."
  }
  return $version
}

function Get-CurrentNodeTargetName {
  # `$IsMacOS` is a PowerShell 7 automatic variable and does not exist under
  # Windows PowerShell 5.1, where `Set-StrictMode -Version Latest` turns any
  # reference into a terminating "variable has not been set" error. The build
  # script carries no `#Requires`, so a macOS/Linux run under 5.1 died before
  # selecting a target. Probe for the variable instead of assuming it.
  $isMac = $false
  $isLinux = $false
  if (Get-Variable -Name IsMacOS -ErrorAction SilentlyContinue) { $isMac = [bool]$IsMacOS }
  if (Get-Variable -Name IsLinux -ErrorAction SilentlyContinue) { $isLinux = [bool]$IsLinux }
  if (-not $isMac -and -not $isLinux -and $PSVersionTable.PSVersion.Major -lt 6) {
    # 5.1 has no platform variables; `$env:OSTYPE` is the available signal.
    $isMac = ("$env:OSTYPE" -match 'darwin')
    $isLinux = -not $isMac -and ("$env:OSTYPE" -match 'linux')
  }

  # A 32-bit PowerShell on 64-bit Windows reports `x86` in
  # `PROCESSOR_ARCHITECTURE` and the real architecture in
  # `PROCESSOR_ARCHITEW6432`. Without this fallback the `win-arm64` target is
  # silently unreachable and the build stages a `win-x64` interpreter that cannot
  # run. `$env:PROCESSOR_ARCHITECTURE` is the primary signal; the W6432 value only
  # fills in when the primary is `x86`.
  $architecture = $env:PROCESSOR_ARCHITECTURE
  if ($architecture -eq 'x86' -and $env:PROCESSOR_ARCHITEW6432) {
    $architecture = $env:PROCESSOR_ARCHITEW6432
  }

  if ($env:OS -eq 'Windows_NT') {
    if ($architecture -eq 'ARM64') { return 'win-arm64' }
    return 'win-x64'
  }
  if ($isMac) {
    if ($architecture -eq 'arm64') { return 'darwin-arm64' }
    return 'darwin-x64'
  }
  if ($architecture -eq 'aarch64') { return 'linux-arm64' }
  return 'linux-x64'
}

# The pinned explicit inputs. Anything a human chose and the build depends on
# belongs here, so a manifest difference names the input that moved.
function Get-PayloadInputs([string]$StageRoot) {
  $inputs = @{}

  $adapter = Join-Path $TauriDir 'runtime\adapter.mjs'
  if (-not (Test-Path $adapter)) { throw "Runtime adapter is missing: $adapter" }
  $inputs['runtimeAdapter'] = (Get-FileHash -LiteralPath $adapter -Algorithm SHA256).Hash.ToLowerInvariant()

  $pinPath = Join-Path $InstallerDir 'node-runtime.json'
  $inputs['nodePin'] = (Get-FileHash -LiteralPath $pinPath -Algorithm SHA256).Hash.ToLowerInvariant()

  $nodeStageProgram = Get-DshRuntimeStageProgram
  $inputs['stageProgram'] = (Get-DshStringDigest -Value $nodeStageProgram)
  # `target-release.mjs` is a transitive input of the account transforms: each of
  # them imports TARGET_RELEASE from it to decide which release's reviewed hashes
  # apply. Sealing the transforms without it would leave the input that governs
  # the accepted target version outside the manifest.
  foreach ($helper in @('seal-runtime.mjs', 'runtime-locks.mjs', 'runtime-payload.psm1', 'payload-manifest.psm1', 'config-editor-runtime-import.mjs', 'target-release.mjs', 'upstream-runtime-dependency-policy.mjs', 'account-profile-runtime.mjs', 'account-login-runtime.mjs', 'account-data-runtime.mjs')) {
    $inputs["packagingHelper:$helper"] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot "lib\$helper") -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $inputs['accountProfileCache'] = (Get-FileHash -LiteralPath (Join-Path $TauriDir 'runtime\account-profile-cache.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
  $inputs['desktopLogin'] = (Get-FileHash -LiteralPath (Join-Path $TauriDir 'runtime\desktop-login.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
  $inputs['accountData'] = (Get-FileHash -LiteralPath (Join-Path $TauriDir 'runtime\account-data.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()
  $inputs['accountDataClient'] = (Get-FileHash -LiteralPath (Join-Path $UiDir 'account-data\client-state.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()

  $packageManager = Get-UpstreamPackageManager
  $inputs['upstreamPackageManager'] = [string]$packageManager

  $runtimeIdentityPath = Join-Path $StageRoot 'work\runtime-identity.json'
  if (-not (Test-Path -LiteralPath $runtimeIdentityPath -PathType Leaf)) {
    throw "Runtime staging produced no lock identity record: $runtimeIdentityPath"
  }
  $runtimeIdentity = Get-Content -LiteralPath $runtimeIdentityPath -Raw | ConvertFrom-Json
  $lockIdentity = $runtimeIdentity.runtimeLockInputs
  if ($null -eq $lockIdentity -or $lockIdentity.target -ne 'win-x64' -or
      $lockIdentity.upstreamCommit -ne (Get-UpstreamCommit) -or
      $lockIdentity.pnpmVersion -ne ([string]$packageManager -replace '^pnpm@', '').Split('+')[0]) {
    throw 'Runtime lock input identity does not match the current target, upstream commit, or package-manager pin.'
  }
  $lockedFiles = @{
    'runtimeLock:descriptor' = Join-Path $RuntimeLockInputs 'descriptor.json'
    'runtimeLock:pnpmLock' = Join-Path $RuntimeLockInputs 'pnpm-lock.yaml'
    'runtimeLock:workspacePolicy' = Join-Path $RuntimeLockInputs 'pnpm-workspace.yaml'
  }
  $expectedLockHashes = @{
    'runtimeLock:descriptor' = [string]$lockIdentity.descriptorSha256
    'runtimeLock:pnpmLock' = [string]$lockIdentity.lockSha256
    'runtimeLock:workspacePolicy' = [string]$lockIdentity.workspacePolicySha256
  }
  foreach ($name in $lockedFiles.Keys) {
    if (-not (Test-Path -LiteralPath $lockedFiles[$name] -PathType Leaf)) {
      throw "Reviewed runtime lock input disappeared before sealing: $($lockedFiles[$name])"
    }
    $actualHash = (Get-FileHash -LiteralPath $lockedFiles[$name] -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedLockHashes[$name]) {
      throw "Reviewed runtime lock input changed after frozen installation: $($lockedFiles[$name])"
    }
    $inputs[$name] = $actualHash
  }

  foreach ($portPackage in Get-DshPortPackageInputs `
      -SourceDirectories @((Join-Path $UiDir 'desktop-updates-bundle'), (Join-Path $UiDir 'client-updates')) `
      -RelativeFiles @('package.json', 'cordis.patch.yml')) {
    $inputs["portPackage:$($portPackage.Name)"] = $portPackage.Sha256
  }
  $inputs['updatesComposition:producer'] = (Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'lib\verify-updates-composition.mjs') -Algorithm SHA256).Hash.ToLowerInvariant()

  if ($qualificationClientBuild) {
    foreach ($name in @('index.js', 'client.js', 'client.js.map')) {
      $inputs["qualificationClientBuild:$name"] = (Get-FileHash -LiteralPath (Join-Path $qualificationClientBuild $name) -Algorithm SHA256).Hash.ToLowerInvariant()
    }
  }
  return $inputs
}

function Get-DshStringDigest([string]$Value) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Value)
    $hash = $sha.ComputeHash($bytes)
    return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLowerInvariant()
  } finally {
    $sha.Dispose()
  }
}

function Get-ProductVersion {
  return (Get-Content (Join-Path $Upstream 'package.json') -Raw | ConvertFrom-Json).version
}

function Get-PayloadManifestRecordPath {
  if ($qualificationRoot) {
    return (Join-Path $qualificationRoot 'runtime-payload.json')
  }
  return (Join-Path $InstallerDir 'runtime-payload.json')
}

# Fail the build when the payload differs from the recorded one, unless the
# caller explicitly accepted a new record. Drift is the failure mode this guards:
# a resolver picking a different transitive version produces a payload that runs
# but is not the one that was tested.
function Assert-PayloadManifestMatches($Manifest) {
  $recordPath = Get-PayloadManifestRecordPath
  if ($UpdatePayloadManifest) {
    Write-DshPayloadManifest -Manifest $Manifest -Path $recordPath
    Write-Host "    payload manifest updated -> $recordPath" -ForegroundColor DarkYellow
    return
  }
  if (-not (Test-Path $recordPath)) {
    Write-DshPayloadManifest -Manifest $Manifest -Path $recordPath
    Write-Host "    no recorded payload manifest existed; recorded the current payload -> $recordPath" -ForegroundColor DarkYellow
    return
  }

  $expected = Read-DshPayloadManifest -Path $recordPath
  $comparison = Compare-DshPayloadManifest -Expected $expected -Actual $Manifest
  if ($comparison.Matches) {
    Write-Host "    payload matches the recorded manifest ($($Manifest.fileCount) files)" -ForegroundColor Green
    return
  }

  $lines = @()
  $lines += $comparison.Differences
  foreach ($path in $comparison.AddedFiles) { $lines += "added file: $path" }
  foreach ($path in $comparison.RemovedFiles) { $lines += "removed file: $path" }
  foreach ($path in $comparison.ChangedFiles) { $lines += "changed file: $path" }
  $shown = @($lines | Select-Object -First 25)
  $more = if ($lines.Count -gt $shown.Count) { "`n  ... and $($lines.Count - $shown.Count) more" } else { '' }
  throw @"
The staged runtime payload differs from the recorded manifest at $recordPath.
This is dependency drift: the same commit would ship different bytes than the
recorded build.

$($shown -join "`n")$more

If the change is intended, re-run with -UpdatePayloadManifest and review the
recorded diff.
"@
}

function Assert-BundleGuardConfiguration([string]$ConfigRoot) {
  if (-not [string]::IsNullOrWhiteSpace($env:TAURI_CONFIG)) {
    throw 'TAURI_CONFIG overlays are unsupported by the resource guard; clear the override before bundling'
  }
  # These CLI auto-merged overlays could inject a post-qualification hook. Until
  # merged configuration is explicitly qualified, refuse them rather than guess.
  foreach ($overlay in @('tauri.windows.conf.json', 'tauri.windows.conf.json5', 'Tauri.windows.toml')) {
    if (Test-Path -LiteralPath (Join-Path $ConfigRoot $overlay)) {
      throw 'platform configuration overlays are unsupported by the resource guard'
    }
  }
  $tauriConf = Get-Content -LiteralPath (Join-Path $ConfigRoot 'tauri.conf.json') -Raw | ConvertFrom-Json
  $hook = $tauriConf.build.beforeBundleCommand
  if ($null -ne $hook -and ($hook -isnot [string] -or -not [string]::IsNullOrWhiteSpace($hook))) {
    throw 'build.beforeBundleCommand is configured; a post-qualification hook could mutate the guarded resource trees'
  }
}

function Build-Bundle {
  Write-Stage 'Release bundle and Windows installer (NSIS)'
  Assert-Tool 'cargo' 'Install Rust via rustup.'
  Assert-ResourceRootsForCompile

  # A bundling build needs exclusivity: the NSIS step needs the just-linked
  # binary to still be on disk, and a concurrent release build deletes it
  # (finding F-25). Only bundling needs this; cargo self-serialises the rest.
  $running = @(Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ProcessName -in @('cargo', 'cargo-tauri', 'rustc') })
  if ($running.Count -gt 0) {
    throw "Another cargo/rustc process is running ($($running.Count) of them): $(($running | ForEach-Object { "$($_.ProcessName)($($_.Id))" }) -join ', '). A bundling build needs the target directory to itself; wait for it to finish."
  }

  # Fail closed if a beforeBundleCommand hook is configured: it could mutate
  # the source trees AFTER the resource guard has qualified them, which would
  # invalidate the physical-metadata and byte-identity proofs.
  Assert-BundleGuardConfiguration -ConfigRoot $AppDir

  # Split build and bundle: the tauri CLI forwards trailing ARGS to the cargo
  # runner (help-verified: "[ARGS]... Command line arguments passed to the
  # runner"). The forwarded --message-format=json-render-diagnostics makes the
  # original compile emit the cargo JSON message stream on stdout. The stream
  # is captured to a scratch file (stderr: rendered diagnostics, visible).
  # The resource guard then derives the exe from that stream and qualifies all
  # four trees (sealed sources + compiled mirrors) before the bundle step.
  $tauriOutput = Join-Path $Scratch ("tauri-build-{0}.json" -f [guid]::NewGuid().ToString('N'))
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $TauriDir
  try {
    & cargo @('tauri', 'build', '--no-bundle', '--', '--message-format=json-render-diagnostics') > $tauriOutput
    $tauriExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    Pop-Location
  }
  if ($tauriExit -ne 0) { throw "cargo tauri build failed with exit code $tauriExit" }

  # Derive the artifact exe from the captured tauri-build stream.
  $exe = Get-ArtifactExeFromCargoJson -ArtifactJsonPath $tauriOutput -Stream 'tauri-build'
  $exeDir = Split-Path $exe

  # The shared guard generates physical metadata and verifies the original CLI
  # stream plus all four trees, with JSON-looking malformed lines still refused.
  Assert-CompiledResourceMirrorsFromJson -ArtifactJsonPath $tauriOutput -Stream 'tauri-build'

  # Bundle the qualified artifacts. No recompile: the bundle step packages
  # the already-built binaries and reads the SOURCE trees (which the runtime
  # stage sealed and the guard proved the mirrors match). Same env/profile.
  Invoke-Checked 'cargo' @('tauri', 'bundle') $TauriDir
  $nsis = Join-Path $exeDir 'bundle\nsis'
  if (Test-Path $nsis) {
    Write-Host "    installer output: $nsis" -ForegroundColor Green
    Get-ChildItem $nsis -File | ForEach-Object { Write-Host "      $($_.Name)  $([math]::Round($_.Length / 1MB, 2)) MB" }
  } else {
    Write-Warning "No NSIS output found at $nsis (non-Windows host or bundler skipped)."
  }
}

function Test-InterfaceFixtures {
  Write-Stage 'Interface fixture parity (Rust + TypeScript round-trip the same bytes)'
  Invoke-Checked 'cargo' @('test', '--workspace', '--locked', '--offline', '--test', 'protocol_fixtures') $TauriDir
  # The affected front-end surface: the desktop bridge, the Updates section and the
  # native guest adapters. The UI test script must include native-guests/tests, or
  # this stage would go green while the guest adapters were never run (finding 19),
  # so the declared script is asserted rather than trusted.
  $uiPackagePath = Join-Path $UiDir 'package.json'
  if (-not (Test-Path $uiPackagePath)) { throw "The UI package manifest is absent: $uiPackagePath" }
  $uiPackage = Get-Content $uiPackagePath -Raw | ConvertFrom-Json
  if ($uiPackage.scripts.test -notmatch 'native-guests/tests') {
    throw 'The UI test script no longer runs native-guests/tests, so the verify stage would not exercise the native guest adapters.'
  }
  if (-not ($uiPackage.scripts.PSObject.Properties.Name -contains 'build:verify')) {
    throw 'The UI package manifest declares no build:verify script, so a build cannot invoke its affected tests.'
  }
  foreach ($project in @('desktop-bridge', 'client-updates', 'native-guests')) {
    $projectFile = Join-Path $UiDir "$project\tsconfig.json"
    if (-not (Test-Path $projectFile)) { throw "The UI type project is absent: $projectFile" }
  }
  Invoke-Checked 'pnpm' @('run', 'test') $UiDir
  Invoke-Checked 'pnpm' @('run', 'test:types') $UiDir
}

function Test-Packaging {
  Write-Stage 'Packaging regression tests (publication, manifest, pinned Node, NSIS hooks)'
  Assert-Tool 'node' 'Install Node.js 22.19+ or 24+.'

  $suites = @(
    @{ Name = 'packaging helpers'; Path = (Join-Path $PackagingTests 'lib-modules.ps1') }
    @{ Name = 'staging and publication guards'; Path = (Join-Path $PackagingTests 'stage-guards.ps1') }
    @{ Name = 'installer hooks compile'; Path = (Join-Path $PackagingTests 'nsis-hooks-compile.ps1') }
    @{ Name = 'installer guard messages localized'; Path = (Join-Path $PackagingTests 'nsis-strings-messages.ps1') }
    @{ Name = 'installer instance guard'; Path = (Join-Path $PackagingTests 'nsis-instance-guard.ps1') }
    @{ Name = 'installer production contract'; Path = (Join-Path $PackagingTests 'installer-contract.test.mjs') }
    @{ Name = 'installer template regressions'; Path = (Join-Path $PackagingTests 'installer-regressions.test.mjs') }
    @{ Name = 'repair contract inventory'; Path = (Join-Path $PackagingTests 'repair-gate-inventory.test.mjs') }
    @{ Name = 'runtime materializer policy'; Path = (Join-Path $PackagingTests 'runtime-materializer.test.mjs') }
    @{ Name = 'config editor runtime const-enum import'; Path = (Join-Path $PackagingTests 'config-editor-runtime-import.test.mjs') }
    @{ Name = 'reviewed runtime lock inputs'; Path = (Join-Path $PackagingTests 'runtime-lock-inputs.test.mjs') }
    @{ Name = 'final runtime descriptor'; Path = (Join-Path $PackagingTests 'runtime-seal.test.mjs') }
    @{ Name = 'build order and safety'; Path = (Join-Path $PackagingTests 'build-script.test.mjs') }
    @{ Name = 'compiled resource guard functions'; Path = (Join-Path $PackagingTests 'resource-guard-functions.test.ps1') }
    @{ Name = 'installer hook control flow'; Path = (Join-Path $PackagingTests 'nsis-hook-behavior.ps1') }
    @{ Name = 'installed qualification safety guards'; Path = (Join-Path $PackagingTests 'verify-installed-guards.ps1') }
    @{ Name = 'qualification gate contract'; Path = (Join-Path $PackagingTests 'gate-contract.test.mjs') }
    @{ Name = 'staging execution-node trust'; Path = (Join-Path $PackagingTests 'execution-node-trust.test.mjs') }
  )

  $failures = @()
  foreach ($suite in $suites) {
    if (-not (Test-Path $suite.Path)) {
      throw "Packaging test suite is missing: $($suite.Path)"
    }
    Write-Host "    -- $($suite.Name)" -ForegroundColor DarkGray
    if ($suite.Path.EndsWith('.mjs')) {
      Invoke-Checked 'node' @('--import', 'tsx/esm', $suite.Path) $Upstream
    } else {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $suite.Path
    }
    if ($LASTEXITCODE -ne 0) { $failures += $suite.Name }
  }
  if ($failures.Count -gt 0) {
    throw "Packaging test suites failed: $($failures -join ', ')"
  }
  # The seven native/packaging suites are DECLARED by the qualification gate, not
  # discovered by a glob, so a deleted or renamed suite is a failure here rather
  # than a quietly smaller green run (finding P1). The gate also refuses to count a
  # precondition skip (for example an absent makensis) as a pass.
  $gateLauncher = Join-Path $PortRoot 'tests\run-verification-gate.ps1'
  if (-not (Test-Path $gateLauncher)) { throw "The qualification gate launcher is absent: $gateLauncher" }
  foreach ($declared in @('lib-modules.ps1', 'stage-guards.ps1', 'nsis-hooks-compile.ps1',
                          'nsis-strings-messages.ps1', 'nsis-instance-guard.ps1',
                          'nsis-hook-behavior.ps1', 'verify-installed-guards.ps1')) {
    if (-not (Test-Path (Join-Path $PackagingTests $declared))) {
      throw "Declared packaging suite is missing: $declared"
    }
  }
  Write-Host '    all packaging suites passed' -ForegroundColor Green
}

Test-Prerequisites

if ($Stage -ne 'runtime-lock-refresh') { $null = New-Item -ItemType Directory -Force -Path $Scratch }
$doAll = $Stage -eq 'all'

# The clean-build order. `ui` and `runtime` produce the two `bundle.resources`
# source roots, so they run before any compile that validates those paths.
$needsResources = $doAll -or $Stage -in @('core', 'bundle')
if ($doAll -or $Stage -eq 'ui') { Build-Ui }
elseif ($needsResources -and -not $SkipResourceStages) {
  Write-Host ''
  Write-Host '==> UI resource root required by the requested stage' -ForegroundColor Cyan
  Build-Ui
}
if ($Stage -eq 'runtime-lock-refresh') { Stage-RuntimeLockRefresh }
elseif ($doAll -or $Stage -eq 'runtime') { Stage-Runtime }
elseif ($needsResources -and -not $SkipResourceStages) {
  Write-Host ''
  Write-Host '==> Runtime resource root required by the requested stage' -ForegroundColor Cyan
  Stage-Runtime
}

if ($doAll -or $Stage -eq 'core') { Build-Core }
if ($doAll -or $Stage -eq 'verify') { Test-InterfaceFixtures }
if ($doAll -or $Stage -eq 'packaging-tests') { Test-Packaging }
if ($doAll -or $Stage -eq 'bundle') { $Release = $true; Build-Bundle }

Write-Host ''
Write-Host 'Build complete.' -ForegroundColor Green
Write-Host 'Signing and update delivery are NOT part of this build; see docs/build-and-install.md section 8.' -ForegroundColor Yellow
