# Upgrade record: `0.1.7-rc.2` → `0.2.1-alpha.2`

Branch `upgrade/harness-0.2.1-alpha.2`, base `83035f0`. Every claim below was read from a real checkout
of the target; nothing here is inferred from a tag, a publication date, or a version-string ordering.

| | Previous reviewed release | Supported target |
|---|---|---|
| Commit | `477b4f420553e8a52c2fbccc464d7561b239c443` | `d743267388641bc76f17c45ce8b4c231aed1d32c` |
| Tag | `dsh-v0.1.7-rc.2` | `dsh-v0.2.1-alpha.2` |
| Root package version | `0.1.7-rc.2` | `0.2.1-alpha.2` |
| `packageManager` | `pnpm@11.7.0` | `pnpm@11.28.5` |
| Node `engines` | `^22.19.0 \|\| >=24.0.0` | `^22.19.0 \|\| >=24.0.0` (unchanged) |
| npm `latest`/`next` | — | `0.2.0-rc.2` (the alpha is a separate tag; this is an alpha, not stable) |

The recorded identity lives in [`port/scripts/lib/target-release.mjs`](../port/scripts/lib/target-release.mjs)
with a fail-closed probe (`assertUpstreamRelease`) that validates any checkout against it.

## 1. What did NOT change — no rebaseline is required, and none was invented

Each of these was read directly at both revisions. A port that "fixes" any of them would be fixing a
change that did not happen.

| Surface | Value at the target | Evidence |
|---|---|---|
| Desktop Host lifecycle protocol | `DESKTOP_HOST_PROTOCOL_VERSION = 4` | `apps/desktop/src/host-protocol.ts` |
| Session format | `SESSION_FORMAT_VERSION = 4` | `packages/core/session/src/types.ts` |
| Web profile bundles | `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-web-app` | `packages/boot/app-boot/src/profile.ts` `PROFILE_TEMPLATES.web` |
| Webserver service name | `webServer` | `packages/host/webserver/src/index.ts:302` |
| Connection URL mint | `connection.authenticatedUrl(baseUrl)` | `packages/client/connection/src/rpc-host.ts:127` |
| Every symbol runtime staging imports | present | `prepareDesktopPackageSet`, `createRuntimeProjectMetadata`, `DESKTOP_HOST_PROTOCOL_VERSION`, `desktopRuntimeFileExclusion`, `selectOfficeEngine` |
| Every symbol the preserved shell imports | present | `clientBuildEnvironmentDefines`, `requestedExternals`, `PLATFORM_MODULES`, `PRELOADED_CLIENT_EXTERNALS`, `parseRemoteStreamServerMessage`, `ShortcutRegistry` |

`port/src-tauri/runtime/adapter.mjs` reads `ctx.webServer.port`,
`ctx.webServer.collectIndexInjections()` and `ctx.connection.authenticatedUrl(...)`; all three still
exist at the target, so the adapter needs no protocol change for this move.

## 2. Verified drift that does require port changes

### 2.1 pnpm `11.7.0` → `11.28.5`

`build.ps1` already derived the version from the checkout's `packageManager` for its corepack lookup,
but the `Assert-Tool` hints repeated `11.7.0` as a literal. Those now derive from the checkout
(`Get-UpstreamPackageManager`), so the message cannot disagree with the toolchain staging uses.

### 2.2 tsdown module-config loader

The target's own bundle scripts run `tsdown --config-loader native`
(`apps/desktop/package.json#scripts.bundle`). The port's `ui/client-updates/bundle.mjs` ran
`tsdown --config tsdown.config.ts` without it, and hardcoded `tsdown@0.22.2`. The bundler now passes
the loader and resolves the tsdown version from the checkout's declared range, refusing a resolution
that is ambiguous or unsatisfiable.

### 2.3 esbuild — the port's pin was already right, and is now enforced

`apps/web` builds with **Vite 6.4.3**, not the root lockfile's newest Vite. The linked `vite@6.4.3`
declares `esbuild: ^0.25.0`; the installed `@esbuild/win32-x64` set is `0.21.5, 0.25.12, 0.28.1, 0.28.2`,
and exactly one satisfies that range: **0.25.12** — the port's existing
`$script:DefaultEsbuildVersion`. Deriving from the root lockfile would have selected 0.28.2 and staged a
compiler the build does not run on.

`ui-build-qualification.psm1` now derives the version from the linked Vite package
(`Get-DshUpstreamEsbuildVersion`) and refuses to proceed when the recorded version is not the one the
build resolves. The literal is therefore checked on every use rather than trusted.

