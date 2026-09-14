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

Planned backend:
- Vercel Functions
- Google Sheets API
- Google service account

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

### Badge Register

Final human-facing columns include:

- Badge Number
- Name
- Phone Number
- WhatsApp Link
- Age
- Gender
- Payment Method
- Amount
- Date
- Time

Internal synchronization identifiers may be added as hidden/supporting columns.

Badge Register must remain numerically sorted ascending by badge number.

Date and Time must be separate human-facing columns.

Use Asia/Kolkata for event date/time.

Internally retain a precise timestamp such as `completedAt`.

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
presented as `Synced`, `Sync complete`, `Uploaded` or `Server connected` —
no synchronization exists. The connectivity hook is kept separable so real sync
state can be added later without reinterpreting this one.

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

Outbox processing and Google Sheets synchronization remain future work. Nothing
is sent anywhere yet, online or offline, and no outbox row is ever removed or
marked synchronized.

### Database Safety

Schema migrations must preserve existing event data.

Destructive database clearing is forbidden during normal startup or migration.

Never call, as part of startup or a migration:

- `db.delete()`
- `indexedDB.deleteDatabase()`
- `table.clear()`

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
