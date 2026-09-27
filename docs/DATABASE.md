# Central Database

A Neon PostgreSQL database holding **central operational metadata** for the
event: which devices exist, what they are for, and which badge range each one
owns.

It is being introduced **gradually**. As of Phase 9A nothing in the live
application depends on it — the app loads, authenticates, routes, registers
devices, configures badge distribution, works offline, issues badges and syncs
to Google Sheets with `DATABASE_URL` completely absent.

---

## Three stores, three jobs

| Store | Owns |
|---|---|
| **IndexedDB** (per device) | The offline workflow: drafts, holds, completed registrations, the outbox, and the live `nextBadge` counter. |
| **Google Sheets** | The human-readable attendee ledger. Badge Register and Held Registrations. |
| **PostgreSQL** | Central operational metadata: events, devices, device attributes, badge-range assignments. |

### What belongs in Postgres

- events
- devices (identity, enabled flag, last seen)
- device attributes (what a device is for)
- badge-range assignments (which range belongs to which device)

### What does NOT belong in Postgres

**No attendee data, at all.** No name, phone, age, gender, payment, held
registration or completed registration. That is a deliberate, permanent scope
boundary for this phase, not an oversight. Google Sheets remains the attendee
ledger; IndexedDB remains the operational source of truth during the event.

**No live badge counter.** There is no `next_badge` column. Postgres owns which
*range* a device holds:

```
Desk A   #001–#200      ← central
nextBadge = 87          ← local, in that device's IndexedDB
```

A central counter would make issuing a badge require the network. This
application is built so a disconnected desk keeps working, so the counter stays
local. A future Admin view may *observe* progress centrally; it must never
become a global online allocator.

**No authentication tables yet.** No `password_hash`, no `device_sessions`, no
admin users. `login_name` exists because it belongs to the device registry and
has a clear uniqueness rule, but authentication is unchanged and password
hashing and session revocation are designed deliberately in Phase 9C.

---

## Architecture

- **Neon PostgreSQL**, serverless
- **`@neondatabase/serverless`** — the HTTP driver. Each query is a stateless
  request, which is the right shape for Vercel Functions: no pool to keep warm
  across invocations, no socket to leak when an instance is frozen.
- **Drizzle ORM** for the schema and typed queries
- **Drizzle Kit** for version-controlled SQL migrations

All runtime database code lives under `server/db/`:

```
server/db/environment.ts   reads DATABASE_URL, never logs it
server/db/schema.ts        the four tables
server/db/client.ts        lazy getDatabase()
drizzle/                   version-controlled SQL migrations
drizzle.config.ts          Drizzle Kit configuration
```

**No module under `src/` may import `server/db`**, and `src/` never reads
`DATABASE_URL`. `pnpm release:check` enforces both.

The client is **lazy**. Importing `client.ts` connects to nothing and validates
nothing — a module-load connection would turn a missing `DATABASE_URL` into a
deployment-wide crash instead of a failure confined to the one call that needed
a database. `getDatabase()` throws `DatabaseNotConfiguredError` when invoked
without configuration, and that error names the reason, never the URL.

---

## The tables

```
events
  └── devices                 (event_id, ON DELETE RESTRICT)
        ├── device_attributes (device_id, ON DELETE CASCADE)
        └── badge_assignments (device_id + event_id, ON DELETE RESTRICT)
```

### Guarantees the database enforces itself

Application validation is not enough: two concurrent writers can both pass a
check and both commit.

- **Active badge ranges within one event may not overlap.** A GiST exclusion
  constraint over `int4range(range_start, range_end, '[]')`, scoped to
  `released_at IS NULL`. Desk A `#001–#200` and Desk B `#150–#300` in the same
  event is rejected by Postgres. Requires the `btree_gist` extension.
- **One active assignment per device.** A partial unique index on `device_id`
  where `released_at IS NULL`.
- **A badge range cannot cross events.** A composite foreign key from
  `badge_assignments(device_id, event_id)` to `devices(id, event_id)`.

A released assignment (`released_at` set) stays as history and stops blocking
new ranges.

### Attributes are text, not an enum

