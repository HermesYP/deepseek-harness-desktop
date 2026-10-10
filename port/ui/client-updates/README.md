# `@dsh-port/dsh-client-ui-updates`

This port-owned Host/Client package is included in the runtime payload but is not activated by the default Desktop composition. The desktop bundle layer is temporarily a no-op: upstream account Settings remains enabled, and Settings has no Updates section. The native application-menu update route is independent and retained.

When explicitly activated, this package's Client contributes to `settings.section` and `settings.launcher` through upstream Cordis slots without modifying the pinned client. Its own `cordis.patch.yml` disables the upstream account plugin; it does not write or replace the user's profile patch. Do not reactivate the replacement launcher until actual renderer acceptance is established.

The Updates page reads `updates.channel` (`stable` by default), selects only `updates.feed-url` for stable and only `updates.feed-url-beta` for beta, and reports a missing selected feed without fallback. SHA-256 checks are reported only when the manifest supplies a digest; the port does not claim signing-key or signature verification.

`bundle.mjs` invokes the pinned upstream `tsdown` toolchain. `port-client-preset.ts` reuses upstream's module-table externals, build-environment helper, and requested-external validation; it supplies the wrapper and file layout that `clientBundle()` cannot derive for a package outside `_upstream/packages/*/*`. The emitted loader wrapper is checked against an upstream-built plugin before runtime staging.

## Operation ownership

Checks, channel changes, and open/install actions own separate tokens; a completion releases only its own operation. Open/install excludes checks and channel changes. Startup and RPC results are rejected when superseded by newer generations or shell events. A successful channel save commits before metadata refresh, so a failed refresh cannot roll back the persisted choice.

## Known Limitations and Deferred Work

- The default desktop bundle remains listed to repair profiles that already reference it, but its no-op patch restores account Settings, Contact us, and Sign in. Updates rendering and native/installed behavior remain unqualified; source tests and bundled JavaScript do not establish activation.
- The runtime payload builder must copy `package.json`, `cordis.patch.yml`, `lib/index.js`, and `lib/client.js` into `node_modules/@dsh-port/dsh-client-ui-updates`; `lib/client.js.map` is included for browser diagnostics.
