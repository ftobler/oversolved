/**
 * The analytic-surface half of move-face: one descriptor per surface kind, so
 * the direct tweak reads the moved surface, its target face and its outside
 * solid through one interface instead of branching on the surface type. The
 * slab and cell classifier the old route needed were deleted with it.
 *
 * The meaning of a move is the same on every kind: the picked face moves by the
 * signed distance `d` along its own OUTWARD normal. On a curved face "along its
 * own normal" is a uniform offset of the surface. With `s` = +1 for a FORWARD
 * face and -1 for REVERSED (so a positive distance always adds material: a boss
 * wall grows, a bore wall moves toward its axis):
 *
 *   cylinder | radius r -> r + s*d, same axis
 *   cone     | ref radius R -> R + s*d/cos(semi), same axis and half-angle (a
 *            | parallel cone; the apex shifts along the axis)
 *   sphere   | radius r -> r + s*d, same centre
 *   torus    | minor radius r -> r + s*d, same axis and major radius
 *
 * The cone's `1/cos(semi)` is not a typo either: the gp_Cone ref radius is
 * measured on the plane through the frame origin, not perpendicular to the
 * surface, so a normal-distance move changes it by d/cos(semi). The direct
 * tweak's analytic volumes pin the sign.
 *
 * The inward move uses the outside solid below: a solid covering the OUTSIDE of
 * the moved surface, and the tool face on the moved surface that becomes the
 * cap. `defeatureWedge.ts` also uses `extendedNeighbourSolid` for a support
 * face.
 */

import type { DisposeScope } from './disposeScope'
import type {
  OccAnalyticCone,
  OccAnalyticCylinder,
  OccAnalyticSphere,
  OccAnalyticTorus,
  OccAxisDir,
  OccAx3,
  OccDisposable,
  OccModule,
  OccShape,
  OccSurfaceAdaptor,
} from './occTypes'
import { canonicalFaces } from './partNames'
import { faceCentroid, faceNormal, makeBoxAt, makeCylinderWithFaces, shapeBndBox } from './primitives'
import {
  FACE_CLASSIFIER_GAP_CHECK_TOL,
  FACE_CLASSIFIER_USE_BND_BOX,
  MESH_PURPOSE_NONE,
  noProgress,
} from './defaultArgs'
import { TOL_LENGTH_SLACK, TOL_SURFACE_IDENTITY, TOL_SURFACE_PARALLEL } from '../solverConstants'
import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'
import { makeHalfSpaceBox } from './halfSpace'
import { rungCatalog } from './moveFaceRungs'

/** A guard refusal. The message reaches the user through the feature failure
 *  path, so it names the geometry that blocked the move. */
export class MoveFaceRefusal extends Error {}

/** The surface kinds move face can offset. */
export type MoveSurfaceKind = 'plane' | 'cylinder' | 'cone' | 'sphere' | 'torus'

/** A point ON a face plus the face's outward normal there. */
export interface FaceAnchor {
  point: Vec3
  normal: Vec3
}

export interface MovedSurface {
  kind: MoveSurfaceKind
  // The handle anchor: a point ON the face plus the outward normal there.
  anchor(): FaceAnchor
  // The tweak's large face on the moved surface S_d.
  targetFace(L: number): OccShape
  // The Geom_Surface of S_d. The caller owns (tracks) the handle.
  targetSurface(): OccDisposable
  // A solid covering the OUTSIDE of S_d (the boundaryless inward cutter), and
  // the tool face that lies on S_d, which becomes the moved face.
  outsideSolid(part: OccShape, L: number): { tool: OccShape; cap: OccShape }
}

// Surface-identity tolerances live on the ladder in solverConstants. This
// module used to carry private copies of them: three instances of the 1e-6
// rung (analytic surface distance, the shipped planar on-plane distance
// `onPickedPlane` before the refactor, and the parameter-space test) and its
// angular companion at 1e-9. The parameter-space test stays tight on purpose:
// a projected point's own residual (up to the mesh deflection, stretched by
// tan(semi) on a cone's slant) is far below the piece's own size, and a point
// near a wire classifies ON either way.

/** The mesh deflection [[representativePoints]] triangulates a face with. A
 *  curved triangle's centroid sits off the surface by up to this much, which is
 *  why a curved region's point test goes through the surface's own parameter
 *  space rather than a 3D distance. */
export const MOVE_FACE_MESH_TOL = 0.05

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])

// ─── face readers ───

