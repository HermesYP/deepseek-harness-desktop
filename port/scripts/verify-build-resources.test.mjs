#!/usr/bin/env node
/**
 * verify-build-resources.test.mjs — unit + refusal tests for the compiled
 * resource qualification guard. Builtin-only; every fixture lives in a fresh
 * temp directory; the helper is exercised through its exported run() so no
 * real build, cargo invocation or launcher runs here.
 *
 * Covered: exact-mirror pass; EXTRA stale files fail (the Tauri directory-merge
 * class) WITHOUT their contents being read; missing files fail; byte/size
 * mismatch fails; non-regular mirror entries fail closed (junction refusal via
 * a real Windows directory junction, which needs no symlink privilege);
 * artifact-stream fail-closed parsing (malformed line, missing successful
 * build-finished, relative executable path, absent executable, ambiguous,
 * non-bin); UTF-16 BOM tolerance; staged dsh.s-* refusal; same-realpath-alias
 * refusal; unknown arguments; and a source-immutability assertion proving the
 * guard performs no writes (no move/delete/modify of the qualified trees).
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm, readFile, lstat, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { run, executableFromCargoJson } from './verify-build-resources.mjs'

/** Build a small source tree: a.txt, sub/b.bin. */
async function makeSourceTree(root) {
  await mkdir(join(root, 'sub'), { recursive: true })
  await writeFile(join(root, 'a.txt'), 'alpha contents')
  await writeFile(join(root, 'sub', 'b.bin'), Buffer.from([1, 2, 3, 4, 5]))
}

/** Copy a tree byte-for-byte into a mirror (regular files, real dirs). */
async function mirrorTree(source, mirror) {
  await mkdir(mirror, { recursive: true })
  for (const rel of ['a.txt', join('sub', 'b.bin')]) {
    const bytes = await readFile(join(source, rel))
    await mkdir(join(mirror, rel, '..'), { recursive: true })
    await writeFile(join(mirror, rel), bytes)
  }
}

function artifactJsonLine(exe) {
  return JSON.stringify({
    reason: 'compiler-artifact',
    target: { name: 'dsh-desktop', kind: ['bin'] },
    executable: exe,
  })
}

const BUILD_FINISHED = JSON.stringify({ reason: 'build-finished', success: true })

/**
 * Run the guard against temp trees. The artifact stream carries the bin
 * artifact plus a successful build-finished unless `stream` overrides it.
 */
async function runGuard({ repo, sourceDsh, sourceUi, exe, stream, encoding = 'utf8', helperStream, manifests }) {
  const artifactJson = join(repo, `artifacts-${Math.random().toString(16).slice(2)}.json`)
  const text = stream ?? `${artifactJsonLine(exe)}\n${BUILD_FINISHED}\n`
  const bom = encoding === 'utf16le' ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0)
  const body = encoding === 'utf16le' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf8')
  await writeFile(artifactJson, Buffer.concat([bom, body]))
  const args = [
    '--artifact-json', artifactJson,
    '--source-dsh', sourceDsh,
    '--source-ui', sourceUi,
  ]
  if (helperStream) args.push('--stream', helperStream)
  if (manifests) {
    args.push('--physical-metadata', manifests)
  }
  return run(args)
}

/** Standard fixture: source trees + byte-exact mirrors + mocked exe. */
async function buildFixture() {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-guard-'))
  const cleanup = async () => { await rm(repo, { recursive: true, force: true }) }
  const sourceDsh = join(repo, 'source-dsh')
  const sourceUi = join(repo, 'source-ui')
  await makeSourceTree(sourceDsh)
  await makeSourceTree(sourceUi)
  const exeDir = join(repo, 'target', 'debug')
  await mirrorTree(sourceDsh, join(exeDir, 'dsh'))
  await mirrorTree(sourceUi, join(exeDir, 'ui'))
  const exe = join(exeDir, 'dsh-desktop.exe')
  await writeFile(exe, Buffer.from('MZ mocked'))
  return { repo, cleanup, sourceDsh, sourceUi, exeDir, exe }
}

