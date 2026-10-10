/**
 * End-to-end negative tests for the parity gates, driven entirely by fixtures.
 *
 * Run with the ordinary test runner, on either supported interpreter:
 *   node --test port/tests/parity-gates.test.mjs            (Node 22.20.0 or 25.4.0)
 * or, for the whole top-level suite:
 *   npm --prefix port/ui run test:verification
 *
 * Do NOT add `--test-isolation=none` here. It exists only in newer Node and the
 * port's pinned build interpreter is 22.20.0, which rejects it (exit 9, unknown
 * option). The supported invocation is plain `--test`; these tests assert
 * nothing that depends on process isolation.
 *
 * WHY THESE EXIST: the helper tests prove the decision primitives behave. These
 * prove the actual comparison FAILS on a broken tree — the property that was
 * missing, because the old script produced a report nobody checked the exit code
 * of. Every test asserts the failure mode, not the happy path.
 *
 * These drive `scripts/lib/parity-core.mjs`, which is the SAME module the CLI
 * (`scripts/compare-parity.mjs`) calls. That is not a shortcut around the CLI:
 * the CLI holds no comparison logic of its own, so this exercises the identical
 * decision code. It is also necessary under the DSH file sandbox on this
 * Windows host — there a sandboxed Node process cannot spawn a child with
 * piped stdio (EPERM, the documented named-pipe confinement), so a test cannot
 * run the CLI as a subprocess and read its exit code.
 *
 * Each run exclusively creates its own UUID scratch root and retains every
 * synthetic fixture for evidence. No shared tree is reused or cleared. No GUI,
 * desktop application or live Harness home is touched, and no port is bound.
 */

import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { deflateSync } from 'node:zlib'

import { compareTrees, validateOptions, loadTrace, listViewports, BLOCKING_VERDICTS } from '../../scripts/lib/parity-core.mjs'
import { SEQUENCE } from './helpers/capture-sequence.mjs'
import { assertNotLiveGui } from './helpers/host-identity.mjs'
import { comboRowUrl, classifyUpdatesSection, PLUGIN_ID } from './helpers/updates-contract.mjs'

const REPO = resolve(import.meta.dirname, '..', '..')
const SCRATCH_PARENT = join(REPO, 'port', '.scratch')
const ownedRoots = new Set()
const fold = value => process.platform === 'win32' ? value.toLowerCase() : value
let SCRATCH

// This synthetic-data lane checks its known parent and every directory it owns;
// it does not relax the runtime qualification's separate all-ancestor policy.
async function assertDirectory(directory) {
  assert.equal(directory, resolve(directory), 'fixture directory must be lexical and absolute')
  const stat = await lstat(directory)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'fixture directory must be a nonsymlink directory')
  assert.equal(fold(await realpath(directory)), fold(directory), 'fixture directory must have the exact realpath')
}

async function createFreshRoot(uuid = randomUUID()) {
  assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u)
  await assertDirectory(SCRATCH_PARENT)
  const root = join(SCRATCH_PARENT, `parity-gates-${uuid}`)
  await mkdir(root) // Exclusive, nonrecursive creation; EEXIST is never reused.
  await assertDirectory(root)
  ownedRoots.add(root)
  console.log(`parity-fixture-retained=${root}`)
  return root
}

