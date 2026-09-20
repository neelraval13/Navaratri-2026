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

Acceptable protection, in order of preference:

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
| 6.2 | Installed as a PWA | ☐ |
| 6.3 | `await navigator.storage.persisted()` returns `true`, or the refusal is accepted | ☐ |
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
