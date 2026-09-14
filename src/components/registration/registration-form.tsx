import { useState } from 'react'
import type * as React from 'react'

import AttendeeDetailsStep from '@/components/registration/attendee-details-step'
import { getFirstInvalidAttendeeField } from '@/components/registration/attendee-validation'
import {
  UNKNOWN_IDENTITY_MATCH,
  getIdentityMatch,
} from '@/components/registration/identity-match'
import PaymentStep from '@/components/registration/payment-step'
import RegistrationFormFooter from '@/components/registration/registration-form-footer'
import RegistrationFormHeader from '@/components/registration/registration-form-header'
import type {
  AttendeeField,
  BlockedAttendeeField,
  Gender,
  PaymentMethod,
  RegistrationStep,
} from '@/components/registration/types'
import { Card, CardContent } from '@/components/ui/card'
import { usePhoneLookup } from '@/hooks/use-phone-lookup'
import { formatBadgeNumber } from '@/lib/badge'

/**
 * Static for this phase. Real badge allocation arrives in a later phase.
 */
const CURRENT_BADGE_NUMBER = 1

const RegistrationForm: React.FC = () => {
  const [currentStep, setCurrentStep] = useState<RegistrationStep>('attendee')

  const [phone, setPhone] = useState('')
  const [name, setName] = useState('')
  const [age, setAge] = useState('')
  const [gender, setGender] = useState<Gender>('')

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('upi')
  const [paymentConfirmed, setPaymentConfirmed] = useState(false)

  const [revealedFields, setRevealedFields] = useState<AttendeeField[]>([])
  const [blockedField, setBlockedField] = useState<BlockedAttendeeField | null>(
    null,
  )
  const [blockedDatabaseCheck, setBlockedDatabaseCheck] = useState(0)

  const phoneLookup = usePhoneLookup(phone)

  /**
   * Matched in memory against the already-loaded phone result set, so a name
   * keystroke never issues another query.
   */
  const identityMatch =
    phoneLookup.status === 'loaded'
      ? getIdentityMatch(phoneLookup.registrations, name)
      : UNKNOWN_IDENTITY_MATCH

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
   * Next always looks actionable, but it only advances once every attendee
   * detail is valid AND this identity is eligible to register.
   *
   * Duplicate protection fails closed: a lookup that is still running or that
   * failed blocks progression rather than assuming a new attendee.
   */
  const handleNext = () => {
    const firstInvalidField = getFirstInvalidAttendeeField(
      phone,
      name,
      age,
      gender,
    )

    if (firstInvalidField !== null) {
      revealField(firstInvalidField)
      blockField(firstInvalidField)

      return
    }

    if (phoneLookup.status !== 'loaded') {
      // Not a field problem, so no field is marked invalid. The database status
      // under the phone field is the honest explanation.
      setBlockedDatabaseCheck((previous) => previous + 1)

      return
    }

    if (identityMatch.kind === 'held' || identityMatch.kind === 'completed') {
      blockField('name')

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
    setPaymentConfirmed(false)
  }

  const handlePaymentConfirmation = () => {
    setPaymentConfirmed(true)
  }

  const handleClear = () => {
    setPhone('')
    setName('')
    setAge('')
    setGender('')
    setPaymentMethod('upi')
    setPaymentConfirmed(false)
    setCurrentStep('attendee')
    setRevealedFields([])
    setBlockedField(null)
    setBlockedDatabaseCheck(0)
  }

  return (
    <Card>
      <RegistrationFormHeader badgeLabel={badgeLabel} />

      <CardContent>
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
            onPhoneChange={setPhone}
            onNameChange={setName}
            onAgeChange={setAge}
            onGenderChange={setGender}
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
        onNext={handleNext}
        onBack={handleBack}
        onClear={handleClear}
      />
    </Card>
  )
}

export default RegistrationForm
