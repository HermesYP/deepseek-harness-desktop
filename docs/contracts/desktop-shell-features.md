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

`browser` is guest-backed (§2), `keyboard`/`shortcuts` are backed by the `shell_shortcuts_*` commands and `dsh://shortcuts/*` events (§3), and `updates` is backed by the `update_*` commands. The port composes the product bridge in `port/ui/desktop-bridge/shell-boot.ts`, fill-if-absent per A11. The shipped call composes `keyboard`, `shortcuts` and `updates` **only**: `browser` and `dshPlatform` are capabilities a composition must supply explicitly, and the shipped build supplies neither, so both members are absent and the preserved consumers select their Web fallbacks (§2, §4).

## 2. `browser: DesktopBrowserBridge`

Type home: `_upstream/packages/client/ui-sidebar-browser/types`. Consumer: `_upstream/packages/client/ui-sidebar-browser/src/client/index.ts:70-71`.

Semantics to preserve — this is the Sidebar Browser panel's guest-page surface:

| Member | Behaviour |
|---|---|
| `acquire(...)` | Obtain a guest lease. A guest must match a **main-issued** lease and partition. |
| `release(...)` | Drop the lease and destroy the guest document. |
| `openRequested` notification | The shell may open a URL the panel requested. |

Security posture to preserve (`apps/desktop/README.md` §Installation ownership): only the main application window enables `<webview>`; guests keep sandbox, context isolation and Web security **without** Node integration and without a guest preload; Browser IPC listeners exist only for the application document; Host authentication remains required independently of URL filtering.

**Current status — fail-closed (2026-10-10).** Rust production admission remains `false,false`; the shell does **not** advertise `globalThis.dshDesktop.browser` when native guests are unavailable, so the preserved panel selects its web/iframe fallback. Dormant source implements lease-bound navigation/observation and presentation adapters but does not establish an admitted native browser. Direct unavailable acquisition refuses `browser_guest_unavailable`, never a fake guest. See [A13](tauri-contract.md) and [the repair ledger](../repair-ledger-2026-10-10.md).

> **Unaccepted native composition gate (S23).** A dormant adapter must reproduce the retained Electron presentation/element face, consume full native observations, bind subscriptions to the right lease/generation, and await hide/dispose without dropping native ownership. Source tests alone do not prove a retained panel actually hosts a native page. The earlier always-advertised bridge/composition claim is withdrawn; do not enable admission until isolated live composition, guest IPC denial, navigation/session policy, DPI, and teardown gates pass.

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
| `__DSH_DIRECTORY_PICKER__` | `shell_pick_directory` | implemented; Rust owns the native dialog and the TypeScript glue keeps a fill-if-absent fallback |
| `__DSH_LOCALE__` | `shell_locale_get` / `shell_locale_apply` | implemented (A4: `onChange` reports the active locale and persists nothing) |
| `dshOnboarding` | the authenticated Host RPC routes (`settings/describe`, `llm/listConfigurableProviders`, `credentials/describe`) + `shell_onboarding_set_active` | implemented (A12: the Host is the model-credential authority, never the Rust keyring) |
| `dshPlatform` (`open(page, bounds)`, `setBounds`, `close()`) | `guest_platform_*` via `createGuestPlatformBridge()` | **bridge definition exists; the shipped shell installs nothing.** `installDesktopShellMarkers()` is called with no guests, so `dshPlatform` stays absent and the account plugin keeps its `window.open` route. A composed caller that supplies the bridge issues the real `guest_platform_*` commands; a shell with no Platform session refuses `platform_account_unavailable` |
| `dshWelcome` | welcome window (parity-matrix S20 / limitations B1) | **not implemented** in this pass |
| `dshUpdateDialog`, `dshMandatoryUpdate` | shell-owned dialog pages | update presentation is implemented (`update_*`); the standalone dialog documents are not |
| DOM markers `html[data-platform]`, `html[data-windows-titlebar]`, `html[data-ds-theme-source]`, `data-fullscreen` | Tauri init script sets `data-platform`, `data-windows-titlebar`, `data-ds-theme-source`; `shell_theme_set` keeps them in sync | Rust-owned; the TypeScript glue **reads** and reports them and never writes them |
| `__DSH_HOST_PATHS__` | `shell_host_paths` / `shell_host_paths_consume` plus the shell's own initialization script | Rust-owned (`pathFor`, `adopt`, `pending`, `consume`). The TypeScript glue never writes it and never fabricates a path |

