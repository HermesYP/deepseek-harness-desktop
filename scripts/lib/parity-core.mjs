/**
 * Parity comparison core (lane V).
 *
 * This module holds the comparison itself so it can be driven IN-PROCESS by the
 * fixture-level tests. The CLI (`scripts/compare-parity.mjs`) is a thin wrapper
 * that parses arguments and reports. Keeping the logic importable matters on
 * this Windows host: the DSH file sandbox denies a sandboxed Node process
 * spawning a child with piped stdio (EPERM, the documented named-pipe
 * confinement), so a test cannot run the CLI as a subprocess and inspect its
 * exit code. Importing the same decision logic is not a workaround — it is the
 * same code path the CLI uses, which is why the CLI holds no comparison logic of
 * its own.
 */

import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { exists, diffIdentity } from '../../port/tests/helpers/verdict.mjs'
import { SEQUENCE, indexSteps, diffFacts } from '../../port/tests/helpers/capture-sequence.mjs'
import { comparePngFiles } from '../../port/tests/helpers/raster.mjs'

/** Verdicts that block parity. `not-applicable` is reported but is not parity. */
export const BLOCKING_VERDICTS = new Set([
  'different', 'raster-differs', 'missing-in-port', 'action-error', 'unverifiable',
])

/**
 * Explicit nondeterminism masks, keyed `<viewport>/<theme>/<step>`.
 *
 * A mask excludes a rectangular region from the pixel comparison. EVERY mask
 * needs a `reason`, and the comparison reports all of them, because an
 * unexplained mask is exactly how a real visual regression gets hidden. The
 * table is deliberately empty: no assumption is currently being made, and any
 * entry added later appears in the report rather than staying silent.
 */
export const MASKS = {}

/**
 * Validate the comparison options.
 *
 * @param {object} options Comparison options.
 * @throws {Error} When a tolerance is out of range.
 */
export function validateOptions(options) {
  const { rasterTolerance, rasterMaxDelta } = options
  if (typeof rasterTolerance !== 'number' || Number.isNaN(rasterTolerance) || rasterTolerance < 0 || rasterTolerance > 1) {
    throw new Error(`raster tolerance must be a fraction between 0 and 1, got ${JSON.stringify(rasterTolerance)}`)
  }
  if (!Number.isInteger(rasterMaxDelta) || rasterMaxDelta < 0 || rasterMaxDelta > 255) {
    throw new Error(`raster max delta must be an integer 0-255, got ${JSON.stringify(rasterMaxDelta)}`)
  }
}

/**
 * Load one run's trace and index its steps by id.
 *
 * @param {string} dir Capture directory.
 * @returns {Promise<object|null>} Parsed trace view, or null when absent.
 */
export async function loadTrace(dir) {
  const path = join(dir, 'trace.json')
  if (!await exists(path)) return null
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  return {
    identity: parsed.identity,
    host: parsed.host,
    steps: indexSteps(parsed),
    consoleErrors: parsed.consoleErrors ?? [],
  }
}

/** Viewport directories present under a capture root. */
export async function listViewports(root) {
  if (!await exists(root)) return []
  const entries = await readdir(root, { withFileTypes: true })
  return entries.filter(e => e.isDirectory()).map(e => e.name).sort()
}

/**
 * Compare two capture trees.
 *
 * @param {object} options Comparison inputs.
 * @param {string} options.referenceRoot Reference capture tree.
 * @param {string} options.portRoot Port capture tree.
 * @param {number} [options.rasterTolerance] Max differing-pixel ratio for parity.
 * @param {number} [options.rasterMaxDelta] Max per-channel peak delta for parity.
 * @param {object} [options.masks] Per-step nondeterminism masks.
 * @returns {Promise<object>} The comparison report.
 * @throws {Error} When the roots are the same or a tolerance is invalid.
 */
