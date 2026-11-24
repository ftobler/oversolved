// The one dimension value editor. A freshly placed dimension and a dimension
// label's double-click open the same dialog: the label, the expression input,
// the kind's value rule, the displayed angle supplement and Flip side all come
// from here, so the two entry points cannot drift apart.
import { evalExpr } from '@/kernel/evalExpr'
import { laterVariablesAt, variableScopeAt } from '@/kernel/features/variable'
import type { Quantity } from '@/utils/fieldUnit'
import { refusalText } from '@/utils/core/statusMark'
import { expressionRefusal, positive } from '@/utils/core/valueRules'
import { dimensionValueRule } from '@/utils/core/dimensionValueRules'
import { isConstraintKindName } from '@/wasm-kernel/codec'
import { CONSTRAINT_BY_KIND } from '@/registry/constraintRegistry'
import { TOOL_DEFS } from '@/components/Toolbar/tools/toolsConfig'
import { iconUrl } from '@/components/Toolbar/tools/toolUtils'
import { getSketchCallback } from './sketchEditorCallbacks'
import type { DialogState } from './sketchEditorTypes'
import { failLoud } from './stateInvariants'

/**
 * The string a dimension value box shows: at most five decimals, trailing zeros
 * trimmed. Five is as fine as the box can show without scrolling its own
 * default, and the exact stored value stays in the document: an unchanged
 * confirm commits nothing, so opening and accepting never nudges a dimension by
 * the display rounding.
 */
export function formatDimensionInput(value: number): string {
  if (!Number.isFinite(value)) return '0'
  // The Number round-trip trims the trailing zeros toFixed pads with, and folds
  // a magnitude that rounds to zero into a plain `0`.
  return String(Number(value.toFixed(5)))
}

/** The dimension editor's leading glyph: the kind's own icon when the registry
 *  names one (the angular dimension today), the dimension tool's otherwise, so
 *  a linear dimension and the toolbar read as the same tool. */
export function dimensionEditorIcon(kind: string | undefined): string {
  const override = kind === undefined ? undefined : CONSTRAINT_BY_KIND.get(kind)?.dimensionIcon
  return iconUrl(override ?? TOOL_DEFS.dimension.icon)
}

export interface DimensionEditorOptions {
  featureId: string
  cid: string
  // The point the label sits at, in client pixels.
  clientPos: [number, number]
  // The number the label shows (an angle's displayed supplement included), or
  // null when the placement had no solved geometry to measure.
  value: number | null
  // The constraint kind: it selects the value rule and the dialog icon.
  kind?: string
  label: string
  quantity: Quantity
  // False for a dimension whose value may be zero (the angle, a radial gap).
  validatePositive?: boolean
  // Directional dimensions only: swaps the side the value pins.
  onFlip?: () => void
  // A placement's dialog owns the gesture: confirm commits the transaction,
  // Escape or Cancel rewinds it. An edit of an existing label owns neither.
  placement?: {
    onCommit: () => void
    onCancel: () => void
  }
}

/** The variable scope visible to a feature's expression fields: the same
 *  earlier-variable fold the builder gives the solve, plus the names defined
 *  below it, so a forward reference is named rather than reported as a syntax
 *  error. Null in a headless use with no document port. */
function expressionScope(featureId: string): {
  context: Record<string, number>
  later: Record<string, number>
} | null {
  const doc = getSketchCallback('getDoc')?.()
  if (!doc) return null
  const features = doc.features ?? []
  const index = features.findIndex(f => f.id === featureId)
  if (index < 0) return null
  const context = variableScopeAt(features, index)
  return { context, later: laterVariablesAt(features, index, context) }
}

export function openDimensionEditor(opts: DimensionEditorOptions): void {
  const { kind, placement } = opts
  const rule = opts.validatePositive === false
    ? undefined
    : kind !== undefined && isConstraintKindName(kind)
      ? dimensionValueRule(kind)
      : positive
  const defaultValue = opts.value === null ? undefined : formatDimensionInput(opts.value)
  const dialog: DialogState = {
    position: opts.clientPos,
    label: opts.label,
    defaultValue,
    quantity: opts.quantity,
    icon: dimensionEditorIcon(kind),
    validate: input => {
      const scope = expressionScope(opts.featureId)
      return refusalText('Value', expressionRefusal(input, rule, scope?.context, scope?.later))
    },
    onConfirm: input => {
      // An unchanged confirm keeps the exact stored value. A placement has
      // already inserted the measured value, so the confirm is only the commit;
      // an edit of a rounded label would otherwise write the rounding back and
      // move a satisfied dimension.
      if (input !== defaultValue) {
        const scope = expressionScope(opts.featureId)
        const edited = evalExpr(input, scope?.context ?? {})
        getSketchCallback('onMutation')?.({
          type: 'set_constraint_value', featureId: opts.featureId, constraintId: opts.cid, value: edited,
        })
      }
      placement?.onCommit()
    },
    ...(opts.onFlip && { extraAction: { label: 'Flip side', onClick: opts.onFlip } }),
  }
  if (placement) dialog.onCancel = placement.onCancel
  if (!getSketchCallback('openDialog')) {
    failLoud('[dimensionEditor] openDialog: no dialog port registered, the value dialog cannot open (import stores/sketchEditorStore in the editor build)')
    return
  }
  getSketchCallback('openDialog')?.(dialog)
}