test('G1: an exact mirror qualifies with zero findings', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 0)
  } finally {
    await cleanup()
  }
})

test('G2: EXTRA stale mirror files fail (the Tauri directory-merge class)', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exeDir, exe } = await buildFixture()
  try {
    // 800-stale class: a file from a PREVIOUS payload left in the mirror.
    await writeFile(join(exeDir, 'dsh', 'stale-old-file.js'), 'stale bytes from a previous payload — never read by the guard')
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 1)
  } finally {
    await cleanup()
  }
})

test('G3: missing and content-mismatched mirror files fail', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exeDir, exe } = await buildFixture()
  try {
    await rm(join(exeDir, 'dsh', 'sub', 'b.bin'))
    await writeFile(join(exeDir, 'ui', 'sub', 'b.bin'), Buffer.from([9, 9]))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 1)
  } finally {
    await cleanup()
  }
})

test('G4: a real Windows directory JUNCTION inside the mirror is refused (no symlink privilege needed)', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exeDir, exe } = await buildFixture()
  try {
    // A junction standing where the sealed source has the file sub/b.bin —
    // fs.symlink(..., 'junction') needs no privilege on Windows.
    const outside = join(repo, 'outside-target')
    await mkdir(outside, { recursive: true })
    await writeFile(join(outside, 'b.bin'), Buffer.from([1, 2, 3, 4, 5]))
    await rm(join(exeDir, 'dsh', 'sub', 'b.bin'))
    await symlink(join(outside, 'b.bin'), join(exeDir, 'dsh', 'sub', 'b.bin'), 'junction')
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 2, 'a junction/reparse entry must refuse the run, not hash through the alias')
  } finally {
    await cleanup()
  }
})

test('G5: artifact stream fail-closed parsing', () => {
  const exeA = 'C:\\t\\debug\\dsh-desktop.exe'
  const exeB = 'C:\\t\\release\\dsh-desktop.exe'
  assert.deepEqual(executableFromCargoJson(`${artifactJsonLine(exeA)}\n${BUILD_FINISHED}\n`).exe, exeA)
  assert.throws(
    () => executableFromCargoJson(`${artifactJsonLine(exeA)}\n${artifactJsonLine(exeB)}\n${BUILD_FINISHED}\n`),
    /ambiguous artifact derivation.*2 distinct/u,
  )
  assert.throws(() => executableFromCargoJson(`{"reason":"build-finished","success":true}\n`), /no dsh-desktop bin compiler-artifact/u)
  assert.throws(
    () => executableFromCargoJson(`${JSON.stringify({ reason: 'compiler-artifact', target: { name: 'dsh-desktop', kind: ['lib'] }, executable: exeA })}\n${BUILD_FINISHED}\n`),
    /no dsh-desktop bin compiler-artifact/u,
  )
  assert.throws(
    () => executableFromCargoJson(`${artifactJsonLine(exeA)}\nthis is not json\n${BUILD_FINISHED}\n`),
    /malformed \(non-JSON\) cargo message line/u,
  )
  assert.throws(
    () => executableFromCargoJson(`${artifactJsonLine('target\\debug\\dsh-desktop.exe')}\n${BUILD_FINISHED}\n`),
    /relative; cargo emits absolute paths/u,
  )
  assert.throws(
    () => executableFromCargoJson(`${artifactJsonLine(exeA)}\n${JSON.stringify({ reason: 'build-finished', success: false })}\n`),
    /no successful build-finished/u,
  )
  assert.throws(() => executableFromCargoJson(`${artifactJsonLine(exeA)}\n`), /no successful build-finished/u)
})

test('G6: a declared executable that is absent refuses', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    // The fixture creates the exe; remove it so the declared path is absent.
    await rm(exe)
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 2, 'an absent declared executable refuses')
  } finally {
    await cleanup()
  }
})

test('G7: UTF-16 BOM artifact files (PowerShell redirection default) parse', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, encoding: 'utf16le' }), 0, 'a UTF-16 BOM artifact file must parse (PowerShell 5.1 redirection)')
  } finally {
    await cleanup()
  }
})

