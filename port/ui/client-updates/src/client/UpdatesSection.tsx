import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { canChangeChannel, canCheck, canOpen, hasCandidate } from './state.ts'
import type { UpdatesSectionInjected, UpdatesSectionState } from './types.ts'

/** Render current update configuration and actions inside the Settings panel. */
export type UpdatesSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'settings.updates'>
  & InjectFace<UpdatesSectionInjected>

/** Render feed selection and updater state for the Settings page. */
export function UpdatesSection({ useUpdates, check, open, selectChannel, retryConfiguration, t }: UpdatesSectionProps) {
  const state = useUpdates(value => value)
  const result = updateResult(state, t)
  const configuration = state.configuration
  const delivery = configuration !== null && configuration.disabledReason === null
  const reason = configuration?.disabledReason

  return (
    <div>
      <p><strong>{t('currentVersion')}:</strong> {state.appVersion || t('unknownVersion')}</p>
      <fieldset disabled={configuration === null || configuration.availableChannels.length === 0 || !canChangeChannel(state)}>
        <legend>{t('releaseChannel')}</legend>
        <label><input type="radio" name="dsh-update-channel" value="stable" disabled={!configuration?.availableChannels.includes('stable')} checked={state.channel === 'stable'} onChange={() => { void selectChannel('stable') }} /> {t('stable')}</label>
        <label><input type="radio" name="dsh-update-channel" value="beta" disabled={!configuration?.availableChannels.includes('beta')} checked={state.channel === 'beta'} onChange={() => { void selectChannel('beta') }} /> {t('beta')}</label>
      </fieldset>
      <p><strong>{t('configuredFeed')}:</strong> {state.feed ?? t('noFeed')}</p>
      {reason != null && <p role="status">{t(reason === 'missing-key' ? 'missingKey' : reason === 'invalid-source' ? 'invalidSource' : reason === 'missing-channel' ? 'missingChannel' : 'missingSource')}</p>}
      <p><strong>{t('lastCheck')}:</strong> {result}</p>
      <p>{t('securityNote')}</p>
      {state.error !== null && <p role="alert">{t(state.error === 'configuration' ? 'configurationFailed' : state.error === 'channel' ? 'channelSaveFailed' : 'actionFailed')}</p>}
      <div>
        {state.error === 'configuration' && <button type="button" onClick={() => { void retryConfiguration() }}>{t('retryConfiguration')}</button>}
        <button type="button" disabled={!delivery || !canCheck(state)} onClick={() => { void check() }}>{t('check')}</button>
        {hasCandidate(state) && <button type="button" disabled={!delivery || !canOpen(state)} onClick={() => { void open() }}>{t('installOpen')}</button>}
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
    case 'downloading': return state.update.percent === undefined
      // A server that declares no length cannot produce a real percentage, so
      // the section reports progress honestly instead of inventing 0%.
      ? t('downloadingUnknown')
      : t('downloading', { percent: state.update.percent })
    case 'verifying': return t('verifying')
    case 'ready': return t('ready')
    case 'installing': return t('installing')
  }
}
