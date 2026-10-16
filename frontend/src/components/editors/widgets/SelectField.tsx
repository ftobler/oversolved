import type { Mutation } from '@/types/cad'
import type { SelectFieldWidgetProps } from './fieldTypes'

export function SelectFieldWidget({
  field, value, data, fid, onMutation, mutationType,
}: SelectFieldWidgetProps) {
  const shown = field.valueFrom ? field.valueFrom(data) : (value ?? field.default ?? field.options[0].value)
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <select
        className="feature-field-select"
        aria-label={field.label}
        value={shown}
        onChange={(e) => {
          e.stopPropagation()
          const write = field.getMutation
            ? field.getMutation(e.target.value, data)
            : { field: field.key, value: e.target.value }
          onMutation({ type: mutationType, featureId: fid, field: write.field, value: write.value } as Mutation)
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {field.options.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </div>
  )
}
