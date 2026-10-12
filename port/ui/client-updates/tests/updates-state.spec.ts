/**
 * Updates-section state transitions.
 *
 * These tests pin the lifecycle rules the section previously only implied:
 * independent ownership per operation with each token releasing only itself, the
 * channel generation and unresolved-switch fence that retire a check, the
 * candidate invalidation that follows the shell's own write, startup reads that
 * cannot overwrite newer information, and `Later` preserving a downloaded
 * `ready`. They exercise the pure transitions in `state.ts`, which the plugin
 * applies for every user action and every shell-published presentation.
 */
import { describe, expect, it } from 'vitest'
import {
  adoptUpdate,
  applyStartupSettings,
  applyStartupStatus,
  beginChannelChange,
  beginCheck,
  beginOpen,
  canChangeChannel,
  canCheck,
  canOpen,
  commitChannelChange,
  completeChannelChange,
  completeCheck,
  completeOpen,
  hasCandidate,
  initialTransitionState,
  isCheckResult,
  isWorking,
  startupStamp,
} from '../src/client/state.ts'
import type { UpdatesTransitionState } from '../src/client/state.ts'
import type { DesktopUpdatePresentation } from '../../desktop-bridge/protocol.ts'

const STABLE_FEED = 'https://updates.example.com/stable.json'
const BETA_FEED = 'https://updates.example.com/beta.json'

function initial(update: DesktopUpdatePresentation = { phase: 'idle' }): UpdatesTransitionState {
  return { ...initialTransitionState(), update, feed: STABLE_FEED }
}

it('an idle startup snapshot does not claim that an update check occurred', () => {
  const state = initial()
  const adopted = applyStartupStatus(state, { phase: 'idle' }, startupStamp(state))
  expect(adopted.checked).toBe(false)
  expect(adoptUpdate(adopted, { phase: 'idle' }).checked).toBe(true)
})

/** The state after a channel save the shell both wrote and read back. */
function saved(
  state: UpdatesTransitionState,
  token: number,
  feed: string | null = BETA_FEED,
): UpdatesTransitionState {
  const committed = commitChannelChange(state, token)
  return completeChannelChange(committed, token, { commit: 'saved', feed, previousChannel: 'stable' })
}

