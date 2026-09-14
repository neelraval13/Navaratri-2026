import { useCallback, useState } from 'react'

/**
 * Drives the shared `.jitter` animation for one field at a time.
 *
 * The class is cleared for a frame before it is re-applied so a repeated
 * invalid attempt always restarts the animation instead of being ignored
 * while the previous run is still playing.
 */
export const useJitter = <TField extends string>() => {
  const [jitteringField, setJitteringField] = useState<TField | null>(null)

  const clearJitter = useCallback(() => {
    setJitteringField(null)
  }, [])

  const triggerJitter = useCallback((field: TField) => {
    setJitteringField(null)

    requestAnimationFrame(() => {
      setJitteringField(field)
    })
  }, [])

  return { jitteringField, triggerJitter, clearJitter }
}
