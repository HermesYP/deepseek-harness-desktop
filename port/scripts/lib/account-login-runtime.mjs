import { createHash } from 'node:crypto'

/** Retain caller validation, then select the owned Host callback for native login. */
export function repairAccountLoginRuntime(source, version) {
  if (version !== '0.1.7-rc.2') throw new Error('Unreviewed account login version')
  source = source.replaceAll('\r\n', '\n')
  const start = '\tasync startSignIn(client, callbackOrigin, loginSource) {'
  const first = source.indexOf(start), last = source.indexOf('\n\tasync cancelSignIn(id) {', first)
  if (first < 0 || last < 0 || source.indexOf(start, first + 1) >= 0) throw new Error('Unreviewed account login shape')
  const method = source.slice(first, last)
  const anchor = 'const origin = loginOrigin(callbackOrigin);'
  const replacement = 'const validatedOrigin = loginOrigin(callbackOrigin);\n\t\tconst origin = desktopCallbackOrigin(this.ctx, validatedOrigin, loginSource); // DSH_PORT_DESKTOP_CALLBACK'
  if (method.includes('DSH_PORT_DESKTOP_CALLBACK')) {
    if (method.split(replacement).length !== 2 || createHash('sha256').update(method.replace(replacement, anchor)).digest('hex') !== 'f9a87137ba5112e4e7ce2d6b839368b1977e97cf9c04ee51b70026437ee2aeb7') throw new Error('Unreviewed repaired account login shape')
    return { source, changed: false }
  }
  if (createHash('sha256').update(method).digest('hex') !== 'f9a87137ba5112e4e7ce2d6b839368b1977e97cf9c04ee51b70026437ee2aeb7') {
    throw new Error('Unreviewed account login semantics')
  }
  return { changed: true, source: 'import { desktopCallbackOrigin } from "./desktop-login.js";\n' + source.replace(anchor, replacement) }
}
