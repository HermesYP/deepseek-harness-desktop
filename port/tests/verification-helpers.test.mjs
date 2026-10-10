/**
 * Fixture-level negative tests for the parity gates (lane V).
 *
 * Run with the ordinary test runner, on either supported interpreter:
 *   node --test port/tests/verification-helpers.test.mjs      (Node 22.20.0 or 25.4.0)
 * or, for the whole top-level suite:
 *   npm --prefix port/ui run test:verification
 *
 * Do NOT add `--test-isolation=none` here. That flag is not a supported option
 * of the port's pinned build interpreter (22.20.0 rejects it as an unknown
 * option, exit 9), and the ordinary runner is what a supported Node 22 build
 * interpreter must be able to execute. The tests need no process-level
 * isolation: they drive pure decision functions, the PNG decoder and
 * fixture-owned temporary directories directly.
 *
 * WHY THESE EXIST: the gates they cover are the ones that decide whether the
 * port has reached parity, so a gate that cannot fail silently converts every
 * release claim into an unfalsifiable one. These tests need no GUI, no browser
 * and no running application: they drive the pure decision logic and the PNG
 * decoder directly, and every test asserts the FAILURE mode, not the happy path.
 *
 * Each test names the concrete false-green it prevents.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'

import { Verdict, PASS, FAIL, SKIP, diffIdentity, hashText } from './helpers/verdict.mjs'
import { SEQUENCE, STEP_IDS, indexSteps, diffFacts, normalizeFact } from './helpers/capture-sequence.mjs'
import { decodePng, compareRasters, comparePngFiles } from './helpers/raster.mjs'
import { classifyHost, NATIVE_WEBVIEW, CHROMIUM_PROBE, assertNotLiveGui, assertIsolatedHome } from './helpers/host-identity.mjs'
import { comboRowUrl, decideUpdatesResource, classifyUpdatesArtifact, classifyUpdatesSection, PLUGIN_ID } from './helpers/updates-contract.mjs'

/** Capture one Verdict's console output instead of printing it during tests. */
function silently(fn) {
  const originalLog = console.log
  const originalError = console.error
  console.log = () => {}
  console.error = () => {}
  const savedExit = process.exitCode
  try {
    return fn()
  } finally {
    console.log = originalLog
    console.error = originalError
    process.exitCode = savedExit
  }
}

// ---------------------------------------------------------------------------
// Verdict: a gate that verifies nothing, or skipped what it required, fails.
// ---------------------------------------------------------------------------

test('a Verdict that recorded no checks fails rather than passing vacuously', () => {
  const verdict = new Verdict('empty gate')
  const code = silently(() => verdict.finish())
  assert.equal(code, 1, 'an empty gate must not report success')
})

test('a required check that SKIPs fails the run', () => {
  const verdict = new Verdict('skip gate')
  verdict.skip('the native webview was driven', 'no CDP endpoint')
  const code = silently(() => verdict.finish())
  assert.equal(code, 1, 'a required check that did not happen is not a pass')
  assert.equal(verdict.failures.length, 1)
})

test('an optional check that SKIPs does not fail the run', () => {
  const verdict = new Verdict('optional gate')
  verdict.record('legitimately absent on this path', SKIP, { detail: 'expected', required: false })
  verdict.ok('something real was checked')
  const code = silently(() => verdict.finish())
  assert.equal(code, 0)
  assert.equal(verdict.failures.length, 0)
})

test('a single FAIL fails the run even when everything else passed', () => {
  const verdict = new Verdict('mixed gate')
  verdict.ok('a')
  verdict.ok('b')
  verdict.fail('c', 'the real defect')
  const code = silently(() => verdict.finish())
  assert.equal(code, 1)
})

// ---------------------------------------------------------------------------
// Identity: two capture trees may only be compared when they are comparable.
// ---------------------------------------------------------------------------

