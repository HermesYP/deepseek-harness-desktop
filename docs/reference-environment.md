# Reproducible reference environment and deterministic test data

This document makes the reference measurements in this repository reproducible by someone who did not run them. Every command is the exact command that was executed on the reference machine.

## Reference machine

| Fact | Value |
|---|---|
| OS | Microsoft Windows 11 Home Single Language, 10.0.26200, x64 |
| Rust | rustc 1.97.1 (`8bab26f4f 2026-07-14`), cargo 1.97.1, target `x86_64-pc-windows-msvc` |
| Node | v25.4.0 (inside upstream `engines: ^22.19.0 \|\| >=24.0.0`) |
| Package manager | pnpm 11.7.0 (matches upstream `packageManager: pnpm@11.7.0`) |
| WebView2 Runtime | Microsoft Edge WebView2 Runtime 153.0.4234.48 |
| Browser used for capture | Playwright Chromium, pinned by the reference checkout's `playwright` devDependency |
| Locale / timezone for captures | `en-US` / `Asia/Shanghai` |

## Pinned upstream reference

| Fact | Value |
|---|---|
| Repository | `https://github.com/deepseek-ai/deepseek-harness` |
| Commit | `477b4f420553e8a52c2fbccc464d7561b239c443` |
| Branch / merge subject | `master` / `Merge pull request #5180 from deepseek-harness/rel/dsh-0.1.7-rc.2` |
| Commit date | `2026-09-24T21:39:59+08:00` |
| Root package version | `0.1.7-rc.2` (`_upstream/package.json`) |
| Local checkout | `_upstream/` (kept as a read-only reference; the port never modifies it) |
| License | MIT (`_upstream/LICENSE`), third-party disclosure in `_upstream/THIRD_PARTY_NOTICES.md` |

Verify the pin at any time:

```powershell
cd _upstream
git log -1 --format="%H %aI %s"    # expect 477b4f420553e8a52c2fbccc464d7561b239c443 ...
git status --porcelain             # expect empty before a build
```

## Bringing up the reference application

```powershell
cd _upstream
pnpm install          # 3m33s on the reference machine; 1387 packages, 335 workspace projects
pnpm run build        # tsc + tsdown (host and client) + Vite web build
```

Observed result: `pnpm install` exit 0, `pnpm run build` exit 0. `_upstream/apps/web/dist/` is the built web client and is the artifact the port preserves.

Benign install warnings that are expected and are not failures:

- `native/system/packages/{darwin-arm64,darwin-x64,linux-arm64,linux-x64}` — "Unsupported platform" for the non-host platform packages.
- "There are cyclic workspace dependencies" — a known upstream workspace property.
- "Failed to create bin ... @deepseek-ai/dsh/lib/bin.js.EXE" for `packages/sdk/client`, `apps/desktop-host`, `python/sdk-runtime` — these resolve after `pnpm run build`.

## Running the reference — and the isolation rule

**Always run the reference against a throwaway Harness home.** The `dsh` CLI defaults `DSH_HOME` to `~/.dsh`, which on this machine is the live state of another running agent harness. Running the reference without overriding it writes into that state (see `docs/verification-report.md`, finding F-1).

```powershell
cd _upstream
$env:DSH_HOME = "$PWD\..\port\.scratch\ref-home"        # throwaway; never ~/.dsh
$env:DSH_DESKTOP_USER_DATA_DIR = "$env:DSH_HOME\userdata"
pnpm dsh web --no-open --port 3085                       # 3080 is in use by the live harness
```

The process prints one line carrying the launch token:

```text
dsh web: http://127.0.0.1:3085/?token=<process launch token>
```

That token is a **credential**. It authenticates the whole application. It must never be copied into documentation, screenshots' filenames, commit messages, or logs that are shipped.

### Authentication model observed (matters for the Rust gateway)

Source of truth: `_upstream/packages/client/connection/src/browser-auth.ts`.

