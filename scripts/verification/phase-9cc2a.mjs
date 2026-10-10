/**
 * Phase 9C-C2A verification — adopting a preassigned central badge range into
 * local badge state.
 *
 * Run with:  pnpm verify:9cc2a
 *
 * It NEVER connects to Neon and makes no HTTP request. The adoption domain and
 * the EXISTING issuance domain both run against the stand-in Dexie, so the
 * safety matrix and the issuance regression are observed rather than asserted
 * from source.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HERE = import.meta.dirname
const root = resolve(HERE, '../..')

if (!existsSync(join(root, 'dist/index.html'))) {
  console.error('This suite inspects the production build. Run `pnpm build` first.')
  process.exit(1)
}

let fails = 0
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) { fails++; console.log(`FAIL ${label}\n     got  ${String(JSON.stringify(actual))}\n     want ${String(JSON.stringify(expected))}`) }
  else console.log(`ok   ${label.padEnd(58)} ${String(JSON.stringify(actual)).slice(0, 38)}`)
}

const read = (p) => readFileSync(join(root, p), 'utf8')
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const jiti = createJiti(import.meta.url, {
  alias: { '@/db/database': `${HERE}/fake-db.mjs`, '@': `${root}/src` },
  interopDefault: true,
})
const adoption = await jiti.import(`${root}/src/db/central-badge-range.ts`)
const enrollment = await jiti.import(`${root}/src/db/central-enrollment.ts`)
const issuance = await jiti.import(`${root}/src/db/registrations.ts`)
const deviceDb = await jiti.import(`${root}/src/db/device.ts`)
const { state } = await import('./fake-db.mjs')

const CENTRAL_DEVICE = 'dddddddd-1111-4111-8111-dddddddddddd'
const CENTRAL_EVENT = 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee'
const OTHER_DEVICE = 'dddddddd-2222-4222-8222-dddddddddddd'
const LOCAL_DEVICE = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa'
const ASSIGNED_AT = '2026-09-02T00:00:00.000Z'

/** The real Phase 7 config shape, with no badge range configured. */
const LOCAL_BASE = {
  id: 'event', eventName: 'Navaratri 2026', currency: 'INR', amount: 20,
  timezone: 'Asia/Kolkata', badgeStart: 1, nextBadge: 1,
  deviceId: LOCAL_DEVICE, deviceName: 'Local Desk A',
  deviceConfiguredAt: '2026-09-01T00:00:00.000Z',
  upiId: 'organizer@upi', payeeName: 'Organizer', updatedAt: '2026-09-01T02:00:00.000Z',
}
const LOCAL_FIELDS = ['deviceId', 'deviceName', 'deviceConfiguredAt', 'eventName',
  'currency', 'amount', 'timezone', 'upiId', 'payeeName']
const localSnapshot = (config) =>
  Object.fromEntries(LOCAL_FIELDS.map((field) => [field, config?.[field]]))

const context = (over = {}) => ({
  device: {
    id: CENTRAL_DEVICE, eventId: CENTRAL_EVENT, name: 'Registration Desk A',
    loginName: 'desk-a', attributes: ['registration'], lastSeenAt: null,
    ...(over.device ?? {}),
  },
  event: {
    id: CENTRAL_EVENT, slug: 'navaratri-2026', name: 'Navaratri 2026',
    timezone: 'Asia/Kolkata',
  },
  activeBadgeRange: over.activeBadgeRange === undefined
    ? { rangeStart: 1, rangeEnd: 200, assignedAt: ASSIGNED_AT }
    : over.activeBadgeRange,
})

