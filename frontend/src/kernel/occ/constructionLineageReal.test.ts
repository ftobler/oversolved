// @vitest-environment node
//
// Gated real-OCC tests for the split-sibling ordering keys
// (construction-order-stability.md):
//   - `faceSplitKey` resize/translation behaviour (its first unit tests),
//   - the shared `shapeNormalFrame` + `normalizedWorldKey` scheme: a uniform
//     rescale leaves the keys byte-identical, so a near-tie refusal is
//     scale-invariant (raw world keys are not -- the bug this fixes),
//   - edge multiplicity on a real face pair sharing 2 edges (a cut half
//     cylinder): both edges stay named and order-stable across a uniform
//     rescale, and both go UNNAMED when a parametric edit pushes them into a
//     near-tie -- never a silent swap.
//
// Skips when opencascade.js is absent, like the other real-OCC gates.

import { describe, it, expect } from 'vitest'
import { loadOcc } from './loadOcc'
import { DisposeScope } from './disposeScope'
import {
  makeBoxAt,
  makeCylinder,
  makeArcEdge,
  makeEllipseEdge,
  faceCentroid,
  faceNormal,
  edgeToGeom,
} from './primitives'
import { booleanWithDiff } from './booleans'
import { transformCopy, makeScaleTrsf } from './transforms'
import { faceGh, edgeGh } from './lineageHash'
import {
  faceSplitKey,
  shapeNormalFrame,
  normalizedWorldKey,
  edgeMidpoint,
  deriveEdgeNames,
  FaceEdgeTable,
} from './constructionLineage'
import { orderSplitChildren } from '../constructionName'
import type { OccShape, OccSubShape } from './occTypes'
import { SPLIT_EPS } from '../constructionName'

const loadedOcc = await loadOcc()
const hasOcc = loadedOcc !== null
const oc = loadedOcc!

/** The bottom (z=0, normal -z) face of an axis-aligned box. */
function bottomFace(scope: DisposeScope, box: OccShape): OccShape {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(box, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const f = scope.track(oc.TopoDS.Face_1(exp.Current()))
    const n = faceNormal(oc, scope, f)
    if (Math.abs(n[2] + 1) < 1e-6) return f
  }
  throw new Error('no bottom face found')
}

/** Assign every face a name keyed by sorted centroid, so two uniform rescales
 *  of the same shape map the same physical face to the same name. */
function nameFacesByGeometry(scope: DisposeScope, shape: OccShape): {
  faceNames: Record<string, string>
  faceAncestry: Record<string, string[]>
} {
  const E = oc.TopAbs_ShapeEnum
  const faces: { gh: string; c: number[] }[] = []
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const f = scope.track(oc.TopoDS.Face_1(exp.Current()))
    faces.push({ gh: faceGh(oc, scope, f), c: faceCentroid(oc, scope, f) })
  }
  faces.sort((a, b) => a.c[0] - b.c[0] || a.c[1] - b.c[1] || a.c[2] - b.c[2])
  const faceNames: Record<string, string> = {}
  const faceAncestry: Record<string, string[]> = {}
  faces.forEach((f, i) => {
    faceNames[f.gh] = `u_f${i}`
    faceAncestry[`u_f${i}`] = [`@anc${i}`]
  })
  return { faceNames, faceAncestry }
}

/** A face pair sharing exactly 2 edges, keyed by midpoint x sign. Returns the
 *  pair's two edge ghs and their deriveEdgeNames UUIDs (undefined = unnamed). */
