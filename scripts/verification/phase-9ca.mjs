/**
 * Phase 9C-A verification — device credentials foundation and Admin
 * provisioning.
 *
 * Run with:  pnpm verify:9ca
 *
 * It NEVER connects to Neon. The hashing service is exercised for real; the
 * registry runs against the stand-in database from Phase 9B; the Admin UI is
 * rendered to markup.
 *
 * Requires `pnpm build` first.
 */
import { createJiti } from 'jiti'
import { spawnSync } from 'node:child_process'
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
const walkSource = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walkSource(full, out)
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

const jiti = createJiti(import.meta.url, { alias: { '@': `${root}/src` }, interopDefault: true })
const password = await jiti.import(`${root}/server/device-auth/password.ts`)
const policy = await jiti.import(`${root}/src/shared/device-password.ts`)
const validation = await jiti.import(`${root}/server/admin/validation.ts`)

console.log('=== 1-18. PASSWORD HASHING ===')
const PLAIN = 'correct horse battery staple'
const hash = await password.hashDevicePassword(PLAIN)

check('a valid password hashes', typeof hash === 'string' && hash.length > 0, true)
check('  the same password verifies true', await password.verifyDevicePassword(PLAIN, hash), true)
check('  a wrong password verifies false',
  await password.verifyDevicePassword('correct horse battery stapl', hash), false)
check('  case is exact', await password.verifyDevicePassword(PLAIN.toUpperCase(), hash), false)
check('  a trailing space is a DIFFERENT password',
  await password.verifyDevicePassword(`${PLAIN} `, hash), false)

const second = await password.hashDevicePassword(PLAIN)
check('two hashes of one password differ (random salt)', hash === second, false)
check('  but both verify', [await password.verifyDevicePassword(PLAIN, hash),
  await password.verifyDevicePassword(PLAIN, second)], [true, true])

console.log('  -- the encoding is self-describing --')
const parts = hash.split('$')
check('the format carries algorithm, version and every parameter',
  [parts.length, parts[0], parts[1], Number(parts[2]), Number(parts[3]), Number(parts[4])],
  [7, 'scrypt', 'v1', 32768, 8, 1])
check('  the documented parameters are the ones used',
  [password.SCRYPT_PARAMETERS.N, password.SCRYPT_PARAMETERS.r, password.SCRYPT_PARAMETERS.p,
   password.SCRYPT_PARAMETERS.keyLength, password.SCRYPT_PARAMETERS.saltLength],
  [32768, 8, 1, 32, 16])
check('  the salt and key are the documented lengths',
  [Buffer.from(parts[5], 'base64url').length, Buffer.from(parts[6], 'base64url').length], [16, 32])
check('  it is NOT a bare salt:hash', /^[^$]*:[^$]*$/.test(hash), false)
check('the plaintext never appears in the encoding',
  (await password.hashDevicePassword('hunter22-passphrase')).includes('hunter22'), false)

console.log('  -- a stored hash is untrusted input --')
const rejects = async (label, stored) =>
  check(`  ${label}`, await password.verifyDevicePassword(PLAIN, stored), false)

await rejects('empty string', '')
await rejects('nonsense', 'nonsense')
await rejects('too few fields', 'scrypt$v1$32768$8$1$AAAA')
await rejects('too many fields', `${hash}$extra`)
await rejects('unsupported algorithm', hash.replace('scrypt$', 'argon2$'))
await rejects('unsupported version', hash.replace('$v1$', '$v2$'))
await rejects('corrupted salt', [parts[0], parts[1], parts[2], parts[3], parts[4], 'AAAA', parts[6]].join('$'))
await rejects('corrupted derived key', [...parts.slice(0, 6), 'AAAA'].join('$'))
await rejects('non-base64url salt', [...parts.slice(0, 5), 'not base64!', parts[6]].join('$'))
await rejects('N is zero', hash.replace('$32768$', '$0$'))
await rejects('N is negative', hash.replace('$32768$', '$-8$'))
await rejects('N is not a power of two', hash.replace('$32768$', '$32767$'))
await rejects('r is zero', `${parts[0]}$${parts[1]}$${parts[2]}$0$${parts.slice(4).join('$')}`)
await rejects('p is zero', `${parts.slice(0, 4).join('$')}$0$${parts.slice(5).join('$')}`)
await rejects('a float N', hash.replace('$32768$', '$3.5$'))
await rejects('a non-numeric N', hash.replace('$32768$', '$abc$'))
await rejects('a non-string hash', 12345)
check('  a non-string password', await password.verifyDevicePassword(12345, hash), false)

