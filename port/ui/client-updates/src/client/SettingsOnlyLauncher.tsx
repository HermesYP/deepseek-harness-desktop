import { useEffect, useRef, useState } from 'react'
import {
  Button, IconEllipsisOutlineMedium, IconSettingsOutlineMedium, Menu,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/** Props supplied by the Settings shell to the port-owned More launcher. */
export type SettingsOnlyLauncherProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.updates'>

/** Keep the sidebar More menu's Settings action without account-only rows. */
export function SettingsOnlyLauncher({ wide, settingsOpen, settingsShortcut, openSettings, t }: SettingsOnlyLauncherProps) {
  const trigger = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => { if (settingsOpen) setOpen(false) }, [settingsOpen])

  return (
    <Menu
      open={open}
      side="top"
      portal
      autoFocus
      anchor={(
        <Button
          ref={trigger}
          variant="ghost"
          size="sm"
          icon={<IconEllipsisOutlineMedium size={14} />}
          aria-label={t('menu')}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}
        >
          {wide ? t('more') : null}
        </Button>
      )}
      items={[{
        id: 'settings',
        label: t('settings'),
        icon: <IconSettingsOutlineMedium size={16} />,
        ...(settingsShortcut === undefined ? {} : { shortcut: settingsShortcut }),
      }]}
      onClose={() => { setOpen(false) }}
      onSelect={id => {
        if (id !== 'settings') return
        setOpen(false)
        trigger.current?.focus()
        openSettings()
      }}
    />
  )
}
