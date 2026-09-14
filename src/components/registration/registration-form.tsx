import { useState } from 'react'
import type * as React from 'react'

import AttendeeDetailsStep from '@/components/registration/attendee-details-step'
import {
  getFirstInvalidAttendeeField,
  isGenderValid,
} from '@/components/registration/attendee-validation'
import BadgeIssuedStep from '@/components/registration/badge-issued-step'
import EventConfigGate from '@/components/registration/event-config-gate'
import FormNotice from '@/components/registration/form-notice'
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
  FormNotice as FormNoticeState,
  Gender,
  PaymentMethod,
  RegistrationStep,
} from '@/components/registration/types'
import { Card, CardContent } from '@/components/ui/card'
import { hasBadgeAvailable } from '@/db/event-config'
import { holdRegistration, issueBadge } from '@/db/registrations'
import type { CompletedRegistration, HeldRegistration } from '@/db/types'
import { useEventConfig } from '@/hooks/use-event-config'
import { useJitter } from '@/hooks/use-jitter'
import { usePhoneLookup } from '@/hooks/use-phone-lookup'
import { formatBadgeNumber } from '@/lib/badge'
import { cn } from '@/lib/utils'

const HOLD_ERROR_MESSAGES = {
  write: 'Unable to hold registration. Try again.',
  missingConfig:
    'Event configuration is missing, so nothing was saved. Reload the app and try again.',
  heldConflict:
    'This attendee is already on hold. Nothing was saved — resume the existing hold instead.',
  completedConflict: 'This attendee already has a badge. Nothing was saved.',
} as const

const ISSUE_ERROR_MESSAGES = {
  write: 'Unable to issue badge. Try again.',
  'missing-config':
    'Event configuration is unavailable. Badge was not issued.',
  'missing-active-registration':
    'The held registration could not be found. Badge was not issued.',
  'completed-conflict':
    'This attendee is already registered. Badge was not issued.',
  'held-conflict':
    'Another held registration exists for this attendee. Badge was not issued.',
  'badge-range-exhausted':
    "No badges remain in this desk's assigned range.",
  'badge-conflict':
    'The next badge number is already assigned. Badge was not issued.',
} as const

