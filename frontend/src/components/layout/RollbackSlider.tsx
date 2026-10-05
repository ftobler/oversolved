import React from 'react'

interface RollbackSliderProps {
  isDragging: boolean
  enabled: boolean
  // The slot the bar currently sits in. Keyboard stepping moves it one slot at
  // a time, clamped to [min, max].
  position: number
  min: number
  max: number
  onGrab: (e: React.PointerEvent) => void
  onSetPosition: (pos: number) => void
}

export function RollbackSlider({ isDragging, enabled, position, min, max, onGrab, onSetPosition }: RollbackSliderProps) {
  // Arrow keys step the bar one slot: Up/Left move toward the start, Down/Right
  // toward the end. The bar may never cover the built-ins, so the step clamps to
  // the legal range and a no-op step commits nothing.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!enabled) return
    let next: number
    if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') next = Math.max(min, position - 1)
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') next = Math.min(max, position + 1)
    else return
    e.preventDefault()
    if (next !== position) onSetPosition(next)
  }

  // The bar sits inside the feature tree's `role="listbox"` <ul>, whose permitted
  // children are option/group. A slider is neither, so wrap the slider in a
  // `group` (a permitted listbox child); the group can hold the slider.
  return (
    <li role="group" aria-label="Rollback">
      <div
        className={`rollback-bar ${isDragging ? 'dragging' : ''}`}
        title="Rollback"
        role="slider"
        tabIndex={enabled ? 0 : -1}
        aria-label="Rollback position"
        aria-orientation="vertical"
        aria-valuenow={position}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-disabled={!enabled}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (!enabled || e.button !== 0) return
          e.preventDefault()  // no text selection while the bar is being pulled
          onGrab(e)
        }}
      />
    </li>
  )
}