async function createOwnedDirectory(directory, owner = SCRATCH) {
  assert.ok(ownedRoots.has(owner), 'fixture owner must be exclusively created by this run')
  assert.equal(directory, resolve(directory), 'fixture directory must not use lexical aliases')
  const inside = relative(owner, directory)
  assert.ok(inside && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`),
    'fixture directory must be inside its owned fixture root')
  await assertDirectory(SCRATCH_PARENT)
  for (let ancestor = dirname(directory); ; ancestor = dirname(ancestor)) {
    await assertDirectory(ancestor)
    if (fold(ancestor) === fold(owner)) break
  }
  await mkdir(directory) // Refuse any existing destination before writing content.
  await assertDirectory(directory)
}

/** Build a minimal valid 8-bit truecolour PNG. */
function encodePng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    raw[cursor] = 0
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
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const VIEWPORT = 'desktop-1280x800'
const THEMES = ['light', 'dark']
// The comparison walks the whole declared sequence, so the fixture must cover
// it: a step the fixture omits would be reported unverifiable, which is correct
// behaviour but would make these tests assert the wrong thing.
const STEP_IDS = SEQUENCE.map(step => step.id)
const STEP_PAGE = Object.fromEntries(SEQUENCE.map(step => [step.id, { surface: step.expectedPage }]))

/** The identity every synthetic capture shares, so only the tested field varies. */
const BASE_IDENTITY = {
  viewport: VIEWPORT,
  locale: 'en-US',
  timezoneId: 'Asia/Shanghai',
  deviceScaleFactor: 1,
  capturedWith: 'capture-reference.mjs/reference-web',
  appVersion: 'test',
  graphRevision: 'revfixture',
}

/**
 * Write one synthetic capture tree.
 *
 * @param {string} root Tree root.
 * @param {object} options Mutation controls.
 */
async function writeTree(root, options) {
  const owner = options.fixtureRoot ?? SCRATCH
  assert.equal(fold(dirname(root)), fold(owner), 'tree must be directly inside its owned fixture root')
  await createOwnedDirectory(root, owner)
  for (const viewport of options.viewports ?? [VIEWPORT]) {
    await createOwnedDirectory(join(root, viewport), owner)
    for (const theme of THEMES) {
      const dir = join(root, viewport, theme)
      await createOwnedDirectory(dir, owner)
      const trace = []
      for (const step of STEP_IDS) {
        if (!options.omitFrame?.(step, theme)) {
          await writeFile(join(dir, `${step}.png`), options.frame(step, theme), { flag: 'wx' })
        }
        const dom = {
          title: 'DSH', lang: 'en', landmarkCount: 12,
          fonts: ['Inter 400 normal'], textSample: 'New Session Settings',
        }
        const extra = options.stepOverride === undefined ? {} : options.stepOverride(step, theme)
        trace.push({ step, label: step, dom, page: STEP_PAGE[step], ...extra })
      }
      if (!options.omitTrace?.(theme)) {
        await writeFile(join(dir, 'trace.json'), JSON.stringify({
          identity: {
            ...BASE_IDENTITY, theme, hostKind: options.hostKind ?? 'native-webview2',
            ...(options.identityOverrides?.[theme] ?? {}),
          },
          host: { kind: options.hostKind ?? 'native-webview2', evidence: ['fixture'] },
          viewport: { id: VIEWPORT, width: 1280, height: 800, dsf: 1 },
          theme,
          baseUrl: 'http://127.0.0.1:3085',
          trace,
          consoleErrors: [],
        }, null, 2), { flag: 'wx' })
      }
    }
  }
}

const uniform = () => encodePng(16, 16, () => [10, 20, 30])

/** Compare two trees with default tolerances. */
const compare = (referenceRoot, portRoot, extra = {}) =>
  compareTrees({ referenceRoot, portRoot, rasterTolerance: 0.002, rasterMaxDelta: 24, ...extra })

before(async () => {
  SCRATCH = await createFreshRoot()
})

// Retain all exclusively created synthetic evidence; there is no cleanup hook.
test('fresh fixture roots are independent and a root collision is refused', async () => {
  const first = await createFreshRoot()
  const second = await createFreshRoot()
  assert.notEqual(first, second)
  await writeTree(join(first, 'same-name'), { frame: uniform, fixtureRoot: first })
  await writeTree(join(second, 'same-name'), { frame: uniform, fixtureRoot: second })
  const firstFrame = join(first, 'same-name', VIEWPORT, 'light', '00-boot.png')
  const original = await readFile(firstFrame)
  await assert.rejects(() => createFreshRoot(basename(first).slice('parity-gates-'.length)), { code: 'EEXIST' })
  assert.deepEqual(await readFile(firstFrame), original, 'a root collision must preserve existing bytes')
  assert.equal((await compare(join(first, 'same-name'), join(second, 'same-name'))).totals.blocking, 0)
})

test('writeTree refuses an existing tree before changing its sentinel or contents', async () => {
  const tree = join(SCRATCH, 'existing-sentinel')
  await createOwnedDirectory(tree)
  const sentinel = join(tree, 'sentinel.txt')
  await writeFile(sentinel, 'retained sentinel', { flag: 'wx' })
  await assert.rejects(() => writeTree(tree, { frame: uniform }), { code: 'EEXIST' })
  assert.equal(await readFile(sentinel, 'utf8'), 'retained sentinel')
  assert.deepEqual(await readdir(tree), ['sentinel.txt'], 'refusal must precede all capture writes')
})

test('writeTree rejects an outside-root destination without creating it', async () => {
  const outside = join(SCRATCH_PARENT, `parity-outside-${randomUUID()}`)
  await assert.rejects(() => writeTree(outside, { frame: uniform }), /inside its owned fixture root/u)
  await assert.rejects(() => lstat(outside), { code: 'ENOENT' })
})

// ---------------------------------------------------------------------------
// Usage errors: the gate refuses configurations that could only mislead.
// ---------------------------------------------------------------------------

test('comparing a tree with itself is refused rather than reported as parity', async () => {
  const tree = join(SCRATCH, 'self')
  await writeTree(tree, { frame: uniform })
  await assert.rejects(
    () => compare(tree, tree),
    /refusing to compare/u,
    'a self-comparison always matches and proves nothing',
  )
})

test('a missing tree is refused', async () => {
  await assert.rejects(
    () => compare(join(SCRATCH, 'absent-a'), join(SCRATCH, 'absent-b')),
    /does not exist/u,
  )
})

test('an out-of-range raster tolerance is refused', () => {
  assert.throws(() => validateOptions({ rasterTolerance: 5, rasterMaxDelta: 24 }), /between 0 and 1/u)
  assert.throws(() => validateOptions({ rasterTolerance: 0.01, rasterMaxDelta: 400 }), /integer 0-255/u)
  assert.throws(() => validateOptions({ rasterTolerance: -1, rasterMaxDelta: 24 }), /between 0 and 1/u)
  assert.doesNotThrow(() => validateOptions({ rasterTolerance: 0.002, rasterMaxDelta: 24 }))
})

// ---------------------------------------------------------------------------
// The happy path, so the negative results below are not vacuous.
// ---------------------------------------------------------------------------

test('two identical trees report every step as identical', async () => {
  const reference = join(SCRATCH, 'clean-ref')
  const port = join(SCRATCH, 'clean-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, { frame: uniform })
  const report = await compare(reference, port)
  // The comparison walks the whole capture sequence, not just the steps this
  // fixture writes frames for, so every step reports on its own terms. What
  // matters is that nothing blocks and every step that HAS both frames is
  // identical.
  const withBothFrames = report.rows.filter(r => STEP_IDS.some(s => r.id.endsWith(`/${s}`)))
  assert.equal(withBothFrames.length, STEP_IDS.length * THEMES.length)
  assert.ok(withBothFrames.every(r => r.verdict === 'identical'), 'every fully captured step is identical')
  assert.equal(report.totals.blocking, 0, 'an identical pair blocks nothing')
  assert.equal(report.identityMismatches.length, 0)
})

// ---------------------------------------------------------------------------
// The false-greens, each reproduced as a failure.
// ---------------------------------------------------------------------------

test('a changed frame fails parity even when every DOM fact still matches', async () => {
  const reference = join(SCRATCH, 'raster-ref')
  const port = join(SCRATCH, 'raster-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, {
    frame: step => (step === '03-empty-session'
      // A localized but real difference: the DOM is identical, the pixels are not.
      ? encodePng(16, 16, (x, y) => (x < 8 && y < 8 ? [250, 250, 250] : [10, 20, 30]))
      : uniform()),
  })
  const report = await compare(reference, port)
  assert.ok(report.totals.blocking > 0, 'a real raster difference must block parity')
  const row = report.rows.find(r => r.id.endsWith('light/03-empty-session'))
  assert.equal(row.verdict, 'raster-differs')
  assert.equal(row.differences.length, 0, 'the DOM facts matched; the raster is what differed')
  assert.ok(row.raster.differingPixels > 0, 'the difference is measured, not assumed')
  assert.equal(row.raster.maxAbsoluteDelta, 240)
  assert.match(row.note, /peak delta/u)
})

test('a small-area difference is still caught by the peak-delta yardstick', async () => {
  const reference = join(SCRATCH, 'small-ref')
  const port = join(SCRATCH, 'small-port')
  // 256 pixels: one pixel changed is 0.39% of the area — under a 2% area-only
  // threshold, and exactly the case an area ratio alone would wave through.
  await writeTree(reference, { frame: () => encodePng(16, 16, () => [0, 0, 0]) })
  await writeTree(port, {
    frame: step => (step === '00-boot'
      ? encodePng(16, 16, (x, y) => (x === 5 && y === 5 ? [255, 255, 255] : [0, 0, 0]))
      : encodePng(16, 16, () => [0, 0, 0])),
  })
  const report = await compare(reference, port)
  const row = report.rows.find(r => r.id.endsWith('light/00-boot'))
  assert.ok(row.raster.differingRatio < 0.02, 'the area alone would not trip a 2% threshold')
  assert.equal(row.verdict, 'raster-differs', 'the peak delta catches it')
})

test('a changed DOM fact fails parity even when the pixels are identical', async () => {
  const reference = join(SCRATCH, 'dom-ref')
  const port = join(SCRATCH, 'dom-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, {
    frame: uniform,
    stepOverride: step => (step === '01-onboarding-notice'
      ? { dom: { title: 'DSH', lang: 'en', landmarkCount: 99, fonts: ['Inter 400 normal'], textSample: 'New Session Settings' } }
      : {}),
  })
  const report = await compare(reference, port)
  const row = report.rows.find(r => r.id.endsWith('/01-onboarding-notice'))
  assert.equal(row.verdict, 'different')
  assert.deepEqual(row.differences, ['landmarkCount'])
})

test('a port frame missing entirely fails parity', async () => {
  const reference = join(SCRATCH, 'miss-ref')
  const port = join(SCRATCH, 'miss-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, {
    frame: uniform,
    omitFrame: (step, theme) => step === '03-empty-session' && theme === 'light',
  })
  const report = await compare(reference, port)
  const row = report.rows.find(r => r.id.endsWith('light/03-empty-session'))
  assert.equal(row.verdict, 'missing-in-port')
  assert.ok(BLOCKING_VERDICTS.has(row.verdict))
})

test('an action error on the port side fails parity instead of being tolerated', async () => {
  const reference = join(SCRATCH, 'act-ref')
  const port = join(SCRATCH, 'act-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, {
    frame: uniform,
    stepOverride: step => (step === '00-boot' ? { actionError: 'TimeoutError: click intercepted' } : {}),
  })
  const report = await compare(reference, port)
  const row = report.rows.find(r => r.id.endsWith('light/00-boot'))
  assert.equal(row.verdict, 'action-error', 'an action that could not be performed is not parity')
  assert.ok(BLOCKING_VERDICTS.has(row.verdict))
})

test('an action error on the reference side also blocks parity', async () => {
  const reference = join(SCRATCH, 'act-ref2')
  const port = join(SCRATCH, 'act-port2')
  await writeTree(reference, {
    frame: uniform,
    stepOverride: step => (step === '00-boot' ? { actionError: 'TimeoutError: not enabled' } : {}),
  })
  await writeTree(port, { frame: uniform })
  const report = await compare(reference, port)
  assert.equal(report.rows.find(r => r.id.endsWith('light/00-boot')).verdict, 'action-error')
})

test('a mismatched capture environment is reported as incomparable, not as a port defect', async () => {
  const reference = join(SCRATCH, 'env-ref')
  const port = join(SCRATCH, 'env-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, { frame: uniform, identityOverrides: { light: { deviceScaleFactor: 2 } } })
  const report = await compare(reference, port)
  assert.equal(report.identityMismatches.length, 1)
  assert.match(report.identityMismatches[0], /deviceScaleFactor/u)
  assert.ok(report.totals.blocking > 0, 'an incomparable pair must not pass')
})

test('a native capture compared against a plain Chromium capture is flagged', async () => {
  const reference = join(SCRATCH, 'host-ref')
  const port = join(SCRATCH, 'host-port')
  await writeTree(reference, { frame: uniform, hostKind: 'native-webview2' })
  await writeTree(port, { frame: uniform, hostKind: 'chromium-probe' })
  const report = await compare(reference, port)
  assert.equal(report.identityMismatches.length, THEMES.length, 'both themes record the host-kind difference')
  assert.ok(report.identityMismatches.every(m => /hostKind/u.test(m)))
})

test('a tree with no captures at all reports zero comparisons rather than parity', async () => {
  const reference = join(SCRATCH, 'empty-ref')
  const port = join(SCRATCH, 'empty-port')
  await createOwnedDirectory(reference)
  await createOwnedDirectory(port)
  const report = await compare(reference, port)
  assert.equal(report.totals.compared, 0)
  assert.equal(report.totals.parity, 0, 'nothing compared means nothing reached parity')
  // The CLI fails on this; the core reports it as zero so the gate can say why.
  assert.equal(await listViewports(reference).then(v => v.length), 0)
})

test('a viewport present on one side only is reported rather than silently dropped', async () => {
  const reference = join(SCRATCH, 'vp-ref')
  const port = join(SCRATCH, 'vp-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, { frame: uniform, viewports: [VIEWPORT, 'desktop-1600x1000'] })
  const report = await compare(reference, port)
  assert.equal(report.missingViewports.length, 1)
  assert.match(report.missingViewports[0], /desktop-1600x1000/u)
})

test('a step whose trace is absent on one side is unverifiable, not parity', async () => {
  const reference = join(SCRATCH, 'notrace-ref')
  const port = join(SCRATCH, 'notrace-port')
  await writeTree(reference, { frame: uniform })
  await writeTree(port, { frame: uniform, omitTrace: theme => theme === 'light' })
  const report = await compare(reference, port)
  assert.ok(report.rows.some(r => r.verdict === 'unverifiable' && r.note?.includes('port trace missing')))
  assert.equal(await loadTrace(join(port, VIEWPORT, 'light')), null)
})

test('a step that reached the wrong surface is a difference, not parity', async () => {
  const reference = join(SCRATCH, 'surf-ref')
  const port = join(SCRATCH, 'surf-port')
  await writeTree(reference, { frame: uniform })
  // 03-empty-session expects the workspace; the port sat on Settings instead.
  await writeTree(port, {
    frame: uniform,
    stepOverride: step => (step === '03-empty-session' ? { page: { surface: 'settings' } } : {}),
  })
  const report = await compare(reference, port)
  const row = report.rows.find(r => r.id.endsWith('light/03-empty-session'))
  assert.equal(row.verdict, 'different')
  assert.deepEqual(row.differences, ['surface'])
  assert.match(row.note, /expected surface "app"/u)
})

test('an optional action the reference did not exercise is not counted as parity', async () => {
  const reference = join(SCRATCH, 'opt-ref')
  const port = join(SCRATCH, 'opt-port')
  await writeTree(reference, {
    frame: uniform,
    stepOverride: step => (step === '03-empty-session' ? { notApplicable: true } : {}),
  })
  await writeTree(port, { frame: uniform })
  const report = await compare(reference, port)
  const row = report.rows.find(r => r.id.endsWith('light/03-empty-session'))
  assert.equal(row.verdict, 'not-applicable')
  assert.ok(!BLOCKING_VERDICTS.has('not-applicable'), 'recorded, but never a parity claim')
  assert.equal(report.totals.notApplicable, THEMES.length)
})

// ---------------------------------------------------------------------------
// Isolation guards the CLI enforces before it touches anything.
// ---------------------------------------------------------------------------

test('the live GUI port is refused by every gate that accepts a URL', () => {
  // `refuse` exits the process rather than throwing, so the guard is verified by
  // observing the exit, not an exception. `process.exit` is stubbed here to keep
  // the assertion in-process.
  const originalExit = process.exit
  const originalError = console.error
  const observed = []
  process.exit = code => { observed.push(code); throw new ExitSignal(code) }
  console.error = message => { observed.push(String(message)) }
  class ExitSignal extends Error {}
  try {
    assert.throws(() => assertNotLiveGui('http://127.0.0.1:3080'), ExitSignal)
    assert.throws(() => assertNotLiveGui('http://localhost:3080'), ExitSignal)
    assert.equal(observed.filter(o => o === 2).length, 2, 'both refusals exit 2')
    assert.ok(observed.some(o => /live Harness GUI/u.test(o)), 'the reason names the live GUI')
    assert.equal(assertNotLiveGui('http://127.0.0.1:3085').port, '3085', 'isolated ports remain allowed')
  } finally {
    process.exit = originalExit
    console.error = originalError
  }
})

// ---------------------------------------------------------------------------
// The Updates entry contract: exact URL, revision and rendered section.
// ---------------------------------------------------------------------------

test('the advertised row URL uses the exact upstream combo format', () => {
  const url = comboRowUrl([PLUGIN_ID], 'rev123')
  assert.equal(url, 'plugins/??@dsh-port/dsh-client-ui-updates/client.js&rev=rev123')
  assert.ok(url.includes('??'), 'the doubled ?? is upstream\'s format, not a typo')
  assert.notEqual(url, url.replace('??', '?'), 'a single ? would be a different request')
})

test('a missing or blank revision is refused rather than guessed', () => {
  assert.throws(() => comboRowUrl([PLUGIN_ID], ''), /revision is required/u)
  assert.throws(() => comboRowUrl([PLUGIN_ID], undefined), /revision is required/u)
})

const FULL_SECTION_TEXT =
  'Current version: 1.0.0 Release channel Stable Beta Configured feed Last check Check for updates SHA-256'

test('a section whose nav label is present but whose content never mounted is NOT rendered', () => {
  // The exact false green the substring check produced: the word "Updates"
  // appears, so the old gate passed, while no section rendered.
  const result = classifyUpdatesSection({
    sectionText: '', navLabel: 'Updates', navEntryPresent: true, navSelected: true, registeredSectionIds: ['updates'],
  })
  assert.equal(result.rendered, false)
  assert.ok(result.reasons.some(r => /absent or empty/u.test(r)))
})

test('a fully rendered section passes only with every content marker present', () => {
  const full = classifyUpdatesSection({
    sectionText: FULL_SECTION_TEXT,
    navLabel: 'Updates', navEntryPresent: true, navSelected: true, registeredSectionIds: ['updates'],
  })
  assert.equal(full.rendered, true, full.reasons.join('; '))
  assert.deepEqual(full.missing, [], 'a rendered section is missing no marker')
  // The positive fixture asserts the SELECTED navigation fact too, so a future
  // weakening of `classifyUpdatesSection` fails here rather than silently
  // accepting a section that was never actually opened.
  assert.equal(full.matched.length, 4)

  const partial = classifyUpdatesSection({
    sectionText: 'Current version: 1.0.0 Release channel',
    navLabel: 'Updates', navEntryPresent: true, navSelected: true, registeredSectionIds: ['updates'],
  })
  assert.equal(partial.rendered, false, 'a partially rendered section is not parity')
})

test('a complete section whose nav button is not selected is NOT rendered', () => {
  // The second false green the nav-label substring check produced: every
  // content marker is present because the section is mounted, but the probe
  // never selected the Updates nav button, so what it read is not evidence that
  // More -> Settings -> Updates was actually reachable. `classifyUpdatesSection`
  // requires `navSelected: true`; this pins that requirement from the negative
  // side so it cannot be relaxed to make a fixture pass.
  const unselected = classifyUpdatesSection({
    sectionText: FULL_SECTION_TEXT,
    navLabel: 'Updates', navEntryPresent: true, navSelected: false, registeredSectionIds: ['updates'],
  })
  assert.equal(unselected.rendered, false, 'an unselected section is not proof the Updates route works')
  assert.deepEqual(unselected.missing, [], 'the content markers matched; only the selection is missing')
  assert.ok(
    unselected.reasons.some(r => /navigation button is not selected/u.test(r)),
    `expected a selection reason, got: ${unselected.reasons.join('; ')}`,
  )
  assert.equal(unselected.reasons.length, 1, 'selection is the only thing wrong with this fixture')

  // A missing nav entry is likewise not rendered, even with full content.
  const noEntry = classifyUpdatesSection({
    sectionText: FULL_SECTION_TEXT,
    navLabel: 'Updates', navEntryPresent: false, navSelected: false, registeredSectionIds: ['updates'],
  })
  assert.equal(noEntry.rendered, false)
  assert.ok(noEntry.reasons.some(r => /nav entry is not rendered/u.test(r)))
})
