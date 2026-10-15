// Desktop-Host Node adapter — the single Node touch-point of the Rust port.
//
// WHY THIS FILE EXISTS: the dsh agent runtime is Node.js (ADR 0002). The Rust
// supervisor spawns this entry with the exact upstream spawn contract of
// `apps/desktop/src/host-process.ts` (`--expose-internals`, then
// `entry runtimeDir projectDir [primaryRuntime [pnpm nodeBin]]`, cwd = projectDir,
// env + `ELECTRON_RUN_AS_NODE=1`). An absent primary is omitted unless manager
// positions require an exact empty-string sentinel. Transport differs from
// upstream Node `process.send` IPC (fd 3): a Rust parent has none, so the
// preserved Desktop-Host lifecycle protocol
// (generation 4, FIFO JSON) rides a newline-delimited JSON duplex socket whose
// name and one-time token arrive via `DSH_DESKTOP_CONTROL_SOCKET` /
// `DSH_DESKTOP_CONTROL_TOKEN`. Message names, fields, direction, ordering and
// failure behaviour are unchanged.
//
// Profile boot, shutdown, quit inspection, update-task control and platform
// publication use the preserved upstream lifecycle. Office uses package-local
// assets and standalone Node; workspace dependencies require a separately
// staged, validated primary authoring runtime (see desktopOffice below).
//
// OFFICE COMPOSITION: upstream mounts `desktopOffice` from its own
// `apps/desktop-host/src/office.ts` and calls `installOfficeEngineResolution`
// from `office-engine.ts`. The packaged runtime ships only
// `@deepseek-ai/dsh-desktop-host/lib/index.js`, and that bundle ends in
// `export {}` — it exports neither `desktopOffice` nor
// `installOfficeEngineResolution`, so the port cannot reuse them. The two
// modules are transcribed here instead, against the same preserved unpacked
// runtime, and their plugin dependencies (`@deepseek-ai/dsh-skill-office`,
// `@deepseek-ai/dsh-tool-workspace-dependencies`, `@deepseek-ai/libreoffice-kit`)
// are the ones the packaged host already declares.
//
// `installOfficeEngineResolution` only rewrites engine resolution when
// `runtimeDir` sits inside an `app.asar` (`office-engine.ts:11-15`); the port
// ships an unpacked runtime, so it returns `undefined` and the preserved
// unpacked directory is used directly.

