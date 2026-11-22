/**
 * Re-seat a periodic face's seam away from the boundary it collides with.
 *
 * OCCT closes a periodic face (cylinder, cone, sphere, torus, a revolution) on
 * itself with a seam edge at u=0. A later boolean can cut across that seam, so
 * the seam ends on the feature's rim: the rim then needs a vertex there, splits
 * into two edges, and every later feature built on it inherits the split (the
 * reported sphere minus slot: one picked rim edge becomes two fillet faces).
 * The seam is display-hidden, so the user sees one edge and gets two.
 *
 * The repair moves the seam to the middle of the largest free u gap of the
 * face's own boundary, where no boundary edge meets it. The surface itself is
 * unchanged: it is rotated about its own axis so the new u=0 lands in that gap,
 * the face is rebuilt on it as a full-period face with the old non-seam,
 * non-degenerate boundary loops as inner wires, and the layer's following
 * `unifySameDomain` folds the rim halves the split seam used to hold apart.
 *
 * Phase 1 covers faces whose whole boundary is interior (the sphere minus slot,
 * a torus cut across its seam). A face whose non-seam boundary carries a closed
 * edge (a cylinder band's cap circles, a bore rim) is left alone: that edge is
 * shared with neighbouring faces, and moving its seam-anchored vertex would
 * have to rebuild those neighbours too. The spike record is in
 * `feature/bug-seam-residual-split.md`.
 */

import type { DisposeScope } from '../disposeScope'
import type {
  OccAxisDir,
  OccAx3,
  OccModule,
  OccOrientedShape,
  OccOrientableShape,
  OccReShape,
  OccShape,
  OccSubShape,
  OccSurfaceAdaptor,
} from '../occTypes'
import type { PassOptions, PassResult } from './types'
import { largestFreeGap, MIN_SEAM_GAP } from './seamGap'
import { unchanged } from './pipeline'
import { swallowUnlessTrap } from '../../errors'
import { noProgress } from '../defaultArgs'
import { OCC_CONFUSION } from '../../solverConstants'

const PERIOD = 2 * Math.PI
// Boundary pcurve samples per edge: dense enough that a free gap below the
// minimum is measured below it rather than bridged by two coarse samples.
const GAP_SAMPLES = 128

type V3 = [number, number, number]

interface MainAxis {
  origin: V3
  dir: V3
}

interface SeamCandidate {
  face: OccSubShape
  axis: MainAxis
  // The new u=0, in the surface's own parameter units.
  seamU: number
  vRange: [number, number]
  // The old non-seam, non-degenerate boundary loops, as inner wires.
  innerWires: OccShape[]
}

function faces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    out.push(scope.track(oc.TopoDS.Face_1(exp.Current())) as OccSubShape)
  }
  return out
}

function faceWires(oc: OccModule, scope: DisposeScope, face: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  const out: OccShape[] = []
  for (; exp.More(); exp.Next()) out.push(scope.track(oc.TopoDS.Wire_1(exp.Current())))
  return out
}

/** A face's distinct edges in explorer order (a seam is met twice). */
function faceEdges(oc: OccModule, scope: DisposeScope, face: OccShape): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_EDGE, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const edge = scope.track(oc.TopoDS.Edge_1(exp.Current())) as OccSubShape
    if (!out.some((e) => e.IsSame(edge))) out.push(edge)
  }
  return out
}

function edgeVertices(oc: OccModule, scope: DisposeScope, edge: OccShape): OccSubShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(edge, E.TopAbs_VERTEX, E.TopAbs_SHAPE))
  const out: OccSubShape[] = []
  for (; exp.More(); exp.Next()) {
    const v = scope.track(oc.TopoDS.Vertex_1(exp.Current())) as OccSubShape
    if (!out.some((x) => x.IsSame(v))) out.push(v)
  }
  return out
}

function isReversed(oc: OccModule, face: OccShape): boolean {
  return (
    (face as OccOrientedShape).Orientation_1().value ===
    oc.TopAbs_Orientation.TopAbs_REVERSED.value
  )
}

function axisOf(scope: DisposeScope, ax3: OccAx3): MainAxis {
  scope.track(ax3)
  const loc = scope.track(ax3.Location())
  const dir = scope.track(ax3.Direction())
  return {
    origin: [loc.X(), loc.Y(), loc.Z()],
    dir: [dir.X(), dir.Y(), dir.Z()],
  }
}

