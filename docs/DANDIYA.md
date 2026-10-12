# Dandiya Checkout and Return

`/dandiya` is the dandiya desk: a physical **pair** of sticks goes out to
exactly **two** registered attendees, and stays out until somebody brings it
back. That repeats all evening, and across event days.

Added in **Phase D3**.

---

## The product rules

```
D-014
  #0042  Meera Patel
  #0081  Arjun Shah
```

| | |
|---|---|
| One pair goes to | exactly two **different** registered badges |
| Both badges must | exist in the current Badge Register |
| One physical pair may have | at most **one** unreleased loan |
| One attendee may hold | at most **one** unresolved stick |
| Each stick ends | **independently** — `RETURNED` or `LOST` |
| A loan stays open | while **any** stick is still out |
| A pair may go out again | only after **both** sticks were RETURNED |
| After any loss | the pair is **unavailable for the rest of the event** |
| An attendee stops holding a stick | as soon as **their own** stick is resolved, either way |
| A pair issued on ONE badge | stays **that badge's** responsibility until the loan closes |
| A loan is closed by | a person, and by nothing else |

Repetition is the normal case, not the exception: the same pair may go out
fifty times in an evening, and the same two people may take one out again
after returning the first.

### Three ways to issue a pair

Not everybody dancing has been through the registration desk, so a pair needs
an accountability anchor rather than two badges.

| Mode | Holders | Accountability | Anchor column | Phone |
|---|---|---|---|---|
| **Two badges** | two registered attendees | **each own stick** | NULL | none |
| **One badge** | one attendee + one guest | **that badge, whole loan** | `accountability_badge_number` | none |
| **No badges** | two guests | **one contact phone number** | NULL | required |

**Exactly one anchor per loan**, so each non-null column names one mode: an
anchor badge means *mixed*, a contact number means *fully badgeless*. The
database holds that with `dandiya_loans_accountability_exclusive`; the mode
itself is derived server-side from the two holders and is never a caller's
choice.

```
PAIR 12                         PAIR 14                    PAIR 18

#9012  Person A                 #9012  Person A            Guest 1  No badge
#9023  Person B                 Guest 2  No badge          Guest 2  No badge

                                                           Contact
                                                           +91 98765 43210
```

**One badge is enough.** A phone is *not* collected because one guest exists —
the other holder's badge is the anchor, and the server **refuses** a number
offered beside a badge rather than storing one nobody needed.

**And that badge answers for the WHOLE pair until the loan closes.** This is
what "give the pair on the badge" means, and the holder-level rule cannot say
it:

```
PAIR 20     #100 registered attendee        #100 returns their OWN stick
            Guest 2  no badge               Guest 2's stick is still OUT
                                            -> the loan is still OPEN
                                            -> #100 may NOT anchor another
                                               mixed pair
```

`dandiya_loan_holders_one_unresolved_per_badge` is partial on `resolved_at`,
so it has already freed #100 — correctly, they are holding nothing. The
whole-loan obligation is a **separate** guarantee, and it lives on the loan:

```sql
UNIQUE(event_id, accountability_badge_number) WHERE closed_at IS NULL
```

**Partial on `closed_at`**, so the anchor is released when the pair is
actually accounted for — a clean return, a partial loss or a total loss alike
— and a historical anchoring never permanently blocks anybody. Partial on
`pair_released_at` instead would tie the attendee to the *pair's* quarantine
after a loss, which is the stock's problem and not their debt.

**Both rules are kept, because they protect different things.** One attendee
cannot personally hold two unresolved **sticks**; one badge cannot anchor two
open mixed **loans**. NULLs stay non-conflicting, so **a two-badge pair keeps
its D3.1 semantics exactly**: each holder is freed by their own stick, and
whole-loan anchoring is never imposed on it.

#### An open anchor blocks that badge from *every* new loan

Not only from another mixed pair. While Pair 20 is open and issued on #9005,
that badge takes part in nothing:

```
PAIR 21   #9005 + Guest    refused   accountability-already-holding-pair
PAIR 22   #9005 + #9010    refused   accountability-already-holding-pair
```

No unique index can hold this half. The offending badge is a **holder** row of
the new loan while the anchor is the **loan** row of the old one, and an index
compares columns of one row of one table — and a second table recording badge
availability would be a second place that can disagree with the ledger.

#### Issuance serialises on the event row

So the decision is made by the **database**, inside the transaction that
writes. One `db.batch`, four statements, in this order and no other:

```sql
-- 1. the serialisation point
SELECT id FROM events WHERE id = $event FOR UPDATE;

-- 2. the guarded write: the anchor rule is this statement's own WHERE
INSERT INTO dandiya_loans (id, event_id, pair_code, ...)
SELECT $loan, $event, $pair, ...
  FROM events
 WHERE events.id = $event
   AND NOT EXISTS (SELECT 1 FROM dandiya_loans
                    WHERE event_id = $event
                      AND closed_at IS NULL
                      AND accountability_badge_number IN ($badges))
RETURNING id;

-- 3, 4. one per stick, conditional on that loan existing
INSERT INTO dandiya_loan_holders (id, loan_id, event_id, badge_number, slot, ...)
SELECT gen_random_uuid(), $loan, $event, $badge, $slot, ...
  FROM dandiya_loans WHERE id = $loan;
```

