# CNG Volunteers

Phase CNG1, corrected by **Phase CNG1.1**. The event's volunteer group, as a
third tab on `/prizes`, plus date-grouped prize history covering both
attendees and volunteers.

```
Attendees (45)   CNG (23)   Awards (79)
```

---

## Why the badge-based model was wrong

Phase CNG1 modelled a CNG member as **a registered attendee identified by a
badge number**, and resolved the organiser's pasted names against the Badge
Register.

That assumption was false. **CNG members are event volunteers.** They do not
wear the numbered attendee badges, and most never pass the registration desk
at all — so most of them are not in the Badge Register, and there is no badge
to key them by.

Representing them under that model would have required inventing one, and
every version of that is wrong:

- a **fake** badge sorts, matches a badge search and collides with a real one
- a **negative** or out-of-range badge is the same problem wearing a disguise
- a **synthetic registration** would put a person who never registered into
  the attendee ledger

So Phase CNG1.1 made the **name** the identity. Storing it centrally is an
explicit, product-required change to the privacy boundary — not an erosion of
it.

---

## What a membership is

```
cng_members   id · event_id · name · added_by_device_id · added_at
                            · removed_at? · removed_by_device_id?
```

`name` is the **one** person field this table holds. There is no phone, age,
gender, WhatsApp link or payment column, and none may be added: none of them
are needed to hand somebody a prize.

- **TEXT, required**, trimmed before storage, non-empty after trimming,
  bounded at **120** characters. The rule lives once in
  `src/shared/cng-contract.ts` and is read by the Add form and the server, so
  what an operator can submit and what the endpoint accepts cannot drift.
- **Not unique, deliberately.** Two volunteers may genuinely share a name, and
  refusing the second would refuse a real person. The row's UUID is the
  identity; the name is what a human reads.
- **No Badge Register read.** Adding a member matches against nothing.
  `badgeNumber` in any CNG body is *refused*, not ignored.

### Removal is soft

`removed_at` and `removed_by_device_id` move together, enforced by
`cng_members_removal_paired`, and the removing device must belong to the same
event. **The active roster is `removed_at IS NULL`.**

Soft removal is a requirement rather than a preference: `cng_prize_awards`
references these rows with `ON DELETE restrict`, so a volunteer who has
received a prize *cannot* be deleted — and history has to be able to say who
received it.

A removal takes the member off the active list and does nothing else. Their
prize history stays and still names them; no attendee, registration, badge or
attendee award is touched, and `server/cng/members.ts` imports none of those
tables.

---

## The CNG prize ledger

```
cng_prize_awards   id · event_id · cng_member_id · prize_name
                      · awarded_by_device_id · awarded_at
```

**Separate from `prize_awards`, and that separation is the point.** The
attendee ledger is keyed by badge number and is Production-live with real
history. Recording a volunteer's prize there would have meant making
`badge_number` nullable, putting a fake value in it, or overloading it with an
identity it does not describe. `prize_awards` is therefore **untouched** —
still six columns, still badge-based, still exactly what it was.

- the award row holds a member **reference**, never a name: one copy of a
  person's name, in one place, joined per request
- **repeat prizes are legal**, exactly as for attendees. There is no
  uniqueness of any kind and none may be added
- **append-only**: no undo, no delete, no edit, so no `updated_at`
- the same **eight-prize catalog** attendees use, from
  `src/shared/prize-contract.ts`

### A removed member cannot receive a new prize

Decided by the **database**, inside the transaction that writes. One
`db.batch`, two statements, **lock first**:

```sql
-- 1  the serialisation point
SELECT id, name FROM cng_members
WHERE id = $member AND event_id = $event AND removed_at IS NULL
FOR UPDATE;

-- 2  the guarded write
INSERT INTO cng_prize_awards (...)
SELECT …constants…
FROM cng_members
WHERE id = $member AND event_id = $event AND removed_at IS NULL
RETURNING id;
```

**The order is load-bearing.** `removeCngMember` is an `UPDATE` of that same
row, so the two contend on it:

| | |
|---|---|
| the award locks first | the removal waits. The award commits while the member is genuinely active, and the removal then proceeds |
| the removal locks first | the award's `SELECT … FOR UPDATE` waits. When the removal commits, READ COMMITTED re-evaluates the predicate on the locked row, `removed_at IS NULL` is now false, the lock yields no row — and statement 2 yields none either, so nothing is written |

A lock taken *after* the write protects nothing, and a lock taken in a
transaction of its own is released before the work it was meant to guard.

Statement 2 still carries the predicate, because `db.batch` cannot branch: an
empty `RETURNING` is the verdict the writer reads, and a foreign-key error is
never used as ordinary control flow.

**A `SELECT` then `INSERT` would not do this.** A process can pause for any
length of time between a read and a write — a GC pause, a cold start, a
retried request — and a removal can commit inside that window. That is a
timing assumption, not a transactional guarantee, which is a mistake this
project has already made once on the dandiya issuance path and does not intend
to repeat.

