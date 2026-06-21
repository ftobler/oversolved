import { useRef, useState, useEffect } from 'react'
import type { Mutation } from '@/types/cad'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { DEFAULT_PART_ROUGHNESS, normalizeHexColor, PART_COLOR_PALETTE } from '@/utils/core/partColors'

interface PartColorPopoverProps {
  popover: { bodyId: string; position: [number, number]; session?: number } | null
  onColorSet: (bodyId: string, color: string) => void
  onTransparencySet: (bodyId: string, t: number) => void
  onMetalnessSet: (bodyId: string, m: number) => void
  onRoughnessSet: (bodyId: string, r: number) => void
  onTransmissionSet: (bodyId: string, t: number) => void
  onCancel: () => void
  onApply: (mutation: Mutation) => void
}

interface InnerProps extends PartColorPopoverProps {
  popover: { bodyId: string; position: [number, number] }
}

const formatPercent = (val: number): string => `${(val * 100).toFixed(0)}%`

// One 0..1 material slider row (opacity / metalness / roughness / transmission).
function MaterialSlider({
  label,
  value,
  onChange,
  display = formatPercent,
}: {
  label: string
  value: number
  onChange: (val: number) => void
  display?: (val: number) => string
}) {
  return (
    <div className="part-color-popover-row">
      <span className="part-color-popover-label">{label}</span>
      <input
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="part-slider"
      />
      <span className="part-slider-value">{display(value)}</span>
    </div>
  )
}

// Separate inner component so `key={bodyId}` re-mounts with fresh draft state
function PartColorPopoverInner({
  popover,
  onColorSet,
  onTransparencySet,
  onMetalnessSet,
  onRoughnessSet,
  onTransmissionSet,
  onCancel,
  onApply,
}: InnerProps) {
  const partStyle = usePartEditorStore(s => s.partStyle)
  const style = partStyle[popover.bodyId]

  const popoverRef = useRef<HTMLDivElement>(null)
  const [colorDraft, setColorDraft] = useState(() => normalizeHexColor(style?.color) || '#6AB59B')
  const [transparencyDraft, setTransparencyDraft] = useState(style?.transparency ?? 0)
  const [metalnessDraft, setMetalnessDraft] = useState(style?.metalness ?? 0)
  const [roughnessDraft, setRoughnessDraft] = useState(style?.roughness ?? DEFAULT_PART_ROUGHNESS)
  const [transmissionDraft, setTransmissionDraft] = useState(style?.transmission ?? 0)

  // Focus first focusable element on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      const firstInput = popoverRef.current?.querySelector('input, button') as HTMLElement | null
      firstInput?.focus()
    })
  }, [])

  return (
    <div
      ref={popoverRef}
      className="part-color-popover"
      tabIndex={-1}
      style={{ left: popover.position[0], top: popover.position[1] + 6 }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
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
            setColorDraft(val)
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
      <MaterialSlider
        label="Opacity"
        value={transparencyDraft}
        onChange={(val) => {
          setTransparencyDraft(val)
          onTransparencySet(popover.bodyId, val)
        }}
        display={(val) => `${((1 - val) * 100).toFixed(0)}%`}
      />
      <MaterialSlider
        label="Metalness"
        value={metalnessDraft}
        onChange={(val) => {
          setMetalnessDraft(val)
          onMetalnessSet(popover.bodyId, val)
        }}
      />
      <MaterialSlider
        label="Roughness"
        value={roughnessDraft}
        onChange={(val) => {
          setRoughnessDraft(val)
          onRoughnessSet(popover.bodyId, val)
        }}
      />
      <MaterialSlider
        label="Transmission"
        value={transmissionDraft}
        onChange={(val) => {
          setTransmissionDraft(val)
          onTransmissionSet(popover.bodyId, val)
        }}
      />
      <div className="part-color-swatches">
        {PART_COLOR_PALETTE.map(c => (
          <button
            key={c}
            className={`part-color-swatch ${normalizeHexColor(colorDraft) === c ? 'selected' : ''}`}
            style={{ background: c }}
            title={c}
            onClick={() => {
              setColorDraft(c)
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

export default function PartColorPopover(props: PartColorPopoverProps) {
  if (!props.popover) return null
  // Include session so re-opening the same body always re-mounts with fresh draft state
  const key = `${props.popover.bodyId}-${props.popover.session ?? 0}`
  return <PartColorPopoverInner key={key} {...props} popover={props.popover} />
}