These DOM markers are **required** for correct desktop layout and native-chrome synchronisation; the shared UI CSS scopes on `html[data-platform]` and the Windows title-bar rules key off `html[data-windows-titlebar]` with `--dsh-windows-titlebar-height`.

## 5. Rules

1. Every unimplemented bridge returns a **typed, explicit** error. Never a silent no-op, never a fabricated result, never a dead control.
2. Where a bridge cannot work, the corresponding UI must degrade exactly as it does when the global is absent (see `ui-backend-protocol.md` §8), rather than entering a broken state.
3. No bridge may expose raw Tauri IPC, filesystem access, a shell, or arbitrary package-manager arguments to any renderer (`apps/desktop/README.md` §Installation ownership).
4. **Installing a bridge is not qualification.** A typed bridge that issues the declared commands is a definition; whether the shell creates a real guest, and whether a preserved consumer can reach it, are separate facts that must each be verified before parity is claimed. The shipped composition installs neither `dshDesktop.browser` nor `dshPlatform`; the dormant definitions behind them issue real commands when a composition supplies them, and the retained Sidebar Browser's route to an admitted native guest and an admitted Platform document remain unqualified gaps (§2, §4).
5. **A name is not an identity.** Where a native fact and a DOM fact can only be correlated by file name (a native drop's absolute paths against the browser's `File` list), a correlation is resolved only when the name is unique on both sides. An ambiguous name yields no path and the file uploads — never a guessed ordinal, which would cite an absolute path the user may never have dropped.

## 6. Renderer hardening: `withGlobalTauri`, CSP, and what each policy covers

Two documents with two policies are involved, and they are not interchangeable.

* **The shell document** — what the window navigates to — is served by the loopback gateway on `http://127.0.0.1:<port>/`. The gateway answers `/` and `/index.html` with an enforcing `Content-Security-Policy` by default (`SHELL_CONTENT_SECURITY_POLICY` in `crates/dsh-gateway/src/lib.rs`; `GatewayConfig::loopback` serves it unless `without_shell_content_security_policy` explicitly opts out). Tauri's `app.security.csp` is **not** what protects this document: the framework's CSP machinery applies to its own `tauri`/asset protocol, not to an external URL.
* **App-protocol documents** — today only the mandatory-policy webview (`WebviewUrl::App("mandatory-policy.html")`, which also carries its own `<meta http-equiv="Content-Security-Policy">`, enforced in addition) — are covered by `app.security.csp` in `port/src-tauri/app/tauri.conf.json`. That value declares the **same directive set** the gateway serves, so the two cannot drift silently. It is a source declaration only: Tauri additionally injects build-time nonce/hash sources into the response for packaged HTML (the page's own inline script is hashed, so it survives), which is why changing it requires a rebuild and why the declaration alone proves nothing about the document that boots.

`withGlobalTauri` is `false`. The flag only controls whether Tauri injects the plugin global API on `window.__TAURI__`; the internal channel `window.__TAURI_INTERNALS__` is always installed, and `port/ui/desktop-bridge/index.ts` resolves that first (`__TAURI__.core` remains only as a fallback for a build configured the other way). Disabling the global removes a script-injection convenience surface without removing any bridge capability, and the init scripts remain main-frame-only.

The declared policy keeps `'unsafe-inline'` and `'unsafe-eval'` for scripts. That is deliberate and must never be described as a hash/nonce-only or `'strict-dynamic'` policy:

* the served `index.html` carries the `__DSH_BOOT_READY__` inline literal, and the gateway re-asserts it for a document that lacks it;
* the Host's boot table is applied at runtime through inline `<script>` elements with no nonce;
* the shipped client bundle contains the client expression evaluator (`new Function`/`eval`).

A policy without those sources cannot boot this renderer. What the policy does establish is narrower: no remote or custom scheme is reachable except the Tauri IPC channel, `base-uri`/`object-src`/`form-action`/`frame-ancestors` are `'none'`, and every other resource kind is limited to the document origin, `data:` and `blob:` — the forms the preserved client uses for attachments and document preview.

Stated limit: the config value and the gateway constant are pinned by source/config assertions, and the served header by response-header tests. Neither proves that WebView2 enforced a policy or that every resource kind a preserved client can request is covered; that needs a live window before any enforcement claim.
