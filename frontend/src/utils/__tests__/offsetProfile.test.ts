import { describe, it, expect } from 'vitest'
import type { PartDoc, SketchFeature } from '@/types/cad'
import { applyAddOffset, applyAddEntity, applyAddRect, applyAddConstraint, applyDeleteElements } from '@/utils/yamlMutations'
import { CONSTRAINTS } from '@/registry'
import { offsetCorners, coordinateCorners, uniqueCorners, lineIntersect, parseVertexRef } from '@/utils/geometry/offsetProfile'
import { sketchAt } from '@/testing/featureAccess'

const DIMENSION_KINDS = new Set(CONSTRAINTS.filter((c) => c.category === 'dimensional').map((c) => c.kind))

function sketchDoc(): PartDoc {
  return { features: [{ id: 'sk', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

function feat(doc: PartDoc) {
  return sketchAt(doc)
}

/** Lines forming an open L: a horizontal then a vertical, sharing a coincident
 *  corner (a.end == b.start). Returns the two ids. */
function addLJoin(doc: PartDoc): [string, string] {
  applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
  applyAddEntity(doc, 'sk', 'line', [10, 0, 10, 10], 'b')
  applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:a:end', 'vertex:sk:b:start'])
  return ['a', 'b']
}

// ─── pure helpers ───

describe('parseVertexRef', () => {
  it('parses a local wire ref against the known set', () => {
    expect(parseVertexRef('$aXend', new Set(['aX']))).toEqual({ entityId: 'aX', vertexKey: 'end' })
    expect(parseVertexRef('$aXstart', new Set(['aX']))).toEqual({ entityId: 'aX', vertexKey: 'start' })
  })

  it('parses the resolved dict form', () => {
    expect(parseVertexRef({ entity: 'aX', point: 'start' }, new Set(['aX']))).toEqual({ entityId: 'aX', vertexKey: 'start' })
  })

  it('rejects refs to unknown entities or non-vertex strings', () => {
    expect(parseVertexRef('$aXend', new Set(['other']))).toBeNull()
    expect(parseVertexRef('$aX', new Set(['aX']))).toBeNull()  // entity ref, no vertex
    expect(parseVertexRef('@builtin_origin', new Set(['aX']))).toBeNull()
  })
})

describe('lineIntersect', () => {
  it('intersects two crossing lines', () => {
    expect(lineIntersect([0, 5, 10, 5], [3, 0, 3, 10])).toEqual([3, 5])
  })

  it('returns null for parallel / collinear lines', () => {
    expect(lineIntersect([0, 0, 10, 0], [0, 2, 10, 2])).toBeNull()      // parallel
    expect(lineIntersect([0, 0, 10, 0], [20, 0, 30, 0])).toBeNull()     // collinear
  })
})

describe('offsetCorners', () => {
  it('finds the one shared corner of two L-joined lines', () => {
    const doc = sketchDoc()
    const [a, b] = addLJoin(doc)
    const corners = offsetCorners([a, b], feat(doc).constraints!)
    expect(corners).toHaveLength(1)
    expect(corners[0].a).toEqual({ entityId: 'a', vertexKey: 'end' })
    expect(corners[0].b).toEqual({ entityId: 'b', vertexKey: 'start' })
  })

  it('finds no corner between unrelated lines (no coincident)', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'line', [0, 5, 10, 5], 'b')
    expect(offsetCorners(['a', 'b'], feat(doc).constraints!)).toHaveLength(0)
  })

  it('ignores corners to entities outside the selection', () => {
    const doc = sketchDoc()
    const [a] = addLJoin(doc)
    expect(offsetCorners([a], feat(doc).constraints!)).toHaveLength(0)  // b not selected
  })
})

describe('coordinateCorners', () => {
  // A hand-drawn chain has matching endpoint coordinates and no constraints.
  function chainDoc(): PartDoc {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'line', [10, 0, 10, 10], 'b')
    return doc
  }

  it('finds a coordinate-only L join and reports the touching endpoint keys', () => {
    const doc = chainDoc()
    const f = feat(doc)
    expect(f.constraints).toHaveLength(0)  // no coincident is what makes this a chain
    const corners = coordinateCorners(f.entities!, f.initial!, ['a', 'b'])
    expect(corners).toHaveLength(1)
    expect(corners[0]).toEqual({
      a: { entityId: 'a', vertexKey: 'end' },
      b: { entityId: 'b', vertexKey: 'start' },
    })
  })

  it('finds no coordinate corner when the endpoints do not touch', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'line', [10.5, 0, 10.5, 10], 'b')
    const f = feat(doc)
    expect(coordinateCorners(f.entities!, f.initial!, ['a', 'b'])).toHaveLength(0)
  })

  it('ignores endpoints of unselected entities and derives arc endpoints', () => {
    const doc = sketchDoc()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'ln')
    // Quarter arc from (10, 0) to (0, 10), centre the origin: its start is the
    // line's end by coordinate, with no constraint between them.
    applyAddEntity(doc, 'sk', 'arc', [0, 0, 10, 0, 90], 'ar')
    applyAddEntity(doc, 'sk', 'line', [0, 10, -5, 10], 'other')
    const f = feat(doc)
    expect(coordinateCorners(f.entities!, f.initial!, ['ln'])).toHaveLength(0)
    const corners = coordinateCorners(f.entities!, f.initial!, ['ln', 'ar'])
    expect(corners).toEqual([{
      a: { entityId: 'ln', vertexKey: 'end' },
      b: { entityId: 'ar', vertexKey: 'start' },
    }])
  })

  it('dedupes a joint found by both a coincident and equal coordinates', () => {
    const doc = sketchDoc()
    const [a, b] = addLJoin(doc)
    const f = feat(doc)
    const explicit = offsetCorners([a, b], f.constraints!)
    const coordinate = coordinateCorners(f.entities!, f.initial!, [a, b])
    expect(explicit).toHaveLength(1)
    expect(coordinate).toHaveLength(1)
    expect(uniqueCorners([...explicit, ...coordinate])).toHaveLength(1)
  })
})

