/**
 * Owned NSIS hash-observer override generator (s045 prep; source + unit checks
 * only - nothing runs a bundle).
 *
 * Generates the SUPPORTED `bundle > windows > signCommand` config override so
 * the canonical tauri.conf.json stays untouched and the original build flow is
 * kept intact: `cargo tauri build --no-bundle` (locked, JSON contract stream)
 * -> resource guard -> `cargo tauri bundle --config <override>` ONLY. The
 * override is packaging config passed via the CLI merge flag; no policy bypass,
 * no canonical config change, no other hook.
 *
 * The recorder is the NON-MUTATING hash observer (port/installer/hash-observer.ps1):
 * it hashes every invoked PE file, appends one JSONL receipt per invocation into
 * the owned receipt root, preserves a copy of the NSIS uninstaller temp file
 * only when identifiable (basename uninstall.exe / un.exe; otherwise
 * classification stays 'unknown'), and NEVER claims or produces signatures -
 * unsigned bytes stay unsigned (mode 'observer-only').
 *
 * Launcher proposal (parent-reviewed before any wiring into build.ps1):
 *
 *   $observerOverride = Join-Path $Scratch 'nsis-hash-observer-override.json'
 *   node scripts\lib\nsis-sign-command-override.mjs \
 *     --recorder (Join-Path $PortRoot 'installer\hash-observer.ps1') \
 *     --root (Join-Path $Scratch 'nsis-hash-observer-receipts') \
 *     --out $observerOverride
 *   Invoke-Checked 'cargo' @('tauri','bundle','--config',$observerOverride) $TauriDir
 *
 * Provenance expectations (per NSIS `!uninstfinalize` + tauri-bundler 2.9.4
 * sign.rs:135-159): tauri substitutes `%1` on every invocation; for the NSIS
 * finalizer pass it is the freshly compiled uninstaller, so the receipt root
 * gains its preserved copy plus its SHA256 line - the digest the parent can
 * pin as the helper's expected uninstaller hash.
 */

import { existsSync, writeFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Invoke-able observer command: the CANONICAL 64-bit Windows PowerShell.
 * A full, well-known system path (never a bare binary name resolved from an
 * ambient PATH) is the trust prefix for the custom sign-command surface. */
export const SYSTEM_POWERSHELL_64 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * @param {string} [platform] - process platform; defaults to the live value.
 * @param {(path: string) => boolean} [exists] - existence probe (unit-injectable).
 * @returns {string} the canonical full-path observer command.
 */
export function resolveObserverCmd(platform = process.platform, exists = existsSync) {
  if (platform !== 'win32') {
    throw new Error('the owned NSIS bundle requires the Windows build host')
  }
  if (!exists(SYSTEM_POWERSHELL_64)) {
    throw new Error(`canonical 64-bit Windows PowerShell absent: ${SYSTEM_POWERSHELL_64}`)
  }
  return SYSTEM_POWERSHELL_64
}

/* Reserved NSIS flags the observer invocation must never carry. */
const RESERVED_FLAGS = ['/P', '/UPDATE', '/R', '/NS']

/**
 * @param {string} observerScript - absolute path to hash-observer.ps1.
 * @param {string} receiptRoot - absolute owned receipt directory.
 * @returns {object} override config for `tauri bundle --config`.
 */
export function buildSignCommandOverride({ observerScript, receiptRoot }) {
  if (!observerScript || !isAbsolute(observerScript)) {
    throw new Error('observerScript must be an absolute file path')
  }
  if (!receiptRoot || !isAbsolute(receiptRoot)) {
    throw new Error('receiptRoot must be an absolute directory path')
  }
  if (!existsSync(observerScript)) {
    throw new Error(`observer script not found: ${observerScript}`)
  }
  if (!existsSync(receiptRoot)) {
    throw new Error(`receipt root not found: ${receiptRoot}`)
  }
  const args = [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', observerScript,
    '%1', receiptRoot,
  ]
  if (args.filter((a) => a === '%1').length !== 1) {
    throw new Error('override must invoke exactly one %1 placeholder')
  }
  for (const flag of RESERVED_FLAGS) {
    if (args.some((a) => a === flag)) {
      throw new Error(`reserved NSIS flag refused in override args: ${flag}`)
    }
  }
  const observerCmd = resolveObserverCmd()
  return {
    $schema: 'https://schema.tauri.app/config/2',
    bundle: {
      windows: {
        signCommand: {
          cmd: observerCmd,
          args,
        },
      },
    },
  }
}

function parseArgs(argv) {
  const wanted = { recorder: undefined, root: undefined, out: undefined }
  for (let i = 2; i < argv.length; i += 1) {
    switch (argv[i]) {
      case '--recorder': wanted.recorder = argv[i + 1]; i += 1; break
      case '--root': wanted.root = argv[i + 1]; i += 1; break
      case '--out': wanted.out = argv[i + 1]; i += 1; break
      default: throw new Error(`unrecognized argv: ${argv[i]}`)
    }
  }
  return wanted
}

/** CLI boundary (pure, unit-testable): returns { code, message }.
 * @param {string[]} argv - raw process.argv including argv[0..1]. */
export function runCli(argv) {
  let wanted
  try {
    wanted = parseArgs(argv)
  } catch (error) {
    return { code: 2, message: String(error.message) }
  }
  if (!wanted.recorder || !wanted.root) {
    return { code: 2, message: 'usage: --recorder <path> --root <absolute dir> [--out <file>]' }
  }
  let override
  try {
    override = buildSignCommandOverride({ observerScript: wanted.recorder, receiptRoot: wanted.root })
  } catch (error) {
    return { code: 2, message: String(error.message) }
  }
  const output = `${JSON.stringify(override, null, 2)}\n`
  if (wanted.out) {
    try {
      writeFileSync(wanted.out, output, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      return { code: 2, message: `refused to write override (exists or unwritable): ${String(error.message)}` }
    }
    return { code: 0, message: `override written: ${resolve(wanted.out)}` }
  }
  return { code: 0, message: output.trimEnd() }
}

/* Real CLI boundary: a direct `node nsis-sign-command-override.mjs ...`
 * invocation executes runCli and honors its exit code on stdout/stderr; an
 * import (unit test, generator consumer) never triggers the CLI. */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const invocation = runCli(process.argv)
  if (invocation.code === 0) {
    process.stdout.write(`${invocation.message}\n`)
  } else {
    process.stderr.write(`${invocation.message}\n`)
  }
  process.exit(invocation.code)
}
