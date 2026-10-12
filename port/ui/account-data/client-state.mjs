/** This module is also embedded inside the preserved client-loader factory by the stage. */
export function sameAccountSession(previous, next) {
  const id = next?.portSessionId
  return previous?.status === 'credential-stored' && next?.status === 'credential-stored'
    && typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    && previous.portSessionId === id
}

export function settledAccountDetail(previous, next) {
  // Preserve a known result only within the revision bound to the same Host session.
  // A stale marker ensures the user never mistakes an old wallet read for a fresh one.
  return next?.status === 'failed' && previous?.status === 'ready'
    ? { ...previous, stale: true, reason: next.reason ?? 'network' }
    : next
}

export function accountNeedsRetry(details) {
  return ['profile', 'balance'].some(field => details?.[field]?.status === 'failed' || details?.[field]?.stale === true)
}

export function accountNeedsVerification(details) {
  return ['profile', 'balance'].some(field => details?.[field]?.reason === 'verification-required')
}

/** External recharge remains available while the embedded Platform capability is gated off. */
export function openAccountPageInBrowser(links, page, target, onReturn) {
  const path = page === 'usage' ? '/usage' : page === 'top-up' ? '/top_up' : null
  if (path === null) throw new Error('Unsupported account destination')
  const url = new URL(page === 'usage' ? links?.usageUrl : links?.topUpUrl)
  if (url.origin !== 'https://platform.deepseek.com' || url.pathname !== path
      || url.username || url.password || url.search || url.hash) throw new Error('Invalid account destination')
  let retired = false, left = false
  const blur = () => { left = true }
  const release = () => {
    if (retired) return
    retired = true
    target.removeEventListener('blur', blur)
    target.removeEventListener('focus', focus)
  }
  const focus = () => {
    if (retired || !left) return
    release(); onReturn?.()
  }
  target.addEventListener('blur', blur)
  target.addEventListener('focus', focus)
  try { target.open(url.href, '_blank', 'noopener,noreferrer') }
  catch (error) { release(); throw error }
  return release
}
