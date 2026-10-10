# Parity matrix — original behaviour → desktop implementation

Statuses use exactly the vocabulary required for this port:

| Status | Meaning |
|---|---|
| `not inspected` | Original behaviour not yet established from source or observation. |
| `specified` | Original behaviour established and the desktop implementation is specified in a binding contract. |
| `implemented` | Desktop code exists and compiles/tests pass, but is not yet compared to the original. |
| `verified` | Compared against the original with matched fixtures, viewport, theme and state. Evidence cited. |
| `blocked` | Cannot be completed in this environment. Reason and owner cited. Never treated as verified. |

Rule enforced throughout: **an unavailable reference behaviour is never marked `verified`**, and `blocked` rows are excluded from any completion claim.

Evidence roots: `docs/analysis/` (reverse-engineering), `docs/contracts/` (binding interfaces), `docs/evidence/` (captures), `docs/verification-report.md` (test results).

Upstream reference: commit `477b4f420553e8a52c2fbccc464d7561b239c443`, version `0.1.7-rc.2`.

## Summary

| Status | Rows |
|---|---|
| `verified` | none yet — `docs/verification-report.md` §4 records per-check results and its §2 records observed reference behaviour |
| `implemented` | — |
| `specified` | — |
| `blocked` | — |
| `not inspected` | — |

Detailed per-domain counts are maintained in the [verification report](<verification-report.md>) so this table and the report cannot drift.

Current qualification distinguishes evidence planes: an actual pinned scratch payload is now sealed, its packaged Node/adapter Host gate passes 9 tests, and its advertised Updates JavaScript resource is served with the correct entry revision and MIME. The [sealed-artifact report](<../port/.scratch/integration-review-20261001/adapter-launch-67CffV/report.json>) verifies the unchanged seal before/after Host execution. This is **not native UI activation or matched product parity** and does not promote the matrix rows to `verified`; strict desktop lint and native composition/acceptance remain open.

### Inventory coverage behind these rows

The route, screen, dialog and application-state inventories this matrix draws on are enumerated in [`analysis/ui-inventory.md`](analysis/ui-inventory.md) §10, which is the flat parity checklist:

| Inventory | Count | Source |
|---|---|---|
| User-visible screens | 19 (`SC-01`…`SC-19`) | `ui-inventory.md` §1, §10 |
| Dialogs and overlays | 53 (`DL-01`…`DL-53`) | `ui-inventory.md` §2, §10 |
| Application state surfaces | conversation nodes (16 kinds), ~55 tool-card renderers, todo/plan/goal/jobs/subagent/schedule/deliverable/attachment/approval/workspace/terminal/browser/preview/model/skill/plugin/trajectory | `ui-inventory.md` §3 |
| Keyboard bindings | 29 application bindings (18 configurable + 11 fixed) + 8 desktop-native accelerator groups | `ui-inventory.md` §6 |
| Features catalogued | 109 rows (90 `verified-in-source`, 12 `credential-dependent`, 4 `documented-only`, 3 `not-determined`) plus a 14-row UNAVAILABLE appendix. **`analysis/feature-inventory.md`'s own Summary section is authoritative** — an earlier version of this table reported 128 and was wrong (finding R-04). | `analysis/feature-inventory.md` |
| Screens + dialogs in the flat checklist | 72 numbered entries | `ui-inventory.md` §10 |

Notable routing finding: the client has **no URL router** (no hash/history/popstate). "Routing" is the `verify-client-route-resolution` HTTP gate plus Conversation-View selection, root panel selection (`ctx.layout.selectPanel`) and right-sidebar tab addressing over `dsh-resource://`. A port that introduced a URL router would change behaviour.

