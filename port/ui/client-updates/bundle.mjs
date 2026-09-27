import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = dirname(fileURLToPath(import.meta.url))
const repositoryRoot = resolve(packageRoot, '../../..')
const pnpmStore = resolve(repositoryRoot, '_upstream/node_modules/.pnpm')
const dependency = readdirSync(pnpmStore).find(name => name.startsWith('tsdown@0.22.2_'))
if (dependency === undefined) throw new Error('the pinned upstream tsdown 0.22.2 toolchain is unavailable')
const runner = resolve(pnpmStore, dependency, 'node_modules/tsdown/dist/run.mjs')
if (!existsSync(runner)) throw new Error(`the pinned tsdown runner is missing: ${runner}`)
const result = spawnSync(process.execPath, [runner, '--config', 'tsdown.config.ts'], {
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
