/**
 * Updates plugin wiring, driven through the plugin's own asynchronous callbacks.
 *
 * These cases exercise `apply(ctx)` rather than the pure transitions: the
 * registered effect subscribes to `dsh://update/state` and issues the two
 * startup reads, and the injected `check`/`open`/`selectChannel` handlers run
 * against a deferred bridge so each operation's completion order is chosen by
 * the test. The two presentational modules are replaced because the assertions
 * are about ownership, ordering and candidate invalidation, not about rendering.
 *
 * This spec needs module mocking and a JSX-capable loader, so it runs under
 * `pnpm test` (vitest) only; `run-transitions.mjs` executes the sibling
 * transition spec in-process under the Windows sandbox.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DesktopUpdatePresentation } from '../../../desktop-bridge/protocol.ts'
import { canChangeChannel, canCheck, canOpen, hasCandidate } from '../../src/client/state.ts'
import type { UpdatesSectionInjected, UpdatesSectionState } from '../../src/client/types.ts'

const STABLE_FEED = 'https://updates.example.com/stable.json'
const BETA_FEED = 'https://updates.example.com/beta.json'
const INSTALLED_VERSION = '0.1.7-rc.2'

interface Slot {
  readonly promise: Promise<unknown>
  readonly resolve: (value: unknown) => void
  readonly reject: (error: unknown) => void
}

/** A promise whose settlement the test controls. */
function deferred(): Slot {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/** Mutable stand-in for the shell, shared with the mocked desktop bridge. */
const backend = vi.hoisted(() => ({
  settings: {} as Record<string, string>,
  version: '0.1.7-rc.2',
  writes: [] as { key: string; value: unknown }[],
  calls: { check: 0, open: 0, status: 0 },
  listeners: new Set<(payload: never) => void>(),
  statusQueue: [] as unknown[],
  checkQueue: [] as unknown[],
  openQueue: [] as unknown[],
  setQueue: [] as unknown[],
  listQueue: [] as unknown[],
  /** The persisted settings store; a write reaches it only when it succeeds. */
  persist(request: { key: string; value: unknown }) {
    backend.settings = { ...backend.settings, [request.key]: String(request.value) }
  },
}))

/** The next queued slot, or an immediate answer when the queue is empty. */
function respond(queue: unknown[], immediate: unknown): Promise<unknown> {
  const slot = queue.shift()
  return slot === undefined ? Promise.resolve(immediate) : (slot as Slot).promise
}

vi.mock('../../../desktop-bridge/index.ts', () => ({
  desktop: {
    shellAppInfo: () => Promise.resolve({ version: backend.version }),
    settingsList: () => respond(backend.listQueue, backend.settings),
    settingsSet: (request: { key: string; value: unknown }) => {
      backend.writes.push(request)
      const slot = backend.setQueue.shift()
      if (slot === undefined) {
        backend.persist(request)
        return Promise.resolve(undefined)
      }
      // A rejected write persists nothing, exactly like the shell's `settings_set`.
      return (slot as Slot).promise.then(() => { backend.persist(request) })
    },
    updateStatus: () => {
      backend.calls.status += 1
      return respond(backend.statusQueue, { phase: 'idle' })
    },
    updateCheck: () => {
      backend.calls.check += 1
      return respond(backend.checkQueue, { phase: 'idle' })
    },
    updateOpen: () => {
      backend.calls.open += 1
      return respond(backend.openQueue, undefined)
    },
    onUpdateState: async (listener: (payload: never) => void) => {
      backend.listeners.add(listener)
      return () => { backend.listeners.delete(listener) }
    },
  },
}))
vi.mock('../../src/client/UpdatesSection.tsx', () => ({ UpdatesSection: () => null }))
vi.mock('../../src/client/SettingsOnlyLauncher.tsx', () => ({ SettingsOnlyLauncher: () => null }))

interface Registered {
  readonly name: string
  readonly inject?: () => UpdatesSectionInjected
}

interface Mounted {
  readonly state: () => UpdatesSectionState
  readonly actions: UpdatesSectionInjected
  readonly disposers: (() => void)[]
}

/** Register the plugin on a minimal Cordis context and return its injected face. */
async function mount(): Promise<Mounted> {
  vi.resetModules()
  const { apply } = await import('../../src/client/index.ts')
  const registered: Registered[] = []
  const disposers: (() => void)[] = []
  const context = {
    locale: { bind: () => (key: string) => key, register: () => () => undefined },
    effect: (run: () => unknown) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    slots: {
      inject: (_name: string, contribute: () => Registered) => { registered.push(contribute()) },
      register: (meta: Registered) => meta,
    },
  }
  apply(context as unknown as Context)
  const section = registered.find(entry => entry.name === 'settings.section')
  const actions = section?.inject?.()
  if (actions === undefined) throw new Error('the Updates section was not registered')
  return {
    state: () => actions.hooks.updates.getSnapshot(),
    actions,
    disposers,
  }
}

/** Deliver one shell presentation through the registered `dsh://update/state` listener. */
function publish(update: DesktopUpdatePresentation): void {
  for (const listener of backend.listeners) listener(update as never)
}

/** Let every queued microtask and the plugin's `await` chain settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve()
  await new Promise(resolve => setTimeout(resolve, 0))
}

beforeEach(() => {
  backend.settings = { 'updates.channel': 'stable', 'updates.feed-url': STABLE_FEED, 'updates.feed-url-beta': BETA_FEED }
  backend.version = INSTALLED_VERSION
  backend.writes = []
  backend.calls = { check: 0, open: 0, status: 0 }
  backend.listeners = new Set()
  backend.statusQueue = []
  backend.checkQueue = []
  backend.openQueue = []
  backend.setQueue = []
  backend.listQueue = []
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('a check and a channel save settle in either order', () => {
  it('keeps the switched channel and the invalidated candidate when the check settles first', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'available', version: '0.1.8' })
    await settle()

    const check = deferred()
    backend.checkQueue.push(check)
    const save = deferred()
    backend.setQueue.push(save)
    const reread = deferred()
    backend.listQueue.push(reread)
    const checking = actions.check()
    const switching = actions.selectChannel('beta')
    await settle()
    expect(state().ownership.check).not.toBeNull()
    expect(state().ownership.channel).not.toBeNull()

    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    // The result belongs to the previous channel and is discarded.
    expect(state().update.phase).toBe('available')
    save.resolve(undefined)
    await settle()
    reread.resolve({ ...backend.settings, 'updates.feed-url-beta': BETA_FEED })
    await settle()
    await Promise.all([checking, switching])

    expect(state().channel).toBe('beta')
    expect(state().feed).toBe(BETA_FEED)
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(hasCandidate(state())).toBe(false)
    expect(state().ownership.check).toBeNull()
    expect(state().ownership.channel).toBeNull()
    expect(state().error).toBeNull()
  })

  it('keeps the switched channel and the invalidated candidate when the save settles first', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'available', version: '0.1.8' })
    await settle()

    const check = deferred()
    backend.checkQueue.push(check)
    const save = deferred()
    backend.setQueue.push(save)
    const reread = deferred()
    backend.listQueue.push(reread)
    const checking = actions.check()
    const switching = actions.selectChannel('beta')
    await settle()

    save.resolve(undefined)
    await settle()
    reread.resolve({ ...backend.settings, 'updates.feed-url-beta': BETA_FEED })
    await settle()
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)

    // The check that was already in flight cannot restore the invalid candidate.
    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await Promise.all([checking, switching])

    expect(state().channel).toBe('beta')
    expect(state().feed).toBe(BETA_FEED)
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(canOpen(state())).toBe(false)
    expect(state().error).toBeNull()
    expect(state().ownership.check).toBeNull()
    expect(state().ownership.channel).toBeNull()
  })

  it('records only the switch the shell persisted', async () => {
    const { state, actions } = await mount()
    await settle()
    backend.writes = []
    await actions.selectChannel('beta')
    await settle()
    expect(backend.writes).toHaveLength(1)
    expect(backend.writes[0]).toEqual({ key: 'updates.channel', value: 'beta' })
    expect(state().channel).toBe('beta')
    expect(state().error).toBeNull()
  })

  it('restores the previous channel when the save is refused', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'available', version: '0.1.8' })
    await settle()
    const refused = deferred()
    backend.setQueue.push(refused)
    const switching = actions.selectChannel('beta')
    await settle()
    refused.reject(new Error('settings_set refused'))
    await settle()
    await switching
    expect(state().channel).toBe('stable')
    expect(state().error).toBe('channel')
    // The rejected write persisted nothing, so the candidate stands.
    expect(backend.settings['updates.channel']).toBe('stable')
    expect(state().update.phase).toBe('available')
    expect(canOpen(state())).toBe(true)
  })

  it('keeps the persisted switch when the refresh that names its feed fails', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const save = deferred()
    backend.setQueue.push(save)
    const reread = deferred()
    backend.listQueue.push(reread)
    const switching = actions.selectChannel('beta')
    await settle()

    save.resolve(undefined)
    await settle()
    // The shell wrote the preference and invalidated its own candidate.
    expect(backend.settings['updates.channel']).toBe('beta')
    expect(state().update.phase).toBe('idle')
    expect(state().channel).toBe('beta')

    reread.reject(new Error('settings_list refused'))
    await settle()
    await switching

    expect(state().channel).toBe('beta')
    // The feed is configured per channel, so an unread refresh leaves it unknown
    // rather than showing the previous channel's.
    expect(state().feed).toBeNull()
    expect(state().error).toBe('channel')
    // The invalidated candidate must not come back with the failed refresh.
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(hasCandidate(state())).toBe(false)
    expect(state().ownership.channel).toBeNull()
  })

  it('keeps a candidate the shell published after the write', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const save = deferred()
    backend.setQueue.push(save)
    const reread = deferred()
    backend.listQueue.push(reread)
    const switching = actions.selectChannel('beta')
    await settle()
    save.resolve(undefined)
    await settle()

    // The shell admits a candidate for the new channel while the feed is read.
    publish({ phase: 'available', version: '0.2.0' })
    await settle()
    reread.resolve(backend.settings)
    await settle()
    await switching

    // The late feed is metadata and must not rewrite the newest phase.
    expect(state().update.phase).toBe('available')
    expect(state().update.version).toBe('0.2.0')
    expect(state().checked).toBe(true)
    expect(state().feed).toBe(BETA_FEED)
    expect(canOpen(state())).toBe(true)
  })
})

describe('a check begun while the channel switch is unresolved', () => {
  it('discards the result when the save settles first', async () => {
    const { state, actions } = await mount()
    await settle()
    const save = deferred()
    backend.setQueue.push(save)
    const reread = deferred()
    backend.listQueue.push(reread)
    const check = deferred()
    backend.checkQueue.push(check)

    const switching = actions.selectChannel('beta')
    const checking = actions.check()
    await settle()
    save.resolve(undefined)
    await settle()
    reread.resolve(backend.settings)
    await settle()
    await switching
    expect(state().update.phase).toBe('idle')

    // The check may have run before the shell wrote the preference.
    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await checking
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(canOpen(state())).toBe(false)
    expect(state().ownership.check).toBeNull()
  })

  it('discards the result when the check settles first', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const save = deferred()
    backend.setQueue.push(save)
    const reread = deferred()
    backend.listQueue.push(reread)
    const check = deferred()
    backend.checkQueue.push(check)

    const switching = actions.selectChannel('beta')
    const checking = actions.check()
    await settle()
    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await checking

    // The discarded success neither replaced nor kept the previous candidate.
    expect(state().update.phase).toBe('ready')
    expect(state().error).toBeNull()
    expect(state().ownership.check).toBeNull()

    save.resolve(undefined)
    await settle()
    reread.resolve(backend.settings)
    await settle()
    await switching
    expect(state().channel).toBe('beta')
    expect(state().update.phase).toBe('idle')
    expect(canOpen(state())).toBe(false)
  })

  it('discards the result when the save is refused', async () => {
    const { state, actions } = await mount()
    await settle()
    const save = deferred()
    backend.setQueue.push(save)
    const check = deferred()
    backend.checkQueue.push(check)

    const switching = actions.selectChannel('beta')
    const checking = actions.check()
    await settle()
    save.reject(new Error('settings_set refused'))
    await settle()
    await switching
    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await checking

    expect(state().channel).toBe('stable')
    expect(state().error).toBe('channel')
    expect(state().update.phase).toBe('idle')
    expect(state().ownership.check).toBeNull()
  })

  it('accepts a check begun after the save settled', async () => {
    const { state, actions } = await mount()
    await settle()
    await actions.selectChannel('beta')
    await settle()
    const check = deferred()
    backend.checkQueue.push(check)
    const checking = actions.check()
    await settle()
    check.resolve({ phase: 'available', version: '0.2.0' })
    await settle()
    await checking
    expect(state().channel).toBe('beta')
    expect(state().update.phase).toBe('available')
    expect(state().update.version).toBe('0.2.0')
    expect(canOpen(state())).toBe(true)
  })
})

describe('obsolete and duplicate operations', () => {
  it('does not restore a candidate from a check that predates the switch', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'available', version: '0.1.8' })
    await settle()

    const check = deferred()
    backend.checkQueue.push(check)
    const checking = actions.check()
    await settle()
    expect(state().ownership.check).not.toBeNull()

    await actions.selectChannel('beta')
    await settle()
    expect(state().update.phase).toBe('idle')

    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await checking
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(canOpen(state())).toBe(false)
  })

  it('does not let a stale check failure replace the channel or the errors', async () => {
    const { state, actions } = await mount()
    await settle()
    const check = deferred()
    backend.checkQueue.push(check)
    const checking = actions.check()
    await settle()

    await actions.selectChannel('beta')
    await settle()

    check.reject(new Error('the previous channel is unreachable'))
    await settle()
    await checking
    expect(state().channel).toBe('beta')
    expect(state().feed).toBe(BETA_FEED)
    expect(state().error).toBeNull()
    expect(state().checked).toBe(false)
  })

  it('runs one check while a second invocation is refused', async () => {
    const { state, actions } = await mount()
    await settle()
    const check = deferred()
    backend.checkQueue.push(check)
    const first = actions.check()
    const second = actions.check()
    await settle()
    expect(backend.calls.check).toBe(1)
    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await Promise.all([first, second])
    expect(state().ownership.check).toBeNull()
    expect(state().update.phase).toBe('available')
  })

  it('runs one channel save while a second invocation is refused', async () => {
    const { actions } = await mount()
    await settle()
    const save = deferred()
    backend.setQueue.push(save)
    const first = actions.selectChannel('beta')
    const second = actions.selectChannel('stable')
    await settle()
    expect(backend.writes).toHaveLength(1)
    save.resolve(undefined)
    await settle()
    await Promise.all([first, second])
  })

  it('runs one install while a second invocation is refused', async () => {
    const { actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const confirmation = deferred()
    backend.openQueue.push(confirmation)
    const first = actions.open()
    const second = actions.open()
    await settle()
    expect(backend.calls.open).toBe(1)
    confirmation.resolve(undefined)
    await settle()
    await Promise.all([first, second])
  })

  it('applies a repeated publication identically', async () => {
    const { state } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const once = { ...state() }
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    expect(state().update).toEqual(once.update)
    expect(state().checked).toBe(once.checked)
    expect(canOpen(state())).toBe(true)
  })
})

describe('the install owns the section until the shell publishes', () => {
  it('refuses a check and a switch before the first working phase arrives', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    expect(canCheck(state())).toBe(true)

    const confirmation = deferred()
    backend.openQueue.push(confirmation)
    const installing = actions.open()
    await settle()

    // The shell has published nothing: the phase alone still reads `ready`.
    expect(state().update.phase).toBe('ready')
    expect(canCheck(state())).toBe(false)
    expect(canChangeChannel(state())).toBe(false)
    expect(canOpen(state())).toBe(false)
    expect(hasCandidate(state())).toBe(true)

    backend.writes = []
    await actions.check()
    await actions.selectChannel('beta')
    await settle()
    // Both invocations were refused before they reached the shell.
    expect(backend.calls.check).toBe(0)
    expect(backend.writes).toHaveLength(0)

    confirmation.resolve(undefined)
    await settle()
    await installing
  })

  it('keeps the downloaded candidate when the confirmation is declined', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const confirmation = deferred()
    backend.openQueue.push(confirmation)
    const installing = actions.open()
    await settle()

    publish({ phase: 'downloading', percent: 40 })
    publish({ phase: 'verifying' })
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    confirmation.resolve(undefined)
    await settle()
    await installing

    // `Later` is published by the shell, so the verified artifact stands.
    expect(state().update.phase).toBe('ready')
    expect(state().update.version).toBe('0.1.8')
    expect(state().error).toBeNull()
    expect(canOpen(state())).toBe(true)
  })

  it('reports a rejected confirmation without inventing a phase', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'available', version: '0.1.8' })
    await settle()
    const confirmation = deferred()
    backend.openQueue.push(confirmation)
    const installing = actions.open()
    await settle()
    confirmation.reject(new Error('update_open refused'))
    await settle()
    await installing
    expect(state().update.phase).toBe('available')
    expect(state().error).toBe('action')
    expect(hasCandidate(state())).toBe(true)
  })

  it('stays owned by the shell while it publishes the install', async () => {
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'ready', version: '0.1.8' })
    await settle()
    const confirmation = deferred()
    backend.openQueue.push(confirmation)
    const installing = actions.open()
    await settle()
    publish({ phase: 'downloading', percent: 10 })
    confirmation.resolve(undefined)
    await settle()
    await installing
    // Ownership passed to the shell's working phase, so the section stays disabled.
    expect(canCheck(state())).toBe(false)
    expect(canChangeChannel(state())).toBe(false)
    publish({ phase: 'idle' })
    await settle()
    expect(canCheck(state())).toBe(true)
    expect(canChangeChannel(state())).toBe(true)
  })
})

describe('startup reads are ordered against what happened after them', () => {
  it('adopts the persisted selection when it is the newest information', async () => {
    backend.settings = { 'updates.channel': 'beta', 'updates.feed-url-beta': BETA_FEED }
    const { state } = await mount()
    await settle()
    expect(state().channel).toBe('beta')
    expect(state().feed).toBe(BETA_FEED)
    expect(state().appVersion).toBe(INSTALLED_VERSION)
  })

  it('keeps the switched channel and feed when the startup reads settle late', async () => {
    // Both startup reads are still in flight when the user switches channels,
    // and the switch issues a third read of its own.
    const status = deferred()
    backend.statusQueue.push(status)
    const startupSettings = deferred()
    backend.listQueue.push(startupSettings)
    const reread = deferred()
    backend.listQueue.push(reread)
    const { state, actions } = await mount()
    await settle()
    expect(state().channel).toBe('stable')

    publish({ phase: 'available', version: '0.1.8' })
    const switching = actions.selectChannel('beta')
    await settle()
    reread.resolve({ ...backend.settings, 'updates.channel': 'beta' })
    await settle()
    await switching
    expect(state().channel).toBe('beta')

    // The startup answers arrive with the selection and the phase they saw.
    startupSettings.resolve({ 'updates.channel': 'stable', 'updates.feed-url': STABLE_FEED })
    status.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    expect(state().channel).toBe('beta')
    expect(state().feed).toBe(BETA_FEED)
    // The late status does not resurrect the candidate the switch invalidated.
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(state().appVersion).toBe(INSTALLED_VERSION)
  })

  it('drops a startup status that would resurrect an invalidated candidate', async () => {
    const status = deferred()
    backend.statusQueue.push(status)
    const { state, actions } = await mount()
    await settle()
    publish({ phase: 'available', version: '0.1.8' })
    await settle()
    await actions.selectChannel('beta')
    await settle()
    expect(state().update.phase).toBe('idle')
    status.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(canOpen(state())).toBe(false)
  })

  it('keeps the startup status when nothing else happened', async () => {
    const status = deferred()
    backend.statusQueue.push(status)
    const { state } = await mount()
    await settle()
    status.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    expect(state().update.phase).toBe('available')
    expect(state().checked).toBe(true)
    expect(backend.calls.status).toBe(1)
  })

  it('drops a startup status that arrives after a check finished silently', async () => {
    // No published event and no owner remains: the completed check is recorded
    // only in the ownership sequence, which the stamp has to cover.
    const status = deferred()
    backend.statusQueue.push(status)
    const check = deferred()
    backend.checkQueue.push(check)
    const { state, actions } = await mount()
    await settle()
    const checking = actions.check()
    await settle()
    check.resolve({ phase: 'available', version: '0.1.9' })
    await settle()
    await checking
    expect(state().update.phase).toBe('available')
    expect(state().ownership.check).toBeNull()
    expect(state().events).toBe(0)

    status.resolve({ phase: 'ready', version: '0.1.7' })
    await settle()
    expect(state().update.phase).toBe('available')
    expect(state().update.version).toBe('0.1.9')
    expect(state().checked).toBe(true)
  })

  it('drops a startup status that arrives after a channel save finished silently', async () => {
    const status = deferred()
    backend.statusQueue.push(status)
    const { state, actions } = await mount()
    await settle()
    await actions.selectChannel('beta')
    await settle()
    expect(state().channel).toBe('beta')
    expect(state().update.phase).toBe('idle')

    status.resolve({ phase: 'ready', version: '0.1.7' })
    await settle()
    expect(state().update.phase).toBe('idle')
    expect(state().checked).toBe(false)
    expect(state().channel).toBe('beta')
    expect(canOpen(state())).toBe(false)
  })

  it('keeps a startup settings read that a successful check did not outdate', async () => {
    // The read is still pending while the user checks; the check changes
    // neither the channel nor its feed, so the read is still current.
    const startupSettings = deferred()
    backend.listQueue.push(startupSettings)
    const check = deferred()
    backend.checkQueue.push(check)
    const { state, actions } = await mount()
    await settle()
    expect(state().feed).toBeNull()
    expect(state().appVersion).toBe('')

    const checking = actions.check()
    await settle()
    check.resolve({ phase: 'available', version: '0.1.9' })
    await settle()
    await checking
    expect(state().update.phase).toBe('available')

    startupSettings.resolve(backend.settings)
    await settle()
    expect(state().channel).toBe('stable')
    expect(state().feed).toBe(STABLE_FEED)
    expect(state().appVersion).toBe(INSTALLED_VERSION)
    // The check's own result still stands.
    expect(state().update.phase).toBe('available')
  })

  it('keeps a startup settings read that a failed check did not outdate', async () => {
    const startupSettings = deferred()
    backend.listQueue.push(startupSettings)
    const check = deferred()
    backend.checkQueue.push(check)
    const { state, actions } = await mount()
    await settle()

    const checking = actions.check()
    await settle()
    check.reject(new Error('the feed is unreachable'))
    await settle()
    await checking
    // The section knew of no feed when the check failed, which the feed line
    // already explains, so the rejection is not also reported as an action error.
    expect(state().error).toBeNull()

    startupSettings.resolve(backend.settings)
    await settle()
    expect(state().feed).toBe(STABLE_FEED)
    expect(state().appVersion).toBe(INSTALLED_VERSION)
  })
})

describe('a late check response cannot regress a newer shell presentation', () => {
  it('keeps a ready the shell published while the check was in flight', async () => {
    const check = deferred()
    backend.checkQueue.push(check)
    const { state, actions } = await mount()
    await settle()
    const checking = actions.check()
    await settle()
    expect(state().ownership.check).not.toBeNull()

    // The shell publishes its progress and its terminal presentation; the check
    // command reports the same result to its own caller.
    publish({ phase: 'checking' })
    publish({ phase: 'downloading', percent: 40 })
    publish({ phase: 'verifying' })
    publish({ phase: 'ready', version: '0.1.9' })
    await settle()

    check.resolve({ phase: 'available', version: '0.1.8' })
    await settle()
    await checking

    expect(state().update.phase).toBe('ready')
    expect(state().update.version).toBe('0.1.9')
    expect(state().error).toBeNull()
    expect(canOpen(state())).toBe(true)
    expect(state().ownership.check).toBeNull()
  })

  it('keeps the phase a check published itself before its response arrived', async () => {
    const check = deferred()
    backend.checkQueue.push(check)
    const { state, actions } = await mount()
    await settle()
    const checking = actions.check()
    await settle()

    // The ordinary path: the shell publishes the same presentation it returns.
    publish({ phase: 'checking' })
    publish({ phase: 'available', version: '0.1.9' })
    check.resolve({ phase: 'available', version: '0.1.9' })
    await settle()
    await checking

    expect(state().update.phase).toBe('available')
    expect(state().update.version).toBe('0.1.9')
    expect(state().checked).toBe(true)
    expect(state().error).toBeNull()
  })

  it('reports a rejected check without regressing a downloaded phase', async () => {
    const check = deferred()
    backend.checkQueue.push(check)
    const { state, actions } = await mount()
    await settle()
    const checking = actions.check()
    await settle()
    publish({ phase: 'downloading', percent: 10 })
    check.reject(new Error('the command transport failed'))
    await settle()
    await checking

    expect(state().update.phase).toBe('downloading')
    expect(state().update.percent).toBe(10)
    // The rejection describes this action and writes no phase.
    expect(state().error).toBe('action')
  })
})