`scripts/cng-award-concurrency-smoke.mjs` proves the effect against a real
database: the stand-in is single-threaded, so it can only pin the lock's
presence and position.

---

## The API

One Function, five methods. `api/` holds **eleven of twelve** Hobby Functions,
and this phase spends none: there is no `api/cng.ts`.

```
GET    /api/prizes   { attendees, awards, cng, cngAwards }
POST   /api/prizes   { badgeNumber, prizeName }        attendees — UNCHANGED
PUT    /api/prizes   { cngMemberId, name }             add a CNG member
DELETE /api/prizes   { cngMemberId }                   soft-remove a member
PATCH  /api/prizes   { cngMemberId, prizeName }        award a CNG prize
```

The **method** is the dispatcher — never `?action=`, never an `action` field
in a body.

**`PATCH` is deliberately separate from `POST`.** One carries a badge number
and appends to the attendee ledger; the other carries a CNG member id and
appends to the volunteer ledger. No body shape could be read as either, so the
live badge-based semantics cannot drift, and no code path lets a volunteer's
identity reach `prize_awards`.

### Adding a member is idempotent, on a client-generated id

A volunteer list is added **one request at a time**, so a lost response has to
be safe to repeat. The **name cannot be the key**: two volunteers may
genuinely share one, and refusing the second would refuse a real person.

So the **browser** mints `cngMemberId` once, when the add is prepared — once
per open Add dialog, once per previewed name in Bulk Add — and reuses it on
every attempt. The server accepts it **only** as the idempotency key: it still
stamps `added_at` and the adding device itself, and the insert is
`ON CONFLICT DO NOTHING` **targeted at the primary key**, never bare, so it
stays loud about every other constraint.

```
same id, same name        200 already-member   the retry of a lost response
same id, different name   409 cng-id-in-use    REFUSED, never overwritten
two ids, same name        201 twice            two real people
```

Nothing is pre-read to decide this. The key decides, and the row that comes
back on a refusal is the **authoritative** one, so the screen shows what
actually exists. `id` already existed as the primary key, so this needed no
new column.

### Authorization

A **live device session** with the **current `prizes` attribute**, re-read from
Postgres on every request. No new attribute and no migration for one. An Admin
cookie authorizes nothing here. Mutations additionally require same-origin.

### Refused fields

Every CNG body refuses these with a 400 rather than ignoring them:

```
badgeNumber · badge · eventId · eventSlug · deviceId · loginName
addedAt · addedBy · removedAt · removedBy · removedByDeviceId
awardedAt · awardedBy · id · attendee · normalizedName
age · gender · phone · whatsapp · payment · paymentMethod · amount
```

`badgeNumber` heads the list deliberately: a CNG member has no badge, and a
body offering one is either the retired model resurfacing or a client
inventing an identity.

**Each method has an exact contract**, so a key outside its own set is refused
**by name** rather than ignored:

```
PUT     { cngMemberId, name }
DELETE  { cngMemberId }
PATCH   { cngMemberId, prizeName }
```

That is what makes `name` legal on `PUT` and refused on `DELETE` and `PATCH` —
two members may share one, and acting on "whoever is called that" could act on
the wrong person. `name` is therefore **not** in the shared list above: a
single deny-list cannot express a field that one method requires and another
must refuse.

### Outcomes

| | |
|---|---|
| `PUT` | `201 { outcome: 'added', member }` the first time; `200 { outcome: 'already-member', member }` for the same id and name again; `409 cng-id-in-use` for the same id under a **different** name, which is never overwritten |
| `DELETE` | `200`, or `404 not-a-cng-member` when another desk got there first. A compare-and-set on `removed_at IS NULL` |
| `PATCH` | `201 { award }`, or `404 cng-member-unavailable` when the member is removed or not on this event |

---

## The screen

### CNG tab

Cards show a **name** and `CNG Member` — **no badge, no age, no gender**,
because a volunteer has none of those. Each card offers **Give Prize** and a
quiet **Remove**.

**+ Add** opens a one-field form. The trimmed name — exactly what will be
stored — is shown back as it is typed, and the same shared validator the
server uses decides whether the button is available.

**Bulk Add Names** opens a paste. It is **no longer a resolver**: every
non-empty line is a volunteer, and nothing is matched against anything.

- lines split on `\r\n`, `\r` and `\n`; each is trimmed, blanks dropped
- a numbered **preview** shows exactly what will be added, before anything is
- a duplicate line is kept — the list said it twice, and two volunteers may
  genuinely share a name
- each confirmed name is **one `PUT /api/prizes { cngMemberId, name }`**, sent
  sequentially through the same call the single Add makes. There is no bulk
  endpoint
- the ids are minted **with the preview** and stay stable while the dialog is
  open, so a run that failed part-way through is safe to repeat: the members
  already added answer `already-member` and nobody is added twice

**The pasted text never leaves the component.** Not to Postgres as text, the
Sheet, IndexedDB, `localStorage`, `sessionStorage`, a URL, a log or an
analytics call. The desk renders the dialog *conditionally* rather than behind
an `open` flag, so closing it unmounts the component and React discards the
list.