import { connect } from 'node:net'
import { realpathSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { basename, delimiter, dirname, isAbsolute, join, relative } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Upper bound of the startup diagnostic carried over the channel (`index.ts:108`). */
const MAX_FATAL_DIAGNOSTIC_CHARS = 64 * 1024

/**
 * The lifecycle generation this adapter speaks. Mirrors the Rust
 * `PROTOCOL_GENERATION`: the private transport preamble carries it and both
 * sides refuse a peer that presents anything else, so a swapped or stale staged
 * runtime cannot boot against a shell it does not understand.
 */
const PINNED_GENERATION = 4

/**
 * How long the adapter waits for the shell's acknowledgement of the transport
 * preamble. The profile must not boot on an unauthenticated channel, and the
 * wait must be finite: a peer that accepts the connection and never
 * acknowledges would otherwise hold startup forever. Overridable only so an
 * isolated fixture can exercise the deadline without waiting it out.
 */
const AUTH_ACK_TIMEOUT_MS = 10_000

/**
 * Maximum size of one shell→Host frame that has not been terminated by a
 * newline yet. The Rust shell sends small control requests, so a peer that
 * streams without a delimiter is a protocol violation, not a large frame: the
 * cap is enforced by dropping the connection instead of concatenating strings
 * until the process runs out of memory.
 */
const MAX_INBOUND_FRAME_CHARS = 1024 * 1024

/**
 * Maximum number of generation-4 frames retained while the profile is still
 * booting. The shell may legitimately send `shutdown` in the window between the
 * acknowledgement and handler registration; anything beyond this bound means the
 * peer is flooding an unauthenticated-then-unbooted channel.
 */
const MAX_PREBOOT_QUEUE = 64

/**
 * How long a refused run waits for the profile it already started to shut down
 * before exiting. A profile shutdown ends the process on its own terms (code 0),
 * which would erase the failure the shell needs to report, so the refused run
 * bounds that wait and then exits non-zero itself.
 */
const FATAL_EXIT_TIMEOUT_MS = 2000

/**
 * Maximum number of outbound frames queued behind the socket. When the shell
 * stops reading, the adapter must not grow an unbounded promise chain: sends
 * past the cap wait for drain instead.
 */
const MAX_WRITE_QUEUE_DEPTH = 64

/**
 * How long the whole outbound queue may wait for one socket drain. This is a
 * budget for the *queue*, not for each frame: sends are serialized, so a
 * per-frame deadline would multiply by the queue depth. Without a bound a shell
 * that opens the pipe and never reads would hold `send()` — and every
 * `await send(...)` in the control paths — pending forever.
 */
const WRITE_DRAIN_TIMEOUT_MS = 2000

const socketName = process.env.DSH_DESKTOP_CONTROL_SOCKET
const token = process.env.DSH_DESKTOP_CONTROL_TOKEN
if (!socketName || !token) {
  console.error('dsh desktop adapter: DSH_DESKTOP_CONTROL_SOCKET / DSH_DESKTOP_CONTROL_TOKEN are required')
  process.exit(1)
}
// The generation is pinned, not negotiated: a parent that pins a different
// lifecycle generation gets a refusal before any profile is loaded, rather than
// a boot whose frames neither side can interpret.
const pinnedGeneration = String(PINNED_GENERATION)
const generation = process.env.DSH_DESKTOP_CONTROL_GENERATION
if (generation !== pinnedGeneration) {
  const shown = generation === undefined ? '(unset)' : JSON.stringify(String(generation).slice(0, 32))
  console.error(`dsh desktop adapter: DSH_DESKTOP_CONTROL_GENERATION must be the pinned supported generation ${pinnedGeneration}; got ${shown}`)
  process.exit(1)
}

/** Validate launch paths before opening the control socket or loading a profile. */
function launchDirectory(value, name) {
  if (typeof value !== 'string' || value.trim() === '' || !isAbsolute(value)) {
    throw new Error(`dsh desktop adapter: ${name} must be an absolute directory`)
  }
  if (!statSync(value).isDirectory()) {
    throw new Error(`dsh desktop adapter: ${name} is not a directory: ${value}`)
  }
  return value
}

const runtimeDir = launchDirectory(process.argv[2], 'runtimeDir')
const projectDir = launchDirectory(process.argv[3], 'projectDir')
const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
if (!statSync(installAnchor).isFile()) throw new Error(`dsh desktop adapter: missing install anchor: ${installAnchor}`)
// An empty positional placeholder preserves optional pnpm/nodeBin positions.
const primaryRuntimeOverride = process.argv[4] !== undefined && process.argv[4] !== ''
const primaryRuntime = primaryRuntimeOverride
  ? launchDirectory(process.argv[4], 'primaryRuntime')
  : join(runtimeDir, 'primary-runtime')

/**
 * Bounded, backpressure-aware writer for the control socket.
 *
 * `write()` reporting `false` means the socket buffer is full: the frame is
 * queued in the kernel, but further writes must wait for `drain`. Sends are
 * serialized through one chain, so at most one frame is ever in flight and the
 * queue depth is an explicit, observable bound rather than one pending promise
 * per frame.
 *
 * Two bounds apply, and they are deliberately different in kind:
 * - [`MAX_WRITE_QUEUE_DEPTH`] bounds how many frames may be waiting, so a shell
 *   that never reads cannot grow the queue without limit;
 * - [`WRITE_DRAIN_TIMEOUT_MS`] bounds how long the **whole queue** may spend
 *   waiting for one drain, not each frame. Because sends are serialized, a
 *   per-frame deadline would multiply: 64 queued frames x 2 s would hold the
 *   process for over two minutes, and the bound would grow with the very
 *   backlog it is meant to bound. The first frame that misses the shared
 *   deadline fails the rest of the queue with it.
 *
 * A shell that never reads therefore stalls for at most one
 * `WRITE_DRAIN_TIMEOUT_MS`, and every frame queued behind a hung frame settles
 * with it instead of waiting its own turn.
 */
class ControlWriter {
  #stream
  #chain = Promise.resolve()
  #depth = 0
  /** When the current drain began waiting; `undefined` when nothing waits. */
  #drainDeadline

  constructor(stream) { this.#stream = stream }

  /** Frames accepted by `send` and not yet resolved. */
  get depth() { return this.#depth }

  /**
   * Queue one frame; resolves once the socket has accepted it.
   * @param {string} frame - One NDJSON line including its newline.
   * @returns {Promise<void>} Resolves after the socket accepted the frame.
   */
  send(frame) {
    if (this.#depth >= MAX_WRITE_QUEUE_DEPTH) {
      return Promise.reject(new Error(
        `control socket write queue is full (${String(MAX_WRITE_QUEUE_DEPTH)} frames pending)`))
    }
    this.#depth += 1
    const write = async () => {
      try {
        if (this.#stream.destroyed) throw new Error('control socket is closed')
        if (this.#stream.write(frame)) {
          // A successful write clears any drain window: the socket is flowing.
          this.#drainDeadline = undefined
          return
        }
        await this.#drain()
      } finally {
        this.#depth -= 1
        if (this.#depth === 0) this.#drainDeadline = undefined
      }
    }
    // Keep the chain alive across a failed frame so one transport error does not
    // strand every later send.
    const next = this.#chain.then(write, write)
    this.#chain = next.catch(() => undefined)
    return next
  }

  #drain() {
    return new Promise((resolve, reject) => {
      const stream = this.#stream
      // The first waiter starts the clock; later frames queued behind it share
      // the same deadline instead of each starting their own.
      const started = this.#drainDeadline ??= Date.now()
      const remaining = WRITE_DRAIN_TIMEOUT_MS - (Date.now() - started)
      if (remaining <= 0) {
        reject(new Error(`control socket did not drain within ${String(WRITE_DRAIN_TIMEOUT_MS)} ms`))
        return
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`control socket did not drain within ${String(WRITE_DRAIN_TIMEOUT_MS)} ms`))
      }, remaining)
      const cleanup = () => {
        clearTimeout(timer)
        stream.off('drain', onDrain)
        stream.off('error', onError)
        stream.off('close', onClose)
      }
      const onDrain = () => { cleanup(); resolve() }
      const onError = (error) => { cleanup(); reject(error) }
      const onClose = () => { cleanup(); reject(new Error('control socket closed before it drained')) }
      stream.once('drain', onDrain)
      stream.once('error', onError)
      stream.once('close', onClose)
    })
  }
}

const stream = connect(socketName)
const writer = new ControlWriter(stream)
/** One NDJSON line per message, FIFO per direction. */
const send = (message) => writer.send(`${JSON.stringify(message)}\n`)
/**
 * Fire-and-forget send that consumes every rejection. A control frame must
 * never surface as an unhandled rejection: the queue bound, a closed socket and
 * a drain deadline all reject, and an unhandled rejection is fatal to the
 * process on this Node line.
 * @param {unknown} message - One protocol frame.
 * @returns {Promise<void>} Settles with the send.
 */
const sendQuietly = (message) => {
  try {
    return send(message).catch((error) => {
      console.error('dsh desktop adapter: control frame was not delivered', error)
    })
  } catch (error) {
    console.error('dsh desktop adapter: control frame was not delivered', error)
    return Promise.resolve()
  }
}

/** First protocol or transport failure; a failed run never boots and never resumes. */
let failure
/** The shell acknowledged the private transport preamble. */
let acknowledged = false
/** The profile has been started; teardown has something to own. */
let booted = false
/** The connection is gone (peer close or socket error). */
let closed = false
/** The application promise of the current boot, once `runProfile` was called. */
let application
/** Installations of the two control surfaces, filled in as the profile boots. */
const control = {}
/** Idempotent teardown for this connection. */
let stopping
/** Registrations that answer generation-4 requests (installed during boot). */
const handlers = []
/** Frames that arrived after authentication but before handlers existed. */
const preBootFrames = []
/** Resolved when the acknowledgement arrives, the peer leaves, or the run fails. */
const authenticated = Promise.withResolvers()
/** Bound for the acknowledgement wait, overridable for isolated fixtures only. */
const ackTimeoutMs = (() => {
  const override = Number(process.env.DSH_ADAPTER_AUTH_ACK_TIMEOUT_MS)
  return Number.isSafeInteger(override) && override > 0 ? override : AUTH_ACK_TIMEOUT_MS
})()

/**
 * Whether `message` is one of the three generation-4 shell→Host requests. The
 * check mirrors the Rust `ShellMessage` decode: a peer that sends anything else
 * is violating the protocol and is refused instead of being ignored.
 * @param {unknown} message - One parsed JSON line.
 * @returns {boolean}
 */
function isDesktopHostRequest(message) {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return false
  if (message.type === 'shutdown') return true
  if (!Number.isSafeInteger(message.requestId)) return false
  if (message.type === 'quit-inspection') return true
  if (message.type === 'update-tasks') {
    return ['inspect', 'lock', 'unlock'].includes(String(message.action))
  }
  return false
}

/**
 * Route one authenticated generation-4 request. Frames that arrive before the
 * boot registered its handlers are queued (bounded), because the shell may
 * legitimately send `shutdown` immediately after the acknowledgement.
 * @param {object} message - One validated request.
 */
function dispatch(message) {
  if (handlers.length === 0) {
    if (preBootFrames.length >= MAX_PREBOOT_QUEUE) {
      refuseProtocol(new Error('control frames arrived faster than the profile could boot'))
      return
    }
    preBootFrames.push(message)
    return
  }
  for (const handler of handlers) handler(message)
}

/**
 * Refuse a protocol violation: report it to the shell as a generation-4 `fatal`
 * frame, release the socket and exit non-zero. The development path must not
 * continue on a channel whose framing is already known to be broken.
 * @param {Error} error - The violation.
 */
function refuseProtocol(error) {
  if (failure !== undefined) return
  failure = error
  reportFatal(error)
}

/** Line reassembly over the socket: bounded, so a delimiter-free peer cannot
 *  make the adapter buffer without limit. */
let buffer = ''
stream.setEncoding('utf8')
stream.on('data', (chunk) => {
  buffer += chunk
  for (;;) {
    const end = buffer.indexOf('\n')
    if (end < 0) break
    const line = buffer.slice(0, end)
    buffer = buffer.slice(end + 1)
    if (!acknowledged) {
      // The shell acknowledges the private preamble with exactly one empty line.
      if (line === '') {
        acknowledged = true
        authenticated.resolve()
        continue
      }
      refuseProtocol(new Error('control channel acknowledgement is not the empty transport line'))
      return
    }
    if (line === '') continue // transport padding carries no protocol meaning
    let message
    try {
      message = JSON.parse(line)
    } catch {
      refuseProtocol(new Error('control frame is not valid JSON'))
      return
    }
    if (!isDesktopHostRequest(message)) {
      refuseProtocol(new Error('control frame is not a known desktop-host request'))
      return
    }
    if (failure !== undefined) return
    dispatch(message)
  }
  if (buffer.length > MAX_INBOUND_FRAME_CHARS) {
    // A shell→Host frame this large without a delimiter is a protocol
    // violation, and holding it would grow this process without limit.
    refuseProtocol(new Error(`control frame exceeded ${String(MAX_INBOUND_FRAME_CHARS)} characters without a newline`))
  }
})

/**
 * Locate the archive containing a packaged runtime.
 *
 * Transcribed from `apps/desktop-host/src/office-engine.ts:12-15`.
 * @param {string} runtimeDir - Prepared or ASAR-contained runtime directory.
 * @returns {string | undefined} Parent archive path, or undefined for a
 *   prepared directory.
 */
function runtimeArchivePath(runtimeDir) {
  const parent = dirname(runtimeDir)
  return basename(parent) === 'app.asar' ? parent : undefined
}

/**
 * Keep engine executable and resource paths usable by native child processes
 * outside Electron.
 *
 * Transcribed from `apps/desktop-host/src/office-engine.ts:23-44`. A no-op for
 * an unpacked runtime, which is what the port ships.
 * @param {string} runtimeDir - Prepared or ASAR-contained dsh runtime directory.
 * @returns {import('node:module').ModuleHooks | undefined} Installed resolver,
 *   or undefined for a non-ASAR runtime.
 */
function installOfficeEngineResolution(runtimeDir) {
  if (runtimeArchivePath(runtimeDir) === undefined) return undefined
  const root = realpathSync(runtimeDir)
  const archive = dirname(root)
  const source = pathToFileURL(join(root, 'node_modules', '@deepseek-ai', 'libreoffice-kit-')).href
  const destination = pathToFileURL(join(`${archive}.unpacked`, relativeFrom(archive, root), 'node_modules', '@deepseek-ai', 'libreoffice-kit-')).href
  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      if (!/^@deepseek-ai\/libreoffice-kit-(?:darwin|win32|linux)-/u.test(specifier)) return resolved
      const canonical = pathToFileURL(realpathSync(fileURLToPath(resolved.url))).href
      if (!canonical.startsWith(source)) {
        if (canonical.startsWith(pathToFileURL(`${archive}/`).href)) {
          throw new Error(`desktop Office engine resolved outside the runtime package directory: ${resolved.url}`)
        }
        return resolved
      }
      const physical = realpathSync(fileURLToPath(destination + canonical.slice(source.length)))
      return { ...resolved, url: pathToFileURL(physical).href }
    },
  })
}