## 0. Desktop shell and application lifecycle

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| S1 | Close hides the window; page and Host keep running; next show presents the same document with session, drafts and scroll position (`apps/desktop/README.md` §Closing) | Rust `app` window lifecycle: hide on close, never reload the webview | `specified` |
| S2 | Windows asks for acknowledgement before the first hide; `background-close-confirmed` marker under userData; Escape/dismissal/failure keeps the window visible (`apps/desktop/README.md`) | Rust `app` + `dsh-core::settings` marker | `specified` |
| S3 | Windows keeps a tray icon the whole run; tooltip = product name; single click shows+focuses; context menu Open / Quit, localized (`apps/desktop/src/tray.ts`) | Tauri tray icon with the same menu and behaviour | `specified` |
| S4 | Quit asks the Host what it would be interrupted; nothing → quit silently; otherwise native message box "Quit DeepSeek Harness?" with one of three localized explanations (`apps/desktop/src/quit-confirmation.ts`, `apps/desktop-host/src/quit-inspection.ts`) | `dsh-core::quit` decision table + `dsh-runtime` `quit-inspection` request over the control channel | `specified` |
| S5 | Fail-closed quit: inspection failure or a 2 s deadline miss is treated as running tasks; concurrent quit requests join the open dialog (`apps/desktop/README.md`) | same | `specified` |
| S6 | Quit skip rules: installer restart, fatal-recovery exit/restart, dev Restart, OS shutdown/restart/logoff (`apps/desktop/README.md`) | same | `specified` |
| S7 | Single-instance lock acquired before any profile access; second launch focuses the existing window (`apps/desktop/src/single-instance.ts`) | `dsh-core::single_instance` (named mutex on Windows, flock on Unix) | `specified` |
| S8 | Application menu: About (native About panel with icon, product name, installed version), Check for Updates, Exit; Edit undo/redo/cut/copy/paste/delete/select-all routed to the focused editor (`apps/desktop/README.md`) | Tauri menu with the same commands and routing via `shell_menu_action` | `specified` |
| S9 | macOS menu: Hide / Hide Others / Show All / Quit with localized labels and product name; standard Window menu with Minimize (⌘M) and Hide (⌘H) | Tauri macOS menu template | `specified` |
| S10 | DevTools: F12 (Fn+F12), ⌘⌥I on macOS, Ctrl+Shift+I on Windows, also in packaged builds; disabled in update overlays and embedded guests | Tauri devtools toggle + the documented exclusions | `specified` |
| S11 | Fatal failure opens one native recovery dialog per process with a bounded error tail (≤1200 UTF-16 units, 8 diagnostic lines, plus the crash-report path) offering Exit / Restart / Disable third-party plugins, back up profile patch, and restart; `EADDRINUSE` variant offers Exit / Restart only | Rust `app` recovery dialog + `dsh-core::diagnostics` | `specified` |
| S12 | Crash report `crash-<UTC>-<source>.log` in the platform logs directory with source ∈ {host, web-boot, renderer, main}, ready flag, versions, error + cause chain cut at 256 KiB, host inspected error ≤64 KiB, window console errors ≤64 KiB; owner-only; retain newest 10 (`apps/desktop/src/crash-report.ts`) | `dsh-core::diagnostics::crash_report` | `specified` |
| S13 | Host stderr retention capped at the last 64 Ki characters (`apps/desktop/README.md`) | `dsh-runtime` bounded stderr tail | `specified` |
| S14 | Native directory picker owned by the shell, attached to the window (restore/show/focus first); concurrent requests share one dialog; cancellation returns no path and stays retryable (`apps/desktop/src/directory-picker.ts`) | `shell_pick_directory` | `specified` |
| S15 | Windows 40-DIP caption with native controls whose colours sync from the application palette; localized Application and Edit popup menus mounted only after the shell overlay seat publishes | **Not ported** — window chrome is the least portable shell surface. The functional commands remain reachable from the application menu (S8). | `blocked` (limitations B5) |
| S16 | Keyboard: complete accepted bindings intercepted before main-document, embedded-frame and browser-guest input; recording and IME composition protected; two-key chords leave the first key's press available; overlay openings invalidate pending chord state (`apps/desktop/src/keyboard.ts`) | Rust `app` shortcut arbitration | `specified` |
| S17 | Shortcut overrides stored in `userData/keybindings.json`, separately from `DSH_HOME`; validated and serialized before publishing; failed reads retain last accepted bindings and block edits (`apps/desktop/src/keybindings.ts`) | `dsh-core::settings` keybinding store | `specified` |
| S18 | External-link handling: only safe schemes opened outside the application | `shell_open_external` with scheme allowlist | `specified` |
| S19 | Clipboard read/write; copy feedback resets after two seconds (`apps/desktop/README.md`) | `shell_clipboard_read` / `shell_clipboard_write` | `specified` |
| S20 | Welcome window (600×700) with entry, sign-in status and API-key pages; Montserrat Light; platform material (macOS vibrancy / Windows acrylic, 40% white light, 50% rgb(24 25 28) dark); Reduce Motion disables transitions (`apps/desktop/README.md`) | Not ported in this pass — see Limitations | `blocked` |
| S21 | Update presentation: product documents receive the Desktop marker and update presentation and an action opening native confirmation; they cannot choose artifacts or authorise installation (`apps/desktop/src/update-presentation.ts`) | `update_status` / `update_open` + `dsh://update/state` | `specified` |
| S22 | Embedded Platform documents in a partition-keyed `WebContentsView` with per-account storage, cleanup-on-open and cleanup-on-close (`apps/desktop/src/platform-view.ts`) | Not ported — requires an embeddable browser guest view; see Limitations | `blocked` |
| S23 | `<webview>` browser guests with main-issued lease and partition; sandbox/context-isolation kept; Browser IPC only for the application document (`apps/desktop/src/browser-guests.ts`) | Not ported — Tauri has no `<webview>` guest surface; see Limitations | `blocked` |
| S24 | Microphone access restricted to audio requests from the primary `dsh-app://app` frame; macOS system authorization + usage description (`apps/desktop/src/microphone-permissions.ts`) | Permission scoping via Tauri capabilities | `specified` |