const seed = (config, completedBadges = 0, heldCount = 0) => {
  state.config = config === null ? null : { ...config }
  state.registrations = new Map()
  state.outbox = new Map()

  for (let index = 0; index < completedBadges; index += 1) {
    state.registrations.set(`c${String(index)}`, {
      id: `c${String(index)}`, status: 'completed', badgeNumber: index + 1,
      name: `Attendee ${String(index)}`, phone: `90000000${String(index).padStart(2, '0')}`,
      normalizedName: `attendee ${String(index)}`, age: 20, gender: 'Male', amount: 20,
      paymentStatus: 'confirmed', paymentMethod: 'cash',
      createdAt: 'T', updatedAt: 'T', completedAt: 'T',
    })
  }

  for (let index = 0; index < heldCount; index += 1) {
    state.registrations.set(`h${String(index)}`, {
      id: `h${String(index)}`, status: 'held', paymentStatus: 'pending',
      name: `Held ${String(index)}`, phone: `91000000${String(index).padStart(2, '0')}`,
      normalizedName: `held ${String(index)}`, age: 20, gender: 'Female', amount: 20,
      createdAt: 'T', updatedAt: 'T', heldAt: 'T',
    })
  }
}

const adopt = (over = {}, confirmed = true) =>
  adoption.adoptCentralBadgeRange({
    context: context(over), physicalStackConfirmed: confirmed,
  })

/** Runs an adoption and reports whether the config row changed at all. */
const attempt = async (config, { over = {}, completed = 0, held = 0, confirmed = true } = {}) => {
  seed(config, completed, held)
  const before = JSON.stringify(state.config)
  const result = await adopt(over, confirmed)

  return { result, mutated: JSON.stringify(state.config) !== before, config: state.config }
}

console.log('=== 1-3. BLOCKED BEFORE ANYTHING IS WRITTEN ===')
const noIdentity = await attempt({ ...LOCAL_BASE, deviceId: undefined, deviceName: undefined })
check('missing local identity is blocked', noIdentity.result.outcome, 'device-not-registered')
check('  and nothing is written', noIdentity.mutated, false)
check('  no local UUID is invented',
  [noIdentity.config.deviceId, noIdentity.config.deviceName], [undefined, undefined])
check('  the central UUID is never copied into it',
  noIdentity.config.deviceId === CENTRAL_DEVICE, false)

const noPermission = await attempt(LOCAL_BASE, { over: { device: { attributes: ['prizes'] } } })
check('a prize-only device cannot adopt',
  noPermission.result.outcome, 'registration-not-permitted')
check('  and nothing is written', noPermission.mutated, false)
const noAttributes = await attempt(LOCAL_BASE, { over: { device: { attributes: [] } } })
check('  nor one with no attributes', noAttributes.result.outcome, 'registration-not-permitted')

const noAssignment = await attempt(LOCAL_BASE, { over: { activeBadgeRange: null } })
check('no central assignment is blocked', noAssignment.result.outcome, 'no-central-assignment')
check('  and nothing is written', noAssignment.mutated, false)
for (const [label, range] of [
  ['a zero start', { rangeStart: 0, rangeEnd: 5, assignedAt: ASSIGNED_AT }],
  ['a reversed range', { rangeStart: 9, rangeEnd: 2, assignedAt: ASSIGNED_AT }],
  ['a fractional range', { rangeStart: 1.5, rangeEnd: 5, assignedAt: ASSIGNED_AT }],
]) {
  const malformed = await attempt(LOCAL_BASE, { over: { activeBadgeRange: range } })
  check(`  ${label} is refused`, malformed.result.outcome, 'no-central-assignment')
}

const missingConfig = await attempt(null)
check('a missing config row is reported', missingConfig.result.outcome, 'missing-config')

console.log('\n=== 4-15. FRESH ADOPTION ===')
const unconfirmed = await attempt(LOCAL_BASE, { confirmed: false })
check('an unconfirmed physical stack blocks adoption',
  unconfirmed.result.outcome, 'stack-not-confirmed')
check('  and writes nothing', unconfirmed.mutated, false)

const fresh = await attempt(LOCAL_BASE)
check('a fresh compatible browser adopts', fresh.result.outcome, 'adopted')
check('  badgeStart is the exact central start', fresh.config.badgeStart, 1)
check('  badgeEnd is the exact central end', fresh.config.badgeEnd, 200)
check('  nextBadge follows the canonical allocator (= badgeStart)',
  fresh.config.nextBadge, fresh.config.badgeStart)
check('  the local range is now usable by the existing model',
  deviceDb.isBadgeDistributionConfigured(fresh.config), true)
