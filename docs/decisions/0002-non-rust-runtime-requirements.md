# ADR 0002 — Non-Rust runtime requirements and each exception

Status: accepted

Companion to [ADR 0001](0001-desktop-architecture.md). The brief requires: *"Inventory any remaining
non-Rust runtime requirements and explain each exception"* and *"Do not claim a fully Rust
implementation if a JavaScript or TypeScript frontend remains."*

**This port is not a fully Rust implementation.** Two large non-Rust runtime components remain in the
product, plus a set of foreign (non-Node, non-Rust) runtimes the product must carry and supervise. This
document names each one, gives the concrete reason, and states what a future Rust replacement would have
to satisfy.

The counts and version numbers below were read from the pinned reference checkout
(`_upstream/`, commit `477b4f420553e8a52c2fbccc464d7561b239c443`) and from the staged runtime payload
(`port/runtime-payload/dsh/`), not inferred.

## Summary of exceptions

| # | Component | Language / runtime | Present at | Why it cannot move to Rust in this port |
|---|---|---|---|---|
| 1 | Web client UI | TypeScript + React 18, in a system webview | run time (webview) | Fidelity requirement: the brief forbids replacing the UI framework and forbids changing rendering. |
| 2 | dsh agent runtime | TypeScript on Node.js, Cordis plugin graph | run time (supervised child process tree) | The Cordis composition *is* the product's behaviour — the agent loop, tool registry, session log, providers, sandbox policy and HMR contract are all plugins. A Rust reimplementation would produce a different product, not a faster one. |

Everything else in the desktop application is Rust: window lifecycle, tray, application menus, native
dialogs, clipboard, external-link handling, persistent settings, OS-backed credential storage,
diagnostics and crash reports, single-instance, quit inspection and confirmation, update presentation
and verification, directory picker, keyboard shortcut arbitration, runtime supervision and clean
shutdown, profile initialisation, and the authenticated application gateway.

## Exception 1 — Web client UI (TypeScript/React)

**What it is.** `apps/web` plus the `packages/client/*` workspace packages (`ui-*`, `store`, `modules`,
`connection`, `locale`, `shortcuts`, `resources`, `primitives`, `slots`, `dockkit`), built by Vite into
a static bundle the shell serves.

**Why it stays.** The brief states: *"Preserve the original frontend framework, components, styles,
fonts, icons, assets, layout, and rendering behavior wherever possible"* and *"Do not replace the UI
framework merely to increase the percentage of Rust."* A React-to-Rust UI rewrite would necessarily
alter layout, animation timing, focus behaviour, selection, scrolling and text rendering — exactly the
fidelity the brief protects. The client also depends on a large, opinionated render machinery
(`ui-renderer` slot system, `client/store` snapshot stores, `ui-slots`) whose observable behaviour *is*
the product's appearance.

**What remains possible.** The client is a pure presentation layer by its own architecture
(`_upstream/packages/client/AGENTS.md`: "The web layer is pure presentation"). Its data layer
(`client/connection`, `api/session-controller`) is transport-agnostic. That is a separate project.

**Licence note.** React 18 (MIT) and the bundled Montserrat brand font (SIL Open Font License —
`packages/client/ui-theme/src/styles/Montserrat-OFL.txt`) both require their licence text to travel with
the redistributed bundle. Upstream's build copies the OFL text to `assets/fonts/Montserrat-OFL.txt`
(`apps/web/vite.config.ts`, `brandFontLicense`); the port preserves that.

A second fidelity constraint lives here and is worth naming: the client is built with upstream's
**official** client build profile (`DSH_CLIENT_BUILD_PROFILE=official`, plus title, version and commit
hash). Without it, `ui-brand-official` does not register and the shell falls back to the generic mark
and the `brand.localBuild` label — a cosmetic difference that is nonetheless a visible divergence from
the released product.

## Exception 2 — dsh agent runtime (TypeScript/Node.js)

**What it is.** The Cordis plugin tree that composes the running `dsh`: model adapters, tool registry
and execution pipeline, the session log and its versioned format and migrations, shell/PTY execution,
filesystem and Git providers, LSP, MCP, skills, subagents, jobs, workflows, schedules, goals, plans,
todos, web search/fetch, computer-use, browser-use, PTC runtime, sandboxing, approval policy, settings,
credentials, persistence, session query, compaction, telemetry, and the agent loop itself.

**Why it stays.**

1. **Coupling, not merely volume.** Upstream's architecture is explicitly *"everything is a plugin"*,
   and the agent loop is itself replaceable from configuration (`_upstream/docs/architecture.md`).
   Behaviour is produced by the *composition*, not by any single module. Reimplementing modules in Rust
   without reimplementing the Cordis composition, effect unwinding, waterfall semantics and HMR contract
   would produce a different product.
2. **Native and foreign runtime dependencies that are themselves required for parity.** Node-PTY ConPTY
   terminals, the LibreOffice conversion engine, the bundled CPython distribution with its Office
   document libraries, and the FFI used for Windows atomic file publication are not Rust components and
   are consumed through Node APIs. See the table below.
3. **Durable formats.** The session log is a durable, versioned, generation-published format with an
   adjacent migration chain (`_upstream/docs/session-format-status.md`,
   `_upstream/docs/persistence-changes/`). A Rust rewrite must reproduce byte-level publication
   semantics (`MoveFileExW` write-through on Windows) and the exact event vocabulary. A mistake here
   corrupts user data.
4. **Model-visible ⟺ logged invariant.** *"Anything that reaches a model request must be reconstructable
   from the session log"* (`_upstream/AGENTS.md`). This is a data-integrity invariant, and a rewrite must
   prove it before it may replace the original.

