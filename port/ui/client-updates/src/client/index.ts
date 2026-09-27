import type { Context } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { desktop } from '../../../desktop-bridge/index.ts'
import type { SettingsMap } from '../../../desktop-bridge/protocol.ts'
import { en, zh } from './locales.ts'
import { UpdatesSection } from './UpdatesSection.tsx'
import { SettingsOnlyLauncher } from './SettingsOnlyLauncher.tsx'
import type { ReleaseChannel, UpdatesSectionInjected, UpdatesSectionState } from './types.ts'
import type { UpdateLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'settings.updates': UpdateLocaleKey
  }
}

const NS = 'settings.updates'
const CHANNEL_KEY = 'updates.channel'
const FEEDS = { stable: 'updates.feed-url', beta: 'updates.feed-url-beta' } as const

/** Cordis services used by the updater section. */
export const inject = ['locale', 'slots']

/** Register the desktop updater section in the preserved Settings shell. */
export function apply(ctx: Context): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-port-ui-updates: locale')

  const store = createSnapshotStore<UpdatesSectionState>({
    appVersion: '',
    channel: 'stable',
    feed: null,
    update: { phase: 'idle' },
    checked: false,
    busy: false,
    channelBusy: false,
    error: null,
  })

  const reload = async (): Promise<void> => {
    const [info, settings] = await Promise.all([desktop.shellAppInfo(), desktop.settingsList()])
    const channel = selectedChannel(settings)
    store.update(state => {
      state.appVersion = info.version
      state.channel = channel
      state.feed = selectedFeed(settings, channel)
    })
  }

  ctx.effect(() => {
    let active = true
    let unlisten: (() => void) | undefined
    void desktop.onUpdateState(update => {
      store.update(state => {
        state.update = update
        if (update.phase === 'idle' || update.phase === 'available' || update.phase === 'error') {
          state.checked = true
        }
      })
    }).then(dispose => {
      if (active) unlisten = dispose
      else dispose()
    }).catch(error => { console.error('dsh-port-ui-updates: subscribe failed', error) })
    void desktop.updateStatus().then(update => {
      if (active) store.update(state => { state.update = update })
    }).catch(error => { console.error('dsh-port-ui-updates: status failed', error) })
    void reload().catch(error => { console.error('dsh-port-ui-updates: initial read failed', error) })
    return () => {
      active = false
      unlisten?.()
    }
  }, 'dsh-port-ui-updates: updater state')

  const check = async (): Promise<void> => {
    store.update(state => { state.busy = true; state.error = null })
    try {
      const update = await desktop.updateCheck()
      store.update(state => { state.update = update; state.checked = true })
      await reload()
    } catch {
      const noFeed = store.getSnapshot().feed === null
      store.update(state => {
        state.update = { phase: 'error' }
        state.checked = true
        state.error = noFeed ? null : 'action'
      })
    } finally {
      store.update(state => { state.busy = false })
    }
  }

  const open = async (): Promise<void> => {
    store.update(state => { state.error = null })
    try {
      await desktop.updateOpen()
    } catch {
      store.update(state => { state.error = 'action' })
    }
  }

  const selectChannel = async (channel: ReleaseChannel): Promise<void> => {
    store.update(state => { state.channelBusy = true; state.error = null })
    try {
      await desktop.settingsSet({ key: CHANNEL_KEY, value: channel })
      await reload()
      store.update(state => { state.update = { phase: 'idle' }; state.checked = false })
    } catch {
      store.update(state => { state.error = 'channel' })
    } finally {
      store.update(state => { state.channelBusy = false })
    }
  }

  const injected = (): UpdatesSectionInjected => ({ hooks: { updates: store }, check, open, selectChannel })
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'updates',
    order: 30,
    label: () => t('nav'),
    locale: NS,
    inject: injected,
  }, UpdatesSection))
  ctx.slots.inject('settings.launcher', () => ctx.slots.register({
    name: 'settings.launcher',
    priority: 100,
    locale: NS,
  }, SettingsOnlyLauncher))
}

function selectedChannel(settings: SettingsMap): ReleaseChannel {
  return settings[CHANNEL_KEY] === 'beta' ? 'beta' : 'stable'
}

function selectedFeed(settings: SettingsMap, channel: ReleaseChannel): string | null {
  const value = settings[FEEDS[channel]]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}