## 1. Model providers and LLM streaming

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| L1 | Provider adapters registered on `ctx.llm`; DeepSeek wire extensions; OpenAI-compatible and `pi-ai` provider configuration (`docs/subsystems/llm-streaming.md`, `docs/user/guide/providers.md`) | Preserved in the supervised upstream runtime; unchanged semantics | `specified` |
| L2 | Streaming: `llm/stream` waterfall → `agent/assistant-stream` start/chunk*/end frames driving live UI incrementality (`docs/architecture.md` §Turn flow) | Preserved; delivered over the proxied WebSocket channel | `specified` |
| L3 | Retries and cancellation: prepared calls, live cancellation, freeze evidence for frozen identities; cancellation during async phases commits neither system nor users (`docs/architecture.md`) | Preserved unchanged | `specified` |
| L4 | Model selection and model catalog with reasoning-effort levels | Preserved unchanged (observed: `DeepSeek-V41-Flash` / `High`) | `specified` |
| L5 | API-key capture: the desktop checks configured model API-key references after the Host starts and before opening the workspace; Save and continue writes through the credential service (`apps/desktop/README.md`) | `credential_store` writes to the OS-backed store | `specified` |
| L6 | Real model calls | Requires `DEEPSEEK_API_KEY` or a configured provider credential | `blocked` |

## 2. Agent loop, sessions and conversation

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| A1 | Turn/step semantics: `turn/start` … `step/start` … tool pipeline … `step/end` … `turn/end` (`docs/architecture.md`) | Preserved unchanged | `specified` |
| A2 | Session log is the source of model context; `deriveMessages()` projects history (`docs/architecture.md` §Session log) | Preserved unchanged | `specified` |
| A3 | Session format v0..v4 generations, generation selection, adjacent migration chain, exclusive publication of the version-named successor (`docs/session-format-status.md`, `docs/persistence-changes/`) | Preserved unchanged (deliberately not reimplemented — see ADR 0002) | `specified` |
| A4 | Resume, fork at a turn boundary, session titles via `ctx.sessionTitle` | Preserved unchanged | `specified` |
| A5 | Compaction of context (`docs/subsystems/compaction.md`) | Preserved unchanged | `specified` |
| A6 | Conversation node rendering: one `ConversationNodeDefinition` per feature with a keyed renderer; tool cards derive in the client from raw call/result events (`docs/subsystems/conversation.md`) | Preserved unchanged (original React client) | `specified` |
| A7 | Streaming assistant chunks rendered incrementally in the transcript | Preserved unchanged over the proxied WebSocket | `specified` |
| A8 | Session query / search / export (`docs/subsystems/session-query.md`) | Preserved unchanged | `specified` |
| A9 | Interrupted-tail repair of unsealed session logs on open | Preserved unchanged | `specified` |
| A10 | Live conversation against a real model | Requires provider credentials | `blocked` |

