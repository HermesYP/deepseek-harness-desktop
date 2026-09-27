import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopUpdatePresentation } from '../../../desktop-bridge/protocol.ts'

export type ReleaseChannel = 'stable' | 'beta'

export interface UpdatesSectionState {
  appVersion: string
  channel: ReleaseChannel
  feed: string | null
  update: DesktopUpdatePresentation
  checked: boolean
  busy: boolean
  channelBusy: boolean
  error: 'channel' | 'action' | null
}

/** Data and actions supplied by the client plugin to its Settings section. */
export interface UpdatesSectionInjected {
  readonly hooks: {
    readonly updates: SnapshotStore<UpdatesSectionState>
  }
  readonly check: () => Promise<void>
  readonly open: () => Promise<void>
  readonly selectChannel: (channel: ReleaseChannel) => Promise<void>
}
