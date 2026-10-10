# Production Release Checklist

The Phase 6B step-by-step gate list. Work through it in order.

**Every gate is PASS/FAIL. A FAIL stops the release** — do not proceed to the
next gate, and above all do not set `SYNC_WRITE_ENABLED=true`.

Git operations and the deployment itself are performed **by hand**. No script
here runs git, deploys, or contacts Google.

---

## GATE 1 — CODE

| # | Step | Pass |
|---|---|---|
| 1.1 | `pnpm lint` exits clean | ☐ |
| 1.2 | `pnpm build` succeeds | ☐ |
| 1.3 | `pnpm release:check` reports all checks passed | ☐ |
| 1.3a | No stray credential file in the working tree (release:check flags these by path) | ☐ |
| 1.4 | Working tree is in the state you intend to ship (inspect it yourself) | ☐ |
| 1.5 | You know exactly which commit is being deployed | ☐ |

`release:check` is read-only. It verifies repository assumptions — required
files, documented variable names, no `VITE_`-prefixed server secrets, no
service-account JSON, no private-key block, no `process.env` in client code. It
does **not** check anything about your Vercel project or your spreadsheet.

---

## GATE 2 — SECRETS

| # | Step | Pass |
|---|---|---|
| 2.1 | No service-account JSON file anywhere in the repository | ☐ |
| 2.2 | `.env.local` is git-ignored and was never committed | ☐ |
| 2.3 | Production secrets exist **only** in the Vercel **Production** environment | ☐ |
| 2.4 | Preview environment has **no** production Sheet credentials | ☐ |
| 2.5 | No server variable anywhere carries a `VITE_` prefix | ☐ |
| 2.6 | `DATABASE_URL` set per environment; Development and Production on **different** Neon branches | ☐ |
| 2.7 | Migrations applied deliberately with `pnpm db:migrate`, development branch first, then verified with `pnpm db:check` | ☐ |

Anything named `VITE_*` is compiled into the browser bundle. A private key there
is published, not protected. Only `VITE_UPI_ID` and `VITE_UPI_PAYEE_NAME` are
meant to be client-visible.

---

## GATE 3 — ACCESS CONTROL

| # | Step | Pass |
|---|---|---|
| 3.1 | Vercel deployment protection is **enabled** on production | ☐ |
| 3.2 | `SYNC_ALLOWED_ORIGIN` is set to the exact canonical production origin | ☐ |
| 3.3 | You have acknowledged that Origin restriction is **not** authentication | ☐ |

**Phase D2 retired Operator Access.** The central DEVICE session is the
application's own authentication and the production API auth boundary. Vercel
Authentication stays enabled in front of it until device access is proven on a
real deployment, then is disabled manually.

| # | Step | Pass |
|---|---|---|
| 3.4 | `EVENT_OPERATOR_ACCESS_CODE` **deleted** from Production, Preview and Development — nothing reads it | ☐ |
| 3.5 | `EVENT_SESSION_SECRET` **deleted** from all three environments — nothing reads it | ☐ |
| 3.6 | `/api/sync-registration` returns `unauthorized` without a device session, verified on the deployment | ☐ |
| 3.6a | `/api/operator-login`, `/api/operator-session` and `/api/operator-logout` all 404 on the deployment | ☐ |
| 3.7 | Device and Admin sign-in rate limits configured per `docs/VERCEL_FIREWALL.md`; any surviving operator-login rule deleted | ☐ |
| 3.8 | `EVENT_ADMIN_ACCESS_CODE` set (8 char minimum; use a longer passphrase) | ☐ |
| 3.9 | `EVENT_ADMIN_SESSION_SECRET` set, 32+ chars, and a different value from `EVENT_DEVICE_SESSION_SECRET` (recommended; isolation is enforced cryptographically regardless) | ☐ |
| 3.10 | Admin-login rate limit configured per `docs/VERCEL_FIREWALL.md` | ☐ |
| 3.11 | `/admin` verified to require its own sign-in, and a device session does not reach it | ☐ |
| 3.12 | `0002_device_credentials.sql` reviewed and applied to Development first, then Production, by hand | ☐ |
| 3.13 | Device passwords recorded wherever the organizer keeps operational secrets — they are never shown again | ☐ |
| 3.14 | No device password provisioned on a shared or reused passphrase | ☐ |
| 3.15 | `EVENT_DEVICE_SESSION_SECRET` set, 32+ chars, generated independently of the other two secrets | ☐ |
| 3.16 | Device-login rate limit configured per `docs/VERCEL_FIREWALL.md`, **with the venue's NAT checked** | ☐ |
| 3.17 | Both realms verified apart on the deployment: a device cookie reaches no Admin API, and an Admin cookie reaches no device API | ☐ |

