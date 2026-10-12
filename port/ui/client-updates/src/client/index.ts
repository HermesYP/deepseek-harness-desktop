import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { desktop, tryDesktop } from '../../../desktop-bridge/index.ts'
import { en, zh } from './locales.ts'
import {
  adoptUpdate,
  applyStartupSettings,
  applyStartupStatus,
  beginChannelChange,
  beginCheck,
  beginOpen,
  commitChannelChange,
  completeChannelChange,
  completeCheck,
  completeOpen,
  initialTransitionState,
  startupStamp,
} from './state.ts'
import { UpdatesSection } from './UpdatesSection.tsx'
import type { ReleaseChannel, UpdatesSectionInjected, UpdatesSectionState } from './types.ts'
import type { UpdatesSettingsRead } from './state.ts'
import type { UpdateLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.updates': UpdateLocaleKey
  }
}

const NS = 'settings.updates'
const CHANNEL_KEY = 'updates.channel'

/** Cordis services used by the updater section. */
export const inject = ['locale', 'slots']

/** Register the desktop updater section in the preserved Settings shell. */
export function apply(ctx: Context): void {
  if (tryDesktop() === undefined) return
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-port-ui-updates: locale')

  const store = createSnapshotStore<UpdatesSectionState>(initialTransitionState())
  let active = true
  let configurationRead = 0

  /**
   * Read the persisted channel and feed selection.
   * @returns The channel, its configured feed, and the installed version.
   */
  const readSettings = async (): Promise<Required<UpdatesSettingsRead>> => {
    const [info, configuration] = await Promise.all([desktop.shellAppInfo(), desktop.updateConfiguration()])
    return { channel: configuration.channel, feed: configuration.feedUrl, configuration, appVersion: info.version }
  }

  const retryConfiguration = async (): Promise<void> => {
    const read = ++configurationRead
    const stamp = startupStamp(store.getSnapshot())
    try {
      const configuration = await readSettings()
      if (active && configurationRead === read) store.update(state => Object.assign(state, applyStartupSettings(state, configuration, stamp)))
    } catch (error) {
      if (active && configurationRead === read && store.getSnapshot().generation === stamp.generation) {
        store.update(state => { state.error = 'configuration'; state.configuration = null })
      }
      console.error('dsh-port-ui-updates: configuration read failed', error)
    }
  }

  ctx.effect(() => {
    let unlisten: (() => void) | undefined
    // The shell owns the update phase; every published presentation is adopted
    // verbatim, which is what makes `Later` preserve a downloaded `ready`.
    void desktop.onUpdateState(update => {
      if (!active) return
      store.update(state => Object.assign(state, adoptUpdate(state, update)))
    }).then(dispose => {
      if (active) unlisten = dispose
      else dispose()
    }).catch(error => { console.error('dsh-port-ui-updates: subscribe failed', error) })
    // Both startup reads are snapshots taken before any user action. The stamp
    // covers published events, operations that have begun since, and channel
    // switches, so a late answer cannot overwrite newer information.
    const stamp = startupStamp(store.getSnapshot())
    void desktop.updateStatus().then(update => {
      if (active) store.update(state => Object.assign(state, applyStartupStatus(state, update, stamp)))
    }).catch(error => { console.error('dsh-port-ui-updates: status failed', error) })
    void retryConfiguration()
    return () => {
      active = false
      unlisten?.()
    }
  }, 'dsh-port-ui-updates: updater state')

  /**
   * Check the packaged feed. Refused while another operation owns the section.
   */
  const check = async (): Promise<void> => {
    if (store.getSnapshot().configuration?.disabledReason != null) return
    const begun = beginCheck(store.getSnapshot())
    if (begun === null) return
    store.update(state => Object.assign(state, begun.state))
    const { token } = begun
    try {
      const update = await desktop.updateCheck()
      store.update(state => Object.assign(state, completeCheck(state, token, { ok: true, update })))
    } catch (error) {
      console.error('dsh-port-ui-updates: check failed', error)
      const noFeed = store.getSnapshot().feed === null
      store.update(state => Object.assign(state, completeCheck(state, token, { ok: false, noFeed })))
    }
  }

  /**
   * Open the shell-owned confirmation. Ownership is released when it returns;
   * the resulting phase arrives through `dsh://update/state`.
   */
  const open = async (): Promise<void> => {
    const begun = beginOpen(store.getSnapshot())
    if (begun === null) return
    store.update(state => Object.assign(state, begun.state))
    const { token } = begun
    try {
      await desktop.updateOpen()
      store.update(state => Object.assign(state, completeOpen(state, token, true)))
    } catch (error) {
      console.error('dsh-port-ui-updates: open failed', error)
      store.update(state => Object.assign(state, completeOpen(state, token, false)))
    }
  }

  /**
   * Persist a release-channel change.
   *
   * The write and the refresh that follows it are answered separately, because
   * the shell's own invalidation happens inside the write: a refusal before the
   * commit restores the previous channel and keeps the candidate, while a failed
   * refresh after the commit keeps the channel the user chose and reports its
   * feed as unknown. A check begun while this runs cannot say which channel it
   * answered for, so its result is discarded.
   */
  const selectChannel = async (channel: ReleaseChannel): Promise<void> => {
    const configuration = store.getSnapshot().configuration
    if (configuration !== null && (configuration.pinnedChannel !== null || !configuration.availableChannels.includes(channel))) return
    const previousChannel = store.getSnapshot().channel
    const begun = beginChannelChange(store.getSnapshot(), channel)
    if (begun === null) return
    store.update(state => Object.assign(state, begun.state))
    const { token } = begun
    try {
      await desktop.settingsSet({ key: CHANNEL_KEY, value: channel })
    } catch (error) {
      console.error('dsh-port-ui-updates: channel save failed', error)
      store.update(state => Object.assign(state, completeChannelChange(state, token, {
        commit: 'refused', previousChannel,
      })))
      return
    }
    store.update(state => Object.assign(state, commitChannelChange(state, token)))
    try {
      const { feed, configuration } = await readSettings()
      store.update(state => Object.assign(state, completeChannelChange(state, token, {
        commit: 'saved', feed, configuration, previousChannel,
      })))
    } catch (error) {
      console.error('dsh-port-ui-updates: channel refresh failed', error)
      store.update(state => Object.assign(state, completeChannelChange(state, token, {
        commit: 'saved-unreadable', previousChannel,
      })))
    }
  }

  const injected = (): UpdatesSectionInjected => ({ hooks: { updates: store }, check, open, selectChannel, retryConfiguration })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'updates',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, UpdatesSection))
}
