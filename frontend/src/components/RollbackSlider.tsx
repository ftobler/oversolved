import React from 'react'

interface RollbackSliderProps {
  isDragging: boolean
  onDragStart: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

export const RollbackSlider: React.FC<RollbackSliderProps> = ({
  isDragging,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}) => (
  <li
    className={`rollback-bar ${isDragging ? 'dragging' : ''}`}
    title="Rollback"
    draggable
    onDragStart={onDragStart}
    onDragOver={onDragOver}
    onDrop={onDrop}
    onDragEnd={onDragEnd}
  ></li>
)
