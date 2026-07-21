import React from 'react'

interface RollbackSliderProps {
  isDragging: boolean
  enabled: boolean
  onGrab: (e: React.PointerEvent) => void
}

export function RollbackSlider({ isDragging, enabled, onGrab }: RollbackSliderProps) {
  return (
    <li
      className={`rollback-bar ${isDragging ? 'dragging' : ''}`}
      title="Rollback"
      onPointerDown={(e) => {
        if (!enabled || e.button !== 0) return
        e.preventDefault()  // no text selection while the bar is being pulled
        onGrab(e)
      }}
    ></li>
  )
}
