# Startup core/deferred roster — desktop port (plan §1, SA-B)

**Payload**: `C:\Users\Yoova\Hermes\dsh-desktop\onboarding-fixed-portable\dsh` — `@deepseek-ai/dsh-desktop-runtime` 0.1.7-rc.2, bundled Node v22.20.0 (win-x64), upstreamCommit `477b4f420553e8a52c2fbccc464d7561b239c443`, flat non-symlinked node_modules (~443 packages).
**Profile**: `C:\Users\Yoova\.dsh\profiles\desktop` (cordis.yml = empty root `[]`; composition entirely from patch layers: `dsh-base` → `dsh-web-app` (+ its 4 preset files) → `@dsh-port/dsh-desktop-updates-bundle` (verified NO-OP) → profile `cordis.patch.yml` → home `$DSH_HOME/cordis.patch.yml`).
**Verification**: production composition loader (`dsh --dump-config` on the bundled node, isolated fixture). Credential files were never opened; the live portable copy and `_upstream` were never modified; the fixture is a copy of CONFIG files only.

## 1. Verification (exact command, exit code)

```powershell
$env:DSH_HOME  = '<scratch>\fixture\home'   # fixture copy of the live profile, renamed desktop-audit
$env:HOME      = $env:DSH_HOME;  $env:USERPROFILE = $env:DSH_HOME
$env:TEMP      = '<scratch>\fixture\temp';  $env:TMP = $env:TEMP
$env:NODE_OPTIONS = '';  $env:NODE_PATH = ''
& 'C:\Users\Yoova\Hermes\dsh-desktop\onboarding-fixed-portable\dsh\node\node.exe' `
  'C:\Users\Yoova\Hermes\dsh-desktop\onboarding-fixed-portable\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js' `
  --dump-config --profile desktop-audit 1>dump-config.stdout.txt 2>dump-config.stderr.txt
# → EXIT=0, stderr empty, 1,268 lines of composed YAML
```

- The CLI rejects the profile **name** `desktop` (`rejectElectronProfile`, `lib/bin.js:36`), so the byte-identical profile copy is composed under `desktop-audit`. This is lossless for composition: `--dump-config` never evaluates `!!js` (printed verbatim) and bundle resolution is installation-anchor-first (`resolveBundleDir`: payload `node_modules` → profile dir), so the fixture needs no `node_modules` of its own. Full transcript + call chain: `.scratch/startup-roster/verify-transcript.md`.
- The desktop boot itself uses the same composition inputs (`adapter.mjs`: `loadProfileDirectory('dsh', projectDir, installAnchor)` + `runProfile({profile:'desktop', resolvedProfile:…, patchFiles:[], args:['--no-open','--port',PORT]})`), so the dump is the adapter's mounted tree.

## 2. Composition headline numbers

| Metric | Value |
|---|---|
| Composed rows (top-level entries) | **182** |
| Hard `disabled: true` rows | **27** |
| `!!js`-gated rows, disabled at win32 runtime | **1** (`bash-sandbox`) |
| **Active at desktop runtime** | **154** |
| **CORE closure** (critical path to usable workspace) | **125 rows** |
| **DEFERRABLE candidates** (active, not first-frame) | **29 rows** |
| Client packages with `dsh.client` manifest | 69 |
| …in the client **immediate tier** (`dsh.client.immediately: true`) | **10** |
| Port-owned (`@dsh-port/*`) rows in the tree | **0** (updates bundle contributes `[]`; `dsh-client-ui-updates` is not a bundle) |
| Required-entry audit rows mounted (fail = no boot) | `agent-loop`, `webserver`, `modules`, `connection` |

Full table: §6. Machine-readable: `.scratch/startup-roster/rows-classified.json`.

## 3. CORE closure — what must mount for chat input + sidebar + Settings on a ready Host

Evidence key: `→` = injects/requires (composition row `inject` or lib `ctx.inject([...])`, verified in payload libs); `★` = required-entry row.

**Transport & readiness owners (the ready path):**
`web-startup` (`dsh-web-app/startup`, parses `--port/--no-open` into `cmdlineArgs`) → `webserver` ★ (`dsh-host-webserver`, injects `webStartup`; binds `node:http` `.listen()`) → `web-runtime` (`dsh-web-app`, injects `webServer`; resolves `@deepseek-ai/dsh-web-frontend` dist, mounts the frontend-static fallback, samples LAN trust, provides `webRuntime`; after `loader.await()` + `auditStartupEntries` announces ready/URL — with `--no-open` it only prints) → `connection` ★ (`dsh-client-connection`, injects `webRuntime`; node half = gateway/SSE transport, browser half = fetch client, `authenticatedUrl`) → `modules` ★ (`dsh-client-modules`, injects `webServer`; scans `dsh.client` manifests into `window.__DSH_BOOT__` and serves `/plugins/<id>/client.js`) → `agent-loop` ★ (creates no agents at boot: `agents: []`; sessions are created on client request).
Adapter readiness: `ready` is sent over the control socket after `ctx.connection.authenticatedUrl(...)` + `webServer.collectIndexInjections()` — **after** the office mount (see §5, D1).

**Typert remote plane** (every Settings/sidebar RPC): `typert` (`dsh-typert-registry`) + `typert-loader` + `typert-gateway` = `api-gateway` (injects `connection`,`webServer`; binds `ws` WebSocketServer under /api) + `api-remotes` + `session-controller` (injects `attachments`) + `settings-controller` + `workspace-controller` + `account-controller` + `workspace-files` (injects `sessions`,`typert`) + `terminal-controller` + `job-controller`.

