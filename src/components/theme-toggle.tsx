import { Moon, Sun } from 'lucide-react'
import type * as React from 'react'

import { useTheme } from '@/components/theme-context'
import { Button } from '@/components/ui/button'

const ThemeToggle: React.FC = () => {
  const { resolvedTheme, setTheme } = useTheme()

  const isDark = resolvedTheme === 'dark'

  const handleToggle = () => {
    setTheme(isDark ? 'light' : 'dark')
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={handleToggle}
      aria-label={`Switch to ${isDark ? 'light' : 'dark'} mode`}
      title={`Switch to ${isDark ? 'light' : 'dark'} mode`}
    >
      {isDark ? <Sun /> : <Moon />}
    </Button>
  )
}

export default ThemeToggle
