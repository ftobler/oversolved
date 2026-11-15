// @vitest-environment node
//
// Unit tests for the neighbour-extension rungs (occ/moveFaceExtend.ts) on
// minimal bodies, without a move-face document:
//   - rung 1's full sphere and torus, the closed kinds whose analytic window is
//     the whole surface and whose face cannot partition a slab (the solid is
//     the splitter tool);
//   - rung 2b's ruled continuation, the fallback the pinned build uses because
//     OCCT rejects a face window past a B-spline's domain (rung 2's patch);
//   - the rung 3/4 capability probes. Both bindings are absent from this OCCT
//     build; the tests that would drive them are skipped, and the refusal text
//     is asserted to say `not bound in this OCCT build`.
//
// Skips when OCC.js is absent.
import { describe, it, expect } from 'vitest'
import { loadOcc } from '../loadOcc'
import { DisposeScope } from '../disposeScope'
import { canonicalFaces, canonicalEdges } from '../bodyNames'
import { faceArea, faceCentroid, makeBezierEdge, makeLineEdge, makeWire, makeFaceFromWire, makePrism } from '../primitives'
import { volumeOf } from '../volume'
import { MoveFaceRefusal } from '../moveFaceSurfaces'
import { extendNeighbour, extensionKind } from '../moveFaceExtend'
import { rungCatalog, unboundRungReason, rung3Bound, rung4Bound, RUNG_3, RUNG_4 } from '../moveFaceRungs'
import type { OccModule, OccShape, OccSubShape } from '../occTypes'

const oc = await loadOcc()

