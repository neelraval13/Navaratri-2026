/**
 * What a central device is authorized to do.
 *
 * The DATABASE stores plain text on purpose, so adding `dandiya` or `checkin`
 * later needs no type change. The APPLICATION owns the current allow-list, so
 * arbitrary free text can never be written through Admin.
 *
 * Framework-free: the browser renders the checkboxes from this list and the
 * server validates against the same one, so the two cannot drift.
 */
export const DEVICE_ATTRIBUTES = ['registration', 'prizes', 'attendees'] as const

export type DeviceAttribute = (typeof DEVICE_ATTRIBUTES)[number]

export const DEVICE_ATTRIBUTE_LABELS: Record<DeviceAttribute, string> = {
  registration: 'Registration',
  prizes: 'Prizes',
  attendees: 'Attendees',
}

/**
 * `registration` is the WHOLE registration-desk workflow, badge issuance
 * included: attendee entry, hold and resume, payment, owning a badge-number
 * range, handing over the physical badge and advancing the local `nextBadge`
 * offline. Issuing a badge is the last step of registering an attendee, not a
 * separate job, so it is not a separate permission.
 *
 * The badge RANGE remains separate data. `registration` says the device may
 * run the workflow; `badge_assignments` says which physical numbers it owns.
 */
export const DEVICE_ATTRIBUTE_DESCRIPTIONS: Record<DeviceAttribute, string> = {
  registration:
    'Full registration desk: attendee entry, payment and issuing physical badges.',
  prizes: 'May use Prize functionality.',
  attendees: 'Read-only attendee directory. Views registrations; changes nothing.',
}

/**
 * The attribute an active badge range depends on.
 *
 * A device owning physical badge numbers must keep whatever authorizes it to
 * hand them out, and releasing a range safely is a reconciliation problem
 * this phase does not solve.
 *
 * Shared deliberately: the Admin form locks the checkbox with it and the
 * server refuses the write with it, so the instant UI guard and the real
 * protection can never disagree about which attribute is required.
 */
export const BADGE_RANGE_REQUIRED_ATTRIBUTE: DeviceAttribute = 'registration'

/**
 * EVERY ATTRIBUTE IS INDEPENDENT, and the three must stay that way.
 *
 * `prizes` does NOT imply `attendees` and `registration` does not either. The
 * prize desk shows its own attendee roster because identifying the badge in
 * somebody's hand is part of awarding a prize; the standalone DIRECTORY —
 * every registered attendee, browsable and searchable by anyone holding the
 * tablet — is a separate thing to be trusted with, so it is separately
 * granted. A device may hold `attendees` alone, and that is a complete and
 * useful device.
 *
 * Implying one from another would also make the Admin checkboxes lie: an
 * operator unticking Attendees would expect the directory to close.
 */

/**
 * The attribute the Prizes module requires.
 *
 * Shared for exactly the reason the badge one is: the route gate, the prize
 * page and `GET`/`POST /api/prizes` all ask the same question, and the
 * endpoint is the one that decides. A device holding only `prizes` is a
 * complete prize desk — it needs no `registration`, no badge range and no
 * central badge binding, because awarding a prize consumes no badge number.
 */
export const PRIZE_REQUIRED_ATTRIBUTE: DeviceAttribute = 'prizes'

/**
 * The attribute the read-only Attendee Directory requires.
 *
 * Shared for the same reason the other two are: the route gate, the page and
 * `GET /api/attendees` all ask the same question, and the endpoint is the one
 * that decides. A device holding only `attendees` is a complete viewer — it
 * needs no `registration`, no `prizes`, no badge range and no central badge
 * binding, because reading a register consumes and changes nothing.
 */
export const ATTENDEE_DIRECTORY_REQUIRED_ATTRIBUTE: DeviceAttribute = 'attendees'

export const isDeviceAttribute = (value: unknown): value is DeviceAttribute => {
  return (
    typeof value === 'string' &&
    (DEVICE_ATTRIBUTES as readonly string[]).includes(value)
  )
}

export type AttributeSetResult =
  | { ok: true; attributes: DeviceAttribute[] }
  | { ok: false; message: string }

/**
 * Validates a requested attribute set.
 *
 * Duplicates are collapsed rather than rejected — asking for `registration`
 * twice is the same request — but an unknown value is refused outright, never
 * silently dropped. The result is sorted so the stored set is deterministic.
 */
export const parseAttributeSet = (value: unknown): AttributeSetResult => {
  if (!Array.isArray(value)) {
    return { ok: false, message: 'attributes must be an array.' }
  }

  const unknown = value.filter((entry) => !isDeviceAttribute(entry))

  if (unknown.length > 0) {
    return {
      ok: false,
      message: `attributes must each be one of: ${DEVICE_ATTRIBUTES.join(', ')}.`,
    }
  }

  return {
    ok: true,
    attributes: [...new Set(value as DeviceAttribute[])].sort(
      (left, right) =>
        DEVICE_ATTRIBUTES.indexOf(left) - DEVICE_ATTRIBUTES.indexOf(right),
    ),
  }
}
