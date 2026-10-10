/**
 * Renderer-hardening configuration regressions (audit C.1#7: `csp: null` +
 * `withGlobalTauri: true`).
 *
 * TWO DIFFERENT DOCUMENTS, TWO DIFFERENT POLICIES. They are not
 * interchangeable, and this file pins both facts separately:
 *
 * * the shell document the window navigates to is served by the loopback
 *   gateway, which answers `/` and `/index.html` with an enforcing
 *   `Content-Security-Policy` by default
 *   (`SHELL_CONTENT_SECURITY_POLICY`, served by `GatewayConfig::loopback`);
 * * Tauri's `app.security.csp` is injected on packaged App-protocol HTML
 *   (`SecurityConfig::csp` — "injected on all HTML files on the built
 *   application"; the framework's CSP machinery is the `tauri` URI protocol,
 *   not an external URL), which today means the mandatory-policy webview.
 *
 * So the config value is held equal to the served policy: one directive set,
 * two enforcement points, no silent drift and no unqualified declaration.
 *
 * These are source/config assertions only. They prove the declared bytes and
 * that nothing requires the disabled global API; they do NOT prove WebView2
 * enforced either policy, which needs a live window and is recorded as an open
 * observation rather than a claim.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

const config = JSON.parse(read('src-tauri/app/tauri.conf.json'))

/** Parse one CSP string into `directive -> sources`, order-insensitively. */
function parsePolicy(policy) {
  const directives = new Map()
  for (const segment of policy.split(';')) {
    const tokens = segment.trim().split(/\s+/u).filter(Boolean)
    if (tokens.length === 0) continue
    const [name, ...sources] = tokens
    assert.equal(directives.has(name.toLowerCase()), false, `duplicate CSP directive ${name}`)
    directives.set(name.toLowerCase(), [...sources].sort())
  }
  return directives
}

/** The gateway's served shell policy, read from its single source of truth. */
function gatewayShellPolicy() {
  const source = read('src-tauri/crates/dsh-gateway/src/lib.rs')
  const constant = source.match(/const SHELL_CONTENT_SECURITY_POLICY: &str = concat!\(([\s\S]*?)\);/u)
  assert.ok(constant, 'SHELL_CONTENT_SECURITY_POLICY must exist in dsh-gateway/src/lib.rs')
  const literals = [...constant[1].matchAll(/"((?:[^"\\]|\\.)*)"/gu)].map(match => JSON.parse(`"${match[1]}"`))
  assert.ok(literals.length > 0, 'SHELL_CONTENT_SECURITY_POLICY must concatenate string literals')
  return literals.join('')
}

test('the renderer does not expose the global Tauri API', () => {
  assert.equal(
    config.app.withGlobalTauri,
    false,
    'withGlobalTauri must be false: it exists only to publish window.__TAURI__, which no port bridge needs',
  )

  // The bridge must keep resolving the always-injected internal channel before
  // the `__TAURI__.core` fallback, or disabling the flag would break every
  // command. This is the property `withGlobalTauri: false` relies on.
  const bridge = read('ui/desktop-bridge/index.ts')
  const readInvoke = bridge.match(/function readInvoke\(\)[\s\S]*?\n\}/u)
  assert.ok(readInvoke, 'readInvoke must exist in port/ui/desktop-bridge/index.ts')
  const internals = readInvoke[0].indexOf('__TAURI_INTERNALS__')
  const globalApi = readInvoke[0].indexOf('__TAURI__')
  assert.ok(internals !== -1, 'readInvoke must resolve __TAURI_INTERNALS__')
  assert.ok(globalApi !== -1, 'readInvoke must keep the __TAURI__ fallback for a build configured the other way')
  assert.ok(
    internals < globalApi,
    '__TAURI_INTERNALS__ must be resolved before __TAURI__: the internal channel is always injected, the global API is not',
  )
})

test('the App-protocol policy is declared and keeps the boot forms the shipped renderer needs', () => {
  const csp = config.app.security.csp
  assert.equal(typeof csp, 'string', 'app.security.csp must declare a policy string, not null')
  assert.ok(csp.trim().length > 0, 'app.security.csp must not be empty')

  const directives = parsePolicy(csp)
  const scriptSrc = directives.get('script-src')
  assert.ok(scriptSrc, 'the policy must declare script-src explicitly')

  // NOT a hash/nonce-only policy, and not 'strict-dynamic': the served
  // index.html carries the __DSH_BOOT_READY__ inline literal (the gateway
  // re-asserts it), the Host boot table is applied through inline <script>
  // elements with no nonce, and the shipped bundle contains the client
  // expression evaluator. A nonce/hash in the directive (or 'strict-dynamic')
  // makes 'unsafe-inline' ignored and cannot boot this renderer.
  assert.ok(scriptSrc.includes("'unsafe-inline'"), "script-src must keep 'unsafe-inline' for the inline boot script")
  assert.ok(scriptSrc.includes("'unsafe-eval'"), "script-src must keep 'unsafe-eval' for the shipped client evaluator")
  assert.equal(scriptSrc.includes("'strict-dynamic'"), false, "'strict-dynamic' would ignore 'unsafe-inline' and break the boot literal")
  for (const source of scriptSrc) {
    assert.equal(
      source.startsWith("'nonce-") || source.startsWith("'sha256-"),
      false,
      `script-src must not carry a config-level ${source}: a nonce/hash makes 'unsafe-inline' ignored`,
    )
  }

  // The Tauri IPC channel is the only non-origin connection the renderer uses.
  const connectSrc = directives.get('connect-src')
  assert.ok(connectSrc?.includes('ipc:'), 'connect-src must allow the Tauri ipc: scheme')
  assert.ok(connectSrc?.includes('http://ipc.localhost'), 'connect-src must allow http://ipc.localhost on Windows WebView2')

  // Framing and injection surfaces stay refused.
  for (const directive of ['base-uri', 'object-src', 'form-action', 'frame-ancestors']) {
    assert.deepEqual(directives.get(directive), ["'none'"], `${directive} must be 'none'`)
  }
})

test('the gateway still serves the same policy on the shell document by default', () => {
  const served = gatewayShellPolicy()
  assert.equal(config.app.security.csp, served, 'the config policy and the gateway-served policy must not drift')

  const servedDirectives = parsePolicy(served)
  const declaredDirectives = parsePolicy(config.app.security.csp)
  assert.deepEqual(
    [...declaredDirectives.keys()].sort(),
    [...servedDirectives.keys()].sort(),
    'the two policies must cover the same directives',
  )
  for (const [directive, sources] of servedDirectives) {
    assert.deepEqual(
      declaredDirectives.get(directive),
      sources,
      `directive ${directive} diverges between the config and the served policy`,
    )
  }

  // The served policy must stay default-on: a default-off or opt-in gateway
  // would leave the shell document with no enforcing policy at all.
  const loopback = read('src-tauri/crates/dsh-gateway/src/lib.rs')
    .match(/pub fn loopback\(static_dir: impl Into<PathBuf>\) -> Self \{[\s\S]*?\n    \}/u)
  assert.ok(loopback, 'GatewayConfig::loopback must exist in dsh-gateway/src/lib.rs')
  assert.match(
    loopback[0],
    /shell_content_security_policy: true/u,
    'GatewayConfig::loopback must serve the shell policy by default',
  )
})
