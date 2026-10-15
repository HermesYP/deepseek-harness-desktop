/**
 * The transient `--config` patch the bundle stage passes to `cargo tauri bundle`
 * so that every `bundle.resources` SOURCE is an absolute, canonical path.
 *
 * WHY THIS EXISTS (measured, not inferred)
 *
 * `bundle.resources` in `port/src-tauri/app/tauri.conf.json` names its sources
 * relative to the app directory:
 *
 *   "../../ui/dist/": "ui/",
 *   "../../runtime-payload/dsh/": "dsh/"
 *
 * `tauri-bundler` 2.9.4 turns each key into an absolute path with
 * `cwd.join(resource.path())` (`src/bundle/windows/nsis/mod.rs`, `generate_resource_data`)
 * WITHOUT canonicalizing it, so the generated `installer.nsi` names sources as
 * `<repo>\port\src-tauri\app\..\..\runtime-payload\dsh\<file>`. The un-collapsed
 * `src-tauri\app\..\..\` costs 20 characters per path, and NSIS's `File` command
 * opens the source with a Win32 path that must stay under `MAX_PATH`:
 *
 *   * 259 characters opens; 260 and longer fail (MAX_PATH is 260 INCLUDING the
 *     terminating NUL). MEASURED with real makensis on the real resource file:
 *     259 -> exit 0, 260 -> `File: failed opening file "<path>"`, 261/263/269 ->
 *     the same failure. The bundle died on a 261-character source that is 241
 *     characters once collapsed.
 *
 * The repository's longest canonical resource path is 241 characters, so
 * canonicalizing every source is sufficient; nothing is excluded, aliased,
 * junctioned or copied, and no destination changes.
 *
 * HOW THE SOURCES ARE REPLACED WITHOUT CHANGING A DESTINATION
 *
 * `tauri-cli` composes and applies `--config` in TWO distinct layers, and they do
 * NOT share one merge algorithm. Do not conflate them:
 *
 *   Layer A, composition of the provided patches (`helpers/config.rs`,
 *   `merge_patches`): every `--config` object is folded into a single patch
 *   object. It only recurses; a `null` value is RETAINED in the composed patch
 *   and deletes nothing. `--config` is repeatable and the objects are merged in
 *   the order given (`bundle.rs`), so two DISJOINT patches - the observer's
 *   `bundle.windows.signCommand` and this `bundle.resources` map - compose without
 *   either one affecting the other. This helper does NOT reimplement Layer A;
 *   `build.ps1` passes the two patches as two separate `--config` arguments.
 *
 *   Layer B, application to the canonical configuration (`json_patch::merge`, the
 *   `use json_patch::merge;` at the top of the same file): an RFC 7386 JSON Merge
 *   Patch, where a `null` value DELETES the key from the document.
 *
 * The emitted patch therefore carries a `null` under each relative source key, so
 * Layer B removes it while adding the canonical one:
 *
 *   { "bundle": { "resources": { "../../runtime-payload/dsh/": null,
 *                                "<repo>\\port\\runtime-payload\\dsh\\": "dsh/" } } }
 *
 * Without those `null`s the relative and canonical keys would both survive Layer B,
 * leaving the un-normalized sources the bundler then hands to NSIS - the very
 * spellings that broke MAX_PATH - and potentially colliding or duplicating
 * destinations. (The installed subtree is decided by the map's explicit
 * DESTINATION value, not by these source keys, so no `_up_`-prefixed destination is
 * claimed here.)
 *
 * Only the SOURCE key is rewritten. Every destination value is copied verbatim, so
 * the installed layout (`$INSTDIR\ui\...`, `$INSTDIR\dsh\...`) is unchanged: the
 * destination is `dest.join(path.strip_prefix(normalize(key)))`
 * (`tauri-utils-2.9.3/src/resources.rs`), and the walked paths carry the same
 * spelling as the key, so the stripped relative tail is identical either way.
 *
 * GLOB SOURCE KEYS ARE REFUSED. The production map holds directory roots only, and
 * a wildcard cannot be canonicalized without re-deriving the pattern (the fixed
 * prefix, the wildcard's own component and the separator style all matter), so this
 * helper fails closed rather than silently broadening a glob. Adding glob support
 * is a separate review.
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Longest source path NSIS's `File` can open, measured on this host with real makensis. */
export const MAX_SOURCE_PATH_LENGTH = 259

