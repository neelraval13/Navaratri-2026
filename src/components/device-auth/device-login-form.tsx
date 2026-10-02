import { CircleAlert, LogIn } from 'lucide-react'
import { useState } from 'react'
import type * as React from 'react'

import PasswordField from '@/components/admin/password-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { loginDevice } from '@/device-auth/device-api'
import type {
  DeviceSessionContext,
  OfflineAuthorizationEnvelope,
} from '@/device-auth/device-session-contract'

interface DeviceLoginFormProps {
  onAuthenticated: (
    context: DeviceSessionContext,
    offlineAuthorization: OfflineAuthorizationEnvelope,
  ) => void
}

/**
 * Signs this browser in as a central event device.
 *
 * It asks for a login name and a password, and nothing else. The event slug
 * comes from the application: this build serves one event, and making an
 * operator type `navaratri-2026` invites a typo that would be indistinguishable
 * from a wrong password. There is no Event ID or Device UUID field, because
 * no human should be typing a UUID at a desk.
 *
 * The password lives in component state only long enough to be sent, and is
 * cleared the moment the server accepts it. It is never written to IndexedDB,
 * localStorage, sessionStorage, the URL or a log.
 */
const DeviceLoginForm: React.FC<DeviceLoginFormProps> = ({ onAuthenticated }) => {
  const [loginName, setLoginName] = useState('')
  const [password, setPassword] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    if (isSubmitting) {
      return
    }

    /**
     * Only the login name is trimmed, matching how it is stored and how the
     * server parses it. The password is NOT: a passphrase with a leading or
     * trailing space is a different passphrase.
     */
    const trimmedLoginName = loginName.trim()

    if (trimmedLoginName === '' || password === '') {
      setError('Enter the device login name and password.')

      return
    }

    setIsSubmitting(true)
    setError(null)

    const result = await loginDevice({ loginName: trimmedLoginName, password })

    setIsSubmitting(false)

    if (!result.ok) {
      // The server's own text is never rendered; only the mapped message.
      setError(result.message)

      return
    }

    // The plaintext leaves React state the moment the server accepts it.
    setPassword('')
    onAuthenticated(result.context, result.offlineAuthorization)
  }

  return (
    <form
      className="space-y-6"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="device-login-name">
          Device Login Name
        </Label>

        <Input
          id="device-login-name"
          value={loginName}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="desk-a"
          onChange={(event) => {
            setLoginName(event.target.value)

            if (error !== null) {
              setError(null)
            }
          }}
          aria-invalid={error !== null}
          className="h-12"
        />

        <p className="text-xs text-muted-foreground">
          The name an administrator gave this device. Lowercase letters,
          numbers and hyphens.
        </p>
      </div>

      <PasswordField
        id="device-login-password"
        label="Password"
        value={password}
        onChange={(value) => {
          setPassword(value)

          if (error !== null) {
            setError(null)
          }
        }}
        autoComplete="current-password"
        disabled={isSubmitting}
      />

      {/*
        A live region, so a screen reader announces the failure rather than
        leaving it to be discovered. The icon is redundant with the text, so
        the state is never communicated by colour alone.
      */}
      <div
        role="status"
        aria-live="polite"
      >
        {error === null ? null : (
          <p className="flex items-start gap-2 text-sm text-destructive">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            {error}
          </p>
        )}
      </div>

      <Button
        type="submit"
        disabled={isSubmitting}
        className="h-12 w-full sm:w-auto sm:min-w-44"
      >
        <LogIn data-icon="inline-start" />
        {isSubmitting ? 'Signing in…' : 'Sign In Device'}
      </Button>
    </form>
  )
}

export default DeviceLoginForm
