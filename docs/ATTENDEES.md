# Attendee Directory

`/attendees` is a **read-only** directory of everyone registered for the
event, for a device holding the `attendees` attribute.

Added in **Phase A1**.

It exists for the people who need to *look something up* — confirm a badge
number, find a name, count who is here — without being handed a registration
desk or a prize desk to do it from.

---

## It changes nothing

This is the whole design, so it is worth stating plainly and in one place.

| | |
|---|---|
| `GET /api/attendees` | the only operation |
| `POST` `PUT` `PATCH` `DELETE` | `405 Method Not Allowed`, `Allow: GET` |
| Database writes | none — the endpoint opens no database client |
| Sheet writes | none — the reader performs no `batchUpdate` |
| Local writes | none — no IndexedDB, no `localStorage`, no Cache Storage |
| Controls on the page | Refresh, four filters, Clear filters |

The attendee card takes **one** prop and renders three lines. There is no
handler to call, no button, no form and no `onClick` anywhere on it — the
directory cannot change an attendee because nothing in it is capable of
asking. `release:check` fails if any of that stops being true.

Correcting an attendee is still the registration desk's job.

---

## The privacy boundary, unchanged

The directory reads the **same** Badge Register that `/api/prizes` reads,
through the **same** reader — `server/attendees/register.ts`.

| | Holds | Reaches this module |
|---|---|---|
| **Google Sheets** — `Badge Register` | badge, name, phone, WhatsApp link, age, gender, payment, amount, timestamps, ids | badge, name, age, gender |
| **Postgres** | events, devices, attributes, badge ranges, the prize ledger | nothing about an attendee |

```json
{ "badgeNumber": 9005, "name": "Meera", "age": 11, "gender": "female" }
```

Four fields. The phone column and the WhatsApp link are not merely unsent —
they are **never read into a variable**, and the row is never spread, so a
column appended to the Sheet later cannot ride along.

There is deliberately **no attendees table in Postgres, no second
spreadsheet and no local copy**. Postgres has held no attendee PII since
Phase 9A, and a convenience copy for a directory screen would be exactly the
second source of truth that ends that.

---

## Authorization

An event route, authorized by the same central device authority as every
other one. No new realm.

| Requirement | Why |
|---|---|
| a device grant for this event | the only event authority since Phase D2 |
| a converged local identity | the browser must be the signed-in device |
| the `attendees` attribute | granted in Admin, per device |
| **a LIVE device session**, on every read | the server decides, and re-reads Postgres each time |

It deliberately does **not** require `registration`, `prizes`, a central
badge range or a `centralBadgeRangeBinding`. Reading a register consumes no
badge number and changes nothing, so badge ownership cannot make it unsafe —
and blocking a viewer because a *registration* desk's badge ledger disagreed
would close a module that has nothing to do with it.

### The three attributes are independent

```
registration only   /badge-registration ✅   /prizes ❌   /attendees ❌
prizes only         /badge-registration ❌   /prizes ✅   /attendees ❌
attendees only      /badge-registration ❌   /prizes ❌   /attendees ✅
```

`prizes` does **not** imply `attendees`, and `registration` does not either.

The prize desk shows its own attendee roster because identifying the badge in
somebody's hand is part of awarding a prize. Browsing the whole register —
every name, searchable, by whoever is holding the tablet — is a separate
thing to be trusted with, so it is separately granted. A device may hold
`attendees` alone, and that is a complete and useful device.

An Admin cookie authorizes nothing here, and `api/attendees.ts` imports no
Admin code.

---

## Online only

The directory reads the live register, and says so when it cannot:

> Attendees requires an internet connection.

While the browser reports offline there is **no list at all** — not a cached
one, not a stale one. There is no IndexedDB cache, no offline roster, no
service-worker copy of attendee data, no polling and no heartbeat.

A stale directory presented as current is worse than none: it would tell a
volunteer somebody is registered who is not, or hide somebody who is.

The only timer in the module aborts a request that never answers. It is not a
retry.

---

## An empty register and an unreadable one are different

This distinction is load-bearing on both sides of the wire.

