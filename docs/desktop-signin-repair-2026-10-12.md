# Desktop sign-in repair — 2026-10-12

The active `merged-ebfc840-portable` reproduced two separate failures: account profile requests returned HTTP 202 with a JSON protocol error, and a browser sign-in attempt expired after ten minutes. Rebuilding the previous portable did not resolve those failures.

## Changes in this worktree

The upstream native shell watches account state and opens the authorization page once per attempt. Its preserved Sign-in dialog only supplies Copy link. The port now installs an authenticated account-state subscription after the desktop boot payload arrives, and sends the authorization page through the existing native external-link command. It retains the copy-link fallback, validates the platform origin and page, rejects expired attempts, and disposes the subscription on document exit.

The preserved client supplies the renderer gateway origin as its callback origin. That gateway requires the WebView session cookie, which the external browser does not possess. The port-owned account stage transform retains upstream caller-origin validation and then selects the actual Host listener for desktop sign-in under the controlled adapter. The existing Host callback verifies state, PKCE, cancellation and single-use exchange. Renderer gateway authentication is unchanged; ordinary web callers retain their supplied origin.

The transform is owned by the official runtime stage, refuses unknown provider versions and generated method shapes, copies its helper before sealing, and records both sources as build inputs. `_upstream` and the already-running portable were not edited.

## Verification and limits

- The real staged desktop profile boots with the production loader, services, HTTP carrier and account stream. A fake loopback platform is the only account service contacted. Credentials and environment paths belong to a fresh owner-contained fixture.
- Authenticated `account/startSignIn`, `account/watch` and cancellation work. The browser callback succeeds without a cookie; wrong state, duplicate state parameters, duplicate exchange and cancelled attempts are refused. The fake platform verifies the actual PKCE verifier against the initialization challenge. A single exchange supplies the account identity and a fixture grant; the grant cannot resolve for production inference.
- Browser-side checks cover native external opening, attempt deduplication, unsafe/expired destinations, reconnect, late events and idempotent disposal. Type checks and the renderer production build pass.
- This does not qualify a live Platform sign-in in WebView2. HTTP 202 from the real profile endpoint remains an external failure. The port retains only previously validated, same-grant profile data; it cannot manufacture fresh account information if the exchange omits it and the profile endpoint refuses it.
- Native guests remain disabled. No installer/release publication or production updater admission is implied by this local portable.

## Startup evidence

The real app log shows approximately eight seconds for its first observed launch and approximately three seconds on the following launch. Fresh isolated product-profile samples in this repair measured approximately 2.4–2.8 seconds after the profile entry imports. These are functional samples, not a native usable-frame benchmark, and do not meet the 1.5-second target.

A trace was inserted into the actual staged `dsh-app-boot` module, executed by the probe, and restored byte-for-byte afterward. Several plugin activation intervals overlap: client modules about 0.81 seconds, HMR about 0.73 seconds, credentials about 0.69 seconds, and the gateway about 0.57 seconds. They are elapsed intervals containing shared module work, not independent costs that can be added together.

The module scan includes 153 pi-ai files, 110 execa files, 95 Zod files and 52 Domino files. CPU sampling again shows compilation, module lookup, package-scope lookup and filesystem metadata work. The profile also includes fixture setup and short account checks, so its aggregate samples are not a native launch breakdown.

The next speed experiment should bundle a measured part of the eager dependency graph into an owned staged payload, preserve every public entry point and shared service/schema identity, and compare paired runs against the unchanged payload. Admit a change only after parity checks and a native launch-to-usable measurement. Do not remove readiness audits, credential checks, Office composition or features to lower the number. The existing `startup-performance-plan-2026-10-11.md` remains the acceptance contract.

## Reproducing the callback check

Use the attested pinned Node 22.20.0 execution copy and the repository's qualification preflight. After the normal stage has applied and sealed the login transform, run:

```powershell
& $qualifiedNode --expose-internals port/tests/fixtures/account-login-host.mjs $absoluteStagedRuntimePath
```

The probe uses loopback port 19417, writes its receipt in an owned temporary directory, and disposes its Host. It does not open or modify the operator's saved account. Port conflicts and failed checks are failures, not skips. Live native/account acceptance must use the newly matched portable; its build receipt records the exact native, UI, payload and changed-source hashes.
