import { CircleAlert } from 'lucide-react'
import type * as React from 'react'

import type { UpiQrStatus } from '@/hooks/use-upi-qr'

const PANEL_CLASS_NAME =
  'mx-auto flex aspect-square w-full max-w-64 items-center justify-center rounded-2xl p-3'

interface UpiQrProps {
  status: UpiQrStatus
  dataUrl: string | null
  /** Describes the QR for assistive technology, e.g. the payee and amount. */
  label: string
}

/**
 * The scannable QR panel.
 *
 * The background is literally white rather than a theme token, and the modules
 * are literally black, in BOTH themes. Inverting or tinting a QR costs scans,
 * and a code nobody can scan is worse than one that ignores the palette.
 */
const UpiQr: React.FC<UpiQrProps> = ({ status, dataUrl, label }) => {
  if (status === 'ready' && dataUrl !== null) {
    return (
      <div className={`${PANEL_CLASS_NAME} border border-border bg-white`}>
        <img
          src={dataUrl}
          alt={label}
          className="h-full w-full"
        />
      </div>
    )
  }

  if (status === 'failed') {
    return (
      <div
        className={`${PANEL_CLASS_NAME} border border-destructive/30 bg-destructive/10`}
      >
        <p className="flex items-center gap-2 px-4 text-center text-sm font-medium text-destructive">
          <CircleAlert className="size-4 shrink-0" />
          Unable to generate UPI QR.
        </p>
      </div>
    )
  }

  return (
    <div
      className={`${PANEL_CLASS_NAME} border border-dashed border-border bg-background`}
    >
      <p className="text-sm text-muted-foreground">
        Preparing UPI QR…
      </p>
    </div>
  )
}

export default UpiQr
