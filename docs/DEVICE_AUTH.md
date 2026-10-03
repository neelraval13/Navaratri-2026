# Device authentication

How a central device proves its identity to this deployment.

> ## The realm exists and has a UI. It does not yet run the event application.
>
> `/`, `/badge-registration` and `/device-registration` still sit behind
> **Operator Access**, exactly as before. Holding a device session unlocks none
> of them, and signing out of a device locks none of them. Connecting the two
> is **Phase 9C-C2 / 9C-C3**.

---

## One endpoint, three methods

```
POST   /api/device-auth   sign in
GET    /api/device-auth   the current session
DELETE /api/device-auth   sign out
```

There is no `?action=` and no `"action"` field in a body: the HTTP method is
the dispatcher. `/api/device-login`, `/api/device-session` and
`/api/device-logout` no longer exist — every file under `api/` becomes a
separate deployment Function and the Hobby plan allows twelve, so one
credential's lifecycle now spends one rather than three.

The behaviour of each is unchanged. Only the path and, for sign-out, the
method have moved.

## Three independent realms

| Realm | Cookie | Unlocks |
|---|---|---|
| Operator | `__Host-navaratri_operator_session` | the event desk and `POST /api/sync-registration` |
| Admin | `__Host-navaratri_admin_session` | `/admin` and the central registry APIs |
| **Device** | `__Host-navaratri_device_session` | the device auth APIs |

**None of them satisfies another.** A device session authorizes no Admin API
and no operator API. An operator or Admin cookie authenticates no device.

Separation is **cryptographic**, not a configuration rule. Each realm signs a
different message:

```
operator:  HMAC(secret, encodedPayload)
admin:     HMAC(secret, "navaratri-admin-session-v1:"  + encodedPayload)
device:    HMAC(secret, "navaratri-device-session-v1:" + encodedPayload)
```

So even if all three secrets were accidentally identical, every cross-realm
token is rejected. A `t` claim is a second, independent barrier. The operator
and Admin implementations were not touched, so sessions live in production
stayed valid.

Distinct secrets remain recommended — rotating one realm should not disturb
another — but isolation does not depend on it.

---

## Signing in

```http
POST /api/device-auth
Content-Type: application/json

{ "eventSlug": "navaratri-2026", "loginName": "desk-a", "password": "…" }
```

Login names are unique **per event**, so authentication resolves the event
first and then the device *within* it. `desk-a` in one event can never
authenticate as `desk-a` in another. A bare `WHERE login_name = ?` is never
issued.

There is no `eventId` field: a human types a slug, not a UUID.

The password travels as plaintext over HTTPS and is hashed by the server.
Hashing in the browser would only turn the digest into a reusable password
equivalent. It is never trimmed, case-folded or Unicode normalised.

### Order of checks

1. same-origin
2. content type, JSON, 4 KiB body limit
3. `EVENT_DEVICE_SESSION_SECRET` present and long enough
4. `DATABASE_URL` configured
5. request shape
6. resolve event by slug, then device by `(eventId, loginName)`
7. derive a key and compare — **always**
8. verify the password
9. only then: device `enabled`, event `active`
10. `last_seen_at = now()`
11. sign a token carrying the current `session_version`
12. set the cookie
13. return the safe context

### One answer for every credential failure

An unknown event, an unknown login name, an unprovisioned device
(`password_hash IS NULL`), a password outside the 8–128 policy and a wrong
password are **indistinguishable**:

```http
401
{ "ok": false, "authenticated": false, "message": "Device login failed." }
```

No "unknown device", no "password incorrect", no "credentials not configured".
Admin already knows credential status; an anonymous caller must not learn it.

They are also indistinguishable in **time**. Without care, an unknown login
would return before any key derivation while a wrong password paid for a full
scrypt — a difference an attacker can measure to enumerate login names. Every
path therefore verifies against a hash: the real one when the device exists,
and otherwise a **fixed timing-equalizer record** built with the same bounded
parameters.

That record is a hash of a throwaway constant. It is not a credential and
grants nothing — no device row references it, and verifying a real submitted
password against it can only ever return false. It is *fixed* rather than
generated per request because generating one would cost a second derivation
and make the unknown path *slower*, swapping one signal for another.

Measured across all five failure paths: within a few milliseconds of each
other.

### Typed refusals, only after the password is proven

```http
403  { "ok": false, "blocked": "device-disabled", "message": "This device is disabled." }
403  { "ok": false, "blocked": "event-inactive",  "message": "This event is not active." }
```

