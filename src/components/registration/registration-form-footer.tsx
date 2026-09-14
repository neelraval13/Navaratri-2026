import { ArrowLeft, ArrowRight } from 'lucide-react'
import type * as React from 'react'

import type { RegistrationStep } from '@/components/registration/types'
import { Button } from '@/components/ui/button'
import { CardFooter } from '@/components/ui/card'

interface RegistrationFormFooterProps {
  currentStep: RegistrationStep
  paymentConfirmed: boolean
  badgeLabel: string
  /** True while a hold write is in flight; every footer action is suspended. */
  isHolding: boolean
  onNext: () => void
  onBack: () => void
  onClear: () => void
  onHold: () => void
}

const RegistrationFormFooter: React.FC<RegistrationFormFooterProps> = ({
  currentStep,
  paymentConfirmed,
  badgeLabel,
  isHolding,
  onNext,
  onBack,
  onClear,
  onHold,
}) => {
  const holdLabel = isHolding ? 'Holding…' : 'Hold Registration'

  if (paymentConfirmed) {
    return (
      <CardFooter className="border-t">
        <Button
          type="button"
          className="h-14 w-full text-base font-semibold"
        >
          Issue Badge {badgeLabel}
        </Button>
      </CardFooter>
    )
  }

  return (
    <CardFooter className="border-t">
      <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        {currentStep === 'attendee' ? (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-12 sm:min-w-32"
              disabled={isHolding}
              onClick={onClear}
            >
              Clear
            </Button>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="secondary"
                className="h-12 sm:min-w-44"
                disabled={isHolding}
                onClick={onHold}
              >
                {holdLabel}
              </Button>

              <Button
                type="button"
                className="h-12 sm:min-w-36"
                disabled={isHolding}
                onClick={onNext}
              >
                Next
                <ArrowRight data-icon="inline-end" />
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="outline"
              className="h-12 sm:min-w-32"
              disabled={isHolding}
              onClick={onBack}
            >
              <ArrowLeft data-icon="inline-start" />
              Back
            </Button>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="outline"
                className="h-12 sm:min-w-32"
                disabled={isHolding}
                onClick={onClear}
              >
                Clear
              </Button>

              <Button
                type="button"
                variant="secondary"
                className="h-12 sm:min-w-44"
                disabled={isHolding}
                onClick={onHold}
              >
                {holdLabel}
              </Button>
            </div>
          </>
        )}
      </div>
    </CardFooter>
  )
}

export default RegistrationFormFooter