## 3. Tools and capabilities

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| T1 | Scoped tool registry and guarded execution pipeline; schemas join prompt assembly (`docs/tool-catalog.md`, `docs/subsystems/tools.md`) | Preserved unchanged | `specified` |
| T2 | Filesystem access and policy via `ctx.fs` providers | Preserved unchanged | `specified` |
| T3 | Shell command execution via `ctx.shell` backends spawning through `ctx.subprocess` | Preserved unchanged | `specified` |
| T4 | Persistent terminal/PTY sessions (ConPTY on Windows) with wait-reason semantics (`docs/subsystems/terminal.md`) | Preserved unchanged inside the supervised runtime | `specified` |
| T5 | Git, edits and diffs (workspace-change surfaces) | Preserved unchanged | `specified` |
| T6 | Subagents and experimental Agent Teams (`docs/subsystems/subagent.md`, `agent-team.md`) | Preserved unchanged | `specified` |
| T7 | Background jobs (`job_*`), workflows, schedules, goals, plans, todos | Preserved unchanged | `specified` |
| T8 | Web search and fetch tools (`docs/subsystems/web.md`) | Preserved unchanged | `blocked` (network/provider-dependent) |
| T9 | MCP external tools (`docs/subsystems/mcp.md`) | Preserved unchanged | `specified` |
| T10 | LSP integration (`docs/subsystems/lsp.md`) | Preserved unchanged | `specified` |
| T11 | Skills, including the `office-*` skills over the bundled Python libraries | Preserved unchanged | `specified` |
| T12 | Attachments and deliverables; image offload | Preserved unchanged | `specified` |
| T13 | Office document conversion via LibreOffice kit | Preserved unchanged; requires the prepared runtime payload | `blocked` (payload assembly is cross-target) |
| T14 | Computer-use / browser-use | Preserved unchanged | `blocked` (external driver credentials) |
| T15 | Tool UI presentation: each tool's card derives from raw events and persisted result metadata; unknown data falls back to the generic form (`docs/cookbook/adding-a-tool.md`) | Preserved unchanged (original React client) | `specified` |

## 4. Human interaction

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| H1 | Approvals and permission presets (`docs/subsystems/approval.md`, `permission-presets.md`) | Preserved unchanged | `specified` |
| H2 | Permission-mode control in the composer (observed: `Workspace Write`) | Preserved unchanged | `specified` |
| H3 | User questions (`docs/subsystems/user-questions.md`) | Preserved unchanged | `specified` |
| H4 | Human commands / slash commands (`docs/subsystems/commands.md`) | Preserved unchanged | `specified` |
| H5 | Message feedback | Preserved unchanged | `specified` |
| H6 | First-run **Internal Testing Notice** modal, blocking all other input | Preserved unchanged | `specified` |

## 5. Configuration and settings

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| C1 | Settings subsystem and config catalog (`docs/subsystems/settings.md`, `docs/config-catalog.md`) | Preserved unchanged for Harness-owned settings | `specified` |
| C2 | Desktop-owned preferences (theme, locale preference, shortcut overrides, close-acknowledgement markers) | Rust `dsh-core::settings`, versioned + atomic | `specified` |
| C3 | Profiles and bundles composition; `dsh --profile web --dump-config` (`docs/architecture.md`) | Preserved unchanged | `specified` |
| C4 | Plugin Manager install/activation/restart via bundled pnpm (`packages/boot/plugin-manager/README.md`) | Preserved unchanged | `specified` |
| C5 | Locale selection: explicit en/zh wins; otherwise first supported OS language; fallback English; automatic selection writes no preference (`apps/desktop/README.md`) | `shell_locale_get` / `shell_locale_set` | `specified` |

## 6. Persistence and recovery

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| P1 | `$DSH_HOME` layout: sessions, storages, logs, cache, attachments, profiles (`apps/desktop/src/paths.ts`) | `dsh-core::paths` mirrors it exactly | `specified` |
| P2 | Desktop exclusively owns `$DSH_HOME/profiles/desktop` and its package-manager state under a single-instance lock (`apps/desktop/README.md` §State ownership) | `dsh-core::single_instance` + `dsh-core::paths` | `specified` |
| P3 | Restart recovery: sessions, drafts, scroll position survive a hide/show and an application restart | Preserved unchanged + `dsh://shell/window` lets the page hold state | `specified` |
| P4 | Profile recovery: disable third-party bundles and rename `cordis.patch.yml` to `cordis.patch.yml.bak-<timestamp>` without parsing it (`apps/desktop/README.md`) | Rust recovery action | `specified` |
| P5 | Spill files for oversized output (`docs/subsystems/spill.md`) | Preserved unchanged | `specified` |
| P6 | Credentials persist across restart in OS-backed storage | `dsh-core::credentials` | `specified` |

## 7. Security posture

