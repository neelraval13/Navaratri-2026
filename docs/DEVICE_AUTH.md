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

No self-claim: if there is no central assignment there is nothing to adopt, and
`/device-login` offers no range entry. Creating an assignment from the device is
Phase 9C-C2B.

## Not in this phase

No device gate on any event route. No offline device authorization. No use of
cached attributes as authority. No badge-range SELF-CLAIM — adoption of an
existing assignment is described above. No heartbeat. No change to Google Sheets, to the outbox, or to sync
authentication, which still uses Operator Access. No schema change — this phase
added no migration and uses the columns Phase 9C-A already provided.
