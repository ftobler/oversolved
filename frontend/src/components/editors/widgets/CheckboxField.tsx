import type { Mutation } from '@/types/cad'
import type { CheckboxFieldWidgetProps } from './fieldTypes'

export function CheckboxFieldWidget({
  field, data, fid, onMutation, mutationType,
}: CheckboxFieldWidgetProps) {
  const checked = field.isChecked ? field.isChecked(data) : (data[field.key] ?? field.default ?? false)

  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="checkbox"
        checked={checked as boolean}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          if (field.getMutation) {
            const m = field.getMutation(e.target.checked, data)
            onMutation({ type: mutationType, featureId: fid, ...m } as Mutation)
          } else {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: e.target.checked } as Mutation)
          }
        }}
      />
    </div>
  )
}