import '@fontsource-variable/oswald/wght.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import ThemeProvider from '@/components/theme-provider'
import { registerServiceWorker } from '@/pwa/register'

import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)

// After render, deliberately: offline support must never be able to stop the
// application from starting.
registerServiceWorker()
