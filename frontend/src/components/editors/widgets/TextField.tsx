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
  field, value, data, fid, onMutation, mutationType,
}: TextFieldWidgetProps) {
  const dv = field.default ?? ''
  // null = idle (mirror external value); string = actively editing.
  const [draft, setDraft] = useState<string | null>(null)
  // A field whose stored value is not text (the pattern's skip list) formats it
  // back to the spelling the author types, so the idle field never shows JSON.
  const external = field.format !== undefined
    ? field.format(value ?? field.default)
    : typeof value === 'string' ? value : value === undefined ? dv : String(value)
  const raw = draft ?? external

  const parsed = draft === null ? null : field.parse ? field.parse(draft) : draft
  const reason = draft === null ? null
    : parsed == null ? field.parseReason?.(draft) ?? 'cannot be read'
    : field.validate ? field.validate(parsed) : null
  const hint = field.hint?.(data ?? {}) ?? null

  return (
    <div className="feature-field-row">
      <span className="feature-field-label">{field.label}</span>
      <input
        type="text"
        className={`feature-field-input${reason !== null ? ' feature-field-input--error' : ''}`}
        value={raw}
        onClick={(e) => e.stopPropagation()}
        onFocus={() => setDraft(external)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null && parsed != null && reason === null) {
            onMutation({ type: mutationType, featureId: fid, field: field.key, value: parsed } as Mutation)
          }
          setDraft(null)  // back to idle: mirror the (possibly updated) external value
        }}
        onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); e.stopPropagation() }}
      />
      {hint !== null && hint !== '' && <span className="feature-field-hint">{hint}</span>}
      <StatusMessage mark={fieldRefusal('Value', reason)} />
    </div>
  )
}