export function faceSurfaceName(oc: OccModule, scope: DisposeScope, face: OccShape): string {
  const t = scope.track(new oc.BRepAdaptor_Surface_2(face, true)).GetType().value
  const S = oc.GeomAbs_SurfaceType
  // Only the GeomAbs_* members are values: embind also hangs `values` (the
  // value-by-number table) and `argCount` (undefined) off every enum.
  for (const [name, v] of Object.entries(S) as [string, { value: number } | undefined][]) {
    if (name.startsWith('GeomAbs_') && v?.value === t) return name.replace(/^GeomAbs_/, '')
  }
  return `type ${t}`
}

// The take* readers own the by-value gp_* proxy they read: each accessor hands
// back a fresh embind object, so a caller passing `axis.Axis()` straight in must
// not also track it (the proxy would then live in the scope for the whole
// solve, one per match).

function takeAxisDir(axis: OccAxisDir): Vec3 {
  const d = axis.Direction()
  const out: Vec3 = [d.X(), d.Y(), d.Z()]
  d.delete()
  axis.delete()
  return out
}

/** The 8 corners of a shape's axis-aligned bounding box. */
function bboxCorners(oc: OccModule, scope: DisposeScope, shape: OccShape): Vec3[] {
  const box = scope.track(new oc.Bnd_Box_1())
  oc.BRepBndLib.Add(shape, box, false)
  const x0 = box.GetXMin(); const x1 = box.GetXMax()
  const y0 = box.GetYMin(); const y1 = box.GetYMax()
  const z0 = box.GetZMin(); const z1 = box.GetZMax()
  const out: Vec3[] = []
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) out.push([x, y, z])
  return out
}

/** The face's extent along `dir`, measured from `origin`. */
function axialRange(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  origin: Vec3,
  dir: Vec3,
): { lo: number; hi: number } {
  let lo = Infinity
  let hi = -Infinity
  for (const c of bboxCorners(oc, scope, face)) {
    const t = dot(sub(c, origin), dir)
    lo = Math.min(lo, t)
    hi = Math.max(hi, t)
  }
  return { lo, hi }
}

/** A gp_Ax2 at `origin` along `dir`, the frame the primitive builders take. */
function baseFrame(oc: OccModule, scope: DisposeScope, origin: Vec3, dir: Vec3): OccDisposable {
  return scope.track(
    new oc.gp_Ax2_4(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_5(dir[0], dir[1], dir[2])),
    ),
  )
}

/** The same frame with the surface's own X direction, so a solid built on it
 *  shares the surface parameterisation (and seam) with the body face. */
function surfaceFrame(
  oc: OccModule,
  scope: DisposeScope,
  origin: Vec3,
  dir: Vec3,
  xDir: Vec3,
): OccDisposable {
  return scope.track(
    new oc.gp_Ax2_2(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_5(dir[0], dir[1], dir[2])),
      scope.track(new oc.gp_Dir_5(xDir[0], xDir[1], xDir[2])),
    ),
  )
}

function cutShapes(oc: OccModule, scope: DisposeScope, target: OccShape, tool: OccShape): OccShape {
  const algo = scope.track(new oc.BRepAlgoAPI_Cut_1())
  const args = scope.track(new oc.TopTools_ListOfShape_1())
  args.Append_1(target)
  const tools = scope.track(new oc.TopTools_ListOfShape_1())
  tools.Append_1(tool)
  algo.SetArguments(args)
  algo.SetTools(tools)
  algo.Build(noProgress(oc))
  return scope.track(algo.Shape())
}

const TWO_PI = 2 * Math.PI

/** A cube of half-side `diagonal + L` about the body's bbox centre: the
 *  finite stand-in for "all of space" the inward cutter is built inside. */
function bigBoxAround(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  L: number,
): OccShape {
  const { centre, diagonal } = shapeBndBox(oc, scope, part)
  const half = diagonal + L
  return scope.track(makeBoxAt(
    oc,
    scope,
    [centre[0] - half, centre[1] - half, centre[2] - half],
    2 * half,
    2 * half,
    2 * half,
  ))
}

/** The one face of `shape` lying on `target`'s surface, or a refusal: the
 *  inward cutter's cap has to be named before the cut, so a tool that lost it
 *  must not proceed silently. */
function faceOnSurface(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  target: OccShape,
): OccShape {
  for (const f of canonicalFaces(oc, scope, shape) as OccShape[]) {
    if (sameAnalyticSurface(oc, scope, f, target)) return f
  }
  throw new MoveFaceRefusal('move_face: the inward cutter has no face on the moved surface')
}

