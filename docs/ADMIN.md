# Admin Control Plane

`/admin` is the central control plane: the device registry for an event, its
device attributes, and badge-range assignment.

It manages **devices, not attendees**. No attendee name, phone, age, gender or
payment is ever visible here, because none of it exists in the central
database.

---

## A separate security realm

Admin and device access are **two different realms**, deliberately:

| | Device access | Admin Access |
|---|---|---|
| Unlocks | An event desk — registration, holds, badge issuance | `/admin` — the central registry |
| Cookie | `__Host-navaratri_operator_session` | `__Host-navaratri_admin_session` |
| Secret | `EVENT_SESSION_SECRET` | `EVENT_ADMIN_SESSION_SECRET` |
| Code | `EVENT_OPERATOR_ACCESS_CODE` (12+) | `EVENT_ADMIN_ACCESS_CODE` (8+) |
| Lifetime | 14 days — a desk must survive the event | 12 hours — a privileged online tool |
| Works offline | Yes, on a trusted device | No, by design |

**Neither credential satisfies the other, and that is enforced in code.**

Admin signatures cover a domain-separation context prepended to the payload,
so the two realms sign different messages even when handed the same key:

```
operator:  HMAC(secret, encodedPayload)
admin:     HMAC(secret, "navaratri-admin-session-v1:" + encodedPayload)
```

So **even if the two secrets were accidentally identical**:

- an operator token is rejected by the admin verifier
- an admin token is rejected by the operator verifier

The operator token format and verifier are untouched, so every operator
session currently live stays valid. A distinct `t` claim on the admin token is
kept as a second, independent barrier.

> Distinct secrets are still **recommended** — rotating one realm should not
> disturb the other, and a shared secret widens the blast radius of a leak.
> But realm separation no longer depends on it.

Only `/admin` is wrapped in the Admin gate. The event application is never
behind it.

---

## Requirements

Admin needs all three:

- `DATABASE_URL`
- `EVENT_ADMIN_ACCESS_CODE` (minimum 8 characters, compared exactly — not
  trimmed, not case-folded)

  8 is the floor, not a recommendation. A short admin code leans on the edge
  rate limit for `POST /api/admin-auth` (5 attempts per minute per IP) and
  the fixed wrong-code delay; neither replaces entropy, so prefer a passphrase
  well above the minimum.
- `EVENT_ADMIN_SESSION_SECRET` (minimum 32 characters)

With any of them absent, `/admin` fails closed with a clear message and **the
event application is completely unaffected** — it still loads, authenticates,
routes, registers devices, issues badges offline and syncs to Sheets.

Every central-data endpoint verifies the admin session **first**, then
validates the request, and only then touches the database. An unauthenticated
caller cannot even determine whether a database exists.

All Admin responses are `Cache-Control: no-store`.

---

## Events

The central database may contain **zero events**, and nothing seeds one
automatically.

- **Zero events** → Event Setup, where an Admin creates the first one
- **One event** → selected automatically
- **Several events** → an event selector

The Event Setup form suggests `Navaratri 2026` / `navaratri-2026` /
`Asia/Kolkata`, but those are UI defaults an operator can change; the server
validates whatever is submitted (slug shape, real IANA timezone, ordered
dates), and the database constraints remain the final safety net.

---

## Devices

Each device record carries:

| Field | Notes |
|---|---|
| Device name | Required |
| Login name | Optional today. Groundwork for Phase 9C sign-in. Unique within an event. |
| Enabled | Central state |
| Attributes | `registration`, `prizes` — any combination, including none |
| Active badge range | At most one |
| Last seen | Factual; usually *Never seen* |
| Created at | |

### Save Device is one operation

Editing a device sends its fields **and** its exact attribute set in a single
`PATCH /api/admin-devices`. The server authenticates, validates the whole
body, loads the device, applies the active-range rule, and only then commits
the fields and the attribute replacement as **one atomic batch**.

This matters because it used to be two requests. A rename committed, then the
attribute change was refused, and the operator was left with a half-applied
edit they had performed as a single Save. Now a refusal writes nothing at all:
the name and the attributes are both exactly as they were.

The reply carries the **complete updated device**, so Admin updates that one
card rather than reloading the registry.

There is no separate attribute endpoint. A second, independently committed
write path for the same data is how the partial edit happened.

### Attributes

The database stores plain **text** so future values need no type change, but
the **application owns the allow-list**. Arbitrary free text is refused, and
there is no `deviceType` — one device may serve several modules.

| Attribute | Authorizes |
|---|---|
| `registration` | The whole registration desk, badge issuance included |
| `prizes` | Future Prize functionality |

**Registration includes physical badge issuance.** In the current event
workflow a device issues the badge as the last step of registering an
attendee, so it is one job and one permission: attendee entry, hold and
resume, payment, owning a badge-number range, handing over the physical badge
and advancing the local `nextBadge` offline. There is no separate badge
capability, and none should be added while the flow stays combined.

