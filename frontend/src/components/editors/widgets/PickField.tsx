import type { Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/usePickField'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useNotifySafe } from '@/contexts/ToastContext'
import type { PickFieldWidgetProps } from './fieldTypes'

export function PickFieldWidget({
  field, data, fid, onMutation, mutationPrefix, features, partLabels,
}: PickFieldWidgetProps) {
  const isMulti = field.multi ?? false
  const rawValues: unknown = data[field.key]
  const notify = useNotifySafe()

  const pickCallback = (selectionId: string) => {
    if (field.validatePick && !field.validatePick(selectionId)) {
      // A refused pick must not vanish silently: the fillet/chamfer edge gate
      // only accepts `?` queries, so a topo-fallback edge (no named query)
      // de-highlights with nothing added. Surface the reason instead.
      notify('Pick refused: this edge has no named query', 'warning')
      return
    }
    const transformed = field.transform ? field.transform(selectionId) : selectionId

    if (isMulti) {
      const addType = field.addMutationType ?? `add_${mutationPrefix}_${field.key}`
      const valueKey = field.addValueKey ?? field.key
      onMutation({ type: addType, featureId: fid, [valueKey]: transformed } as Mutation)
    } else {
      onMutation({ type: `${mutationPrefix}_field`, featureId: fid, field: field.key, value: transformed } as Mutation)
    }
  }

  const removeMutationType = isMulti
    ? (field.removeMutationType ?? `remove_${mutationPrefix}_${field.key}`)
    : `${mutationPrefix}_field`

  const normalizedValues: string[] = field.normalize
    ? (field.normalize(rawValues) as string[])
    : Array.isArray(rawValues) ? rawValues as string[] : (rawValues ? [rawValues as string] : [])

  const removeAt = (index: number) => {
    if (isMulti) {
      const key = field.removeKey ?? 'index'
      const val = field.removeValueIsIndex === false ? normalizedValues[index] : index
      onMutation({ type: removeMutationType, featureId: fid, [key]: val } as Mutation)
    } else {
      onMutation({ type: removeMutationType, featureId: fid, field: field.key, value: (field.removeValue ?? '') } as Mutation)
    }
  }

  // Removing a chip arms the field so the user can immediately re-pick the
  // value they just took out (a stale chamfer edge, say) instead of having to
  // click the chip again. The unpick (viewport re-click) path keeps plain
  // removeAt: there the user is already in picking mode.
  const removeAndActivate = (index: number) => {
    removeAt(index)
    activate()
  }

  // Re-clicking an already-picked element should remove it. The chip stores the
  // transformed value, so map the toggled-off selectionId back to its index.
  const unpickCallback = (selectionId: string) => {
    const index = normalizedValues.indexOf(selectionId)
    if (index >= 0) removeAt(index)
  }

  const pickState = usePickField(fid, field.key, pickCallback, { multi: isMulti, onUnpick: unpickCallback, features })
  const { toggle, activate } = pickState

  // The feature's last solve splits the picks that did not apply into two kinds
  // (kernel partial result): `unresolved_edges` matched no current edge (stale,
  // shown struck through -- re-picking is the fix) and `failed_edges` resolved
  // but the modifier refused/skipped them (shown red -- the parameter or
  // geometry is the fix). Values added since the solve simply are not in either
  // set and stay neutral.
  const solveResult = usePartEditorStore(s => s.solveResults?.[fid])
  const edgeSet = (key: string): ReadonlySet<string> | undefined => {
    if (typeof solveResult !== 'object' || solveResult === null) return undefined
    const raw = (solveResult as Record<string, unknown>)[key]
    return Array.isArray(raw) && raw.length > 0 ? new Set(raw as string[]) : undefined
  }
  const unresolvedValues = edgeSet('unresolved_edges')
  const failedValues = edgeSet('failed_edges')

  return (
    <div className="feature-field-row feature-field-row--stacked">
      <span className="feature-field-label">{field.label}</span>
      <PickChip
        values={normalizedValues}
        isPicking={pickState.isPicking}
        onActivate={toggle}
        onRemove={removeAndActivate}
        onReorder={isMulti
          ? (from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: field.key, fromIndex: from, toIndex: to } as Mutation)
          : undefined
        }
        emptyText={field.emptyText}
        features={features}
        partLabels={partLabels}
        unresolvedValues={unresolvedValues}
        failedValues={failedValues}
      />
    </div>
  )
}