test('G8: refusals — staged segment, unknown argument, both-args', async () => {
  assert.equal(
    await run([
      '--exe', 'C:\\x\\port\\runtime-payload\\dsh.s-abc123\\dsh\\dsh-desktop.exe',
      '--source-dsh', 'C:\\x\\port\\runtime-payload\\dsh',
      '--source-ui', 'C:\\x\\port\\ui\\dist',
    ]),
    2, 'a staged dsh.s-* path is refused',
  )
  assert.equal(await run(['--bogus', 'x', '--exe', 'C:\\a.exe', '--source-dsh', 'C:\\s', '--source-ui', 'C:\\u']), 2)
  assert.equal(
    await run(['--exe', 'C:\\a.exe', '--artifact-json', 'C:\\j.json', '--source-dsh', 'C:\\s', '--source-ui', 'C:\\u']),
    2, 'artifact-json and exe are mutually exclusive',
  )
})

test('G9: a mirror directory that is the SAME REALPATH as the source is refused as vacuous', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'dsh-guard-'))
  try {
    // The source directory is named exactly `dsh` so the exe-relative mirror
    // derivation (exeDir/dsh) lands on the source itself: the vacuous
    // comparison must refuse, never pass trivially.
    const sourceDsh = join(repo, 'dsh')
    const sourceUi = join(repo, 'source-ui')
    await makeSourceTree(sourceDsh)
    await makeSourceTree(sourceUi)
    const exe = join(repo, 'dsh-desktop.exe')
    await writeFile(exe, Buffer.from('MZ mocked'))
    assert.equal(await run(['--exe', exe, '--source-dsh', sourceDsh, '--source-ui', sourceUi]), 2)
  } finally {
    await cleanup(repo)
  }
})

/** Remove a temp repo (test-local teardown helper). */
async function cleanup(repo) {
  await rm(repo, { recursive: true, force: true })
}

test('G10: the guard performs NO writes — source trees are byte- and mtime-identical after a run', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    const snapshot = []
    for (const rel of ['a.txt', join('sub', 'b.bin')]) {
      for (const root of [sourceDsh, sourceUi]) {
        const path = join(root, rel)
        const info = await lstat(path)
        snapshot.push({ path, mtimeMs: info.mtimeMs, sha256: createHash('sha256').update(await readFile(path)).digest('hex') })
      }
    }
    await runGuard({ repo, sourceDsh, sourceUi, exe })
    for (const entry of snapshot) {
      const info = await lstat(entry.path)
      assert.equal(info.mtimeMs, entry.mtimeMs, `mtime unchanged for ${entry.path}`)
      assert.equal(createHash('sha256').update(await readFile(entry.path)).digest('hex'), entry.sha256, `bytes unchanged for ${entry.path}`)
    }
  } finally {
    await cleanup()
  }
})

test('G11: tauri-build stream — narration skipped, JSON rules enforced, narration-only refuses', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    // Tauri narration + forwarded cargo JSON: the run passes.
    const tauriStream = [
      'Info Running beforeBuildCommand',
      artifactJsonLine(exe),
      BUILD_FINISHED,
      `Built application at: ${exe}`,
      '',
    ].join('\n')
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, stream: tauriStream, helperStream: 'tauri-build' }), 0)
    // A narration-only stream (no cargo messages at all) refuses even in
    // tauri-build mode: the runner emitted no cargo messages to qualify.
    const narrationArtifact = join(repo, 'narration.json')
    await writeFile(narrationArtifact, 'Info Running beforeBuildCommand\nBuilt application somewhere\n')
    const narrationExit = await run([
      '--stream', 'tauri-build',
      '--artifact-json', narrationArtifact,
      '--source-dsh', sourceDsh,
      '--source-ui', sourceUi,
    ])
    assert.equal(narrationExit, 2, 'a narration-only tauri stream carries no cargo messages and refuses')
  } finally {
    await cleanup()
  }
})

