# `desktop-bridge` — typed TypeScript mirror of the Rust contract

One TypeScript type per Rust type of `docs/contracts/tauri-contract.md`
(including amendments A1–A11) plus the `dshDesktop` sub-bridge shapes of
`docs/contracts/desktop-shell-features.md`.

- `protocol.ts` — literal request/response/event payload types, the `DshError`
  union, `DshCommandMap`/`DshEventMap`. Naming rule (A1): upstream types keep
  upstream names/shapes verbatim (`ShortcutBinding`, `DesktopShortcutInput`,
  `DesktopUpdatePresentation`, `IndexInjection`, …); port-specific composites
  get port-specific names (`ShortcutBindingRow`, `ShortcutsChangedEvent`, …).
  A13 folds in the native guest (`guest_*` + `dsh://guests/*`), native-path
  (`shell_host_paths*`), caption-menu (`shell_caption_menu`) and renderer
  diagnostic (`shell_renderer_console`) wire forms. **Invoke form:** the
  `guest_*` family takes ONE `request: <Struct>` parameter, so its payload
  travels nested under `request`; every other family is flat. Their fixture
  files do not exist yet (`port/fixtures/**` is `dsh-core`-owned), so
  `tests/protocol.spec.ts` pins each wire form in its `PORT_WIRE_SAMPLES` table
  and lists the missing fixture by name rather than omitting the type.
- `index.ts` — `invoke` wrapper per command and typed `listen` subscription per
  `dsh://` event (Tauri 2 core event plugin), exposed as the typed `desktop`
  facade. Degrades gracefully outside the shell: `tryDesktop()` returns
  `undefined`, every `desktop.*` call throws the typed `NotDesktopError`
  (`kind: 'not_desktop'`), so the same bundle still works in a plain browser.
- `guests.ts` — guest-backed `dshDesktop.browser` and `dshPlatform` over the
  Rust guest commands (lane G2). Its `invokeUnlisted` path predates A13; the
  typed facade now covers the same commands, so a later change can route it
  through `desktop.*` with no wire change.
- `markers.ts` — install/read accessors and exact consumer shapes for the nine
  marker globals (`__DSH_BOOT_READY__`, `dshDesktopBoot`, `__DSH_TRANSPORT__`,
  `__DSH_HOST_PATHS__`, `__DSH_DIRECTORY_PICKER__`, `__DSH_LOCALE__`,
  `dshOnboarding`, `dshDesktop` — the authoritative name; `__DSH_DESKTOP__` does
  not exist upstream and is not implemented — and `dshPlatform`), plus
  bridge-backed factories.
  `dshDesktop.keyboard` carries the in-page physical-input producer (one
  capture-phase `keydown` on `window` producing upstream `DesktopShortcutInput`
  verbatim from `event.code`, stamped with the accepted revision from the
  shared `ShortcutRevisionCache`, IME/AltGraph skipped, no `preventDefault` —
  the recorded K4 gap).
  `__DSH_HOST_PATHS__.pathFor` has no command-level transport in the contract
  and is supplied by the Rust initialization script; the module's
  `hostPathDropIntake` pairs the shell's adopted batch with the DOM `File` list
  for the drop-intake path, resolving a file only when its base name is unique
  on **both** sides (a name is not an identity, so an ambiguous one yields no
  path and the file uploads).
- `shell-boot.ts` — module-evaluation glue installed before the preserved
  entry, plus the A11 ownership table: `__DSH_BOOT_READY__` is the served
  `index.html` literal (Rust may re-assert idempotently); the DOM markers
  (`html[data-platform]`, `html[data-windows-titlebar]` +
  `--dsh-windows-titlebar-height`, `html[data-ds-theme-source]`), and
  `__DSH_HOST_PATHS__` (native file paths) are Rust-owned — this glue never
  writes them; `__DSH_DIRECTORY_PICKER__` is Rust-owned with a
  `shell_pick_directory` fill-if-absent fallback here; `dshDesktop`,
  `dshDesktopBoot`, `__DSH_LOCALE__`, `dshOnboarding`, `dshPlatform` are
  TypeScript-bridge-owned. `dshDesktop.browser` is composed from the guest
  bridge and `dshPlatform` from the Platform guest bridge, so both guest
  surfaces are installed rather than stubbed. Exactly one writer per global per
  run: the glue fills only ABSENT globals and never overwrites one. Outside the
  Tauri shell it installs nothing (Web mode).
- `tests/protocol.spec.ts` — round-trips every `port/fixtures/protocol/*.json`
  byte-identically (the same files as the Rust `protocol_fixtures.rs`), fails
  loudly on unregistered fixture files (A7/A8), and asserts every command
  response, every event payload, and every `DshError` variant has fixture
  coverage plus compile-time closed-union maps.
- `tests/event-transport.spec.ts` — drives the bridge through a Tauri 2
  `plugin:event` transport stub (the `Event<T>` `{event, id, payload}` envelope
  contract) and asserts `dsh://` listeners receive the DOMAIN payload, never
  the envelope; pins the single-authority fill rule and the composed product
  bridge.
- `tests/keyboard-input.spec.ts` (jsdom) — end-to-end producer tests: real
  `KeyboardEvent`s yield verbatim `DesktopShortcutInput` with the accepted
  revision, pre-revision input is dropped, IME/AltGraph is skipped, default
  actions are never suppressed, revision refreshes on `dsh://shortcuts/changed`,
  and Rust-side `kind: 'menu'` input arrives through an emitted event.
- `tests/shell-surfaces.spec.ts` (jsdom) — the marker glue's own behaviours: the
  DOM markers stay Rust-owned, the directory picker keeps one owner, and a host
  path is never fabricated (a duplicate base name on either side resolves to no
  path rather than a guessed ordinal, and a stale batch resolves to nothing).
- `tests/shell-integration.spec.ts` (jsdom) — the shared integration this lane
  added: `installDesktopShellMarkers()` really writes the absent globals and
  leaves Rust-installed ones identical by object identity; the installed
  `dshDesktop.browser`/`dshPlatform` issue the real guest commands; every
  port-addition command travels under its contract name with its declared
  fields (nested `request` for `guest_*`, flat for the rest); guest events
  deliver domain payloads and their disposers unlisten; and a missing transport
  is a typed `not_desktop` refusal rather than a silent no-op.

Both jsdom suites run under `port/.scratch/lane-f-check/specs-harness.mjs` here
because vitest's forked pool cannot spawn in this sandbox; see that runner's
header for the exact limit and for the one spec it excludes and why.

Fixture files are generated and owned by the Rust lane; wire forms missing a
fixture are requested from the lead by type name and shape (A7).
