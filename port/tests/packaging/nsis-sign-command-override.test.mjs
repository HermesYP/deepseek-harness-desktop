/**
 * Unit checks for the owned NSIS hash-observer override generator
 * (port/scripts/lib/nsis-sign-command-override.mjs) and for the contract the
 * s045r2+ helper expects from the observer invocation shape. Pure unit checks:
 * no bundler call, no registry, no installer lifecycle, no execution of the
 * recorder under test (only its source file is validated incoming). The CLI
 * boundary IS exercised as a real child process with a temporary owned out
 * file (no build, no signature, no registry writes).
 */
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SYSTEM_POWERSHELL_64,
  buildSignCommandOverride,
  resolveObserverCmd,
  runCli,
} from '../../scripts/lib/nsis-sign-command-override.mjs'

describe('resolveObserverCmd', () => {
  it('returns the canonical full-path 64-bit Windows PowerShell on win32', () => {
    assert.equal(SYSTEM_POWERSHELL_64, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    assert.equal(resolveObserverCmd('win32', () => true), SYSTEM_POWERSHELL_64)
  })
  it('refuses non-win32 hosts and an absent canonical PowerShell', () => {
    assert.throws(() => resolveObserverCmd('linux', () => true), /Windows build host/u)
    assert.throws(() => resolveObserverCmd('win32', () => false), /canonical 64-bit Windows PowerShell absent/u)
  })
})

describe('buildSignCommandOverride', () => {
  let fixtureRoot, observerScript, receiptRoot

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  const setupFixture = () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-sign-command-override-'))
    mkdirSync(join(fixtureRoot, 'receipts'))
    observerScript = join(fixtureRoot, 'hash-observer.ps1')
    writeFileSync(observerScript, 'ok\n', 'utf8')
    receiptRoot = join(fixtureRoot, 'receipts')
  }

  it('emits the supported signCommand observer invocation shape', () => {
    setupFixture()
    const override = buildSignCommandOverride({ observerScript, receiptRoot })
    assert.equal(override.$schema, 'https://schema.tauri.app/config/2')
    const signCommand = override.bundle.windows.signCommand
    assert.equal(signCommand.cmd, SYSTEM_POWERSHELL_64)
    assert.ok(isAbsolute(signCommand.cmd), 'observer cmd is a full system path, not a bare binary')
    const args = signCommand.args
    // Exactly one %1, second to last; the receipt root is the final arg.
    assert.equal(args.filter((a) => a === '%1').length, 1)
    assert.equal(args.at(-2), '%1')
    assert.equal(args.at(-1), receiptRoot)
    // Invocation stays PowerShell-safe and NSIS-flag-free.
    assert.deepEqual(args.slice(0, 4), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'])
    for (const flag of ['/P', '/UPDATE', '/R', '/NS']) {
      assert.ok(!args.includes(flag), `reserved flag ${flag} must never appear`)
    }
    assert.ok(isAbsolute(observerScript), 'observer path ships absolute')
    // The override survives a JSON round-trip unchanged (CLI/merge payload).
    assert.deepEqual(JSON.parse(JSON.stringify(override)), override)
  })

  it('refuses relative or missing recorder and relative or missing receipt root', () => {
    setupFixture()
    assert.throws(
      () => buildSignCommandOverride({ observerScript: 'installer/hash-observer.ps1', receiptRoot }),
      /absolute file path/u,
    )
    assert.throws(
      () => buildSignCommandOverride({ observerScript: join(fixtureRoot, 'absent.ps1'), receiptRoot }),
      /not found/u,
    )
    assert.throws(
      () => buildSignCommandOverride({ observerScript, receiptRoot: 'scratch\\receipts' }),
      /absolute directory path/u,
    )
    assert.throws(
      () => buildSignCommandOverride({ observerScript, receiptRoot: join(fixtureRoot, 'absent-dir') }),
      /not found/u,
    )
  })
})

describe('real CLI invocation (child process)', () => {
  let fixtureRoot, observerScript, receiptRoot

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  const setupFixture = () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'dsh-sign-command-cli-'))
    mkdirSync(join(fixtureRoot, 'receipts'))
    observerScript = join(fixtureRoot, 'hash-observer.ps1')
    writeFileSync(observerScript, 'ok\n', 'utf8')
    receiptRoot = join(fixtureRoot, 'receipts')
  }

  it('executes the module as a real CLI that writes a temporary owned out file', () => {
    setupFixture()
    const modulePath = fileURLToPath(new URL('../../scripts/lib/nsis-sign-command-override.mjs', import.meta.url))
    const outPath = join(fixtureRoot, 'override.json')
    const worked = spawnSync(process.execPath, [
      modulePath, '--recorder', observerScript, '--root', receiptRoot, '--out', outPath,
    ], { encoding: 'utf8' })
    assert.equal(worked.status, 0, `CLI failed: ${worked.stderr}`)
    assert.match(worked.stderr, /^$/u, 'the success path must stay silent on stderr')
    const override = JSON.parse(readFileSync(outPath, 'utf8'))
    assert.equal(override.bundle.windows.signCommand.cmd, SYSTEM_POWERSHELL_64)
    assert.equal(override.bundle.windows.signCommand.args.at(-2), '%1')
    // The out file uses wx semantics: a second CLI run is refused loudly.
    const refused = spawnSync(process.execPath, [
      modulePath, '--recorder', observerScript, '--root', receiptRoot, '--out', outPath,
    ], { encoding: 'utf8' })
    assert.equal(refused.status, 2)
    assert.match(refused.stderr, /refused to write/u)
  })

  it('exits 2 with usage on stderr when arguments are missing', () => {
    setupFixture()
    const modulePath = fileURLToPath(new URL('../../scripts/lib/nsis-sign-command-override.mjs', import.meta.url))
    const refuse = spawnSync(process.execPath, [modulePath, '--recorder', observerScript], { encoding: 'utf8' })
    assert.equal(refuse.status, 2)
    assert.match(refuse.stderr, /usage:/u)
  })
})