/**
 * Desktop Office skills and bundled authoring dependencies.
 *
 * Office skills use package-local assets and the Host's standalone Node.
 * The primary authoring payload, when supplied, is validated before activation.
 * A missing default payload explicitly refuses workspace dependency support;
 * it does not register a tool pointing at absent files or abort basic boot.
 * @param {object} ctx - Profile scope.
 * @param {{ source: string, root: string, runtimeDir: string }} config - Bundled
 *   payload source and Harness-home installation root.
 */
async function desktopOffice(ctx, config) {
  const officeSkills = await import('@deepseek-ai/dsh-skill-office')
  const workspaceDependencies = await import('@deepseek-ai/dsh-tool-workspace-dependencies')
  let primaryPresent = false
  try {
    primaryPresent = statSync(join(config.source, 'runtime.json')).isFile()
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (primaryPresent) {
    await workspaceDependencies.resolvePrimaryRuntime(config.source)
    await ctx.plugin(workspaceDependencies, config)
  } else if (primaryRuntimeOverride) {
    throw new Error(`dsh desktop adapter: primaryRuntime has no runtime.json: ${config.source}`)
  } else {
    console.warn(`dsh desktop adapter: Office workspace dependencies unavailable; ${config.source} is not staged. load_workspace_dependencies is not registered.`)
  }
  const archive = runtimeArchivePath(config.runtimeDir) === undefined
    ? undefined
    : dirname(realpathSync(config.runtimeDir))
  const manifest = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))
  const packageRoot = dirname(archive === undefined
    ? manifest
    : join(`${archive}.unpacked`, relativeFrom(archive, manifest)))
  await ctx.plugin(officeSkills, {
    node: process.execPath,
    cli: join(packageRoot, 'lib', 'cli.js'),
  })
}