**Session domain** (sidebar list + chat transcript): `session` (injects `typert`) → `session-log-deepseek`, `session-persistence-jsonl` (root `dshHomePath('sessions')`), `session-projection`, `session-projection-cache` (write-behind timers), `session-stats`, `session-turn-outline`, `session-title`, `session-title-llm` (LLM title on first prompt), `session-reference`, `session-query-sqlite` (`openAt: never` → verified zero boot cost; `node:sqlite` is a lazy `await import` behind `_assertSearchEnabled`), `session-checkpoint-policy`, `attachment-local`, `storage` → `storage-json` → `storage-domain` (injects backend).

**Agent/chat execution** (first message): `agent`, `agent-loop`, `tools`, `system-prompt`, `shell-env`, `commands`, `command-feedback`, `user-questions`, `approval`, `permission`, `sandbox-policy`/`sandbox`/`pwsh-sandbox`/`fs-sandbox`/`fs-observation-policy`/`subprocess-local`, `llm` + `llm-retry` + `llm-deepseek-account` + `llm-deepseek` (injects `settings`) + `deepseek-account`/`deepseek-account-platform` (injects `agents`; desktopPlatform resolves `'win32'`; fetch is per-request only) + `authorization` + `credentials-local` + `agent-default-model`, `agent-preset-registry` (+ the 4 preset group rows; per-session mount, zero boot cost), `skill` (registry), `mcp-resources` (no servers configured), `token-meter`, `spill-local`/`spill-policy`, `compaction-basic`/`command-compact`/`tool-result-pruner` (**host rows re-enabled by the home-level patch** — the web layer had disabled them when moving the agent plane behind presets), `image-offload`, `goal`/`goal-round-driver`, `jobs` (`dsh-jobs-local`, the background-job registry that preset tools resolve with `ctx.get`), `plugin-package-inventory-deepseek` (light), `settings` (enabled via profileContext), `workspace`/`workspace-changes`→(D-list), `file-reference-local`, `directory-picker` (`-auto`; cheap `accessSync` probes), `fs-observation-policy`.

**Client roster** (first frame; non-immediate tiers are kernel-fetched on demand, so their host rows cost only the `modules` scan): immediate tier = `dsh-api-gateway`, `dsh-api-remotes`, `dsh-client-connection`, `dsh-client-file-upload`, `dsh-client-hmr`, `dsh-client-locale`, `dsh-client-modules`, `dsh-client-ui-renderer`, `dsh-client-ui-theme`, `dsh-typert-registry`; plus the mounted surface rows: `ui-theme`, `locale`, `shortcuts`/`ui-shortcuts`, `ui-layout`, `ui-renderer`, `ui-session`, `resources`, `ui-sidebar`, `ui-sidebar-right`, `ui-conversation`, `ui-chat` (profile-configured), `ui-input-trigger`, `ui-commands`, `ui-skill`, `ui-subagent`, `ui-reference`, `ui-attachment`, `ui-tool`, `ui-brand-official`, `ui-approval`, `ui-permission`, `ui-user-questions`, `ui-model-selection`, `ui-plan`, `ui-goal`, `ui-workspace`, `ui-settings` (profile patch sets `enabled: false` on its shell toggle while `ui-settings-general`/`-models`/`-account` remain the Settings surface), `ui-settings-general`, `ui-settings-models`, `ui-settings-account` (profile patch: onboarding done/skipped), `client-file-upload`.

**CORE count: 125 rows.** The chat input, sidebar, Settings RPCs, and a ready Host depend on exactly these; removing any row in §3 breaks a first-frame or first-message capability (or a required-entry audit).

## 4. DEFERRABLE candidates (29 active rows), ranked by activation-cost evidence

Static cost evidence = top-level imports executed at row mount + activation work, from payload `lib/index.js` reads (`.scratch/startup-roster/evidence-activation-costs.md`).

