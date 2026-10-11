# Prize Distribution

`/prizes` lets an authorized Prize device award prizes to registered attendees
and shows the permanent history of what has been given.

Added in **Phase P1**. **Phase P1.1** changed the product rule: repeat winners
are allowed, and prize names come from a fixed catalog of eight.

## What P1.1 changed

| | P1 | P1.1 |
|---|---|---|
| How many prizes an attendee may receive | at most one | as many as the volunteer gives them |
| An attendee who has won | disappeared from the list | stays in the list, with a warning |
| The enforcement | `UNIQUE(event_id, badge_number)` | none — repeats are legal |
| The prize name | free text | one of eight fixed categories |
| First tab | `Eligible` | `Attendees` |
| Second tab | `Awarded`, counting people | `Awards`, counting records |
| Two desks awarding one badge at once | one won, one was refused | both succeed |

The migration that made the difference is `0004_repeat_prize_awards.sql`,
which drops the constraint `0003_prize_awards.sql` created. 0003 was **not**
edited: it had already been applied to Development, and a migration that has
run anywhere is history. A database that has never seen P1 applies 0003 and
then 0004 and arrives at the same place.

---

## The privacy boundary, unchanged

This module reads attendee data and writes a prize ledger, and the two live in
different places on purpose.

| | Holds | Does not hold |
|---|---|---|
| **Google Sheets** — `Badge Register` | badge, name, phone, age, gender, payment | — |
| **Postgres** — `prize_awards` | event, badge number, prize name, awarding device, timestamp | any attendee data at all |

The prize screen needs a name beside a badge number, so the name is **read**
from the Sheet on every request and joined to the ledger in the response. It
is never stored centrally. `prize_awards` has no column for a name, a phone
number, an age, a gender, a WhatsApp link or a payment, and it must not grow
one: Postgres has held no attendee PII since Phase 9A, and a convenience copy
is how two sources of truth begin to disagree.

The phone number and the WhatsApp link are not merely unstored — they are
never read. The prize desk identifies an attendee by the badge in their hand.

---

## Authorization

An event route, authorized by the same central device authority as every other
one:

| Requirement | Why |
|---|---|
| a device grant for this event | the only event authority since Phase D2 |
| a converged local identity | work must be attributable to the signed-in device |
| the `prizes` attribute | granted in Admin, per device |
| **a LIVE device session**, for every read and every write | the server decides, and it re-reads Postgres each time |

It deliberately does **not** require:

- `registration`
- a central badge range
- a `centralBadgeRangeBinding`

A device holding only `prizes` is a complete prize desk. Awarding a prize
consumes no badge number, so badge ownership cannot make it unsafe — and
blocking a prize desk because a *registration* desk's badge ledger disagreed
would close a module that has nothing to do with it.

A device with `registration` only is refused. A device with both may use both.

An Admin cookie authorizes nothing here. The realms are cryptographically
separate and `api/prizes.ts` imports no Admin code.

---

## Online only

Prize awarding is online only, and the screen says so:

> Prizes requires an internet connection.

While the browser reports offline there is no roster and **no award control at
all**, so nothing can appear to succeed locally. There is deliberately no
offline queue, no optimistic award, no local authoritative prize state, no
polling and no heartbeat.

The reason is one sentence: **two disconnected prize desks must never be able
to award the same badge.** Registration can be offline-first because each desk
owns a disjoint range of physical badges; prizes have no such partition, so the
only thing that can keep them unique is a single central authority answering in
the moment.

---

## The screen

Two tabs, counting different things:

```
Attendees (45)   every registered attendee, winners included
Awards (2)       every award RECORD, so one badge may appear twice
```

The attendee count does not move when a prize is given; the award count does.

```
Before award        After one award to #9005      After another
Attendees (45)      Attendees (45)                Attendees (45)
Awards (0)          Awards (1)                    Awards (2)
```

