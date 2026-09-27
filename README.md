# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## Application routes

One origin, real pathnames, one storage namespace:

| Route | Module |
|---|---|
| `/` | Home — event operations launcher |
| `/badge-registration` | Attendee badge workflow |
| `/device-registration` | Provision and inspect this physical device |

Dandiya and Prizes are shown on Home as **Coming soon** and are inert — there
are no routes behind them yet.

Routing is presentation only. Changing the pathname creates no second database
or storage namespace: IndexedDB, the trusted-device marker, the operator
session cookie, the service worker, the device identity, the badge range,
registrations and the outbox all belong to the origin, not the path.

`vercel.json` carries **explicit** rewrites for the two non-root routes, so a
direct visit or refresh works while `/api/*` can never be captured by the SPA
fallback. The service worker's navigation fallback serves the cached shell for
deep links offline, with `/api/` denylisted.

## Admin control plane

`/admin` manages the **central device registry**: events, devices, device
attributes and badge-range assignment. Full detail in
**[docs/ADMIN.md](docs/ADMIN.md)**.

Admin is a **separate security realm** from Operator Access — different
cookie, different secret, different lifetime (12 hours vs 14 days). Neither
credential satisfies the other, and the event application is never wrapped in
Admin auth.

It needs `DATABASE_URL`, `EVENT_ADMIN_ACCESS_CODE` (8+) and
`EVENT_ADMIN_SESSION_SECRET` (32+). With any absent, `/admin` fails closed and
the event application is unaffected.

Admin signatures are domain-separated, so each realm rejects the other's token
**even if the two secrets were identical** — separation is enforced in code,
not by an operational rule. `/admin` does not sit behind Operator Access.

Admin manages **devices, not attendees**, and is online-only: registry data is
never cached in IndexedDB.

Device capabilities are `registration` and `prizes`. **Registration includes
physical badge issuance** — issuing is the last step of registering an
attendee, so it is one permission, not two. The badge range stays separate
data: `registration` says a device may run the workflow, `badge_assignments`
says which physical numbers it owns.

Admin can also provision the credentials a device will eventually sign in
with: a login name plus a device password, stored as a `node:crypto` scrypt
hash. The policy is 8–128 characters, taken exactly — nothing is trimmed, case
folded or Unicode normalised, and spaces count. Admin sees only whether
credentials are `Configured`; the hash, its salt and the session version never
leave the server, and a password is never shown again after it is set.

> **Phase 9C-A stores credentials. It does not enable device login.**
>
> There is no device login endpoint, session or cookie. Devices still use
> Operator Access, and provisioning a password activates nothing.
> `password_hash = NULL` means *not provisioned* — never *passwordless*.

**Still deliberately absent:** device login, a heartbeat, central enforcement
of `enabled`, and badge-range self-claim. `/device-registration` remains the
transitional local flow and is not yet linked to central records. Those
connect in the later 9C phases.

## Central database (Phase 9A — foundation only)

A Neon PostgreSQL database holds **central operational metadata**: events,
devices, device attributes and badge-range assignments. Full detail in
**[docs/DATABASE.md](docs/DATABASE.md)**.

**Nothing in the live application depends on it yet.** With `DATABASE_URL`
absent the app still loads, authenticates, routes, registers devices,
configures badge distribution, works offline, issues badges and syncs to
Google Sheets. Only a deliberate database call fails, and it fails closed.

| Store | Owns |
|---|---|
| IndexedDB | The offline workflow, and the live `nextBadge` counter |
| Google Sheets | The attendee ledger |
| PostgreSQL | Events, devices, attributes, badge-range assignments |

**No attendee data is stored centrally** — no name, phone, age, gender or
payment. **No central badge counter**: Postgres owns which *range* a device
holds, `nextBadge` stays local so a disconnected desk keeps issuing.

```bash
pnpm db:generate   # author SQL from the schema; needs no database
pnpm db:migrate    # apply it, deliberately, one environment at a time
pnpm db:check      # read-only: connection, tables, guarantees
```

Migrations are never automatic — not in the build, the start command, a
Function, app bootstrap or `release:check`. Development and Production must
never share a database branch.

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

