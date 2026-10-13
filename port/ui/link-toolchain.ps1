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
# Junctioned package names: the full set the shell build, the bridge, and the tests resolve from files under port/ui/.
$packages = @('@deepseek-ai', '@types', '@vitejs', 'vite', 'vitest', 'react', 'react-dom', 'typescript', 'playwright')
# Root-hoisted test engines resolve from the workspace root instead of apps/web.
$rootModules = Join-Path $upstreamRoot 'node_modules'
$rootPackages = @('jsdom')
$targets = @()
foreach ($n in $packages) { $targets += [pscustomobject]@{ Name = $n; Dir = $upstreamModules } }
foreach ($n in $rootPackages) { $targets += [pscustomobject]@{ Name = $n; Dir = $rootModules } }
foreach ($t in $targets) {
  $link = Join-Path $target $t.Name
  $source = Join-Path $t.Dir $t.Name
  if (Test-Path $link) { Write-Output "kept    $($t.Name)"; continue }
  New-Item -ItemType Junction -Path $link -Target $source | Out-Null
  Write-Output "linked  $($t.Name) -> $source"
}
Write-Output "toolchain linked into $target from $upstreamRoot"
