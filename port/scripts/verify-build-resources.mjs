#!/usr/bin/env node
/**
 * verify-build-resources.mjs — the compiled-resource qualification guard.
 *
 * WHY THIS EXISTS
 *   Tauri's build-script resource copy is a DIRECTORY MERGE: files left in
 *   `<exeDir>/dsh` or `<exeDir>/ui` by a previous build are never removed, so
 *   a stale payload can ride alongside the freshly copied one and the compile
 *   still passes. This guard closes that gap for the port's two resource
 *   mirrors: it verifies EXACT file membership plus per-file byte identity
 *   (size + SHA-256) of the compiled exe-relative `dsh` and `ui` trees against
 *   the sealed published sources (`port/runtime-payload/dsh` and
 *   `port/ui/dist`), and fails on missing, EXTRA (the stale-file class), or
 *   content-mismatched files.
 *
 * SAFETY
 *   * Strictly read-only: the helper opens, stats and hashes; it never moves,
 *     deletes, renames or writes anything, and it never logs file CONTENT —
 *     only relative paths, counts, sizes and hashes.
 *   * Roots and ancestors: both roots are lstat-verified as real non-linked
 *     directories with every ancestor a real, non-linked, READABLE directory
 *     (unreadable ancestors fail closed); a junction/reparse anywhere in a
 *     walked tree is refused via native-realpath mismatch (a junction
 *     resolves away from its parent even when a plain lstat reports a
 *     directory), and a realpath-equivalent source/mirror alias is refused.
 *   * Hashing discipline: the MIRROR walk only discovers names (lstat/readdir)
 *     and hashes files the sealed source also declares — unknown extra files
 *     are listed by name but never opened (unexpected user data is never
 *     touched). The sealed SOURCE walk hashes everything it declares.
 *   * Old staged payload segments (`dsh.s-*`) are refused generically: this
 *     guard qualifies the published default, never a staging tree.
 *   * Sparse-file detection is approximate on Windows (content hash + declared
 *     size; reparse/links are the hard gates) — recorded in the output.
 *
 * ARTIFACT DERIVATION (no blind target guessing)
 *   `--artifact-json <file>` takes the stdout of the ORIGINAL compile run.
 *   Two stream shapes are accepted, chosen by `--stream`:
 *     * `cargo` (default): the stdout of `cargo build …
 *       --message-format=json-render-diagnostics`. Fail-closed parsing: every
 *       non-empty line must parse as JSON; the stream must contain a
 *       successful `build-finished`; the `dsh-desktop` bin compiler-artifact
 *       must carry an ABSOLUTE executable path; exactly ONE distinct path is
 *       accepted.
 *     * `tauri-build`: the stdout of `cargo tauri build --no-bundle -- …`
 *       (the tauri CLI forwards trailing ARGS to the cargo runner and prints
 *       its own non-JSON narration lines, which are counted and skipped —
 *       every JSON line is still held to the same rules).
 *   The executable must exist as a regular single-link file. An explicit
 *   `--exe <path>` is accepted instead for callers that derive the artifact by
 *   other non-writing means (e.g. cargo metadata).
 *
 * PHYSICAL METADATA (fail-closed sparse/reparse gate)
 *   Node's std fs cannot see NTFS SparseFile or the full ReparsePoint class,
 *   so a full pass requires the caller (build.ps1) to supply a validated
 *   combined manifest via `--physical-metadata <file>`. build.ps1 generates
 *   it by a read-only explicit-directory-stack walk that refuses SparseFile,
 *   ReparsePoint and any attribute outside the allowlist, then writes a
 *   schema-versioned manifest binding each section's CANONICAL ROOT to its
 *   entries (so wrong-tree manifests cannot pass). The helper cross-checks
 *   root bindings, kind matches and exact membership against all four walked
 *   trees. Without a manifest the verdict is `limited-pass` — the record
 *   states honestly that physical attributes were not verified.
 *
 * EXECUTABLE NLINK POLICY
 *   The compiled dsh-desktop.exe's hard-link count is RECORDED but NOT
 *   refused: normal Cargo output hardlinks the target exe and its deps/ copy
 *   (nlink=2), which is not a relocation hazard. Byte provenance stays with
 *   the separate SHA-256 verification against the declared hash. The
 *   nlink=1 refusal is kept on every dsh/ui RESOURCE file (in walkTree),
 *   where a hard link would be a genuine integrity concern.
 *
 * Exit codes: 0 qualified (or limited-pass), 1 failure, 2 refused arguments.
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, stat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const EXPECTED_BIN_NAME = 'dsh-desktop'
const STAGED_SEGMENT = /[\\/]dsh\.s-[^\\/]*/iu
const LIST_CAP = 50

