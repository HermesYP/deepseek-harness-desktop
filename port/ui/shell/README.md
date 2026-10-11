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
- `src/main.ts` — imports `../../desktop-bridge/shell-boot.ts` (marker install),
  `./external-links.ts` (desktop-only browser link routing), then `./web-main.ts`;
  ESM evaluation order guarantees the markers exist before the preserved entry
  reads `globalThis.dshDesktopBoot`.
- `src/external-links.ts` — installs the main shell's external-link handler only
  when Tauri is present. New-tab links and `window.open` browser fallbacks use
  `shell_open_external`; ordinary browsers keep their native behavior. This
  prevents the native new-window refusal and the opener plugin's ungranted IPC
  command from silently swallowing account links. OS failures offer Copy link.
- `src/script-preload.ts` — port delta that honors the Host's application
  `script-preload` rows, which upstream's `applyIndexInjections` ignores
  (`_upstream/packages/client/web/src/apply-injections.ts:36`). It wraps
  `dshDesktopBoot.ready` to start one `fetch(url, { credentials: 'same-origin' })`
  per unique application-batch URL the moment the boot payload arrives, and
  installs a merging accessor on `__DSH_TRANSPORT__` so the preserved entry's
  `{ ownsHost, streamBaseUrl }` assignment carries the port's
  `loadBundle` transport. The transport serves a prefetched URL from the stored
  response exactly once (executed as an inline classic script — the `script`
  row mechanism — so the loader's registration wrapper, arrival order, and
  per-URL in-flight dedupe are unchanged) and sends every other URL, and every
  failed prefetch, through the default `<script src>` transport. The preserved
  `web-main.ts` stays byte-identical; see `src/script-preload.ts` header for
  the mechanism and the cache-header rationale.
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