`db.batch` cannot branch, so the rule rides on the insert's own `WHERE`. When
it does not hold the select yields no row, nothing is written, and `RETURNING`
comes back empty — which is the verdict the writer reads. Statements 3 and 4
select from the loan statement 2 would have written, so **a refusal writes no
holder rows either** and the batch commits having changed nothing. A
foreign-key error is never used as ordinary control flow.

**There was a pre-read here, and it was a TOCTOU hole.** `SELECT` the open
anchors, decide in application code, then write: a process can pause for any
length of time in between — a GC pause, a cold start, a retried request — and
in that window another desk can commit a mixed loan on the same badge *and*
that badge's own stick can be resolved. The holder index then has nothing to
catch, because the only unresolved stick left on the other loan belongs to a
guest. The retracted defence of that read argued from how many network round
trips could fit in the window, which is a timing assumption rather than a
transactional guarantee. A process pause has no bound.

**Why the event row.** There is no central row standing for "badge #9005 in
this event" to lock instead — the badge lives in the Google Sheet. The event
row is the one row every issuance of one event genuinely shares. It is
deliberately coarse: two desks issuing for the same event take turns, an
issuance is four statements with no network waits in between, and different
events never block each other. Correctness first; make it finer only if real
measurements show contention.

Never an advisory lock, an application mutex, a browser lock, sleeping,
retrying, or a second badge-availability table.

**It is not the D3.1 resolution lock.** Resolutions lock their own **loan**
row, which serialises two desks resolving different sticks of one pair.
Issuance locks the **event** row. Two questions, two locks, one call site each.

**Within the locked transaction the anchor set can only shrink** — anchors are
created by issuance, which this lock serialises, and removed by a close. That
holds only while nothing `UPDATE`s an anchor and nothing sets `closed_at` back
to null, and `release:check` fails on either.

**The stand-in database cannot prove this.** It is single-threaded, so a
scripted writer has always already committed. `verify:d3` pins the statement
order from the transaction's own record and the structure around it;
`scripts/dandiya-issuance-concurrency-smoke.mjs` proves the effect against a
real database — a writer that began *before* an anchor committed still
observes it after waiting on the event row.

**Closing the loan releases the badge into both kinds of pair again**, because
the anchor index is partial on `closed_at`.

**The mode is derived, never submitted.** `openDandiyaLoan` takes an
already-discriminated issuance — `two-badges`, `one-badge` or `badgeless` —
and `issuanceColumns` is the one total, unexported function from mode to
columns. That is why none of the four impossible loans can be written: a mixed
loan with no anchor, one anchored to a badge that is not on it, a badge loan
carrying a phone number, and a badgeless loan with no contact. A request body
naming `accountabilityBadgeNumber` is **refused**, not ignored.

**On screen** a mixed pair labels its badge holder *Accountability badge*, on
the Active card and in History, read from the server's own value rather than
inferred. The other two modes show nothing — on a two-badge pair it would be
false, and on a badgeless one the contact number is already there.

**A no-badge holder is `badge_number = NULL`**, never a synthetic badge. Not
`0`, not `-1`, not `999999`, not `GUEST-1`. A fake number would sort, match a
badge search and collide with a real badge, and no screen could tell a guest
from an attendee whose badge had been mistyped. NULL is the truthful
representation of "there is no badge".

**Both sticks are still separate holder rows**, so each can be returned or
marked lost on its own exactly as a badge holder's can. A guest's stick is
named by its **slot** — 1 or 2 — because a badge could not name it.

**Nothing else is collected.** No guest name, no age, no gender, no address,
no ID, no WhatsApp field. The slot exists so the stick can be accounted for;
the pair's accountability is a badge or a single number.

### Each stick is its own obligation

Two people take one pair. One finishes dancing and hands their stick back;
the other is still on the floor. **Phase D3.1 records that as it is** rather
than averaging it into "out" or waiting for both:

```
PAIR D-021                       INCOMPLETE

#0042  Meera Patel     Returned · 8:14 PM
#0081  Arjun Shah      Stick 2 · Out      [ Return Stick ] [ Mark Lost ]
```

Meera is free — she has nothing left to give back, and she may be issued
another pair. Arjun is not. The **pair** is not free either: a pair missing a
stick is not a pair.

A stick can also be **LOST**. That frees the attendee for the same reason a
return does — they have no stick and nothing more to give back — and the
event keeps a record of it. It does **not** free the physical pair.

### Three loan outcomes, derived

When the last stick is resolved the loan closes with an outcome derived from
the two resolutions:

| Resolutions | Outcome | Pair afterwards |
|---|---|---|
| returned + returned | `returned` | **released** — may go out again |
| returned + lost | `partial_loss` | **quarantined** for the event |
| lost + lost | `lost` | **quarantined** for the event |

Only `returned` sets `pair_released_at`. There is no repair action, no
override and no release control anywhere in the application: freeing a
quarantined pair means somebody physically replaced the missing stick, and
that is a decision with a person behind it rather than a button on the floor.

There is deliberately **no separate inventory table**. A pair's availability
is a fact about its last loan, and a second place recording it is a second
place that can disagree.

### A resolution is final

Returned never becomes lost and lost never becomes returned, however often
the request is repeated. `Return Whole Pair` on a loan with a lost stick
resolves only the stick still out and closes the loan as a partial loss; it
never rewrites the loss. `Report Pair Lost` preserves an already-returned
stick the same way.

### A previous loss is information, not a penalty

Somebody who lost a stick earlier may be issued another pair. The screen
warns the volunteer, naming the pairs and when; nothing is disabled and there
is no override to find, because there is nothing to override.

---

