import { useState } from 'react'
import type * as React from 'react'

import AttendeeDetailsStep from '@/components/registration/attendee-details-step'
import {
  getFirstInvalidAttendeeField,
  isGenderValid,
} from '@/components/registration/attendee-validation'
import HoldNotice from '@/components/registration/hold-notice'
import {
  UNKNOWN_IDENTITY_MATCH,
  findOtherRegistrationConflict,
  getIdentityMatch,
} from '@/components/registration/identity-match'
import PaymentStep from '@/components/registration/payment-step'
import RegistrationFormFooter from '@/components/registration/registration-form-footer'
import RegistrationFormHeader from '@/components/registration/registration-form-header'
import type {
  AttendeeField,
  BlockedAttendeeField,
  Gender,
  HoldNotice as HoldNoticeState,
  PaymentMethod,
  RegistrationStep,
} from '@/components/registration/types'
import { Card, CardContent } from '@/components/ui/card'
import { holdRegistration } from '@/db/registrations'
import type { HeldRegistration } from '@/db/types'
import { usePhoneLookup } from '@/hooks/use-phone-lookup'
import { formatBadgeNumber } from '@/lib/badge'

/**
 * Static for this phase. Real badge allocation arrives in a later phase.
 */
const CURRENT_BADGE_NUMBER = 1

const HOLD_ERROR_MESSAGES = {
  write: 'Unable to hold registration. Try again.',
  missingConfig:
    'Event configuration is missing, so nothing was saved. Reload the app and try again.',
  heldConflict:
    'This attendee is already on hold. Nothing was saved — resume the existing hold instead.',
  completedConflict:
    'This attendee already has a badge. Nothing was saved.',
} as const

/**
 * What is stopping Step 1 from progressing, if anything.
 */
type StepOneBlock =
  | { kind: 'field'; field: AttendeeField }
  | { kind: 'database' }
  | { kind: 'identity' }

