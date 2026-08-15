import type { Mutation } from '@/types/cad'
import { ExpressionInput } from './ExpressionInput'
import type { NumberFieldWidgetProps } from './fieldTypes'
import { validateNumberFieldValue } from './numberFieldValidate'

export function NumberFieldWidget({
  field, value, arrayData, fid, onMutation, mutationType,
}: NumberFieldWidgetProps) {
  const dv = field.default ?? 0
  const isArraySplice = field.arrayField != null && field.arrayIndex != null
  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <ExpressionInput
        value={value ?? dv}
        ariaLabel={field.label}
        unit={field.unit}
        validate={(v) => validateNumberFieldValue(field, v)}
        onChange={(v) => {
          if (isArraySplice && arrayData) {
            const arr = [...arrayData]
            arr[field.arrayIndex!] = v
            onMutation({ type: mutationType, featureId: fid, field: field.arrayField!, value: arr } as Mutation)
          } else {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: v } as Mutation)
          }
        }}
      />
    </div>
  )
}