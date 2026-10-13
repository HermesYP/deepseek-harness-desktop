/**
 * Behavioural tests for the generated `port/.upstream` junction.
 *
 * The shell build reads upstream sources through that junction with static
 * specifiers, so the linker is what decides which checkout the port's own UI
 * build actually reads. These tests run the real linker against throwaway
 * fixtures and assert its observable behaviour, not its source text:
 *
 *   * it creates the junction and the toolchain links against the selected root;
 *   * re-running it with a DIFFERENT root repoints them;
 *   * the previously referenced checkout is left completely intact, because the
 *     unlink is non-recursive and must never follow the junction;
 *   * an ordinary directory at the generated path is refused and NOT deleted;
 *   * a root that is not a checkout fails the post-condition.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const linkerSource = join(port, 'ui', 'link-toolchain.ps1')
const powershell = process.env.DSH_PACKAGING_POWERSHELL
  ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

/** A throwaway repository whose only upstream input is a marker-bearing checkout. */
function fixture(marker) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-upstream-link-'))
  const repo = join(root, 'repo')
  const ui = join(repo, 'port', 'ui')
  mkdirSync(ui, { recursive: true })
  cpSync(linkerSource, join(ui, 'link-toolchain.ps1'))
  const upstream = join(root, marker)
  mkdirSync(join(upstream, 'apps', 'web', 'node_modules', 'vite'), { recursive: true })
  mkdirSync(join(upstream, 'node_modules', 'jsdom'), { recursive: true })
  writeFileSync(join(upstream, 'package.json'), JSON.stringify({ name: marker, version: '1.0.0' }))
  // Sentinels prove the referenced checkout survives a repoint.
  writeFileSync(join(upstream, 'apps', 'web', 'node_modules', 'vite', 'marker.txt'), marker)
  writeFileSync(join(upstream, 'node_modules', 'jsdom', 'marker.txt'), marker)
  return { root, repo, ui, upstream, link: join(repo, 'port', '.upstream') }
}

function runLinker(ui, upstreamRoot) {
  return spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    join(ui, 'link-toolchain.ps1'), '-UpstreamRoot', upstreamRoot,
  ], { encoding: 'utf8' })
}

const junctionTarget = path => realpathSync(path)
const isLink = path => lstatSync(path).isSymbolicLink()

test('the linker points the generated junction and the toolchain at the selected root', () => {
  const first = fixture('upstream-alpha')
  const result = runLinker(first.ui, first.upstream)
  assert.equal(result.status, 0, `the linker must succeed: ${result.stdout}${result.stderr}`)
  assert.ok(isLink(first.link), 'the generated path is a link, not a real directory')
  assert.equal(junctionTarget(first.link), realpathSync(first.upstream), 'the junction resolves to the selected root')
  assert.equal(
    readFileSync(join(first.link, 'package.json'), 'utf8'),
    readFileSync(join(first.upstream, 'package.json'), 'utf8'),
    'the junction is readable as the selected checkout')
  const vite = join(first.ui, 'node_modules', 'vite')
  assert.ok(isLink(vite), 'a toolchain package is linked, not copied')
  assert.equal(junctionTarget(vite), realpathSync(join(first.upstream, 'apps', 'web', 'node_modules', 'vite')))
  assert.match(result.stdout, /from /, 'the selected root is reported')
})

test('re-running with a different root repoints it and destroys nothing', () => {
  const first = fixture('upstream-alpha')
  const second = fixture('upstream-beta')
  assert.equal(runLinker(first.ui, first.upstream).status, 0)
  const result = runLinker(first.ui, second.upstream)
  assert.equal(result.status, 0, `the linker must succeed: ${result.stdout}${result.stderr}`)
  assert.equal(junctionTarget(first.link), realpathSync(second.upstream), 'the junction follows the new root')
  assert.equal(
    junctionTarget(join(first.ui, 'node_modules', 'vite')),
    realpathSync(join(second.upstream, 'apps', 'web', 'node_modules', 'vite')),
    'the toolchain link follows the new root')

  // The previous checkout must be untouched: a recursive delete through the
  // junction would have destroyed it.
  assert.equal(
    readFileSync(join(first.upstream, 'apps', 'web', 'node_modules', 'vite', 'marker.txt'), 'utf8'),
    'upstream-alpha',
    'the previously referenced checkout still holds its content')
  assert.equal(
    readFileSync(join(first.upstream, 'node_modules', 'jsdom', 'marker.txt'), 'utf8'),
    'upstream-alpha',
    'the previously referenced root package still holds its content')
  assert.ok(existsSync(join(first.upstream, 'package.json')), 'the previous root manifest survives')
})

test('an ordinary directory at the generated path is refused and never deleted', () => {
  const first = fixture('upstream-alpha')
  // Pre-create the generated path as a REAL directory holding a sentinel.
  mkdirSync(first.link, { recursive: true })
  const sentinel = join(first.link, 'sentinel.txt')
  writeFileSync(sentinel, 'must survive')
  const result = runLinker(first.ui, first.upstream)
  assert.notEqual(result.status, 0, 'the linker must refuse rather than replace it')
  assert.match(`${result.stdout}${result.stderr}`, /ordinary directory/, 'the refusal names the cause')
  assert.ok(existsSync(sentinel), 'the sentinel was not deleted')
  assert.equal(readFileSync(sentinel, 'utf8'), 'must survive')
  assert.ok(!isLink(first.link), 'the real directory is still a real directory')
})

test('a root that is not a checkout fails the canonical post-condition', () => {
  const first = fixture('upstream-alpha')
  const notACheckout = join(first.root, 'not-a-checkout')
  mkdirSync(join(notACheckout, 'apps', 'web', 'node_modules', 'vite'), { recursive: true })
  const result = runLinker(first.ui, notACheckout)
  assert.notEqual(result.status, 0, 'a root with no root manifest must not pass as a checkout')
  assert.match(`${result.stdout}${result.stderr}`, /does not resolve to a checkout/, 'the failure names the missing checkout')
})