## Nothing expires

**An open loan is not closed by a date.** Midnight changes which rows a
screen calls "today" and nothing else — it never returns a pair, releases a
holder, frees a badge or resets a pair's availability.

A pair still out from yesterday stays in **Active**, labelled
**Outstanding since 12 Oct** with the day named, so somebody chases it rather
than mistaking it for tonight's traffic. It is reachable as
**Active → Carryover**, and the main screen says how many there are.

### A loan belongs to the day it went OUT on

This is the whole of the day-wise history, and it is worth stating before
anything else:

| | |
|---|---|
| A loan's historical day is | `issued_at`, in the event timezone |
| It is **never** | `closed_at`, `resolved_at`, or when anyone looked |
| A loan crossing midnight | stays on the day it was issued, and says it closed on the next |
| An unresolved loan | appears in its own day's history **and** in Active |
| Midnight | moves the day label and the counters. It mutates nothing |

```
Pair 12
Issued   12 Oct, 11:50 PM
#9012    Returned 12 Oct, 11:58 PM
#9023    Returned 13 Oct, 12:20 AM
Outcome  Returned
Closed   13 Oct, 12:20 AM          <- the next day, and still 12 Oct history
```

**Why not the close.** Grouping by `closed_at` would move a loan from one day
to another as it was resolved, so "what did we hand out last night?" could
never be answered twice the same way — and the pairs that matter most, the
ones still out, have no close at all and would belong to no day.

**No stored day column.** There is no `event_day`, no copied date and no
nightly snapshot. The day is derived from the timestamp the ledger already
holds, so there is nothing to roll over at 00:00 and nothing that can drift
from the loan it describes. `release:check` fails if a rollover mutation
appears.

### Two different questions, at two different times

This is the part that is easy to get backwards.

| When | The question | Where to look |
|---|---|---|
| **During the event day** | which sticks have not come back tonight? | **History → Today → Outstanding** |
| **After midnight** | what is still owed from last night? | the **carryover banner**, and **Active → Carryover** |

**Closing up is a History question.** While the day is still running, the
sticks that are out are *today's*, so the end-of-night list is today's own
history filtered to Outstanding — pair code, both attendees, badge numbers,
and which stick is missing.

**The carryover banner is the morning-after reminder.** It appears only once
the event day has rolled over and last night's unresolved loans have become
somebody else's problem to chase. That is a change of LABEL, not of state:
the loans did not move, close or release, and nothing was written at 00:00.

### Previous-day carryover

```
2 pairs · 3 sticks still outstanding from previous days   [ Show carryover ]
```

It counts **pairs** and **sticks** separately because they are different
jobs: two pairs with one stick each is two people to find, not four. It is
**derived from the open loans the board already carries** — a projection,
never a stored figure — and it is silent at zero.

`Show carryover` opens **Active** with its **Carryover** filter selected, so
the rows are exactly the pairs the banner counted. Active's own filters are:

| | |
|---|---|
| **All** | every pair that is out — the usual view |
| **Carryover (N)** | open loans issued **before** the server's event day |

Switching between them is **purely client-side** over rows already loaded: no
request, and nothing about a loan changes. As the last leftover is resolved
the Carryover view empties, says *"Nothing is outstanding from previous
days."* and offers **Show all active pairs** — it never silently throws the
operator back to a view they did not choose.

The day both the banner and the filter compare against comes from the
**server**, not the tablet: a device with a wrong clock would otherwise under-
or over-report the one number somebody is relying on.

That is structural, not a convention: there is no timer, no nightly job, and
no date arithmetic on any mutation path. `release:check` fails if
`server/dandiya/loans.ts` or `api/dandiya.ts` so much as reads the calendar.

The event timezone (`Asia/Kolkata`) is used for the "today" counters and the
history filter, and `src/shared/event-time.ts` is the one definition of which
day an instant falls in — shared, because the server counts and the browser
filters, and two implementations would disagree for ninety minutes every
night.

---

## The database owns both guarantees

`0005_dandiya_checkout.sql` creates two tables.

```
dandiya_loans          event · pair_code · issued_by · issued_at
                               · closed_by · closed_at
                               · outcome · pair_released_at

dandiya_loan_holders   loan · event · badge_number · slot
                               · resolution · resolved_at · resolved_by
```

`resolved_at IS NULL` means that attendee is **still holding their stick**.
`pair_released_at IS NULL` means the **physical pair** is not available —
which covers both a loan still running and a pair quarantined by a loss. A
closed loan is history and is never deleted.

`closed_at IS NULL` means the loan is still open. It is a **third** state and
not a synonym for either of the others: a quarantined pair has a closed loan,
every stick resolved, and an unreleased pair code at the same time.

### Two partial unique indexes

```sql
UNIQUE(event_id, pair_code)    WHERE pair_released_at IS NULL
UNIQUE(event_id, badge_number) WHERE resolved_at IS NULL
```

These are the **entire concurrency story**, and they are **partial** on
purpose: uniqueness that also covered history would forbid exactly the reuse
the event depends on.

No application check can replace them. Two desks can each read "that pair is
free" and both submit, so the endpoint asks the ledger **nothing** before
inserting — a `SELECT` above the insert would only move the race. One insert
wins; the other is told which conflict it hit.

`db:check` verifies the **predicate**, not just the columns. An index that
kept its columns and lost its `WHERE` clause would stop a pair from ever
going out a second time, which is the opposite failure and just as bad.

