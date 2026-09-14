import type * as React from 'react'

import { CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface RegistrationFormHeaderProps {
  badgeLabel: string
  /**
   * `to-allocate` shows the next badge that WILL be handed out; `allocated`
   * shows the badge that just was. Never show the next number while telling the
   * operator to hand over the previous one.
   */
  mode: 'to-allocate' | 'allocated'
}

const RegistrationFormHeader: React.FC<RegistrationFormHeaderProps> = ({
  badgeLabel,
  mode,
}) => {
  return (
    <CardHeader className="justify-items-center border-b text-center">
      <CardDescription className="text-xs font-medium uppercase tracking-[0.22em]">
        {mode === 'allocated' ? 'Badge allocated' : 'Badge to be allocated'}
      </CardDescription>

      <CardTitle className="text-6xl font-bold leading-none tracking-tight text-primary sm:text-7xl">
        {badgeLabel}
      </CardTitle>
    </CardHeader>
  )
}

export default RegistrationFormHeader
