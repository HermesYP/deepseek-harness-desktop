# Account name and balance analysis — 2026-10-12

The original failure combines refused/non-JSON profile responses, incomplete identity validation and a reproduced client notification race. A fresh test-account login now yields validated identity and wallet data, and the isolated native debug app displays the account email and `$0.00` balance. Direct profile refresh remains refused; this is not a durable browser-verification transport fix.

## Observed application evidence

- The process inspected during initial diagnosis ran `merged-ebfc840-portable`, SHA-256 `414631d93034b4a2693bbc0be7c0a9cc047b60575065b140c4bd80a185f6885d`. It was closed before the later isolated qualification described below.
- At 10:30 IST, two `/auth-api/v0/users/current` requests returned HTTP 202 and failed at `parse-json` with error code `protocol`. The wallet endpoint `/api/v0/users/get_user_summary` returned HTTP 200 with envelope code 0 and business code 0. That confirms transport/envelope success, not final wallet schema acceptance or rendering.
- At 14:54 IST the Host exited unexpectedly with code 1. The gateway then failed to reconnect its WebSocket several times. The diagnostic captures no underlying exception, so the cause of that process exit remains unknown. The Office warning and third-party plugin mount message do not prove its cause.
- The last recorded relaunch still used `merged-ebfc840-portable`. Its sign-in initialization succeeded at approximately 15:02 IST, followed by cancellation approximately one second later. There is no recorded successful exchange in this last attempt.

## Why the interface can look signed in but lack information

`PlatformAccount.getState()` reports `credential-stored` from the presence of a syntactically valid local grant. It does not query the profile or wallets. The client displays that as signed in and obtains the two fields independently. The profile request reaches JSON parsing because HTTP 202 is a successful HTTP status; a non-JSON body becomes a protocol failure. `readAccountDetail()` returns `{ status: 'failed' }`, and the account section falls back to a generic signed-in label and unavailable profile information.

The local profile cache is bound to the full hash of the exact grant. A changed grant after relogin cannot reuse the old grant's cached identity. Without valid user data in the exchange or a successful profile request, a relogin therefore cannot recover the name. This binding must be preserved to avoid showing one account's identity under another account's credential.

The client also sets `details: undefined` and advances a request revision on every account-state frame, including a reconnect or an identity notification. Both fields temporarily return to loading, and results from the previous revision are discarded. After a Host failure the replacement requests cannot complete normally. This behavior can amplify the missing-data symptom, but the logs do not prove that it alone causes a balance to remain missing indefinitely.

## Reproduction without a real account

An owned fixture exercised the actual packaged account provider with intercepted requests restricted to `https://fixture.invalid`:

| Mock response | Packaged provider result |
|---|---|
| Profile HTTP 202 with non-JSON body; wallet HTTP 200 with valid payload | Profile failed; balance ready |
| Wallet HTTP 200 with invalid wallet shape | Balance failed |

No real account request, grant, browser cookie, name or balance was read. The result demonstrates that profile failure does not inherently prevent balance loading, and that HTTP 200 alone is insufficient proof of a usable wallet result.

## Confirmed public-request challenge and remaining measurement

An additional credential-free probe made public requests to the Platform landing page and `/auth-api/v0/users/current` with the deployment's browser-style headers. Both returned HTTP 202, `content-type: text/html; charset=UTF-8`, `x-amzn-waf-action: challenge`, and an empty body. The probe used no account credentials. This confirms a current edge challenge for that Node request path; it does not prove what a newly authenticated native app will receive. [AWS documents](https://docs.aws.amazon.com/waf/latest/developerguide/waf-captcha-and-challenge-actions.html) these Challenge response signals. The in-app browser reached the ordinary Platform sign-in page successfully.

New Host diagnostics record only status and allowlisted content-type/verification classifications. No response body, authorization header or cookie is logged by the new overlay. The later fresh-account measurement below separates the profile refusal from the independently reproduced client race and wallet-schema handling.

## Fix priorities

1. Establish and handle the profile challenge/refusal explicitly, with an honest retry/browser-account route. Do not treat every HTTP 2xx response as account JSON or repeatedly relogin to recover a name.
2. Preserve completed details across ordinary state refreshes only when the Host supplies a reliable same-account/grant identity. Clear them on sign-out or credential change; the present `credential-stored` projection alone cannot prove a same-account session.
3. Surface field-specific failures and explicit retry rather than generic labels or ambiguous loading. Keep wallet reads independent of profile reads and distinguish unavailable balance from zero balance.
4. Capture the actual cause of an unexpected Host exit and validate recovery of account streams/RPCs after restart.

The `signin-fixed-20261012-portable` build repairs automatic browser opening and the desktop PKCE callback route. It still has the external profile-response limitation described here. Its receipt remains unchanged by this analysis.