Rotating `EVENT_DEVICE_SESSION_SECRET` revokes every issued device session
immediately. There is no session store to clear.

### Build parity

`pnpm build` typechecks the browser project, the `api/` + `server/` project and
a deliberately DEGRADED profile before it bundles anything. That third pass
exists because a build once passed locally while the deployment platform's own
compile of `api/**` reported dozens of errors.

If a deployment ever fails with TypeScript errors that `pnpm build` did not
show, that is a parity regression, not a one-off: reproduce it by adding the
platform's compiler options to `tsconfig.parity.json` and fix the source, never
the profile.

| # | Step | Pass |
|---|---|---|
| 3.21 | `pnpm build` run on a clean checkout, not an incremental tree | ☐ |
| 3.22 | `pnpm verify:parity` green | ☐ |
| 3.23 | `pnpm typecheck:vercel-functions` green — the platform compiles each `api/*.ts` separately after our build finishes | ☐ |
| 3.24 | Deployment Function count is **10 of 12** — the Hobby limit is enforced at deploy time, after the build succeeds | ☐ |

A deployment can still fail after a green build: Vercel typechecks every
function on its own, against the ROOT `tsconfig.json`'s `compilerOptions`. If
that happens, reproduce it by adjusting `scripts/vercel-function-typecheck.mjs`
to match the platform's options and fix the source — never widen the model to
make the error disappear.

### Device credentials (Phase 9C-A)

*Historical: at 9C-A, provisioning a device password stored a credential and
enabled nothing — there was no device login endpoint, session or cookie yet.
Since Phase 9C-B it is a working credential, and since Phase D2 it is the
ONLY way a desk gets event access.*

`password_hash = NULL` means *not provisioned*, never *passwordless*. A
password is never displayed after it is set and cannot be recovered — only
reset, which since Phase 9C-B **immediately signs that device out of every
browser it is logged into**.

### Device authentication (Phase 9C-B)

*Historical: at 9C-B the device realm existed but the event application did
not use it.*

Since Phase D2 it is the production auth boundary.
**`EVENT_DEVICE_SESSION_SECRET` is now REQUIRED in Production** — leaving it
unset means no desk can sign in and no desk can work.

Rotating it invalidates every device session at once. Per-device revocation is
an Admin password reset or disabling the device.

### Device sign-in UI (Phase 9C-C1)

*Historical: at 9C-C1, `/device-login` recorded a central-identity snapshot
and authorized nothing. Since Phase D2 signing in here is what opens the
event application, and Set Up This Device is what gives this browser its
identity.*

| # | Step | Pass |
|---|---|---|
| 3.18 | Each physical device signed in once at `/device-login` as its own central device, on the browser it will actually use | ☐ |
| 3.19 | Central device names in Admin match the physical labels on the desks | ☐ |
| 3.20 | No desk enrolled as a device belonging to another desk — a mismatch is refused, but the wrong *first* binding is not | ☐ |
| 3.21 | Each desk's central badge range adopted at `/device-login`, with the physical badge stack verified at that desk | ☐ |
| 3.22 | Any desk showing a range conflict reconciled BEFORE the event — adoption is blocked, so that desk cannot issue | ☐ |

Adoption is per-browser and explicit: a central assignment does not start
local issuance. Since Phase D2, central revocation closes an ONLINE desk at
its next session check — but an OFFLINE desk keeps working until its signed
lease expires, so a desk that must stop issuing immediately still has to be
stopped physically.

The third is the one to take seriously: binding a browser to the wrong central
device succeeds, because it is the first binding. Later phases make badge
ownership depend on it.

### Badge-range self-claim (Phase 9C-C2B)

A device with no central assignment can reserve one itself at `/device-login`,
through `POST /api/device-badge-claim`. It is **online only** and requires the
device session plus `registration`; the range it reserves must be the physical
badge stack actually standing at that desk, which no software can verify.

| # | Step | Pass |
|---|---|---|
| 3.23 | Every desk's physical badge stack counted and its first/last number written down BEFORE anyone claims | ☐ |
| 3.24 | Range claimed at the desk that holds the stack, with the confirmation ticked by the person looking at the badges | ☐ |
| 3.25 | Admin shows each device owning exactly the range its desk physically holds, with no overlaps | ☐ |
| 3.26 | Any desk that already had a local range claimed THAT range centrally, and its next badge is unchanged afterwards | ☐ |
| 3.27 | No desk left in "Central range claimed, but local setup could not be completed" — that desk must not issue badges | ☐ |
| 3.28 | No desk left showing "Claim status could not be confirmed" without a Refresh Device Status to settle it | ☐ |