Every attendee card has **Give Prize**, always, and shows a count when that
badge already holds prizes. Search, the age window, the gender filter and
Clear filters all work over **every** registered attendee: searching `9005`
after #9005 has won three times still returns #9005.

The history tab is newest-first and lists one row per award, so repeated badge
numbers are expected and are never grouped.

---

## The API

One Function, dispatched by method.

### `GET /api/prizes`

```json
{
  "attendees": [{ "badgeNumber": 9005, "name": "Prize Test 05", "age": 11, "gender": "female" }],
  "awards": [
    {
      "id": "…",
      "badgeNumber": 9002,
      "prizeName": "Best Dance - Boy",
      "awardedAt": "2026-10-10T12:30:00.000Z",
      "awardedBy": { "id": "…", "name": "Prize Test Desk" },
      "attendee": { "badgeNumber": 9002, "name": "Prize Test 02", "age": 15, "gender": "male" }
    }
  ]
}
```

`attendees` is **every** attendee in the synced Badge Register, sorted by
badge number ascending. Nothing is subtracted from it: a previous prize
disqualifies nobody, so an attendee who has already won three stays in the
list and stays findable by search and by the age and gender filters.

`awards` is every award **record**, newest first. Several rows may share a
badge number, including rows with the same `prizeName`, and they are never
grouped or collapsed — three prizes for #9005 are three things that happened.
The `id` identifies an award; the badge number does not.

`attendee` may be `null`. History must survive a Sheet row being edited away —
the prize was still given, and the badge, prize, time and awarding device are
facts the ledger itself owns.

### `POST /api/prizes`

```json
{ "badgeNumber": 9005, "prizeName": "Best Dance - Girl" }
```

`prizeName` must be **exactly one of the eight catalog labels** below.
Surrounding whitespace is trimmed; nothing else is repaired. An arbitrary
string is refused with `400`, never corrected into whichever prize it
resembled.

Nothing else is accepted. `eventId`, `eventSlug`, `deviceId`, `loginName`,
`awardedAt`, `awardedBy`, `attendee`, `name`, `age` and `gender` are **refused
outright** rather than ignored: the session identifies the device and the
event, the database stamps the time, and an attendee field submitted by a
client is a claim about a person that the Badge Register already answers.

Preconditions, in order:

1. a live device session
2. a well-formed body — positive integer badge, and a prize name that is one
   of the eight catalog labels
3. the current `prizes` attribute
4. readable Sheet credentials, behind the existing release interlock
5. **the badge exists in this event's Badge Register**
6. the insert

The only attendee precondition is step 5. The ledger is **not** consulted:
there is no "has this badge been awarded?" question to ask, so every
successful `POST` appends exactly one row.

| Outcome | Status |
|---|---|
| recorded | `201` with the complete history row |
| badge not in the register | `404` `blocked: "badge-not-registered"` |
| prize name not in the catalog | `400` |
| Sheet unreadable, or writes not configured | `503` `reason: "roster-unavailable"` |

There is **no `409`** and no `already-awarded`. Both were removed in P1.1
along with the constraint they reported.

A constraint name, a SQLSTATE and another device's internals never appear in a
response.

---

## The prize catalog

Free-text prize entry was removed in P1.1. The allowed values are exactly
these eight:

| Best Dance | Best Dress |
|---|---|
| `Best Dance - Boy` | `Best Dress - Boy` |
| `Best Dance - Girl` | `Best Dress - Girl` |
| `Best Dance - Male` | `Best Dress - Male` |
| `Best Dance - Female` | `Best Dress - Female` |

The allow-list lives in `src/shared/prize-contract.ts` and is read by the
browser chooser and by the server, so what a volunteer can tap and what the
endpoint will accept cannot drift. There is **no catalog table**: eight values
that change once a year do not need a migration, an Admin screen and a join.

The canonical **label** is the wire value and the stored value, so the ledger
reads correctly with no lookup. Each entry also carries a stable `code`
(`best-dance-girl`), used for React keys, grouping and tests, and never
stored.