export async function compareTrees(options) {
  const referenceRoot = options.referenceRoot
  const portRoot = options.portRoot
  const rasterTolerance = options.rasterTolerance ?? 0.002
  const rasterMaxDelta = options.rasterMaxDelta ?? 24
  validateOptions({ rasterTolerance, rasterMaxDelta })
  const masks = options.masks ?? MASKS

  // A tree compared with itself always matches and is therefore worthless as
  // parity evidence. Refuse rather than emit a green report.
  if (referenceRoot === portRoot) {
    throw new Error(
      `refusing to compare ${referenceRoot} with itself: identical inputs are trivially identical and prove nothing. `
      + 'Pass a distinct port tree captured from the port under test.',
    )
  }
  for (const [name, root] of [['reference', referenceRoot], ['port', portRoot]]) {
    if (!await exists(root)) throw new Error(`the ${name} tree does not exist: ${root}`)
  }

  const rows = []
  const referenceViewports = await listViewports(referenceRoot)
  const portViewports = await listViewports(portRoot)
  const missingViewports = [
    ...referenceViewports.filter(v => !portViewports.includes(v)).map(v => `${v} (missing in port)`),
    ...portViewports.filter(v => !referenceViewports.includes(v)).map(v => `${v} (missing in reference)`),
  ]

  for (const viewport of referenceViewports) {
    if (!portViewports.includes(viewport)) continue
    for (const theme of ['light', 'dark']) {
      const refDir = join(referenceRoot, viewport, theme)
      const portDir = join(portRoot, viewport, theme)
      const ref = await loadTrace(refDir)
      const port = await loadTrace(portDir)
      const prefix = `${viewport}/${theme}`

      if (ref === null || port === null) {
        const missing = [ref === null ? 'reference trace missing' : null, port === null ? 'port trace missing' : null]
          .filter(Boolean).join('; ')
        rows.push({ id: `${prefix}/*`, verdict: 'unverifiable', differences: ['trace'], note: missing })
        continue
      }

      // Identity must match before any pixel is compared. A different locale,
      // DPI, viewport or harness revision makes the trees incomparable, and
      // reporting "different" would blame the port for a capture difference.
      const identityDiff = diffIdentity(ref.identity, port.identity)
      for (const difference of identityDiff) {
        rows.push({ id: `${prefix}/*`, verdict: 'unverifiable', differences: ['identity'], note: difference })
      }

      const refHost = ref.host?.kind ?? 'unknown'
      const portHost = port.host?.kind ?? 'unknown'

      for (const step of SEQUENCE) {
        const id = `${prefix}/${step.id}`
        const refStep = ref.steps.get(step.id)
        const portStep = port.steps.get(step.id)
        const refImage = join(refDir, `${step.id}.png`)
        const portImage = join(portDir, `${step.id}.png`)

        if (refStep === undefined) {
          rows.push({ id, verdict: 'unverifiable', differences: ['reference-step-missing'] })
          continue
        }
        if (refStep.outcome === 'not-applicable') {
          // Recorded explicitly: an optional action the reference did not
          // perform cannot establish parity and must not be counted as one.
          rows.push({ id, verdict: 'not-applicable', differences: [], note: 'the reference did not exercise this optional action' })
          continue
        }
        if (!await exists(portImage)) {
          rows.push({ id, verdict: 'missing-in-port', differences: ['frame'] })
          continue
        }
        if (refStep.outcome === 'action-error' || portStep?.outcome === 'action-error') {
          rows.push({
            id,
            verdict: 'action-error',
            differences: ['actionError'],
            note: { reference: refStep.actionError ?? null, port: portStep?.actionError ?? null },
          })
          continue
        }
        if (portStep === undefined || portStep.outcome === 'incomplete') {
          rows.push({ id, verdict: 'unverifiable', differences: ['port-step-missing'] })
          continue
        }

        // Expected-surface identity: a step that should have reached a surface
        // must have reached it on BOTH sides, or the comparison is comparing
        // states that are not the same state.
        const expectedSurface = step.expectedPage
        if (expectedSurface !== undefined) {
          const refSurface = refStep.page?.surface
          const portSurface = portStep.page?.surface
          const satisfied = surface => expectedSurface === 'app' ? surface !== 'settings' : surface === expectedSurface
          if (!satisfied(refSurface) || !satisfied(portSurface)) {
            rows.push({
              id,
              verdict: 'different',
              differences: ['surface'],
              note: `expected surface "${expectedSurface}"; reference observed ${JSON.stringify(refSurface)}, port observed ${JSON.stringify(portSurface)}`,
            })
            continue
          }
        }

        const differences = diffFacts(refStep.dom, portStep.dom)

        // Measure the raster instead of assuming it.
        let raster
        try {
          raster = await comparePngFiles(refImage, portImage, { masks: masks[`${prefix}/${step.id}`] ?? [] })
        } catch (error) {
          rows.push({ id, verdict: 'unverifiable', differences: ['raster'], note: String(error).slice(0, 200) })
          continue
        }
        if (!raster.comparable) {
          rows.push({ id, verdict: 'unverifiable', differences: ['raster'], note: raster.reason })
          continue
        }

        // Two independent yardsticks, because either alone can be fooled. An
        // area ratio misses a large localized change in a corner of a big frame
        // (replacing a panel on a 1600x1000 canvas is well under 2% of pixels),
        // while a peak delta alone trips on a single antialiased edge. A frame is
        // parity only when the difference is BOTH small in area AND low in peak.
        const within = raster.differingRatio <= rasterTolerance && raster.maxAbsoluteDelta <= rasterMaxDelta
        const verdictName = differences.length > 0 ? 'different' : (within ? 'identical' : 'raster-differs')

        rows.push({
          id,
          verdict: verdictName,
          differences,
          raster: {
            differingRatio: Number(raster.differingRatio.toFixed(6)),
            differingPixels: raster.differingPixels,
            comparedPixels: raster.comparedPixels,
            maskedPixels: raster.maskedPixels,
            meanAbsoluteDelta: Number(raster.meanAbsoluteDelta.toFixed(4)),
            maxAbsoluteDelta: raster.maxAbsoluteDelta,
            channelTolerance: raster.channelTolerance,
            masks: raster.masks,
          },
          ...(verdictName === 'raster-differs'
            ? {
                note: 'DOM facts match, but the raster differs beyond tolerance: '
                  + `${(raster.differingRatio * 100).toFixed(3)}% of compared pixels (${raster.differingPixels}) `
                  + `exceed the channel tolerance (limit ${(rasterTolerance * 100).toFixed(3)}%), `
                  + `peak delta ${raster.maxAbsoluteDelta} (limit ${rasterMaxDelta})`,
              }
            : {}),
          ...(verdictName === 'identical' && refHost !== portHost
            ? { hostKinds: { reference: refHost, port: portHost } }
            : {}),
        })
      }
    }
  }

  const counts = rows.reduce((acc, row) => {
    acc[row.verdict] = (acc[row.verdict] ?? 0) + 1
    return acc
  }, {})
  const blocking = rows.filter(row => BLOCKING_VERDICTS.has(row.verdict))
  const identityMismatches = rows
    .filter(row => row.differences?.includes('identity'))
    .map(row => `${row.id}: ${row.note}`)

  return {
    generatedAt: new Date().toISOString(),
    referenceRoot,
    portRoot,
    rasterTolerance,
    rasterMaxDelta,
    missingViewports,
    identityMismatches,
    counts,
    totals: {
      compared: rows.length,
      parity: counts.identical ?? 0,
      blocking: blocking.length,
      notApplicable: counts['not-applicable'] ?? 0,
    },
    rows,
  }
}