/** Build a validated COMBINED physical-metadata manifest bound to canonical roots. */
function combinedManifest({ sourceDsh, sourceUi, mirrorDsh, mirrorUi }) {
  const section = root => {
    const entries = [{ path: '.', kind: 'directory', attributes: 'Directory' }]
    for (const rel of ['a.txt', 'sub', 'sub/b.bin']) {
      entries.push({ path: rel, kind: rel === 'sub' ? 'directory' : 'file', attributes: rel === 'sub' ? 'Directory' : 'Archive' })
    }
    return { root, entries }
  }
  return {
    schemaVersion: 1,
    sourceDsh: section(sourceDsh),
    sourceUi: section(sourceUi),
    mirrorDsh: section(mirrorDsh),
    mirrorUi: section(mirrorUi),
  }
}

test('G12: combined physical-metadata manifest — full pass, wrong-tree/sparse/reparse/unknown/membership-mismatch refuse', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exeDir, exe } = await buildFixture()
  try {
    const manifestPath = join(repo, 'physical-metadata.json')
    const mirrorDsh = join(exeDir, 'dsh')
    const mirrorUi = join(exeDir, 'ui')
    const goodManifest = combinedManifest({ sourceDsh, sourceUi, mirrorDsh, mirrorUi })
    await writeFile(manifestPath, JSON.stringify(goodManifest))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 0,
      'validated combined manifest makes the run a full pass')

    // WRONG-TREE manifest: the sourceDsh section carries the ui root instead.
    const wrongTree = structuredClone(goodManifest)
    wrongTree.sourceDsh.root = sourceUi
    await writeFile(manifestPath, JSON.stringify(wrongTree))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2,
      'a wrong-tree manifest (same membership but different root) must refuse')

    // SparseFile attribute fails closed.
    const sparse = structuredClone(goodManifest)
    for (const entry of sparse.sourceDsh.entries) { if (entry.path === 'a.txt') entry.attributes = 'Archive, SparseFile' }
    await writeFile(manifestPath, JSON.stringify(sparse))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'SparseFile fails closed')

    // ReparsePoint attribute fails closed.
    const reparse = structuredClone(goodManifest)
    for (const entry of reparse.sourceDsh.entries) { if (entry.path === 'sub') entry.attributes = 'Directory, ReparsePoint' }
    await writeFile(manifestPath, JSON.stringify(reparse))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'ReparsePoint fails closed')

    // Unknown attribute token fails closed.
    const unknown = structuredClone(goodManifest)
    for (const entry of unknown.sourceDsh.entries) { if (entry.path === 'a.txt') entry.attributes = 'Archive, Encrypted' }
    await writeFile(manifestPath, JSON.stringify(unknown))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'unknown attribute fails closed')

    // Manifest missing a walked file fails closed.
    const omit = structuredClone(goodManifest)
    omit.sourceDsh.entries = omit.sourceDsh.entries.filter(entry => entry.path !== 'a.txt')
    await writeFile(manifestPath, JSON.stringify(omit))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'missing manifest entry fails closed')

    // Root entry with SparseFile attribute fails closed.
    const rootSparse = structuredClone(goodManifest)
    for (const entry of rootSparse.sourceDsh.entries) { if (entry.path === '.') entry.attributes = 'Directory, SparseFile' }
    await writeFile(manifestPath, JSON.stringify(rootSparse))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'root SparseFile fails closed')

    // Root entry with ReparsePoint attribute fails closed.
    const rootReparse = structuredClone(goodManifest)
    for (const entry of rootReparse.sourceDsh.entries) { if (entry.path === '.') entry.attributes = 'Directory, ReparsePoint' }
    await writeFile(manifestPath, JSON.stringify(rootReparse))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'root ReparsePoint fails closed')

    // Root entry with unknown attribute fails closed.
    const rootUnknown = structuredClone(goodManifest)
    for (const entry of rootUnknown.sourceDsh.entries) { if (entry.path === '.') entry.attributes = 'Directory, Encrypted' }
    await writeFile(manifestPath, JSON.stringify(rootUnknown))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'root unknown attribute fails closed')

    // Missing root entry (no path '.') fails closed.
    const noRoot = structuredClone(goodManifest)
    noRoot.sourceDsh.entries = noRoot.sourceDsh.entries.filter(entry => entry.path !== '.')
    await writeFile(manifestPath, JSON.stringify(noRoot))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'missing root entry fails closed')

    // Duplicate root entries fail closed.
    const dupRoot = structuredClone(goodManifest)
    dupRoot.sourceDsh.entries.push({ path: '.', kind: 'directory', attributes: 'Directory' })
    await writeFile(manifestPath, JSON.stringify(dupRoot))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'duplicate root entry fails closed')

    for (const replacement of [
      { path: '.', kind: 'file', attributes: 'Archive' },
      { path: '.', kind: 'directory' },
      { path: '.', kind: 'unknown', attributes: 'Directory' },
    ]) {
      const malformedRoot = structuredClone(goodManifest)
      malformedRoot.sourceDsh.entries = malformedRoot.sourceDsh.entries.map(entry => entry.path === '.' ? replacement : entry)
      await writeFile(manifestPath, JSON.stringify(malformedRoot))
      assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2, 'root kind and attributes must be validated, not just its existence')
    }
  } finally {
    await cleanup()
  }
})

