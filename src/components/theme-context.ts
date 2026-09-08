import { createContext, useContext } from 'react'

export type Theme = 'light' | 'dark' | 'system'

export interface ThemeProviderState {
  theme: Theme
  resolvedTheme: 'light' | 'dark'
  setTheme: (theme: Theme) => void
}

export const initialThemeState: ThemeProviderState = {
  theme: 'system',
  resolvedTheme: 'light',
  setTheme: () => undefined,
}

export const ThemeProviderContext =
  createContext<ThemeProviderState>(initialThemeState)

export const useTheme = (): ThemeProviderState => {
  return useContext(ThemeProviderContext)
}
