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

Planned offline architecture:
- PWA
- Service Worker
- IndexedDB
- Dexie

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
- fixed +91 prefix
- exactly 10 digits eventually
- numeric entry
- parents may reuse the same phone number for multiple children

Name

Age
- integer
- eventual allowed range 0–120

Gender
- Male
- Female
- no default selection

The phone number is intentionally entered before the name.

---

## Duplicate Logic

Phone number alone is NOT a duplicate.

A parent may register multiple children using the same phone number.

Future duplicate behavior:

Phone not previously used
→ New number

Phone previously used
→ Informational warning only

Same phone + different name
→ Allowed

Same phone + same normalized name + HELD
→ Resume held registration

Same phone + same normalized name + COMPLETED
→ Reject duplicate

Name normalization should eventually account for:
- case
- leading/trailing spaces
- repeated spaces

Do not implement duplicate logic before the relevant phase.

---

## Step 2 — Payment

Fixed amount:

₹20

Payment methods:

- UPI
- Cash

UPI is selected by default.

UPI uses the organizer's PERSONAL UPI.

There is no payment gateway.

Payment confirmation is manual.

Do not implement automatic UPI transaction detection.

Future UPI QR:

- fixed amount ₹20
- event payee
- transaction note:

`{Event Name} Badge Fee`

Example:

`Navaratri 2026 Badge Fee`

The same QR can be reused.

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

Do not implement persistence before the relevant phase.

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

The browser/device will eventually be the operational source of truth using
IndexedDB.

Google Sheets is the synchronized central ledger.

Do not implement offline functionality until its assigned phase.

---

## Planned Local Data Model

Future local storage will use Dexie + IndexedDB.

Likely tables:

- registrations
- outbox
- config

Held and completed registrations should preferably use registration status
rather than separate local tables unless implementation requirements justify
otherwise.

Potential statuses:

- held
- completed

Every registration will eventually have a unique internal ID.

Synchronization must eventually be idempotent.

Do not implement this early.

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