### The demographic suggestion

The Badge Register already knows the attendee's age and gender, so the chooser
highlights the likely division:

| | under 18 | 18 and over |
|---|---|---|
| **Male** | Boy | Male |
| **Female** | Girl | Female |

18 is the boundary and it is adult: a 17-year-old is suggested `Girl`, an
18-year-old `Female`.

It is a **recommendation and nothing else.** All eight buttons stay enabled,
nothing is preselected, nothing is auto-submitted, and an award is never
refused for disagreeing with the hint — the volunteer at the table knows
things the Badge Register does not. The server never consults it;
`release:check` fails if anything under `api/` or `server/` reaches for it.

No division is ever stored against a person. It is a property of the prize.

### Legacy history

A P1 award may hold any free-text name up to 80 characters — Development has
one real row reading `Best Dressed`. Those rows are **history**: the prize was
given, so the API returns them, the client parser accepts them and the history
tab displays them. Only **new** awards are restricted to the eight values.

---

## Repeat prizes

An attendee may receive Best Dance and Best Dress, the same prize twice, or
several prizes over the evening. Previous awards are **information**.

`0004_repeat_prize_awards.sql` drops P1's
`UNIQUE(event_id, badge_number)` and deliberately puts **nothing** in its
place — not `UNIQUE(event_id, badge_number, prize_name)`, not one per
category, not a unique index. Every one of those would refuse a second
legitimate award.

The database may therefore hold, legitimately:

```
#9005  Best Dance - Girl
#9005  Best Dress - Girl
#9005  Best Dance - Girl
```

### The warning

When Give Prize is opened for a badge that already has awards, the dialog
shows a prominent amber **Previous prizes** section above the chooser, naming
each earlier prize with its time and its awarding device, and saying how many
there are and that another may still be given. The button reads **Award
Another Prize** instead of **Award Prize**.

It **never blocks**. It disables nothing, removes nobody from the list,
returns no conflict and asks for no Admin approval or override permission.

The warning is drawn from the award history the screen has already loaded, so
a prize given a moment ago is listed the next time the dialog opens — the
returned record is appended locally rather than re-fetched, which would
discard the filters the volunteer is working through. An explicit **Refresh**
re-reads everything from the server. There is no polling.

### Concurrency

Two devices **may** award the same badge at the same moment, and **both
inserts succeed**. That is now legal, and the database no longer arbitrates
it.

What is still protected is an accidental double submission from **one** UI
action: while a request is in flight the submit button and all eight prize
buttons are disabled, the desk refuses a second call outright, and overlapping
roster reads still resolve by sequence rather than by timing, so a late older
response cannot replace newer state.

**A Sheet that cannot be read writes nothing.** The register is the only thing
that can confirm a badge exists, so the read happens before the insert and a
failure fails closed.

### What `db:check` proves

After `0003` and `0004` have been applied by hand, `pnpm db:check` proves the
real database carries the ledger and its guarantees — the table, its exact six
columns, the three checks, both foreign keys, the same-event composite key and
both indexes — and that it carries **no per-attendee uniqueness**:

```
PASS  repeated prize awards are allowed
```

That line looks for the *shape* rather than the old constraint's name: a
UNIQUE constraint, a primary key or a bare unique index mentioning
`badge_number` all fail it, because a replacement under a new name would be
the same broken rule. A database that still carries one refuses a second
legitimate prize, and a volunteer would meet that at the table rather than at
release time.

Everything it does is a `SELECT` against the Postgres catalog. It verifies
each remaining constraint by **definition** rather than by name — a constraint
with the right name and the wrong columns would guarantee nothing — and
compares the column set for equality, so an ADDED column fails.

---

## No undo

Prize history is **append-only from the product**. There is no undo, no delete
and no edit, so `prize_awards` carries no `updated_at` and gets no
`set_updated_at` trigger — `awarded_at` is the only timestamp that means
anything.

