# `port/ui` — preserved web-client shell + typed desktop bridge

This directory ships the pinned upstream DeepSeek Harness web-client shell
(`_upstream/`, commit `477b4f420553e8a52c2fbccc464d7561b239c443`) with
port-owned desktop additions. The upstream React client and its shipped assets
remain byte-identical except for the port-owned shell entry and boot document;
the Updates Settings contribution is a separate client plugin and does not
modify the preserved client files.

## Preserved verbatim vs. what the bridge adds

| Preserved verbatim | Added by the port |
|---|---|
| `shell/src/web-main.ts` — byte-identical copy of `_upstream/apps/web/src/main.ts` (the `AppWebEntry` + `applyIndexInjections` + `__DSH_BOOT_READY__` boot-gate flow) | `desktop-bridge/` — typed TS mirror of `docs/contracts/tauri-contract.md` (A1–A11), `invoke`/event wrappers, marker-global installers |
| the preserved client packages and Settings shell | `client-updates/` — port-owned default Client plugin registering an Updates section in the upstream `settings.section` slot; `port-client-preset.ts` adapts upstream's dynamic bundle conventions without modifying `_upstream` |
| `shell/src/node-module-stub.ts`, `shell/public/*` (favicons, `manifest.webmanifest`) — byte-identical copies (SHA256-verified) | `shell/src/main.ts` — 2-line entry that installs the TypeScript-bridge markers (`dshDesktop`, `dshDesktopBoot`, `__DSH_LOCALE__`, `dshOnboarding`, plus the `__DSH_DIRECTORY_PICKER__` fallback) fill-only-if-absent, then runs the preserved entry; per amendment A11 the DOM markers and `__DSH_HOST_PATHS__` are Rust-owned and never written here |
| all built CSS/JS chunks, fonts, icons, copy, spacing, motion (128 shipped files are byte-identical to `_upstream/apps/web/dist`) | `shell/index.html` — upstream `index.html` plus the one `__DSH_BOOT_READY__` head script the shell-owned boot path requires (`ui-backend-protocol.md` §7.3; upstream inserts the same literal at serve time, `apps/desktop/src/web-document.ts:10`) |
| `shell/vite.config.ts` behaviour: `base: './'`, `dedupe: ['react','react-dom']`, `brandFontLicense` (`assets/fonts/Montserrat-OFL.txt`), chunk/asset layout, `define` substitutions (reuses `_upstream/scripts/client-build-environment.ts` read-only) | `validate/` — mount + font verification harnesses |

## Update channel feeds

The release preference is persisted in the desktop settings store as `updates.channel` (`stable` by default, or `beta`). Stable consults `updates.feed-url`; beta consults only `updates.feed-url-beta` and never falls back to stable. A blank or unset selected feed is reported as no feed configured. Update manifests may include SHA-256 for download verification; this build has no signing-key or signature verification, so a hash does not establish release provenance. The Updates Settings section and Settings-only sidebar More menu are supplied by `@dsh-port/dsh-client-ui-updates` in `client-updates/` through the upstream `settings.section` and `settings.launcher` slots. Its bundle patch disables upstream `ui-settings-account`, whose launcher adds Contact us and Sign in; the port registers a replacement launcher containing only Settings, so the Settings route remains available.

Desktop adds `@dsh-port/dsh-client-ui-updates` to `DESKTOP_PROFILE_BUNDLES`. This intentionally diverges from upstream `PROFILE_TEMPLATES.web.bundles` in `_upstream/packages/boot/app-boot/src/profile.ts`; that split is the F-30 maintenance risk and requires deliberate comparison when upstream changes its Web profile. The port-owned `port-client-preset.ts` imports upstream bundle helpers and reproduces only the bundle configuration the upstream preset cannot apply outside its `_upstream/packages/*/*` workspace. The account-bundle exclusion also deliberately differs from upstream Desktop: `_upstream/apps/desktop/src/project-manager.ts` selects `PROFILE_TEMPLATES.web`, and `_upstream/packages/bundle/web-app/package.json` includes `@deepseek-ai/dsh-client-ui-settings-account`. Review both changes when comparing desktop behavior with upstream.

