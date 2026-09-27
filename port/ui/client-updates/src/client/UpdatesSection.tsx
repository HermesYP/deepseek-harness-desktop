import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UpdatesSectionInjected, UpdatesSectionState } from './types.ts'

/** Render current update configuration and actions inside the Settings panel. */
export type UpdatesSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.updates'>
  & InjectFace<UpdatesSectionInjected>

/** Render feed selection and updater state for the Settings page. */
export function UpdatesSection({ useUpdates, check, open, selectChannel, t }: UpdatesSectionProps) {
  const state = useUpdates(value => value)
  const result = updateResult(state, t)
  const canOpen = state.update.phase === 'available' || state.update.phase === 'ready'

  return (
    <div>
      <p><strong>{t('currentVersion')}:</strong> {state.appVersion || t('unknownVersion')}</p>
      <fieldset disabled={state.channelBusy || state.busy}>
        <legend>{t('releaseChannel')}</legend>
        <label><input type="radio" name="dsh-update-channel" value="stable" checked={state.channel === 'stable'} onChange={() => { void selectChannel('stable') }} /> {t('stable')}</label>
        <label><input type="radio" name="dsh-update-channel" value="beta" checked={state.channel === 'beta'} onChange={() => { void selectChannel('beta') }} /> {t('beta')}</label>
      </fieldset>
      <p><strong>{t('configuredFeed')}:</strong> {state.feed ?? t('noFeed')}</p>
      <p><strong>{t('lastCheck')}:</strong> {result}</p>
      <p>{t('securityNote')}</p>
      {state.error !== null && <p role="alert">{t(state.error === 'channel' ? 'channelSaveFailed' : 'actionFailed')}</p>}
      <div>
        <button type="button" disabled={state.busy || state.channelBusy} onClick={() => { void check() }}>{t('check')}</button>
        {canOpen && <button type="button" onClick={() => { void open() }}>{t('installOpen')}</button>}
      </div>
    </div>
  )
}

function updateResult(
  state: Pick<UpdatesSectionState, 'update' | 'checked' | 'feed'>,
  t: UpdatesSectionProps['t'],
): string {
  if (state.update.phase === 'error') return state.feed === null ? t('noFeedCheck') : t('failed')
  if (!state.checked && state.update.phase === 'idle') return t('notChecked')
  switch (state.update.phase) {
    case 'idle': return t('upToDate')
    case 'checking': return t('checking')
    case 'available': return t('available', { version: state.update.version ?? '' })
    case 'downloading': return t('downloading', { percent: state.update.percent ?? 0 })
    case 'verifying': return t('verifying')
    case 'ready': return t('ready')
    case 'installing': return t('installing')
  }
}
