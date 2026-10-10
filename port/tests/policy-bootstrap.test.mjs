/** Shared producer/consumer fixtures for packaged mandatory-policy inputs. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { createPolicyBootstrap } from '../ui/shell/policy-bootstrap.mjs'

const configured = JSON.parse(readFileSync(new URL('../src-tauri/app/tests/fixtures/policy-bootstrap-configured.json', import.meta.url), 'utf8'))

test('the actual UI define supplies the client version, independently of package versions', () => {
  assert.deepEqual(createPolicyBootstrap({
    version: '9.9.9',
    dshMandatoryUpdatePolicy: configured.dshMandatoryUpdatePolicy,
    unrelatedPrivateData: 'must not be copied',
  }, { 'process.env.DSH_CLIENT_VERSION': JSON.stringify(configured.clientVersion) }), configured)
})

test('an absent policy and an unset UI version remain explicitly unconfigured', () => {
  assert.deepEqual(createPolicyBootstrap({ version: '9.9.9' }, {}), { schemaVersion: 1, clientVersion: null })
})

test('present invalid policy values survive staging for native rejection rather than becoming absence', () => {
  for (const value of [null, false, '', [], { origin: 'http://invalid.example.test' }]) {
    const bootstrap = createPolicyBootstrap({ dshMandatoryUpdatePolicy: value }, {})
    assert.ok(Object.hasOwn(bootstrap, 'dshMandatoryUpdatePolicy'))
    assert.deepEqual(bootstrap.dshMandatoryUpdatePolicy, value)
  }
})

test('only an own application-package policy field is staged', () => {
  const applicationPackage = Object.create({ dshMandatoryUpdatePolicy: configured.dshMandatoryUpdatePolicy })
  assert.ok(!Object.hasOwn(createPolicyBootstrap(applicationPackage, {}), 'dshMandatoryUpdatePolicy'))
})

test('invalid application package JSON is rejected', () => {
  for (const value of [null, [], 'package', 4]) {
    assert.throws(() => createPolicyBootstrap(value, {}), /application package/)
  }
})

test('invalid UI define encodings cannot silently supply another version', () => {
  for (const value of ['undefined', 'null', '123', '{}']) {
    assert.throws(() => createPolicyBootstrap({}, { 'process.env.DSH_CLIENT_VERSION': value }))
  }
  assert.equal(createPolicyBootstrap({}, { 'process.env.DSH_CLIENT_VERSION': '""' }).clientVersion, '')
})
