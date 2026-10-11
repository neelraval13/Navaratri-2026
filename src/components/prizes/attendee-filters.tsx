import { Search, X } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  hasActivePrizeFilters,
  parseAgeBounds,
  type PrizeFilterState,
  type PrizeGenderFilter,
} from '@/prizes/prize-filters'
import { cn } from '@/lib/utils'

interface AttendeeFiltersProps {
  state: PrizeFilterState
  resultCount: number
  totalCount: number
  onChange: (state: PrizeFilterState) => void
  onClear: () => void
}

const GENDER_OPTIONS: { value: PrizeGenderFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
]

/**
 * Finding one attendee: search, an age window, and gender.
 *
 * Gender is three buttons rather than a dropdown because there are three
 * options and a volunteer should not have to open anything. The values are
 * the normalised ones registration already stores, so there is no third
 * spelling of gender anywhere.
 *
 * It filters ALL REGISTERED ATTENDEES, winners included. There is no "hide
 * attendees who already have a prize" control and none may be added: since
 * Phase P1.1 a previous prize disqualifies nobody, so a filter that removed
 * them would hide people a volunteer is looking for.
 *
 * An unusable age window says so and filters NOTHING. Quietly returning an
 * empty list for `min 20, max 5` would read as "nobody matched", which is the
 * one answer that must never be guessed at here.
 */
const AttendeeFilters: React.FC<AttendeeFiltersProps> = ({
  state,
  resultCount,
  totalCount,
  onChange,
  onClear,
}) => {
  const bounds = parseAgeBounds(state)
  const ageError = bounds.ok === false ? bounds.message : null

  return (
    <div className="space-y-4 rounded-2xl border border-border bg-card p-4">
      <div className="space-y-1.5">
        <Label htmlFor="prize-search">
          Search
        </Label>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />

          <Input
            id="prize-search"
            type="text"
            inputMode="search"
            autoComplete="off"
            placeholder="Badge number or name"
            className="h-11 pl-9"
            value={state.search}
            onChange={(event) => {
              onChange({ ...state, search: event.target.value })
            }}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="prize-min-age">
            Age
          </Label>

          <div className="flex items-center gap-2">
            <Input
              id="prize-min-age"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Min"
              className="h-11"
              aria-invalid={ageError !== null}
              aria-describedby={ageError === null ? undefined : 'prize-age-error'}
              value={state.minAge}
              onChange={(event) => {
                onChange({ ...state, minAge: event.target.value })
              }}
            />

            <span className="text-sm text-muted-foreground">
              to
            </span>

            <Input
              id="prize-max-age"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="Max"
              className="h-11"
              aria-invalid={ageError !== null}
              aria-describedby={ageError === null ? undefined : 'prize-age-error'}
              value={state.maxAge}
              onChange={(event) => {
                onChange({ ...state, maxAge: event.target.value })
              }}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <span className="flex items-center gap-2 text-sm leading-none font-medium">
            Gender
          </span>

          <div
            role="group"
            aria-label="Gender"
            className="flex gap-2"
          >
            {GENDER_OPTIONS.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={state.gender === option.value ? 'default' : 'outline'}
                className={cn('h-11 flex-1')}
                aria-pressed={state.gender === option.value}
                onClick={() => {
                  onChange({ ...state, gender: option.value })
                }}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      {ageError === null ? null : (
        <p
          id="prize-age-error"
          className="text-sm text-destructive"
        >
          {ageError}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {resultCount === totalCount
            ? `${String(totalCount)} attendees`
            : `${String(resultCount)} of ${String(totalCount)} attendees`}
        </p>

        {hasActivePrizeFilters(state) ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
          >
            <X data-icon="inline-start" />
            Clear filters
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export default AttendeeFilters
