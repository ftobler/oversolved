import { useCallback, useEffect } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { failLoud } from '@/stores/stateInvariants'
import { isPickAllowed } from '@/utils/query/pickOrder'
import { useNotifySafe } from '@/contexts/ToastContext'

/**
 * Layer-2 pick-field consumer. A pick chip is a consumer of normal selection,
 * never a parallel click path: viewport clicks always `toggleNormalSelection`,
 * and this hook observes the result while its field is the single
 * store-owned `activePickField`.
 *
 * When a new (non-chip-owned) item appears in `normalSelection`, it calls
 * `onPick(selectionId)` so the editor can dispatch its mutation, then clears
 * the selection so the chip's sync effect re-populates chip-owned items.
 * Single-pick fields auto-close after one pick; `multi` fields stay open and
 * consume every new id (a rubber-band box lands as one `normalSelection` set,
 * so all N boxed edges reach `onPick`, not just the first).
 *
 * Re-clicking an already-picked element toggles it out of `normalSelection`
 * (the viewport click path is symmetric). A chip-owned id that has dropped out
 * of `normalSelection` is that toggle-off, so we call `onUnpick(selectionId)`
 * to let the editor dispatch the matching remove mutation. Every consumer owes
 * an `onUnpick`: the drop breaks the "chipOwnedSelection subset of
 * normalSelection" invariant until this hook consumes it, so a consumer without
 * a handler is a wiring bug and fails loud rather than silently no-opping.
 *
 * KNOWN GAP: the toggle-off is only detectable when the chip mirrors the very
 * string the viewport toggles. An editor that stores a REWRITTEN value (any
 * `transform`, or `emitAbsoluteSelectionQuery`, which turns `vertex:sk1:l1:start`
 * into `@sk1/l1/start`) mirrors a value no click can ever match, so a re-click
 * takes the onPick branch instead and re-dispatches the value it already holds.
 * Harmless but useless: a redundant mutation and a no-op undo entry. It bites
 * sketch vertex/edge picks; plane, face and body values round-trip unchanged.
 * Closing it means normalizing the clicked id the same way before comparing,
 * which belongs with the transform, not here.
 *
 * `features` is the build-order stack. Passing it enables the circular-dependency
 * guard: this is the one choke point every pick chip funnels through, so the
 * rule "you may only pick from features before you" is enforced here once
 * instead of in each editor.
 *
 * Returns `{ isPicking, toggle, activate }`: `toggle` activates this field
 * (clearing any other active field) or deactivates it if already active;
 * `activate` unconditionally arms this field, used after a chip is removed so
 * the user can immediately re-pick the value they just took out.
 */
export function usePickField(
  featureId: string,
  field: string,
  onPick: (selectionId: string) => void,
  opts?: {
    multi?: boolean
    onUnpick?: (selectionId: string) => void
    features?: readonly { id: string }[]
  },
): { isPicking: boolean; toggle: () => void; activate: () => void } {
  const multi = opts?.multi ?? false
  const onUnpick = opts?.onUnpick
  const features = opts?.features
  const activePickField = useSketchEditorStore(s => s.activePickField)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const notify = useNotifySafe()
  const isPicking = activePickField?.featureId === featureId && activePickField?.field === field

  useEffect(() => {
    if (!isPicking) return
    const s = useSketchEditorStore.getState()

    // Consume every new (non-chip-owned) pick. A single field takes the first
    // id and closes; a multi field loops over the whole set so a rubber-band
    // box adds every edge instead of just the first one (g2-M3).
    let hasNewPick = false
    let refused = false
    for (const id of s.normalSelection) {
      if (s.chipOwnedSelection.has(id)) continue
      hasNewPick = true
      if (features && !isPickAllowed(id, featureId, features)) {
        // Circular dependency: the host would reference its own output or a
        // later feature's. Drop the pick but keep the field open (unlike an
        // accepted pick) so the user can go straight for valid geometry.
        if (!refused) {
          refused = true
          notify('Pick refused: can only reference earlier features', 'warning')
        }
        if (!multi) {
          s.clearNormalSelection()
          return
        }
        continue  // multi: skip the rejected id, keep consuming the box
      }
      onPick(id)
      if (!multi) {
        s.clearNormalSelection()
        s.setActivePickField(null)
        return
      }
    }
    if (hasNewPick) {
      s.clearNormalSelection()
      return
    }

    // No new pick: a chip-owned id missing from normalSelection is a re-click
    // toggle-off, so remove it from the chip.
    for (const id of s.chipOwnedSelection) {
      if (!s.normalSelection.has(id)) {
        if (!onUnpick) {
          // The drop is a transient invariant violation that only this hook can
          // consume. A consumer without a handler leaves it stranded, so drop
          // the mirror ourselves and then report the missing wiring. Order
          // matters: failLoud throws in test mode, so reporting first would skip
          // the recovery exactly where the leftover orphan bleeds into the next
          // assertion. The chip re-syncs from its unchanged values on the next
          // render, making this a visible no-op rather than corrupt state.
          s.clearNormalSelection()
          failLoud(`[usePickField] '${featureId}:${field}' dropped chip-owned '${id}' but has no onUnpick handler`)
          return
        }
        onUnpick(id)
        // Mirror the onPick path: empty both selection sets so the unstable
        // callback identity can't re-fire this remove before the async re-solve
        // updates `values` and the chip's sync effect repopulates the survivors.
        s.clearNormalSelection()
        return
      }
    }
  }, [normalSelection, isPicking, onPick, onUnpick, multi, features, featureId, field, notify])

  const toggle = useCallback(() => {
    const s = useSketchEditorStore.getState()
    const cur = s.activePickField
    if (cur?.featureId === featureId && cur?.field === field) {
      s.setActivePickField(null)
    } else {
      s.setActivePickField({ featureId, field, multi })
    }
  }, [featureId, field, multi])

  // Unconditional arming, unlike `toggle`: idempotent when this field is already
  // the active one (setActivePickField re-arms the same entry), so a caller can
  // fire it after a remove without worrying about whether the field was active.
  const activate = useCallback(() => {
    useSketchEditorStore.getState().setActivePickField({ featureId, field, multi })
  }, [featureId, field, multi])

  return { isPicking, toggle, activate }
}
