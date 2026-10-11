// Receipt validation is an acceptance boundary, not a proof that a feature works.
// Callers must supply the exact intended source, artifact and evidence scope.
const kinds = new Set(['source', 'ui-build', 'host', 'native', 'installer-contract', 'installed-release'])
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const commit = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
function requireReceipt(condition, message) {
  if (!condition) throw new Error(`Invalid qualification receipt: ${message}`)
}

export function validateReceipt(receipt, context) {
  requireReceipt(receipt !== null && typeof receipt === 'object' && !Array.isArray(receipt), 'object required')
  requireReceipt(context !== null && typeof context === 'object' && !Array.isArray(context), 'explicit context required')
  requireReceipt(receipt.schemaVersion === 1, 'unsupported schemaVersion')
  requireReceipt(commit(context.sourceCommit) && receipt.sourceCommit === context.sourceCommit, 'sourceCommit mismatch')
  requireReceipt(hash(context.sourceInputsSHA256) && receipt.sourceInputsSHA256 === context.sourceInputsSHA256, 'source input digest mismatch')
  requireReceipt(typeof context.gateId === 'string' && context.gateId.length > 0 && receipt.gateId === context.gateId, 'gateId mismatch')
  requireReceipt(kinds.has(context.evidenceKind) && receipt.evidenceKind === context.evidenceKind, 'evidence kind mismatch')
  requireReceipt(context.artifactSHA256 === null || hash(context.artifactSHA256), 'expected artifact identity malformed or absent')
  requireReceipt(receipt.artifactSHA256 === context.artifactSHA256, 'artifact identity mismatch')
  requireReceipt(context.evidenceKind === 'source' || hash(context.artifactSHA256), 'artifact identity required for executable/build acceptance')
  const fields = new Set(['schemaVersion', 'gateId', 'evidenceKind', 'result', 'exitCode', 'sourceCommit', 'sourceInputsSHA256', 'artifactSHA256', 'startedAt', 'finishedAt', 'counts', 'checks', 'deliberateSkips', 'evidence'])
  requireReceipt(Object.keys(receipt).every(key => fields.has(key)), 'unknown schema field')
  requireReceipt(['PASS', 'FAIL', 'SKIP', 'REFUSED'].includes(receipt.result), 'unknown result')
  requireReceipt(Number.isSafeInteger(receipt.exitCode), 'numeric integer exitCode required')
  const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value))
  requireReceipt(timestamp(receipt.startedAt) && timestamp(receipt.finishedAt) && Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt), 'invalid execution interval')
  const countNames = ['tests', 'passed', 'failed', 'skipped', 'ignored']
  const counts = receipt.counts
  requireReceipt(counts !== null && typeof counts === 'object' && !Array.isArray(counts), 'counts object required')
  requireReceipt(Object.keys(counts).length === countNames.length && countNames.every(name => Number.isSafeInteger(counts[name]) && counts[name] >= 0), 'exact nonnegative integer counts required')
  requireReceipt(counts.tests === counts.passed + counts.failed + counts.skipped + counts.ignored, 'test accounting mismatch')
  requireReceipt(Array.isArray(context.requiredChecks) && context.requiredChecks.length > 0 && context.requiredChecks.every(id => typeof id === 'string' && id.length > 0), 'explicit required check IDs required')
  requireReceipt(new Set(context.requiredChecks).size === context.requiredChecks.length, 'duplicate required checks')
  requireReceipt(Array.isArray(receipt.checks) && receipt.checks.length > 0 && receipt.checks.every(check => check && typeof check.id === 'string' && check.id.length > 0 && ['PASS', 'FAIL', 'SKIP', 'REFUSED'].includes(check.status)), 'measured checks required')
  requireReceipt(new Set(receipt.checks.map(check => check.id)).size === receipt.checks.length, 'duplicate measured check')
  requireReceipt(context.requiredChecks.every(id => receipt.checks.some(check => check.id === id)), 'missing required feature check')
  requireReceipt(Array.isArray(receipt.deliberateSkips) && receipt.deliberateSkips.every(skip => skip && typeof skip.id === 'string' && skip.id.length > 0 && typeof skip.reason === 'string' && skip.reason.length > 0), 'skip accounting required')
  requireReceipt(Array.isArray(receipt.evidence) && receipt.evidence.length > 0 && receipt.evidence.every(item => item && typeof item.path === 'string' && item.path.trim().length > 0 && !/[\x00-\x1f]/.test(item.path) && hash(item.sha256)), 'hashed retained evidence required')
  if (receipt.result === 'PASS') {
    requireReceipt(receipt.exitCode === 0 && counts.failed === 0 && counts.skipped === 0 && counts.ignored === 0 && receipt.deliberateSkips.length === 0 && receipt.checks.every(check => check.status === 'PASS'), 'PASS contains failure, refusal or unexecuted checks')
  }
  return {
    status: receipt.result,
    gateId: context.gateId,
    evidenceKind: receipt.evidenceKind,
    sourceCommit: receipt.sourceCommit,
    sourceInputsSHA256: receipt.sourceInputsSHA256,
    artifactSHA256: receipt.artifactSHA256,
    counts: structuredClone(receipt.counts),
    evidence: structuredClone(receipt.evidence),
  }
}