It also verifies **which column** each predicate names, because there is a
near-miss that reads almost identically. The attendee index partial on
`resolution IS NULL` would release a holder the moment their stick was
recorded **lost** — and also when it was returned — so the one thing it must
be partial on is `resolved_at`.

### The release rules are database CHECKs

```sql
pair_released_at IS NULL OR outcome = 'returned'
outcome IS DISTINCT FROM 'returned' OR pair_released_at IS NOT NULL
```

Both directions, because `pair_released_at` is simultaneously the release and
the pair index's predicate: a loss that released the pair would put a pair
with one stick straight back into circulation, and a clean return that forgot
to release would retire a perfectly good pair for the evening. This is the
rule a well-meaning repair would relax first, so the database holds it rather
than the application.

A resolution and a close are each all-or-nothing:
`dandiya_loan_holders_resolution_paired` requires `resolution`, `resolved_at`
and `resolved_by` to be present together or absent together, and
`dandiya_loans_close_paired` does the same for `closed_at`, `closed_by` and
`outcome`.

### Holders are rows, not columns

Two rows per loan, one per stick-slot — because the active-attendee guarantee
has to be a unique index over a **single** badge column. With `badge_one` and
`badge_two` columns there is no index that could stop the same attendee
appearing as `badge_one` here and `badge_two` there.

`UNIQUE(loan_id, slot)` keeps a loan to two holders; `UNIQUE(loan_id,
badge_number)` stops one attendee holding both sticks of a pair.

### One transaction each

| Operation | One `db.batch`, all or nothing |
|---|---|
| Issue | the loan row **and** both holder rows |
| Resolve | the holder resolution **and**, if it was the last, the loan's close |

Issuing matters because a pair marked out with one holder is a ledger nobody
can reconcile — so a holder conflict rolls the loan back too.

Every holder write is a **compare-and-set** on `resolved_at IS NULL`. That is
what makes a resolution final and what makes two volunteers at the same table
safe: the loser matches no row and is told.

### The loan row is locked first

Every resolution transaction begins with

```sql
SELECT id FROM dandiya_loans
WHERE id = $1 AND event_id = $2 AND closed_at IS NULL
FOR UPDATE
```

Its rows are never read. The only thing wanted is the **row lock**.

**Compare-and-set alone does not serialise this**, and that is worth being
precise about because it is easy to believe it does. Two desks resolving
*different* sticks of one pair write *different* holder rows, so they never
conflict with each other. Under READ COMMITTED — what this runs at — every
statement takes a fresh snapshot and sees its own transaction's writes but not
another transaction's uncommitted ones. So:

| | Desk A resolves stick 1 | Desk B resolves stick 2 |
|---|---|---|
| holder CAS | matches, stick 1 resolved | matches, stick 2 resolved |
| close CAS | sees stick 2 still out → no match | sees stick 1 still out → no match |
| commit | loan left open | loan left open |

Both succeed, every stick is resolved, and the loan stays **open for the rest
of the event**. Neither `UPDATE dandiya_loans` matched a row, so neither one
even took a lock. The shared loan row is the only natural serialisation point,
so it is locked explicitly.

With the lock, Desk B blocks until Desk A commits, then re-evaluates the
predicate and proceeds against a world in which stick 1 is *committed*
resolved — so B's close sees none unresolved and closes with the right
outcome.

`closed_at IS NULL` is part of the predicate so an already-closed loan blocks
nobody. That is safe because a loan only closes once every holder is resolved,
after which no holder compare-and-set can match anything.

**A lock wait fails closed.** The resolution transaction is three or four
statements over one loan, so the wait is measured in microseconds; but if a
wait ever did exceed the server's statement timeout, the batch aborts and
nothing is written — the operator sees the generic "could not be recorded"
message and taps again. That is the safe direction, and it is one of the
things the concurrency smoke is there to observe on a real branch.

**The position is load-bearing.** A lock taken after the holder update
protects nothing, and a lock taken in a transaction of its own is released
before the work it was meant to guard. It is the first statement in the *same*
batch, and all four actions — `resolve-holder` returned, `resolve-holder`
lost, `return-pair`, `lost-pair` — go through that one writer. There is no
alternate close path. No application mutex, browser lock, process-local map,
pre-read, sleep-and-retry or advisory lock stands in for it.

### The close is then derived inside the transaction

The outcome is **not** computed from a prior read. Three mutually exclusive
compare-and-sets travel in the same batch, each requiring `closed_at IS NULL`,
that **no** holder is still unresolved, and a specific number of lost ones:

```
no holder unresolved AND 0 lost  ->  outcome 'returned',     pair released
no holder unresolved AND 1 lost  ->  outcome 'partial_loss', pair held
no holder unresolved AND 2 lost  ->  outcome 'lost',         pair held
```

All three count the holders **after** the resolution above them. The lock is
what makes "after" mean after the *other desk* too; the compare-and-sets are
what keep the loan from closing twice, or closing while a stick is still out.

---

### The contact number

The **only** attendee-identifying value this database holds, and deliberately
narrow.

```
dandiya_loans.contact_phone   text, NULL unless BOTH holders are guests
```

| | |
|---|---|
| Stored as | exactly **ten digits** — `9876543210` |
| Never | `+91`, spacing, or a second format |
| Accepted from an operator | `+91 98765 43210`, `919876543210`, `09876543210`, `98765 43210` |
| Belongs to | the **loan**, not to either stick |
| Present when | and only when both holders are badgeless |

