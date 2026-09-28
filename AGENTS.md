# AGENTS.md

## Project

Navaratri 2026 Event Registration Application

This is a small, offline-first event registration application used by event
staff to collect attendee details, confirm a ₹20 payment, allocate pre-made
physical badge numbers, and eventually synchronize records to Google Sheets.

The application must remain simple, reliable, fast, and usable at an event
registration desk.

---

## Core Product Model

The core relationship is:

Person → Payment → Physical Badge

Badges are pre-made physical badges.

The application does NOT print badges or generate personalized badges.

The application tells the operator which numbered physical badge to hand out.

A badge number is consumed ONLY when the operator explicitly issues the badge.

---

## Current Architecture

Frontend:
- React
- TypeScript
- Vite

UI:
- Tailwind CSS v4
- shadcn
- Base UI
- Maia style
- Lucide icons

Typography:
- Oswald Variable
- Self-hosted through Fontsource
- Do not introduce remote Google Fonts

Theme:
- Light mode
- Dark mode
- Pink semantic primary
- Neutral surfaces

Local persistence:
- Dexie
- IndexedDB
- database name: `navaratri-2026-registration`
- version 1
- tables: registrations, config, outbox

Payment QR:
- qrcode, generated locally in the browser
- organizer's personal UPI
- no payment gateway

Offline architecture:
- PWA, installable via the browser's own install flow
- vite-plugin-pwa with a Workbox-generated service worker

Backend:
- Vercel Function at `POST /api/sync-registration`
- Google Sheets API via `googleapis`
- Google service account, server-side credentials only

Do not change the agreed architecture unless explicitly instructed.

---

## Design System

Use the existing design system.

Typography:
- Oswald Variable throughout the application

Primary identity:
- Pink

Semantic colors:
- Primary / actions → Pink
- Success → Green
- Warning / Hold → Amber
- Error / Duplicate → Red
- Neutral information → Gray

Do not use pink for semantic success, warning, or error states.

Geometry:
- Maia-style soft rounded geometry
- Large touch-friendly controls
- Approximately 12–16px card/control radii where appropriate

Interaction:
- Optimize primarily for desktop and tablet event desks
- Mobile must remain usable
- Minimum important controls should be comfortably touchable
- Prefer clear hierarchy over dense information

Avoid:
- gradients
- glassmorphism
- decorative illustrations
- excessive shadows
- unnecessary animations
- arbitrary colors when semantic design tokens already exist

Use semantic Tailwind/shadcn tokens whenever possible:

- bg-background
- text-foreground
- text-primary
- text-muted-foreground
- border-border
- bg-card
- etc.

Do not scatter arbitrary pink classes throughout the application when the
semantic primary token is appropriate.

---

## Theme Rules

The application supports:

- Light
- Dark
- System preference on first use

Manual theme choice is persisted locally.

Do not remove or bypass the existing ThemeProvider.

Do not hardcode pages to dark or light colors.

---

## React Component Style

For application-owned `.tsx` components, use this form wherever reasonable:

```tsx
import type * as React from 'react'

interface ExampleProps {
  // props
}

const Example: React.FC<ExampleProps> = ({
  // props
}) => {
  return (
    // JSX
  )
}

export default Example
```

For components without props:

```tsx
import type * as React from 'react'

const Example: React.FC = () => {
  return (
    // JSX
  )
}

export default Example
```

Exceptions:
- entry-point files such as `main.tsx`
- hooks
- contexts
- utility files
- shadcn-generated UI primitives
- cases where the pattern clearly does not apply

Do not rewrite shadcn registry components merely to satisfy this convention.

---

## Component Structure

Do not allow `App.tsx` to become a giant application file.

Prefer small feature components.

Registration-related application components should live under:

```text
src/components/registration/
```

For example:

```text
registration-form.tsx
registration-form-header.tsx
registration-form-footer.tsx
attendee-details-step.tsx
payment-step.tsx
```

Use sensible names based on actual responsibility.

Do not over-componentize trivial markup.

---

## Registration Workflow

The registration UI is a two-step workflow.

### Form Header

The registration FORM header displays:

BADGE TO BE ALLOCATED

#xxx

The badge number should be visually dominant.

This is NOT the global application header.

The global app shell may independently contain the event name and theme toggle.

---

## Step 1 — Attendee Details

Fields:

Phone Number
- fixed +91 visual prefix, never part of the stored value
- digits only
- exactly 10 digits
- stored internally as raw digits, for example `9876543210`
- displayed as `XXXXX XXXXX`, for example `98765 43210`
- an invalid character attempt is rejected and the existing value is preserved
- an 11th digit is never accepted
- parents may reuse the same phone number for multiple children

Name
- at least one non-whitespace character after trimming

Age
- digits only
- range 0–120 inclusive
- a value above 120 is never accepted

Gender
- Male
- Female
- no default selection

The phone number is intentionally entered before the name.

Rejected input is signalled with a brief jitter on the field, never a toast or
a modal.

### Step 1 Progression

Next remains visually actionable. It is not disabled.

Next must never reach Step 2 unless every attendee detail is valid.

When Next is blocked, guide the operator to the FIRST invalid field in this
order:

Phone → Name → Age → Gender

Focus that field, jitter it, and show a concise inline message for it.

Validation feedback must not appear on initial render. It appears once a field
has become relevant through interaction, or once Next has been blocked by it.

A field's message and its `aria-invalid` state clear as soon as it becomes
valid.

---

## Duplicate Logic

Phone number alone is NOT a duplicate.

A parent may register multiple children using the same phone number.

Step 1 checks the local database READ-ONLY. It never writes.

### Name Normalization

The comparison form is exactly:

1. trim leading whitespace
2. trim trailing whitespace
3. collapse repeated internal whitespace to one space
4. lowercase

`Rahul Sharma`, ` rahul   sharma ` and `RAHUL SHARMA` all normalize to
`rahul sharma`.

No fuzzy matching, no phonetic matching, no punctuation stripping, no spelling
correction.

The human-facing Name input is never modified. `normalizedName` is for
comparison and storage only.

### Phone Lookup

The lookup runs ONLY at exactly 10 raw digits. A partial number is never
queried.

It uses the `phone` index and never scans the registrations table.

Below 10 digits, phone usage and any identity match derived from it are
cleared.

Phone not previously used
→ green `New number`

Phone previously used
→ amber informational `Used by N attendees`, with a compact summary of the
existing registrations

A shared family phone number is expected and allowed. It is never an error, and
it says nothing about WhatsApp.

### Identity Match

Same phone + different normalized name
→ allowed, shown as green `New attendee`

Same phone + same normalized name + HELD
→ amber `Registration on hold`, blocks Next

Same phone + same normalized name + COMPLETED
→ red `Already registered · Badge #xxx`, blocks Next

`[phone+normalizedName]` is not unique, so corrupt data could hold both a held
and a completed record for one identity. The COMPLETED record always wins. An
issued badge must never be downgraded to "on hold".

### Fail Closed

Duplicate protection must never fail open.

Next must not proceed while the lookup for the current phone number is still
running or has failed. A failed lookup shows
`Unable to check existing registrations.` and must never assume a new attendee.

A stale response for an older phone number must never replace the result for
the number currently entered.

A held match belonging to another registration is blocked as a new registration
and offers `Resume Registration` instead. A held match for the registration the
operator is currently resuming is allowed — see Hold Persistence.

The UI lookup is not the only defense. Identity conflicts are re-checked against
the `[phone+normalizedName]` index inside the write transaction, so a stale UI
lookup can never let a duplicate through.

---

## Step 2 — Payment

Fixed amount:

₹20

The displayed amount and the transaction note come from `EventConfig.amount` and
`EventConfig.eventName`, the same row persistence reads, so the two cannot
drift.

Payment methods:

- UPI
- Cash

UPI is selected by default.

UPI uses the organizer's PERSONAL UPI.

There is no payment gateway.

Payment confirmation is manual.

Do not implement automatic UPI transaction detection.

### UPI QR

