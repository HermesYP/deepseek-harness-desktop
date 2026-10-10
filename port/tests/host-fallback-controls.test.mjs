/** Pure runner decisions only: no artifact reads, Host launches or process census. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '../../_upstream/node_modules/.pnpm/yaml@2.9.0/node_modules/yaml/dist/index.js'
import { comboRowUrl, PLUGIN_ID } from './helpers/updates-contract.mjs'
import {
  assertMaterializedPath, FALLBACK_PATCH_SHA256, materializedPathChain,
  qualificationPaths, qualifyUpdatesGraph, updatesExpectation,
} from './host-fallback-controls.mjs'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const normal = join(port, 'runtime-payload', 'dsh')
const stage = join(dirname(normal), 'dsh.s-12ab34cd')
const normalInput = () => ({ port, payload: normal, artifact: normal,
  stageIdentityPath: join(stage, 'work', 'runtime-identity.json'),
  nodeIdentityPath: join(stage, 'node-identity.json') })
const documentUrl = 'http://127.0.0.1:41234/app/'
const emptyGraph = () => ({ rev: 'graph-anchor', entries: [], batches: [] })
const referenceGraph = () => ({ rev: 'graph-anchor', entries: [{ id: PLUGIN_ID,
  rev: '012345abcdef', url: comboRowUrl([PLUGIN_ID], '012345abcdef') }],
  batches: [{ phase: 'application', rev: 'fedcba987654', entries: [PLUGIN_ID],
    url: comboRowUrl([PLUGIN_ID], 'fedcba987654') }] })

test('normal lane selects exact read-only root and one caller-selected retained stage', () => {
  const input = normalInput()
  assert.deepEqual(qualificationPaths(input), { lane: 'normal-sealed-read-only', artifact: normal,
    stageIdentityPath: input.stageIdentityPath, nodeIdentityPath: input.nodeIdentityPath })
  // A stage-shaped name selects identity files; it is not build-instance proof.
  assert.equal('freshInstanceId' in qualificationPaths(input), false)
})

test('scratch sealed lane retains the original enclosing identity paths', () => {
  const artifact = join(port, '.scratch', 'rq-reference', 'rt', 'dsh')
  assert.deepEqual(qualificationPaths({ port, payload: artifact, artifact,
    stageIdentityPath: 'ignored-runner-control', nodeIdentityPath: 'ignored-runner-control' }), {
    lane: 'scratch-sealed', artifact,
    stageIdentityPath: join(port, '.scratch', 'rq-reference', 'stage-identity.json'),
    nodeIdentityPath: join(port, '.scratch', 'rq-reference', 'node-identity.json'),
  })
})

for (const [name, change] of [
  ['arbitrary installed root', { artifact: join(port, 'installed', 'dsh'), payload: join(port, 'installed', 'dsh') }],
  ['scratch-prefix lookalike', { artifact: join(port, '.scratch-other', 'dsh'), payload: join(port, '.scratch-other', 'dsh') }],
  ['normal lexical alias', { payload: `${dirname(normal)}${sep}other${sep}..${sep}dsh` }],
  ['relative normal selection', { payload: join('port', 'runtime-payload', 'dsh') }],
  ['external alias into normal', { payload: join(port, 'alias-to-normal') }],
  ['normal realpath escapes', { artifact: join(port, 'elsewhere', 'dsh') }],
  ['normal reparse into scratch is not scratch admission', { artifact: join(port, '.scratch', 'alias-target', 'rt', 'dsh') }],
  ['missing stage control', { stageIdentityPath: undefined }],
  ['missing Node control', { nodeIdentityPath: undefined }],
  ['relative stage control', { stageIdentityPath: 'dsh.s-12ab34cd/work/runtime-identity.json' }],
  ['relative Node control', { nodeIdentityPath: 'dsh.s-12ab34cd/node-identity.json' }],
  ['different Node stage', { nodeIdentityPath: join(dirname(normal), 'dsh.s-87654321', 'node-identity.json') }],
  ['outside stage sibling', { stageIdentityPath: join(port, '.scratch', 'dsh.s-12ab34cd', 'work', 'runtime-identity.json') }],
  ['uppercase stage suffix', { stageIdentityPath: join(dirname(normal), 'dsh.s-12AB34CD', 'work', 'runtime-identity.json') }],
  ['short stage suffix', { stageIdentityPath: join(dirname(normal), 'dsh.s-12ab34c', 'work', 'runtime-identity.json') }],
  ['nonstage sibling', { stageIdentityPath: join(dirname(normal), 'dsh.staging', 'work', 'runtime-identity.json') }],
  ['wrong stage filename', { stageIdentityPath: join(stage, 'work', 'stage-identity.json') }],
  ['wrong Node filename', { nodeIdentityPath: join(stage, 'work', 'node-identity.json') }],
  ['stage identity traversal alias', { stageIdentityPath: `${stage}${sep}work${sep}x${sep}..${sep}runtime-identity.json` }],
  ['Node identity traversal alias', { nodeIdentityPath: `${stage}${sep}x${sep}..${sep}node-identity.json` }],
]) test(`normal path gate rejects ${name}`, () => {
  assert.throws(() => qualificationPaths({ ...normalInput(), ...change }))
})

test('Windows normal lexical casing does not weaken lowercase stage naming', { skip: process.platform !== 'win32' }, () => {
  const input = normalInput()
  const selected = qualificationPaths({ ...input, artifact: normal.toUpperCase(), payload: normal.toUpperCase() })
  assert.equal(selected.lane, 'normal-sealed-read-only')
})

for (const [kind, path] of [['file', join(stage, 'work', 'runtime-identity.json')], ['directory', normal]]) {
  test(`materialized ${kind} evidence positively covers every ancestor through filesystem root`, () => {
    const chain = materializedPathChain(path)
    assert.equal(chain[0], resolve(path))
    assert.equal(dirname(chain.at(-1)), chain.at(-1))
    const observed = []
    assertMaterializedPath(path, kind, candidate => {
      observed.push(candidate)
      return { kind: candidate === resolve(path) ? kind : 'directory', reparse: false, realpath: candidate }
    })
    assert.deepEqual(observed, chain)
  })
}

for (const [name, mutation] of [
  ['reparse leaf', fact => ({ ...fact, reparse: true })],
  ['unverified reparse attributes', fact => ({ ...fact, reparse: undefined })],
  ['nonregular leaf', fact => ({ ...fact, kind: 'other' })],
  ['directory instead of identity file', fact => ({ ...fact, kind: 'directory' })],
  ['escaped leaf realpath', fact => ({ ...fact, realpath: join(port, 'elsewhere', 'runtime-identity.json') })],
  ['missing filesystem fact', () => null],
]) test(`materialized identity gate rejects ${name}`, () => {
  const path = normalInput().stageIdentityPath
  assert.throws(() => assertMaterializedPath(path, 'file', candidate => {
    const fact = { kind: candidate === path ? 'file' : 'directory', reparse: false, realpath: candidate }
    return candidate === path ? mutation(fact) : fact
  }))
})

for (const ancestor of materializedPathChain(normal).slice(1)) {
  test(`materialized path gate rejects reparse at ancestor depth ${materializedPathChain(normal).indexOf(ancestor)}`, () => {
    assert.throws(() => assertMaterializedPath(normal, 'directory', candidate => ({
      kind: 'directory', reparse: candidate === ancestor, realpath: candidate,
    })), /reparse\/unverified/)
  })
}

for (const [name, mutation] of [
  ['non-directory ancestor', fact => ({ ...fact, kind: 'file' })],
  ['ancestor realpath alias', fact => ({ ...fact, realpath: join(port, 'different') })],
  ['ancestor without attributes evidence', fact => ({ ...fact, reparse: undefined })],
]) test(`materialized path gate rejects ${name}`, () => {
  const path = normalInput().nodeIdentityPath
  assert.throws(() => assertMaterializedPath(path, 'file', candidate => {
    const fact = { kind: candidate === path ? 'file' : 'directory', reparse: false, realpath: candidate }
    return candidate === dirname(path) ? mutation(fact) : fact
  }))
})

test('fallback requires both parsed empty sequence semantics and frozen packaged SHA', () => {
  for (const text of ['[]\n', '# comment\n[]\n', '---\n[]\n']) {
    assert.equal(updatesExpectation(parse(text), FALLBACK_PATCH_SHA256), 'absent-by-fallback')
  }
  assert.throws(() => updatesExpectation(parse('[]\n'), '0'.repeat(64)), /unrecognized empty patch/)
  assert.throws(() => updatesExpectation([], undefined), /unrecognized empty patch/)
  for (const text of ['', 'null\n', '{}\n', '"[]"\n']) {
    assert.throws(() => updatesExpectation(parse(text), FALLBACK_PATCH_SHA256), /operations sequence/)
  }
})

test('nonempty packaged reference operations always require enabled Updates', () => {
  const operations = parse('- id: dsh-port-ui-updates\n  name: "@dsh-port/dsh-client-ui-updates"\n')
  assert.equal(updatesExpectation(operations, 'a'.repeat(64)), 'enabled-reference')
  assert.equal(updatesExpectation(operations, FALLBACK_PATCH_SHA256), 'enabled-reference')
  assert.throws(() => qualifyUpdatesGraph(emptyGraph(), updatesExpectation(operations, FALLBACK_PATCH_SHA256), documentUrl), /exact same-origin/)
})

test('fallback graph records absence without a resource request or renderer claim', () => {
  const graph = { rev: 'graph-anchor', entries: [{ id: '@example/other' }],
    batches: [{ entries: ['@example/other'] }] }
  assert.deepEqual(qualifyUpdatesGraph(graph, 'absent-by-fallback', documentUrl), {
    updatesActivation: { expected: 'absent-by-fallback', advertised: false, activationQualified: false }, resource: null,
  })
})

for (const [name, graph] of [
  ['entry advertisement', { ...emptyGraph(), entries: [{ id: PLUGIN_ID }] }],
  ['batch-only advertisement', { ...emptyGraph(), batches: [{ entries: [PLUGIN_ID] }] }],
  ['entry and batch advertisements', referenceGraph()],
]) test(`fallback rejects wrong ${name}`, () => {
  assert.throws(() => qualifyUpdatesGraph(graph, 'absent-by-fallback', documentUrl), /must not advertise/)
})

for (const [name, graph] of [
  ['missing graph revision', { entries: [], batches: [] }],
  ['missing entries', { rev: 'graph-anchor', batches: [] }],
  ['missing batches', { rev: 'graph-anchor', entries: [] }],
  ['invented rows API', { rev: 'graph-anchor', rows: [], batches: [] }],
  ['null entry', { ...emptyGraph(), entries: [null] }],
  ['missing entry id', { ...emptyGraph(), entries: [{}] }],
  ['null batch', { ...emptyGraph(), batches: [null] }],
  ['missing batch ids', { ...emptyGraph(), batches: [{}] }],
  ['string batch ids', { ...emptyGraph(), batches: [{ entries: PLUGIN_ID }] }],
  ['object batch ids', { ...emptyGraph(), batches: [{ entries: [{ id: PLUGIN_ID }] }] }],
]) test(`graph gate rejects ${name} instead of assuming absence`, () => {
  assert.throws(() => qualifyUpdatesGraph(graph, 'absent-by-fallback', documentUrl))
})

test('reference graph selects actual entry revision, never graph or batch revision', () => {
  const graph = referenceGraph()
  const result = qualifyUpdatesGraph(graph, 'enabled-reference', documentUrl)
  assert.deepEqual(result.updatesActivation, { expected: 'enabled-reference', advertised: true, activationQualified: false })
  assert.equal(result.resource.requestUrl, new URL(comboRowUrl([PLUGIN_ID], graph.entries[0].rev), documentUrl).href)
  assert.equal(new URL(result.resource.requestUrl).searchParams.get('rev'), '012345abcdef')
  assert.notEqual(graph.entries[0].rev, graph.rev)
  assert.notEqual(graph.entries[0].rev, graph.batches[0].rev)
})

for (const [name, change] of [
  ['no advertised entry', graph => { graph.entries = [] }],
  ['missing entry revision', graph => { delete graph.entries[0].rev }],
  ['empty entry revision', graph => { graph.entries[0].rev = '' }],
  ['missing entry URL', graph => { delete graph.entries[0].url }],
  ['graph-revision URL', graph => { graph.entries[0].url = comboRowUrl([PLUGIN_ID], graph.rev) }],
  ['batch-revision URL', graph => { graph.entries[0].url = comboRowUrl([PLUGIN_ID], graph.batches[0].rev) }],
  ['cross-origin URL', graph => { graph.entries[0].url = `http://example.invalid/${comboRowUrl([PLUGIN_ID], graph.entries[0].rev)}` }],
  ['malformed URL', graph => { graph.entries[0].url = 'http://[' }],
]) test(`enabled reference rejects ${name}`, () => {
  const graph = referenceGraph()
  change(graph)
  assert.throws(() => qualifyUpdatesGraph(graph, 'enabled-reference', documentUrl), /exact same-origin/)
})

test('arbitrary bypass expectation cannot authorize absent Updates', () => {
  for (const expected of ['skip', 'disabled', true, undefined]) {
    assert.throws(() => qualifyUpdatesGraph(emptyGraph(), expected, documentUrl), /packaged composition/)
  }
})
