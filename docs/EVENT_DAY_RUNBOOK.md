# Event Day Runbook

For the person operating and supporting the registration desk.

**The one rule that matters:** if anything network-related breaks, **keep
registering**. The browser is the source of truth. Registrations are committed
to IndexedDB before anything is sent anywhere, and synchronization catches up on
its own.

---

## A. Before event day

| # | Check | Done |
|---|---|---|
| 1 | Final code checkpoint committed (by hand — the tooling never runs git) | ☐ |
| 2 | Final Google Spreadsheet created | ☐ |
| 3 | Spreadsheet shared with the service-account email as **Editor** | ☐ |
| 4 | Production env values set in the Vercel **Production** environment only | ☐ |
| 5 | Preview kept isolated — no production Sheet credentials in Preview | ☐ |
| 6 | Vercel deployment protection **enabled** on production | ☐ |
| 7 | `SYNC_WRITE_ENABLED=true` set **only after** #6 | ☐ |
| 8 | Production deployment opened once **while online** (this is what caches the app) | ☐ |
| 9 | Installed as a PWA on the event device | ☐ |
| 10 | Service worker is controlling the page (DevTools → Application → Service Workers → "activated and is running") | ☐ |
| 11 | Storage persistence checked — see §L | ☐ |
| 12 | UPI QR physically scanned: payee name correct, amount ₹20 | ☐ |
| 13 | Google Sheet sync smoke-tested (see the release checklist) | ☐ |
| 14 | Local outbox verified **zero** — header shows `Synced` | ☐ |
| 15 | `nextBadge` matches the first physical badge on the desk | ☐ |
| 16 | `badgeEnd` correct, if a range is configured | ☐ |
| 17 | Device charger and power available at the desk | ☐ |

---

## B. Event opening check

In the app, confirm:

- correct event name in the header
- correct **next badge** in the form header
- the Online / Offline mode indicator is understood by whoever is at the desk
- Sync shows `Synced` — and remember that means **the local queue is empty**,
  nothing more
- UPI payee name is correct on the QR panel
- the physical badge on top of the pile **matches the displayed next badge**

If #6 does not match, stop and reconcile before registering anyone.

---

## C. Normal registration

1. Phone
2. Name
3. Age
4. Gender
5. **Next**
6. UPI or Cash
7. Confirm payment
8. **Issue Badge #xxx**
9. **Physically hand over the badge number shown**
10. **Next Person**

The badge is consumed only at step 8. Steps 1–7 consume nothing.

---

## D. Hold / Resume

**Hold consumes no badge.** Use it when someone cannot pay right now.

- the registration is saved and the badge counter does not move
- they come back later and you Resume from the same phone + name
- the badge is assigned **only** at the final Issue Badge — so they receive
  whatever badge is current when they actually return, not the one that was on
  screen when they first walked up

Clear abandons the editing session only. It never deletes the saved held record.

---

## E. Internet goes down

### KEEP REGISTERING.

- local registration works normally
- Hold and Issue Badge both work
- the pending count in the header will grow — that is correct and expected
- **do not refresh the page repeatedly**; nothing is waiting on a reload
- the UPI QR still renders (it is generated locally), but the payer needs their
  own connectivity to complete the payment — take cash if they cannot
- when connectivity returns, synchronization resumes **automatically**

Nothing is lost. The rows are durable in IndexedDB.

---

## F. Vercel / sync endpoint down

### KEEP REGISTERING.

- local data is safe in IndexedDB
- pending rows remain queued
- retries happen automatically with a growing delay
- once the service is back, press **Retry synchronization** in the header if you
  do not want to wait for the next automatic attempt
- **do not delete outbox data** to "clean up" — that is the only copy of work
  that has not reached the Sheet yet

---

## G. Google Sheet unavailable

### KEEP REGISTERING.

- same local-first behaviour as §F
- **do not edit the application-owned tab headers or layout to try to fix sync**
- restore access to the Sheet, or restore its layout, then press
  **Retry synchronization**

---

## H. Sync issue

The header shows `Sync issue` when something needs a human. Registration is
still completely usable.

### `badge-conflict`

The badge number in the Sheet already belongs to a **different** registration.

- the physical badge has already been handed to someone
- **do not** renumber the local record
- **do not** decrement `nextBadge`
- open the Badge Register and the local registration and compare them
- this needs human reconciliation — the server deliberately refuses to guess

### `sheet-shape-conflict`

The spreadsheet is not in the shape the app owns.

