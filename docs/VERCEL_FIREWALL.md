# Vercel Firewall — Login Rate Limits

`POST /api/operator-login` is the one public, unauthenticated endpoint in this
application. It needs edge rate limiting.

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

## The rule

Configure in the Vercel Dashboard under the project's Firewall settings:

| Setting | Value |
|---|---|
| **Condition — Path** | `/api/operator-login` |
| **Condition — Method** | `POST` |
| **Action** | Rate Limit |
| **Key** | IP |
| **Limit** | 10 |
| **Window** | 60 seconds |
| **Algorithm** | Fixed Window |
| **On exceed** | Deny / rate-limit response |

Ten attempts per minute per IP leaves an operator who fat-fingers the code
plenty of room, while making online guessing against a 12+ character passphrase
pointless.

> **The final IP threshold must be confirmed once the expected device count and
> the venue network topology are known.** Several event devices may sit behind
> one NAT public address, in which case they share the limit — a venue with
> many desks on one uplink needs a higher number than a single device would.
> Do not weaken application authentication to compensate.

A fixed window is sufficient here. The burst a sliding window would prevent is
not a meaningful threat against a strong passphrase.

---

## Admin login

`POST /api/admin-login` is the second public, unauthenticated endpoint and
needs its own rule. Admin is a higher-value credential and legitimate traffic
is far lower, so the limit is tighter:

| Setting | Value |
|---|---|
| **Condition — Path** | `/api/admin-login` |
| **Condition — Method** | `POST` |
| **Action** | Rate Limit |
| **Key** | IP |
| **Limit** | 5 |
| **Window** | 60 seconds |
| **Algorithm** | Fixed Window |

Like the operator rule, this is **not created by application code** and must
be configured manually in the Vercel Dashboard. Review it before production
enablement. The client shows a generic *"Too many admin login attempts"*
message on 429 and reveals no address, counter or code correctness.

## Device login

`POST /api/device-login` is the third public, unauthenticated endpoint.

**The limit must be looser than it looks like it should be.** Several event
devices normally share the venue's Wi-Fi and leave through **one NAT address**,
so an IP-keyed rule sees every desk as one client. A tight limit would lock out
the whole venue while an operator retypes a passphrase on one tablet.

| Setting | Value |
|---|---|
| **Condition — Path** | `/api/device-login` |
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

Like the other two, it is not created by application code and must be
configured manually in the Vercel Dashboard.

Rate limiting is a smaller part of the protection here than it is for the
operator or Admin endpoints: every device login path — unknown event, unknown
login name, unprovisioned device, wrong password — pays for a full scrypt
derivation, so guessing is inherently expensive and every failure looks
identical. See `docs/DEVICE_AUTH.md`.

**Do not rate-limit `/api/device-session`**: it is called on startup and on
reconnect, exactly like `/api/operator-session`, and blocking it would break
a working desk rather than a guesser. **Do not rate-limit
`/api/device-logout`** either.

## Scope: this endpoint only

**Do not rate-limit:**

| Endpoint | Why not |
|---|---|
| `/api/operator-session` | Called on startup, on focus and on reconnect by every device. Normal traffic looks bursty. |
| `/api/operator-logout` | Rarely called, and blocking a logout is worse than allowing it. |
| `/api/sync-registration` | Already requires a valid operator session, and a device returning from offline legitimately drains a queue in a burst. Rate-limiting it would stall recovery exactly when it matters. |

---

## This is a layer, not a replacement

Every existing application protection stays exactly as it is:

- exact access-code comparison, no trimming, no case folding
- constant-time comparison over SHA-256 digests
- fixed delay before a wrong-code response
- same-origin requirement on login
- `__Host-` prefixed, `Secure`, `HttpOnly`, `SameSite=Strict` cookie
- 14-day session expiry
- server-only secrets, never `VITE_` prefixed
- generic invalid-code response
- the access code is never logged and never persisted client-side

The firewall reduces attempt volume. The passphrase and the constant-time
comparison are what actually protect the endpoint.

---

## Client behaviour on 429

The unlock form treats a rate-limited response as its own case and shows:

> Too many unlock attempts. Wait a moment and try again.

It never renders the server's response text, and never reveals the caller's
address, the remaining attempt count, or whether the submitted code was
correct. A 401 still says the code is incorrect; any other unsuccessful status
says *Unable to unlock. Try again.*
