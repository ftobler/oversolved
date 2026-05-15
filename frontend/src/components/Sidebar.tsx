import React, { useState, useRef, useCallback, useEffect } from 'react'
import { FeatureTree } from '@/components/FeatureTree'
import { BodyPartsList } from '@/components/BodyPartsList'

const MIN_SPLIT_PERCENT = 20
const MAX_SPLIT_PERCENT = 80
const DEFAULT_SPLIT_PERCENT = 70

export const Sidebar: React.FC = () => {
  const [splitPercent, setSplitPercent] = useState(DEFAULT_SPLIT_PERCENT)
  const isDraggingRef = useRef(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  const handleMouseDown = useCallback(() => {
    isDraggingRef.current = true
  }, [])

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current || !sidebarRef.current) return
    const rect = sidebarRef.current.getBoundingClientRect()
    const newPercent = ((e.clientY - rect.top) / rect.height) * 100
    setSplitPercent(Math.max(MIN_SPLIT_PERCENT, Math.min(MAX_SPLIT_PERCENT, newPercent)))
  }, [])

  const handleMouseUp = useCallback(() => {
    isDraggingRef.current = false
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
    <aside className="doc-sidebar" ref={sidebarRef}>
      <FeatureTree splitPercent={splitPercent} />
      <div
        className="resize-handle"
        onMouseDown={handleMouseDown}
        title="Drag to resize"
      />
      <BodyPartsList splitPercent={splitPercent} />
    </aside>
  )
}
