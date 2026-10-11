// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { DshDesktopApi } from '../index.ts'
import { installDesktopExternalLinks } from '../external-links.ts'

let dispose: (() => void) | undefined
let invoke: Mock<(command: string, args?: Record<string, unknown>) => Promise<void>>
let desktop: DshDesktopApi
const originalWindowOpen = window.open

beforeEach(async () => {
  vi.resetModules()
  invoke = vi.fn(async (_command: string, _args?: Record<string, unknown>) => undefined)
  vi.stubGlobal('__TAURI_INTERNALS__', { invoke })
  // Like the real initialization script, the transport must exist BEFORE the
  // facade binds its invoke channel at module evaluation.
  desktop = (await import('../index.ts')).desktop
})
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.open = originalWindowOpen
})

function link(href: string, target = '_blank'): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.target = target
  anchor.innerHTML = '<span>View usage</span>'
  document.body.append(anchor)
  return anchor
}
function click(anchor: HTMLAnchorElement, init: MouseEventInit = {}): MouseEvent {
  const event = new MouseEvent('click', { bubbles: true, cancelable: true, ...init })
  anchor.firstElementChild!.dispatchEvent(event)
  return event
}

describe('preserved client external-browser fallbacks', () => {
  it('routes Usage and Top-up through the granted shell command before the old opener script', () => {
    const pluginOpener = vi.fn((event: MouseEvent) => {
      if (!event.defaultPrevented) void invoke('plugin:opener|open_url')
    })
    // The older delivered native exe installs its listener before the UI loads.
    window.addEventListener('click', pluginOpener)
    try {
      dispose = installDesktopExternalLinks(desktop)
      for (const path of ['usage', 'top_up']) {
        expect(click(link(`https://platform.deepseek.com/${path}`)).defaultPrevented).toBe(true)
        expect(invoke).toHaveBeenLastCalledWith('shell_open_external', {
          url: `https://platform.deepseek.com/${path}`,
        })
      }
      expect(pluginOpener).toHaveBeenCalledTimes(2)
      expect(invoke).toHaveBeenCalledTimes(2)
    } finally { window.removeEventListener('click', pluginOpener) }
  })

  it('routes window.open without requesting the native new-window path or a guest', () => {
    const nativeOpen = vi.fn(() => null)
    window.open = nativeOpen
    dispose = installDesktopExternalLinks(desktop)
    expect(window.open).not.toBe(nativeOpen)
    expect(window.open('https://platform.deepseek.com/dsh/authorize?state=example', '_blank', 'noopener,noreferrer')).toBeNull()
    expect(invoke).toHaveBeenCalledExactlyOnceWith('shell_open_external', {
      url: 'https://platform.deepseek.com/dsh/authorize?state=example',
    })
    expect(nativeOpen).not.toHaveBeenCalled()
  })

  it('lets the client cancel a link before the shell consumes it', () => {
    dispose = installDesktopExternalLinks(desktop)
    const anchor = link('https://platform.deepseek.com/usage')
    anchor.addEventListener('click', event => event.preventDefault())
    click(anchor)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('handles middle-click and modified new-tab clicks once', () => {
    dispose = installDesktopExternalLinks(desktop)
    const anchor = link('https://example.com/', '_self')
    click(anchor, { ctrlKey: true })
    const middle = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 })
    anchor.dispatchEvent(middle)
    expect(middle.defaultPrevented).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('leaves disabled links, downloads and ordinary navigation alone', () => {
    dispose = installDesktopExternalLinks(desktop)
    const disabled = link('https://example.com/')
    disabled.setAttribute('aria-disabled', 'true')
    const download = link('https://example.com/download')
    download.download = 'file'
    for (const anchor of [disabled, download, link('https://example.com/', '_self')]) {
      expect(click(anchor).defaultPrevented).toBe(false)
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('never exports the gateway origin, credentials or unsupported schemes to the OS', () => {
    dispose = installDesktopExternalLinks(desktop)
    for (const value of [
      new URL('/?token=private', window.location.href).href,
      'https://user:password@example.com/', 'file:///C:/Windows/',
      'javascript:void(0)', 'data:text/html,hello',
    ]) expect(click(link(value)).defaultPrevented).toBe(false)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('preserves window.open for local documents and explicit same-window targets', () => {
    const nativeOpen = vi.fn(() => null)
    window.open = nativeOpen
    dispose = installDesktopExternalLinks(desktop)
    window.open('/document', '_blank')
    window.open('https://example.com/', '_self')
    expect(nativeOpen).toHaveBeenCalledTimes(2)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows a copyable failure without putting the private URL in diagnostics', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    invoke.mockRejectedValueOnce({ kind: 'other', detail: { code: 'open_external' } })
    dispose = installDesktopExternalLinks(desktop)
    window.open('https://platform.deepseek.com/dsh/authorize?state=private-state')
    await Promise.resolve()
    await Promise.resolve()
    const alert = document.querySelector('[role="alert"]')!
    expect(alert.textContent).toContain('Could not open your browser')
    expect(warning).toHaveBeenCalledExactlyOnceWith('[dsh-shell] external browser open failed')
    ;(alert.querySelector('button') as HTMLButtonElement).click()
    expect(invoke).toHaveBeenLastCalledWith('shell_clipboard_write', {
      text: 'https://platform.deepseek.com/dsh/authorize?state=private-state',
    })
  })

  it('installs once and restores the original open function when disposed', () => {
    const nativeOpen = vi.fn(() => null)
    window.open = nativeOpen
    dispose = installDesktopExternalLinks(desktop)
    expect(installDesktopExternalLinks(desktop)).toBe(dispose)
    window.open('https://example.com/')
    expect(invoke).toHaveBeenCalledTimes(1)
    dispose()
    expect(window.open).toBe(nativeOpen)
    window.open('https://example.com/')
    expect(nativeOpen).toHaveBeenCalledTimes(1)
  })

  it('does not install the shell entry in an ordinary browser', async () => {
    vi.unstubAllGlobals()
    const nativeOpen = window.open
    await import('../../shell/src/external-links.ts')
    expect(window.open).toBe(nativeOpen)
  })
})
