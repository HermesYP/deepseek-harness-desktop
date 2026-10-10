import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { UpdatesTransitionState } from './state.ts'

export type ReleaseChannel = 'stable' | 'beta'

/**
 * The published Updates section state.
 *
 * It is the transition state itself, so every rendered field — the phase, the
 * per-operation ownership tokens, the channel generation and the retained
 * errors — is a value the transitions in `state.ts` produced.
 */
export type UpdatesSectionState = UpdatesTransitionState

/** Data and actions supplied by the client plugin to its Settings section. */
export interface UpdatesSectionInjected {
  readonly hooks: {
    readonly updates: SnapshotStore<UpdatesSectionState>
  }
  readonly check: () => Promise<void>
  readonly open: () => Promise<void>
  readonly selectChannel: (channel: ReleaseChannel) => Promise<void>
}