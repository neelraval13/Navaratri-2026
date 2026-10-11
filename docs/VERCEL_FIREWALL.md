# Vercel Firewall — Login Rate Limits

`POST /api/device-auth` and `POST /api/admin-auth` are the only public,
unauthenticated endpoints in this application. Both need edge rate limiting.

> **This rule is NOT created by application code.** It must be configured
> manually in the Vercel project firewall. Nothing in this repository creates,
> reads or verifies it.

---

## The rule that is actually deployed

**The live plan permits ONE custom rate-limit rule.** Production therefore uses
a single rule whose condition matches either sign-in endpoint, rather than the
two separate rules an earlier revision of this document described.

| Setting | Value |
|---|---|
| **Condition** | Path `/api/admin-auth` **OR** Path `/api/device-auth` |
| **Condition — Method** | `POST` |
| **Action** | Rate Limit |
| **Key** | IP |
| **Limit** | **10 requests** |
| **Window** | **60 seconds** |
| **Algorithm** | Fixed Window |

This is the real configuration. Do not describe the limits as 5/min for Admin
and 30/min for devices — those were two rules this plan cannot have, and a
checklist that asks an operator to confirm a rule that does not exist teaches
them to tick boxes.

### What the single rule costs

One shared bucket means **the two endpoints compete**. Ten POSTs a minute from
one address covers Admin comfortably; it is tighter than a device-only rule
would be, and the venue consideration below is why that matters.

**Several event devices normally share the venue's Wi-Fi and leave through one
NAT address**, so an IP-keyed rule sees every desk as one client. A site
provisioning twenty tablets on the morning of the event will exceed 10/minute
legitimately.

**Before the event**, do one of these deliberately:

1. provision and sign in the desks **before** the rule matters, or from a
   different network, or
2. raise the limit for the day and lower it afterwards, or
3. temporarily disable the rule during provisioning.

**A rate limit that locks out the venue is an outage, not a defence.** Count
the desks and confirm whether they egress through a single address; set the
threshold after that, not before.

### The method matters

`/api/admin-auth` and `/api/device-auth` each serve three operations,
dispatched by HTTP method:

| Method | Operation |
|---|---|
| `POST` | sign in — the only one worth rate-limiting |
| `GET` | session introspection — called on startup and on reconnect |
| `DELETE` | sign out |

**The rule must condition on `Method = POST`.** A rule on the paths alone would
throttle session checks and sign-outs too, and breaking a working desk's
reconnect is worse than anything a guesser can do. Blocking a sign-out is
worse than allowing it.

> **Phase D2 retired Operator Access.** `/api/operator-login`,
> `/api/operator-session` and `/api/operator-logout` no longer exist. Any
> firewall rule still naming one of those paths matches nothing and should be
> deleted at the next review.

---

## Why the edge, and not the function

Serverless function instances do not share memory. An in-process counter would
be per-instance, reset on every cold start, and trivially bypassed by
concurrency — it would look like a rate limiter without being one.

So:

- **Do not** implement an in-memory rate limiter inside the Vercel Function.
- **Do not** add Redis, a database or a KV store solely for this.
- **Do not** add `@vercel/firewall`. That package exists for code-level custom
  rate-limit keys; a simple IP-based rule on two paths does not need it.

---

## Scope: these two POSTs only

**Do not rate-limit:**

| Endpoint | Why not |
|---|---|
| `GET /api/device-auth` | Called on startup and on reconnect by every device. Normal traffic looks bursty, and throttling it closes a desk that is still authorized. |
| `DELETE /api/device-auth` | Rarely called, and blocking a sign-out is worse than allowing it. |
| `/api/sync-registration` | Already requires a valid device session, and a device returning from offline legitimately drains a queue in a burst. Rate-limiting it would stall recovery exactly when it matters. |
| `/api/device-badge-claim` | Authenticated, and the database is what protects it. See below. |
| `/api/prizes` | Authenticated device traffic. See below. |

### Why the claim endpoint gets no rule

`POST /api/device-badge-claim` and its `PATCH` refill are **not** logins. They
are refused outright without a valid `__Host-navaratri_device_session`, so
there is no credential to guess at them and no enumeration surface to throttle.

What protects them is the database, not request volume: active badge ranges
cannot overlap within an event (a GiST exclusion constraint) and a device may
hold at most one active assignment (a partial unique index). A caller holding a
real device session can repeat the request as often as it likes and still
produce exactly one row.

Rate-limiting the path would also throttle the legitimate retry that recovers a
response lost in flight, which is the one case where retrying is correct.

### Why the prize endpoint gets no rule

`/api/prizes` is the same shape of thing: authenticated device traffic, refused
without a device session carrying the current `prizes` attribute.

`GET` is a roster read that a prize desk performs on opening the page, on
reconnect and on every explicit Refresh — ordinary, bursty, and harmless.
`POST` is protected by `UNIQUE(event_id, badge_number)`, which no amount of
repetition can get past: a second award for the same badge is refused by
Postgres whether it arrives once or a hundred times.

A rule here would throttle a volunteer pressing Refresh and protect nothing.

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

Rate limiting is a smaller part of the protection for the device endpoint than
for Admin: every device login path — unknown event, unknown login name,
unprovisioned device, wrong password — pays for a full scrypt derivation, so
guessing is inherently expensive and every failure looks identical. See
`docs/DEVICE_AUTH.md`.

The firewall reduces attempt volume. The credentials and the constant-cost
comparisons are what actually protect the endpoints.

---

## Client behaviour on 429

Each sign-in form treats a rate-limited response as its own case and shows a
generic wait message.

It never renders the server's response text, and never reveals the caller's
address, the remaining attempt count, or whether the submitted credential was
correct.