**What the Rust core takes over anyway.** Process lifetime and orchestration: the Rust supervisor owns
spawning, health, the lifecycle control channel, quit inspection, update-task inspection, tree
containment and clean shutdown, and the Rust core creates and maintains the desktop profile the Host
boots. This is the "application orchestration into Rust" the brief asks for, and it is the layer that was
previously JavaScript (`apps/desktop/src/host-process.ts`, `apps/desktop-host/src/index.ts`).

The transport changed shape deliberately: upstream speaks Node `process.send` IPC on fd 3, which a Rust
parent does not have. The port's adapter (`port/src-tauri/runtime/adapter.mjs`) rides the identical
Desktop-Host lifecycle protocol (generation 4, FIFO JSON) over a newline-delimited JSON duplex socket.
Message names, fields, direction, ordering and failure behaviour are unchanged; only the transport is.

**What a future Rust replacement would have to satisfy.** (a) reproduce the Cordis composition and
effect semantics or provide an explicit profile translation; (b) reproduce `SESSION_FORMAT_VERSION` and
every released migration; (c) pass the keyless recorded-session snapshot suite
(`pnpm run test:snapshot`) and the Python/TypeScript SDK expected outputs; (d) pass the real-API e2e
suite against every provider.

## Remaining non-Node runtime requirements

These are neither Rust nor JavaScript. Each is a foreign runtime the port must still carry and supervise.
Versions are the ones resolved into the staged payload at the pinned revision.

| Requirement | Technology | Runtime role | Port treatment |
|---|---|---|---|
| Persistent terminal sessions | `node-pty` 1.2.0-beta.15 (native addon; ConPTY on Windows) | `ctx.terminals` backend for persistent PTY execution (`_upstream/docs/subsystems/terminal.md`) | Carried in the supervised runtime. Rust owns the process tree that contains it; the PTY itself stays in the runtime. |
| Windows atomic publication | `koffi` (FFI; upstream pins `^3.1.0`, payload resolves 3.3.1) | `MoveFileExW` with write-through for JSONL durability | Carried in the supervised runtime. Rust does not reimplement the session writer. |
| Office document conversion | `@deepseek-ai/libreoffice-kit` 0.1.2 (native engine or WASM) | `render_document` / Office→PDF (`_upstream/docs/subsystems/office-to-pdf.md`) | Carried as a prepared runtime payload; Rust does not shell out to it. The composition is mounted by the Node adapter, not by Rust. |
| Bundled scripting runtime | CPython with numpy, pandas, python-docx, python-pptx, openpyxl, Pillow, lxml, XlsxWriter | `load_workspace_dependencies` and the `office-*` skills | Carried as a prepared payload. |
| Process confinement | `@deepseek-ai/node-addon-system` 0.1.2 (Landlock launcher) | `ctx.sandbox` backend (`_upstream/docs/subsystems/sandbox.md`) | Linux-only upstream. On Windows the upstream sandbox backend is `sandbox-windows-acl`. Carried in the runtime. |
| Text search | ripgrep executable, via `@vscode/ripgrep` (`packages/fs/tool-fs-search`) | The model-facing `glob` and `grep` tools | Carried as a runtime binary; Rust resolves and does not substitute it. There is no tool named `search`. |
| Bundled package manager | `pnpm` 11.7.0 | Plugin installation/repair through the Web Plugin Manager | Carried as a prepared payload; matches upstream's `packageManager` pin. |
| Image processing | `sharp` 0.35.x (native; upstream pins `^0.35.3`) | Icon/tray rendering at build time; image handling at run time | Build-time for the port's icon pipeline; run-time inside the runtime. |

## Build-time non-Rust toolchain

These produce the deliverable but are not part of the shipped runtime.

| Tool | Role | Why not Rust |
|---|---|---|
| `pnpm` 11.7.0 + Node (22.20.0 pinned for the shipped payload; the reference machine builds on 25.4.0) | Builds the preserved web client and stages the supervised runtime from the pinned upstream lockfile | Reproducing the upstream build is required for fidelity; a different bundler would change chunking, hashing and code-splitting behaviour. |
| Vite 6 | Bundles the web client | Upstream's build entry. |
| TypeScript 6 | Type-checks and emits the client and runtime | Upstream toolchain. |
| `@tauri-apps/cli` / `tauri-bundler` | Drives the NSIS installer build | Rust-adjacent; invoked from `port/scripts/build.ps1`. |
| NSIS 3.11 | Compiles the installer | The bundler's Windows target. Supplied by `tauri-bundler`. |
| PowerShell 5.1 | Runs `build.ps1`, the packaging suites and the installer's build-time guards | The build host's shell. The port does not depend on `pwsh`. |

## Honest statement of Rust coverage

Measured against the desktop application's own layers, the Rust workspace implements the complete
desktop shell and application core (window lifecycle, menus, tray, dialogs, clipboard, external links,
settings, credentials, diagnostics, crash reports, single-instance, quit model, shortcut arbitration,
update presentation and verification, directory picker, profile initialisation), the complete runtime
supervision and process lifecycle layer, and the authenticated application gateway. Those are compiled
and locally tested — `cargo build --workspace`, `cargo test --workspace` and
`cargo clippy --workspace --all-targets -- -D warnings` are the `core` stage of
`port/scripts/build.ps1`.

It does **not** implement the user interface or the agent runtime. Those are the two exceptions above,
and any claim of a "fully Rust implementation" would be false — in any state of completion.

Two things this statement is deliberately *not* evidence for:

- **Native qualification.** Compiling and passing local tests is not installed, clean-machine
  acceptance. See [`implementation-plan.md`](implementation-plan.md) §Milestone 5.
- **Erasure of the exceptions.** The foreign runtimes above are carried *by* the Node runtime. Every one
  of them remains a non-Rust dependency of the shipped product.