/** A full cone frustum over the body's axial span, for the cone's outside
 *  solid. `ref` is the target surface's ref radius at the frame origin. */
function coneOutside(
  oc: OccModule,
  scope: DisposeScope,
  part: OccShape,
  loc: Vec3,
  dir: Vec3,
  semi: number,
  ref: number,
  L: number,
): OccShape {
  const range = axialRange(oc, scope, part, loc, dir)
  const cos = Math.cos(semi)
  const shape = coneFrustum(
    oc,
    scope,
    loc,
    dir,
    semi,
    ref,
    range.lo / cos - L,
    range.hi / cos + L,
  )
  if (shape === null) throw new MoveFaceRefusal('move_face: the cone cutter is empty')
  return shape
}

/** One internal point per piece of a face: a mesh triangle centroid. A face
 *  centroid can sit in a hole of an annulus; a triangle centroid cannot. */
export function representativePoints(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): Vec3[] {
  const mesher = scope.track(new oc.BRepMesh_IncrementalMesh_2(face, MOVE_FACE_MESH_TOL, false, 0.3, false))
  void mesher
  const loc = scope.track(new oc.TopLoc_Location_1())
  const handle = scope.track(oc.BRep_Tool.Triangulation(face, loc, MESH_PURPOSE_NONE))
  if (handle.IsNull()) return []
  const tri = handle.get()
  if (tri === null) return []
  // A face placed by a TopLoc_Location stores its mesh in local coordinates;
  // transform each node to world so the centroid is classified in the body's
  // own space. Identity for the solids built here, non-identity for a placed
  // import.
  const trsf = scope.track(loc.Transformation())
  const out: Vec3[] = []
  for (let i = 1; i <= tri.NbTriangles(); i++) {
    const t = scope.track(tri.Triangle(i))
    const a = scope.track(tri.Node(t.Value(1)))
    const b = scope.track(tri.Node(t.Value(2)))
    const c = scope.track(tri.Node(t.Value(3)))
    a.Transform(trsf)
    b.Transform(trsf)
    c.Transform(trsf)
    out.push([(a.X() + b.X() + c.X()) / 3, (a.Y() + b.Y() + c.Y()) / 3, (a.Z() + b.Z() + c.Z()) / 3])
  }
  return out
}

/** Classify `p` against `face`: true when IN or ON. `tol` is the classifier's
 *  tolerance, so an off-surface mesh centroid still lands (see regionTol). */
export function pointInFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  p: Vec3,
  tol: number,
): boolean {
  const pnt = scope.track(new oc.gp_Pnt_3(p[0], p[1], p[2]))
  const classifier = scope.track(new oc.BRepClass_FaceClassifier_1())
  classifier.Perform_2(face, pnt, tol, FACE_CLASSIFIER_USE_BND_BOX, FACE_CLASSIFIER_GAP_CHECK_TOL)
  const state = classifier.State().value
  return state === oc.TopAbs_State.TopAbs_IN.value || state === oc.TopAbs_State.TopAbs_ON.value
}

/**
 * Classify a point already expressed in the surface's parameter space against
 * `face`'s wires (IN or ON). The 3D form projects first, which is unreliable on
 * a closed or periodic surface (an off-face point can project onto the wrong
 * branch and read IN), so the curved kinds project analytically and classify
 * here. `u` is an angle on every curved kind and the wires may sit on any 2π
 * lift of it; `v` is an angle only on a torus (on a cylinder or cone it is a
 * length, so a 2π shift there would wrap a far-away point into the face).
 */
export function pointInFaceUv(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  uv: [number, number],
  tol: number,
  vPeriodic: boolean,
): boolean {
  const twoPi = 2 * Math.PI
  for (const du of [0, -twoPi, twoPi]) {
    for (const dv of vPeriodic ? [0, -twoPi, twoPi] : [0]) {
      const pnt = scope.track(new oc.gp_Pnt2d_3(uv[0] + du, uv[1] + dv))
      const classifier = scope.track(new oc.BRepClass_FaceClassifier_1())
      classifier.Perform_1(face, pnt, tol, FACE_CLASSIFIER_USE_BND_BOX, FACE_CLASSIFIER_GAP_CHECK_TOL)
      const state = classifier.State().value
      if (state === oc.TopAbs_State.TopAbs_IN.value || state === oc.TopAbs_State.TopAbs_ON.value) {
        return true
      }
    }
  }
  return false
}

/** A unit direction, normalised (the surface axes are unit already; this keeps
 *  the UV formulas honest). */
function unit(v: Vec3): Vec3 {
  const n = norm(v)
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : v
}

