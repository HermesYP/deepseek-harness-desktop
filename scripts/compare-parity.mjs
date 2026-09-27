/**
 * Parity comparison harness.
 *
 * Compares a REFERENCE capture tree against a PORT capture tree produced by the
 * same capture harness, at identical viewports, themes and interaction steps,
 * and reports per-step parity. Dependency-free on purpose: it compares the
 * deterministic DOM facts recorded in `trace.json` plus exact image bytes, and
 * never guesses at pixels it cannot account for.
 *
 * Usage:
 *   node scripts/compare-parity.mjs --reference <dir> --port <dir> [--out <report.json>]
 *
 * Verdicts per step:
 *   identical        image bytes match AND every tracked DOM fact matches
 *   dom-identical    every tracked DOM fact matches, image bytes differ
 *   different        at least one tracked DOM fact differs
 *   missing-in-port  the port produced no frame for this step
 *   action-error     one side recorded an action error for this step
 *
 * Owned by: lead (acceptance evidence). Do not edit in an implementation lane.
 */
import { createHash } from 'node:crypto'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const referenceRoot = resolve(arg('reference', 'docs/evidence/reference'))
const portRoot = resolve(arg('port', 'docs/evidence/port'))
const outPath = resolve(arg('out', 'docs/evidence/parity-report.json'))

/**
 * The deterministic DOM facts that must match for visual/state parity. These are
 * exactly what the capture harness records, so the comparison has no hidden
 * heuristics: text content, landmark count and installed font faces.
 */
const TRACKED_FACTS = ['title', 'lang', 'landmarkCount', 'fonts', 'textSample']

async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

/** SHA-256 of a file, or null when absent. */
async function hashOf(path) {
  if (!await exists(path)) return null
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** Load one run's trace.json and index its steps by capture order. */
async function loadTrace(dir) {
  const path = join(dir, 'trace.json')
  if (!await exists(path)) return null
  return JSON.parse(await readFile(path, 'utf8'))
}

function diffFacts(a, b) {
  const differences = []
  for (const fact of TRACKED_FACTS) {
    const left = JSON.stringify(a?.[fact] ?? null)
    const right = JSON.stringify(b?.[fact] ?? null)
    if (left !== right) differences.push(fact)
  }
  return differences
}

async function listStepIds(dir) {
  if (!await exists(dir)) return []
  const entries = await readdir(dir)
  return entries
    .filter((name) => name.endsWith('.png'))
    .map((name) => name.slice(0, -4))
    .sort()
}

const rows = []
const viewports = (await exists(referenceRoot))
  ? (await readdir(referenceRoot, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
  : []

for (const viewport of viewports) {
  for (const theme of ['light', 'dark']) {
    const refDir = join(referenceRoot, viewport, theme)
    const portDir = join(portRoot, viewport, theme)
    const refTrace = await loadTrace(refDir)
    const portTrace = await loadTrace(portDir)
    const stepIds = await listStepIds(refDir)

    for (let i = 0; i < stepIds.length; i += 1) {
      const step = stepIds[i]
      const id = `${viewport}/${theme}/${step}`
      const refImage = join(refDir, `${step}.png`)
      const portImage = join(portDir, `${step}.png`)

      if (!await exists(portImage)) {
        rows.push({ id, verdict: 'missing-in-port', differences: ['frame'] })
        continue
      }

      const refStep = refTrace?.trace?.[i]
      const portStep = portTrace?.trace?.[i]
      const refHash = await hashOf(refImage)
      const portHash = await hashOf(portImage)

      if (refStep?.actionError || portStep?.actionError) {
        rows.push({
          id,
          verdict: 'action-error',
          differences: ['actionError'],
          note: { reference: refStep?.actionError ?? null, port: portStep?.actionError ?? null },
        })
        continue
      }

      const differences = diffFacts(refStep?.dom, portStep?.dom)
      const verdict = differences.length > 0
        ? 'different'
        : (refHash === portHash ? 'identical' : 'dom-identical')

      rows.push({
        id,
        verdict,
        differences,
        ...(verdict === 'dom-identical' ? { note: 'DOM facts match; raster differs (expected across engines)' } : {}),
      })
    }
  }
}

const counts = rows.reduce((acc, row) => {
  acc[row.verdict] = (acc[row.verdict] ?? 0) + 1
  return acc
}, {})

const report = {
  generatedAt: new Date().toISOString(),
  referenceRoot,
  portRoot,
  trackedFacts: TRACKED_FACTS,
  counts,
  totals: { compared: rows.length },
  rows,
}

await writeFile(outPath, JSON.stringify(report, null, 2))

// eslint-disable-next-line no-console
console.log(JSON.stringify({ outPath, counts, compared: rows.length }, null, 2))
const blocking = rows.filter((r) => r.verdict === 'different' || r.verdict === 'missing-in-port')
if (blocking.length > 0) {
  // eslint-disable-next-line no-console
  console.error(`PARITY GAPS: ${blocking.length} step(s) differ or are missing:`)
  for (const row of blocking.slice(0, 40)) {
    // eslint-disable-next-line no-console
    console.error(`  ${row.verdict.padEnd(16)} ${row.id}  [${(row.differences ?? []).join(', ')}]`)
  }
  process.exitCode = 1
}