test('a capture identity difference is detected field by field', () => {
  const shared = {
    viewport: 'desktop-1280x800', theme: 'light', baseUrl: 'http://127.0.0.1:3085',
    locale: 'en-US', timezoneId: 'Asia/Shanghai', deviceScaleFactor: 1,
    capturedWith: 'capture-reference.mjs/reference-web', hostKind: NATIVE_WEBVIEW,
    appVersion: '0.1.7-rc.2', graphRevision: 'abc',
  }
  assert.deepEqual(diffIdentity(shared, { ...shared }), [])

  // Same page, different device scale factor: the pixels are not comparable.
  const dpi = diffIdentity(shared, { ...shared, deviceScaleFactor: 2 })
  assert.equal(dpi.length, 1)
  assert.match(dpi[0], /deviceScaleFactor/u)

  // A missing identity entirely must not read as "identical".
  assert.ok(diffIdentity(shared, undefined).length > 0)
})

test('a native webview capture and a plain Chromium capture are not the same host', () => {
  const shared = {
    viewport: 'desktop-1280x800', theme: 'light', baseUrl: 'http://127.0.0.1:3085',
    locale: 'en-US', timezoneId: 'Asia/Shanghai', deviceScaleFactor: 1,
    capturedWith: 'capture-reference.mjs/port-webview', hostKind: NATIVE_WEBVIEW,
    appVersion: '0.1.7-rc.2', graphRevision: 'abc',
  }
  const differences = diffIdentity(shared, { ...shared, hostKind: CHROMIUM_PROBE })
  assert.equal(differences.length, 1)
  assert.match(differences[0], /hostKind/u)
})

// ---------------------------------------------------------------------------
// Trace indexing: the exact bug that paired the wrong steps.
// ---------------------------------------------------------------------------

test('an action error plus a state entry for one step merge into one record', () => {
  // This is the recorded reference shape: 24 entries for 19 steps, with two
  // entries per failed step. Positional indexing compared the wrong steps.
  const trace = {
    trace: [
      { step: '00-boot', label: 'boot', dom: { title: 'A' } },
      { step: '01-onboarding-notice', label: 'notice', dom: { title: 'B' } },
      { step: '02-notice-dismissed', label: 'dismiss', actionError: 'TimeoutError: not enabled' },
      { step: '02-notice-dismissed', label: 'dismiss', dom: { title: 'C' } },
      { step: '03-empty-session', label: 'empty', dom: { title: 'D' } },
    ],
  }
  const index = indexSteps(trace)
  assert.equal(index.size, 4, 'duplicate ids collapse into one record each')
  assert.equal(index.get('02-notice-dismissed').outcome, 'action-error', 'the error survives the merge')
  assert.equal(index.get('02-notice-dismissed').actionError, 'TimeoutError: not enabled')
  assert.equal(index.get('03-empty-session').dom.title, 'D', 'the following step keeps its OWN facts')
  // The old positional read would have taken entry 3 for step "03", which is
  // what produced a comparison of unrelated states.
  assert.equal(trace.trace[3].step, '02-notice-dismissed')
})

test('a step with neither facts nor an error is incomplete, not captured', () => {
  const index = indexSteps({ trace: [{ step: '00-boot', label: 'boot' }] })
  assert.equal(index.get('00-boot').outcome, 'incomplete')
})

test('a not-applicable step is distinguishable from a captured one', () => {
  const index = indexSteps({ trace: [{ step: '02-notice-dismissed', notApplicable: true, dom: { title: 'x' } }] })
  assert.equal(index.get('02-notice-dismissed').outcome, 'not-applicable')
})

// ---------------------------------------------------------------------------
// DOM facts and raster: DOM equality is not visual parity.
// ---------------------------------------------------------------------------

test('the tracked facts are compared exactly, with whitespace tolerance only where declared', () => {
  const base = { title: 't', lang: 'en', landmarkCount: 5, fonts: ['A 400 normal'], textSample: 'hello\n' }
  assert.deepEqual(diffFacts(base, { ...base, textSample: 'hello   ' }), [], 'trailing whitespace is noise')

  assert.deepEqual(diffFacts(base, { ...base, landmarkCount: 6 }), ['landmarkCount'])
  assert.deepEqual(diffFacts(base, { ...base, fonts: ['B 400 normal'] }), ['fonts'])
  assert.deepEqual(diffFacts(base, { ...base, title: 'other' }), ['title'])

  // A fact missing on one side is a difference, never an implicit match.
  assert.ok(diffFacts(base, { title: 't' }).length > 0)
  assert.equal(normalizeFact('landmarkCount', 5), 5, 'non-string facts are not normalized')
})

