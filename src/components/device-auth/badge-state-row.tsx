import type * as React from 'react'

interface BadgeStateRowProps {
  label: string
  children: React.ReactNode
}

/**
 * One labelled fact about badge state.
 *
 * Shared by the adoption and claim sections so local and central values are
 * always presented identically — an operator comparing two ranges should not
 * have to notice that they are formatted differently.
 */
const BadgeStateRow: React.FC<BadgeStateRowProps> = ({ label, children }) => (
  <div>
    <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
      {label}
    </p>

    <div className="mt-0.5 text-sm">
      {children}
    </div>
  </div>
)

export default BadgeStateRow
