# Link the upstream apps/web toolchain into `port/ui/node_modules` so the shell
# build and the bridge tests resolve the exact dependency versions the pinned
# upstream build used, without a second install. Each entry is an NTFS junction
# to `_upstream/apps/web/node_modules/*`; `_upstream/` is never written to.
# Run from anywhere; paths are script-relative:
#
#   pwsh -File port/ui/link-toolchain.ps1
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$upstreamModules = Join-Path (Split-Path -Parent (Split-Path -Parent $here)) '_upstream\apps\web\node_modules'
$target = Join-Path $here 'node_modules'
if (-not (Test-Path (Join-Path $upstreamModules 'vite'))) {
  throw "upstream toolchain missing at $upstreamModules - run pnpm install && pnpm run build in _upstream first"
}
New-Item -ItemType Directory -Force -Path $target | Out-Null
# Junctioned package names: the full set the shell build, the bridge, and the tests resolve from files under port/ui/.
$packages = @('@deepseek-ai', '@types', '@vitejs', 'vite', 'vitest', 'react', 'react-dom', 'typescript', 'playwright')
# Root-hoisted test engines resolve from the workspace root instead of apps/web.
$rootModules = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $upstreamModules))) 'node_modules'
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
Write-Output "toolchain linked into $target"
