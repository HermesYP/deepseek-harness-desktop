import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const sourceCommit = 'bd4641e1c58928add9f0adddf5e9afe8fbd201ea'
const sourceInputsSHA256 = 'a'.repeat(64)
const artifactSHA256 = 'b'.repeat(64)
const context = { gateId: 'source-contract', evidenceKind: 'source', sourceCommit, sourceInputsSHA256, artifactSHA256: null, requiredChecks: ['receipt-boundary'] }
const receipt = () => ({
  schemaVersion: 1, gateId: 'source-contract', evidenceKind: 'source', result: 'PASS', exitCode: 0,
  sourceCommit, sourceInputsSHA256, artifactSHA256: null,
  startedAt: '2026-10-10T22:06:15+05:30', finishedAt: '2026-10-10T22:06:16+05:30',
  counts: { tests: 1, passed: 1, failed: 0, skipped: 0, ignored: 0 },
  checks: [{ id: 'receipt-boundary', status: 'PASS' }], deliberateSkips: [],
  evidence: [{ path: 'retained/source-contract.stdout.log', sha256: 'c'.repeat(64) }],
})

// Dynamic import keeps the first RED attached to this missing production feature,
// rather than failing test collection or hiding it behind an optional empty glob.
test('a fully witnessed source receipt contributes only its exact source counts', async () => {
  const { validateReceipt } = await import('../scripts/status-receipts.mjs')
  const result = validateReceipt(receipt(), context)
  assert.equal(result.status, 'PASS')
  assert.deepEqual(result.counts, { tests: 1, passed: 1, failed: 0, skipped: 0, ignored: 0 })
  assert.equal(result.artifactSHA256, null)
})

test('source and artifact identities cannot be substituted or inferred', async () => {
  const { validateReceipt } = await import('../scripts/status-receipts.mjs')
  for (const [field, value] of [
    ['sourceCommit', 'd'.repeat(40)], ['sourceInputsSHA256', 'd'.repeat(64)],
    ['gateId', 'other-gate'], ['evidenceKind', 'native'], ['schemaVersion', 2],
  ]) {
    assert.throws(() => validateReceipt({ ...receipt(), [field]: value }, context), /receipt/i, field)
  }
  const nativeContext = { ...context, gateId: 'native-contract', evidenceKind: 'native', artifactSHA256 }
  const nativeReceipt = { ...receipt(), gateId: 'native-contract', evidenceKind: 'native', artifactSHA256 }
  assert.equal(validateReceipt(nativeReceipt, nativeContext).status, 'PASS')
  assert.throws(() => validateReceipt({ ...nativeReceipt, artifactSHA256: 'e'.repeat(64) }, nativeContext), /receipt/i)
  assert.throws(() => validateReceipt({ ...nativeReceipt, artifactSHA256: null }, nativeContext), /receipt/i)
  assert.throws(() => validateReceipt(nativeReceipt, { ...nativeContext, artifactSHA256: null }), /receipt/i)
})

test('a PASS cannot conceal missing checks, boolean counts, failures or skips', async () => {
  const { validateReceipt } = await import('../scripts/status-receipts.mjs')
  const invalid = [
    { ...receipt(), exitCode: true },
    { ...receipt(), exitCode: 1 },
    { ...receipt(), counts: { ...receipt().counts, tests: true } },
    { ...receipt(), counts: { ...receipt().counts, tests: 2 } },
    { ...receipt(), counts: { tests: 1, passed: 0, failed: 0, skipped: 1, ignored: 0 }, deliberateSkips: [{ id: 'native', reason: 'unqualified' }] },
    { ...receipt(), counts: { tests: 1, passed: 0, failed: 0, skipped: 0, ignored: 1 } },
    { ...receipt(), counts: { tests: 1, passed: 0, failed: 1, skipped: 0, ignored: 0 } },
    { ...receipt(), counts: { tests: -1, passed: -1, failed: 0, skipped: 0, ignored: 0 } },
    { ...receipt(), counts: { tests: 0, passed: 0, failed: 0, skipped: 0, ignored: 0 }, checks: [] },
    { ...receipt(), checks: [{ id: 'unrelated', status: 'PASS' }] },
    { ...receipt(), checks: [{ id: 'receipt-boundary', status: 'SKIP' }] },
    { ...receipt(), checks: [{ id: 'receipt-boundary', status: 'PASS' }, { id: 'receipt-boundary', status: 'PASS' }] },
    { ...receipt(), deliberateSkips: [{ id: 'unrun', reason: 'not executed' }] },
    { ...receipt(), evidence: [] },
    { ...receipt(), evidence: [{ path: 'log', sha256: true }] },
    { ...receipt(), startedAt: 'not-a-date' },
    { ...receipt(), finishedAt: '2026-10-10T21:06:16+05:30' },
    { ...receipt(), result: 'probably-pass' },
  ]
  for (const value of invalid) assert.throws(() => validateReceipt(value, context), /receipt/i, JSON.stringify(value))
})

test('status rendering does not promote a missing or skipped receipt', async () => {
  const { renderStatus } = await import('../scripts/status-receipts.mjs')
  const base = { generatedAt: '2026-10-10T22:06:16+05:30', reviewedBaseline: sourceCommit }
  const row = { ...context, title: 'Source checks', scope: 'focused receipt-validator regression only', receipt: receipt() }
  const skipped = { ...receipt(), result: 'SKIP', exitCode: 3, counts: { tests: 1, passed: 0, failed: 0, skipped: 1, ignored: 0 }, checks: [{ id: 'receipt-boundary', status: 'SKIP' }], deliberateSkips: [{ id: 'receipt-boundary', reason: 'not run' }] }
  const output = renderStatus({ ...base, rows: [
    row,
    { ...context, gateId: 'native-unrun', title: 'Native app', scope: 'no matching native image receipt', evidenceKind: 'native', artifactSHA256: null, receipt: null },
    { ...context, gateId: 'updates-settings', title: 'Settings Updates', scope: 'fallback intentional', deferredReason: 'activation deferred', receipt: null },
    { ...row, gateId: 'skipped-fixture', title: 'Skipped fixture', receipt: { ...skipped, gateId: 'skipped-fixture' } },
  ] })
  assert.match(output, /Source checks \| PASS/)
  assert.match(output, /Native app \| UNQUALIFIED/)
  assert.match(output, /Settings Updates \| DEFERRED/)
  assert.match(output, /Skipped fixture \| DEFERRED/)
  assert.match(output, /1 tested; 1 passed; 0 failed; 0 skipped; 0 ignored/)
  assert.throws(() => renderStatus({ ...base, rows: [{ ...row, sourceCommit: 'f'.repeat(40) }] }), /receipt/i)
})

test('duplicate status rows cannot conceal a failing receipt behind the same gate ID', async () => {
  const { renderStatus } = await import('../scripts/status-receipts.mjs')
  const row = { ...context, title: 'Source checks', scope: 'focused', receipt: receipt() }
  assert.throws(() => renderStatus({ generatedAt: receipt().finishedAt, reviewedBaseline: sourceCommit, rows: [row, row] }), /receipt/i)
})

test('the all-lane runner explicitly declares the nonempty receipt contract suite', () => {
  const gate = readFileSync(new URL('./run-verification-gate.ps1', import.meta.url), 'utf8')
  assert.ok(/Id\s*=\s*'node-status-receipts';\s*Dir\s*=\s*\$TestsDir;\s*Pattern\s*=\s*'status-receipts\.test\.mjs';[^\r\n]*MinFiles\s*=\s*1;\s*MinTests\s*=\s*6/.test(gate), 'missing explicit named status suite with nonempty floors')
})
