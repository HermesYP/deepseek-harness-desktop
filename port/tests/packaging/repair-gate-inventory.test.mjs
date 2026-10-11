import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')

test('both packaging entry points explicitly declare installer-contract and runtime-lock regressions', () => {
  const build = read('../../scripts/build.ps1')
  const gate = read('../run-verification-gate.ps1')
  const buildInventory = build.slice(build.indexOf('function Test-Packaging {'), build.indexOf('Test-Prerequisites\n', build.indexOf('function Test-Packaging {')))
  const gateInventory = gate.slice(gate.indexOf('foreach ($name in @('), gate.indexOf('# UI lane:'))
  for (const name of ['installer-contract.test.mjs', 'runtime-lock-inputs.test.mjs', 'repair-gate-inventory.test.mjs', 'config-editor-runtime-import.test.mjs']) {
    assert.ok(buildInventory.includes(`'${name}'`), `build packaging inventory omits ${name}`)
    assert.ok(gateInventory.includes(`'${name}'`), `all-lane packaging inventory omits ${name}`)
  }
})