A prize given by mistake is therefore a row a human removes deliberately, and
that is the deliberate trade for letting a volunteer award freely.

A prize that has been handed over has been handed over. A ledger a volunteer
can rewrite is not a ledger.

Admin has no prize screen either. Correcting a mistaken award is a deliberate
database operation by a human, like every other central correction.

---

## Development fixtures

`/prizes` reads real synced registrations, so testing it needs rows in the
**Development** Badge Register. `scripts/seed-prizes-development.mjs` puts
thirty obviously fake ones there.

```bash
# Confirm the configuration before anything is written. Makes NO request.
env VERCEL_ENV=development node scripts/seed-prizes-development.mjs --dry-run

# Seed badges #9001-#9030.
env VERCEL_ENV=development node scripts/seed-prizes-development.mjs --confirm

# Remove exactly those rows again.
env VERCEL_ENV=development node scripts/seed-prizes-development.mjs --cleanup --confirm
```

`VERCEL_ENV` is supplied explicitly because `vercel dev` does not expose it to
this project — the same reason the guarded local sync command does.

**It cannot seed Production.** Four independent things must agree:

1. `--confirm` on the command line
2. `VERCEL_ENV` exactly `development`
3. `SYNC_ALLOWED_VERCEL_ENV` exactly `development`
4. the real release interlock in `server/sync/environment.ts`, which requires
   those two to match *before* it reads a single credential

A production deployment sets `SYNC_ALLOWED_VERCEL_ENV=production`, so even a
production credential in the environment is refused. The one thing no code can
check is whether a development env file points at the production spreadsheet,
so the script prints a short non-reversible **fingerprint** of the spreadsheet
id to compare by eye. It never prints the id or any other value.

What it seeds:

- badges **#9001-#9030** — far above any range a real desk is handed, so a
  fixture row is recognisable at a glance
- names `Prize Test 01` … `Prize Test 30`
- ages from 5 to 71, covering children, teens and adults
- fifteen Male and fifteen Female
- phones in the unused `90000000xx` block, amounts of ₹20, alternating
  UPI/Cash, and valid Date/Time cells built by the application's own row
  builder

It is **idempotent**: every fixture row has a deterministic Registration ID, so
a second run rewrites the same thirty rows instead of adding thirty more.
`--cleanup` blanks only those rows in place — it never deletes a row, because
removing a dimension shifts every index below it, and it never touches a row it
did not write.

The fixture rows carry no device id or device name on purpose, so a pre-Phase-7
`legacy` Development tab stays recognisable as legacy rather than becoming a
shape the sync endpoint would refuse.

---

## The test prize device

In **Development** Admin, create a disposable device:

| Field | Value |
|---|---|
| Name | `Prize Test Desk` |
| Login | `prize-test` |
| Enabled | yes |
| Access | `prizes` only |
| Badge range | none |

Provision a disposable password. Do **not** give it `registration` unless you
are deliberately testing mixed access — a `prizes`-only device is the case most
worth proving, because it has no badge range at all.

---

## Rate limiting

`/api/prizes` gets **no firewall rule**. It is authenticated device traffic,
refused outright without a valid `__Host-navaratri_device_session`, so there is
no credential to guess at it and no enumeration surface to throttle. A rule
would throttle a prize desk's ordinary roster reads instead. See
`docs/VERCEL_FIREWALL.md`.

---

## Verification

```bash
pnpm verify:p1
```

Exercises the real endpoint, the real ledger writer, the real roster reader,
the real composer, the real filters, the real catalog and the real prize
chooser and previous-prize warning — the last two rendered with
`react-dom/server`, with only Base UI's dialog portal stood in for, because it
produces nothing at all server-side.

Postgres, the Sheets API and HTTP are stood in for. It never opens a socket.

The P1 assertions that proved a second prize was *refused* were rewritten
rather than deleted: the same situations, with the opposite expected outcome.
That is the only honest way to record a deliberate reversal — a deleted
assertion looks like a rule nobody ever had.