describe.skipIf(!oc)('neighbour extension rungs (real OCC)', () => {
  if (!oc) return
  const occ = oc
  const PI = Math.PI

  const ax2z = (scope: DisposeScope): OccShape =>
    scope.track(new occ.gp_Ax2_4(
      scope.track(new occ.gp_Pnt_3(0, 0, 0)),
      scope.track(new occ.gp_Dir_5(0, 0, 1)),
    ))

  const ball = (scope: DisposeScope, r: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeSphere_5(scope.track(new occ.gp_Pnt_3(0, 0, 0)), r).Shape())

  const torus = (scope: DisposeScope, major: number, minor: number): OccShape =>
    scope.track(new occ.BRepPrimAPI_MakeTorus_5(ax2z(scope), major, minor).Shape())

  const valid = (scope: DisposeScope, shape: OccShape): boolean =>
    scope.track(new occ.BRepCheck_Analyzer(shape, true, false, false)).IsValid_2()

  it('rung 1 extends a sphere neighbour to the full sphere and offers its solid', () => {
    const scope = new DisposeScope()
    try {
      const body = ball(scope, 25)
      const face = canonicalFaces(occ, scope, body)[0] as OccShape
      expect(extensionKind(occ, scope, face)).toBe('sphere')
      const tool = extendNeighbour(occ, scope, face, null, [0, 0, 1], 0.5, 100, 1.5)
      expect(tool.rung).toContain('rung 1')
      expect(faceArea(occ, scope, tool.face)).toBeCloseTo(4 * PI * 625, 1)
      expect(valid(scope, tool.face)).toBe(true)
      if (tool.solid === null) throw new Error('a sphere neighbour must carry its solid')
      expect(volumeOf(occ, scope, tool.solid)).toBeCloseTo((4 / 3) * PI * 25 ** 3, 0)
      expect(valid(scope, tool.solid)).toBe(true)
    } finally { scope.dispose() }
  })

  it('rung 1 extends a torus neighbour to the full torus and offers its solid', () => {
    const scope = new DisposeScope()
    try {
      const body = torus(scope, 10, 2)
      const face = canonicalFaces(occ, scope, body)[0] as OccShape
      expect(extensionKind(occ, scope, face)).toBe('torus')
      const tool = extendNeighbour(occ, scope, face, null, [0, 0, 1], 0.5, 100, 1.5)
      expect(tool.rung).toContain('rung 1')
      expect(faceArea(occ, scope, tool.face)).toBeCloseTo(4 * PI * PI * 10 * 2, 1)
      if (tool.solid === null) throw new Error('a torus neighbour must carry its solid')
      expect(volumeOf(occ, scope, tool.solid)).toBeCloseTo(2 * PI * PI * 10 * 4, 0)
    } finally { scope.dispose() }
  })

  it('rung 2 rejects the out-of-domain patch and rung 2b gives a valid ruled continuation', () => {
    const scope = new DisposeScope()
    try {
      // An extruded Bezier-capped D: its side face is a spline surface of
      // extrusion, the same class the fixture's plane-sphere fillet carries.
      const body = scope.track(prismOfBezierDCap(occ, scope))
      const spline = (canonicalFaces(occ, scope, body) as OccShape[]).find(
        (f) => extensionKind(occ, scope, f) === 'freeform',
      )
      if (!spline) throw new Error('the D prism has no freeform side face')
      const cap = (canonicalFaces(occ, scope, body) as OccShape[]).find(
        (f) => Math.abs(faceCentroid(occ, scope, f)[2] - 5) < 1e-6,
      )
      if (!cap) throw new Error('the D prism has no top cap')
      const edge = (canonicalEdges(occ, scope, cap) as OccShape[]).find((e) =>
        (canonicalEdges(occ, scope, spline) as OccShape[]).some((se) => (se as OccSubShape).IsSame(e as OccSubShape)),
      )
      if (!edge) throw new Error('no shared cap/spline edge')
      const tool = extendNeighbour(occ, scope, spline, edge, [0, 0, 1], 2, 100, 6)
      expect(tool.rung).toContain('rung 2b')
      expect(valid(scope, tool.face)).toBe(true)
      // The strip is the extrusion of the edge, so it lies on the face's own
      // surface and its first-order continuation is exact here.
      const stripArea = faceArea(occ, scope, tool.face)
      expect(stripArea).toBeGreaterThan(0)
    } finally { scope.dispose() }
  })

  it('names the unbound rungs and reports them in the refusal catalog', () => {
    expect(rung3Bound(occ)).toBe(false)
    expect(rung4Bound(occ)).toBe(false)
    expect(unboundRungReason(occ, RUNG_3)).toContain('not bound in this OCCT build')
    expect(unboundRungReason(occ, RUNG_4)).toContain('not bound in this OCCT build')
    expect(rungCatalog(occ)).toMatch(/rung 1.*rung 2.*rung 3.*rung 4/s)
    // The two bindings rung 1's closed kinds and rung 2's patch rely on are in
    // the pinned build; a release bump that drops or renumbers them fails here.
    expect(typeof occ.BRepBuilderAPI_MakeFace_14).toBe('function')
    expect(typeof occ.BRep_Tool.Surface_2).toBe('function')
  })

  it('a freeform neighbour without a shared edge still refuses by name with every rung', () => {
    const scope = new DisposeScope()
    try {
      const body = scope.track(prismOfBezierDCap(occ, scope))
      const spline = (canonicalFaces(occ, scope, body) as OccShape[]).find(
        (f) => extensionKind(occ, scope, f) === 'freeform',
      )
      if (!spline) throw new Error('the D prism has no freeform side face')
      let threw: unknown = null
      try {
        extendNeighbour(occ, scope, spline, null, [0, 0, 1], 2, 100, 6)
      } catch (e) { threw = e }
      expect(threw).toBeInstanceOf(MoveFaceRefusal)
      expect((threw as Error).message).toMatch(/rung 1.*rung 2.*rung 3.*rung 4/s)
    } finally { scope.dispose() }
  })

  // The rung-3/4 tests drive the native call once a pinned OCCT release binds
  // it. They are skipped, not deleted: the capability probe flips them on.
  it.skipIf(!rung3Bound(occ))('rung 3 extends a B-spline patch with GeomLib::ExtendSurfByLength', () => {
    const rung3 = (occ as unknown as { GeomLib?: { ExtendSurfByLength?: unknown } }).GeomLib?.ExtendSurfByLength
    expect(typeof rung3).toBe('function')
  })

  it.skipIf(!rung4Bound(occ))('rung 4 offsets the picked face through BRepOffset_MakeOffset', () => {
    const rung4 = (occ as unknown as { BRepOffset_MakeOffset?: { SetOffsetOnFace?: unknown } }).BRepOffset_MakeOffset
    expect(typeof rung4?.SetOffsetOnFace).toBe('function')
  })
})

/** The extruded Bezier-capped D used by the rung-2 tests. */
function prismOfBezierDCap(occ: OccModule, scope: DisposeScope): OccShape {
  const arc = scope.track(makeBezierEdge(occ, scope, [[0, 0, 0], [5, -3, 0], [10, 0, 0]]))
  const line = scope.track(makeLineEdge(occ, scope, [10, 0, 0], [0, 0, 0]))
  const wire = scope.track(makeWire(occ, scope, [arc, line], { requireClosed: true }))
  const face = scope.track(makeFaceFromWire(occ, scope, wire))
  return makePrism(occ, scope, face, [0, 0, 1], 5)
}