- `authenticatedUrl(base)` appends exactly one `token` query parameter holding the process launch token.
- `GET /` with exactly one matching `token` mints an HMAC-signed, **authority-bound** session cookie and answers `303` to `./`.
- A valid cookie lets the caller serve the index; every other request gets the same minimal `401`.
- The signing secret is created by the credential provider and held in memory for the process.

Observed confirmation: an unauthenticated `GET http://127.0.0.1:3085/` returns `401 Unauthorized`.

## Deterministic capture fixtures

The capture harness is `scripts/capture-reference.mjs` (lead-owned). It uses application-content capture through Playwright — never desktop screenshots — at fixed viewports and themes so reference and port are directly comparable.

Constants shared by reference and port captures (`scripts/capture-reference.mjs`):

| Dimension | Values |
|---|---|
| Viewports | `desktop-1280x800` (dsf 1), `desktop-1600x1000` (dsf 1) |
| Themes | `light`, `dark` (via `colorScheme`) |
| Motion | `reducedMotion: 'reduce'` so transition end-states are stable |
| Locale / timezone | `en-US` / `Asia/Shanghai` |
| Interaction steps | 19 fixed steps, ids `00-boot` … `18-shortcut-hint` |

Each step emits `<id>.png`, and each capture writes `trace.json` (per-step DOM facts: title, `lang`, landmark count, installed font faces, a 1500-character text sample, plus any action error) and `dom-snapshot.html`.

Run:

```powershell
node scripts/capture-reference.mjs --url '<authenticated url>' --out docs/evidence/reference
```

Output layout: `docs/evidence/reference/<viewport>/<theme>/<step>.png` plus `trace.json`, `dom-snapshot.html`, and a top-level `index.json` recording `capturedAt`, the base URL **with the token redacted in any derived report**, and per-run console-error counts.

## Reference application state captured

The reference runs from a **fresh, empty Harness home**, so it represents the *first-run* state:

1. `00-boot` — the boot/loading page.
2. `01-onboarding-notice` — the first-run **"Internal Testing Notice"** modal, which is modal and blocks all other input. This is why a naive keyboard-driven capture produces identical frames after boot: the modal swallows the input. Recorded as a real product behaviour, not a capture failure.
3. `02-notice-…` onward — the workspace: left sidebar (brand + version badge, **New Session** `Ctrl+Alt+N`, **Plugins**, **Workspaces** with search/sort/import, the default workspace entry, **Settings** at the foot), the main composer ("Describe what you want to build, / commands, @ files or sessions") with the permission-mode control (**Workspace Write**), the model picker (**DeepSeek-V41-Flash / High**) and the send control, and the right panel toggle.

Title served: `DSH Local Build`. Version badge: `0.1.7-rc.2-477b4f4-dirty` — the `-dirty` suffix is expected because the reference checkout contains build artifacts from `pnpm install` / `pnpm run build`; it is not a defect in the port.

## Deterministic test data for parity runs

`port/fixtures/protocol/*.json` are the canonical JSON fixtures shared by the Rust side (`port/src-tauri/crates/dsh-core/tests/protocol_fixtures.rs`) and the TypeScript side (`port/ui/tests/protocol.spec.ts`). They are the deterministic test data for interface parity: both languages must round-trip the same bytes.

The parity runs compare reference and port with **identical fixtures, viewport sizes, themes and representative states**. Representative states are: first-run onboarding notice, empty session, composer with a draft, permission-mode menu open, model picker open, Plugins page, Settings open, sidebar collapsed/expanded, and the command/slash surface.

## What this environment cannot verify

Not verifiable here and therefore never marked verified: Windows EV code signing and its signature cache; macOS Developer ID signing, notarization and stapling; update-feed upload to COS/CDN; real model-provider calls (need `DEEPSEEK_API_KEY` or equivalent); cross-target runtime assembly and signed installation; the interactive Windows installer tests. See `docs/analysis/platform-support.md` §5 and `docs/parity-matrix.md`.