/** `path.relative` bound for the two transcriptions that need it. */
function relativeFrom(from, to) {
  return relative(from, to)
}
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

/**
 * Platform-session publisher (transcribed from
 * apps/desktop-host/src/platform-session.ts at dsh-v0.2.1-alpha.3).
 *
 * Identity-only account wakeups are subscribed (`watch(signal, true)`, so a
 * profile-ID change surfaces as a session re-publication), and the disposer is
 * asynchronous: it aborts the lifetime, publishes the private-session clear,
 * and then AWAITS the subscription loop's unwind, so no in-flight session
 * publication can survive disposal.
 */
function installPlatformSessionPublisher(ctx, publish) {
  ctx.inject(['deepseekAccount'], (accountCtx) => {
    const account = accountCtx.deepseekAccount
    accountCtx.effect(() => {
      const lifetime = new AbortController()
      const updates = (async () => {
        try {
          for await (const _state of account.watch(lifetime.signal, true)) {
            if (lifetime.signal.aborted) break
            const session = await account.getPlatformSession()
            // Disposal can abort during the credential read.
            if (!lifetime.signal.aborted) publish(session)
          }
        } catch {
          if (!lifetime.signal.aborted) accountCtx.logger('desktop-platform').warn('Account session subscription failed')
        } finally {
          if (!lifetime.signal.aborted) publish(null)
        }
      })()
      return async () => {
        lifetime.abort()
        publish(null)
        await updates
      }
    })
  })
}

