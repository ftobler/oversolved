import { useCallback, useEffect, useState } from 'react'
import type { PartFeature } from '@/types/cad'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { failLoud } from '@/stores/stateInvariants'
import { isPickAllowed } from '@/utils/query/pickOrder'
import {
  identityWantKey,
  planPickIntake,
  type PickBatch,
  type WantKeyOf,
} from '@/utils/query/pickIntake'
import { fieldRefusal, type StatusMark } from '@/utils/core/statusMark'

/**
 * Layer-2 pick-field consumer. A pick chip is a consumer of normal selection,
 * never a parallel click path: viewport clicks always `toggleNormalSelection`,
 * and this hook observes the result while its field is the single
 * store-owned `activePickField`.
 *
 * A chip holds IDENTITIES, not selection strings. The caller hands over the
 * field's `held` values and a `wantKeyOf` that maps a pick to the identity it
 * names: a part field wants the body a face, an edge or the whole part belongs
 * to, and every other field wants the stored form of the id (`IDENTITY`, or the
 * field's own transform). One arriving `normalSelection` batch is planned
 * against those held keys (`planPickIntake`, utils/query/pickIntake.ts): a click
 * whose identity is already held is the REMOVAL pick for that value, even when
 * it names the value through a different face or edge, while a lasso only adds
 * and skips what is already held. Each identity lands once, so a box over a
 * part's twelve faces is one part, and a box over several parts is one batch.
 *
 * The batch reaches the editor through `onPickBatch({ add, remove })`, which
 * dispatches it as one mutation group (one undo step). The older single-id
 * `onPick`/`onUnpick` pair stays for consumers with no identity model (the
 * plane editors and the bug report), which see the same plan reduced to its
 * first actions.
 *
 * A refused pick never reaches the callbacks: both refusal guards run here,
 * inside the same plan, so a refused id is dropped from the batch like any other
 * refusal. Passing `features` enables the circular-dependency rule ("only
 * reference earlier features"); `validatePick` is the field's own rule,
 * returning the reason to refuse or null. A refusal keeps the field armed,
 * unlike an accepted pick, so the user can go straight for valid geometry, and
 * its reason comes back as the `refusal` field mark (utils/core/statusMark.ts)
 * for the editor to show next to the field with StatusMessage. The message
 * belongs in the dialog the user is working in, not in a toast detached from
 * the field it explains. The reason travels with the field's rule, so it cannot
 * misstate why the pick was refused. It lasts while the same field stays armed
 * and clears on the next accepted pick or toggle-off.
 *
 * Re-clicking an already-picked element toggles it out of `normalSelection`
 * (the viewport click path is symmetric). A chip-owned id that has dropped out
 * of `normalSelection` is that toggle-off, so we call `onUnpick(selectionId)` (or
 * the batch's remove for its index) to let the editor dispatch the matching
 * remove mutation. Every consumer owes one of the two: the drop breaks the
 * "chipOwnedSelection subset of normalSelection" invariant until this hook
 * consumes it, so a consumer without a handler is a wiring bug and fails loud
 * rather than silently no-opping.
 *
 * A refusal consumes only the ids it refused (`dropFromNormalSelection`), never
 * the whole selection: clearing it also wiped the chip-owned mirror, leaving the
 * chip unlit until its values changed again (the backlog's "a refused pick wipes
 * the chip's highlight mirror").
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
    features?: readonly PartFeature[]
    validatePick?: (selectionId: string, features?: readonly PartFeature[]) => string | null
    // The values the field holds, in chip order. Remove actions are indices into
    // this list; a field without it never plans a removal.
    held?: readonly string[]
    // How an arriving id (and a held value) maps to the identity the field
    // holds. Absent means the exact-string identity of the stored value.
    wantKeyOf?: WantKeyOf
    // Names a held value in an "already in" refusal (the chip's own label).
    labelOf?: (heldValue: string) => string
    // The whole arrival as one plan, for an editor that can dispatch a group.
    onPickBatch?: (batch: PickBatch) => void
  },
): { isPicking: boolean; toggle: () => void; activate: () => void; refusal: StatusMark } {
  const multi = opts?.multi ?? false
  const onUnpick = opts?.onUnpick
  const onPickBatch = opts?.onPickBatch
  const features = opts?.features
  const validatePick = opts?.validatePick
  const held = opts?.held
  const labelOf = opts?.labelOf
  const wantKeyOf = opts?.wantKeyOf
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
    const heldValues = held ?? []
    const keyOf = wantKeyOf ?? identityWantKey()

    // One arriving batch: a click is a batch of one, a lasso is the whole boxed
    // set. A single-pick field keeps its old rule and considers only the first
    // arriving id (the rest of a box is dropped).
    const arriving = [...s.normalSelection].filter(id => !s.chipOwnedSelection.has(id))
    if (arriving.length > 0) {
      const batch = multi ? arriving : arriving.slice(0, 1)
      // The two refusal guards ride into the plan as refusals of their own, so a
      // refused id is dropped from the batch like a wrong-identity pick.
      const guardedKeyOf: WantKeyOf = (id) => {
        if (features && !isPickAllowed(id, featureId, features)) {
          return { refused: 'can only reference earlier features' }
        }
        const fieldReason = validatePick ? validatePick(id, features) : null
        return fieldReason === null ? keyOf(id) : { refused: fieldReason }
      }
      const intake = planPickIntake(batch, heldValues, guardedKeyOf, { labelOf })
      const acted = intake.add.length > 0 || intake.remove.length > 0
      const reason = intake.refused[0]
      // The refusal is a pick outcome delivered by the viewport click, and it
      // must render beside the field in this same commit; the state is the
      // hook's own last outcome, not a copy of external data.
      // eslint-disable-next-line react-hooks/set-state-in-effect -- a viewport click is the external event, and the reason must reach the field now
      setLastRefusal(reason === undefined ? null : { key: fieldKey, reason })

      if (acted) {
        if (onPickBatch) {
          onPickBatch({ add: intake.add, remove: intake.remove })
        } else {
          for (const id of intake.add) onPick(id)
          if (intake.remove.length > 0) {
            if (onUnpick) {
              for (const index of intake.remove) onUnpick(heldValues[index])
            } else {
              // The plan only removes against held values, and a consumer that
              // supplied those without a way to take one out is a wiring bug.
              failLoud(`[usePickField] '${featureId}:${field}' planned a removal but has no onUnpick or onPickBatch handler`)
            }
          }
        }
        // Both selection sets are emptied so the unstable callback identity
        // cannot re-fire this batch before the async re-solve updates `values`
        // and the chip's sync effect repopulates the survivors.
        s.clearNormalSelection()
        if (!multi) s.setActivePickField(null)
        return
      }

      // Nothing landed: consume only the ids this arrival examined, so the
      // chip's own highlight mirror survives a refusal. A single field still
      // throws away the rest of a box, as it always did.
      s.dropFromNormalSelection(arriving)
      return
    }

    // No new pick: a chip-owned id missing from normalSelection is a re-click
    // toggle-off, so remove it from the chip.
    for (const id of s.chipOwnedSelection) {
      if (s.normalSelection.has(id)) continue
      if (onPickBatch) {
        // The index is in the field's own value order, the same space the
        // widget's remove mutations use.
        const index = heldValues.indexOf(id)
        if (index < 0) {
          // A chip only mirrors the field's values, so this cannot happen; drop
          // the stranded mirror rather than leave the invariant broken.
          s.clearNormalSelection()
          return
        }
        onPickBatch({ add: [], remove: [index] })
      } else if (onUnpick) {
        onUnpick(id)
      } else {
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
      setLastRefusal(null)
      // Mirror the batch path: empty both selection sets so the unstable
      // callback identity can't re-fire this remove before the async re-solve
      // updates `values` and the chip's sync effect repopulates the survivors.
      s.clearNormalSelection()
      return
    }
  }, [normalSelection, isPicking, onPick, onUnpick, multi, features, featureId, field, fieldKey, validatePick, onPickBatch, held, wantKeyOf, labelOf])

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