const RegistrationForm: React.FC = () => {
  const [currentStep, setCurrentStep] = useState<RegistrationStep>('attendee')

  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [age, setAge] = useState('')
  const [gender, setGender] = useState<Gender>('')

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('upi')
  const [paymentMethodTouched, setPaymentMethodTouched] = useState(false)
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)

  const [revealedFields, setRevealedFields] = useState<AttendeeField[]>([])
  const [blockedField, setBlockedField] = useState<BlockedAttendeeField | null>(
    null,
  )
  const [blockedDatabaseCheck, setBlockedDatabaseCheck] = useState(0)

  /**
   * The id of the held registration currently being edited, or null for a
   * brand-new draft. A resumed registration keeps this id through Back, edits
   * and re-holds, so it always updates the same row.
   */
  const [activeHeldRegistrationId, setActiveHeldRegistrationId] = useState<
    string | null
  >(null)

  const [isHolding, setIsHolding] = useState(false)
  const [holdNotice, setHoldNotice] = useState<HoldNoticeState | null>(null)

  const phoneLookup = usePhoneLookup(phone)

  /**
   * Matched in memory against the already-loaded phone result set, so a name
   * keystroke never issues another query.
   */
  const identityMatch =
    phoneLookup.status === 'loaded'
      ? getIdentityMatch(phoneLookup.registrations, name)
      : UNKNOWN_IDENTITY_MATCH

  /**
   * Two separate questions, which used to be conflated:
   *
   * 1. Is a held registration being edited at all? That is true from Resume
   *    until Clear, a successful Hold, or another reset — even after the
   *    operator corrects the phone or name, because re-holding still updates
   *    that same row.
   * 2. Does the entered identity collide with a DIFFERENT registration?
   *
   * Global duplicate detection is never weakened: the record being edited is
   * simply not a duplicate of itself, and that distinction is drawn here at the
   * product-flow layer rather than inside the matcher.
   */
  const isEditingHeldRegistration = activeHeldRegistrationId !== null

  /**
   * Derived from the FULL already-loaded phone result set rather than from the
   * single best match, so a second held record for the same identity cannot
   * hide behind the active one. No extra query is issued.
   */
  const otherRegistrationConflict =
    phoneLookup.status === 'loaded'
      ? findOtherRegistrationConflict(
          phoneLookup.registrations,
          name,
          activeHeldRegistrationId,
        )
      : null

  const badgeLabel = formatBadgeNumber(CURRENT_BADGE_NUMBER)

  const revealField = (field: AttendeeField) => {
    setRevealedFields((fields) =>
      fields.includes(field) ? fields : [...fields, field],
    )
  }

  const blockField = (field: AttendeeField) => {
    setBlockedField((previous) => ({
      field,
      attempt: (previous?.attempt ?? 0) + 1,
    }))
  }

  /**
   * Shared by Next and Hold: neither may act on an attendee who is invalid,
   * unresolved, or already registered.
   *
   * Duplicate protection fails closed — a lookup that is still running or that
   * failed blocks, rather than assuming a new attendee.
   */
  const findStepOneBlock = (): StepOneBlock | null => {
    const firstInvalidField = getFirstInvalidAttendeeField(
      phone,
      name,
      age,
      gender,
    )

    if (firstInvalidField !== null) {
      return { kind: 'field', field: firstInvalidField }
    }

    if (phoneLookup.status !== 'loaded') {
      return { kind: 'database' }
    }

    if (otherRegistrationConflict !== null) {
      return { kind: 'identity' }
    }

    return null
  }

  const applyStepOneBlock = (block: StepOneBlock) => {
    if (block.kind === 'field') {
      revealField(block.field)
      blockField(block.field)

      return
    }

    if (block.kind === 'database') {
      // Not a field problem, so no field is marked invalid. The database status
      // under the phone field is the honest explanation.
      setBlockedDatabaseCheck((previous) => previous + 1)

      return
    }

    blockField('name')
  }

  const resetDraft = () => {
    setPhone('')
    setName('')
    setAge('')
    setGender('')
    setPaymentMethod('upi')
    setPaymentMethodTouched(false)
    setPaymentConfirmed(false)
    setCurrentStep('attendee')
    setRevealedFields([])
    setBlockedField(null)
    setBlockedDatabaseCheck(0)
    setActiveHeldRegistrationId(null)
  }

  /**
   * Entering anything means the next registration has begun, so the previous
   * hold's confirmation is no longer relevant.
   */
  const handlePhoneChange = (nextPhone: string) => {
    setHoldNotice(null)
    setPhone(nextPhone)
  }

  const handleNameChange = (nextName: string) => {
    setHoldNotice(null)
    setName(nextName)
  }

  const handleAgeChange = (nextAge: string) => {
    setHoldNotice(null)
    setAge(nextAge)
  }

  const handleGenderChange = (nextGender: Gender) => {
    setHoldNotice(null)
    setGender(nextGender)
  }

  const handleNext = () => {
    const block = findStepOneBlock()

    if (block !== null) {
      applyStepOneBlock(block)

      return
    }

    setBlockedField(null)
    setCurrentStep('payment')
  }

  const handleBack = () => {
    setCurrentStep('attendee')
  }

  const handlePaymentMethodChange = (nextPaymentMethod: PaymentMethod) => {
    setPaymentMethod(nextPaymentMethod)
    setPaymentMethodTouched(true)
    setPaymentConfirmed(false)
  }

  const handlePaymentConfirmation = () => {
    setPaymentConfirmed(true)
  }

  /**
   * Abandons the current editing session. A resumed hold stays saved in
   * IndexedDB untouched — Clear never deletes or mutates a held record.
   */
  const handleClear = () => {
    setHoldNotice(null)
    resetDraft()
  }

  /**
   * Resume is read-only: it loads the stored values into the draft and opens
   * Payment, where the operator left off. Nothing is written, and no badge is
   * assigned.
   */
  const handleResume = (registration: HeldRegistration) => {
    setPhone(registration.phone)
    setName(registration.name)
    setAge(String(registration.age))
    setGender(registration.gender)
    setActiveHeldRegistrationId(registration.id)

    setPaymentMethod(registration.paymentMethod ?? 'upi')
    // Restoring a stored method is not the operator explicitly choosing one.
    setPaymentMethodTouched(false)
    setPaymentConfirmed(false)

    setRevealedFields([])
    setBlockedField(null)
    setBlockedDatabaseCheck(0)
    setHoldNotice(null)

    setCurrentStep('payment')
  }

  const performHold = async () => {
    const block = findStepOneBlock()

    if (block !== null) {
      applyStepOneBlock(block)

      return
    }

    // Already guaranteed by the field validation above; this narrows the UI
    // selection type to the domain gender.
    if (!isGenderValid(gender)) {
      return
    }

    setIsHolding(true)
    setHoldNotice(null)

    try {
      const result = await holdRegistration({
        registrationId: activeHeldRegistrationId,
        phone,
        name,
        age: Number(age),
        gender,
        /**
         * Explicit only: the method is persisted when the operator is on the
         * payment step or has actually changed it. Otherwise null keeps whatever
         * a resumed record already had and stores nothing for a new hold.
         */
        paymentMethod:
          currentStep === 'payment' || paymentMethodTouched
            ? paymentMethod
            : null,
      })

      if (result.outcome === 'created' || result.outcome === 'updated') {
        resetDraft()
        setHoldNotice({ kind: 'held', name: result.registration.name })

        return
      }

      if (result.outcome === 'missing-config') {
        setHoldNotice({
          kind: 'error',
          message: HOLD_ERROR_MESSAGES.missingConfig,
        })

        return
      }

      // A conflict only reaches here when the UI lookup was stale. Nothing was
      // written, and the draft is preserved.
      setHoldNotice({
        kind: 'error',
        message:
          result.outcome === 'completed-conflict'
            ? HOLD_ERROR_MESSAGES.completedConflict
            : HOLD_ERROR_MESSAGES.heldConflict,
      })
      blockField('name')
    } catch (error: unknown) {
      console.error('Navaratri: hold registration failed.', error)

      // The draft is deliberately left intact so nothing the operator typed is
      // lost and they can simply press Hold again.
      setHoldNotice({ kind: 'error', message: HOLD_ERROR_MESSAGES.write })
    } finally {
      setIsHolding(false)
    }
  }

  const handleHold = () => {
    if (isHolding) {
      return
    }

    void performHold()
  }

  return (
    <Card>
      <RegistrationFormHeader badgeLabel={badgeLabel} />

      <CardContent className="space-y-6">
        {holdNotice === null ? null : <HoldNotice notice={holdNotice} />}

        {currentStep === 'attendee' ? (
          <AttendeeDetailsStep
            phone={phone}
            name={name}
            age={age}
            gender={gender}
            revealedFields={revealedFields}
            blockedField={blockedField}
            phoneLookup={phoneLookup}
            identityMatch={identityMatch}
            blockedDatabaseCheck={blockedDatabaseCheck}
            isEditingHeldRegistration={isEditingHeldRegistration}
            otherRegistrationConflict={otherRegistrationConflict}
            onResume={handleResume}
            onPhoneChange={handlePhoneChange}
            onNameChange={handleNameChange}
            onAgeChange={handleAgeChange}
            onGenderChange={handleGenderChange}
            onRevealField={revealField}
          />
        ) : (
          <PaymentStep
            phone={phone}
            name={name}
            age={age}
            gender={gender}
            paymentMethod={paymentMethod}
            paymentConfirmed={paymentConfirmed}
            onPaymentMethodChange={handlePaymentMethodChange}
            onConfirmPayment={handlePaymentConfirmation}
          />
        )}
      </CardContent>

      <RegistrationFormFooter
        currentStep={currentStep}
        paymentConfirmed={paymentConfirmed}
        badgeLabel={badgeLabel}
        isHolding={isHolding}
        onNext={handleNext}
        onBack={handleBack}
        onClear={handleClear}
        onHold={handleHold}
      />
    </Card>
  )
}

export default RegistrationForm
