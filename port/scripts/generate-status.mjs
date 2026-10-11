// Usage: pinned-node port/scripts/generate-status.mjs docs/current-status.json
// Output is stdout only: malformed input never overwrites the current report.
import { readFileSync } from 'node:fs'
import { renderStatus } from './status-receipts.mjs'

if (process.argv.length !== 3) throw new Error('Usage: generate-status.mjs <structured-status-input.json>')
const input = JSON.parse(readFileSync(process.argv[2], 'utf8'))
process.stdout.write(renderStatus(input))
