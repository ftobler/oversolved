// A newly added feature arms its first pick field. A part field must arm as a
// part pick, or the Parts card keeps listing the preview and a row click cannot
// feed the chip of the feature the user just added.
import { describe, it, expect } from 'vitest'
import { firstPickField } from '@/pages/firstPickField'
import { EDITOR_SCHEMAS } from '@/components/editors/featureEditorSchemas'

describe('firstPickField', () => {
  it('arms every part field as a part pick', () => {
    for (const kind of ['boolean', 'transform', 'mirror', 'split', 'delete_body']) {
      expect({ kind, names: firstPickField(kind)?.names }).toEqual({ kind, names: 'body' })
    }
  })

  it('leaves an element field without a names flag', () => {
    expect(firstPickField('extrude')).toEqual({ field: 'sketch', multi: true, names: undefined })
    expect(firstPickField('fillet')).toEqual({ field: 'edges', multi: true, names: undefined })
    expect(firstPickField('helix')).toEqual({ field: 'reference', names: undefined })
  })

  it('keeps the plane pick for a plain plane or sketch add', () => {
    expect(firstPickField('plane')).toEqual({ field: 'plane', names: undefined })
  })

  it('returns nothing for a kind with no armed field', () => {
    expect(firstPickField('variable')).toBeUndefined()
    expect(firstPickField('not_a_kind')).toBeUndefined()
  })

  it('names a field that exists in the kind\'s schema', () => {
    // The table duplicates the schema's field keys; this fails if a schema
    // renames or drops the field a kind arms first.
    for (const [kind, schema] of Object.entries(EDITOR_SCHEMAS)) {
      const firstPick = firstPickField(kind)
      if (!firstPick) continue
      const field = schema.fields.find(f => f.type === 'pick' && f.key === firstPick.field)
      expect({ kind, field: field?.type }).toEqual({ kind, field: 'pick' })
    }
  })
})
