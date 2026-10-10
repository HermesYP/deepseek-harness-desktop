/**
 * Pure state transitions for the Updates settings section.
 *
 * The section applies these transitions for every user action and every
 * presentation the shell publishes, so the rules that decide what the section
 * shows are stated once here and are directly testable:
 *
 * - **Ownership is per operation and held by a token.** A check, a channel save
 *   and an install/confirmation each take the next token from a monotonic
 *   sequence. A check and a channel save may overlap, because neither touches
 *   the other's subject; an install owns all three, because it is the only
 *   operation that acts on an admitted candidate. A completion releases only the
 *   token it was started with, so a duplicate or superseded completion cannot
 *   free an operation that is still running.
 * - **A channel change opens a new generation and an unresolved transition.**
 *   The generation increments when the save begins, and the section stays
 *   `switching` until the save settles. A check that was already in flight, or
 *   one begun while the switch is unresolved, may describe the previous
 *   channel: its result is discarded, and only its own token is released, so a
 *   stale success cannot restore a candidate and a stale failure cannot replace
 *   the channel or raise an error.
 * - **A channel switch invalidates the candidate when the shell writes it.** The
 *   shell clears its candidate inside `settings_set`, before that call answers
 *   (`update_flow::invalidate_for_channel_change`), so the section invalidates
 *   at the same moment: phase `idle`, section unchecked. The feed is metadata
 *   that arrives afterwards and never rewrites the phase, so a presentation the
 *   shell published in between survives. A refused save wrote nothing, so the
 *   candidate stands.
 * - **A refusal before the commit and a failed refresh after it differ.** A
 *   save refused by `settings_set` restores the previous channel, because the
 *   persisted preference is unchanged. Once the shell has accepted the write the
 *   channel is what the user chose, and a failing read leaves the feed unknown
 *   rather than rolling the persisted preference back.
 * - **The install owns the section before the shell publishes a working phase.**
 *   Between `update_open` being invoked and the shell publishing `downloading`,
 *   `verifying` or `installing`, the phase alone would still allow a check or a
 *   channel switch; the action token closes that window.
 * - **A check result is adopted only while it is still the newest news.** The
 *   shell publishes a presentation through `dsh://update/state` before
 *   `update_check` answers, so a response that arrives after a newer publication
 *   describes work that has already been superseded: adopting it would move the
 *   section back from a `downloading` or `ready` the shell published in the
 *   meantime. A rejection still reports itself, because it writes no phase.
 * - **`Later` preserves `Ready`.** A phase published by the shell is adopted
 *   verbatim: declining a confirmation is not a failure and must not discard a
 *   verified artifact.
 * - **A failure never fabricates a phase.** On a rejected action the last
 *   shell-published update state is retained unless the shell itself published
 *   the error, so the UI cannot claim "up to date" or "ready" on its own.
 * - **Startup reads are ordered against what happened after them.** The
 *   `update_status` snapshot and the settings read issued when the section is
 *   registered carry a stamp taken when they were requested. The status carries
 *   the event count and the ownership sequence, so it is dropped once the shell
 *   has published anything or any operation has begun and finished. The settings
 *   read carries the channel generation alone, because that is the only writer
 *   of the selection it returns: a check changes neither the channel nor its
 *   feed, so a completed check must not retire an otherwise valid answer.
 */

import type { DesktopUpdatePresentation } from '../../../desktop-bridge/protocol.ts'
import type { ReleaseChannel } from './types.ts'

/** The operations that hold independent ownership of the section. */
export type UpdatesOwner = 'check' | 'channel' | 'action'

/**
 * The token each operation holds while it runs, or `null` when idle.
 *
 * A token identifies one run of one operation, so releasing it cannot affect
 * any other operation, and a completion carrying a token that is no longer held
 * is a duplicate.
 */
export interface UpdatesOwnership {
  readonly check: number | null
  readonly channel: number | null
  readonly action: number | null
}

/** The section state these transitions own. */
export interface UpdatesTransitionState {
  update: DesktopUpdatePresentation
  checked: boolean
  channel: ReleaseChannel
  feed: string | null
  appVersion: string
  error: 'channel' | 'action' | null
  /** Incremented when a channel save begins; older check results are obsolete. */
  generation: number
  /** Whether a channel save is unresolved; a check begun now is already obsolete. */
  switching: boolean
  /** Published presentations adopted so far; orders the startup status read. */
  events: number
  /** Source of the next ownership token; never reused. */
  sequence: number
  ownership: UpdatesOwnership
  /**
   * The generation the held check may report against, or `null` when it may
   * report none: while no check is owned, and for a check begun while a channel
   * switch is unresolved, whose channel the shell resolved is unknowable.
   */
  checkGeneration: number | null
  /**
   * Adopted presentations when the held check began, or `null` while no check is
   * owned. A check result that arrives after the shell published anything is
   * superseded news.
   */
  checkEvents: number | null
}

