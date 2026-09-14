import type * as React from 'react'

import type { Gender, PaymentMethod } from '@/components/registration/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { formatPhoneNumber } from '@/lib/phone'
import { cn } from '@/lib/utils'

const GENDER_LABELS: Record<Exclude<Gender, ''>, string> = {
  male: 'Male',
  female: 'Female',
}

const PAYMENT_METHOD_OPTION_CLASS_NAME =
  'h-12 gap-3 rounded-4xl border border-input px-5 font-medium has-data-[checked]:border-primary has-data-[checked]:bg-primary/5'

interface PaymentStepProps {
  phone: string
  name: string
  age: string
  gender: Gender
  paymentMethod: PaymentMethod
  paymentConfirmed: boolean
  onPaymentMethodChange: (paymentMethod: PaymentMethod) => void
  onConfirmPayment: () => void
}

const PaymentStep: React.FC<PaymentStepProps> = ({
  phone,
  name,
  age,
  gender,
  paymentMethod,
  paymentConfirmed,
  onPaymentMethodChange,
  onConfirmPayment,
}) => {
  const attendeeName = name.trim()

  const attendeeDetails = [
    phone.trim() ? `+91 ${formatPhoneNumber(phone.trim())}` : '',
    age.trim(),
    gender ? GENDER_LABELS[gender] : '',
  ]
    .filter((detail) => detail !== '')
    .join(' · ')

  /**
   * A confirmed payment cannot be undone from within this registration, so the
   * method is locked once it has been confirmed. The selected option keeps its
   * primary accent; the option that was not used fades out.
   */
  const paymentMethodOptionClassName = cn(
    PAYMENT_METHOD_OPTION_CLASS_NAME,
    paymentConfirmed
      ? 'cursor-not-allowed has-data-[unchecked]:opacity-50'
      : 'cursor-pointer',
  )

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Step 2 of 2
        </p>

        <h2 className="font-heading text-2xl font-semibold">
          Payment
        </h2>
      </div>

      <div className="space-y-6">
        <div className="rounded-2xl border border-border bg-muted/30 px-5 py-4">
          <p
            className={cn(
              'text-lg font-semibold',
              attendeeName === '' && 'text-muted-foreground',
            )}
          >
            {attendeeName === '' ? 'Name not entered' : attendeeName}
          </p>

          <p className="mt-1 text-sm text-muted-foreground">
            {attendeeDetails === '' ? 'Details not entered' : attendeeDetails}
          </p>
        </div>

        <RadioGroup
          value={paymentMethod}
          onValueChange={(value: string) =>
            onPaymentMethodChange(value as PaymentMethod)
          }
          disabled={paymentConfirmed}
          className="grid grid-cols-2 gap-3"
        >
          <Label
            htmlFor="payment-upi"
            className={paymentMethodOptionClassName}
          >
            <RadioGroupItem
              value="upi"
              id="payment-upi"
            />

            UPI
          </Label>

          <Label
            htmlFor="payment-cash"
            className={paymentMethodOptionClassName}
          >
            <RadioGroupItem
              value="cash"
              id="payment-cash"
            />

            Cash
          </Label>
        </RadioGroup>

        {paymentMethod === 'upi' ? (
          <div className="rounded-2xl border border-border bg-muted/30 p-6 text-center">
            <div className="mx-auto flex aspect-square w-full max-w-56 items-center justify-center rounded-2xl border border-dashed border-border bg-background">
              <div>
                <p className="text-lg font-semibold">
                  UPI QR
                </p>

                <p className="mt-1 text-sm text-muted-foreground">
                  Added in a later phase
                </p>
              </div>
            </div>

            <p className="mt-6 text-4xl font-bold text-primary">
              ₹20
            </p>

            <p className="mt-1 text-sm text-muted-foreground">
              Navaratri 2026 Badge Fee
            </p>

            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
              Please pay exactly ₹20 and show the successful payment screen
              before continuing.
            </p>
          </div>
        ) : (
          <div className="rounded-2xl border border-border bg-muted/30 p-6 text-center">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Cash to collect
            </p>

            <p className="mt-3 text-5xl font-bold text-primary">
              ₹20
            </p>

            <p className="mt-4 text-sm text-muted-foreground">
              Collect the full amount before confirming payment.
            </p>
          </div>
        )}

        {paymentConfirmed ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
            <p className="font-semibold text-emerald-700 dark:text-emerald-400">
              ₹20 received via {paymentMethod === 'upi' ? 'UPI' : 'Cash'}
            </p>
          </div>
        ) : (
          <Button
            type="button"
            className="h-14 w-full text-base"
            onClick={onConfirmPayment}
          >
            {paymentMethod === 'upi' ? 'Payment Confirmed' : 'Cash Received'}
          </Button>
        )}
      </div>
    </div>
  )
}

export default PaymentStep
