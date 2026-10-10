# Desktop ↔ Host Lifecycle Protocol (SHARED INTERFACE SPECIFICATION)

Binding process and IPC contract between the Electron main process ("shell", `apps/desktop/src/`) and the Desktop Host child process (`apps/desktop-host/src/`), traced from `_upstream/` at commit `477b4f420553e8a52c2fbccc464d7561b239c443`. The protocol generation is `DESKTOP_HOST_PROTOCOL_VERSION = 4` (`_upstream/apps/desktop/src/host-protocol.ts:4`), recorded in release metadata as `hostProtocolVersion` and required to match at runtime (`_upstream/apps/desktop/src/release.ts:11,21-27`). Transport is the Node.js child-process IPC channel created by `stdio: [..., 'ipc']` — messages are JSON-serialized objects delivered in send order per direction (Node IPC semantics; ordering guarantee: FIFO per channel, stated from `child.send`/`process.send` usage `_upstream/apps/desktop/src/host-process.ts:206,274` and `_upstream/apps/desktop-host/src/index.ts:48-51,59`). There is no framing layer, no sequence numbers, and no message ids except the shell-minted `requestId` on control requests.

## 1. Message vocabulary

Shell-side union and validation: `DesktopHostEvent` + `isDesktopHostEvent` (`_upstream/apps/desktop/src/host-process.ts:26-91`). Host-side dispatch: `_upstream/apps/desktop-host/src/index.ts:59-104`. Every field name below is exact.

### 1.1 `ready` — Host → shell (once, after startup)

```json
{ "type": "ready", "url": "http://127.0.0.1:19387/?token=…", "injections": [ { "kind": "global", "name": "__DSH_BOOT__", "value": { "rev": "…", "entries": [], "batches": [] } } ] }
```

Fields: `type: 'ready'`, `url: string` (the Host's browser authentication URL produced by `ctx.connection.authenticatedUrl(\`http://127.0.0.1:${ctx.webServer.port}\`)`), `injections?: readonly unknown[] | undefined` (the Host's `ctx.webServer.collectIndexInjections()` table — structured `IndexInjection` rows, see `ui-backend-protocol.md` §7) (`_upstream/apps/desktop-host/src/index.ts:103-104`; shell type `ReadyEvent`/`DesktopHostReady`, `_upstream/apps/desktop/src/host-process.ts:8-12,106-110`). Validation on receipt: `typeof candidate.url === 'string'`; `injections` is not structurally validated (`_upstream/apps/desktop/src/host-process.ts:59-60`) — the shell later requires `injections !== undefined` and fails startup otherwise (`_upstream/apps/desktop/src/main.ts:419-420`). Exactly one `ready` is expected; a second would re-resolve the already-settled ready promise (no-op) — **NOT DETERMINED FROM SOURCE** as a defended case. Ordering: `ready` is sent only after the profile application booted, the `update-tasks` and `quit-inspection` controls were installed, the office engine plugin mounted, and the platform-session publisher installed (`_upstream/apps/desktop-host/src/index.ts:92-104`), so at `ready` time every control message below is answerable.

### 1.2 `shutdown` — shell → Host (graceful teardown request)

```json
{ "type": "shutdown" }
```

