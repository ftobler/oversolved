import React from 'react'

export interface PickChipProps {
  values: string[]
  isPicking: boolean
  onActivate: () => void
  onRemove: (index: number) => void
  emptyText?: string
}

export const PickChip: React.FC<PickChipProps> = ({
  values,
  isPicking,
  onActivate,
  onRemove,
  emptyText,
}) => {
  const isEmpty = values.length === 0
  return (
    <div
      className={`feature-pick-chip ${isEmpty ? 'empty' : ''} ${isPicking ? 'picking' : ''}`}
      onClick={(e) => { e.stopPropagation(); onActivate() }}
    >
      {isEmpty && emptyText ? (
        <span className="feature-pick-chip-empty-text">{emptyText}</span>
      ) : (
        values.map((v, i) => (
          <div key={`${v}-${i}`} className="feature-pick-chip-item">
            <span className="feature-pick-chip-item-text">{v}</span>
            <button
              className="feature-pick-chip-item-remove"
              onClick={(e) => { e.stopPropagation(); onRemove(i) }}
              title="Remove"
            >×</button>
          </div>
        ))
      )}
    </div>
  )
}