check('  badgeConfiguredAt records the deliberate act',
  typeof fresh.config.badgeConfiguredAt, 'string')

const binding = fresh.config.centralBadgeRangeBinding
check('the binding records the central device', binding.deviceId, CENTRAL_DEVICE)
check('  and the central event', binding.eventId, CENTRAL_EVENT)
check('  the exact assigned range',
  [binding.rangeStart, binding.rangeEnd], [1, 200])
check('  the central assignedAt, unaltered', binding.assignedAt, ASSIGNED_AT)
check('  and a local adoptedAt', /^\d{4}-\d{2}-\d{2}T.*Z$/.test(binding.adoptedAt), true)
check('  its fields are EXACTLY the approved set',
  Object.keys(binding).sort(),
  ['adoptedAt', 'assignedAt', 'deviceId', 'eventId', 'rangeEnd', 'rangeStart'])
check('  it is NOT an allocator: no nextBadge inside it',
  /nextBadge/.test(JSON.stringify(binding)), false)
check('  and carries no credential',
  /password|token|cookie|sessionVersion|salt|scrypt/i.test(JSON.stringify(binding)), false)

console.log('  -- the binding is separate from the enrollment --')
seed(LOCAL_BASE)
await enrollment.saveCentralDeviceEnrollment(context())
await adopt()
check('enrollment and binding coexist as separate fields',
  [state.config.centralDeviceEnrollment !== undefined,
   state.config.centralBadgeRangeBinding !== undefined], [true, true])
check('  the enrollment still holds only its seven C1 fields',
  Object.keys(state.config.centralDeviceEnrollment).sort(),
  ['attributes', 'deviceId', 'deviceName', 'eventId', 'eventSlug', 'loginName', 'verifiedAt'])
check('  activeBadgeRange was never copied into it',
  /activeBadgeRange|rangeStart|rangeEnd/.test(JSON.stringify(state.config.centralDeviceEnrollment)), false)

console.log('\n=== 16-23. EXACT-MATCH MIGRATION ===')
const EXISTING = {
  ...LOCAL_BASE, badgeEnd: 200, nextBadge: 37,
  badgeConfiguredAt: '2026-09-05T00:00:00.000Z',
}
const aligned = await attempt(EXISTING, { completed: 36 })
check('an identical local range aligns rather than resetting',
  aligned.result.outcome, 'aligned')
check('  the existing coherent nextBadge is PRESERVED', aligned.config.nextBadge, 37)
check('  the local range is untouched',
  [aligned.config.badgeStart, aligned.config.badgeEnd], [1, 200])
check('  the existing badgeConfiguredAt is preserved',
  aligned.config.badgeConfiguredAt, '2026-09-05T00:00:00.000Z')
check('  every issued registration survives', state.registrations.size, 36)
check('  and the binding is added',
  [aligned.config.centralBadgeRangeBinding.deviceId,
   aligned.config.centralBadgeRangeBinding.rangeEnd], [CENTRAL_DEVICE, 200])

const firstAdoptedAt = aligned.config.centralBadgeRangeBinding.adoptedAt
await new Promise((done) => setTimeout(done, 5))
const repeat = await adopt()
check('a repeated adoption is idempotent', repeat.outcome, 'already-adopted')
check('  nextBadge is not touched', state.config.nextBadge, 37)
check('  and adoptedAt is NOT churned',
  state.config.centralBadgeRangeBinding.adoptedAt, firstAdoptedAt)

