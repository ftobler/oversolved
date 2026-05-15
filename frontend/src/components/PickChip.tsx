import React, { useEffect, useState } from 'react'
import type { PartFeature } from '@/types/cad'
import { queryLabel } from '@/utils/queryLabel'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

export interface PickChipProps {
  values: string[]
  isPicking: boolean
  onActivate: () => void
  onRemove: (index: number) => void
  onReorder?: (fromIndex: number, toIndex: number) => void
  emptyText?: string
  features?: PartFeature[]
  partLabels?: Record<string, string>
}

export const PickChip: React.FC<PickChipProps> = ({
  values,
  isPicking,
  onActivate,
  onRemove,
  onReorder,
  emptyText,
  features,
  partLabels,
}) => {
  const setPickChipHighlightItems = useSketchEditorStore(s => s.setPickChipHighlightItems)
  const isEmpty = values.length === 0
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null)

  useEffect(() => {
    setPickChipHighlightItems(isPicking ? values : [])
  }, [isPicking, values, setPickChipHighlightItems])
  const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)
  const [dropSide, setDropSide] = useState<'left' | 'right' | null>(null)

  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (!onReorder) return
    e.dataTransfer.setData('text/plain', String(index))
    e.dataTransfer.effectAllowed = 'move'
    setDraggingIndex(index)
  }

  const handleDragOver = (e: React.DragEvent, index: number) => {
    if (!onReorder || draggingIndex === null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    const side = x < rect.width / 2 ? 'left' : 'right'
    setDropTargetIndex(index)
    setDropSide(side)
  }

  const handleDrop = (e: React.DragEvent, targetIndex: number) => {
    if (!onReorder) return
    e.preventDefault()
    const sourceIndex = Number(e.dataTransfer.getData('text/plain'))
    if (sourceIndex === targetIndex) {
      setDraggingIndex(null)
      setDropTargetIndex(null)
      setDropSide(null)
      return
    }
    let insertAt: number
    if (sourceIndex < targetIndex) {
      insertAt = dropSide === 'right' ? targetIndex : targetIndex - 1
    } else {
      insertAt = dropSide === 'right' ? targetIndex + 1 : targetIndex
    }
    onReorder(sourceIndex, insertAt)
    setDraggingIndex(null)
    setDropTargetIndex(null)
    setDropSide(null)
  }

  const handleDragEnd = () => {
    setDraggingIndex(null)
    setDropTargetIndex(null)
    setDropSide(null)
  }

  return (
    <div
      className={`feature-pick-chip ${isEmpty ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
      onClick={(e) => { e.stopPropagation(); onActivate() }}
    >
      {isEmpty && emptyText ? (
        <span className="feature-pick-chip-empty-text">{emptyText}</span>
      ) : (
        values.map((v, i) => {
          const isDragging = draggingIndex === i
          const isDropTarget = dropTargetIndex === i
          const dropClass = isDropTarget && dropSide ? `drop-target-${dropSide}` : ''
          return (
            <div
              key={`${v}-${i}`}
              className={`feature-pick-chip-item ${isDragging ? 'dragging' : ''} ${dropClass}`}
              draggable={!!onReorder}
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              {onReorder && (
                <span className="feature-pick-chip-item-drag" title="Drag to reorder">
                  <img src="/src/assets/icons/toolbar-menu.svg" alt="" draggable={false} />
                </span>
              )}
              <span className="feature-pick-chip-item-text">{features ? queryLabel(v, features, partLabels) : v}</span>
              <button
                className="feature-pick-chip-item-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(i) }}
                title="Remove"
              >×</button>
            </div>
          )
        })
      )}
    </div>
  )
}