| State | Response | Screen |
|---|---|---|
| Nobody has registered yet | `200` `{ "attendees": [] }` | `Attendees (0)` and *"No attendees have been registered yet."* |
| The Sheet could not be read | `503` `reason: "register-unavailable"` | an error, with **Try again** |

A register that cannot be read is never answered with `[]`, and never with a
partial list. Whoever reads "No attendees have been registered yet" has to be
able to believe it.

---

## The API

```
GET /api/attendees
```

```json
{
  "ok": true,
  "attendees": [
    { "badgeNumber": 9001, "name": "Prize Test 01", "age": 7, "gender": "female" }
  ]
}
```

Sorted by badge number **ascending**, which is the order somebody scans a
stack of badges in. The count is `attendees.length`; there is no separate
count field, because a second field carrying it is a second thing that can
disagree with the list.

Preconditions, in order:

1. a live device session — `session_version` current, device enabled,
   credentials provisioned, event active
2. the current `attendees` attribute, re-read from Postgres
3. readable Sheet credentials, behind the existing release interlock
4. a Badge Register with the expected layout

Every failure is generic to an unauthenticated caller: a `401` tells it
nothing about whether an event, a register or a database exists.

| Outcome | Status |
|---|---|
| the roster | `200` |
| no session, or a stale one | `401` |
| no `attendees` attribute | `403` `blocked: "attendees-required"` |
| register unreadable, or writes not configured | `503` `reason: "register-unavailable"` |
| any other method | `405` with `Allow: GET` |

Filtering is **client-side** after that one request. The event is a few
hundred attendees; a query per keystroke would add latency and server
complexity to solve a problem of a size this event does not have.

---

## Shared, not duplicated

Two modules now read attendees, so each piece exists once:

| Shared module | Used by |
|---|---|
| `server/attendees/register.ts` | `GET /api/attendees`, `GET`/`POST /api/prizes` |
| `src/shared/attendee-contract.ts` | both, plus the browser parsers |
| `src/attendees/attendee-filters.ts` | the directory and the prize desk |
| `src/components/attendees/attendee-filters.tsx` | both screens |

A second Badge Register parser would be a second opinion about which columns
exist, how an age is read, how gender is normalised and which rows are
usable — and the two would drift the first time somebody hand-edited a cell.
A second set of filters would mean one screen finding Meera and the other
not.

`release:check` pins this: exactly one module outside `server/sync/` may
reference `BADGE_REGISTER_COLUMNS`, and both Functions must go through
`readAttendeeRegister`.

The prize module keeps the names it already spoke in —
`PrizeAttendee` and `PrizeGender` are **aliases** of the shared types, not
copies — so Production-live prize code did not have to churn.

---

## No migration

A1 needs none. `device_attributes.attribute` is already plain text and the
application owns the allow-list, so `attendees` is a new allowed string and
nothing else. The migration set is unchanged at `0000`-`0004`, and
`release:check` fails if a `0005` appears for this phase.

---

## Rate limiting

`/api/attendees` gets **no firewall rule**. It is authenticated device
traffic, refused outright without a valid `__Host-navaratri_device_session`,
and it is read-only. A rule would throttle a viewer pressing Refresh and
protect nothing. See `docs/VERCEL_FIREWALL.md`.

---

## The test viewer device

In **Development** Admin, create a disposable device:

| Field | Value |
|---|---|
| Name | `Attendee Viewer Test` |
| Login | `attendee-viewer-test` |
| Enabled | yes |
| Access | `attendees` only |
| Badge range | none |

Provision a disposable password. Do **not** give it `registration` or
`prizes` — a viewer with neither is the case most worth proving, because it
has no badge range, no binding and nothing it can change.

Sign in at `/device-login`, then **Set Up This Device**. Home must then show
Badge Registration and Prizes as *Not on this device*, Attendees as
available, and Dandiya as *Coming soon*.

The existing prize fixtures (`scripts/seed-prizes-development.mjs`, badges
`#9001`-`#9030`) are what makes the directory worth looking at in
Development. See `docs/PRIZES.md`.

---

## Verification

```bash
pnpm verify:a1
```

Exercises the real endpoint, the real Badge Register reader, the real route
policy, the real shared filters, the real browser client and the real cards
and filter controls against a stand-in Postgres and a stand-in Sheets API. It
never opens a socket.