function fail(message) {
  throw new Error(`bundle resource override: ${message}`)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasTrailingSeparator(key) {
  return key.endsWith('/') || key.endsWith('\\')
}

/**
 * Rewrite one `bundle.resources` source key as an absolute, canonical path.
 *
 * GLOB KEYS ARE REFUSED, not "best-effort" canonicalized: a wildcard cannot be
 * rewritten without re-deriving the pattern (its fixed prefix, the wildcard's own
 * component and the separator style all matter), and guessing silently broadens or
 * narrows what the bundler copies. The production map holds directory roots only.
 *
 * @param key - the source key exactly as `tauri.conf.json` writes it.
 * @param appDir - absolute directory holding `tauri.conf.json`.
 * @returns the canonical key, keeping the original trailing separator style.
 */
export function canonicalResourceKey(key, appDir) {
  if (typeof key !== 'string' || key.length === 0) fail('a resource source key must be a non-empty string')
  if (typeof appDir !== 'string' || !isAbsolute(appDir)) fail(`the app directory must be absolute: ${appDir}`)
  if (key.includes('*')) {
    fail(`the resource source "${key}" is a glob; this override normalizes directory roots only, and a glob must not be rewritten without re-deriving its pattern`)
  }

  const trailing = hasTrailingSeparator(key)
  const resolvedDirectory = resolve(appDir, key === '' ? '.' : key)
  // Preserve the author's separator style rather than imposing one, so the emitted
  // key looks like the configuration it replaces on every platform.
  const separator = key.endsWith('\\') ? '\\' : '/'
  const canonical = trailing && !resolvedDirectory.endsWith('\\') && !resolvedDirectory.endsWith('/')
    ? `${resolvedDirectory}${separator}`
    : resolvedDirectory
  // `resolve` already collapses `.` and `..`; assert it rather than assume, so a
  // future path form that defeats it fails here instead of in the installer.
  if (/(^|[\\/])\.\.([\\/]|$)/u.test(canonical) || /(^|[\\/])\.[\\/]/u.test(canonical)) {
    fail(`canonicalizing "${key}" left a relative component: ${canonical}`)
  }
  return canonical
}

/**
 * Find the longest source path the bundler will hand to NSIS's `File`.
 *
 * `File` opens the SOURCE, so the limit applies to the longest walked FILE under
 * each canonical resource root - not to the directory key. Measuring it turns
 * "canonicalizing should be enough" into a precondition the build enforces.
 *
 * @param resources - the map from `tauri.conf.json`.
 * @param appDir - absolute directory holding `tauri.conf.json`.
 * @returns `{ path, length, files }` for the longest source path found.
 */
export function longestResourceSourcePath(resources, appDir) {
  let longest = { path: '', length: 0 }
  let files = 0
  const consider = (candidate) => {
    const length = candidate.length
    if (length > longest.length) longest = { path: candidate, length }
  }
  for (const key of Object.keys(resources)) {
    const canonical = canonicalResourceKey(key, appDir)
    let stats
    try {
      stats = statSync(canonical)
    } catch (error) {
      fail(`a resource source does not exist: ${canonical} (${error.code ?? error.message})`)
    }
    if (!stats.isDirectory()) {
      consider(canonical)
      files += 1
      continue
    }
    for (const entry of readdirSync(canonical, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue
      const parent = entry.parentPath ?? entry.path
      consider(join(parent, entry.name))
      files += 1
    }
  }
  return { ...longest, files }
}

/**
 * Build the `bundle.resources` merge patch for one resource map.
 *
 * @param resources - the map from `tauri.conf.json` (`source -> destination`).
 * @param appDir - absolute directory holding `tauri.conf.json`.
 * @param options.maxSourcePathLength - override for the fail-closed length gate.
 * @param options.observedLongestPath - a measured `{ path, length }` source path.
 * @returns `{ patch, mappings, longestCanonical, unchanged }`.
 */
export function buildResourcePatch(resources, appDir, {
  maxSourcePathLength = MAX_SOURCE_PATH_LENGTH,
  observedLongestPath = null,
} = {}) {
  if (!isPlainObject(resources)) {
    fail('bundle.resources must be a source-to-destination object; the glob-array form has no destination map and is not supported here')
  }
  const keys = Object.keys(resources)
  if (keys.length === 0) fail('bundle.resources is empty; refusing to emit an override that maps nothing')

  const patch = {}
  const mappings = []
  let longestCanonical = 0
  let longestKey = ''

  for (const key of keys) {
    const destination = resources[key]
    if (typeof destination !== 'string') {
      fail(`the destination for "${key}" must be a string (got ${JSON.stringify(destination)})`)
    }
    const canonical = canonicalResourceKey(key, appDir)
    // Every destination is copied VERBATIM: the installed layout is decided by the
    // destination and the tail stripped from the source, never by the source spelling.
    if (canonical !== key) {
      patch[canonical] = destination
      // RFC 7386: `null` deletes the relative key from the canonical configuration.
      // Without this the two spellings would BOTH survive the merge.
      patch[key] = null
    }
    mappings.push({ from: key, to: canonical, destination, unchanged: canonical === key })
    if (canonical.length > longestCanonical) {
      longestCanonical = canonical.length
      longestKey = canonical
    }
  }

  if (process.platform === 'win32' && longestCanonical > maxSourcePathLength) {
    fail(`canonical source "${longestKey}" is ${longestCanonical} characters, above the ${maxSourcePathLength}-character NSIS File limit; refusing to emit an override that would fail the compile`)
  }
  if (observedLongestPath !== null && observedLongestPath.length > maxSourcePathLength) {
    fail(`the longest canonical resource source is ${observedLongestPath.length} characters, above the ${maxSourcePathLength}-character NSIS File limit: ${observedLongestPath.path}`)
  }
  return {
    patch,
    mappings,
    longestCanonical,
    unchanged: mappings.every((mapping) => mapping.unchanged),
  }
}

/**
 * Apply an RFC 7386 JSON Merge Patch, exactly as `json_patch::merge` does for
 * `tauri-cli --config`: objects merge key by key, `null` deletes, everything else
 * (including arrays) replaces.
 *
 * @param target - the document to patch; mutated in place.
 * @param patch - the merge patch.
 * @returns the patched document.
 */
export function applyMergePatch(target, patch) {
  if (!isPlainObject(patch)) return patch
  if (!isPlainObject(target)) target = {}
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete target[key]
    } else if (isPlainObject(value)) {
      target[key] = applyMergePatch(isPlainObject(target[key]) ? target[key] : {}, value)
    } else {
      target[key] = value
    }
  }
  return target
}

