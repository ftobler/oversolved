import type { Mutation } from '@/types/cad'
import type { SelectFieldWidgetProps } from './fieldTypes'

export function SelectFieldWidget({
  field, value, fid, onMutation, mutationType,
}: SelectFieldWidgetProps) {
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <select
        className="feature-field-select"
        aria-label={field.label}
        value={value ?? field.default ?? field.options[0].value}
        onChange={(e) => {
          e.stopPropagation()
          onMutation({ type: mutationType, featureId: fid, field: field.key, value: e.target.value } as Mutation)
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