#### Permission and range are still separate

The permission and the numbers remain different things:

| | Says |
|---|---|
| `registration` | this device may run the workflow |
| `badge_assignments` | which physical numbers this device owns |

That distinction is sufficient. A registration device with no assignment
simply has no numbers yet.

#### Attributes and an active range

A device with an **active badge range cannot lose `registration`** — that
would leave it owning a physical range with nothing authorizing it to hand
those badges out.

Releasing a range safely is a reconciliation problem this phase does not
solve.

In Edit Device the Registration checkbox is therefore **locked on** while a
range is active, with the range named beneath it — there is no valid action
to take, so the operator is told immediately rather than after a round trip
that could only fail. Create Device is unaffected: a new device owns no range.

The lock is a courtesy, not the protection. The server refuses the removal
independently, and both sides read the required attribute from the same
shared constant so they cannot disagree.

## Device credentials

Phase 9C-A lets Admin provision the credentials a device will eventually sign
in with: its **login name** plus a **device password**.

> **Provisioning a credential does not put a device into service.**
>
> Since Phase 9C-B these credentials do work: a device can sign in at
> `POST /api/device-auth` and hold its own session. But the **event
> application still ran on Operator Access at that phase** — a device session
> unlocked none of `/`, `/badge-registration` or `/device-registration`.
> Phase D2 reversed that: the device session is now the only authority, and
> `/device-registration` is retired. At the time there was no
> device login screen yet. Setting a password on a *disabled* device is
> normal, and preparing a desk before opening it; a disabled device cannot
> sign in.

### What is stored

Only a scrypt hash, in a self-describing record:

```
scrypt$v1$<N>$<r>$<p>$<saltBase64url>$<keyBase64url>
```

| | |
|---|---|
| Algorithm | Node's built-in `node:crypto` `scrypt`, asynchronous |
| `N` / `r` / `p` | 32768 / 8 / 1 — about 32 MB and tens of milliseconds |
| Derived key | 32 bytes |
| Salt | 16 fresh `randomBytes` per password |
| Comparison | `timingSafeEqual` over equal-length buffers |

The algorithm, format version and every cost parameter travel *with* each
hash, so the verifier never assumes today's constants and the parameters can be
raised later without invalidating existing rows. A stored hash is treated as
untrusted input: malformed encoding, an unsupported version and impossible or
absurd parameters all return `false` before any work is done, and never throw.

There is no bcrypt, no argon2 native build and no hashing service. A plaintext
password is never stored, never logged, never returned and never written to
IndexedDB, `localStorage` or `sessionStorage`.

### The policy

8–128 characters. No required uppercase, lowercase, digit or symbol, so long
passphrases are welcome.

The value is taken **exactly**: never trimmed, never case-folded, never Unicode
normalised. Spaces are ordinary characters, so `"  my desk  "` and `"my desk"`
are different passwords. Silently "helping" would lock someone out of a desk on
event day.

The rules live in `src/shared/device-password.ts` and are read by both the
Admin browser form and the server, so the inline error and the actual refusal
cannot disagree. The browser sends the plaintext over HTTPS; hashing in the
browser instead would only turn the digest into a reusable password equivalent.

### Credential status

Admin sees one derived boolean:

```
Credentials
Configured            or            Not configured
[ Reset Password ]                  [ Set Password ]
```

The hash, its salt, its parameters and `session_version` never leave the
server. Nothing reveals a password, a previous password or a generated secret
after a save — if it is not recorded when it is set, it is reset.

### Setting and resetting

Credentials require a **login name**; one is never generated to make a request
succeed, and the Set Password action is unavailable without one.

**Create Device** may include a password. It is optional — inventory can be
created first and provisioned later — and when supplied, the device row, its
attributes and its password hash commit in one atomic batch. If anything fails,
no device is created.

**Editing** a device never shows a password field. A blank one inside Save
Device would be ambiguous between keeping the password, clearing it and setting
an empty one, so a reset is a deliberate separate action:
`POST /api/admin-device-password`, which checks the Admin session, the origin,
the body, the device, the event and the login name before hashing anything.

There is **no Clear Password, Remove Credentials or Disable Password**. Once a
device is provisioned the choices are resetting the password or disabling the
device, because a null hash means "never provisioned" and must never become a
route to a device without one.

### `session_version`

The revocation mechanism. Every deliberate password change increments it —
`1 → 2`, then `2 → 3` — with no attempt to detect whether the new password
equals the old one.

**Since Phase 9C-B this has an immediate effect.** A device session carries the
version it was issued under, and every authenticated request compares it with
the stored value. Resetting a password therefore signs that device out of every
browser it is logged into, at once, with no logout and no session store. See
`docs/DEVICE_AUTH.md`.

Disabling a device has the same effect on its live sessions, and is the right
action when a desk should stop being used rather than get new credentials.