function multiplicityPair(
  scope: DisposeScope,
  shape: OccShape,
  faceNames: Record<string, string>,
  edgeNames: Record<string, string>,
): { leftGh: string; rightGh: string; leftUuid?: string; rightUuid?: string } | null {
  const E = oc.TopAbs_ShapeEnum
  const adj: Record<string, string[]> = {}  // edge gh -> adjacent face uuids
  const mid: Record<string, number> = {}  // edge gh -> midpoint x
  const fexp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  for (; fexp.More(); fexp.Next()) {
    const f = scope.track(oc.TopoDS.Face_1(fexp.Current()))
    const fu = faceNames[faceGh(oc, scope, f)]
    if (!fu) continue
    const eexp = scope.track(new oc.TopExp_Explorer_2(f, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    for (; eexp.More(); eexp.Next()) {
      const e = scope.track(oc.TopoDS.Edge_1(eexp.Current()))
      const gh = edgeGh(oc, scope, e)
      if (gh === null) continue
      if (!adj[gh]) adj[gh] = []
      if (!adj[gh].includes(fu)) adj[gh].push(fu)
      const { ed } = edgeToGeom(oc, scope, e)
      const s = (ed as { start?: number[] }).start
      const end = (ed as { end?: number[] }).end
      const c = (ed as { center?: number[] }).center
      const mx = s && end ? (s[0] + end[0]) / 2 : c ? c[0] : 0
      mid[gh] ??= mx
    }
  }
  const byPair: Record<string, string[]> = {}
  for (const [gh, set] of Object.entries(adj)) {
    if (set.length === 2) {
      const k = [...set].sort().join('|')
      ;(byPair[k] ??= []).push(gh)
    }
  }
  for (const eghs of Object.values(byPair)) {
    if (eghs.length === 2) {
      const sorted = [...eghs].sort((x, y) => mid[x] - mid[y])
      return {
        leftGh: sorted[0],
        rightGh: sorted[1],
        leftUuid: edgeNames[sorted[0]],
        rightUuid: edgeNames[sorted[1]],
      }
    }
  }
  return null
}

describe.skipIf(!hasOcc)('faceSplitKey (parent-frame split ordering)', () => {
  it('uniform resize of the parent leaves the key unchanged', () => {
    const scope = new DisposeScope()
    try {
      const parent = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10))
      const child = bottomFace(scope, makeBoxAt(oc, scope, [2, 2, 0], 4, 4, 10))
      const big = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 20, 20, 20))
      const bigChild = bottomFace(scope, makeBoxAt(oc, scope, [4, 4, 0], 8, 8, 20))
      const k1 = faceSplitKey(oc, scope, parent, child)
      const k2 = faceSplitKey(oc, scope, big, bigChild)
      expect(k1.length).toBe(2)
      for (let i = 0; i < 2; i++) expect(k2[i]).toBeCloseTo(k1[i], 9)
    } finally {
      scope.dispose()
    }
  })

  it('a translation of the parent cancels', () => {
    const scope = new DisposeScope()
    try {
      const parent = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10))
      const child = bottomFace(scope, makeBoxAt(oc, scope, [2, 2, 0], 4, 4, 10))
      const moved = bottomFace(scope, makeBoxAt(oc, scope, [7, 3, 9], 10, 10, 10))
      const movedChild = bottomFace(scope, makeBoxAt(oc, scope, [9, 5, 9], 4, 4, 10))
      const k1 = faceSplitKey(oc, scope, parent, child)
      const k2 = faceSplitKey(oc, scope, moved, movedChild)
      for (let i = 0; i < 2; i++) expect(k2[i]).toBeCloseTo(k1[i], 9)
    } finally {
      scope.dispose()
    }
  })

  it('a non-uniform resize changes the key, but bounded by the parent scale', () => {
    const scope = new DisposeScope()
    try {
      const parent = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10))
      const child = bottomFace(scope, makeBoxAt(oc, scope, [2, 2, 0], 4, 4, 10))
      // Stretch x only: the u component follows the stretch while the frame
      // scale only grows as sqrt(2), so the key moves -- but stays O(1), never
      // becoming the ~0 distance that would silently tie two distinct siblings.
      const sx = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 20, 10, 10))
      const sxChild = bottomFace(scope, makeBoxAt(oc, scope, [4, 2, 0], 8, 4, 10))
      const k1 = faceSplitKey(oc, scope, parent, child)
      const k2 = faceSplitKey(oc, scope, sx, sxChild)
      expect(Math.abs(k2[0] - k1[0])).toBeGreaterThan(1e-6)  // it really changed
      for (let i = 0; i < 2; i++) expect(Math.abs(k2[i] - k1[i])).toBeLessThan(1.0)
    } finally {
      scope.dispose()
    }
  })

  it('keys are dimensionless (sqrt area is the unit)', () => {
    // The child centroid offset is projected and divided by sqrt(parent area),
    // so the key has no world units: a 1mm offset on a 10x10 face reads the
    // same as a 10mm offset on a 100x100 face.
    const scope = new DisposeScope()
    try {
      const small = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10))
      const smallChild = bottomFace(scope, makeBoxAt(oc, scope, [4.5, 4.5, 0], 1, 1, 10))
      const big = bottomFace(scope, makeBoxAt(oc, scope, [0, 0, 0], 100, 100, 100))
      const bigChild = bottomFace(scope, makeBoxAt(oc, scope, [45, 45, 0], 10, 10, 100))
      const k1 = faceSplitKey(oc, scope, small, smallChild)
      const k2 = faceSplitKey(oc, scope, big, bigChild)
      for (let i = 0; i < 2; i++) expect(k2[i]).toBeCloseTo(k1[i], 9)
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!hasOcc)('normalizedWorldKey (shared edge/vertex/corner frame)', () => {
  it('a uniform rescale produces identical keys', () => {
    const scope = new DisposeScope()
    try {
      const frame10 = shapeNormalFrame(oc, scope, makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10))
      const frame20 = shapeNormalFrame(oc, scope, makeBoxAt(oc, scope, [0, 0, 0], 20, 20, 20))
      expect(frame10.span).toBe(10)
      expect(frame20.span).toBe(20)
      const p1 = [1, 2, 3]
      const p2 = [4, 2, 3]
      const a = normalizedWorldKey(frame10, p1)
      const b = normalizedWorldKey(frame10, p2)
      const a2 = normalizedWorldKey(frame20, [2, 4, 6])
      const b2 = normalizedWorldKey(frame20, [8, 4, 6])
      for (let i = 0; i < 3; i++) {
        expect(a2[i]).toBeCloseTo(a[i], 9)
        expect(b2[i]).toBeCloseTo(b[i], 9)
      }
    } finally {
      scope.dispose()
    }
  })

  it('raw world keys refuse inconsistently across a rescale; normalized keys agree', () => {
    // Same RELATIVE separation (5e-4 of the parent span) in a 1-unit and a
    // 100-unit box. Raw world keys refuse in the small box (5e-4 < SPLIT_EPS)
    // and order in the big one (0.05 > SPLIT_EPS) -- the absolute-epsilon bug.
    // Normalized keys refuse in BOTH, which is the consistent answer.
    const scope = new DisposeScope()
    try {
      const small = shapeNormalFrame(oc, scope, makeBoxAt(oc, scope, [0, 0, 0], 1, 1, 1))
      const big = shapeNormalFrame(oc, scope, makeBoxAt(oc, scope, [0, 0, 0], 100, 100, 100))
      expect(small.span).toBe(1)
      expect(big.span).toBe(100)

      const rawSmall = [{ item: 'a', key: [0.5] }, { item: 'b', key: [0.5 + 5e-4] }]
      const rawBig = [{ item: 'a', key: [50] }, { item: 'b', key: [50 + 5e-2] }]
      expect(orderSplitChildren(rawSmall)).toBeNull()
      expect(orderSplitChildren(rawBig)).toEqual(['a', 'b'])

      const normSmall = [
        { item: 'a', key: normalizedWorldKey(small, [0.5, 0.5, 0.5]) },
        { item: 'b', key: normalizedWorldKey(small, [0.5 + 5e-4, 0.5, 0.5]) },
      ]
      const normBig = [
        { item: 'a', key: normalizedWorldKey(big, [50, 50, 50]) },
        { item: 'b', key: normalizedWorldKey(big, [50 + 5e-2, 50, 50]) },
      ]
      expect(orderSplitChildren(normSmall)).toBeNull()
      expect(orderSplitChildren(normBig)).toBeNull()
    } finally {
      scope.dispose()
    }
  })

  it('a uniform rescale does not flip two close but distinguishable siblings', () => {
    const scope = new DisposeScope()
    try {
      const frame10 = shapeNormalFrame(oc, scope, makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10))
      const frame20 = shapeNormalFrame(oc, scope, makeBoxAt(oc, scope, [0, 0, 0], 20, 20, 20))
      // 0.05 world units apart in the 10-box: normalized 0.005 (> SPLIT_EPS),
      // so the order is unambiguous and must survive a 2x uniform rescale.
      const c10 = [
        { item: 'left', key: normalizedWorldKey(frame10, [4.0, 5, 5]) },
        { item: 'right', key: normalizedWorldKey(frame10, [4.05, 5, 5]) },
      ]
      const c20 = [
        { item: 'left', key: normalizedWorldKey(frame20, [8.0, 10, 10]) },
        { item: 'right', key: normalizedWorldKey(frame20, [8.1, 10, 10]) },
      ]
      expect(orderSplitChildren(c10)).toEqual(['left', 'right'])
      expect(orderSplitChildren(c20)).toEqual(['left', 'right'])
      expect(SPLIT_EPS).toBeGreaterThan(0)
      expect(SPLIT_EPS).toBeLessThan(1)
    } finally {
      scope.dispose()
    }
  })
})

