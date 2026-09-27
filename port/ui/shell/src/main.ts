/**
 * Port entry: install the desktop marker bridge, then run the preserved
 * upstream browser entry verbatim (`web-main.ts`, a byte-identical copy of
 * `_upstream/apps/web/src/main.ts`). Module evaluation order guarantees the
 * markers exist before the preserved entry reads `globalThis.dshDesktopBoot`.
 */
import '../../desktop-bridge/shell-boot.ts'
import './web-main.ts'
