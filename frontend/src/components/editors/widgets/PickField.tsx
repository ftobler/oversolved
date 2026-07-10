import type { Mutation } from '@/types/cad'
import { PickChip } from '@/components/sketch/PickChip'
import { usePickField } from '@/hooks/usePickField'
import type { PickFieldWidgetProps } from './fieldTypes'

export function PickFieldWidget({
  field, data, fid, onMutation, mutationPrefix, features, partLabels,
}: PickFieldWidgetProps) {
  const isMulti = field.multi ?? false
  const rawValues: unknown = data[field.key]

  const pickCallback = (selectionId: string) => {
    if (field.validatePick && !field.validatePick(selectionId)) return
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

  // Re-clicking an already-picked element should remove it. The chip stores the
  // transformed value, so map the toggled-off selectionId back to its index.
  const unpickCallback = (selectionId: string) => {
    const index = normalizedValues.indexOf(selectionId)
    if (index >= 0) removeAt(index)
  }

  const pickState = usePickField(fid, field.key, pickCallback, { multi: isMulti, onUnpick: unpickCallback, features })

  return (
    <div className="feature-field-row feature-field-row--stacked">
      <span className="feature-field-label">{field.label}</span>
      <PickChip
        values={normalizedValues}
        isPicking={pickState.isPicking}
        onActivate={pickState.toggle}
        onRemove={removeAt}
        onReorder={isMulti
          ? (from, to) => onMutation({ type: 'reorder_pick_field', featureId: fid, field: field.key, fromIndex: from, toIndex: to } as Mutation)
          : undefined
        }
        emptyText={field.emptyText}
        features={features}
        partLabels={partLabels}
      />
    </div>
  )
}