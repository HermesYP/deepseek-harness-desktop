# Account browser links and diagnostics repair

Date: 2026-10-11. These results apply to the current dirty working tree and the
local portable UI delivery below; they do not qualify an installer or release.

## Browser buttons

The user reported that Usage/Top-up did nothing after the prior UI hotfix.
Removing the unavailable `dshPlatform` capability selected the preserved client's
browser fallback, but did not establish that the fallback could open a browser.

Two independent routes were blocked:

- Account links are `target="_blank"` anchors. The pinned opener plugin 2.5.5
  injects a window-level click listener that prevents default navigation and
  invokes `plugin:opener|open_url`. The main view's exact-origin capability grants
  the port's `bridge` commands, not this plugin command.
- Programmatic `window.open` reaches the main window's native new-window handler,
  which returns `NewWindowResponse::Deny`.

The port now routes external new-tab links and `window.open` through the existing
`shell_open_external` command. Its normal-policy and owned-origin checks remain
in force. A document-level bubbling handler lets the client's own handlers run
first and precedes the older executable's window-level opener handler. New native
builds disable that plugin's automatic link script. Only the main shell installs
this code; `dshPlatform` remains absent and native guests remain disabled.

The handler does not export same-origin gateway URLs, embedded credentials or
unsupported schemes. It preserves downloads, disabled links and client-cancelled
events. Opening failures show a Copy link action and a fixed diagnostic message
without recording the destination URL. External browser calls return null,
consistent with a destination that supplies no scriptable WindowProxy.

### Local delivery

Portable application:
`%USERPROFILE%\Hermes\dsh-desktop\onboarding-fixed-portable\dsh-desktop.exe`

Evidence and rollback:
`%USERPROFILE%\Hermes\dsh-desktop\repair-evidence\external-links-20261011-3bd0fe66`

- Production UI built with the pinned Node and byte-identical esbuild copies in
  an owned directory outside the workspace; both child tokens were Medium.
- Entry: `ui/assets/index-WLNBzqxB.js`, SHA-256
  `250e59cc2456dd3b1763eeb4fc2e8ad12c4a3d5ccf5416537856804dcf8975fe`.
- 193 build files verified against the delivered bytes; 63 files written.
  Existing changed files have retained backups. Old unused hashed assets remain
  available to the previously loaded document. The entry HTML was replaced last.
- The existing runtime seal verified before delivery. Native executable,
  runtime-payload manifest, desktop descriptor and the prior account-platform
  hotfix module have unchanged hashes after delivery. UI files are outside that
  runtime descriptor, so this repair does not reseal or modify the Node payload.
- A first delivery attempt refused the empty backup-path argument to .NET
  `File.Replace`; its applied changes were rolled back. The successful delivery
  supplies a real retained replacement-backup path.
- No application restart, real account request or credential access was performed
  by this agent. Native click acceptance is pending the user's restart/check.
  Older installers still require a new qualified delivery.

### Checks

- Desktop bridge: 239 passed across 11 files, including 10 external-link cases.
  They drive the real typed facade's Tauri command names and reproduce the old
  plugin's event ordering. These are DOM/transport tests, not native browser
  acceptance. jsdom also reported its expected unsupported-document-navigation
  message for a deliberately unintercepted negative case.
- Desktop bridge TypeScript: passed.
- Qualified Vite production build: passed; 193 output files.
- Strict workspace Clippy, all targets, locked/offline: passed, including the app.

## Diagnostic source fixes

The native source now pipes both Host stdout and stderr, frames complete bounded
lines across read chunks, and passes them to the app logger through the existing
redaction/sanitization functions. Stdout terminal forwarding and the bounded
stderr recovery tail remain available. Overlong individual lines are discarded
whole. This is a per-line bound, not a total daily-log size bound. Reader tasks are
not joined by the fatal path, so abrupt shutdown can still race final output.

Crash reports are written to a unique temporary file, synced, and published under
the final name only after writing succeeds. Publication preserves existing files
on collision; failed writes clean up their own temporary file. The chosen
same-directory hard-link publication fails explicitly on unsupported filesystems.
It does not establish why the two historical reports were empty. Existing Windows
profile ACL assumptions are unchanged.

Core/gateway/runtime tests: 225 passed, 1 ignored. Fresh test binaries were probed
with `--list` and their actual Medium child tokens verified before execution.
New tests cover partial-write cleanup, final-name visibility, report collisions,
split UTF-8/credential framing, oversized-line handling and stdout observation
without a console. These native changes have compiled and passed Clippy, but are
not included in the portable executable above; they need a native rebuild and
qualification before delivery.

The latest user run created `platform-auth-403.log` under the application's logs
directory. Four records at 09:22:30-09:22:32 UTC (14:52:30-14:52:32 in the user's
Asia/Calcutta timezone) report status 403 for `/auth-api/v0/users/current`, all
classified `edge-block`. The current classifier assigns that label when the body
contains `generated by cloudfront` or `request blocked`; the retained 240-character
excerpt does not preserve either marker. This establishes the classifier's
observed result, not the particular edge rule, geography or reason for refusal.
No raw response body or private account data was printed during inspection.

A successful balance response establishes acceptance for that route, not the
profile route. Profile recovery remains unresolved; this browser-link repair does
not prove it. Changing credentials or injecting session headers is not justified
by these records alone.
