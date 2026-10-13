# Link the upstream apps/web toolchain into `port/ui/node_modules` so the shell
# build and the bridge tests resolve the exact dependency versions the target
# upstream build used, without a second install. Each entry is an NTFS junction
# to `<upstream>/apps/web/node_modules/*`; the upstream checkout is never written
# to.
#
# The upstream checkout is explicit. Precedence:
#   1. -UpstreamRoot <path>
#   2. $env:DSH_UPSTREAM_ROOT
#   3. <repo>/_upstream
# The default is the repository's own reference checkout; an externally owned
# checkout (a qualification clone outside the main tree) is a supported input.
#
# Run from anywhere; paths are script-relative:
#
#   pwsh -File port/ui/link-toolchain.ps1
#   pwsh -File port/ui/link-toolchain.ps1 -UpstreamRoot C:\path\to\checkout
[CmdletBinding()]
param(
  [string]$UpstreamRoot
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent (Split-Path -Parent $here)
if (-not $UpstreamRoot) { $UpstreamRoot = $env:DSH_UPSTREAM_ROOT }
if (-not $UpstreamRoot) { $UpstreamRoot = Join-Path $repoRoot '_upstream' }
if (-not (Test-Path -LiteralPath $UpstreamRoot -PathType Container)) {
  throw "upstream checkout not found at $UpstreamRoot - pass -UpstreamRoot or set DSH_UPSTREAM_ROOT"
}
$upstreamRoot = (Resolve-Path -LiteralPath $UpstreamRoot).Path
$upstreamModules = Join-Path $upstreamRoot 'apps\web\node_modules'
$target = Join-Path $here 'node_modules'
if (-not (Test-Path (Join-Path $upstreamModules 'vite'))) {
  throw "upstream toolchain missing at $upstreamModules - run pnpm install && pnpm run build in $upstreamRoot first"
}
New-Item -ItemType Directory -Force -Path $target | Out-Null

function Set-DshJunction([string]$Path, [string]$Destination, [string]$Label) {
  # Create or repoint ONE generated junction. Three safety rules:
  #   * an ordinary directory or file at the generated path is never removed;
  #   * a link is repointed by deleting the LINK only, non-recursively, because a
  #     recursive delete through a junction destroys the referenced checkout;
  #   * a link already pointing at the destination is kept as-is.
  $existing = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
  if ($null -ne $existing) {
    if (($existing.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
      $kind = if ($existing.PSIsContainer) { 'directory' } else { 'file' }
      throw "Refusing to replace an ordinary $kind at a generated link path: $Path"
    }
    $current = @($existing.Target)[0]
    if ($current) { $current = [System.IO.Path]::GetFullPath($current) }
    if ($current -and [string]::Equals($current, $Destination, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Output "kept     $Label -> $current"
      return
    }
    [System.IO.Directory]::Delete($Path, $false)
    New-Item -ItemType Junction -Path $Path -Target $Destination | Out-Null
    Write-Output "relinked $Label -> $Destination"
    return
  }
  New-Item -ItemType Junction -Path $Path -Target $Destination | Out-Null
  Write-Output "linked   $Label -> $Destination"
}

# --- port/.upstream: the stable path the shell build and the TS preset read -----
# `shell/vite.config.ts`, `port-client-preset.ts`, the desktop bridge and the
# client-updates tsconfig import upstream sources with STATIC relative
# specifiers. esbuild inlines those when Vite bundles the config, so a
# runtime-chosen path can never reach them, and a computed dynamic import cannot
# either because the config loader cannot load upstream `.ts`. The selected root
# is therefore exposed at ONE stable, generated junction that those static
# specifiers read. That is what makes the shell build genuinely follow the
# selected checkout instead of silently reading the repository's own.
$linkPath = Join-Path (Split-Path -Parent $here) '.upstream'
# The unlink path is derived from THIS script's own location and canonicalized;
# it is never taken from caller input, and nothing else is ever removed.
$linkParent = (Resolve-Path -LiteralPath (Split-Path -Parent $linkPath)).Path
$linkPath = Join-Path $linkParent '.upstream'
Set-DshJunction -Path $linkPath -Destination $upstreamRoot -Label '.upstream'
$created = Get-Item -LiteralPath $linkPath -Force
if (($created.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0) {
  throw "The generated upstream link is not a reparse point: $linkPath"
}
$createdTarget = @($created.Target)[0]
if (-not $createdTarget) { throw "The generated upstream link exposes no target: $linkPath" }
$createdTarget = [System.IO.Path]::GetFullPath($createdTarget)
if (-not [string]::Equals($createdTarget, $upstreamRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "The generated upstream link points at $createdTarget, not the selected root $upstreamRoot."
}
# It must actually resolve to a checkout, not merely name one.
if (-not (Test-Path -LiteralPath (Join-Path $linkPath 'package.json') -PathType Leaf)) {
  throw "The generated upstream link does not resolve to a checkout: $linkPath"
}

# Junctioned package names: the full set the shell build, the bridge, and the tests resolve from files under port/ui/.
$packages = @('@deepseek-ai', '@types', '@vitejs', 'vite', 'vitest', 'react', 'react-dom', 'typescript', 'playwright')
# Root-hoisted test engines resolve from the workspace root instead of apps/web.
$rootModules = Join-Path $upstreamRoot 'node_modules'
$rootPackages = @('jsdom')
$targets = @()
foreach ($n in $packages) { $targets += [pscustomobject]@{ Name = $n; Dir = $upstreamModules } }
foreach ($n in $rootPackages) { $targets += [pscustomobject]@{ Name = $n; Dir = $rootModules } }
foreach ($t in $targets) {
  $source = Join-Path $t.Dir $t.Name
  if (-not (Test-Path -LiteralPath $source)) {
    Write-Output "skipped  $($t.Name) (absent at $source)"
    continue
  }
  Set-DshJunction -Path (Join-Path $target $t.Name) -Destination $source -Label $t.Name
}
Write-Output "toolchain linked into $target from $upstreamRoot"