No fields besides `type`. Sent by `DesktopHostProcess.stop()` while `child.connected` (`_upstream/apps/desktop/src/host-process.ts:293`). Host handling: `message.type === 'shutdown'` triggers `stop()` once (`stopping` memoizes it): await the application promise (startup failure is swallowed — "shutdown only owns a tree that booted", call `running?.shutdown.shutdown(0)`, then send `shutdown-complete`, then `process.disconnect()` (`_upstream/apps/desktop-host/src/index.ts:52-61`). Ordering guarantee: at most one effective `shutdown`; further `shutdown` messages join the memoized teardown. Failure behaviour: a `shutdown` send error is routed to `fail()` (first failure reporting, `_upstream/apps/desktop/src/host-process.ts:293`).

### 1.3 `shutdown-complete` — Host → shell (teardown acknowledgement)

```json
{ "type": "shutdown-complete" }
```

Fields: `type` only (validated case `_upstream/apps/desktop/src/host-process.ts:57-58`). Sent after the application tree's `shutdown.shutdown(0)` completed and immediately before the Host disconnects its IPC (`_upstream/apps/desktop-host/src/index.ts:52-58`). Ordering: strictly after a `shutdown` request or a parent `disconnect`; receipt while `stopping` sets `shutdownCompleted = true`; receipt without a requested shutdown is a protocol violation → `fail(new Error('dsh desktop host acknowledged an unrequested shutdown'))` and the shell kills the child (`_upstream/apps/desktop/src/host-process.ts:214-217,208-210`). `shutdownCompleted` feeds the update handoff gate (`requireGraceful`, §3.3).

### 1.4 `quit-inspection` — shell → Host request / Host → shell response

Request (shell-minted `requestId`, `_upstream/apps/desktop/src/host-process.ts:268-274`):

```json
{ "type": "quit-inspection", "requestId": 7 }
```

Response (success or failure, same shape):

```json
{ "type": "quit-inspection", "requestId": 7, "activeTasks": true, "scheduledTasks": false }
{ "type": "quit-inspection", "requestId": 7, "activeTasks": true, "scheduledTasks": false, "error": "desktop quit: Host is stopping" }
```

Response fields (`_upstream/apps/desktop/src/host-process.ts:31-37,85-87`): `type: 'quit-inspection'`, `requestId: number` (safe integer, echoed), `activeTasks: boolean`, `scheduledTasks: boolean`, `error?: string`. Semantics (`_upstream/apps/desktop-host/src/quit-inspection.ts:23-40`): `activeTasks` = any agent `status === 'running'` or non-empty `inbox.nextTurn`/`nextStep`, or any job `running`/`stopping` (`hasDesktopActiveTasks`, `_upstream/apps/desktop-host/src/update-tasks.ts:16-21`); `scheduledTasks` = any live agent's `workspace/session-activity` waterfall reports a `kind: 'schedule'` entry whose timer is armed in this process. On any error the Host answers `{ activeTasks: true, scheduledTasks: false, error }` — an unknown state is deliberately reported as interruptible work so the shell asks before quitting (`_upstream/apps/desktop-host/src/index.ts:70-74`). Deadline: `QUIT_INSPECTION_DEADLINE_MS = 2_000` (`_upstream/apps/desktop/src/host-process.ts:49`); the shell rejects with `desktop quit: inspection timed out` after 2 s and `DesktopQuitConfirmation` then treats the state as `'unknown'` and shows the running-tasks prompt (`_upstream/apps/desktop/src/host-process.ts:254-258`, `_upstream/apps/desktop/src/quit-confirmation.ts:15-21,68-75`). Correlation: `requestId` from a per-process monotone counter starting at 1 (`_upstream/apps/desktop/src/host-process.ts:151`); a late response finds no pending entry and is dropped (`request?.resolve(...)`, `:220-222`). Ordering: one in-flight inspection is typical but not enforced; each request is answered exactly once by the Host (success or `error`), or not at all on teardown (shell deadline covers that).

### 1.5 `update-tasks` — shell → Host request / Host → shell response

Request:

```json
{ "type": "update-tasks", "requestId": 3, "action": "inspect" }
{ "type": "update-tasks", "requestId": 4, "action": "lock" }
{ "type": "update-tasks", "requestId": 5, "action": "unlock" }
```

Response:

```json
{ "type": "update-tasks", "requestId": 4, "active": true }
{ "type": "update-tasks", "requestId": 4, "active": true, "error": "desktop update: Host is stopping" }
```

Request fields: `type: 'update-tasks'`, `requestId: number` (safe integer; added by `control()`, `_upstream/apps/desktop/src/host-process.ts:274`), `action: 'inspect' | 'lock' | 'unlock'` (validated `_upstream/apps/desktop-host/src/index.ts:78-79`). Response fields (`_upstream/apps/desktop/src/host-process.ts:26-30,82-84`): `type: 'update-tasks'`, `requestId`, `active: boolean` (note: `active`, not `activeTasks`), `error?: string`. Semantics (`_upstream/apps/desktop-host/src/update-tasks.ts:28-61`): `inspect` returns `hasDesktopActiveTasks(...)`; `lock` additionally (a) refuses every new `/api` request with `503` via a `connection/request` waterfall listener, (b) drains already-admitted requests (`await Promise.all(pendingRequests)`), then re-checks tasks; `unlock` clears the lock and bumps `lockGeneration` (a superseded lock fails with `desktop update: admission lock was superseded`). On error the Host answers `active: true` with `error` (`_upstream/apps/desktop-host/src/index.ts:85-88`) — "tasks unknown" refuses installation. Deadline: `control({type:'update-tasks', action}, 10_000, 'desktop update: task inspection timed out')` — 10 s (`_upstream/apps/desktop/src/host-process.ts:243-247`); an unanswered drain fails at that deadline without authorizing installation (doc comment `:237-242`). Correlation and ordering as §1.4.

### 1.6 `platform-session` — Host → shell (credential updates, unsolicited)

```json
{ "type": "platform-session", "session": { "origin": "https://platform.example", "token": "…", "userId": "u-1", "requestHeaders": { "x-custom": "v" } } }
{ "type": "platform-session", "session": null }
```

Fields: `type: 'platform-session'`, `session: PlatformSession | null` where (`_upstream/packages/credentials/deepseek-account/src/index.ts:20`, mirror validation `_upstream/apps/desktop/src/host-process.ts:61-79`):

```typescript
export interface PlatformSession {
  readonly origin: string                 // exact URL origin; https:, or http: only on localhost/127.0.0.1/[::1]; no userinfo
  readonly token: string                  // non-empty
  readonly userId: AccountUserId | null   // null or non-empty string
  readonly embeddedPageDist?: string      // must be a string when present
  readonly requestHeaders?: Readonly<Record<string, string>>  // all-lowercase names; values free of CR/LF; may not be
    // authorization, x-dsh-auth-token, host, content-length, transfer-encoding, connection, content-type
}
```

Produced by `installPlatformSessionPublisher` (publishes on every account-provider state change; `null` on stream end/disposal) (`_upstream/apps/desktop-host/src/platform-session.ts:10-36`), delivered synchronously to the shell's `onPlatformSession` → `platformView.setSession(next)` (`_upstream/apps/desktop/src/host-process.ts:213`, `_upstream/apps/desktop/src/main.ts:413`); the shell also synthesizes `null` locally on `stop()` and on `fail()` (`host-process.ts:292,311`). Ordering: at-least-once, last-value-wins; the shell revalidates every frame and a malformed frame is a protocol violation → `fail('dsh desktop host sent an invalid IPC event')` + `SIGTERM` (`host-process.ts:206-212`). These credentials never reach the renderer (`_upstream/apps/desktop-host/src/platform-session.ts:8`).

### 1.7 `fatal` — Host → shell (fatal startup/runtime failure before exit)

```json
{ "type": "fatal", "message": "webserver: listen EADDRINUSE …", "diagnostic": "Error: webserver: listen EADDRINUSE …\n    at …" }
```

Fields: `type: 'fatal'`, `message: string` (what the Host chose to show), `diagnostic?: string` (the Host's complete inspected error: `util.inspect(error, { depth: 4, maxArrayLength: 50 })` truncated to `MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024`) (`_upstream/apps/desktop-host/src/index.ts:107-121`; shell type `FatalEvent` `_upstream/apps/desktop/src/host-process.ts:14-19`, validation `:80-81`, cap `MAX_HOST_DIAGNOSTIC_CHARS` `:51`). Sent instead of stderr reporting because "stderr bytes and this IPC message race, and the shell reports the first failure it sees" (`_upstream/apps/desktop-host/src/index.ts:113-115`); after sending, the Host logs to stderr, sets `process.exitCode = 1`, and disconnects (`:117-120`). Shell: wraps it in `DesktopHostFatalError(message, diagnostic)` (diagnostic kept as a getter so `util.inspect` does not duplicate it, `_upstream/apps/desktop/src/host-process.ts:121-135`) and routes it to `onFailure` → `reportFatal` (§3.4).

### 1.8 Control-response correlation summary

`quit-inspection` and `update-tasks` responses are `Extract<DesktopHostEvent, { requestId: number }>` (`_upstream/apps/desktop/src/host-process.ts:40`); the shell matches `requestId` against `controlRequests` and, when `error` is present, rejects the caller with `new Error(message.error)` (`:219-223`). A response with `error: undefined` resolves with the whole response object and callers assert the `type` (`updateTasks`/`inspectQuit` throw `desktop …: Host answered with a different control response` on mismatch, `:245-246,256-257`). Messages failing `isDesktopHostEvent` in either direction are fatal (shell side, §1.6); the Host ignores inbound messages that are not `shutdown`/`quit-inspection`/`update-tasks` or that lack a safe-integer `requestId` (`_upstream/apps/desktop-host/src/index.ts:59-90` — silent `return`, no error reply).

## 2. Spawn contract (shell → Host)

Transcribed from `DesktopHostProcess.start()` (`_upstream/apps/desktop/src/host-process.ts:186-205`) and its construction site (`_upstream/apps/desktop/src/main.ts:408-413`):

```typescript
// argv — exact order (host-process.ts:189-197)
spawn(this.node, [
  '--expose-internals',
  ...(this.inspectPort === undefined ? [] : [`--inspect=127.0.0.1:${this.inspectPort}`]),  // dev-only inspector
  entry,             // join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js') (:188)
  this.runtimeDir,   // argv[2] in the Host: immutable runtime packages dir (= resources.dsh)
  this.projectDir,   // argv[3] in the Host: Desktop plugin profile dir and child cwd (= activeProject)
  this.primaryRuntime ?? join(this.runtimeDir, '..', 'runtime', 'primary-runtime'),  // argv[4]: bundled dependency payload
  ...this.packageManager === undefined ? [] : [this.packageManager.pnpm, this.packageManager.nodeBin],  // argv[5], argv[6]
], {
  cwd: this.projectDir,
  env: desktopNodeEnvironment(this.node, undefined, this.environment),  // see below
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],                            // stdin ignored; stdout piped to shell stdout; stderr captured (64 KiB tail); fd 3 = IPC
})
```

Environment (`desktopNodeEnvironment`, `_upstream/apps/desktop/src/node-environment.ts:12-18`): the caller environment verbatim plus `ELECTRON_RUN_AS_NODE: '1'`; because `bin` is passed `undefined` for the Host spawn, `DSH_DESKTOP_NODE_EXECUTABLE` and `PATH` prepending are NOT added at spawn time (they are scoped to package operations instead — see below). `this.node` is the Electron executable in Node mode (`process.execPath`, `_upstream/apps/desktop/src/main.ts:148-156`). `runtimeDir` = `resources.dsh`: packaged `join(app.getAppPath(), 'dsh')`, development `join(app.getAppPath(), '.desktop-build', 'development', 'project')` (`main.ts:154-155`). `projectDir` = `paths.profile` (the Desktop plugin profile directory, `_upstream/apps/desktop/src/main.ts:315,320`). `primaryRuntime` = packaged `join(process.resourcesPath, 'runtime', 'primary-runtime')`, development `$DSH_DESKTOP_PRIMARY_RUNTIME_DIR` (required for unpackaged launches) (`main.ts:317-319`, `:159-165`). `packageManager` = `{ pnpm, nodeBin }` from `runtimeResources()`: `pnpm` is `$DSH_DESKTOP_PNPM_ENTRY` or `<app>/node_modules/pnpm/bin/pnpm.mjs` (dev) or `<resources>/runtime/pnpm/bin/pnpm.mjs` (packaged); `nodeBin` is `<app>/scripts/node-bin` (dev) or `<resources>/runtime/bin` (packaged) (`main.ts:147-157`).

Package-manager argv on the Host side (`_upstream/apps/desktop-host/src/index.ts:31-41`): when `argv[5]` is present, `runProfile` receives `packageManager: { command: process.execPath, args: ['--expose-internals', argv[5]], env: { ELECTRON_RUN_AS_NODE: '1', DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, PATH: `${argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}` } }` — i.e. the bundled pnpm entry is run under the Electron Node with the bundled `node-bin` directory fronted on `PATH`, scoped to package operations only.

The Host reads its argv as `argv[2]=runtimeDir`, `argv[3]=projectDir`, `argv[4]=primaryRuntime` (default `join(runtimeDir,'..','runtime','primary-runtime')`), `argv[5]=pnpm`, `argv[6]=nodeBin` (`_upstream/apps/desktop-host/src/index.ts:19-20,95-99`), loads the profile via `loadProfileDirectory('dsh', projectDir, join(runtimeDir,'node_modules','@deepseek-ai','dsh','package.json'))` and boots `runProfile({ profile: 'desktop', args: ['--no-open', '--port', '19387'], ... })` (`:22-42`) — the Web application listens on loopback and its actual port is reported through `ctx.webServer.port` inside `ready.url` (`:103`).

## 3. Lifecycle: startup, shutdown, timeouts, failure

### 3.1 Startup ordering

Shell: `DesktopBackendController.start(prepare)` serializes attempts (`_upstream/apps/desktop/src/backend-controller.ts:60-98`); `prepare` runs `manager.applyRelease()` (release metadata validation incl. `hostProtocolVersion === 4`, `_upstream/apps/desktop/src/release.ts:21-27`), then `createHost` builds `DesktopHostProcess`, then `host.start()` awaits `readyPromise`. On `ready` the shell immediately performs the cookie exchange `authenticateWebHost(ready.url)` — `fetch(url, { redirect: 'manual' })` and requires `303` + `set-cookie`, storing the cookie pair (`_upstream/apps/desktop/src/web-document.ts:43-50`, `_upstream/apps/desktop/src/main.ts:416-421`) — then records `hostUrl`/`injections`, connects the welcome/account backend, and only then publishes `{phase:'ready'}`. Host ordering before `ready`: `runProfile` resolves (webserver listening) → install `update-tasks` control → install `quit-inspection` control → mount office engine → install platform-session publisher → compute `authenticatedUrl` → send `ready` (`_upstream/apps/desktop-host/src/index.ts:92-104`).

### 3.2 Shutdown ordering and timeouts

`DesktopHostProcess.stop(requireGraceful = false)` (`_upstream/apps/desktop/src/host-process.ts:288-308`): set `stopping`, synthesize `platform-session: null`, send `{type:'shutdown'}` if connected; then escalate on timers — wait ≤ **10 000 ms** for child exit (`exitsWithin(exited, 10_000)`, `:295`), else `child.kill('SIGTERM')`; wait ≤ **5 000 ms**, else `child.kill('SIGKILL')`; wait ≤ **5 000 ms** more, else throw `dsh desktop host did not exit after SIGKILL` (`:297-301`). Host side: `shutdown` → `running?.shutdown.shutdown(0)` (the shared profile shutdown; its internal plugin-tree disposal budget is up to 5 s per `_upstream/apps/cli/reference/README.md:117`) → `shutdown-complete` → `process.disconnect()` (`_upstream/apps/desktop-host/src/index.ts:52-58`); an IPC `disconnect` (parent death) triggers the same `stop()` (`:91`). Application quit ordering: `before-quit` → optional quit confirmation (which ran `quit-inspection` under the 2 s deadline, §1.4) → `finishQuit()` → `backend.close()` → `host.stop(...)` → `app.quit()` (`_upstream/apps/desktop/src/main.ts:1185-1225`).

"Ready" means: the Host process booted the `desktop` profile to a listening webserver with all four control surfaces (update-tasks, quit-inspection, platform-session, office engine) installed, and the shell has (a) obtained its auth cookie and (b) captured the boot injection table — until then `backend.host` is `undefined` and the protocol handle answers `503` (`_upstream/apps/desktop/src/main.ts:626-628`, `_upstream/apps/desktop/src/backend-controller.ts:53`).

### 3.3 Update handoff gate (`requireGraceful`)

`stop(requireGraceful = true)` (update installation path, `_upstream/apps/desktop/src/main.ts:461-468,577-590`) additionally requires a clean outcome: no forced-kill (`graceful` deadline met), `child.exitCode === 0`, and `shutdownCompleted === true`; otherwise it throws `DesktopHostUncleanExitError('desktop update: Host did not complete graceful task teardown (exit …, signal …, shutdown acknowledged …, graceful deadline exceeded …)')` which refuses installation while still confirming exit (`_upstream/apps/desktop/src/host-process.ts:304-307`).

### 3.4 Fatal / recovery path

Any unexpected child outcome funnels into `fail(error)` once: `child.on('message')` protocol violation (`host-process.ts:206-212`), `fatal` IPC → `DesktopHostFatalError` (`:218`), child `error` event (`:225`), non-zero exit → `Error('dsh desktop host exited with <code>: <stderr tail>')`, zero/other exit → `Error('dsh desktop host stopped: <stderr tail>')` with a ≤ 64 KiB stderr tail (`:226-233`, `:51`). `fail()` rejects the ready promise and every pending control request with the first failure and reports `onFailure` exactly once (`:310-321`). `DesktopBackendController.failed()` then publishes `{phase:'error'}` and runs cleanup; the shell routes it to `reportFatal` (`_upstream/apps/desktop/src/main.ts:472-475`, `backend-controller.ts:138-148`). `reportFatal` → `DesktopFatalRecovery.report(error, source)` (`fatal-recovery.ts:65-104`): deduplicates to the first fatal, writes a crash report bounded by `CRASH_REPORT_WAIT_MS = 1_000` (`fatal-recovery.ts:20,106-119`), then shows a native dialog — special-casing `listen EADDRINUSE` — with buttons Exit / Restart / (non-EADDRINUSE) Disable third-party plugins, looping until a recovery operation succeeds. Crash reports (`_upstream/apps/desktop/src/crash-report.ts`): plain-text file `crash-<ISO-time>-<source>.log` in `app.getPath('logs')` with mode 0600, `CrashReportSource ∈ {host, web-boot, renderer, main}`, phase `startup|running`, the inspected error (≤ 256 KiB), the `hostDiagnostic` verbatim when the failure was a `DesktopHostFatalError` with one, and the renderer console error tail (≤ 64 KiB); 10 newest retained (`crash-report.ts:44-57,94-137,147-184`). `startup-error.ts:8-13` (`desktopErrorState`) renders serializable messages (AggregateError members joined by newlines) for UI. Web-boot failures reach the same path through `DESKTOP_IPC.bootFailed` (`_upstream/apps/desktop/src/main.ts:647-654`).

### 3.5 Port repair ownership rules (2026-10-10)

The private Rust/adapter handshake is an authenticated `<token> <generation>` header and is separate from upstream generation-4 message vocabulary. The stream decoder retains FIFO framing state across partial reads; a valid prefix cannot hide a malformed tail or partial EOF. A stale generation cannot satisfy current readiness/control requests.

Containment ownership, actual liveness and unresolved teardown are independent facts. A failed kill/wait retains the tree owner, revokes readiness and remains `stopping`; neither `failed` nor an error return is evidence of death. Restart requires containment-settled proof. Graceful update additionally retains the clean-exit/acknowledgement gate above. An explicit unresolved-Host Quit-anyway dialog may authorize only one generation-bound terminal exit, not recovery restart or update.

The source repair uses nonblocking native callback dialogs and generation-owned quit attempts. Dropped/cancelled callbacks authorize nothing; refused exit preserves policy/update owners for retry, and diagnostics drain only at committed exit. Source tests are not native callback, process-tree or release-install acceptance; see [the current repair ledger](../repair-ledger-2026-10-10.md).

## 4. Process-tree cleanup

The child is spawned with default `detached` (false) and default `windowsHide` (false — neither option appears in the spawn call, `_upstream/apps/desktop/src/host-process.ts:189-201`); there is **no job object, no process-group kill, and no `taskkill /T` in the runtime shell** (the `taskkill /T /F` occurrences live only in packaging scripts, e.g. `_upstream/apps/desktop/scripts/packaging-run.mjs:100`). Orphan prevention is therefore cooperative plus kill escalation: (a) the shell escalates `shutdown` → SIGTERM (10 s) → SIGKILL (5 s) → SIGKILL (5 s) on the direct child (`_upstream/apps/desktop/src/host-process.ts:294-301`); (b) the Host treats IPC `disconnect` — which fires when the shell dies or the channel drops — as a shutdown request and runs the same graceful `shutdown.shutdown(0)` teardown of its application tree (`_upstream/apps/desktop-host/src/index.ts:91,52-58`), and the underlying profile shutdown drains plugin-owned children with its own disposal budget (`_upstream/apps/cli/reference/README.md:117`); (c) `DesktopBackendController` prevents children outliving a window by serializing/cancelling attempts and running `cleanup` → `host.stop()` on `stop()`/`close()` (`_upstream/apps/desktop/src/backend-controller.ts:32,104-136`). Whether grandchildren of the Host survive a SIGKILL of the Host is **NOT DETERMINED FROM SOURCE** (no tree-kill in the runtime path) — the graceful `disconnect`/`shutdown` path is the only guarantee.

## 5. Behaviour-compatible Rust supervisor: required surface

1. Speak the exact message vocabulary of §1 over a JSON, FIFO, bidirectional channel with the same field names, including `update-tasks` responses carrying `active` (not `activeTasks`) and `quit-inspection` responses carrying `activeTasks` + `scheduledTasks` + optional `error`; mint `requestId` as a per-process monotone integer; enforce the same validation strictness (a malformed Host→shell frame is fatal and terminates the child). Version-pin `DESKTOP_HOST_PROTOCOL_VERSION = 4` and reject mismatched bundled release metadata (`release.ts:21-27`).
2. Reproduce the spawn contract of §2 exactly: `ELECTRON_RUN_AS_NODE=1` for the child (or an equivalent plain-Node runtime that can execute the same `lib/index.js`), `--expose-internals` first, positional argv `entry runtimeDir projectDir primaryRuntime [pnpm nodeBin]`, `cwd = projectDir`, stdio `ignore/pipe/capture/IPC`, and the package-manager environment block when `pnpm`/`nodeBin` are supplied (`node-environment.ts:12-18`, `apps/desktop-host/src/index.ts:31-41`).
3. Reproduce ordering of §3.1: run release preparation before spawn, treat the `ready` message as the readiness boundary, perform the launch-token → cookie exchange against `ready.url` immediately (expect `303` + `set-cookie`, `_upstream/apps/desktop/src/web-document.ts:43-50`), and hold all UI traffic until then (answer 503-equivalent while not ready, `main.ts:626-628`).
4. Enforce the deadlines: quit-inspection 2 000 ms (missing answer = unknown work = prompt before quitting, `quit-confirmation.ts:15-21`), update-tasks 10 000 ms (missing answer = do not authorize installation, `host-process.ts:237-247`), shutdown escalation 10 s / 5 s / 5 s (`host-process.ts:294-301`), crash-report write ≤ 1 000 ms before the recovery dialog (`fatal-recovery.ts:20`).
5. Track `shutdown-complete` and exit cleanliness exactly as §3.3: installation (or its Rust equivalent) must refuse after a forced kill, non-zero exit, or missing `shutdown-complete`, while still confirming the process exited.
6. Implement the failure funnel of §3.4: first-failure-wins reporting, `DesktopHostFatalError`-equivalent carrying the Host's `diagnostic` string verbatim to a crash report, stderr tail capture ≤ 64 KiB, and a deduplicating native recovery flow (crash report first, then Exit/Restart/Disable-plugins dialog with the EADDRINUSE special case).
7. Clean up the tree per §4: at minimum cooperative `disconnect`-driven teardown in the Host (do not close the IPC channel without a prior `shutdown` when a graceful stop is required), SIGTERM→SIGKILL escalation on the direct child, and — recommended for strict parity — a Windows job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` or `taskkill /T /F`, and POSIX process-group (`detached` + `kill(-pid)`) teardown, since the reference implementation has neither and orphans after SIGKILL are **NOT DETERMINED FROM SOURCE**.
8. Forward HTTP and WebSocket to the Host exactly as the Electron shell does (cookie injection, `Origin` rewrite for `ws://127.0.0.1/*`, `set-cookie` and hop-by-hop header stripping, `/plugins/` `cache-control: no-store`) and serve the packaged Web entry with the `__DSH_BOOT_READY__` head injection plus the `dshDesktopBoot` bridge returning `{injections, streamBaseUrl}` — see `ui-backend-protocol.md` §7.3 and `_upstream/apps/desktop/src/main.ts:617-676`, `_upstream/apps/desktop/src/web-document.ts`.