These name a reason because the caller has already **proven it knows the
device password**, so nothing is enumerated — and an operator standing at a
disabled desk needs to know why. A disabled device with a *wrong* password
still gets the generic 401.

`starts_at` / `ends_at` are not enforced. `events.active` is the explicit
operational switch.

---

## The session

`__Host-navaratri_device_session` — `Secure`, `HttpOnly`, `SameSite=Strict`,
`Path=/`, no `Domain`, **14 days**. Event desks may operate across several
days, which is why it matches the operator TTL rather than Admin's 12 hours.

The `__Host-` prefix is browser-enforced: the cookie is refused unless it is
Secure, has `Path=/`, and carries no `Domain`.

### What the token carries

```json
{ "v": 1, "t": "device", "deviceId": "…", "eventId": "…", "sv": 3, "iat": …, "exp": … }
```

Identifiers and a version. **Not** the password, the hash, the login name, the
device name, the attributes, the badge range, `enabled` or `lastSeenAt`.

Every one of those can change centrally, and a stale claim would keep
authorizing after an Admin had already changed it.

### Permissions are fetched live, never claimed

```
A device logs in with        registration + prizes
Admin removes prizes
Next GET /api/device-auth   registration
```

No new cookie, no password reset, no logout. The same applies to `enabled`,
`events.active` and the active badge assignment — a range assigned *after*
login appears on the next check.

This is why attributes are not in the token: permissions must be centrally
revocable without reissuing a credential.

---

## `GET /api/device-auth`

Answers: *does this browser hold a valid device session, and what is that
device now?*

A valid signature is **not** authorization. It proves only that this server
issued the token. Every call re-reads Postgres and requires all of:

- the device still exists
- it still belongs to the event the token names
- `session_version` still matches `sv`
- it is still enabled
- its credentials are still provisioned
- its event is still active

Any failure returns the same body, revealing nothing:

```http
200  { "authenticated": false, "configured": true }
```

Not 401 — this is session *introspection*, and a missing cookie is a normal
answer rather than an error. A supplied-but-unusable cookie is cleared.

Missing configuration returns `503 { "authenticated": false, "configured": false }`.

It **never** updates `last_seen_at`: a UI checking its own session is not
evidence of device activity.

---

## Revocation: `session_version`

There is **no session store**, and none should be added.

`devices.session_version` starts at 1 and is incremented by every deliberate
Admin password set or reset. The token carries the value it was issued under,
and every authenticated request compares the two.

```
cookie issued with sv = 3
Admin resets the password  →  session_version = 4
next session check         →  authenticated: false
```

Immediately, with no logout and no server-side bookkeeping. Rotating
`EVENT_DEVICE_SESSION_SECRET` is the blunt instrument that revokes *every*
device session at once.

---

## `DELETE /api/device-auth`

Same-origin, expires `__Host-navaratri_device_session`, returns success.

It touches no other cookie, writes no row, opens no IndexedDB and leaves the
local trusted-device marker alone. It consults no database configuration,
because clearing a cookie needs none — logout must work when the central
database is unreachable.

---

## `last_seen_at`

Phase 9C-B is the first time a central device *proves* its identity, so a
successful login is the first trustworthy sighting. Only a successful login
writes it; a failed attempt says nothing about where the real device is.

There is **no heartbeat**, and Admin still shows the factual "Last seen"
label. It must never be presented as Online / Offline.

---

## The safe context

An explicit DTO, never a spread Drizzle row — `passwordHash` and
`sessionVersion` sit one field away on the same object:

```json
{
  "device": { "id", "eventId", "name", "loginName", "attributes", "lastSeenAt" },
  "event":  { "id", "slug", "name", "timezone" },
  "activeBadgeRange": { "rangeStart", "rangeEnd", "assignedAt" } | null
}
```

No response in this realm ever contains a password, a hash, a salt, a derived
key or a session version.

---

## Configuration

`EVENT_DEVICE_SESSION_SECRET` — server-only, minimum 32 characters, taken
exactly. Never `VITE_` prefixed, never logged, never returned.

Device authentication also needs `DATABASE_URL`.

Nothing at startup depends on either. A deployment without them runs exactly
as before; device authentication simply reports itself unavailable when it is
invoked.

Rate limiting for `POST /api/device-auth` is a Vercel firewall rule — see
`docs/VERCEL_FIREWALL.md`. Several devices may share the venue's NAT address,
so the limit must not be tuned like a single-user login.

---

---

## `/device-login` — the browser UI (Phase 9C-C1)