/** Build a minimal valid 8-bit truecolour PNG from raw RGB rows. */
function encodePng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0 // filter: none
    cursor += 1
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelAt(x, y)
      raw[cursor] = r; raw[cursor + 1] = g; raw[cursor + 2] = b
      cursor += 3
    }
  }
  const chunk = (type, body) => {
    const out = Buffer.alloc(8 + body.length + 4)
    out.writeUInt32BE(body.length, 0)
    out.write(type, 4, 'ascii')
    body.copy(out, 8)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('the PNG decoder round-trips a known raster', () => {
  const bytes = encodePng(4, 3, (x, y) => [x * 60, y * 80, 10])
  const decoded = decodePng(bytes, 'fixture')
  assert.equal(decoded.width, 4)
  assert.equal(decoded.height, 3)
  // Pixel (2,1) must be [120, 80, 10, 255].
  const at = (1 * 4 + 2) * 4
  assert.deepEqual([...decoded.data.subarray(at, at + 4)], [120, 80, 10, 255])
})

test('the PNG decoder rejects input it cannot honestly decode', () => {
  assert.throws(() => decodePng(Buffer.from('not a png at all'), 'fixture'), /not a PNG/u)
  assert.throws(() => decodePng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'fixture'), /IHDR/u)
})

test('identical rasters measure as identical, and different rasters measure as different', () => {
  const left = decodePng(encodePng(8, 8, () => [10, 20, 30]), 'left')
  const right = decodePng(encodePng(8, 8, () => [10, 20, 30]), 'right')
  const same = compareRasters(left, right)
  assert.equal(same.comparable, true)
  assert.equal(same.differingPixels, 0)
  assert.equal(same.differingRatio, 0)
  assert.equal(same.maxAbsoluteDelta, 0)

  // One pixel changed hard: a small area, but a real difference. This is the
  // case an area-only threshold can wave through on a large frame.
  const changed = decodePng(encodePng(8, 8, (x, y) => (x === 3 && y === 3 ? [250, 250, 250] : [10, 20, 30])), 'changed')
  const different = compareRasters(left, changed)
  assert.equal(different.differingPixels, 1)
  assert.equal(different.maxAbsoluteDelta, 240)
  assert.ok(different.differingRatio < 0.02, 'the area is small, which is why the peak delta matters too')
})

test('a masked region is excluded and accounted for, and never silently', () => {
  const left = decodePng(encodePng(8, 8, () => [0, 0, 0]), 'left')
  const right = decodePng(encodePng(8, 8, (x, y) => (x < 2 && y < 2 ? [255, 255, 255] : [0, 0, 0])), 'right')
  const unmasked = compareRasters(left, right)
  assert.equal(unmasked.differingPixels, 4, 'the 2x2 block differs when nothing is masked')

  const masked = compareRasters(left, right, {
    masks: [{ reason: 'live clock region', x: 0, y: 0, width: 2, height: 2 }],
  })
  assert.equal(masked.differingPixels, 0, 'the masked block is excluded')
  assert.equal(masked.maskedPixels, 4, 'and its exclusion is recorded')
  assert.equal(masked.masks.length, 1)
  assert.equal(masked.masks[0].reason, 'live clock region', 'every mask carries its reason')
})

test('rasters of different sizes are not comparable rather than "equal"', () => {
  const small = decodePng(encodePng(4, 4, () => [1, 2, 3]), 'small')
  const large = decodePng(encodePng(8, 8, () => [1, 2, 3]), 'large')
  const result = compareRasters(small, large)
  assert.equal(result.comparable, false)
  assert.match(result.reason, /dimensions differ/u)
})

// ---------------------------------------------------------------------------
// Host identity: a Chromium probe is not native desktop evidence.
// ---------------------------------------------------------------------------

test('a plain Chromium page is not classified as the native webview', () => {
  const chromium = classifyHost({
    hasTauriInternals: false, hasDesktopBoot: false, hasDesktopMarker: false,
    hasHostPaths: false, platformMarker: null,
    userAgent: 'Mozilla/5.0 ... Chrome/140.0.0.0 Safari/537.36',
  })
  assert.equal(chromium.kind, CHROMIUM_PROBE)
  assert.ok(chromium.evidence.length > 0, 'the classification states why')
})

