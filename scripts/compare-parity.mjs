/**
 * Parity comparison harness (CLI).
 *
 * Compares a REFERENCE capture tree against a PORT capture tree produced by the
 * same capture harness, at identical viewports, themes and interaction steps.
 *
 * Usage:
 *   node scripts/compare-parity.mjs --reference <dir> --port <dir> [--out <report.json>]
 *     [--raster-tolerance <fraction>] [--raster-max-delta <0-255>]
 *
 * All comparison logic lives in `scripts/lib/parity-core.mjs` so the
 * fixture-level tests can drive the identical code path in-process. This file
 * only parses arguments, writes the report and reports the verdict.
 *
 * WHAT WAS WRONG, AND WHY EACH FIX MATTERS
 *
 *   1. WRONG STEP PAIRED. Reading `trace.trace[i]` by array POSITION was wrong
 *      because the capture harness pushes one entry per action error IN ADDITION
 *      to one entry per step: the recorded reference trace has 24 entries for 19
 *      steps, so from the first failed action onward every comparison paired
 *      unrelated steps. Steps are now keyed by their stable id.
 *   2. SELF-COMPARISON "PASSED". Comparing a tree with itself yields "identical"
 *      for every frame and proves nothing. Refused as a usage error.
 *   3. ZERO CAPTURES "PASSED". An empty or mismatched tree produced
 *      `compared: 0` and exit 0. A comparison that covered nothing now fails.
 *   4. VISUAL VERDICT WAS AN ASSUMPTION. "dom-identical" carried the note
 *      "raster differs (expected across engines)" — an assumption standing in for
 *      a measurement. Frames are decoded and compared per pixel, and the report
 *      carries the measured ratio, peak delta and every explicit mask with its
 *      reason.
 *   5. ENVIRONMENT WAS NOT CHECKED. Trees captured at different viewports,
 *      locales, DPI or harness revisions were compared as if comparable.
 *   6. ACTION ERRORS WERE TOLERATED. They are blocking verdicts now.
 *
 * Owned by: parity lane V.
 */
import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Verdict, usageError } from '../port/tests/helpers/verdict.mjs'
import { SEQUENCE } from '../port/tests/helpers/capture-sequence.mjs'
import { compareTrees, validateOptions } from './lib/parity-core.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const referenceRoot = resolve(arg('reference', 'docs/evidence/reference'))
const portRoot = resolve(arg('port', 'docs/evidence/port'))
const outPath = resolve(arg('out', 'docs/evidence/parity-report.json'))
const toleranceArg = arg('raster-tolerance', '0.002')
const rasterTolerance = Number(toleranceArg)
const maxDeltaArg = arg('raster-max-delta', '24')
const rasterMaxDelta = Number(maxDeltaArg)

try {
  validateOptions({ rasterTolerance, rasterMaxDelta })
} catch (error) {
  usageError(`${error.message} (--raster-tolerance / --raster-max-delta)`)
}

let report
try {
  report = await compareTrees({ referenceRoot, portRoot, rasterTolerance, rasterMaxDelta })
} catch (error) {
  // Configuration problems (same tree, absent tree) are usage errors: they mean
  // the gate was not given what it needs to run honestly, which is not the same
  // as the product under test failing.
  usageError(String(error.message))
}

await writeFile(outPath, JSON.stringify(report, null, 2))
console.log(`\n${JSON.stringify({
  outPath,
  counts: report.counts,
  compared: report.totals.compared,
  parity: report.totals.parity,
  blocking: report.totals.blocking,
}, null, 2)}`)

const verdict = new Verdict('parity comparison')
verdict.record(
  'both trees cover the same viewports',
  report.missingViewports.length === 0 ? 'PASS' : 'FAIL',
  report.missingViewports.length === 0 ? 'viewports match' : report.missingViewports.join(', '),
)
verdict.record(
  'the comparison actually covered every step',
  report.totals.compared > 0 ? 'PASS' : 'FAIL',
  report.totals.compared > 0
    ? `${report.totals.compared} step comparison(s)`
    : 'no step was compared; a comparison that covers nothing cannot pass',
)
verdict.record(
  'the trees recorded matching environment identities',
  report.identityMismatches.length === 0 ? 'PASS' : 'FAIL',
  report.identityMismatches.length === 0 ? undefined : report.identityMismatches.join(' | '),
)
verdict.record(
  'every compared step reached visual and state parity',
  report.totals.blocking === 0 && report.totals.parity > 0 ? 'PASS' : 'FAIL',
  report.totals.blocking === 0
    ? (report.totals.parity > 0 ? `${report.totals.parity} step(s) identical` : 'no step reached identical')
    : `${report.totals.blocking} step(s) are not parity`,
)

const blocking = report.rows.filter(row => row.verdict !== 'identical' && row.verdict !== 'not-applicable')
if (blocking.length > 0) {
  console.error(`\nPARITY GAPS: ${blocking.length} step(s) are not parity:`)
  for (const row of blocking.slice(0, 60)) {
    const detail = (row.differences ?? []).join(', ')
    const raster = row.raster === undefined ? '' : ` raster ${(row.raster.differingRatio * 100).toFixed(3)}%`
    console.error(`  ${row.verdict.padEnd(16)} ${row.id}  [${detail}]${raster}`)
  }
}
const notApplicable = report.rows.filter(row => row.verdict === 'not-applicable')
if (notApplicable.length > 0) {
  console.log(`\nNOT COMPARED (optional actions the reference did not exercise): ${notApplicable.length}`)
  for (const row of notApplicable) console.log(`  ${row.id}`)
}
if (report.totals.parity > 0 && report.totals.blocking === 0) {
  console.log(`\nExpected step count per viewport/theme: ${SEQUENCE.length}`)
}

verdict.finish()