console.log('  -- absurd parameters cost nothing --')
const started = Date.now()
const absurd = await password.verifyDevicePassword(PLAIN, 'scrypt$v1$1073741824$1024$16$AAAA$BBBB')
const elapsed = Date.now() - started
check('an enormous N/r is refused', absurd, false)
check('  without doing the work (under 200ms)', elapsed < 200, true)
check('  and the guard is a real bound, not a comment',
  /MAX_SCRYPT_MEMORY_BYTES/.test(stripComments(read('server/device-auth/password.ts'))), true)

console.log('  -- verification never throws for a bad credential --')
let threw = false
try {
  for (const stored of ['', 'x', 'scrypt$v1$$$$$', hash.slice(0, 20)])
    await password.verifyDevicePassword(PLAIN, stored)
} catch { threw = true }
check('malformed input returns false rather than throwing', threw, false)

console.log('\n=== 11-16. PASSWORD POLICY ===')
const lengths = (n) => policy.validateDevicePassword('a'.repeat(n)).ok
check('7 characters rejected', lengths(7), false)
check('8 characters accepted', lengths(8), true)
check('128 characters accepted', lengths(128), true)
check('129 characters rejected', lengths(129), false)
check('the bounds are named constants',
  [policy.DEVICE_PASSWORD_MIN_LENGTH, policy.DEVICE_PASSWORD_MAX_LENGTH], [8, 128])
check('leading and trailing spaces are NOT trimmed',
  policy.validateDevicePassword('  abcdefgh  ').password, '  abcdefgh  ')
check('  a space-only password of 8 counts', policy.validateDevicePassword(' '.repeat(8)).ok, true)
check('  and 7 spaces does not', policy.validateDevicePassword(' '.repeat(7)).ok, false)
check('the value is returned byte for byte',
  policy.validateDevicePassword('Straße-Ünïcode').password, 'Straße-Ünïcode')
check('  no Unicode normalisation',
  policy.validateDevicePassword('éabcdefg').password.length, 9)
check('  no case folding',
  await password.verifyDevicePassword('ABCDEFGH', await password.hashDevicePassword('abcdefgh')), false)
check('a non-string is rejected', [policy.validateDevicePassword(null).ok,
  policy.validateDevicePassword(12345678).ok], [false, false])

console.log('  -- the policy has ONE implementation --')
check('the server reads it from the shared module',
  /from '\.\.\/\.\.\/src\/shared\/device-password\.js'/.test(read('server/device-auth/password.ts')), true)
check('  and so does the Admin validator',
  /from '\.\.\/\.\.\/src\/shared\/device-password\.js'/.test(read('server/admin/validation.ts')), true)
check('  the browser uses the same rules',
  ['src/components/admin/device-dialog.tsx', 'src/components/admin/device-password-dialog.tsx']
    .map((file) => /from '@\/shared\/device-password'/.test(read(file))), [true, true])
check('  the shared module holds no crypto',
  /node:crypto|scrypt|randomBytes|timingSafeEqual/.test(read('src/shared/device-password.ts')), false)

console.log('  -- the pair check --')
const pair = (over) => policy.checkPasswordPair({
  password: 'abcdefgh', confirmPassword: 'abcdefgh', hasLoginName: true, required: false, ...over })
check('a matching pair is accepted', pair({}), { ok: true, password: 'abcdefgh' })
check('  a mismatch is rejected', pair({ confirmPassword: 'abcdefgi' }).ok, false)
check('  a short password is rejected', pair({ password: 'abcdefg', confirmPassword: 'abcdefg' }).ok, false)
check('  no login name is rejected', pair({ hasLoginName: false }).ok, false)
check('  nothing supplied means NO credentials',
  pair({ password: '', confirmPassword: '' }), { ok: true, password: null })
check('  unless credentials are required',
  pair({ password: '', confirmPassword: '', required: true }).ok, false)
check('  a confirmation alone is a half-filled form',
  pair({ password: '' }).ok, false)
check('  confirmation is compared exactly, not trimmed',
  pair({ confirmPassword: 'abcdefgh ' }).ok, false)

