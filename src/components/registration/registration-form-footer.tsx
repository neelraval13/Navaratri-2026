import { ArrowLeft, ArrowRight } from 'lucide-react'
import type * as React from 'react'

import type { RegistrationStep } from '@/components/registration/types'
import { Button } from '@/components/ui/button'
import { CardFooter } from '@/components/ui/card'

interface RegistrationFormFooterProps {
  currentStep: RegistrationStep
  paymentConfirmed: boolean
  badgeLabel: string
  onNext: () => void
  onBack: () => void
  onClear: () => void
}

const RegistrationFormFooter: React.FC<RegistrationFormFooterProps> = ({
  currentStep,
  paymentConfirmed,
  badgeLabel,
  onNext,
  onBack,
  onClear,
}) => {
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
              onClick={onClear}
            >
              Clear
            </Button>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
              <Button
                type="button"
                variant="secondary"
                className="h-12 sm:min-w-44"
              >
                Hold Registration
              </Button>

              <Button
                type="button"
                className="h-12 sm:min-w-36"
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
                onClick={onClear}
              >
                Clear
              </Button>

              <Button
                type="button"
                variant="secondary"
                className="h-12 sm:min-w-44"
              >
                Hold Registration
              </Button>
            </div>
          </>
        )}
      </div>
    </CardFooter>
  )
}

export default RegistrationFormFooter