9. Set the release interlock (also server-only, also never `VITE_`):

   ```bash
   SYNC_WRITE_ENABLED=true
   SYNC_ALLOWED_VERCEL_ENV=development
   ```

   Credentials existing on a deployment is deliberately **not** enough to write
   to the event ledger. See *Production and event day* below.

   Locally you must also supply `VERCEL_ENV` yourself when starting the server -
   see *Testing it locally*.

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

## Production and event day

Two documents carry the operational detail:

- **[docs/PRODUCTION_RELEASE_CHECKLIST.md](docs/PRODUCTION_RELEASE_CHECKLIST.md)** -
  the PASS/FAIL gates to work through before going live
- **[docs/EVENT_DAY_RUNBOOK.md](docs/EVENT_DAY_RUNBOOK.md)** - what to do at the
  desk, including every failure mode and read-only inspection helpers

```bash
pnpm release:check
```

is a local, read-only repository audit: required files, documented variable
names, no `VITE_`-prefixed server secrets, no service-account JSON, no
private-key block, no `process.env` in client code. It never writes, deploys,
runs git or contacts Google.

### Multi-device badge partitioning

The event runs on several registration devices. They do **not** coordinate badge
numbers through a shared online counter — the app is offline-first, and a shared
counter means two disconnected desks can hand out the same physical badge.

Instead **every device owns a non-overlapping physical badge range**, stored
locally in its own IndexedDB `EventConfig`:

| Device | Range |
|---|---|
| Registration Desk A | #001-#250 |
| Registration Desk B | #251-#500 |
| Registration Desk C | #501-#750 |

On first run a device shows **Device Setup**: a name, a badge range, and a
mandatory confirmation that the matching physical badges are at that desk. It
generates a stable `deviceId` and sets `nextBadge` to the range start.

**The physical stack is authoritative.** The software cannot stop an organizer
from handing two desks overlapping badge stacks. The server's badge-collision
guard is a backstop that fires *after* sync and cannot un-hand two duplicate
badges already given out offline.

Setup **fails closed around existing data**: a device that already holds
registrations or queued outbox rows is never stamped with an identity, and
nothing is deleted.

Range assignment is **one-time** in Phase 7A. There is no edit or reset control,
deliberately: changing a range while other devices operate offline is exactly
how duplicates happen. Emergency reassignment is separate future work.

When a range runs out the desk says so, names its own range, and **Hold
Registration keeps working** — the attendee can be sent to another desk.

Every new registration snapshots `deviceId` and `deviceName` at write time, so
the queued outbox row already carries its own provenance and both Sheet tabs
record which desk issued what.

#### What this does NOT solve

- **Cross-device attendee duplicate detection.** Duplicate phone+name checking
  reads local IndexedDB, so it is strong *per device*. Two desks do not share a
  database, and the Sheet is a ledger, not a live client database. Badge
  uniqueness is solved by range partitioning; attendee identity across devices
  is a separate future concern.
- **Cross-device Resume.** A held registration is resumable on the **same
  device**, because local IndexedDB owns the workflow state. A hold appearing in
  Google Sheets does not make it resumable elsewhere.

#### Device registration is not badge distribution

These are two different things, and the distinction matters:

| Concept | Means | Required for |
|---|---|---|
| **Device registration** | This physical device has a name and a stable `deviceId`. | Every event device, whatever it does |
| **Badge distribution** | This device additionally owns a finite, non-overlapping badge range. | Only devices that hand out badges |

A prize desk or a dandiya desk is a fully registered device that owns no badge
range at all, and that is a healthy state — not a half-finished setup. One
device may later serve several modules, which is why this is **not** modelled
as a single `deviceType`: identity is stable, and each module attaches its own
optional configuration to it.

So:

- `/device-registration` asks only for a **device name**. No badge fields.
- `/badge-registration` has three states: register the device → assign a badge
  range → run the workflow. Badge setup lives at the front of the badge module
  because owning badges is that module's concern.
- `holdRegistration` and `issueBadge` require **badge distribution**, not mere
  registration, enforced inside their own transactions.