/** A begun operation: the state holding its token, and the token itself. */
export interface UpdatesOperation {
  readonly state: UpdatesTransitionState
  readonly token: number
}

/** The outcome of a channel read: the persisted selection and its feed. */
export interface UpdatesSettingsRead {
  readonly channel: ReleaseChannel
  readonly feed: string | null
  readonly appVersion: string
}

/** The state facts a startup read was requested against. */
export interface UpdatesReadStamp {
  /** Adopted presentations at request time. */
  readonly events: number
  /** Ownership sequence at request time; every operation that begins advances it. */
  readonly sequence: number
  /** Channel generation at request time. */
  readonly generation: number
}

/** How a channel save ended, relative to the moment the shell wrote the preference. */
export type ChannelChangeCompletion =
  /** The preference was written and the refreshed feed was read. */
  | { readonly commit: 'saved'; readonly feed: string | null; readonly previousChannel: ReleaseChannel }
  /** The preference was written, but the refresh that names its feed failed. */
  | { readonly commit: 'saved-unreadable'; readonly previousChannel: ReleaseChannel }
  /** The shell refused the write, so the persisted preference never changed. */
  | { readonly commit: 'refused'; readonly previousChannel: ReleaseChannel }

/** The idle section state the plugin starts from. */
export function initialTransitionState(): UpdatesTransitionState {
  return {
    update: { phase: 'idle' },
    checked: false,
    channel: 'stable',
    feed: null,
    appVersion: '',
    error: null,
    generation: 0,
    switching: false,
    events: 0,
    sequence: 0,
    ownership: { check: null, channel: null, action: null },
    checkGeneration: null,
    checkEvents: null,
  }
}

/** The stamp a startup read carries for as long as its answer is current. */
export function startupStamp(state: UpdatesTransitionState): UpdatesReadStamp {
  return { events: state.events, sequence: state.sequence, generation: state.generation }
}

/** Whether a phase means the shell is actively working. */
export function isWorking(phase: DesktopUpdatePresentation['phase']): boolean {
  return phase === 'checking' || phase === 'downloading' || phase === 'verifying' || phase === 'installing'
}

/**
 * Whether a published phase is a terminal result the section may report.
 * `idle`/`available`/`error` all mean "a check finished".
 */
export function isCheckResult(phase: DesktopUpdatePresentation['phase']): boolean {
  return phase === 'idle' || phase === 'available' || phase === 'error'
}

/** Whether the published phase offers an update to install. */
export function hasCandidate(state: UpdatesTransitionState): boolean {
  return state.update.phase === 'available' || state.update.phase === 'ready'
}

/** Whether any operation currently holds its ownership token. */
function ownsAnything(state: UpdatesTransitionState): boolean {
  return state.ownership.check !== null || state.ownership.channel !== null || state.ownership.action !== null
}

/**
 * Whether the section can start a check.
 *
 * Refused while a check is in flight, while an install/confirmation owns the
 * section, and during every shell working phase, because each of those already
 * owns or is producing the candidate. A channel save does not block a check:
 * the save touches no artifact, the shell refuses the check itself if the two
 * would collide, and a check that predates the switch has its result discarded.
 */
export function canCheck(state: UpdatesTransitionState): boolean {
  return state.ownership.check === null && state.ownership.action === null && !isWorking(state.update.phase)
}

/**
 * Whether the channel radios can be changed.
 *
 * A channel switch invalidates the candidate the shell is working on, so it
 * waits for any working phase and for an install/confirmation to settle. It
 * does not wait for a check: the switch invalidates whatever that check finds.
 */
export function canChangeChannel(state: UpdatesTransitionState): boolean {
  return state.ownership.channel === null && state.ownership.action === null && !isWorking(state.update.phase)
}

/**
 * Whether the install affordance may be invoked.
 *
 * The install acts on the admitted candidate, so it requires that phase, no
 * working phase, and no other operation in flight.
 */
export function canOpen(state: UpdatesTransitionState): boolean {
  return hasCandidate(state)
    && !isWorking(state.update.phase)
    && !ownsAnything(state)
}