const BADGE_RANGE_EXHAUSTED_NOTICE: FormNoticeState = {
  kind: 'error',
  message: "No badges remaining in this desk's assigned range.",
}

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
   * brand-new draft. A resumed registration keeps this id through Back, edits,
   * re-holds and badge issuance, so it always updates the same row.
   */
  const [activeHeldRegistrationId, setActiveHeldRegistrationId] = useState<
    string | null
  >(null)

  const [isHolding, setIsHolding] = useState(false)
  const [isIssuing, setIsIssuing] = useState(false)
  const [formNotice, setFormNotice] = useState<FormNoticeState | null>(null)

  /**
   * The badge that was just allocated, awaiting hand-over. While this is set the
   * form shows the completion state instead of either step.
   */
  const [issuedRegistration, setIssuedRegistration] =
    useState<CompletedRegistration | null>(null)

  const eventConfig = useEventConfig()
  const phoneLookup = usePhoneLookup(phone)

  const {
    jitteringField: badgeRangeJitter,
    triggerJitter: triggerBadgeRangeJitter,
    clearJitter: clearBadgeRangeJitter,
  } = useJitter<'badge-range'>()

  /**
   * Computed before the handlers so Next and Resume can both consult it. It is
   * false while the configuration is still loading, which is harmless because
   * the form is not rendered until it has loaded.
   */
  const canIssueBadge =
    eventConfig.config !== null && hasBadgeAvailable(eventConfig.config)

  /**
   * Matched in memory against the already-loaded phone result set, so a name
   * keystroke never issues another query.
   */
  const identityMatch =
    phoneLookup.status === 'loaded'
      ? getIdentityMatch(phoneLookup.registrations, name)
      : UNKNOWN_IDENTITY_MATCH

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
    setIssuedRegistration(null)
  }

  /**
   * Entering anything means the next registration has begun, so the previous
   * write's confirmation is no longer relevant.
   */
  const handlePhoneChange = (nextPhone: string) => {
    setFormNotice(null)
    setPhone(nextPhone)
  }

  const handleNameChange = (nextName: string) => {
    setFormNotice(null)
    setName(nextName)
  }

  const handleAgeChange = (nextAge: string) => {
    setFormNotice(null)
    setAge(nextAge)
  }

  const handleGenderChange = (nextGender: Gender) => {
    setFormNotice(null)
    setGender(nextGender)
  }

  const handleNext = () => {
    /**
     * Checked BEFORE field validation, so a blocked Next never fabricates an
     * attendee-field error to explain a range problem.
     *
     * With no badge available, Payment must be unreachable: the operator must
     * never collect the fee with nothing to hand over. The form-level error is
     * already on screen, so the press only re-emphasises it. Hold is unaffected
     * — a hold consumes no badge.
     */
    if (!canIssueBadge) {
      triggerBadgeRangeJitter('badge-range')

      return
    }

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
    setFormNotice(null)
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
    setFormNotice(null)

    // Resume normally opens Payment, where the operator left off — but it must
    // not become a back door into Payment when no badge is available. The
    // restored draft can still be edited and re-held from Step 1.
    setCurrentStep(canIssueBadge ? 'payment' : 'attendee')
  }

  /**
   * Starts the next attendee. The issuing transaction already advanced
   * `nextBadge`, so this performs no database write at all.
   */
  const handleNextPerson = () => {
    setFormNotice(null)
    resetDraft()
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
    setFormNotice(null)

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
        setFormNotice({ kind: 'held', name: result.registration.name })

        return
      }

      if (result.outcome === 'missing-config') {
        setFormNotice({
          kind: 'error',
          message: HOLD_ERROR_MESSAGES.missingConfig,
        })

        return
      }

      // A conflict only reaches here when the UI lookup was stale. Nothing was
      // written, and the draft is preserved.
      setFormNotice({
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
      setFormNotice({ kind: 'error', message: HOLD_ERROR_MESSAGES.write })
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

  const performIssueBadge = async () => {
    // Payment is manually confirmed before this action is ever offered; the
    // check is defensive, and the transaction is the real guarantee.
    if (!paymentConfirmed || !isGenderValid(gender)) {
      return
    }

    setIsIssuing(true)
    setFormNotice(null)

    try {
      const result = await issueBadge({
        registrationId: activeHeldRegistrationId,
        phone,
        name,
        age: Number(age),
        gender,
        paymentMethod,
      })

      if (result.outcome === 'issued') {
        // The service returns the stored row, so the displayed badge number is
        // never recomputed locally and cannot drift from IndexedDB.
        eventConfig.applyConfig(result.config)
        setIssuedRegistration(result.registration)

        return
      }

      // Nothing was written: no registration, no outbox row, no badge consumed.
      setFormNotice({
        kind: 'error',
        message: ISSUE_ERROR_MESSAGES[result.outcome],
      })
    } catch (error: unknown) {
      console.error('Navaratri: issuing badge failed.', error)

      // Payment stays confirmed and the draft stays intact so the operator can
      // simply retry.
      setFormNotice({ kind: 'error', message: ISSUE_ERROR_MESSAGES.write })
    } finally {
      setIsIssuing(false)
    }
  }

  const handleIssueBadge = () => {
    if (isIssuing) {
      return
    }

    void performIssueBadge()
  }

  if (eventConfig.status !== 'loaded' || eventConfig.config === null) {
    return (
      <EventConfigGate
        status={eventConfig.status === 'failed' ? 'failed' : 'loading'}
        onRetry={eventConfig.reload}
      />
    )
  }

  const config = eventConfig.config
  const isComplete = issuedRegistration !== null

  /**
   * While handing a badge over, the header must show the badge just allocated,
   * not the next one waiting.
   */
  const badgeLabel = formatBadgeNumber(
    issuedRegistration?.badgeNumber ?? config.nextBadge,
  )

  return (
    <Card>
      <RegistrationFormHeader
        badgeLabel={badgeLabel}
        mode={isComplete ? 'allocated' : 'to-allocate'}
      />

      <CardContent className="space-y-6">
        {formNotice === null ? null : <FormNotice notice={formNotice} />}

        {/*
          Suppressed during completion: a badge that was just handed over must
          still be announced normally, even when its increment exhausted the
          range. The block applies again from the next Step 1.
        */}
        {canIssueBadge || isComplete ? null : (
          <div
            className={cn(badgeRangeJitter === 'badge-range' && 'jitter')}
            onAnimationEnd={clearBadgeRangeJitter}
          >
            <FormNotice notice={BADGE_RANGE_EXHAUSTED_NOTICE} />
          </div>
        )}

        {issuedRegistration !== null ? (
          <BadgeIssuedStep registration={issuedRegistration} />
        ) : currentStep === 'attendee' ? (
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
            amount={config.amount}
            eventName={config.eventName}
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
        isIssuing={isIssuing}
        isComplete={isComplete}
        canIssueBadge={canIssueBadge}
        onNext={handleNext}
        onBack={handleBack}
        onClear={handleClear}
        onHold={handleHold}
        onIssueBadge={handleIssueBadge}
        onNextPerson={handleNextPerson}
      />
    </Card>
  )
}

export default RegistrationForm