## Build

```powershell
pwsh -File port/ui/link-toolchain.ps1        # junction port/ui/node_modules -> _upstream/apps/web/node_modules (read-only use)
cd port/ui
$env:DSH_CLIENT_VERSION = '0.1.7-rc.2'; $env:DSH_CLIENT_COMMIT_HASH = '477b4f4'
node node_modules/vite/bin/vite.js build --config shell/vite.config.ts
node client-updates/bundle.mjs                    # produces and wrapper-checks the default plugin
```

Equivalent script: `node node_modules/vite/bin/vite.js build` via `pnpm run build`
(`package.json`). Set `DSH_CLIENT_TITLE` to project a different document title;
unset it builds the upstream default `DSH Local Build`.

**Output path: `port/ui/dist/`** — the packaged web-client shell the Rust
gateway serves at `/` (shell-owned boot path). Layout:

```text
port/ui/dist/
  index.html                    upstream head + __DSH_BOOT_READY__ script; module entry ./assets/index-*.js
  favicon.svg favicon-dark.svg manifest.webmanifest
  assets/index-*.js assets/vendor-*.js (+ .map)      the preserved client bundle + the thin bridge
  assets/index-*.css assets/vendor-*.css             all CSS tokens and component styles
  assets/fonts/montserrat-{light,regular,medium}-*.woff2
  assets/fonts/Montserrat-OFL.txt                    SIL OFL license, travels with the font
  assets/fonts/KaTeX_*.{woff2,woff,ttf}              60 content-font faces
  assets/langs/*.js                                  60 lazy shiki grammar chunks
```

The upstream `preview.html`/`preview/` worker-preview surface is deliberately
not built (experimental deployment artifact, never rendered by the desktop
client); `productWebBundleIsolation` is an upstream build gate and is likewise
omitted. Neither affects the client served at `/`.

## Tests

```powershell
cd port/ui
node node_modules/typescript/bin/tsc --noEmit -p desktop-bridge\tsconfig.json   # bridge type lockstep
node node_modules/typescript/bin/tsc --noEmit -p client-updates\tsconfig.json    # plugin typecheck
node node_modules\vitest\vitest.mjs run desktop-bridge\tests\                   # bridge suites
```

`desktop-bridge/tests/protocol.spec.ts` round-trips **every** file in
`port/fixtures/protocol/` byte-identically against the hand-written mirror
types and fails loudly on any unregistered file (contract amendments A7/A8);
`tests/event-transport.spec.ts` proves `dsh://` listeners receive domain
payloads through the Tauri `plugin:event` envelope contract, and
`tests/keyboard-input.spec.ts` (jsdom) drives the keyboard producer with real
key events end to end.
`port/ui/tests/protocol.spec.ts` and `port/ui/src/desktop-bridge/*` are
compatibility re-exports for the paths named in `docs/contracts/tauri-contract.md`.

## Validation (see `validate/README.md`)

`node validate/mount-check.mjs` serves `dist/` on port 3086 and drives real
Chromium over it with the Host injection table and built plugin bundles;
`node validate/font-check.mjs` proves every webfont face loads at its
`assets/fonts/` path.

The shell-only identity and font checks do not exercise the port-owned Settings plugin or its Host profile patch. Rebuild the shell and stage the plugin into the runtime payload before assembled verification; record the Settings section, Settings-only More menu, menu-triggered check result, and post-restart channel read-back under `docs/evidence/port-update/`. Real Tauri rendering still depends on the Rust gateway and `runtime_boot_ready` injection table; the `browser` guest bridge and `__DSH_HOST_PATHS__` remain documented differences in `docs/contracts/tauri-contract.md`.
