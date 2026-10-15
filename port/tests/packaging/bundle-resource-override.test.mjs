/**
 * The bundle-stage resource path normalization.
 *
 * The bundle died in makensis on a 261-character `File` source
 * (`...\port\src-tauri\app\..\..\runtime-payload\dsh\...`) whose canonical form is
 * 241 characters. `tauri-bundler` joins `bundle.resources` keys onto the app
 * directory without canonicalizing them, so the fix is a transient `--config`
 * JSON Merge Patch that replaces each relative source key with its canonical
 * absolute form while copying every destination verbatim.
 *
 * These tests pin the two properties that make that safe:
 *
 *   1. the RFC 7386 merge (what `tauri-cli --config` performs: `use
 *      json_patch::merge`) must leave EXACTLY the canonical keys - the `null`
 *      entries are load-bearing, because without them both spellings survive and
 *      every resource is installed twice, once under `_up_`-prefixed paths;
 *   2. no destination value may change, under any input.
 *
 * Measured with real makensis on the real resource file: 259 characters opens,
 * 260 and longer fail with `File: failed opening file "<path>"`, so the gate is
 * `MAX_SOURCE_PATH_LENGTH = 259`.
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  MAX_SOURCE_PATH_LENGTH, applyMergePatch, buildBundleOverride, buildResourcePatch,
  canonicalResourceKey, longestResourceSourcePath,
} from '../../scripts/lib/bundle-resource-override.mjs'

const port = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const repo = resolve(port, '..')
const appDir = join(port, 'src-tauri', 'app')
const realConfig = JSON.parse(readFileSync(join(appDir, 'tauri.conf.json'), 'utf8'))
const realResources = realConfig.bundle.resources

// The real failing source, as the bundle spelled it and as it canonicalizes.
const longTail = join('runtime-payload', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-experimental-inspector',
  'lib', 'devtools', 'models', 'issues_manager', 'descriptions',
  'selectElementAccessibilityInteractiveContentAttributesSelectDescendant.md')

test('a relative resource key canonicalizes to an absolute path with no relative component', () => {
  const canonical = canonicalResourceKey('../../runtime-payload/dsh/', appDir)
  assert.equal(canonical, `${join(port, 'runtime-payload', 'dsh')}/`,
    'the key resolves against the app directory and keeps its trailing separator')
  assert.ok(!canonical.includes('..'), 'no parent component survives');
  assert.ok(!/(^|[\\/])\.[\\/]/u.test(canonical), 'no single-dot component survives')
  assert.equal(canonicalResourceKey('../../ui/dist/', appDir), `${join(port, 'ui', 'dist')}/`)
});

test('a glob source key is refused rather than rewritten', () => {
  // A wildcard cannot be canonicalized without re-deriving its pattern: the fixed
  // prefix, the wildcard's own component (`icon*.png`) and the separator style all
  // matter, and a guess silently broadens or narrows what the bundler copies.
  // The production map holds directory roots only, so this fails closed.
  for (const key of ['../assets/icon*.png', '..\\assets\\icon*.png', '../../assets/**/*.png', '*.png']) {
    assert.throws(() => canonicalResourceKey(key, appDir), /is a glob/u, `the glob "${key}" is refused`)
  }
  assert.throws(() => buildResourcePatch({ '../assets/icon*.png': 'assets/' }, appDir), /is a glob/u,
    'the patch builder refuses a glob source through the same guard')
});

test('an already absolute key is normalized, not rewritten into a relative one', () => {
  const absolute = `${join(port, 'ui', 'dist')}\\`
  assert.equal(canonicalResourceKey(absolute, appDir), `${join(port, 'ui', 'dist')}\\`,
    'an absolute Windows key keeps its own separator style')
});

test('the emitted patch deletes each relative key and adds the canonical one with the SAME destination', () => {
  const { patch, mappings, unchanged } = buildResourcePatch(realResources, appDir)
  assert.equal(unchanged, false, 'the real configuration does need rewriting')
  for (const [key, destination] of Object.entries(realResources)) {
    assert.equal(patch[key], null, `the relative key "${key}" is deleted by the patch`)
    const canonical = canonicalResourceKey(key, appDir)
    assert.equal(patch[canonical], destination, `the canonical key carries the original destination for "${key}"`)
  }
  assert.equal(Object.keys(patch).length, 2 * Object.keys(realResources).length,
    'exactly one deletion and one addition per source')
  assert.deepEqual(mappings.map((mapping) => mapping.destination).sort(), ['dsh/', 'ui/'],
    'every destination is carried verbatim')
});

