import { ListChecks, UserPlus } from 'lucide-react'
import type * as React from 'react'

import CngMemberCard from '@/components/cng/cng-member-card'
import { Button } from '@/components/ui/button'
import { previousCngAwardsFor } from '@/prizes/prize-filters'
import type { CngMember, CngPrizeAward } from '@/shared/cng-contract'

interface CngRosterProps {
  members: readonly CngMember[]
  /** The VOLUNTEER ledger, for the per-card prize count. */
  cngAwards: readonly CngPrizeAward[]
  isBusy: boolean
  onAdd: () => void
  onBulkAdd: () => void
  onGivePrize: (member: CngMember) => void
  onRemove: (member: CngMember) => void
}

/**
 * THE CNG TAB: the event's volunteer group, as cards.
 *
 * NOT A SUBSET OF THE ATTENDEES TAB. Phase CNG1 modelled a member as a
 * registered attendee and this tab rendered badges, ages and genders;
 * volunteers have none of those, so the cards show a NAME and say `CNG
 * Member`. The two tabs describe different groups of people who happen to be
 * at the same event.
 *
 * OLDEST FIRST, as the server returns it. The organiser pastes their list in
 * the order they wrote it, and a roster that re-sorted itself alphabetically
 * would be one they have to search rather than read.
 *
 * NO FILTERS. The group is a couple of dozen people and the whole point is
 * seeing all of them at once; the age and gender filters on the Attendees tab
 * exist because a few hundred attendees need narrowing, and neither fact even
 * exists here.
 *
 * TWO WAYS IN, and the primary one is Add — one name, typed. **Bulk Add
 * Names** is the secondary, setup-time action: the organiser pastes their
 * written list and every non-empty line becomes a member. It is deliberately
 * not the prominent control, because it is used once an evening at most.
 *
 * NEITHER ROUTE MATCHES ANYTHING. There is no Badge Register read, no badge,
 * no age and no gender — a CNG name is simply a name, shown back to the
 * operator before the row is written.
 */
const CngRoster: React.FC<CngRosterProps> = ({
  members,
  cngAwards,
  isBusy,
  onAdd,
  onBulkAdd,
  onGivePrize,
  onRemove,
}) => {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-heading text-xl font-semibold uppercase tracking-[0.08em]">
          {`CNG Members (${String(members.length)})`}
        </h2>

        <div className="flex flex-wrap items-center gap-2">
          {/* Secondary: setup-time, used once rather than per volunteer. */}
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={isBusy}
            onClick={onBulkAdd}
          >
            <ListChecks data-icon="inline-start" />
            Bulk Add Names
          </Button>

          <Button
            type="button"
            className="h-11"
            disabled={isBusy}
            onClick={onAdd}
          >
            <UserPlus data-icon="inline-start" />
            Add
          </Button>
        </div>
      </div>

      {members.length === 0 ? (
        <p className="rounded-2xl border border-border bg-card px-4 py-8 text-center text-sm text-muted-foreground">
          No CNG members yet. Add one with the button above, or paste the
          volunteer list with Bulk Add Names.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {members.map((member) => (
            <CngMemberCard
              key={member.id}
              member={member}
              previousAwardCount={previousCngAwardsFor(cngAwards, member.id).length}
              isBusy={isBusy}
              onGivePrize={onGivePrize}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default CngRoster
