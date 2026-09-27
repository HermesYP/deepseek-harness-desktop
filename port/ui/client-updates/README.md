# `@dsh-port/dsh-client-ui-updates`

This port-owned Host/Client package ships with the Desktop profile. Its Host package patch disables upstream `@deepseek-ai/dsh-client-ui-settings-account` in the Desktop composition; its Client package contributes the Updates page to `settings.section` and a Settings-only More menu to `settings.launcher`.

The package uses upstream's Cordis slots and settings shell without modifying the pinned client. `cordis.patch.yml` is this package's default bundle layer, applied before the user's profile patch; it does not write or replace the profile's own `cordis.patch.yml`.

The Updates page reads `updates.channel` (`stable` by default), selects only `updates.feed-url` for stable and only `updates.feed-url-beta` for beta, and reports a missing selected feed without fallback. SHA-256 checks are reported only when the manifest supplies a digest; the port does not claim signing-key or signature verification.

`bundle.mjs` invokes the pinned upstream `tsdown` toolchain. `port-client-preset.ts` reuses upstream's module-table externals, build-environment helper, and requested-external validation; it supplies the wrapper and file layout that `clientBundle()` cannot derive for a package outside `_upstream/packages/*/*`. The emitted loader wrapper is checked against an upstream-built plugin before runtime staging.

## Known Limitations and Deferred Work

- Desktop's profile intentionally differs from upstream `PROFILE_TEMPLATES.web.bundles`: it adds this package, whose patch disables the account UI also included by upstream's `@deepseek-ai/dsh-web-app` bundle. Review this divergence when upstream changes its Web profile or the account launcher.
- The runtime payload builder must copy `package.json`, `cordis.patch.yml`, `lib/index.js`, and `lib/client.js` into `node_modules/@dsh-port/dsh-client-ui-updates`; `lib/client.js.map` is included for browser diagnostics.
