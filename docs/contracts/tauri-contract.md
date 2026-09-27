# Tauri command and event contract (port-owned)

> **READ THE AMENDMENTS FIRST.** [`## Amendments (lead rulings)`](#amendments-lead-rulings) (A1–A10) **supersede** the base tables below wherever they conflict, and several base rows are stale (finding R-11). Known superseded base text: the `dsh://shortcuts/changed` payload type name (A1), `dsh://shortcuts/menu` and `ShortcutsMenuEvent` (withdrawn by A10), `shell_close_window`'s request shape (A9), `LocaleState`'s fields (A9), `AppInfo`'s `credentialRef` (A5), and `shell_locale_apply` / `shell_onboarding_set_active` (A4/A9 — present only in the amendments). Implement from the amendments where they speak.

Status: binding. This is the interface between the UI-fidelity team and the Rust team. It is owned by the lead. Changes require lead approval and a corresponding change to `port/ui/src/desktop-bridge.ts` and `port/src-tauri/app/src/commands.rs` in the same change.

## Scope

This document specifies only the channel that the port **adds**: the typed boundary between the preserved upstream web client and the Rust application core.

Two channels are preserved from upstream and are deliberately **not** re-specified here:

| Channel | Spec | Owner |
|---|---|---|
| Web client ↔ agent runtime (authenticated HTTP API + WebSocket stream) | `docs/contracts/ui-backend-protocol.md` | unchanged upstream protocol |
| Rust core ↔ dsh host process (Desktop-Host lifecycle protocol, generation 4) | `docs/contracts/desktop-host-lifecycle-protocol.md` | message vocabulary preserved |

## Naming and typing rules

- Rust `#[tauri::command]` names are `snake_case`; the TypeScript mirror calls them with the same string. Command names are prefixed with a domain (`runtime_*`, `settings_*`, `credential_*`, `shell_*`, `update_*`, `dev_*`) and never collide with upstream RPC method names.
- Every payload is `serde` `Serialize`/`Deserialize` on the Rust side and has a hand-written TypeScript literal type in `port/ui/src/desktop-bridge/protocol.ts`. The two are kept in lockstep by the fixture test `port/src-tauri/crates/dsh-core/tests/protocol_fixtures.rs`, which asserts the Rust types round-trip the canonical JSON fixtures in `port/fixtures/protocol/*.json`. The TypeScript side asserts the same fixtures in `port/ui/tests/protocol.spec.ts`.
- Every fallible command returns `Result<T, DshError>`. `DshError` is the single error taxonomy below. A command never returns a raw OS error string as its only diagnostic.
- No command returns secrets. `credential_*` commands return metadata (provider, reference id, `hasSecret: boolean`) and never the secret value.

## Error taxonomy

```rust
#[derive(Debug, Clone, Serialize, Deserialize, thiserror::Error)]
#[serde(tag = "kind", content = "detail", rename_all = "snake_case")]
pub enum DshError {
  /// The requested object does not exist (unknown session id, unknown setting key).
  NotFound { entity: String, id: String },
  /// Caller supplied a value the domain rejects.
  InvalidArgument { field: String, reason: String },
  /// An underlying OS or filesystem operation failed.
  Io { operation: String, path: Option<String>, message: String },
  /// The dsh host process is not in a state that can serve the request.
  RuntimeUnavailable { state: String, reason: String },
  /// The credential store refused or could not complete an operation.
  CredentialStore { operation: String, message: String },
  /// A timed wait expired.
  Timeout { operation: String, millis: u64 },
  /// The operation was cancelled by the user.
  Cancelled { operation: String },
  /// Anything else, with a stable machine code and a human message.
  Other { code: String, message: String },
}
```

`DshError` serializes to `{ "kind": ..., "detail": { ... } }`. The UI renders `message`/`reason`/`operation` text verbatim; it never renders `code` or `message` from `Other` as the sole explanation of a known condition.

## Commands (UI → Rust)

### Application identity and lifecycle

| Command | Request | Response | Notes |
|---|---|---|---|
| `shell_app_info` | `void` | `AppInfo { productName, version, protocolGeneration, runtimeVersion, platform, arch, locale }` | `protocolGeneration` is `4`. |
| `shell_locale_get` | `void` | `LocaleState { preference: "en" \| "zh" \| null, effective: "en" \| "zh", source: "preference" \| "os" \| "default" }` | Mirrors the welcome-window locale rule in `apps/desktop/README.md`. |
| `shell_locale_set` | `{ preference: "en" \| "zh" \| null }` | `LocaleState` | `null` restores automatic selection and writes no preference. |
| `shell_window_set_fullscreen` | `{ enabled: bool }` | `void` | macOS/Windows fullscreen parity. |
| `shell_theme_set` | `{ theme: "system" \| "light" \| "dark" }` | `void` | Backs the `nativeThemeSet` marker. |
| `shell_appearance` | `void` | `Appearance { theme, accent, captionHeightDip, reduceMotion, reduceTransparency, increaseContrast }` | Backs the Windows caption colour sync. |
| `shell_menu_action` | `{ id: MenuActionId }` | `void` | Lets page-owned commands (e.g. "Close Page or Window") route through the client page owner. |
| `shell_open_external` | `{ url: string }` | `void` | External-link handling. Rejects non-`http`/`https`/`mailto` schemes. |
| `shell_clipboard_write` | `{ text: string }` | `void` | |
| `shell_clipboard_read` | `void` | `{ text: string }` | |
| `shell_quit_request` | `void` | `void` | Starts the ordinary quit flow (inspection + confirmation). Idempotent. |
| `shell_close_window` | `void` | `void` | Backs the `shortcutsCloseWindow` channel. |

`MenuActionId` is a closed union: `about`, `check_for_updates`, `exit`, `undo`, `redo`, `cut`, `copy`, `paste`, `delete`, `select_all`, `close_page_or_window`, `reload_page`, `restart_app_and_host`, `toggle_devtools`, `minimize`, `hide`, `hide_others`, `show_all`, `zoom_in`, `zoom_out`, `reset_zoom`.

### Desktop boot bridge

The upstream client entry calls `globalThis.dshDesktopBoot.ready()` and `globalThis.dshDesktopBoot.failed(message)`. The port supplies these from a Tauri initialization script that wraps the following two commands.

| Command | Request | Response | Notes |
|---|---|---|---|
| `runtime_boot_ready` | `void` | `BootPayload { injections: IndexInjection[], streamBaseUrl: string, authenticatedUrl: string }` | Resolves when the host control channel has reported `ready`. `IndexInjection` is the upstream type from `packages/host/webserver/src/injections.ts` and is re-declared verbatim in Rust. |
| `runtime_boot_failed` | `{ message: string }` | `void` | Triggers the native fatal-recovery dialog. Mirrors `apps/desktop/src/fatal-recovery.ts`. |

### Runtime supervision

| Command | Request | Response | Notes |
|---|---|---|---|
| `runtime_status` | `void` | `RuntimeStatus { state: RuntimeState, url: string \| null, startedAt: string \| null, lastError: string \| null }` | |
| `runtime_restart` | `void` | `RuntimeStatus` | Development-only surface. Waits for host shutdown before relaunching, per `apps/desktop/README.md`. |
| `runtime_quit_inspection` | `void` | `QuitInspection { activeTasks: bool, scheduledTasks: bool, error: string \| null }` | Fails closed: an unavailable host reports `activeTasks: true`, matching upstream. |

`RuntimeState` is a closed union: `starting`, `ready`, `stopping`, `stopped`, `failed`.

### Settings

| Command | Request | Response | Notes |
|---|---|---|---|
| `settings_get` | `{ key: string }` | `SettingValue` | |
| `settings_set` | `{ key: string, value: SettingValue }` | `void` | Atomic write. |
| `settings_list` | `void` | `Record<string, SettingValue>` | |
| `settings_reset` | `{ key: string }` | `void` | |

`SettingValue` is a closed union over `string \| number \| boolean \| null`. The Rust store is versioned and is the authority for desktop-owned preferences; Harness-owned settings remain in `$DSH_HOME` and are not duplicated.

### Credentials (OS-backed)

| Command | Request | Response | Notes |
|---|---|---|---|
| `credential_list` | `void` | `CredentialRef[]` | Metadata only. |
| `credential_has` | `{ provider: string, reference: string }` | `{ present: bool }` | |
| `credential_store` | `{ provider: string, reference: string, secret: string }` | `void` | Secret travels once over the invoke channel and is written to the OS store. It is never logged, echoed, or persisted to disk by Rust. |
| `credential_delete` | `{ provider: string, reference: string }` | `void` | |

`CredentialRef { provider, reference, hasSecret, updatedAt }`.

### Directory picker

| Command | Request | Response | Notes |
|---|---|---|---|
| `shell_pick_directory` | `{ title: string \| null, defaultPath: string \| null }` | `{ path: string \| null }` | Native folder dialog owned by the shell. Concurrent requests share one dialog; cancellation returns `null` and stays retryable (upstream `apps/desktop/src/directory-picker.ts`). |

### Update presentation

| Command | Request | Response | Notes |
|---|---|---|---|
| `update_status` | `void` | `DesktopUpdatePresentation` | Verbatim upstream type from `apps/desktop/src/ipc.ts`. |
| `update_open` | `void` | `void` | Opens main-process-owned confirmation. Product documents cannot choose artifacts or authorise installation. |
| `update_check` | `void` | `DesktopUpdatePresentation` | |

### Shortcut configuration

Backs `dshDesktop.shortcuts`, the upstream `DesktopShortcutsApi`. Ratified by the lead after the Rust lane found that `desktop-shell-features.md` mandated this behaviour while this contract declared no UI→Rust channel for it (Rule 1 made the two documents contradictory).

| Command | Request | Response | Notes |
|---|---|---|---|
| `shell_shortcuts_get` | `{ definitions: ShortcutDefinition[] }` | `ShortcutConfigSnapshot` | Verbatim upstream shape (`_upstream/packages/client/shortcuts/protocol`). Backs `shortcutsGet`. |
| `shell_shortcuts_edit` | `{ edit: ShortcutEdit, revision: string }` | `ShortcutSaveResult` | Verbatim upstream shape. Backs `shortcutsEdit`. |
| `shell_shortcuts_recording` | `{ active: bool }` | `void` | Backs `shortcutsRecording`. Also mirrored as `dsh://shortcuts/recording`. |

Persistence and semantics (`desktop-shell-features.md` K1–K3):

- **K1** bindings live in `keybindings.json` in the application user-data directory, **separate from `DSH_HOME`** — so `settings_*` must not back these commands.
- **K2** the Rust core validates and serialises changes before publishing accepted bindings.
- **K3** a failed read retains the last accepted bindings and **blocks edits**, including Restore All; unreadable and future-version files are left unchanged.

`ShortcutBinding`, used by `dsh://shortcuts/changed`, is the upstream `NormalizedBinding` plus an `id` field — the accepted effective binding rows. All three request/response types and `ShortcutBinding` are pinned by the shared fixtures in `port/fixtures/protocol/`, and both language sides must round-trip them byte-identically.

## Events (Rust → UI)

Event names are namespaced `dsh://`. Payloads are JSON.

| Event | Payload | Notes |
|---|---|---|
| `dsh://runtime/state` | `RuntimeStatus` | Emitted on every transition. |
| `dsh://locale/changed` | `LocaleState` | Backs `localeChanged`. |
| `dsh://appearance/changed` | `Appearance` | Backs `windowsAppearance`. |
| `dsh://shortcuts/changed` | `{ bindings: ShortcutBinding[] }` | Backs `shortcutsChanged`. |
| `dsh://shortcuts/recording` | `{ recording: bool }` | Backs `shortcutsRecording`. |
| `dsh://shortcuts/input` | `DesktopShortcutInput` **verbatim** (`_upstream/packages/client/shortcuts/src/native.ts:6-10`) — `{ revision, kind, frameName, code, control, alt, shift, meta, repeat }` plus upstream's own `kind: 'menu'` arm carrying `commandId: ShortcutCommandId` | Backs `shortcutsInput` and drives `DesktopKeyboardApi.subscribe`. Menu-routed page commands (K10, e.g. Close Page or Window) arrive on the **`kind: 'menu'` arm**, per amendment A10. |
| `dsh://update/state` | `DesktopUpdatePresentation` | Backs `updatesPresentation`. |
| `dsh://shell/window` | `{ state: "shown" \| "hidden" \| "focused" \| "blurred" }` | Lets the page react to hide/show (drafts and scroll survive; the page is never reloaded). |
| `dsh://shell/quit-confirmed` | `{ reason: "user" \| "installer" \| "update" \| "fatal-recovery" \| "os-shutdown" }` | Terminal. |

## Marker globals the Rust core must install

The preserved client reads these from `globalThis`. The port installs them with a Tauri initialization script, replacing upstream's Electron preloads (`apps/desktop/src/preload-*.ts`).

| Global | Upstream source | Required shape | Behaviour when absent |
|---|---|---|---|
| `globalThis.__DSH_BOOT_READY__` | `packages/host/webserver/src/injections.ts` (`READY_MARKUP`) | `PromiseWithResolvers<void>` | Desktop boot throws `desktop web: boot readiness is missing`. |
| `globalThis.dshDesktopBoot` | `apps/web/src/main.ts` | `{ ready(): Promise<{injections, streamBaseUrl}>, failed(message): Promise<void> }` | Client runs in Web mode. |
| `globalThis.__DSH_TRANSPORT__` | set by `apps/web/src/main.ts` | `{ ownsHost: true, streamBaseUrl }` | Stream mux falls back to `document.baseURI`. |
| `globalThis.__DSH_HOST_PATHS__` | `apps/desktop/src/preload-app.ts:81-83` | `{ pathFor(file: File): string }` | Dragged/pasted folders and path-bearing files do not become `@path` chips (`packages/client/ui-conversation/src/client/apply.ts:107`). |
| `globalThis.__DSH_DIRECTORY_PICKER__` | `apps/desktop/src/preload-app.ts:75-77` | `{ pick(): Promise<string \| null> }` | The non-native browse picker fallback is used. |
| `globalThis.__DSH_LOCALE__` | `apps/desktop/src/preload-app.ts:102-105` | `{ read(): Promise<{languages, preference}>, onChange(locale): void }` | Ordinary browser locale detection. |
| `globalThis.dshOnboarding` | `apps/desktop/src/preload-app.ts:61-64` | `{ hasApiKey(): Promise<boolean>, setActive(active: boolean): void }` | The web credential onboarding path runs instead of the desktop one. |
| `globalThis.dshDesktop` | `apps/desktop/src/preload-app.ts:99` | `{ protocolVersion: 1, browser, keyboard, shortcuts, updates }` — the upstream `DshDesktopProductApi` (`apps/desktop/src/ipc.ts:71-81`) | Web mode: browser/shortcuts/updates bridges disabled and web credential onboarding registers (`ui-settings-models/src/client/index.ts:81` tests `'dshDesktop' in globalThis`). |

> **Correction (lead, after interface review).** An earlier draft of this table named the desktop marker `__DSH_DESKTOP__`. That identifier **does not occur anywhere in the upstream tree at this commit**. The marker the client actually tests is `'dshDesktop' in globalThis`. Implement `dshDesktop`; do not implement `__DSH_DESKTOP__`.

`dshDesktop` is the highest-fidelity desktop surface and is implemented by wrapping the commands above. `browser`, `keyboard` and `shortcuts` are specified in `docs/contracts/desktop-shell-features.md`.

Two further globals are **not** shell-owned and must arrive through the Host injection table: `window.__DSH_BOOT__` (the `WebBootGraph` client entry graph) and `window.__ModuleLoader__` (the bundle-registration queue facade). Both are **required** and boot fails loudly without them. `__DSH_CONNECTION_RECOVERY__` also arrives as an injection row. See `docs/contracts/ui-backend-protocol.md` §7.3.

## Amendments (lead rulings)

Ratified after both implementation lanes escalated divergences. Where an amendment conflicts with anything above it, **the amendment wins**; the superseded text is kept so the revision history stays auditable. Logged as findings F-6…F-10 in [`../verification-report.md`](../verification-report.md).

### A1 — Shortcut type names: upstream keeps upstream's name

Supersedes the `ShortcutBinding` wording in `### Shortcut configuration`.

| Type | Shape | Used in |
|---|---|---|
| `ShortcutBinding` | `{ code: string; secondCode?: string; modifiers: string[] }` — **upstream verbatim**, `_upstream/packages/client/shortcuts/src/binding.ts:15-19`, **no `id`** | inside `ShortcutDefinition`, `ShortcutDocument`, `ShortcutEdit`, `ShortcutConfigSnapshot`, `ShortcutSaveResult` |
| `ShortcutBindingRow` | `{ id: string } & ShortcutBinding` — the accepted effective binding **row** | `dsh://shortcuts/changed` → `{ bindings: ShortcutBindingRow[] }` |

Rule: when upstream declares a type, the port's mirror keeps upstream's name and upstream's exact shape. A port-specific composite gets a port-specific name. Fixture files must round-trip one wire form each and both language sides must round-trip **every** file in `port/fixtures/protocol/`.

### A2 — `dsh://shortcuts/input` carries upstream's input shape; menu dispatch gets its own event

Supersedes the `dsh://shortcuts/input` row.

The `{ chord, source }` payload could not drive `dshDesktop.keyboard` (`DesktopKeyboardApi.subscribe`), whose consumers need the upstream `DesktopShortcutInput`. Rule: **carry upstream verbatim**.

| Event | Payload | Notes |
|---|---|---|
| `dsh://shortcuts/input` | `DesktopShortcutInput` verbatim — `{ revision, kind, frameName, code, control, alt, shift, meta, repeat }` (`_upstream/apps/desktop/src/preload-app.ts:18-36`) | Drives `DesktopKeyboardApi.subscribe`. Do not add invented fields to this type. |
| `dsh://shortcuts/menu` | `{ commandId: MenuActionId }` | **New.** Menu-routed page commands (K10, e.g. Close Page or Window). The page owner dispatches them. |

This **retracts** the earlier `chord: "menu:<commandId>"` convention: overloading a key chord to carry a menu identifier invented wire fields inside an upstream type. Menu dispatch is not a key chord and must not be encoded as one.

### A3 — Shortcut configuration commands do exist

No change required, but for the avoidance of doubt: `shell_shortcuts_get`, `shell_shortcuts_edit` and `shell_shortcuts_recording` are declared in `### Shortcut configuration` above. `dshDesktop.shortcuts` is implementable and must not be left uninstalled.

### A4 — Locale: reporting the active locale is not saving a preference

`__DSH_LOCALE__.onChange(locale)` reports the UI's current locale so the shell can update its dictionary and menus. Upstream writes **no** preference on this path (`_upstream/packages/client/locale/src/client/bootstrap.ts:14-16`), while `shell_locale_set` persists one. Split them:

| Command | Request | Response | Persists |
|---|---|---|---|
| `shell_locale_set` | `{ preference: "en" \| "zh" \| null }` | `LocaleState` | **Yes** (`null` = automatic, writes nothing) |
| `shell_locale_apply` | `{ locale: "en" \| "zh" }` | `LocaleState` | **No** — updates the shell's current dictionary and menu only |

`__DSH_LOCALE__.onChange` maps to `shell_locale_apply`, never to `shell_locale_set`.

### A5 — Onboarding credential coordinates come from the runtime, never a hardcoded pair

`dshOnboarding.hasApiKey()` must call `credential_has` with the **official provider's configured reference**, which upstream takes from the credential service rather than a constant. Rule: the coordinates are supplied at boot and are not hardcoded in Rust or TypeScript.

Extend `AppInfo` (returned by `shell_app_info`) with:

```typescript
readonly credentialRef: { provider: string; reference: string } | null
```

`null` means no official provider reference is configured, and `hasApiKey()` then resolves `false`. `credentialRef` is a *reference identifier*, not a secret; it may appear in `AppInfo` and in logs.

### A6 — Fixtures contain only contract types

`port/fixtures/protocol/desktop-release.json` described a `DesktopRelease` type the contract never declared. Rule: **every fixture file names a type declared in this contract or in `desktop-shell-features.md`.** Rename that fixture to `app-info.json` and give it the `AppInfo` shape (including A5's `credentialRef`); if richer release metadata is genuinely needed, extend `AppInfo` with declared optional fields and update this document in the same change.

### A7 — Fixture files are type-named; one wire form per file

`port/fixtures/protocol/` uses **one** naming scheme: `<type-name-kebab>.json`, one canonical wire form per file. Method, not filename, distinguishes a request from a response — each file simply states "this type's wire form".

Examples: `app-info.json`, `shortcut-binding.json`, `shortcut-binding-row.json`, `shortcut-config-snapshot.json`, `shortcut-save-result.json`, `desktop-shortcut-input.json`, `menu-action-id.json`, `dsh-error.json`, `index-injection.json`, `desktop-update-presentation.json`, `runtime-status.json`, `locale-state.json`, `appearance.json`, `credential-ref.json`, `boot-payload.json`, `shortcuts-changed-event.json`.

Ownership and rules:

1. `dsh-core` generates and owns the fixture files (`port/fixtures/**`).
2. Every command and event payload gets its own declared type name, so it becomes a type-named file — e.g. `ShortcutsChangedEvent` = `{ bindings: ShortcutBindingRow[] }`.
3. The TypeScript mirror must round-trip **every** file present, with no exclusions, and must fail loudly on a file it cannot round-trip.
4. Neither side invents a parallel naming scheme (`command-*`, `event-*`). A missing wire form is requested from the lead and added by `dsh-core`.
5. A6 still applies: every fixture names a type declared here or in `desktop-shell-features.md`.

Reason: one home per fact. Two naming schemes in one shared directory drift silently and stop the round-trip guarantee from meaning anything.

### A8 — Variant arms get their own fixture file; upstream types never absorb port fields

Clarifies A7's "one wire form per file".

| Case | File naming | Example |
|---|---|---|
| A type with exactly one form | `<type-kebab>.json` | `clipboard-text.json`, `settings-map.json`, `credential-presence.json`, `shortcuts-menu-event.json` |
| A nullable / optional arm | `<type-kebab>.json` for the set arm, `<type-kebab>.null.json` for the empty arm | `picked-directory.json`, `picked-directory.null.json` |
| A union discriminant declared by **upstream** | one file per upstream variant: `<type-kebab>.<variant>.json`, using upstream's own discriminant values | `desktop-shortcut-input.<kind>.json` |

**Hard rule.** A type upstream declares is never given fields the port invented. `DesktopShortcutInput` is upstream's shape exactly (`{revision, kind, frameName, code, control, alt, shift, meta, repeat}`) and its `kind` takes upstream's own values only. It carries **no** `commandId` and no menu dispatch — menu commands travel only on `dsh://shortcuts/menu` as `ShortcutsMenuEvent`. Encoding a menu identifier inside a keyboard input type is the defect A2 already removed; do not re-introduce it.

`SettingValue`, `MenuActionId` and request payloads each get their own type-named fixture (`setting-value.json`, `menu-action-id.json`, `locale-set-request.json`, `locale-apply-request.json`, `shortcuts-get-request.json`, `shortcuts-edit-request.json`, `shortcuts-recording-request.json`, `credential-store-request.json` — synthetic secret only, never a real one, `pick-directory-request.json`).

### A9 — Three commands widened to match their consumers

Raised by the UI lane when the preserved client's real call signatures did not fit the declared commands. Each is a widening, not a behaviour change.

| Command | Was | Now | Why |
|---|---|---|---|
| `shell_close_window` | request `void` | request `{ revision: string }` | `DesktopKeyboardApi.closeWindow(revision)` carries a revision; dropping it lost a correlation value the client uses to retire the binding's dispatch. |
| `shell_onboarding_set_active` | *did not exist* | new: request `{ active: bool }`, response `void` | `dshOnboarding.setActive(active)` (`apps/desktop/src/preload-app.ts:61-64`) had no transport. It signals onboarding visibility so the shell can hold or release the workspace. |
| `LocaleState` | `{ preference, effective, source }` | `{ preference, effective, source, languages: string[] }` | `__DSH_LOCALE__.read()` returns `{languages, preference}` (`apps/desktop/src/main.ts:703-709`). Deriving `languages` as `[effective]` is a silent narrowing. `languages` is the OS language order used for automatic selection. |

Two accepted adaptations, recorded so they are not mistaken for parity:

- `dshDesktop.shortcuts.subscribe(listener)` is adapted by re-issuing `shell_shortcuts_get` on each `dsh://shortcuts/changed` event. The snapshot always comes from Rust and is **never fabricated** in TypeScript. This is equivalent in observable behaviour but is not upstream's push-of-a-snapshot shape.
- `dshDesktop.browser` is a typed `DshError::Other { code: "browser_guest_unavailable" }` stub (parity-matrix D5 / limitations B3), never a silent no-op.

### A10 — CORRECTION: `DesktopShortcutInput` does have a menu arm upstream (retracts A2/A8's hard rule)

Found by the independent adversarial review (finding R-05). **The lead was wrong twice here and this supersedes A2's retraction and A8's "hard rule".**

`_upstream/packages/client/shortcuts/src/native.ts:6-10` declares `DesktopShortcutInput` **with** a `kind: 'menu'` arm carrying `commandId` (`ShortcutCommandId`), covered by `_upstream/packages/client/shortcuts/tests/native.client.spec.ts:88`. The preserved client already mirrors it at `port/ui/desktop-bridge/protocol.ts:347-360`.

Consequences — all in upstream's favour:

1. `dsh://shortcuts/input` carries `DesktopShortcutInput` **verbatim, including its `kind: 'menu'` + `commandId: ShortcutCommandId` arm**. The type is upstream's; the port adds nothing to it and takes nothing away.
2. **`dsh://shortcuts/menu`, `ShortcutsMenuEvent` and the A2 menu convention are WITHDRAWN.** They were invented because the lead misread upstream. Do not implement them; do not emit them. Remove any code or fixture written for them.
3. `ShortcutCommandId` (upstream, shortcut-configurable commands such as `page.close`) is a **different type** from `MenuActionId` (this contract's application-menu actions: `about`, `exit`, `undo`, …). `shell_menu_action` keeps `MenuActionId`. Never substitute one for the other.
4. A8's rule is restated correctly: **a type upstream declares is reproduced exactly, variant arms included.** The port must not *add* fields upstream does not have. A8's own "one file per upstream variant" rule therefore *requires* `desktop-shortcut-input.menu.json` alongside `desktop-shortcut-input.keyboard.json` / `.iframe.json` / `.webview.json`.
5. `desktop-shell-features.md` rule K10 (menu-routed page commands, e.g. Close Page or Window) is delivered through this `kind: 'menu'` arm, not through a separate event.

This is recorded rather than quietly edited away, because the earlier retraction (F-9) was itself wrong and the correction history matters.

### A11 — Which side owns which marker global (corrects the A-era ruling)

The earlier ruling "the Rust init script owns DOM markers only; the TS bridge owns every product global" was **too broad**. Ownership must follow *who can actually produce the value*: a global whose value requires native knowledge, or which must exist before any page script runs, belongs to the Rust initialization script.

| Global | Owner | Why |
|---|---|---|
| `__DSH_BOOT_READY__` | served `index.html` literal; Rust may re-assert idempotently | must exist before the preserved entry evaluates (`ui-backend-protocol.md` §7.3) |
| `html[data-platform]`, `html[data-windows-titlebar]` + `--dsh-windows-titlebar-height`, `html[data-ds-theme-source]` | **Rust** | must be set before CSS and layout run |
| `__DSH_HOST_PATHS__` | **Rust** | `pathFor(file)` needs the native path recorded by the drag-drop/picker event; there is no Tauri equivalent of `webUtils.getPathForFile`, and TypeScript cannot recover a host path from a `File` |
| `__DSH_DIRECTORY_PICKER__` | **Rust** | wraps the native folder dialog owned by the shell |
| `dshDesktop`, `dshDesktopBoot`, `__DSH_LOCALE__`, `dshOnboarding`, `dshPlatform` | **TypeScript bridge** | thin wrappers over the declared commands; nothing native is required to construct them |

The invariant that matters is **exactly one producer per global per run**, and the mechanism that guarantees it is that the TypeScript bridge is **fill-only-if-absent**: it checks `markers.read*()` before installing and never overwrites a value the Rust script already provided. A test must pin that by object identity — a preinstalled marker survives unchanged, an absent one is filled.

`port/ui/desktop-bridge/shell-boot.ts` and both `port/ui` READMEs must state this table. The superseded "Rust is authoritative for everything" phrasing contradicted the ruling and was flagged by the app lane; **a comment that contradicts the code is a defect of the same class as code that contradicts the contract.**

### A12 — The host is authoritative for model credentials (corrects A5's use for onboarding)

Found by an independent review. `dshOnboarding.hasApiKey()` was implemented by asking the **Rust keyring** with coordinates loaded from desktop settings. That is the wrong source for *model* credentials, and it has two failure modes:

1. Those coordinates have **no normal initialization path**, so a fresh installation reports "no API key".
2. Even when supplied, the Rust store cannot see credentials configured through the **preserved provider settings or environment**, because upstream keeps model credentials with the host.

The result is a user-visible bug: an API-key user is misclassified as having no configured key.

| Rule | |
|---|---|
| Model-credential authority | **The dsh host.** `hasApiKey()` must derive presence from the host's provider references and credential metadata, over the authenticated channel the preserved client already uses (`ui-backend-protocol.md` §2–§3), not from the Rust keyring. |
| `credential_*` commands | Remain valid and stay declared, but are for **desktop-owned** secrets written through the OS store. They must **never** gate onboarding. |
| A5's `AppInfo.credentialRef` | Remains available to *write* a key (the welcome/onboarding save path uses the official provider's configured reference). It is **not** the presence authority. |
| `dshOnboarding` shape | Unchanged — `{ hasApiKey(): Promise<boolean>; setActive(active: boolean): void }` — so the preserved client is untouched. |

## Rules

1. No placeholder command exists. If a command is not implemented it is absent from this document and absent from the mirror; the UI must not call it.
2. Every command has at least one test that exercises a success path and each declared error variant that the command can produce.
3. Cancellation: long-running commands (`runtime_restart`, `shell_pick_directory`, `update_check`) accept no client-side cancellation handle and are idempotent, matching upstream semantics. Model/agent cancellation stays in the preserved upstream RPC, not here.
4. Process lifecycle: Rust owns the host process tree and is the only component allowed to spawn, stop or inspect it.
5. Secrets never appear in `println!`, `log`, tracing spans, crash reports, or event payloads. `credential_store` is the only command that accepts a secret value.
