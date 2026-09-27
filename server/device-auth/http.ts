/**
 * HTTP helpers for the device auth endpoints.
 *
 * Kept out of `password.ts` and `authenticate.ts` so neither carries an HTTP
 * concern, and separate from the Admin helpers so the realms stay
 * independently changeable.
 */

/** A device login body is three short strings; nothing legitimate is larger. */
export const MAX_DEVICE_BODY_BYTES = 4 * 1024

/**
 * Session state must never sit in a CDN or browser HTTP cache, and the answer
 * depends entirely on the device cookie.
 */
export const deviceJson = (
  body: unknown,
  status: number,
  cookie?: string,
): Response => {
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    vary: 'Cookie',
  })

  if (cookie !== undefined) {
    headers.append('set-cookie', cookie)
  }

  return new Response(JSON.stringify(body), { status, headers })
}

export type DeviceBodyResult =
  | { ok: true; body: unknown }
  | { ok: false; response: Response }

/**
 * Reads a JSON body under a small fixed limit.
 *
 * The submitted body is never echoed and never logged — it carries a
 * plaintext device password.
 */
export const readDeviceBody = async (request: Request): Promise<DeviceBodyResult> => {
  const contentType = request.headers.get('content-type') ?? ''

  if (!contentType.toLowerCase().includes('application/json')) {
    return {
      ok: false,
      response: deviceJson(
        { ok: false, message: 'Content-Type must be application/json.' },
        415,
      ),
    }
  }

  let raw: string

  try {
    raw = await request.text()
  } catch {
    return {
      ok: false,
      response: deviceJson({ ok: false, message: 'Request body could not be read.' }, 400),
    }
  }

  if (raw.length > MAX_DEVICE_BODY_BYTES) {
    return {
      ok: false,
      response: deviceJson({ ok: false, message: 'Request body is too large.' }, 413),
    }
  }

  try {
    return { ok: true, body: JSON.parse(raw) }
  } catch {
    return {
      ok: false,
      response: deviceJson({ ok: false, message: 'Request body is not valid JSON.' }, 400),
    }
  }
}