The organizer's PERSONAL UPI details come from environment variables, never from
committed source:

`VITE_UPI_ID`
`VITE_UPI_PAYEE_NAME`

Real values live only in an uncommitted `.env.local`; `.env.example` documents
the names. Never put an authentication secret in a `VITE_*` variable — every one
of them is bundled into the browser.

Startup bootstrap copies non-empty environment values into `EventConfig.upiId`
and `EventConfig.payeeName`. A blank or absent value leaves the stored one alone,
an identical value writes nothing at all, and badge state — `nextBadge`,
`badgeStart`, `badgeEnd` — is never touched. Correcting the UPI details and
restarting therefore costs nothing.

EventConfig remains the single source of truth for those values.

The QR is generated locally in the browser from the bundled encoder. It makes no
network request, so it keeps working at a desk with no connectivity. Completing
the payment still needs the attendee's own UPI app and their connectivity.

The encoded URI is:

`upi://pay?pa=<upiId>&pn=<payeeName>&am=<amount>&cu=INR&tn=<Event Name> Badge Fee`

`am` comes from `EventConfig.amount`, formatted to two decimal places.

The SAME QR is valid for every attendee for the whole event. It contains NO
attendee name, phone, age, badge number, registration id or transaction
reference. This application performs no reconciliation, so a per-attendee
reference would add nothing and would leak personal data into a code that is
shown to strangers.

Nothing generated is persisted. No image, data URL, canvas or URI is written to
IndexedDB or copied into a registration; a registration stores only
`paymentMethod`. The QR is a deterministic presentation artifact of EventConfig.

The QR is black on white in BOTH themes. It is never tinted, inverted or made
transparent — scannability beats branding.

UPI configuration is NOT verification. The format check is restrained and makes
no network call; it says nothing about whether the UPI ID exists or belongs to
anyone.

Confirming a UPI payment remains a manual operator action. There is no gateway,
no callback, no polling, no status parsing and no automatic detection.
`Payment Confirmed` becomes available only once a real QR is on screen, so an
operator can never mark a UPI payment received with nothing presented to scan.

If the UPI ID or payee name is missing or malformed, or `EventConfig.currency`
is not `INR`, UPI fails closed: the panel reports that UPI payment is not
configured, `Payment Confirmed` is unavailable, and the operator uses Cash.
Attendee entry, Hold and Cash registration are all unaffected.

---

## Payment State Rules

Before payment confirmation:

Operator may:
- go Back
- Clear
- Hold Registration

After payment confirmation:

Hide:
- Back
- Clear
- Hold Registration

Lock:
- the UPI / Cash payment method controls

The confirmed method remains visible but cannot be changed by mouse, keyboard,
or label click.

A confirmed payment cannot be undone within the current registration.

Show only:

ISSUE BADGE #xxx

The irreversible registration action is:

ISSUE BADGE

Do not consume a badge merely because payment was selected or the form was
opened.

---

## Form Footer

The footer belongs to the REGISTRATION FORM.

It is not the application's global footer.

Step 1 footer:

- Clear
- Hold Registration
- Next

Step 2 before payment:

- Back
- Clear
- Hold Registration

Step 2 after payment:

- Issue Badge #xxx

After a badge has been issued:

- Next Person

The footer should remain visually stable between steps.

---

## Clear Registration

Clear means:

- discard current draft
- clear entered attendee information
- clear payment state
- return to Step 1
- do not consume a badge

Once payment has been confirmed, Clear must not be available.

---

## Hold Registration

Hold means:

Save the registration for later WITHOUT consuming a badge.

Example:

Current physical badge: #047

Person cannot pay.

Registration is held.

Other attendees receive:
#047
#048
#049
...

Held attendee later returns when current badge is #053.

They receive #053.

The badge seen when the registration was originally started is never reserved.

Held registrations eventually live separately from completed badge records.

### Hold Persistence

Hold writes a durable HeldRegistration to IndexedDB.

A held registration consumes NO badge:

- `nextBadge` is never read for ownership and never incremented
- the record carries no `badgeNumber`
- the record carries no `completedAt`
- `paymentStatus` stays `pending`

The registration write and its outbox upsert happen in ONE Dexie transaction.
Either both persist or neither does.

Each registration has exactly one pending outbox row, keyed deterministically:

`registration:${registrationId}`

Repeated local edits before a sync overwrite that row with the latest snapshot
instead of accumulating stale ones.

Hold from Step 1 stores NO payment method for a brand-new hold. The hidden
Step 2 default must never be persisted by accident.

Hold from Step 2 stores the currently selected payment method.

A resumed hold keeps its stored payment method unless the operator explicitly
changed it.

`amount` is read from the EventConfig row inside the same transaction. If that
row is missing, the hold fails and nothing is written.

A completed registration can never be overwritten or downgraded by Hold.

### Resume

An exact held identity offers a real `Resume Registration` action.

Resume is READ-ONLY. It loads the stored attendee values into the draft,
restores the stored payment method (or UPI when none was stored), leaves payment
unconfirmed, and opens Step 2 — where the operator left off. It writes nothing
and assigns no badge.

A resumed registration keeps its registration id for its whole life. Re-holding
UPDATES the same row, preserving `id` and `createdAt`.

`heldAt` is the time of the LATEST hold, refreshed every time the record is held
again.

### Editing A Held Registration

The operator is editing a held registration from Resume until Clear, a
successful Hold, or another explicit reset ends the session — NOT only while the
entered identity still exactly matches what is stored.

Correcting the phone or name during that session does not end it. Re-holding
still updates the same row, so the UI must keep saying so.

The status therefore reads `Editing held registration` and takes visual priority
over `New attendee` and over the phone-level `New number` /
`Used by N attendees`. Its own held record is never a duplicate of itself, so
Next is allowed and no Resume action is offered for it.

A conflict with a DIFFERENT registration still overrides and blocks:

- completed exact match → red `Already registered`
- held exact match belonging to another record → amber `Registration on hold`,
  which offers Resume for that record

Checking and failed lookup states still take precedence over all of the above
and still fail closed.

Clear abandons the editing session only. It never deletes or mutates the saved
held record.

---

## Badge Allocation

Badge numbers represent pre-made physical badges.

Store badge numbers internally as numbers.

Display formatting may use:

#001
#002
#003

etc.

Badge number must be consumed ONLY when Issue Badge succeeds.

A held registration has no badge number.

### Authoritative Badge Number

`EventConfig.nextBadge` in IndexedDB is authoritative.

The registration form header displays it on Step 1, on Step 2 and for a resumed
held registration. There is no independent React counter that could drift from
the stored value.

Only a successful Issue Badge transaction changes it. Opening the form, Next,
payment selection, payment confirmation, Hold, Resume, Back and Clear all leave
it exactly where it was.

If the configuration cannot be read, registration does not start. The UI never
displays a guessed badge number.

### Badge Issuance

Issue Badge is persistent. ONE Dexie transaction over registrations, config and
outbox does all of it:

1. read EventConfig
2. refuse if the configured badge range is exhausted
3. load the resumed held record when there is one
4. re-check `[phone+normalizedName]` conflicts against the compound index
5. refuse if the current badge number is already assigned
6. write the CompletedRegistration
7. increment `nextBadge` exactly once and refresh `config.updatedAt`
8. replace the registration's deterministic outbox row with the completed
   snapshot

Any refusal returns before the first write: no registration, no outbox row, no
badge consumed.

A brand-new completed registration gets a `crypto.randomUUID()` id and has no
`heldAt`.

A resumed held registration keeps its id and is transitioned in place.
`createdAt` and `heldAt` are preserved, `completedAt` is the completion time,
and no second row is ever created.

`amount` comes from `EventConfig.amount` inside the same transaction, never from
the UI. `paymentStatus: 'confirmed'` is constructed by the service, never
accepted from the caller.

`badgeEnd` is honored when configured: once `nextBadge > badgeEnd` the range is
exhausted and issuance is refused. Allocation never wraps back to `badgeStart`.