function axisDirOf(scope: DisposeScope, ax: OccAxisDir): MainAxis {
  scope.track(ax)
  const loc = scope.track(ax.Location())
  const dir = scope.track(ax.Direction())
  return {
    origin: [loc.X(), loc.Y(), loc.Z()],
    dir: [dir.X(), dir.Y(), dir.Z()],
  }
}

/**
 * The surface's own revolution axis. Rotating a surface about it maps the
 * surface onto itself and shifts u, which is exactly a seam move. Null for a
 * primary surface that is not a revolution (a plane, an extrusion, a freeform
 * patch).
 */
function mainAxis(oc: OccModule, scope: DisposeScope, ad: OccSurfaceAdaptor): MainAxis | null {
  const T = oc.GeomAbs_SurfaceType
  const t = ad.GetType().value
  if (t === T.GeomAbs_Sphere.value) return axisOf(scope, scope.track(ad.Sphere()).Position())
  if (t === T.GeomAbs_Torus.value) return axisOf(scope, scope.track(ad.Torus()).Position())
  if (t === T.GeomAbs_Cylinder.value) return axisOf(scope, scope.track(ad.Cylinder()).Position())
  if (t === T.GeomAbs_Cone.value) return axisOf(scope, scope.track(ad.Cone()).Position())
  if (t === T.GeomAbs_SurfaceOfRevolution.value) {
    return axisDirOf(scope, scope.track(ad.AxeOfRevolution()))
  }
  return null
}

/**
 * Does a seam edge end on a boundary vertex that two or more boundary edges
 * share? That is the residual: the rim had to break to meet the seam. A full
 * sphere's seam ends on degenerate pole edges and a plain cylinder's on a
 * single closed cap circle, neither of which counts.
 */
function seamIsCut(
  oc: OccModule,
  scope: DisposeScope,
  seamEdges: readonly OccSubShape[],
  boundary: ReadonlyArray<{ edge: OccSubShape; vertices: OccSubShape[] }>,
): boolean {
  for (const seam of seamEdges) {
    for (const vertex of edgeVertices(oc, scope, seam)) {
      let incident = 0
      for (const { vertices } of boundary) {
        if (vertices.some((v) => v.IsSame(vertex))) incident++
      }
      if (incident >= 2) return true
    }
  }
  return false
}

/** The u values the face's boundary occupies, normalised into one period. */
function boundaryAngles(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  boundary: readonly OccShape[],
): number[] | null {
  const angles: number[] = []
  for (const edge of boundary) {
    let ad
    try {
      ad = scope.track(new oc.BRepAdaptor_Curve2d_2(edge, face))
    } catch (e) {
      swallowUnlessTrap(e)
      return null
    }
    const t0 = ad.FirstParameter()
    const t1 = ad.LastParameter()
    for (let i = 0; i <= GAP_SAMPLES; i++) {
      const p = scope.track(ad.Value(t0 + ((t1 - t0) * i) / GAP_SAMPLES))
      let u = p.X() % PERIOD
      if (u < 0) u += PERIOD
      if (!Number.isFinite(u)) return null
      angles.push(u)
    }
  }
  return angles
}

/** Closed wire over `edges`, or null when they do not chain into one. */
function makeLoop(oc: OccModule, scope: DisposeScope, edges: readonly OccShape[]): OccShape | null {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
  for (const edge of edges) builder.Add_1(edge)
  if (!builder.IsDone()) return null
  return builder.Wire()
}

/**
 * The boundary edges of one old wire in loop order. The wire walk interleaves
 * the seam edges (they are traversed between two rim edges), so the remaining
 * edges are not in chain order and MakeWire would silently build a shorter
 * wire. Walking by shared vertex recovers the loop.
 */
function chainLoop(
  oc: OccModule,
  scope: DisposeScope,
  edges: readonly OccShape[],
): OccShape[] | null {
  if (edges.length === 0) return null
  const ends = edges.map((edge) => edgeVertices(oc, scope, edge))
  if (ends.some((v) => v.length !== 2)) return null
  const used = edges.map(() => false)
  used[0] = true
  const order = [0]
  let current = ends[0][1]
  for (let step = 1; step < edges.length; step++) {
    const next = edges.findIndex((_, i) => !used[i] && ends[i].some((v) => v.IsSame(current)))
    if (next < 0) return null
    used[next] = true
    order.push(next)
    current = ends[next][0].IsSame(current) ? ends[next][1] : ends[next][0]
  }
  // A loop has to come back to where it started.
  if (!current.IsSame(ends[0][0])) return null
  return order.map((i) => edges[i])
}

