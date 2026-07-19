// The mate authoring body (Stage 8). Two reference chips and the parameters the
// mate's kind actually reads. Rendered inline inside the mate's tree row, below
// the pink editing header the tree draws (kind label + accept/reject/delete), so
// this component owns only the fields, mirroring the part editor's feature
// editors that expand inside the feature-item. Renaming is deliberately absent:
// it lives in the row's tridot menu, where every other feature in the app renames.
//
// The chips are NOT the part editor's PickChip: that one consumes
// sketchEditorStore's normalSelection, which the assembly scene never writes.
// Here a chip arms `assemblyStore.activeMateField`, and the viewport's aimed
// candidate is written into the mate's slot as the user clicks and cycles. So
// the chip shows what the document holds, always, rather than a parallel
// selection that could drift from it.
//
// Presentational: every mutation leaves through a callback, so the panel's logic
// (mateKinds.ts, assemblyMutations.ts) stays viewport-free and unit-tested.

import { useState } from 'react'
import type { MateFeatureDef, MateRef, MateRefField } from '@/types/cad'
import type { MateResult } from '@/kernel/solveAssembly'
import type { MateFieldTarget } from '@/stores/assemblyStore'
import type { MateParamPatch } from '@/utils/assemblyMutations'
import {
  MATE_PARAM_LABELS, isMateRefEmpty, mateParams, mateRefLabel, normalizeMateAngleDeg,
  type MateParam,
} from '@/utils/mateKinds'

interface MateEditorProps {
  featureId: string
  mate: MateFeatureDef
  result?: MateResult
  activeField: MateFieldTarget | null
  labelFor?: (handle: string) => string | undefined
  onArmField: (target: MateFieldTarget | null) => void
  onUpdate: (patch: MateParamPatch) => void
}

const REF_FIELDS: readonly MateRefField[] = ['ref_a', 'ref_b']
const REF_TITLES: Record<MateRefField, string> = { ref_a: 'Reference A', ref_b: 'Reference B' }

// Wears the part editor's pick-chip classes so the two look identical; the
// mate-ref-chip class carries only the button reset and the `stale` state, which
// the part chip has no equivalent for.
function chipClass(ref: MateRef, stale: boolean, picking: boolean): string {
  const parts = ['feature-pick-chip', 'mate-ref-chip']
  if (isMateRefEmpty(ref)) parts.push('empty')
  // Red means "the geometry this named is gone". An unpicked slot is merely
  // empty, so it must not borrow the same alarm.
  else if (stale) parts.push('stale')
  if (picking) parts.push('picking')
  return parts.join(' ')
}

/** The scalar params ride NumberOrExpr; expression binding is not wired yet, so a
 *  formula authored elsewhere is shown blank and edited as a number. */
function numericValue(v: unknown): string {
  return typeof v === 'number' ? String(v) : ''
}