test('native markers classify the Tauri webview, and the evidence names them', () => {
  const native = classifyHost({
    hasTauriInternals: true, hasDesktopBoot: true, hasDesktopMarker: true,
    hasHostPaths: true, platformMarker: 'windows',
    userAgent: 'Mozilla/5.0 ... Edg/140.0.0.0',
  })
  assert.equal(native.kind, NATIVE_WEBVIEW)
  assert.ok(native.evidence.includes('__TAURI_INTERNALS__'))
  assert.ok(native.evidence.includes('data-platform=windows'))
})

test('partial and browser-injected product markers do not qualify native evidence', () => {
  const keys = ['hasTauriInternals', 'hasDesktopBoot', 'hasDesktopMarker', 'hasHostPaths']
  for (let mask = 0; mask < 15; mask += 1) {
    const facts = { platformMarker: 'win32', userAgent: 'Edg/140.0.0.0' }
    for (const [index, key] of keys.entries()) facts[key] = Boolean(mask & (1 << index))
    assert.equal(classifyHost(facts).kind, CHROMIUM_PROBE, `partial marker mask ${mask}`)
  }
})

test('an Edge user agent alone does not make a page native', () => {
  const edge = classifyHost({
    hasTauriInternals: false, hasDesktopBoot: false, hasDesktopMarker: false,
    hasHostPaths: false, platformMarker: null,
    userAgent: 'Mozilla/5.0 ... Edg/140.0.0.0',
  })
  assert.equal(edge.kind, CHROMIUM_PROBE, 'WebView2 and Edge share a user agent; markers decide')
})

// ---------------------------------------------------------------------------
// Isolation guards: the live GUI and live home are never touched.
// ---------------------------------------------------------------------------

/** Run a refusing guard in-process and return the exit code it requested. */
function caughtExit(fn) {
  const originalExit = process.exit
  const originalError = console.error
  let code
  let message = ''
  process.exit = c => { code = c; throw new ExitSignal() }
  console.error = m => { message = String(m) }
  class ExitSignal extends Error {}
  try {
    fn()
  } catch (error) {
    if (!(error instanceof ExitSignal)) throw error
  } finally {
    process.exit = originalExit
    console.error = originalError
  }
  return { code, message }
}

test('the live GUI port is refused', () => {
  const gui = caughtExit(() => assertNotLiveGui('http://127.0.0.1:3080'))
  assert.equal(gui.code, 2, 'a refusal is a usage error')
  assert.match(gui.message, /live Harness GUI/u)
  assert.equal(caughtExit(() => assertNotLiveGui('http://localhost:3080')).code, 2)
  // An isolated port is accepted.
  assert.equal(assertNotLiveGui('http://127.0.0.1:3085').port, '3085')
})

test('a non-loopback target is refused', () => {
  const remote = caughtExit(() => assertNotLiveGui('https://example.com'))
  assert.equal(remote.code, 2)
  assert.match(remote.message, /non-loopback/u)
})

test('an unset or non-isolated DSH_HOME is refused', () => {
  const scratch = 'C:\\Users\\Yoova\\OneDrive\\Dokumen\\Coding\\dsh\\port\\.scratch'
  assert.equal(caughtExit(() => assertIsolatedHome(undefined, scratch)).code, 2)
  assert.equal(caughtExit(() => assertIsolatedHome('', scratch)).code, 2)
  const live = caughtExit(() => assertIsolatedHome('C:\\Users\\Yoova\\.dsh', scratch))
  assert.equal(live.code, 2)
  assert.match(live.message, /outside the isolated scratch root/u)
  assert.doesNotThrow(() => assertIsolatedHome(`${scratch}\\run-home`, scratch))
  for (const unsafe of [scratch, `${scratch}-escape\\run-home`, `${scratch}\\..\\live`, 'relative-home']) {
    assert.equal(caughtExit(() => assertIsolatedHome(unsafe, scratch)).code, 2, unsafe)
  }
  assert.doesNotThrow(() => assertIsolatedHome(`${scratch}\\nested\\..\\run-home`, scratch))
})

// ---------------------------------------------------------------------------
// The Updates entry contract: an exact URL, revision and rendered section.
// ---------------------------------------------------------------------------

