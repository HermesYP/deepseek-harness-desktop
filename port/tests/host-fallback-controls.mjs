/** Pure qualification decisions; no payload I/O, process queries or launches. */
import assert from 'node:assert/strict'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { decideUpdatesResource, PLUGIN_ID } from './helpers/updates-contract.mjs'

export const FALLBACK_PATCH_SHA256 = '60a1b04578fede8558133d3c3eeb62cbcbc611266cff0733cb09b02fe7074c6c'
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value

/** Select only the existing scratch lane or the exact published normal root. */
export function qualificationPaths({ port, payload, artifact, stageIdentityPath, nodeIdentityPath }) {
  const normal = join(port, 'runtime-payload', 'dsh')
  const normalRequested = typeof payload === 'string' && fold(payload) === fold(normal)
  if (!normalRequested && fold(artifact).startsWith(fold(join(port, '.scratch') + sep))) {
    const qualification = dirname(dirname(artifact))
    return { lane: 'scratch-sealed', artifact, stageIdentityPath: join(qualification, 'stage-identity.json'),
      nodeIdentityPath: join(qualification, 'node-identity.json') }
  }
  assert.equal(fold(artifact), fold(normal), 'artifact must be scratch-owned or the exact normal payload root')
  assert.ok(typeof payload === 'string' && isAbsolute(payload), 'normal payload requires an absolute lexical path')
  assert.equal(fold(payload), fold(normal), 'normal payload must not be selected through an arbitrary alias')
  for (const path of [stageIdentityPath, nodeIdentityPath]) {
    assert.ok(typeof path === 'string' && isAbsolute(path), 'normal payload requires explicit absolute stage and Node identity paths')
  }
  const stage = dirname(dirname(resolve(stageIdentityPath)))
  assert.equal(fold(dirname(stage)), fold(dirname(normal)), 'normal stage must be a direct sibling of the published payload')
  assert.match(basename(stage), /^dsh\.s-[0-9a-f]{8}$/u, 'normal stage must retain its fresh UUID-short name')
  assert.equal(fold(stageIdentityPath), fold(join(stage, 'work', 'runtime-identity.json')), 'stage identity must be exactly work/runtime-identity.json without aliases')
  assert.equal(fold(nodeIdentityPath), fold(join(stage, 'node-identity.json')), 'Node identity must belong to the same normal stage without aliases')
  return { lane: 'normal-sealed-read-only', artifact, stageIdentityPath: resolve(stageIdentityPath), nodeIdentityPath: resolve(nodeIdentityPath) }
}

/** Include every ancestor through the filesystem root, not just the leaf. */
export function materializedPathChain(path) {
  const paths = []
  for (let current = resolve(path); ; current = dirname(current)) {
    paths.push(current)
    if (dirname(current) === current) return paths
  }
}

/** Require positive regular-file/directory and non-reparse evidence at every level. */
export function assertMaterializedPath(path, kind, inspect) {
  for (const [index, candidate] of materializedPathChain(path).entries()) {
    const fact = inspect(candidate)
    assert.ok(fact && fact.reparse === false, 'qualification path or ancestor is reparse/unverified')
    assert.equal(fact.kind, index === 0 ? kind : 'directory', 'qualification path must be a regular file/directory with directory ancestors')
    assert.equal(fold(fact.realpath), fold(candidate), 'qualification path must not escape through an alias')
  }
}

/** An empty parsed YAML sequence is fallback only for the explicitly frozen patch. */
export function updatesExpectation(patch, patchSha256) {
  assert.ok(Array.isArray(patch), 'packaged desktop patch must parse as a YAML operations sequence')
  if (patch.length !== 0) return 'enabled-reference'
  assert.equal(patchSha256, FALLBACK_PATCH_SHA256, 'unrecognized empty patch cannot authorize absent Updates')
  return 'absent-by-fallback'
}

/** Fallback forbids all Updates advertisements; enabled mode retains exact entry-revision selection. */
export function qualifyUpdatesGraph(graph, expected, documentUrl) {
  assert.ok(graph && typeof graph === 'object' && typeof graph.rev === 'string' && graph.rev.trim() !== ''
    && Array.isArray(graph.entries) && Array.isArray(graph.batches), 'Host must advertise a complete boot graph')
  assert.ok(graph.entries.every(entry => entry && typeof entry.id === 'string' && entry.id.trim() !== ''), 'boot entries must have package ids')
  assert.ok(graph.batches.every(batch => batch && Array.isArray(batch.entries)
    && batch.entries.every(id => typeof id === 'string' && id.trim() !== '')), 'boot batches must list package ids')
  assert.ok(['enabled-reference', 'absent-by-fallback'].includes(expected), 'Updates expectation must come from packaged composition')
  const advertised = graph.entries.some(entry => entry.id === PLUGIN_ID)
    || graph.batches.some(batch => batch.entries.includes(PLUGIN_ID))
  if (expected === 'absent-by-fallback') {
    assert.equal(advertised, false, 'no-op fallback must not advertise an Updates entry or batch')
    return { updatesActivation: { expected, advertised: false, activationQualified: false }, resource: null }
  }
  const resource = decideUpdatesResource(graph, documentUrl)
  assert.ok(resource.requestUrl, 'Updates must advertise its exact same-origin entry-revision resource')
  return { updatesActivation: { expected, advertised: true, activationQualified: false }, resource }
}