describe.skipIf(!hasOcc)('edge multiplicity: a face pair sharing 2 edges', () => {
  function halfCylinder(scope: DisposeScope, radius: number): OccShape {
    const cyl = makeCylinder(oc, scope, [0, 0, 0], [0, 0, 1], radius, 10)
    const cut = makeBoxAt(oc, scope, [-6, 0, -6], 12, 6, 12)
    return booleanWithDiff(oc, scope, cyl, cut, 'cut').shape
  }

  it('both edges of the pair are named and keep their order across a uniform rescale', () => {
    const s1 = new DisposeScope()
    const s2 = new DisposeScope()
    try {
      const half = halfCylinder(s1, 5)
      const n1 = nameFacesByGeometry(s1, half)
      const e1 = deriveEdgeNames(oc, s1, half, n1.faceNames, n1.faceAncestry).edgeNames
      const p1 = multiplicityPair(s1, half, n1.faceNames, e1)
      expect(p1).not.toBeNull()
      expect(p1!.leftUuid).toBeDefined()
      expect(p1!.rightUuid).toBeDefined()
      expect(p1!.leftUuid).not.toBe(p1!.rightUuid)

      const scaled = transformCopy(oc, s2, half, makeScaleTrsf(oc, s2, [0, 0, 0], 2))
      const n2 = nameFacesByGeometry(s2, scaled)
      const e2 = deriveEdgeNames(oc, s2, scaled, n2.faceNames, n2.faceAncestry).edgeNames
      const p2 = multiplicityPair(s2, scaled, n2.faceNames, e2)
      expect(p2).not.toBeNull()
      // The left edge (more-negative midpoint x) keeps index 0's UUID and the
      // right edge keeps index 1's: a uniform resize never swaps them.
      expect(p2!.leftUuid).toBe(p1!.leftUuid)
      expect(p2!.rightUuid).toBe(p1!.rightUuid)
    } finally {
      s1.dispose()
      s2.dispose()
    }
  })

  it('two arcs of one circle with different angle ranges get distinct keys, not a permanent centre tie', () => {
    // An arc carries no start/end, so the old code fell back to the shared
    // circle centre: two arcs of ONE circle produced the byte-identical key
    // [0,0,0], orderSplitChildren refused (a permanent tie), and both stayed
    // unnamed -- never a swap. The mid-parameter point moves along the circle
    // with the angle range, so distinct arcs must order instead.
    const scope = new DisposeScope()
    try {
      const first = makeArcEdge(oc, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5, 0, Math.PI)
      const second = makeArcEdge(oc, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5, Math.PI, 2 * Math.PI)
      const k1 = edgeMidpoint(oc, scope, first)
      const k2 = edgeMidpoint(oc, scope, second)
      for (const k of [k1, k2]) expect(k.some(Number.isNaN)).toBe(false)
      expect(k1, 'distinct angle ranges must not collapse onto the circle centre').not.toEqual(k2)
      const ordered = orderSplitChildren([
        { item: 'first', key: k1 },
        { item: 'second', key: k2 },
      ])
      expect(ordered, 'distinct arc keys order instead of permanently refusing').not.toBeNull()
      expect(new Set(ordered!).size).toBe(2)
    } finally {
      scope.dispose()
    }
  })

  it('the arc midpoint lands on the circle at the mid-parameter, not the centre', () => {
    const scope = new DisposeScope()
    try {
      // Arc [0, pi] on a radius-5 circle centred at the origin: the point at the
      // mid-parameter pi/2 is (0, 5, 0) with v = axis x x_axis = (0, 1, 0).
      const arc = makeArcEdge(oc, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5, 0, Math.PI)
      const m = edgeMidpoint(oc, scope, arc)
      expect(m.some(Number.isNaN)).toBe(false)
      expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(5, 6)
      expect(Math.abs(m[0])).toBeCloseTo(0, 6)
      expect(m[1]).toBeCloseTo(5, 6)
    } finally {
      scope.dispose()
    }
  })

  it('two halves of a split ellipse get distinct non-centre keys, not a permanent centre tie', () => {
    // An ellipse edge carries a/b instead of radius, so the old code missed the
    // mid-parameter arm entirely and fell back to the shared centre: two split
    // halves produced byte-identical keys, orderSplitChildren refused (a
    // permanent tie), and both stayed unnamed. The eccentric-angle midpoint
    // must move along the ellipse like the circle arm does.
    const scope = new DisposeScope()
    try {
      const first = makeEllipseEdge(oc, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 6, 3, 0, Math.PI)
      const second = makeEllipseEdge(oc, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 6, 3, Math.PI, 2 * Math.PI)
      const k1 = edgeMidpoint(oc, scope, first)
      const k2 = edgeMidpoint(oc, scope, second)
      for (const k of [k1, k2]) expect(k.some(Number.isNaN)).toBe(false)
      // Mid-eccentric-angle points pi/2 and 3pi/2: (0, b, 0) and (0, -b, 0),
      // each ON the ellipse and neither at the centre.
      for (const k of [k1, k2]) expect(Math.hypot(k[0], k[1], k[2])).toBeCloseTo(3, 6)
      expect(k1, 'split halves must not collapse onto the ellipse centre').not.toEqual(k2)
      expect(k2[1]).toBeCloseTo(-k1[1], 6)
      const ordered = orderSplitChildren([
        { item: 'first', key: k1 },
        { item: 'second', key: k2 },
      ])
      expect(ordered, 'distinct half keys order instead of permanently refusing').not.toBeNull()
      expect(new Set(ordered!).size).toBe(2)
    } finally {
      scope.dispose()
    }
  })

  it('shapeNormalFrame clamps a vertex-less shape to span 1', () => {
    // An empty compound (an import with no solids) has no TopAbs_VERTEX, so the
    // frame cannot be derived: the honest default is centre 0 and span 1, never
    // a divide-by-zero span.
    const scope = new DisposeScope()
    try {
      const compound = scope.track(new oc.TopoDS_Compound())
      scope.track(new oc.BRep_Builder()).MakeCompound(compound)
      expect(shapeNormalFrame(oc, scope, compound)).toEqual({ centre: [0, 0, 0], span: 1 })
    } finally {
      scope.dispose()
    }
  })

  it('FaceEdgeTable.rowOf maps each read face to its row and a foreign face to null', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10)
      const t = FaceEdgeTable.read(oc, scope, box)
      const E = oc.TopAbs_ShapeEnum
      const exp = scope.track(new oc.TopExp_Explorer_2(box, E.TopAbs_FACE, E.TopAbs_SHAPE))
      let matched = 0
      for (; exp.More(); exp.Next()) {
        const face = scope.track(oc.TopoDS.Face_1(exp.Current())) as OccSubShape
        const row = t.rowOf(face)
        expect(row).not.toBeNull()
        // The row is keyed by topological identity, so re-looking it up by the
        // row's own face returns the same row.
        expect(t.rowOf(row!.face)).toBe(row)
        matched++
      }
      expect(matched).toBe(t.rows.length)
      const other = makeBoxAt(oc, scope, [100, 0, 0], 10, 10, 10)
      const otherExp = scope.track(new oc.TopExp_Explorer_2(other, E.TopAbs_FACE, E.TopAbs_SHAPE))
      const foreign = scope.track(oc.TopoDS.Face_1(otherExp.Current())) as OccSubShape
      expect(t.rowOf(foreign)).toBeNull()
    } finally {
      scope.dispose()
    }
  })

  it('FaceEdgeTable.area and surfaceType report a box face area and kind', () => {
    const scope = new DisposeScope()
    try {
      const box = makeBoxAt(oc, scope, [0, 0, 0], 10, 10, 10)
      const t = FaceEdgeTable.read(oc, scope, box)
      const row = t.rows[0]
      expect(t.area(row)).toBeCloseTo(100, 6)
      expect(t.surfaceType(row)).toBe('flatface')
    } finally {
      scope.dispose()
    }
  })

  it('a parametric edit pushing the pair into a near-tie leaves BOTH unnamed', () => {
    const scope = new DisposeScope()
    try {
      // Radius 0.003 -> the two shared edges sit 0.006 apart in a shape whose
      // span is 10 (the height): normalized separation 6e-4 < SPLIT_EPS, so the
      // ordering is ambiguous and must refuse -- both edges unnamed -- instead
      // of silently picking which is index 0. The same shape at radius 5 is
      // clearly ordered (the resize test above), so this is the same pair under
      // a parametric radius edit that makes its order ambiguous.
      const thin = halfCylinder(scope, 0.003)
      const n = nameFacesByGeometry(scope, thin)
      const e = deriveEdgeNames(oc, scope, thin, n.faceNames, n.faceAncestry).edgeNames
      const p = multiplicityPair(scope, thin, n.faceNames, e)
      expect(p).not.toBeNull()  // the multiplicity pair still exists
      expect(p!.leftUuid).toBeUndefined()
      expect(p!.rightUuid).toBeUndefined()
    } finally {
      scope.dispose()
    }
  })
})
