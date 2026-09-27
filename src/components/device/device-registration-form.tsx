import { CircleAlert, Save } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { registerDevice } from '@/db/device'
import { DEVICE_NAME_MAX_LENGTH } from '@/shared/device'

interface DeviceRegistrationFormProps {
  onRegistered: () => void
}

/**
 * Generic device registration: a name, and nothing else.
 *
 * No badge range and no physical-stack confirmation. Not every event device
 * hands out badges, so asking about badges here would be asking the wrong
 * question of a prize or dandiya desk.
 */
const DeviceRegistrationForm: React.FC<DeviceRegistrationFormProps> = ({
  onRegistered,
}) => {
  const [deviceName, setDeviceName] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSaving) {
      return
    }

    if (deviceName.trim() === '') {
      setError('Enter a device name.')

      return
    }

    setIsSaving(true)
    setError(null)

    const result = await registerDevice({ deviceName })

    setIsSaving(false)

    if (result.outcome === 'registered' || result.outcome === 'already-registered') {
      onRegistered()

      return
    }

    if (result.outcome === 'existing-data') {
      setError(
        'This device already contains registration data and cannot be initialized automatically. Reconciliation is required.',
      )

      return
    }

    if (result.outcome === 'invalid-name') {
      setError(`Enter a device name of 1-${String(DEVICE_NAME_MAX_LENGTH)} characters.`)

      return
    }

    setError('Event configuration is unavailable. Reload the app and try again.')
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="space-y-6"
    >
      <div className="space-y-2">
        <Label htmlFor="device-name">
          Device name
        </Label>

        <Input
          id="device-name"
          type="text"
          placeholder="Registration Desk A"
          maxLength={DEVICE_NAME_MAX_LENGTH}
          value={deviceName}
          onChange={(event) => {
            setDeviceName(event.target.value)
          }}
          className="h-12"
        />
      </div>

      {error === null ? null : (
        <p className="flex items-start gap-2 text-sm text-destructive">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}

      <Button
        type="submit"
        disabled={isSaving}
        className="h-12 w-full sm:w-auto sm:min-w-48"
      >
        <Save data-icon="inline-start" />
        {isSaving ? 'Registering…' : 'Register Device'}
      </Button>
    </form>
  )
}

export default DeviceRegistrationForm
