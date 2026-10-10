# Materialize the supervised dsh runtime payload.
#
# This module owns the Node-side staging program that `build.ps1` used to embed
# as an inline here-string. It was extracted so the materializer is a reviewable
# file with a header stating its contract, rather than 130 lines of JavaScript
# inside a PowerShell string.
#
# The staged tree is produced entirely by upstream's own machinery, imported
# from the read-only reference checkout, so the payload cannot drift from the
# product it is supposed to reproduce:
#
#   * `prepare-package-set.ts`  selects the tarball closure rooted at BOTH
#     `@deepseek-ai/dsh` and `@deepseek-ai/dsh-desktop-host`, walking
#     `dependencies`, `peerDependencies` and platform-filtered
#     `optionalDependencies`.
#   * `project-manager.ts`      writes the isolated runtime project whose
#     `pnpm-workspace.yaml` sets `nodeLinker: hoisted` and
#     `autoInstallPeers: false`, which is what produces a flat tree of real
#     directories instead of a `.pnpm` junction farm (findings F-15/F-17/F-21).
#   * `runtime-file-policy.ts`  decides exactly which installed files are
#     omitted, including the LibreOffice engine selection.
#
# No step here reaches the network on its own behalf and no step substitutes a
# different package manager, linker or registry: `--frozen-lockfile
# --trust-lockfile` against the lockfile generated from the pinned package set
# is what makes the closure reproducible.
#
# TWO TREES, TWO CONTRACTS.
#
# The stage builds in a staging root and publishes only its inner `dsh/` tree, so
# there are two different acceptable top-level shapes:
#
#   staging root  packed/ work/ dsh/ node/ stage-runtime.mjs node-identity.json
#                 -> Get-DshStagingTopLevel
#   payload root  adapter.mjs node_modules/ node/ package.json runtime-payload.json
#                 desktop-runtime.json NODE-LICENSE.txt
#                 -> Get-DshPayloadTopLevel (this is what SHIPS)
#
# Confusing the two makes the stage reject its own correct working tree, because
# the staging root necessarily holds the build's workspace. Each set is therefore
# named and consumed separately, and the payload shape is asserted against the
# inner tree both before and after the swap.

Set-StrictMode -Version Latest

