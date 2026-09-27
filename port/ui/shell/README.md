# `shell` — preserved client shell assembly

A Vite entry + `index.html` that mounts the upstream client exactly as
`apps/web` does, consuming the already-built upstream workspace artifacts
(`_upstream/packages/*/lib`) through `port/ui/node_modules` junctions.

Provenance:

- `src/web-main.ts` — byte-identical copy of `_upstream/apps/web/src/main.ts`
  (SHA256-verified): `AppWebEntry` + `applyIndexInjections` + the
  `__DSH_BOOT_READY__` boot-gate flow, unmodified.
- `src/node-module-stub.ts`, `public/favicon.svg`, `public/favicon-dark.svg`,
  `public/manifest.webmanifest` — byte-identical copies (SHA256-verified).
- `src/main.ts` — the only new entry code: imports
  `../desktop-bridge/shell-boot.ts` (marker install) and then `./web-main.ts`;
  ESM evaluation order guarantees the markers exist before the preserved entry
  reads `globalThis.dshDesktopBoot`.
- `src/css-modules.d.ts` — the standard `*.css` module declaration.
- `index.html` — upstream `index.html` verbatim, plus the literal
  `<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>`
  first in `<head>`: the shell-owned boot path of
  `docs/contracts/ui-backend-protocol.md` §7.3 (upstream Electron inserts the
  same literal at serve time, `apps/desktop/src/web-document.ts:10,31-32`).
- `vite.config.ts` — the port of `_upstream/apps/web/vite.config.ts` with the
  same `base: './'`, `resolve.dedupe`, `brandFontLicense` (emits
  `assets/fonts/Montserrat-OFL.txt`), `clientBuildEnvironmentDefines`,
  es2022 target, sourcemaps, and chunk/asset naming (`assets/`, `assets/langs/`,
  `assets/fonts/`). Deltas: output goes to `port/ui/dist/`; the worker-preview
  surface (`preview.ts`, `emitPreviewPage`) and the `productWebBundleIsolation`
  build gate are omitted (neither affects the client at `/`); bare `vite serve`
  is rejected, as upstream, because it cannot inject `window.__DSH_BOOT__`.

Build and output path: see `../README.md`.
