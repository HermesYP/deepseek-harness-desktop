/** Route the preserved client's browser fallbacks through the owned shell command. */
import type { DshDesktopApi } from './index.ts'

type LinkBridge = Pick<DshDesktopApi, 'shellOpenExternal' | 'shellClipboardWrite'>
const installations = new WeakMap<Window, () => void>()

/**
 * Intercept new-tab links after the client's own handlers have run, but before
 * Tauri's window-level opener script. That script uses a plugin command which
 * the exact-origin capability deliberately does not grant. Programmatic
 * `window.open` also needs this route: the native shell denies new webviews.
 * Only the main shell installs this; guest documents receive no bridge.
 */
export function installDesktopExternalLinks(bridge: LinkBridge, view: Window = window): () => void {
  const existing = installations.get(view)
  if (existing !== undefined) return existing
  const doc = view.document
  const originalOpen = view.open
  let disposed = false
  let failure: HTMLElement | undefined

  const externalUrl = (value: string | URL): string | undefined => {
    try {
      const parsed = new URL(String(value), doc.baseURI)
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)
        || parsed.username !== '' || parsed.password !== ''
        || parsed.origin === view.location.origin) return undefined
      return parsed.href
    } catch { return undefined }
  }

  const reportFailure = (url: string): void => {
    if (disposed) return
    // URLs can contain an authorization state. Keep them out of diagnostics.
    console.warn('[dsh-shell] external browser open failed')
    failure?.remove()
    failure = doc.createElement('div')
    failure.setAttribute('role', 'alert')
    failure.dataset.dshExternalLinkError = ''
    failure.style.cssText = 'position:fixed;bottom:20px;left:20px;right:20px;z-index:2147483647;padding:16px;background:#242424;color:white;border:1px solid #888;border-radius:8px;display:flex;gap:12px;align-items:center'
    const message = doc.createElement('span')
    message.textContent = 'Could not open your browser. Copy the link and open it manually.'
    const copy = doc.createElement('button')
    copy.type = 'button'
    copy.textContent = 'Copy link'
    copy.addEventListener('click', () => {
      void bridge.shellClipboardWrite({ text: url }).then(
        () => { copy.textContent = 'Copied' },
        () => { copy.textContent = 'Copy failed' },
      )
    })
    const dismiss = doc.createElement('button')
    dismiss.type = 'button'
    dismiss.textContent = 'Dismiss'
    dismiss.addEventListener('click', () => { failure?.remove(); failure = undefined })
    failure.append(message, copy, dismiss)
    doc.body.append(failure)
  }

  const open = (url: string): void => {
    void bridge.shellOpenExternal({ url }).catch(() => reportFailure(url))
  }
  const newWindowTarget = (target: string): boolean =>
    !['_self', '_top', '_parent'].includes(target.toLowerCase())

  const click = (event: MouseEvent): void => {
    if (event.defaultPrevented || event.altKey
      || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return
    const anchor = event.composedPath().find((node): node is HTMLAnchorElement =>
      node instanceof Element && node.tagName === 'A')
    if (anchor === undefined || !anchor.hasAttribute('href')
      || anchor.hasAttribute('download') || anchor.getAttribute('aria-disabled') === 'true') return
    const target = anchor.target || doc.querySelector('base[target]')?.getAttribute('target') || '_self'
    if (!newWindowTarget(target) && !event.ctrlKey && !event.metaKey
      && !event.shiftKey && event.button !== 1) return
    const url = externalUrl(anchor.href)
    if (url === undefined) return
    event.preventDefault()
    open(url)
  }

  const shellOpen: Window['open'] = (url, target, features) => {
    const external = url === undefined ? undefined : externalUrl(url)
    if (external !== undefined && newWindowTarget(target ?? '_blank')) {
      open(external)
      // The OS browser supplies no scriptable WindowProxy (noopener semantics).
      return null
    }
    return originalOpen.call(view, url, target, features)
  }
  doc.addEventListener('click', click)
  doc.addEventListener('auxclick', click)
  view.open = shellOpen

  const dispose = (): void => {
    disposed = true
    doc.removeEventListener('click', click)
    doc.removeEventListener('auxclick', click)
    if (view.open === shellOpen) view.open = originalOpen
    failure?.remove()
    installations.delete(view)
  }
  installations.set(view, dispose)
  return dispose
}
