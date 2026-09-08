import { useState } from 'react'
import type * as React from 'react'

import ThemeToggle from '@/components/theme-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

type PaymentMethod = 'upi' | 'cash'

const App: React.FC = () => {
  const [paymentMethod, setPaymentMethod] =
    useState<PaymentMethod>('upi')

  const [paymentConfirmed, setPaymentConfirmed] = useState(false)

  const handlePaymentMethodChange = (value: string) => {
    setPaymentMethod(value as PaymentMethod)
    setPaymentConfirmed(false)
  }

  const handlePaymentConfirmation = () => {
    setPaymentConfirmed(true)
  }

  const handleClear = () => {
    setPaymentMethod('upi')
    setPaymentConfirmed(false)
  }

  return (
    <main className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-background">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <div>
            <p className="text-xl font-semibold tracking-wide">
              Navaratri 2026
            </p>
          </div>

          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto w-full max-w-6xl px-4 py-8 sm:px-6 sm:py-10">
        <section className="mb-8 text-center">
          <p className="text-sm font-medium uppercase tracking-[0.22em] text-muted-foreground">
            Badge to be allocated
          </p>

          <p className="mt-2 text-7xl font-bold tracking-tight text-primary sm:text-8xl">
            #001
          </p>
        </section>

        <div className="grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">
                Attendee Details
              </CardTitle>

              <CardDescription>
                Enter the attendee information before confirming payment.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="space-y-2">
                <Label htmlFor="phone">
                  Phone Number
                </Label>

                <div className="flex">
                  <div className="flex h-12 items-center rounded-l-lg border border-r-0 border-input bg-muted px-4 text-sm font-medium text-muted-foreground">
                    +91
                  </div>

                  <Input
                    id="phone"
                    type="tel"
                    inputMode="numeric"
                    placeholder="9876543210"
                    className="h-12 rounded-l-none"
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Badge variant="secondary">
                    Phone status will appear here
                  </Badge>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="name">
                  Name
                </Label>

                <Input
                  id="name"
                  type="text"
                  placeholder="Enter attendee name"
                  className="h-12"
                />
              </div>

              <div className="grid gap-6 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="age">
                    Age
                  </Label>

                  <Input
                    id="age"
                    type="text"
                    inputMode="numeric"
                    placeholder="Age"
                    className="h-12"
                  />
                </div>

                <div className="space-y-3">
                  <Label>
                    Gender
                  </Label>

                  <RadioGroup
                    defaultValue="male"
                    className="flex min-h-12 items-center gap-6"
                  >
                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        value="male"
                        id="gender-male"
                      />

                      <Label
                        htmlFor="gender-male"
                        className="cursor-pointer font-normal"
                      >
                        Male
                      </Label>
                    </div>

                    <div className="flex items-center gap-2">
                      <RadioGroupItem
                        value="female"
                        id="gender-female"
                      />

                      <Label
                        htmlFor="gender-female"
                        className="cursor-pointer font-normal"
                      >
                        Female
                      </Label>
                    </div>
                  </RadioGroup>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-2xl">
                Payment
              </CardTitle>

              <CardDescription>
                Collect ₹20 before issuing the badge.
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <RadioGroup
                value={paymentMethod}
                onValueChange={handlePaymentMethodChange}
                className="grid grid-cols-2 gap-3"
              >
                <Label
                  htmlFor="payment-upi"
                  className="flex h-12 cursor-pointer items-center gap-3 rounded-lg border border-input px-4"
                >
                  <RadioGroupItem
                    value="upi"
                    id="payment-upi"
                  />

                  UPI
                </Label>

                <Label
                  htmlFor="payment-cash"
                  className="flex h-12 cursor-pointer items-center gap-3 rounded-lg border border-input px-4"
                >
                  <RadioGroupItem
                    value="cash"
                    id="payment-cash"
                  />

                  Cash
                </Label>
              </RadioGroup>

              {paymentMethod === 'upi' ? (
                <div className="rounded-xl border border-border bg-muted/30 p-5 text-center">
                  <div className="mx-auto flex aspect-square w-full max-w-52 items-center justify-center rounded-xl border border-dashed border-border bg-background">
                    <div>
                      <p className="text-lg font-semibold">
                        UPI QR
                      </p>

                      <p className="mt-1 text-sm text-muted-foreground">
                        Added in Phase 5
                      </p>
                    </div>
                  </div>

                  <p className="mt-5 text-4xl font-bold text-primary">
                    ₹20
                  </p>

                  <p className="mt-1 text-sm text-muted-foreground">
                    Navaratri 2026 Badge Fee
                  </p>

                  <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
                    Please pay exactly ₹20 and show the successful payment
                    screen before continuing.
                  </p>
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-muted/30 p-6 text-center">
                  <p className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                    Cash to collect
                  </p>

                  <p className="mt-2 text-5xl font-bold text-primary">
                    ₹20
                  </p>

                  <p className="mt-3 text-sm text-muted-foreground">
                    Collect the full amount before confirming payment.
                  </p>
                </div>
              )}

              {!paymentConfirmed ? (
                <Button
                  type="button"
                  className="h-14 w-full text-base"
                  onClick={handlePaymentConfirmation}
                >
                  {paymentMethod === 'upi'
                    ? 'Payment Confirmed'
                    : 'Cash Received'}
                </Button>
              ) : (
                <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-center">
                  <p className="font-semibold text-emerald-700 dark:text-emerald-400">
                    ₹20 received via{' '}
                    {paymentMethod === 'upi' ? 'UPI' : 'Cash'}
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {!paymentConfirmed ? (
            <>
              <Button
                type="button"
                variant="outline"
                className="h-12 sm:min-w-32"
                onClick={handleClear}
              >
                Clear
              </Button>

              <Button
                type="button"
                variant="secondary"
                className="h-12 sm:min-w-48"
              >
                Hold Registration
              </Button>
            </>
          ) : (
            <Button
              type="button"
              className="h-14 w-full text-lg font-semibold"
            >
              Issue Badge #001
            </Button>
          )}
        </div>
      </div>
    </main>
  )
}

export default App