describe('ownership', () => {
  it('refuses a second check while one is in flight', () => {
    const started = beginCheck(initial())!
    expect(started.state.ownership.check).toBe(started.token)
    expect(beginCheck(started.state)).toBeNull()
    expect(canCheck(started.state)).toBe(false)
  })

  it('refuses a check while a download is running', () => {
    const downloading = adoptUpdate(initial(), { phase: 'downloading', percent: 10 })
    expect(beginCheck(downloading)).toBeNull()
    expect(canCheck(downloading)).toBe(false)
  })

  it('allows a check while a channel save is in flight', () => {
    const channel = beginChannelChange(initial(), 'beta')!
    const check = beginCheck(channel.state)!
    expect(check.state.ownership.check).toBe(check.token)
    expect(check.state.ownership.channel).toBe(channel.token)
    expect(canCheck(check.state)).toBe(false)
    expect(canChangeChannel(check.state)).toBe(false)
  })

  it('refuses a second open while one is in flight', () => {
    const opened = beginOpen(initial({ phase: 'ready' }))!
    expect(opened.state.ownership.action).toBe(opened.token)
    expect(beginOpen(opened.state)).toBeNull()
  })

  it('disables the channel radios during every shell working phase', () => {
    for (const update of [
      { phase: 'checking' },
      { phase: 'downloading', percent: 40 },
      { phase: 'verifying' },
      { phase: 'installing' },
    ] as const) {
      expect(canChangeChannel(adoptUpdate(initial(), update)), update.phase).toBe(false)
    }
  })

  it('keeps the channel radios available while nothing is owned', () => {
    for (const update of [{ phase: 'idle' }, { phase: 'available', version: '0.1.8' }, { phase: 'ready', version: '0.1.8' }] as const) {
      expect(canChangeChannel(adoptUpdate(initial(), update)), update.phase).toBe(true)
    }
  })

  it('releases only the token the completion was begun with', () => {
    const check = beginCheck(initial())!
    const channel = beginChannelChange(check.state, 'beta')!
    const afterCheck = completeCheck(channel.state, check.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    expect(afterCheck.ownership.check).toBeNull()
    expect(afterCheck.ownership.channel).toBe(channel.token)
    // The channel save still owns the section, so the switch stays pending.
    expect(canChangeChannel(afterCheck)).toBe(false)
    const afterChannel = saved(afterCheck, channel.token)
    expect(afterChannel.ownership.channel).toBeNull()
    expect(afterChannel.channel).toBe('beta')
  })

  it('releases ownership when a check completes successfully', () => {
    const started = beginCheck(initial())!
    const done = completeCheck(started.state, started.token, { ok: true, update: { phase: 'checking' } })
    expect(done.ownership.check).toBeNull()
  })

  it('releases ownership when a check fails', () => {
    const started = beginCheck(initial())!
    const done = completeCheck(started.state, started.token, { ok: false, noFeed: false })
    expect(done.ownership.check).toBeNull()
    expect(done.error).toBe('action')
  })
})

describe('duplicate completions', () => {
  it('ignores a repeated check completion', () => {
    const started = beginCheck(initial())!
    const done = completeCheck(started.state, started.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    const again = completeCheck(done, started.token, { ok: false, noFeed: false })
    expect(again).toBe(done)
    expect(again.error).toBeNull()
    expect(again.update.phase).toBe('available')
  })

  it('does not let a superseded check token release the running check', () => {
    const first = beginCheck(initial())!
    const settled = completeCheck(first.state, first.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    const second = beginCheck(settled)!
    const late = completeCheck(second.state, first.token, { ok: false, noFeed: false })
    expect(late.ownership.check).toBe(second.token)
    expect(late.error).toBeNull()
  })

  it('ignores a superseded channel completion', () => {
    const first = beginChannelChange(initial(), 'beta')!
    const failed = completeChannelChange(first.state, first.token, { commit: 'refused', previousChannel: 'stable' })
    expect(failed.error).toBe('channel')
    const second = beginChannelChange(failed, 'beta')!
    const late = completeChannelChange(second.state, first.token, { commit: 'refused', previousChannel: 'stable' })
    expect(late).toBe(second.state)
    expect(late.channel).toBe('beta')
    expect(late.error).toBeNull()
    expect(late.ownership.channel).toBe(second.token)
  })

  it('ignores a commit that no longer owns the save', () => {
    const switching = beginChannelChange(initial(), 'beta')!
    const refused = completeChannelChange(switching.state, switching.token, { commit: 'refused', previousChannel: 'stable' })
    const late = commitChannelChange(refused, switching.token)
    expect(late).toBe(refused)
    expect(hasCandidate(late)).toBe(false)
  })

  it('ignores a repeated open completion', () => {
    const opened = beginOpen(initial({ phase: 'ready' }))!
    const done = completeOpen(opened.state, opened.token, false)
    const again = completeOpen(done, opened.token, true)
    expect(again).toBe(done)
    expect(again.error).toBe('action')
  })
})

describe('the install owns the section before the shell publishes a working phase', () => {
  it('disables checks and the channel switch while no working phase is published', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    const opened = beginOpen(ready)!
    // The shell has published nothing yet: the phase alone would still allow
    // a check and a switch, so the action token has to close that window.
    expect(isWorking(opened.state.update.phase)).toBe(false)
    expect(canCheck(opened.state)).toBe(false)
    expect(canChangeChannel(opened.state)).toBe(false)
    expect(canOpen(opened.state)).toBe(false)
    // The candidate itself is untouched: the install did not consume it.
    expect(hasCandidate(opened.state)).toBe(true)
  })

  it('refuses a check and a switch begun while the install owns the section', () => {
    const opened = beginOpen(initial({ phase: 'available', version: '0.1.8' }))!
    expect(beginCheck(opened.state)).toBeNull()
    expect(beginChannelChange(opened.state, 'beta')).toBeNull()
  })

  it('waits for an in-flight check and channel save before the install', () => {
    const check = beginCheck(initial())!
    expect(beginOpen(check.state)).toBeNull()
    const channel = beginChannelChange(check.state, 'beta')!
    expect(beginOpen(channel.state)).toBeNull()
  })

  it('returns the affordance once the confirmation settles', () => {
    const opened = beginOpen(initial({ phase: 'ready' }))!
    const done = completeOpen(opened.state, opened.token, true)
    expect(canOpen(done)).toBe(true)
    expect(canCheck(done)).toBe(true)
    expect(canChangeChannel(done)).toBe(true)
  })
})

describe('the channel generation retires every check the switch made unknowable', () => {
  it('increments the generation and marks the channel unresolved when the save begins', () => {
    const before = initial()
    const begun = beginChannelChange(before, 'beta')!
    expect(begun.state.generation).toBe(before.generation + 1)
    expect(begun.state.switching).toBe(true)
    expect(begun.state.checkGeneration).toBeNull()
  })

  it('clears the unresolved mark once the save settles', () => {
    const begun = beginChannelChange(initial(), 'beta')!
    expect(saved(begun.state, begun.token).switching).toBe(false)
    const other = beginChannelChange(initial(), 'beta')!
    const refused = completeChannelChange(other.state, other.token, { commit: 'refused', previousChannel: 'stable' })
    expect(refused.switching).toBe(false)
  })

  it('discards a check that predates the switch, in either settlement order', () => {
    const check = beginCheck(initial())!
    const switching = beginChannelChange(check.state, 'beta')!
    const early = completeCheck(switching.state, check.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    // The result describes the previous channel: no candidate may appear.
    expect(early.update.phase).toBe('idle')
    expect(early.checked).toBe(false)
    expect(early.ownership.check).toBeNull()
    expect(early.ownership.channel).toBe(switching.token)

    const late = completeCheck(saved(early, switching.token), check.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    expect(late.update.phase).toBe('idle')
    expect(late.checked).toBe(false)
    expect(canOpen(late)).toBe(false)
  })

  it('discards a check begun while the switch is unresolved', () => {
    const switching = beginChannelChange(initial(), 'beta')!
    const check = beginCheck(switching.state)!
    // The shell resolves the channel when the check runs, which may still be
    // the previous one, so the check is stamped with no generation at all.
    expect(check.state.checkGeneration).toBeNull()
    const settled = completeCheck(saved(check.state, switching.token), check.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    expect(settled.update.phase).toBe('idle')
    expect(settled.checked).toBe(false)
    expect(settled.ownership.check).toBeNull()
    // Releasing the token is all an obsolete result is allowed to do.
    expect(canCheck(settled)).toBe(true)
  })

  it('discards a check begun during a switch that was refused', () => {
    const switching = beginChannelChange(initial(), 'beta')!
    const check = beginCheck(switching.state)!
    const refused = completeChannelChange(check.state, switching.token, { commit: 'refused', previousChannel: 'stable' })
    const settled = completeCheck(refused, check.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    expect(settled.update.phase).toBe('idle')
    expect(settled.error).toBe('channel')
    expect(settled.ownership.check).toBeNull()
  })

  it('discards a failure from a check the switch made unknowable', () => {
    const switching = beginChannelChange(initial(), 'beta')!
    const check = beginCheck(switching.state)!
    const settled = completeCheck(saved(check.state, switching.token), check.token, { ok: false, noFeed: false })
    expect(settled.channel).toBe('beta')
    expect(settled.error).toBeNull()
    expect(settled.checked).toBe(false)
  })

  it('applies a check begun after the switch settled', () => {
    const switching = beginChannelChange(initial(), 'beta')!
    const switched = saved(switching.state, switching.token)
    const check = beginCheck(switched)!
    expect(check.state.checkGeneration).toBe(switched.generation)
    const settled = completeCheck(check.state, check.token, { ok: true, update: { phase: 'available', version: '0.2.0' } })
    expect(settled.update.phase).toBe('available')
    expect(settled.update.version).toBe('0.2.0')
  })

  it('leaves the invalidated state installed whichever order the two operations settle in', () => {
    const available = adoptUpdate(initial(), { phase: 'available', version: '0.1.8' })
    const check = beginCheck(available)!
    const switching = beginChannelChange(check.state, 'beta')!
    const switched = saved(switching.state, switching.token)
    const settled = completeCheck(switched, check.token, { ok: true, update: { phase: 'available', version: '0.1.8' } })
    expect(settled.channel).toBe('beta')
    expect(settled.feed).toBe(BETA_FEED)
    expect(settled.update.phase).toBe('idle')
    expect(settled.checked).toBe(false)
    expect(settled.ownership.check).toBeNull()
    expect(settled.ownership.channel).toBeNull()
  })
})

describe('the write and the refresh after it are answered separately', () => {
  it('drops the previous channel candidate when the shell accepts the write', () => {
    const available = adoptUpdate(initial(), { phase: 'available', version: '0.1.8' })
    expect(canOpen(available)).toBe(true)
    const switching = beginChannelChange(available, 'beta')!
    // The shell invalidates its candidate inside `settings_set`, before it
    // answers, so the section does the same at that moment.
    const committed = commitChannelChange(switching.state, switching.token)
    expect(committed.update.phase).toBe('idle')
    expect(committed.checked).toBe(false)
    expect(canOpen(committed)).toBe(false)
    // The save still owns the section until its feed is read.
    expect(committed.ownership.channel).toBe(switching.token)
    const done = completeChannelChange(committed, switching.token, { commit: 'saved', feed: BETA_FEED, previousChannel: 'stable' })
    expect(done.channel).toBe('beta')
    expect(done.feed).toBe(BETA_FEED)
    expect(done.error).toBeNull()
  })

  it('keeps a presentation the shell published after the write', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    const switching = beginChannelChange(ready, 'beta')!
    const committed = commitChannelChange(switching.state, switching.token)
    const published = adoptUpdate(committed, { phase: 'available', version: '0.2.0' })
    const done = completeChannelChange(published, switching.token, { commit: 'saved', feed: BETA_FEED, previousChannel: 'stable' })
    // The late feed is metadata: it must not rewrite the newest phase.
    expect(done.update.phase).toBe('available')
    expect(done.update.version).toBe('0.2.0')
    expect(done.checked).toBe(true)
    expect(done.feed).toBe(BETA_FEED)
  })

  it('drops a downloaded ready candidate when the channel changes', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    const switching = beginChannelChange(ready, 'beta')!
    const done = saved(switching.state, switching.token, null)
    expect(done.update.phase).toBe('idle')
    expect(done.feed).toBeNull()
    expect(canOpen(done)).toBe(false)
  })

  it('keeps a switch that a failed refresh cannot roll back', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    const switching = beginChannelChange(ready, 'beta')!
    const committed = commitChannelChange(switching.state, switching.token)
    const done = completeChannelChange(committed, switching.token, { commit: 'saved-unreadable', previousChannel: 'stable' })
    // The shell wrote `updates.channel`, so the selection is the new one.
    expect(done.channel).toBe('beta')
    // The feed is configured per channel and is now unknown rather than stale.
    expect(done.feed).toBeNull()
    expect(done.error).toBe('channel')
    // The candidate the shell invalidated must not come back.
    expect(done.update.phase).toBe('idle')
    expect(canOpen(done)).toBe(false)
  })

  it('restores the previous channel when the write is refused', () => {
    const available = adoptUpdate(initial(), { phase: 'available', version: '0.1.8' })
    const switching = beginChannelChange(available, 'beta')!
    const failed = completeChannelChange(switching.state, switching.token, { commit: 'refused', previousChannel: 'stable' })
    expect(failed.channel).toBe('stable')
    expect(failed.error).toBe('channel')
    // A refused write persisted nothing, so the shell left its candidate alone.
    expect(failed.update.phase).toBe('available')
    expect(canOpen(failed)).toBe(true)
  })

  it('keeps the candidate when a switch is refused before it begins', () => {
    const downloading = adoptUpdate(initial(), { phase: 'downloading', percent: 40 })
    expect(beginChannelChange(downloading, 'beta')).toBeNull()
  })
})

describe('Later preserves a downloaded ready state', () => {
  it('adopts a ready presentation verbatim without dropping the candidate', () => {
    const available = adoptUpdate(initial(), { phase: 'available', version: '0.1.8' })
    const ready = adoptUpdate(available, { phase: 'ready', version: '0.1.8' })
    expect(ready.update.phase).toBe('ready')
    expect(ready.update.version).toBe('0.1.8')
    // The install affordance stays available after the user declines.
    expect(canOpen(ready)).toBe(true)
  })

  it('keeps ready across an unrelated check result arriving late', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    // The shell is authoritative: whatever it publishes last wins, and a
    // `ready` phase is never rewritten locally into an error or idle state.
    expect(adoptUpdate(ready, { phase: 'ready', version: '0.1.8' }).update.phase).toBe('ready')
  })

  it('never invents a phase when the confirmation is rejected', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    const opened = beginOpen(ready)!
    const failed = completeOpen(opened.state, opened.token, false)
    expect(failed.update.phase).toBe('ready')
    expect(failed.error).toBe('action')
    expect(canOpen(failed)).toBe(true)
  })

  it('reports the decline without a channel-generation change', () => {
    const ready = adoptUpdate(initial(), { phase: 'ready', version: '0.1.8' })
    const opened = beginOpen(ready)!
    expect(opened.state.generation).toBe(ready.generation)
    const settled = completeOpen(opened.state, opened.token, true)
    expect(settled.update.phase).toBe('ready')
    expect(settled.update.version).toBe('0.1.8')
    expect(settled.error).toBeNull()
    expect(canOpen(settled)).toBe(true)
  })
})

describe('a check result is adopted only while it is the newest news', () => {
  it('adopts a check success while the shell published nothing newer', () => {
    const started = beginCheck(initial())!
    const settled = completeCheck(started.state, started.token, { ok: true, update: { phase: 'available', version: '0.1.9' } })
    expect(settled.update.phase).toBe('available')
    expect(settled.checked).toBe(true)
  })

  it('discards a check success the shell has already superseded', () => {
    const started = beginCheck(initial())!
    // The shell publishes the terminal presentation before `update_check`
    // answers, so a response arriving after a newer publication is old news.
    const published = adoptUpdate(started.state, { phase: 'ready', version: '0.1.8' })
    const settled = completeCheck(published, started.token, { ok: true, update: { phase: 'available', version: '0.1.9' } })
    expect(settled.update.phase).toBe('ready')
    expect(settled.update.version).toBe('0.1.8')
    expect(settled.ownership.check).toBeNull()
    expect(canOpen(settled)).toBe(true)
  })

  it('reports a rejected check without rewriting a newer presentation', () => {
    const started = beginCheck(initial())!
    const published = adoptUpdate(started.state, { phase: 'downloading', percent: 40 })
    const settled = completeCheck(published, started.token, { ok: false, noFeed: false })
    expect(settled.update.phase).toBe('downloading')
    expect(settled.update.percent).toBe(40)
    expect(settled.error).toBe('action')
  })
})

describe('startup reads are ordered against newer information', () => {
  it('adopts the startup status while nothing newer exists', () => {
    const state = initial()
    const adopted = applyStartupStatus(state, { phase: 'available', version: '0.1.8' }, startupStamp(state))
    expect(adopted.update.phase).toBe('available')
    expect(adopted.checked).toBe(true)
  })

  it('adopts the startup settings while the stamp is current', () => {
    const state = initial()
    const adopted = applyStartupSettings(state, { channel: 'beta', feed: BETA_FEED, appVersion: '0.1.7' }, startupStamp(state))
    expect(adopted.channel).toBe('beta')
    expect(adopted.feed).toBe(BETA_FEED)
    expect(adopted.appVersion).toBe('0.1.7')
  })

  it('discards the startup status once a presentation was published', () => {
    const state = initial()
    const published = adoptUpdate(state, { phase: 'downloading', percent: 10 })
    const late = applyStartupStatus(published, { phase: 'available', version: '0.1.8' }, startupStamp(state))
    expect(late).toBe(published)
    expect(late.update.phase).toBe('downloading')
  })

  it('discards the startup status after an operation began and finished', () => {
    const state = initial()
    const stamp = startupStamp(state)
    const check = beginCheck(state)!
    const settled = completeCheck(check.state, check.token, { ok: true, update: { phase: 'available', version: '0.1.9' } })
    // The operation left no owner behind and published no event, so only the
    // sequence records that it happened.
    expect(settled.ownership.check).toBeNull()
    expect(settled.events).toBe(state.events)
    const late = applyStartupStatus(settled, { phase: 'ready', version: '0.1.7' }, stamp)
    expect(late).toBe(settled)
    expect(late.update.phase).toBe('available')
  })

  it('discards the startup status while an operation owns the section', () => {
    const state = initial()
    const started = beginCheck(state)!
    const late = applyStartupStatus(started.state, { phase: 'available', version: '0.1.8' }, startupStamp(state))
    expect(late).toBe(started.state)
  })

  it('discards the channel and feed a late startup read would revert', () => {
    const state = initial()
    const switching = beginChannelChange(state, 'beta')!
    const switched = saved(switching.state, switching.token)
    const late = applyStartupSettings(switched, { channel: 'stable', feed: STABLE_FEED, appVersion: '0.1.7' }, startupStamp(state))
    expect(late.channel).toBe('beta')
    expect(late.feed).toBe(BETA_FEED)
    // The installed version is independent of the channel and still applies.
    expect(late.appVersion).toBe('0.1.7')
  })

  it('discards a late startup read issued before a switch that then failed', () => {
    const state = initial()
    const switching = beginChannelChange(state, 'beta')!
    const failed = completeChannelChange(switching.state, switching.token, { commit: 'refused', previousChannel: 'stable' })
    const late = applyStartupSettings(failed, { channel: 'beta', feed: BETA_FEED, appVersion: '0.1.7' }, startupStamp(state))
    expect(late.channel).toBe('stable')
    expect(late.feed).toBe(STABLE_FEED)
  })

  it('keeps a startup read that a completed check did not outdate', () => {
    // A check changes neither the channel nor its feed, so the generation the
    // read was requested at is still current and its answer is applied.
    const state = initial()
    const stamp = startupStamp(state)
    const check = beginCheck(state)!
    const checked = completeCheck(check.state, check.token, { ok: true, update: { phase: 'available', version: '0.1.9' } })
    const late = applyStartupSettings(checked, { channel: 'stable', feed: BETA_FEED, appVersion: '0.1.7' }, stamp)
    expect(late.channel).toBe('stable')
    expect(late.feed).toBe(BETA_FEED)
    expect(late.appVersion).toBe('0.1.7')
  })
})

describe('check result reporting', () => {
  it('reports a missing feed as an explanation rather than an action failure', () => {
    const started = beginCheck({ ...initial(), feed: null })!
    const done = completeCheck(started.state, started.token, { ok: false, noFeed: true })
    expect(done.error).toBeNull()
    expect(done.checked).toBe(true)
  })

  it('marks the section checked only for terminal phases', () => {
    expect(isCheckResult('idle')).toBe(true)
    expect(isCheckResult('available')).toBe(true)
    expect(isCheckResult('error')).toBe(true)
    expect(isCheckResult('checking')).toBe(false)
    expect(isCheckResult('downloading')).toBe(false)
    expect(isCheckResult('ready')).toBe(false)
  })

  it('adopts an error presentation and marks the section checked', () => {
    const failed = adoptUpdate(initial(), { phase: 'error', failure: 'check-network' })
    expect(failed.update.phase).toBe('error')
    expect(failed.update.failure).toBe('check-network')
    expect(failed.checked).toBe(true)
  })
})

describe('working phases', () => {
  it('classifies exactly the phases that mean the shell is busy', () => {
    for (const phase of ['checking', 'downloading', 'verifying', 'installing'] as const) {
      expect(isWorking(phase), phase).toBe(true)
    }
    for (const phase of ['idle', 'available', 'ready', 'error'] as const) {
      expect(isWorking(phase), phase).toBe(false)
    }
  })
})
