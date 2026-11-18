// The editor schemas are the one place a feature field's wording lives. The
// user decision is that a part is called a part everywhere a human reads it,
// while the document keeps the `body` keys and the `'body'` enum value. This
// sweeps every visible field string at once, so a new field cannot reintroduce
// the old word even if its own editor test only checks layout.
import { describe, it, expect } from 'vitest'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'
import type { EditorFieldDef } from '@/components/editors/widgets/fieldTypes'

const STORED_WORD = /\bbod(?:y|ies)\b/i

/** Every string a field shows, from the label to a select's option labels.
 *  A function hint is computed from the form and has no static text to scan. */
function visibleStrings(field: EditorFieldDef): string[] {
  const strings = [field.label]
  if (field.type === 'pick') {
    if (field.emptyText !== undefined) strings.push(field.emptyText)
    if (field.hint !== undefined) strings.push(field.hint)
  }
  if (field.type === 'text') {
    if (field.placeholder !== undefined) strings.push(field.placeholder)
    if (field.title !== undefined) strings.push(field.title)
  }
  if (field.type === 'select') strings.push(...field.options.map(option => option.label))
  return strings
}

describe('feature editor wording', () => {
  it('calls a part a part, never a body', () => {
    const offenders: string[] = []
    for (const [kind, schema] of Object.entries(EDITOR_SCHEMAS)) {
      for (const field of schema.fields) {
        for (const text of visibleStrings(field)) {
          if (STORED_WORD.test(text)) offenders.push(`${kind}.${field.key}: "${text}"`)
        }
      }
    }
    expect(offenders).toEqual([])
  })

  it('names the whole-body pick and the subject option a part', () => {
    const transform = EDITOR_SCHEMAS.transform.fields
    expect(transform.find(field => field.key === 'bodies')?.label).toBe('Parts')

    const subject = EDITOR_SCHEMAS.mirror.fields.find(field => field.key === 'subject')
    if (subject?.type !== 'select') throw new Error('the mirror subject field must be a select')
    expect(subject.options).toEqual([{ value: 'body', label: 'Part' }, { value: 'feature', label: 'Feature' }])

    expect(EDITOR_SCHEMAS.mirror.fields.find(field => field.key === 'target_body')?.label).toBe('Target part')
  })
})