/** The surface frame (location + X/Y/Z axes) an analytic UV read needs. */
interface SurfaceFrame {
  origin: Vec3
  x: Vec3
  y: Vec3
  z: Vec3
}

/** The frame of a gp_Ax3; owns (deletes) `pos`. */
function takeAx3(pos: OccAx3): SurfaceFrame {
  const loc = pos.Location()
  const x = pos.XDirection()
  const y = pos.YDirection()
  const z = pos.Direction()
  const frame: SurfaceFrame = {
    origin: [loc.X(), loc.Y(), loc.Z()],
    x: unit([x.X(), x.Y(), x.Z()]),
    y: unit([y.X(), y.Y(), y.Z()]),
    z: unit([z.X(), z.Y(), z.Z()]),
  }
  loc.delete()
  x.delete()
  y.delete()
  z.delete()
  pos.delete()
  return frame
}

/** Two unit directions are parallel or antiparallel. */
function parallel(a: Vec3, b: Vec3): boolean {
  return norm(cross(a, b)) <= TOL_SURFACE_PARALLEL
}

/** The two axis lines coincide (parallel directions and no perpendicular gap). */
function sameAxisLine(dirA: Vec3, originA: Vec3, dirB: Vec3, originB: Vec3): boolean {
  if (!parallel(dirA, dirB)) return false
  return norm(cross(sub(originB, originA), dirA)) <= TOL_SURFACE_IDENTITY
}

function sameCylinder(a: OccAnalyticCylinder, b: OccAnalyticCylinder): boolean {
  if (Math.abs(a.Radius() - b.Radius()) > TOL_SURFACE_IDENTITY) return false
  return sameAxisLine(takeAxisDir(a.Axis()), takeAx3(a.Position()).origin, takeAxisDir(b.Axis()), takeAx3(b.Position()).origin)
}

function sameSphere(a: OccAnalyticSphere, b: OccAnalyticSphere): boolean {
  if (Math.abs(a.Radius() - b.Radius()) > TOL_SURFACE_IDENTITY) return false
  return norm(sub(takeAx3(a.Position()).origin, takeAx3(b.Position()).origin)) <= TOL_SURFACE_IDENTITY
}

function sameTorus(a: OccAnalyticTorus, b: OccAnalyticTorus): boolean {
  if (Math.abs(a.MajorRadius() - b.MajorRadius()) > TOL_SURFACE_IDENTITY) return false
  if (Math.abs(a.MinorRadius() - b.MinorRadius()) > TOL_SURFACE_IDENTITY) return false
  return sameAxisLine(takeAxisDir(a.Axis()), takeAx3(a.Position()).origin, takeAxisDir(b.Axis()), takeAx3(b.Position()).origin)
}

/** The cone's apex, the point on the axis where its radius reaches zero. */
function coneApex(cone: OccAnalyticCone): Vec3 {
  const semi = cone.SemiAngle()
  const ref = cone.RefRadius()
  const frame = takeAx3(cone.Position())
  return add(frame.origin, scale(frame.z, -ref / Math.tan(semi)))
}

function sameCone(a: OccAnalyticCone, b: OccAnalyticCone): boolean {
  if (Math.abs(a.SemiAngle() - b.SemiAngle()) > TOL_SURFACE_IDENTITY) return false
  if (norm(sub(coneApex(a), coneApex(b))) > TOL_SURFACE_IDENTITY) return false
  return sameAxisLine(takeAxisDir(a.Axis()), takeAx3(a.Position()).origin, takeAxisDir(b.Axis()), takeAx3(b.Position()).origin)
}

/**
 * Do two faces lie on the same analytic surface? Used to map a cell's lateral
 * piece onto the extended tool face it lies on (the planar path also had a
 * centroid-in-face test; a curved piece's centroid sits off its surface, so the
 * analytic compare is the one that survives the tube slabs).
 */
