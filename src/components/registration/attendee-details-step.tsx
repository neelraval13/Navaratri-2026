import { useEffect, useRef } from 'react'
import type * as React from 'react'

import {
  ATTENDEE_FIELD_MESSAGES,
  PHONE_LENGTH,
  isAgeValid,
  isGenderValid,
  isNameValid,
  isPhoneValid,
} from '@/components/registration/attendee-validation'
import type {
  AttendeeField,
  BlockedAttendeeField,
  Gender,
} from '@/components/registration/types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { useJitter } from '@/hooks/use-jitter'
import { formatPhoneNumber } from '@/lib/phone'
import { cn } from '@/lib/utils'

interface AttendeeDetailsStepProps {
  phone: string
  name: string
  age: string
  gender: Gender
  revealedFields: AttendeeField[]
  blockedField: BlockedAttendeeField | null
  onPhoneChange: (phone: string) => void
  onNameChange: (name: string) => void
  onAgeChange: (age: string) => void
  onGenderChange: (gender: Gender) => void
  onRevealField: (field: AttendeeField) => void
}

const AttendeeDetailsStep: React.FC<AttendeeDetailsStepProps> = ({
  phone,
  name,
  age,
  gender,
  revealedFields,
  blockedField,
  onPhoneChange,
  onNameChange,
  onAgeChange,
  onGenderChange,
  onRevealField,
}) => {
  const { jitteringField, triggerJitter, clearJitter } =
    useJitter<AttendeeField>()

  const phoneRef = useRef<HTMLInputElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const ageRef = useRef<HTMLInputElement>(null)
  const genderRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (blockedField === null) {
      return
    }

    const fieldRefs = {
      phone: phoneRef,
      name: nameRef,
      age: ageRef,
      gender: genderRef,
    }

    fieldRefs[blockedField.field].current?.focus()

    triggerJitter(blockedField.field)
  }, [blockedField, triggerJitter])

  const showPhoneError = revealedFields.includes('phone') && !isPhoneValid(phone)
  const showNameError = revealedFields.includes('name') && !isNameValid(name)
  const showAgeError = revealedFields.includes('age') && !isAgeValid(age)
  const showGenderError =
    revealedFields.includes('gender') && !isGenderValid(gender)

  const handlePhoneChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value
    const nextDigits = nextValue.replace(/\D/g, '')

    if (nextDigits.length > PHONE_LENGTH) {
      triggerJitter('phone')

      return
    }

    if (/[^\d ]/.test(nextValue)) {
      triggerJitter('phone')
    }

    onPhoneChange(nextDigits)
  }

  const handleAgeChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextValue = event.target.value

    if (nextValue !== '' && !isAgeValid(nextValue)) {
      triggerJitter('age')

      return
    }

    onAgeChange(nextValue)
  }

  return (
    <div className="space-y-8">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Step 1 of 2
        </p>

        <h2 className="font-heading text-2xl font-semibold">
          Attendee Details
        </h2>
      </div>

      <div className="space-y-6">
        <div className="space-y-2">
          <Label htmlFor="attendee-phone">
            Phone Number
          </Label>

          <div
            className={cn('flex', jitteringField === 'phone' && 'jitter')}
            onAnimationEnd={clearJitter}
          >
            <span className="flex h-12 shrink-0 items-center rounded-l-4xl border border-r-0 border-input bg-muted px-5 text-sm font-medium text-muted-foreground">
              +91
            </span>

            <Input
              id="attendee-phone"
              ref={phoneRef}
              type="tel"
              inputMode="numeric"
              placeholder="98765 43210"
              value={formatPhoneNumber(phone)}
              onChange={handlePhoneChange}
              onBlur={() => onRevealField('phone')}
              aria-invalid={showPhoneError}
              aria-describedby={
                showPhoneError ? 'attendee-phone-error' : undefined
              }
              className="h-12 rounded-l-none"
            />
          </div>

          {showPhoneError ? (
            <p
              id="attendee-phone-error"
              className="text-sm text-destructive"
            >
              {ATTENDEE_FIELD_MESSAGES.phone}
            </p>
          ) : null}
        </div>

        <div className="space-y-2">
          <Label htmlFor="attendee-name">
            Name
          </Label>

          <Input
            id="attendee-name"
            ref={nameRef}
            type="text"
            placeholder="Enter attendee name"
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
            onBlur={() => onRevealField('name')}
            onAnimationEnd={clearJitter}
            aria-invalid={showNameError}
            aria-describedby={showNameError ? 'attendee-name-error' : undefined}
            className={cn('h-12', jitteringField === 'name' && 'jitter')}
          />

          {showNameError ? (
            <p
              id="attendee-name-error"
              className="text-sm text-destructive"
            >
              {ATTENDEE_FIELD_MESSAGES.name}
            </p>
          ) : null}
        </div>

        <div className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="attendee-age">
              Age
            </Label>

            <Input
              id="attendee-age"
              ref={ageRef}
              type="text"
              inputMode="numeric"
              placeholder="Age"
              value={age}
              onChange={handleAgeChange}
              onBlur={() => onRevealField('age')}
              onAnimationEnd={clearJitter}
              aria-invalid={showAgeError}
              aria-describedby={showAgeError ? 'attendee-age-error' : undefined}
              className={cn('h-12', jitteringField === 'age' && 'jitter')}
            />

            {showAgeError ? (
              <p
                id="attendee-age-error"
                className="text-sm text-destructive"
              >
                {ATTENDEE_FIELD_MESSAGES.age}
              </p>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label id="attendee-gender-label">
              Gender
            </Label>

            <RadioGroup
              value={gender}
              onValueChange={(value: string) => onGenderChange(value as Gender)}
              onAnimationEnd={clearJitter}
              aria-labelledby="attendee-gender-label"
              aria-invalid={showGenderError}
              aria-describedby={
                showGenderError ? 'attendee-gender-error' : undefined
              }
              className={cn(
                'flex h-12 items-center gap-8',
                jitteringField === 'gender' && 'jitter',
              )}
            >
              <Label
                htmlFor="attendee-gender-male"
                className="cursor-pointer font-normal"
              >
                <RadioGroupItem
                  ref={genderRef}
                  value="male"
                  id="attendee-gender-male"
                />

                Male
              </Label>

              <Label
                htmlFor="attendee-gender-female"
                className="cursor-pointer font-normal"
              >
                <RadioGroupItem
                  value="female"
                  id="attendee-gender-female"
                />

                Female
              </Label>
            </RadioGroup>

            {showGenderError ? (
              <p
                id="attendee-gender-error"
                className="text-sm text-destructive"
              >
                {ATTENDEE_FIELD_MESSAGES.gender}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

export default AttendeeDetailsStep