const USAGE = `verify-build-resources.mjs — exact compiled-resource mirror qualification

Required:
  --source-dsh <ABS dir>    sealed published runtime payload (port/runtime-payload/dsh)
  --source-ui <ABS dir>     sealed published UI (port/ui/dist)
  --artifact-json <file>    stdout of the ORIGINAL compile run (see --stream)
    -- or --
  --exe <ABS path>          the already-derived dsh-desktop executable

Stream shape (with --artifact-json):
  --stream <cargo|tauri-build>  cargo: strict JSON-line stream (default);
                                tauri-build: the tauri CLI's own narration lines
                                are skipped, JSON lines stay fail-closed.

Physical metadata (full pass):
  --physical-metadata <file>  validated COMBINED manifest binding canonical
                              roots for all four trees (schemaVersion 1);
                              absent manifest = limited-pass.

Exit codes: 0 pass (or limited-pass), 1 failure, 2 refused.`

function refused(message) {
  return Object.assign(new Error(message), { code: 'refused' })
}

const ARGUMENT_NAMES = new Set([
  'source-dsh', 'source-ui', 'artifact-json', 'exe', 'stream',
  'physical-metadata',
])

const parseArgs = argv => {
  const values = new Map()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) throw refused(`unexpected positional argument #${index + 1}`)
    const name = token.slice(2)
    if (!ARGUMENT_NAMES.has(name)) throw refused(`unknown argument --${name}`)
    if (values.has(name)) throw refused(`--${name} supplied twice`)
    const next = argv[index + 1]
    if (next === undefined || next.startsWith('--')) throw refused(`--${name} requires a value`)
    values.set(name, next)
    index += 1
  }
  const sourceDsh = values.get('source-dsh')
  const sourceUi = values.get('source-ui')
  if (!sourceDsh || !isAbsolute(sourceDsh)) throw refused('--source-dsh must be an absolute path')
  if (!sourceUi || !isAbsolute(sourceUi)) throw refused('--source-ui must be an absolute path')
  const artifactJson = values.get('artifact-json')
  const exe = values.get('exe')
  if ((artifactJson === undefined) === (exe === undefined)) {
    throw refused('exactly one of --artifact-json or --exe is required')
  }
  if (artifactJson !== undefined && !isAbsolute(artifactJson)) throw refused('--artifact-json must be an absolute path')
  if (exe !== undefined && !isAbsolute(exe)) throw refused('--exe must be an absolute path')
  const stream = values.get('stream') ?? 'cargo'
  if (stream !== 'cargo' && stream !== 'tauri-build') throw refused(`--stream must be 'cargo' or 'tauri-build', got ${stream}`)
  const physicalMetadata = values.has('physical-metadata') ? resolve(values.get('physical-metadata')) : null
  return {
    sourceDsh: resolve(sourceDsh),
    sourceUi: resolve(sourceUi),
    artifactJson: artifactJson === undefined ? null : resolve(artifactJson),
    exe: exe === undefined ? null : resolve(exe),
    stream,
    physicalMetadata,
  }
}

const sha256File = async path => createHash('sha256').update(await readFile(path)).digest('hex')

/** Strip a PowerShell redirection BOM and decode. */
function decodeMaybeBom(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf8-bom' }
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf16le-bom' }
  }
  return { text: buffer.toString('utf8'), encoding: 'utf8' }
}

/**
 * The dsh-desktop bin executable from a compile message stream. Fail-closed:
 * in `cargo` mode every non-empty line must parse; in `tauri-build` mode the
 * tauri CLI's own narration lines are counted and skipped while every JSON
 * line is held to the same rules. The stream must contain a SUCCESSFUL
 * build-finished; the dsh-desktop bin artifact must carry an ABSOLUTE
 * executable path; exactly one distinct path is accepted.
 */
