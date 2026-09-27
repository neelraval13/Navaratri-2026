import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface PasswordFieldProps {
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  autoComplete: 'new-password' | 'current-password'
  hint?: string
  disabled?: boolean
}

/**
 * A masked password input with its own Show / Hide control.
 *
 * Visibility is per field and lives only in component state — nothing is
 * written to localStorage, sessionStorage or IndexedDB, and the value itself
 * is held by the caller only until its request has been sent.
 *
 * The value is passed through EXACTLY: no trimming, so a passphrase with
 * spaces is preserved, matching the server's policy.
 */
const PasswordField: React.FC<PasswordFieldProps> = ({
  id,
  label,
  value,
  onChange,
  autoComplete,
  hint,
  disabled = false,
}) => {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>
        {label}
      </Label>

      <div className="relative">
        <Input
          id={id}
          type={isVisible ? 'text' : 'password'}
          autoComplete={autoComplete}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value)
          }}
          className="h-12 pr-12"
        />

        <button
          // Never `submit`: toggling visibility must not send the form.
          type="button"
          onClick={() => {
            setIsVisible((previous) => !previous)
          }}
          aria-label={isVisible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
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

      {hint === undefined ? null : (
        <p className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}

export default PasswordField
