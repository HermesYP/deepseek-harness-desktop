# Upstream drift inventory: `0.1.7-rc.2` → `0.2.0-rc.2`

Status: **read-only inventory, no baseline change made.** Nothing in this document has been applied. It
records what changed upstream and what a Rust/Tauri desktop port must touch to move its pinned
baseline, so the move can be made later as one atomic, verified change.

This is a **drift inventory and migration checklist, not a completed rebaseline.** The port still
targets the pinned revision. No parity with `0.2.0-rc.2` is implied anywhere below.

| | Pinned (repository baseline) | Checked newer (inventory subject only) |
|---|---|---|
| Commit | `477b4f420553e8a52c2fbccc464d7561b239c443` | `639ed015397290b3745d163aafe02ffee4aa3f84` |
| Release | `0.1.7-rc.2` | `0.2.0-rc.2` |
| Tag | [`dsh-v0.1.7-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-rc.2) | [`dsh-v0.2.0-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2) |
| Relationship | merge base, ancestor of the target | `ahead_by: 448`, `behind_by: 0` |
| Local checkout | `_upstream/` (read-only, unmodified) | not present locally; read through GitHub raw/API |
| Adopted by the port? | **Yes** — product version, staged payload and preserved client are all `0.1.7-rc.2` | **No.** Nothing consumes this revision. |

### Which revision is which — do not conflate them

`477b4f4…` is the revision the repository **builds and pins**: `port/src-tauri/app/tauri.conf.json`
declares `0.1.7-rc.2`, the staged payload manifest (`port/runtime-payload/dsh/package.json`) depends on
`@deepseek-ai/*` at `0.1.7-rc.2`, and the preserved client shell was built from this checkout.

`639ed015…` is a revision that was **read, not adopted**. It is newer and it is public, but neither fact
makes the port compatible with it, and neither fact establishes that a product built from it behaves
the same way. Semantic parity is never inferred from a tag, a date or a version-string ordering.

### Public upstream position, verified against official sources

Checked on the reference machine through the GitHub API:

- The repository's newest release is `dsh-v0.2.0-rc.2`, published `2026-09-29T09:42:36Z`, marked
  `prerelease: true`, with **no release assets**
  (<https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=10>). Its release notes
  summarise changes since `v0.1.7-rc.2`
  (<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.0-rc.2>).
- `releases/latest` returns **404** (<https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/latest>),
  which is the correct response when every published release is a prerelease. There is therefore **no
  "latest stable" upstream release** to compare against at all.