`device_attributes.attribute` is plain text. Adding `prizes`, `dandiya` or
`checkin` later must not require altering a database type. The application will
own the allow-list when it needs one. There is deliberately **no `deviceType`**:
one device may serve several modules.

### `updated_at`

Maintained by a **database trigger**, not by convention. One generic
`set_updated_at()` function is attached to `events`, `devices` and
`badge_assignments`, so no writer has to remember the column and no row can
quietly go stale.

---

## Development and Production isolation

**Development and Production must never share a database branch.**

```
Neon project
├── production branch    ← only the production deployment
└── development branch   ← local work, disposable
```

Preview may get its own branch later, or stay unconfigured. Never point local
development at Production because it is convenient: a mistaken migration or a
stray write there is not recoverable from a laptop.

Set `DATABASE_URL` per environment in the Vercel dashboard, and locally in
`.env.local`. It is never committed.

---

## Migration procedure

Migrations are a **deliberate human action**. Nothing migrates automatically:
not the build, not the start command, not a Function invocation, not app
bootstrap, not `release:check`. `release:check` asserts this.

```bash
# 1. Edit server/db/schema.ts, then generate SQL. Needs no database.
pnpm db:generate

# 2. Read the generated SQL in drizzle/ before running it anywhere.

# 3. Apply it, deliberately, to one environment at a time.
DATABASE_URL=<development branch> pnpm db:migrate

# 4. Confirm. Read-only.
DATABASE_URL=<development branch> pnpm db:check
```

Apply to a **development branch first**, always.

`pnpm db:check` verifies the connection, the four tables and the three
guarantees above. It only ever runs SELECTs — it creates nothing, seeds
nothing, migrates nothing, updates nothing and deletes nothing. With
`DATABASE_URL` absent it fails clearly without printing it.

Some statements need raw SQL that Drizzle's DSL cannot express — the exclusion
constraint, the extension and the triggers. Those live in a hand-written,
journaled migration (`0001_range_guards_and_touch.sql`) generated with
`drizzle-kit generate --custom`, version controlled like any other.

---

## Development constraint smoke test

`db:check` proves the constraints **exist**. This proves they actually
**reject** bad writes — an exclusion constraint with the right name but the
wrong predicate would pass the first check and fail this one.

> ### NEVER run this against Production.
> It writes rows. Point it only at a disposable **Development** branch.

```bash
export DATABASE_URL=<development branch>
export ALLOW_DB_SMOKE_WRITES=true
pnpm db:smoke
```

Then immediately:

```bash
unset DATABASE_URL
unset ALLOW_DB_SMOKE_WRITES
```

Two interlocks must both be satisfied before a single write happens. A
connection string alone never implies consent to write:

- `DATABASE_URL` must be set
- `ALLOW_DB_SMOKE_WRITES` must be **exactly** `true` — not `TRUE`, not `True`,
  not `1`, not `yes`, and not padded

Either one missing aborts before the driver is even constructed.

### What it proves

It creates two disposable events and three devices, then checks that
PostgreSQL rejects:

| Attempt | Rejected by |
|---|---|
| Overlapping active ranges in one event (`#001–#200` then `#150–#300`) | `badge_assignments_active_ranges_no_overlap` |
| A second active range for a device already holding one | `badge_assignments_one_active_per_device` |
| A device from Event B claimed under Event A | `badge_assignments_device_event_fk` |

…and accepts an adjacent non-overlapping range, a release, and a
re-assignment after that release. Released rows stay as history.

### Cleanup

Every identifier is generated up front, so cleanup targets **exact ids from
that run only** — including the ids of writes that were supposed to fail, in
case one unexpectedly landed. It deletes in dependency order (assignments →
attributes → devices → events) in a `finally` block, then verifies none of the
run's ids remain.

It never deletes by name pattern, never truncates, and never touches a row
that existed beforehand.

The connection string is never printed. Constraint names and SQLSTATE codes
are, because those are what make a failure diagnosable.

This is manual operational tooling. It is deliberately **not** wired into
`build`, `start`, `release:check` or `pnpm verify`.

---

## Not seeded automatically

The application never creates an event row at bootstrap. There is no
`CREATE TABLE` on startup, no `db.sync()`, and no schema push from a Function.
