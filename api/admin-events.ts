import {
  adminConflict,
  adminError,
  adminJson,
  adminUnexpected,
  guardAdminRequest,
  readAdminBody,
} from '../server/admin/http.js'
import { createEvent, listEvents } from '../server/admin/registry.js'
import { parseCreateEventInput } from '../server/admin/validation.js'

/** Lists the central events. Admin session is verified before any DB access. */
export async function GET(request: Request): Promise<Response> {
  const guard = guardAdminRequest(request, { mutating: false, requiresDatabase: true })

  if (!guard.ok) {
    return guard.response
  }

  try {
    return adminJson({ ok: true, events: await listEvents() }, 200)
  } catch (error: unknown) {
    return adminUnexpected('list events', error)
  }
}

/**
 * Creates the first (or another) event. There is no automatic seed anywhere —
 * an event exists because a human created it here.
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

  const input = parseCreateEventInput(body.body)

  if (!input.ok) {
    return adminError(input.message, 400)
  }

  try {
    const result = await createEvent(input.value)

    if (!result.ok) {
      return 'conflict' in result ? adminConflict(result.conflict) : adminError(result.blocked, 409)
    }

    return adminJson({ ok: true, event: result.value }, 201)
  } catch (error: unknown) {
    return adminUnexpected('create event', error)
  }
}