**The organiser's real list is never compiled in.** Phase CNG1 first shipped
it as a constant in client source — which is bundled to the browser, so the
list would have been downloadable by anyone who opened the page. It is pasted
at runtime instead, and `release:check` fails if a name-list module or
constant is ever imported or declared again.

### Give Prize

Opens the CNG award dialog: the member's name, the same eight prizes, and the
same previous-prize warning — which informs and never blocks, because repeat
prizes are legal. There is **no demographic suggestion**, because a volunteer
has no age or gender recorded and this phase is not going to start collecting
them to highlight a button.

---

## Combined award history

The Awards tab is unchanged in design — date-grouped and collapsible, as
reviewed and approved — and now carries both ledgers.

```
▾ 16 October 2026                           18 awards

  #188                                         9:50 pm
  Best Dance - Female
  Ranita Shah
  AWARDED BY ...

  CNG                                          9:55 pm
  Best Dance - Female
  Asha Mehta
  AWARDED BY ...

› 15 October 2026                           14 awards
```

- an attendee row leads with the **badge**; a CNG row leads with **`CNG`** and
  the member's name. **No badge is fabricated for a volunteer**
- both are sorted together by award time, newest first, under the same
  event-local date headings
- the latest date is expanded, older ones collapsed behind clickable headings
- `Awards (N)` counts **attendee + CNG** records — the same number the history
  shows
- search matches an attendee badge, an attendee name, a CNG member name or a
  prize name. A CNG row is never matched by a number, because it has none

**The two ledgers arrive separately on the wire** and are combined for display
only, by `combineAwardHistory` in `src/prizes/award-groups.ts`. They are
different tables with different identities; merging them server-side would
mean inventing a field one of them does not have.

### The day is Asia/Kolkata

Unchanged by CNG1.1. `groupAwardsByEventDay` uses `eventDayKey` from
`src/shared/event-time.ts` — the one definition of the event's clock, the same
one the dandiya counters use. Never the browser's timezone and never the
server's: `23:59` and `00:01` IST are different nights, and `verify:cng1`
proves it with a CNG award and an attendee award two minutes apart, under
three very different process timezones.

Grouping is presentation only: nothing is moved between days, reordered within
a day or altered in any field, and flattening the groups reproduces the input
exactly.

---

## The migrations

**`0007_cng_members.sql` is history.** It has been applied to Development, so
it is not edited, renamed, deleted or regenerated. Production will apply 0007
and then 0008; Development applies only 0008.

### `0008_cng_named_members.sql`

It **refuses to run** if `cng_members` holds any row:

```sql
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "cng_members") THEN
		RAISE EXCEPTION 'cng_members is not empty: 0008 changes what a CNG membership MEANS (badge number -> name) and there is no honest conversion. …';
	END IF;
END
$$;
```

That guard is the **first** statement, before anything is altered. There is no
honest conversion from a badge number to a name, and silently inventing one
would invent people.

It then drops the badge model and adds the named one:

- `DROP CONSTRAINT cng_members_event_id_badge_number_key`
- `DROP CONSTRAINT cng_members_badge_number_positive`
- `DROP COLUMN badge_number`
- `ADD COLUMN name text NOT NULL`, `removed_at`, `removed_by_device_id`
- checks: name non-empty, name ≤ 120, removal paired
- `UNIQUE(id, event_id)` — the target the award's composite key references
- the removing-device foreign keys, both plain and same-event
- `CREATE TABLE cng_prize_awards` with its two checks, four foreign keys and
  three indexes

**It alters nothing else.** Not `events`, `devices`, `device_attributes`,
`badge_assignments`, `prize_awards`, `dandiya_loans` or
`dandiya_loan_holders` — `prize_awards` is not named by a single statement —
and it never touches Google Sheet data.

**Migrations never run automatically.** A human runs `pnpm db:migrate`, one
environment at a time — **Development first, and only after review**.
`pnpm db:check` is read-only. See `docs/DATABASE.md`.

---

## Verification

`pnpm verify:cng1` — `scripts/verification/phase-cng1.mjs`. It connects to
nothing: the real endpoint, both real writers, the real roster reader, the
real composers, the real parsers, the real grouping and the real components
all run against a stand-in Postgres, a stand-in Sheets API and a stand-in
dialog portal.

Every fixture name in the suite is **invented**. A test carrying a real
volunteer name would put it back into tracked source.

`release:check` adds the `cng-membership` audit: the exact column set of both
tables, `name` allowed on the membership and forbidden on the award, no other
person field anywhere, **no badge read, written, formatted or constructed in
any CNG module**, `prize_awards.badge_number` still NOT NULL, no Badge
Register read when curating the group, one writer per ledger with neither
reaching the other, `recordPrizeAward` still at one call site, soft removal
with a compare-and-set, the active-member guard inside the write, no
compiled-in name list, no storage or network sink in the paste dialog, a
timezone-safe grouping, and 0008 refusing a non-empty table while touching no
protected table.