export function executableFromCargoJson(text, { stream = 'cargo' } = {}) {
  const executables = new Set()
  let parsedLines = 0
  let narrationLines = 0
  let buildFinishedSuccess = false
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim()
    if (trimmed === '') continue
    let entry
    try {
      entry = JSON.parse(trimmed)
    } catch {
      // The malformed line's BYTES are never echoed: file content can include
      // sensitive compiler or build-script text. Report position and kind only.
      if (stream === 'tauri-build') { narrationLines += 1; continue }
      throw refused(`malformed (non-JSON) cargo message line at stream line ${index + 1}; refusing the artifact stream (line content is never echoed)`)
    }
    parsedLines += 1
    if (entry?.reason === 'build-finished') {
      buildFinishedSuccess = entry.success === true
      continue
    }
    if (entry?.reason !== 'compiler-artifact') continue
    if (entry?.target?.name !== EXPECTED_BIN_NAME) continue
    if (!Array.isArray(entry.target?.kind) || !entry.target.kind.includes('bin')) continue
    if (typeof entry.executable !== 'string' || entry.executable === '') {
      throw refused(`the ${EXPECTED_BIN_NAME} compiler-artifact carries no executable path`)
    }
    if (!isAbsolute(entry.executable)) {
      throw refused(`the ${EXPECTED_BIN_NAME} compiler-artifact executable path is relative; cargo emits absolute paths, so this stream is not authoritative`)
    }
    executables.add(entry.executable)
  }
  if (parsedLines === 0) throw refused('the artifact JSON carried no parseable cargo message lines')
  if (!buildFinishedSuccess) {
    throw refused('the artifact stream shows no successful build-finished; refusing to qualify from an incomplete cargo stream')
  }
  if (executables.size === 0) {
    throw refused(`no ${EXPECTED_BIN_NAME} bin compiler-artifact with an executable was found in the cargo JSON — was the build actually run?`)
  }
  if (executables.size > 1) {
    throw refused(`ambiguous artifact derivation: ${executables.size} distinct ${EXPECTED_BIN_NAME} executables in the cargo JSON; refusing to guess`)
  }
  return { exe: [...executables][0], parsedLines, narrationLines }
}

/** Reject any path with a staged dsh.s-* segment (generic, any suffix). */
function assertNoStagedSegment(label, path) {
  if (STAGED_SEGMENT.test(path)) {
    throw refused(`${label} resolves into a STAGED payload (dsh.s-* segment): ${path}. Staged payloads are read-only source and are never qualified.`)
  }
}

/**
 * Root + ancestor gate: the root must lstat as a real directory (no
 * symlink/junction), every ancestor a real, non-linked, READABLE directory
 * (unreadable ancestors fail closed), and the root's native realpath must
 * match its declared path case-insensitively — a junction/reparse root
 * resolves elsewhere and is refused before anything is walked.
 */
