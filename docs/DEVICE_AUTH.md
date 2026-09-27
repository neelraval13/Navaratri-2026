# Device authentication

How a central device proves its identity to this deployment.

> ## Phase 9C-B builds the realm. It does not yet run the event application.
>
> `/`, `/badge-registration` and `/device-registration` still sit behind
> **Operator Access**, exactly as before. Holding a device session unlocks none
> of them, nothing in the event application calls these endpoints, and there
> is no device login screen. Connecting the two is **Phase 9C-C**.

---

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
POST /api/device-login
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
Next GET /api/device-session registration
```

No new cookie, no password reset, no logout. The same applies to `enabled`,
`events.active` and the active badge assignment — a range assigned *after*
login appears on the next check.

This is why attributes are not in the token: permissions must be centrally
revocable without reissuing a credential.

---

## `GET /api/device-session`

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

## `POST /api/device-logout`

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

Rate limiting for `POST /api/device-login` is a Vercel firewall rule — see
`docs/VERCEL_FIREWALL.md`. Several devices may share the venue's NAT address,
so the limit must not be tuned like a single-user login.

---

## Not in this phase

No device login page, form or gate. No enrollment. No mapping from an
authenticated central device into IndexedDB. No copying of permissions or a
badge range into local `EventConfig`. No badge-range self-claim. No offline
device authorization. No heartbeat. No schema change — this phase added no
migration and uses the columns Phase 9C-A already provided.