### Badge Range Exhausted

While the range is exhausted, the operator cannot progress from Attendee Details
to Payment at all, and Resume opens Attendee Details rather than Payment.

Payment must NEVER be collected when this desk has no badge to hand over.
Reaching Payment with no badge available would let an operator take the fee and
then find Issue Badge unavailable, with Back, Clear and Hold already hidden by
the confirmed payment.

Hold Registration stays available and functional, because a hold consumes no
badge. Attendee details can still be entered, held and cleared.

A badge that was just issued is still announced normally on the completion
screen, even when its own increment exhausted the range. The block applies again
from the next Step 1.

The UI block is only the earlier layer. The issuance transaction keeps enforcing
`badgeEnd` independently and keeps returning `badge-range-exhausted`, so a stale
UI can never push past the range.

If the current `nextBadge` is already assigned to a completed registration,
issuance fails closed rather than skipping to the next free number. A config
that has drifted from the physical badge sequence needs operator attention.

### Completion

A successful issue does NOT clear the form. It shows a completion state naming
the exact physical badge to hand over and to whom, and the form header switches
to `BADGE ALLOCATED` showing the badge just issued — never the next one.

`Next Person` starts the next draft. It performs no database write, because the
issuing transaction already advanced `nextBadge`.

Future multi-device use will be handled by physically splitting badge ranges
between desks.

Do not build distributed badge allocation unless explicitly requested.

---

## Final Google Spreadsheet

The spreadsheet will eventually contain two tabs:

1. Badge Register
2. Held Registrations

IndexedDB remains the operational source of truth. Google Sheets is the
synchronized central ledger, written to only by the server.

### Badge Register

Visible columns, in order:

`A` Badge · `B` Name · `C` Phone · `D` WhatsApp Link · `E` Age · `F` Gender ·
`G` Payment · `H` Amount · `I` Date · `J` Time

Technical columns, AFTER the human-facing ledger and hidden in the Sheet UI:

`K` Registration ID · `L` Updated At

Badge is stored as a NUMBER. The `#001` appearance is a display format only, so
sorting and comparison stay numeric. The tab is kept sorted by Badge ascending.

### Held Registrations

Visible columns, in order:

`A` Name · `B` Phone · `C` WhatsApp Link · `D` Age · `E` Gender · `F` Payment ·
`G` Amount · `H` Held Date · `I` Held Time

Technical columns, hidden:

`J` Registration ID · `K` Updated At

Payment is blank when the hold happened before a method was chosen.

Date and Time are separate columns, formatted `DD/MM/YYYY` and `hh:mm:ss AM/PM`
in Asia/Kolkata — never the server's or the browser's timezone. Completed rows
derive them from `completedAt`, held rows from `heldAt`. The precise ISO
timestamps stay in IndexedDB and in the hidden `Updated At` column.

Phone is the raw 10 digits with no `+91`; the WhatsApp link carries the country
code as `https://wa.me/91XXXXXXXXXX`.

### Sync Bridge

`POST /api/sync-registration` accepts ONE registration snapshot and upserts it.
The shared wire contract lives in `src/shared/sync-contract.ts` and is
framework-free, so the server and the future browser processor cannot disagree.
Every field is validated at runtime; invalid input is rejected, never coerced.

Service-account credentials are server-only. They must NEVER be given a `VITE_`
prefix, because everything so named is bundled into the browser.

Credentials existing is NOT sufficient authority to write. Every Sheet write is
additionally gated by the release interlock — see Production Release Safety.

**Registration ID is the remote idempotency key** — never name, phone or row
position. Replaying the same snapshot never creates a second row.

`Updated At` protects against stale writes. An incoming snapshot older than the
remote row is ignored rather than allowed to downgrade newer Sheet state.

**COMPLETED ALWAYS WINS OVER HELD.** If a registration already has a badge in
Badge Register, a late-arriving held payload never resurrects it in Held
Registrations. A successful completed sync clears that person's held row.

**Badge collision fails closed.** If the incoming badge number already belongs
to a DIFFERENT registration, the endpoint returns `badge-conflict` and writes
nothing. The physical badge was already handed out, so a human must reconcile
it. The server never overwrites the other attendee and never picks another
number.

Cross-device duplicate-person reconciliation is separate future work. Sync is
never refused merely because another row shares a name or phone under a
different Registration ID.

### Sheet Write Safety

Every cell is written through `spreadsheets.batchUpdate` with an explicitly
typed `userEnteredValue`: `stringValue` for text, `numberValue` for numbers.
`spreadsheets.values` with `USER_ENTERED` is never used for a row write, because
it parses any string beginning with `=`, `+`, `-` or `@` as a formula — an
attendee name could then execute inside the operator's spreadsheet.

The WhatsApp cell is the ONLY `formulaValue` the server ever writes. It is built
from a phone number already restricted to exactly ten digits plus a constant
label, and the digit check is repeated at the cell builder so a non-conforming
value degrades to a literal string rather than becoming a formula. No arbitrary
request field may ever reach `formulaValue`.

The human-facing name is stored literally. It is never sanitised, escaped or
prefixed with an apostrophe.

Sheet titles contain spaces, so every A1 range single-quotes the title
(`'Badge Register'!A1:L`). An embedded quote is doubled.

A completed snapshot's remote mutation is ONE `spreadsheets.batchUpdate`: the
Badge Register append or update, the clearing of any lingering held row, and the
numeric sort land together or not at all. Sorting is issued on every completed
path — including `already-current` and `stale-ignored` — because it is always
safe and repairs a ledger left unsorted by an earlier partial attempt. A stale
completed request never overwrites the newer badge row but still clears a
lingering held row, since a completed row already exists remotely.

Held writes use the same typed-cell batch path and need no sorting.

Tab initialisation is also one batch: header values, frozen header, hidden
technical columns, text phone format and numeric badge format together, so a tab
can never end up with a correct header but missing contract formatting.

### Sheet Shape Safety

The server creates the two tabs it owns if they are missing. Unrelated tabs are
never touched.

An existing tab is only safe to initialise when the ENTIRE application-owned
range is blank. A blank header row with human data below it fails closed — that
is somebody's spreadsheet, and stamping a header onto it would append beneath
their records. A partial, reordered or different header also fails closed.

A tab already containing MORE THAN ONE nonblank row with the same Registration
ID fails closed with `sheet-shape-conflict`. The first duplicate is never chosen
silently, because that would compound existing ledger corruption. The operator
message stays generic; the id goes to the server log only.

Held rows are cleared in place rather than deleted, because deleting a row
shifts every index below it and would race with concurrent writers.

### Concurrency Limitation

Google Sheets offers no conditional unique append keyed on Registration ID, so
the server can DETECT a duplicate but cannot prevent one being created by two
simultaneous writers. No distributed lock is implemented and none should be.

The browser therefore guarantees, and must keep guaranteeing:

- one sync processor running at a time
- one in-flight request per outbox item
- no overlapping sync cycles

Registration ids are locally generated UUIDs and each outbox row is owned by the
device that wrote it, so single-flight per device is the intended concurrency
control.

The server never touches IndexedDB. A sync failure leaves the local record and
its pending outbox row exactly as they were.

`SYNC_ALLOWED_ORIGIN` restricts which origin may POST. This is NOT user
authentication — any direct HTTP client can set an Origin header. Before public
production use, the deployment must be access-controlled or a real
authentication layer added. Never put a server secret in a `VITE_*` variable to
try to authenticate the browser; it would simply be published.

---

## WhatsApp

Do NOT verify whether a phone number has WhatsApp.

The application UI does not need WhatsApp verification.

The Google Sheet will eventually contain a clickable WhatsApp link using:

https://wa.me/91XXXXXXXXXX

This is only a convenience link.

---

## Offline-First Requirement

The event registration flow must eventually work without network connectivity.

Network connectivity must NOT be required to:
- enter attendee details
- hold a registration
- confirm payment manually
- issue a badge
- continue to the next attendee

The browser/device is the operational source of truth using IndexedDB.