The parser is `src/shared/phone.ts`, read by the browser form **and** the
server, so instant feedback and real enforcement cannot drift. It is the same
ten-digit rule registration has always used — `attendee-validation.ts` reads
its length and pattern from that module rather than repeating them.

**It is on the loan because one of two people leaves a number for the pair.**
Copying it onto both holder rows would assert that both gave it; copying it
onto one would make the slots unequal for no reason.

**One open badgeless loan per number**, enforced by

```sql
UNIQUE(event_id, contact_phone) WHERE closed_at IS NULL
```

the badgeless analogue of one unresolved stick per registered attendee, and
the sibling of the mixed loan's anchor index. It is
**partial on `closed_at`**, so the number frees the moment that loan closes —
a guest who brought their sticks back may borrow again the same evening, and a
historical number never permanently blocks anybody. Badge-based loans carry
NULL here, and Postgres treats NULLs as distinct, so they never participate.

**Where it is shown.** On the Active card and in a day's History, including the
Outstanding filter — because that is how the team finds two people who have no
badges, and nobody should have to open a database to read it. It is also
searchable, with or without a country code.

**What it is not.** It is never a registered attendee's number: the Badge
Register reader still does not read that column, and `release:check` fails if
it starts to. No contact number is ever logged.

## Almost no attendee PII

Neither table has a column for a name, age, gender, WhatsApp link or payment,
and none may be added. A loan records a pair code, two badge **numbers** (or
NULL for a guest), two device ids — and, **only for a fully badgeless pair**,
one contact phone number.

**That one number is the whole of the exception**, added in Phase D3.3 because
a pair issued to two people with no badges would otherwise be accountable to
nobody. It is documented in full above. Everything else about an attendee
still lives in Google Sheets.

The screen needs names beside those numbers, so they are **read** from the
Badge Register on every request and joined into the response — through
`server/attendees/register.ts`, the same reader `/api/prizes` and
`/api/attendees` use. There is deliberately no second Sheet parser and no
attendee table in Postgres.

**A Sheet row edited away does not erase a loan.** The pair really did go out,
from that desk, at that time, to those badge numbers — those are the ledger's
own facts, and the attendee detail is nullable beside them.

---

## Authorization

An event route, authorized by the same central device authority as every
other one. No new realm.

| Requirement | Why |
|---|---|
| a device grant for this event | the only event authority since Phase D2 |
| a converged local identity | work must be attributable to the signed-in device |
| the `dandiya` attribute | granted in Admin, per device |
| **a LIVE device session**, on every read and every write | the server decides, and re-reads Postgres each time |

It deliberately does **not** require `registration`, `prizes`, `attendees`, a
central badge range or a `centralBadgeRangeBinding`. A pair of sticks is not a
badge: issuing one consumes no badge number and advances no counter.

### Dandiya does not imply Attendees

```
registration only   /badge-registration ✅   others ❌
prizes only         /prizes ✅               others ❌
attendees only      /attendees ✅            others ❌
dandiya only        /dandiya ✅              others ❌
```

The dandiya workflow **reads** the safe attendee register, because
identifying the two badge holders is part of issuing the pair. That is not the
same as being granted the standalone directory, and granting one must never
grant the other.

A device holding only `dandiya` is a complete dandiya desk.

---

## Online only

```
Dandiya requires an internet connection.
```

While the browser reports offline there is **no board, no form and no Return
button** — nothing stale is shown and nothing can appear to succeed locally.
There is no IndexedDB dandiya state, no offline queue, no optimistic issue, no
optimistic return, no service-worker persistence, no polling and no
heartbeat.

The reason is one sentence: **two disconnected desks must never be able to
issue the same physical pair, or the same attendee.** Registration can be
offline-first because each desk owns a disjoint range of physical badges;
dandiya pairs have no such partition.

The only timer in the module aborts a request that never answers. It is not a
retry — a retried issue could put one pair out twice.

---

## The API

One Function, dispatched by method.

### `GET /api/dandiya`

```json
{
  "attendees": [{ "badgeNumber": 42, "name": "Meera Patel", "age": 11, "gender": "female" }],
  "active": [
    {
      "id": "…",
      "pairCode": "D-014",
      "issuedAt": "2026-10-11T14:02:00.000Z",
      "issuedBy": { "id": "…", "name": "Anuradha" },
      "holders": [
        { "badgeNumber": 42, "slot": 1, "resolution": "returned", "resolvedAt": "2026-10-11T14:44:00.000Z", "resolvedBy": { "id": "…", "name": "Anuradha" }, "attendee": { "badgeNumber": 42, "name": "Meera Patel", "age": 11, "gender": "female" } },
        { "badgeNumber": 81, "slot": 2, "resolution": null, "resolvedAt": null, "resolvedBy": null, "attendee": { "badgeNumber": 81, "name": "Arjun Shah", "age": 15, "gender": "male" } }
      ]
    }
  ],
  "issues": [{ "…": "…", "outcome": "partial_loss", "pairReleasedAt": null }],
  "history": [{ "…": "…", "closedAt": "…", "closedBy": { "…": "…" }, "outcome": "returned", "pairReleasedAt": "…" }],
  "today": {
    "issued": 12, "fullyReturned": 10, "partialLosses": 1, "lostPairs": 0,
    "activeLoans": 1, "sticksOut": 1
  }
}
```

**`active` is OLDEST FIRST**, chosen deliberately: the desk's question is
"what is still outstanding", so the pair that has been out longest sits at the
top — including anything left over from yesterday, which would otherwise
scroll away under the evening's traffic.