It is never exposed to Admin: it answers a question Admin does not ask.

### No delete

There is no Delete Device action. Operational history should not casually
disappear. A device that should stop being used is **disabled**.

---

## Badge ranges

Admin can assign a device its **first** badge range, when the device exists in
the selected event, is enabled, has **`registration`**, and has no active
range.

There is deliberately **no edit, replace, release, transfer, extend or reset**.
Changing a range while devices operate offline is how two attendees end up
with the same physical badge. Once assigned, the range is shown read-only.

PostgreSQL is authoritative — two Admins can race past any application check —
and its constraint violations are translated into safe typed conflicts:

| Constraint | Reported as |
|---|---|
| `badge_assignments_active_ranges_no_overlap` | `badge-range-overlap` |
| `badge_assignments_one_active_per_device` | `badge-range-already-assigned` |
| `badge_assignments_device_event_fk` | `device-event-mismatch` |
| `devices_event_id_login_name_key` | `login-name-taken` |

No raw SQL, connection data, driver stack or database URL is ever returned.
Unknown failures give a generic message and log the operation plus SQLSTATE.

---

### Two ways a device will get its range

Central pre-assignment is **one** of two intended models, and it stays:

**A. Admin pre-assigns centrally** — what exists today. The Admin types the
range on the device's behalf.

**B. The device claims its own range** — Phase 9C. The Admin grants
Registration and the device, once authenticated, enters the physical range in
front of it.

Model B is not implemented: there is no authenticated browser-to-device
identity until Phase 9C.

### Phase 9C: device self-claim (design, not implemented)

1. Admin creates the device.
2. Admin grants it **Registration**.
3. The device authenticates with its own credentials.
4. If no central badge assignment exists, the device may enter its physical
   range.
5. The device submits that range **online**.
6. The server verifies the authenticated device actually has
   `registration`.
7. PostgreSQL **atomically reserves** the range.
8. Overlap is rejected centrally by the exclusion constraint.
9. The accepted range is cached into that device's IndexedDB.
10. The local `nextBadge` starts at `range_start`.
11. The device continues issuing badges **offline**, exactly as today.

> ### A device may NEVER establish a new badge range purely offline.
>
> The first claim must be centrally accepted. Two disconnected desks each
> inventing a range is precisely how two attendees end up holding the same
> physical badge, and no local check can prevent it. After the claim, issuance
> stays local and offline — the network is required once, to agree the range,
> and never again to hand out a badge.

## What Phase 9B deliberately does NOT do

**There is no device password.** Login name is groundwork only. Device
authentication, password hashing, session revocation and the range-claim API
above are all Phase 9C.

**`Enabled = false` is central state only.** It does **not** currently revoke
an existing device's event access at that phase, because devices did not authenticate
centrally yet. The UI says so. That enforcement arrives with Phase 9C.

**There is no heartbeat.** `last_seen_at` is displayed factually and will read
*Never seen* for most devices. Admin never claims Online or Offline — without
device authentication there is no trustworthy central device identity to
report on.

**Creating a device here does not touch any browser.** There is no
authenticated mapping from a browser to a central device record yet, so
creating *Registration Desk A* in Admin does not modify any device's
IndexedDB, badge range or `nextBadge`.

**The central event does not replace local EventConfig.** `eventName`,
`timezone`, `amount`, UPI details and the local badge range are not rewritten
from Postgres. The two systems are connected deliberately in later
device-enrollment work.

---

## `/device-registration` is transitional

The existing self-registration route keeps working exactly as it does today,
and must not be removed yet: current devices do not use central
authentication.

- **Local device identity** (`/device-registration` → IndexedDB) is what the
  event desks actually run on today.
- **Central device records** (Admin → Postgres) are groundwork for Phase 9C.

They are **not linked automatically**. Phase 9C introduces device sign-in and
replaces the transitional self-registration flow.

---

## Rate limiting

`POST /api/admin-auth` should be rate limited at the Vercel edge. See
[VERCEL_FIREWALL.md](VERCEL_FIREWALL.md). A 429 shows a generic *"Too many
admin login attempts"* message that reveals no address, no counter and nothing
about the submitted code.

---

## Phase D2 — Operator Access retired

The sections above that describe Operator Access as the event application's
authority are **historical**. Phase D2 deleted that realm: the central device
is the sole event-operations authority, `/device-registration` is a redirect
to `/device-login`, and `EVENT_OPERATOR_ACCESS_CODE` and
`EVENT_SESSION_SECRET` are obsolete.

What that means for Admin:

- Disabling a device now **does** close its event access — at its next
  session check if it is online, and when its signed offline lease expires if
  it is away. It is still not instant for an offline desk.
- Resetting a device password still increments `session_version`, which now
  signs that device out of the event application as well as out of
  `/device-login`.
- Admin remains a completely separate realm. An Admin cookie authorizes no
  event route, and a device cookie reaches no Admin API.
