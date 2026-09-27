import type * as React from 'react'

import type { AdminBadgeRange } from '@/admin/admin-api'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { formatBadgeRange } from '@/db/device'
import {
  BADGE_RANGE_REQUIRED_ATTRIBUTE,
  DEVICE_ATTRIBUTES,
  DEVICE_ATTRIBUTE_DESCRIPTIONS,
  DEVICE_ATTRIBUTE_LABELS,
  type DeviceAttribute,
} from '@/shared/device-attributes'

export interface DeviceFormValues {
  name: string
  loginName: string
  enabled: boolean
  attributes: DeviceAttribute[]
}

interface DeviceFormFieldsProps {
  idPrefix: string
  values: DeviceFormValues
  onChange: (values: DeviceFormValues) => void
  /** Present only when editing a device that already owns badge numbers. */
  activeBadgeRange?: AdminBadgeRange | null
}

/**
 * The fields shared by Create Device and Edit Device.
 *
 * There is deliberately NO password field. Device passwords arrive with the
 * next authentication phase, and a disabled or fake one here would suggest a
 * protection that does not exist.
 */
const DeviceFormFields: React.FC<DeviceFormFieldsProps> = ({
  idPrefix,
  values,
  onChange,
  activeBadgeRange = null,
}) => {
  /**
   * A device owning physical badge numbers must keep whatever authorizes it
   * to hand them out. The server refuses the removal either way; locking the
   * checkbox means the operator is told immediately instead of after a round
   * trip that could only ever fail. Create Device is unaffected — a new
   * device owns no range yet.
   */
  const lockedAttribute =
    activeBadgeRange === null ? null : BADGE_RANGE_REQUIRED_ATTRIBUTE
  const toggleAttribute = (attribute: DeviceAttribute, checked: boolean) => {
    const next = new Set(values.attributes)

    if (checked) {
      next.add(attribute)
    } else {
      next.delete(attribute)
    }

    onChange({
      ...values,
      attributes: DEVICE_ATTRIBUTES.filter((entry) => next.has(entry)),
    })
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-name`}>
          Device name
        </Label>

        <Input
          id={`${idPrefix}-name`}
          value={values.name}
          placeholder="Registration Desk A"
          onChange={(event) => {
            onChange({ ...values, name: event.target.value })
          }}
          className="h-12"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor={`${idPrefix}-login-name`}>
          Login name
        </Label>

        <Input
          id={`${idPrefix}-login-name`}
          value={values.loginName}
          placeholder="desk-a"
          onChange={(event) => {
            onChange({ ...values, loginName: event.target.value })
          }}
          className="h-12"
        />

        <p className="text-xs text-muted-foreground">
          Lowercase letters, numbers and single hyphens. Used for device sign-in
          in the next authentication phase; there is no password yet.
        </p>
      </div>

      <Label
        htmlFor={`${idPrefix}-enabled`}
        className="flex items-start gap-3 font-normal"
      >
        <input
          id={`${idPrefix}-enabled`}
          type="checkbox"
          checked={values.enabled}
          onChange={(event) => {
            onChange({ ...values, enabled: event.target.checked })
          }}
          className="mt-0.5 size-5 shrink-0 accent-primary"
        />

        <span className="text-sm leading-relaxed">
          Enabled
        </span>
      </Label>

      <div className="space-y-2">
        <p className="text-sm font-medium">
          Access
        </p>

        {DEVICE_ATTRIBUTES.map((attribute) => {
          const isLocked = attribute === lockedAttribute

          return (
            <Label
              key={attribute}
              htmlFor={`${idPrefix}-attribute-${attribute}`}
              className="flex items-start gap-3 font-normal"
            >
              <input
                id={`${idPrefix}-attribute-${attribute}`}
                type="checkbox"
                checked={isLocked || values.attributes.includes(attribute)}
                disabled={isLocked}
                onChange={(event) => {
                  toggleAttribute(attribute, event.target.checked)
                }}
                className="mt-0.5 size-5 shrink-0 accent-primary disabled:opacity-100"
              />

              <span className="text-sm leading-relaxed">
                {DEVICE_ATTRIBUTE_LABELS[attribute]}

                <span className="block text-xs text-muted-foreground">
                  {isLocked && activeBadgeRange !== null
                    ? `Required while this device owns badge range ${formatBadgeRange(activeBadgeRange.rangeStart, activeBadgeRange.rangeEnd)}.`
                    : DEVICE_ATTRIBUTE_DESCRIPTIONS[attribute]}
                </span>
              </span>
            </Label>
          )
        })}
      </div>
    </div>
  )
}

export default DeviceFormFields
