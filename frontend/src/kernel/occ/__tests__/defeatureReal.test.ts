// @vitest-environment node
//
// Phase-0 probe for the delete-face kernel path (occ/defeature.ts), kept as a
// regression test. It pins the OCCT 7.4.0p1 (opencascade.js 1.1.1) behaviour the
// adapter is built on:
//
//   - `SetShape` + `AddFaceToRemove` per face + `SetToFillHistory(true)` +
//     `Build` removes the faces and extends the neighbours' surfaces to close
//     the gap (a plain box comes back).
//   - A connected set of picked faces (sharing an edge) is removed or refused as
//     a unit.
//   - An impossible removal is a SILENT NO-OP: `IsDone` is true and nothing is
//     deleted. `IsDeleted(face) == false` is the only failure signal, so the
//     no-op rows must come back as failedGroups with the shape UNCHANGED.
//   - Removing a face whose ring holds a non-analytic (B-spline) neighbour can
//     hang for over a minute, so the neighbour type is refused BEFORE OCC runs.
//   - No face is Generated: "no new geometry" holds by construction.
//
// Skips when opencascade.js is absent, like every *Real suite.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import {
  makeBox,
  makeBoxAt,
  makeCylinder,
  makeLineEdge,
  makeBezierEdge,
  makeWire,
  makeFaceFromWire,
  makePrism,
  faceSurfaceType,
  faceCentroid,
  edgeToGeom,
  type Vec3,
} from '../primitives'
import { volumeOf } from '../volume'
import { booleanWithDiff, exploreSolids } from '../booleans'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import { applyFilletWithDiff, applyChamferWithDiff, isValidShape } from '../edgeModifier'
import { applyDeleteFacesWithLineage } from '../defeature'
import type { OccModule, OccShape } from '../occTypes'

const oc = await loadOcc()
// The tests only run when the build is present; this is the non-null view.
const OCC = oc as OccModule

