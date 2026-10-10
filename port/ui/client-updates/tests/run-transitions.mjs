/**
 * In-process runner for the Updates-section transition tests.
 *
 * The repository's `vitest`/`node --test` runners spawn a piped child process,
 * which the DSH Windows file sandbox refuses (`spawn EPERM`). This runner
 * imports the same spec file and executes it in one process, redirecting the
 * spec's `vitest` import to a minimal shim, so the same assertions still run
 * under confinement. The spec remains a normal vitest spec and is the file CI
 * runs unchanged.
 *
 * Only the pure transition specs in this directory run here. `plugin/` holds
 * the cases that drive `apply(ctx)` against a mocked desktop bridge; they need
 * module mocking and a JSX-capable loader, so they run under `pnpm test`.
 */

import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { register } from 'node:module'

const testsDirectory = dirname(fileURLToPath(import.meta.url))
const shimUrl = pathToFileURL(`${testsDirectory}/vitest-shim.mjs`).href
const suite = await import('./vitest-shim.mjs')

// Redirect the spec's `vitest` import to the shim.
register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, next) {
      if (specifier === 'vitest') return { url: ${JSON.stringify(shimUrl)}, shortCircuit: true }
      return next(specifier, context)
    }
  `)}`,
  { parentURL: import.meta.url },
)

const specFiles = readdirSync(testsDirectory).filter(name => name.endsWith('.spec.ts'))
for (const file of specFiles) {
  await import(new URL(`./${file}`, import.meta.url))
}

const { passed, failures, total } = suite.report()
console.log(`updates-state transitions: ${passed}/${total} passed`)
for (const failure of failures) console.error(`FAIL ${failure}`)
if (failures.length > 0) process.exitCode = 1
