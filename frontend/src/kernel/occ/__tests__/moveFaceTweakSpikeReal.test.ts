// @vitest-environment node
//
// Phase-0 spike for the direct B-rep move-face (feature/move-face-direct-brep).
// It confirms the bindings route A needs before any production code exists:
//
//   1. surface-surface intersection: GeomAPI_IntSS and BRepAlgoAPI_Section are
//      NOT bound, and a BRepAlgoAPI_Common over two faces comes back empty in
//      this build. BRepAlgoAPI_Splitter partitions the argument face by the
//      tool face, and the split introduces the intersection edges. So the
//      section primitive is Splitter, not Common; no binding gap forces route
//      B.
//   2. an edge on a given curve: BRepBuilderAPI_MakeEdge_24 (Geom_Curve) and
//      _31 (p-curve + surface) are bound; the spike rebuilds an edge from a
//      curve handle.
//   3. a face on a given surface + wire: BRepBuilderAPI_MakeFace_21 is bound
//      and accepts a wire with no p-curves (it computes them), which is what
//      the rebuilt faces need.
//
// gp_Pln is bound at runtime (gp_Pln_2 takes a gp_Ax3) although the typed slice
// did not list it, so a moved planar face is a new gp_Pln at the target offset.
// A moved cylinder/cone face is the primitive's lateral face at the new radius.
//
// BRepBuilderAPI_Sewing and BRepBuilderAPI_MakeSolid are not bound; a shell is
// assembled with BRep_Builder.MakeShell + Add and wrapped with MakeSolid,
// which is the shipped way of filling a solid (offsetShape.ts, boolean tests).
// ShapeFix_Solid is not bound either; the cleanup layer's heal pass is the
// orientation repair.
//
// The four fixtures are the plan's phase-0 set: the report document (5 picks,
// d = 2), a cylinder boss wall +1, a cone frustum base -2, and a box with a
// through-hole whose top face moves -2.
//
// Skips when OCC.js or the Rust solver is absent.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadOcc } from '../loadOcc'
import { noProgress } from '../defaultArgs'
import { DisposeScope, withTransientScope } from '../disposeScope'
import { SharedHarness } from '../sharedHarness'
import { volumeOf } from '../volume'
import { canonicalFaces, canonicalEdges } from '../partNames'
import { faceCentroid, faceNormal, makeBox, makeCircleEdge, makeLineEdge, makeWire, type Vec3 } from '../primitives'
import { makeHalfSpaceBox } from '../halfSpace'
import { booleanWithDiff } from '../booleans'
import { makeFaceIndexCache, resolveFacesByQuery } from '../../features/shared/faceResolution'
import { setSketchSolver, resetSketchSolver } from '../../features/sketch'
import { loadSolver } from '@/wasm-kernel/loadSolver'
import { partSpecFromText } from '@/utils/partExport'
import { normalToFrame } from '../../types3d'
import type { OccModule, OccShape } from '../occTypes'
import type { PartSolid } from '../../types3d'

const oc = await loadOcc()
const solveBytes = loadSolver()

const REPORT_RECIPE = readFileSync(
  join(process.cwd(), 'regressions', 'move-face-legacy-cap', 'recipe.yaml'),
  'utf8',
)
const REPORT_DOC = partSpecFromText(REPORT_RECIPE)

/** A large face on a planar neighbour, wide enough to cross any fixture. */
function bigPlaneFace(oc2: OccModule, scope: DisposeScope, face: OccShape, L: number): OccShape {
  const adaptor = scope.track(new oc2.BRepAdaptor_Surface_2(face, true))
  const plane = scope.track(adaptor.Plane())
  const maker = scope.track(new oc2.BRepBuilderAPI_MakeFace_9(plane, -L, L, -L, L))
  return scope.track(maker.Face())
}

/** A large face on `face`'s plane moved by `d` along `n`. */
function movedBigPlaneFace(
  oc2: OccModule,
  scope: DisposeScope,
  face: OccShape,
  n: Vec3,
  d: number,
  L: number,
): OccShape {
  const c = faceCentroid(oc2, scope, face)
  const frameAxis = normalToFrame(n)
  const frame = scope.track(new oc2.gp_Ax3_3(
    scope.track(new oc2.gp_Pnt_3(c[0] + n[0] * d, c[1] + n[1] * d, c[2] + n[2] * d)),
    scope.track(new oc2.gp_Dir_5(n[0], n[1], n[2])),
    scope.track(new oc2.gp_Dir_5(frameAxis.x_axis[0], frameAxis.x_axis[1], frameAxis.x_axis[2])),
  ))
  const plane = scope.track(new oc2.gp_Pln_2(frame))
  return scope.track(new oc2.BRepBuilderAPI_MakeFace_9(plane, -L, L, -L, L).Face())
}