/**
 * Build the `--config` object for the resource sources alone.
 *
 * The observer's override is deliberately NOT folded in here: `build.ps1` passes
 * it as its own `--config` argument and lets the CLI compose the two (Layer A),
 * because the patches touch disjoint keys and folding them here would mean
 * reimplementing the composition rule. Applying the result to a configuration
 * (Layer B) is the caller's job - see {@link applyMergePatch}.
 *
 * @param options.resources - the map from `tauri.conf.json`.
 * @param options.appDir - absolute directory holding `tauri.conf.json`.
 * @param options.maxSourcePathLength - override for the fail-closed length gate.
 * @param options.observedLongestPath - a measured `{ path, length }` source path.
 * @returns `{ override, mappings, longestCanonical, unchanged }`.
 */
export function buildBundleOverride({ resources, appDir, maxSourcePathLength, observedLongestPath }) {
  const { patch, mappings, longestCanonical, unchanged } = buildResourcePatch(resources, appDir, {
    maxSourcePathLength, observedLongestPath,
  })
  return { override: { bundle: { resources: patch } }, mappings, longestCanonical, unchanged }
}

function parseArguments(argv) {
  const options = { appDir: '', out: '', config: '' }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--app-dir', '--out', '--config'].includes(flag)) fail(`unknown argument ${flag}`)
    if (value === undefined || value.startsWith('--')) fail(`${flag} needs a value`)
    if (flag === '--app-dir') options.appDir = value
    if (flag === '--out') options.out = value
    if (flag === '--config') options.config = value
    index += 1
  }
  if (!options.appDir) fail('--app-dir is required')
  if (!options.out) fail('--out is required')
  return options
}

/**
 * CLI boundary. Returns a status instead of throwing so a refusal is one clean
 * line on stderr rather than a stack trace, matching the sibling helpers'
 * `runCli` convention.
 *
 * @param argv - process arguments including the two leading node/script entries.
 * @returns `{ code, message }`.
 */
export function runCli(argv) {
  try {
    const options = parseArguments(argv.slice(2))
    const appDir = resolve(options.appDir)
    const configPath = options.config ? resolve(options.config) : join(appDir, 'tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8'))
    const observedLongestPath = longestResourceSourcePath(config?.bundle?.resources, appDir)
    const { override, mappings, unchanged } = buildBundleOverride({
      resources: config?.bundle?.resources, appDir, observedLongestPath,
    })
    writeFileSync(options.out, `${JSON.stringify(override, null, 2)}\n`, { flag: 'wx' })
    const lines = mappings
      .filter((mapping) => !mapping.unchanged)
      .map((mapping) => `BUNDLE_RESOURCE_SOURCE canonical="${mapping.to}" (was "${mapping.from}") destination="${mapping.destination}"`)
    lines.push(`BUNDLE_RESOURCE_OVERRIDE out=${options.out} mappings=${mappings.length} `
      + `rewritten=${mappings.filter((mapping) => !mapping.unchanged).length} `
      + `unchanged=${unchanged ? 'yes' : 'no'} longestCanonicalSource=${observedLongestPath.length} `
      + `resourceFiles=${observedLongestPath.files}`)
    return { code: 0, message: lines.join('\n') }
  } catch (error) {
    return { code: 1, message: `bundle resource override: ${error.message}` }
  }
}

/* Real CLI boundary: a direct `node bundle-resource-override.mjs ...` invocation
 * runs the CLI and honours its exit code; an import (unit test, generator
 * consumer) never triggers it. */
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const invocation = runCli(process.argv)
  if (invocation.code === 0) {
    process.stdout.write(`${invocation.message}\n`)
  } else {
    process.stderr.write(`${invocation.message}\n`)
  }
  process.exit(invocation.code)
}