/** Chain each wire's non-seam, non-degenerate edges into one closed loop. */
function boundaryLoops(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): OccShape[] | null {
  const loops: OccShape[] = []
  for (const wire of faceWires(oc, scope, face)) {
    const E = oc.TopAbs_ShapeEnum
    const exp = scope.track(new oc.TopExp_Explorer_2(wire, E.TopAbs_EDGE, E.TopAbs_SHAPE))
    const kept: OccSubShape[] = []
    for (; exp.More(); exp.Next()) {
      const edge = scope.track(oc.TopoDS.Edge_1(exp.Current())) as OccSubShape
      if (oc.BRep_Tool.IsClosed_2(edge, face)) continue
      if (oc.BRep_Tool.Degenerated(edge)) continue
      if (!kept.some((e) => e.IsSame(edge))) kept.push(edge)
    }
    if (kept.length === 0) continue
    // After the seam and pole edges are dropped the rest has to be a closed
    // loop on its own; a lollipop would mean this face is not a phase 1 shape.
    let loop: OccShape | null
    try {
      const ordered = chainLoop(oc, scope, kept)
      loop = ordered === null ? null : makeLoop(oc, scope, ordered)
    } catch (e) {
      swallowUnlessTrap(e)
      return null
    }
    if (loop === null) return null
    loops.push(scope.track(loop))
  }
  return loops
}

/** The re-seat candidate this face is, or null to leave it alone. */
function candidateFor(oc: OccModule, scope: DisposeScope, face: OccSubShape): SeamCandidate | null {
  const ad = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (!ad.IsUPeriodic()) return null
  const axis = mainAxis(oc, scope, ad)
  if (axis === null) return null
  const edges = faceEdges(oc, scope, face)
  const seamEdges = edges.filter((e) => oc.BRep_Tool.IsClosed_2(e, face))
  if (seamEdges.length === 0) return null
  const boundary = edges.filter(
    (e) => !oc.BRep_Tool.IsClosed_2(e, face) && !oc.BRep_Tool.Degenerated(e),
  )
  if (boundary.length === 0) return null
  const boundaryVertices = boundary.map((edge) => ({
    edge,
    vertices: edgeVertices(oc, scope, edge),
  }))
  if (!seamIsCut(oc, scope, seamEdges, boundaryVertices)) return null
  // Phase 1: a closed boundary edge is shared with a neighbouring face and its
  // vertex sits on the seam; moving that vertex is a topology rewrite, not a
  // seam re-seat.
  if (boundaryVertices.some(({ vertices }) => vertices.length === 1)) return null
  const angles = boundaryAngles(oc, scope, face, boundary)
  if (angles === null) return null
  const seamU = largestFreeGap(angles, MIN_SEAM_GAP)
  if (seamU === null) return null
  const innerWires = boundaryLoops(oc, scope, face)
  if (innerWires === null || innerWires.length === 0) return null
  return {
    face,
    axis,
    seamU,
    vRange: [ad.FirstVParameter(), ad.LastVParameter()],
    innerWires,
  }
}

/**
 * The face rebuilt on its own surface with u=0 at `seamU`: a full-period face
 * carrying the old boundary loops as inner wires, with the same material side.
 * A rotation about the surface's own axis leaves its normal field unchanged, so
 * the old face's orientation flag carries over unchanged.
 */
