import {
  readSyncEnvironment,
  SYNC_DISABLED_LOG_MESSAGES,
} from '../server/sync/environment.js'
import { syncRegistration } from '../server/sync/sync-registration.js'
import {
  parseSyncRegistrationRequest,
  type SyncFailureResponse,
  type SyncRegistrationResponse,
  type SyncSuccessResponse,
} from '../src/shared/sync-contract.js'

/**
 * One registration snapshot is a few hundred bytes. This endpoint accepts a
 * single record, not arbitrary documents.
 */
const MAX_BODY_BYTES = 16 * 1024

const jsonResponse = (
  body: SyncRegistrationResponse,
  status: number,
): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  })
}

const failure = (
  outcome: SyncFailureResponse['outcome'],
  message: string,
  status: number,
  extra: Omit<SyncFailureResponse, 'ok' | 'outcome' | 'message'> = {},
): Response => {
  return jsonResponse({ ok: false, outcome, message, ...extra }, status)
}

const success = (
  outcome: SyncSuccessResponse['outcome'],
  registrationId: string,
  payloadUpdatedAt: string,
): Response => {
  return jsonResponse(
    { ok: true, outcome, registrationId, payloadUpdatedAt },
    200,
  )
}

/**
 * Upserts ONE registration snapshot into the central Google Sheet.
 *
 * All registration data travels in the JSON body: no name, phone, registration
 * id or badge number ever appears in the URL.
 *
 * This endpoint never touches the browser's IndexedDB or its outbox. The local
 * store stays the operational source of truth, and a failure here simply leaves
 * the pending outbox row in place for Phase 5B to retry.
 */
export async function POST(request: Request): Promise<Response> {
  /**
   * Read configuration first: the Origin check itself depends on it, and the
   * release interlock must be settled before anything else happens.
   *
   * A disabled or mismatched deployment reports the EXISTING
   * `sync-not-configured` contract. No new outcome is introduced for the
   * release switch, so the browser keeps its Phase 5B classification, retains
   * its outbox rows and carries on registering locally.
   */
  const configuration = readSyncEnvironment()

  if (!configuration.ok) {
    console.error(
      `Navaratri sync: refused. ${SYNC_DISABLED_LOG_MESSAGES[configuration.reason]}`,
    )

    return failure(
      'sync-not-configured',
      'Google Sheets synchronization is not configured on this deployment.',
      503,
    )
  }

  const environment = configuration.environment

  /**
   * A same-origin browser POST always carries an Origin header. This keeps the
   * endpoint from being driven by another site's page.
   *
   * It is NOT user authentication: any direct HTTP client can set this header
   * to anything. Before public production use the deployment itself must be
   * access-controlled, or a real application authentication layer added.
   */
  const origin = request.headers.get('origin')

  if (origin !== environment.allowedOrigin) {
    return failure('forbidden-origin', 'Origin is not allowed.', 403)
  }

  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('application/json')) {
    return failure('invalid-request', 'Content-Type must be application/json.', 415)
  }

  let rawBody: string

  try {
    rawBody = await request.text()
  } catch {
    return failure('invalid-request', 'Request body could not be read.', 400)
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return failure('invalid-request', 'Request body is too large.', 413)
  }

  let parsedBody: unknown

  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    return failure('invalid-request', 'Request body is not valid JSON.', 400)
  }

  const parsed = parseSyncRegistrationRequest(parsedBody)

  if (!parsed.ok) {
    return failure('invalid-request', parsed.message, 400)
  }

  const { request: syncRequest } = parsed
  const { registrationId, payload } = syncRequest

  try {
    const result = await syncRegistration(syncRequest, environment)

    if (result.ok) {
      return success(result.outcome, registrationId, payload.updatedAt)
    }

    if (result.outcome === 'badge-conflict') {
      console.error(
        `Navaratri sync: badge ${String(result.badgeNumber)} is already assigned to a different registration. Human reconciliation required.`,
      )

      return failure(
        'badge-conflict',
        'That badge number is already assigned to a different registration.',
        409,
        {
          registrationId,
          payloadUpdatedAt: payload.updatedAt,
          badgeNumber: result.badgeNumber,
        },
      )
    }

    console.error(`Navaratri sync: sheet shape conflict — ${result.message}`)

    return failure('sheet-shape-conflict', result.message, 409, {
      registrationId,
      payloadUpdatedAt: payload.updatedAt,
    })
  } catch (error: unknown) {
    // Diagnostics stay server-side. The response never carries a Google stack
    // trace, credentials or attendee details.
    console.error(
      `Navaratri sync: failed for registration ${registrationId}.`,
      error instanceof Error ? error.message : 'Unknown error.',
    )

    return failure(
      'sync-failed',
      'Synchronization failed. The record is unchanged remotely.',
      502,
      { registrationId, payloadUpdatedAt: payload.updatedAt },
    )
  }
}
