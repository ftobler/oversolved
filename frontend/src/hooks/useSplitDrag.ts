/**
 * useSplitDrag -- the pointer + keyboard resize mechanism shared by the part
 * editor's document panel and the assembly tree. Both editors split their
 * navigator into a top and a bottom pane with the same band, step, document
 * mousemove/mouseup listeners, and container-height math; this hook is the one
 * copy so a clamping or cleanup fix cannot drift between them.
 *
 * The caller owns the container element (the ref), the splitter's markup and
 * its aria-label, since the two editors render different containers.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react'

export const MIN_SPLIT_PERCENT = 20
export const MAX_SPLIT_PERCENT = 80
export const DEFAULT_SPLIT_PERCENT = 70
const SPLIT_STEP_PERCENT = 2

export interface UseSplitDragResult {
  // Top pane height as a percentage of the container, clamped to the band.
  splitPercent: number
  // Attach to the element whose height the split divides.
  containerRef: RefObject<HTMLDivElement | null>
  // Splitter `onMouseDown`: arms the document-level drag.
  handleMouseDown: () => void
  // Splitter `onKeyDown`: arrow keys nudge by a fixed step.
  handleKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => void
  min: number
  max: number
}

function clampPercent(p: number): number {
  return Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, p))
}

export function useSplitDrag(): UseSplitDragResult {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT)
  const isDraggingRef = useRef(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(() => {
    isDraggingRef.current = true
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current || !containerRef.current) return
    const rect = containerRef.current.getBoundingClientRect()
    const newPercent = ((e.clientY - rect.top) / rect.height) * 100
    setSplitPercent(clampPercent(newPercent))
  }, [])

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false
  }, [])

  // The splitter is a slider: arrow keys nudge it by a fixed step, clamped to
  // the same band the drag uses, so the panes can be resized without a pointer.
  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    let delta = 0
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') delta = -SPLIT_STEP_PERCENT
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') delta = SPLIT_STEP_PERCENT
    else return
    e.preventDefault()
    setSplitPercent(p => clampPercent(p + delta))
  }, [])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  return {
    splitPercent,
    containerRef,
    handleMouseDown,
    handleKeyDown,
    min: MIN_SPLIT_PERCENT,
    max: MAX_SPLIT_PERCENT,
  }
}
