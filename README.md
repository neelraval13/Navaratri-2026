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

## Google Sheets sync setup (server only)

`POST /api/sync-registration` upserts one registration into a central Google
Spreadsheet. Credentials are server-side only and never reach the browser.

1. Create (or pick) a **Google Cloud project**.
2. Enable the **Google Sheets API** for it.
3. Create a **service account**, then create a JSON key for it.
4. From that JSON take `client_email` and `private_key`. **Do not commit the
   JSON file**, and do not add it to the repository in any form.
5. Create or open the target **Google Spreadsheet** and copy its ID from the URL
   (`https://docs.google.com/spreadsheets/d/<THIS_PART>/edit`).
6. **Share that spreadsheet with the service-account email as an Editor.** Sync
   fails until you do; the server never creates a spreadsheet of its own.
7. Set these server environment variables (locally in `.env.local`, and in the
   Vercel project settings for a deployment):

   ```bash
   GOOGLE_SHEETS_SPREADSHEET_ID=<spreadsheet id>
   GOOGLE_SERVICE_ACCOUNT_EMAIL=<...@...iam.gserviceaccount.com>
   GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
   SYNC_ALLOWED_ORIGIN=http://localhost:3000
   ```

   Escaped `\n` sequences in the private key are fine - the server converts them
   to real newlines.

8. **Never prefix these with `VITE_`.** Anything named `VITE_*` is compiled into
   the browser bundle; a private key there would be public.

The server creates the two tabs it owns - **Badge Register** and **Held
Registrations** - if they are missing, writes their header rows, freezes the
header, hides the technical columns and formats the badge column - all in one
atomic request.

A tab is only initialized when it is *completely* blank. Sync fails closed
rather than touching a tab that has a different or partial header, a blank
header with data underneath it, or two rows sharing one Registration ID. Other
tabs are never read or modified.

Note on `SYNC_ALLOWED_ORIGIN`: it stops another website's page from driving the
endpoint, but it is **not user authentication** - any direct HTTP client can send
whatever Origin header it likes. Before exposing this publicly, put the
deployment behind access control or add a real authentication layer.

## Outbox synchronization

**IndexedDB is the operational source of truth.** Every registration action -
Hold, Resume, Issue Badge - is committed locally first and never waits for the
network. Google Sheets is a ledger the browser catches up to afterwards.

Each registration owns exactly one outbox row, keyed `registration:<id>`. A
background processor drains that queue by POSTing one snapshot at a time to
`/api/sync-registration`. It starts only after the local database has
bootstrapped, and it runs automatically on:

- app start
- a local Hold or Issue Badge commit
- the browser coming back online
- the tab regaining focus or becoming visible
- a retry timer for rows that failed

Registration never blocks on any of this. A sync error is reported in the header
and nothing else; the operator keeps working, and the record is already safe
locally.

**Offline** simply means rows accumulate. The header shows how many are pending
and they are sent once connectivity returns.

While the browser reports offline nothing is attempted at all - no request, no
attempt counted, no error recorded - and that applies to the manual Retry
button too. There is nothing to retry into, and a failed attempt would only push
the row further down its backoff. Offline is a connectivity state, not a sync
failure.

### What "Synced" means

`Synced` means **the local outbox is empty** - every registration this device
has written has been accepted by the server. It is not a claim about anyone
else's device.

### Why acknowledgement is conditional

An outbox row is deleted **only when the exact snapshot that was sent is still
the one stored** - matched on both registration id and the payload's
`updatedAt`. This is what protects the Held -> Completed transition: if an
attendee is held, the request is sent, and the badge is issued before the
response arrives, the newer completed snapshot has already overwritten that row.
The held response then acknowledges nothing, and the completed snapshot is sent
in the same cycle. A stale failure cannot contaminate a newer snapshot for the
same reason.

### Retries and errors

Transient problems - a timeout, a network error, an unreadable response, a 429
or any 5xx - are retried with a growing delay (5s, 15s, 30s, 60s, then every 5
minutes).

Some failures need a human instead and are shown as `Sync issue`:

- `badge-conflict` - that badge number already belongs to a different
  registration in the Sheet. The physical badge is already in someone's hand, so
  the server refuses to overwrite it and **a person must reconcile the ledger.**
- `sheet-shape-conflict` - the spreadsheet is not in the shape the app owns.
- `invalid-request`, `forbidden-origin`, `sync-not-configured` - configuration
  problems that retrying cannot fix.

The endpoint is idempotent on Registration ID, so replaying a snapshot never
creates a second row.

### Testing it locally

The endpoint is a Vercel Function, so plain `pnpm dev` does **not** serve it -
use the Vercel CLI, which runs the function and the Vite dev server together:

```bash
pnpm dlx vercel@latest dev --listen 3001
```

Set `SYNC_ALLOWED_ORIGIN=http://localhost:3001` to match. Google credentials
stay server-side; the browser never holds them and never imports `googleapis`.

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
- `Online` is a **connectivity** indicator only. Synchronization has its own
  separate indicator next to it (see *Outbox synchronization* above).
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