| # | Original behaviour (evidence) | Desktop implementation | Status |
|---|---|---|---|
| X1 | Sandbox rungs: Windows restricted-token + `KILL_ON_JOB_CLOSE` job object, macOS Seatbelt, Linux bwrap then Landlock (`docs/subsystems/sandbox.md`) | Preserved unchanged inside the supervised runtime | `specified` |
| X2 | Credentials kept out of frontend bundles and logs | `dsh-core::credentials` + the "never log a secret" rule; the launch token is never printed by the port | `specified` |
| X3 | Application gateway binds loopback only; LAN is opt-in | `dsh-gateway` | `specified` |
| X4 | Process-tree containment so no child outlives the application | `dsh-runtime::proc_tree` (Job Object / process group) | `specified` |
| X5 | Scoped webview permissions (Tauri capabilities, least privilege) | `app/capabilities/` | `specified` |
| X6 | Product telemetry (`docs/subsystems/product-telemetry.md`) | Preserved unchanged | `specified` |
| X7 | `SAFETY.md` developer-preview notice | Preserved unchanged in-product | `specified` |

## 8. Deliberate differences (not parity losses)

| # | Original | Port | Why | Impact |
|---|---|---|---|---|
| D1 | Desktop-Host lifecycle over Node `process.send` IPC | Same message vocabulary and protocol generation 4 over a local NDJSON control socket | A Rust parent has no Node IPC stack | None observable |
| D2 | Window loads `dsh-app://app/`; Electron forwards application HTTP to the Host | Window loads the Rust gateway's loopback origin; Rust proxies HTTP + WebSocket to the Host | Tauri custom schemes cannot carry WebSocket upgrades, and the streaming channel is a WebSocket | Origin string differs; cookies, RPC and streaming are identical to upstream Web |
| D3 | Electron main preloads install `__DSH_DESKTOP__`, `__DSH_HOST_PATHS__`, `dshDesktopBoot` | Tauri initialization scripts install the same globals | No Electron preload exists | None observable |
| D4 | Electron shell in JavaScript | Rust shell | The port's purpose | None observable |
| D5 | `<webview>` browser guests with a main-issued lease and partition | No guest surface exists in Tauri/WebView2; `browser` returns `DshError::Other { code: "browser_guest_unavailable" }` and Sidebar Browser runs its Web fallback | Platform capability gap | Parity loss S23 / limitations B3. Never a silent no-op. |
| D6 | `webUtils.getPathForFile` resolves a dropped/picked file's real path | `__DSH_HOST_PATHS__.pathFor` resolves paths recorded from native drag-drop/picker events and answers `''` for pasted bytes | No Tauri equivalent of `webUtils` | Matches upstream's observable rule when the global is absent. |
| D7 | Complete chord bindings intercepted **before** document/embedded/guest input via Electron `before-input-event` (rules K4/K6/K7) | Chord arbitration runs page-side — the upstream Linux dispatch path | Tauri exposes no pre-page input interception API | **Measured, per the Rust lane:** **K4 NOT preserved** — interception happens after the key event reaches the document, so editing and terminal input are not protected. **K6 approximated** — the first key's press and release always reach the page and chord completion/repeat consumption is after the fact; the observable guarantee holds for main-document input only (embedded/guest frames are not intercepted, and guests are unavailable anyway). **K7 preserved** — pending-chord invalidation on overlay open/close is page-side state and is fully supported, including two-key `secondCode` chords (schema v2) across all 29 catalog rows. |

## 9. Blocked and unavailable (never counted as complete)

| # | Item | Reason | Owner |
|---|---|---|---|
| B1 | Windows EV code signing, signature cache, PE-signature audit | Needs SafeNet hardware token, PIN and certificate | release engineering |
| B2 | macOS Developer ID signing, hardened runtime, notarization and stapling | Needs Apple credentials and a macOS host | release engineering |
| B3 | Update-feed upload to COS/CDN and feed publication | Needs bucket credentials and network | release engineering |
| B4 | Real model-provider streaming and tool calls | Needs `DEEPSEEK_API_KEY` or a configured provider credential | product QA |
| B5 | Cross-target primary-runtime payload assembly and signed installation | "Cross-target execution and signed installation require the target release host" | release engineering |
| B6 | Interactive and silent Windows installer qualification (`smoke-windows.ps1`) | Needs pinned NSIS/7-Zip plugin tooling and an interactive Windows desktop | release engineering |
| B7 | Welcome window (S20), embedded Platform documents (S22), browser guests (S23) | Require shell surfaces outside the Tauri feature set chosen for this pass | port team |
| B8 | Linux desktop parity | Upstream ships no Linux desktop release ("Linux is not a supported Desktop release target"), so no original exists to compare against | n/a |
