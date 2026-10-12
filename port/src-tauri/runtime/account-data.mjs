import { randomUUID } from 'node:crypto'

const sessions = new WeakMap()
/** A public random identifier for one credential lifetime; never derived from a grant. */
export function accountSessionId(lifetime, token) {
  if (typeof token !== 'string' || token.length === 0) return null
  let current = sessions.get(lifetime)
  if (current === undefined || current.token !== token) {
    current = { token, id: randomUUID() }; sessions.set(lifetime, current)
  }
  return current.id
}

/** Record only allowlisted response metadata, never bodies, cookies or header values. */
export function accountResponseMetadata(response) {
  const type = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  const action = response.headers.get('x-amzn-waf-action')
  return {
    contentType: ['application/json', 'text/html'].includes(type) ? type : 'other',
    verification: ['challenge', 'captcha'].includes(action) ? action : null,
  }
}

/** Account field failures retain a small, non-secret reason for an honest recovery UI. */
export function accountFailureReason(error) {
  if (error?.accountReason === 'verification-required') return 'verification-required'
  return error?.code === 'network' ? 'network' : 'protocol'
}
