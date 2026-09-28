import {
  adminConflict,
  adminError,
  adminJson,
  adminUnexpected,
  guardAdminRequest,
  readAdminBody,
} from '../server/admin/http.js'
import {
  createDevice,
  listDevices,
  updateDeviceConfiguration,
} from '../server/admin/registry.js'
import {
  parseCreateDeviceInput,
  parseDeviceConfigurationInput,
} from '../server/admin/validation.js'

const BLOCK_MESSAGES: Record<string, string> = {
  'device-not-found': 'That device could not be found.',
  'device-event-mismatch': 'That device does not belong to the selected event.',
  'registration-required-by-badge-range':
    'This device has an active badge range, so Registration access cannot be removed.',
}

const readEventId = (request: Request): string | null => {
  try {
    return new URL(request.url).searchParams.get('eventId')
  } catch {
    return null
  }
}

/** Every central device in one event, with attributes and active badge range. */
export async function GET(request: Request): Promise<Response> {
  const guard = guardAdminRequest(request, { mutating: false, requiresDatabase: true })

  if (guard.ok === false) {
    return guard.response
  }

  const eventId = readEventId(request)

  if (eventId === null || eventId === '') {
    return adminError('eventId is required.', 400)
  }

  try {
    return adminJson({ ok: true, devices: await listDevices(eventId) }, 200)
  } catch (error: unknown) {
    return adminUnexpected('list devices', error)
  }
}

/**
 * Creates a central device and its initial attributes atomically.
 *
 * This record is groundwork for Phase 9C authentication. It does NOT touch any
 * browser's IndexedDB: there is no authenticated mapping from a browser to a
 * central device yet.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = guardAdminRequest(request, { mutating: true, requiresDatabase: true })

  if (guard.ok === false) {
    return guard.response
  }

  const body = await readAdminBody(request)

  if (body.ok === false) {
    return body.response
  }

  const raw = body.body as Record<string, unknown>
  const eventId = typeof raw.eventId === 'string' ? raw.eventId : ''

  if (eventId === '') {
    return adminError('eventId is required.', 400)
  }

  const input = parseCreateDeviceInput(raw)

  if (input.ok === false) {
    return adminError(input.message, 400)
  }

  try {
    const result = await createDevice(eventId, input.value)

    if (result.ok === false) {
      return 'conflict' in result ? adminConflict(result.conflict) : adminError(result.blocked, 409)
    }

    return adminJson({ ok: true, device: result.value }, 201)
  } catch (error: unknown) {
    return adminUnexpected('create device', error)
  }
}

/**
 * The COMPLETE Edit Device operation: device fields AND the exact attribute
 * set, in one request.
 *
 * Save Device is one action for the operator, so it is one operation here.
 * Everything is authenticated, validated and rule-checked before the first
 * write, and the fields and attributes then commit as a single atomic batch —
 * a refusal persists nothing at all. The reply carries the whole updated
 * device so the caller need not reload the registry to see what it just did.
 *
 * `enabled: false` changes CENTRAL state only. It does not revoke an existing
 * device's Operator Access, because devices do not use central authentication
 * yet — that enforcement arrives with Phase 9C.
 */
export async function PATCH(request: Request): Promise<Response> {
  const guard = guardAdminRequest(request, { mutating: true, requiresDatabase: true })

  if (guard.ok === false) {
    return guard.response
  }

  const body = await readAdminBody(request)

  if (body.ok === false) {
    return body.response
  }

  const raw = body.body as Record<string, unknown>
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : ''

  if (deviceId === '') {
    return adminError('deviceId is required.', 400)
  }

  const input = parseDeviceConfigurationInput(raw)

  if (input.ok === false) {
    return adminError(input.message, 400)
  }

  try {
    const result = await updateDeviceConfiguration(deviceId, input.value)

    if (result.ok === false) {
      if ('conflict' in result) {
        return adminConflict(result.conflict)
      }

      // Nothing was written, so the operator's device is exactly as it was.
      return adminJson(
        {
          ok: false,
          blocked: result.blocked,
          message: BLOCK_MESSAGES[result.blocked] ?? 'That change could not be applied.',
        },
        result.blocked === 'device-not-found' ? 404 : 409,
      )
    }

    return adminJson({ ok: true, device: result.value }, 200)
  } catch (error: unknown) {
    return adminUnexpected('update device', error)
  }
}
