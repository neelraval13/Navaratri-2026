# Device Provisioning

Run this once per physical registration device, before the event.

Fill in [`DEVICE_RANGE_PLAN.md`](DEVICE_RANGE_PLAN.md) as you go — decide the
ranges there **first**, then provision each device against that plan.

---

## Per-device steps

| # | Step | Done |
|---|---|---|
| 1 | Open the production app **while online** | ☐ |
| 2 | Unlock Operator Access | ☐ |
| 3 | Complete **Device Setup** using the range from the central plan | ☐ |
| 4 | Confirm the matching physical badge stack is at this desk | ☐ |
| 5 | Open **Device Readiness** (clipboard icon in the header) | ☐ |
| 6 | Copy the **Device ID** into the Device Range Plan | ☐ |
| 7 | Verify: readiness range == plan range == physical stack | ☐ |
| 8 | Verify **Next badge** equals the range start | ☐ |
| 9 | Verify **Completed = 0** and **Held = 0** on a freshly provisioned device | ☐ |
| 10 | Verify **Pending sync = 0** | ☐ |
| 11 | Verify **Service worker: Active** | ☐ |
| 12 | Install the PWA using the browser / OS install UI | ☐ |
| 13 | Reopen the **installed** app | ☐ |
| 14 | Open Device Readiness again and re-check | ☐ |
| 15 | Check **Persistent storage** status | ☐ |
| 16 | Verify **Network: Online** and **Pending sync: Synced** | ☐ |
| 17 | Physically label the device with its desk name and range | ☐ |
| 18 | Run the offline test below | ☐ |
| 19 | **Do not clear site data afterwards** | ☐ |
| 20 | Record the final check in the Device Range Plan | ☐ |

If step 11 says *Not controlling this page*, close and reopen the app — the
worker takes over on the next load. If step 15 says *Not granted*, that is a
warning, not a blocker: the app still works, but keep pending sync low.

---

## Offline provisioning test

The point of this test is to prove the **installed app and its local data
survive without a network**. It is not a badge test.

1. Load the app online and confirm Device Readiness looks right.
2. Disconnect the network (airplane mode, or turn off Wi-Fi).
3. Reload / reopen the installed PWA.
4. The app must open.
5. Device name, assigned range and next badge must all still be there.
6. Reconnect.
7. Confirm **Online** and **Synced** again.

> **Do not issue a real production badge merely to prove offline loading
> works.** Opening the app is the evidence. Issuing a badge consumes a real
> number from the real range.

---

## Smoke-testing badge issuance

**Do not smoke-test issuance with real event badge numbers unless you have a
cleanup and reconciliation plan agreed in advance.**

A completed registration consumes a number from this device's range, writes a
row to Badge Register, and advances `nextBadge`. None of that is undone by
deleting a spreadsheet row, and there is no reset control — by design.

If you need to prove issuance end to end, do it on a device configured with a
**designated non-event test range**, and provision that device again for the
real event afterwards. Do not "borrow" numbers from a desk's event range.

---

## What provisioning must never do

- never clear site data, browser data or IndexedDB on a provisioned device
- never reset `nextBadge`
- never reconfigure a device that already holds registrations
- never give two devices overlapping ranges
- never move a badge stack between configured devices casually

Device Setup itself refuses to run on a device that already holds registrations
or queued sync rows. If you see that message, the device needs reconciliation,
not another attempt.