# The staging program. Inputs are positional so the caller can pass them
# explicitly; every path and pin it needs arrives as an argument.
$script:DshRuntimeStageProgram = @'
import { closeSync, copyFileSync, cpSync, existsSync, globSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const [
  upstream, pnpmEntry, packedDsh, packedHost, packedVendor, packedLandlock,
  packageSet, project, output, adapterSource, probeStdout, probeStderr, identityFile,
] = process.argv.slice(2)

const importUpstream = (file) => import(pathToFileURL(join(upstream, file)).href)
const { prepareDesktopPackageSet } = await importUpstream('apps/desktop/scripts/prepare-package-set.ts')
const { createRuntimeProjectMetadata } = await importUpstream('apps/desktop/src/project-manager.ts')
const { DESKTOP_HOST_PROTOCOL_VERSION } = await importUpstream('apps/desktop/src/host-protocol.ts')
const { desktopRuntimeFileExclusion } = await importUpstream('apps/desktop/scripts/runtime-file-policy.ts')
const { selectOfficeEngine } = await importUpstream('scripts/libreoffice-packages.mjs')

// --- package closure --------------------------------------------------------
// Mirrors upstream prepare-package-set.ts: two roots, three sections, optional
// dependencies filtered by the target platform. A package the closure omits is
// a hard failure (`workspace package closure omits ...`) rather than a silent
// gap, because a missing package surfaces much later as an unresolvable import
// inside the Host process (finding F-13).
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

// --- pack -------------------------------------------------------------------
// `pnpm pack` per closure package. Packing, not linking, is what makes the
// inputs explicit: each tarball is an immutable artifact with a recorded
// integrity hash in the package set descriptor.
for (const [name, record] of selected) {
  const destination = record.directory === 'apps/desktop-host' ? packedHost
    : record.directory.startsWith('vendor/') ? packedVendor
      : record.directory.startsWith('native/system/packages/') ? packedLandlock : packedDsh
  console.log(`pnpm pack ${name}`)
  const result = spawnSync(process.execPath, [pnpmEntry, '--dir', join(upstream, record.directory), 'pack', '--pack-destination', destination], {
    cwd: upstream, stdio: 'inherit', env: { ...process.env, npm_execpath: pnpmEntry },
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`packing ${name} failed with ${String(result.status)}`)
}
prepareDesktopPackageSet([packedDsh, packedHost, packedVendor, packedLandlock], packageSet)

// --- isolated runtime project ----------------------------------------------
const rootManifest = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'))
const version = rootManifest.version
const pnpmVersion = String(rootManifest.packageManager).replace(/^pnpm@/u, '').split('+')[0]
const release = { schemaVersion: 1, version, hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: process.versions.node, pnpmVersion }
createRuntimeProjectMetadata(project, release)
const workspaceConfig = readFileSync(join(project, 'pnpm-workspace.yaml'), 'utf8')
if (!workspaceConfig.includes('nodeLinker: hoisted') || !workspaceConfig.includes('autoInstallPeers: false')) {
  throw new Error('runtime project is missing upstream hoisted-linker workspace settings')
}

// --- install ----------------------------------------------------------------
// The user config is emptied so a developer's `~/.npmrc` cannot redirect the
// registry, inject an auth token, or change the linker for a build that ships.
const userConfig = join(project, 'isolated.npmrc')
writeFileSync(userConfig, '')
const pnpm = (...args) => {
  console.log(`pnpm ${args.join(' ')}`)
  const result = spawnSync(process.execPath, [
    pnpmEntry,
    `--config.registry=${process.env.npm_config_registry ?? 'https://registry.npmjs.org/'}`,
    `--config.store-dir=${join(project, 'store')}`,
    `--config.userconfig=${userConfig}`,
    ...args,
  ], { cwd: project, stdio: 'inherit', env: { ...process.env, npm_execpath: pnpmEntry, NPM_CONFIG_USERCONFIG: userConfig } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed with ${String(result.status)}`)
}
pnpm('install', '--lockfile-only')
pnpm('install', '--prod', '--frozen-lockfile', '--trust-lockfile')

// --- hoisted-shape assertions ----------------------------------------------
// These assert the *shape* the later `cpSync(dereference: true)` depends on. If
// the linker silently fell back to isolated mode, `.pnpm` would hold the real
// packages and excluding it would discard the entire transitive layer - a
// failure that otherwise appears as an inexplicable module-resolution error
// (finding F-21).
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
  rmSync(pnpmMetadata, { recursive: true, force: true })
}
if (existsSync(pnpmMetadata)) throw new Error('runtime .pnpm metadata was not removed')

// --- materialize ------------------------------------------------------------
// The Office engine is selected from the *installed* kit manifest rather than
// assumed, and `desktopRuntimeFileExclusion` then drops every other target's
// engine. A cross-target install would otherwise ship a foreign binary.
const target = { platform: process.platform, arch: process.arch }
const officeManifest = JSON.parse(readFileSync(join(modules, '@deepseek-ai/libreoffice-kit/package.json'), 'utf8'))
const officeEngine = selectOfficeEngine(officeManifest, target)

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const materialized = join(output, 'node_modules')
cpSync(modules, materialized, {
  recursive: true,
  dereference: true,
  // `dereference: true` is what turns the top-level package links into real
  // directories. It is safe only because the install was hoisted: the filter
  // rejects `.pnpm` before it is traversed, so no junction cycle can be
  // followed (the F-17 robocopy loop).
  filter: (source) => desktopRuntimeFileExclusion(relative(modules, source), target, officeEngine) === undefined,
})

const set = JSON.parse(readFileSync(join(packageSet, 'desktop-packages.json'), 'utf8'))
writeFileSync(join(output, 'package.json'), `${JSON.stringify({
  name: '@deepseek-ai/dsh-desktop-runtime', private: true, version,
  type: 'module', dependencies: Object.fromEntries(set.packages.map((entry) => [entry.name, entry.version])),
}, null, 2)}\n`)
copyFileSync(adapterSource, join(output, 'adapter.mjs'))

// --- Office closure requirement --------------------------------------------
// The kit manifest is present but the *selected* engine must also be present,
// because a payload without it converts no document while every other check
// passes. Recorded so the packaging manifest ties the engine to the payload.
const engineDirectory = join(materialized, '@deepseek-ai', `libreoffice-kit-${officeEngine}`)
if (!existsSync(join(engineDirectory, 'package.json'))) {
  throw new Error(`runtime payload is missing the selected LibreOffice engine @deepseek-ai/libreoffice-kit-${officeEngine} for ${target.platform}/${target.arch}`)
}
if (!existsSync(join(engineDirectory, 'prebuilds.json'))) {
  throw new Error(`LibreOffice engine ${officeEngine} has no prebuilds.json; the payload cannot convert documents`)
}

// --- resolution probe -------------------------------------------------------
// Provenance: the adapter must load from the materialized tree. This is the only
// check that exercises Node's real resolver rather than a path existence test.
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
const probeText = `${readFileSync(probeStdout, 'utf8')}${readFileSync(probeStderr, 'utf8')}`.trim()
console.log(`resolution check (exit ${String(probe.status)}): ${probeText}`)
const expectedProbeText = 'dsh desktop adapter: DSH_DESKTOP_CONTROL_SOCKET / DSH_DESKTOP_CONTROL_TOKEN are required'
if (probe.error || probe.status !== 1 || probeText !== expectedProbeText ||
  /ERR_MODULE_NOT_FOUND|ERR_DLOPEN_FAILED|SyntaxError|ECONNREFUSED/u.test(probeText)) {
  throw new Error(`runtime adapter failed resolution check: ${probe.error?.message ?? probeText}`)
}

// --- identity ---------------------------------------------------------------
// The identity record ties the payload to the exact inputs that produced it.
// `build.ps1` folds this into the payload manifest, so a build that ships a
// different closure than the recorded one fails instead of drifting.
writeFileSync(identityFile, `${JSON.stringify({
  schemaVersion: 1,
  version,
  hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
  pnpmVersion,
  buildNodeVersion: process.versions.node,
  packageClosureSize: selected.size,
  packageSetSize: set.packages.length,
  officeEngine,
  platform: target.platform,
  arch: target.arch,
}, null, 2)}\n`)
console.log(`Selected package closure: ${set.packages.length} packages; Office engine: ${officeEngine}`)
'@

function Get-DshRuntimeStageProgram {
    [CmdletBinding()]
    param()

    return $script:DshRuntimeStageProgram
}

# Write the staging program to disk. It is written into the STAGING root, never
# into the published payload root, so it cannot ship: the payload root is
# validated against an explicit allowed top-level set before publication
# (finding F-26, where probe debris shipped wholesale).
function Write-DshRuntimeStageProgram {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$Path)

    $parent = Split-Path -Parent $Path
    if (-not (Test-Path -LiteralPath $parent)) {
        $null = New-Item -ItemType Directory -Force -Path $parent
    }
    [System.IO.File]::WriteAllText($Path, $script:DshRuntimeStageProgram, (New-Object System.Text.UTF8Encoding($false)))
    return $Path
}

# The allowed top level of a published payload. Anything else means the stage
# left debris behind, and because the installer maps this directory wholesale
# (tauri.conf.json: `../../runtime-payload/dsh/` -> `dsh/`) debris ships.
#
# This is the shape of the INNER `dsh/` directory (`$PayloadDsh`), NOT of the
# staging root. The staging root is a workspace that legitimately holds `packed/`,
# `work/`, `node/`, `dsh/`, `stage-runtime.mjs` and `node-identity.json`; asserting
# this set against it rejects a correct stage outright. Use
# `Get-DshStagingTopLevel` for the staging root (see `Get-DshStagingTopLevel`).
function Get-DshPayloadTopLevel {
    [CmdletBinding()]
    param()

    return @('adapter.mjs', 'node_modules', 'package.json', 'runtime-payload.json', 'NODE-LICENSE.txt', 'node', 'desktop-runtime.json')
}

# The allowed top level of the STAGING root, which is a different tree with a
# different contract.
#
# `Stage-RuntimeInto` creates exactly these entries and nothing else:
#
#   packed/               pnpm pack destinations (dsh, host, vendor, landlock)
#   work/                 the isolated runtime project, identity, probe output
#   dsh/                  the materialized payload - the ONLY part that publishes
#   node/                 the extracted pinned interpreter, moved into dsh/ later
#   stage-runtime.mjs     the staging program itself
#   node-identity.json    the pinned-interpreter record read back by the caller
#
# Declaring it separately is what makes the two assertions mean different things:
# the staging check catches workspace debris (a stray downloaded archive, a probe
# log) while the payload check catches SHIPPED debris (finding F-26). Collapsing
# them into one set is the defect this pair exists to prevent.
function Get-DshStagingTopLevel {
    [CmdletBinding()]
    param()

    return @('dsh', 'node', 'node-identity.json', 'packed', 'stage-runtime.mjs', 'work')
}

# The top level of the payload directory INSIDE a staging root. The staging tree
# carries the same shipped shape one level down, which is what lets the payload be
# validated BEFORE the swap rather than only after it.
function Get-DshStagedPayloadPath {
    [CmdletBinding()]
    param([Parameter(Mandatory)][string]$StageRoot)

    return (Join-Path $StageRoot 'dsh')
}

# Promote only the inner payload to a sibling before the publication helper's
# rename. Never publish the staging workspace or overwrite an unowned candidate.
function Publish-DshStagedPayload {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$StageRoot,
        [Parameter(Mandatory)][string]$PublishedPath
    )

    $workspace = (Resolve-Path -LiteralPath $StageRoot -ErrorAction Stop).Path
    $published = [System.IO.Path]::GetFullPath($PublishedPath)
    $parent = Split-Path -Parent $published
    $comparison = if ($env:OS -eq 'Windows_NT') {
        [System.StringComparison]::OrdinalIgnoreCase
    } else { [System.StringComparison]::Ordinal }
    if (-not [string]::Equals((Split-Path -Parent $workspace), $parent, $comparison) -or
        [string]::Equals($workspace, $published, $comparison)) {
        throw 'Payload staging workspace must be a distinct sibling of the published directory.'
    }
    $payload = Get-DshStagedPayloadPath -StageRoot $workspace
    $candidate = Join-Path $parent "$(Split-Path -Leaf $published).candidate"
    if (Test-Path -LiteralPath $candidate) {
        throw "An unpublished payload candidate already exists at $candidate; inspect it before retrying."
    }
    if (-not (Test-Path -LiteralPath $payload -PathType Container) -or
        ((Get-Item -LiteralPath $workspace).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
        ((Get-Item -LiteralPath $payload).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
        throw "Staged payload must be a materialized directory: $payload"
    }

    # Both resolved targets are on the same parent volume. Directory.Move
    # relocates the inner tree without copying or rewriting sealed bytes.
    [System.IO.Directory]::Move($payload, $candidate)
    try {
        return Publish-DshStagedTree -StagedPath $candidate -PublishedPath $published
    } finally {
        # A failed publication keeps the candidate available to this owner.
        if (Test-Path -LiteralPath $candidate) {
            [System.IO.Directory]::Move($candidate, $payload)
        }
    }
}

# Register copied packages before either metadata inventory is written. The upstream
# descriptor's shared-package list is derived from these exact root declarations.
function Register-DshPayloadPackages {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)]
        [ValidatePattern('^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$')]
        [string[]]$Names
    )
    $manifestPath = Join-Path $Root 'package.json'
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($null -eq $manifest.dependencies -or $manifest.dependencies -isnot [pscustomobject]) {
        throw 'Payload package.json must declare an object of dependencies.'
    }
    foreach ($name in $Names) {
        $installedPath = Join-Path $Root "node_modules/$name/package.json"
        $installed = Get-Content -LiteralPath $installedPath -Raw | ConvertFrom-Json
        if ($installed.name -ne $name -or $installed.version -isnot [string] -or
            [string]::IsNullOrWhiteSpace($installed.version)) {
            throw "Copied package identity does not match $name."
        }
        $existing = $manifest.dependencies.PSObject.Properties[$name]
        if ($null -ne $existing -and $existing.Value -ne $installed.version) {
            throw "Payload already declares an incompatible version of $name."
        }
        $manifest.dependencies | Add-Member -NotePropertyName $name -NotePropertyValue $installed.version -Force
    }
    $json = $manifest | ConvertTo-Json -Depth 20
    [System.IO.File]::WriteAllText($manifestPath, "$json`n", (New-Object System.Text.UTF8Encoding($false)))
}

# Package anchors that must be real directories in the published payload. The
# first four are the profile-boot closure that F-13/F-22 established; a payload
# missing any of them boots to a profile that silently omits a layer.
function Get-DshPayloadAnchors {
    [CmdletBinding()]
    param()

    return @(
        'node_modules/@deepseek-ai/dsh'
        'node_modules/@deepseek-ai/cordis-plugin-group'
        'node_modules/@deepseek-ai/dsh-base'
        'node_modules/@deepseek-ai/dsh-web-app'
        'node_modules/@deepseek-ai/dsh-desktop-host'
        'node_modules/@deepseek-ai/libreoffice-kit'
    )
}

# Probe files that assert each anchor is a real package, not a dangling link.
function Get-DshPayloadAnchorFiles {
    [CmdletBinding()]
    param()

    return @($(Get-DshPayloadAnchors | ForEach-Object { "$_/package.json" }))
}

Export-ModuleMember -Function @(
    'Get-DshRuntimeStageProgram'
    'Write-DshRuntimeStageProgram'
    'Get-DshPayloadTopLevel'
    'Get-DshStagingTopLevel'
    'Get-DshStagedPayloadPath'
    'Publish-DshStagedPayload'
    'Register-DshPayloadPackages'
    'Get-DshPayloadAnchors'
    'Get-DshPayloadAnchorFiles'
)
