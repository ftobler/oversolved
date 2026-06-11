import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { applyAddNgon, applyAddOffset, applyAddEntity, applyDeleteElements } from '@/utils/yamlMutations'

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
  it('clones each source entity and records an offset constraint', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]

    expect(feat.entities).toHaveLength(2)
    const dst = feat.entities!.find((e) => e.id !== 'src')!
    expect(dst.kind).toBe('line')
    // Copy starts as an exact duplicate of the source params.
    expect(feat.initial![dst.id]).toEqual(feat.initial!['src'])

    const off = feat.constraints!.find((c) => c.kind === 'offset')!
    expect(off).toMatchObject({ a: '$src', b: '$' + dst.id, value: 5 })
  })

  it('offsets multiple sources in one call', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'circle', [0, 0, 5], 'b')
    applyAddOffset(doc, 'sk', ['a', 'b'], 2)
    const feat = doc.features![0]
    expect(feat.entities).toHaveLength(4)
    expect(feat.constraints!.filter((c) => c.kind === 'offset')).toHaveLength(2)
  })

  it('deleting the copy garbage-collects its offset constraint', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]
    const dst = feat.entities!.find((e) => e.id !== 'src')!

    applyDeleteElements(doc, [`entity:sk:${dst.id}`])
    expect(feat.constraints!.some((c) => c.kind === 'offset')).toBe(false)
    expect(feat.entities!.map((e) => e.id)).toEqual(['src'])
  })

  it('breaking an offset (deleting the constraint) leaves the copy independent', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const feat = doc.features![0]
    const off = feat.constraints!.find((c) => c.kind === 'offset')!
    const dst = feat.entities!.find((e) => e.id !== 'src')!

    applyDeleteElements(doc, [`constraint:sk:${off.id}`])
    expect(feat.constraints!.some((c) => c.kind === 'offset')).toBe(false)
    expect(feat.entities!.some((e) => e.id === dst.id)).toBe(true)  // copy survives
  })
})