test('the patch, applied to the configuration, leaves ONLY canonical keys and unchanged destinations', () => {
  const { override } = buildBundleOverride({ resources: realResources, appDir })
  const merged = applyMergePatch(structuredClone(realConfig), override)
  const canonicalDsh = canonicalResourceKey('../../runtime-payload/dsh/', appDir)
  const canonicalUi = canonicalResourceKey('../../ui/dist/', appDir)
  const resources = merged.bundle.resources
  assert.deepEqual(Object.keys(resources).sort(), [canonicalDsh, canonicalUi].sort(),
    'the merged map holds exactly the two canonical sources')
  assert.equal(Object.keys(resources).length, 2, 'no relative key survives the merge')
  for (const key of Object.keys(resources)) {
    assert.ok(!key.includes('..'), `no relative source survives: ${key}`)
  }
  assert.equal(resources[canonicalUi], 'ui/', 'the ui destination is byte-identical')
  assert.equal(resources[canonicalDsh], 'dsh/', 'the dsh destination is byte-identical')
  // The rest of the canonical configuration is untouched.
  assert.equal(merged.bundle.windows.nsis.template, realConfig.bundle.windows.nsis.template)
  assert.deepEqual(merged.bundle.windows.nsis.languages, realConfig.bundle.windows.nsis.languages)
});

test('the null deletions are load-bearing: without them both spellings survive', () => {
  const { patch } = buildResourcePatch(realResources, appDir)
  const additive = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== null))
  const naive = applyMergePatch(structuredClone(realConfig), { bundle: { resources: additive } })
  assert.equal(Object.keys(naive.bundle.resources).length, 4,
    'an additive patch merges key-wise and keeps BOTH spellings')
  assert.ok(Object.keys(naive.bundle.resources).some((key) => key.includes('..')),
    'the un-normalized spelling is exactly what the null entries remove, and it is the spelling that broke MAX_PATH')
  // The installed subtree is still the explicit map destination, so the failure
  // mode here is "the un-normalized sources survive", not a proven `_up_` path.
  assert.deepEqual([...new Set(Object.values(naive.bundle.resources))].sort(), ['dsh/', 'ui/'],
    'both spellings carry the same explicit destinations, which is why the retained sources must be removed')
});

test('the two bundle patches are disjoint, so the CLI composes them in any order', () => {
  // build.ps1 passes the observer override and this resource override as two
  // separate `--config` arguments. The CLI's own composition (Layer A) folds them
  // into one patch and RETAINS nulls; application (Layer B) is the merge modelled
  // here. Because the patches touch disjoint keys, each must take effect alone and
  // together, in either order.
  const { override: resources } = buildBundleOverride({ resources: realResources, appDir })
  const observer = { bundle: { windows: { signCommand: { cmd: 'powershell.exe', args: ['-File', 'x.ps1'] } } } }
  for (const [first, second, label] of [
    [resources, observer, 'resources then observer'],
    [observer, resources, 'observer then resources'],
  ]) {
    const merged = applyMergePatch(applyMergePatch(structuredClone(realConfig), first), second)
    assert.equal(Object.keys(merged.bundle.resources).length, 2, `${label}: the resource replacement still holds`)
    assert.ok(Object.keys(merged.bundle.resources).every((key) => !key.includes('..')), `${label}: no relative source survives`)
    assert.deepEqual(merged.bundle.windows.signCommand, observer.bundle.windows.signCommand,
      `${label}: the observer signCommand still holds`)
    assert.equal(merged.bundle.windows.nsis.installMode, realConfig.bundle.windows.nsis.installMode,
      `${label}: the rest of the configuration is untouched`)
  }
  // Neither patch mentions the other's keys, which is the property the ordering
  // independence rests on.
  assert.deepEqual(Object.keys(resources.bundle), ['resources'])
  assert.deepEqual(Object.keys(observer.bundle), ['windows'])
});

test('applyMergePatch models the application layer: objects merge, null deletes, scalars replace', () => {
  // This is Layer B only (`json_patch::merge` when the composed patch is applied to
  // the canonical configuration). It is deliberately NOT a model of the CLI's
  // patch-over-patch composition, which retains nulls instead of deleting.
  const target = { a: { b: 1, c: 2 }, list: [1, 2], keep: 'yes' }
  applyMergePatch(target, { a: { c: null, d: 3 }, list: [9] })
  assert.deepEqual(target, { a: { b: 1, d: 3 }, list: [9], keep: 'yes' })
});

test('the override refuses inputs it cannot normalize safely', () => {
  assert.throws(() => buildResourcePatch({}, appDir), /empty/u, 'an empty resource map is refused')
  assert.throws(() => buildResourcePatch(['a'], appDir), /source-to-destination object/u,
    'the glob-array form has no destination map and is refused rather than guessed')
  assert.throws(() => buildResourcePatch({ '../../ui/dist/': 7 }, appDir), /must be a string/u,
    'a non-string destination is refused')
  assert.throws(() => canonicalResourceKey('', appDir), /non-empty string/u)
  assert.throws(() => canonicalResourceKey('../../ui/dist/', 'relative/dir'), /must be absolute/u)
});

