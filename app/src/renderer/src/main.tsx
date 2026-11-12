import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
