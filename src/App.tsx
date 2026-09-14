import type * as React from 'react'

import DatabaseGate from '@/components/database-gate'
import RegistrationForm from '@/components/registration/registration-form'
import ThemeToggle from '@/components/theme-toggle'

const App: React.FC = () => {
  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="border-b border-border">
        <div className="mx-auto flex h-16 w-full max-w-3xl items-center justify-between px-4 sm:px-6">
          <p className="text-xl font-semibold tracking-wide">
            Navaratri 2026
          </p>

          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
        <DatabaseGate>
          <RegistrationForm />
        </DatabaseGate>
      </main>
    </div>
  )
}

export default App
