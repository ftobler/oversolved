// The viewport's viewer options, behind one eye button in the bottom-right HUD
// stack. Position chosen with the user: "bottom right corner ... single eye
// icon with dropdown", beside the orientation cube rather than in the header
// (app and document actions) or the toolbar (authoring).
//
// The eye never toggles anything itself; it only opens this card. That keeps
// one meaning for the eye across the app: the feature tree's eye says what is
// SHOWN, and so does this one, opening the rows that decide it.
//
// Two groups, deliberately unlike each other:
//   Show   - document visibility. Rows dispatch through the part page, so they
//            record undo and agree with the keyboard toggles.
//   Viewer - browser preferences. No undo, no document write. Shading and
//            Edges are the drawn layers, Brightness is the global exposure,
//            Zebra and Curvature replace the body material, Camera decides
//            whether an orbit turns about the cursor point, and Debug holds
//            the ID-buffer overlay.
import { useCallback, useEffect, useRef, useState } from 'react'
import iconEyeIcon from '@/assets/icons/icon-eye.svg'
import {
  useViewOptionsStore,
} from '@/stores/viewOptionsStore'
import type { CurvatureKind } from '@/adapters/preferences'
import { MAX_BRIGHTNESS, MAX_ZEBRA_STRIPES, MIN_BRIGHTNESS, MIN_ZEBRA_STRIPES } from '@/adapters/preferences'
import type { ShowGroup, ShowGroupState } from '@/components/Viewport/viewOptionsShow'
import { SHOW_GROUPS } from '@/components/Viewport/viewOptionsShow'
import '@/components/layout/Glass.css'
import '@/components/Viewport/ViewOptions.css'

export interface ViewOptionsButtonProps {
  // The part editor's document-visibility rows. Absent in the assembly, which
  // has no feature tree to show or hide.
  show?: Record<ShowGroup, ShowGroupState>
  onToggleShow?: (group: ShowGroup) => void
}

const SHOW_LABELS: Record<ShowGroup, string> = {
  planes: 'Planes',
  sketches: 'Sketches',
  origin: 'Origin',
}

interface CheckRowProps {
  label: string
  checked: boolean
  disabled?: boolean
  title?: string
  onToggle: () => void
}

/** One check row. A real button, so Space/Enter and the focus ring come for
 *  free; arrow-key movement is handled on the card. */
function CheckRow({ label, checked, disabled = false, title, onToggle }: CheckRowProps) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      className={`view-options-row${checked ? ' checked' : ''}`}
      title={title ?? label}
      disabled={disabled}
      data-view-row
      onClick={onToggle}
    >
      <span className="view-options-check" aria-hidden="true">{checked ? '\u2713' : ''}</span>
      <span className="view-options-label">{label}</span>
    </button>
  )
}

function formatRange(range: [number, number]): string {
  const fmt = (v: number) => (Math.abs(v) < 0.0005 ? '0' : v.toFixed(3))
  return `${fmt(range[0])} .. ${fmt(range[1])} 1/mm`
}

