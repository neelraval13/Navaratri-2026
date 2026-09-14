# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Local UPI setup

The payment QR pays the organizer's **personal** UPI ID. Real values are
intentionally never committed.

1. Create `.env.local` in the project root (it is already git-ignored):

   ```bash
   VITE_UPI_ID=<YOUR_REAL_UPI_ID>
   VITE_UPI_PAYEE_NAME=<YOUR_PAYEE_NAME>
   ```

   `.env.example` lists the names with no values.

2. Restart `pnpm dev` after changing them — Vite reads environment variables at
   startup, so a hot reload is not enough.

On startup these are copied into the stored event configuration. A blank or
absent value leaves the existing stored value alone, and badge numbering is
never affected.

Two things this does not do:

- The QR only presents the payment request. Completing it still requires the
  attendee's own UPI app and their connectivity.
- Payment confirmation in this application is **manual**. There is no gateway
  and no automatic detection — the operator presses `Payment Confirmed`.

## Offline / PWA testing

The service worker is disabled in `pnpm dev` on purpose — stale dev caches are
confusing. Test the real thing against a production build:

```bash
pnpm build
pnpm preview
```

1. If you are testing UPI, make sure `.env.local` exists first (see above).
2. Open the preview URL **while online**.
3. Wait for the service worker to install and take control — DevTools →
   Application → Service Workers shows "activated and is running".
4. Check DevTools → Application: Manifest shows *Navaratri 2026 Registration*
   with its icons, and Cache Storage contains the generated app cache.
5. Set DevTools → Network to **Offline**.
6. Reload the page. The registration UI should open normally.
7. Run through registration: attendee entry, duplicate lookup, Hold, Resume,
   Cash payment and Issue Badge all work offline.
8. Set Network back to **Online**. The header indicator changes on its own; no
   reload is needed and nothing is uploaded.

Worth knowing:

- **The very first visit cannot work offline** — the app has to be cached once
  while online before it can open without a network.
- Registrations, event config and the outbox live in **IndexedDB**, never in the
  service worker's caches. The worker only stores the built app shell.
- The outbox is **not synchronized yet**. `Online` means only that the browser
  reports connectivity — nothing is sent anywhere.
- The UPI QR renders offline because it is generated locally. Completing the
  actual payment still needs the payer's own UPI app and their connectivity.
- A new app version downloaded in the background never reloads a page that is
  open. It takes over the next time every tab has been closed.

## React Compiler

The React Compiler is enabled on this template. See [this documentation](https://react.dev/learn/react-compiler) for more information.

Note: This will impact Vite dev & build performances.
You can also try [the experimental native React Compiler support in plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/README.md#rust-react-compiler) by using `compiler: true` in the plugin options instead of using the Babel plugin.

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```
