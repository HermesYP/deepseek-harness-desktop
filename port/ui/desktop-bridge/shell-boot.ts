/**
 * Desktop marker bridge glue: runs at module evaluation, before the preserved
 * upstream entry (`./web-main.ts`) reads `globalThis.dshDesktopBoot`.
 *
 * Ownership (contract amendment A11) — who OWNS producing each surface:
 *
 *   `__DSH_BOOT_READY__`                          served `index.html` literal
 *                                                 (Rust may re-assert idempotently)
 *   `html[data-platform]`, `html[data-windows-titlebar]`
 *   + `--dsh-windows-titlebar-height`,
 *     `html[data-ds-theme-source]`                Rust (DOM markers)
 *   `__DSH_HOST_PATHS__`                          Rust (native file paths; no Tauri
 *                                                 `webUtils.getPathForFile` equivalent,
 *                                                 TypeScript cannot recover a path
 *                                                 from a `File`) — this glue NEVER
 *                                                 writes it
 *   `__DSH_DIRECTORY_PICKER__`                    Rust (native dialog); this glue
 *                                                 keeps only a fill-if-absent
 *                                                 `shell_pick_directory` fallback
 *   `dshDesktop`, `dshDesktopBoot`,
 *   `__DSH_LOCALE__`, `dshOnboarding`,
 *   `dshPlatform`                                 TypeScript bridge (`dshPlatform`
 *                                                 not implemented —
 *                                                 `desktop-shell-features.md` §4;
 *                                                 zero writers today)
 *
 * Exactly one writer per global per run: the Rust initialization script
 * executes before page modules and owns its rows above; this glue fills only
 * globals that are still ABSENT and never overwrites one. Outside the Tauri
 * shell it installs nothing, so the preserved client runs its Web path
 * unchanged.
 *
 * `__DSH_TRANSPORT__` is set by the preserved entry from
 * `dshDesktopBoot.ready()`. `dshDesktop.keyboard` is mandatory in the desktop
 * runtime (upstream throws when it is absent) and is installed with its
 * in-page physical-input producer (`markers.ts` `createKeyboardApi`), which
 * stamps produced input with the accepted shortcut revision.
 */
import { desktop, isDesktop, type DshDesktopApi } from './index.ts'
import {
  createDesktopBoot, createDesktopProductApi, createDirectoryPicker, createLocaleBridge,
  createOnboardingBridge, markers,
} from './markers.ts'

/**
 * Fill absent marker globals from the typed bridge (A11: the TypeScript-bridge
 * rows plus the `__DSH_DIRECTORY_PICKER__` fallback); never overwrite an
 * existing marker and never write `__DSH_HOST_PATHS__` or the DOM markers,
 * which are Rust-owned.
 * @param bridge - typed desktop facade used for the fallback factories.
 */
export function installDesktopShellMarkers(bridge: DshDesktopApi = desktop): void {
  if (!isDesktop()) return
  if (markers.readDesktopBoot() === undefined) markers.installDesktopBoot(createDesktopBoot(bridge))
  if (markers.readDirectoryPicker() === undefined) markers.installDirectoryPicker(createDirectoryPicker(bridge))
  if (markers.readLocaleBridge() === undefined) markers.installLocaleBridge(createLocaleBridge(bridge))
  if (markers.readOnboarding() === undefined) markers.installOnboarding(createOnboardingBridge(bridge))
  if (markers.readDesktopProductApi() === undefined) markers.installDesktopProductApi(createDesktopProductApi(bridge))
}

installDesktopShellMarkers()
