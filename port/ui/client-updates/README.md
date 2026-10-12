# `@dsh-port/dsh-client-ui-updates`

The port-owned desktop bundle inserts this Host/Client plugin into the default Desktop composition. Its client contributes the Updates section through the preserved Settings slots. Account stays enabled and retains the single Settings launcher. The native application-menu update route remains available.

The row uses an `insert` list; a bare id/name patch cannot create it. This client package's own bundle patch is a compatibility no-op for older profiles, and it never disables Account. `apply(ctx)` returns outside a Tauri renderer and registers no competing launcher. User profile files are unchanged.

The Updates page calls native `update_configuration` for its effective channel, packaged feed, allowed channel choices and delivery availability. Renderer feed settings provide no authority. A packaged channel pin overrides an old saved preference in both presentation and checks. Missing/malformed sources, missing channels and absent signing keys have separate explanations; checks are disabled until delivery is available. A configuration read failure offers Retry. An idle startup snapshot does not claim a check has run.

`bundle.mjs` invokes the pinned upstream `tsdown` toolchain. `port-client-preset.ts` reuses upstream's module-table externals, build-environment helper, and requested-external validation; it supplies the wrapper and file layout that `clientBundle()` cannot derive for a package outside `_upstream/packages/*/*`. The emitted loader wrapper is checked against an upstream-built plugin before runtime staging.

## Operation ownership

Checks, channel changes, and open/install actions own separate tokens; a completion releases only its own operation. Open/install excludes checks and channel changes. Startup and RPC results are rejected when superseded by newer generations or shell events. A successful channel save commits before metadata refresh, so a failed refresh cannot roll back the persisted choice.

## Known Limitations and Deferred Work

- The explicit `port/tests/fixtures/updates-host.mjs <staged-runtime>` fixture loads the production profile, checks Account retention, fetches the graph-advertised revision-tagged bundle, and mounts its served factory through real Cordis with the actual snapshot-store engine. Its native invoke, slot/locale adapters and React server-render projection are fixture boundaries. This proves composition, serving and plugin registration; it does not qualify a native WebView2 view or an installed upgrade.
- Delivery remains disabled when `updates.json` is absent. Production release hosting/signing, authoritative v2 freshness/target/rollback enforcement, key rotation/revocation and exact install/upgrade acceptance are separate open work. Do not ship the public qualification signing key.
- The runtime payload builder must copy `package.json`, `cordis.patch.yml`, `lib/index.js`, and `lib/client.js` into `node_modules/@dsh-port/dsh-client-ui-updates`; `lib/client.js.map` is included for browser diagnostics.