**`historyDate=YYYY-MM-DD`** selects the day. Omitted, it means **today** —
in event time, decided by the server. The server turns that day key into
`[start, next start)` **instants** through `src/shared/event-time.ts` and
compares `issued_at` against them; `DATE(issued_at)` is never used, because it
would be evaluated in the database session's timezone and would group the
ninety minutes either side of IST midnight into the wrong day. An impossible
day is a `400` `invalid-history-date`, never a silent fall back to today.

**The read is scoped to what the desk needs**, as five disjunctions:

| Clause | Serves |
|---|---|
| `closed_at IS NULL` | `active`, and the previous-day carryover |
| `pair_released_at IS NULL` | `issues` |
| `issued_at` in the selected day | `history` |
| `issued_at` in today | `today.issued` |
| `closed_at` in today | `today.fullyReturned` and the two losses |

Today is always read, even while an earlier day is on screen, because the
counters above the tabs are about tonight either way. The first two clauses
are bounded by the event's physical stock of pairs rather than by its length,
so a week-long event never ships every loan it ever made to render one night.

**`active` holds a partially resolved loan** for as long as either stick is
out. One attendee finishing does not remove the other's obligation from the
board a volunteer reads to chase outstanding sticks. It carries **every** open
loan with no day scoping, which is what makes the carryover answerable.

**`issues` is the quarantine list**: loans that closed with a loss and never
released their pair, newest first. Those rows are in `history` too — nothing
is moved out of the record to build this list. It exists separately because
"which pairs are missing a stick" is a question somebody asks standing at the
table, not one they scroll a history for.

**`history` is NEWEST ISSUED FIRST** and holds one day's loans in **every**
state. Ordered by issue time rather than close time deliberately: a day's
list must not reshuffle itself as pairs come back. Repeated pair codes are
expected, and each loan is its own record with its own `id`.

**`historyDay`** is the day the server answered for and **`eventDay`** is the
event's own today. Both travel in the response because the server decides
them: a browser labelling one night's rows with another night's heading would
be an error nobody could see.

**`today`** counts in the event timezone, and the six counters answer two
different questions on purpose:

| Counter | Counted from |
|---|---|
| `issued` | the **issue** day |
| `fullyReturned`, `partialLosses`, `lostPairs` | the **close** day, by outcome |
| `activeLoans`, `sticksOut` | **no date at all** |

`activeLoans` and `sticksOut` are obligations rather than traffic:
yesterday's unreturned pair is still a stick somebody is holding, and a
counter that forgot it at midnight would be the one number a volunteer cannot
afford to trust. `sticksOut` counts unresolved **holder rows**, so a
partially resolved loan contributes one, not two.

**`attendees`** is the roster the issue form searches. It travels with the
board rather than from `/api/attendees` for a decisive reason: a dandiya-only
device does not hold the `attendees` attribute and must not need it. It also
keeps the desk to one request, so the names a volunteer picks from and the
loans they are checked against are one snapshot.

The read composes three flat Postgres queries — loans, holders, device names —
rather than one join, because a loan has two holders and may name two
devices, and the result would have to be regrouped in code anyway.

### `POST /api/dandiya`

```json
{ "pairCode": "D-014", "badgeNumbers": [42, 81] }
```

Nothing else is accepted. `eventId`, `eventSlug`, `deviceId`, `loginName`,
`issuedAt`, `closedAt`, `closedBy`, `outcome`, `pairReleasedAt`,
`resolvedAt`, `resolvedBy`, `attendees`, `name`, `age` and `gender` are
**refused outright** rather than ignored.

Preconditions, in order:

1. a live device session with the current `dandiya` attribute
2. a well-formed body — a valid bounded pair code, exactly two different
   positive badge numbers
3. readable Sheet credentials, behind the existing release interlock
4. **both badges exist in this event's Badge Register**
5. the insert — one loan and two holders, one transaction

| Outcome | Status |
|---|---|
| issued | `201` with the complete active loan |
| a badge is not registered | `404` `blocked: "badge-not-registered"`, with the badge numbers |
| the pair is already out | `409` `conflict: "pair-in-use"` |
| the pair is quarantined by a loss | `409` `conflict: "pair-unavailable"` |
| an attendee is already holding one | `409` `conflict: "attendee-already-holding-pair"` |
| register unreadable, or writes not configured | `503` `reason: "register-unavailable"` |

**A Sheet that cannot be read writes nothing.** The register is the only thing
that can confirm the badges exist, so the read happens before the insert and a
failure fails closed.

A constraint name, a SQLSTATE and another device's identity never appear in a
response.

**The two pair refusals are distinguished after the database has refused**,
never before it: the blocking row is re-read and classified as `pair-in-use`
if its loan is still open and `pair-unavailable` if it is a quarantine. The
precheck is for the **message**; the index is the safety.

### `PATCH /api/dandiya`

Four actions, in three shapes:

```json
{ "loanId": "…", "action": "resolve-holder", "badgeNumber": 42, "resolution": "returned" }
{ "loanId": "…", "action": "resolve-holder", "badgeNumber": 42, "resolution": "lost" }
{ "loanId": "…", "action": "return-pair" }
{ "loanId": "…", "action": "lost-pair" }
```

`resolve-holder` ends one stick. The two shortcuts resolve **every stick
still out** in one request and never touch one already resolved.