async function assertRealRoot(label, root) {
  assertNoStagedSegment(label, root)
  let info
  try {
    info = await lstat(root)
  } catch (error) {
    throw refused(`${label} root is not stat-able (${String(error?.code ?? error?.message).slice(0, 60)}): ${root}`)
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw refused(`${label} root must be a real directory (no symlink/junction/reparse): ${root}`)
  }
  let real
  try {
    real = await realpath(root)
  } catch (error) {
    throw refused(`${label} root realpath failed (${String(error?.code ?? error?.message).slice(0, 60)}): ${root}`)
  }
  if (real.replace(/[\\/]+$/u, '').toLowerCase() !== root.replace(/[\\/]+$/u, '').toLowerCase()) {
    throw refused(`${label} root is a junction/reparse alias: declared ${root}, realpath ${real}`)
  }
  const ancestors = []
  let current = dirname(root)
  while (true) {
    ancestors.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  for (const ancestor of ancestors) {
    let ancestorInfo
    try {
      ancestorInfo = await lstat(ancestor)
    } catch (error) {
      throw refused(`${label} traverses an UNREADABLE ancestor (${ancestor}); refusing unknown visibility: ${String(error?.code ?? error?.message).slice(0, 60)}`)
    }
    if (!ancestorInfo.isDirectory() || ancestorInfo.isSymbolicLink()) {
      throw refused(`${label} traverses a non-directory or linked ancestor (${ancestor}); a linked payload ancestor is a relocation hazard`)
    }
  }
}

/**
 * Walk one tree into {files: relative-path map {size, sha256}, names: every
 * discovered regular-file relative path}. `hashFilter` (the sealed source's
 * file set, for MIRROR walks) limits which files are READ: unknown extra files
 * are discovered by name only and never opened (unexpected user data is never
 * touched). Junctions/reparse points are detected by native-realpath mismatch
 * (a junction resolves away from its parent even when a plain lstat reports a
 * directory), and a directory standing where the sealed source declares a file
 * refuses instead of degrading to a membership diff.
 */
async function walkTree(label, root, hashFilter = null) {
  await assertRealRoot(label, root)
  const files = new Map()
  const names = new Set()
  const kinds = new Map()

  const walk = async (dir, dirReal) => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      throw refused(`${label} directory is not readable (${String(error?.code ?? error?.message).slice(0, 60)}): ${dir}`)
    }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      const rel = relative(root, path).split(sep).join('/')
      const expectedReal = join(dirReal, entry.name)
      let entryReal
      try {
        entryReal = await realpath(path)
      } catch (error) {
        throw refused(`${label} entry realpath failed (${String(error?.code ?? error?.message).slice(0, 60)}): ${path}`)
      }
      if (entryReal.toLowerCase() !== expectedReal.toLowerCase()) {
        throw refused(`${label} entry is a junction/reparse alias: declared ${path}, realpath ${entryReal}`)
      }
      const info = await lstat(path)
      if (info.isDirectory()) {
        names.add(rel) // directories are recorded for physical-metadata cross-checks and symmetric extra detection
        kinds.set(rel, 'directory')
        await walk(path, entryReal)
        continue
      }
      if (!info.isFile()) {
        throw refused(`${label} entry is neither file nor directory: ${path}`)
      }
      if (typeof info.nlink === 'number' && info.nlink !== 1) {
        throw refused(`${label} file has ${info.nlink} hard links; a single-link regular file is required: ${path}`)
      }
      names.add(rel)
      kinds.set(rel, 'file')
      if (hashFilter !== null && !hashFilter.has(rel)) continue // name discovered; contents of UNKNOWN files are never read
      const bytes = await readFile(path)
      files.set(rel, { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
    }
  }
  await walk(root, await realpath(root))
  return { files, names, kinds }
}

/**
 * Qualify one mirror against its source: exact membership both directions,
 * then per-file size + SHA-256 identity. Returns the finding lists (capped in
 * the emitted record, never capped in the decision).
 */
async function qualifyMirror(label, sourceDir, mirrorDir) {
  const sourceReal = await realpath(sourceDir)
  const mirrorReal = await realpath(mirrorDir)
  if (sourceReal.toLowerCase() === mirrorReal.toLowerCase()) {
    throw refused(`${label}: the source and mirror are the same directory (realpath alias); the comparison would be vacuous`)
  }
  const source = await walkTree(`${label} source`, sourceDir)
  const mirror = await walkTree(`${label} mirror`, mirrorDir, new Set(source.files.keys()))

  const missing = []
  const extra = []
  const mismatched = []
  // Extra detection uses the mirror's DISCOVERED NAMES (including unknown
  // files whose contents were deliberately never read). Directory entries are
  // recorded symmetrically on both walks so structural entries never appear
  // as extra.
  for (const rel of mirror.names) {
    if (!source.names.has(rel)) extra.push(rel)
  }
  for (const rel of source.files.keys()) {
    if (!mirror.files.has(rel)) missing.push(rel)
  }
  for (const [rel, expected] of source.files.entries()) {
    const observed = mirror.files.get(rel)
    if (observed === undefined) continue
    if (observed.size !== expected.size || observed.sha256 !== expected.sha256) {
      mismatched.push({ rel, expected: { size: expected.size, sha256: expected.sha256 }, observed: { size: observed.size, sha256: observed.sha256 } })
    }
  }
  return {
    sourceCount: source.files.size,
    mirrorCount: mirror.names.size,
    missing,
    extra,
    mismatched,
    walked: { source: source.names, mirror: mirror.names },
    kinds: { source: source.kinds, mirror: mirror.kinds },
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
  }
}