console.log('\n=== 19-32. ADMIN CREDENTIAL PROVISIONING ===')
const dbJiti = createJiti(import.meta.url, {
  alias: {
    '../db/client.js': `${HERE}/fake-admin-db.mjs`,
    '../db/schema.js': `${HERE}/fake-drizzle.mjs`,
    'drizzle-orm': `${HERE}/fake-drizzle.mjs`,
    '@': `${root}/src`,
  },
  interopDefault: true,
})
const registry = await dbJiti.import(`${root}/server/admin/registry.ts`)
const fakeDb = await import('./fake-admin-db.mjs')

const create = (over) => validation.parseCreateDeviceInput({
  name: 'Desk A', loginName: 'desk-a', enabled: true, attributes: ['registration'], ...over })

check('a device may be created WITHOUT credentials',
  [create({}).ok, create({}).value.password], [true, null])
check('  which is how inventory is prepared first',
  create({ loginName: null }).ok, true)
check('a password without a login name is REJECTED',
  create({ loginName: null, password: 'abcdefgh', confirmPassword: 'abcdefgh' }).ok, false)
check('  a mismatched confirmation is rejected',
  create({ password: 'abcdefgh', confirmPassword: 'abcdefgi' }).ok, false)
check('  a short password is rejected',
  create({ password: 'abcdefg', confirmPassword: 'abcdefg' }).ok, false)
check('  a valid pair is carried on the create input',
  create({ password: 'abcdefgh', confirmPassword: 'abcdefgh' }).value.password, 'abcdefgh')

const seed = ({ loginName = 'desk-a', passwordHash = null, sessionVersion = 1, enabled = true } = {}) => {
  fakeDb.reset()
  fakeDb.state.devices.set('d1', {
    id: 'd1', eventId: 'e1', name: 'Desk A', loginName, enabled, passwordHash, sessionVersion,
    lastSeenAt: null, createdAt: new Date('2026-01-01T00:00:00.000Z'),
  })
  fakeDb.state.attributes.push({ deviceId: 'd1', attribute: 'registration' })
  fakeDb.state.applied = []
}
const stored = () => fakeDb.state.devices.get('d1')

console.log('  -- create hashes server-side, in the same atomic batch --')
fakeDb.reset()
const created = await registry.createDevice('e1', {
  name: 'Desk B', loginName: 'desk-b', enabled: true, attributes: ['registration'],
  password: 'a-real-passphrase',
})
const createdRow = [...fakeDb.state.devices.values()][0]
check('the device was created', created.ok, true)
check('  the stored value is a scrypt hash, not the password',
  [createdRow.passwordHash.startsWith('scrypt$v1$'), createdRow.passwordHash.includes('a-real-passphrase')],
  [true, false])
check('  and it verifies', await password.verifyDevicePassword('a-real-passphrase', createdRow.passwordHash), true)
check('  one batch carried the device AND its credentials',
  fakeDb.state.applied.filter((entry) => !entry.startsWith('select')),
  ['insert devices', 'insert device_attributes'])
check('  session_version starts at the column default',
  createdRow.sessionVersion === undefined || createdRow.sessionVersion === 1, true)

fakeDb.reset()
const bare = await registry.createDevice('e1', {
  name: 'Desk C', loginName: null, enabled: true, attributes: [], password: null,
})
check('a credential-free create stores no hash',
  [bare.ok, [...fakeDb.state.devices.values()][0].passwordHash], [true, null])
check('  and reports credentials as unconfigured', bare.value.credentialsConfigured, false)

console.log('  -- the DTO exposes only whether credentials exist --')
check('AdminDevice carries credentialsConfigured',
  Object.keys(created.value).sort(),
  ['activeBadgeRange', 'attributes', 'createdAt', 'credentialsConfigured', 'enabled',
   'eventId', 'id', 'lastSeenAt', 'loginName', 'name'])
check('  it is true when provisioned', created.value.credentialsConfigured, true)
check('  and no hash, salt or version is present',
  JSON.stringify(created.value).match(/scrypt|passwordHash|sessionVersion|salt/i), null)

seed({ passwordHash: 'scrypt$v1$32768$8$1$AAAA$BBBB' })
const listed = await registry.listDevices('e1')
check('a listed device reports Configured', listed[0].credentialsConfigured, true)
check('  without leaking the hash', JSON.stringify(listed).includes('scrypt'), false)
seed()
check('an unprovisioned device reports Not configured',
  (await registry.listDevices('e1'))[0].credentialsConfigured, false)

