import '@fontsource-variable/oswald/wght.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from '@/App'
import ThemeProvider from '@/components/theme-provider'
import { bootstrapDatabase } from '@/db/bootstrap'

import './index.css'

/**
 * Seeds the local store without blocking first paint. A failure here must never
 * destroy or clear existing event data, so it is only logged.
 */
bootstrapDatabase().catch((error: unknown) => {
  console.error('Navaratri: local database bootstrap failed.', error)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
)