Google Sheets is the synchronized central ledger.

### Progressive Web App

The application is a PWA. `vite-plugin-pwa` generates a Workbox service worker
that precaches the built shell: `index.html`, JS chunks, CSS, icons and the
self-hosted Oswald `woff2` files. A navigation fallback to the cached
`index.html` means reloading `/` offline opens the app, after it has been
successfully loaded online at least once.

The service worker is responsible ONLY for static assets. It never stores
registration, config or outbox data — those stay in IndexedDB, which remains the
operational source of truth. Nothing belongs in Cache Storage, localStorage, the
worker or the manifest.

Once cached, everything operates offline: attendee entry, duplicate lookup,
Hold, Resume, payment selection, manual confirmation, Issue Badge and the badge
counter. The UPI QR renders offline too, because it is generated locally —
though completing the payment still needs the payer's own app and connectivity.

Offline never blocks or disables any registration action, and there is no
full-page offline error. Only the connectivity indicator changes. There is no
second offline implementation of any product rule.

A service worker registration failure only logs; the application still loads.

### Service Worker Updates

A newly downloaded version WAITS. It never reloads a page that is open, because
a desk must not be interrupted mid-registration. The update takes over once
every tab has been closed. Any update indication stays passive.

There is no custom install button; browser-native installation is enough.

Production PWA behaviour is verified with `pnpm build` + `pnpm preview`. The
development server deliberately registers no service worker.

### Connectivity Indicator

The header shows `Online` or `Offline mode` from `navigator.onLine` plus the
`online`/`offline` events. No polling, no ping endpoint, no backend request.

Offline is amber, never destructive red: the desk is designed to keep working.

`Online` means ONLY that the browser reports connectivity. It must never be
presented as `Synced`, `Sync complete`, `Uploaded` or `Server connected`.
Synchronization has its own separate indicator beside it; the two are never
merged, because a device can be online with work still queued.

---

## Local Data Model

Local storage uses Dexie + IndexedDB.

Database name:

`navaratri-2026-registration`

Current version:

1

Tables:

- registrations
- config
- outbox

IndexedDB is the durable local event store and the operational source of truth
during the event.

Google Sheets is later synchronized FROM this local store.

Held and completed registrations share the `registrations` table and are
distinguished by registration status:

- held
- completed

A held registration has no badge number.

Every registration has a unique internal ID.

Registration data must never be stored in localStorage. The existing
localStorage use for theme preference is unrelated and stays.

Synchronization must eventually be idempotent.

Startup bootstrap creates the default event config row ONLY when it does not
already exist. Existing configuration, such as `nextBadge`, is never
overwritten with defaults.

### Database Readiness

Registration depends on IndexedDB for duplicate detection, so the registration
UI must not begin database-dependent work before `bootstrapDatabase()` has
completed successfully.

Startup gates the registration form on that bootstrap and shows a minimal
initialization state until it resolves. Bootstrap has exactly one owner; feature
components never bootstrap.

If bootstrap fails, registration stays unavailable rather than running with
duplicate checks that silently fail open. The failure state offers a retry and
never deletes or recreates the database.

### Current Write Surface

The application writes in exactly three places:

1. the startup event-config bootstrap
2. Hold Registration — the held registration plus its pending outbox row, in one
   transaction
3. Issue Badge — the completed registration, the `nextBadge` increment and the
   pending outbox row, in one transaction

Those three are the only writers of registration data. The outbox processor
additionally updates and deletes outbox rows, and writes nothing else — it never
touches a registration or the config row.

### Database Safety

Schema migrations must preserve existing event data.

Destructive database clearing is forbidden during normal startup or migration.

Never call, as part of startup or a migration:

- `db.delete()`
- `indexedDB.deleteDatabase()`
- `table.clear()`

---

## Outbox Synchronization

A background processor drains the outbox to `POST /api/sync-registration`.

IndexedDB stays the operational source of truth. Registration NEVER waits for
synchronization: Hold, Resume and Issue Badge commit locally and return, and a
sync failure never blocks, disables or reverses any registration action.

The processor starts only AFTER `bootstrapDatabase()` has succeeded, for the
same reason the registration form does.

### Single Flight

Rows are processed SERIALLY, one request in flight at a time, in `createdAt`
order with the id as a tie-break, so a cycle is deterministic.

Two layers keep cycles from overlapping:

1. an in-tab promise latch — a concurrent caller receives the RUNNING cycle's
   promise rather than starting a second one
2. the Web Locks API (`navaratri-2026-outbox-sync`, `ifAvailable: true`) when
   available, so other tabs on the same origin step aside instead of queueing

Where Web Locks is unavailable the in-tab latch still applies. There is NO
distributed lock between physical devices and none should be added — each outbox
row is owned by the device that wrote it.

### Conditional Acknowledgement

This is the safety-critical rule.

An outbox row is deleted ONLY when the snapshot that was sent is still the
snapshot stored — matched on BOTH `registrationId` and `payload.updatedAt`. A
row whose payload changed while the request was in flight is left alone and
re-sent.

A response for an older snapshot must never delete a newer one. This is what
protects the Held → Completed transition: if a badge is issued while the held
snapshot is still in flight, the held response acknowledges nothing and the
completed snapshot is sent in the same cycle.

Failure metadata is written under the same condition, so a stale failure can
never contaminate a newer snapshot.

The response is verified to echo the registration id and `payloadUpdatedAt` that
were sent. A mismatch is treated as an invalid response, not as success.

Each snapshot is attempted at most once per cycle.

### Retryable Versus Attention

Retryable — `sync-failed`, `network-error`, `timeout`, `invalid-response`,
`unexpected-http` — retry automatically with a growing delay: 5s, 15s, 30s, 60s,
then every 5 minutes.

An opaque 429 or 5xx, including a bare 503 from a proxy, is `sync-failed`. Only
a VALIDATED failure body may produce an attention code such as
`sync-not-configured`; an unreadable error page never gets to park a row on the
attention list.

Attention — `badge-conflict`, `sheet-shape-conflict`, `invalid-request`,
`forbidden-origin`, `sync-not-configured` — retrying cannot fix these. They
surface in the sync indicator and wait for a human.

`badge-conflict` specifically means the physical badge is already recorded
against a DIFFERENT registration. A person must reconcile the ledger; the
processor never renumbers a badge and the server never overwrites the other
attendee.

A global failure stops the current cycle rather than burning through every
remaining row against the same broken configuration. A row-specific failure
moves on to the next row.

### Triggers

Synchronization runs automatically on:

1. application start, once the database is ready
2. a local Hold or Issue Badge commit, signalled AFTER the transaction commits
3. the browser going back online
4. the tab regaining focus or becoming visible
5. a retry timer for rows that are due

### Offline Is Not A Sync Failure

`navigator.onLine` is used in ONE direction only. It cannot prove the endpoint
is reachable when it says online, but a browser reporting OFFLINE is certain
enough to skip work that would fail.

While it reports offline, for automatic AND manual runs alike:

- no request is made
- `attemptCount` is not incremented
- `lastAttemptAt` is not touched
- no failure code or message is written
- NO retry timer is armed

Rows stay durable and the status is still re-derived from IndexedDB. The
`online` event is what resumes synchronization.

Arming a timer while offline would fire immediately, skip, and re-arm — a
zero-delay spin. A manual retry ignores backoff and the attention hold, but not
this.

### Another Tab Owns The Lock

Failing to take the Web Lock is a SKIP, not a failure and not an attempt. No
outbox row is read for sending and no attempt metadata changes.

That tab schedules one restrained re-check — about a second — rather than
competing for the lock in a zero-delay loop, so it still notices when the other
tab has drained the queue.

### Sync Status

The header shows synchronization separately from connectivity.

`Synced` means exactly one thing: the LOCAL OUTBOX IS EMPTY. It says nothing
about any other device.

Pending rows are shown as a count, sync issues as `Sync issue`, and a manual
retry is offered whenever anything is pending.

### Sync Boundaries

