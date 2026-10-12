/** Replace the upstream native shell's account watcher, without a guest webview. */
import { parseRemoteStreamServerMessage, REMOTE_STREAM_MUX_PATH } from '../../../_upstream/packages/api/gateway/src/stream-protocol.ts'

const active = new WeakMap<Window, () => void>()
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Extract only a current, platform-owned authorization page; never retain grants. */
export function accountAuthorization(value: unknown, now = Date.now()): { id: string; url: URL } | undefined {
  if (!record(value) || !['signed-out', 'credential-stored'].includes(String(value.status)) || !record(value.links) || !record(value.attempt)) return
  const attempt = value.attempt
  if (attempt.phase !== 'waiting-browser' || typeof attempt.id !== 'string' || !attempt.id
    || typeof attempt.authorizeUrl !== 'string' || typeof attempt.expiresAt !== 'number'
    || !Number.isFinite(attempt.expiresAt) || attempt.expiresAt <= now) return
  try {
    const url = new URL(attempt.authorizeUrl)
    const origin = new URL(String(value.links.usageUrl)).origin
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.origin !== origin || url.pathname !== '/dsh/authorize' || url.username || url.password || url.hash
      || !(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return
    return { id: attempt.id, url }
  } catch { return }
}

/** One authenticated account subscription per main document; opens each attempt once. */
export function installAccountBrowserLauncher(base: string, view: Window = window): () => void {
  const installed = active.get(view)
  if (installed !== undefined) return installed
  const origin = new URL(base).origin
  if (origin !== view.location.origin) throw new Error('desktop account: stream origin mismatch')
  const streamUrl = new URL(REMOTE_STREAM_MUX_PATH, origin)
  streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  let disposed = false, socket: WebSocket | undefined, retry: ReturnType<typeof setTimeout> | undefined
  let openedAttempt: string | undefined
  const connect = (): void => {
    if (disposed) return
    const id = globalThis.crypto.randomUUID()
    const next = new (view as Window & { WebSocket: typeof WebSocket }).WebSocket(streamUrl)
    socket = next
    next.addEventListener('open', () => {
      if (!disposed && socket === next) next.send(JSON.stringify({ type: 'open', streamId: id, endpoint: 'account/watch', payload: { args: {} } }))
    })
    next.addEventListener('message', event => {
      if (disposed || socket !== next) return
      try {
        if (typeof event.data !== 'string' || event.data.length > 65_536) throw new Error('invalid frame')
        const frame = parseRemoteStreamServerMessage(event.data)
        if (frame.streamId !== id || frame.type !== 'item') { next.close(); return }
        const authorization = accountAuthorization(frame.value)
        if (authorization === undefined || authorization.id === openedAttempt) return
        openedAttempt = authorization.id
        const theme = view.document.documentElement.dataset.theme
        const prefersDark = typeof view.matchMedia === 'function' && view.matchMedia('(prefers-color-scheme: dark)').matches
        authorization.url.searchParams.set('theme', theme === 'dark' || (theme !== 'light' && prefersDark) ? 'dark' : 'light')
        // The installed external-links sidecar routes this through the owned
        // shell command, including a visible copy-link fallback on failure.
        view.open(authorization.url.href, '_blank', 'noopener,noreferrer')
      } catch { next.close() }
    })
    next.addEventListener('error', () => { next.close() })
    next.addEventListener('close', () => {
      if (!disposed && socket === next) retry = setTimeout(() => {
        try { connect() } catch { dispose() }
      }, 1000)
    })
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    clearTimeout(retry)
    socket?.close()
    view.removeEventListener('pagehide', dispose)
    active.delete(view)
  }
  active.set(view, dispose)
  view.addEventListener('pagehide', dispose, { once: true })
  try { connect() } catch { dispose(); throw new Error('desktop account: state stream unavailable') }
  return dispose
}