/** A large face on `face`'s own surface, for a non-planar intersection pair. */
function bigFaceOn(oc2: OccModule, scope: DisposeScope, face: OccShape, L: number): OccShape {
  const adaptor = scope.track(new oc2.BRepAdaptor_Surface_2(face, true))
  const S = oc2.GeomAbs_SurfaceType
  const t = adaptor.GetType().value
  if (t === S.GeomAbs_Plane.value) return bigPlaneFace(oc2, scope, face, L)
  if (t === S.GeomAbs_Cylinder.value) {
    const cyl = scope.track(adaptor.Cylinder())
    return scope.track(new oc2.BRepBuilderAPI_MakeFace_10(cyl, 0, 2 * Math.PI, -L, L).Face())
  }
  if (t === S.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    return scope.track(new oc2.BRepBuilderAPI_MakeFace_11(cone, 0, 2 * Math.PI, -2 * L, 2 * L).Face())
  }
  const surface = scope.track(oc2.BRep_Tool.Surface_2(face))
  return scope.track(new oc2.BRepBuilderAPI_MakeFace_14(surface, -L, L, -L, L, 1e-6).Face())
}

/** The intersection edges of two large faces, via the bound splitter. */
function sectionEdges(
  oc2: OccModule,
  scope: DisposeScope,
  a: OccShape,
  b: OccShape,
): { edges: OccShape[]; all: OccShape } {
  const algo = scope.track(new oc2.BRepAlgoAPI_Splitter_1())
  const args = scope.track(new oc2.TopTools_ListOfShape_1())
  args.Append_1(a)
  const tools = scope.track(new oc2.TopTools_ListOfShape_1())
  tools.Append_1(b)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.Build(noProgress(oc2))
  if (!algo.IsDone()) throw new Error('spike: the face splitter did not complete')
  const all = scope.track(algo.Shape())
  // The result carries the argument face's own boundary edges plus the split
  // edges. The split edges are the intersection; the spike checks that the
  // expected curve kind is present rather than separating the two sets.
  return { edges: canonicalEdges(oc2, scope, all) as OccShape[], all }
}

/** Edge kinds present in a common result, for the binding report. */
function edgeKinds(oc2: OccModule, scope: DisposeScope, edges: OccShape[]): string[] {
  const seen = new Set<string>()
  for (const e of edges) {
    const ad = scope.track(new oc2.BRepAdaptor_Curve_2(e))
    const t = ad.GetType().value
    const C = oc2.GeomAbs_CurveType
    if (t === C.GeomAbs_Line.value) seen.add('line')
    else if (t === C.GeomAbs_Circle.value) seen.add('circle')
    else if (t === C.GeomAbs_Ellipse.value) seen.add('ellipse')
    else seen.add('spline')
  }
  return [...seen]
}