| # | Row(s) | Package | Cost evidence at mount | Deferral mechanism that fits the existing lifecycle | Semantics |
|---|---|---|---|---|---|
| D1 | — (adapter-owned, no row) | `desktopOffice` in `adapter.mjs` | imports `dsh-skill-office` (3.9 KB) + `dsh-tool-workspace-dependencies` (10.3 KB) and mounts via `await ctx.plugin(...)` **between loader settle and the `ready` frame** (`bootMark('office-installed')` precedes `ready-sent`) | **Move the call after the `ready` send** — `ctx.plugin` dynamic mount is the sanctioned lifecycle; the adapter owns this code | None: Office skills register moments later; `primary-runtime` is absent in this payload so the workspace-dependencies half already no-ops with a warn |
| D2 | `llm-pi-ai` | `dsh-llm-pi-ai` | 111.3 KB module + top-level `@earendil-works/pi-ai/providers/all` catalog; mounted **dormant** (zero routes until an `llm-pi-ai:` settings section exists) | Lazy import of the pi-ai catalog at first route registration (upstream change), or port-owned deferred `ctx.plugin` mount after ready | None if deferred mount; row-disable would remove the Models-page provider twin (semantics change) |
| D3 | `session-telemetry-otel` | `dsh-session-telemetry-otel` | Full OTel SDK import (`sdk-logs`, `exporter-logs-otlp-http`, `api-logs`, `resources`) + `new LoggerProvider/BatchLogRecordProcessor/OTLPLogExporter` at activation; mode FEEDBACK_ONLY (emits only after explicit user feedback) | Row `disabled: true` via the launcher's existing telemetry switch (`DSH_TELEMETRY_DISABLED`, `resolveTelemetryPatch`) — supported today | Explicit opt-out (loses feedback-triggered telemetry); lazy provider construction on first emit = upstream change, no semantics change |
| D4 | `cordis-host-runner` (+`cordis-client-runner`, `cordis-inspect-providers`, `ui-cordis`) | `dsh-cordis-host-runner` | 100.4 KB; imports `node:vm` (`Script/createContext/runInContext`) + llm/tools/typert | Port-owned post-ready phased `ctx.plugin` mount; or row disable (Cordis tool surfaces report unavailable) | None for first frame either way; agent's `cordis` tool appears late |
| D5 | `plugin-manager` (+`ui-plugin-manager`, `plugin-inventory`, `ui-settings-plugin-inventory`, `ui-settings-plugins`) | `dsh-plugin-manager` | 83.6 KB; imports `execa` + dsh-app-boot reconcile/compatibility machinery; active because profileContext exists | Post-ready phased mount; or row disable — the sidebar Plugins page already "reports itself unavailable" without a profile-backed Host (documented behavior) | None for first frame |
| D6 | `open-in-app` + `ui-open-in-app` | `dsh-host-open-in-app` | 46.6 KB; imports `dsh-native-command` + launch-environment + subprocess; probes/launches are request-time | Post-ready phased mount | "Open In…" button appears late; a Host with no resolved application already renders no button |
| D7 | `office-to-pdf` + `ui-sidebar-documentpreview` | `dsh-office-to-pdf` | 26.2 KB + top-level `import { createConverter } from "@deepseek-ai/libreoffice-kit"` (converter process itself is lazy per conversion) | Post-ready phased mount (pairs with D1) | Document-preview Office rendering registers late; other preview renderers unaffected |
| D8 | `workspace-changes` + `ui-deliverables` | `dsh-workspace-changes` | 38.1 KB + `diff` import; git spawns happen per top-level turn (not at boot) | Post-ready phased mount, or lazy import at first turn (upstream) | None: changed-files card populates from the first turn onward |
| D9 | `hmr` | `dsh-hmr` | 24.3 KB + chokidar + @babel/code-frame + picomatch; **starts filesystem watchers at activation** on the profile manifest + both patch files | Row `disabled: true` in the desktop profile patch — pure composition, supported today | Profile edits require restart — already the desktop norm (port owns updates/restarts); `client-hmr` stays mounted and stays idle |
| D10 | `session-log-download` | `dsh-session-log-export` | 23.2 KB + `fflate` zip import | Post-ready phased mount | `/export` + download dialog register late |
| D11 | `subagent`, `subagent-spawn-in-process`, `subagent-fork-in-process` | `dsh-subagent` + in-process backends | Registry + backends imported at mount; needed only at first delegation | Post-ready phased mount only — the registry is a cross-session singleton the host api-proxy serves; keep it before the first session's first delegation | None if mounted before first use |
| D12 | `web-fetch-http`, `web-search-deepseek` (+base `web`) | `dsh-web-fetch-http` (26.7 KB, ipaddr.js) / `dsh-web-search-deepseek` (13.5 KB) | per-request fetch; services consumed per session by the preset `tool-web` row | Lazy import inside first search/fetch (upstream change) | None; row disable would break web tools per session |
| D13 | `message-feedback` + `ui-message-feedback` | `dsh-message-feedback` | 12.8 KB (zod, session surface helpers) | Post-ready phased mount | Like/Dislike strip registers late |
| D14 | `ui-jobs` + `job-controller`, `ui-workflow-run`, `ui-trajectory`, `ui-agent-preset`, `ui-sidebar-browser` | client-lazy already | Host cost = module scan only (non-immediate client tier); `ui-sidebar-browser` is desktop-enabled via `!!js` gate | No action needed; kernel already defers their module fetch | — |
| D15 | `config-editor` | `dsh-config-editor` | 7.4 KB, light (yaml/js-yaml) | Post-ready phased mount | Live-config editing registers late |

**Already deferred by upstream (verified, no action):** `session-query-sqlite` (`openAt: never`; lazy `node:sqlite`), `time-context`/`schedule`/`ui-schedule` (rows disabled), `skill-badge`, `tool-ralph`, the entire preset-plane tool roster (host rows disabled; presets mount per session), 59/69 client packages (non-immediate tier), `session-projection-cache` (timers only), storage/persistence (request-time fs).

## 5. Deferral-mechanism matrix (existing lifecycle vs port-owned phased composition, plan §2)

| Mechanism | Supported today without code changes? | Semantics change? | Applies to |
|---|---|---|---|
| Profile patch row `disabled: true` (desktop `cordis.patch.yml`) | Yes — the sanctioned user-layer operation | Yes for service consumers; safe where the consumer degrades gracefully (Plugins page unavailable-warning; telemetry opt-out switch; HMR-restart norm) | D3, D9 (+ any row whose consumers tolerate absence) |
| `DSH_TELEMETRY_DISABLED` env switch (launcher telemetry patch) | Yes — existing `resolveTelemetryPatch` | Explicit opt-out | D3 |
| Post-`ready` phased `ctx.plugin(...)` mount in the adapter (the existing `desktopOffice` pattern) | Code lives in adapter.mjs — port-owned boot code; lifecycle mechanism (`ctx.plugin`) is first-class and already used | None — features register moments later, before or shortly after first use | D1, D2, D4, D5, D6, D7, D8, D10, D11, D13, D15 |
| Lazy import inside first-use methods | No — upstream plugin code change | None | D2, D8, D12 |
| Client immediate-tier trimming | Already implemented upstream (`dsh.client.immediately` + `prefetchImmediateTier()`); only 10 packages prefetch | — | no-op for the port |

