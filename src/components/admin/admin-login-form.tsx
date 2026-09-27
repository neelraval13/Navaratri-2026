import { Eye, EyeOff, LockOpen } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { adminLogin } from '@/admin/admin-api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Admin sign-in. A SEPARATE realm from Operator Access — signing in here
 * grants no operator access, and an unlocked event device is not an Admin.
 *
 * The code lives in component state only long enough to send it. It is never
 * written to IndexedDB, localStorage or sessionStorage.
 */
const AdminLoginForm: React.FC = () => {
  const [accessCode, setAccessCode] = useState('')
  const [isVisible, setIsVisible] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (isSubmitting || accessCode === '') {
      return
    }

    setIsSubmitting(true)
    setError(null)

    const result = await adminLogin(accessCode)

    if (result.ok) {
      setAccessCode('')
      setIsSubmitting(false)

      return
    }

    setError(result.message)
    setIsSubmitting(false)
  }

  return (
    <form
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
      className="space-y-4"
    >
      {/* Keeps password managers happy and Chrome quiet; never sent to the API. */}
      <input
        type="text"
        name="username"
        autoComplete="username"
        value="navaratri-admin"
        readOnly
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />

      <div className="space-y-2">
        <Label htmlFor="admin-access-code">
          Admin access code
        </Label>

        {/*
          The toggle only changes how the field renders. The value stays in
          component state and is never written to localStorage,
          sessionStorage or IndexedDB, and `autocomplete` is unchanged so
          password managers keep working.
        */}
        <div className="relative">
          <Input
            id="admin-access-code"
            type={isVisible ? 'text' : 'password'}
            autoComplete="current-password"
            autoFocus
            value={accessCode}
            onChange={(event) => {
              setAccessCode(event.target.value)

              if (error !== null) {
                setError(null)
              }
            }}
            aria-invalid={error !== null}
            aria-describedby={error === null ? undefined : 'admin-access-code-error'}
            className="h-12 pr-12"
          />

          <button
            // Never `submit`: toggling visibility must not send the form.
            type="button"
            onClick={() => {
              setIsVisible((previous) => !previous)
            }}
            aria-label={isVisible ? 'Hide access code' : 'Show access code'}
            aria-pressed={isVisible}
            className="absolute inset-y-0 right-0 flex w-12 items-center justify-center rounded-r-4xl text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {isVisible ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </button>
        </div>

        {error === null ? null : (
          <p
            id="admin-access-code-error"
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
        {isSubmitting ? 'Signing in…' : 'Sign in'}
      </Button>
    </form>
  )
}

export default AdminLoginForm
