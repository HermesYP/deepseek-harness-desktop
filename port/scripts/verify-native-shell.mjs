// Exercise the exact raw JavaScript constants shipped by the native shell.
// These VM fixtures do not qualify WebView2, real DOM drops, or installed UI.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function scriptFrom(file, name) {
  const source = readFileSync(new URL(`../src-tauri/app/src/${file}`, import.meta.url), 'utf8')
  const match = source.match(new RegExp(`pub const ${name}: &str = r#"([\\s\\S]*?)"#;`))
  assert.ok(match, `Missing raw script ${name}`)
  return match[1]
}

function environment(extra = {}) {
  const listeners = new Map()
  const context = vm.createContext({
    ...extra,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail } },
    dispatchEvent(event) { for (const listener of listeners.get(event.type) ?? []) listener(event) },
    addEventListener(type, listener) {
      const list = listeners.get(type) ?? []
      list.push(listener)
      listeners.set(type, list)
    },
  })
  context.window = context
  return context
}

let assertions = 0
function equal(actual, expected) { assert.deepEqual(actual, expected); assertions += 1 }
const pathScript = scriptFrom('native_paths.rs', 'HOST_PATHS_SCRIPT')
let now = 1000
const paths = environment({ Date: { now: () => now } })
vm.runInContext(pathScript, paths)
const api = paths.__DSH_HOST_PATHS__
const file = new File(['one'], 'one.txt')
api.adopt(['C:\\drop\\one.txt'])
equal(api.pathFor(file), '') // A name alone is not a native-file association.
paths.dispatchEvent({ type: 'drop', dataTransfer: { files: [file] } })
equal(api.pathFor(file), 'C:\\drop\\one.txt')
equal(Array.from(api.pending()), [])
equal(api.pathFor(new File(['paste'], 'one.txt')), '')
equal(api.pathFor(file), 'C:\\drop\\one.txt') // Identity survives intake.

api.adopt(['C:\\first\\one.txt', 'C:\\second\\one.txt'])
paths.dispatchEvent({ type: 'drop', dataTransfer: { files: [file] } })
equal(api.pathFor(file), '') // Ambiguous native basenames never use guessed order.
api.adopt(['C:\\drop\\one.txt'])
const duplicate = new File(['two'], 'one.txt')
paths.dispatchEvent({ type: 'drop', dataTransfer: { files: [file, duplicate] } })
equal(api.pathFor(file), '')
equal(api.pathFor(duplicate), '')
api.adopt(['C:\\drop\\one.txt'])
now += 5001
paths.dispatchEvent({ type: 'drop', dataTransfer: { files: [file] } })
equal(api.pathFor(file), '')
equal(Array.from(api.pending()), [])
api.adopt(['C:\\drop\\one.txt'])
api.consume()
paths.dispatchEvent({ type: 'drop', dataTransfer: { files: [file] } })
equal(api.pathFor(file), '')
api.adopt(['C:\\drop\\one.txt'])
paths.dispatchEvent({ type: 'drop', dataTransfer: { files: [file] } })
paths.dispatchEvent({ type: 'pagehide' })
equal(api.pathFor(file), '')
equal(Array.from(api.pending()), [])
vm.runInContext(pathScript, paths)
equal(paths.__DSH_HOST_PATHS__, api) // Idempotent installation.

const consoleScript = scriptFrom('renderer_bridge.rs', 'SCRIPT')
const timers = []
const invocations = []
const originalCalls = []
const settlements = []
const consoleEnv = environment({
  location: { origin: 'http://127.0.0.1:54321' },
  console: { error(...args) { originalCalls.push(args); return 'original-result' } },
  setTimeout(callback) { timers.push(callback); return timers.length },
  __TAURI_INTERNALS__: {
    invoke(command, request) {
      invocations.push({ command, request })
      return new Promise(resolve => settlements.push(resolve))
    },
  },
})
const settleMicrotasks = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve() }
vm.runInContext(consoleScript, consoleEnv)
equal(consoleEnv.console.error('first'), 'original-result')
for (let i = 0; i < 40; i += 1) consoleEnv.console.error(`line-${i}`)
equal(originalCalls.length, 41)
equal(timers.length, 1)
timers.shift()()
await settleMicrotasks()
equal(invocations.length, 1)
equal(invocations[0].command, 'shell_renderer_console')
equal(invocations[0].request.lines.length, 32)
equal(invocations[0].request.lines[0].message, 'line-8')
equal(invocations[0].request.lines[31].message, 'line-39')
consoleEnv.console.error('next')
equal(timers.length, 0) // One flight until the prior IPC settles.
settlements.shift()()
await settleMicrotasks()
equal(timers.length, 1)
timers.shift()()
await settleMicrotasks()
equal(invocations.length, 2)
equal(invocations[1].request.lines[0].message, 'next')
settlements.shift()()
await settleMicrotasks()
consoleEnv.dispatchEvent({ type: 'error', message: 'uncaught', lineno: 1e30 })
consoleEnv.dispatchEvent({ type: 'unhandledrejection', reason: 'rejected' })
consoleEnv.console.error('x'.repeat(20000))
timers.shift()()
await settleMicrotasks()
equal(invocations[2].request.lines[0].line, 0)
equal(invocations[2].request.lines[0].sourceId, consoleEnv.location.origin)
equal(invocations[2].request.lines[1].message, 'rejected')
equal(invocations[2].request.lines[2].message.length, 8192)
settlements.shift()()
await settleMicrotasks()
vm.runInContext(consoleScript, consoleEnv)
consoleEnv.__TAURI_INTERNALS__.invoke = () => { throw new Error('synchronous IPC failure') }
consoleEnv.console.error('no recursion')
timers.shift()()
await settleMicrotasks()
equal(timers.length, 0)
equal(originalCalls.at(-1)[0], 'no recursion')
console.log(`Native shell VM fixtures: ${assertions} assertions passed (not native qualification).`)
