# ADR 0002 — Non-Rust runtime requirements and each exception

Status: accepted

Companion to [ADR 0001](0001-desktop-architecture.md). The brief requires: *"Inventory any remaining non-Rust runtime requirements and explain each exception"* and *"Do not claim a fully Rust implementation if a JavaScript or TypeScript frontend remains."*

**This port is not a fully Rust implementation.** Two large non-Rust runtime components remain. This document names every one, gives the concrete reason, and states what a future Rust replacement would have to satisfy.

## Summary of exceptions

| # | Component | Language / runtime | Present at | Why it cannot move to Rust in this port |
|---|---|---|---|---|
| 1 | Web client UI | TypeScript + React 18, in a system webview | run time (webview) | Fidelity requirement: the brief forbids replacing the UI framework and forbids changing rendering. |
| 2 | dsh agent runtime | TypeScript on Node.js, Cordis plugin graph | run time (supervised child process tree) | 55 workspace package groups, 335 workspace projects, a Python runtime and six native addon families implement the agent, tools, session log and providers. Rewriting them changes behaviour, not just implementation language. |

Everything else in the desktop application is Rust: window lifecycle, tray, application menus, native dialogs, clipboard, external-link handling, persistent settings, OS-backed credential storage, diagnostics and crash reports, single-instance, quit inspection and confirmation, update presentation, directory picker, keyboard shortcut arbitration, runtime supervision and clean shutdown, and the authenticated application gateway.

## Exception 1 — Web client UI (TypeScript/React)

**What it is.** `apps/web` plus roughly 60 workspace packages under `packages/client/*` (`ui-*`, `store`, `modules`, `connection`, `locale`, `shortcuts`, `resources`, `primitives`, `slots`, `dockkit`), built by Vite into a static bundle the shell serves.

**Why it stays.** The brief states: *"Preserve the original frontend framework, components, styles, fonts, icons, assets, layout, and rendering behavior wherever possible"* and *"Do not replace the UI framework merely to increase the percentage of Rust."* A React-to-Rust UI rewrite would necessarily alter layout, animation timing, focus behaviour, selection, scrolling and text rendering. That is exactly the fidelity the brief protects. The client also depends on a large, opinionated render machinery (`ui-renderer` slot system, `client/store` snapshot stores, `ui-slots`) whose observable behaviour is the product's appearance.

**What remains possible.** The client is a pure presentation layer by its own architecture (`_upstream/packages/client/AGENTS.md`: "The web layer is pure presentation"). Its data layer (`client/connection`, `api/session-controller`) is already transport-agnostic and could be rehosted. That is a separate project.

**Licence note.** React 18 (MIT) and the bundled Montserrat brand font (SIL Open Font License — `packages/client/ui-theme/src/styles/Montserrat-OFL.txt`) both require their licence text to travel with the redistributed bundle. The build copies the OFL text to `assets/fonts/Montserrat-OFL.txt` (`apps/web/vite.config.ts`, `brandFontLicense`). The port preserves that.

## Exception 2 — dsh agent runtime (TypeScript/Node.js)

**What it is.** The Cordis plugin tree that composes the running `dsh`: model adapters, tool registry and execution pipeline, the session log and its v0..v4 format and migrations, shell/PTY execution, filesystem and Git providers, LSP, MCP, skills, subagents, jobs, workflows, schedules, goals, plans, todos, web search/fetch, computer-use, browser-use, PTC runtime, sandboxing, approval policy, settings, credentials, persistence, session query, compaction, telemetry, and the agent loop itself.

**Why it stays.**

1. **Volume and coupling.** The upstream tree is 13,850 files across 335 workspace projects with an explicit *"everything is a plugin"* architecture in which the agent loop is itself replaceable from configuration (`_upstream/docs/architecture.md`). Behaviour is produced by the *composition*, not by any single module. Reimplementing modules in Rust without reimplementing the Cordis composition, effect unwinding, waterfall semantics and HMR contract would produce a different product.
2. **Native and foreign runtime dependencies that are themselves required for parity.** See the table below. Node-PTY ConPTY terminals, the LibreOffice conversion engine, the bundled CPython distribution with its Office document libraries, and the FFI used for Windows atomic file publication are not Rust components and are consumed through Node APIs.
3. **Durable formats.** The session log is a durable, versioned, generation-published format with an adjacent migration chain (`_upstream/docs/session-format-status.md`, `_upstream/docs/persistence-changes/`). A Rust rewrite must reproduce byte-level publication semantics (`MoveFileExW` write-through on Windows) and the exact event vocabulary. A mistake here corrupts user data.
4. **Model-visible ⟺ logged invariant.** *"Anything that reaches a model request must be reconstructable from the session log"* (`_upstream/AGENTS.md`). This is a data-integrity invariant, and a rewrite must prove it before it may replace the original.

