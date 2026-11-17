import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { MenuBarPanel } from './components/MenuBarPanel'
import { TrayFlyout } from './components/TrayFlyout'
import { installThemes } from './theme/appearance'
import { themeOnPlatform } from '@shared/themes'

// Before the first render, so the first frame already has the saved theme's colours (Liquid Glass shows as
// Porcelain on Windows, which doesn't offer it).
installThemes(
  document,
  themeOnPlatform(window.mergelane.initialState.appearanceTheme, window.mergelane.platform)
)
// main.css draws the Windows 11 look under data-platform="win32" (ADR-0060).
document.documentElement.dataset.platform = window.mergelane.platform

// The same page draws the notification-area flyout on Windows and the menu bar's menu on the Mac, each in its
// own small window (main/notificationArea.ts loads it with #tray, ADR-0061; main/menuBarPanel.ts with #menubar,
// ADR-0067).
const place = window.location.hash

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {place === '#tray' ? <TrayFlyout /> : place === '#menubar' ? <MenuBarPanel /> : <App />}
  </StrictMode>
)
