import type { Mutation } from '@/types/cad'
import { normalizeHexColor } from '@/utils/partColors'
import { PART_COLOR_PALETTE } from '@/utils/partColors'

interface PartColorPopoverProps {
  popover: { bodyId: string; position: [number, number] } | null
  popoverRef: React.RefObject<HTMLDivElement | null>
  colorDraft: string
  onColorDraftChange: (v: string) => void
  transparencyDraft: number
  onTransparencyDraftChange: (v: number) => void
  metalnessDraft: number
  onMetalnessDraftChange: (v: number) => void
  onColorSet: (bodyId: string, color: string) => void
  onTransparencySet: (bodyId: string, t: number) => void
  onMetalnessSet: (bodyId: string, m: number) => void
  onCancel: () => void
  onApply: (mutation: Mutation) => void
}

export default function PartColorPopover({
  popover,
  popoverRef,
  colorDraft,
  onColorDraftChange,
  transparencyDraft,
  onTransparencyDraftChange,
  metalnessDraft,
  onMetalnessDraftChange,
  onColorSet,
  onTransparencySet,
  onMetalnessSet,
  onCancel,
  onApply,
}: PartColorPopoverProps) {
  if (!popover) return null

  return (
    <div
      ref={popoverRef}
      className="part-color-popover"
      tabIndex={-1}
      style={{ left: popover.position[0], top: popover.position[1] + 6 }}
      onMouseDown={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()  // prevent window-level Escape handler from double-firing
          onCancel()
          return
        }
        if (e.key === 'Tab') {
          const container = popoverRef.current
          if (!container) return
          const focusable = container.querySelectorAll<HTMLElement>(
            'input:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'
          )
          if (focusable.length === 0) return
          const first = focusable[0]
          const last = focusable[focusable.length - 1]
          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault()
              last.focus()
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault()
              first.focus()
            }
          }
        }
      }}
    >
      <div className="part-color-popover-row">
        <span className="part-color-popover-label">Color</span>
        <input
          type="text"
          className="part-color-input"
          value={colorDraft}
          onChange={(e) => {
            const val = e.target.value.toUpperCase()
            onColorDraftChange(val)
            const normalized = normalizeHexColor(val)
            if (normalized) {
              onColorSet(popover.bodyId, normalized)
            }
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const normalized = normalizeHexColor(colorDraft)
              if (normalized) {
                onApply({ type: 'set_part_color', bodyId: popover.bodyId, color: normalized })
              }
            }
          }}
          placeholder="#RRGGBB"
        />
      </div>
      <div className="part-color-popover-row">
        <span className="part-color-popover-label">Transparency</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={transparencyDraft}
          onChange={(e) => {
            const val = parseFloat(e.target.value)
            onTransparencyDraftChange(val)
            onTransparencySet(popover.bodyId, val)
          }}
          className="part-slider"
        />
        <span className="part-slider-value">{(transparencyDraft * 100).toFixed(0)}%</span>
      </div>
      <div className="part-color-popover-row">
        <span className="part-color-popover-label">Metalness</span>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={metalnessDraft}
          onChange={(e) => {
            const val = parseFloat(e.target.value)
            onMetalnessDraftChange(val)
            onMetalnessSet(popover.bodyId, val)
          }}
          className="part-slider"
        />
        <span className="part-slider-value">{(metalnessDraft * 100).toFixed(0)}%</span>
      </div>
      <div className="part-color-swatches">
        {PART_COLOR_PALETTE.map(c => (
          <button
            key={c}
            className={`part-color-swatch ${normalizeHexColor(colorDraft) === c ? 'selected' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => {
              onColorDraftChange(c)
              onColorSet(popover.bodyId, c)
            }}
          />
        ))}
      </div>
      <div className="part-color-popover-actions">
        <button className="part-color-popover-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="part-color-popover-btn part-color-popover-btn-primary"
          disabled={!normalizeHexColor(colorDraft)}
          onClick={() => {
            const normalized = normalizeHexColor(colorDraft)
            if (!normalized) return
            onApply({ type: 'set_part_color', bodyId: popover.bodyId, color: normalized })
          }}
        >
          Apply
        </button>
      </div>
    </div>
  )
}