function rebuild(oc: OccModule, scope: DisposeScope, candidate: SeamCandidate): OccShape | null {
  const ad = scope.track(new oc.BRepAdaptor_Surface_2(candidate.face, true))
  // A full-period carrier of the same surface: BRep_Tool.Surface_2 hands back a
  // typed Handle(Geom_Surface), while Geom_Surface.Transformed returns
  // Handle(Geom_Geometry), which MakeFace cannot take.
  const oldHandle = scope.track(oc.BRep_Tool.Surface_2(candidate.face))
  const wholeMaker = scope.track(
    new oc.BRepBuilderAPI_MakeFace_14(
      oldHandle,
      ad.FirstUParameter(),
      ad.LastUParameter(),
      candidate.vRange[0],
      candidate.vRange[1],
      OCC_CONFUSION,
    ),
  )
  if (!wholeMaker.IsDone()) return null
  const whole = scope.track(wholeMaker.Face())
  const trsf = scope.track(new oc.gp_Trsf_1())
  trsf.SetRotation_1(
    scope.track(
      new oc.gp_Ax1_2(
        scope.track(
          new oc.gp_Pnt_3(
            candidate.axis.origin[0],
            candidate.axis.origin[1],
            candidate.axis.origin[2],
          ),
        ),
        scope.track(
          new oc.gp_Dir_5(candidate.axis.dir[0], candidate.axis.dir[1], candidate.axis.dir[2]),
        ),
      ),
    ),
    candidate.seamU,
  )
  const moved = scope.track(new oc.BRepBuilderAPI_Transform_2(whole, trsf, true, true)).Shape()
  const movedFace = scope.track(oc.TopoDS.Face_1(moved))
  const rotated = scope.track(oc.BRep_Tool.Surface_2(movedFace))
  const maker = scope.track(
    new oc.BRepBuilderAPI_MakeFace_14(
      rotated,
      0,
      PERIOD,
      candidate.vRange[0],
      candidate.vRange[1],
      OCC_CONFUSION,
    ),
  )
  if (!maker.IsDone()) return null
  for (const wire of candidate.innerWires) maker.Add(wire)
  const fixer = scope.track(new oc.ShapeFix_Face_2(scope.track(maker.Face())))
  // Perform builds the pcurves on the rotated surface; FixOrientation only
  // succeeds afterwards (it throws on the bare full-period face in this build)
  // and changes nothing the Perform face did not already have.
  fixer.Perform(noProgress(oc))
  let face = scope.track(fixer.Face() as OccSubShape)
  try {
    fixer.FixOrientation_1()
    const oriented = scope.track(fixer.Face() as OccSubShape)
    if (!oriented.IsSame(face)) face = oriented
  } catch (e) {
    swallowUnlessTrap(e)
  }
  if (isReversed(oc, candidate.face)) {
    face = scope.track((face as unknown as OccOrientableShape).Reversed() as OccSubShape)
  }
  return face
}

export function reseatSeams(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  // The pass reads no options: the free-gap floor is the seam rule's own.
  _options: PassOptions = {},
): PassResult {
  const identity = unchanged(shape)
  try {
    const candidates: SeamCandidate[] = []
    for (const face of faces(oc, scope, shape)) {
      try {
        const candidate = candidateFor(oc, scope, face)
        if (candidate) candidates.push(candidate)
      } catch (e) {
        swallowUnlessTrap(e)
        // A face that cannot be read is left as it is; the others still run.
      }
    }
    if (candidates.length === 0) return identity

    const reshape = scope.track(new oc.BRepTools_ReShape())
    const swaps: Array<{ from: OccSubShape; to: OccSubShape }> = []
    for (const candidate of candidates) {
      try {
        const rebuilt = rebuild(oc, scope, candidate)
        if (!rebuilt) continue
        reshape.Replace(candidate.face, rebuilt)
        swaps.push({ from: candidate.face, to: rebuilt as OccSubShape })
      } catch (e) {
        swallowUnlessTrap(e)
        // Best effort per face: the others still move.
      }
    }
    if (swaps.length === 0) return identity

    const E = oc.TopAbs_ShapeEnum
    const substituted = scope.track(reshape.Apply(shape, E.TopAbs_FACE))
    const healer = scope.track(new oc.ShapeFix_Shape_2(substituted))
    healer.Perform(noProgress(oc))
    const healed = scope.track(healer.Shape())

    let context: OccReShape | null = null
    try {
      context = scope.track(healer.Context()).get()
      if (context) {
        for (const swap of swaps) {
          swap.to = scope.track(context.Apply(swap.to, E.TopAbs_SHAPE)) as OccSubShape
        }
      }
    } catch (e) {
      swallowUnlessTrap(e)
      // Best effort: an unmapped swap degrades lineage on that face, not
      // geometry.
    }
    const ctx = context
    const rebase = (s: OccSubShape): OccSubShape => {
      const swap = swaps.find((sw) => sw.from.IsSame(s))
      if (swap) return swap.to
      if (!ctx) return s
      try {
        return scope.track(ctx.Apply(s, E.TopAbs_SHAPE)) as OccSubShape
      } catch (e) {
        swallowUnlessTrap(e)
        return s
      }
    }

    return { shape: scope.detach(healed), changed: true, rebase }
  } catch (e) {
    swallowUnlessTrap(e)
    // Recognition and rebuild are best effort: the un-re-seated result is a
    // sound solid, it just keeps the split.
    return identity
  }
}
