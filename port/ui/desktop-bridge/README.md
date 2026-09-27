# `desktop-bridge` — typed TypeScript mirror of the Rust contract

One TypeScript type per Rust type of `docs/contracts/tauri-contract.md`
(including amendments A1–A11) plus the `dshDesktop` sub-bridge shapes of
`docs/contracts/desktop-shell-features.md`.

- `protocol.ts` — literal request/response/event payload types, the `DshError`
  union, `DshCommandMap`/`DshEventMap`. Naming rule (A1): upstream types keep
  upstream names/shapes verbatim (`ShortcutBinding`, `DesktopShortcutInput`,
  `DesktopUpdatePresentation`, `IndexInjection`, …); port-specific composites
  get port-specific names (`ShortcutBindingRow`, `ShortcutsChangedEvent`, …).
- `index.ts` — `invoke` wrapper per command and typed `listen` subscription per
  `dsh://` event (Tauri 2 core event plugin), exposed as the typed `desktop`
  facade. Degrades gracefully outside the shell: `tryDesktop()` returns
  `undefined`, every `desktop.*` call throws the typed `NotDesktopError`
  (`kind: 'not_desktop'`), so the same bundle still works in a plain browser.
- `markers.ts` — install/read accessors and exact consumer shapes for the eight
  marker globals (`__DSH_BOOT_READY__`, `dshDesktopBoot`, `__DSH_TRANSPORT__`,
  `__DSH_HOST_PATHS__`, `__DSH_DIRECTORY_PICKER__`, `__DSH_LOCALE__`,
  `dshOnboarding`, `dshDesktop` — the authoritative name; `__DSH_DESKTOP__` does
  not exist upstream and is not implemented), plus bridge-backed factories.
  `dshDesktop.keyboard` carries the in-page physical-input producer (one
  capture-phase `keydown` on `window` producing upstream `DesktopShortcutInput`
  verbatim from `event.code`, stamped with the accepted revision from the
  shared `ShortcutRevisionCache`, IME/AltGraph skipped, no `preventDefault` —
  the recorded K4 gap). `dshDesktop.browser` is the typed
  `browser_guest_unavailable` stub of `desktop-shell-features.md` §2.
  `__DSH_HOST_PATHS__.pathFor` has no command-level transport in the contract
  and is supplied by the Rust initialization script (documented at the
  installer).
- `shell-boot.ts` — module-evaluation glue installed before the preserved
  entry, plus the A11 ownership table: `__DSH_BOOT_READY__` is the served
  `index.html` literal (Rust may re-assert idempotently); the DOM markers
  (`html[data-platform]`, `html[data-windows-titlebar]` +
  `--dsh-windows-titlebar-height`, `html[data-ds-theme-source]`), and
  `__DSH_HOST_PATHS__` (native file paths) are Rust-owned — this glue never
  writes them; `__DSH_DIRECTORY_PICKER__` is Rust-owned with a
  `shell_pick_directory` fill-if-absent fallback here; `dshDesktop`,
  `dshDesktopBoot`, `__DSH_LOCALE__`, `dshOnboarding`, `dshPlatform` are
  TypeScript-bridge-owned (`dshPlatform` not implemented,
  `desktop-shell-features.md` §4). Exactly one writer per global per run: the
  glue fills only ABSENT globals and never overwrites one. Outside the Tauri
  shell it installs nothing (Web mode).
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

Fixture files are generated and owned by the Rust lane; wire forms missing a
fixture are requested from the lead by type name and shape (A7).