describe.skipIf(!oc)('defeature phase-0 probe (real OCC)', () => {

  const facesOf = (scope: DisposeScope, s: OccShape): OccShape[] =>
    canonicalFaces(OCC, scope, s) as OccShape[]
  const faceType = (scope: DisposeScope, f: OccShape): string => faceSurfaceType(OCC, scope, f)
  const centroid = (scope: DisposeScope, f: OccShape): Vec3 => faceCentroid(OCC, scope, f)
  const faceCount = (scope: DisposeScope, s: OccShape): number => facesOf(scope, s).length
  const solidCount = (scope: DisposeScope, s: OccShape): number => exploreSolids(OCC, scope, s).length

  const cut = (scope: DisposeScope, target: OccShape, tool: OccShape): OccShape =>
    scope.track(booleanWithDiff(OCC, scope, target, tool, 'cut').shape)
  const fuse = (scope: DisposeScope, target: OccShape, tool: OccShape): OccShape =>
    scope.track(booleanWithDiff(OCC, scope, target, tool, 'fuse').shape)

  const cylinderFaces = (scope: DisposeScope, s: OccShape): OccShape[] =>
    facesOf(scope, s).filter((f) => faceType(scope, f) === 'cylinderface')
  // The one planar face whose centroid is exactly `c`.
  const planarFaceAt = (scope: DisposeScope, s: OccShape, c: Vec3): OccShape =>
    facesOf(scope, s).find(
      (f) => faceType(scope, f) === 'flatface' && c.every((v, i) => Math.abs(centroid(scope, f)[i] - v) < 1e-6),
    )!
  const planarFacesAtZ = (scope: DisposeScope, s: OccShape, z: number): OccShape[] =>
    facesOf(scope, s).filter((f) => faceType(scope, f) === 'flatface' && Math.abs(centroid(scope, f)[2] - z) < 1e-6)

  // The 20x20x10 base box (V = 4000), untracked as the primitives contract.
  const box = (scope: DisposeScope): OccShape => makeBox(OCC, scope, 20, 20, 10)

  const verticalEdges = (scope: DisposeScope, s: OccShape): OccShape[] =>
    (canonicalEdges(OCC, scope, s) as OccShape[]).filter((e) => {
      const g = edgeToGeom(OCC, scope, e)
      return g?.ed.kind === 'line' && Math.abs(g.ed.start[0] - g.ed.end[0]) < 1e-9 && Math.abs(g.ed.start[1] - g.ed.end[1]) < 1e-9
    })
  const topEdges = (scope: DisposeScope, s: OccShape): OccShape[] =>
    (canonicalEdges(OCC, scope, s) as OccShape[]).filter((e) => {
      const g = edgeToGeom(OCC, scope, e)
      return g?.ed.kind === 'line' && Math.abs(g.ed.start[2] - 10) < 1e-9 && Math.abs(g.ed.end[2] - 10) < 1e-9
    })

  // The picks for a hole/pocket/boss: the named features faces, addressed by
  // geometry (a hole's bore is the only cylindrical face; its floor the planar
  // face at the hole's bottom).
  const blindHole = (scope: DisposeScope): { shape: OccShape; remove: OccShape[] } => {
    const shape = cut(scope, box(scope), makeCylinder(OCC, scope, [10, 10, 5], [0, 0, 1], 2, 10))
    return { shape, remove: [...cylinderFaces(scope, shape), planarFaceAt(scope, shape, [10, 10, 5])] }
  }

  it('a fillet on one vertical edge heals back to the plain box', () => {
    const scope = new DisposeScope()
    try {
      const base = box(scope)
      const fil = applyFilletWithDiff(OCC, scope, base, 3, [verticalEdges(scope, base)[0]])
      expect(fil.success).toBe(true)
      const shaped = scope.track(fil.shape)
      expect(faceCount(scope, shaped)).toBe(7)
      const res = applyDeleteFacesWithLineage(OCC, scope, shaped, fil.diff.new_faces as OccShape[])
      expect(res.applied).toBe(true)
      expect(res.failedGroups).toEqual([])
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
      expect(solidCount(scope, res.shape)).toBe(1)
      expect(isValidShape(OCC, scope, res.shape)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('a chamfer on one top edge heals back to the plain box', () => {
    const scope = new DisposeScope()
    try {
      const base = box(scope)
      const ch = applyChamferWithDiff(OCC, scope, base, 2, [topEdges(scope, base)[0]], 'distance', 45)
      expect(ch.success).toBe(true)
      const shaped = scope.track(ch.shape)
      expect(faceCount(scope, shaped)).toBe(7)
      const res = applyDeleteFacesWithLineage(OCC, scope, shaped, ch.diff.new_faces as OccShape[])
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('a fillet chain: one of four top fillets removed leaves the sharp edge (9 faces)', () => {
    const scope = new DisposeScope()
    try {
      const base = box(scope)
      const fil = applyFilletWithDiff(OCC, scope, base, 2, topEdges(scope, base))
      expect(fil.success).toBe(true)
      const shaped = scope.track(fil.shape)
      expect(faceCount(scope, shaped)).toBe(10)
      const res = applyDeleteFacesWithLineage(OCC, scope, shaped, [(fil.diff.new_faces as OccShape[])[0]])
      expect(res.applied).toBe(true)
      // One fillet gone: the sharp edge returns and the two adjacent fillets run
      // on to the corner (the probe measured 3950.029).
      expect(volumeOf(OCC, scope, res.shape)).toBeGreaterThan(3945)
      expect(volumeOf(OCC, scope, res.shape)).toBeLessThan(3955)
      expect(faceCount(scope, res.shape)).toBe(9)
    } finally {
      scope.dispose()
    }
  })

  it('a blind hole (wall + floor) heals back to the plain box', () => {
    const scope = new DisposeScope()
    try {
      const { shape, remove } = blindHole(scope)
      expect(faceCount(scope, shape)).toBe(8)
      expect(remove).toHaveLength(2)
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, remove)
      expect(res.applied).toBe(true)
      expect(res.failedGroups).toEqual([])
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
      expect(isValidShape(OCC, scope, res.shape)).toBe(true)
    } finally {
      scope.dispose()
    }
  })

  it('a through hole (wall only) heals back to the plain box', () => {
    const scope = new DisposeScope()
    try {
      const shape = cut(scope, box(scope), makeCylinder(OCC, scope, [10, 10, -1], [0, 0, 1], 2, 12))
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, cylinderFaces(scope, shape))
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('a rectangular pocket (4 walls + floor) heals back to the plain box', () => {
    const scope = new DisposeScope()
    try {
      const shape = cut(scope, box(scope), makeBoxAt(OCC, scope, [5, 5, 5], 10, 10, 8))
      // The four pocket walls (planar, centroid z = 7.5) plus the floor.
      const walls = planarFacesAtZ(scope, shape, 7.5)
      const remove = [...walls, planarFaceAt(scope, shape, [10, 10, 5])]
      expect(remove).toHaveLength(5)
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, remove)
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('a boss (wall + top) heals back to the plain box', () => {
    const scope = new DisposeScope()
    try {
      const shape = fuse(scope, box(scope), makeCylinder(OCC, scope, [10, 10, 10], [0, 0, 1], 3, 4))
      const remove = [...cylinderFaces(scope, shape), planarFaceAt(scope, shape, [10, 10, 14])]
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, remove)
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('two blind holes removed in one call', () => {
    const scope = new DisposeScope()
    try {
      const a = cut(scope, box(scope), makeCylinder(OCC, scope, [5, 5, 5], [0, 0, 1], 2, 10))
      const shape = cut(scope, a, makeCylinder(OCC, scope, [15, 15, 5], [0, 0, 1], 2, 10))
      const remove = [...cylinderFaces(scope, shape), planarFaceAt(scope, shape, [5, 5, 5]), planarFaceAt(scope, shape, [15, 15, 5])]
      expect(remove).toHaveLength(4)
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, remove)
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000, 3)
      expect(faceCount(scope, res.shape)).toBe(6)
    } finally {
      scope.dispose()
    }
  })

  it('a blind-hole floor alone becomes a through hole (partial pick heals)', () => {
    const scope = new DisposeScope()
    try {
      const { shape } = blindHole(scope)
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, [planarFaceAt(scope, shape, [10, 10, 5])])
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000 - Math.PI * 4 * 10, 3)
      expect(faceCount(scope, res.shape)).toBe(7)
    } finally {
      scope.dispose()
    }
  })

  it('a hole wall alone is a silent no-op: refused, shape unchanged', () => {
    const scope = new DisposeScope()
    try {
      const { shape } = blindHole(scope)
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, cylinderFaces(scope, shape))
      expect(res.applied).toBe(false)
      expect(res.failedGroups).toHaveLength(1)
      expect(res.failedGroups[0].reason).toContain('close the gap')
      expect(res.shape).toBe(shape)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000 - Math.PI * 4 * 5, 3)
    } finally {
      scope.dispose()
    }
  })

  it('the box top face is a silent no-op', () => {
    const scope = new DisposeScope()
    try {
      const base = box(scope)
      const res = applyDeleteFacesWithLineage(OCC, scope, base, [planarFaceAt(scope, base, [10, 10, 10])])
      expect(res.applied).toBe(false)
      expect(res.shape).toBe(base)
    } finally {
      scope.dispose()
    }
  })

  it('a through-hole wall plus the adjacent top face fails as one connected group', () => {
    const scope = new DisposeScope()
    try {
      // The through hole's wall and the box top share the mouth circle, so they
      // are ONE connected group, and OCC refuses the whole set (the hole stays).
      const shape = cut(scope, box(scope), makeCylinder(OCC, scope, [10, 10, -1], [0, 0, 1], 2, 12))
      const remove = [...cylinderFaces(scope, shape), planarFaceAt(scope, shape, [10, 10, 10])]
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, remove)
      expect(res.applied).toBe(false)
      expect(res.failedGroups).toHaveLength(1)
      expect(res.failedGroups[0].faceIndices).toHaveLength(2)
      expect(res.shape).toBe(shape)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000 - Math.PI * 4 * 10, 3)
    } finally {
      scope.dispose()
    }
  })

  it('KNOWN LIMITATION: a blind-hole wall plus the top face is not refused', () => {
    // The plan's probe measured a silent no-op for a THROUGH hole (the case
    // pinned above). On a BLIND hole the same pair reports IsDeleted for both
    // and this build returns a valid half-height box (V = 2000): the top and
    // bore planes extend and the floor plane extends outward, losing half the
    // material. No plan guard (IsDeleted, validity, solid count) catches it, so
    // the behaviour is recorded here rather than asserted as intended. See
    // tmp/handoff.md.
    const scope = new DisposeScope()
    try {
      const { shape } = blindHole(scope)
      const remove = [...cylinderFaces(scope, shape), planarFaceAt(scope, shape, [10, 10, 10])]
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, remove)
      expect(res.applied).toBe(true)
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(2000, 2)
    } finally {
      scope.dispose()
    }
  })

  it('disjoint mixed call: the hole is removed, the boss top is refused', () => {
    const scope = new DisposeScope()
    try {
      const holed = cut(scope, box(scope), makeCylinder(OCC, scope, [5, 5, -1], [0, 0, 1], 2, 12))
      const shape = fuse(scope, holed, makeCylinder(OCC, scope, [15, 15, 10], [0, 0, 1], 3, 4))
      const holeWall = cylinderFaces(scope, shape).find(
        (f) => Math.hypot(centroid(scope, f)[0] - 5, centroid(scope, f)[1] - 5) < 1e-6,
      )!
      const bossTop = planarFaceAt(scope, shape, [15, 15, 14])
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, [holeWall, bossTop])
      expect(res.applied).toBe(true)
      expect(res.failedGroups).toHaveLength(1)
      expect(res.failedGroups[0].faceIndices).toEqual([1])
      // Deleting the hole fills it: box (4000) + boss (pi 9 4).
      expect(volumeOf(OCC, scope, res.shape)).toBeCloseTo(4000 + Math.PI * 9 * 4, 3)
    } finally {
      scope.dispose()
    }
  })

  it('refuses a non-analytic B-spline neighbour before calling OCC (fast)', () => {
    const scope = new DisposeScope()
    try {
      // A "D" profile: a vertical line plus a Bezier curve bulging right,
      // extruded. The Bezier side face is a SurfaceOfExtrusion (surface type
      // 'face'), so deleting the top face (whose ring holds it) is refused by
      // the neighbour-type guard instead of hanging in OCC for a minute.
      const p = (x: number, y: number): Vec3 => [x, y, 0]
      const wire = scope.track(makeWire(OCC, scope, [
        makeLineEdge(OCC, scope, p(1, 6), p(1, 14)),
        makeBezierEdge(OCC, scope, [p(1, 14), p(12, 14), p(12, 6), p(1, 6)]),
      ]))
      const face = scope.track(makeFaceFromWire(OCC, scope, wire))
      const shape = scope.track(makePrism(OCC, scope, face, [0, 0, 1], 10))
      const top = planarFacesAtZ(scope, shape, 10)[0]
      expect(facesOf(scope, shape).some((f) => faceType(scope, f) === 'face')).toBe(true)
      const t0 = Date.now()
      const res = applyDeleteFacesWithLineage(OCC, scope, shape, [top])
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(res.applied).toBe(false)
      expect(res.failedGroups[0].reason).toContain('non-analytic')
    } finally {
      scope.dispose()
    }
  })

  it('a plate of 25 holes removes one, then all in a single call', { timeout: 60000 }, () => {
    const scope = new DisposeScope()
    try {
      const tools: OccShape[] = []
      for (let i = 0; i < 5; i++) {
        for (let j = 0; j < 5; j++) {
          tools.push(makeCylinder(OCC, scope, [10 + i * 20, 10 + j * 20, -1], [0, 0, 1], 2, 7))
        }
      }
      let shape = makeBox(OCC, scope, 100, 100, 5)
      for (const t of tools) shape = cut(scope, shape, t)
      const walls = cylinderFaces(scope, shape)
      expect(walls).toHaveLength(25)

      const one = applyDeleteFacesWithLineage(OCC, scope, shape, [walls[0]])
      expect(one.applied).toBe(true)
      expect(faceCount(scope, one.shape)).toBe(30)

      const all = applyDeleteFacesWithLineage(OCC, scope, shape, walls)
      expect(all.applied).toBe(true)
      expect(volumeOf(OCC, scope, all.shape)).toBeCloseTo(50000, 2)
      expect(faceCount(scope, all.shape)).toBe(6)
    } finally {
      scope.dispose()
    }
  })
})