export function MateEditor({
  featureId, mate, result, activeField, labelFor, onArmField, onUpdate,
}: MateEditorProps) {
  const staleRefs = new Set(result?.staleRefs ?? [])
  // The box's own text, not `mate.angle` directly: a half-typed keystroke ('-',
  // '1e') must stay visible so the user can finish the number, rather than
  // snapping back to the last committed value mid-entry. Resynced
  // from the document whenever the committed angle changes from elsewhere (a
  // +90 click, a different mate selected) -- done inline during render
  // (the React-recommended way to adjust state on a prop change) rather than
  // in an effect, which would commit the stale text for one extra render.
  const [angleText, setAngleText] = useState(() => numericValue(mate.angle))
  const [syncedFor, setSyncedFor] = useState<{ featureId: string; angle: unknown }>({
    featureId, angle: mate.angle,
  })
  if (syncedFor.featureId !== featureId || syncedFor.angle !== mate.angle) {
    setSyncedFor({ featureId, angle: mate.angle })
    setAngleText(numericValue(mate.angle))
  }

  // Overflow cleans itself up: the +90 button steps forever and lands back in
  // [0, 360), so three presses reach what a -90 button would have. Not used by
  // the free-text box's per-keystroke commit, which would
  // rewrite a leading '-' into 351 before the user could type the '90' after it.
  const commitAngle = (next: number) => {
    onUpdate({ angle: normalizeMateAngleDeg(next) })
  }

  const renderParam = (param: MateParam) => {
    if (param === 'flip') {
      return (
        <label key={param} className="feature-field-row">
          <span className="feature-field-label">{MATE_PARAM_LABELS.flip}</span>
          <input
            type="checkbox"
            checked={!!mate.flip}
            onChange={e => onUpdate({ flip: e.target.checked || undefined })}
          />
        </label>
      )
    }
    if (param === 'angle') {
      const current = typeof mate.angle === 'number' ? mate.angle : 0
      return (
        <div key={param} className="mate-param-angle">
          <label className="feature-field-row">
            <span className="feature-field-label">{MATE_PARAM_LABELS.angle}</span>
            <input
              type="number"
              className="feature-field-input"
              aria-label={MATE_PARAM_LABELS.angle}
              value={angleText}
              placeholder="0"
              onChange={e => {
                const raw = e.target.value
                setAngleText(raw)
                if (raw === '') { onUpdate({ angle: undefined }); return }
                const next = Number(raw)
                // Committed unnormalised so a negative stays typeable; the roll
                // residual wraps either way, so the document is never wrong in
                // between, only unnormalised. Garbage commits nothing and stays
                // on screen for the user to fix.
                if (Number.isFinite(next)) onUpdate({ angle: next })
              }}
              // Entry is finished: fold whatever was typed into [0, 360). 270
              // and -90 name the same roll (mate_residuals.rs wraps the
              // difference), so this is a display normalisation, not a change
              // of pose.
              onBlur={() => {
                if (angleText.trim() === '') return
                const typed = Number(angleText)
                if (!Number.isFinite(typed)) return
                const normalized = normalizeMateAngleDeg(typed)
                setAngleText(String(normalized))
                if (normalized !== typed) onUpdate({ angle: normalized })
              }}
            />
          </label>
          <div className="mate-angle-buttons">
            <button type="button" onClick={() => commitAngle(current + 90)}>
              +90&deg;
            </button>
          </div>
        </div>
      )
    }
    return (
      <label key={param} className="feature-field-row">
        <span className="feature-field-label">{MATE_PARAM_LABELS[param]}</span>
        <input
          type="number"
          className="feature-field-input"
          value={numericValue(mate[param])}
          placeholder="0"
          onChange={e => {
            const raw = e.target.value
            // An emptied box means "unset", not zero: the solver defaults these
            // itself, and writing 0 would pin an offset the user did not ask for.
            onUpdate({ [param]: raw === '' ? undefined : Number(raw) } as MateParamPatch)
          }}
        />
      </label>
    )
  }

  return (
    // Clicks inside the editor must not bubble to the row, whose onClick would
    // re-select the mate and disarm the field a chip just armed.
    <div className="mate-editor" onClick={e => e.stopPropagation()}>
      {REF_FIELDS.map(field => {
        const picking = activeField?.featureId === featureId && activeField.field === field
        const empty = isMateRefEmpty(mate[field])
        return (
          // Stacked like the part editor's pick fields: a reference string is far
          // wider than the 80px label column leaves room for.
          <div key={field} className="feature-field-row feature-field-row--stacked">
            <span className="feature-field-label">{REF_TITLES[field]}</span>
            <button
              type="button"
              className={chipClass(mate[field], staleRefs.has(field), picking)}
              aria-pressed={picking}
              onClick={() => onArmField(picking ? null : { featureId, field })}
            >
              {/* Same two shapes the part editor's PickChip renders: italic
                  placeholder text when empty, a pink pill once picked. Spans,
                  not divs, because the chip itself is a button here. */}
              {empty ? (
                <span className="feature-pick-chip-empty-text">
                  {mateRefLabel(mate[field], labelFor)}
                </span>
              ) : (
                <span className="feature-pick-chip-item">
                  <span className="feature-pick-chip-item-text">
                    {mateRefLabel(mate[field], labelFor)}
                  </span>
                </span>
              )}
            </button>
          </div>
        )
      })}

      <div className="mate-param-list">{mateParams(mate.kind).map(renderParam)}</div>
    </div>
  )
}
