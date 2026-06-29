import type { Mutation } from '@/types/cad'
import type { TextFieldWidgetProps } from './fieldTypes'

export function TextFieldWidget({
  field, value, fid, onMutation, mutationType,
}: TextFieldWidgetProps) {
  const dv = field.default ?? ''
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="text"
        className="feature-field-input"
        defaultValue={value ?? dv}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => {
          const parsed = field.parse ? field.parse(e.target.value) : e.target.value
          if (parsed == null) return
          if (field.validate && !field.validate(parsed)) return
          onMutation({ type: mutationType, featureId: fid, field: field.key, value: parsed } as Mutation)
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
    </div>
  )
}