A real page, deliberately **outside Operator Access**. In the final
architecture it replaces the shared operator code as the per-device entry
point, so it is built where it will live rather than moved later.

It is additive. Nothing in the event application links its behaviour to this
page: a browser with no device session still reaches Operator Access for every
event route, and a browser with a valid device session still has to satisfy
Operator Access for them.

### What it asks for

A **login name** and a **password**. Nothing else.

The event slug comes from `src/shared/event.ts` — one constant, read by the
device login client and by the Admin event form. An operator typing
`navaratri-2026` by hand would eventually mistype it, and a wrong slug is
indistinguishable from a wrong password. There is no Event ID or Device UUID
field either: nobody should type a UUID at a desk.

The login name is trimmed, matching how it is stored. The password is not.

### Runtime validation

The response is validated at runtime, not merely typed. Identifiers must be
UUIDs, names must be non-empty, the device must belong to the event it was
returned with, and a badge range must be a coherent positive interval.

**Attributes fail closed.** An unrecognised string — anything outside
`registration` and `prizes` — rejects the entire response rather than becoming
a locally recorded capability.

The context is projected field by field, never spread, so a field the server
adds later cannot arrive in local state by accident.

---

## `centralDeviceEnrollment` — what the browser remembers

One optional field on the **existing** `config` row. No new object store, no
new index, no Dexie version bump; the database stays at version 1 with
`registrations`, `config` and `outbox`.

```
deviceId · eventId · eventSlug · deviceName · loginName · attributes · verifiedAt
```

It answers exactly one question: *which central device did this browser last
prove it is, and when?*

> ### It is not permission to operate.
>
> The HttpOnly cookie is the credential and `GET /api/device-auth` is the
> only way to check it. A cached enrollment never produces an authenticated
> state, never authorizes an event route, and is never described as
> authoritative offline. Those rules are **Phase 9C-C3**.

### Deliberately absent

The password, its hash and salt, the session token, the cookie,
`sessionVersion` — none of which ever reaches the browser — **and
`activeBadgeRange`**.

The central range may be *displayed*, read-only, alongside the words
*"Central assignment only. Local badge range has not been changed."* It is not
written anywhere. Importing it would silently change which physical badges this
desk believes it owns, and that transition is **Phase 9C-C2**. There is no
"Use this range" action, and `configureBadgeDistribution` is never called from
this page.

### The local Phase 7 identity is untouched

`deviceId`, `deviceName`, `deviceConfiguredAt`, `badgeStart`, `badgeEnd`,
`nextBadge` and `badgeConfiguredAt` belong to this browser's own offline badge
workflow and to Sheets provenance. The central values are stored *beside*
them, never over them — the central device id does not replace the local one,
and the central display name does not replace the local one. Converging the
two is a later, deliberate migration.

---

## One browser, one central device

Re-verifying the **same** device refreshes its name, login name, attributes
and `verifiedAt` — exactly the facts that change centrally.

Authenticating as a **different** device is refused:

> This browser is enrolled as *Registration Desk A*. It cannot silently switch
> to *Registration Desk B*.

The new device is not persisted, and its session is ended immediately with
`DELETE /api/device-auth` so the browser is not left holding a cookie it
declined to enroll. Badge ownership will eventually depend on this binding, so
rebinding is an explicit operator decision: **Clear Central Enrollment**.

That action removes the enrollment snapshot and nothing else. It is not Reset
Device, not Clear Event Data, not Clear Badge Range and not an operator logout
— the local device identity, the badge range, `nextBadge`, every registration,
every outbox row and the trusted-operator marker all survive it.

---

## Signing out, and being offline

**Sign Out Device** calls the server first. Only a confirmed logout clears the
local enrollment; if the request fails the enrollment is kept and the page says
the device session is still active, because claiming otherwise would be a lie
the operator acts on.

When the server cannot be reached, the page shows the cached identity as
*"Last verified device: …"* with *"Internet is required to verify or change the
central device in this phase."* It never says **Authenticated**, and it unlocks
nothing.

### No heartbeat

The session is checked on page mount, after a successful login, and when the
operator presses **Refresh Device Status**. There is no `setInterval`, no
background timer and no polling. Reconnect reconciliation is Phase 9C-C3.

---

---

## Adopting a central badge range (Phase 9C-C2A)

The central assignment says which physical badge numbers a device **owns**. It
is not the allocator: `nextBadge` stays in IndexedDB, because issuing a badge
must work with no network. Adoption copies the range **once**, deliberately,
and the existing local model then does all the work exactly as before.