A shortcut carrying a `badgeNumber` or a `resolution` is **refused**, not
ignored: `{ "action": "return-pair", "resolution": "lost" }` must not read as
either. No timestamp and no device either — the server derives both.

Returns `{ ok: true, loanId, resolvedAt, resolvedHolders }`, and the client
re-reads: the counters, Active, Issues and History all move together, and
whether this resolution **closed** the loan was decided by the database
rather than by the request.

| Outcome | Status |
|---|---|
| resolved | `200` |
| no such loan on this event | `404` `blocked: "loan-not-found"` |
| that badge is not one of its holders | `404` `blocked: "holder-not-found"` |
| that stick was already resolved | `409` `conflict: "holder-already-resolved"` |
| every stick was already resolved | `409` `conflict: "loan-already-closed"` |

**A resolution needs no Sheet.** Nobody's name has to be confirmed to take a
stick back or to record one missing, so resolving keeps working when the
register does not.

---

## The screen

Four tabs, with the operational numbers above them:

```
Sticks out   Active   Issued today   Returned today   Partial losses   Pairs lost
     1          1          12              10                1              0

[ Issue Pair ]  [ Active (1) ]  [ Issues (1) ]  [ History ]
```

### Issue Pair

Pair number, attendee one, attendee two, Issue — in that order, because that
is the order the desk has them: the sticks are in the volunteer's hand before
the two people are identified.

Each attendee is **searched** by badge number or name and then **confirmed**,
which replaces the field with an identity card:

```
#0042
Meera Patel
Registered
[ Change ]
```

The attendee already chosen in the other slot is removed from the results and
named if it is searched for, so picking the same badge twice is prevented
rather than refused afterwards.

A pair that is already out, a pair quarantined by a loss, or an attendee who
is already holding one blocks Issue and says why:

```
Already holding D-007
Issued 7:18 PM
```

```
D-031 is unavailable.
Its previous loan ended with a partial loss.
```

A **previous loss** by the chosen attendee is different: it is shown and it
blocks nothing.

```
Previous Dandiya loss
D-007 · 8:42 PM
```

Editing either pair-code boundary of that judgement is not a thing here —
there is one code — but the same principle holds: the warning describes the
pair currently typed, and clearing the field clears it.

Those warnings come from the loaded board. They are **messages** — the
authority is the two partial unique indexes, and the endpoint consults no
precheck. When another desk wins the race anyway, the screen is told, says so,
and re-reads.

After a successful issue:

```
Pair D-014 issued to #0042 + #0081
```

All three inputs clear and focus returns to the pair field, so the next pair
is one keystroke away.

Pair codes are **case-insensitive**: the field uppercases on blur as a
courtesy, and the server canonicalises on the request. See below.

### Active

Searchable by pair code, either badge number or either attendee name.

```
PAIR D-014                                        OUT

#0042  Meera Patel   Stick 1 · Out   [ Return Stick ] [ Mark Lost ]
#0081  Arjun Shah    Stick 2 · Out   [ Return Stick ] [ Mark Lost ]

Issued 7:32 PM by Anuradha

[ Return Whole Pair ]                      [ Report Pair Lost ]
```

**Every stick still out has its own two controls**, which is the whole of
Phase D3.1 on screen. A stick already resolved shows its ending and its time
and offers nothing: a resolution is final, and a control to change it would
be a control to rewrite the ledger.

```
PAIR D-021                                 INCOMPLETE

#0042  Meera Patel   Returned · 8:14 PM
#0081  Arjun Shah    Stick 2 · Out   [ Return Stick ] [ Mark Lost ]

[ Return Remaining Stick ]                 [ Report Pair Lost ]
```

A partially resolved loan reads **INCOMPLETE** rather than OUT, because
somebody scanning the board needs to know a stick is missing from this pair
and not merely that the pair is out. A leftover from an earlier event day is
amber and says **OUTSTANDING**, with the issue time; it is still resolvable,
and nothing about it has changed except the label.

Every action confirms first, naming the pair and the sticks it will affect —
and naming what it will **not** touch:

```
Report pair D-021 lost?

#0042 already returned — that stays.
```

```
Return pair D-021?

#0042 already recorded as lost — that stays, and this pair
will stay unavailable.
```

### Issues

The pairs that must not be handed out: every loan that closed with a loss and
never released its pair, searchable, with each holder's own ending.

**Read-only, by design.** There is no Restore, Release or Reissue control,
because freeing a quarantined pair means somebody physically repaired or
replaced it.

### History

**One event day at a time**, and the day is navigable:

```
Event day   [ < ]  [ 2026-10-12 ]  [ > ]  [ Today ]
            Mon, 12 Oct 2026

Issued  Outstanding  Returned  Partial loss  Pair lost
  14         2          11           1            0

2 sticks from this day are still unaccounted for.

[ All ]  [ Outstanding ]  [ Returned ]  [ Losses ]
```

Every pair **issued** that day, in whatever state it is now in — including
the ones that never came back, which is the reason somebody opens this screen
at the end of an evening. One row per loan, so repeated pair codes are
expected and never grouped. Searchable within the day by pair code, badge
number or attendee name.

Each row carries the pair code, the issue time, the issuing device, both
attendees with their badge numbers, **each stick's own resolution and when**,
the loan's state, and the close time when there is one — which may be on a
**later day** than the one being viewed. Read-only: no undo, no edit, no
delete.

**Outstanding is the prominent state**: its own filter, its own count in the
summary, and a bordered row. It is the only state anybody has to act on.