console.log('\n=== 24-32. CONFLICTS FAIL CLOSED ===')
for (const [label, localOver, expected] of [
  ['a different range start', { badgeStart: 2, badgeEnd: 200, nextBadge: 2 }, 'range-conflict'],
  ['a different range end', { badgeEnd: 250, nextBadge: 1 }, 'range-conflict'],
  ['a local range larger than central', { badgeEnd: 400, nextBadge: 1 }, 'range-conflict'],
  ['a local range inside central', { badgeStart: 50, badgeEnd: 100, nextBadge: 50 }, 'range-conflict'],
  ['a local range elsewhere entirely', { badgeStart: 201, badgeEnd: 300, nextBadge: 201 }, 'range-conflict'],
  ['a nextBadge above the range', { badgeEnd: 200, nextBadge: 500 }, 'incoherent-next-badge'],
  ['a nextBadge below the range', { badgeStart: 10, badgeEnd: 200, nextBadge: 1 }, 'range-conflict'],
  ['a malformed local range', { badgeStart: 9, badgeEnd: 2, nextBadge: 9 }, 'incoherent-next-badge'],
]) {
  const conflict = await attempt({ ...LOCAL_BASE, ...localOver })
  check(`${label} is blocked`, conflict.result.outcome, expected)
  check(`  and mutates nothing`, conflict.mutated, false)
}

const issuedNoRange = await attempt(LOCAL_BASE, { completed: 3 })
check('issued badges with no configured range are blocked',
  [issuedNoRange.result.outcome, issuedNoRange.result.issuedCount],
  ['issued-badges-without-range', 3])
check('  and mutate nothing', issuedNoRange.mutated, false)
check('  held registrations alone do NOT block',
  (await attempt(LOCAL_BASE, { held: 4 })).result.outcome, 'adopted')

const otherBinding = await attempt({
  ...LOCAL_BASE, badgeEnd: 200, nextBadge: 1,
  centralBadgeRangeBinding: {
    deviceId: OTHER_DEVICE, eventId: CENTRAL_EVENT, rangeStart: 1, rangeEnd: 200,
    assignedAt: ASSIGNED_AT, adoptedAt: 'EARLIER',
  },
})
check('a binding owned by another central device is blocked',
  [otherBinding.result.outcome, otherBinding.result.attemptedDeviceId],
  ['binding-device-conflict', CENTRAL_DEVICE])
check('  and mutates nothing', otherBinding.mutated, false)

const changedRange = await attempt({
  ...LOCAL_BASE, badgeEnd: 200, nextBadge: 1,
  centralBadgeRangeBinding: {
    deviceId: CENTRAL_DEVICE, eventId: CENTRAL_EVENT, rangeStart: 1, rangeEnd: 150,
    assignedAt: ASSIGNED_AT, adoptedAt: 'EARLIER',
  },
})
check('a central range that no longer matches the binding is blocked',
  changedRange.result.outcome, 'central-range-changed')
check('  and mutates nothing', changedRange.mutated, false)
check('  the local range is left exactly as it was',
  [changedRange.config.badgeStart, changedRange.config.badgeEnd, changedRange.config.nextBadge],
  [1, 200, 1])

console.log('\n=== 33-41. LOCAL STATE PRESERVATION ===')
seed(LOCAL_BASE, 0, 2)
const baseline = localSnapshot(state.config)
const outboxBefore = state.outbox.size
await adopt()
check('the local device identity is unchanged', localSnapshot(state.config), baseline)
check('  local deviceId is NOT the central one',
  [state.config.deviceId, state.config.deviceId === CENTRAL_DEVICE], [LOCAL_DEVICE, false])
check('  local deviceName is NOT the central one',
  [state.config.deviceName, state.config.deviceName === 'Registration Desk A'],
  ['Local Desk A', false])
check('  held registrations are untouched',
  [...state.registrations.values()].filter((row) => row.status === 'held').length, 2)
check('  no registration gained or lost a badge number',
  [...state.registrations.values()].filter((row) => row.badgeNumber !== undefined).length, 0)
check('  the outbox is untouched', state.outbox.size, outboxBefore)
check('the adoption transaction never writes a registration or outbox row',
  /db\.registrations\.(put|add|update|delete)|db\.outbox\./
    .test(stripComments(read('src/db/central-badge-range.ts'))), false)
check('  it only counts them', /db\.registrations\s*\n?\s*\.where\('status'\)/
  .test(read('src/db/central-badge-range.ts')), true)
/**
 * ONE TRANSACTION PER WRITER. Phase D2.1 added the contiguous extension as a
 * second writer in this module, so a bare count of one no longer describes
 * it — and a bare count of two would be satisfied by two transactions inside
 * `adoptCentralBadgeRange`. Each writer is therefore named and checked to
 * open its own.
 */
