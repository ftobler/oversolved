import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature, PartConstraint } from '@/types/cad'
import { applyAddNgon, applyDeleteElements } from '@/utils/yamlMutations'
import { parseTarget } from '@/utils/yamlMutations/helpers'

// The n-gon's center is a construction circumcircle authored alongside the
// lines. The `ngon` sugar constraint owns the circle through its `circle` field
// (not a member of `refs`), and the lowering emits the coupling itself.

const FID = 'sk'
const V_OTHER = 'vertex:sk:other:end'
const PATH = 'entity:sk:curve'

function sketchDoc(): PartDoc {
  return { features: [{ id: FID, kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

const feat = (doc: PartDoc): PartFeature => doc.features![0]
const circles = (doc: PartDoc) => (feat(doc).entities ?? []).filter(e => e.kind === 'circle')
const ngonOf = (doc: PartDoc): PartConstraint => feat(doc).constraints!.find(c => c.kind === 'ngon')!
const pinnedTo = (doc: PartDoc, snapRef: string): PartConstraint[] =>
  (feat(doc).constraints ?? []).filter(c => c.kind === 'coincident' && c.b === parseTarget(snapRef, FID))

describe('applyAddNgon construction circumcircle', () => {
  it('authors one construction circle at the center with r = circumradius', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [2, 1], [5, 5], 6)
    const cs = circles(doc)
    expect(cs).toHaveLength(1)
    expect(cs[0].construction).toBe(true)
    expect(feat(doc).initial![cs[0].id]).toEqual([2, 1, 5])
    expect(feat(doc).entities!.filter(e => e.kind === 'line')).toHaveLength(6)
  })

  it('the ngon constraint names the circle outside refs, so the side count stays N', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 5)
    const ngon = ngonOf(doc)
    const circle = circles(doc)[0]
    expect(ngon.circle).toBe(parseTarget(`entity:${FID}:${circle.id}`, FID))
    expect(ngon.refs).toHaveLength(5)
    expect(ngon.refs).not.toContain(ngon.circle)
  })

  it('the coupling is lowered, not authored: only the chain and the ngon are stored', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6)
    expect(feat(doc).constraints).toHaveLength(7)
  })

  it('centerRef pins the circle center with one coincident', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6, null, V_OTHER)
    const circle = circles(doc)[0]
    const pins = pinnedTo(doc, V_OTHER)
    expect(pins).toHaveLength(1)
    expect(pins[0].a).toBe(parseTarget(`vertex:${FID}:${circle.id}:center`, FID))
  })

  it('centerRef === cornerRef on one vertex authors only the center pin', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6, V_OTHER, V_OTHER)
    const pins = pinnedTo(doc, V_OTHER)
    expect(pins).toHaveLength(1)
    expect(pins[0].a).toBe(parseTarget(`vertex:${FID}:${circles(doc)[0].id}:center`, FID))
  })

  it('centerRef and cornerRef on one curve are two statements, both pinned', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6, PATH, PATH)
    expect(pinnedTo(doc, PATH)).toHaveLength(2)
  })

  it('degenerate and non-finite input authors no circle either', () => {
    for (const [center, corner, sides] of [
      [[1, 1], [1, 1], 6],
      [[0, 0], [NaN, 0], 6],
      [[0, 0], [10, 0], NaN],
    ] as [[number, number], [number, number], number][]) {
      const doc = sketchDoc()
      applyAddNgon(doc, FID, center, corner, sides, null, V_OTHER)
      expect(feat(doc).entities).toHaveLength(0)
      expect(feat(doc).constraints).toHaveLength(0)
    }
  })
})

describe('deleting parts of a centered n-gon', () => {
  it('deleting the ngon constraint keeps the circle as a free construction circle', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6)
    applyDeleteElements(doc, [`constraint:${FID}:${ngonOf(doc).id}`])
    expect(feat(doc).constraints!.some(c => c.kind === 'ngon')).toBe(false)
    expect(circles(doc)).toHaveLength(1)
    expect(feat(doc).constraints!.filter(c => c.kind === 'coincident')).toHaveLength(6)
  })

  it('deleting the circle keeps the polygon regular and drops only the circle field', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6)
    const circle = circles(doc)[0]
    applyDeleteElements(doc, [`entity:${FID}:${circle.id}`])
    const ngon = ngonOf(doc)
    expect(ngon).toBeTruthy()
    expect(ngon.refs).toHaveLength(6)
    expect(ngon.circle).toBeUndefined()
  })

  it('deleting the circle center vertex drops the circle the same way', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6, null, V_OTHER)
    const circle = circles(doc)[0]
    applyDeleteElements(doc, [`vertex:${FID}:${circle.id}:center`])
    expect(circles(doc)).toHaveLength(0)
    expect(ngonOf(doc).circle).toBeUndefined()
    // The center pin referenced the deleted circle and is collected with it.
    expect(pinnedTo(doc, V_OTHER)).toHaveLength(0)
  })

  it('deleting a member line collects the ngon; the circle stays free', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6)
    const line = feat(doc).entities!.find(e => e.kind === 'line')!
    applyDeleteElements(doc, [`entity:${FID}:${line.id}`])
    expect(feat(doc).constraints!.some(c => c.kind === 'ngon')).toBe(false)
    expect(circles(doc)).toHaveLength(1)
  })
})