test('the source-length gate fails closed at the measured NSIS limit', () => {
  const observed = { path: `${'x'.repeat(MAX_SOURCE_PATH_LENGTH)}`, length: MAX_SOURCE_PATH_LENGTH }
  assert.doesNotThrow(() => buildResourcePatch(realResources, appDir, { observedLongestPath: observed }),
    'a source at the measured limit is accepted')
  const over = { path: `${'x'.repeat(MAX_SOURCE_PATH_LENGTH + 1)}`, length: MAX_SOURCE_PATH_LENGTH + 1 }
  assert.throws(() => buildResourcePatch(realResources, appDir, { observedLongestPath: over }),
    /above the 259-character NSIS File limit/u, 'one character over is refused with the path named')
});

test('the longest source path is measured by walking the canonical roots', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-respath-'))
  try {
    const source = join(base, 'res')
    const deep = join(source, 'a'.repeat(30), 'b'.repeat(30))
    mkdirSync(deep, { recursive: true })
    const deepest = join(deep, 'leaf.txt')
    writeFileSync(deepest, 'x')
    writeFileSync(join(source, 'top.txt'), 'x')
    const measured = longestResourceSourcePath({ [source]: 'res/' }, base)
    assert.equal(measured.files, 2, 'both files are counted')
    assert.equal(measured.path, deepest, 'the deepest file is the longest source')
    assert.throws(() => longestResourceSourcePath({ [join(base, 'absent')]: 'x/' }, base),
      /does not exist/u, 'a missing source is refused rather than skipped')
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
});

test('the live resource trees stay under the limit, and normalization is what keeps them there', (t) => {
  // SKIP rather than fail when the staged trees are absent: `runtime-payload/` and
  // `ui/dist/` are build products, and a clean checkout has neither. The pure
  // fixture tests above are the mandatory coverage.
  const roots = Object.keys(realResources).map((key) => canonicalResourceKey(key, appDir))
  const absent = roots.filter((root) => !existsSync(root))
  if (absent.length > 0) {
    t.skip(`the staged resource roots are absent (${absent.join(', ')}), so this live-tree qualification has nothing to measure`)
    return
  }
  const measured = longestResourceSourcePath(realResources, appDir)
  assert.ok(measured.files > 0, 'the live resource roots were walked')
  assert.ok(measured.length <= MAX_SOURCE_PATH_LENGTH,
    `the longest canonical source is ${measured.length} characters: ${measured.path}`)

  // The claim that must hold on ANY checkout, long or short: normalization is a
  // pure lexical saving of the un-collapsed `src-tauri\app\..\..\` prefix, and the
  // canonical spelling fits. The exact host lengths (241/261 here) are retained as
  // build evidence, NOT asserted here, so a checkout under `C:\dev\dsh` - where the
  // un-normalized spelling never exceeded the limit in the first place - still
  // passes.
  const prefix = 'src-tauri\\app\\..\\..\\'
  // `join(port, '')` may or may not keep the trailing separator, so make it explicit
  // rather than depending on that; the comparison is purely lexical.
  const portPrefix = join(port, '').endsWith('\\') ? join(port, '') : `${join(port, '')}\\`
  const relativeRoot = measured.path.slice(portPrefix.length)
  // Built by concatenation: `join` would collapse the `..` segments, and the whole
  // point of the comparison is the spelling the bundler actually emitted.
  const unnormalized = `${portPrefix}${prefix}${relativeRoot}`
  assert.equal(unnormalized.length - measured.path.length, prefix.length,
    'canonicalization removes exactly the un-collapsed app-directory prefix, whatever the checkout root length')
  assert.ok(measured.path.length < unnormalized.length,
    'the canonical spelling is strictly shorter than the un-normalized one')
  const canonical = join(port, longTail)
  if (existsSync(canonical)) {
    // The real file the bundle died on, when this checkout carries it: the same
    // lexical relation.
    const emitted = `${appDir}\\..\\..\\runtime-payload\\dsh\\node_modules\\@deepseek-ai\\`
      + 'dsh-experimental-inspector\\lib\\devtools\\models\\issues_manager\\descriptions\\'
      + 'selectElementAccessibilityInteractiveContentAttributesSelectDescendant.md'
    assert.equal(emitted.length - canonical.length, prefix.length,
      'the file the bundle died on is 20 characters shorter once canonicalized')
    assert.ok(canonical.length <= MAX_SOURCE_PATH_LENGTH,
      `the canonical spelling of that file fits the NSIS limit (${canonical.length})`)
  }
});
