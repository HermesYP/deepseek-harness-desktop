/**
 * Assembled-application acceptance check.
 *
 * This is the check the independent review asked for: it exercises the REAL
 * assembled application — the Rust gateway, its authentication, the proxied
 * application HTTP surface and the multiplexed streaming WebSocket — rather
 * than the UI in isolation (mount-check) or serialization (fixture round-trips).
 *
 * Run it against a live desktop application or a live `dsh` host:
 *
 *   node scripts/verify-assembled.mjs --base http://127.0.0.1:<port> --token <launch token>
 *
 * `--token` is a credential. It is read from the command line, never written to
 * a file, never printed by this script, and redacted from every failure message.
 *
 * Exit code 0 only when every REQUIRED step passes. A step that cannot be
 * attempted is reported as SKIP and does not satisfy a required step.
 *
 * Owned by: parity lane V.
 */
import { createHash } from 'node:crypto'
import { Verdict, usageError } from '../port/tests/helpers/verdict.mjs'
import { assertNotLiveGui } from '../port/tests/helpers/host-identity.mjs'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}

const base = arg('base', 'http://127.0.0.1:3085')
const token = arg('token')
const timeoutMs = Number(arg('timeout', '15000'))

if (token === undefined) {
  usageError('verify-assembled: --token is required (the application launch token)')
}
// Refuse the live GUI outright: this script drives a real instance end to end
// and 3080 belongs to the user's running Harness.
assertNotLiveGui(base)

/** Redact any occurrence of the token from text that may be printed. */
const redact = (value) => String(value).split(token).join('<redacted-token>')

const verdict = new Verdict('assembled application')
const results = []
const record = (name, status, detail, options = {}) => {
  results.push({ name, status, detail: detail === undefined ? undefined : redact(detail) })
  return verdict.record(name, status, { ...options, detail: detail === undefined ? undefined : redact(detail) })
}