test('the advertised row URL uses the exact upstream combo format', () => {
  const url = comboRowUrl([PLUGIN_ID], 'rev123')
  assert.equal(url, 'plugins/??@dsh-port/dsh-client-ui-updates/client.js&rev=rev123')
  assert.ok(url.startsWith('plugins/??'), 'the doubled ?? is upstream\'s format, not a typo')
})

test('a missing or blank revision is refused rather than guessed', () => {
  // A guessed revision can only produce a misleading 404, so the helper refuses
  // instead of issuing a request that cannot be interpreted.
  assert.throws(() => comboRowUrl([PLUGIN_ID], ''), /revision is required/u)
  assert.throws(() => comboRowUrl([PLUGIN_ID], undefined), /revision is required/u)
})

test('entry URL revision is independent of batch and graph revisions', () => {
  // Mirrors ClientModuleRegistry.compose(): entry rows, batch descriptors, and
  // the graph hash carry separate revisions. The row URL uses the entry revision.
  const fixture = {
    rev: 'graph-revision',
    entries: [{ id: PLUGIN_ID, rev: 'entry-revision', url: comboRowUrl([PLUGIN_ID], 'entry-revision') }],
    batches: [{ phase: 'application', rev: 'batch-revision', url: 'plugins/??batch.js&rev=batch-revision', entries: [PLUGIN_ID] }],
  }
  const base = 'http://127.0.0.1:4312/mount/'
  const decision = decideUpdatesResource(fixture, base)
  assert.equal(decision.urlMatches, true)
  assert.equal(decision.requestUrl, `${base}plugins/??@dsh-port/dsh-client-ui-updates/client.js&rev=entry-revision`)
  assert.equal(decision.batches[0].rev, 'batch-revision')
  for (const wrongRev of [fixture.rev, fixture.batches[0].rev]) {
    const wrong = decideUpdatesResource({ ...fixture, entries: [{ ...fixture.entries[0], url: comboRowUrl([PLUGIN_ID], wrongRev) }] }, base)
    assert.equal(wrong.urlMatches, false)
    assert.equal(wrong.requestUrl, null, 'wrong revisions must not become request targets')
  }
  const changedGraph = decideUpdatesResource({ ...fixture, rev: 'unrelated-graph' }, base)
  assert.equal(changedGraph.requestUrl, decision.requestUrl)
})

test('verifier refuses absent, malformed, blank-revision and cross-origin resource targets', () => {
  const base = 'http://127.0.0.1:4312/'
  for (const entry of [undefined,
    { id: PLUGIN_ID, rev: '', url: comboRowUrl([PLUGIN_ID], 'r') },
    { id: PLUGIN_ID, rev: '   ', url: comboRowUrl([PLUGIN_ID], 'r') },
    { id: PLUGIN_ID, rev: 'r', url: 'http://[' },
    { id: PLUGIN_ID, rev: 'r', url: '' },
    { id: PLUGIN_ID, rev: 'r', url: `https://example.com/${comboRowUrl([PLUGIN_ID], 'r')}` },
    { id: PLUGIN_ID, rev: 'r', url: comboRowUrl([PLUGIN_ID], 'r').replace('??', '?') },
  ]) {
    const result = decideUpdatesResource({ rev: 'graph', entries: entry ? [entry] : [], batches: [] }, base)
    assert.equal(result.requestUrl, null)
    assert.equal(result.urlMatches, false)
  }
})

test('two route forms are NOT interchangeable: the doubled ?? is required', () => {
  const correct = comboRowUrl([PLUGIN_ID], 'r')
  const singleQuestion = correct.replace('??', '?')
  assert.notEqual(correct, singleQuestion)
  assert.ok(correct.includes('??'), 'a single ? would be a different request')
})

