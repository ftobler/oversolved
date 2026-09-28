import { describe, it, expect } from 'vitest'
import type { PartDoc, PartFeature, PartConstraint } from '@/types/cad'
import { applyAddRect, applyAddCenterRect, applyAddNgon } from '@/utils/yamlMutations'
import { parseTarget } from '@/utils/yamlMutations/helpers'

// The snap refs the rect, center rect and n-gon draw tools carry to the doc
// writer: each one must become a coincident on the vertex that sits where the
// user clicked, found here by coordinate rather than by trusting line order.

const FID = 'sk'
const V_OTHER = 'vertex:sk:other:end'
const V_OTHER2 = 'vertex:sk:other2:start'
const PATH = 'entity:sk:curve'

function sketchDoc(): PartDoc {
  return { features: [{ id: FID, kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

const feat = (doc: PartDoc): PartFeature => doc.features![0]
const coincidents = (doc: PartDoc): PartConstraint[] =>
  (feat(doc).constraints ?? []).filter(c => c.kind === 'coincident')

// Every wire ref of a line vertex authored at `at`.
function lineVertexRefsAt(doc: PartDoc, at: [number, number]): string[] {
  const refs: string[] = []
  const f = feat(doc)
  for (const e of f.entities ?? []) {
    if (e.kind !== 'line') continue
    const p = f.initial![e.id]
    const ends: [string, number, number][] = [['start', p[0], p[1]], ['end', p[2], p[3]]]
    for (const [key, x, y] of ends) {
      if (Math.abs(x - at[0]) < 1e-6 && Math.abs(y - at[1]) < 1e-6) {
        refs.push(parseTarget(`vertex:${FID}:${e.id}:${key}`, FID) as string)
      }
    }
  }
  return refs
}

// The coincidents that pin something to `snapRef` (the second operand).
const pinnedTo = (doc: PartDoc, snapRef: string): PartConstraint[] =>
  coincidents(doc).filter(c => c.b === parseTarget(snapRef, FID))

describe('applyAddRect snap refs', () => {
  it('pins the p0 and p1 corners to their refs', () => {
    const doc = sketchDoc()
    applyAddRect(doc, FID, [1, 2], [6, 5], V_OTHER, PATH)
    const p0 = pinnedTo(doc, V_OTHER)
    const p1 = pinnedTo(doc, PATH)
    expect(p0).toHaveLength(1)
    expect(p1).toHaveLength(1)
    expect(lineVertexRefsAt(doc, [1, 2])).toContain(p0[0].a)
    expect(lineVertexRefsAt(doc, [6, 5])).toContain(p1[0].a)
  })

  it('authors only the first when both refs are the same vertex', () => {
    const doc = sketchDoc()
    applyAddRect(doc, FID, [1, 2], [6, 5], V_OTHER, V_OTHER)
    const pins = pinnedTo(doc, V_OTHER)
    expect(pins).toHaveLength(1)
    expect(lineVertexRefsAt(doc, [1, 2])).toContain(pins[0].a)
  })

  it('pins both corners when both refs are the same curve', () => {
    // Two different points on one curve are two independent statements.
    const doc = sketchDoc()
    applyAddRect(doc, FID, [1, 2], [6, 5], PATH, PATH)
    const pins = pinnedTo(doc, PATH)
    expect(pins).toHaveLength(2)
    expect(lineVertexRefsAt(doc, [1, 2])).toContain(pins[0].a)
    expect(lineVertexRefsAt(doc, [6, 5])).toContain(pins[1].a)
  })

  it('without refs authors exactly the plain rectangle constraints', () => {
    const plain = sketchDoc()
    applyAddRect(plain, FID, [1, 2], [6, 5])
    const nulled = sketchDoc()
    applyAddRect(nulled, FID, [1, 2], [6, 5], null, null)
    expect(feat(plain).constraints).toHaveLength(8)
    expect(feat(nulled).constraints).toHaveLength(8)
  })
})

describe('applyAddCenterRect snap refs', () => {
  it('pins the center point and the corner to their refs', () => {
    const doc = sketchDoc()
    applyAddCenterRect(doc, FID, [0, 0], [3, 2], V_OTHER, V_OTHER2)
    const point = feat(doc).entities!.find(e => e.kind === 'point')!
    const center = pinnedTo(doc, V_OTHER)
    expect(center).toHaveLength(1)
    expect(center[0].a).toBe(parseTarget(`vertex:${FID}:${point.id}:xy`, FID))
    const corner = pinnedTo(doc, V_OTHER2)
    expect(corner).toHaveLength(1)
    expect(lineVertexRefsAt(doc, [3, 2])).toContain(corner[0].a)
  })

  it('authors only the center pin when both refs are the same vertex', () => {
    const doc = sketchDoc()
    applyAddCenterRect(doc, FID, [0, 0], [3, 2], V_OTHER, V_OTHER)
    expect(pinnedTo(doc, V_OTHER)).toHaveLength(1)
  })

  it('pins the center and the corner when both refs are the same curve', () => {
    const doc = sketchDoc()
    applyAddCenterRect(doc, FID, [0, 0], [3, 2], PATH, PATH)
    expect(pinnedTo(doc, PATH)).toHaveLength(2)
  })

  it('without refs authors exactly the plain center rectangle constraints', () => {
    const doc = sketchDoc()
    applyAddCenterRect(doc, FID, [0, 0], [3, 2])
    expect(feat(doc).constraints).toHaveLength(10)
  })
})

describe('applyAddNgon snap refs', () => {
  it('pins the first line start (the corner click) to cornerRef', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6, V_OTHER)
    const pins = pinnedTo(doc, V_OTHER)
    expect(pins).toHaveLength(1)
    const first = feat(doc).entities![0]
    expect(pins[0].a).toBe(parseTarget(`vertex:${FID}:${first.id}:start`, FID))
    expect(lineVertexRefsAt(doc, [10, 0])).toContain(pins[0].a)
  })

  it('without a ref authors exactly the plain n-gon constraints', () => {
    const doc = sketchDoc()
    applyAddNgon(doc, FID, [0, 0], [10, 0], 6)
    expect(feat(doc).constraints).toHaveLength(7)
  })
})
