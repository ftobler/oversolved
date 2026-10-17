import { useState } from 'react'
import type { Mutation } from '@/types/cad'
import type { TextFieldWidgetProps } from './fieldTypes'
import { StatusMessage } from '@/components/shared/StatusMessage'
import { fieldRefusal } from '@/utils/core/statusMark'

/** While idle the field mirrors the external `value` directly (no local copy to
 *  drift); local edit state exists only between focus and blur, so an external
 *  change (e.g. undo/redo) is picked up whenever the user isn't mid-edit.
 *
 *  A draft the field refuses (`parse` gives null, or `validate` names a reason)
 *  is a field refusal like a refused number: the reason shows while editing
 *  and the blur commits nothing. */
export function TextFieldWidget({
  field, value, fid, onMutation, mutationType,
}: TextFieldWidgetProps) {
  const dv = field.default ?? ''
  // null = idle (mirror external value); string = actively editing.
  const [draft, setDraft] = useState<string | null>(null)
  const raw = draft ?? value ?? dv

  const parsed = draft === null ? null : field.parse ? field.parse(draft) : draft
  const reason = draft === null ? null
    : parsed == null ? 'cannot be read'
    : field.validate ? field.validate(parsed) : null

  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="text"
        className={`feature-field-input${reason !== null ? ' feature-field-input--error' : ''}`}
        value={raw}
        onClick={(e) => e.stopPropagation()}
        onFocus={() => setDraft(value ?? dv)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && parsed != null && reason === null) {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: parsed } as Mutation)
          }
          setDraft(null)  // back to idle: mirror the (possibly updated) external value
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
      <StatusMessage mark={fieldRefusal('Value', reason)} />
    </div>
  )
}