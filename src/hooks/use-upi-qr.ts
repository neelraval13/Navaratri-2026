import { toDataURL, type QRCodeToDataURLOptions } from 'qrcode'
import { useEffect, useState } from 'react'

export type UpiQrStatus = 'idle' | 'loading' | 'ready' | 'failed'

export interface UpiQr {
  status: UpiQrStatus
  dataUrl: string | null
}

/**
 * Scanning reliability beats branding: plain black modules on a solid white
 * field, with a generous quiet zone, rendered large enough to stay crisp when
 * the panel scales down on a phone.
 */
const QR_OPTIONS: QRCodeToDataURLOptions = {
  errorCorrectionLevel: 'M',
  margin: 2,
  width: 512,
  color: {
    dark: '#000000',
    light: '#ffffff',
  },
}

/**
 * A settled render, tagged with the URI it answered.
 */
interface SettledQr {
  uri: string
  status: 'ready' | 'failed'
  dataUrl: string | null
}

/**
 * Renders a UPI URI to a QR data URL entirely in the browser.
 *
 * No network request is involved — the encoder is bundled — so the QR keeps
 * working at a desk with no connectivity. Completing the payment still needs the
 * attendee's own UPI app and their connectivity; that is outside this
 * application.
 *
 * Results are tagged with the URI they were generated for and compared during
 * render, so a slow result for a previous URI can never be shown for the current
 * one. Nothing generated here is ever persisted.
 */
export const useUpiQr = (uri: string | null): UpiQr => {
  const [settled, setSettled] = useState<SettledQr | null>(null)

  useEffect(() => {
    if (uri === null) {
      return
    }

    let cancelled = false

    toDataURL(uri, QR_OPTIONS)
      .then((dataUrl) => {
        if (cancelled) {
          return
        }

        setSettled({ uri, status: 'ready', dataUrl })
      })
      .catch((error: unknown) => {
        console.error('Navaratri: generating the UPI QR failed.', error)

        if (cancelled) {
          return
        }

        setSettled({ uri, status: 'failed', dataUrl: null })
      })

    return () => {
      cancelled = true
    }
  }, [uri])

  if (uri === null) {
    return { status: 'idle', dataUrl: null }
  }

  if (settled === null || settled.uri !== uri) {
    return { status: 'loading', dataUrl: null }
  }

  return { status: settled.status, dataUrl: settled.dataUrl }
}