### Offline device authorization (Phase 9C-C3A)

*Historical: at 9C-C3A the signed lease was foundation only.*

Since Phase D2 the lease is the ONLY thing that keeps an offline desk
working, so **these steps are no longer preparatory — an unconfigured signing
key means every desk stops the moment the venue's internet does.**

| # | Step | Pass |
|---|---|---|
| 3.29 | A P-256 key pair generated for this deployment, never reused from another environment | ☐ |
| 3.30 | `EVENT_DEVICE_OFFLINE_PRIVATE_KEY_PKCS8_B64` set **server-side only**, never with a `VITE_` prefix | ☐ |
| 3.31 | `VITE_EVENT_DEVICE_OFFLINE_PUBLIC_KEY_SPKI_B64` set to the **matching** public key — a mismatched pair verifies nothing, and only an offline desk would discover it | ☐ |
| 3.32 | The private key is not in the repository, not in a commit, not in a screenshot and not in a chat message | ☐ |
| 3.33 | `events.ends_at` set for the event, so every lease is capped by it rather than by 24 hours alone | ☐ |
| 3.34 | A device signed in once online and `/device-login` shows **Available offline** with a sensible *Valid until* | ☐ |

Leaving both unset is a valid production state for C3A: device sign-in works,
the page reports offline authorization unavailable, and nothing fails open.
**Phase 9C-C3B is required before a device lease can unlock event
operations,** and it must not be switched on until these are configured.

### Device-authorized event operations (Phase 9C-C3B, D2)

A centrally enrolled, CONVERGED device opens `/` and `/badge-registration` on
its own authority, online or from a verified offline lease. Since Phase D2
there is nothing else that opens them.

| # | Step | Pass |
|---|---|---|
| 3.35 | Each desk opens `/badge-registration` and the banner reads *Device access · Verified online* | ☐ |
| 3.36 | With the network disabled, the same desk still opens it and the banner reads *Offline device access* with a sensible *valid until* — never "Authenticated" | ☐ |
| 3.37 | A badge issued offline advances `nextBadge` locally and queues in the outbox with no device-auth request | ☐ |
| 3.38 | On reconnect, one device revalidation happens and the outbox drains with no further action | ☐ |
| 3.39 | Removing `registration` centrally, then reconnecting, closes badge registration on that desk | ☐ |
| 3.40 | Disabling a device centrally, then reconnecting, clears its lease and its authority — and NO fallback appears | ☐ |
| 3.41 | A desk whose local range disagrees with its central assignment **hard-blocks** with no override | ☐ |
| 3.42 | A browser with no device grant shows *Device access required* and a link to Device Sign-In, and nothing else | ☐ |

Run 3.36-3.38 against the **deployment**, or against `pnpm build` +
`pnpm preview` locally. `vercel dev` registers no service worker, so an
offline reload there fails before any application code runs; and Preview
serves no Vercel Functions, so the reconnect in 3.38 needs `vercel dev` on the
same origin. `docs/DEVICE_AUTH.md` has the two-server procedure.

Step 3.41 is the one to take seriously. It is the only case a credential
could never have resolved, and it is the case that protects two attendees
from receiving the same badge.

### Badge refill (Phase D2.1)

A desk that runs out extends its OWN range upward and contiguously, at
`/device-login`. There is no new endpoint, no migration and no schema change,
so nothing new has to be configured — but the plan has to be right before the
event, because a refill cannot start anywhere but one past a desk's current
last badge.

| # | Step | Pass |
|---|---|---|
| 3.49 | `docs/DEVICE_RANGE_PLAN.md` keeps the reserve as a SINGLE block above every assigned range | ☐ |
| 3.50 | Every desk's physical stack ends exactly where its recorded range ends | ☐ |
| 3.51 | Whoever is on the floor knows that **Add More Badges** is the answer to an exhausted desk, and that Hold Registration keeps working | ☐ |
| 3.52 | Refill rehearsed once in Development on a disposable device and range — never with production numbers | ☐ |
| 3.53 | Confirmed in that rehearsal that the next badge number did NOT change | ☐ |
| 3.54 | A refill needs connectivity; the venue has a way to get one desk online if it runs out mid-outage | ☐ |

