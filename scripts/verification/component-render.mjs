import { createJiti } from 'jiti'
import { resolve } from 'node:path'
const HERE = import.meta.dirname
const root = resolve(HERE, '../..')
const jiti = createJiti(import.meta.url, {
  alias: { '@/hooks/use-event-config': `${HERE}/fake-event-config.mjs`, '@': `${root}/src` },
  interopDefault: true, jsx: { runtime: 'automatic' },
})
const { state } = await jiti.import(`${HERE}/fake-event-config.mjs`)
const load = async (p) => { const m = await jiti.import(`${root}/${p}`); return m.default ?? m }
const DeviceLabel = await load('src/components/device/device-label.tsx')
const DeviceSetupGate = await load('src/components/device/device-setup-gate.tsx')

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
const MARKER = '__REGISTRATION_FORM__'
const gate = (status, config) => { state.status = status; state.config = config; return describe(DeviceSetupGate({ children: MARKER })) }
const label = (status, config) => { state.status = status; state.config = config; return describe(DeviceLabel()) }

console.log(JSON.stringify({
  gate: { loading: gate('loading', null), failed: gate('failed', null), loadedNull: gate('loaded', null),
    unconfigured: gate('loaded', UNCONFIGURED), configured: gate('loaded', CONFIGURED) },
  label: { configured: label('loaded', CONFIGURED), afterIssue: label('loaded', { ...CONFIGURED, nextBadge: 200 }),
    exhausted: label('loaded', { ...CONFIGURED, nextBadge: 251 }), unconfigured: label('loaded', UNCONFIGURED) },
}))
