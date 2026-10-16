// The hole editor's cosmetic-thread controls: the checkbox writes (and clears)
// the whole spec, the select writes the table entry it names, and neither ever
// writes a field of its own into the document. The diameter field stays the
// user's own number: a thread is metadata, so picking one does not silently
// resize the bore.
import { describe, it, expect } from 'vitest'
import { HOLE_SCHEMA } from '@/components/editors/featureEditorSchemas'
import type { CheckboxFieldDef, SelectFieldDef } from '@/components/editors/widgets/fieldTypes'

const threadCheckbox = (): CheckboxFieldDef => {
  const field = HOLE_SCHEMA.fields.find((f) => f.type === 'checkbox' && f.key === '_threaded')
  if (!field || field.type !== 'checkbox') throw new Error('no thread checkbox')
  return field
}

const threadSelect = (): SelectFieldDef => {
  const field = HOLE_SCHEMA.fields.find((f) => f.type === 'select' && f.key === '_thread_designation')
  if (!field || field.type !== 'select') throw new Error('no thread designation select')
  return field
}

describe('the hole schema thread controls', () => {
  it('checks the box from the stored spec, never from its own key', () => {
    const box = threadCheckbox()
    expect(box.isChecked!({ thread: { designation: 'M6x1', nominal: 6, pitch: 1 } })).toBe(true)
    expect(box.isChecked!({})).toBe(false)
    expect(box.isChecked!({ _threaded: true })).toBe(false)
  })

  it('writes the whole table spec when checked, and clears it when not', () => {
    const box = threadCheckbox()
    expect(box.getMutation!(true, {})).toEqual({
      field: 'thread', value: { designation: 'M2x0.4', nominal: 2, pitch: 0.4 },
    })
    expect(box.getMutation!(true, { _thread_designation: 'M8x1.25' })).toEqual({
      field: 'thread', value: { designation: 'M8x1.25', nominal: 8, pitch: 1.25 },
    })
    expect(box.getMutation!(false, { _thread_designation: 'M8x1.25' })).toEqual({ field: 'thread', value: null })
  })

  it('offers every table designation, labelled with its drill', () => {
    const select = threadSelect()
    expect(select.options.map((o) => o.value)).toContain('M6x1')
    expect(select.options.find((o) => o.value === 'M6x1')!.label).toBe('M6x1 (drill 5)')
  })

  it('shows the stored designation and writes the selected one', () => {
    const select = threadSelect()
    expect(select.valueFrom!({ thread: { designation: 'M10x1.5', nominal: 10, pitch: 1.5 } })).toBe('M10x1.5')
    expect(select.valueFrom!({})).toBe('M2x0.4')
    expect(select.getMutation!('M10x1.5', {})).toEqual({
      field: 'thread', value: { designation: 'M10x1.5', nominal: 10, pitch: 1.5 },
    })
  })

  it('keeps the diameter field out of the thread write', () => {
    // The thread controls only ever name 'thread': the bore is the authored
    // diameter, and picking M6x1 next to a 5 mm bore must not rewrite it.
    const spec = threadCheckbox().getMutation!(true, {}) as { field: string }
    expect(spec.field).toBe('thread')
    expect(threadSelect().getMutation!('M6x1', {})).toMatchObject({ field: 'thread' })
  })
})
