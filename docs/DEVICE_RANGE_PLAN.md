# Device Range Plan

The central record of which physical badge range belongs to which registration
device.

**This is a human operational artifact.** The application never reads it, never
writes it and does not own it. Keep it wherever the organizer will actually look
during setup — a tab in the event spreadsheet named `Device Range Plan` works
well, and the sync server ignores every tab except *Badge Register* and
*Held Registrations*.

---

## Which devices need a row

**Only devices that will hand out badges.**

Every event device is *registered* — it gets a name and an id — but a prize
desk or a dandiya desk owns no badge range and needs no row here. Registering a
device does not make it a badge distributor.

## The plan

Fill one row per physical device while provisioning it.

| Device / Desk | Device ID | Range Start | Range End | Badge Count | Physical Stack Confirmed | PWA Installed | Persistent Storage | Online + Synced Check | Notes |
|---|---|---|---|---|---|---|---|---|---|
| Registration Desk A | | 1 | 250 | 250 | ☐ | ☐ | ☐ | ☐ | |
| Registration Desk B | | 251 | 500 | 250 | ☐ | ☐ | ☐ | ☐ | |
| Registration Desk C | | 501 | 750 | 250 | ☐ | ☐ | ☐ | ☐ | |
| *(Reserve — unassigned)* | — | 751 | 800 | 50 | ☐ | — | — | — | Not configured on any device |

**Badge Count = Range End − Range Start + 1.**

The **Device ID** is copied from **Device Readiness** on the device itself,
after Device Setup. It is not a secret, and it is not typed by anyone — the app
generates it once.

The ranges above are an EXAMPLE. Nothing in the application hard-codes them.

---

## Rules

- **Ranges must not overlap.** This is the entire duplicate-prevention
  mechanism. Two desks sharing a number will hand the same badge to two people.
- **Gaps are allowed.** A range does not have to start where the previous one
  ended.
- **Ranges do not need to be equal sizes.** A busy gate can be given more.
- **A badge number belongs to at most one active device.**
- **The software range and the physical stack must match exactly.** The
  application cannot verify this; only the person placing the badges can.
- **Never move a physical stack to another configured device casually.** That
  device has its own range and will keep issuing from it.
- **Never reuse a range from a broken or offline device without
  reconciliation.** That device may hold registrations that have not synced
  yet, and its badges may already be in attendees' hands.
- **Never reset `nextBadge` during the event.**
- **A Device ID identifies the browser installation, not the person.** Swapping
  operators does not change it; reinstalling or clearing site data does.
- **Never clear browser or site data during the event.** That destroys the local
  device identity, its range, and any registration not yet synchronized.
- **Registration and badge assignment are separate steps.** A device is
  registered at `/device-registration`; a badge range is assigned at
  `/badge-registration`, where the physical-stack confirmation also belongs.

---

## Reserve range

Where enough physical badges exist, keep a **reserve range assigned to no
device**.

```
Desk A     #001–#250
Desk B     #251–#500
Desk C     #501–#750
Reserve    #751–#800   ← not configured anywhere
```

A reserve gives the organizer somewhere to go if a desk exhausts its range
early, without having to take numbers from a desk that is still working.

### Handing the reserve out — badge refill

Since Phase D2.1 a desk takes more badges by **refill**: its existing range is
extended upward and contiguously, at `/device-login`. The first badge of the
refill is derived from the desk's current last badge and **cannot be typed**.

So the reserve is handed out **from the bottom up, to the desk whose range the
reserve follows**. With the plan above, #751 can only go to Desk C:

```
Desk C     #501–#750  →  refill through #800  →  #501–#800
Reserve    (consumed)
```

Giving #751–#800 to Desk A is not expressible, and must not be attempted by
editing a number: a desk's range start never moves, because badges already
issued from it would then belong to numbers it no longer owns.

Plan the reserve as a **single block above every assigned range**, and record
each desk's new last badge here after every refill. A refill does not change
the desk's next badge, so a desk part-way through its range can be topped up
before it runs out.

Releasing, shrinking or transferring a range between desks is still **not**
something the application can do, and it is not a matter of editing a number:
the safe procedure has to account for badges already issued and rows not yet
synced.

---

## Physical labelling

Label every device visibly, and label the badge stack beside it identically:

```
Registration Desk A
BADGES #001–#250
```

Before the event opens, check the physical label against what the app shows —
the device name on screen, the assigned range in **Device Readiness**, and the
first badge in the stack against **Next badge**. All four must agree.