export function sameAnalyticSurface(
  oc: OccModule,
  scope: DisposeScope,
  a: OccShape,
  b: OccShape,
): boolean {
  const ad = scope.track(new oc.BRepAdaptor_Surface_2(a, true))
  const bd = scope.track(new oc.BRepAdaptor_Surface_2(b, true))
  const S = oc.GeomAbs_SurfaceType
  const ta = ad.GetType().value
  const tb = bd.GetType().value
  if (ta !== tb) return false
  if (ta === S.GeomAbs_Plane.value) {
    const na = faceNormal(oc, scope, a)
    const nb = faceNormal(oc, scope, b)
    if (!parallel(na, nb)) return false
    return Math.abs(dot(sub(faceCentroid(oc, scope, b), faceCentroid(oc, scope, a)), na)) <= TOL_SURFACE_IDENTITY
  }
  if (ta === S.GeomAbs_Cylinder.value) return sameCylinder(scope.track(ad.Cylinder()), scope.track(bd.Cylinder()))
  if (ta === S.GeomAbs_Cone.value) return sameCone(scope.track(ad.Cone()), scope.track(bd.Cone()))
  if (ta === S.GeomAbs_Sphere.value) return sameSphere(scope.track(ad.Sphere()), scope.track(bd.Sphere()))
  if (ta === S.GeomAbs_Torus.value) return sameTorus(scope.track(ad.Torus()), scope.track(bd.Torus()))
  return false
}

// ─── neighbour split tools ───
function ball(oc: OccModule, scope: DisposeScope, centre: Vec3, radius: number): OccShape {
  const builder = scope.track(
    new oc.BRepPrimAPI_MakeSphere_5(scope.track(new oc.gp_Pnt_3(centre[0], centre[1], centre[2])), radius),
  )
  return scope.track(builder.Shape())
}

/** The solid torus of `minor` about `frame` with major radius `major`. */
function solidTorus(
  oc: OccModule,
  scope: DisposeScope,
  frame: OccDisposable,
  major: number,
  minor: number,
): OccShape {
  const builder = scope.track(new oc.BRepPrimAPI_MakeTorus_5(frame, major, minor))
  return scope.track(builder.Shape())
}

/** The solid cylinder from axial `lo` to `hi` about the axis `origin`+`dir`. */
function solidCylinder(
  oc: OccModule,
  scope: DisposeScope,
  origin: Vec3,
  dir: Vec3,
  lo: number,
  hi: number,
  radius: number,
  xDir?: Vec3,
): OccShape {
  const base = add(origin, scale(dir, lo))
  const frame = xDir ? surfaceFrame(oc, scope, base, dir, xDir) : baseFrame(oc, scope, base, dir)
  const builder = scope.track(new oc.BRepPrimAPI_MakeCylinder_3(frame, radius, hi - lo))
  return scope.track(builder.Shape())
}

/**
 * The frustum of one cone (`ref` radius at the frame origin, half-angle
 * `semi`) over the slant range [vLo, vHi], clipped at its own apex. Null when
 * the range lies entirely on the far side of the apex. The cone's own V
 * parameter runs along +dir and its point at V is
 * `loc + dir * V * cos(semi)` with radius `ref + V * sin(semi)`.
 */
function coneFrustum(
  oc: OccModule,
  scope: DisposeScope,
  loc: Vec3,
  dir: Vec3,
  semi: number,
  ref: number,
  vLo: number,
  vHi: number,
): OccShape | null {
  const sinSemi = Math.sin(semi)
  const cosSemi = Math.cos(semi)
  const apexV = -ref / sinSemi
  let a = vLo
  let b = vHi
  if (sinSemi > 0) a = Math.max(vLo, apexV)
  else b = Math.min(vHi, apexV)
  if (!(b - a > TOL_LENGTH_SLACK)) return null  // a frustum of slant slack or less is no solid
  const rLo = ref + a * sinSemi
  const rHi = ref + b * sinSemi
  if (rLo < -TOL_SURFACE_IDENTITY || rHi < -TOL_SURFACE_IDENTITY) return null
  const base = add(loc, scale(dir, a * cosSemi))
  const builder = scope.track(
    new oc.BRepPrimAPI_MakeCone_3(baseFrame(oc, scope, base, dir), Math.max(rLo, 0), Math.max(rHi, 0), (b - a) * cosSemi),
  )
  return scope.track(builder.Shape())
}

// ─── neighbour split tools ───

/**
 * A SOLID on `face`'s own surface that spans the slab, the splitter counterpart
 * of `extendNeighbourFace`. A full cylindrical or conical FACE is a closed
 * shell with no free boundary and OCCT's splitter leaves the argument whole
 * when it is the only tool; a solid on the same surface partitions the slab on
 * both sides. Planes need no solid: a bounded planar face cuts.
 */
