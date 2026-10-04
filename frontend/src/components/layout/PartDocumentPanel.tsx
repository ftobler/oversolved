import { useState, useRef, useCallback, useEffect, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { FeatureTree } from '@/components/layout/FeatureTree'
import { BodyPartsList } from '@/components/layout/BodyPartsList'

const MIN_SPLIT_PERCENT = 20
const MAX_SPLIT_PERCENT = 80
const DEFAULT_SPLIT_PERCENT = 70
const SPLIT_STEP_PERCENT = 2

// The part editor's own navigator: FeatureTree over BodyPartsList, with the
// drag splitter it always had. The wrapper is the flex column that used to be
// the aside, so the percentage-height bands and the splitter rect resolve
// exactly as before; extracting it lets Sidebar host both this stack and the
// assembly tree without either knowing about the other.
export function PartDocumentPanel() {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT)
  const isDraggingRef = useRef(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(() => {
    isDraggingRef.current = true
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current || !panelRef.current) return
    const rect = panelRef.current.getBoundingClientRect()
    const newPercent = ((e.clientY - rect.top) / rect.height) * 100
    setSplitPercent(Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, newPercent)))
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
    setSplitPercent(p => Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, p + delta)))
  }, [])

  useEffect(() => {
    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
    }
  }, [handleMouseMove, handleMouseUp])

  return (
    <div className="document-panel" ref={panelRef}>
      <FeatureTree splitPercent={splitPercent} />
      <div
        className="resize-handle"
        onMouseDown={handleMouseDown}
        onKeyDown={handleKeyDown}
        title="Drag to resize"
        role="slider"
        tabIndex={0}
        aria-label="Resize part panes"
        aria-orientation="vertical"
        aria-valuenow={Math.round(splitPercent)}
        aria-valuemin={MIN_SPLIT_PERCENT}
        aria-valuemax={MAX_SPLIT_PERCENT}
      />
      <BodyPartsList splitPercent={splitPercent} />
    </div>
  )
}