async function withTimeout(promise, label) {
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// 1. Authentication boundary: an unauthenticated request must be refused.
// ---------------------------------------------------------------------------
console.log('\n1. Authentication boundary')
let cookieHeader
try {
  const response = await withTimeout(
    fetch(new URL('/', base), { redirect: 'manual' }),
    'unauthenticated GET /',
  )
  if (response.status === 401 || response.status === 403) {
    record('unauthenticated GET / is refused', 'PASS', `status ${response.status}`)
  } else {
    record('unauthenticated GET / is refused', 'FAIL', `expected 401/403, got ${response.status}`)
  }
} catch (error) {
  record('unauthenticated GET / is refused', 'FAIL', error.message)
}

// ---------------------------------------------------------------------------
// 2. Launch-token exchange must mint a session cookie and redirect to './'.
// ---------------------------------------------------------------------------
console.log('\n2. Launch-token exchange')
try {
  const url = new URL('/', base)
  url.searchParams.set('token', token)
  const response = await withTimeout(fetch(url, { redirect: 'manual' }), 'token exchange')
  const setCookie = response.headers.get('set-cookie')
  const location = response.headers.get('location')
  if (response.status === 303 && setCookie !== null) {
    cookieHeader = setCookie.split(';')[0]
    const okLocation = location === './' || location === '/' || (location ?? '').endsWith('/')
    record('valid token mints cookie + 303', okLocation ? 'PASS' : 'FAIL', `status 303, location ${location}`)
  } else {
    record('valid token mints cookie + 303', 'FAIL', `status ${response.status}, set-cookie ${setCookie === null ? 'absent' : 'present'}`)
  }
} catch (error) {
  record('valid token mints cookie + 303', 'FAIL', error.message)
}

// ---------------------------------------------------------------------------
// 3. A cookie-authenticated index must carry the boot contract the client needs.
// ---------------------------------------------------------------------------
console.log('\n3. Boot contract in the served document')
if (cookieHeader === undefined) {
  record('served index.html carries the boot contract', 'SKIP', 'no cookie from step 2')
} else {
  try {
    const response = await withTimeout(
      fetch(new URL('/', base), { headers: { cookie: cookieHeader } }),
      'authenticated index',
    )
    const body = await response.text()
    if (response.status !== 200) {
      record('served index.html carries the boot contract', 'FAIL', `status ${response.status}`)
    } else {
      // The desktop boot path requires this literal before the entry runs.
      const hasReady = body.includes('__DSH_BOOT_READY__')
      // The host supplies these two through the index injection table; the shell
      // applies them via applyIndexInjections, so they need not appear in the
      // served HTML of the shell-owned path. That is a legitimate reason for this
      // check to be OPTIONAL — but "legitimately absent here" must not be
      // reported as a PASS, which is what the old code did.
      const hasBoot = body.includes('__DSH_BOOT__')
      const hasLoader = body.includes('__ModuleLoader__')
      record(
        'served index.html carries __DSH_BOOT_READY__',
        hasReady ? 'PASS' : 'FAIL',
        hasReady ? undefined : 'the desktop boot gate literal is missing; the client will throw "boot readiness is missing"',
      )
      record(
        'index injection state (__DSH_BOOT__ / __ModuleLoader__)',
        hasBoot && hasLoader ? 'PASS' : 'SKIP',
        hasBoot && hasLoader
          ? 'present in served HTML'
          : 'not in served HTML — expected on the shell-owned path, where the client applies the injection table from dshDesktopBoot.ready(). This is NOT evidence of correctness: confirm by asserting the mounted client instead (scripts/mount-check-app.mjs).',
        // Optional-by-design: this script cannot see the mounted client, so its
        // absence here is expected and must not fail the run — but it must also
        // not be counted as a pass.
        { required: false },
      )
      const digest = createHash('sha256').update(body).digest('hex').slice(0, 16)
      // A digest is a recorded fact for cross-run comparison, not a check that
      // can succeed or fail. Reporting it as PASS inflated the pass count.
      verdict.note(`index digest sha256:${digest}… len ${body.length}`)
      console.log(`  [note] index digest sha256:${digest}… len ${body.length}`)
    }
  } catch (error) {
    record('served index.html carries the boot contract', 'FAIL', error.message)
  }
}

// ---------------------------------------------------------------------------
// 4. A static asset must be served (proves the packaged UI is reachable).
// ---------------------------------------------------------------------------
console.log('\n4. Packaged UI assets')
if (cookieHeader === undefined) {
  record('a packaged asset is served', 'SKIP', 'no cookie from step 2')
} else {
  try {
    const response = await withTimeout(
      fetch(new URL('/favicon.svg', base), { headers: { cookie: cookieHeader } }),
      'asset fetch',
    )
    record('a packaged asset is served', response.status === 200 ? 'PASS' : 'FAIL', `/favicon.svg status ${response.status}`)
  } catch (error) {
    record('a packaged asset is served', 'FAIL', error.message)
  }
}

// ---------------------------------------------------------------------------
// 5. The streaming WebSocket must accept an authenticated upgrade.
//    This is the channel that carries assistant streaming and session events.
// ---------------------------------------------------------------------------
console.log('\n5. Streaming WebSocket (the highest-risk surface)')
if (cookieHeader === undefined) {
  record('mux WebSocket upgrade is accepted', 'SKIP', 'no cookie from step 2')
} else {
  try {
    const wsUrl = new URL('/api/remote.mux', base)
    wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:'
    // Node's global WebSocket (undici) is available on Node 22+.
    const socket = new WebSocket(wsUrl, { headers: { cookie: cookieHeader, origin: base } })
    const outcome = await withTimeout(new Promise((resolve) => {
      socket.addEventListener('open', () => resolve({ kind: 'open' }))
      socket.addEventListener('error', () => resolve({ kind: 'error' }))
      socket.addEventListener('close', (event) => resolve({ kind: 'close', code: event.code }))
    }), 'websocket upgrade')
    if (outcome.kind === 'open') {
      record('mux WebSocket upgrade is accepted', 'PASS', 'connection opened')
      socket.close()
    } else {
      record(
        'mux WebSocket upgrade is accepted',
        'FAIL',
        outcome.kind === 'close' ? `closed with code ${outcome.code}` : 'error before open',
      )
    }
  } catch (error) {
    record('mux WebSocket upgrade is accepted', 'FAIL', error.message)
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
const counts = results.reduce((acc, row) => {
  acc[row.status] = (acc[row.status] ?? 0) + 1
  return acc
}, {})
if ((counts.SKIP ?? 0) > 0) {
  console.log(`\n${counts.SKIP} optional check(s) were not exercised; they are reported as SKIP and are not evidence of correctness.`)
}
verdict.finish()
