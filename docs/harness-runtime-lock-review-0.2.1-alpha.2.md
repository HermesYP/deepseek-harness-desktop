# Frozen runtime input review: 0.2.1-alpha.2

## Scope and status

**Patched inputs authorised for frozen staging; executable acceptance still pending.** The current [descriptor](<%USERPROFILE%/Hermes/dsh-desktop/worktrees/harness-0.2.1-alpha.2/port/runtime-locks/windows-x64/descriptor.json>) is `REVIEWED` after the two independent audits below. The outside-workspace patched candidate remains immutable `CANDIDATE`. No dependency resolution or package bytes were hand-edited; the only promotion edit is the copied descriptor's review status. The [promotion receipt](<%USERPROFILE%/Hermes/dsh-desktop/worktrees/harness-0.2.1-alpha.2/docs/evidence/harness-runtime-lock-promotion-0.2.1-alpha.2.json>) binds both descriptor digests and derives the release identity from the target-release module. The narrow [Git attributes rule](<%USERPROFILE%/Hermes/dsh-desktop/worktrees/harness-0.2.1-alpha.2/.gitattributes>) preserves the frozen input bytes on Windows checkout.

## Initial unpatched candidate: approval withdrawn

The initial byte/integrity audit below remains valid, but its staging approval is withdrawn. The original candidate and [archived input copy](<%USERPROFILE%/AppData/Local/DSH-Qualification/withdrawn021-50837612/windows-x64-initial-candidate/descriptor.json>) remain `CANDIDATE`. The initial audit JSON explicitly records `WITHDRAWN`; it is not the current runtime baseline.

- Source: tag `dsh-v0.2.1-alpha.2`, commit `d743267388641bc76f17c45ce8b4c231aed1d32c`.
- Package manager: pnpm `11.28.5`; archive-pinned Node `22.20.0`, ABI 127.
- Lock SHA-256: `fd1f1e23326e0053e3ec81f1d9f93fa2255c4d59456bc5f9df46bdc318e1b721`.
- Workspace policy SHA-256: `683f3aed69cd854c0b1e21e52246e1fdf20f4782a1d7c2cf24c52fbf286f420d`.
- Manifest SHA-256: `ad05dc7441acd67bf2d3cfc2ef04040b16c3f0264a25d5af842929b4cca48d77`.
- Package-set SHA-256: `49fd7836930e65a46944e31ddb702faeeaa13b3e62a8743a071d64e02fe6f283`.

## Review evidence

[Full generated audit](<%USERPROFILE%/Hermes/dsh-desktop/worktrees/harness-0.2.1-alpha.2/docs/evidence/harness-runtime-lock-review-0.2.1-alpha.2.json>) records the actual metadata, policy and external dependency differences. Independent derivation of the descriptor matched the generator; all four project metadata files matched byte-for-byte; all **298** candidate tarballs (**24,791,992 bytes**) were regular files with the exact declared sizes and SHA-512 integrities. The tarball directory contained exactly the declared set. Every local DSH package is the target version and every local override points to its declared relative tarball. Strict dependency-build policy, hoisted linking and disabled automatic peers were checked.

The runtime lock contains **346** external package entries; **66** entries are absent from the upstream workspace lock. This includes published unsupported-platform native packages (the workspace uses links), as well as newer dependency versions resolved within package constraints: notably pi-ai/pi-telemetry `1.1.0`, zod `4.6.7` and koffi platform packages `3.3.3`. No unchanged external package identity has a changed integrity. This is **not** a claim that the external closure equals the upstream workspace lock or that integrity proves compatibility. Actual staged Host, account and native chat/tool/cancellation tests must verify it.

Local tarballs were made from the built source checkout and are **not** claimed byte-identical to npm's published DSH tarball. The automatic staging compiler resolves tsx's actual dependency link (`0.28.1`, not an ambiguous `~0.28.0` range) and copies identical bytes outside the labelled tree, proving the actual Medium child token without relabelling. Compiler qualification helpers, like the existing UI helper, are outside the payload-input seal; the runtime-affecting adapter/overlay helpers are sealed.

## Semantic review and corrected decision

The initial candidate has zero `patch_hash` entries, whereas the upstream monorepo lock has fifteen. Two omitted patches matter to the shipped runtime:

- `node-pty@1.2.0-beta.15`: the upstream Windows patch disposes the conout worker immediately after native kill, even if the process emits no subsequent output. The candidate has the same version but lacks that teardown fix. The Unix spawn-helper hunk is not Windows-relevant.
- `@earendil-works/pi-ai@1.0.2`: the upstream patch removes repeated partial tool-argument JSON parsing during streaming in six provider implementations. Inspection of the candidate's actual installed `1.1.0` files confirms those parsing calls remain; the newer version does not subsume the patch.

