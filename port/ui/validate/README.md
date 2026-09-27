# `validate` — output verification harnesses

Run both from `port/ui/` after a build (ports 3086/3089, `127.0.0.1` only; no
other process or user state is touched).

- `node validate/mount-check.mjs` — serves `dist/` exactly as the shell-owned
  boot path describes (`ui-backend-protocol.md` §7.3): dist statics, the Host
  injection table (`bootInjections` from the built `@deepseek-ai/dsh-client-modules`)
  rendered into `index.html`, and the 64 built client plugin bundles at their
  `/plugins/...` combo URLs. Fetches every shipped file (expects 200 at each
  exact path), then drives real Chromium and asserts the client mounts (root
  populated, plugin `style[data-plugin]` tags injected, `__DSH_BOOT_READY__` /
  `__DSH_BOOT__` / `__ModuleLoader__` live, no boot-failure text). Unconnected
  `/api` console noise is expected (no agent runtime in this harness).
  Screenshot: `../.scratch/mount-check.png`.
- `node validate/font-check.mjs` — serves `dist/`, force-loads every registered
  `@font-face`, and asserts the 3 Montserrat brand faces and 20 KaTeX content
  faces load from their `assets/fonts/` paths.
- `node validate/gateway-probe.mjs --base <url> --token <token> --rev <rev>` —
  checks a running gateway: `/` carries `__DSH_BOOT_READY__`, and the bootstrap
  `script-src` row URL (`plugins/??<spec>&rev=<rev>`, upstream's
  `comboSearch()`/`comboUrl()` format — the doubled `??` is intentional)
  returns JavaScript. Requires the live graph's revision (build-derived;
  identical builds share it — the test placeholder `fx` never matches), the
  exact `--src <batch.url>`, or a token so the served row can be discovered;
  without one it fails fast instead of issuing a request that can only
  misreport. Rendered rows are HTML-entity-decoded before resolution (the
  browser does the same for `script.src`). Outcomes are reported separately
  with status, content-type, and first bytes: served-JavaScript (PASS),
  shell-document fallback (200 + `text/html` + `<!doctype` — the only outcome
  supporting the "HTML did not preload" explanation), 404 (wrong revision —
  not fallback evidence), and unexpected. REQUIRED FIRST STEP: run it against
  a known-good reference instance before judging any port (baseline: passes
  against the upstream reference).

All exit non-zero on failure.