The service worker never caches or intercepts `/api/sync-registration`.
Registration data is never cached as an HTTP response.

The browser NEVER holds Google credentials and never imports `googleapis` or
anything under `server/sync/`. Only the shared wire contract in
`src/shared/sync-contract.ts` is imported by both sides.

Attendee names, phone numbers and full request payloads are never logged.

---

## Production Release Safety

### Release Interlock

Two server-only variables gate every Sheet write. Neither may ever be `VITE_`
prefixed.

`SYNC_WRITE_ENABLED` must be EXACTLY `true`. Unset, blank, `false`, `TRUE`,
`True`, `1`, `yes` and any padded value such as ` true` or `true ` all mean
disabled. The value is NOT trimmed and NOT case-folded.

`SYNC_ALLOWED_VERCEL_ENV` must be exactly `development`, `preview` or
`production` — again no trimming and no case folding — and must exactly equal
the runtime `VERCEL_ENV`, which is not trimmed either. An ABSENT `VERCEL_ENV`
fails closed: this application is deliberately deployed through Vercel, and an
unknown runtime is where writing to the real ledger is least safe.

There must NEVER be a fallback that assumes `development` when `VERCEL_ENV` is
missing. Deployed Production and Preview runtimes take the value from Vercel
itself. Locally, `vercel dev` does NOT expose it to the function in this
project, so guarded local sync testing supplies it explicitly:

```bash
env VERCEL_ENV=development pnpm dlx vercel@latest dev --listen 3001
```

The absent-value guard is not weakened to make local testing convenient.

A whitespace or casing typo is a CONFIGURATION FAILURE. The interlock never
repairs a near-miss value, because a release switch that guesses at intent is
not a release switch.

The interlock is evaluated BEFORE any credential is read, so a deployment with
writes disabled never handles a private key at all.

A failed interlock returns the EXISTING `sync-not-configured` contract. No new
outcome was introduced for the release switch, so the browser's Phase 5B
classification is unchanged: rows are retained, `Sync issue` is shown, and
registration continues locally.

This exists because the repository is connected to Vercel Git auto-deployment. A
push can produce a deployment before production credentials and access
protection are intentionally ready. Sheet writes must never become possible
merely because credentials happen to exist.

### Environment Policy

Preview must NEVER use the production spreadsheet by default. The preferred
preview configuration is no Google sync credentials at all and writes disabled.

Production write enablement happens ONLY after deployment protection is in
place. Vercel Authentication or Password Protection are the platform options; an
application authentication layer would be a future phase.

`SYNC_ALLOWED_ORIGIN` is a same-origin guard. It is NOT authentication and must
never be described as such — any direct HTTP client can set an Origin header.

If no suitable access-control mechanism exists, production Sheet writes stay
disabled.

### Persistent Storage

After database readiness the browser requests persistent storage, at most once
per session. It never blocks startup or registration, never shows a modal, never
clears data, and a refusal or an exception is non-fatal.

Persistence is BEST EFFORT, not a backup. It does not survive Clear Site Data,
uninstalling the app, a wiped profile or a failed device. Google Sheets is the
ledger for snapshots already acknowledged; pending rows exist only on the
device.

### Operations

Event-day procedure lives in `docs/`:

- `docs/PRODUCTION_RELEASE_CHECKLIST.md`
- `docs/EVENT_DAY_RUNBOOK.md`

No destructive reset or clear is ever part of normal event operations. Local
inspection helpers are read-only by default, and a helper that prints personal
data is separate and deliberate.

Production must never seed test data: no test registrations, no test outbox
rows, no test badge rows, no test phone numbers and no disposable spreadsheet
id. EventConfig bootstrap defaults are the only automatic writes.

## Admin Control Plane

Admin auth is a SEPARATE realm from Operator/device auth: different cookie
(`__Host-navaratri_admin_session`), different secret, 12-hour lifetime.

Realm isolation is CRYPTOGRAPHIC, never a documentation-only invariant. Admin
signatures cover the domain-separation context
`navaratri-admin-session-v1:` prepended to the payload, so each realm rejects
the other's token EVEN IF the two secrets are identical. Distinct secrets stay
recommended, but separation must not depend on them. The operator token format
and verifier must not be changed — doing so would invalidate live sessions.

`EVENT_ADMIN_ACCESS_CODE` has a minimum of 8 characters, compared exactly —
no trimming, no case folding. That is a floor, not a recommendation: a short
admin code leans on the edge rate limit for `POST /api/admin-login` and the
fixed wrong-code delay, and neither replaces entropy. `EVENT_ADMIN_SESSION_SECRET`
stays at a 32-character minimum.

`/admin` is NOT behind Operator Access and must never be. It is matched before
the event routes and rendered outside the event shell, so it never mounts the
offline registration workflow. Equally, the event application is never wrapped
in Admin auth.

The event shell — Operator Access, DatabaseGate, StorageManager, SyncManager —
mounts ONCE against a single event-route pattern, so navigating between event
pages never restarts the sync processor.

Every Admin API verifies the session FIRST, then validates, then touches the
database. An unauthenticated caller must not be able to learn whether a
database exists. All Admin responses are `Cache-Control: no-store`.

Admin is an ONLINE-ONLY control plane. Mutable registry data is never cached
in IndexedDB.

The Admin device registry is central Postgres state. It contains NO attendee
PII, and creating a central record NEVER mutates any browser's IndexedDB —
there is no authenticated browser-to-device mapping until Phase 9C.

`enabled` is central state only. It does NOT revoke a legacy device's Operator
Access, because devices do not authenticate centrally yet. Never imply
otherwise in the UI.

`last_seen_at` is FACTUAL. Never infer or display Online/Offline: without
device authentication there is no trustworthy central heartbeat identity.

There is NO device deletion — disable instead, so operational history survives.

There is NO badge-range edit, replace, release, transfer, extend or reset in
Admin. Only the first assignment. Changing a range while devices operate
offline is how two attendees get the same badge.

Device attributes are `registration` and `prizes`. The database stores TEXT
for future extensibility, but the application owns the allow-list and free
text is refused.

`registration` IS the whole registration-desk workflow, physical badge
issuance included: attendee entry, hold and resume, payment, owning a
badge-number range, handing over the badge and advancing the local
`nextBadge` offline. Issuing a badge is the last step of registering an
attendee, not a separate job, so there is NO separate badge capability and
none may be added while the flow stays combined.

Permission and range remain separate DATA: `registration` says the device may
run the workflow, `badge_assignments` says which physical numbers it owns.
That distinction is sufficient.

Assigning a badge range requires `registration`, and a device holding an
active badge range may not lose it. Edit Device locks that checkbox on and
names the range, but the client guard is a courtesy: the server refuses the
removal independently, and both read `BADGE_RANGE_REQUIRED_ATTRIBUTE` from
the shared module so they cannot disagree.

Save Device is ONE operation. Device fields and the exact attribute set travel
in a single `PATCH /api/admin-devices`, are validated together, and commit as
one atomic `db.batch`. A refusal writes NOTHING — not the rename, not the
attributes. There must never be a second independently committed write path
for device configuration; splitting it is what let a rename persist while its
attribute change was refused.

Admin mutations return the COMPLETE updated entity, and the control plane
replaces that one item in local state. A successful mutation never re-fetches
the registry, never clears the selected event and never shows the full-screen
loading state — that state belongs to the FIRST load only. An explicit Refresh
keeps the current content on screen and shows its progress on the button
itself. A failed refresh keeps what is already rendered rather than blanking
it.

A device may NEVER establish a new badge range purely offline. The first claim
must be centrally accepted; after that, issuance stays local and offline.

## Device Credentials

Phase 9C-A STORES device credentials. It does NOT enable device login. There is
no `/api/device-login`, no device session, no cookie and no heartbeat, and none
may be added before its phase. Devices still use Operator Access. Provisioning
a password ACTIVATES NOTHING — a disabled device may be provisioned, because
preparing a desk before opening it is normal and `enabled` is enforced at login.