/**
 * Physical-metadata gate over one validated manifest (written by build.ps1
 * from FileSystemInfo.Attributes after refusing SparseFile, ReparsePoint and
 * any attribute outside the allowlist). Cross-checks: exact membership against
 * the walked tree, allowlisted attribute tokens only, and directories/files
 * matching the walk. Fail-closed on unknown attributes.
 */
/**
 * Cross-check a validated combined physical-metadata manifest against ALL
 * FOUR walked trees (sealed sources + compiled mirrors). Fail-closed:
 * unknown attribute tokens, kind mismatches (root=directory, file/dir
 * matching the walk), missing root binding or canonical-root mismatch,
 * missing manifest entries for walked names, un-walked manifest entries,
 * and any unknown attribute token all refuse. A wrong-tree manifest with
 * the same membership cannot pass because the canonical root binding is
 * verified per section.
 */
const PHYSICAL_METADATA_SCHEMA_VERSION = 1

async function applyPhysicalMetadataManifest(manifestPath, trees) {
  const manifestRaw = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (manifestRaw.schemaVersion !== PHYSICAL_METADATA_SCHEMA_VERSION) {
    throw refused(`physical metadata manifest schemaVersion is ${manifestRaw.schemaVersion}, expected ${PHYSICAL_METADATA_SCHEMA_VERSION}`)
  }
  const ALLOWED_TOKENS = new Set(['Directory', 'Archive', 'ReadOnly', 'NotContentIndexed'])
  const sections = {}
  for (const key of ['sourceDsh', 'sourceUi', 'mirrorDsh', 'mirrorUi']) {
    const section = manifestRaw[key]
    if (!section || typeof section !== 'object') throw refused(`physical metadata manifest section '${key}' is missing or not an object`)
    if (typeof section.root !== 'string' || !isAbsolute(section.root)) {
      throw refused(`physical metadata manifest section '${key}' has no absolute canonical root binding`)
    }
    if (!Array.isArray(section.entries)) throw refused(`physical metadata manifest section '${key}'.entries is not an array`)
    // Canonical root binding: the manifest's declared root must match the
    // actual walked root. A wrong-tree manifest with the same membership
    // cannot pass because the root paths differ.
    const actualReal = await realpath(trees[key].dir)
    if (section.root.replace(/[\\/]+$/u, '').toLowerCase() !== actualReal.replace(/[\\/]+$/u, '').toLowerCase()) {
      throw refused(`physical metadata manifest section '${key}' binds root '${section.root}' but the actual walked root is '${actualReal}'; refusing wrong-tree metadata`)
    }
    const byPath = new Map()
    // ALL entries (including the root at '.') go through the SAME allowlisted
    // tokens, kind checks and duplicate detection. The root is NOT pre-seeded.
    for (const entry of section.entries) {
      if (typeof entry?.path !== 'string' || typeof entry?.attributes !== 'string' || typeof entry?.kind !== 'string') {
        throw refused(`physical metadata manifest entry in '${key}' is malformed`)
      }
      if (byPath.has(entry.path)) throw refused(`physical metadata manifest '${key}' carries a duplicate path: ${entry.path}`)
      const tokens = entry.attributes.split(',').map(token => token.trim()).filter(token => token !== '')
      const unknown = tokens.filter(token => !ALLOWED_TOKENS.has(token))
      if (unknown.length > 0) {
        throw refused(`physical metadata '${key}' carries UNKNOWN file attributes (${unknown.join(', ')}) at '${entry.path}'; failing closed`)
      }
      if (entry.kind === 'file' && tokens.includes('Directory')) {
        throw refused(`physical metadata '${key}' declares a DIRECTORY at a file path: ${entry.path}`)
      }
      if (entry.kind === 'directory' && !tokens.includes('Directory')) {
        throw refused(`physical metadata '${key}' declares a non-directory at a directory path: ${entry.path}`)
      }
      // Kind must match the walked tree's structure.
      const walkedKind = trees[key].kinds.get(entry.path)
      if (walkedKind !== undefined && walkedKind !== entry.kind) {
        throw refused(`physical metadata '${key}' declares kind '${entry.kind}' at '${entry.path}' but the walk found '${walkedKind}'`)
      }
      byPath.set(entry.path, entry)
    }
    // After the loop: the root entry MUST exist at path '.' with kind='directory'.
    if (!byPath.has('.')) {
      throw refused(`physical metadata manifest section '${key}' is missing the root entry at path '.'`)
    }
    if (byPath.get('.').kind !== 'directory') {
      throw refused(`physical metadata manifest section '${key}' root entry must have kind 'directory'`)
    }
    sections[key] = byPath
  }
  const results = {}
  for (const [key, tree] of Object.entries(trees)) {
    const byPath = sections[key]
    const missing = [...tree.walked].filter(rel => !byPath.has(rel) && rel !== '')
    if (missing.length > 0) {
      throw refused(`physical metadata '${key}' is missing ${missing.length} walked entr(ies), first: ${missing[0]}`)
    }
    const unWalked = [...byPath.keys()].filter(rel => !tree.walked.has(rel) && rel !== '.')
    if (unWalked.length > 0) {
      throw refused(`physical metadata '${key}' carries ${unWalked.length} entr(ies) the walk did not visit, first: ${unWalked[0]}`)
    }
    results[key] = { ok: true, entries: byPath.size }
  }
  return { verified: true, ...results, manifestPath }
}

