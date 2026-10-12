import { isDesktop } from '../../desktop-bridge/index.ts'
import { markers } from '../../desktop-bridge/markers.ts'
import { installAccountBrowserLauncher } from '../../desktop-bridge/account-browser.ts'

const boot = markers.readDesktopBoot()
if (isDesktop() && boot !== undefined) {
  const ready = boot.ready.bind(boot)
  boot.ready = async () => {
    const payload = await ready()
    try { installAccountBrowserLauncher(payload.streamBaseUrl) }
    catch { console.warn('[dsh-shell] account browser launcher unavailable; copy-link remains available') }
    return payload
  }
}
