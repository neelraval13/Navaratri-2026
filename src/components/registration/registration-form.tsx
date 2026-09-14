import { useState } from 'react'
import type * as React from 'react'

import AttendeeDetailsStep from '@/components/registration/attendee-details-step'
import { getFirstInvalidAttendeeField } from '@/components/registration/attendee-validation'
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

  const badgeLabel = formatBadgeNumber(CURRENT_BADGE_NUMBER)

  const revealField = (field: AttendeeField) => {
    setRevealedFields((fields) =>
      fields.includes(field) ? fields : [...fields, field],
    )
  }

  /**
   * Next always looks actionable, but it only advances once every attendee
   * detail is valid. Otherwise it points the operator at the first blocker.
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

      setBlockedField((previous) => ({
        field: firstInvalidField,
        attempt: (previous?.attempt ?? 0) + 1,
      }))

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