> ### Ownership is not presence.
>
> A row in Postgres proves this device owns `#001–#200`. It cannot prove the
> badges are on the table. So nothing is automatic: signing in does not adopt,
> `GET /api/device-auth` does not adopt, and **Refresh Device Status** does not
> adopt. An operator must confirm *"I have physical badges #001–#200 at this
> device"*, and the action stays unavailable until they do.

### What `/device-login` shows

A **Local Badge Setup** section, separate from the central summary, so nobody
has to infer whether this browser can issue badges from the fact that Postgres
says it owns some:

| State | Meaning |
|---|---|
| Local device setup required | transitional: this browser has no Phase 7 identity yet |
| Not available | the central device lacks the `registration` attribute |
| Not assigned | no central assignment exists — creating one is 9C-C2B |
| Ready to adopt | fresh, compatible: the range may be adopted |
| Ranges match | the local range already equals central — link it, keep the counter |
| Aligned | adopted; the binding records where the range came from |
| Conflict | blocked, with both ranges shown and no override |

### Fresh adoption

Writes `badgeStart`, `badgeEnd`, `nextBadge = badgeStart` — the same canonical
invariant `configureBadgeDistribution` uses — and `badgeConfiguredAt`. The local
model's physical-stack confirmation is expressed through that timestamp; no
second confirmation field was invented.

### Exact-match migration

An existing Phase 7 desk whose range already equals the central one is
**aligned, not re-set up**. `nextBadge`, `badgeConfiguredAt` and every issued
registration are preserved — this desk has already handed badges out, and
restarting its counter would reissue them. Only the binding is added.

### `centralBadgeRangeBinding`

One optional field on the existing `config` row — no new store, no index, no
Dexie version bump:

```
deviceId · eventId · rangeStart · rangeEnd · assignedAt · adoptedAt
```

**Provenance, not an allocator.** `nextBadge` is never mirrored here; a second
copy of the counter is a second thing that can drift from the physical stack.
No password, hash, token, cookie or `sessionVersion` either. It is deliberately
*not* inside `centralDeviceEnrollment`, which still excludes `activeBadgeRange`.

It exists so a later reconnect can tell *"this range was adopted from desk-a's
central assignment"* apart from *"this browser has an old hand-typed Phase 7
range"*.

### What fails closed

| Situation | Outcome |
|---|---|
| No local Phase 7 identity | blocked; a local UUID is never generated, and the central one is never copied into it |
| No `registration` attribute | blocked — read from the **current** session, not the cached enrollment |
| No central assignment | blocked |
| Badges issued locally with no configured range | **blocked** — reconstructing a counter from issued numbers could skip a badge already taken out of the stack |
| Local range ≠ central range | **blocked hard**, both shown, no override, no truncate, no merge |
| Local range matches but `nextBadge` is outside it | blocked rather than guessing a replacement |
| Binding belongs to another central device | blocked; a range is never reassigned silently |
| Central now reports a different range | blocked; the local range is left exactly as it is |

Every refusal writes **nothing**. The transaction is one `db.transaction` over
`config`, with `registrations` opened read-only to count issued badges, so the
range and its provenance can never land separately. No registration, held
record or outbox row is ever modified.

### Durability

**Signing the device out does not clear the adopted badge range**, and neither
does **Clear Central Enrollment** — both are auth actions, while an adopted
range is durable operational state that must survive a sign-out or a network
loss. Clearing the identity while a binding exists shows a warning saying so.
Nothing cascades. Authorization and revocation behaviour is Phase 9C-C3.

### Still transitional

C2A does **not** make device auth authoritative. `/`, `/badge-registration` and
`/device-registration` still answer to Operator Access, the binding is never
used as authorization, and no device gate exists.

That has an honest consequence worth stating: **central revocation cannot stop
an operator-gated desk from issuing badges.** Disabling a device centrally
invalidates its device session, but the event routes do not consult it yet, and
an offline desk consults nothing. Closing that is C3/D.

## Phase 9C-C2B — authenticated online badge-range self-claim

C2A could only adopt an assignment an Admin had already made. C2B lets a device
that owns **no** central range reserve one itself, while online and signed in.

```
POST /api/device-badge-claim      11 / 12 Vercel Functions, headroom 1
```

### The request

```json
{ "rangeStart": 201, "rangeEnd": 300, "physicalStackConfirmed": true }
```

