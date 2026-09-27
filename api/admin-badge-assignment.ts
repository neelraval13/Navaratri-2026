import {
  adminConflict,
  adminError,
  adminJson,
  adminUnexpected,
  guardAdminRequest,
  readAdminBody,
} from '../server/admin/http.js'
import { assignBadgeRange } from '../server/admin/registry.js'
import { parseBadgeRangeInput } from '../server/admin/validation.js'

const BLOCK_MESSAGES: Record<string, string> = {
  'device-not-found': 'That device could not be found.',
  'device-event-mismatch': 'That device does not belong to the selected event.',
  'device-disabled': 'Enable this device before assigning it a badge range.',
  'device-not-registration':
    'Give this device Registration access before assigning it a badge range.',
  'badge-range-already-assigned': 'This device already has an active badge range.',
}

/**
 * Assigns a device its FIRST badge range.
 *
 * There is deliberately no edit, replace, release, transfer or extend
 * endpoint. Changing a range while devices operate offline is how two
 * attendees end up with the same physical badge; doing it safely needs a
 * reconciliation protocol that this phase does not implement.
 */
export async function POST(request: Request): Promise<Response> {
  const guard = guardAdminRequest(request, { mutating: true, requiresDatabase: true })

  if (!guard.ok) {
    return guard.response
  }

  const body = await readAdminBody(request)

  if (!body.ok) {
    return body.response
  }

  const raw = body.body as Record<string, unknown>
  const eventId = typeof raw.eventId === 'string' ? raw.eventId : ''
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : ''

  if (eventId === '' || deviceId === '') {
    return adminError('eventId and deviceId are required.', 400)
  }

  const range = parseBadgeRangeInput(raw)

  if (!range.ok) {
    return adminError(range.message, 400)
  }

  try {
    const result = await assignBadgeRange(eventId, deviceId, range.value)

    if (!result.ok) {
      if ('conflict' in result) {
        return adminConflict(result.conflict)
      }

      return adminJson(
        {
          ok: false,
          blocked: result.blocked,
          message: BLOCK_MESSAGES[result.blocked] ?? 'That badge range could not be assigned.',
        },
        409,
      )
    }

    return adminJson({ ok: true, badgeRange: result.value }, 201)
  } catch (error: unknown) {
    return adminUnexpected('assign badge range', error)
  }
}
