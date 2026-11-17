// @vitest-environment node
//
// The mutation catalog is what an MCP client reads before it writes a document,
// so it follows the same rule as the UI: the item is a part, and the stored key
// is named where the payload keeps it. Field values stay `body`; only the prose
// changed.
import { describe, it, expect } from 'vitest'
import { mutationInfoOf } from '../mutationCatalog'
import type { Mutation } from '@/types/cad'

// The catalog (row, field) pairs that carry a whole-part value. Naming them
// explicitly keeps a same-named field elsewhere (freeze_projection.target names
// a projection) out of the rule. Each description must say part and must name
// the stored `body` vocabulary, so a client that reads "part" can still find the
// key or id prefix the payload uses.
const PART_FIELDS: Array<[string, string]> = [
  ['add_hole', 'target'],
  ['add_boolean', 'target'],
  ['add_boolean', 'tools'],
  ['add_boolean_tool', 'tool'],
  ['remove_boolean_tool', 'tool'],
  ['add_transform', 'bodies'],
  ['add_transform_body', 'bodyQuery'],
  ['add_split', 'bodies'],
  ['add_split_body', 'bodyQuery'],
  ['add_delete_body', 'bodies'],
  ['add_delete_body_ref', 'bodyQuery'],
  ['add_mirror', 'body'],
  ['add_mirror', 'target_body'],
  ['add_linear_pattern', 'source_body'],
  ['add_linear_pattern', 'target_body'],
  ['add_circular_pattern', 'source_body'],
  ['add_circular_pattern', 'target_body'],
  ['add_curve_pattern', 'source_body'],
  ['add_curve_pattern', 'target_body'],
  ['add_instance_pattern', 'source_body'],
  ['add_instance_pattern', 'target_body'],
  ['add_pattern', 'source_body'],
  ['add_pattern', 'target_body'],
  ['add_extrude', 'merge_target'],
  ['add_revolve', 'merge_target'],
  ['add_sweep', 'merge_target'],
]

function partFields(): Array<[string, string, string]> {
  return PART_FIELDS.map(([type, field]) => {
    const info = mutationInfoOf(type as Mutation['type']).fields[field]
    return [type, field, info?.note ?? '']
  })
}

describe('mutation catalog part wording', () => {
  it('describes every part field as a part and names its stored key', () => {
    const missing: string[] = []
    for (const [type, field, note] of partFields()) {
      const where = `${type}.${field}`
      if (!/\bpart/i.test(note)) missing.push(`${where}: no part word in "${note}"`)
      const stored = note.includes('`' + field + '`') || /`body(?:ies|_body)?`/.test(note)
      if (!stored) missing.push(`${where}: no stored key in "${note}"`)
    }
    expect(missing).toEqual([])
  })

  it('keeps the subject choices as the stored enum values', () => {
    // `subject` is a stored value, not a part reference: its options stay
    // `body | feature` so a client writes the value the document holds.
    expect(mutationInfoOf('add_linear_pattern').fields.subject.note).toContain('body | feature')
    expect(mutationInfoOf('add_mirror').fields.subject.note).toContain('body | feature')
  })

  it('names the part in the body-subject pick descriptions', () => {
    const pattern = mutationInfoOf('add_linear_pattern')
    expect(pattern.fields.source_body.note).toContain('part')
    expect(pattern.fields.source_body.note).toContain('source_body')
    expect(pattern.fields.target_body.note).toContain('part')
    expect(mutationInfoOf('add_mirror').fields.body.note).toContain('part (stored as `body`)')
  })
})