console.log('  -- set and reset increment the session version --')
seed()
const first = await registry.setDevicePassword('e1', 'd1', 'first-passphrase')
check('the first set succeeds', first, { ok: true, value: { deviceId: 'd1', credentialsConfigured: true } })
check('  a hash was stored', stored().passwordHash.startsWith('scrypt$v1$'), true)
check('  which verifies', await password.verifyDevicePassword('first-passphrase', stored().passwordHash), true)
check('  session_version 1 -> 2', stored().sessionVersion, 2)

await registry.setDevicePassword('e1', 'd1', 'second-passphrase')
check('a reset replaces the hash',
  [await password.verifyDevicePassword('second-passphrase', stored().passwordHash),
   await password.verifyDevicePassword('first-passphrase', stored().passwordHash)], [true, false])
check('  session_version 2 -> 3', stored().sessionVersion, 3)

await registry.setDevicePassword('e1', 'd1', 'second-passphrase')
check('re-setting the SAME password still increments', stored().sessionVersion, 4)
check('  because a reset is a revocation, not a comparison',
  /detect whether the new password equals|without\s*\n?\s*\* comparing the new password/.test(read('server/admin/registry.ts')), true)

console.log('  -- provisioning preconditions --')
seed()
check('an unknown device is rejected',
  await registry.setDevicePassword('e1', 'nope', 'a-passphrase'), { ok: false, blocked: 'device-not-found' })
seed()
check('the wrong event is rejected',
  await registry.setDevicePassword('other', 'd1', 'a-passphrase'), { ok: false, blocked: 'device-event-mismatch' })
seed()
check('  and neither wrote anything',
  fakeDb.state.applied.filter((entry) => !entry.startsWith('select')), [])
seed({ loginName: null })
check('a device with no login name is rejected',
  await registry.setDevicePassword('e1', 'd1', 'a-passphrase'), { ok: false, blocked: 'device-has-no-login-name' })
check('  and no hash was written', stored().passwordHash, null)

seed({ enabled: false })
const disabled = await registry.setDevicePassword('e1', 'd1', 'a-passphrase')
check('a DISABLED device may still be provisioned', disabled.ok, true)
check('  preparing a desk before opening it', stored().passwordHash.startsWith('scrypt$'), true)

console.log('  -- nothing clears a password, and no login exists --')
const registrySource = stripComments(read('server/admin/registry.ts'))
check('no clear/remove/disable-password operation',
  /clearDevicePassword|removeCredentials|disablePassword|passwordHash: null/.test(registrySource), false)
check('  nor any such API route',
  readdirSync(join(root, 'api')).filter((f) => /clear|revoke|password-remove/i.test(f)), [])
// Phase 9C-B added the device realm. What must still NOT exist is the next
// phase: enrollment, self-claim and a heartbeat.
check('  no enrollment or self-claim endpoint exists',
  ['device-enroll.ts', 'device-claim-range.ts', 'device-heartbeat.ts']
    .map((f) => existsSync(join(root, 'api', f))), [false, false, false])
check('  and a password is still only ever set or reset',
  /clearDevicePassword|removeCredentials|disablePassword/.test(
    readdirSync(join(root, 'api')).map((f) => read(`api/${f}`)).join('\n')), false)
check('  password.ts holds no HTTP or database concern',
  /Request|Response|getDatabase|drizzle|cookie/i.test(stripComments(read('server/device-auth/password.ts'))), false)

console.log('  -- the password endpoint guards in the right order --')
const endpoint = read('api/admin-device-password.ts')
check('the Admin session is checked first',
  endpoint.indexOf('guardAdminRequest') < endpoint.indexOf('readAdminBody'), true)
check('  before the registry is touched',
  endpoint.indexOf('guardAdminRequest') < endpoint.indexOf('setDevicePassword'), true)
check('  and the mutation is same-origin guarded',
  /mutating: true/.test(endpoint), true)
check('the success reply is only the registry value',
  /return adminJson\(\{ ok: true, \.\.\.result\.value \}, 200\)/.test(endpoint), true)
check('  and that value is exactly deviceId + credentialsConfigured',
  Object.keys(first.value).sort(), ['credentialsConfigured', 'deviceId'])
