import {
  OPERATOR_AUTH_LOG_MESSAGES,
  readOperatorAuthEnvironment,
} from '../server/auth/environment.js'
import { serializeOperatorSessionCookie } from '../server/auth/cookies.js'
import {
  createOperatorSessionToken,
  isOperatorAccessCodeValid,
} from '../server/auth/operator-session.js'
import { isSameOriginRequest } from '../server/auth/same-origin.js'

/** An access code is a passphrase, not a document. */
const MAX_BODY_BYTES = 2 * 1024

/**
 * A fixed pause before every rejection. It blunts naive online guessing without
 * pretending to be a rate limiter — the real protection is a strong passphrase,
 * which the configuration minimum enforces.
 */
const INVALID_CODE_DELAY_MS = 750

const jsonResponse = (body: unknown, status: number, cookie?: string): Response => {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
  })

  if (cookie !== undefined) {
    headers.append('set-cookie', cookie)
  }

  return new Response(JSON.stringify(body), { status, headers })
}

const delay = (ms: number): Promise<void> => {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Exchanges the shared operator access code for a signed session cookie.
 *
 * The submitted code is never logged, never echoed and never stored. The
 * response body carries no token: the session exists only as an HttpOnly
 * cookie the browser cannot read.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return jsonResponse({ ok: false, message: 'Origin is not allowed.' }, 403)
  }

  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('application/json')) {
    return jsonResponse(
      { ok: false, message: 'Content-Type must be application/json.' },
      415,
    )
  }

  let rawBody: string

  try {
    rawBody = await request.text()
  } catch {
    return jsonResponse({ ok: false, message: 'Request body could not be read.' }, 400)
  }

  if (rawBody.length > MAX_BODY_BYTES) {
    return jsonResponse({ ok: false, message: 'Request body is too large.' }, 413)
  }

  let parsedBody: unknown

  try {
    parsedBody = JSON.parse(rawBody)
  } catch {
    return jsonResponse({ ok: false, message: 'Request body is not valid JSON.' }, 400)
  }

  if (
    typeof parsedBody !== 'object' ||
    parsedBody === null ||
    Array.isArray(parsedBody) ||
    typeof (parsedBody as Record<string, unknown>).accessCode !== 'string'
  ) {
    return jsonResponse({ ok: false, message: 'An access code is required.' }, 400)
  }

  const accessCode = (parsedBody as Record<string, unknown>).accessCode as string

  const configuration = readOperatorAuthEnvironment()

  if (!configuration.ok) {
    console.error(
      `Navaratri operator login: refused. ${OPERATOR_AUTH_LOG_MESSAGES[configuration.reason]}`,
    )

    return jsonResponse(
      {
        ok: false,
        configured: false,
        message: 'Operator access is not configured on this deployment.',
      },
      503,
    )
  }

  if (!isOperatorAccessCodeValid(accessCode, configuration.environment.accessCode)) {
    await delay(INVALID_CODE_DELAY_MS)

    // Deliberately generic: never how close it was, never the submitted value.
    return jsonResponse({ ok: false, message: 'Access code is incorrect.' }, 401)
  }

  return jsonResponse(
    { ok: true, authenticated: true },
    200,
    serializeOperatorSessionCookie(
      createOperatorSessionToken(configuration.environment.sessionSecret),
    ),
  )
}
