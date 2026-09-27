import { CircleAlert, KeyRound } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { setDevicePassword, type AdminDevice } from '@/admin/admin-api'
import PasswordField from '@/components/admin/password-field'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { checkPasswordPair } from '@/shared/device-password'

interface DevicePasswordDialogProps {
  eventId: string
  device: AdminDevice
  /** The device with its refreshed credential status, for this card alone. */
  onSaved: (device: AdminDevice) => void
}

/**
 * Sets or resets ONE device's password.
 *
 * Deliberately separate from Save Device: a blank password field inside an
 * ordinary edit could mean keep it, clear it, or set an empty one, and a
 * credential change is far too consequential to infer from an empty input.
 *
 * The existing password is never loaded, never revealed and never hinted at —
 * the server holds only a hash, and a reset does not need the old value.
 *
 * There is no Clear Password. Once a device is provisioned the choices are
 * resetting the password or disabling the device; a null hash means
 * "never provisioned", and must never become a way to reach a device without
 * one.
 */
const DevicePasswordDialog: React.FC<DevicePasswordDialogProps> = ({
  eventId,
  device,
  onSaved,
}) => {
  const isReset = device.credentialsConfigured

  const [isOpen, setIsOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  /** Every field, at once, so nothing typed outlives the dialog. */
  const clear = () => {
    setPassword('')
    setConfirmPassword('')
    setError(null)
  }

  const save = async () => {
    if (isSaving) {
      return
    }

    // The same rules the server applies, so the operator is told immediately
    // rather than after a round trip that could only fail.
    const checked = checkPasswordPair({
      password,
      confirmPassword,
      hasLoginName: device.loginName !== null,
      required: true,
    })

    if (!checked.ok) {
      setError(checked.message)

      return
    }

    setIsSaving(true)
    setError(null)

    const result = await setDevicePassword({
      eventId,
      deviceId: device.id,
      password,
      confirmPassword,
    })

    setIsSaving(false)

    if (!result.ok) {
      setError(result.message)

      return
    }

    clear()
    setIsOpen(false)
    onSaved({ ...device, credentialsConfigured: true })
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        setIsOpen(open)
        // Blank on every open AND on every close: a password must never sit
        // in component state after the dialog has gone.
        clear()
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={device.loginName === null}
          >
            <KeyRound data-icon="inline-start" />
            {isReset ? 'Reset Password' : 'Set Password'}
          </Button>
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isReset ? 'Reset Device Password' : 'Set Device Password'}
          </DialogTitle>

          <DialogDescription>
            {device.name}
            {device.loginName === null ? '' : ` · ${device.loginName}`}
          </DialogDescription>
        </DialogHeader>

        <PasswordField
          id={`device-password-${device.id}`}
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          disabled={isSaving}
          hint="8–128 characters. Spaces count, and nothing is trimmed."
        />

        <PasswordField
          id={`device-password-confirm-${device.id}`}
          label="Confirm Password"
          value={confirmPassword}
          onChange={setConfirmPassword}
          autoComplete="new-password"
          disabled={isSaving}
        />

        {error === null ? null : (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        <p className="text-xs leading-relaxed text-muted-foreground">
          {isReset
            ? 'Replaces the stored password. The current one is never shown and is not needed.'
            : 'Stored as a hash. It is never shown again, so record it now.'}
        </p>

        <Button
          type="button"
          disabled={isSaving}
          onClick={() => {
            void save()
          }}
          className="h-12 w-full sm:w-auto sm:min-w-44"
        >
          {isSaving ? 'Saving…' : isReset ? 'Reset Password' : 'Set Password'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export default DevicePasswordDialog
