import { UserMinus } from 'lucide-react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { formatEventDateTime } from '@/lib/datetime'
import type { CngMember } from '@/shared/cng-contract'

interface CngMemberCardProps {
  member: CngMember
  /** How many prizes this member already holds. Informational only. */
  previousAwardCount: number
  isBusy: boolean
  onGivePrize: (member: CngMember) => void
  onRemove: (member: CngMember) => void
}

/**
 * One CNG volunteer.
 *
 * A NAME, AND NOTHING THAT DOES NOT EXIST. There is no badge number, no age
 * and no gender on this card, because a volunteer has none of those: they do
 * not wear the numbered attendee badges and most never pass the registration
 * desk. Phase CNG1 showed all three by modelling a member as a registered
 * attendee; printing a badge here would mean the application had invented
 * one.
 *
 * It therefore says `CNG Member` under the name rather than leaving the
 * second line blank or filling it with an `Age — · —`. The one secondary fact
 * worth having is provenance: which desk added them, and when.
 *
 * GIVE PRIZE GOES TO THE VOLUNTEER LEDGER. It opens the CNG award dialog,
 * which writes `cng_prize_awards` through `PATCH /api/prizes` — never the
 * attendee ledger, and never with a fabricated badge. The eight prizes are
 * the same eight; the recipient is identified differently.
 *
 * REMOVE IS DELIBERATELY QUIET, and it is the one thing this card can change.
 * A small outline control rather than a destructive button beside the primary
 * action: removing somebody from the group is a correction, not a step in the
 * evening's work, and it opens a confirmation rather than acting on the tap.
 * The removal is SOFT, so their prizes stay in the history.
 */
const CngMemberCard: React.FC<CngMemberCardProps> = ({
  member,
  previousAwardCount,
  isBusy,
  onGivePrize,
  onRemove,
}) => {
  return (
    <div className="flex flex-col justify-between gap-4 rounded-2xl border border-border bg-card p-4">
      <div className="space-y-0.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            {/*
              THE NAME DOMINATES, because it is the only identity a volunteer
              has — the place the badge number occupies on an attendee card.
            */}
            <p
              className="truncate font-heading text-xl font-semibold tracking-tight"
              title={member.name}
            >
              {member.name}
            </p>

            <p className="text-sm text-muted-foreground">
              CNG Member
            </p>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Remove ${member.name} from CNG`}
            disabled={isBusy}
            onClick={() => {
              onRemove(member)
            }}
          >
            <UserMinus data-icon="inline-start" />
            Remove
          </Button>
        </div>

        <p className="pt-1 text-xs uppercase tracking-[0.12em] text-muted-foreground">
          {`Added by ${member.addedBy.name} · ${formatEventDateTime(member.addedAt)}`}
        </p>

        {previousAwardCount === 0 ? null : (
          /* Amber: worth noticing, never an error and never a refusal. */
          <p className="pt-1 text-sm font-medium text-amber-700 dark:text-amber-400">
            {previousAwardCount === 1
              ? '1 prize already received'
              : `${String(previousAwardCount)} prizes already received`}
          </p>
        )}
      </div>

      <Button
        type="button"
        className="h-11 w-full"
        disabled={isBusy}
        onClick={() => {
          onGivePrize(member)
        }}
      >
        Give Prize
      </Button>
    </div>
  )
}

export default CngMemberCard