- **do not clear local data**
- repair the app-owned tab headers / layout
- press **Retry synchronization**

---

## I. Power loss or browser crash

1. Reopen the installed PWA.
2. Committed registrations should all still be there.
3. **Check `nextBadge` before continuing** — compare it against the physical
   badge pile.
4. Check the pending sync count.
5. **Do not clear browser or site data.**

---

## J. Do NOT do these things during the event

- do not **Clear Site Data**
- do not uninstall the browser or the PWA until the event is fully complete
- do not delete the IndexedDB database
- do not edit the hidden **Registration ID** or **Updated At** columns
- do not manually renumber completed local badges
- do not use a test or development spreadsheet as the final ledger
- do not paste a service-account key into the browser or the console

---

## K. Event close

1. Wait until Sync shows **`Synced`** and the pending count is zero.
2. Inspect the final Sheet: badge order should be ascending and complete.
3. Check **Held Registrations** for attendees who never came back.
4. Make a backup copy of the Google Spreadsheet (File → Make a copy).
5. Export or retain any operational records you need.
6. **Do not clear local IndexedDB immediately.**
7. Keep the device and the app intact until reconciliation is finished.

---

## L. Read-only DevTools helpers

Open DevTools → Console on the registration page and paste. **All of these only
read.** None of them writes, clears or deletes anything.

### 1. Event configuration

```js
await (async () => {
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open('navaratri-2026-registration')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rows = await new Promise((res, rej) => {
    const q = idb.transaction('config', 'readonly').objectStore('config').getAll()
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
  })
  const event = rows.find((row) => row.id === 'event')
  console.log('eventName:', event?.eventName)
  console.log('nextBadge:', event?.nextBadge)
  console.log('badgeStart:', event?.badgeStart)
  console.log('badgeEnd:', event?.badgeEnd ?? '(no range configured)')
  idb.close()
})()
```

### 2. Outbox / sync queue

```js
await (async () => {
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open('navaratri-2026-registration')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rows = await new Promise((res, rej) => {
    const q = idb.transaction('outbox', 'readonly').objectStore('outbox').getAll()
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
  })
  console.log('pending rows:', rows.length)
  console.table(rows.map((row) => ({
    status: row.payload?.status,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt ?? '',
    lastErrorCode: row.lastErrorCode ?? '',
    lastError: row.lastError ?? '',
  })))
  idb.close()
})()
```

No attendee details are printed.

### 3. Registration counts

```js
await (async () => {
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open('navaratri-2026-registration')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rows = await new Promise((res, rej) => {
    const q = idb.transaction('registrations', 'readonly').objectStore('registrations').getAll()
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
  })
  console.log('held:', rows.filter((r) => r.status === 'held').length)
  console.log('completed:', rows.filter((r) => r.status === 'completed').length)
  console.log('total:', rows.length)
  idb.close()
})()
```

### 4. Look up ONE attendee (only when debugging a specific person)

This one prints personal data, so use it deliberately and only for the attendee
in front of you.

```js
await (async () => {
  const PHONE = ''          // 10 digits, no +91
  if (PHONE.length !== 10) { console.error('Set PHONE to 10 digits first.'); return }
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open('navaratri-2026-registration')
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error)
  })
  const rows = await new Promise((res, rej) => {
    const q = idb.transaction('registrations', 'readonly').objectStore('registrations').getAll()
    q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error)
  })
  console.table(rows.filter((r) => r.phone === PHONE).map((r) => ({
    name: r.name, status: r.status, badge: r.badgeNumber ?? '',
    payment: r.paymentMethod ?? '', heldAt: r.heldAt ?? '', completedAt: r.completedAt ?? '',
  })))
  idb.close()
})()
```

---

## M. Device storage check

```js
await navigator.storage.persisted()
```

`true` means the browser has marked this origin's storage as persistent, which
makes it resistant to automatic eviction under storage pressure.

Optionally:

```js
await navigator.storage.estimate()
```

The numbers it returns are **estimates**, not guarantees, and browsers
deliberately report them coarsely.

### What persistence does and does not mean

The app requests persistence automatically once the database is ready. It is a
hint to the browser, not a safety net.

Persistent storage **does not** mean:

- a backup exists
- IndexedDB can never be lost
- data survives **Clear Site Data**, uninstalling the app or wiping the profile
- the device cannot fail

Google Sheets is the central ledger for snapshots that have **already been
acknowledged**. Anything still pending in the outbox exists only on this device
until it syncs. That is the real reason to keep the pending count low and to
finish the event with `Synced`.
