/**
 * Unit regressions for the port adapter's platform-session publisher
 * (`port/src-tauri/runtime/adapter.mjs` — the transcription of upstream
 * `apps/desktop-host/src/platform-session.ts` at dsh-v0.2.1-alpha.3).
 *
 * The REAL shipped function is extracted from the adapter source by its unique
 * anchors and evaluated in an isolated VM context; the adapter module itself is
 * NEVER imported or executed (its top level requires desktop control-socket
 * environment variables and would exit this process).
 *
 * The fake host is cordis-shaped for this function only: `ctx.inject(groups,
 * consumer)` runs the consumer synchronously with an account context whose
 * `effect(factory)` invokes the factory and records the returned disposer, and
 * whose `logger(name)` records warnings. The fake account's `watch` is a
 * manually paced async generator that observes its caller-owned signal —
 * park/release advance one consumer loop iteration at a time and an abort wakes
 * the parked generator the way the real Host signal does — so every scenario is
 * deterministic and bounded (microtask flushes only, no wall-clock waits).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adapterSource = readFileSync(join(port, 'src-tauri', 'runtime', 'adapter.mjs'), 'utf8')

/** Extract the REAL publisher definition between unique anchors. */
function extractPublisher() {
  const marker = 'function installPlatformSessionPublisher(ctx, publish) {'
  const first = adapterSource.indexOf(marker)
  assert.notEqual(first, -1, 'adapter.mjs must declare installPlatformSessionPublisher(ctx, publish)')
  assert.equal(adapterSource.indexOf(marker, first + 1), -1, 'the publisher definition must be unique')
  const bodyEnd = adapterSource.indexOf('\n}', first)
  assert.notEqual(bodyEnd, -1, 'the publisher definition must terminate at a column-0 closing brace')
  const body = adapterSource.slice(first, bodyEnd + 2)
  assert.ok(body.startsWith(marker), 'extraction must begin at the definition')
  assert.ok(body.trimEnd().endsWith('}'), 'extraction must end at the closing brace')
  // Import-free: the function reaches only for ctx/account/publish, never
  // module bindings, the environment, or the adapter's control channel.
  assert.doesNotMatch(body, /(^|[^.\w])import\b|require\(|process\.env|\bsend\(/, 'the extracted publisher must be self-contained')
  assert.match(body, /account\.watch\(lifetime\.signal, true\)/, 'the port must subscribe with includeIdentityChanges=true')
  assert.match(body, /await updates/, 'the disposer must await the subscription unwind')
  assert.doesNotMatch(body, /void updates/, 'the alpha.2 fire-and-forget disposal must be gone')
  return body
}

// The script runs in THIS realm (runInThisContext), not a new VM context: the
// fake host's cross-realm array literals would otherwise be declared unequal by
// Node's deepEqual even when structurally identical. The code is still only the
// anchor-verified, import-free function expression extracted above.
const publisherFunction = new vm.Script(`(${extractPublisher()})`).runInThisContext()

const flush = () => new Promise((done) => { setImmediate(done) })

/**
 * A manually paced account. Every `watch(signal, includeIdentityChanges)` call
 * owns a generator version; `openIteration()` advances exactly one consumer
 * loop iteration (a pending getPlatformSession read can be held open across a
 * disposal via `holdGet`). An abort wakes the parked generator the way the real
 * Host signal does; the account's provider lifetime is always independent.
 */
class FakeAccount {
  constructor() {
    this.provider = new AbortController()
    this.watchCalls = []
    this.cleanedUp = new Map()
    this.sessionQueue = []
    this.getPlatformCalls = []
    this.heldGet = undefined
    this.nextFailure = undefined
    this.releaseWaits = []
  }

  getPlatformSession() {
    this.getPlatformCalls.push(this.watchCalls.length)
    const held = this.heldGet
    this.heldGet = undefined
    if (held !== undefined) return held.promise.then(() => this.sessionQueue.shift())
    return Promise.resolve(this.sessionQueue.shift())
  }

  watch(signal, includeIdentityChanges) {
    const self = this
    this.watchCalls.push({ signal, includeIdentityChanges })
    const id = this.watchCalls.length - 1
    this.cleanedUp.set(id, false)
    async function* pacer() {
      try {
        while (true) {
          if (signal.aborted) return
          await new Promise((wake) => {
            const onAbort = () => { signal.removeEventListener('abort', onAbort); wake() }
            signal.addEventListener('abort', onAbort, { once: true })
            self.releaseWaits.push(() => { signal.removeEventListener('abort', onAbort); wake() })
          })
          if (signal.aborted) return
          const failure = self.nextFailure
          self.nextFailure = undefined
          if (failure !== undefined) throw failure
          yield { state: 'wake' }
        }
      } finally {
        self.cleanedUp.set(id, true)
      }
    }
    return pacer()
  }

  /** Close exactly one consumer iteration; return a promise that settles the iteration. */
  openIteration({ session, holdGet, failure } = {}) {
    if (session !== undefined) this.sessionQueue.push(session)
    const held = holdGet
    const scheduledFailure = failure
    return async () => {
      assert.ok(this.releaseWaits.length > 0, 'the subscription must be parked awaiting a pull')
      if (held !== undefined) this.heldGet = held
      if (scheduledFailure !== undefined) this.nextFailure = scheduledFailure
      const wake = this.releaseWaits.shift()
      wake()
      await flush()
      if (held !== undefined) await flush()
    }
  }

  failOnNextPull(error) { this.nextFailure = error }
}

/** A minimal cordis-facet host for this function only. */
function makeHost(account) {
  const log = []
  const host = {
    log,
    account,
    published: [],
    warns: [],
    disposers: [],
    publish(value) {
      host.published.push(value === null ? null : { ...value })
      log.push(`publish:${value === null ? 'null' : value.version ?? 'unknown'}`)
    },
    ctx: {
      inject: (groups, consumer) => {
        assert.deepEqual(groups, ['deepseekAccount'])
        return consumer({
          deepseekAccount: account,
          effect: (factory) => {
            const disposer = factory()
            host.disposers.push(disposer)
            return disposer
          },
          logger: (name) => ({ warn: (line) => {
            host.warns.push({ name, line })
            log.push(`warn:${name}`)
          } }),
        })
      },
    },
  }
  return host
}

/** Install the REAL function; exactly one effect disposer must be created. */
function install(host) {
  let captured
  publisherFunction(host.ctx, host.publish)
  captured = host.disposers.at(-1)
  assert.ok(captured, 'the effect factory must return a disposer')
  assert.equal(host.disposers.length, 1, 'exactly one subscription disposer')
  return captured
}

const sessionOf = (version) => ({
  version,
  origin: 'https://platform.deepseek.com',
  token: `fixture-token-${version}`,
  userId: `fixture-user-${version}`,
  requestHeaders: {},
})

test('extraction pins the shipped alpha.3 semantics before behavior checks', () => {
  extractPublisher()
})

test('subscribes with includeIdentityChanges=true and rotates published sessions', async () => {
  const host = makeHost(new FakeAccount())
  const dispose = install(host)
  const account = host.account
  assert.equal(account.watchCalls.length, 1, 'exactly one subscription')
  assert.equal(account.watchCalls[0].includeIdentityChanges, true, 'identity-only wakeups must be subscribed')

  await account.openIteration({ session: sessionOf(1) })()
  assert.deepEqual(host.published, [sessionOf(1)], 'the first wake publishes the session')

  await account.openIteration({ session: sessionOf(2) })()
  assert.deepEqual(host.published, [sessionOf(1), sessionOf(2)], 'the second wake publishes the rotation')

  assert.equal(account.provider.signal.aborted, false, 'the provider lifetime is independent')
  assert.equal(account.cleanedUp.get(0), false, 'the subscription is still live')
  assert.equal(typeof dispose, 'function')
})

test('disposal aborts, clears the private session immediately, and never publishes the parked rotation', async () => {
  const host = makeHost(new FakeAccount())
  const dispose = install(host)
  const account = host.account
  assert.equal(account.watchCalls.length, 1, 'one subscription at install time')
  const version1 = sessionOf(1)
  await account.openIteration({ session: version1 })()
  assert.deepEqual(host.published, [version1])

  // The next credential read is parked mid-flight while disposal runs: launch
  // the iteration, then wait until the publisher's read has ACTUALLY entered
  // its getPlatformSession call before disposing.
  const heldGet = deferredResolve()
  const settleIteration = account.openIteration({ session: sessionOf(2), holdGet: heldGet })()
  await awaitCredentialCall(account, 2)
  assert.deepEqual(host.published, [version1], 'the parked rotation cannot publish while its read is held')

  const disposePromise = dispose()
  await flush()
  assert.equal(host.log.includes('publish:null'), true, 'the private session clear is immediate after the abort')
  assert.equal(host.account.provider.signal.aborted, false, 'the provider lifetime stays independent of disposal')
  assert.equal(account.cleanedUp.get(0), false, 'the held read keeps the subscription unwound-free while pending')

  // Release the held read: the post-abort guard must drop the rotated session.
  heldGet.resolve('released')
  await settleIteration
  assert.equal(await isSettled(disposePromise), true, 'disposal completes only after the unwind')
  assert.equal(account.cleanedUp.get(0), true, 'the disposer awaited the subscription cleanup')
  assert.deepEqual(host.published, [version1, null], 'the last publication is the immediate clear')
})

test('subscription failures warn and clear; the provider lifetime stays independent', async () => {
  const host = makeHost(new FakeAccount())
  const dispose = install(host)
  const account = host.account
  assert.equal(account.watchCalls.length, 1, 'one subscription at install time')
  const failure = new Error('fixture subscription failure')
  account.failOnNextPull(failure)
  await account.openIteration({ failure })()
  await flush()
  assert.deepEqual(host.published, [null], 'a failed subscription publishes the clear while not aborted')
  assert.equal(host.warns.length, 1, 'exactly one warning')
  assert.equal(host.warns[0].name, 'desktop-platform', 'the warning names the desktop-platform channel')
  assert.equal(host.warns[0].line, 'Account session subscription failed', 'the warning carries the upstream message')

  await dispose()
  assert.equal(account.cleanedUp.get(0), true, 'disposal still unwinds the failed subscription')
  assert.equal(account.provider.signal.aborted, false)
  assert.deepEqual(host.published, [null, null], 'an aborted subscription still clears the session')
  assert.equal(typeof dispose, 'function')
})

test('provider lifetime independence across two subscriptions', async () => {
  const account = new FakeAccount()
  const hostOne = makeHost(account)
  const hostTwo = makeHost(account)
  const disposeOne = install(hostOne)
  const disposeTwo = install(hostTwo)
  assert.equal(account.watchCalls.length, 2, 'two independent subscriptions share the provider')
  assert.equal(account.watchCalls.every(entry => entry.includeIdentityChanges === true), true)

  await account.openIteration({ session: sessionOf(1) })()
  assert.equal(hostOne.published.length, 1)
  assert.equal(hostTwo.published.length, 0, 'each host owns its own publication channel')

  await disposeOne()
  assert.equal(account.provider.signal.aborted, false, 'disposing one publisher never aborts the provider')
  assert.equal(account.cleanedUp.get(0), true, 'the disposed subscription unwound')
  assert.equal(account.cleanedUp.get(1), false, 'the surviving subscription is untouched')

  await account.openIteration({ session: sessionOf(2) })()
  assert.deepEqual(hostTwo.published, [sessionOf(2)], 'the surviving publisher keeps rotating sessions')
  assert.equal(typeof disposeTwo, 'function')
})

function deferredResolve() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

/**
 * Flush until the publisher's credentials read has actually entered its
 * `getPlatformSession` call (bounded, so a wedged host fails instead of hanging).
 */
async function awaitCredentialCall(account, count) {
  for (let spins = 0; spins < 500 && account.getPlatformCalls.length < count; spins += 1) {
    await flush()
  }
}

async function isSettled(promise) {
  let settled = false
  await promise.then(() => { settled = true }, () => { settled = true })
  return settled
}

async function flushMicrotasks(count) {
  for (let index = 0; index < count; index += 1) await flush()
}
