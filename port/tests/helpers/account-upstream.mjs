import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Exercise a genuinely built checkout. A missing lib is a failed precondition,
// not a skipped review, and package version alone never approves a transform.
export const accountUpstreamRoot = process.env.DSH_UPSTREAM_ROOT
  ? resolve(process.env.DSH_UPSTREAM_ROOT)
  : fileURLToPath(new URL('../../../_upstream/', import.meta.url))
export const accountUpstreamVersion = JSON.parse(readFileSync(join(accountUpstreamRoot, 'package.json'), 'utf8')).version
export const readAccountUpstream = relative => readFileSync(join(accountUpstreamRoot, relative), 'utf8')
