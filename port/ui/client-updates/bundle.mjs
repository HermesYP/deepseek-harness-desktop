/**
 * Bundle the port-owned Updates client plugin with the target checkout's own
 * tsdown toolchain, then verify the emitted `__ModuleLoader__` wrapper.
 *
 * Two upstream facts are read from the checkout rather than repeated here:
 *
 *   * the tsdown version the checkout declares (a literal pinned the port to a
 *     toolchain the target may no longer install);
 *   * the module-config loader. The target's own bundle scripts run
 *     `tsdown --config-loader native`; the port passes the same loader so the
 *     emitted plugin is produced by the same configuration path as upstream's.
 *
 * The upstream checkout is explicit: `$DSH_UPSTREAM_ROOT`, else `<repo>/_upstream`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(packageRoot, '../../..')
const upstreamRoot = process.env.DSH_UPSTREAM_ROOT
  ? resolve(process.env.DSH_UPSTREAM_ROOT)
  : resolve(repositoryRoot, '_upstream')
const pnpmStore = resolve(upstreamRoot, 'node_modules/.pnpm')

if (!existsSync(pnpmStore)) {
  throw new Error(`the upstream pnpm store is unavailable at ${pnpmStore}; build and install ${upstreamRoot} first`)
}

/** The tsdown range the upstream checkout declares. */
function declaredTsdownRange() {
  const manifestPath = resolve(upstreamRoot, 'package.json')
  if (!existsSync(manifestPath)) throw new Error(`the upstream root manifest is absent: ${manifestPath}`)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const range = manifest?.devDependencies?.tsdown ?? manifest?.dependencies?.tsdown
  if (typeof range !== 'string' || range.length === 0) {
    throw new Error(`the upstream checkout at ${upstreamRoot} declares no tsdown dependency; refusing to guess the toolchain`)
  }
  return range
}

function parseVersion(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(text)
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** Whether an installed version satisfies the declared caret or exact range. */
function satisfies(version, range) {
  const target = parseVersion(version)
  if (target === null) return false
  const caret = /^\^(\d+\.\d+\.\d+)$/u.exec(range.trim())
  if (caret !== null) {
    const base = parseVersion(caret[1])
    if (base[0] > 0) {
      return target[0] === base[0] && (target[1] > base[1] || (target[1] === base[1] && target[2] >= base[2]))
    }
    if (base[1] > 0) return target[0] === base[0] && target[1] === base[1] && target[2] >= base[2]
    return target[0] === 0 && target[1] === 0 && target[2] === base[2]
  }
  if (/^\d+\.\d+\.\d+$/u.test(range.trim())) return range.trim() === version
  throw new Error(`unsupported upstream tsdown range '${range}'; refusing to guess whether an installed version satisfies it`)
}

/** The single installed tsdown version satisfying the declared range. */
function resolveTsdownDirectory() {
  const range = declaredTsdownRange()
  const candidates = []
  for (const name of readdirSync(pnpmStore)) {
    if (!name.startsWith('tsdown@')) continue
    const version = name.slice('tsdown@'.length).split('_')[0]
    if (satisfies(version, range)) candidates.push({ name, version })
  }
  if (candidates.length !== 1) {
    throw new Error(
      `the upstream checkout declares tsdown '${range}' and ${candidates.length} installed versions satisfy it`
      + ` (${candidates.map(candidate => candidate.version).join(', ') || 'none'}); exactly one reviewed toolchain is required`,
    )
  }
  return candidates[0]
}

const tsdown = resolveTsdownDirectory()
const runner = resolve(pnpmStore, tsdown.name, 'node_modules/tsdown/dist/run.mjs')
if (!existsSync(runner)) throw new Error(`the resolved tsdown ${tsdown.version} runner is missing: ${runner}`)

const result = spawnSync(process.execPath, [runner, '--config-loader', 'native', '--config', 'tsdown.config.ts'], {
  cwd: packageRoot,
  stdio: 'inherit',
})
if (result.error !== undefined) throw result.error
if (result.status !== 0) {
  process.exitCode = result.status ?? 1
} else {
  const verification = spawnSync(process.execPath, ['verify-wrapper.mjs'], {
    cwd: packageRoot,
    stdio: 'inherit',
  })
  if (verification.error !== undefined) throw verification.error
  if (verification.status !== 0) process.exitCode = verification.status ?? 1
}
