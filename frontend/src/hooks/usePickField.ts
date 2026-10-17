import { useCallback, useEffect, useState } from 'react'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { failLoud } from '@/stores/stateInvariants'
import { isPickAllowed } from '@/utils/query/pickOrder'
import { fieldRefusal, type StatusMark } from '@/utils/core/statusMark'

/**
 * Layer-2 pick-field consumer. A pick chip is a consumer of normal selection,
 * never a parallel click path: viewport clicks always `toggleNormalSelection`,
 * and this hook observes the result while its field is the single
 * store-owned `activePickField`.
 *
 * When a new (non-chip-owned) item appears in `normalSelection`, it calls
 * `onPick(selectionId)` so the editor can dispatch its mutation, then clears
 * the selection so the chip's sync effect re-populates chip-owned items.
 * Single-pick fields auto-close after one accepted pick; `multi` fields stay
 * open and consume every new id (a rubber-band box lands as one
 * `normalSelection` set, so all N boxed edges reach `onPick`, not just the
 * first).
 *
 * A refused pick never reaches `onPick`: both refusal guards run here. Passing
 * `features` enables the circular-dependency rule ("only reference earlier
 * features"); `validatePick` is the field's own rule, returning the reason to
 * refuse or null. A refusal keeps the field armed, unlike an accepted pick, so
 * the user can go straight for valid geometry, and its reason comes back as
 * the `refusal` field mark (utils/core/statusMark.ts) for the editor to show
 * next to the field with StatusMessage. The message belongs in
 * the dialog the user is working in, not in a toast detached from the field it
 * explains. The reason travels with the field's rule, so it cannot misstate
 * why the pick was refused. It lasts while the same field stays armed and
 * clears on the next accepted pick or toggle-off.
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
 * Harmless but useless: a redundant mutation, which the no-op guard swallows
 * as a value-identical write, so no dead undo entry lands and no solve runs. It
 * bites sketch vertex/edge picks; plane, face and body values round-trip
 * unchanged.
 * Closing it means normalizing the clicked id the same way before comparing,
 * which belongs with the transform, not here.
 *
 * Returns `{ isPicking, toggle, activate, refusal }`: `toggle` activates this field
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
    validatePick?: (selectionId: string) => string | null
  },
): { isPicking: boolean; toggle: () => void; activate: () => void; refusal: StatusMark } {
  const multi = opts?.multi ?? false
  const onUnpick = opts?.onUnpick
  const features = opts?.features
  const validatePick = opts?.validatePick
  const activePickField = useSketchEditorStore(s => s.activePickField)
  const normalSelection = useSketchEditorStore(s => s.normalSelection)
  const isPicking = activePickField?.featureId === featureId && activePickField?.field === field
  // The last refusal, keyed by the field it was raised in. Disarming or moving
  // to another field drops it outright (PlaneEditor reuses one hook across its
  // plane fields, so `isPicking` stays true across a field switch), during
  // render rather than in an effect, so a re-armed field starts clean instead
  // of flashing the old reason.
  const fieldKey = `${featureId}:${field}`
  const [lastRefusal, setLastRefusal] = useState<{ key: string; reason: string } | null>(null)
  if (lastRefusal !== null && (!isPicking || lastRefusal.key !== fieldKey)) setLastRefusal(null)
  const refusal = fieldRefusal('Pick', lastRefusal?.reason ?? null)

  useEffect(() => {
    if (!isPicking) return
    const s = useSketchEditorStore.getState()

    // Consume every new (non-chip-owned) pick. A single field takes the first
    // accepted id and closes; a multi field loops over the whole set so a
    // rubber-band box adds every edge instead of just the first one (g2-M3).
    let hasNewPick = false
    let refusedWith: string | null = null
    for (const id of s.normalSelection) {
      if (s.chipOwnedSelection.has(id)) continue
      hasNewPick = true
      if (features && !isPickAllowed(id, featureId, features)) {
        // Circular dependency: the host would reference its own output or a
        // later feature's. Drop the pick but keep the field open (unlike an
        // accepted pick) so the user can go straight for valid geometry.
        refusedWith ??= 'can only reference earlier features'
        if (!multi) {
          setLastRefusal({ key: fieldKey, reason: refusedWith })
          s.clearNormalSelection()
          return
        }
        continue  // multi: skip the rejected id, keep consuming the box
      }
      // The field's own rule, when it has one: it returns the refusal reason,
      // which is what the user is told. A refused pick de-highlights with
      // nothing added and keeps the field open, like the build-order refusal
      // above; a box dragging in several bad picks reports the first reason.
      const fieldRefusal = validatePick ? validatePick(id) : null
      if (fieldRefusal !== null) {
        refusedWith ??= fieldRefusal
        if (!multi) {
          setLastRefusal({ key: fieldKey, reason: refusedWith })
          s.clearNormalSelection()
          return
        }
        continue  // multi: skip the refused id, keep consuming the box
      }
      onPick(id)
      if (!multi) {
        setLastRefusal(null)
        s.clearNormalSelection()
        s.setActivePickField(null)
        return
      }
    }
    if (hasNewPick) {
      // A box that mixed good and bad picks still reports the refusal: the
      // user should learn why some of the boxed elements did not land.
      setLastRefusal(refusedWith === null ? null : { key: fieldKey, reason: refusedWith })
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
        setLastRefusal(null)
        // Mirror the onPick path: empty both selection sets so the unstable
        // callback identity can't re-fire this remove before the async re-solve
        // updates `values` and the chip's sync effect repopulates the survivors.
        s.clearNormalSelection()
        return
      }
    }
  }, [normalSelection, isPicking, onPick, onUnpick, multi, features, featureId, field, fieldKey, validatePick])

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
  // It also drops a standing refusal: the chip's x removes a value without the
  // unpick path, and the reason no longer describes the field it now shows.
  const activate = useCallback(() => {
    setLastRefusal(null)
    useSketchEditorStore.getState().setActivePickField({ featureId, field, multi })
  }, [featureId, field, multi])

  return { isPicking, toggle, activate, refusal }
}