// ─── connected offset mutation ───

describe('applyAddOffset connectivity', () => {
  it('closed rectangle reconnects all 4 corners, 0 dimensions (the disjointed-geometry regression)', () => {
    const doc = sketchDoc()
    applyAddRect(doc, 'sk', [0, 0], [10, 10])
    const f = feat(doc)
    const srcIds = f.entities!.map((e) => e.id)
    expect(srcIds).toHaveLength(4)

    applyAddOffset(doc, 'sk', srcIds, 2)
    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !srcIds.includes(id))
    expect(cloneIds).toHaveLength(4)

    // 4 parallel (one per clone) and 4 NEW coincidents among the clones.
    expect(f.constraints!.filter((c) => c.kind === 'parallel')).toHaveLength(4)
    const cloneSet = new Set(cloneIds)
    const cloneCoincidents = f.constraints!.filter(
      (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
    )
    expect(cloneCoincidents).toHaveLength(4)
    expect(f.constraints!.filter((c) => DIMENSION_KINDS.has(c.kind))).toHaveLength(0)
  })

  it('miter corner equals the offset-line intersection, not the offset of the shared vertex', () => {
    const doc = sketchDoc()
    // CCW unit-ish rectangle. lA bottom (0,0)->(10,0), lB right (10,0)->(10,10).
    applyAddRect(doc, 'sk', [0, 0], [10, 10])
    const f = feat(doc)
    const srcIds = f.entities!.map((e) => e.id)
    const lA = srcIds[0], lB = srcIds[1]
    applyAddOffset(doc, 'sk', srcIds, 2)

    // The lA/lB corner clones must meet at the miter (10-2, 0+2) = (8, 2),
    // which is NOT the offset of the corner (10, 0).
    const coin = f.constraints!.find(
      (c) =>
        c.kind === 'coincident' &&
        ((c.a as string).includes('end') || (c.b as string).includes('end')),
    )
    // Resolve the clone of lA (parallel partner of lA) and read its end vertex.
    const cloneOfA = (f.constraints!.find((c) => c.kind === 'parallel' && c.a === '$' + lA)!.b as string).slice(1)
    const cloneOfB = (f.constraints!.find((c) => c.kind === 'parallel' && c.a === '$' + lB)!.b as string).slice(1)
    const pa = f.initial![cloneOfA]  // [x0,y0,x1,y1]; end is [x1,y1]
    const pb = f.initial![cloneOfB]  // start is [x0,y0]
    expect([pa[2], pa[3]]).toEqual([8, 2])
    expect([pb[0], pb[1]]).toEqual([8, 2])
    expect(coin).toBeTruthy()
  })

  it('open chain leaves 2 free ends: N clones, N-1 corner coincidents', () => {
    const doc = sketchDoc()
    // Open 3-segment chain: a-b-c sharing 2 corners.
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'line', [10, 0, 10, 10], 'b')
    applyAddEntity(doc, 'sk', 'line', [10, 10, 20, 10], 'c')
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:a:end', 'vertex:sk:b:start'])
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:b:end', 'vertex:sk:c:start'])
    applyAddOffset(doc, 'sk', ['a', 'b', 'c'], 2)

    const f = feat(doc)
    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !['a', 'b', 'c'].includes(id))
    expect(cloneIds).toHaveLength(3)
    const cloneSet = new Set(cloneIds)
    const cloneCoincidents = f.constraints!.filter(
      (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
    )
    expect(cloneCoincidents).toHaveLength(2)  // N-1 corners
  })

  it('partial selection (3 of 4 rectangle lines) reconnects only the 2 enclosed corners', () => {
    const doc = sketchDoc()
    applyAddRect(doc, 'sk', [0, 0], [10, 10])
    const f = feat(doc)
    const srcIds = f.entities!.map((e) => e.id)
    const chosen = srcIds.slice(0, 3)  // 3 consecutive lines -> 2 interior corners
    applyAddOffset(doc, 'sk', chosen, 2)

    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !srcIds.includes(id))
    expect(cloneIds).toHaveLength(3)
    const cloneSet = new Set(cloneIds)
    const cloneCoincidents = f.constraints!.filter(
      (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
    )
    expect(cloneCoincidents).toHaveLength(2)
  })

  it('near-parallel corner leaves a gap: no coincident, no crash', () => {
    const doc = sketchDoc()
    // Two collinear segments sharing a corner; offsetting both the same way keeps
    // them collinear, so there is no miter point.
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'a')
    applyAddEntity(doc, 'sk', 'line', [10, 0, 20, 0], 'b')
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:a:end', 'vertex:sk:b:start'])
    expect(() => applyAddOffset(doc, 'sk', ['a', 'b'], 2)).not.toThrow()

    const f = feat(doc)
    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !['a', 'b'].includes(id))
    const cloneSet = new Set(cloneIds)
    const cloneCoincidents = f.constraints!.filter(
      (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
    )
    expect(cloneCoincidents).toHaveLength(0)  // gap, no reconnection
  })

  it('line+arc tangent join carries over as a tangent between the clones', () => {
    const doc = sketchDoc()
    // A line meeting an arc at a fillet corner: line.end coincident arc.start.
    // Degree slots: [-90, 0] puts the arc start exactly at (10, 0) = line.end.
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'ln')
    applyAddEntity(doc, 'sk', 'arc', [10, 5, 5, -90, 0], 'ar')
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:ln:end', 'vertex:sk:ar:start'])
    applyAddOffset(doc, 'sk', ['ln', 'ar'], 2)

    const f = feat(doc)
    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !['ln', 'ar'].includes(id))
    expect(cloneIds).toHaveLength(2)
    const cloneSet = new Set(cloneIds)
    const tangents = f.constraints!.filter(
      (c) =>
        c.kind === 'tangent' &&
        cloneSet.has((c.a as string).slice(1)) &&
        cloneSet.has((c.b as string).slice(1)),
    )
    expect(tangents).toHaveLength(1)
  })

  it('mixed line+circle: lines reconnect, the circle offsets concentric and untouched by the graph', () => {
    const doc = sketchDoc()
    const [a, b] = addLJoin(doc)
    applyAddEntity(doc, 'sk', 'circle', [50, 50, 5], 'circ')
    applyAddOffset(doc, 'sk', [a, b, 'circ'], 2)

    const f = feat(doc)
    // The two lines reconnect (one coincident among clones); the circle has a
    // concentric and no corner at all.
    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !['a', 'b', 'circ'].includes(id))
    expect(cloneIds).toHaveLength(3)
    const cloneSet = new Set(cloneIds)
    expect(
      f.constraints!.filter(
        (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
      ),
    ).toHaveLength(1)
    expect(f.constraints!.filter((c) => c.kind === 'concentric')).toHaveLength(1)
  })

  it('spline corner offsets copy-at-source and grafts NO relationship (no tangent)', () => {
    const doc = sketchDoc()
    // A line meeting a spline endpoint. Splines have no clean offset, so the clone
    // is a copy at source and the corner must NOT be reconnected (no tangent).
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'ln')
    applyAddEntity(doc, 'sk', 'spline', [10, 0, 13, 2, 16, 2, 19, 0], 'sp')
    applyAddConstraint(doc, 'sk', 'coincident', ['vertex:sk:ln:end', 'vertex:sk:sp:start'])
    applyAddOffset(doc, 'sk', ['ln', 'sp'], 2)

    const f = feat(doc)
    expect(f.constraints!.some((c) => c.kind === 'tangent')).toBe(false)
    // Spline clone is an exact copy at source.
    const spClone = f.entities!.map((e) => e.id).find((id) => !['ln', 'sp'].includes(id) && f.initial![id].length === 8)!
    expect(f.initial![spClone]).toEqual(f.initial!['sp'])
  })

  it('deleting a reconnected clone garbage-collects its corner coincident', () => {
    const doc = sketchDoc()
    const [a, b] = addLJoin(doc)
    applyAddOffset(doc, 'sk', [a, b], 2)
    const f = feat(doc)
    const cloneIds = f.entities!.map((e) => e.id).filter((id) => !['a', 'b'].includes(id))
    const cloneSet = new Set(cloneIds)
    expect(
      f.constraints!.filter(
        (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
      ),
    ).toHaveLength(1)

    // Track the coincident's id before deletion so we can verify it is removed.
    const coinId = f.constraints!.find(
      (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
    )!.id

    applyDeleteElements(doc, [`entity:sk:${cloneIds[0]}`])
    // The corner coincident referenced the deleted clone -> GC'd. Its parallel too.
    expect(f.constraints!.find((c) => c.id === coinId)).toBeUndefined()
  })
})