**What the Rust core takes over anyway.** Process lifetime and orchestration: the Rust supervisor owns spawning, health, the lifecycle control channel, quit inspection, update-task inspection, tree containment and clean shutdown. This is the "application orchestration into Rust" the brief asks for, and it is the layer that was previously JavaScript (`apps/desktop/src/host-process.ts`, `apps/desktop-host/src/index.ts`).

**What a future Rust replacement would have to satisfy.** (a) reproduce the Cordis composition and effect semantics or provide an explicit profile translation; (b) reproduce `SESSION_FORMAT_VERSION` and every released migration; (c) pass the keyless recorded-session snapshot suite (`pnpm run test:snapshot`) and the Python/TypeScript SDK expected outputs; (d) pass the real-API e2e suite against every provider.

## Remaining non-Node runtime requirements

These are not Rust and not JavaScript. Each is a foreign runtime the port must still carry and supervise.

| Requirement | Technology | Runtime role | Port treatment |
|---|---|---|---|
| Persistent terminal sessions | `node-pty` 1.2.0-beta.15 (native addon, ConPTY on Windows) | `ctx.terminals` backend for persistent PTY execution (`_upstream/docs/subsystems/terminal.md`) | Carried in the supervised runtime. Rust owns the process tree that contains it; the PTY itself stays in the runtime. |
| Windows atomic publication | `koffi` (FFI) | `MoveFileExW` with write-through for JSONL durability | Carried in the supervised runtime. Rust does not reimplement the session writer. |
| Office document conversion | `@deepseek-ai/libreoffice-kit` 0.1.1 (native engine or WASM) | `render_document` / Office→PDF (`_upstream/docs/subsystems/office-to-pdf.md`) | Carried as a prepared runtime payload; Rust does not shell out to it. |
| Bundled scripting runtime | CPython with numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, XlsxWriter | `load_workspace_dependencies` and the `office-*` skills | Carried as a prepared payload installed under `$DSH_HOME/dsh-runtimes/dsh-primary-runtime`. |
| Process confinement | `@deepseek-ai/node-addon-system` (Landlock launcher) | `ctx.sandbox` backend (`_upstream/docs/subsystems/sandbox.md`) | Linux-only upstream. On Windows the upstream sandbox backend is `sandbox-windows-acl`. Carried in the runtime. |
| Text search | ripgrep executable | `search` tool | Carried as a runtime binary; Rust resolves and does not substitute it. |
| Bundled package manager | `pnpm` 11.7.0 | Plugin installation/repair through the Web Plugin Manager | Carried as a prepared payload. |
| Image processing | `sharp` 0.35 (native) | Icon/tray rendering at build time; image handling at run time | Build-time for the port's icon pipeline; run-time inside the runtime. |

## Build-time non-Rust toolchain

These produce the deliverable but are not part of the shipped runtime.

| Tool | Role | Why not Rust |
|---|---|---|
| `pnpm` 11.7.0 + Node 22/24/25 | Builds the preserved web client and the supervised runtime from the pinned upstream lockfile | Reproducing the upstream build is required for fidelity; a different bundler would change chunking, hashing and code-splitting behaviour. |
| Vite 6 | Bundles the web client | Upstream's build entry. |
| TypeScript 6 | Type-checks and emits the client and runtime | Upstream toolchain. |
| `@tauri-apps/cli` | Drives `tauri-bundler` for the NSIS installer | Rust-adjacent; invoked from the build script. |

## Honest statement of Rust coverage

**Implementation status of this statement — read it with the paragraph below.** This section states the *accepted design and its target responsibility split*. At the time of the independent adversarial review (finding R-01) the Rust workspace held `dsh-core` and `dsh-runtime` only: `app/src/lib.rs` was an 87-byte placeholder, `dsh-gateway/src/lib.rs` was 102 bytes, and there were **zero** `#[tauri::command]` handlers anywhere in `port/src-tauri`. Read the list below as **specified, not implemented**, and consult `verification-report.md` §4 for actual `cargo build` / `cargo test` status. Nothing here is evidence that a capability ships.

Measured against the desktop application's own layers, the design places the complete desktop shell and application core in Rust (window lifecycle, menus, tray, dialogs, clipboard, external links, settings, credentials, diagnostics, crash reports, single-instance, quit model, shortcut arbitration, update presentation, directory picker), the complete runtime supervision and process lifecycle layer in Rust, and the authenticated application gateway in Rust.

It does **not** implement the user interface or the agent runtime. Those are the two exceptions above, and any claim of a "fully Rust implementation" would be false — in any state of completion.
