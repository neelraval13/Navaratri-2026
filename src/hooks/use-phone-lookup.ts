import { useCallback, useEffect, useRef, useState } from 'react'

import { PHONE_LENGTH } from '@/components/registration/attendee-validation'
import { db } from '@/db/database'
import type { RegistrationRecord } from '@/db/types'

export type PhoneLookupStatus = 'idle' | 'checking' | 'loaded' | 'failed'

export interface PhoneLookup {
  status: PhoneLookupStatus
  /** Registrations already using the current 10-digit phone number. */
  registrations: RegistrationRecord[]
  retry: () => void
}

/**
 * A settled result, tagged with the exact request it answered.
 */
interface SettledLookup {
  phone: string
  attempt: number
  status: 'loaded' | 'failed'
  registrations: RegistrationRecord[]
}

const NO_REGISTRATIONS: RegistrationRecord[] = []

/**
 * Reads the registrations already using a phone number.
 *
 * The query only runs at exactly 10 raw digits — a partial number is never
 * looked up — and goes through the `phone` index rather than scanning the
 * table.
 *
 * Stale results are prevented twice over. A request version discards a response
 * that is no longer the newest, and the settled result is tagged with the phone
 * number and attempt it answered, so only a result belonging to the number the
 * operator is currently looking at is ever reported. Dropping back below 10
 * digits reports `idle`, which clears both the phone usage result and any
 * identity match derived from it.
 *
 * A failure reports `failed`, never an empty result: duplicate protection must
 * fail closed rather than treat the attendee as new.
 */
export const usePhoneLookup = (phone: string): PhoneLookup => {
  const [settled, setSettled] = useState<SettledLookup | null>(null)
  const [attempt, setAttempt] = useState(0)
  const latestRequestRef = useRef(0)

  useEffect(() => {
    const requestId = latestRequestRef.current + 1
    latestRequestRef.current = requestId

    if (phone.length !== PHONE_LENGTH) {
      return
    }

    db.registrations
      .where('phone')
      .equals(phone)
      .toArray()
      .then((registrations) => {
        if (latestRequestRef.current !== requestId) {
          return
        }

        setSettled({ phone, attempt, status: 'loaded', registrations })
      })
      .catch((error: unknown) => {
        console.error('Navaratri: phone registration lookup failed.', error)

        if (latestRequestRef.current !== requestId) {
          return
        }

        setSettled({
          phone,
          attempt,
          status: 'failed',
          registrations: NO_REGISTRATIONS,
        })
      })
  }, [phone, attempt])

  const retry = useCallback(() => {
    setAttempt((previous) => previous + 1)
  }, [])

  if (phone.length !== PHONE_LENGTH) {
    return { status: 'idle', registrations: NO_REGISTRATIONS, retry }
  }

  const isCurrent =
    settled !== null && settled.phone === phone && settled.attempt === attempt

  if (!isCurrent) {
    return { status: 'checking', registrations: NO_REGISTRATIONS, retry }
  }

  return {
    status: settled.status,
    registrations: settled.registrations,
    retry,
  }
}