That is the whole body. **`deviceId`, `eventId`, `eventSlug` and `loginName` are
refused outright**, not ignored: the authenticated session decides which device
and event a claim belongs to, and a field a caller believes it can choose is one
a later refactor might start reading.

`physicalStackConfirmed` must be exactly `true`. The server cannot see the
badges — only the operator can — but requiring the flag means a buggy or
bypassed client cannot reserve a range without that deliberate action having
happened. It is a **mutation guard and is never persisted**: no column, no
migration, nothing in the reservation row. The local `badgeConfiguredAt`
continues to express the local setup event.

### Authentication

The endpoint authenticates with `__Host-navaratri_device_session` and nothing
else, through the same primitives `GET /api/device-auth` uses. **A claim fails
wherever that session check would fail**: an unknown or tampered cookie, a
`session_version` behind the row, a disabled device, a deactivated event, an
unprovisioned `password_hash`. An Admin or operator cookie authenticates
nothing here. Every one of those is the same generic 401, and none of them
writes.

`registration` is then required from the **current** Postgres attribute set, not
from the token and not from the cached enrollment — an Admin may have removed it
after the form was rendered. Without it: `403 registration-required`, no central
mutation. `prizes` alone can never claim badge numbers.

### One shared central writer

`server/badge-assignments/reserve.ts` is the ONLY module in the repository that
inserts a `badge_assignments` row. Admin preassignment and Device self-claim both
go through it, so the insert and the interpretation of a constraint violation
exist once.

Their **authorization layers stay separate**: Admin checks that the device it
picked exists, belongs to the event, is enabled and holds `registration`; a
device proves its own session. Admin never imports device session code, and the
claim endpoint never imports Admin auth. The range *model* —
`server/badge-assignments/range.ts` — is shared too, so a device cannot claim a
range Admin could not assign.

### Postgres is the authority

Prechecks exist for a useful message, never for safety. Two writers can each
read "no overlap" and both proceed; what stops them is the database:

| Constraint | Conflict | Response |
|---|---|---|
| `badge_assignments_active_ranges_no_overlap` (GiST **exclusion constraint**) | `range-overlap` | 409 |
| `badge_assignments_one_active_per_device` (partial unique index) | `already-assigned` | 409 |
| `badge_assignments_device_event_fk` | `device-event-mismatch` | 409, fails closed |

`range-overlap` never says which device holds the numbers. An unrecognised
database error is rethrown and becomes a generic 500; no SQL, table name or
connection string reaches the caller or the log.

#### Internal names, public names

The database layer and the wire use different spellings on purpose, and
exactly one place translates between them —
`PUBLIC_BADGE_CLAIM_CONFLICT` in `server/badge-assignments/conflicts.ts`:

| Internal | Public |
|---|---|
| `badge-range-overlap` | `range-overlap` |
| `badge-range-already-assigned` | `already-assigned` |
| `device-event-mismatch` | `device-event-mismatch` |

The map is a total `Record` over the internal conflicts, so adding one without
deciding its public name fails to compile. The public set lives in
`src/shared/badge-claim-contract.ts` and the browser recognises it with that
module's own guard, so neither side can drift onto the other's spelling. A
Postgres constraint name is never a wire value.

#### The error arrives wrapped

Drizzle rethrows every driver error as `DrizzleQueryError`, whose message is
`Failed query: …` and whose `cause` carries the real Postgres error:

```
DrizzleQueryError        message: "Failed query: insert into …"
  └─ cause: NeonDbError  constraint: "badge_assignments_…", code: "23P01"
       └─ sourceError: …
```

`readConstraintName` therefore walks the chain. Reading only the top level
mapped **nothing** in production while passing every test written against a
bare error object — an overlapping badge range reached the operator as *"The
server returned an unexpected response."*, and every Admin conflict
(`login-name-taken`, `event-slug-taken`, both badge conflicts) degraded to a
generic 500 the same way. The verification suite's stand-in database now
throws the wrapped shape, so the gap cannot reopen.

### Retries are idempotent

| Situation | Answer |
|---|---|
| This device already owns the **same** range | `200 already-claimed`, the authoritative row, no second insert |
| This device already owns a **different** range | `409 already-assigned`, **with its own real range**, never replaced |
| A concurrent writer committed between the check and the insert | the one-active-per-device violation is caught, the current assignment is **re-read**, and the two answers above apply |

That last row is also what recovers a response lost in flight: replaying the
request is safe.

### The local preflight comes first

Before any request is sent, the browser proves against its OWN IndexedDB that it
could safely adopt the range if Postgres accepted it. There is exactly **one**
definition of "can this browser own range X?" — the C2A adoption planner — and
the claim planner and the preflight both run it. The safety matrix is not copied
into the UI.

