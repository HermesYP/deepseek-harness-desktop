<#
.SYNOPSIS
  Build, test and package the DeepSeek Harness desktop port.

.DESCRIPTION
  Reproducible entry point for every artifact this port ships. Stages are
  independent and individually selectable; the default runs the full sequence.

  Safety: never sets or inherits DSH_HOME from the caller's profile. Any run that
  launches a dsh process uses a throwaway home under port\.scratch\ and a port
  above 3084, because a live agent harness owns C:\Users\Yoova\.dsh and port 3080.

.PARAMETER Stage
  ui        build the preserved web client shell
  core      cargo build + test + clippy for the Rust workspace
  runtime   stage the supervised dsh runtime payload beside the executable
  bundle    cargo tauri build (release + NSIS installer)
  verify    run the interface-fixture parity tests on both language sides
  all       every stage in order (default)

.PARAMETER Release
  Build with --release. Implied by the bundle stage.

.EXAMPLE
  .\port\scripts\build.ps1 -Stage all -Release

.EXAMPLE
  .\port\scripts\build.ps1 -Stage core
#>
[CmdletBinding()]
param(
  [ValidateSet('ui', 'core', 'runtime', 'bundle', 'verify', 'all')]
  [string]$Stage = 'all',
  [switch]$Release
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$PortRoot = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $PortRoot
$Upstream = Join-Path $RepoRoot '_upstream'
$UiDir = Join-Path $PortRoot 'ui'
$TauriDir = Join-Path $PortRoot 'src-tauri'
$Scratch = Join-Path $PortRoot '.scratch'

function Write-Stage([string]$Message) {
  Write-Host ''
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Assert-Tool([string]$Name, [string]$Hint) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required tool '$Name' was not found on PATH. $Hint"
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
function Use-IsolatedHarnessHome([string]$Purpose) {
  $home = Join-Path $Scratch "$Purpose-home"
  New-Item -ItemType Directory -Force -Path $home | Out-Null
  $env:DSH_HOME = $home
  $env:DSH_DESKTOP_USER_DATA_DIR = (Join-Path $home 'userdata')
  Write-Host "    DSH_HOME isolated to $home" -ForegroundColor DarkYellow
}

function Test-Prerequisites {
  Write-Stage 'Prerequisites'
  Assert-Tool 'node' 'Install Node.js 22.19+ or 24+ (upstream engines range).'
  Assert-Tool 'pnpm' 'Install pnpm 11.7.0 (matches upstream packageManager).'
  Assert-Tool 'cargo' 'Install Rust via rustup with the x86_64-pc-windows-msvc toolchain.'
  if (-not (Test-Path (Join-Path $Upstream 'apps\web\dist'))) {
    throw "The reference web client has not been built. Run 'pnpm install; pnpm run build' in $Upstream first (see docs/build-and-install.md section 2)."
  }
  Write-Host '    ok' -ForegroundColor Green
}

function Build-Ui {
  Write-Stage 'Preserved web client shell (port/ui)'
  Assert-Tool 'pnpm' 'Install pnpm 11.7.0.'
  Invoke-Checked 'pnpm' @('install') $UiDir

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
    # This script runs with ErrorActionPreference = 'Stop', and a native command
    # that writes to stderr raises a NativeCommandError under that setting -- which
    # aborted this function before the client build ever ran. Scope the preference
    # down for the duration of the call and fail with a clear message instead.
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

  Invoke-Checked 'pnpm' @('run', 'build') $UiDir
}

function Build-Core {
  Write-Stage 'Rust application core and Tauri shell (port/src-tauri)'
  Assert-Tool 'cargo' 'Install Rust via rustup.'
  $cargoArgs = @('build', '--workspace')
  if ($Release) { $cargoArgs += '--release' }
  Invoke-Checked 'cargo' $cargoArgs $TauriDir
  Invoke-Checked 'cargo' @('test', '--workspace') $TauriDir
  Invoke-Checked 'cargo' @('clippy', '--workspace', '--all-targets', '--', '-D', 'warnings') $TauriDir
}

function Stage-Runtime {
  Write-Stage 'Supervised dsh runtime payload'

  # Tauri resources land beside the executable; the adapter stays inside dsh/
  # so Node resolves bare ESM imports through dsh/node_modules.
  $payload = Join-Path $PortRoot 'runtime-payload'
  $staging = Join-Path $Scratch 'runtime-staging'
  if (Test-Path $payload) { Remove-Item $payload -Recurse -Force }
  if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
  $null = New-Item -ItemType Directory -Force -Path $staging

  # Pack the same inputs and select the same roots as upstream's
  # prepare-package-set.ts. Its roots are @deepseek-ai/dsh and
  # @deepseek-ai/dsh-desktop-host; required dependencies and peers (including
  # cordis-plugin-group) are traversed from their manifests, not hand-listed.
  $packageManager = (Get-Content (Join-Path $Upstream 'package.json') -Raw | ConvertFrom-Json).packageManager
  $pnpmVersion = ([string]$packageManager -replace '^pnpm@', '').Split('+')[0]
  $pnpmEntry = Join-Path $env:LOCALAPPDATA "node\corepack\v1\pnpm\$pnpmVersion\bin\pnpm.mjs"
  if (-not (Test-Path $pnpmEntry)) { throw "Pinned pnpm entry point not found: $pnpmEntry" }
  $oldNpmExecPath = $env:npm_execpath
  $env:npm_execpath = $pnpmEntry
  $packedDsh = Join-Path $staging 'packed-dsh'
  $packedHost = Join-Path $staging 'packed-host'
  $packedVendor = Join-Path $staging 'packed-vendor'
  $packedLandlock = Join-Path $staging 'packed-landlock'
  foreach ($directory in @($packedDsh, $packedHost, $packedVendor, $packedLandlock)) {
    $null = New-Item -ItemType Directory -Force -Path $directory
  }

  # The Node helper mirrors upstream prepare-package-set.ts, project-manager.ts
  # and prepare-dsh.ts, including fs.cpSync so Windows junction semantics match
  # the measured upstream operation rather than PowerShell/robocopy semantics.
  $nodeStage = Join-Path $staging 'stage-runtime.mjs'
  @'
import { closeSync, copyFileSync, cpSync, existsSync, globSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
const [upstream, pnpmEntry, packedDsh, packedHost, packedVendor, packedLandlock, packageSet, project, output, adapterSource, probeStdout, probeStderr] = process.argv.slice(2)
const importUpstream = (file) => import(pathToFileURL(join(upstream, file)).href)
const { prepareDesktopPackageSet } = await importUpstream('apps/desktop/scripts/prepare-package-set.ts')
const { createRuntimeProjectMetadata } = await importUpstream('apps/desktop/src/project-manager.ts')
const { DESKTOP_HOST_PROTOCOL_VERSION } = await importUpstream('apps/desktop/src/host-protocol.ts')
const { desktopRuntimeFileExclusion } = await importUpstream('apps/desktop/scripts/runtime-file-policy.ts')
const { selectOfficeEngine } = await importUpstream('scripts/libreoffice-packages.mjs')
const yaml = createRequire(join(upstream, 'package.json'))('js-yaml')
const workspace = yaml.load(readFileSync(join(upstream, 'pnpm-workspace.yaml'), 'utf8'))
const workspacePaths = globSync(workspace.packages.map((pattern) => `${pattern}/package.json`), { cwd: upstream })
const available = new Map(workspacePaths.map((manifestPath) => {
  const manifest = JSON.parse(readFileSync(join(upstream, manifestPath), 'utf8'))
  return [manifest.name, { manifest, directory: manifestPath.replaceAll('\\', '/').slice(0, -'/package.json'.length) }]
}))
const roots = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']
const selected = new Map()
const compatible = (rules, value) => !rules || (rules.every((rule) => rule.startsWith('!'))
  ? !rules.includes(`!${value}`)
  : rules.includes(value) || rules.includes('any'))
const visit = (name) => {
  if (selected.has(name)) return
  const record = available.get(name)
  if (!record) throw new Error(`workspace package closure omits ${name}`)
  selected.set(name, record)
  for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const dependency of Object.keys(record.manifest[section] ?? {})) {
      const candidate = available.get(dependency)
      if (!candidate) continue
      if (section === 'optionalDependencies' &&
        (!compatible(candidate.manifest.os, process.platform) || !compatible(candidate.manifest.cpu, process.arch))) continue
      visit(dependency)
    }
  }
}
for (const name of roots) visit(name)
console.log(`Workspace closure before packing: ${selected.size} packages`)
for (const [name, record] of selected) {
  const destination = record.directory === 'apps/desktop-host' ? packedHost
    : record.directory.startsWith('vendor/') ? packedVendor
      : record.directory.startsWith('native/system/packages/') ? packedLandlock : packedDsh
  console.log(`pnpm pack ${name}`)
  const result = spawnSync(process.execPath, [pnpmEntry, '--dir', join(upstream, record.directory), 'pack', '--pack-destination', destination], { cwd: upstream, stdio: 'inherit', env: { ...process.env, npm_execpath: pnpmEntry } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`packing ${name} failed with ${String(result.status)}`)
}
prepareDesktopPackageSet([packedDsh, packedHost, packedVendor, packedLandlock], packageSet)
const version = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8')).version
const packageManager = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8')).packageManager
const pnpmVersion = String(packageManager).replace(/^pnpm@/u, '').split('+')[0]
const release = { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: process.versions.node, pnpmVersion }
createRuntimeProjectMetadata(project, release)
const workspaceConfig = readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')
if (!workspaceConfig.includes('nodeLinker: hoisted') || !workspaceConfig.includes('autoInstallPeers: false')) {
  throw new Error('runtime project is missing upstream hoisted-linker workspace settings')
}
const userConfig = join(project, 'isolated.npmrc')
writeFileSync(userConfig, '')
const pnpm = (...args) => {
  console.log(`pnpm ${args.join(' ')}`)
  const result = spawnSync(process.execPath, [pnpmEntry, `--config.registry=${process.env.npm_config_registry ?? 'https://registry.npmjs.org/'}`, `--config.store-dir=${join(project, 'store')}`, `--config.userconfig=${userConfig}`, ...args], { cwd: project, stdio: 'inherit', env: { ...process.env, npm_execpath: pnpmEntry, NPM_CONFIG_USERCONFIG: userConfig } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with ${String(result.status)}`)
}
pnpm('install', '--lockfile-only')
pnpm('install', '--prod', '--frozen-lockfile', '--trust-lockfile')
const modules = join(project, 'node_modules')
if (readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8').includes('nodeLinker: hoisted') === false) {
  throw new Error('runtime project lost its hoisted-linker setting')
}
const pnpmMetadata = join(modules, '.pnpm')
if (existsSync(pnpmMetadata)) {
  const entries = readdirSync(pnpmMetadata)
  if (entries.some((entry) => entry !== 'lock.yaml')) {
    throw new Error(`hoisted runtime has unexpected .pnpm contents: ${entries.join(', ')}`)
  }
  // pnpm 11.7 writes only its lock metadata here in hoisted mode. The upstream
  // file policy excludes this manager directory, so remove it before copying.
  rmSync(pnpmMetadata, { recursive: true, force: true })
}
if (existsSync(pnpmMetadata)) throw new Error('runtime .pnpm metadata was not removed')
const target = { platform: process.platform, arch: process.arch }
const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
const officeEngine = selectOfficeEngine(officeManifest, target)
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const materialized = join(output, 'node_modules')
cpSync(modules, materialized, {
  recursive: true,
  dereference: true,
  filter: (source) => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
})
const set = JSON.parse(readFileSync(join(packageSet, 'desktop-packages.json'), 'utf8'))
writeFileSync(join(output, 'package.json'), `${JSON.stringify({
  name: '@deepseek-ai/dsh-desktop-runtime', private: true, version,
  type: 'module', dependencies: Object.fromEntries(set.packages.map((entry) => [entry.name, entry.version])),
}, null, 2)}\n`)
copyFileSync(adapterSource, join(output, 'adapter.mjs'))
const stdoutFd = openSync(probeStdout, 'w')
const stderrFd = openSync(probeStderr, 'w')
let probe
try {
  probe = spawnSync(process.execPath, [join(output, 'adapter.mjs')], {
    cwd: output,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !['DSH_DESKTOP_CONTROL_SOCKET', 'DSH_DESKTOP_CONTROL_TOKEN'].includes(key))),
    timeout: 15000,
    stdio: ['ignore', stdoutFd, stderrFd],
  })
} finally {
  closeSync(stdoutFd)
  closeSync(stderrFd)
}
const probeText = `${readFileSync(probeStdout, 'utf8')}${readFileSync(probeStderr, 'utf8')}`
console.log(`resolution check (exit ${String(probe.status)}): ${probeText.trim()}`)
const expectedProbeText = 'dsh desktop adapter: DSH_DESKTOP_CONTROL_SOCKET / DSH_DESKTOP_CONTROL_TOKEN are required'
if (probe.error || probe.status !== 1 || probeText.trim() !== expectedProbeText ||
  /ERR_MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|SyntaxError|ECONNREFUSED/u.test(probeText)) {
  throw new Error(`runtime adapter failed resolution check: ${probe.error?.message ?? probeText}`)
}
console.log(`Selected package closure: ${set.packages.length} packages`)
'@ | Set-Content -Encoding utf8 $nodeStage
  # Upstream uses one directory for both the package set and runtime project:
  # createRuntimeProjectMetadata verifies the package set from projectDir.
  $packageSet = Join-Path $staging 'runtime-project'
  $project = $packageSet
  $dsh = Join-Path $payload 'dsh'
  $nodeArgs = @('--import', 'tsx/esm', $nodeStage, $Upstream, $pnpmEntry,
    $packedDsh, $packedHost, $packedVendor, $packedLandlock, $packageSet, $project, $dsh,
    (Join-Path $TauriDir 'runtime\adapter.mjs'),
    (Join-Path $Scratch 'adapter-resolution.stdout'), (Join-Path $Scratch 'adapter-resolution.stderr'))
  Invoke-Checked 'node' $nodeArgs $Upstream

  $anchors = @(
    'node_modules\@deepseek-ai\dsh\package.json',
    'node_modules\@deepseek-ai\cordis-plugin-group\package.json',
    'node_modules\@deepseek-ai\dsh-base\package.json',
    'node_modules\@deepseek-ai\dsh-web-app\package.json')
  $missing = @($anchors | Where-Object { -not (Test-Path (Join-Path $dsh $_)) })

  # Ship the port-owned client plugins (finding F-43). Upstream's package set is a
  # dependency closure rooted at @deepseek-ai/dsh and desktop-host, so a
  # port-owned package is NOT in it by construction and has to be added
  # explicitly here. Each plugin carries its own `dsh.bundle.patch`, which is how
  # port policy reaches the desktop profile -- for example disabling the
  # web-oriented account plugin -- WITHOUT writing into the user's own
  # profiles/desktop/cordis.patch.yml.
  # Copied BEFORE the integrity checks so reparse points, path depth and the file
  # count all cover what actually ships, and so a missing plugin fails the stage
  # loudly instead of silently producing an installer without it.
  $portPlugins = @(
    @{ Source = (Join-Path $UiDir 'client-updates'); Name = '@dsh-port\dsh-client-ui-updates' }
  )
  foreach ($plugin in $portPlugins) {
    $pluginTarget = Join-Path $dsh (Join-Path 'node_modules' $plugin.Name)
    New-Item -ItemType Directory -Force -Path $pluginTarget | Out-Null
    foreach ($file in @('package.json', 'cordis.patch.yml', 'lib\index.js', 'lib\client.js', 'lib\client.js.map')) {
      $from = Join-Path $plugin.Source $file
      if (-not (Test-Path $from)) {
        throw "Port plugin file missing: $from. Build it first with: & `"$PSScriptRoot\build.ps1`" -Stage ui"
      }
      $to = Join-Path $pluginTarget $file
      New-Item -ItemType Directory -Force -Path (Split-Path $to -Parent) | Out-Null
      Copy-Item $from $to -Force
    }
    Write-Host "    port plugin -> $pluginTarget" -ForegroundColor DarkGray
  }

  $reparse = @(Get-ChildItem (Join-Path $dsh 'node_modules') -Recurse -Force -ErrorAction Stop |
    Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  $files = @(Get-ChildItem (Join-Path $dsh 'node_modules') -Recurse -File -Force)
  $deepest = 0
  foreach ($file in $files) { if ($file.FullName.Length -gt $deepest) { $deepest = $file.FullName.Length } }
  foreach ($relative in $anchors) {
    $entry = Get-Item (Join-Path $dsh $relative) -ErrorAction SilentlyContinue
    if ($entry -and ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $missing += "$relative (reparse point)" }
  }
  # Reject anything unexpected at the payload root. This directory is mapped
  # WHOLESALE into the installer (`../../runtime-payload/dsh/` -> `dsh/`), so any
  # stray staged entry ships. A debug probe directory left behind by an
  # interrupted build did exactly that (finding F-26), and no behavioural check
  # could see it because the debris is inert while the application still runs.
  $expectedTopLevel = @('adapter.mjs', 'node_modules', 'package.json')
  $unexpected = @(Get-ChildItem $dsh -Force -ErrorAction SilentlyContinue |
    Where-Object { $expectedTopLevel -notcontains $_.Name } | ForEach-Object { $_.Name })

  if ($unexpected.Count -or $missing.Count -or $reparse.Count -or $deepest -ge 260) {
    if ($unexpected.Count) {
      throw "Runtime payload guard failed: unexpected top-level entries would ship: $($unexpected -join ', '). Expected only: $($expectedTopLevel -join ', ')."
    }
    throw "Runtime payload guard failed: missingOrLinked=$($missing -join ', '); reparsePoints=$($reparse.Count); deepestPath=$deepest"
  }

  # Node helper has already run the adapter from the materialized payload with
  # a 15-second timeout, capturing stdout/stderr through file descriptors and
  # asserting exit 1 plus only the expected missing-control-env diagnostic.
  Write-Host "    materialized files=$($files.Count), reparsePoints=$($reparse.Count), deepestPath=$deepest chars" -ForegroundColor Green
  Write-Host "    payload -> $payload" -ForegroundColor DarkGray
}

function Build-Bundle {
  Write-Stage 'Release bundle and Windows installer (NSIS)'
  Assert-Tool 'cargo' 'Install Rust via rustup.'
  Invoke-Checked 'cargo' @('tauri', 'build') $TauriDir
  $nsis = Join-Path $TauriDir 'target\release\bundle\nsis'
  if (Test-Path $nsis) {
    Write-Host "    installer output: $nsis" -ForegroundColor Green
    Get-ChildItem $nsis -File | ForEach-Object { Write-Host "      $($_.Name)  $([math]::Round($_.Length / 1MB, 2)) MB" }
  } else {
    Write-Warning "No NSIS output found at $nsis (non-Windows host or bundler skipped)."
  }
}

function Test-InterfaceFixtures {
  Write-Stage 'Interface fixture parity (Rust + TypeScript round-trip the same bytes)'
  Invoke-Checked 'cargo' @('test', '--workspace', '--test', 'protocol_fixtures') $TauriDir
  Invoke-Checked 'pnpm' @('run', 'test') $UiDir
}

Test-Prerequisites

$doAll = $Stage -eq 'all'
if ($doAll -or $Stage -eq 'ui') { Build-Ui }
if ($doAll -or $Stage -eq 'core') { Build-Core }
if ($doAll -or $Stage -eq 'runtime') { Stage-Runtime }
if ($doAll -or $Stage -eq 'verify') { Test-InterfaceFixtures }
if ($doAll -or $Stage -eq 'bundle') { $Release = $true; Build-Bundle }

Write-Host ''
Write-Host 'Build complete.' -ForegroundColor Green
Write-Host 'Signing and update delivery are NOT part of this build; see docs/build-and-install.md section 7.' -ForegroundColor Yellow