`devices.password_hash` is a scrypt hash and NOTHING else: never a password,
never a reversible ciphertext, never a temporary secret.

`password_hash IS NULL` means CREDENTIALS HAVE NOT BEEN PROVISIONED. It must
NEVER be read as "may sign in without a password"; the future login rejects a
null hash before any comparison. It is nullable so the migration preserves
existing devices. There is NO way to set it back to NULL — no Clear Password,
no Remove Credentials, no Disable Password. Once provisioned, the choices are
reset the password or disable the device.

`session_version` starts at 1 and is incremented by EVERY deliberate password
set or reset, with no comparison to the previous password. A future device
session carries the value it was issued under, so a reset revokes every session
that device holds. There is no session store, and none should be added.

Hashing is Node's built-in `node:crypto` `scrypt`, asynchronous, in
`server/device-auth/password.ts` — no bcrypt, no argon2, no hashing service,
and no HTTP or database concern in that module. The encoded form is
self-describing, `scrypt$v1$N$r$p$salt$key`, so parameters can be raised later.
A STORED HASH IS UNTRUSTED INPUT: malformed encoding, an unsupported version
and absurd parameters all return false before any work, bounded by
`MAX_SCRYPT_MEMORY_BYTES`, and never throw for an ordinary bad credential.

The policy is 8-128 characters, taken EXACTLY — never trimmed, never case
folded, never Unicode normalised, spaces significant. It lives in
`src/shared/device-password.ts` and is read by both the browser form and the
server, so instant feedback and real enforcement cannot drift.

The browser sends plaintext over HTTPS and the SERVER hashes it. Never hash in
the browser: the digest would simply become a reusable password equivalent.

Admin sees ONLY a derived `credentialsConfigured` boolean. `passwordHash`,
`sessionVersion`, the salt and the derived key never leave the server, never
appear in a response, never reach `src/` and are never logged. AdminDevice is
an EXPLICIT projection — a raw Drizzle device row is never serialized to a
browser.

Create Device may include an OPTIONAL password, and the device row, its
attributes and its hash commit in ONE atomic batch. Editing a device NEVER
shows a password field: a blank one inside Save Device would be ambiguous
between keeping, clearing and emptying the password, so a reset is its own
deliberate action. Credentials always require a login name, and one is never
generated to make a request succeed.

## Device Authentication

Device auth is a THIRD independent security realm, alongside Operator Access
and Admin. Its cookie is `__Host-navaratri_device_session`, its secret is
`EVENT_DEVICE_SESSION_SECRET` (server-only, min 32, exact, never `VITE_`), and
its signing context is `navaratri-device-session-v1:`.

A Device cookie NEVER satisfies Admin or Operator auth, and neither of those
ever authenticates a device. Separation is CRYPTOGRAPHIC: each realm signs a
different message, so all three reject each other's tokens even with identical
secrets. Never import one realm's session code into another.

A device authenticates with `eventSlug` + `loginName` + `password`. Login names
are unique PER EVENT, so the lookup is always event-scoped — never a bare
`WHERE login_name = ?`.

The token carries IDENTIFIERS AND A SESSION VERSION, never permissions: no
password, hash, login name, device name, attributes, badge range, `enabled` or
`lastSeenAt`. Those change centrally and are fetched FRESH from Postgres on
every authenticated request, so an Admin change takes effect without a new
cookie and without a password reset.

`session_version` is the revocation mechanism, and there is NO session store.
Every authenticated request verifies `token.sv === devices.session_version`; an
Admin password reset increments it and instantly invalidates every cookie
issued under the old value. Verifying the HMAC alone is NOT authorization.

`enabled = false` and `events.active = false` each invalidate login and every
existing session. `password_hash IS NULL` is never passwordless login.

Every credential failure — unknown event, unknown login name, unprovisioned
device, policy violation, wrong password — returns ONE generic 401 and does
COMPARABLE password work, via a fixed timing-equalizer hash. Only after the
password is proven may a typed 403 name `device-disabled` or `event-inactive`.

`last_seen_at` is written ONLY by a successful device login. A session check
never touches it, and there is NO heartbeat.

### Device Login And Central Enrollment

`/device-login` is the central device sign-in page. It lives OUTSIDE Operator
Access on purpose — it is where the per-device entry point will eventually
live — and it unlocks NOTHING. `/`, `/badge-registration` and
`/device-registration` still answer to Operator Access whether or not a device
session exists, and signing out of a device locks none of them. There is NO
device gate on any event route until the offline bridge exists.

The event slug is supplied by the application from `src/shared/event.ts`, never
typed. No screen asks an operator for an event id, an event slug or a device
UUID.

The session response is validated at RUNTIME, not merely typed, and fails
closed. An attribute outside the `registration` / `prizes` allow-list rejects
the whole response rather than becoming a local capability. The context is
projected field by field, never spread, so a future server field cannot reach
local state by accident.

`centralDeviceEnrollment` is ONE optional field on the EXISTING config row —
no new store, no new index, no Dexie version bump. It holds only `deviceId`,
`eventId`, `eventSlug`, `deviceName`, `loginName`, `attributes` and
`verifiedAt`.

It NEVER holds a password, hash, salt, token, cookie, `sessionVersion` — or
`activeBadgeRange`. The central range may be DISPLAYED read-only and must say
the local range is unchanged; importing it is a later phase, and
`configureBadgeDistribution` is never called from device login.

The enrollment is "the last central identity this browser verified", NOT
permission to operate. It never produces an authenticated state, never
authorizes a route, and is never presented as offline authority. Offline, the
page shows "last verified" and must never say Authenticated.

Central values NEVER overwrite the Phase 7 local ones. The central `deviceId`
and `deviceName` are stored BESIDE the local identity, and `badgeStart`,
`badgeEnd`, `nextBadge`, `deviceConfiguredAt` and `badgeConfiguredAt` are never
touched by enrollment. Enrollment is config-only: it never opens the
registrations or outbox tables.

One browser binds to ONE central device. Re-verifying the same device refreshes
its name, login name, attributes and `verifiedAt`. A DIFFERENT device is
refused, not swapped in: the new device is not persisted, its session is ended
immediately, and rebinding requires an explicit Clear Central Enrollment, which
removes the snapshot and nothing else.

Sign Out calls the server FIRST. A failed logout keeps the local enrollment and
says so rather than claiming the cookie is gone.

There is NO polling and NO heartbeat. The session is checked on mount, after a
login, and on an explicit Refresh Device Status.

## Central Database

PostgreSQL (Neon) is the CENTRAL OPERATIONAL AUTHORITY: events, devices,
device attributes and badge-range assignments. Google Sheets remains the
attendee ledger. IndexedDB remains the offline workflow state.

ATTENDEE PII IS NEVER STORED CENTRALLY — no name, phone, age, gender, payment,
held or completed registration — unless a later explicit architecture change
says otherwise.

The central badge assignment owns the RANGE, never a live `nextBadge`. A
central counter would make issuing a badge require the network, which is the
one thing this application is built to avoid. `nextBadge` stays local.

Active badge ranges may not overlap within an event, and a device may hold at
most one active assignment. Both are enforced by the DATABASE — a GiST
exclusion constraint and a partial unique index — because two concurrent
writers can each pass an application check and still both commit.

`DATABASE_URL` is SERVER-ONLY and must never be `VITE_` prefixed. All database
code lives under `server/db/`. A client module may NEVER import `server/db`,
and `src/` must never read `DATABASE_URL`.

MIGRATIONS NEVER RUN AUTOMATICALLY. Not in a build, a start command, a Function
invocation, app bootstrap or `release:check`. A human runs `pnpm db:migrate`
deliberately, one environment at a time; `pnpm db:check` is read-only.

The database client is LAZY: importing it connects to nothing and validates
nothing. A module-load connection would turn a missing `DATABASE_URL` into a
deployment-wide crash instead of a failure confined to the call that needed it.
Connection strings are credentials and never appear in a log, an error or a
response.

Development and Production must never share a database branch.