Recommended port default (§2 fallback ordering): D1 (move office mount after ready) + D9 (disable HMR watchers) + D3 (telemetry switch) are the no-semantics-change wins; D2/D4/D5/D6 follow as post-ready phased mounts if boot-timing marks (`bootMark` in the instrumented adapter) show their share of `application-resolved → ready-sent`.

## 6. Full mounted composition (loader-verified, 182 rows)

Class key: **CORE** = critical path (§3) · **DEFERRABLE** = §4 · **DISABLED** = `disabled: true` in the composed tree · **DISABLED@win32** = `!!js` evaluates disabled at desktop runtime · *group* = agent-preset group row (per-session mount, no boot cost).

| # | id | package | layer introduced | state | class |
|---|---|---|---|---|---|
| 1 | tool-plugin-manager | @deepseek-ai/dsh-plugin-manager/tools | @deepseek-ai/dsh-base | disabled:true | DISABLED |
| 2 | plugin-manager | @deepseek-ai/dsh-plugin-manager | @deepseek-ai/dsh-base | !!js '!ctx.get(''profileContext'')' | CORE |
| 3 | timer | @deepseek-ai/cordis-plugin-timer | @deepseek-ai/dsh-base |  | CORE |
| 4 | hmr | @deepseek-ai/dsh-hmr | @deepseek-ai/dsh-base | !!js '!ctx.get(''profileContext'')' | CORE |
| 5 | llm | @deepseek-ai/dsh-llm | @deepseek-ai/dsh-base |  | CORE |
| 6 | deepseek-llm-api-extensions | @deepseek-ai/dsh-deepseek-llm-api-extensions | @deepseek-ai/dsh-base |  | CORE |
| 7 | session | @deepseek-ai/dsh-session | @deepseek-ai/dsh-base |  | CORE |
| 8 | session-log-deepseek | @deepseek-ai/dsh-session-log-deepseek | @deepseek-ai/dsh-base |  | CORE |
| 9 | typert | @deepseek-ai/dsh-typert-registry | @deepseek-ai/dsh-base |  | CORE |
| 10 | typert-loader | @deepseek-ai/dsh-typert-loader | @deepseek-ai/dsh-base |  | CORE |
| 11 | typert-gateway | @deepseek-ai/dsh-api-gateway | @deepseek-ai/dsh-base |  | CORE |
| 12 | session-title | @deepseek-ai/dsh-session-title | @deepseek-ai/dsh-base |  | CORE |
| 13 | session-title-llm | @deepseek-ai/dsh-session-title-first-prompt-llm | @deepseek-ai/dsh-base |  | CORE |
| 14 | user-questions | @deepseek-ai/dsh-user-questions | @deepseek-ai/dsh-base |  | CORE |
| 15 | agent | @deepseek-ai/dsh-agent | @deepseek-ai/dsh-base |  | CORE |
| 16 | plugin-package-inventory-deepseek | @deepseek-ai/dsh-plugin-package-inventory-deepseek | @deepseek-ai/dsh-base |  | CORE |
| 17 | agent-default-model | @deepseek-ai/dsh-agent-default-model | @deepseek-ai/dsh-base, patched by (fixture-home)\profiles\desktop-audit\cordis.patch.yml |  | CORE |
| 18 | jobs | @deepseek-ai/dsh-jobs-local | @deepseek-ai/dsh-base |  | CORE |
| 19 | llm-retry | @deepseek-ai/dsh-llm-retry | @deepseek-ai/dsh-base |  | CORE |
| 20 | config-editor | @deepseek-ai/dsh-config-editor | @deepseek-ai/dsh-base | !!js '!ctx.get(''profileContext'')' | CORE |
| 21 | settings | @deepseek-ai/dsh-settings | @deepseek-ai/dsh-base | !!js '!ctx.get(''profileContext'')' | CORE |
| 22 | authorization | @deepseek-ai/dsh-authorization | @deepseek-ai/dsh-base |  | CORE |
| 23 | deepseek-account | @deepseek-ai/dsh-deepseek-account-platform | @deepseek-ai/dsh-base |  | CORE |
| 24 | credentials | @deepseek-ai/dsh-credentials-local | @deepseek-ai/dsh-base |  | CORE |
| 25 | llm-pi-ai | @deepseek-ai/dsh-llm-pi-ai | @deepseek-ai/dsh-base |  | DEFERRABLE |
| 26 | session-persistence-jsonl | @deepseek-ai/dsh-session-persistence-jsonl | @deepseek-ai/dsh-base |  | CORE |
| 27 | attachment-local | @deepseek-ai/dsh-attachment-local | @deepseek-ai/dsh-base |  | CORE |
| 28 | session-query-sqlite | @deepseek-ai/dsh-session-query-sqlite | @deepseek-ai/dsh-base |  | CORE |
| 29 | session-projection | @deepseek-ai/dsh-session-projection | @deepseek-ai/dsh-base |  | CORE |
| 30 | storage | @deepseek-ai/dsh-storage | @deepseek-ai/dsh-base |  | CORE |
| 31 | storage-json | @deepseek-ai/dsh-storage-json | @deepseek-ai/dsh-base |  | CORE |
| 32 | storage-domain | @deepseek-ai/dsh-storage-domain | @deepseek-ai/dsh-base |  | CORE |
| 33 | session-projection-cache | @deepseek-ai/dsh-session-projection-cache | @deepseek-ai/dsh-base |  | CORE |
| 34 | session-telemetry-otel | @deepseek-ai/dsh-session-telemetry-otel | @deepseek-ai/dsh-base |  | DEFERRABLE |
| 35 | subprocess | @deepseek-ai/dsh-subprocess-local | @deepseek-ai/dsh-base |  | CORE |
| 36 | sandbox | @deepseek-ai/dsh-sandbox-local | @deepseek-ai/dsh-base |  | CORE |
| 37 | sandbox-policy | @deepseek-ai/dsh-sandbox-policy | @deepseek-ai/dsh-base |  | CORE |
| 38 | bash-sandbox | @deepseek-ai/dsh-bash-sandbox | @deepseek-ai/dsh-base | !!js process.platform === 'win32' | DISABLED@win32 |
| 39 | pwsh-sandbox | @deepseek-ai/dsh-pwsh-sandbox | @deepseek-ai/dsh-base | !!js process.platform !== 'win32' | CORE |
| 40 | approval | @deepseek-ai/dsh-user-approval | @deepseek-ai/dsh-base |  | CORE |
| 41 | permission | @deepseek-ai/dsh-permission-presets | @deepseek-ai/dsh-base |  | CORE |
| 42 | shell-env | @deepseek-ai/dsh-shell-env | @deepseek-ai/dsh-base |  | CORE |
| 43 | tool-bash | @deepseek-ai/dsh-tool-bash | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 44 | tool-pwsh | @deepseek-ai/dsh-tool-pwsh | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 45 | tool-jobs | @deepseek-ai/dsh-tool-jobs | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 46 | fs-observation-policy | @deepseek-ai/dsh-fs-observation-policy | @deepseek-ai/dsh-base |  | CORE |
| 47 | tool-fs | @deepseek-ai/dsh-tool-fs | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 48 | tool-fs-search | @deepseek-ai/dsh-tool-fs-search | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 49 | agent-instructions | @deepseek-ai/dsh-agent-instructions | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 50 | skill | @deepseek-ai/dsh-skill | @deepseek-ai/dsh-base |  | CORE |
| 51 | skill-filesystem | @deepseek-ai/dsh-skill-filesystem | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 52 | skill-badge | @deepseek-ai/dsh-skill-badge | @deepseek-ai/dsh-base | disabled:true | DISABLED |
| 53 | tool-skill | @deepseek-ai/dsh-tool-skill | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 54 | commands | @deepseek-ai/dsh-commands | @deepseek-ai/dsh-base |  | CORE |
| 55 | command-feedback | @deepseek-ai/dsh-command-feedback | @deepseek-ai/dsh-base |  | CORE |
| 56 | goal | @deepseek-ai/dsh-goal | @deepseek-ai/dsh-base |  | CORE |
| 57 | goal-round-driver | @deepseek-ai/dsh-goal-round-driver | @deepseek-ai/dsh-base |  | CORE |
| 58 | command-goal | @deepseek-ai/dsh-command-goal | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 59 | plan-mode | @deepseek-ai/dsh-plan-mode | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 60 | token-meter | @deepseek-ai/dsh-token-meter | @deepseek-ai/dsh-base |  | CORE |
| 61 | compaction-basic | @deepseek-ai/dsh-compaction-basic | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app, (fixture-home)\cordis.patch.yml | false | CORE |
| 62 | command-compact | @deepseek-ai/dsh-command-compact | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app, (fixture-home)\cordis.patch.yml | false | CORE |
| 63 | subagent | @deepseek-ai/dsh-subagent | @deepseek-ai/dsh-base |  | DEFERRABLE |
| 64 | subagent-spawn-in-process | @deepseek-ai/dsh-subagent-spawn-in-process | @deepseek-ai/dsh-base |  | DEFERRABLE |
| 65 | subagent-fork-in-process | @deepseek-ai/dsh-subagent-fork-in-process | @deepseek-ai/dsh-base |  | DEFERRABLE |
| 66 | tool-subagent-control | @deepseek-ai/dsh-tool-subagent-control | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 67 | tool-subagent-list-agents | @deepseek-ai/dsh-tool-subagent-control/list-agents | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 68 | tool-subagent | @deepseek-ai/dsh-tool-subagent | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 69 | tool-subagent-fork | @deepseek-ai/dsh-tool-subagent | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 70 | ptc-runtime | @deepseek-ai/dsh-ptc-runtime-node | @deepseek-ai/dsh-base |  | DEFERRABLE |
| 71 | workflow-ptc | @deepseek-ai/dsh-workflow-ptc | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 72 | tool-workflow | @deepseek-ai/dsh-tool-workflow | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 73 | timeout-policy | @deepseek-ai/dsh-tool-call-timeout-policy | @deepseek-ai/dsh-base |  | CORE |
| 74 | spill-local | @deepseek-ai/dsh-spill-local | @deepseek-ai/dsh-base |  | CORE |
| 75 | spill-policy | @deepseek-ai/dsh-spill-policy | @deepseek-ai/dsh-base |  | CORE |
| 76 | session-checkpoint-policy | @deepseek-ai/dsh-session-checkpoint-policy | @deepseek-ai/dsh-base |  | CORE |
| 77 | tool-result-pruner | @deepseek-ai/dsh-compaction-tool-result-pruner | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app, (fixture-home)\cordis.patch.yml | false | CORE |
| 78 | image-offload | @deepseek-ai/dsh-compaction-image-offload | @deepseek-ai/dsh-base |  | CORE |
| 79 | tool-todo | @deepseek-ai/dsh-tool-todo | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 80 | tool-goal | @deepseek-ai/dsh-tool-goal | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 81 | tool-ralph | @deepseek-ai/dsh-tool-ralph | @deepseek-ai/dsh-base | disabled:true | DISABLED |
| 82 | repeat-tool-reminder | @deepseek-ai/dsh-repeat-tool-reminder | @deepseek-ai/dsh-base |  | CORE |
| 83 | web | @deepseek-ai/dsh-web | @deepseek-ai/dsh-base |  | CORE |
| 84 | web-search-deepseek | @deepseek-ai/dsh-web-search-deepseek | @deepseek-ai/dsh-base |  | CORE |
| 85 | web-fetch-http | @deepseek-ai/dsh-web-fetch-http | @deepseek-ai/dsh-base |  | CORE |
| 86 | tool-web | @deepseek-ai/dsh-tool-web | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 87 | mcp-resources | @deepseek-ai/dsh-mcp-resources | @deepseek-ai/dsh-base |  | CORE |
| 88 | tools | @deepseek-ai/dsh-tools | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app |  | CORE |
| 89 | system-prompt | @deepseek-ai/dsh-system-prompt | @deepseek-ai/dsh-base, patched by @deepseek-ai/dsh-web-app |  | CORE |
| 90 | agent-loop | @deepseek-ai/dsh-agent-loop | @deepseek-ai/dsh-base |  | CORE |
| 91 | fs-sandbox | @deepseek-ai/dsh-fs-sandbox | @deepseek-ai/dsh-base |  | CORE |
| 92 | llm-deepseek | @deepseek-ai/dsh-llm-deepseek-api-key | @deepseek-ai/dsh-base |  | CORE |
| 93 | llm-deepseek-account | @deepseek-ai/dsh-llm-deepseek-account | @deepseek-ai/dsh-base |  | CORE |
| 94 | subagent-model-selection-settings | @deepseek-ai/dsh-tool-subagent/model-selection-settings | @deepseek-ai/dsh-web-app |  | CORE |
| 95 | message-feedback | @deepseek-ai/dsh-message-feedback | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 96 | session-log-download | @deepseek-ai/dsh-session-log-export | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 97 | open-in-app | @deepseek-ai/dsh-host-open-in-app | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 98 | ui-open-in-app | @deepseek-ai/dsh-client-ui-open-in-app | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 99 | workspace | @deepseek-ai/dsh-workspace | @deepseek-ai/dsh-web-app |  | CORE |
| 100 | session-reference | @deepseek-ai/dsh-session-reference | @deepseek-ai/dsh-web-app |  | CORE |
| 101 | file-reference-local | @deepseek-ai/dsh-file-reference-local | @deepseek-ai/dsh-web-app |  | CORE |
| 102 | session-stats | @deepseek-ai/dsh-session-stats | @deepseek-ai/dsh-web-app |  | CORE |
| 103 | session-turn-outline | @deepseek-ai/dsh-session-turn-outline | @deepseek-ai/dsh-web-app |  | CORE |
| 104 | directory-picker | @deepseek-ai/dsh-host-directory-picker-auto | @deepseek-ai/dsh-web-app |  | CORE |
| 105 | plugin-inventory | @deepseek-ai/dsh-host-plugin-inventory | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 106 | session-controller | @deepseek-ai/dsh-api-session-controller | @deepseek-ai/dsh-web-app |  | CORE |
| 107 | job-controller | @deepseek-ai/dsh-api-job-controller | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 108 | terminal-controller | @deepseek-ai/dsh-api-terminal-controller | @deepseek-ai/dsh-web-app |  | CORE |
| 109 | workspace-files | @deepseek-ai/dsh-api-workspace-files | @deepseek-ai/dsh-web-app |  | CORE |
| 110 | time-context | @deepseek-ai/dsh-time-context | @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 111 | schedule | @deepseek-ai/dsh-schedule | @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 112 | ui-settings-account | @deepseek-ai/dsh-client-ui-settings-account | @deepseek-ai/dsh-web-app, patched by (fixture-home)\profiles\desktop-audit\cordis.patch.yml |  | CORE |
| 113 | account-controller | @deepseek-ai/dsh-api-account-controller | @deepseek-ai/dsh-web-app |  | CORE |
| 114 | settings-controller | @deepseek-ai/dsh-api-settings-controller | @deepseek-ai/dsh-web-app |  | CORE |
| 115 | workspace-controller | @deepseek-ai/dsh-api-workspace-controller | @deepseek-ai/dsh-web-app |  | CORE |
| 116 | cordis-host-runner | @deepseek-ai/dsh-cordis-host-runner | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 117 | cordis-inspect-providers | @deepseek-ai/dsh-tool-cordis/host | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 118 | web-startup | @deepseek-ai/dsh-web-app/startup | @deepseek-ai/dsh-web-app |  | CORE |
| 119 | webserver | @deepseek-ai/dsh-host-webserver | @deepseek-ai/dsh-web-app |  | CORE |
| 120 | web-runtime | @deepseek-ai/dsh-web-app | @deepseek-ai/dsh-web-app |  | CORE |
| 121 | client-hmr | @deepseek-ai/dsh-client-hmr | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 122 | modules | @deepseek-ai/dsh-client-modules | @deepseek-ai/dsh-web-app |  | CORE |
| 123 | connection | @deepseek-ai/dsh-client-connection | @deepseek-ai/dsh-web-app |  | CORE |
| 124 | file-upload | @deepseek-ai/dsh-client-file-upload | @deepseek-ai/dsh-web-app |  | CORE |
| 125 | api-remotes | @deepseek-ai/dsh-api-remotes | @deepseek-ai/dsh-web-app |  | CORE |
| 126 | cordis-client-runner | @deepseek-ai/dsh-cordis-client-runner | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 127 | ui-theme | @deepseek-ai/dsh-client-ui-theme | @deepseek-ai/dsh-web-app |  | CORE |
| 128 | locale | @deepseek-ai/dsh-client-locale | @deepseek-ai/dsh-web-app |  | CORE |
| 129 | shortcuts | @deepseek-ai/dsh-client-shortcuts | @deepseek-ai/dsh-web-app |  | CORE |
| 130 | ui-shortcuts | @deepseek-ai/dsh-client-ui-shortcuts | @deepseek-ai/dsh-web-app |  | CORE |
| 131 | ui-layout | @deepseek-ai/dsh-client-ui-layout | @deepseek-ai/dsh-web-app |  | CORE |
| 132 | ui-renderer | @deepseek-ai/dsh-client-ui-renderer | @deepseek-ai/dsh-web-app |  | CORE |
| 133 | ui-session | @deepseek-ai/dsh-client-ui-session | @deepseek-ai/dsh-web-app |  | CORE |
| 134 | resources | @deepseek-ai/dsh-client-resources | @deepseek-ai/dsh-web-app |  | CORE |
| 135 | ui-sidebar | @deepseek-ai/dsh-client-ui-sidebar | @deepseek-ai/dsh-web-app |  | CORE |
| 136 | ui-sidebar-right | @deepseek-ai/dsh-client-ui-sidebar-right | @deepseek-ai/dsh-web-app |  | CORE |
| 137 | office-to-pdf | @deepseek-ai/dsh-office-to-pdf | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 138 | ui-sidebar-documentpreview | @deepseek-ai/dsh-client-ui-sidebar-documentpreview | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 139 | ui-sidebar-browser | @deepseek-ai/dsh-client-ui-sidebar-browser | @deepseek-ai/dsh-web-app | !!js ctx.get('profileContext')?.name !== 'desktop' | CORE |
| 140 | ui-sidebar-terminal | @deepseek-ai/dsh-client-ui-sidebar-terminal | @deepseek-ai/dsh-web-app |  | CORE |
| 141 | ui-sidebar-files | @deepseek-ai/dsh-client-ui-sidebar-files | @deepseek-ai/dsh-web-app |  | CORE |
| 142 | ui-settings | @deepseek-ai/dsh-client-ui-settings | @deepseek-ai/dsh-web-app, patched by (fixture-home)\profiles\desktop-audit\cordis.patch.yml |  | CORE |
| 143 | ui-settings-general | @deepseek-ai/dsh-client-ui-settings-general | @deepseek-ai/dsh-web-app |  | CORE |
| 144 | ui-settings-models | @deepseek-ai/dsh-client-ui-settings-models | @deepseek-ai/dsh-web-app |  | CORE |
| 145 | ui-plugin-manager | @deepseek-ai/dsh-client-ui-plugin-manager | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 146 | ui-settings-plugin-inventory | @deepseek-ai/dsh-client-ui-settings-plugin-inventory | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 147 | ui-conversation | @deepseek-ai/dsh-client-ui-conversation | @deepseek-ai/dsh-web-app |  | CORE |
| 148 | ui-approval | @deepseek-ai/dsh-client-ui-approval | @deepseek-ai/dsh-web-app |  | CORE |
| 149 | ui-chat | @deepseek-ai/dsh-client-ui-chat | @deepseek-ai/dsh-web-app, patched by (fixture-home)\profiles\desktop-audit\cordis.patch.yml |  | CORE |
| 150 | ui-brand-official | @deepseek-ai/dsh-client-ui-brand-official | @deepseek-ai/dsh-web-app |  | CORE |
| 151 | ui-attachment | @deepseek-ai/dsh-client-ui-attachment | @deepseek-ai/dsh-web-app |  | CORE |
| 152 | ui-tool | @deepseek-ai/dsh-client-ui-tool | @deepseek-ai/dsh-web-app |  | CORE |
| 153 | ui-cordis | @deepseek-ai/dsh-client-ui-cordis | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 154 | ui-deliverables | @deepseek-ai/dsh-client-ui-deliverables | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 155 | workspace-changes | @deepseek-ai/dsh-workspace-changes | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 156 | ui-workspace | @deepseek-ai/dsh-client-ui-workspace | @deepseek-ai/dsh-web-app |  | CORE |
| 157 | ui-workflow-run | @deepseek-ai/dsh-client-ui-workflow-run | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 158 | ui-input-trigger | @deepseek-ai/dsh-client-ui-input-trigger | @deepseek-ai/dsh-web-app |  | CORE |
| 159 | ui-commands | @deepseek-ai/dsh-client-ui-commands | @deepseek-ai/dsh-web-app |  | CORE |
| 160 | ui-skill | @deepseek-ai/dsh-client-ui-skill | @deepseek-ai/dsh-web-app |  | CORE |
| 161 | ui-subagent | @deepseek-ai/dsh-client-ui-subagent | @deepseek-ai/dsh-web-app |  | CORE |
| 162 | ui-reference | @deepseek-ai/dsh-client-ui-reference | @deepseek-ai/dsh-web-app |  | CORE |
| 163 | ui-jobs | @deepseek-ai/dsh-client-ui-jobs | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 164 | ui-schedule | @deepseek-ai/dsh-client-ui-schedule | @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 165 | ui-goal | @deepseek-ai/dsh-client-ui-goal | @deepseek-ai/dsh-web-app |  | CORE |
| 166 | ui-message-feedback | @deepseek-ai/dsh-client-ui-message-feedback | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 167 | ui-model-selection | @deepseek-ai/dsh-client-ui-model-selection | @deepseek-ai/dsh-web-app |  | CORE |
| 168 | ui-permission | @deepseek-ai/dsh-client-ui-permission-presets | @deepseek-ai/dsh-web-app |  | CORE |
| 169 | ui-agent-preset | @deepseek-ai/dsh-client-ui-agent-preset | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 170 | ui-settings-plugins | @deepseek-ai/dsh-client-ui-settings-plugins | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 171 | ui-settings-shell | @deepseek-ai/dsh-client-ui-settings-shell | @deepseek-ai/dsh-web-app |  | CORE |
| 172 | ui-settings-agent-loop | @deepseek-ai/dsh-client-ui-settings-agent-loop | @deepseek-ai/dsh-web-app |  | CORE |
| 173 | ui-settings-subagent | @deepseek-ai/dsh-client-ui-settings-subagent | @deepseek-ai/dsh-web-app |  | CORE |
| 174 | ui-settings-web-search | @deepseek-ai/dsh-client-ui-settings-web-search | @deepseek-ai/dsh-web-app |  | CORE |
| 175 | ui-plan | @deepseek-ai/dsh-client-ui-plan | @deepseek-ai/dsh-web-app |  | CORE |
| 176 | ui-user-questions | @deepseek-ai/dsh-client-ui-user-questions | @deepseek-ai/dsh-web-app |  | CORE |
| 177 | ui-trajectory | @deepseek-ai/dsh-client-ui-trajectory | @deepseek-ai/dsh-web-app |  | DEFERRABLE |
| 178 | agent-preset-registry | @deepseek-ai/dsh-agent-preset-registry | @deepseek-ai/dsh-web-app |  | CORE |
| 179 | preset-standard | @deepseek-ai/dsh-agent-preset | @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 180 | preset-ptc | @deepseek-ai/dsh-agent-preset | @deepseek-ai/dsh-web-app | disabled:true | DISABLED |
| 181 | preset-minimal | @deepseek-ai/dsh-agent-preset | @deepseek-ai/dsh-web-app | !!js process.platform !== 'win32' | CORE |
| 182 | preset-cordis | @deepseek-ai/dsh-agent-preset | @deepseek-ai/dsh-web-app | !!js '!ctx.get(''profileContext'')' | CORE |

