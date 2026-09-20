import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

/** Light-theme `--background`: oklch(1 0 0). */
const PWA_BACKGROUND_COLOR = '#ffffff'

/** Light-theme `--primary`, the existing pink: oklch(0.525 0.223 3.958). */
const PWA_THEME_COLOR = '#c6005c'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    tailwindcss(),
    VitePWA({
      /**
       * A newly downloaded version WAITS instead of taking over. A registration
       * desk must never be reloaded while an operator is mid-entry, so the new
       * worker activates only once every tab has been closed.
       */
      registerType: 'prompt',
      /**
       * Registered explicitly from src/pwa/register.ts so a failure is logged
       * and can never block the application from rendering.
       */
      injectRegister: null,
      /** No development worker: stale dev caches are confusing. Test via preview. */
      devOptions: { enabled: false },
      /**
       * Emits `crossorigin="use-credentials"` on the manifest link.
       *
       * Production sits behind Vercel Authentication. Without credentials the
       * manifest request is redirected to the SSO origin and then blocked by
       * CORS, so the installed app loses its name, icons and standalone
       * display even though the page itself authenticated fine.
       *
       * The fix is to send the session cookie with the manifest request, NOT
       * to make the manifest public or to weaken the deployment protection.
       */
      useCredentials: true,
      // No includeAssets: globPatterns below already covers everything copied
      // from public/, and listing a file twice only risks a precache conflict.
      manifest: {
        name: 'Navaratri 2026 Registration',
        short_name: 'Navaratri 2026',
        description: 'Offline badge registration for Navaratri 2026',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        // Orientation is deliberately not locked: desks are landscape tablets
        // and desktops, but the form stays usable on a phone in portrait.
        background_color: PWA_BACKGROUND_COLOR,
        theme_color: PWA_THEME_COLOR,
        icons: [
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        /**
         * The whole built shell: markup, JS chunks, styles, icons and the
         * self-hosted Oswald woff2 files. Registration data is never cached
         * here — it lives in IndexedDB and only in IndexedDB.
         */
        globPatterns: ['**/*.{html,js,css,png,svg,ico,webp,woff2}'],
        /** Reloading `/` while offline serves the precached shell. */
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
        /** Never seize control of a page that is already open. */
        clientsClaim: false,
        skipWaiting: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
})
