// @vitest-environment node
//
// The split feature over the drive surface: the Ex021 practice script in one
// `run` (sketch, extrude, plane, split), the boundary refusals with their fixes,
// and the catalog/schema presence an MCP caller reads. Real kernel where
// provisioned.

import { describe, it, expect } from 'vitest'
import { emptyDriveDoc } from '../headlessOps'
import { mutationInfoOf, validateMutation } from '../mutationCatalog'
import { PART_DOC_SCHEMA_JSON } from '@/persistence/partDocSchema'

describe('the split mutation catalog', () => {
  it('lists the four mutations', () => {
    for (const type of ['add_split', 'set_split_field', 'add_split_body', 'remove_split_body'] as const) {
      expect(mutationInfoOf(type).summary.length).toBeGreaterThan(0)
    }
  })

  it('states the side rule on add_split and set_split_field', () => {
    for (const type of ['add_split', 'set_split_field'] as const) {
      const note = mutationInfoOf(type).note ?? ''
      expect(note, type).toContain('above')
      expect(note, type).toContain('below')
      expect(note, type).toContain('both')
      expect(note, type).toContain('OUTWARD')
    }
  })

  it('publishes split in the part-document schema', () => {
    expect(PART_DOC_SCHEMA_JSON).toContain('"split"')
    expect(PART_DOC_SCHEMA_JSON).toContain('"above"')
  })
})
describe('split boundary refusals', () => {
  function refusal(raw: Record<string, unknown>): string {
    // A document lets the plane check name the valid planes; without one the
    // boundary can only judge the value's shape.
    const result = validateMutation(raw, { doc: emptyDriveDoc() })
    if (result.ok) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`)
    return result.error.message
  }

  it('refuses an unknown keep side, listing the three values', () => {
    const message = refusal({ type: 'add_split', featureId: 'sp1', keep: 'top' })
    expect(message).toContain('"above"')
    expect(message).toContain('"below"')
    expect(message).toContain('"both"')
  })

  it('refuses a plane name that is not a plane, listing the valid ones', () => {
    const message = refusal({ type: 'add_split', featureId: 'sp1', plane: 'top' })
    expect(message).toContain('@builtin_plane_top')
    expect(message).toContain('case-sensitive')
  })

  it('refuses bodies that are not a list', () => {
    expect(refusal({ type: 'add_split', featureId: 'sp1', bodies: '@ex1' })).toContain('bodies')
  })

  it('refuses an unknown set_split_field field', () => {
    expect(refusal({ type: 'set_split_field', featureId: 'sp1', field: 'side', value: 'above' }))
      .toContain('side')
  })
})
