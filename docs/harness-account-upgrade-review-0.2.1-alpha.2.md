# Account overlay review: 0.2.1-alpha.2

Reviewed against commit `d743267388641bc76f17c45ce8b4c231aed1d32c` (tag `dsh-v0.2.1-alpha.2`) and the built qualification checkout. This is an emitted-code compatibility review, **not live platform acceptance**. The source-only checkout cannot satisfy tests that execute built Host/client code.

## Narrow release and code gates

The three transforms select `TARGET_RELEASE.release` from the sealed target descriptor, retain their historical `0.1.7-rc.2` inputs, and reject every unreviewed release or generated semantic region. A release string alone never authorizes a source shape. Target profile repair accepts only the original upstream method, not the historical portable disk-fallback variant.

The target HTTP request region is `13ce7456fc971c58c8f95d212957dadb8b117a8a48e07753ba3786a41ca4b87a` (SHA-256). Reviewed client regions:

| Region | SHA-256 |
|---|---|
| AccountSection | `b77d0878eae2e44ca4883a45a05d601261646ec57202a54d2c7af631594e79d1` |
| apply | `30703f0fd642d3381c77bcc29152abbd81a3999bcccbcb77db0d06edfd924b37` |
| English strings | `3f3ce636669ce75254e5bfffcaded7cf4d1c196e09326c58e4ae02243e7259c4` |
| Chinese strings | `e162549f2b24d3fa850b9d00301b92ee536716da045f1a2e332c48e9974e83a5` |

User schema, account state, detail reads, `getProfile`, and `startSignIn` emitted semantics are unchanged from the original historical upstream regions. The original profile method hash remains `3628899fd423bb6838586f915d7da7ee5b96de6e371546f95a4944ec4f3f97b2`; the login hash remains `f9a87137ba5112e4e7ce2d6b839368b1977e97cf9c04ee51b70026437ee2aeb7`.

## Semantic changes reviewed

- Network failure now exposes upstream `no-response`. The public desktop failure classifier maps both old `network` and new `no-response` to the existing safe `network` reason; bodies, exception text, cookies, tokens and URLs are not diagnostic output.
- Upstream adds `getDeviceIdentity()` and factors out the device OS string. This does not change the grant, profile, login or read lifetime regions the overlays replace.
- AccountSection hides the empty bonus row only when a ready balance has no positive bonus. Failed/loading balances still have status UI. The preserved stale-data and Retry overlays coexist with this new branch.
- Feedback now samples a ready profile UID, optional native device info (browser user agent fallback), pixel ratio and screen resolution. The questionnaire URL's hidden fields are `uid`, `source`, `harness_version`, and `device_info`; retired prefill fields are removed. It does not include an authorization token or cookie. Feedback remains an explicit user action; the overlay does not broaden permitted account-page destinations.
- Onboarding adds optional product-analytics events and corrects the Continue setup callback. It keeps the native browser Add credits fallback and refresh-on-return behavior. The component test context now supplies the framework's optional service lookup, as the new real client calls `ctx.get('productAnalytics')`.
- Other emitted client changes are stylesheet identifiers and localized Settings/contact/bonus/network copy; these do not justify removing drift guards.

## Expiry precedence correction

The existing WAF diagnostic repair must not turn an authenticated HTTP 401 into retryable browser verification. Its classification now defers to upstream's existing authenticated-401 branch. Both HTTP 401 and JSON code 40003 still produce `AccountUnauthorizedError`; challenged HTTP 202 produces `verification-required`, cancels its body, and does not clear a valid grant. Same-grant cached identity remains visibly stale rather than fabricated fresh data; rotated/signed-out grants never receive an old profile.

## Evidence and limits at review time

Pinned Node 22.20.0 with `DSH_UPSTREAM_ROOT` selecting the built target checkout ran five focused suites: **28 tests, 27 pass, 0 fail, 1 skip**. Tests execute the real emitted client (including the race against original upstream), the real onboarding credit-button component, and the actual transformed HTTP request function with real upstream Zod. The HTTP behavior test covers authenticated 401 plus WAF headers, 202 challenge, code 40003, new transport code and log redaction. The packaged profile-expiry test also supplies a WAF header on its 401 response.

The single skipped test requires `DSH_TEST_ACCOUNT_RUNTIME` pointing at the generated runtime. It must run again against the staged target package before packaging acceptance. No successful live profile response, latest native login, or production provider chat is claimed by this review.

## Other inspected Host drift

`apps/desktop-host/src/index.ts` now explicitly binds `127.0.0.1` on port `0` and constructs the authenticated origin from `ctx.webServer.protocol`; the old port adapter still needed those production changes when reviewed. `host-process.ts`, `host-protocol.ts` and `office.ts` are unchanged. The Office-engine hook adds resolved engine-target matching only for packaged ASAR roots; the port ships an unpacked runtime, so its no-ASAR hook remains a no-op. These findings were passed to the build/adapter owner, not silently assumed compatible.
