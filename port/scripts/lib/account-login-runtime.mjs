import { createHash } from 'node:crypto'

// Reviewed compiled `startSignIn` bodies, keyed by EXPLICIT release literal so a
// retarget cannot re-point the pin. 0.2.1-alpha.3 differs from 0.2.1-alpha.2 by
// exactly one reviewed line — the "sign-in failed" report moved from
// `console.info` to `console.error`; the CallbackOrigin pair
// `const origin = loginOrigin(callbackOrigin);` is byte-identical and remains the
// anchor this port rewrites, so the validated caller origin is still preserved.
const reviewedStartSignIn = new Map([
  ['0.1.7-rc.2', 'f9a87137ba5112e4e7ce2d6b839368b1977e97cf9c04ee51b70026437ee2aeb7'],
  ['0.2.1-alpha.2', 'f9a87137ba5112e4e7ce2d6b839368b1977e97cf9c04ee51b70026437ee2aeb7'],
  ['0.2.1-alpha.3', 'a7a354ced7b25f553e25ab87e3037f9761fb52a2262709f72cba0c502fce4ca2'],
  ['0.2.1-rc.2', 'a7a354ced7b25f553e25ab87e3037f9761fb52a2262709f72cba0c502fce4ca2'],
])

/** Retain caller validation, then select the owned Host callback for native login. */
export function repairAccountLoginRuntime(source, version) {
  const expected = reviewedStartSignIn.get(version)
  if (expected === undefined) throw new Error('Unreviewed account login version')
  source = source.replaceAll('\r\n', '\n')
  const start = '\tasync startSignIn(client, callbackOrigin, loginSource) {'
  const first = source.indexOf(start), last = source.indexOf('\n\tasync cancelSignIn(id) {', first)
  if (first < 0 || last < 0 || source.indexOf(start, first + 1) >= 0) throw new Error('Unreviewed account login shape')
  const method = source.slice(first, last)
  const anchor = 'const origin = loginOrigin(callbackOrigin);'
  const replacement = 'const validatedOrigin = loginOrigin(callbackOrigin);\n\t\tconst origin = desktopCallbackOrigin(this.ctx, validatedOrigin, loginSource); // DSH_PORT_DESKTOP_CALLBACK'
  if (method.includes('DSH_PORT_DESKTOP_CALLBACK')) {
    if (method.split(replacement).length !== 2 || createHash('sha256').update(method.replace(replacement, anchor)).digest('hex') !== expected) throw new Error('Unreviewed repaired account login shape')
    return { source, changed: false }
  }
  if (createHash('sha256').update(method).digest('hex') !== expected) {
    throw new Error('Unreviewed account login semantics')
  }
  return { changed: true, source: 'import { desktopCallbackOrigin } from "./desktop-login.js";\n' + source.replace(anchor, replacement) }
}