/**
 * Begin the check action. Refused while a check or any working phase owns the section.
 *
 * A check begun while a channel switch is unresolved is stamped with no
 * generation: the shell resolves the channel when `update_check` runs, so the
 * section cannot tell which channel such a check answered for and discards the
 * result rather than reporting a candidate for an unknown feed.
 */
export function beginCheck(state: UpdatesTransitionState): UpdatesOperation | null {
  if (!canCheck(state)) return null
  const token = state.sequence + 1
  return {
    token,
    state: {
      ...state,
      sequence: token,
      error: null,
      ownership: { ...state.ownership, check: token },
      checkGeneration: state.switching ? null : state.generation,
      checkEvents: state.events,
    },
  }
}

/** Set the published presentation and mark the section checked for a terminal phase. */
function withPresentation(
  state: UpdatesTransitionState,
  update: DesktopUpdatePresentation,
): UpdatesTransitionState {
  return { ...state, update, checked: state.checked || isCheckResult(update.phase) }
}

/**
 * Adopt an update presentation published by the shell.
 *
 * The presentation is taken as-is: the shell owns the phase, and `Later`
 * therefore preserves `ready` exactly as any other phase. Adopting advances the
 * event count, which retires the startup status read this event supersedes.
 */
export function adoptUpdate(
  state: UpdatesTransitionState,
  update: DesktopUpdatePresentation,
): UpdatesTransitionState {
  return { ...withPresentation(state, update), events: state.events + 1 }
}

/**
 * Adopt the startup status read.
 *
 * The read is a snapshot taken when the section registered, so it is adopted
 * only while nothing newer exists. The stamp covers both published events and
 * operations: an operation that began and finished after the request leaves no
 * owner behind but has advanced the sequence, and its result is newer than this
 * snapshot.
 * @param state - Section state at the time the read is applied.
 * @param update - Presentation the shell returned for `update_status`.
 * @param stamp - State facts captured when the read was requested.
 * @returns The state with the snapshot adopted, or `state` unchanged when superseded.
 */
export function applyStartupStatus(
  state: UpdatesTransitionState,
  update: DesktopUpdatePresentation,
  stamp: UpdatesReadStamp,
): UpdatesTransitionState {
  if (state.events !== stamp.events || state.sequence !== stamp.sequence) return state
  return withPresentation(state, update)
}

/**
 * Adopt the startup settings read.
 *
 * The installed version is independent of the channel, so it is always applied.
 * The channel and its feed are applied while no channel save has opened a newer
 * generation since the read was requested. The generation is the whole currency
 * contract here: a channel save is the only writer of the selection this read
 * returns, and a check changes neither the channel nor its feed — so a check
 * that finished while the read was in flight must not retire an answer that is
 * still correct.
 * @param state - Section state at the time the read is applied.
 * @param read - Selection and installed version the read returned.
 * @param stamp - State facts captured when the read was requested.
 * @returns The state with the read applied to the fields it still owns.
 */
export function applyStartupSettings(
  state: UpdatesTransitionState,
  read: UpdatesSettingsRead,
  stamp: UpdatesReadStamp,
): UpdatesTransitionState {
  const versioned = state.appVersion === read.appVersion ? state : { ...state, appVersion: read.appVersion }
  if (state.generation !== stamp.generation) return versioned
  return { ...versioned, channel: read.channel, feed: read.feed }
}

/**
 * Complete a check with its result.
 *
 * A rejection does not clear the published update state: the section reports
 * that the action failed, and the last phase the shell published remains the
 * source of truth for the update itself. A result is obsolete when a channel
 * save has begun since the check, and when the check itself began during an
 * unresolved switch; an obsolete result releases its own token and changes
 * nothing else.
 * @param state - Section state when the check settled.
 * @param token - Token the check was begun with.
 * @param outcome - The presentation the check returned, or why it failed.
 * @returns The state with the check's own token released.
 */
export function completeCheck(
  state: UpdatesTransitionState,
  token: number,
  outcome: { ok: true; update: DesktopUpdatePresentation } | { ok: false; noFeed: boolean },
): UpdatesTransitionState {
  if (state.ownership.check !== token) return state
  const released: UpdatesTransitionState = {
    ...state,
    ownership: { ...state.ownership, check: null },
    checkGeneration: null,
    checkEvents: null,
  }
  // `null` is a check begun while the channel was unresolved: it names no
  // generation and so never matches the current one.
  if (state.checkGeneration === null || state.checkGeneration !== state.generation) return released
  if (outcome.ok) {
    // The shell publishes the terminal presentation before `update_check`
    // answers, so a response that arrives after a newer publication carries
    // news the section already moved past.
    if (state.events !== state.checkEvents) return released
    return { ...withPresentation(released, outcome.update), error: null }
  }
  return {
    ...released,
    checked: true,
    // A missing feed is already explained by the feed line, so it is not an
    // action failure.
    error: outcome.noFeed ? null : 'action',
  }
}