export default function ViewOptionsButton({ show, onToggleShow }: ViewOptionsButtonProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)

  const shading = useViewOptionsStore(s => s.shading)
  const edges = useViewOptionsStore(s => s.edges)
  const brightness = useViewOptionsStore(s => s.brightness)
  const zebra = useViewOptionsStore(s => s.zebra)
  const zebraStripes = useViewOptionsStore(s => s.zebra_stripes)
  const curvature = useViewOptionsStore(s => s.curvature)
  const curvatureKind = useViewOptionsStore(s => s.curvature_kind)
  const curvatureRange = useViewOptionsStore(s => s.curvature_range)
  const curvatureAutoRange = useViewOptionsStore(s => s.curvatureAutoRange)
  const collisionDebug = useViewOptionsStore(s => s.collisionDebug)
  const orbitAroundCursor = useViewOptionsStore(s => s.orbit_around_cursor)

  const setShading = useViewOptionsStore(s => s.setShading)
  const setEdges = useViewOptionsStore(s => s.setEdges)
  const setBrightness = useViewOptionsStore(s => s.setBrightness)
  const resetBrightness = useViewOptionsStore(s => s.resetBrightness)
  const setZebra = useViewOptionsStore(s => s.setZebra)
  const setZebraStripes = useViewOptionsStore(s => s.setZebraStripes)
  const setCurvature = useViewOptionsStore(s => s.setCurvature)
  const setCurvatureKind = useViewOptionsStore(s => s.setCurvatureKind)
  const setCurvatureRange = useViewOptionsStore(s => s.setCurvatureRange)
  const setCollisionDebug = useViewOptionsStore(s => s.setCollisionDebug)
  const setOrbitAroundCursor = useViewOptionsStore(s => s.setOrbitAroundCursor)

  // Escape and an outside pointer both close. A second eye click goes through
  // the button's own toggle; a row click deliberately does not close, so a
  // user can flip several options while watching the model.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setOpen(false)
      buttonRef.current?.focus()
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // One roving order over the interactive rows. Buttons already answer
  // Space/Enter; this adds the pointer-free movement the plan asks for.
  const onCardKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return
    const card = rootRef.current
    if (!card) return
    const rows = Array.from(card.querySelectorAll<HTMLElement>('[data-view-row]:not([disabled])'))
    if (rows.length === 0) return
    e.preventDefault()
    const at = rows.indexOf(document.activeElement as HTMLElement)
    let next = at
    if (e.key === 'ArrowDown') next = at < 0 ? 0 : (at + 1) % rows.length
    else if (e.key === 'ArrowUp') next = at <= 0 ? rows.length - 1 : at - 1
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = rows.length - 1
    rows[next]?.focus()
  }, [])

  // Clicks inside the card belong to the card: without this, a row click bubbles
  // into the viewport's own pointer handlers (rubber band, click gesture) and a
  // menu interaction reads as a canvas click.
  const stop = useCallback((e: React.SyntheticEvent) => { e.stopPropagation() }, [])

  const effectiveRange: [number, number] | null = curvatureRange ?? curvatureAutoRange
  const stripeDisabled = !shading
  const curvatureDisabled = !shading

  return (
    <div className="view-options" ref={rootRef} onPointerDown={stop} onPointerUp={stop} onClick={stop}>
      <button
        ref={buttonRef}
        type="button"
        className={`view-options-btn${open ? ' open' : ''}`}
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="View options"
        onClick={() => setOpen(v => !v)}
      >
        <img src={iconEyeIcon} alt="" />
      </button>

      {open && (
        <div className="view-options-popover glass-panel" role="menu" aria-label="View options" onKeyDown={onCardKeyDown}>
          {show && (
            <>
              <div className="view-options-heading">Show</div>
              {SHOW_GROUPS.map(group => (
                <CheckRow
                  key={group}
                  label={SHOW_LABELS[group]}
                  checked={show[group].visible}
                  disabled={show[group].disabled}
                  onToggle={() => onToggleShow?.(group)}
                />
              ))}
              <div className="view-options-divider" />
            </>
          )}

          <div className="view-options-heading">View</div>
          <CheckRow
            label="Shading"
            checked={shading}
            disabled={!edges}
            title={!edges ? 'Keep at least one layer on' : 'Shading'}
            onToggle={() => setShading(!shading)}
          />
          <CheckRow
            label="Edges"
            checked={edges}
            disabled={!shading}
            title={!shading ? 'Keep at least one layer on' : 'Edges'}
            onToggle={() => setEdges(!edges)}
          />

          <div className="view-options-slider-row">
            <div className="view-options-slider-head">
              <span className="view-options-label">Brightness</span>
              <span className="view-options-value">{brightness.toFixed(2)}</span>
            </div>
            <input
              type="range"
              className="view-options-slider"
              aria-label="Brightness"
              title="Brightness (double-click to reset)"
              min={MIN_BRIGHTNESS}
              max={MAX_BRIGHTNESS}
              step={0.05}
              value={brightness}
              onChange={e => setBrightness(Number(e.target.value))}
              onDoubleClick={() => resetBrightness()}
              data-view-row
            />
          </div>

          <CheckRow
            label="Zebra"
            checked={zebra}
            disabled={stripeDisabled}
            title={stripeDisabled ? 'Zebra needs shading' : 'Zebra stripes'}
            onToggle={() => setZebra(!zebra)}
          />
          {zebra && (
            <div className="view-options-slider-row">
              <div className="view-options-slider-head">
                <span className="view-options-label">Stripe width</span>
                <span className="view-options-value">{zebraStripes}</span>
              </div>
              <input
                type="range"
                className="view-options-slider"
                aria-label="Stripe width"
                min={MIN_ZEBRA_STRIPES}
                max={MAX_ZEBRA_STRIPES}
                step={1}
                value={zebraStripes}
                onChange={e => setZebraStripes(Number(e.target.value))}
                data-view-row
              />
            </div>
          )}

          <CheckRow
            label="Curvature"
            checked={curvature}
            disabled={curvatureDisabled}
            title={curvatureDisabled ? 'Curvature needs shading' : 'Colour by curvature'}
            onToggle={() => setCurvature(!curvature)}
          />
          {curvature && (
            <div className="view-options-curvature">
              <div className="view-options-segment" role="group" aria-label="Curvature kind">
                {(['mean', 'gaussian'] as CurvatureKind[]).map(kind => (
                  <button
                    key={kind}
                    type="button"
                    className={`view-options-segment-btn${curvatureKind === kind ? ' active' : ''}`}
                    aria-pressed={curvatureKind === kind}
                    onClick={() => setCurvatureKind(kind)}
                    data-view-row
                  >
                    {kind === 'mean' ? 'Mean' : 'Gaussian'}
                  </button>
                ))}
              </div>
              <div className="view-options-legend" aria-label="Curvature legend">
                <span className="view-options-legend-bar" />
                <span className="view-options-legend-caption">
                  {effectiveRange ? formatRange(effectiveRange) : 'no bodies'}
                  {curvatureRange ? ' (manual)' : ' (auto)'}
                </span>
              </div>
              <div className="view-options-range-row">
                <input
                  type="number"
                  className="view-options-range-input"
                  aria-label="Curvature range minimum"
                  step="0.01"
                  value={curvatureRange?.[0] ?? ''}
                  onChange={e => {
                    if (e.target.value.trim() === '') return
                    const lo = Number(e.target.value)
                    if (!Number.isFinite(lo)) return
                    const hi = curvatureRange?.[1] ?? effectiveRange?.[1] ?? 1
                    setCurvatureRange([lo, Math.max(lo + 1e-4, hi)])
                  }}
                  data-view-row
                />
                <span className="view-options-label">to</span>
                <input
                  type="number"
                  className="view-options-range-input"
                  aria-label="Curvature range maximum"
                  step="0.01"
                  value={curvatureRange?.[1] ?? ''}
                  onChange={e => {
                    if (e.target.value.trim() === '') return
                    const hi = Number(e.target.value)
                    if (!Number.isFinite(hi)) return
                    const lo = curvatureRange?.[0] ?? effectiveRange?.[0] ?? 0
                    setCurvatureRange([Math.min(hi - 1e-4, lo), hi])
                  }}
                  data-view-row
                />
                <button
                  type="button"
                  className="view-options-reset"
                  title="Back to the automatic range"
                  onClick={() => setCurvatureRange(null)}
                  data-view-row
                >
                  Auto
                </button>
              </div>
            </div>
          )}

          <div className="view-options-divider" />
          <div className="view-options-heading">Camera</div>
          <CheckRow
            label="Orbit around cursor"
            checked={orbitAroundCursor}
            title="Right-drag turns about the body point under the cursor"
            onToggle={() => setOrbitAroundCursor(!orbitAroundCursor)}
          />

          <div className="view-options-divider" />
          <div className="view-options-heading">Debug</div>
          <CheckRow
            label="Collision render"
            checked={collisionDebug}
            title="Draw the ID buffer the pick pass reads"
            onToggle={() => setCollisionDebug(!collisionDebug)}
          />
        </div>
      )}
    </div>
  )
}