Attributes are TEXT, not a Postgres enum, and there is no `deviceType`: one
device may serve several modules.

## Application Shell And Routing

This is a MULTI-MODULE single-page application on one origin, not a single
screen.

- `/` is Home, the module launcher
- `/badge-registration` owns the attendee badge workflow
- `/device-registration` owns physical device provisioning and readiness

Routing is presentation work. An internal route must NEVER create a new
database, store, storage namespace or origin: IndexedDB, the trusted-device
marker, the session cookie and the service worker belong to the origin, and
changing the pathname resets nothing.

`SyncManager` is APP-GLOBAL. It mounts once, inside DatabaseGate and outside
the router, so a pending registration keeps draining while the operator is on
Home or any other module. Never mount one per route, and never mount a second
DatabaseGate.

API routes must NEVER be captured by the SPA fallback. Rewrites are explicit
per known route rather than a catch-all, and the service worker's navigation
fallback denylists `/api/`.

Initial Device Setup has exactly ONE writer and one transaction. A second
device-configuration writer must never be added, whatever route calls it.

Routing must preserve deep-link intent through Operator Access: the access gate
renders IN PLACE and never navigates, so unlocking resumes at the requested
URL rather than redirecting Home.

Internal navigation uses the router. `window.location` is for genuinely leaving
the application, never for moving between modules.

## Multi-Device Badge Partitioning

There is NO global badge allocator and NO shared `nextBadge` between clients.
Devices must never coordinate badge numbers through an online counter: the
application is offline-first, and a shared counter lets two disconnected desks
issue the same physical badge.

Every device owns a NON-OVERLAPPING physical badge range, held only in its own
local `EventConfig`. That local range is the PRIMARY duplicate-prevention
mechanism. Server-side badge-conflict detection stays a SECONDARY backstop, not
the allocator — it fires after sync and cannot recall a badge already handed
over.

Badge ranges are NEVER read from environment variables or build-time config. One
Vercel deployment serves every device, so a deployment-wide range is a
contradiction. Ranges live only in local EventConfig.

The organizer must physically place the matching badge stack at the matching
device. The software cannot verify this.

### Device Identity Is Not Badge Ownership

A registered physical device is NOT tied to one feature. Identity and badge
ownership are separate questions, asked by separate helpers:

- `isDeviceRegistered(config)` — valid `deviceId` + `deviceName`. Nothing else.
  `deviceConfiguredAt` may be absent on a legacy device and must not invalidate
  it.
- `isBadgeDistributionConfigured(config)` — registered PLUS a finite coherent
  range (`badgeStart <= nextBadge <= badgeEnd + 1`).

Never model this as a single `deviceType`. One physical device may serve
several modules, so each module attaches its own optional configuration to the
one stable identity. Do not build a generic capability registry for this;
keep it concrete.

Badge ownership is NEVER inferred from device identity, and never from the
bootstrap defaults `badgeStart: 1` / `nextBadge: 1` / no `badgeEnd`.

There are exactly TWO writers, and each is the only one of its kind:

- `registerDevice({ deviceName })` — the only device-identity writer. It never
  reads or writes `badgeStart`, `badgeEnd` or `nextBadge`.
- `configureBadgeDistribution({ badgeStart, badgeEnd, physicalStackConfirmed })`
  — the only badge-range writer. It requires an already-registered device, a
  mandatory physical-stack confirmation, and refuses a second run.

`holdRegistration`, `issueBadge` and `hasBadgeAvailable` require BADGE
distribution, not mere registration. A registered prize or dandiya desk must
never be able to create a badge registration.

A legacy Phase 7 device with identity and a range satisfies both immediately.
It must never be forced through either setup again, and `badgeConfiguredAt`
being absent must not invalidate it.

### Device Identity

`deviceId`, `deviceName` and `deviceConfiguredAt` are properties on the EXISTING
config row. Device provenance fields are properties on existing registration and
outbox objects. No new store, no new index, no Dexie version bump — the database
stays at version 1.

`deviceId` is a `crypto.randomUUID()` generated ONCE at setup, never typed by an
operator and never regenerated in normal use.

A device is configured only when it has a valid `deviceId`, a valid
`deviceName`, and a coherent finite range where
`badgeStart <= nextBadge <= badgeEnd + 1`. The bootstrap defaults do NOT satisfy
this, which is what makes an existing device show Device Setup rather than
silently behaving as though it owned an open-ended range.

A configured device always has a FINITE `badgeEnd`. Phase 7 permits no
open-ended range.

### Device Setup

Initial setup FAILS CLOSED around existing data: it is refused when the
registrations or outbox tables are non-empty. Device identity is never stamped
onto historical data, and nothing is deleted or modified.

Setup preserves every unrelated config field: `eventName`, `currency`, `amount`,
`timezone`, `upiId`, `payeeName`.

Range assignment is ONE-TIME in Phase 7A. There is no range edit, no next-badge
reset and no device-id change. Changing a range while other devices operate
offline creates physical duplicate issuance.

Range exhaustion NEVER wraps to `badgeStart`, never picks another free number
and never borrows another desk's range. Hold Registration stays available.

### Device Provenance

Every new held or completed registration SNAPSHOTS `deviceId` and `deviceName`
from EventConfig at the moment the state is written. They are never derived
later at HTTP send time, so a queued outbox snapshot already carries its
provenance and a later configuration change can never mutate a snapshot behind
the processor.

`holdRegistration` and `issueBadge` verify device configuration INSIDE their own
transactions. UI gating is not sufficient. A refusal writes nothing at all.

Persisted and wire types keep the fields optional for legacy compatibility. The
wire validator accepts both fields present and valid, or BOTH absent; exactly
one present is rejected. Legacy local records are never mutated merely to add
metadata.

### Sheet V1 To V2 Migration

Device columns are APPENDED so no existing column ever moves:

- Badge Register `M` Device ID, `N` Device Name — `K:N` hidden, range `A1:N`
- Held Registrations `L` Device ID, `M` Device Name — `J:M` hidden, range `A1:M`

Shape detection is `empty` | `legacy` | `matching` | `conflicting`. A `legacy`
tab carries the exact pre-Phase-7 header with the appended columns blank across
the whole range; it is upgraded in place by writing ONLY the new header cells
and re-hiding the technical range. Existing rows keep blank device cells and are
never rewritten, moved or deleted. Migration is idempotent, and a conflicting
shape still fails closed.

The server still ignores every unrelated tab, including a human Device Range
Plan.

### Diagnostics Are Read-Only

Any device diagnostics or readiness view is STRICTLY READ-ONLY. It must never
edit a range, reset `nextBadge`, change a device id, delete a registration,
clear the outbox, clear storage or log out — not even as a side effect.

Dynamic readiness values must be read FRESH from IndexedDB at the moment they
are shown. They must never be copied from another component's `useEventConfig()`
instance: `nextBadge` and the outbox count change while the desk works, and a
second hook instance is not refreshed by the one the registration form updates
after an issue. A stale diagnostic number is worse than none.

Diagnostics must not call `navigator.storage.persist()`, register or replace a
service worker, or call `skipWaiting`. StorageManager owns the single
persistence request per session, and the PWA update policy is unchanged.

Diagnostics must never display attendee names, phone numbers or any other
personal data — counts only. A copied summary carries the same restriction, and
no secret, token, cookie or credential.

### Login Rate Limiting Is Edge Infrastructure

There must be NO in-process rate limiter in any Vercel Function. Serverless
instances share no memory, so a per-instance counter resets on every cold start
and is bypassed by concurrency — it would look like a rate limiter without
being one.

Rate limiting for `POST /api/operator-login` belongs in the Vercel firewall,
configured manually outside this repository and documented in
`docs/VERCEL_FIREWALL.md`. Do not add Redis, a database or a KV store for it.

It is an additional layer. The exact access-code comparison, constant-time
digest comparison, fixed wrong-code delay, same-origin requirement and cookie
attributes all remain authoritative and must not be weakened because a firewall
rule exists.

