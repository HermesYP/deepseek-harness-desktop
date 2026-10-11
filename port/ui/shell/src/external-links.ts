import { desktop, isDesktop } from '../../desktop-bridge/index.ts'
import { installDesktopExternalLinks } from '../../desktop-bridge/external-links.ts'

if (isDesktop()) installDesktopExternalLinks(desktop)