check('  the endpoint never names a hash, salt or version',
  /passwordHash|password_hash|sessionVersion|session_version|salt|derivedKey/
    .test(stripComments(endpoint)), false)

console.log('\n=== 33-45. ADMIN CREDENTIAL UI ===')
const { renderDeviceForm, checkboxes } = await import('./admin-render.mjs')
const cardSource = stripComments(read('src/components/admin/device-card.tsx'))
const dialogSource = stripComments(read('src/components/admin/device-password-dialog.tsx'))
const fieldSource = stripComments(read('src/components/admin/password-field.tsx'))

check('the device card shows a credential status',
  [/Credentials/.test(cardSource), /Configured/.test(cardSource), /Not configured/.test(cardSource)],
  [true, true, true])
check('  derived only from the boolean',
  /device\.credentialsConfigured \?/.test(cardSource), true)
check('  no hash, salt or password is ever rendered',
  /passwordHash|scrypt|salt|lastPassword/.test(cardSource), false)
check('Set Password when unconfigured, Reset when configured',
  [/isReset \? 'Reset Password' : 'Set Password'/.test(dialogSource),
   /device\.credentialsConfigured/.test(dialogSource)], [true, true])
check('  and no reveal or clear action',
  /Show password|Reveal|Clear Password|Remove Credentials/.test(dialogSource), false)

check('both password fields are masked by default',
  /type=\{isVisible \? 'text' : 'password'\}/.test(fieldSource), true)
check('  with an Eye / EyeOff toggle',
  [/EyeOff/.test(fieldSource), /<Eye className/.test(fieldSource)], [true, true])
check('  that is a button, never a submit',
  [/type="button"/.test(fieldSource), /type="submit"/.test(fieldSource)], [true, false])
check('  with accessible Show / Hide labels',
  /aria-label=\{isVisible \? `Hide \$\{label\.toLowerCase\(\)\}` : `Show \$\{label\.toLowerCase\(\)\}`\}/.test(fieldSource), true)
check('  exposing its pressed state', /aria-pressed=\{isVisible\}/.test(fieldSource), true)
check('  and visibility is per-field state only',
  /localStorage|sessionStorage|indexedDB/.test(fieldSource), false)

console.log('  -- Create Device --')
const createForm = renderDeviceForm({
  values: { name: '', loginName: '', enabled: true, attributes: [], password: '', confirmPassword: '' },
  idPrefix: 'create-device', showCredentials: true,
})
check('Create Device offers optional credentials',
  [/Optional now\. Required before this device can use device login\./.test(createForm),
   createForm.includes('id="create-device-password"'),
   createForm.includes('id="create-device-confirm-password"')], [true, true, true])
check('  both start masked',
  [...createForm.matchAll(/<input[^>]*id="create-device-(confirm-)?password"[^>]*>/g)]
    .map((match) => match[0].includes('type="password"')), [true, true])
check('  and it says a login name is needed first',
  /A login name is needed first\./.test(createForm), true)
const withLogin = renderDeviceForm({
  values: { name: 'A', loginName: 'desk-a', enabled: true, attributes: [], password: '', confirmPassword: '' },
  idPrefix: 'create-device', showCredentials: true,
})
check('  which disappears once one is typed', /A login name is needed first\./.test(withLogin), false)

const editForm = renderDeviceForm({
  values: { name: 'A', loginName: 'desk-a', enabled: true, attributes: ['registration'], password: '', confirmPassword: '' },
})
check('Edit Device shows NO password field',
  [/type="password"/.test(editForm), /Confirm Password/.test(editForm)], [false, false])
check('  because a blank one would be ambiguous',
  /blank one inside Save Device would be ambiguous|ambiguous between keeping/.test(
    read('src/components/admin/device-form-fields.tsx')), true)
check('  and an existing password is never loaded',
  /password: '',\n  confirmPassword: '',/.test(read('src/components/admin/device-dialog.tsx')), true)
check('  the attribute checkboxes still render',
  checkboxes(editForm).filter((entry) => entry.id.includes('-attribute-')).length, 2)

console.log('  -- client-side refusal before the request --')
const deviceDialogSource = stripComments(read('src/components/admin/device-dialog.tsx'))
check('Create Device checks the pair before sending',
  deviceDialogSource.indexOf('checkPasswordPair') < deviceDialogSource.indexOf('await createDevice'), true)