**Do not refill with production badge numbers to prove the feature works.**
Extending a range consumes reserve numbers, and nothing shrinks a central
range afterwards.

### Device identity convergence (Phase D1)

A browser converges its local device identity onto the central one. **Phase
D2 made this mandatory**: an unconverged browser cannot open any event route,
so every desk must be converged before the event.

| # | Step | Pass |
|---|---|---|
| 3.43 | Each desk's `/device-login` Identity section reviewed; the central device shown is the right one for that desk | ☐ |
| 3.44 | Convergence performed deliberately, with the acknowledgement read, while online | ☐ |
| 3.45 | After convergence, Event Operations shows the central device name | ☐ |
| 3.46 | Badge range, next badge number and the central binding unchanged by the migration | ☐ |
| 3.47 | Any desk reporting an identity conflict reconciled BEFORE the event — it cannot be overridden | ☐ |
| 3.48 | Registrations created before convergence still show the old device id in the Sheet's technical columns; that is expected and correct | ☐ |

Converge **before** the event, not during it. The identity applies to future
registrations only, so converging mid-event deliberately splits one desk's
records across two device ids — legible, but avoidable.

**There is no undo.** Nothing in the application releases, edits, transfers or
extends a central badge range, so a range claimed against the wrong desk has to
be reconciled by hand in the database before the event. Reserve a range only
when the badges are on the table.

A claim that succeeds centrally and fails locally leaves REAL central ownership
in place; that is deliberate, so the ledger never disagrees with a human's
belief about who holds the numbers. Resolve it before the desk opens.

The login rate limit is a Vercel firewall rule configured by hand in the
Dashboard — no application code creates it, and `release:check` cannot verify
it.

Platform protection, in order of preference:

1. **Vercel Authentication** — if it suits the operators/team
2. **Password Protection** — if the Vercel plan supports it
3. an explicitly approved application authentication layer, as a **future
   phase** — none exists today

`SYNC_ALLOWED_ORIGIN` stops another website's page from driving the endpoint.
Any direct HTTP client can set an Origin header to whatever it likes, so it is a
same-origin guard, not a user check. **It is not authentication.**

> **If no suitable access-control mechanism is available, STOP.**
> Leave `SYNC_WRITE_ENABLED` unset. Do not enable production Sheet writes.

---

## GATE 4 — GOOGLE

| # | Step | Pass |
|---|---|---|
| 4.1 | Final event spreadsheet created | ☐ |
| 4.2 | Shared with the service-account email as **Editor** | ☐ |
| 4.3 | Google Sheets API enabled on the Cloud project | ☐ |
| 4.4 | Production spreadsheet ID configured in Vercel Production | ☐ |
| 4.5 | Tabs are either freshly app-created, or known-compatible | ☐ |
| 4.6 | Hidden technical columns (Registration ID, Updated At) untouched | ☐ |

The server creates **Badge Register** and **Held Registrations** itself if they
are missing, and refuses to initialise a tab that is not completely blank. A
partial, reordered or foreign header fails closed rather than stamping itself
over somebody's data.

---

## GATE 5 — ENVIRONMENT

Set in the Vercel **Production** environment:

```bash
SYNC_ALLOWED_VERCEL_ENV=production
SYNC_ALLOWED_ORIGIN=<exact canonical production origin>
GOOGLE_SHEETS_SPREADSHEET_ID=<final spreadsheet id>
GOOGLE_SERVICE_ACCOUNT_EMAIL=<...@...iam.gserviceaccount.com>
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY=<service account private key>
VITE_UPI_ID=<organizer UPI id>
VITE_UPI_PAYEE_NAME=<organizer payee name>
```

| # | Step | Pass |
|---|---|---|
| 5.1 | All of the above set in Production | ☐ |
| 5.2 | UPI production values configured and correct | ☐ |
| 5.3 | Gates 1–4 have all passed | ☐ |
| 5.4 | **Only now:** set `SYNC_WRITE_ENABLED=true` and redeploy | ☐ |

`SYNC_WRITE_ENABLED` must be **exactly** `true`. Unset, blank, `false`, `TRUE`,
`1`, `yes` and padded values such as `" true"` all mean disabled — which is the
safe state. The value is not trimmed and not case-folded.

`SYNC_ALLOWED_VERCEL_ENV` must be exactly `development`, `preview` or
`production`, and the runtime `VERCEL_ENV` must exactly equal it. Neither is
trimmed. If they differ, or if `VERCEL_ENV` is absent, the endpoint fails closed
with `sync-not-configured` and makes no Google API call at all.