function installControlRequestHandlers() {
  handlers.push((message) => {
    if (message.type === 'shutdown') { void stop().catch(() => {}); return }
    if (message.type === 'quit-inspection') {
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
}

/**
 * The loopback application origin the shell opens for this run.
 *
 * The Host reports the protocol its listener actually speaks: `webServer.protocol`
 * is `'http:'` for a plain listener and `'https:'` when the listener serves TLS,
 * so the URL is composed from that value rather than assumed. Only those two
 * schemes are accepted -- an unexpected value means the listener is not what the
 * shell believes, and publishing a guessed origin would open the wrong scheme.
 * The port is validated the same way: the invocation asks for port 0 and the Host
 * reports the port the operating system actually assigned.
 *
 * @param webServer - the Host's `webServer` service.
 * @returns the `scheme//127.0.0.1:port` origin, with no path and no token.
 */
function loopbackApplicationOrigin(webServer) {
  const protocol = webServer?.protocol
  if (protocol !== 'http:' && protocol !== 'https:') {
    // The refusal names the reason and never the observed value: this text reaches
    // startup diagnostics, and a malformed or substituted service must not be able
    // to place arbitrary content there.
    throw new Error('dsh desktop: the Host webserver reported an unsupported protocol; refusing to publish an application URL')
  }
  const port = webServer?.port
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('dsh desktop: the Host webserver reported an unusable port; refusing to publish an application URL')
  }
  return `${protocol}//127.0.0.1:${String(port)}`
}

async function main() {
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles: [],
    // `--host 127.0.0.1 --port 0` is the invocation the Desktop Host uses: a
    // loopback listener on an OS-assigned ephemeral port. A fixed port collides
    // with whichever process already owns it, and the shell learns the real
    // origin from the `ready` frame anyway.
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
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
  booted = true
  // Registered before the profile is awaited: the shell may send `shutdown`
  // immediately after the acknowledgement (it cancels startup that way), and a
  // frame that arrives before its handler would otherwise be held until boot.
  installControlRequestHandlers()
  const queued = preBootFrames.splice(0)
  const { ctx } = await application
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  // Office composition (`index.ts:95-99`), before the platform-session
  // publisher and `ready`, exactly as upstream orders it.
  installOfficeEngineResolution(runtimeDir)
  await ctx.plugin(desktopOffice, {
    runtimeDir,
    source: primaryRuntime,
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  installPlatformSessionPublisher(ctx, (session) => { sendQuietly({ type: 'platform-session', session }) })
  const url = ctx.connection.authenticatedUrl(loopbackApplicationOrigin(ctx.webServer))
  sendQuietly({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections() })
  // Frames that raced the acknowledgement are answered now that the control
  // surfaces exist. They are delivered in wire order.
  for (const message of queued) {
    if (failure !== undefined || stopping !== undefined) break
    dispatch(message)
  }
}

/**
 * Release the control socket without depending on the peer: the queued bytes
 * are flushed and the handle is then destroyed. A shell that keeps its end open
 * must not be able to keep this process alive after its own teardown.
 */
function endThenDestroy() {
  try {
    if (stream.destroyed) return
    stream.end(() => {
      try { stream.destroy() } catch { /* the socket is already gone */ }
    })
  } catch {
    try { stream.destroy() } catch { /* the socket is already gone */ }
  }
}

/**
 * Release the profile if a boot owns one. Rejections are consumed: a startup
 * failure and a protocol refusal must both be able to reach this without
 * surfacing an unhandled rejection.
 * @returns {Promise<void>}
 */
async function shutdownApplication() {
  if (application === undefined) return
  try {
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
  } catch (error) {
    console.error(error)
  }
}

/**
 * Idempotent teardown for this connection. Every rejection is consumed here:
 * the socket is released unconditionally, so a rejected shutdown or
 * acknowledgement can never leave the control socket open behind a process that
 * is exiting.
 * @param {boolean} [complete] Whether to acknowledge a requested shutdown. A
 *   refusal path must not emit an unrequested `shutdown-complete`.
 * @returns {Promise<void>} Settles when the socket is released.
 */
function stop(complete = true) {
  if (stopping !== undefined) return stopping
  stopping = (async () => {
    await shutdownApplication()
    if (complete && booted) {
      try { await send({ type: 'shutdown-complete' }) } catch (error) { console.error(error) }
    }
    endThenDestroy()
  })()
  return stopping
}

/**
 * Start the Host, but only on an authenticated channel and only within the
 * acknowledgement deadline. A peer that never acknowledges, a refusal, or a
 * connection that closed during authentication all end the process without
 * loading a profile (`ReportFatal` → `fatal` frame + non-zero exit).
 * @returns {Promise<void>}
 */
async function boot() {
  let timer
  try {
    // Private transport preamble (not protocol generation 4): the one-time
    // token and the pinned lifecycle generation. Queued through the same writer
    // as protocol frames so it always precedes them and inherits the same drain
    // bound.
    await writer.send(`${token} ${pinnedGeneration}\n`)
    await Promise.race([
      authenticated.promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`control channel did not acknowledge the transport preamble within ${String(ackTimeoutMs)} ms`))
        }, ackTimeoutMs)
      }),
    ])
  } catch (error) {
    reportFatal(error)
    return
  } finally {
    clearTimeout(timer)
  }
  // Nothing may boot behind a refusal or a connection the peer already closed.
  if (failure !== undefined || stopping !== undefined || closed) return
  try {
    await main()
  } catch (error) {
    reportFatal(error)
  }
}

