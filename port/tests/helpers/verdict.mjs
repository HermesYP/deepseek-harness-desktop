/**
 * Shared verdict and identity primitives for the parity gates (lane V).
 *
 * WHY THIS EXISTS: the gate scripts this replaces could not fail. They recorded
 * findings into a JSON report and then exited 0, they compared a capture tree
 * against ITSELF (`--reference` == `--port`, which yields "identical" for every
 * frame and proves nothing), they indexed a trace array by POSITION although the
 * harness pushes one entry per action error PLUS one per step (24 entries for 19
 * steps, so every comparison after the first error paired the wrong steps), and
 * they accepted a missing selector, a wrong attached page and a swallowed click
 * as success. A verdict object that cannot express "not verified" is not a
 * verdict.
 *
 * The rules encoded here:
 *   1. A check is one of PASS / FAIL / SKIP. SKIP never satisfies a required
 *      check, and a run with zero executed checks fails.
 *   2. Every artifact records the environment and fixture identity it was
 *      produced under, so two trees can be proven comparable before they are
 *      compared.
 *   3. Comparing a tree with itself is refused: it always passes and is
 *      therefore worthless as parity evidence.
 *   4. Anything the caller expected to observe and did not observe is a FAIL,
 *      not a note.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

/** Status of one individually reported check. */
export const PASS = 'PASS'
export const FAIL = 'FAIL'
export const SKIP = 'SKIP'

/**
 * Collects named checks and computes an exit code.
 *
 * `required` checks must PASS: an SKIP on a required check is a failure of the
 * run, because the check the caller asked for did not happen. Optional checks
 * may SKIP without failing the run.
 */
export class Verdict {
  /** @param {string} title Human-readable name of the gate being run. */
  constructor(title) {
    this.title = title
    this.checks = []
    this.notes = []
  }

  /**
   * Record one check result.
   *
   * @param {string} name Check name, printed verbatim.
   * @param {string} status One of PASS / FAIL / SKIP.
   * @param {object} [options] Optional detail and severity.
   * @param {string} [options.detail] Evidence or the reason for the status.
   * @param {boolean} [options.required] True when the run cannot pass without it.
   * @returns {object} The recorded check.
   */
  record(name, status, options = {}) {
    const check = {
      name,
      status,
      required: options.required !== false,
      ...(options.detail === undefined ? {} : { detail: options.detail }),
    }
    this.checks.push(check)
    const mark = status === PASS ? 'PASS' : status === SKIP ? 'SKIP' : 'FAIL'
    const suffix = check.detail === undefined ? '' : ` - ${check.detail}`
    console.log(`  [${mark}] ${name}${suffix}`)
    return check
  }

  /** Record a passing check. */
  ok(name, detail) { return this.record(name, PASS, { detail }) }

  /** Record a failing check. */
  fail(name, detail) { return this.record(name, FAIL, { detail }) }

  /**
   * Assert a condition, recording PASS when true and FAIL when false.
   *
   * @param {boolean} condition The condition under test.
   * @param {string} name Check name.
   * @param {string} [detail] Evidence printed either way.
   */
  assert(condition, name, detail) {
    return condition ? this.ok(name, detail) : this.fail(name, detail)
  }

  /** Record an optional check that could not be exercised. */
  skip(name, detail) { return this.record(name, SKIP, { detail }) }

  /** Add context that is not itself a check. */
  note(message) { this.notes.push(message) }

  /** Failing checks, including required checks that skipped. */
  get failures() {
    return this.checks.filter(c => c.status === FAIL || (c.required && c.status === SKIP))
  }

  /** Counts per status. */
  get counts() {
    return this.checks.reduce((acc, c) => {
      acc[c.status] = (acc[c.status] ?? 0) + 1
      return acc
    }, {})
  }

  /**
   * Print the summary and set the process exit code.
   *
   * A run that recorded no checks at all is itself a failure: a gate that
   * verified nothing must never report success.
   *
   * @returns {number} The exit code that was set.
   */
  finish() {
    const counts = this.counts
    console.log(`\n${this.title}: ${counts.PASS ?? 0} PASS, ${counts.FAIL ?? 0} FAIL, ${counts.SKIP ?? 0} SKIP`)
    if (this.checks.length === 0) {
      console.error(`RESULT: FAIL - ${this.title} executed no checks; a gate that verifies nothing cannot pass.`)
      process.exitCode = 1
      return 1
    }
    const failures = this.failures
    if (failures.length > 0) {
      console.error(`RESULT: FAIL - ${this.title} did not satisfy ${failures.length} required check(s):`)
      for (const failure of failures) {
        const reason = failure.status === SKIP
          ? `SKIPPED (required): ${failure.detail ?? 'not exercised'}`
          : (failure.detail ?? 'no detail')
        console.error(`  - ${failure.name}: ${reason}`)
      }
      process.exitCode = 1
      return 1
    }
    console.log(`RESULT: PASS - ${this.title} satisfied every required check.`)
    return 0
  }
}

/**
 * Fail fast with a usage error. Exit code 2 distinguishes "the gate was not
 * given what it needs to run honestly" from "the product under test failed".
 *
 * @param {string} message The problem to report.
 * @returns {never} Always exits.
 */
export function usageError(message) {
  console.error(`${message}`)
  process.exit(2)
}

/** True when the path exists. */
export async function exists(path) {
  try { await stat(path); return true } catch { return false }
}

/**
 * SHA-256 of a file's bytes, or null when the file is absent.
 *
 * @param {string} path File to hash.
 * @returns {Promise<string|null>} Hex digest, or null when absent.
 */
export async function hashFile(path) {
  if (!await exists(path)) return null
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/** SHA-256 of a string. */
export function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/**
 * The capture-harness parameters that must be identical on both sides of a
 * comparison. Two trees may only be compared when these match exactly: a
 * different viewport, theme, locale, DPI or fixture produces different pixels
 * for reasons that have nothing to do with port parity.
 */
export const IDENTITY_FIELDS = [
  'viewport',
  'theme',
  'baseUrl',
  'locale',
  'timezoneId',
  'deviceScaleFactor',
  'capturedWith',
  'hostKind',
  'appVersion',
  'graphRevision',
]

/**
 * Compare two capture identities field by field.
 *
 * @param {object|undefined} left The reference identity.
 * @param {object|undefined} right The port identity.
 * @returns {string[]} Names of fields that differ or are missing.
 */
export function diffIdentity(left, right) {
  const differences = []
  for (const field of IDENTITY_FIELDS) {
    const a = JSON.stringify(left?.[field] ?? null)
    const b = JSON.stringify(right?.[field] ?? null)
    if (a !== b) differences.push(`${field}: reference=${a} port=${b}`)
  }
  return differences
}

/**
 * Exit code helper: fail when a value is not a usable non-empty string.
 *
 * @param {unknown} value Value to inspect.
 * @returns {boolean} True when the value is a non-empty, non-whitespace string.
 */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}