## Implemented account-data repair

The additional port-owned Host/client stage overlay:

- Supplies a random, non-token-derived `portSessionId`, stable for one credential lifetime. It rotates when the credential or Host lifetime changes and is absent while signed out.
- Preserves completed details and pending reads across notifications carrying the same session identifier. Unknown, changed and signed-out sessions clear the details; late reads from a retired session are discarded.
- Classifies WAF Challenge/CAPTCHA responses as `verification-required`, with independent profile/wallet failures. A challenge does not expire a stored grant; a true unauthorized response still does.
- Displays a validated contact when a profile has no display name. Failed refreshes retain previously displayed results only within the current session and explicitly mark them stale. An account-details Retry button invokes both reads; existing browser-account links remain available.
- Accepts null or absent optional contact fields, including a phone-only identity with `email: null`. At least one nonempty contact or display name is still required. This correction existed only in the earlier portable artifact and is now owned by the stage, so rebuilding cannot silently lose it.
- Applies reviewed semantic guards before packaging and sealing. CSS identifiers contain checkout paths, so client guards cover the changed behavior blocks rather than a location-dependent whole-bundle digest.
- Supplies the onboarding Add credits action with the existing external-browser route while the embedded Platform capability is absent. It validates the exact HTTPS destination and refreshes account data after the app loses and regains focus. Guest admission remains disabled.

The production-profile Host fixture passes against the staged payload: authenticated stream delivery of the session identifier, successful PKCE exchange with a null-email/phone-only identity, independent wallet success under a profile challenge, explicit challenge reason over real RPC, no cached identity reuse after relogin, invalid balance and empty identity rejection, and genuine unauthorized credential expiry. The authentic client factory tests reproduce the race in the unmodified bundle and verify same-session retention, pending read acceptance, Retry wiring, contact fallback and retirement of old results in the repaired bundle. The actual onboarding registration/controller/credit component also shows the original disabled button and verifies that the repaired button invokes the browser opener and refreshes after return. Framework/transport boundaries are mocked in these client tests; they are not native visual qualification. All 18 affected account tests pass with no skips against the v2 portable provider/client. The preceding broader 122-test account/packaging run had one missing generated-manifest precondition; after supplying the then-current staged manifest and scoping the child PowerShell module path, all 25 gate-contract tests pass. The v2-only change is the onboarding browser action; unrelated passing packaging checks were not repeated.

## Fresh-account qualification

The user created and authorized the dedicated test account through the Platform browser flow. No browser cookies were imported, inference request was made or purchase was performed.

| Lane | Result and boundary |
|---|---|
| Private Host loading the production profile from the v1 portable | Browser PKCE exchange succeeds; profile and wallet schema results are `ready`; repeat profile read remains ready. The exchange and wallet endpoints return HTTP 200 JSON. |
| Profile background refresh in that live Host | `/auth-api/v0/users/current` returns HTTP 403 HTML without a WAF-action header. Identity is available through the valid exchange and grant-bound cache. This response does not prove a specific WAF Challenge classification. |
| Fresh native debug app with explicit owned credential namespace/home and the v1 runtime/shell | Actual authenticated gateway RPC/watch delivers ready fields. Settings → Account visibly displays the validated test contact and `$0.00` topped-up balance. The account legitimately has no display name. |
| Native onboarding | Get started persists without the former settings error. Skip and Got it complete onboarding. Add credits was disabled because the embedded Platform capability is absent; the v2 browser fallback fixes its injection and passes the authentic component test, but has not received a new native visual test. |
| Credential cleanup | Local grants in both isolated test lanes are removed. Remote revocation is unverified; the standalone Host's logout request was aborted during disposal. The signed-out native test window was left open when UI interaction was paused. |

Evidence: `C:\Users\Yoova\Hermes\dsh-desktop\repair-evidence\account-live-20261012\` contains the live Host and native RPC receipts, authorization-result screenshot and native Account screenshot. The native debug build uses an outside trusted Cargo target with measured Medium parent/child tokens and the explicit per-run credential fence. The worktree's Low negative control was not exercised. These checks do not qualify a release credential namespace, native guest lifecycle or installer.

The v2 portable reuses the matching Oct 12 Release executable and shell and contains newly sealed runtime client bytes. Only its mock production-profile Host and authentic client tests establish v2 integration here; the real native account screenshot belongs to the preceding v1 runtime. The standalone `profileReadyMs: 2633` measurement excludes imports, native startup and browser interaction, so it is not a cold-launch benchmark. The 1.5-second startup target remains unmet.

This repair handles the client race, identity validation and failure presentation. It does not make a refused Node profile refresh pass browser verification. A durable profile transport/session solution remains open. Two earlier isolated headless Edge probes exited without producing browser output; they are not a qualified workaround and are not included in the product. Native guests remain disabled.
