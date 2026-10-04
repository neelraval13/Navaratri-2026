import { createJiti } from 'jiti'
import { resolve } from 'node:path'
const HERE = import.meta.dirname
const root = resolve(HERE, '../..')
const jiti = createJiti(import.meta.url, {
  alias: { '@/hooks/use-event-config': `${HERE}/fake-event-config.mjs`,
    '@/hooks/use-network-status': `${HERE}/fake-network-status.mjs`, '@': `${root}/src` },
  interopDefault: true, jsx: { runtime: 'automatic' },
})
const { state } = await jiti.import(`${HERE}/fake-event-config.mjs`)
const load = async (p) => { const m = await jiti.import(`${root}/${p}`); return m.default ?? m }
const DeviceLabel = await load('src/components/device/device-label.tsx')
/**
 * Phase D2 deleted `DeviceRegisteredGate`: the route-level access gate now
 * answers the same question, and its refusal screen is what a desk actually
 * sees. That screen is rendered here instead, for every reason it can give.
 */
const DeviceAccessRequired = await load('src/components/event-access/device-access-required.tsx')
const network = await jiti.import(`${HERE}/fake-network-status.mjs`)

const describe = (node, out = { text: [], components: [], delegated: [] }) => {
  if (node === null || node === undefined || typeof node === 'boolean') return out
  if (typeof node === 'string' || typeof node === 'number') { out.text.push(String(node)); return out }
  if (Array.isArray(node)) { for (const c of node) describe(c, out); return out }
  if (typeof node === 'object' && 'type' in node) {
    const t = node.type
    const nm = typeof t === 'function' ? (t.name || 'anonymous') : String(t?.toString?.() ?? t)
    out.components.push(nm)
    if (typeof t === 'function') {
      out.delegated.push({ name: nm, status: node.props?.status ?? null, hasRetry: typeof node.props?.onRetry === 'function' })
    }
    describe(node.props?.children, out)
  }
  return out
}

const CONFIGURED = { id: 'event', deviceId: '11111111-2222-4333-8444-555555555555',
  deviceName: 'Registration Desk A', badgeStart: 1, badgeEnd: 250, nextBadge: 5, updatedAt: 'T1' }
const UNCONFIGURED = { ...CONFIGURED, deviceId: undefined, deviceName: undefined, badgeEnd: undefined }
// Registered hardware that owns no badge range: the new middle state.
const REGISTERED_NO_BADGES = { ...CONFIGURED, badgeStart: 1, badgeEnd: undefined, nextBadge: 1 }
const label = (status, config) => { state.status = status; state.config = config; return describe(DeviceLabel()) }
const refusal = (gap, status = 'online') => { network.state.status = status; return describe(DeviceAccessRequired({ gap })) }

console.log(JSON.stringify({
  refusal: Object.fromEntries([
    'no-grant', 'event-mismatch', 'storage-unavailable', 'no-enrollment',
    'missing-local-identity', 'identity-convergence-required', 'not-permitted',
    'no-central-range',
  ].map((gap) => [gap, refusal(gap)])),
  refusalOffline: refusal('no-grant', 'offline'),
  label: { configured: label('loaded', CONFIGURED), afterIssue: label('loaded', { ...CONFIGURED, nextBadge: 200 }),
    exhausted: label('loaded', { ...CONFIGURED, nextBadge: 251 }), unconfigured: label('loaded', UNCONFIGURED),
    registeredNoBadges: label('loaded', REGISTERED_NO_BADGES) },
}))