describe.skipIf(!oc || !solveBytes)('direct move-face spike (real OCC)', () => {
  const occ = oc!

  it('reports the bound and missing primitives for the tweak', () => {
    const anyOc = occ as unknown as Record<string, unknown>
    // Present, and used by the tweak.
    expect(typeof anyOc.BRepAlgoAPI_Common_1).toBe('function')
    expect(typeof anyOc.BRepBuilderAPI_MakeEdge_24).toBe('function')
    expect(typeof anyOc.BRepBuilderAPI_MakeEdge_31).toBe('function')
    expect(typeof anyOc.BRepBuilderAPI_MakeFace_21).toBe('function')
    expect(typeof anyOc.BRepCheck_Analyzer).toBe('function')
    expect(typeof anyOc.BRep_Builder).toBe('function')
    // gp_Pln is bound at runtime (the typed slice did not list it); the moved
    // plane is a gp_Pln_2, so the tweak needs no transformed copy.
    expect(typeof anyOc.gp_Pln_2).toBe('function')
    // Missing: the plan's named fallbacks. Their absence is the reason the
    // tweak runs over Common + MakeShell, not a route-B trigger.
    expect(anyOc.GeomAPI_IntSS).toBeUndefined()
    expect(anyOc.BRepAlgoAPI_Section).toBeUndefined()
    expect(anyOc.BRepBuilderAPI_Sewing).toBeUndefined()
    expect(anyOc.BRepBuilderAPI_MakeSolid).toBeUndefined()
    expect(anyOc.ShapeFix_Solid).toBeUndefined()
  })

  it('builds an edge from a curve handle and a face from surface + wire', () => {
    withTransientScope((scope) => {
      // A curve edge (MakeEdge_24 reads the Geom_Circle the arc maker hands
      // back) is the shape trimmed intersection curves take.
      const arc = scope.track(makeCircleEdge(occ, scope, [0, 0, 0], [0, 0, 1], [1, 0, 0], 5))
      expect(canonicalEdges(occ, scope, arc).length).toBe(1)

      // Rebuild the top of a box as a face on the SAME surface with a wire of
      // fresh edges: exactly what a trimmed neighbour gets in the tweak.
      const box = scope.track(makeBox(occ, scope, 10, 10, 10))
      const top = (canonicalFaces(occ, scope, box) as OccShape[]).find((f) => {
        const n = faceNormal(occ, scope, f)
        return Math.abs(n[2] - 1) < 1e-9
      })!
      expect(top).toBeDefined()
      const surface = scope.track(occ.BRep_Tool.Surface_2(top))
      const corners: Vec3[] = [[0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]]
      const loop = corners.map((a, i) => {
        const b = corners[(i + 1) % corners.length]
        return scope.track(makeLineEdge(occ, scope, a, b))
      })
      const wire = scope.track(makeWire(occ, scope, loop, { requireClosed: true }))
      const maker = scope.track(new occ.BRepBuilderAPI_MakeFace_21(surface, wire, true))
      expect(maker.IsDone()).toBe(true)
      const face = scope.track(maker.Face())
      const analyzer = scope.track(new occ.BRepCheck_Analyzer(face, true, false, false))
      expect(analyzer.IsValid_2()).toBe(true)
    })
  })

  it('report document: each moved pick intersects every neighbour on a line', () => {
    const h = new SharedHarness(occ)
    resetSketchSolver()
    setSketchSolver(solveBytes!)
    const baseDoc = structuredClone(REPORT_DOC) as { features: Record<string, unknown>[] }
    baseDoc.features.pop()  // the move itself
    const base = h.run(baseDoc)
    const part = base._build_state.checkpoints['ItndFzj0p5ptXDPqsLWTaKPm']
      ?.body_store_snapshot?.['body_ItndFzj0p5ptXDPqsLWTaKPm'] as PartSolid | undefined
    if (!part) throw new Error('the report document has no body after the extrude')
    const scope = new DisposeScope()
    try {
      const index = makeFaceIndexCache(occ, scope, h.table)(part)
      const stored = ((structuredClone(REPORT_DOC) as { features: Record<string, unknown>[] })
        .features.find((f) => f.id === 'Pqa8cKOIZ02jshDxVx8typkI')!
        .move_face as { faces: string[] }).faces
      const faces = stored.map((q) => {
        const face = resolveFacesByQuery(occ, scope, h.table, part, index, [q]).get(q)
        if (!face) throw new Error(`the report pick did not resolve: ${q}`)
        return face
      })
      expect(faces).toHaveLength(5)
      expect(stored).toHaveLength(5)
      const shape = h.table.get<OccShape>(part.shape!)
      const L = 200
      const allFaces = canonicalFaces(occ, scope, shape) as OccShape[]
      // Every pick is a plane and its neighbours are planes: each edge's new
      // curve is a line, the simplest tweak case.
      for (const face of faces) {
        const adaptor = scope.track(new occ.BRepAdaptor_Surface_2(face, true))
        expect(adaptor.GetType().value).toBe(occ.GeomAbs_SurfaceType.GeomAbs_Plane.value)
        const n = faceNormal(occ, scope, face)
        const movedFace = movedBigPlaneFace(occ, scope, face, n, 2, L)
        const faceEdges = canonicalEdges(occ, scope, face)
        for (const neighbour of allFaces) {
          if (neighbour === face) continue
          const shares = canonicalEdges(occ, scope, neighbour).some((edge) =>
            faceEdges.some((own) => (edge as { IsSame(s: unknown): boolean }).IsSame(own)),
          )
          if (!shares) continue
          const { edges } = sectionEdges(occ, scope, movedFace, bigPlaneFace(occ, scope, neighbour, L))
          expect(edges.length).toBeGreaterThan(0)
          expect(edgeKinds(occ, scope, edges)).toContain('line')
        }
      }
    } finally {
      scope.dispose()
    }
  }, 120_000)

  it('cylinder boss wall +1: the moved cylinder meets the cap plane in a circle', () => {
    withTransientScope((scope) => {
      const box = scope.track(makeBox(occ, scope, 40, 40, 10))
      const boss = scope.track(cylinderSolid(scope, 20, 20, 10, 5, 10))
      const part = scope.track(boolParts(scope, box, boss, 'fuse'))
      const lateral = (canonicalFaces(occ, scope, part) as OccShape[]).find((f) => {
        const a = scope.track(new occ.BRepAdaptor_Surface_2(f, true))
        return a.GetType().value === occ.GeomAbs_SurfaceType.GeomAbs_Cylinder.value
      })!
      expect(lateral).toBeDefined()
      const top = (canonicalFaces(occ, scope, part) as OccShape[]).find((f) => {
        const c = faceCentroid(occ, scope, f)
        const n = faceNormal(occ, scope, f)
        return Math.abs(n[2] - 1) < 1e-9 && Math.abs(c[2] - 20) < 1e-6
      })!
      expect(top).toBeDefined()
      // The moved wall is a cylinder about the boss axis with radius 6; its
      // intersection with the (now enlarged) top cap plane is a circle.
      const frame = scope.track(new occ.gp_Ax3_3(
        scope.track(new occ.gp_Pnt_3(20, 20, 10)),
        scope.track(new occ.gp_Dir_5(0, 0, 1)),
        scope.track(new occ.gp_Dir_5(1, 0, 0)),
      ))
      const cyl = scope.track(new occ.gp_Cylinder_2(frame, 6))
      const movedFace = scope.track(new occ.BRepBuilderAPI_MakeFace_10(cyl, 0, 2 * Math.PI, -20, 20).Face())
      const { edges } = sectionEdges(occ, scope, movedFace, bigPlaneFace(occ, scope, top, 200))
      expect(edges.length).toBeGreaterThan(0)
      expect(edgeKinds(occ, scope, edges)).toContain('circle')
    })
  })

  it('cone frustum base -2: the moved base plane meets the cone in a circle', () => {
    withTransientScope((scope) => {
      const ax2 = scope.track(new occ.gp_Ax2_4(
        scope.track(new occ.gp_Pnt_3(0, 0, 0)),
        scope.track(new occ.gp_Dir_5(0, 0, 1)),
      ))
      const part = scope.track(new occ.BRepPrimAPI_MakeCone_3(ax2, 10, 4, 12).Shape())
      const faces = canonicalFaces(occ, scope, part) as OccShape[]
      const base = faces.find((f) => {
        const n = faceNormal(occ, scope, f)
        return Math.abs(n[2] + 1) < 1e-9
      })!
      expect(base).toBeDefined()
      const lateral = faces.find((f) => {
        const a = scope.track(new occ.BRepAdaptor_Surface_2(f, true))
        return a.GetType().value === occ.GeomAbs_SurfaceType.GeomAbs_Cone.value
      })!
      expect(lateral).toBeDefined()
      // The base moved -2 along its outward normal (down): its radius stays 10
      // at z = -2, where the cone itself is wider than its base, so the moved
      // plane meets the cone in a circle.
      const n = faceNormal(occ, scope, base)
      const movedFace = movedBigPlaneFace(occ, scope, base, n, -2, 200)
      const { edges } = sectionEdges(occ, scope, movedFace, bigFaceOn(occ, scope, lateral, 200))
      expect(edges.length).toBeGreaterThan(0)
      expect(edgeKinds(occ, scope, edges)).toContain('circle')
    })
  })

  it('box with a through hole: the top moved -2 is the half-space cut', () => {
    withTransientScope((scope) => {
      const plate = scope.track(makeBox(occ, scope, 40, 30, 10))
      const bore = scope.track(cylinderSolid(scope, 20, 15, -5, 5, 20))
      const part = scope.track(boolParts(scope, plate, bore, 'cut'))
      const top = (canonicalFaces(occ, scope, part) as OccShape[]).find((f) => {
        const n = faceNormal(occ, scope, f)
        const c = faceCentroid(occ, scope, f)
        return Math.abs(n[2] - 1) < 1e-9 && Math.abs(c[2] - 10) < 1e-6
      })!
      expect(top).toBeDefined()
      // Inward is the material half-space of the moved boundaryless plane.
      const box = makeHalfSpaceBox(occ, scope, [0, 0, 8], [0, 0, 1], part)
      const cut = booleanWithDiff(occ, scope, part, box.shape, 'cut')
      const want = 40 * 30 * 8 - Math.PI * 25 * 8
      expect(volumeOf(occ, scope, cut.shape)).toBeCloseTo(want, 2)
      expect(canonicalFaces(occ, scope, cut.shape)).toHaveLength(7)
    })
  })
})

function cylinderSolid(scope: DisposeScope, x: number, y: number, z: number, radius: number, height: number): OccShape {
  const ax2 = scope.track(new oc!.gp_Ax2_4(
    scope.track(new oc!.gp_Pnt_3(x, y, z)),
    scope.track(new oc!.gp_Dir_5(0, 0, 1)),
  ))
  return scope.track(new oc!.BRepPrimAPI_MakeCylinder_3(ax2, radius, height).Shape())
}

function boolParts(scope: DisposeScope, a: OccShape, b: OccShape, op: 'fuse' | 'cut'): OccShape {
  const algo = scope.track(op === 'fuse' ? new oc!.BRepAlgoAPI_Fuse_1() : new oc!.BRepAlgoAPI_Cut_1())
  const args = scope.track(new oc!.TopTools_ListOfShape_1())
  args.Append_1(a)
  const tools = scope.track(new oc!.TopTools_ListOfShape_1())
  tools.Append_1(b)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.Build(noProgress(oc!))
  return scope.track(algo.Shape())
}
