/**
 * Fixture-owned launch barrier — **TEST INFRASTRUCTURE, never shipped**.
 *
 * WHY THIS EXISTS. `adapter-launch.integration.test.mjs` must sample a Host's
 * process tree *while it is alive*: the post-teardown verdict in
 * `helpers/process-authority.mjs` is `not-verified` for any Host without a live
 * sample, because an intermediary that has exited hides everything below it in
 * the final table. The argument-validation launches
 * (`missing-runtime`, `relative-runtime`, `missing-project`,
 * `whitespace-primary`, the no-control launch, and the missing-primary-metadata
 * launch) exit in a few hundred milliseconds — faster than one spawn-time
 * identity read plus one process-table read — so the tree could never be
 * sampled.
 *
 * WHAT IT IS. A wrapper that starts the **real adapter, from its actual bytes,
 * with the configured interpreter** as its direct child, forwards stdio
 * verbatim, records the exact command and argv it launched, and exits with the
 * Host's exit code. It holds its own process open for `barrierMs` so the fixture
 * has a live tree to sample, and exits immediately once the Host has outlived
 * the barrier window (so a long-lived launch pays no delay).
 *
 * WHAT IT IS NOT. It is not part of the product, and a barrier-mediated launch
 * is **fixture mediation, not production launch acceptance**. The lane records
 * the wrapper, its digest, the argv attestation and this limitation verbatim.
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'

const [command, ...args] = process.argv.slice(2)
if (typeof command !== 'string' || command === '') {
  console.error('dsh fixture launch barrier: a command is required')
  process.exit(2)
}
const requested = Number(process.env.DSH_FIXTURE_LAUNCH_BARRIER_MS)
const barrierMs = Number.isFinite(requested) && requested >= 0 ? requested : 0
const recordPath = process.env.DSH_FIXTURE_LAUNCH_RECORD
const begun = Date.now()

const record = {
  scheme: 'dsh-fixture-launch-barrier/1',
  barrierPid: process.pid,
  command,
  args,
  childPid: null,
  barrierMs,
  startedAtUtc: new Date().toISOString(),
  exit: null,
}

function attest() {
  if (typeof recordPath !== 'string' || recordPath === '') return
  try { writeFileSync(recordPath, JSON.stringify(record, null, 2)) } catch { /* attestation only */ }
}

attest()
const child = spawn(command, args, { stdio: 'inherit', windowsHide: true })
record.childPid = child.pid ?? null
attest()

child.on('error', (error) => {
  record.exit = { code: null, signal: null, error: String(error?.message ?? error) }
  attest()
  process.exit(70)
})

child.on('exit', (code, signal) => {
  record.exit = { code: code === null ? null : code, signal: signal ?? null }
  attest()
  // Hold the tree open only for the remainder of the barrier window: a Host that
  // outlived the window is sampled already and pays nothing here.
  const remaining = Math.max(0, barrierMs - (Date.now() - begun))
  const forwarded = code === null ? 1 : code
  if (remaining === 0) process.exit(forwarded)
  setTimeout(() => process.exit(forwarded), remaining)
})
