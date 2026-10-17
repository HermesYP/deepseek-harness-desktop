# Disclosure: private evidence committed to the public repository

**Date of this disclosure:** 2026-10-17

## What happened

The public repository contained two tracked evidence artifacts captured against a
real desktop profile:

- `docs/evidence/port-sessions/mount-check.png`
- `docs/evidence/port-sessions/mount-check.json`

The screenshot showed private workspace and project names, a private source path,
a session title, and a pasted code-review message. The JSON carried the same
session text and sidebar labels.

The files were introduced in the initial public commit
`d26c953` (2026-09-27) and were present on every branch and on the
`desktop-v0.2.1-alpha.3-port.20261015.1` release tag.

## What was not exposed

- **No installer or portable artifact contained the evidence.** The Tauri
  `bundle.resources` mapping ships only `ui/dist/` and `runtime-payload/dsh/`.
  `docs/` is source-repository content and is not packaged.
- **No live API key, cookie, provider secret, or credential-store file was
  tracked.** A tracked-file scan for provider-key patterns and credential-store
  names found no live secret.
- The reference capture trace files contained one expired loopback gateway launch
  token (`http://127.0.0.1:3085/?token=…`). The server process no longer exists;
  the token is not usable. It has been redacted to `?token=<redacted>`.

## Remediation

- Removed `docs/evidence/port-sessions/` from the tracked tree.
- Redacted the expired token in the reference traces.
- Replaced personal absolute paths in tracked operational files and evidence
  records with placeholders (`%USERPROFILE%`, `<repo>`, `<artifacts>`).
- Added a repository hygiene gate (`scripts/check-repo-hygiene.mjs`) and a CI job
  that fail if a personal path, a launch-token-shaped URL, a credential-store
  artifact, or the removed evidence directory is tracked again.
- Added `LICENSE` and `NOTICE` and wired the installer's license page.

## History

This is a **forward-only** remediation, chosen deliberately. The artifacts remain
retrievable from the existing public history by commit SHA until GitHub removes
unreachable objects. Purging them would require a full history rewrite, force-push
of every branch, deletion and recreation of the release tag, and a GitHub Support
request for object removal; it would invalidate existing clones and the published
release's source reference. The project has chosen not to do that at this time.

If the workspace/project names in the screenshot are sensitive, treat this as a
disclosure to the affected owner and rotate anything that the screenshot or JSON
could have revealed. The artifacts did not contain credentials.