stream.on('connect', () => { void boot() })
// The peer closing is the one teardown request that has no frame: release the
// profile (if it booted) and the socket. Rejections are consumed.
stream.on('close', () => {
  closed = true
  authenticated.resolve()
  if (failure === undefined && !acknowledged) {
    // A channel that was never acknowledged cannot have hosted a Host: this is
    // a failed launch, not a clean end.
    console.error('dsh desktop adapter: control channel closed before it was acknowledged')
    process.exitCode = 1
  }
  void stop().catch(() => {})
})

/**
 * Report a startup failure to the shell over the control channel, then exit
 * non-zero. The shell receives the complete inspected error here, not through
 * stderr: stderr bytes and this frame race and the shell reports the first
 * failure it sees (`apps/desktop-host/src/index.ts:113-120`).
 *
 * The socket is released in a `finally`, after the failure frame has been
 * queued, so the shell can read it; every rejection is consumed.
 * @param {unknown} error - The failure to report.
 */
function reportFatal(error) {
  const message = error instanceof Error ? error.message : String(error)
  const diagnostic = inspect(error, { depth: 4, maxArrayLength: 50 }).slice(0, MAX_FATAL_DIAGNOSTIC_CHARS)
  console.error(`dsh desktop adapter: ${message}`)
  process.exitCode = 1
  sendQuietly({ type: 'fatal', message, diagnostic })
    .catch(() => {})
    .finally(() => {
      // Release the socket: the shell reads the failure frame above, and the
      // refusal must not keep this process alive if the peer never closes.
      endThenDestroy()
      // A startup failure or protocol refusal owns the profile it already
      // started: release it without emitting an unrequested `shutdown-complete`,
      // then exit non-zero. The exit is forced (bounded) because the profile's
      // own shutdown path exits with code 0, which would erase this failure.
      const bail = setTimeout(() => process.exit(1), FATAL_EXIT_TIMEOUT_MS)
      void stop(false)
        .catch(() => {})
        .finally(() => {
          clearTimeout(bail)
          process.exit(1)
        })
    })
}
stream.on('error', (error) => {
  console.error('dsh desktop adapter: control socket failed', error)
  process.exitCode = 1
  closed = true
  // Wake a pending authentication wait rather than leaving the boot parked on a
  // socket that will never answer.
  authenticated.resolve()
})
void resolveDshHome
