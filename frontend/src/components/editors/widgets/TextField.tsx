import { useState } from 'react'
import type { Mutation } from '@/types/cad'
import type { TextFieldWidgetProps } from './fieldTypes'

/** While idle the field mirrors the external `value` directly (no local copy to
 *  drift); local edit state exists only between focus and blur, so an external
 *  change (e.g. undo/redo) is picked up whenever the user isn't mid-edit. */
export function TextFieldWidget({
  field, value, fid, onMutation, mutationType,
}: TextFieldWidgetProps) {
  const dv = field.default ?? ''
  // null = idle (mirror external value); string = actively editing.
  const [draft, setDraft] = useState<string | null>(null)
  const raw = draft ?? value ?? dv

  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="text"
        className="feature-field-input"
        value={raw}
        onClick={(e) => e.stopPropagation()}
        onFocus={() => setDraft(value ?? dv)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          const parsed = field.parse ? field.parse(e.target.value) : e.target.value
          if (parsed != null && (!field.validate || field.validate(parsed))) {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: parsed } as Mutation)
          }
          setDraft(null)  // back to idle: mirror the (possibly updated) external value
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
    </div>
  )
}