// The section view's controls as their own card in the right column.
//
// This is viewer state, not a feature: everything it reads and writes lives in
// `stores/sectionStore.ts`, which is outside the document by design. There is
// no Mutation, no undo entry and no edit session, and Exit only turns the
// section off. That is also why the card has no OK/Cancel pair: there is
// nothing to commit or discard.
import { useMemo } from 'react'
import type { LengthUnit } from '@/types/cad'
import { BUILTIN_SECTION_PLANES } from '@/viewport/sectionPlane'
import {
  SECTION_PICK_HINT,
  SECTION_PICK_UNAVAILABLE_NOTE,
  sectionCardVisible,
  useSectionStore,
} from '@/stores/sectionStore'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { queryLabel } from '@/utils/query/queryLabel'
import { evalExpr } from '@/kernel/evalExpr'
import { ExpressionInput } from '@/components/editors/widgets/ExpressionInput'
import { StatusMessage } from '@/components/shared/StatusMessage'
import '@/components/layout/Glass.css'
import '@/components/Viewport/SectionPanel.css'
import sectionIcon from '@/assets/icons/feature-section.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'

export interface SectionPanelProps {
  // The part editor resolves a picked face or user plane; the assembly has no
  // planar-face registry for a section, so it shows the builtin planes only.
  allowPick?: boolean
  // The box displays and accepts the document's own unit. The assembly has no
  // unit, so it keeps the millimetre default.
  lengthUnit?: LengthUnit
}

const PLANE_LABELS = { front: 'Front', top: 'Top', right: 'Right' } as const

export function SectionPanel({ allowPick = true, lengthUnit = 'mm' }: SectionPanelProps) {
  const enabled = useSectionStore(s => s.enabled)
  const plane = useSectionStore(s => s.plane)
  const offset = useSectionStore(s => s.offset)
  const flipped = useSectionStore(s => s.flipped)
  const disabledReason = useSectionStore(s => s.disabledReason)
  const pickError = useSectionStore(s => s.pickError)
  const picking = useSectionStore(s => s.picking)
  const visible = useSectionStore(sectionCardVisible)
  const setEnabled = useSectionStore(s => s.setEnabled)
  const setPlane = useSectionStore(s => s.setPlane)
  const setOffset = useSectionStore(s => s.setOffset)
  const setFlipped = useSectionStore(s => s.setFlipped)
  const setPicking = useSectionStore(s => s.setPicking)
  const cancelPicking = useSectionStore(s => s.cancelPicking)

  // A picked face or plane is named the way the tree and pick chips name it.
  // A face query already carries its query syntax; a user plane's source is the
  // bare feature id, which the resolver expects as a ref. The body-pick
  // resolver is wrong here: it names the whole part of a face query.
  const partLabels = usePartEditorStore(s => s.partLabels)
  const features = usePartEditorStore(s => s.features)
  const pickedLabel = useMemo(() => {
    if (plane.kind !== 'query') return null
    const query = plane.query.startsWith('@') || plane.query.startsWith('?')
      ? plane.query
      : `@${plane.query}`
    return queryLabel(query, features, partLabels)
  }, [plane, features, partLabels])

  // A thumbnail capture never carries the editor's furniture, and an off
  // section with no reason has nothing to say. The assembly's column reads the
  // same predicate.
  if (!visible) return null

  const togglePick = () => {
    if (picking) {
      cancelPicking()
      return
    }
    // One viewport click cannot serve two armed picks. The section pick takes
    // priority in the dispatcher, so the feature field has to stand down.
    useSketchEditorStore.getState().setActivePickField(null)
    setPicking(true)
  }

  // The store holds a number; an expression is evaluated on the way in, and
  // ExpressionInput has already refused what it cannot evaluate.
  const commitOffset = (value: string | number) => {
    setOffset(typeof value === 'number' ? value : evalExpr(value))
  }

  return (
    <div className="glass-panel feature-edit-panel section-panel">
      <div className="feature-edit-panel-header">
        <img className="feature-icon" src={sectionIcon} alt="" />
        <span className="feature-edit-panel-title section-panel-title">Section</span>
        <button
          type="button"
          className="section-panel-exit"
          title="Exit section view"
          aria-label="Exit section view"
          onClick={() => setEnabled(false)}
        >
          <img src={cancelIcon} alt="" />
        </button>
      </div>

      <div className="feature-edit-panel-body section-panel-body">
        {!enabled && disabledReason !== null && (
          <>
            <StatusMessage mark={{ level: 'error', message: disabledReason }} />
            <button
              type="button"
              className="section-panel-again"
              onClick={() => setEnabled(true)}
            >
              Turn on again
            </button>
          </>
        )}

        {enabled && (
          <>
            <div className="feature-field-row section-panel-plane-row">
              <span className="feature-field-label section-panel-plane-label">Plane</span>
              <div className="section-panel-planes" role="group" aria-label="Section plane">
                {BUILTIN_SECTION_PLANES.map(id => {
                  const chosen = plane.kind === 'builtin' && plane.id === id
                  return (
                    <button
                      key={id}
                      type="button"
                      className={`feature-field-tab${chosen ? ' active' : ''}`}
                      aria-pressed={chosen}
                      onClick={() => setPlane({ kind: 'builtin', id })}
                    >
                      {PLANE_LABELS[id]}
                    </button>
                  )
                })}
                {allowPick && (
                  <button
                    type="button"
                    className="feature-field-select section-panel-pick"
                    aria-pressed={picking}
                    title={picking
                      ? 'Cancel the viewport pick'
                      : pickedLabel === null
                        ? 'Pick a face or plane in the viewport'
                        : 'Pick another face or plane'}
                    onClick={togglePick}
                  >
                    {picking ? 'Cancel pick' : pickedLabel ?? 'Pick'}
                  </button>
                )}
              </div>
            </div>

            {!allowPick && (
              <div className="section-panel-note" role="status">{SECTION_PICK_UNAVAILABLE_NOTE}</div>
            )}
            {pickError !== null && (
              <StatusMessage mark={{ level: 'error', message: pickError }} />
            )}
            {picking && (
              <StatusMessage mark={{ level: 'warning', message: SECTION_PICK_HINT }} />
            )}

            <div className="feature-field-row">
              <span className="feature-field-label">Offset</span>
              <ExpressionInput
                value={offset}
                onChange={commitOffset}
                quantity="length"
                lengthUnit={lengthUnit}
                ariaLabel="Section offset"
              />
            </div>

            <div className="feature-field-row">
              <span className="feature-field-label">Reverse</span>
              <label className="section-panel-check">
                <input
                  type="checkbox"
                  checked={flipped}
                  title="Keep the other half"
                  onChange={e => setFlipped(e.target.checked)}
                />
                Reverse direction
              </label>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