A rate-limited response must produce a generic operator-safe message. The
client never renders server response text and never reveals an address, an
attempt count, or whether the submitted code was correct.

### Device Provisioning

The Device Range Plan is a HUMAN artifact. The application never reads, writes
or owns it, and the server keeps ignoring every tab except the two it owns.

Provisioning a device must never clear local production state: no site data,
no IndexedDB, no `nextBadge` reset, no reconfiguration of a device that already
holds registrations.

### Phase 7A Non-Goals

Cross-device attendee duplicate detection is NOT solved. Duplicate detection
reads local IndexedDB and is strong per device only.

Cross-device Resume is NOT supported. A held registration resumes on the SAME
device, because local IndexedDB owns the workflow state.

---

### Operator Access

The production API auth boundary is a first-party OPERATOR SESSION, not the
platform login.

`EVENT_OPERATOR_ACCESS_CODE` (min 12 characters) and `EVENT_SESSION_SECRET`
(min 32 characters) are server-only and must NEVER be `VITE_` prefixed. Both are
read exactly, never trimmed. Missing or too-short values fail closed.

The session is a stateless HMAC-SHA256 token in a `__Host-` prefixed cookie:
`Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`, 14 days. There
is NO session store, and none should be added — rotating `EVENT_SESSION_SECRET`
is how every session is revoked at once.

`/api/sync-registration` checks the session FIRST, before the release interlock,
before the origin guard and before any configuration is read. An unauthenticated
caller gets `unauthorized` and learns nothing about the deployment.

Access-code comparison is constant time over SHA-256 digests, with a fixed
delay before a rejection. That delay is not a rate limiter — the access code
must be a strong passphrase, which the length minimum enforces.

Origin restriction is NOT authentication. Only the signed cookie grants API
access.

The access code is NEVER stored client-side, logged, returned or exposed to
browser code.

### Unauthorized Is Attention And Global

`unauthorized` retains its outbox row, is attention-class (no automatic retry)
and global (stops the cycle). A 401 never acknowledges or deletes a snapshot.

A successful unlock triggers a MANUAL cycle, because the attention hold is what
manual retry exists to bypass.

### Trusted Device Marker

`localStorage` records only that this device completed a real unlock. It is NOT
authentication: no token, no code, no API authority. Its sole purpose is offline
continuity, because an HttpOnly cookie cannot be inspected offline.

Offline startup makes NO auth request. A trusted device opens; a device that has
never been unlocked is told to connect once.

### Never Yank The Form

An expired session on a trusted device shows a banner and keeps the application
open. It NEVER replaces the registration form with a login screen, never clears
local data and never blocks local registration. Only a device that has never
been unlocked sees the hard gate.

Lock is auth only: it clears the session cookie and the marker, and touches
nothing in IndexedDB, the outbox, the config, `nextBadge` or the PWA cache.

### Server Runtime

Vercel Functions run as NODE ESM. Node does not guess file extensions for
relative imports, so every relative specifier under `api/` and `server/` MUST
carry an explicit `.js` extension in the TypeScript source. TypeScript resolves
`./foo.js` back to `./foo.ts` for typechecking; the emitted runtime JavaScript
keeps `.js`.

An extensionless specifier crashes the deployed function at MODULE LOAD, before
the handler runs — it is not caught by any test that only imports TypeScript.

`tsconfig.server.json` uses `module` and `moduleResolution` of `NodeNext` so
this fails typecheck. `release:check` enforces it independently. Do not relax
either to `bundler`: that is what allowed the failure through.

Package specifiers such as `googleapis` are unaffected. Browser code under
`src/` is bundled by Vite and keeps extensionless imports.

### Production Access And The Manifest

Production is behind Vercel Authentication. The PWA manifest link is therefore
emitted with `crossorigin="use-credentials"` (`useCredentials: true` in the
VitePWA config), because an unauthenticated manifest request is redirected to
the SSO origin and blocked by CORS.

The fix is to send credentials, never to make the manifest public or to weaken
deployment protection.

### Build Parity

`pnpm build` must FAIL whenever `api/**` or `server/**` has a TypeScript error
that a differently-configured compiler would find. A local build that passes
while the deployment platform's own compile fails is the failure mode this
guards against, and it has happened once.

Two independent causes, both now closed:

1. `tsconfig.json` is a SOLUTION file. Project references do NOT inherit
   compiler options, so a tool that ignores references — the platform's
   function compiler is one — reads the root `compilerOptions` and fills the
   rest from its own defaults. When those options were only `paths`, `api/**`
   was compiled NON-STRICT. The root therefore carries a safe baseline
   (`strict`, `types: ["node"]`, `lib`, `module`) purely for such readers. The
   three real projects do not extend it and are unaffected, and
   `tsconfig.app.json` keeps `types: ["vite/client"]` so no Node global ever
   reaches browser code.

2. Without `strictNullChecks`, a discriminated union STOPS NARROWING through
   `if (!result.ok)`. Every `result.response`, `result.message` and
   `result.blocked` below such a guard then fails to compile. Server and shared
   code therefore narrows with an EXPLICIT discriminant — `if (x.ok === false)`
   — which narrows under every configuration. Do not reintroduce bare negation
   on a result union. A parser returning another parser's failure branch must
   narrow first, so the branch is seen as the shared `{ ok: false; message }`.

`tsconfig.parity.json` is the DEGRADED profile, compiled on every build by
`pnpm typecheck:parity`. It is deliberately non-strict and must stay that way;
relaxing it to make a change compile defeats its only purpose.
`scripts/verification/build-parity.mjs` additionally compiles `api/` and
`server/` under four configurations and plants a canary to prove each one is
really checking.

Never silence a type error here. `@ts-ignore`, `@ts-expect-error`,
`@ts-nocheck` and `as any` are forbidden in `api/`, `server/` and `src/`, and
`release:check` fails on them. Two pre-existing `as unknown as` sites are
pinned by name; a new one fails the parity suite.

`packageManager` pins pnpm exactly, because the platform selects its pnpm from
that field and a different major would resolve the lockfile differently.

### release:check

`pnpm release:check` is a READ-ONLY repository audit. It must never mutate a
file, run a Git command, contact a network, deploy, print a secret value or
delete anything.

---

## Git Rules

DO NOT run Git commands.

Do not:
- git add
- git commit
- git push
- git pull
- git checkout
- git reset
- git restore
- git stash
- create branches
- merge branches
- modify Git history

The human operator performs ALL Git operations manually.

You may report which files changed.

---

## Deployment Rules

DO NOT deploy.

Do not run:
- Vercel CLI deployment commands
- production deployment commands
- environment mutations

Deployment is performed manually by the human operator.

---

## Scope Discipline

Implement ONLY the requested phase/task.

Do not proactively implement future features.

Do not:
- add databases early
- add authentication early
- add APIs early
- add Google integration early
- add PWA functionality early
- add validation beyond the current task
- add animations simply because they look nice
- refactor unrelated working code

If a future requirement affects the current design, leave the appropriate
extension point without implementing the future feature.

---

## Dependencies

Do not add dependencies unless they are genuinely required for the current
task.

Prefer the dependencies already installed.

Do not replace the existing stack without explicit instruction.

---

## Generated UI Components

Files inside:

```text
src/components/ui/
```

are shadcn-generated primitives.

Do not unnecessarily rewrite them.

The ESLint Fast Refresh exception for this directory is intentional because
shadcn components may export variants/helpers alongside components.

Application-specific components belong outside this directory.

---

## Quality Requirements

After code changes, always run:

```bash
pnpm lint
pnpm build
```

Fix problems caused by your changes.

Do not claim completion if either command fails.

When relevant, also provide manual test instructions.

---

## Completion Report

At the end of every task report:

1. What was implemented
2. Files created
3. Files modified
4. Dependencies added or removed
5. Important implementation decisions
6. `pnpm lint` result
7. `pnpm build` result
8. Anything incomplete
9. Any assumptions made

Do not run Git commands after completing the task.
