import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { installThemes } from './theme/appearance'

// Before the first render, so the first frame already has the saved theme's colours.
installThemes(document, window.mergelane.initialState.appearanceTheme)
// Windows draws its window buttons over the top right; main.css keeps the headers clear of them.
document.documentElement.dataset.platform = window.mergelane.platform

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