const RANGE_WRITERS = ['adoptCentralBadgeRange', 'extendLocalBadgeRange']
const rangeDomain = stripComments(read('src/db/central-badge-range.ts'))

check('  and each writer commits in ONE transaction of its own',
  RANGE_WRITERS.map((writer) => {
    const body = rangeDomain.slice(rangeDomain.indexOf(`export const ${writer} = async`))

    return /^[\s\S]{0,400}db\.transaction\(/.test(body)
  }), RANGE_WRITERS.map(() => true))
check('    and there are exactly that many',
  [...rangeDomain.matchAll(/db\.transaction\(/g)].length, RANGE_WRITERS.length)
/**
 * Three config writes: adoption's fresh path, adoption's alignment path, and
 * the extension. Each is a single `put` inside its own transaction.
 */
check('  with one config write per outcome',
  [...rangeDomain.matchAll(/db\.config\.put\(/g)].length, 3)

const dexie = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION = 1/.test(dexie), true)
check('  stores unchanged',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((entry) => entry.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and this phase did not touch the schema',
  /centralBadgeRangeBinding/.test(dexie), false)

console.log('\n=== 57-62. LOGOUT AND CLEAR DO NOT DESTROY BADGE STATE ===')
seed(LOCAL_BASE)
await enrollment.saveCentralDeviceEnrollment(context())
await adopt()
const adoptedState = {
  badgeStart: state.config.badgeStart, badgeEnd: state.config.badgeEnd,
  nextBadge: state.config.nextBadge, binding: state.config.centralBadgeRangeBinding,
}
await enrollment.clearCentralDeviceEnrollment()
check('clearing the central enrollment removes only the enrollment',
  state.config.centralDeviceEnrollment, undefined)
check('  the adopted badge range survives',
  [state.config.badgeStart, state.config.badgeEnd], [adoptedState.badgeStart, adoptedState.badgeEnd])
check('  nextBadge survives', state.config.nextBadge, adoptedState.nextBadge)
check('  and the binding survives',
  state.config.centralBadgeRangeBinding, adoptedState.binding)
check('the enrollment writers never name a badge field',
  /badgeStart|badgeEnd|nextBadge|centralBadgeRangeBinding/
    .test(stripComments(read('src/db/central-enrollment.ts'))), false)

const panelSource = stripComments(read('src/components/device-auth/device-enrollment-panel.tsx'))
check('sign-out clears the enrollment but no badge state',
  /logoutDevice\(\)[\s\S]{0,400}clearCentralDeviceEnrollment\(\)/.test(panelSource), true)
check('  and never clears the binding or the range',
  /clearCentralBadgeRange|badgeStart:|nextBadge:|delete .*centralBadgeRangeBinding/
    .test(panelSource), false)
const panelRaw = read('src/components/device-auth/device-enrollment-panel.tsx')
check('clearing the identity warns when a binding exists',
  [panelRaw.includes('This browser has an adopted central badge range'),
   panelRaw.includes('Clearing the identity does not remove that local badge range'),
   /state\.adoptedRange === null \? null :/.test(panelRaw)], [true, true, true])

console.log('\n=== 55-56, 63-67. NO AUTOMATIC OR OFFLINE ADOPTION ===')
check('adoption is called from exactly one place',
  [...panelSource.matchAll(/adoptCentralBadgeRange\(/g)].length, 1)
check('  and only from the explicit operator action',
  /const adopt = async \(physicalStackConfirmed: boolean\)/.test(panelSource), true)
check('  which requires an authenticated state',
  /state\.phase !== 'authenticated'[\s\S]{0,60}return/.test(panelSource), true)
check('verifying a session only READS the plan',
  [/readCentralBadgeRangePlan\(context\)/.test(panelSource),
   /saved\.outcome === 'saved'[\s\S]{0,300}adoptCentralBadgeRange/.test(panelSource)],
  [true, false])
/**
 * Sliced to the helper's OWN body. Phase D2.1 appended the refill section
 * after it, so a slice that ran to the end of the file would read the
 * extension's transaction as the read helper's and report the opposite of
 * the truth.
 */
check('  the read helper writes nothing',
  (() => {
    const from = rangeDomain.indexOf('export const readCentralBadgeRangePlan')
    const next = rangeDomain.indexOf('export ', from + 1)

    return from === -1
      ? 'the read helper is missing'
      : /put\(|delete\(|transaction\(/.test(
          rangeDomain.slice(from, next === -1 ? undefined : next),
        )
  })(),
  false)
check('the offline branches cannot reach adoption',
  /'last-verified'[\s\S]{0,600}adoptCentralBadgeRange/.test(panelSource), false)
check('  a cached enrollment alone never carries an assignment',
  /activeBadgeRange/.test(stripComments(read('src/db/central-enrollment.ts'))), false)
check('no central write is reachable from the adoption domain',
  /POST|PATCH|PUT|DELETE|fetch\(/.test(
    stripComments(read('src/db/central-badge-range.ts'))), false)
/**
 * C2B added a self-claim, and this is where its boundary is pinned: the
 * endpoint is named in exactly one client module, and the adoption domain —
 * the thing that writes local badge state — still does not know it exists.
 */
check('  the claim endpoint is named in exactly one client module',
  walk(join(root, 'src'))
    .filter((file) => /device-badge-claim/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), ['src/device-auth/device-api.ts'])

console.log('\n=== 68-72. ISSUANCE REGRESSION (existing domain code) ===')
seed(LOCAL_BASE)
await adopt()
const issue = (name, phone) => issuance.issueBadge({
  registrationId: null, phone, name, age: 20, gender: 'Male', paymentMethod: 'cash',
})
const first = await issue('One', '9000000001')
check('the first issued badge is the adopted start',
  [first.outcome, first.registration.badgeNumber], ['issued', 1])
check('  nextBadge advanced by exactly one', state.config.nextBadge, 2)
const second = await issue('Two', '9000000002')
check('  the second follows it',
  [second.outcome, second.registration.badgeNumber, state.config.nextBadge], ['issued', 2, 3])

state.config.nextBadge = 200
const last = await issue('Last', '9000000003')
check('the final badge in the range issues',
  [last.outcome, last.registration.badgeNumber, state.config.nextBadge], ['issued', 200, 201])
const past = await issue('Over', '9000000004')
check('  and exhaustion behaves exactly as before', past.outcome, 'badge-range-exhausted')
check('  the binding is untouched by issuance',
  state.config.centralBadgeRangeBinding.rangeEnd, 200)
check('issuance makes no network call',
  /fetch\(|\/api\//.test(stripComments(read('src/db/registrations.ts'))), false)
check('  and reads no central module',
  /central-badge-range|device-auth|centralBadgeRangeBinding/
    .test(read('src/db/registrations.ts')), false)

console.log('\n=== 42-54. THE DEVICE LOGIN UI ===')
/**
 * Phase 9C-C2B split this section into three components: the adoption states
 * stayed here, every REFUSAL moved into the shared block that the self-claim
 * section also renders, and the claim surface became its own file. The
 * behaviour asserted below is unchanged; only where it lives has moved.
 */
const setupSource = read('src/components/device-auth/local-badge-setup.tsx')
const blockSource = read('src/components/device-auth/adoption-block.tsx')
const claimSource = read('src/components/device-auth/badge-range-claim.tsx')
check('local badge state has its own section',
  /Local Badge Setup/.test(setupSource), true)
check('  a fresh range offers adoption',
  [/Not configured/.test(setupSource),
   /can adopt the central assignment/.test(setupSource)], [true, true])
check('  the action is explicitly worded, never "Continue"',
  [/Set Up \$\{range\} On This Device/.test(setupSource),
   /^\s*(Continue|Confirm|Use)\s*$/m.test(setupSource)], [true, false])
check('  no adoption control without the registration attribute',
  /registration-not-permitted'[\s\S]{0,400}Not available/.test(blockSource), true)
check('  nor with no central assignment',
  [/no-central-assignment'[\s\S]{0,200}<BadgeRangeClaim/.test(setupSource),
   /Not assigned/.test(claimSource)], [true, true])
/**
 * Phase D2 retired `/device-registration`, so this refusal no longer sends
 * anyone there. Device setup now happens in the Identity section of the SAME
 * page, and the refusal says so rather than linking away.
 */
check('  a missing local identity points at Device setup, on this page',
  [/ROUTES\.deviceRegistration/.test(blockSource),
   /Device setup required/.test(blockSource),
   /Device Identity section above/.test(blockSource)], [false, true, true])
check('the confirmation requires the physical stack',
  [/I have physical badges \{range\} at this device\./.test(setupSource),
   /disabled=\{!confirmed \|\| isBusy\}/.test(setupSource)], [true, true])
check('  and resets on every opening, never persisting',
  [/setConfirmed\(false\)/.test(setupSource),
   /localStorage|sessionStorage/.test(setupSource)], [true, false])
check('the dialog shows the range, the count and the next badge',
  [/Central assignment/.test(setupSource), /Badge count/.test(setupSource),
   /Local next badge after setup/.test(setupSource),
   /formatBadgeRange/.test(setupSource)], [true, true, true, true])
check('  and warns that issuance becomes local and offline',
  /issue badges from this range locally,\s*\n?\s*including while offline/.test(setupSource), true)
check('an exact match shows "Ranges match" and the current next badge',
  [/Ranges match/.test(setupSource), /Next badge/.test(setupSource),
   /Link Existing Range To Central Assignment/.test(setupSource)], [true, true, true])
check('a mismatch shows BOTH ranges', /plan\.local\.rangeStart/.test(blockSource), true)
check('  and offers no override',
  /Use central anyway|Override|Force|Replace range|Fix range/i
    .test(stripComments(setupSource + blockSource + claimSource)), false)
check('a successful adoption shows the aligned binding',
  /Aligned with central assignment/.test(setupSource), true)
check('the summary is re-read from the committed row',
  /const badge = await readCentralBadgeRangePlan/.test(panelSource), true)
check('  so a reload shows the adopted state without re-adopting',
  [...panelSource.matchAll(/readCentralBadgeRangePlan\(/g)].length >= 2, true)

console.log('\n=== 34, 73-78. NOTHING ELSE MOVED ===')
/**
 * Phase D2 removed Operator Access entirely, so what this guarded — that
 * C2A moved no route policy — is now stated against the policy that
 * replaced it: every event module answers to the device gate, and the
 * retired route answers to nothing.
 */
check('every event route is gated by the device, and no operator gate survives',
  [/OperatorAccessGate/.test(read('src/components/app-router.tsx')),
   /<EventAccessGate module="/.test(read('src/components/app-router.tsx'))], [false, true])
check('  and /device-registration accepts no grant at all',
  /ROUTES\.deviceRegistration[\s\S]{0,200}EventAccessGate/
    .test(stripComments(read('src/components/app-router.tsx'))), false)
check('  and no device gate was added',
  /Device(Access|Session|Auth)Gate/.test(
    stripComments(read('src/components/event-app-gate.tsx')) +
    stripComments(read('src/components/app-router.tsx'))), false)
/**
 * Phase 9C-C3B reads the binding when authorizing badge registration — but
 * only ever to BLOCK. It is provenance, so it can prove that local badge
 * ownership DISAGREES with central and must never, on its own, prove that
 * anything is allowed.
 */
check('  the binding is read in exactly the expected places',
  walk(join(root, 'src'))
    .filter((file) => !/central-badge-range|local-badge-setup|device-enrollment-panel|db\/types/
      .test(file))
    .filter((file) => /centralBadgeRangeBinding/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')), ['src/device-auth/event-authorization.ts'])
check('  and there it can only ever refuse',
  (() => {
    const domain = stripComments(read('src/device-auth/event-authorization.ts'))
    const checker = domain.slice(
      domain.indexOf('const checkBadgeOwnership'),
      domain.indexOf('export const hasLocalBadgeOwnership'))
    const ownership = domain.slice(
      domain.indexOf('export const hasLocalBadgeOwnership'),
      domain.indexOf('const localRangeOf'))
    return [
      checker.includes('centralBadgeRangeBinding'),
      // Everything it can return is a conflict or `null`; it cannot authorize.
      /BadgeSafetyConflict \| null/.test(checker),
      /authorized/.test(checker),
      /**
       * Phase D1 added the SECOND and last reader: `hasLocalBadgeOwnership`,
       * a boolean predicate that decides whether the badge check APPLIES.
       * It is named here rather than counted loosely, and it is held to the
       * same rule — it is not consulted when a module is authorized.
       */
      domain.split('centralBadgeRangeBinding').length - 1,
      ownership.includes('centralBadgeRangeBinding'),
      /: boolean =>/.test(ownership),
      /authorized|ModuleAuthorization|BadgeSafetyConflict/.test(ownership),
      /hasLocalBadgeOwnership/.test(
        domain.slice(domain.indexOf('const authorizeEventModule'))),
    ]
  })(), [true, true, false, 2, true, true, false, false])

const functionChecker = await import('../vercel-function-typecheck.mjs')
const budget = functionChecker.checkFunctionBudget()
// C2B added exactly one Function; C2A's own guarantees below are unchanged.
// Phase D2 deleted the three Operator Functions; C2A added none.
check('the Function inventory is exactly eight', budget.actual.length, 8)
check('  with four slots of headroom',
  functionChecker.HOBBY_FUNCTION_LIMIT - budget.actual.length, 4)
check('  and nothing unexpected', budget.problems, [])
check('the only device range endpoint is the C2B self-claim',
  ['device-badge-assignment.ts', 'device-claim-range.ts', 'device-range.ts',
   'device-badge-claim.ts']
    .filter((file) => existsSync(join(root, 'api', file))), ['device-badge-claim.ts'])
check('device auth GET remains read-only',
  /db\.insert|db\.update|db\.delete|badgeAssignments/
    .test(stripComments(read('api/device-auth.ts'))), false)
check('  and its session loader writes nothing but last_seen_at on login',
  [...stripComments(read('server/device-auth/authenticate.ts'))
    .matchAll(/\.update\(/g)].length, 1)
/**
 * C2A's rule was "Admin is the only central assignment writer". C2B adds
 * Device self-claim, so the rule becomes the stronger one: there is exactly
 * ONE place that inserts a `badge_assignments` row, and both realms go
 * through it.
 */
check('exactly one module inserts a central badge assignment',
  walk(join(root, 'server'))
    .filter((file) => /insert\(badgeAssignments\)/.test(stripComments(readFileSync(file, 'utf8'))))
    .map((file) => file.replace(`${root}/`, '')),
  ['server/badge-assignments/reserve.ts'])
check('  and Admin reserves through it',
  /reserveBadgeRange\(/.test(stripComments(read('server/admin/registry.ts'))), true)

check('NO migration was added',
  readdirSync(join(root, 'drizzle')).filter((file) => file.endsWith('.sql')).sort(),
  ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
check('  and no server file knows about the binding',
  /centralBadgeRangeBinding/.test(
    walk(join(root, 'server')).map((file) => readFileSync(file, 'utf8')).join('\n')), false)
check('Google Sheet ranges unchanged',
  [/A1:N/.test(read('server/sync/sheet-contract.ts')),
   /A1:M/.test(read('server/sync/sheet-contract.ts'))], [true, true])
/**
 * 9C-C3B adds a SECOND sync realm: a live device session. The operator path
 * is unchanged and tried first; the signed offline lease is accepted by
 * nothing.
 */
check('sync keeps the operator realm and never takes the offline lease',
  [/operator/i.test(read('api/sync-registration.ts')),
   /verifyOfflineAuthorization|offline-lease|centralDeviceOfflineAuthorization/
     .test(stripComments(read('api/sync-registration.ts')))], [true, false])

const manifest = JSON.parse(read('package.json'))
check('verify:9cc2a is registered',
  manifest.scripts['verify:9cc2a'], 'node scripts/verification/phase-9cc2a.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9cc2a'), true)
check('no dependency was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /zod|redux|zustand|jotai|react-query|tanstack|swr/i.test(name)), [])

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
