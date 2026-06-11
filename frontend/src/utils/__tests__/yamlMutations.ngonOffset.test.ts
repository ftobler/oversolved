import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddNgon, applyAddOffset, applyAddEntity, applyDeleteElements, applySetConstraintValue } from '@/utils/yamlMutations'

function sketchDoc(): PartDoc {
  return { features: [{ id: 'sk', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

describe('applyAddNgon', () => {
  it('creates N line entities, a closed coincident chain, and one ngon constraint', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    const feat = doc.features![0]

    const lines = feat.entities!.filter((e) => e.kind === 'line')
    expect(lines).toHaveLength(6)
    expect(feat.constraints!.filter((c) => c.kind === 'coincident')).toHaveLength(6)

    const ngons = feat.constraints!.filter((c) => c.kind === 'ngon')
    expect(ngons).toHaveLength(1)
    expect(ngons[0].refs).toHaveLength(6)
    // Every member ref is one of the created lines.
    const lineRefs = new Set(lines.map((l) => '$' + l.id))
    for (const r of ngons[0].refs!) expect(lineRefs.has(r)).toBe(true)
  })

  it('seeds the lines on the circumcircle through the corner click', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 4)
    const feat = doc.features![0]
    // First vertex sits at the corner; all vertices are radius 10 from center.
    for (const id of feat.entities!.map((e) => e.id)) {
      const p = feat.initial![id]
      expect(Math.hypot(p[0], p[1])).toBeCloseTo(10, 4)
    }
  })

  it('clamps sides below 3 up to a triangle', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, 'sk', [0, 0], [5, 0], 2)
    expect(doc.features![0].entities!.filter((e) => e.kind === 'line')).toHaveLength(3)
  })

  it('does nothing for a degenerate (zero-radius) n-gon', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, 'sk', [3, 3], [3, 3], 6)
    expect(doc.features![0].entities).toHaveLength(0)
  })
})

describe('applyAddOffset', () => {
  it('clones a line and adds parallel + an editable line_distance dimension (no stored offset value)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]

    expect(feat.entities).toHaveLength(2)
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(dst.kind).toBe('line')
    expect(feat.initial![dst.id]).toEqual(feat.initial!['src'])  // copy starts as a duplicate

    // No sugar `offset` constraint exists -- the distance is a normal dimension.
    expect(feat.constraints!.some((c) => c.kind === 'offset')).toBe(false)
    expect(feat.constraints!.find((c) => c.kind === 'parallel')).toMatchObject({ a: '$src', b: '$' + dst.id })
    const dim = feat.constraints!.find((c) => c.kind === 'line_distance')!
    expect(dim).toMatchObject({ a: '$src', b: '$' + dst.id + 'start', value: 5 })
  })

  it('clones a circle and adds concentric + a diameter dimension', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'circle', [0, 0, 5], 'src')
    applyAddOffset(doc, 'sk', ['src'], 3)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(feat.constraints!.find((c) => c.kind === 'concentric')).toMatchObject({ a: '$src', b: '$' + dst.id })
    expect(feat.constraints!.find((c) => c.kind === 'diameter')).toMatchObject({ target: '$' + dst.id, value: 16 })
  })

  it('clones an arc and adds concentric + a radius dimension', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'arc', [0, 0, 5, 0, Math.PI], 'src')
    applyAddOffset(doc, 'sk', ['src'], 2)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(feat.constraints!.find((c) => c.kind === 'concentric')).toMatchObject({ a: '$src', b: '$' + dst.id })
    expect(feat.constraints!.find((c) => c.kind === 'radius')).toMatchObject({ target: '$' + dst.id, value: 7 })
  })

  it('offsets multiple sources in one call', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'circle', [0, 0, 5], 'b')
    applyAddOffset(doc, 'sk', ['a', 'b'], 2)
    const feat = doc.features![0]
    expect(feat.entities).toHaveLength(4)  // 2 sources + 2 copies
    expect(feat.constraints!.filter((c) => c.kind === 'parallel')).toHaveLength(1)
    expect(feat.constraints!.filter((c) => c.kind === 'concentric')).toHaveLength(1)
  })

  it('leaves a spline copy free (no clean parametric offset)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'spline', [0, 0, 1, 1, 2, 1, 3, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 2)
    const feat = doc.features![0]
    expect(feat.entities).toHaveLength(2)
    expect(feat.constraints ?? []).toHaveLength(0)  // copy only
  })

  it('deleting the copy garbage-collects its offset relationship + dimension', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!

    applyDeleteElements(doc, [`entity:sk:${dst.id}`])
    expect(feat.constraints ?? []).toHaveLength(0)  // parallel + line_distance both GC'd
    expect(feat.entities!.map((e) => e.id)).toEqual(['src'])
  })

  it('the offset distance is a normal dimension the user can re-value', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]
    const dim = feat.constraints!.find((c) => c.kind === 'line_distance')!
    applySetConstraintValue(doc, 'sk', dim.id, 12)
    expect(feat.constraints!.find((c) => c.id === dim.id)!.value).toBe(12)
  })
})
