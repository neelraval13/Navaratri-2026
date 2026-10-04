# Vercel Firewall — Login Rate Limits

`POST /api/device-auth` and `POST /api/admin-auth` are the only public,
unauthenticated endpoints in this application. Both need edge rate limiting.

> **Phase D2 retired Operator Access.** `/api/operator-login`,
> `/api/operator-session` and `/api/operator-logout` no longer exist. Any
> firewall rule still naming one of those paths matches nothing and should be
> deleted at the next review.

> **This rule is NOT created by application code.** It must be configured
> manually in the Vercel project firewall after deployment. Nothing in this
> repository creates, reads or verifies it.

---

## Why the edge, and not the function

Serverless function instances do not share memory. An in-process counter would
be per-instance, reset on every cold start, and trivially bypassed by
concurrency — it would look like a rate limiter without being one.

So:

- **Do not** implement an in-memory rate limiter inside the Vercel Function.
- **Do not** add Redis, a database or a KV store solely for this.
- **Do not** add `@vercel/firewall`. That package exists for code-level custom
  rate-limit keys; a simple IP-based rule on one path does not need it.

---

## Admin login

`POST /api/admin-auth` is the second public, unauthenticated endpoint and
needs its own rule. Admin is a higher-value credential and legitimate traffic
is far lower, so the limit is tighter:

| Setting | Value |
|---|---|
| **Condition — Path** | `/api/admin-auth` |
| **Condition — Method** | `POST` |
| **Action** | Rate Limit |
| **Key** | IP |
| **Limit** | 5 |
| **Window** | 60 seconds |
| **Algorithm** | Fixed Window |

Like the device rule, this is **not created by application code** and must
be configured manually in the Vercel Dashboard. Review it before production
enablement. The client shows a generic *"Too many admin login attempts"*
message on 429 and reveals no address, counter or code correctness.

## Device login

`POST /api/device-auth` is the event desk's only sign-in, and since Phase D2
the only way any desk gets event authority at all.

**The limit must be looser than it looks like it should be.** Several event
devices normally share the venue's Wi-Fi and leave through **one NAT address**,
so an IP-keyed rule sees every desk as one client. A tight limit would lock out
the whole venue while an operator retypes a passphrase on one tablet.

| Setting | Value |
|---|---|
| **Condition — Path** | `/api/device-auth` |
| **Condition — Method** | `POST` |
| **Action** | Rate Limit |
| **Key** | IP |
| **Limit** | 30 |
| **Window** | 60 seconds |
| **Algorithm** | Fixed Window |

This is a **starting point, not a setting to accept unexamined**. Before
production, count the devices that will actually be at the venue and confirm
whether they egress through a single address. A site with twenty desks
provisioning on the morning of the event will exceed 30/minute legitimately.

Like the Admin rule, it is not created by application code and must be
configured manually in the Vercel Dashboard.

Rate limiting is a smaller part of the protection here than it is for the
Admin endpoint: every device login path — unknown event, unknown login name,
unprovisioned device, wrong password — pays for a full scrypt derivation, so
guessing is inherently expensive and every failure looks identical. See
`docs/DEVICE_AUTH.md`.

**A rate limit that locks out the venue is an outage, not a defence.** This is
the endpoint an entire event depends on; set the threshold after counting the
desks, not before.

### The method matters

`/api/admin-auth` and `/api/device-auth` each serve three operations,
dispatched by HTTP method:

| Method | Operation |
|---|---|
| `POST` | sign in — the only one worth rate-limiting |
| `GET` | session introspection — called on startup and on reconnect |
| `DELETE` | sign out |

**Both rules must condition on `Method = POST`.** A rule on the path alone
would throttle session checks and sign-outs too, and breaking a working desk's
reconnect is worse than anything a guesser can do. Blocking a sign-out is
worse than allowing it.

That is an improvement on the previous shape: when login had its own path,
the path was the whole condition and a mistake was invisible. Now the method
is doing real work, so it must be set explicitly.

## Scope: these two POSTs only

**Do not rate-limit:**

| Endpoint | Why not |
|---|---|
| `GET /api/device-auth` | Called on startup and on reconnect by every device. Normal traffic looks bursty, and throttling it closes a desk that is still authorized. |
| `DELETE /api/device-auth` | Rarely called, and blocking a sign-out is worse than allowing it. |
| `/api/sync-registration` | Already requires a valid device session, and a device returning from offline legitimately drains a queue in a burst. Rate-limiting it would stall recovery exactly when it matters. |

---

## Why the claim endpoint gets no rule

`POST /api/device-badge-claim` is **not** a login. It is refused outright
without a valid `__Host-navaratri_device_session`, so there is no credential
to guess at it and no enumeration surface to throttle.

What protects it is the database, not request volume: active badge ranges
cannot overlap within an event (a GiST exclusion constraint) and a device may
hold at most one active assignment (a partial unique index). A caller holding
a real device session can repeat the request as often as it likes and still
produce exactly one row — a repeat of the same range is answered
`already-claimed`, and a different one `already-assigned`.

Rate-limiting the path would also throttle the legitimate retry that recovers
a response lost in flight, which is the one case where retrying is the correct
behaviour.

---

## This is a layer, not a replacement

Every existing application protection stays exactly as it is:

- exact password and access-code comparison, no trimming, no case folding
- scrypt verification for every device credential, including a failing one
- a fixed timing-equalizer hash, so every device failure costs the same
- constant-time digest comparison for the Admin code
- same-origin requirement on every sign-in
- `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite=Strict` cookies
- `session_version` revocation, re-read from Postgres on every request
- server-only secrets, never `VITE_` prefixed
- one generic 401 for every credential failure

The firewall reduces attempt volume. The credentials and the constant-cost
comparisons are what actually protect the endpoints.

---

## Client behaviour on 429

Each sign-in form treats a rate-limited response as its own case and shows a
generic wait message.

It never renders the server's response text, and never reveals the caller's
address, the remaining attempt count, or whether the submitted credential was
correct.
