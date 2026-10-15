/**
 * The Desktop Host invocation and application origin the port's adapter publishes.
 *
 * These are source checks on purpose. `port/src-tauri/runtime/adapter.mjs` is a
 * single-file entry point with top-level side effects (it opens the control
 * socket and boots the profile), and it imports only Node builtins and upstream
 * packages, so a test cannot import it and there is no sibling module to extract
 * the origin helper into without changing what the payload stages. The behaviour
 * is exercised by the adapter integration and staged lanes, which run the real
 * adapter against a real staged payload.
 *
 * They pin the two production drifts found against the newest Desktop Host:
 * the invocation args, and the listener protocol the origin is built from.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const port = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const adapter = readFileSync(join(port, 'src-tauri', 'runtime', 'adapter.mjs'), 'utf8')
const hostSource = join(port, '..', '_upstream', 'apps', 'desktop-host', 'src', 'index.ts')

test('the adapter asks for a loopback listener on an OS-assigned port', () => {
  assert.match(adapter, /args: \['--no-open', '--host', '127\.0\.0\.1', '--port', '0'\]/,
    'the invocation matches the newest Desktop Host: loopback plus an ephemeral port')
  assert.ok(!adapter.includes('19387'),
    'the fixed port is gone; it collided with whatever process already owned it')
  assert.ok(!/'--port',\s*'[1-9]\d*'/.test(adapter),
    'no fixed non-zero port may be requested; port 0 is the ephemeral request')
})

test('the application origin is built from the listener protocol, not assumed', () => {
  assert.match(adapter, /ctx\.connection\.authenticatedUrl\(loopbackApplicationOrigin\(ctx\.webServer\)\)/,
    'the origin comes from the validated helper, not an inline literal')
  assert.ok(!adapter.includes('`http://127.0.0.1:${String(ctx.webServer.port)}`'),
    'the hardcoded http scheme is gone: a TLS listener would have published the wrong scheme')
  assert.match(adapter, /const protocol = webServer\?\.protocol/,
    'the listener protocol is read from the Host service')
})

test('an unsupported protocol or unusable port refuses instead of publishing a guess', () => {
  assert.match(adapter, /protocol !== 'http:' && protocol !== 'https:'/,
    'only the two schemes the webserver service can report are accepted')
  assert.match(adapter, /refusing to publish an application URL/,
    'the refusal is explicit rather than a silently wrong URL')
  assert.match(adapter, /!Number\.isInteger\(port\) \|\| port <= 0 \|\| port > 65535/,
    'a port the listener could not have been bound to is refused too')
  assert.match(adapter, /return `\$\{protocol\}\/\/127\.0\.0\.1:\$\{String\(port\)\}`/,
    'the returned origin keeps the reported scheme and stays loopback-only')
})

/** The adapter's origin helper, evaluated from its real source. */
function loadOriginHelper() {
  const start = adapter.indexOf('function loopbackApplicationOrigin(')
  assert.ok(start >= 0, 'the adapter still declares loopbackApplicationOrigin')
  const end = adapter.indexOf('\n}\n', start)
  assert.ok(end > start, 'the helper body is closed')
  const source = adapter.slice(start, end + 3)
  // Executing the real extracted function keeps this behavioural: the adapter
  // itself cannot be imported (top-level side effects, no sibling module).
  return new Function(`${source}\nreturn loopbackApplicationOrigin`)()
}

test('a refusal never echoes the observed service value into diagnostics', () => {
  const origin = loadOriginHelper()

  assert.equal(origin({ protocol: 'http:', port: 41234 }), 'http://127.0.0.1:41234')
  assert.equal(origin({ protocol: 'https:', port: 443 }), 'https://127.0.0.1:443')

  // A sentinel stands in for whatever a malformed or substituted service returns.
  const protocolSentinel = 'SENTINEL-PROTOCOL-9f3c1a'
  const portSentinel = 'SENTINEL-PORT-5b7e20'
  for (const [label, service] of [
    ['an unsupported protocol', { protocol: protocolSentinel, port: 41234 }],
    ['a missing protocol', {}],
    ['a non-numeric port', { protocol: 'http:', port: portSentinel }],
    ['a zero port', { protocol: 'http:', port: 0 }],
    ['an out-of-range port', { protocol: 'http:', port: 70000 }],
  ]) {
    assert.throws(
      () => origin(service),
      error => {
        assert.ok(error instanceof Error, `${label} must raise an Error`)
        assert.ok(!error.message.includes('SENTINEL'),
          `${label} must not echo the observed value into diagnostics: ${error.message}`)
        return true
      },
      `${label} must be refused`)
  }
  assert.ok(!/JSON\.stringify\((?:protocol|port)/.test(adapter),
    'the refusal text is never built from the observed value')
})

test('the recorded Host argv still matches the port adapter, when the checkout is present', () => {
  let upstream
  try {
    upstream = readFileSync(hostSource, 'utf8')
  } catch {
    return // the reference checkout is optional for this unit check
  }
  const upstreamArgs = /args: \['--no-open', '--host', '127\.0\.0\.1', '--port', '0'\]/u.test(upstream)
  assert.ok(upstreamArgs,
    'the target Desktop Host still declares the loopback/ephemeral invocation the adapter mirrors')
  assert.match(upstream, /ctx\.webServer\.protocol/, 'the target still composes its origin from the listener protocol')
})