/** Cap a finding list for the emitted record; the decision uses full lists. */
function cap(list) {
  return { total: list.length, first: list.slice(0, LIST_CAP).map(entry => (typeof entry === 'string' ? entry : entry.rel)) }
}

/**
 * Regularity gate for the derived executable: real, non-linked, absolute,
 * canonical. The compiled exe's nlink is RECORDED but NOT refused: normal
 * Cargo output hardlinks target\debug\dsh-desktop.exe and
 * target\debug\deps\dsh_desktop.exe (nlink=2), which is not a relocation
 * hazard. Byte provenance stays with the separate SHA-256 verification.
 * The nlink=1 refusal is kept on every dsh/ui RESOURCE file (in walkTree),
 * where a hard link would be a genuine integrity concern.
 */
async function assertRegularExecutable(label, exe) {
  assertNoStagedSegment(label, exe)
  if (!isAbsolute(exe)) throw refused(`${label} must be an absolute path (cargo emits absolute executable paths): ${exe}`)
  let info
  try {
    info = await lstat(exe)
  } catch (error) {
    throw refused(`${label} is not stat-able (${String(error?.code ?? error?.message).slice(0, 60)}): ${exe}`)
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw refused(`${label} must be a regular non-linked file: ${exe}`)
  }
  let real
  try {
    real = await realpath(exe)
  } catch (error) {
    throw refused(`${label} realpath failed (${String(error?.code ?? error?.message).slice(0, 60)}): ${exe}`)
  }
  if (real.replace(/[\\/]+$/u, '').toLowerCase() !== exe.replace(/[\\/]+$/u, '').toLowerCase()) {
    throw refused(`${label} is a junction/reparse alias: declared ${exe}, realpath ${real}`)
  }
  return { nlink: typeof info.nlink === 'number' ? info.nlink : 'unknown' }
}

