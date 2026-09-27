import { CircleAlert, Plus, Save } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { createDevice, updateDevice, type AdminDevice } from '@/admin/admin-api'
import DeviceFormFields, {
  type DeviceFormValues,
} from '@/components/admin/device-form-fields'
import { checkPasswordPair } from '@/shared/device-password'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface DeviceDialogProps {
  eventId: string
  /** Absent for a create; present for an edit. */
  device?: AdminDevice
  /** The server-confirmed device, so the caller updates one card in place. */
  onSaved: (device: AdminDevice) => void
}

/**
 * An existing password is NEVER loaded. The server holds only a hash, and a
 * blank field on an edit would be ambiguous — resetting is its own action.
 */
const toValues = (device?: AdminDevice): DeviceFormValues => ({
  name: device?.name ?? '',
  loginName: device?.loginName ?? '',
  enabled: device?.enabled ?? true,
  attributes: device?.attributes ?? [],
  password: '',
  confirmPassword: '',
})

/**
 * Create or edit one central device.
 *
 * There is no delete action, by design: operational history should not
 * casually disappear. A device that should stop being used is disabled.
 */
const DeviceDialog: React.FC<DeviceDialogProps> = ({ eventId, device, onSaved }) => {
  const isEdit = device !== undefined

  const [isOpen, setIsOpen] = useState(false)
  const [values, setValues] = useState<DeviceFormValues>(() => toValues(device))
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (isSaving) {
      return
    }

    if (values.name.trim() === '') {
      setError('Enter a device name.')

      return
    }

    const loginName = values.loginName.trim() === '' ? null : values.loginName.trim()

    /**
     * Create Device only, and checked with the SAME rules the server applies,
     * so a mismatch or a password without a login name is refused before a
     * request that could only fail.
     */
    if (!isEdit) {
      const credentials = checkPasswordPair({
        password: values.password,
        confirmPassword: values.confirmPassword,
        hasLoginName: loginName !== null,
        required: false,
      })

      if (!credentials.ok) {
        setError(credentials.message)

        return
      }
    }

    setIsSaving(true)
    setError(null)

    /**
     * ONE request either way. Edit Device sends its fields and its exact
     * attribute set together, so the server can refuse the whole edit before
     * writing any part of it.
     */
    const result = isEdit
      ? await updateDevice({
          deviceId: device.id,
          eventId,
          name: values.name,
          loginName,
          enabled: values.enabled,
          attributes: values.attributes,
        })
      : await createDevice({
          eventId,
          name: values.name,
          loginName,
          enabled: values.enabled,
          attributes: values.attributes,
          password: values.password,
          confirmPassword: values.confirmPassword,
        })

    setIsSaving(false)

    // The dialog stays open with what the operator typed, so a refused edit
    // can be corrected rather than retyped.
    if (!result.ok) {
      setError(result.message)

      return
    }

    // The plaintext leaves React state the moment the save succeeds.
    setValues(toValues(device))
    setIsOpen(false)
    onSaved(result.value)
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open: boolean) => {
        setIsOpen(open)

        if (open) {
          setValues(toValues(device))
          setError(null)
        }
      }}
    >
      <DialogTrigger
        render={
          isEdit ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
            >
              Edit
            </Button>
          ) : (
            <Button type="button">
              <Plus data-icon="inline-start" />
              Add Device
            </Button>
          )
        }
      />

      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Edit Device' : 'Add Device'}
          </DialogTitle>

          <DialogDescription>
            {isEdit
              ? 'The device id and its event cannot be changed.'
              : 'Creates a central device record for this event.'}
          </DialogDescription>
        </DialogHeader>

        <DeviceFormFields
          idPrefix={isEdit ? `edit-${device.id}` : 'create-device'}
          values={values}
          onChange={setValues}
          activeBadgeRange={device?.activeBadgeRange ?? null}
          showCredentials={!isEdit}
        />

        {error === null ? null : (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}

        <Button
          type="button"
          disabled={isSaving}
          onClick={() => {
            void save()
          }}
          className="h-12 w-full sm:w-auto sm:min-w-44"
        >
          <Save data-icon="inline-start" />
          {isSaving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Device'}
        </Button>
      </DialogContent>
    </Dialog>
  )
}

export default DeviceDialog