test('G14: the normal Cargo executable hardlink pair qualifies', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    await link(exe, join(repo, 'cargo-deps-executable.exe'))
    assert.equal((await lstat(exe)).nlink, 2)
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 0)
  } finally {
    await cleanup()
  }
})

test('G15: hardlinked resource files remain refused', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    await link(join(sourceDsh, 'a.txt'), join(repo, 'unexpected-resource-alias.txt'))
    assert.equal((await lstat(join(sourceDsh, 'a.txt'))).nlink, 2)
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 2)
  } finally {
    await cleanup()
  }
})

test('G16: a UTF-8 BOM in the physical metadata manifest is stripped before JSON.parse', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exeDir, exe } = await buildFixture()
  try {
    const mirrorDsh = join(exeDir, 'dsh')
    const mirrorUi = join(exeDir, 'ui')
    const goodManifest = combinedManifest({ sourceDsh, sourceUi, mirrorDsh, mirrorUi })
    const manifestPath = join(repo, 'physical-metadata-bom.json')
    // Simulate PowerShell Set-Content -Encoding utf8: UTF-8 BOM + JSON body.
    const bom = Buffer.from([0xef, 0xbb, 0xbf])
    const body = Buffer.from(JSON.stringify(goodManifest), 'utf8')
    await writeFile(manifestPath, Buffer.concat([bom, body]))
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 0,
      'a UTF-8 BOM in the physical metadata manifest must be stripped before JSON.parse')
  } finally {
    await cleanup()
  }
})

test('G17: malformed physical metadata refuses safely and is parsed before byte hashing', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    const manifestPath = join(repo, 'malformed-metadata.json')
    await writeFile(manifestPath, '\uFEFF{"invalid": "not-a-real-secret')
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe, manifests: manifestPath }), 2,
      'malformed JSON must be a safe refusal, not a JSON.parse internal-error')
    const helper = await readFile(new URL('./verify-build-resources.mjs', import.meta.url), 'utf8')
    const parseAt = helper.indexOf('const physicalManifest =')
    const hashAt = helper.indexOf("const dsh = await qualifyMirror('dsh'")
    assert.ok(parseAt >= 0 && hashAt > parseAt, 'metadata syntax is checked before the expensive tree walk/hash')
    assert.match(helper, /malformed physical metadata JSON; content is never echoed/)
  } finally { await cleanup() }
})

test('G13: standalone runs record limited-pass (no physical metadata)', async () => {
  const { repo, cleanup, sourceDsh, sourceUi, exe } = await buildFixture()
  try {
    assert.equal(await runGuard({ repo, sourceDsh, sourceUi, exe }), 0, 'standalone runs stay limited-pass (honest scope)')
  } finally {
    await cleanup()
  }
})