const cell = value => String(value ?? 'not recorded').replace(/\|/g, '\\|').replace(/[\r\n]/g, ' ')

export function renderStatus(input) {
  requireReceipt(input && commit(input.reviewedBaseline), 'reviewed baseline required')
  requireReceipt(typeof input.generatedAt === 'string' && Number.isFinite(Date.parse(input.generatedAt)), 'report date required')
  requireReceipt(Array.isArray(input.rows) && input.rows.length > 0, 'explicit status rows required')
  requireReceipt(input.rows.every(row => row && typeof row.gateId === 'string' && row.gateId.length > 0) && new Set(input.rows.map(row => row.gateId)).size === input.rows.length, 'duplicate or missing status gate IDs')
  const lines = [
    '# Current Windows port status', '',
    `Reviewed baseline: \`${input.reviewedBaseline}\`.`,
    `Report generated: ${cell(input.generatedAt)} (IST dates are recorded in receipts).`, '',
    'A source check, compiled fixture or historical image cannot qualify a different artifact or installed behavior. Missing receipts stay UNQUALIFIED; deliberately skipped work stays DEFERRED. No production update delivery or release publication is accepted here.', '',
    '| Gate | Status | Source commit | Artifact SHA-256 | Date | Scope / measured counts | Deliberate skips / evidence |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const row of input.rows) {
    requireReceipt(row && typeof row.title === 'string' && typeof row.scope === 'string', 'row title and scope required')
    requireReceipt(row.sourceCommit === null || commit(row.sourceCommit), 'row source commit malformed')
    requireReceipt(row.artifactSHA256 === null || hash(row.artifactSHA256), 'row artifact malformed')
    let status = row.deferredReason ? 'DEFERRED' : 'UNQUALIFIED'
    let counts = 'no matched execution receipt'
    let evidence = row.deferredReason ?? 'no matched receipt; current gate open'
    let date = input.generatedAt
    if (row.receipt !== null && row.receipt !== undefined) {
      const accepted = validateReceipt(row.receipt, row)
      status = { PASS: 'PASS', FAIL: 'FAIL', SKIP: 'DEFERRED', REFUSED: 'FAIL' }[accepted.status]
      const n = accepted.counts
      counts = `${n.tests} tested; ${n.passed} passed; ${n.failed} failed; ${n.skipped} skipped; ${n.ignored} ignored`
      date = row.receipt.finishedAt
      evidence = row.receipt.deliberateSkips.map(skip => `${skip.id}: ${skip.reason}`).concat(accepted.evidence.map(item => `${item.path} (SHA-256 ${item.sha256})`)).join('; ')
    }
    lines.push(`| ${cell(row.title)} | ${status} | ${cell(row.sourceCommit)} | ${cell(row.artifactSHA256)} | ${cell(date)} | ${cell(row.scope)}; ${counts} | ${cell(evidence)} |`)
  }
  lines.push('', 'Counts above come only from schema- and identity-validated structured receipts; overlapping suites are not summed. A receipt must name all required feature checks. A PASS containing ignored/skipped tests, missing checks, a nonzero exit, or mismatched source/artifact identities is rejected.', '',
    'Current work: [repair checkpoint](docs/repair-checkpoint-2026-10-10.md) and [implementation plan](docs/port-fix-plan-2026-10-10.md).',
    'History: [review checkpoint](docs/commit-review-2026-10-10.md), [earlier repair ledger](docs/repair-ledger-2026-10-10.md), and [verification report](docs/verification-report.md). These remain evidence only for their recorded sources/images.', '',
    'Native guest admission remains disabled. The Settings Updates section is deferred; the functioning application-menu update route and More > Settings fallback remain intentional. Exact release installation, upgrade and uninstall without system Node require a separate non-overlapping production-identity environment.', '')
  return lines.join('\n')
}