test('artifact classification requires HTTP 200, actual JavaScript MIME and plugin text', () => {
  const body = `/* ${PLUGIN_ID} */`
  for (const contentType of ['text/javascript', 'application/javascript; charset=utf-8', ' TEXT/JAVASCRIPT ', 'application/ecmascript']) {
    assert.deepEqual(classifyUpdatesArtifact({ status: 200, contentType, body }), {
      servedJavaScript: true, mentionsPluginId: true, artifactAccepted: true,
    })
  }
  for (const status of [204, 303, 401, 404, 500]) {
    assert.equal(classifyUpdatesArtifact({ status, contentType: 'text/javascript', body }).artifactAccepted, false)
  }
  for (const contentType of ['', 'text/html', 'text/html; note=javascript', 'application/not-javascript', 'javascript']) {
    assert.equal(classifyUpdatesArtifact({ status: 200, contentType, body }).servedJavaScript, false)
  }
  const wrongBody = classifyUpdatesArtifact({ status: 200, contentType: 'text/javascript', body: 'export {}' })
  assert.equal(wrongBody.servedJavaScript, true)
  assert.equal(wrongBody.mentionsPluginId, false)
  assert.equal(wrongBody.artifactAccepted, false)
})

test('accepted artifact text does not establish Settings activation', () => {
  assert.equal(classifyUpdatesArtifact({ status: 200, contentType: 'text/javascript', body: PLUGIN_ID }).artifactAccepted, true)
  const activation = classifyUpdatesSection({ sectionText: '', navEntryPresent: true, navSelected: true })
  assert.equal(activation.rendered, false)
})

test('a section whose nav label is present but whose content never mounted is NOT rendered', () => {
  // This is the exact false green the substring check produced: the word
  // "Updates" appears, so the old gate passed, while no section rendered.
  const result = classifyUpdatesSection({
    sectionText: '',
    navLabel: 'Updates',
    navEntryPresent: true,
    navSelected: true,
  })
  assert.equal(result.rendered, false)
  assert.ok(result.reasons.some(r => /absent or empty/u.test(r)))
})

test('content markers without actual Updates navigation selection fail', () => {
  const result = classifyUpdatesSection({
    sectionText: 'Current version: 1.0 Release channel Configured feed SHA-256',
    navLabel: 'Updates',
    navEntryPresent: true,
    navSelected: false,
  })
  assert.equal(result.rendered, false)
  assert.ok(result.reasons.some(r => /navigation button is not selected/u.test(r)))
})

test('a fully rendered section passes only with every content marker present', () => {
  const full = classifyUpdatesSection({
    sectionText: 'Current version: 1.0.0 Release channel Stable Beta Configured feed Last check Check for updates SHA-256',
    navLabel: 'Updates',
    navEntryPresent: true,
    navSelected: true,
  })
  assert.equal(full.rendered, true, full.reasons.join('; '))
  assert.ok(full.matched.includes('securityNote'))

  const partial = classifyUpdatesSection({
    sectionText: 'Current version: 1.0.0 Release channel',
    navLabel: 'Updates',
    navEntryPresent: true,
    navSelected: true,
  })
  assert.equal(partial.rendered, false, 'a partially rendered section is not parity')
  assert.ok(partial.missing.includes('check'))
})

// ---------------------------------------------------------------------------
// The capture sequence itself must be self-consistent.
// ---------------------------------------------------------------------------

test('step ids are unique and every step declares an expected surface', () => {
  assert.equal(new Set(STEP_IDS).size, STEP_IDS.length, 'a duplicate id would merge two states')
  for (const step of SEQUENCE) {
    assert.equal(typeof step.id, 'string')
    assert.ok(step.id.length > 0)
    assert.equal(typeof step.label, 'string', `${step.id} needs a label`)
    assert.ok(['app', 'settings', 'plugins'].includes(step.expectedPage), `${step.id} declares a known surface`)
  }
})

test('every required action-bearing step declares selectors as a list, not a single string', () => {
  for (const step of SEQUENCE) {
    if (step.click !== undefined) {
      assert.ok(Array.isArray(step.click) && step.click.length > 0, `${step.id}.click must be a non-empty list`)
    }
    if (step.focus !== undefined) {
      assert.ok(Array.isArray(step.focus) && step.focus.length > 0, `${step.id}.focus must be a non-empty list`)
    }
  }
})

test('the two surface-reaching steps actually require their surface', () => {
  const settings = SEQUENCE.find(s => s.id === '12-settings-open')
  const plugins = SEQUENCE.find(s => s.id === '10-plugins-page')
  assert.equal(settings.expectedPage, 'settings', 'settings-open must prove it opened settings')
  assert.equal(plugins.expectedPage, 'plugins', 'plugins-page must prove it reached plugins')
})
