// The chamfer kind's boundary checks for the two asymmetric kinds: the new
// kind value and its two optional keys load, an unknown kind is refused by
// field, and a document that predates them is unchanged (nothing is defaulted
// into the stored payload).
import { describe, it, expect } from 'vitest'
import { loadPartDoc } from '@/persistence/docSchema'
import { featureFieldNames, featureParamsSchema } from '@/persistence/partDocSchema'
import { applySetChamferField } from '@/utils/yamlMutations/featureDefs'
import type { PartDoc } from '@/types/cad'

function doc(chamfer: unknown): Record<string, unknown> {
  return { kind: 'part', features: [{ id: 'ch1', kind: 'chamfer', chamfer }] }
}

describe('chamfer document validation', () => {
  it('accepts two_distance with distance2 and reverse and keeps the payload', () => {
    const chamfer = { edges: ['?e1'], distance: 1, kind: 'two_distance', distance2: 2, reverse: true }
    const result = loadPartDoc(doc(chamfer))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].chamfer).toEqual(chamfer)
  })

  it('accepts a reversed angle_distance chamfer', () => {
    const chamfer = { edges: ['?e1'], distance: 1, kind: 'angle_distance', angle: 30, reverse: true }
    const result = loadPartDoc(doc(chamfer))
    expect(result.ok).toBe(true)
  })

  it('refuses an unknown kind by field, listing the three values', () => {
    const result = loadPartDoc(doc({ edges: ['?e1'], distance: 1, kind: 'two_angles' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].chamfer.kind')
    for (const kind of ['distance', 'angle_distance', 'two_distance']) {
      expect(result.error.message).toContain(`"${kind}"`)
    }
  })

  it('refuses a non-boolean reverse by field', () => {
    const result = loadPartDoc(doc({ edges: ['?e1'], distance: 1, kind: 'two_distance', reverse: 1 }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.field).toBe('features[0].chamfer.reverse')
  })

  it('leaves a document without the new keys unchanged', () => {
    const chamfer = { edges: ['?e1'], distance: 1, kind: 'angle_distance', angle: 45 }
    const result = loadPartDoc(doc(chamfer))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].chamfer).toEqual(chamfer)
  })

  it('lists the fields in the part schema the MCP boundary reads', () => {
    const properties = featureParamsSchema('chamfer')?.properties as Record<string, unknown>
    expect(Object.keys(properties)).toEqual(
      expect.arrayContaining(['distance2', 'reverse']),
    )
    expect(featureFieldNames('chamfer')).toEqual(
      expect.arrayContaining(['distance2', 'reverse']),
    )
    expect(properties.kind).toEqual({ enum: ['distance', 'angle_distance', 'two_distance'] })
  })

  it('keeps a distance2 and reverse set through the editor path across save/load', () => {
    const draft = doc({ edges: ['?e1'], distance: 1, kind: 'two_distance' }) as unknown as PartDoc
    applySetChamferField(draft, 'ch1', 'distance2', 2)
    applySetChamferField(draft, 'ch1', 'reverse', true)
    const result = loadPartDoc(JSON.parse(JSON.stringify(draft)))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect((result.doc.features as Record<string, unknown>[])[0].chamfer).toEqual({
      edges: ['?e1'], distance: 1, kind: 'two_distance', distance2: 2, reverse: true,
    })
  })
})