Reserving first and only then discovering a local conflict would leave a desk
owning numbers it cannot issue, and **nothing releases a central range in this
phase.**

### What the operator sees, in the existing Local Badge Setup section

| Local state | Offered |
|---|---|
| No local range, no issued badges | **Badge Range Setup**: start, end, live badge count, mandatory confirmation, `Claim & Set Up #201–#300` |
| A coherent local range (with or without issued badges) | the range **read-only**, its next badge and completed count, `Claim Existing #001–#200 Centrally` |
| Issued badges but no coherent range | blocked |
| An incoherent local range or counter | blocked |
| A binding whose central assignment is gone | blocked: *"Local badge ownership history does not match the current central state."* |
| A binding for a different central device | blocked |

**There is no suggested range and no "next free range" button.** No global
allocator exists, and inventing one would let the software rather than the
physical badge stack decide which numbers a desk hands out. An existing local
range may claim only ITSELF — typing a different one would put the local
allocator immediately at odds with central ownership.

The happy path is ONE deliberate action: confirm the stack → preflight →
reserve → adopt the range the **server** returned, through the same C2A
transaction. C2B has no local badge writer of its own.

### The two distributed failures

There is no transaction across Postgres and IndexedDB, so both are handled
explicitly.

**Central succeeded, local setup did not.** The reservation is real and is
**not rolled back** — undoing it automatically would hand the numbers back while
a human still believes this desk owns them. The page says so, shows both the
central assignment and the local reason, and tells the operator not to issue
badges from this device until it is reconciled. The next session check surfaces
the assignment and C2A's ordinary alignment or conflict UI becomes the recovery
path.

**The response was lost.** A network failure or timeout is reported as *"Claim
status could not be confirmed."*, never as a failure: the reservation may have
committed. Nothing local changes, nothing is retried automatically, and the
operator re-checks central state with **Refresh Device Status**.

### Still true

Central owns the RANGE; **`nextBadge` stays local** and is never reset by a
claim. There is no `next_badge`, `last_issued_badge` or `claimed_count` column,
and issuing a badge updates no central row. No attendee data enters Postgres.
The claim is **online only** — there is no offline path, no polling and no
heartbeat.

## Not in this phase

No device gate on any event route — `/`, `/badge-registration` and
`/device-registration` still answer to Operator Access, and an operator may see
both sign-ins during this transitional period. No offline device authorization.
No use of cached attributes as authority. No release, edit, transfer or extend
of a central range. No heartbeat. No change to Google Sheets, to the outbox, or
to sync authentication, which still uses Operator Access. No schema change —
C2A and C2B both added no migration and use the columns Phase 9C-A provided.


## Phase 9C-C3A — the signed offline authorization lease

A desk must keep working through a venue internet outage. But a boolean in
IndexedDB is not authorization: anyone with the device can edit it. So the
server signs a short-lived statement of what a device was allowed to do, and
the browser verifies that signature **offline**.

**C3A builds and displays the artifact. It unlocks nothing.** `/`,
`/badge-registration` and `/device-registration` still answer to Operator
Access. Phase 9C-C3B is what wires the lease to event routes.

### Asymmetric, because the browser must verify without a server

ECDSA **P-256 / SHA-256**, through `node:crypto` on the server and the Web
Crypto API in the browser. No JWT package, no crypto library.

| | |
|---|---|
| `EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64` | server only, PKCS#8 DER base64 — **signs** |
| `VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64` | browser, SPKI DER base64 — **verifies** |

An HMAC would mean shipping the signing secret in the bundle, and anyone with
the bundle could then mint themselves Registration or Prizes access. The
public key being readable is the *point*: it can check a lease and cannot
create one.

DER base64 rather than PEM so each value is a single line in a Vercel
environment variable. Generate them with the commands in `.env.example`;
never against Production, and never commit the output.

The private key is validated on read — **including the curve**. A P-384 key
would sign happily and produce a 96-byte signature the browser could never
accept, and that failure would surface only at a desk with no internet.

### The token

```
<base64url payload>.<base64url signature>
```

Signed bytes are `navaratri-device-offline-v1:` + the **encoded** payload, so
there is no canonical-JSON problem: the bytes on the wire are the bytes that
were signed. Node signs with `dsaEncoding: 'ieee-p1363'` — the raw r‖s pair
WebCrypto requires. Node's ECDSA default is DER, which `crypto.subtle.verify`
rejects outright.

