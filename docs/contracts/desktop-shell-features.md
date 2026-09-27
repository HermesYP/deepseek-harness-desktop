# Desktop shell features contract (port-owned)

Status: binding. Companion to [`tauri-contract.md`](tauri-contract.md), which owns the command and event vocabulary. This document specifies the `dshDesktop` sub-bridges that the preserved client reaches for, and the native shell behaviours they stand for.

Read [`ui-backend-protocol.md`](ui-backend-protocol.md) §8 first: it is authoritative on which globals exist and what the client does when each is absent.

## 1. `globalThis.dshDesktop`

Shape is the upstream `DshDesktopProductApi` (`_upstream/apps/desktop/src/ipc.ts:71-81`), re-declared verbatim:

```typescript
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly browser: DesktopBrowserBridge
  readonly keyboard: DesktopKeyboardApi
  readonly shortcuts: DesktopShortcutsApi
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}
```

Upstream exposes the full API only to the `dsh-app://app` main frame and a stub `{ protocolVersion: 1 }` otherwise (`apps/desktop/src/preload-app.ts:99`). The port reproduces that restriction: the full object is installed only in the owned application document.

`updates` is backed by the `update_*` commands and the `dsh://update/state` event in [`tauri-contract.md`](tauri-contract.md). `DesktopUpdatePresentation` is the upstream type verbatim (`{ phase, version?, percent?, failure? }`).

## 2. `browser: DesktopBrowserBridge`

Type home: `_upstream/packages/client/ui-sidebar-browser/types`. Consumer: `_upstream/packages/client/ui-sidebar-browser/src/client/index.ts:70-71`.

Semantics to preserve — this is the Sidebar Browser panel's guest-page surface:

| Member | Behaviour |
|---|---|
| `acquire(...)` | Obtain a guest lease. A guest must match a **main-issued** lease and partition. |
| `release(...)` | Drop the lease and destroy the guest document. |
| `openRequested` notification | The shell may open a URL the panel requested. |

Security posture to preserve (`apps/desktop/README.md` §Installation ownership): only the main application window enables `<webview>`; guests keep sandbox, context isolation and Web security **without** Node integration and without a guest preload; Browser IPC listeners exist only for the application document; Host authentication remains required independently of URL filtering.

> **Known limitation.** Tauri has no `<webview>` guest surface. This bridge is therefore **not implemented** in this pass and the Sidebar Browser panel will not host arbitrary pages. Tracked as parity-matrix S23 and limitations B3. Implement it as a stub that returns a typed `not_desktop`/`unsupported` error through `DshError::Other { code: "browser_guest_unavailable" }` — never a silent no-op, and never a fake guest.

## 3. `keyboard: DesktopKeyboardApi` and `shortcuts: DesktopShortcutsApi`

Type home: `_upstream/packages/client/shortcuts/protocol`. Consumers: `_upstream/packages/client/shortcuts/src/client/index.ts:45` and `storage.ts:39`.

Backed by the `shortcutsInput`, `shortcutsCloseWindow`, `shortcutsGet`, `shortcutsEdit`, `shortcutsChanged` and `shortcutsRecording` channels upstream (`apps/desktop/src/ipc.ts:8-13`), which in the port are the `dsh://shortcuts/*` events and the `shell_close_window` command in [`tauri-contract.md`](tauri-contract.md).

Behaviour to preserve (`apps/desktop/README.md` §Key technical decisions):

| # | Behaviour |
|---|---|
| K1 | Shortcut overrides live in `keybindings.json` under the application user-data directory, **separately from `DSH_HOME`**. |
| K2 | The main process validates and serialises changes before publishing accepted bindings. |
| K3 | Failed reads retain the last accepted bindings and **block edits**, including Restore All. Unreadable and future-version files remain unchanged. |
| K4 | Complete accepted bindings are intercepted before main-document, embedded-frame and browser-guest input, **including editing and terminal input**. |
| K5 | Recording and input-method composition are protected and never intercepted. |
| K6 | Two-key chords leave the first key's initial press available to the page and do not intercept its release; complete chords and their repeats are consumed. |
| K7 | Every overlay opening or closing invalidates pending chord state. |
| K8 | Accepted commands are forwarded once through the trusted bridge. |
| K9 | Chords have no native menu accelerator. |
| K10 | The macOS File menu displays the accepted single-key binding, including arrow keys, and routes Close Page or Window through the client page owner. |

Binding set to support (from [`../analysis/ui-inventory.md`](../analysis/ui-inventory.md) §6): **29 application bindings** — 18 configurable commands with per-profile defaults, plus 11 fixed rows (send / newline / complementary / `/` / `@` / Esc-Esc stop / approval Enter / approval Esc / menu move / menu select / menu dismiss) — and **8 desktop-native accelerator groups** (F12, ⌘⌥I, ⌘W file close, ⌘M, ⌘H, ⌘Q, Edit roles, dev reload).

Focus rules to preserve: `focusWithoutRing`, `data-modal-autofocus`, `useModalLayer`, and menu keyboard walk.

## 4. Other shell-owned surfaces

| Global / surface | Port backing | Status |
|---|---|---|
| `__DSH_DIRECTORY_PICKER__` | `shell_pick_directory` | specified — not yet implemented |
| `__DSH_LOCALE__` | `shell_locale_get` / `shell_locale_set` | specified — not yet implemented |
| `dshOnboarding` | `credential_has` + `runtime_boot_ready` ordering | specified — not yet implemented |
| `dshPlatform` (`open(page, bounds)`, `setBounds`, `close()`) | none | **not implemented** — needs the embedded Platform document surface of parity-matrix S22 / limitations B2. Return a typed `DshError::Other { code: "platform_view_unavailable" }`. |
| `dshWelcome` | welcome window (parity-matrix S20 / limitations B1) | **not implemented** in this pass |
| `dshUpdateDialog`, `dshMandatoryUpdate` | shell-owned dialog pages | update presentation is implemented (`update_*`); the standalone dialog documents are not |
| DOM markers `html[data-platform]`, `html[data-windows-titlebar]`, `html[data-ds-theme-source]`, `data-fullscreen` | Tauri init script sets `data-platform`, `data-windows-titlebar`, `data-ds-theme-source`; `shell_theme_set` keeps them in sync | specified — not yet implemented |

These DOM markers are **required** for correct desktop layout and native-chrome synchronisation; the shared UI CSS scopes on `html[data-platform]` and the Windows title-bar rules key off `html[data-windows-titlebar]` with `--dsh-windows-titlebar-height`.

## 5. Rules

1. Every unimplemented bridge returns a **typed, explicit** error. Never a silent no-op, never a fabricated result, never a dead control.
2. Where a bridge cannot work, the corresponding UI must degrade exactly as it does when the global is absent (see `ui-backend-protocol.md` §8), rather than entering a broken state.
3. No bridge may expose raw Tauri IPC, filesystem access, a shell, or arbitrary package-manager arguments to any renderer (`apps/desktop/README.md` §Installation ownership).