### 2.4 `OPTIONAL_BUNDLES` 3 → 11

`packages/boot/app-boot/src/profile.ts` grows from 3 to 11 shipped optional bundles. The port does not
enumerate this list, so no port edit is required; it is recorded because the target's own profile
loader owns it.

### 2.5 Retired profile bundles (new at the target)

`profile.ts` adds `RETIRED_BUNDLES`, whose first entry retires
`@deepseek-ai/dsh-experimental-schedule-bundle` from an existing profile's bundle list. The upstream Host
performs this at load; the port's `initialize_desktop_profile` only creates absent files and never
re-adds the bundle, so no port change is required. Flagged for the native/installed lane because it
mutates existing user profiles.

### 2.6 Web listener trust moved to `webStartup`

Upstream's own guide
([`docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config`](../_upstream/docs/upgrade-guide/v0.2.1-alpha.1/web-listener-trust-config/guide.md))
records that the `webRuntime` service is gone in favour of `webStartup`, that the `connection` row now
reads `ctx.webStartup.trustedHosts`, and that a wildcard listener host (`0.0.0.0`, `::`) is **rejected at
load**.

The `webserver` row still exists and still takes `host`/`port`, but its config is now
`host/port/tls/compression/compressionLevel/compressionThresholdBytes` with `inject: [webStartup]`. A
patch **replaces the matched row's whole config**, so a patch that restates only `host` and `port`
silently drops TLS, compression and the injection. **This applies to the port's own profile patches and
is not yet fixed**: the port's adapter launch fixtures write
`- id: webserver\n  config:\n    host: 127.0.0.1\n    port: 0\n`
(`port/tests/adapter-launch.integration.test.mjs`, `port/tests/adapter-staged-lane.test.mjs`). Those must
be restated completely before a staged-lane or native run against the target.

## 3. Implemented in this step

| Change | File |
|---|---|
| Recorded target descriptor, fail-closed probe, source-constant extractors | `port/scripts/lib/target-release.mjs` (new) |
| Explicit `-UpstreamRoot` with `$env:DSH_UPSTREAM_ROOT` fallback, checkout assertion, pnpm version derived from the checkout | `port/scripts/build.ps1` |
| Explicit upstream root for the UI toolchain link | `port/ui/link-toolchain.ps1` |
| `--config-loader native`, tsdown version derived, explicit upstream root | `port/ui/client-updates/bundle.mjs` |
| esbuild version derived from the linked Vite and cross-checked | `port/tests/packaging/ui-build-qualification.psm1` |
| Version pins: target version in the Tauri config, the Rust workspace and its lockfile, the bound protocol fixture, and the port-owned UI packages | `port/src-tauri/app/tauri.conf.json`, `port/src-tauri/Cargo.toml`, `port/src-tauri/Cargo.lock`, `port/fixtures/protocol/app-info.json`, `port/ui/client-updates/package.json`, `port/ui/desktop-updates-bundle/package.json` |
| Regressions | `port/tests/target-release.test.mjs` (new), `port/tests/packaging/upstream-root.test.mjs` (new), `port/tests/packaging/gate-contract.test.mjs` (extended) |

## 4. Remaining prerequisites — none of these is discharged by this step

1. **A built target checkout.** The account transforms hash reviewed blocks of **emitted** `lib/`, and a
   freshly cloned target has no `lib/`. Their tests currently fail on the missing inputs, not on drifted
   behaviour.
2. **Account transformation re-review.** `port/scripts/lib/account-data-runtime.mjs`,
   `account-login-runtime.mjs` and `account-profile-runtime.mjs` still gate on `0.1.7-rc.2` and refuse
   every other version. They must be re-reviewed against the target's built modules. Owned by the
   parent; deliberately untouched here.
3. **Runtime-lock refresh.** `port/runtime-locks/windows-x64` and the staged payload remain at
   `0.1.7-rc.2`. A refresh needs the target's pnpm `11.28.5` and the built checkout:
   `build.ps1 -Stage runtime-lock-refresh`. Lock pins must not be edited by hand.
4. **Web listener patch completeness** (§2.6).
5. **Native/installed acceptance** of the resulting artifact — a separate, non-overlapping production
   identity environment.

## 5. What this record does not claim

It does not claim that any built artifact carries `0.2.1-alpha.2`. It does not claim parity with the
target for any surface not listed in §1. It does not establish that the port's staged payload, runtime
locks, or account transforms are compatible with the target — they are still the previous reviewed
release, and they fail closed rather than guessing.