check('  the password dialog does too',
  dialogSource.indexOf('checkPasswordPair') < dialogSource.indexOf('await setDevicePassword'), true)
check('  and the server still decides',
  /parseCredentialInput/.test(stripComments(read('api/admin-device-password.ts'))), true)
check('submit is disabled while saving',
  [/disabled=\{isSaving\}/.test(dialogSource), /isSaving \? 'Saving…'/.test(dialogSource)], [true, true])

console.log('  -- nothing typed outlives the dialog --')
check('every field is cleared on open AND on close',
  /onOpenChange=\{\(open: boolean\) => \{\s*setIsOpen\(open\)[\s\S]{0,120}clear\(\)/.test(dialogSource), true)
check('  and after a successful save',
  /clear\(\)\s*setIsOpen\(false\)\s*onSaved\(/.test(dialogSource), true)
check('  Create Device resets its values too',
  /setValues\(toValues\(device\)\)\s*setIsOpen\(false\)/.test(deviceDialogSource), true)
check('  no password is persisted anywhere',
  /localStorage|sessionStorage|indexedDB|Dexie/.test(dialogSource + deviceDialogSource), false)

console.log('  -- one card updates, no full-screen reload --')
check('a saved password updates that device only',
  /onSaved\(\{ \.\.\.device, credentialsConfigured: true \}\)/.test(dialogSource), true)
check('  through the card\'s existing local-update path',
  /<DevicePasswordDialog[\s\S]{0,140}onSaved=\{onChanged\}/.test(cardSource), true)
check('  and the control plane never re-fetches for it',
  /onSaved=\{refresh\}|onChanged=\{refresh\}/.test(
    stripComments(read('src/components/admin/admin-control-plane.tsx'))), false)

console.log('\n=== 46-57. NOTHING ELSE CHANGED ===')
const clientFiles = walkSource(join(root, 'src'))
  .map((file) => ({ file: file.replace(`${root}/`, ''), code: stripComments(readFileSync(file, 'utf8')) }))
check('no client module names a hash or session column',
  clientFiles.filter((entry) => /passwordHash|password_hash|sessionVersion|session_version/.test(entry.code))
    .map((entry) => entry.file), [])
check('  nor imports the hashing service',
  clientFiles.filter((entry) => /server\/device-auth|node:crypto/.test(entry.code)).map((entry) => entry.file), [])
check('  and no credential reaches the built bundle',
  ['scrypt$v1', 'passwordHash', 'session_version']
    .map((needle) => spawnSync('grep', ['-rl', needle, join(root, 'dist')], { encoding: 'utf8' }).stdout.trim()),
  ['', '', ''])

const dexie = read('src/db/database.ts')
check('IndexedDB version unchanged (1)', /DATABASE_VERSION = 1/.test(dexie), true)
check('  exactly three stores',
  ((/\.stores\(\{([\s\S]*?)\}\)/.exec(dexie)?.[1] ?? '').match(/^\s*(\w+):/gm) ?? [])
    .map((m) => m.trim().replace(':', '')), ['registrations', 'config', 'outbox'])
check('  and no credential field joined it',
  /password|credential|hash/i.test(stripComments(dexie)), false)

const sheet = read('server/sync/sheet-contract.ts')
check('Google Sheet ranges unchanged', [/A1:N/.test(sheet), /A1:M/.test(sheet)], [true, true])
check('  and the sheet learns no credential', /password|credential/i.test(stripComments(sheet)), false)
check('the sync contract is untouched',
  /password|credential|device-auth/i.test(stripComments(read('src/shared/sync-contract.ts'))), false)

// Phase D2 retired Operator Access entirely; what mattered here — that this
// phase touched no other realm — is now asserted as its absence.
check('the Operator realm is gone, not merely unused',
  [existsSync(join(root, 'server/auth')), existsSync(join(root, 'src/auth'))], [false, false])
check('Admin auth is unchanged',
  [/navaratri-admin-session-v1:/.test(read('server/admin-auth/session.ts')),
   /MIN_ADMIN_ACCESS_CODE_LENGTH = 8/.test(read('server/admin-auth/environment.ts'))], [true, true])
check('event routes are unchanged',
  ['/', '/badge-registration', '/device-registration', '/admin']
    .every((route) => read('src/app/routes.ts').includes(`'${route}'`)), true)
// Phase D2 retired the page; the path survives as a redirect for bookmarks.
check('  /device-registration is retired, but its path still resolves',
  [existsSync(join(root, 'src/pages/device-registration-page.tsx')),
   JSON.parse(read('vercel.json')).rewrites.some((r) => r.source === '/device-registration')],
  [false, true])
check('badge allocation stays local',
  [/nextBadge/.test(read('src/db/registrations.ts')),
   /server\/db|drizzle/.test(read('src/db/registrations.ts'))], [true, false])
check('  and central Postgres holds no badge counter',
  /next_badge|nextBadge/.test(stripComments(read('server/db/schema.ts'))), false)
check('the attribute allow-list is unchanged',
  /DEVICE_ATTRIBUTES = \['registration', 'prizes'\]/.test(read('src/shared/device-attributes.ts')), true)
check('Save Device is still ONE atomic operation',
  [(registrySource.slice(registrySource.indexOf('export const updateDeviceConfiguration'),
    registrySource.indexOf('export const setDevicePassword')).match(/db\.batch\(/g) ?? []).length,
   /replaceDeviceAttributes/.test(registrySource)], [1, false])

console.log('\n=== MIGRATION ===')
const migrations = readdirSync(join(root, 'drizzle')).filter((f) => f.endsWith('.sql')).sort()
check('exactly one migration was added',
  migrations, ['0000_central_foundation.sql', '0001_range_guards_and_touch.sql', '0002_device_credentials.sql'])
const migration = read('drizzle/0002_device_credentials.sql')
check('  it adds a nullable password_hash',
  /ADD COLUMN "password_hash" text;/.test(migration), true)
check('  a session_version defaulting to 1',
  /ADD COLUMN "session_version" integer DEFAULT 1 NOT NULL;/.test(migration), true)
check('  and a session_version >= 1 check',
  /"session_version" >= 1/.test(migration), true)
check('  it never drops, deletes or truncates',
  /DROP|DELETE|TRUNCATE|ALTER COLUMN/i.test(migration), false)
check('  and it stores no plaintext column',
  /password_plaintext|password_ciphertext|temporary_password|"password"/i.test(migration), false)
check('the earlier migrations are untouched',
  [read('drizzle/0000_central_foundation.sql').includes('password'),
   read('drizzle/0001_range_guards_and_touch.sql').includes('password')], [false, false])
check('no session or token table was added',
  /device_sessions|refresh_tokens|access_tokens|admin_users/i.test(migration), false)
check('migrations never run automatically',
  Object.entries(JSON.parse(read('package.json')).scripts)
    .filter(([name, command]) => name !== 'db:migrate' && command.includes('drizzle-kit migrate')), [])

const dbCheck = read('scripts/db-check.mjs')
check('db:check verifies the new columns without reading a value',
  [/information_schema\.columns/.test(dbCheck),
   /devices_session_version_positive/.test(dbCheck),
   /SELECT[^`]*password_hash/i.test(stripComments(dbCheck))], [true, true, false])
// Every SQL template in the file, so a prose word like "drop" in a label
// cannot look like a write.
const dbCheckStatements = [...stripComments(dbCheck).matchAll(/sql`([^`]*)`/g)].map((m) => m[1])
check('  every statement it runs is a SELECT',
  dbCheckStatements.filter((statement) => !/^\s*SELECT\b/i.test(statement)), [])
check('  and none of them writes',
  dbCheckStatements.filter((statement) =>
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(statement)), [])

console.log('\n=== DEPENDENCIES + SUITE ===')
const manifest = JSON.parse(read('package.json'))
check('no password library was added',
  Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter((name) => /bcrypt|argon2|pbkdf2|password|auth0|clerk/i.test(name)), [])
check('hashing is Node built-in crypto',
  /from 'node:crypto'/.test(read('server/device-auth/password.ts')), true)
check('verify:9ca is registered',
  manifest.scripts['verify:9ca'], 'node scripts/verification/phase-9ca.mjs')
check('  and included in verify', manifest.scripts.verify.includes('verify:9ca'), true)
check('release:check covers credentials',
  /device-credentials/.test(read('scripts/release-check.mjs')), true)

console.log(fails === 0 ? '\nALL CHECKS PASS' : `\n${fails} FAILURE(S)`)
process.exit(fails === 0 ? 0 : 1)