Claims are minimal:

```
v · t · deviceId · eventId · eventSlug · attributes · activeBadgeRange · iat · exp
```

Never: a password or hash, a session token or cookie, `sessionVersion`, an
Admin or operator credential, any attendee data, **`nextBadge`**, or this
browser's local Phase 7 identity.

`activeBadgeRange` is there because offline Registration will eventually have
to prove more than "this device once had Registration" — it must say which
central assignment was authorized. It is **not** an allocator; `nextBadge`
stays local.

### Lifetime

```
exp = min(now + 24h, event.endsAt)
```

At most **24** hours, and never past the event's `endsAt`. An event that has
already ended produces **no lease at all**. There is no indefinite offline
authority and no local extension — only the server issues one. The browser
tolerates five minutes of clock skew on `iat` — a server clock slightly
ahead genuinely produces one — and treats an expired lease as expired however
intact its bytes are.

**The skew is not applied to `exp`.** Authority ends at the instant the server
signed, not five minutes later: adding grace there would extend real
authorization past the moment it was meant to stop, and a desk whose own clock
lags already has slack. The local expiry timer is armed for that same instant,
so the timer and the verifier cannot disagree.

### It is never a central API credential

This is the threat boundary, stated plainly. The token is readable by
JavaScript, because the browser must verify it with no network. Its power is
**local authorization until `exp`** — not server authentication.

`/api/device-auth`, `/api/device-badge-claim`, the Admin APIs and
`/api/sync-registration` all keep requiring their own cookies. No endpoint
reads the lease, the browser never puts it in a header or a cookie, and
`release:check` and `verify:9cc3a` both enforce that.

### Where it comes from, and when

Issued beside — never instead of — the session cookie, on operations that
already happen: **login**, an explicit **session check**, and a **successful
self-claim** (which changes central badge ownership, so the old lease is
stale the moment it returns). There is no timer, no polling and no heartbeat.

If signing is unconfigured the response says `offlineAuthorization:
{ configured: false }`. Online device authentication is unaffected and no
fake lease is invented.

### Saved only after it verifies

A received token is stored only once its signature holds, its claims parse,
its clock is sane, **and** it describes the same device, event, attributes and
badge range the server returned in that same response. A mismatch is dropped
and reported — and dropping it never makes the online session look
unauthenticated.

Only the token is stored, as `centralDeviceOfflineAuthorization` — one
optional field on the existing config row, separate from
`centralDeviceEnrollment` and `centralBadgeRangeBinding`, with no Dexie
version bump. **No decoded claim is stored beside it**: a second unsigned copy
of "what this device may do" would be trivially editable and
indistinguishable from the signed answer. Every read verifies again.

### Clearing it

| Event | Lease |
|---|---|
| Successful device sign-out | **cleared**, with the enrollment, in one transaction |
| **Failed** sign-out | **kept** — nothing was revoked, and pretending otherwise is a lie the operator acts on |
| Clear Central Enrollment | **cleared** |
| Server definitively rejects the session | **cleared** — expired, `session_version` reset, device disabled, event inactive, credentials removed, device deleted |
| Network unreachable, 503, unexpected | **kept** |

**A network failure is not a revocation.** Treating one as revocation would
disable a desk at exactly the moment its offline authority is what keeps it
running. Badge range, `nextBadge`, `centralBadgeRangeBinding`, registrations
and the outbox survive all of these.

### What the operator sees

`/device-login` gains an informational **Offline Authorization** section, and
Device Readiness reports the lease read-only. Both show only **verified**
claims — access, central badge assignment, expiry — never decoded-but-
unverified ones.

Offline, a valid lease is called *"Offline authorization lease valid"*, never
**Authenticated**: nobody asked the server, and the only thing proven is the
signature.


## Phase 9C-C3B — device-authorized event operations

A centrally enrolled device can now **open event modules on its own
authority**, online or offline, without the shared operator code.

Operator Access remains, as a transitional fallback. **Phase D** is what
removes it and converges the local identity; until then both exist, and a
browser may legitimately be `claim-test-2` centrally and `claim-test-local-2`
locally.

### Two authorities, one grant

| Source | Comes from | Lives until |
|---|---|---|
| `device-online` | the live `GET /api/device-auth` context | the next check |
| `device-offline` | the claims of a **cryptographically verified** C3A lease | the signed `exp` |

They are normalised into one in-memory `DeviceOperationalGrant` before any
rule runs, and the grant is **never persisted**: authorization that survives a
reload without being re-established is authorization nobody checked. The
signed lease persists; the conclusion drawn from it does not.

