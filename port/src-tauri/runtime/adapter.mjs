// Desktop-Host Node adapter — the single Node touch-point of the Rust port.
//
// WHY THIS FILE EXISTS: the dsh agent runtime is Node.js (ADR 0002). The Rust
// supervisor spawns this entry with the exact upstream spawn contract of
// `apps/desktop/src/host-process.ts` (`--expose-internals`, then
// `entry runtimeDir projectDir primaryRuntime [pnpm nodeBin]`, cwd = projectDir,
// env + `ELECTRON_RUN_AS_NODE=1`). It replaces `apps/desktop-host/src/index.ts`
// only in its transport: upstream speaks Node `process.send` IPC (fd 3); a Rust
// parent has none, so the identical Desktop-Host lifecycle protocol
// (generation 4, FIFO JSON) rides a newline-delimited JSON duplex socket whose
// name and one-time token arrive via `DSH_DESKTOP_CONTROL_SOCKET` /
// `DSH_DESKTOP_CONTROL_TOKEN`. Message names, fields, direction, ordering and
// failure behaviour are unchanged.
//
// Everything else follows `_upstream/apps/desktop-host/src/index.ts` line for
// line: `loadProfileDirectory` + `runProfile` from the unmodified upstream
// packages, memoized `shutdown`, quit inspection, update-task control, the
// platform-session publisher, and the `fatal` report on startup failure.
//
// NOT CARRIED HERE (packaging parity item): `installOfficeEngineResolution`
// and the `desktopOffice` skill plugin (`apps/desktop-host/src/office*.ts`) are
// private build output of `@deepseek-ai/dsh-desktop-host` and are not part of
// the lifecycle vocabulary; Office payload wiring belongs to the packaging lane.

import { connect } from 'node:net'
import { delimiter, join } from 'node:path'
import { inspect } from 'node:util'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Upper bound of the startup diagnostic carried over the channel (`index.ts:108`). */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

const socketName = process.env.DSH_DESKTOP_CONTROL_SOCKET
const token = process.env.DSH_DESKTOP_CONTROL_TOKEN
if (socketName === undefined || token === undefined) {
  console.error('dsh desktop adapter: DSH_DESKTOP_CONTROL_SOCKET / DSH_DESKTOP_CONTROL_TOKEN are required')
  process.exit(1)
}

/** One NDJSON line per message, FIFO per direction. */
const stream = connect(socketName)
let writeQueue = Promise.resolve()
const send = (message) => {
  writeQueue = writeQueue.then(() => new Promise((resolve) => {
    stream.write(`${JSON.stringify(message)}\n`, () => { resolve() })
  }))
  return writeQueue
}

/** Line reassembly over the socket stream. */
let buffer = ''
const handlers = []
stream.setEncoding('utf8')
stream.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (line === '') continue // transport acknowledgement line
    let message
    try { message = JSON.parse(line) } catch { continue } // host-side leniency mirrors index.ts
    for (const handler of handlers) handler(message)
  }
})

const runtimeDir = process.argv[2]
const projectDir = process.argv[3]
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

/** Quit inspection (transcribed from apps/desktop-host/src/quit-inspection.ts). */
function installDesktopQuitInspection(ctx) {
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  return async () => {
    if (stopped) throw new Error('desktop quit: Host is stopping')
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop quit: task services are unavailable')
    const liveAgents = agents.list()
    const activeTasks = hasDesktopActiveTasks(liveAgents, jobs)
    let scheduledTasks = false
    for (const agent of liveAgents) {
      const activity = await ctx.waterfall('workspace/session-activity', { sessionId: agent.id }, () => Promise.resolve([]))
      if (activity.some((entry) => entry.kind === 'schedule')) { scheduledTasks = true; break }
    }
    return { activeTasks, scheduledTasks }
  }
}

/** Shared update-restart work rule (transcribed from apps/desktop-host/src/update-tasks.ts). */
function hasDesktopActiveTasks(liveAgents, jobs) {
  return liveAgents.some((agent) => agent.status === 'running'
    || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
    || [undefined, ...liveAgents].some((agent) => jobs.list(agent?.id)
      .some((job) => job.status === 'running' || job.status === 'stopping'))
}

/** Update admission (transcribed from apps/desktop-host/src/update-tasks.ts). */
function installDesktopUpdateTaskControl(ctx) {
  let locked = false
  let lockGeneration = 0
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  const pendingRequests = new Set()
  ctx.on('connection/request', async (_request, response, next) => {
    if (locked) { response.writeHead(503); response.end(); return }
    const finished = Promise.withResolvers()
    pendingRequests.add(finished.promise)
    try { await next() } finally { pendingRequests.delete(finished.promise); finished.resolve() }
  })
  return async (action) => {
    if (stopped) throw new Error('desktop update: Host is stopping')
    if (action === 'unlock') { locked = false; lockGeneration++ }
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop update: task services are unavailable')
    if (action === 'lock') {
      locked = true
      const generation = ++lockGeneration
      await Promise.all(pendingRequests)
      if (stopped) throw new Error('desktop update: Host is stopping')
      if (generation !== lockGeneration) throw new Error('desktop update: admission lock was superseded')
    }
    return hasDesktopActiveTasks(agents.list(), jobs)
  }
}

/** Platform-session publisher (transcribed from apps/desktop-host/src/platform-session.ts). */
function installPlatformSessionPublisher(ctx, publish) {
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    const account = accountCtx.deepseekAccount
    accountCtx.effect(() => {
      const lifetime = new AbortController()
      const updates = (async () => {
        try {
          for await (const _state of account.watch(lifetime.signal)) {
            if (lifetime.signal.aborted) break
            const session = await account.getPlatformSession()
            if (!lifetime.signal.aborted) publish(session)
          }
        } catch {
          if (!lifetime.signal.aborted) accountCtx.logger('desktop-platform').warn('Account session subscription failed')
        } finally {
          if (!lifetime.signal.aborted) publish(null)
        }
      })()
      return async () => { lifetime.abort(); publish(null); void updates }
    })
  })
}

async function main() {
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    args: ['--no-open', '--port', process.env.DSH_DESKTOP_HOST_PORT ?? '19387'],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping
  const control = {}
  const stop = () => stopping ??= (async () => {
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    stream.end()
  })()
  handlers.push((message) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'quit-inspection') {
      if (!Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({
            type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      })().catch((error) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !Number.isSafeInteger(message.requestId)
      || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    const requestId = message.requestId
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action)
        await send({ type: 'update-tasks', requestId, active })
      } catch (error) {
        await send({
          type: 'update-tasks', requestId, active: true,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })().catch((error) => { console.error(error) })
  })
  stream.on('close', () => { void stop() })
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  installPlatformSessionPublisher(ctx, (session) => { void send({ type: 'platform-session', session }) })
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  void send({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() })
}

const boot = main()
stream.on('connect', () => {
  // Transport authentication preamble (not protocol generation 4).
  stream.write(`${token}\n`, () => {
    boot.catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      // The shell receives the complete inspected error here, not through stderr.
      const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
      void send({ type: 'fatal', message, diagnostic })
        .catch(() => {})
        .finally(() => {
          console.error(error)
          process.exitCode = 1
          stream.end()
        })
    })
  })
})
stream.on('error', (error) => {
  console.error('dsh desktop adapter: control socket failed', error)
  process.exitCode = 1
})
void resolveDshHome