- The tag list confirms the mapping
  (<https://api.github.com/repos/deepseek-ai/deepseek-harness/tags?per_page=5>):
  `dsh-v0.2.0-rc.2` → `639ed015…`, `dsh-v0.1.7-rc.2` → `477b4f42…`.
- `master` currently points at `639ed015…` and its head commit is the release merge
  `release: dsh@0.2.0-rc.2`, touching only three `package.json` version fields
  (<https://api.github.com/repos/deepseek-ai/deepseek-harness/commits/master?per_page=3>).

**What that does and does not tell us.** It confirms that the checked revision is real, tag-associated
and the newest published one. It says nothing about API, protocol, session-format or behavioural
compatibility between the two, and nothing here should be read as such a claim. The only
compatibility statements in this document are the per-file verdicts in §3 and §4, each of which rests on
a full read of both sides.

## 1. Method, and how complete each comparison is

The local `_upstream` checkout stays at the pinned commit and was never fetched, modified or cleaned.
Target-side facts come from GitHub's raw file and contents API. **Several reads were truncated by the
fetch tool, so this inventory distinguishes full from partial coverage per item — it is not a complete
change list for all 448 commits.**

Throughout, **"target" means the checked newer revision `639ed015…`** — the inventory subject. It is
never a statement that the port targets it. The port targets `477b4f4…`.

Sources actually read:

| # | Source | Coverage |
|---|---|---|
| S1 | `api.github.com/.../compare/477b4f4...639ed015` (page 1) | Commit list **truncated in transit**; `status: ahead`, `ahead_by: 448`, `behind_by: 0` read complete. The `files` array was **not** reached. |
| S2 | `github.com/.../compare/477b4f4...639ed015.diff` | **Truncated mid-file.** Only the first 34 file blocks were captured, all under `.agents/notes/**` (documentation). **No source file beyond `.agents/` was seen in this diff.** |
| S3 | `api.github.com/.../commits?sha=639ed015&per_page=100&page=1` | **Truncated in transit.** 54 distinct commit subjects extracted. Because of merge topology this skews to the **newest** commits, not a uniform 100. |
| S4 | `raw.githubusercontent.com/.../639ed015/<path>` for specific files | **Complete**, per file. Used for the load-bearing verdicts in §4. |
| S5 | `api.github.com/.../contents/apps/desktop/src?ref=639ed015` | **Complete** file list for that directory (65 entries). |
| S6 | Local `_upstream` at the pinned commit | **Complete** for the three trees compared. |

S6 was compared against S5 as a set difference; the pinned *content* of the files that matter was read
locally in full. S2's truncation is why §3 is a curated, verified table rather than a full file list:
a claim appears there only when a specific read supports it.

## 2. Commit subjects observed (54 of 448)

Extracted from S3. Grouped by the area they touch, using the subjects as written upstream. **This is a
sample weighted toward the newest commits, not a full subject list.**

- **Windows / sandbox (11):** `fix(sandbox): repair inherited ACL entries within normalized roots`,
  `fix(sandbox-windows-acl): request the diagnosis escalation after a denial`,
  `fix(windows): classify after the subtree scan and surface report failures`,
  `fix(windows): close the remaining ACL review findings`,
  `fix(windows): diagnose and repair ACL failures in one run`,
  `fix(windows): keep Explorer path-opening windows visible`,
  `fix(windows): keep the ACL report readable after truncation`,
  `fix(windows): tighten the single-run repair against review findings`,
  `fix(windows): verify ACL repairs against the object's own entries`, plus four `docs(windows):…`.
- **Web / client UI (10):** `perf(client): reduce long-session rendering and whale animation overhead`,
  `perf(web): inline whale image into CSS at build time`,
  `fix(client): make Office and PDF text selections visible in both themes`,
  `fix(web): align plugin guidance with review feedback`, `fix(web): clarify coding view settings copy`,
  `fix(web): preserve whale accessibility and update animation tests`,
  `refactor(web): trim unrelated changes from Safari recovery fix`, plus `docs(web)`/`test(web)`.
- **Desktop (3):** `refactor(desktop): make CLI registration a post-install menu action`,
  `refactor(native-command): require explicit window visibility`,
  `fix(telemetry): align desktop product reporting timeouts`.
- **Schema / persistence (1, via a merge subject):** `Merge pull request #5191 … cleanup/compact-persistence-schema`.
- **Dependencies (1):** `fix(deps): pin Koffi to the tested release`.
- **Docs / notes / tests / tooling (remainder).**

**Impact read from subjects alone:** the desktop area is small but not empty, and it is *menu- and
command-installation-shaped* rather than protocol-shaped. The one persistence-adjacent subject
(`compact-persistence-schema`) is the item that most needs a direct read before any baseline move; see
`UNVERIFIED` items in §5.

## 3. File-level drift (verified reads only)

| Path | Status | Area | Impact on a Rust/Tauri desktop port |
|---|---|---|---|
| `apps/desktop/src/web-document.ts` | **unchanged** | A | The direct reference for the Rust gateway. Byte-identical at both revisions, so **no gateway rebaseline is required** from this file. Verified by full read of both sides (S4, S6). |
| `packages/client/connection/src/browser-auth.ts` | **behaviorally unchanged** | B | The reference for the Rust `auth.rs`. Refactored into more helpers, but the cookie format (`v1.<body>.<sig>`, base64url, HMAC-SHA256), the `dsh-auth-<sha256(authority)>` name, `Max-Age`/`Path=/`/`Expires`/`HttpOnly`/`SameSite=Strict`, the 303→`./` mint, and the minimal 401 body are the same. Verified by full read of both sides. |
| `apps/desktop/src/command-installation.ts` | **added** (13,664 B) | A | New. `refactor(desktop): make CLI registration a post-install menu action` — upstream moved `dsh` CLI registration to a menu action. A port that owns menus must add this consumer or record an intentional deviation. |
| `apps/desktop/src/command-management.ts` | **added** (12,674 B) | A | New, the management half of the same feature. |
| `apps/desktop/src/command-manager-entry.ts` | **added** (2,871 B) | A | New entry module for the same feature. |
| `apps/desktop/src/device-info.ts` | **added** (1,363 B) | A/F | New; paired with `fix(telemetry): align desktop product reporting timeouts`. |
| `apps/desktop/src/duration-env.ts` | **added** (703 B) | A | New small helper. |
| `apps/desktop/src/login-shell-environment.ts` | **added** (9,089 B) | A | New. From `feat(desktop-login-shell-env)`. Resolves the login-shell environment for spawned processes — relevant to how a port spawns the Node Host with an inherited environment. |
| `apps/desktop/src/client/` | **added** (dir) | A/G | New directory; present at the target, absent at the pinned tree. Contents not enumerated in this inventory (`UNVERIFIED`). |
| `packages/boot/app-boot/src/profile.ts` → `OPTIONAL_BUNDLES` | **modified** | E | Grows from **3 to 4** entries: adds `@deepseek-ai/dsh-experimental-schedule-bundle`. `PROFILE_TEMPLATES` and `INSTALLATION_OWNED_PROFILE_TUPLES` are unchanged. Any port code or fixture that enumerates optional bundles must add the fourth. |
| `packages/core/session/src/types.ts` → `SESSION_FORMAT_VERSION` | **unchanged** (`4` at both) | D | No session-format migration is required. Verified by reading the constant at both revisions. |
| `apps/desktop/package.json` | **version only** | A/F | Same scripts and dependency structure; only `version` moved `0.1.7-rc.2` → `0.2.0-rc.2`. No new desktop runtime dependency appeared. |

Set difference over `apps/desktop/src` (65 at target vs 58 pinned): **7 entries added, 0 removed** —
the six files above plus the `client/` directory. Verified against S5 and S6.

## 4. Gateway-relevant verdicts

Each is a direct yes/no from a full read of both revisions (S4 + S6), not an inference.

| Question | Verdict | Evidence |
|---|---|---|
| Did `apps/desktop/src/web-document.ts` change? | **No** | Identical content at both revisions. |
| Did the boot-readiness injection change? | **No** | `BOOT` is still `<script>globalThis.__DSH_BOOT_READY__ = Promise.withResolvers()</script>`, still inserted via `body.toString().replace('<head>', '<head>' + BOOT)`. |
| Did the plugin `no-store` rule change? | **No** | `PLUGIN_BUNDLE_PATH = /^\/plugins\//u`, still forcing `cache-control: no-store` after the withheld-header deletion. |
| Did the withheld response headers change? | **No** | Same 11 names in the same order. |
| Did the stripped request headers change? | **No** | Still `host`, `origin`, `cookie`, `sec-fetch-site`. |
| Did the foreign-origin refusal change? | **No** | Still `origin !== null && origin !== 'dsh-app://app'` → 403. A port serving from a real HTTP origin substitutes its own origin here, which the port already does. |
| Did the auth cookie format or flow change? | **No** | See §3 row 2. |
| Did `SESSION_FORMAT_VERSION` change? | **No** — `4` at both | `packages/core/session/src/types.ts`. |
| Did `OPTIONAL_BUNDLES` change? | **Yes** — 3 → 4 | `packages/boot/app-boot/src/profile.ts`. |

**Consequence:** for the files actually read, the *protocol* surface the Rust gateway mirrors shows no
drift at the checked revision, so the gateway work in this lane is a correctness fix against the
**pinned** reference, not a rebaseline.

Read the coverage limit with that sentence. Nine files and one directory were compared; the compare
API's authoritative `files` array was never read (§6 item 1). "No drift found in what was read" is not
"no drift", and it is not a compatibility statement about the checked revision.

## 5. Rebaseline manifest and consumer migration checklist

Ordered. Each item names its evidence and the concrete action. Items marked `UNVERIFIED` must not be
applied on this document's authority.

### Gate 0 — before any baseline move

1. **Re-run the drift inventory with complete coverage.** This document is truncated in three places
   (§1). Re-fetch the compare API's `files` array (paginated, and note that GitHub caps it at 300
   entries) and read `apps/desktop/src/main.ts` and `packages/client/connection/**` at the target.
   *Action:* produce a complete file list before touching the baseline.
   `UNVERIFIED — needs the full compare file list and a target read of apps/desktop/src/main.ts.`

2. **Read the compact-persistence-schema change.** Subject `Merge pull request #5191 … cleanup/compact-persistence-schema`
   is the only persistence-shaped entry observed. Even though `SESSION_FORMAT_VERSION` is unchanged, a
   persistence *type* change can still alter stored records without a version bump (the project
   documents typed persistence changes separately from the format version).
   *Action:* read `packages/session/**` and `packages/compaction/**` at the target and compare the
   persistence types a port or its fixtures depend on.
   `UNVERIFIED — needs a target read of the session/compaction persistence types.`

3. **Confirm the Koffi pin.** `fix(deps): pin Koffi to the tested release` pins `koffi` to `3.1.1`;
   the target `apps/desktop/package.json` shows `"koffi": "3.1.1"`.
   *Action:* if a port stages a Node runtime payload, verify the staged `koffi` version matches rather
   than resolving `^3.1.0`. **Evidence: target `apps/desktop/package.json` (S4).**

### Gate 1 — protocol and runtime consumers

4. **No gateway protocol change required.** `web-document.ts` and `browser-auth.ts` are unchanged in
   substance (§4). A rebaseline must still re-run the port's gateway regression suite against the new
   reference, but must not "fix" the gateway to match a change that did not happen.
   **Evidence: §4 table.**

5. **No session-format migration required for the current header.** `SESSION_FORMAT_VERSION = 4` at
   both revisions; existing user sessions remain readable without a migration step.
   **Evidence: `packages/core/session/src/types.ts` at both revisions.** This does *not* clear Gate 0
   item 2, which concerns persistence types rather than the format version.

6. **Re-check the Host launch environment.** `login-shell-environment.ts` is new upstream
   (§3). It changes how the desktop resolves the environment for spawned processes.
   *Action:* compare the port's `dsh-runtime` spawn environment against the target behavior; a port
   that inherits the parent environment verbatim may now diverge on macOS/Linux login shells.
   **Evidence: file added between revisions (S5 vs S6).**

### Gate 2 — profile composition and first-party state

7. **Add the fourth optional bundle.** `OPTIONAL_BUNDLES` gains
   `@deepseek-ai/dsh-experimental-schedule-bundle` (§4).
   *Action:* update every port-side enumeration or fixture of optional bundles together — profile
   initialization, any bundled plugin-list UI data, and the fixtures that assert the official group.
   **Evidence: `packages/boot/app-boot/src/profile.ts` at both revisions (S4 + S6).**

8. **Do not enable Schedule by default.** The upstream decision is explicit that the shipped Web
   composition carries **none** of `time-context`, `schedule` and `ui-schedule`, and that the bundle
   ships switched off. A baseline move must not switch it on as a side effect.
   **Evidence: the schedule-bundle agent note present in the target tree (S4).**

9. **Preserve user profiles through the move.** `PROFILE_TEMPLATES` and
   `INSTALLATION_OWNED_PROFILE_TUPLES` are unchanged, so existing profiles keep their bundle lists.
   Any migration must activate the new bundle **without** overwriting user or plugin customization.
   **Evidence: `packages/boot/app-boot/src/profile.ts` at both revisions.**

### Gate 3 — desktop surface consumers

10. **CLI registration became a post-install menu action.** New
    `command-installation.ts`, `command-management.ts`, `command-manager-entry.ts` (§3).
    *Action:* decide per item whether the port implements it natively, defers it, or records it as an
    intentional deviation. This is a **menu/authority** change, so it belongs with the port's menu and
    native-command modules rather than the gateway.
    **Evidence: three files added between revisions (S5 vs S6) + commit subject.**

11. **Native command window visibility became explicit.** Subject
    `refactor(native-command): require explicit window visibility`.
    *Action:* audit any port command that opens a window or path for the new explicit-visibility
    requirement. Paired with `fix(windows): keep Explorer path-opening windows visible`, which is a
    Windows-specific behavior the port's native path-opening consumer should match.
    **Evidence: commit subjects (S3).**

12. **Enumerate the new `apps/desktop/src/client/` directory.** It is new at the target and its
    contents were not read here.
    `UNVERIFIED — needs a target read of apps/desktop/src/client/**.`

### Gate 4 — UI, fixtures and documentation

13. **UI drift is present and measurable.** Observed subjects include a long-session rendering /
    input / whale-animation performance change, a whale image inlined into CSS at build time, Office
    and PDF selection visibility in both themes, and plugin-manager guidance copy.
    *Action:* because the port preserves the upstream UI unmodified, these arrive by rebuilding the UI
    from the new revision rather than by editing port code. Record the new UI artifact identity and
    re-run the capture/comparison fixtures.
    **Evidence: commit subjects (S3). Note the coverage limit: this is a sample, not the full UI change
    list.**

14. **Update fixtures and documentation as one change.** The baseline identity appears in the port's
    contract docs, parity matrix, fixtures and manifest. Moving the baseline without moving all of them
    together produces the "identical files ⇒ parity" inference the plan forbids.
    *Action:* update the pinned-revision record, the protocol fixtures, the UI artifact identity and the
    session/format fixtures in a single change, and re-record the environment fingerprint.

## 6. Truncation ledger

Stated plainly so no reader mistakes a partial comparison for a complete one.

1. **Commit list (S1): truncated in transit.** `ahead_by: 448` and `behind_by: 0` were read; the
   per-commit array and the `files` array were cut off. The `files` array — the authoritative changed
   file list — was **never read**.
2. **Compare diff (S2): truncated mid-file.** Only the first 34 file blocks were captured, and all 34
   are `.agents/notes/**` documentation. **No source change appears in the captured portion.** The
   inventory therefore does not claim to have enumerated the diff.
3. **Commit subjects (S3): a 54-subject sample of 448, biased to the newest commits** by merge
   topology. Absence of a subject from §2 is not evidence that nothing changed in that area.
4. **Contents API (S5): complete for `apps/desktop/src`**, but that one directory is the only tree
   compared as a set.
5. **Not determined at all:** the full changed-file list; `apps/desktop/src/main.ts` at the target;
   `apps/desktop/src/client/**` contents; the session/compaction persistence-type change;
   `packages/client/connection/**` beyond `browser-auth.ts`; Node/pnpm engine changes; the target's
   added/removed top-level packages.
6. **Public position: verified, and separately recorded.** The release/tag/`master` facts in the
   "Public upstream position" table above come from the GitHub API and are complete for what they cover
   — they were not truncated. They establish publication metadata only, not compatibility (§7).

## 7. What this document does not do

- It does not move the port's baseline, and it does not make the port `0.2.0-rc.2`-compatible.
- It does not claim a commit count as a measure of work. `448` is GitHub's `ahead_by`, an input to the
  inventory, not a migration estimate.
- It does not assert parity with the checked revision anywhere. §4 lists what did **not** change; that is
  the opposite of a parity claim about what did.
- It does not treat the checked revision's public status — newest release, `master` head, `ahead_by:
  448`, a later publication date — as evidence of semantic equivalence or incompatibility. Only the
  per-file reads in §3 and §4 carry any weight here, and only for the files actually read.

## 8. What still has to happen before this inventory can gate a rebaseline

The checklist in §5 is complete enough to act on **only** once Gate 0 is discharged. Everything below
is outstanding, and none of it can be discharged from this document:

| # | Outstanding item | Why it is a prerequisite |
|---|---|---|
| 1 | Full compare file list (paginated; GitHub caps at 300 entries) | The `files` array is the authoritative changed-file list and was never read (§1 S1, §6 item 1). |
| 2 | Target read of `apps/desktop/src/main.ts` | The gateway's boot-injection and window-model reference; never read at the checked revision. |
| 3 | Target read of `apps/desktop/src/client/**` and `packages/client/connection/**` beyond `browser-auth.ts` | `client/` is new and unenumerated; `connection/**` is the rest of the transport reference. |
| 4 | Session/compaction persistence **types** at the checked revision | `SESSION_FORMAT_VERSION` is unchanged at both, but a persistence type change can alter stored records without a version bump (§5 item 2). |
| 5 | Node/pnpm engine and top-level package delta | Determines whether the pinned Node and the payload closure move (§6 item 5). |
| 6 | Re-run the port's gateway regression suite against the checked revision | Gate 1 item 4 requires the suite to be re-run even where no change is expected. |
| 7 | Decide the `login-shell-environment.ts` divergence | §5 item 6; unread at the target. |

Until those are done, the honest statement remains: **the port targets `477b4f4…` and this document is a
partial, explicitly-truncated inventory of `639ed015…`.**
