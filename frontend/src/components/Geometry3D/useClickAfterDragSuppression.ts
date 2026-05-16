import { useRef, useCallback } from 'react'

export function useClickAfterDragSuppression() {
  const moved = useRef(false)
  const markMoved = useCallback(() => { moved.current = true }, [])
  // Returns true if the click should be suppressed (consumed and cleared).
  const consumeClick = useCallback((): boolean => {
    if (moved.current) { moved.current = false; return true }
    return false
  }, [])
  const reset = useCallback(() => { moved.current = false }, [])
  return { markMoved, consumeClick, reset }
}
