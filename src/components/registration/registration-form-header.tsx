import type * as React from 'react'

import { CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

interface RegistrationFormHeaderProps {
  badgeLabel: string
}

const RegistrationFormHeader: React.FC<RegistrationFormHeaderProps> = ({
  badgeLabel,
}) => {
  return (
    <CardHeader className="justify-items-center border-b text-center">
      <CardDescription className="text-xs font-medium uppercase tracking-[0.22em]">
        Badge to be allocated
      </CardDescription>

      <CardTitle className="text-6xl font-bold leading-none tracking-tight text-primary sm:text-7xl">
        {badgeLabel}
      </CardTitle>
    </CardHeader>
  )
}

export default RegistrationFormHeader
