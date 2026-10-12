/**
 * Port entry: install the desktop marker bridge, honor the Host's
 * `script-preload` hints (port-owned sidecar), then run the preserved upstream
 * browser entry verbatim (`web-main.ts`, a byte-identical copy of
 * `_upstream/apps/web/src/main.ts`). Module evaluation order guarantees the
 * markers exist before the preserved entry reads `globalThis.dshDesktopBoot`,
 * and the preload sidecar wraps `dshDesktopBoot.ready` before the preserved
 * entry calls it.
 */
import '../../desktop-bridge/shell-boot.ts'
import './external-links.ts'
import './account-browser.ts'
import './script-preload.ts'
import './web-main.ts'