export async function run(argv) {
  let args
  try {
    args = parseArgs(argv)
  } catch (error) {
    process.stderr.write(`REFUSED: ${error.message}\n${USAGE}\n`)
    return 2
  }

  const record = {
    record: 'verify-build-resources',
    kind: 'compiled-resource-qualification',
    scopeStatement: 'Exact membership + byte identity of the compiled exe-relative dsh/ui mirrors against the sealed published sources. Read-only: no move, delete, rename or write. Junction/reparse ALIASES are refused by native-realpath mismatch; NTFS SparseFile and the remaining reparse classes are OUT OF SCOPE for this Node-only helper unless a validated physical-metadata manifest is supplied (build.ps1 writes a schema-versioned combined manifest binding canonical roots from FileSystemInfo.Attributes). Hashing discipline: mirrored files are read only when the sealed source declares them; unknown extras are named, never opened. Executable nlink is recorded, not refused (Cargo hardlinks the target exe and its deps copy); resource files keep the nlink=1 refusal.',
    startedAt: new Date().toISOString(),
    stream: args.stream,
    artifactJson: args.artifactJson,
    sourceDsh: args.sourceDsh,
    sourceUi: args.sourceUi,
    exe: null,
    mirrorDsh: null,
    mirrorUi: null,
    physicalMetadata: { verified: false },
    qualification: {},
    verdict: 'internal-error',
    exitCode: 1,
  }

  try {
    assertNoStagedSegment('--source-dsh', args.sourceDsh)
    assertNoStagedSegment('--source-ui', args.sourceUi)

    let exe = args.exe
    if (exe === null) {
      const buffer = await readFile(args.artifactJson)
      const { text, encoding } = decodeMaybeBom(buffer)
      record.artifactEncoding = encoding
      const derived = executableFromCargoJson(text, { stream: args.stream })
      exe = derived.exe
      record.artifactParsedLines = derived.parsedLines
      record.artifactNarrationLines = derived.narrationLines
    }
    exe = resolve(exe)
    const exeRegular = await assertRegularExecutable('derived executable', exe)
    record.exeNlink = exeRegular.nlink
    assertNoStagedSegment('--exe', exe)
    const exeDir = dirname(exe)
    const mirrorDsh = join(exeDir, 'dsh')
    const mirrorUi = join(exeDir, 'ui')
    record.exe = exe
    record.mirrorDsh = mirrorDsh
    record.mirrorUi = mirrorUi

    const dsh = await qualifyMirror('dsh', args.sourceDsh, mirrorDsh)
    const ui = await qualifyMirror('ui', args.sourceUi, mirrorUi)
    record.qualification = {
      dsh: { ...dsh, missing: cap(dsh.missing), extra: cap(dsh.extra), mismatchedCount: dsh.mismatched.length, mismatched: dsh.mismatched.slice(0, LIST_CAP) },
      ui: { ...ui, missing: cap(ui.missing), extra: cap(ui.extra), mismatchedCount: ui.mismatched.length, mismatched: ui.mismatched.slice(0, LIST_CAP) },
    }

    // Physical-metadata gate: with a validated combined manifest the attribute
    // strings are allowlisted and cross-checked against ALL FOUR walked trees
    // (sealed sources + compiled mirrors); without a manifest the verdict is
    // an honest limited-pass (the Node-only helper cannot see NTFS SparseFile
    // or the full ReparsePoint class).
    if (args.physicalMetadata !== null) {
      record.physicalMetadata = await applyPhysicalMetadataManifest(args.physicalMetadata, {
        sourceDsh: { dir: args.sourceDsh, walked: dsh.walked.source, kinds: dsh.kinds.source },
        sourceUi: { dir: args.sourceUi, walked: ui.walked.source, kinds: ui.kinds.source },
        mirrorDsh: { dir: mirrorDsh, walked: dsh.walked.mirror, kinds: dsh.kinds.mirror },
        mirrorUi: { dir: mirrorUi, walked: ui.walked.mirror, kinds: ui.kinds.mirror },
      })
    }

    const mirrorsOk = dsh.ok && ui.ok
    const physicalOk = record.physicalMetadata.verified === true
    if (!mirrorsOk) {
      record.verdict = 'failed-qualification'
      record.exitCode = 1
    } else if (physicalOk) {
      record.verdict = 'pass'
      record.exitCode = 0
    } else {
      record.verdict = 'limited-pass'
      record.exitCode = 0
    }
  } catch (error) {
    if (error?.code === 'refused') {
      record.verdict = 'refused'
      record.exitCode = 2
      record.refusalReason = String(error.message).slice(0, 400)
    } else {
      record.internalErrorKind = String(error?.code ?? error?.name ?? 'error').slice(0, 48)
      record.internalErrorMessage = String(error?.message ?? '').slice(0, 300)
    }
  }
  record.finishedAt = new Date().toISOString()
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`)
  return record.exitCode
}

const invokedDirectly = (() => {
  try {
    return pathToFileURL(resolve(process.argv[1] ?? '')).href === import.meta.url
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  run(process.argv.slice(2)).then(
    code => process.exit(code),
    error => {
      process.stderr.write(`INTERNAL: ${String(error?.code ?? error?.message).slice(0, 160)}\n`)
      process.exit(1)
    },
  )
}