If you paste a value and sync stays disabled, check for a stray space before
suspecting anything else.

### Preview

Preferred: **do not configure Google sync credentials in Preview**, and leave
`SYNC_WRITE_ENABLED` unset there.

Git pushes create Preview deployments. A preview must never write to the final
event ledger. If preview sync testing is ever genuinely needed, use a
**disposable preview-only spreadsheet** with `SYNC_ALLOWED_VERCEL_ENV=preview` —
never the production Sheet.

### Development

For local testing:

```bash
SYNC_WRITE_ENABLED=true
SYNC_ALLOWED_VERCEL_ENV=development
SYNC_ALLOWED_ORIGIN=http://localhost:3001
```

Pull Development-scoped variables from the Vercel project with:

```bash
pnpm dlx vercel@latest env pull .env.development.local --environment=development
```

Then start the local server with `VERCEL_ENV` supplied explicitly:

```bash
env VERCEL_ENV=development pnpm dlx vercel@latest dev --listen 3001
```

`vercel dev` does **not** expose `VERCEL_ENV` to the function in this project,
so the prefix is required. Without it the interlock fails closed - which is the
correct behaviour, not a bug to work around.

Point it at a **disposable development spreadsheet** only.

---

## GATE 6 — DEVICE

| # | Step | Pass |
|---|---|---|
| 6.1 | Production app loaded on the event device **while online** | ☐ |
| 6.1a | `/` and `/badge-registration` open by direct URL; `/device-registration` redirects to `/device-login` | ☐ |
| 6.1b | `GET /api/device-auth` still returns JSON, not the SPA shell | ☐ |
| 6.2 | Installed as a PWA | ☐ |
| 6.3 | `await navigator.storage.persisted()` returns `true`, or the refusal is accepted | ☐ |
| 6.3 | Provisioned per `docs/DEVICE_PROVISIONING.md`, against `docs/DEVICE_RANGE_PLAN.md` | ☐ |
| 6.3a | Device signed in and **converged** at `/device-login` — Set Up This Device, or Converge Device Identity | ☐ |
| 6.3a1 | *Badge desks only:* central badge range adopted at `/device-login`, with the physical stack confirmed | ☐ |
| 6.3b | Its range does not overlap any other device's | ☐ |
| 6.3c | The matching physical badge stack is at this device | ☐ |
| 6.4 | `nextBadge` matches the first physical badge on the desk | ☐ |
| 6.5 | Badge range (`badgeStart` / `badgeEnd`) is correct | ☐ |
| 6.6 | UPI QR scanned: correct payee, ₹20 | ☐ |
| 6.7 | Outbox is zero — header shows `Synced` | ☐ |

Persistence may be declined by the browser. That is not a release blocker; it is
a reason to keep the pending count low during the event.

---

## GATE 7 — PRODUCTION SMOKE TEST

Use **dedicated smoke-test attendees**, not real ones.

| # | Test | Pass |
|---|---|---|
| 7.1 | Online Hold → appears in **Held Registrations** | ☐ |
| 7.2 | Resume → Issue Badge → appears in **Badge Register** | ☐ |
| 7.3 | The held row is cleared remotely by that completion | ☐ |
| 7.4 | Offline Hold → reconnect → reaches the Sheet | ☐ |
| 7.5 | Offline Issue Badge → reconnect → reaches the Sheet | ☐ |
| 7.6 | Sync status transitions: pending → syncing → `Synced` | ☐ |
| 7.7 | Outbox drains to zero | ☐ |
| 7.8 | No duplicate badge number appears anywhere | ☐ |

### Handling the badges a smoke test consumes

A real smoke test **issues real badge numbers**. Decide up front, before you
start:

- **Preferred:** configure a designated non-event test range
  (`badgeStart` / `badgeEnd`) for the smoke test, so no event badge is touched.
- **Or:** run the smoke test without physically issuing a badge from the event
  sequence, and reconcile the consumed numbers deliberately afterwards.

Afterwards, remove or reconcile **only the smoke-test rows**, in a controlled
way, before the event opens.

> **Do not blindly reset `nextBadge` after a production smoke test.**
> `nextBadge` is authoritative and must match the physical badge pile. Resetting
> it casually is how two attendees end up with the same badge number. Set it
> deliberately, to a number you have verified against the badges on the desk.

---

## After all gates pass

Go to `docs/EVENT_DAY_RUNBOOK.md` and work through **Before event day**.
