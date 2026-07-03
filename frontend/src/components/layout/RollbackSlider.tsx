import React from 'react'

interface RollbackSliderProps {
  isDragging: boolean
  draggable: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

export function RollbackSlider({
  isDragging,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: RollbackSliderProps) {
  return (
    <li
      className={`rollback-bar ${isDragging ? 'dragging' : ''}`}
      title="Rollback"
      draggable={draggable}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragEnd={onDragEnd}
    ></li>
  )
}