The four filters are **All**, **Outstanding**, **Returned** and **Losses**
(partial loss and pair lost together). The day's summary is counted from the
day's own rows rather than sent beside them — one list, one set of numbers,
nothing that can disagree.

**A day cannot be navigated past the event's today**, and an impossible date
is refused rather than quietly answered for another day.

#### Its states

| | |
|---|---|
| Loading | `Loading this day…`, while a day change is in flight |
| Empty day | `No pairs were issued on this day.` |
| Empty filter | `No outstanding pairs from this day.` |
| Empty search | `No loans match this search.` |
| Error | the board's own error, with `Try again` |

**An empty day is not an error.** A quiet afternoon and a failed request must
never read the same way.

---

## Pair codes are canonical

A pair code identifies one physical object, so it is **canonicalised**: outer
whitespace trimmed, then **uppercased**.

```
" d-014 "  ->  "D-014"
"D-014"    ->  "D-014"
"d-014"    ->  "D-014"
"test-01"  ->  "TEST-01"
```

Nothing else is rewritten — separators and internal characters are left
exactly as typed, because those really do distinguish labels.

**This is a safety rule, not tidiness.** The only protection against one pair
going out twice is

```sql
UNIQUE(event_id, pair_code) WHERE pair_released_at IS NULL
```

and an index compares **bytes**. If `D-014` and `d-014` were stored as
written, two volunteers typing the same physical label with different shift
keys would each get an open loan on the same sticks: the index would see two
pairs and the floor would have one. Canonicalising before the insert is what
makes the index mean what it says.

Three things hold it together, and `release:check` fails if any disappears:

| | |
|---|---|
| `parsePairCode` in `src/shared/dandiya-contract.ts` | trims, then uppercases |
| `dandiya_loans_pair_code_canonical` | `pair_code = upper(btrim(pair_code))` |
| `0005_dandiya_checkout.sql` | carries that CHECK |

**The server is the authority.** The issue field uppercases on blur so a
volunteer can see what the ledger will record, but that is comfort only: the
canonical value comes back from the request, and it is what Active, History
and search all use. Search is case-insensitive in both directions, so typing
the label in any case finds the pair.

---

## Development test desk

In **Development** Admin, create a disposable device:

| Field | Value |
|---|---|
| Name | `Dandiya Test Desk` |
| Login | `dandiya-test` |
| Enabled | yes |
| Access | `dandiya` only |
| Badge range | none |

Provision a disposable password. Do **not** give it the other three — a
`dandiya`-only device is the case most worth proving, because it has no badge
range, no binding and no directory access.

The existing prize fixtures (`scripts/seed-prizes-development.mjs`, badges
`#9001`-`#9030`) supply the attendees. See `docs/PRIZES.md`.

---

## Verification

```bash
pnpm verify:d3
```

Exercises the real endpoint, the real ledger writer, the real board composer,
the real Badge Register reader, the real route policy, the real filters, the
real browser client and the real cards and forms against a stand-in Postgres
and a stand-in Sheets API. It never opens a socket.

The stand-in Postgres enforces both partial unique indexes the way the real
ones do — at insert time, after whatever the application checked — and its
`batch` is one transaction, which is what makes the rollback and race tests
mean anything. A concurrent writer is driven explicitly in two shapes: one
that resolves the **same** stick between the read and the write, and one that
resolves the **other** stick.

**What it cannot test is PostgreSQL's visibility rules.** It is single-threaded
and its batch applies statements against live state, so a scripted concurrent
writer has already committed before the first statement runs — which is
exactly the world the real row lock produces. The fake therefore shows the
correct post-lock behaviour *whether or not the lock is there*. `verify:d3`
and `release:check` pin the lock's presence, its position and its single
writer; the effect is proved separately.

### The real concurrency proof

```bash
export DATABASE_URL=<development branch>
export ALLOW_DANDIYA_DB_SMOKE_WRITES=true
env VERCEL_ENV=development pnpm db:smoke:dandiya --confirm
```

`scripts/dandiya-concurrency-smoke.mjs` calls the **real writer** twice at
once — each `db.batch` is one HTTP request and therefore one Postgres
transaction on its own connection — and then reads the committed state back.
Four cases, each repeated (five rounds by default, because a missing lock
loses a *narrow* race and one attempt could pass by luck):

| Case | Concurrent resolutions | Expected |
|---|---|---|
| A | returned + returned | `returned`, closed, pair released |
| B | returned + lost | `partial_loss`, closed, pair **not** released |
| C | lost + lost | `lost`, closed, pair **not** released |
| D | the same stick twice | exactly one accepted, resolution immutable, loan still open |

Every case also asserts the invariant the missing lock broke: a loan with
every stick resolved **must** be closed.

**It writes, so four things must agree**, all checked before a connection is
opened: `--confirm`, `ALLOW_DANDIYA_DB_SMOKE_WRITES` exactly `true`,
`VERCEL_ENV` exactly `development`, and a `SYNC_ALLOWED_VERCEL_ENV` that does
not name another environment. It creates only `SMOKE-D31-` pair codes with
badge fixtures from `#9901` — clear of the prize fixtures at `#9001-#9030` —
reads one existing event and device to satisfy the foreign keys, and never
creates, modifies or deletes an event, device, attribute, badge assignment,
prize award or registration. Cleanup removes only its own rows;
`--cleanup --confirm` removes leftovers without running the cases. It is never
wired into `verify`, `build`, `lint` or `release:check`, and must never be
pointed at Production.