## 7. Readiness owners

1. **Required-entry audit** (`dsh-app-boot` global list, rows mounted here): `agent-loop` ★, `webserver` ★, `modules` ★, `connection` ★ — any failure = startup failure (dispose + nonzero). Everything else warns and continues.
2. **web-runtime** (`dsh-web-app`) is the ready announcer: after `loader.await()` + `auditStartupEntries` it prints the URL / would hand off the browser (desktop passes `--no-open`).
3. **Adapter** sends the shell's `ready` frame after: loader settle → update/quit controls → office-engine resolution (no-op, unpacked runtime) → **office plugin mount (D1 — currently on this path)** → platform-session publisher → `authenticatedUrl` + `collectIndexInjections()`.
4. **First-frame client owners**: the 10 immediate-tier modules, then the client cordis tree pulls `ui-layout`/`ui-sidebar`/`ui-chat`/`ui-settings*` on demand over `modules`-served `/plugins/<id>/client.js`.
5. **Settings data plane**: `settings` service (enabled via profileContext) ← `settings-controller` Remote ← `ui-settings*` pages (each page injects `settings`); `ui-settings-account` additionally injects `account-controller` Remotes; `dsh-client-ui-settings-account` writes only its namespace (`version/step/...` per the profile patch).

## 8. Raw evidence index (`.scratch/startup-roster/`)

| File | Content |
|---|---|
| `verify-transcript.md` | Exact commands, fixture layout, call chain, layer provenance, row accounting |
| `dump-config.composed.yaml` | The loader's composed tree (UTF-8; 1,268 lines, `!!js` verbatim) |
| `rows.json` / `rows-classified.json` | Parsed rows (id/name/layer/state) / + CORE-DEFERRABLE classification |
| `roster-table.md` | Generated table source for §6 |
| `evidence-dependency-graph.md` | `inject` map, `loader.await` sites, client immediate tier, required-entry list |
| `evidence-activation-costs.md` | Per-package import/activation cost signatures, adapter post-settle sequence |
| `fixture/home/` | Isolated throwaway fixture (profile copy under `profiles/desktop-audit` + home-level patch copy) |