export function extendedNeighbourSolid(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  L: number,
): OccShape | null {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  const S = oc.GeomAbs_SurfaceType
  if (t === S.GeomAbs_Cylinder.value) {
    const cyl = scope.track(adaptor.Cylinder())
    const dir = takeAxisDir(cyl.Axis())
    const srf = takeAx3(cyl.Position())
    const range = axialRange(oc, scope, face, srf.origin, dir)
    return solidCylinder(oc, scope, srf.origin, dir, range.lo - L, range.hi + L, cyl.Radius(), srf.x)
  }
  if (t === S.GeomAbs_Cone.value) {
    const cone = scope.track(adaptor.Cone())
    const semi = cone.SemiAngle()
    const srf = takeAx3(cone.Position())
    const range = axialRange(oc, scope, face, srf.origin, srf.z)
    const cos = Math.cos(semi)
    // The gp_Cone slant parameter is the axial coordinate over cos(semi).
    return coneFrustum(
      oc,
      scope,
      srf.origin,
      srf.z,
      semi,
      cone.RefRadius(),
      range.lo / cos - L,
      range.hi / cos + L,
    )
  }
  return null
}

// ─── the per-kind descriptors ───

function planeSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const n = faceNormal(oc, scope, face)
  const c0 = faceCentroid(oc, scope, face)
  const pTarget = add(c0, scale(n, d))
  // The target plane keeps the face's own X direction, so its U parameter and
  // pcurves stay in the same frame the picked face used.
  const plane = scope.track(adaptor.Plane())
  const position = scope.track(plane.Position())
  const xd = scope.track(position.XDirection())
  const pX: Vec3 = [xd.X(), xd.Y(), xd.Z()]
  const targetPlaneFace = (L: number): OccShape => {
    const frame = scope.track(new oc.gp_Ax3_3(
      scope.track(new oc.gp_Pnt_3(pTarget[0], pTarget[1], pTarget[2])),
      scope.track(new oc.gp_Dir_5(n[0], n[1], n[2])),
      scope.track(new oc.gp_Dir_5(pX[0], pX[1], pX[2])),
    ))
    const target = scope.track(new oc.gp_Pln_2(frame))
    const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_9(target, -L, L, -L, L))
    return scope.track(maker.Face())
  }
  return {
    kind: 'plane',
    anchor: () => ({ point: c0, normal: n }),
    targetFace: (L) => targetPlaneFace(L),
    targetSurface: () => scope.track(oc.BRep_Tool.Surface_2(targetPlaneFace(1))),
    outsideSolid: (part) => {
      const box = makeHalfSpaceBox(oc, scope, pTarget, n, part)
      return { tool: box.shape, cap: box.base }
    },
  }
}

function cylinderSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const cyl = scope.track(adaptor.Cylinder())
  const r = cyl.Radius()
  const dir = takeAxisDir(cyl.Axis())
  const srf = takeAx3(cyl.Position())
  const origin = srf.origin
  const range = axialRange(oc, scope, face, origin, dir)
  // Growing the radius means moving along the outward radial direction.
  const s = offsetSign(oc, scope, face, adaptor, (p) => radialFrom(p, origin, dir))
  const r2 = r + s * d
  const frame = (): OccDisposable => scope.track(new oc.gp_Ax3_3(
    scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
    scope.track(new oc.gp_Dir_5(dir[0], dir[1], dir[2])),
    scope.track(new oc.gp_Dir_5(srf.x[0], srf.x[1], srf.x[2])),
  ))
  const targetFace = (L: number): OccShape => {
    const cyl2 = scope.track(new oc.gp_Cylinder_2(frame(), r2))
    const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_10(cyl2, 0, TWO_PI, range.lo - L, range.hi + L))
    return scope.track(maker.Face())
  }
  return {
    kind: 'cylinder',
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    targetFace,
    targetSurface: () => scope.track(oc.BRep_Tool.Surface_2(targetFace(1))),
    outsideSolid: (part, L) => {
      const prange = axialRange(oc, scope, part, origin, dir)
      const lo = prange.lo - L
      const hi = prange.hi + L
      const base = add(origin, scale(dir, lo))
      const cylTool = makeCylinderWithFaces(oc, scope, base, dir, r2, hi - lo)
      if (s > 0) {
        // An outer wall: the outside is everything beyond the new radius.
        const tool = cutShapes(oc, scope, bigBoxAround(oc, scope, part, L), cylTool.shape)
        return { tool, cap: faceOnSurface(oc, scope, tool, targetFace(1)) }
      }
      // A bore: the outside is the new bore itself.
      return { tool: cylTool.shape, cap: cylTool.faces.lateral }
    },
  }
}

function coneSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const cone = scope.track(adaptor.Cone())
  const ref = cone.RefRadius()
  const semi = cone.SemiAngle()
  const srf = takeAx3(cone.Position())
  const loc = srf.origin
  const dir = srf.z
  const range = axialRange(oc, scope, face, loc, dir)
  // Growing the ref radius means moving along the cone's natural normal:
  // cos(semi) * radial - sin(semi) * axis.
  const s = offsetSign(oc, scope, face, adaptor, (p) =>
    sub(scale(radialFrom(p, loc, dir), Math.cos(semi)), scale(dir, Math.sin(semi))))
  const ref2 = ref + (s * d) / Math.cos(semi)
  // Past this the moved surface's radius at the frame plane is non-positive:
  // the parallel cone has passed its own apex, and the offset is no longer the
  // same nappe (the construction below would build the mirrored one). A move
  // that merely pushes the apex inside the face's extent is fine and clips.
  if (ref2 <= TOL_SURFACE_IDENTITY) {
    throw new MoveFaceRefusal('move_face: the move takes the cone past its apex')
  }
  // The gp_Cone V parameter runs along +dir (z = V cos(semi)), so the face's
  // axial span maps straight onto it.
  const cos = Math.cos(semi)
  const vA = range.lo / cos
  const vB = range.hi / cos
  const frame = (): OccDisposable => scope.track(new oc.gp_Ax3_3(
    scope.track(new oc.gp_Pnt_3(loc[0], loc[1], loc[2])),
    scope.track(new oc.gp_Dir_5(dir[0], dir[1], dir[2])),
    scope.track(new oc.gp_Dir_5(srf.x[0], srf.x[1], srf.x[2])),
  ))
  const targetFace = (L: number): OccShape => {
    const cone2 = scope.track(new oc.gp_Cone_2(frame(), semi, ref2))
    const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_11(cone2, 0, TWO_PI, vA - L, vB + L))
    return scope.track(maker.Face())
  }
  return {
    kind: 'cone',
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    targetFace,
    targetSurface: () => scope.track(oc.BRep_Tool.Surface_2(targetFace(1))),
    outsideSolid: (part, L) => {
      const coneTool = coneOutside(oc, scope, part, loc, dir, semi, ref2, L)
      if (s > 0) {
        const tool = cutShapes(oc, scope, bigBoxAround(oc, scope, part, L), coneTool)
        return { tool, cap: faceOnSurface(oc, scope, tool, targetFace(1)) }
      }
      return { tool: coneTool, cap: faceOnSurface(oc, scope, coneTool, targetFace(1)) }
    },
  }
}

function sphereSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const sph = scope.track(adaptor.Sphere())
  const r = sph.Radius()
  const srf = takeAx3(sph.Position())
  const centre = srf.origin
  // Growing the radius means moving away from the centre.
  const s = offsetSign(oc, scope, face, adaptor, (p) => sub(p, centre))
  const r2 = r + s * d
  const frame = (): OccDisposable => scope.track(new oc.gp_Ax3_3(
    scope.track(new oc.gp_Pnt_3(centre[0], centre[1], centre[2])),
    scope.track(new oc.gp_Dir_5(srf.z[0], srf.z[1], srf.z[2])),
    scope.track(new oc.gp_Dir_5(srf.x[0], srf.x[1], srf.x[2])),
  ))
  const targetFace = (): OccShape => {
    const sph2 = scope.track(new oc.gp_Sphere_2(frame(), r2))
    const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_6(sph2))
    return scope.track(maker.Face())
  }
  return {
    kind: 'sphere',
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    targetFace: () => targetFace(),
    targetSurface: () => scope.track(oc.BRep_Tool.Surface_2(targetFace())),
    outsideSolid: (part, L) => {
      const sphereTool = ball(oc, scope, centre, r2)
      if (s > 0) {
        const tool = cutShapes(oc, scope, bigBoxAround(oc, scope, part, L), sphereTool)
        return { tool, cap: faceOnSurface(oc, scope, tool, targetFace()) }
      }
      return { tool: sphereTool, cap: faceOnSurface(oc, scope, sphereTool, targetFace()) }
    },
  }
}

function torusSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const tor = scope.track(adaptor.Torus())
  const major = tor.MajorRadius()
  const minor = tor.MinorRadius()
  const srf = takeAx3(tor.Position())
  const loc = srf.origin
  const dir = srf.z
  // Growing the minor radius means moving away from the tube's centre circle.
  const s = offsetSign(oc, scope, face, adaptor, (p) =>
    sub(p, add(loc, scale(radialFrom(p, loc, dir), major))))
  const minor2 = minor + s * d
  // d === 0 is the anchor read (faceNormalAndCentroid): a pre-existing spindle
  // torus must not refuse there.
  if (d !== 0 && minor2 > major + TOL_SURFACE_IDENTITY) {
    throw new MoveFaceRefusal(
      `move_face: the move would take the torus tube past its major radius (minor ${minor2} > major ${major})`,
    )
  }
  const frameAx3 = (): OccDisposable => scope.track(new oc.gp_Ax3_3(
    scope.track(new oc.gp_Pnt_3(loc[0], loc[1], loc[2])),
    scope.track(new oc.gp_Dir_5(dir[0], dir[1], dir[2])),
    scope.track(new oc.gp_Dir_5(srf.x[0], srf.x[1], srf.x[2])),
  ))
  const targetFace = (): OccShape => {
    const tor2 = scope.track(new oc.gp_Torus_2(frameAx3(), major, minor2))
    const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_7(tor2))
    return scope.track(maker.Face())
  }
  return {
    kind: 'torus',
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    targetFace: () => targetFace(),
    targetSurface: () => scope.track(oc.BRep_Tool.Surface_2(targetFace())),
    outsideSolid: (part, L) => {
      const torusTool = solidTorus(oc, scope, frameAx3(), major, minor2)
      if (s > 0) {
        const tool = cutShapes(oc, scope, bigBoxAround(oc, scope, part, L), torusTool)
        return { tool, cap: faceOnSurface(oc, scope, tool, targetFace()) }
      }
      return { tool: torusTool, cap: faceOnSurface(oc, scope, torusTool, targetFace()) }
    },
  }
}

/** A point ON the face at its UV-domain midpoint. */
function uvMidPoint(oc: OccModule, scope: DisposeScope, adaptor: OccSurfaceAdaptor): Vec3 {
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  adaptor.D1(u, v, p, du, dv)
  return [p.X(), p.Y(), p.Z()]
}

/** A point ON the face at its UV-domain midpoint plus the outward normal there.
 *  A curved face's centroid can lie off the face (a full cylinder's centroid
 *  lies on its axis, where it has no normal), so the anchor is the midpoint. */
function uvAnchor(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  adaptor: OccSurfaceAdaptor,
): FaceAnchor {
  return { point: uvMidPoint(oc, scope, adaptor), normal: faceNormal(oc, scope, face) }
}

/**
 * The sign that takes the face's outward normal to the direction in which the
 * surface parameter grows (a bigger radius, a bigger ref radius). It is read
 * from the GEOMETRY, not the face's orientation flag: an extruded circle's
 * lateral face is REVERSED with the cylinder's frame pointing down the axis,
 * yet its outward normal is the radial one, and the orientation flag alone
 * would grow the body inward. `positive` is that parameter-growing direction at
 * `p` (unnormalised is fine).
 */
function offsetSign(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  adaptor: OccSurfaceAdaptor,
  positive: (p: Vec3) => Vec3,
): number {
  const n = faceNormal(oc, scope, face)
  return dot(n, positive(uvMidPoint(oc, scope, adaptor))) >= 0 ? 1 : -1
}

/** The radial unit direction from `axisPoint` toward `p` (perpendicular to
 *  `axisDir`). */
function radialFrom(p: Vec3, axisPoint: Vec3, axisDir: Vec3): Vec3 {
  const rel = sub(p, axisPoint)
  const radial = sub(rel, scale(axisDir, dot(rel, axisDir)))
  const len = norm(radial)
  return len > 0 ? scale(radial, 1 / len) : [0, 0, 0]
}

/**
 * The descriptor for `face`, or a refusal naming the surface kind it cannot
 * offset (a B-spline, Bezier, revolution, extrusion or offset surface).
 */
export function movedSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
): MovedSurface {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  const S = oc.GeomAbs_SurfaceType
  if (t === S.GeomAbs_Plane.value) return planeSurface(oc, scope, face, d, adaptor)
  if (t === S.GeomAbs_Cylinder.value) return cylinderSurface(oc, scope, face, d, adaptor)
  if (t === S.GeomAbs_Cone.value) return coneSurface(oc, scope, face, d, adaptor)
  if (t === S.GeomAbs_Sphere.value) return sphereSurface(oc, scope, face, d, adaptor)
  if (t === S.GeomAbs_Torus.value) return torusSurface(oc, scope, face, d, adaptor)
  throw new MoveFaceRefusal(
    `move_face: cannot move a ${faceSurfaceName(oc, scope, face)} face; the freeform picked-face route is not in this build. ` +
    `Rungs: ${rungCatalog(oc)}`,
  )
}
