import {
  adminConflict,
  adminError,
  adminJson,
  adminUnexpected,
  guardAdminRequest,
  readAdminBody,
} from '../server/admin/http.js'
import { setDevicePassword } from '../server/admin/registry.js'
import { parseCredentialInput } from '../server/admin/validation.js'

const BLOCK_MESSAGES: Record<string, string> = {
  'device-not-found': 'That device could not be found.',
  'device-event-mismatch': 'That device does not belong to the selected event.',
  'device-has-no-login-name':
    'Give this device a login name before setting a device password.',
}

/**
 * Sets or resets ONE device's password.
 *
 * Its own endpoint, not part of Save Device: a blank password field inside an
 * ordinary edit could mean keep it, clear it, or set an empty one, and a
 * credential change is too consequential to infer.
 *
 * Order: Admin session, then same-origin, then the body, then the device —
 * exactly like every other Admin route, so an unauthenticated caller learns
 * nothing about the deployment or about which devices exist.
 *
 * Phase 9C-A STORES the credential. It does not enable device login: there is
 * no device session, no cookie and no device login. Provisioning a
 * password activates nothing.
 *
 * The reply carries no password, no hash, no salt, no derived key and no
 * session version.
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
  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : ''

  if (eventId === '' || deviceId === '') {
    return adminError('eventId and deviceId are required.', 400)
  }

  /**
   * The login-name rule is re-checked against the STORED row inside the
   * registry. Passing `hasLoginName: true` here only lets the shared
   * validator reach the length and confirmation checks; it never grants a
   * device credentials it is not eligible for.
   */
  const password = parseCredentialInput(raw, { hasLoginName: true, required: true })

  if (password.ok === false) {
    return adminError(password.message, 400)
  }

  if (password.value === null) {
    return adminError('A device password is required.', 400)
  }

  try {
    const result = await setDevicePassword(eventId, deviceId, password.value)

    if (result.ok === false) {
      if ('conflict' in result) {
        return adminConflict(result.conflict)
      }

      return adminJson(
        {
          ok: false,
          blocked: result.blocked,
          message: BLOCK_MESSAGES[result.blocked] ?? 'That change could not be applied.',
        },
        result.blocked === 'device-not-found' ? 404 : 409,
      )
    }

    return adminJson({ ok: true, ...result.value }, 200)
  } catch (error: unknown) {
    // Names the operation and nothing submitted: no password, no body.
    return adminUnexpected('set device password', error)
  }
}
