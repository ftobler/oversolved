import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddNgon, applyAddOffset, applyAddEntity, applyDeleteElements } from '@/utils/yamlMutations'
import { round } from '@/utils/yamlMutations/helpers'
import { CONSTRAINTS } from '@/registry'

// Every constraint kind that carries a numeric dimension value. Offset must
// author NONE of these -- the user dimensions the result afterward.
const DIMENSION_KINDS = new Set(CONSTRAINTS.filter((c) => c.category === 'dimensional').map((c) => c.kind))

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
    for (const id of feat.entities!.filter((e) => e.kind === 'line').map((e) => e.id)) {
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
  it('clones a line, seeds it offset along the left normal, and adds parallel ONLY (no dimension)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]

    expect(feat.entities).toHaveLength(2)
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(dst.kind).toBe('line')
    // Seed is the source moved +5 along the left normal of start->end, i.e. +y.
    expect(feat.initial![dst.id]).toEqual([0, 5, 10, 5])
    expect(feat.initial![dst.id]).not.toEqual(feat.initial!['src'])  // NOT an exact copy

    // Exactly one relationship constraint, and NO dimension of any kind.
    expect(feat.constraints!.find((c) => c.kind === 'parallel')).toMatchObject({ a: '$src', b: '$' + dst.id })
    expect(feat.constraints!.some((c) => c.kind === 'offset')).toBe(false)
    expect(feat.constraints!.some((c) => DIMENSION_KINDS.has(c.kind))).toBe(false)
  })

  it('negative distance seeds the clone on the other side', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], -4)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(feat.initial![dst.id]).toEqual([0, -4, 10, -4])
  })

  it('clones a circle, seeds r + distance, and adds concentric ONLY (no diameter)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'circle', [0, 0, 5], 'src')
    applyAddOffset(doc, 'sk', ['src'], 3)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(feat.initial![dst.id]).toEqual([0, 0, 8])  // r = 5 + 3, center unchanged
    expect(feat.constraints!.find((c) => c.kind === 'concentric')).toMatchObject({ a: '$src', b: '$' + dst.id })
    expect(feat.constraints!.some((c) => DIMENSION_KINDS.has(c.kind))).toBe(false)
  })

  it('clones an arc, seeds r + distance keeping the angles, and adds concentric ONLY (no radius)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'arc', [0, 0, 5, 0, Math.PI], 'src')
    applyAddOffset(doc, 'sk', ['src'], 2)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(feat.initial![dst.id]).toEqual([0, 0, 7, round(0), round(Math.PI)])  // r = 5 + 2, angles preserved
    expect(feat.constraints!.find((c) => c.kind === 'concentric')).toMatchObject({ a: '$src', b: '$' + dst.id })
    expect(feat.constraints!.some((c) => DIMENSION_KINDS.has(c.kind))).toBe(false)
  })

  it('offsetting multiple sources authors ZERO dimensions (the "hilarious dimensions" regression)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'line', [10, 0, 10, 10], 'b')
    applyAddEntity(doc, 'sk', 'circle', [0, 0, 5], 'c')
    applyAddOffset(doc, 'sk', ['a', 'b', 'c'], 2)
    const feat = doc.features![0]
    expect(feat.entities).toHaveLength(6)  // 3 sources + 3 copies
    expect(feat.constraints!.filter((c) => c.kind === 'parallel')).toHaveLength(2)
    expect(feat.constraints!.filter((c) => c.kind === 'concentric')).toHaveLength(1)
    expect(feat.constraints!.filter((c) => DIMENSION_KINDS.has(c.kind))).toHaveLength(0)
  })

  it('leaves a spline copy free at source (no clean parametric offset)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'spline', [0, 0, 1, 1, 2, 1, 3, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 2)
    const feat = doc.features![0]
    expect(feat.entities).toHaveLength(2)
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(feat.initial![dst.id]).toEqual(feat.initial!['src'])  // copy at source
    expect(feat.constraints ?? []).toHaveLength(0)  // copy only, no relationship
  })

  it('skips a degenerate zero-length line (no normal direction)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [3, 3, 3, 3], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]
    expect(feat.entities).toHaveLength(1)  // no clone created
    expect(feat.constraints ?? []).toHaveLength(0)
  })

  it('deleting the copy garbage-collects its offset relationship', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!

    applyDeleteElements(doc, [`entity:sk:${dst.id}`])
    expect(feat.constraints ?? []).toHaveLength(0)  // parallel GC'd
    expect(feat.entities!.map((e) => e.id)).toEqual(['src'])
  })
})