This omission is inherited from upstream Desktop's generated project policy, which also lacks `patchedDependencies`; it is not uniquely introduced by the port. Likewise `minimumReleaseAgeExclude` is an exemptions list, not a hold list; without a release-age gate it pins no versions. Newer external resolutions resulted from admitted package ranges and a fresh standalone resolution, not from dropping an age gate.

Decision: preserve the two exact upstream patch files, pin their reviewed target versions in generated policy, bind their bytes to candidate descriptors, and regenerate the candidate through pnpm. Seed refresh with the unchanged upstream lock so pnpm can reuse reviewed external resolutions; never hand-edit resolution entries. Re-review the newly generated candidate before frozen staging. The other five monorepo patch targets are absent from the current runtime closure.

## Regenerated patched candidate: staging approval

The [new independent audit](<%USERPROFILE%/Hermes/dsh-desktop/worktrees/harness-0.2.1-alpha.2/docs/evidence/harness-runtime-lock-review-patched-0.2.1-alpha.2.json>) and a separate DeepSeek read-only semantic audit agree:

- Lock SHA-256: `cb390ebcbe4e89ec90ee91c96af2663793a4612d43c006b986c3c0c946e077fd`.
- Workspace policy SHA-256: `dcf46a8daad5258c1394433fd22753fa64e79dda338f3f7e57e553ddb02ebcc5`.
- Dependency-policy record SHA-256: `58d7a6ce28661d2c52454e15775a849945d5ead2159cd71edc31b00d0ead3117`.
- Both exact upstream patches and their version overrides are present. Applied lock snapshots carry the matching patch hashes. The record's source policy and lock hashes equal the actual built source bytes.
- The same **298 tarballs / 24,791,992 bytes** remain unchanged, with all local overrides and the seven native build approvals preserved. Exemptions were copied without adding a release-age gate.
- **324** external entries; **4**, not 66, absent from the source lock; zero same-identity integrity changes. All four are published non-Windows `node-addon-system` variants at `0.1.2`, linked rather than registry-resolved in the source workspace.
- Actual resolutions are pi-ai/pi-telemetry `1.0.2`, node-pty `1.2.0-beta.15`, koffi and its platform packages **only `3.1.1`**, zod `4.4.3`, undici `8.10.2`, jose `6.2.3`, ws `8.21.3`, yaml `2.9.0` and execa `10.0.1`. These match the source lock. Seeding does not guarantee this outcome; it is the measured result of pnpm's regeneration.

The adopted copy's full **306-file** inventory and SHA-256 hashes matched the candidate before its descriptor alone was marked `REVIEWED`. The original patched candidate was not modified. This approves frozen staging only, not end-to-end compatibility. Combined lock/policy/Cordis regression tests passed **40/40**. The broader packaging run passed **169/170**; the remaining failure explicitly required the not-yet-published runtime descriptor and was not disabled.

## Actual staging attempts

The first attempt refused inherited `npm_config_userconfig` before installation/publication. A retry explicitly isolated that variable in the caller while preserving the build's owned npm configuration. Frozen installation and materialization then succeeded, but an old unconditional Cordis `4.0.4` guard refused the target `4.0.5-alpha.1`. The guard has since been source-reviewed and repaired with an exact two-version table; neither failed attempt published a sealed runtime.

The patched frozen retry (managed job `pwsh-492`) completed installation, materialization and sealing transformations, then correctly refused publication: its deepest staged file was **280 characters**, beyond the unchanged `<260` path limit. The file is a DevTools inspector accessibility-description Markdown asset; the checkout prefix alone makes the final published path too long as well. No package files will be removed and the guard will not be loosened. The next normal build runs from a newly owned short-path checkout of the same commits and byte-identical frozen inputs/UI.

## Outstanding at review time

Patched candidate regeneration, semantic review and frozen-input adoption are complete. Frozen publication/sealing validation, native-addon loading, a matching desktop build, packaged account integration and real WebView2 acceptance are still pending. Production account/provider verification and installer/update acceptance remain separate gates; fixture-provider evidence cannot close them.

Native acceptance also separates the static patch-presence check, actual UI terminal shell lifecycle and actual Worker-thread disposal. Process-table shell absence cannot prove disposal of node-pty's Worker thread. Independent review found and fixed the initial static detector's false-negative on the real comment/catch-separated patch shape; its regression suite now checks actual pre/post-images. A separate real-native quiet-child helper is prepared but has not run.
