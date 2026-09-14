import { CircleAlert } from 'lucide-react'
import type * as React from 'react'

import UpiQr from '@/components/payment/upi-qr'
import type { Gender, PaymentMethod } from '@/components/registration/types'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useUpiQr } from '@/hooks/use-upi-qr'
import { formatPhoneNumber } from '@/lib/phone'
import type { UpiPayment } from '@/lib/upi'
import { cn } from '@/lib/utils'

const GENDER_LABELS: Record<Exclude<Gender, ''>, string> = {
  male: 'Male',
  female: 'Female',
}

const PAYMENT_METHOD_OPTION_CLASS_NAME =
  'h-12 gap-3 rounded-4xl border border-input px-5 font-medium has-data-[checked]:border-primary has-data-[checked]:bg-primary/5'

interface PaymentStepProps {
  /** From EventConfig, so the displayed fee cannot drift from what is stored. */
  amount: number
  eventName: string
  /**
   * The resolved UPI payment, or null when UPI is not usable — unconfigured,
   * malformed, or a non-INR currency. Cash stays available either way.
   */
  upiPayment: UpiPayment | null
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
  amount,
  eventName,
  upiPayment,
  phone,
  name,
  age,
  gender,
  paymentMethod,
  paymentConfirmed,
  onPaymentMethodChange,
  onConfirmPayment,
}) => {
  const upiQr = useUpiQr(upiPayment?.uri ?? null)

  /**
   * UPI can only be confirmed once there is a real, scannable QR on screen. An
   * operator must never be able to mark a UPI payment received when nothing was
   * ever presented to scan. Cash is unaffected.
   */
  const canConfirmPayment =
    paymentMethod === 'cash' ||
    (upiPayment !== null && upiQr.status === 'ready')

  /**
   * The same invariant, enforced a second time in the handler rather than only
   * by the button's disabled state.
   *
   * Confirming a payment is irreversible within a registration, so it should not
   * rely on a prop that a later refactor could move, re-wire or fire
   * programmatically. This mirrors the guards already on Hold and Issue Badge.
   */
  const handleConfirmPayment = () => {
    if (!canConfirmPayment) {
      return
    }

    onConfirmPayment()
  }

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
          upiPayment === null ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-center">
              <p className="flex items-center justify-center gap-2 text-sm font-medium text-destructive">
                <CircleAlert className="size-4" />
                UPI payment is not configured.
              </p>

              <p className="mt-1 text-sm text-muted-foreground">
                Use Cash for this registration.
              </p>
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-muted/30 p-6 text-center">
              <UpiQr
                status={upiQr.status}
                dataUrl={upiQr.dataUrl}
                label={`UPI QR to pay ₹${String(amount)} to ${upiPayment.details.payeeName}`}
              />

              <p className="mt-6 text-4xl font-bold text-primary">
                ₹{amount}
              </p>

              <p className="mt-1 text-sm text-muted-foreground">
                {eventName} Badge Fee
              </p>

              {/*
                Shown so the operator and the attendee can both confirm the QR
                points at the expected personal account before paying.
              */}
              <dl className="mt-4 space-y-1 text-sm">
                <div className="flex items-baseline justify-center gap-2">
                  <dt className="text-muted-foreground">Paying</dt>
                  <dd className="font-medium">
                    {upiPayment.details.payeeName}
                  </dd>
                </div>

                <div className="flex items-baseline justify-center gap-2">
                  <dt className="text-muted-foreground">UPI ID</dt>
                  <dd className="font-medium break-all">
                    {upiPayment.details.upiId}
                  </dd>
                </div>
              </dl>

              <p className="mt-4 text-sm text-muted-foreground">
                Scan with any UPI app.
              </p>

              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Please pay exactly ₹{amount} and show the successful payment
                screen before continuing.
              </p>
            </div>
          )
        ) : (
          <div className="rounded-2xl border border-border bg-muted/30 p-6 text-center">
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
              Cash to collect
            </p>

            <p className="mt-3 text-5xl font-bold text-primary">
              ₹{amount}
            </p>

            <p className="mt-4 text-sm text-muted-foreground">
              Collect the full amount before confirming payment.
            </p>
          </div>
        )}

        {paymentConfirmed ? (
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
            <p className="font-semibold text-emerald-700 dark:text-emerald-400">
              ₹{amount} received via{' '}
              {paymentMethod === 'upi' ? 'UPI' : 'Cash'}
            </p>
          </div>
        ) : (
          <Button
            type="button"
            className="h-14 w-full text-base"
            disabled={!canConfirmPayment}
            onClick={handleConfirmPayment}
          >
            {paymentMethod === 'upi' ? 'Payment Confirmed' : 'Cash Received'}
          </Button>
        )}
      </div>
    </div>
  )
}

export default PaymentStep