/**
 * Begin the channel-save action. Independent of a check in flight.
 *
 * Beginning the save opens a new generation and marks the channel as
 * unresolved, so every check already in flight — and every check begun until the
 * save settles — is stamped obsolete at once. A refused switch changes nothing.
 * @param state - Section state before the switch.
 * @param channel - Channel the user selected.
 * @returns The begun operation, or `null` when the switch is not allowed.
 */
export function beginChannelChange(
  state: UpdatesTransitionState,
  channel: ReleaseChannel,
): UpdatesOperation | null {
  if (!canChangeChannel(state)) return null
  const token = state.sequence + 1
  return {
    token,
    state: {
      ...state,
      sequence: token,
      channel,
      error: null,
      generation: state.generation + 1,
      switching: true,
      ownership: { ...state.ownership, channel: token },
    },
  }
}

/**
 * Adopt the candidate invalidation the shell performed while writing the
 * preference.
 *
 * `settings_set` invalidates the admitted candidate before it answers, so the
 * section drops its candidate at the same moment: the previously available or
 * downloaded target belonged to the channel the user just left. The channel
 * token stays held, because the feed that names the new channel is read after
 * this call returns.
 * @param state - Section state after `settings_set` resolved.
 * @param token - Token the save was begun with.
 * @returns The state without the previous channel's candidate, or `state` when the token is not held.
 */
export function commitChannelChange(
  state: UpdatesTransitionState,
  token: number,
): UpdatesTransitionState {
  if (state.ownership.channel !== token) return state
  return { ...state, update: { phase: 'idle' }, checked: false }
}

/**
 * Complete a channel change.
 *
 * The candidate was already invalidated when the shell accepted the write, so
 * this applies metadata only: the phase stays whatever the shell has published
 * since, including a candidate admitted for the new channel. A refusal restores
 * the previous channel, because the persisted preference was never written and
 * the shell left its candidate alone; a refresh that failed after the write
 * keeps the channel the user chose and reports the feed as unknown. A completion
 * whose token is no longer held changes nothing.
 * @param state - Section state when the save settled.
 * @param token - Token the save was begun with.
 * @param outcome - How the save ended relative to the write.
 * @returns The state with the save's own token released.
 */
export function completeChannelChange(
  state: UpdatesTransitionState,
  token: number,
  outcome: ChannelChangeCompletion,
): UpdatesTransitionState {
  if (state.ownership.channel !== token) return state
  const released: UpdatesTransitionState = {
    ...state,
    ownership: { ...state.ownership, channel: null },
    switching: false,
  }
  switch (outcome.commit) {
    case 'saved':
      return { ...released, error: null, feed: outcome.feed }
    case 'saved-unreadable':
      // The preference is persisted; only the feed naming it is unknown, and it
      // is configured per channel, so the previous channel's feed must not stand.
      return { ...released, error: 'channel', feed: null }
    case 'refused':
      return { ...released, error: 'channel', channel: outcome.previousChannel }
  }
}

/**
 * Begin the install/open action. Owns the section while it runs.
 *
 * The action token also covers the window before the shell publishes a working
 * phase, so a check or a channel switch cannot be started in between.
 * @param state - Section state before the install.
 * @returns The begun operation, or `null` when the install is not allowed.
 */
export function beginOpen(state: UpdatesTransitionState): UpdatesOperation | null {
  if (!canOpen(state)) return null
  const token = state.sequence + 1
  return {
    token,
    state: { ...state, sequence: token, error: null, ownership: { ...state.ownership, action: token } },
  }
}

/**
 * Complete the install/open action.
 *
 * The shell publishes phase changes through `dsh://update/state`, so this only
 * releases the action's own token; the phase is never invented here. A
 * completion whose token is no longer held changes nothing.
 * @param state - Section state when the confirmation settled.
 * @param token - Token the action was begun with.
 * @param ok - Whether the shell accepted the request.
 * @returns The state with the action's own token released.
 */
export function completeOpen(
  state: UpdatesTransitionState,
  token: number,
  ok: boolean,
): UpdatesTransitionState {
  if (state.ownership.action !== token) return state
  return {
    ...state,
    ownership: { ...state.ownership, action: null },
    error: ok ? null : 'action',
  }
}