Online wins whenever the server answers. Yesterday's lease must not outrank
today's truth, so an authenticated response both authorizes and **replaces**
the cached lease.

### Route policy

| Route | Authority |
|---|---|
| `/` | device grant **or** Operator Access |
| `/badge-registration` | device Registration authority **or** Operator Access |
| `/device-registration` | **Operator Access only** |

The last is deliberate: that page rewrites this browser's transitional Phase 7
identity — the very identity the lease's badge checks are measured against. A
device lease must not unlock the thing it is measured by.

### Registration needs more than permission

`attributes includes registration` is not enough. Central badge ownership must
agree with the local allocator *and* its provenance: the event must match, the
enrollment must be consistent, the local Phase 7 identity must exist, and the
binding's device, event, range and **`assignedAt`** must all equal the live
central assignment, which must in turn equal `badgeStart`/`badgeEnd` with a
coherent `nextBadge`.

`nextBadge === badgeEnd + 1` is **coherent** — that is the exhausted state, and
it reaches the existing badge-range-exhausted workflow rather than looking like
an authorization failure.

### Some failures fall back. Some never fall back.

**Fallback allowed** — no grant, wrong event, no enrollment, no local identity,
no Registration attribute, no central range, no valid lease, no public key.
These describe *who is asking*.

**Hard block, and Operator Access is not offered** — any disagreement between
central and local badge ownership, or an enrollment naming a different device
or event. The hard-block screen offers no Continue, no Override and no
operator code, because the operator credential authorizes a *person at a
browser*; it cannot make two desks holding the same physical badge numbers
safe. Those **never fall back**.

Authorization also **never repairs** badge state: no adoption, no `nextBadge`
reset, no binding write. C2A stays the only adoption path, because physical
stack presence still needs a human.

### The provider

One `DeviceEventAuthorizationProvider`, mounted once around the event routes.
It checks on **mount**, on an **offline → online transition**, and on an
explicit **Refresh Device Access**. There is still no polling and no
heartbeat.

It sets exactly **one timer**, armed from the verified signed `exp`. That
timer resolves through a **local-only path** that cannot reach the network —
`resolveFromCachedLease` in `event-authorization-runtime.ts`, which never
touches the session source. It exists so a page left open offline stops
trusting a lease that has run out. If Operator Access happens to be unlocked
the route continues on that authority; otherwise the gate appears.

The two triggers are deliberately **separate**. They once shared one counter,
which meant the expiry timer re-ran the online path and issued a
`GET /api/device-auth` nobody had asked for — pointless on an offline desk,
and a heartbeat by accident on an online one. The decision logic therefore
lives outside React as two plain async functions, so "does this path reach
the network?" is answered by counting calls on a fake rather than by reading
an effect graph.

Overlapping checks are resolved by **sequence, not timing** — a manual refresh
that revokes access cannot be undone by an older in-flight response arriving
late.

| Reconnect outcome | Effect |
|---|---|
| authenticated | fresh context, fresh lease stored, authorization re-evaluated |
| definitively unauthenticated | **cached lease cleared**, device authority gone |
| network error, timeout, 503 | lease **retained** until its signed expiry |

A network failure is not a revocation.

### Sync: Operator or a live device

`/api/sync-registration` now accepts **either** realm, tried in this order:

1. **Operator** — unchanged. A valid operator session proceeds exactly as
   before: no Neon call, no device check, no range enforcement. A legacy desk
   must not start failing because the central database is unreachable.
2. **Device** — a *live* session: `session_version`, `enabled`, event active,
   credentials provisioned, current `registration`, current active range.

Both failures answer with the same generic 401.

For a **device-authorized completed** snapshot the badge must fall inside that
device's **current** central range, or the endpoint returns
`device-badge-range-mismatch` (403), writes nothing and leaves the outbox row
pending. That is the server-side half of the reconnect race: a desk may issue
#501 offline, be disabled centrally while away, and flush the instant it
returns — possibly before its own browser has processed the revocation. **The
ledger refuses it on its own authority**, not on the client having noticed in
time. Held rows carry no badge and are not range-checked.

The signed offline lease is **never** sent and accepted by nothing — not here,
not anywhere. It is local authorization; the server reads Postgres instead.

### Still true

Registration stays offline-first: IndexedDB transaction, local `nextBadge`,
durable outbox. Issuance performs **no** device-auth request — authorization
happens at the route boundary, not on every button.