- An existing Phase 7 device with identity *and* a range already satisfies
  both, and is never sent through either setup again.

Future modules attach their own local configuration to the same stable device
identity. There is deliberately no generic capability framework yet.

#### Device Readiness

An unlocked, configured device has a **Device Readiness** panel behind the
clipboard icon in the header. It is a **read-only** operational view: device
identity and assigned range, local counts (completed / held / pending sync),
and event-device state (network, service worker, app mode, persistent storage,
operator access). A **Copy device summary** button puts the same facts on the
clipboard for the range plan.

Every dynamic value is read **fresh from IndexedDB** each time the panel opens,
when *Refresh checks* is pressed, and when connectivity changes — never copied
from another component's configuration hook, because `nextBadge` and the outbox
count change while the desk works.

It contains no control that edits a range, resets a badge number, changes a
device id, clears data or logs out. Diagnostics observe; they never mutate.

#### Device Range Plan and provisioning

Three documents cover event-device setup:

- **[docs/DEVICE_RANGE_PLAN.md](docs/DEVICE_RANGE_PLAN.md)** — the central
  record of which range belongs to which device, plus the reserve-range policy
- **[docs/DEVICE_PROVISIONING.md](docs/DEVICE_PROVISIONING.md)** — the
  per-device workflow, including the offline test
- **[docs/VERCEL_FIREWALL.md](docs/VERCEL_FIREWALL.md)** — the operator-login
  rate-limit rule

The range plan is a **human artifact**. The application never reads or writes
it; the server only ever touches Badge Register and Held Registrations, so
renaming an unused `Sheet1` to `Device Range Plan` is safe.

Where enough badges exist, keep a **reserve range assigned to no device**, so a
desk that exhausts its range early has somewhere to go. Transferring the
reserve is not something the app can do today — the safe procedure has to
account for badges already issued and rows not yet synced.

### Operator access (application authentication)

The production site is a normal origin:

```
https://navaratri.neelluu.com
```

First use on a new device shows an **Operator Access** screen. Entering the
shared access code exchanges it, server-side, for a signed session stored in an
HttpOnly cookie that lasts 14 days - long enough to cover the whole event
without a second unlock.

Two server-only variables configure it (never `VITE_` prefixed):

| Variable | Meaning |
|---|---|
| `EVENT_OPERATOR_ACCESS_CODE` | The shared desk code. Minimum 12 characters, compared exactly. Use a strong passphrase, **not** a 6-digit PIN. |
| `EVENT_SESSION_SECRET` | HMAC-SHA256 signing key, minimum 32 characters. **Rotating it revokes every existing session.** |

Permanent facts about this layer:

- **The operator session is the production API auth boundary.**
  `/api/sync-registration` requires it, and the check runs *before* the release
  interlock - an unauthenticated caller learns nothing about how the deployment
  is configured.
- **Origin restriction is not authentication.** Neither `SYNC_ALLOWED_ORIGIN`
  nor the same-origin check on the auth routes identifies a user. Only the
  signed cookie grants API access.
- **The access code is never stored client-side** - not in IndexedDB, not in
  localStorage, not in sessionStorage. It is sent once and discarded.
- The browser cannot read the session cookie; it is `HttpOnly`, `Secure`,
  `SameSite=Strict`, `Path=/`, `__Host-` prefixed and carries no `Domain`.
- A **trusted-device marker** in localStorage records only that this device has
  completed a real unlock. It holds no token and grants no API authority - it
  exists so an already-unlocked desk can reopen the PWA offline.
- **Offline registration still works** on a previously unlocked device.
- **If the session expires, pending outbox rows are retained.** The form is
  never replaced by a login screen mid-registration; a banner offers Unlock and
  synchronization resumes after it.

Vercel Authentication remains enabled in front of production until this layer is
proven in a real deployment, and is then disabled manually. It is no longer
required once first-party operator access is working.

### The sync release interlock

Two server-only variables gate every Sheet write:

| Variable | Meaning |
|---|---|
| `SYNC_WRITE_ENABLED` | Must be **exactly** `true`. Unset, blank, `false`, `TRUE`, `1`, `yes` and padded values like `" true"` all mean **disabled**. Not trimmed, not case-folded. |
| `SYNC_ALLOWED_VERCEL_ENV` | Exactly `development`, `preview` or `production`. Must exactly equal the runtime `VERCEL_ENV`, which is not trimmed either. |

A whitespace or casing typo is a configuration failure to fix, not something the
code repairs for you.

Both must be satisfied, and `VERCEL_ENV` must be present at all. Otherwise the
endpoint returns the existing `sync-not-configured` response, makes no Google
API call, and reads no credentials. The browser keeps its rows queued, shows
`Sync issue`, and registration carries on locally — nothing is lost.

There is deliberately **no fallback that assumes `development`** when
`VERCEL_ENV` is missing. Deployed Production and Preview runtimes get the value
from Vercel itself; locally you supply it explicitly.

This exists because the repository is connected to Vercel Git auto-deployment. A
push can create a deployment before production credentials and access protection
are intentionally ready. **Sheet writes must never become possible merely
because credentials happen to exist.**

### Environment policy

| Environment | Policy |
|---|---|
| **Development** | `SYNC_ALLOWED_VERCEL_ENV=development`, `SYNC_WRITE_ENABLED=true`, pointed at a **disposable** test spreadsheet only. Locally, `VERCEL_ENV` must be supplied explicitly when starting the server. |
| **Preview** | Preferred: **no** Google sync credentials at all, writes disabled. Git pushes create previews; a preview must never touch the final ledger. If preview testing is genuinely needed, use a disposable preview-only spreadsheet with `SYNC_ALLOWED_VERCEL_ENV=preview`. |
| **Production** | `SYNC_ALLOWED_VERCEL_ENV=production`. `SYNC_WRITE_ENABLED` stays unset until **every** gate in the release checklist passes - deployment protection included. |

> `SYNC_ALLOWED_ORIGIN` is a same-origin guard. **It is not authentication.** Any
> direct HTTP client can set an Origin header. Before enabling production
> writes, the deployment must be protected by Vercel Authentication, Password
> Protection, or an explicitly approved authentication layer in a future phase.

### Server runtime notes

Vercel Functions run as **Node ESM**, and Node does not guess file extensions
for relative imports. Every relative specifier under `api/` and `server/`
therefore carries an explicit `.js` extension in the TypeScript source -
TypeScript resolves it back to the `.ts` file for typechecking:

```ts
import { readSyncEnvironment } from '../server/sync/environment.js'
```

`tsconfig.server.json` uses `NodeNext` module resolution so an extensionless
relative import fails typecheck instead of crashing the deployed function at
module load. `pnpm release:check` enforces the same rule independently.

Production sits behind **Vercel Authentication**, so the PWA manifest link is
emitted with `crossorigin="use-credentials"` (`useCredentials: true` in the
VitePWA config). Without it the manifest request is redirected to the SSO origin
and blocked by CORS, and the installed app loses its name, icons and standalone
display.

### Persistent storage

Once the local database is ready the app asks the browser for persistent
storage, which resists automatic eviction under storage pressure. The request
never blocks startup or registration, is made at most once per session, and a
refusal changes nothing.

It is **not a backup**. It does not survive Clear Site Data, uninstalling the
app, a wiped profile or a failed device. Google Sheets is the ledger for
snapshots already acknowledged; anything still pending exists only on the
device.

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
use the Vercel CLI, which runs the function and the Vite dev server together.

Pull the Development-scoped variables from the Vercel project first, if you keep
them there:

```bash
pnpm dlx vercel@latest env pull .env.development.local --environment=development
```

Then start the server **with `VERCEL_ENV` supplied explicitly**:

```bash
env VERCEL_ENV=development pnpm dlx vercel@latest dev --listen 3001
```

The `env VERCEL_ENV=development` prefix is required. We verified in this project
that `vercel dev` does **not** expose `VERCEL_ENV` to the server function, so
without it the interlock correctly fails closed with `sync-not-configured` and
no sync happens. That guard is intentional and is not weakened for local use -
the server never assumes `development` when the value is absent.

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
