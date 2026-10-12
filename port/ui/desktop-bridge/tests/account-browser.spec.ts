// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountAuthorization, installAccountBrowserLauncher } from '../account-browser.ts'
import { installDesktopExternalLinks } from '../external-links.ts'

class Socket extends EventTarget {
  static all: Socket[] = []
  sent: string[] = []
  closed = false
  constructor(readonly url: string | URL) { super(); Socket.all.push(this) }
  send(value: string) { this.sent.push(value) }
  close() { if (this.closed) return; this.closed = true; this.dispatchEvent(new Event('close')) }
  item(value: unknown) {
    const streamId = JSON.parse(this.sent[0]!).streamId
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'item', streamId, value }) }))
  }
}
const state = (id = 'fixture-attempt') => ({ status: 'signed-out', links: { usageUrl: 'https://platform.deepseek.com/usage' },
  attempt: { id, phase: 'waiting-browser', expiresAt: Date.now() + 60000, authorizeUrl: 'https://platform.deepseek.com/dsh/authorize?state=fixture-state' } })
const disposers: Array<() => void> = []
afterEach(() => { disposers.splice(0).reverse().forEach(stop => stop()); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); Socket.all = []; delete document.documentElement.dataset.theme })

describe('native account browser launcher', () => {
  it('opens the actual authenticated account stream once per attempt through the shell bridge', async () => {
    vi.stubGlobal('WebSocket', Socket)
    document.documentElement.dataset.theme = 'dark'
    const shellOpenExternal = vi.fn(async () => undefined)
    disposers.push(installDesktopExternalLinks({ shellOpenExternal, shellClipboardWrite: vi.fn(async () => undefined) }))
    const stop = installAccountBrowserLauncher(window.location.origin)
    disposers.push(stop)
    expect(installAccountBrowserLauncher(window.location.origin)).toBe(stop)
    const socket = Socket.all[0]!
    socket.dispatchEvent(new Event('open'))
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: 'open', endpoint: 'account/watch', payload: { args: {} } })
    socket.item(state()); socket.item(state())
    expect(shellOpenExternal).toHaveBeenCalledTimes(1)
    expect(shellOpenExternal).toHaveBeenCalledWith({ url: 'https://platform.deepseek.com/dsh/authorize?state=fixture-state&theme=dark' })
    socket.item(state('second-attempt'))
    expect(shellOpenExternal).toHaveBeenCalledTimes(2)
  })

  it('does not open expired, nonwaiting, mismatched-origin or credential-bearing destinations', () => {
    expect(accountAuthorization({ ...state(), attempt: { ...state().attempt, expiresAt: 0 } })).toBeUndefined()
    for (const authorizeUrl of ['https://evil.invalid/dsh/authorize', 'https://user:password@platform.deepseek.com/dsh/authorize', 'https://platform.deepseek.com/wrong', 'javascript:alert(1)']) {
      expect(accountAuthorization({ ...state(), attempt: { ...state().attempt, authorizeUrl } })).toBeUndefined()
    }
    expect(accountAuthorization({ ...state(), attempt: { ...state().attempt, phase: 'cancelled' } })).toBeUndefined()
  })

  it('owns reconnect and disposal; callbacks after document exit cannot reopen a browser', () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket)
    const open = vi.spyOn(window, 'open').mockReturnValue(null)
    const stop = installAccountBrowserLauncher(window.location.origin); disposers.push(stop)
    const first = Socket.all[0]!
    first.dispatchEvent(new Event('open')); first.item(state())
    first.close(); vi.advanceTimersByTime(1000)
    const next = Socket.all[1]!
    next.dispatchEvent(new Event('open')); next.item(state())
    expect(open).toHaveBeenCalledTimes(1)
    window.dispatchEvent(new Event('pagehide'))
    next.item(state('new')); vi.advanceTimersByTime(3000)
    expect(Socket.all).toHaveLength(2); expect(next.closed).toBe(true); expect(open).toHaveBeenCalledTimes(1)
  })

  it('a disposed document cannot remove a later installation', () => {
    vi.stubGlobal('WebSocket', Socket)
    const old = installAccountBrowserLauncher(window.location.origin)
    old()
    const current = installAccountBrowserLauncher(window.location.origin); disposers.push(current)
    old()
    expect(installAccountBrowserLauncher(window.location.origin)).toBe(current)
    expect(Socket.all).toHaveLength(2)
  })
})
