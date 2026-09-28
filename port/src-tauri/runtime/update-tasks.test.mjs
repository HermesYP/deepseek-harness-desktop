import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Evaluate the actual function declarations from adapter.mjs without booting
// its socket or desktop runtime. This fixture cannot drift into a reimplementation.
const adapterSource = readFileSync(new URL('./adapter.mjs', import.meta.url), 'utf8')
const start = adapterSource.indexOf('/** Shared update-restart work rule')
const end = adapterSource.indexOf('/** Platform-session publisher', start)
assert.notEqual(start, -1)
assert.notEqual(end, -1)
const productionHelpers = vm.runInNewContext(
  `${adapterSource.slice(start, end)}; ({ hasDesktopActiveTasks, installDesktopUpdateTaskControl })`,
  { Promise, Set, Error },
)
const { hasDesktopActiveTasks, installDesktopUpdateTaskControl } = productionHelpers

function fixture() {
  const services = {
    agents: { list: () => [] },
    jobs: { list: () => [] },
  }
  let requestHandler
  const ctx = {
    effect() {},
    get: (name) => services[name],
    on: (event, handler) => { if (event === 'connection/request') requestHandler = handler },
  }
  const updateTasks = installDesktopUpdateTaskControl(ctx)
  const request = (next = async () => {}) => {
    const result = { status: 200, ended: false }
    const response = {
      writeHead(status) { result.status = status },
      end() { result.ended = true },
    }
    return Promise.resolve(requestHandler({}, response, next)).then(() => result)
  }
  return { updateTasks, request }
}

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

test('active-task predicate is the production adapter helper', () => {
  assert.equal(hasDesktopActiveTasks([], { list: () => [] }), false)
  assert.equal(hasDesktopActiveTasks([
    { id: 'a', status: 'running', inbox: { nextTurn: [], nextStep: [] } },
  ], { list: () => [] }), true)
})

test('deadline rollback survives late completion of admitted request', async () => {
  const { updateTasks, request } = fixture()
  const admitted = deferred()
  const admittedResponse = request(() => admitted.promise)
  const locking = updateTasks('lock')
  const deadline = await Promise.race([
    locking.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('deadline exceeded'), 10)),
  ])
  assert.equal(deadline, 'deadline exceeded')

  // Rust's admission-error rollback sends unlock when its 10 s control request
  // times out. The original middleware request is still outstanding here.
  await updateTasks('unlock')
  admitted.resolve()
  await admittedResponse
  await assert.rejects(locking, /superseded/)
  const afterLateCompletion = await request()
  assert.equal(afterLateCompletion.status, 200)
  console.log(JSON.stringify({ deadline, statusAfterOriginalRequestFinishes: afterLateCompletion.status }))
})
