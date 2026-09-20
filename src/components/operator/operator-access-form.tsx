import { LockOpen } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { unlockOperatorAccess } from '@/auth/operator-access'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface OperatorAccessFormProps {
  /** Distinguishes the two places this form appears, for stable input ids. */
  idPrefix: string
  autoFocus?: boolean
}

/**
 * The access-code form.
 *
 * The code is held in component state only for as long as it takes to submit
 * it. It is never written to IndexedDB, localStorage or sessionStorage, and the
 * server's reply carries no token — the session arrives as an HttpOnly cookie.
 */
const OperatorAccessForm: React.FC<OperatorAccessFormProps> = ({
  idPrefix,
  autoFocus = false,
}) => {
  const [accessCode, setAccessCode] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inputId = `${idPrefix}-access-code`
  const errorId = `${inputId}-error`

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSubmitting || accessCode === '') {
      return
    }

    setIsSubmitting(true)
    setError(null)

    const result = await unlockOperatorAccess(accessCode)

    if (result.ok) {
      // Drop the code from memory the moment it is no longer needed.
      setAccessCode('')
      setIsSubmitting(false)

      return
    }

    setError(result.message ?? null)
    setIsSubmitting(false)
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor={inputId}>
          Access code
        </Label>

        <Input
          id={inputId}
          type="password"
          autoComplete="current-password"
          autoFocus={autoFocus}
          value={accessCode}
          onChange={(event) => {
            setAccessCode(event.target.value)

            if (error !== null) {
              setError(null)
            }
          }}
          aria-invalid={error !== null}
          aria-describedby={error === null ? undefined : errorId}
          className="h-12"
        />

        {error === null ? null : (
          <p
            id={errorId}
            className="text-sm text-destructive"
          >
            {error}
          </p>
        )}
      </div>

      <Button
        type="submit"
        disabled={isSubmitting}
        className="h-12 w-full sm:w-auto sm:min-w-32"
      >
        <LockOpen data-icon="inline-start" />
        {isSubmitting ? 'Unlocking…' : 'Unlock'}
      </Button>
    </form>
  )
}

export default OperatorAccessForm