// A hand-drawn chain joins its endpoints by coordinate alone: no coincident
// constraints exist, so before the coordinate-corner discovery the offset clones
// translated each line's endpoints instead of mitering them and the chain stayed
// open (birdhouse F1). The rect path always joined; these chains must match it.
describe('applyAddOffset on a coordinate-only chain', () => {
  function addCoordChain(doc: PartDoc, lines: Array<[string, number[]]>): string[] {
    for (const [id, params] of lines) applyAddEntity(doc, 'sk', 'line', params, id)
    return lines.map(([id]) => id)
  }

  function cloneOfSource(f: SketchFeature, sourceId: string): string {
    const parallel = f.constraints!.find((c) => c.kind === 'parallel' && c.a === '$' + sourceId)
    return (parallel!.b as string).slice(1)
  }

  function cloneCoincidents(f: SketchFeature, sourceIds: string[]) {
    const cloneSet = new Set(f.entities!.map((e) => e.id).filter((id) => !sourceIds.includes(id)))
    return f.constraints!.filter(
      (c) => c.kind === 'coincident' && parseVertexRef(c.a, cloneSet) && parseVertexRef(c.b, cloneSet),
    )
  }

  function polygonArea(points: Array<[number, number]>): number {
    let sum = 0
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i]
      const [x1, y1] = points[(i + 1) % points.length]
      sum += x0 * y1 - x1 * y0
    }
    return Math.abs(sum) / 2
  }

  it('L-chain: mitered corner, one clone coincident, the offset lines meet', () => {
    const doc = sketchDoc()
    const srcIds = addCoordChain(doc, [
      ['a', [0, 0, 10, 0]],
      ['b', [10, 0, 10, 10]],
    ])
    applyAddOffset(doc, 'sk', srcIds, 2)
    const f = feat(doc)

    expect(f.entities!).toHaveLength(4)
    expect(cloneCoincidents(f, srcIds)).toHaveLength(1)

    // The inward offset of the corner is (8, 2), the intersection of y=2 and
    // x=8, not the offset of the shared vertex (10, 2) or (8, 0).
    const pa = f.initial![cloneOfSource(f, 'a')]
    const pb = f.initial![cloneOfSource(f, 'b')]
    expect([pa[2], pa[3]]).toEqual([8, 2])
    expect([pb[0], pb[1]]).toEqual([8, 2])
  })

  it('three-line triangle closes into the 598 mm2 ring loop (birdhouse F1)', () => {
    const doc = sketchDoc()
    const srcIds = addCoordChain(doc, [
      ['o1', [-54, 0, 54, 0]],
      ['o2', [54, 0, 0, 85]],
      ['o3', [0, 85, -54, 0]],
    ])
    applyAddOffset(doc, 'sk', srcIds, 2)
    const f = feat(doc)

    expect(f.entities!).toHaveLength(6)
    expect(cloneCoincidents(f, srcIds)).toHaveLength(3)

    // Each clone corner is the intersection of its two seeded offset lines: the
    // sample vertices the report hand-computed for the 2 mm inset triangle.
    const a = f.initial![cloneOfSource(f, 'o1')]
    const b = f.initial![cloneOfSource(f, 'o2')]
    const c = f.initial![cloneOfSource(f, 'o3')]
    expect(a[2]).toBeCloseTo(50.35994, 5)
    expect(a[3]).toBeCloseTo(2, 6)
    expect(b[0]).toBeCloseTo(50.35994, 5)
    expect(b[1]).toBeCloseTo(2, 6)
    expect(b[2]).toBeCloseTo(0, 6)
    expect(b[3]).toBeCloseTo(81.270277, 5)
    expect(c[0]).toBeCloseTo(0, 6)
    expect(c[1]).toBeCloseTo(81.270277, 5)
    expect(c[2]).toBeCloseTo(-50.35994, 5)
    expect(c[3]).toBeCloseTo(2, 6)
    expect(a[0]).toBeCloseTo(-50.35994, 5)
    expect(a[1]).toBeCloseTo(2, 6)

    const outer: Array<[number, number]> = [[-54, 0], [54, 0], [0, 85]]
    const inner: Array<[number, number]> = [
      [a[2], a[3]], [b[2], b[3]], [c[2], c[3]],
    ]
    // The extrude sees both closed loops, so the profile is the 2 mm ring:
    // 4590 - 3992.05 = 597.95 mm2, 120 thick = 71754 mm3 (report: ~598, 71760).
    expect(polygonArea(outer)).toBeCloseTo(4590, 6)
    expect(polygonArea(inner)).toBeCloseTo(3992.046, 2)
    expect(polygonArea(outer) - polygonArea(inner)).toBeCloseTo(598, 0)
  })
})
