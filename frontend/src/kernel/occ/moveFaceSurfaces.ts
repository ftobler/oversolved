/**
 * The analytic-surface half of move-face: one descriptor per surface kind, so
 * `moveFaceCells` builds its slab, classifies its cells and anchors its handle
 * through one interface instead of branching on the surface type.
 *
 * The meaning of a move is the same on every kind: the picked face moves by the
 * signed distance `d` along its own OUTWARD normal, the faces that bound it
 * extend along their own surfaces and the face may vanish when moved too far.
 * On a curved face "along its own normal" is a uniform offset of the surface.
 * With `s` = +1 for a FORWARD face and -1 for REVERSED (so a positive distance
 * always adds material: a boss wall grows, a bore wall moves toward its axis):
 *
 *   cylinder | radius r -> r + s*d, same axis
 *   cone     | ref radius R -> R + s*d/cos(semi), same axis and half-angle (a
 *            | parallel cone; the apex shifts along the axis)
 *   sphere   | radius r -> r + s*d, same centre
 *   torus    | minor radius r -> r + s*d, same axis and major radius
 *
 * The cone's `1/cos(semi)` is not a typo either: the gp_Cone ref radius is
 * measured on the plane through the frame origin, not perpendicular to the
 * surface, so a normal-distance move changes it by d/cos(semi). The analytic
 * volumes in occ/__tests__/moveFaceCurvedReal.test.ts pin the sign.
 *
 * The slab is the region between the source surface S and the target S_d, built
 * from the analytic primitives plus one boolean: the outer solid minus the
 * inner one. Where the moved surface collapses (a bore closes, a boss is
 * removed completely) the inner solid is omitted, so the face vanishes into a
 * full primitive. The planar slab is unchanged: a large face on the picked
 * plane swept by n*d.
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
import { canonicalFaces } from './bodyNames'
import { faceCentroid, faceNormal } from './primitives'
import { add, cross, dot, scale, sub, type Vec3 } from '@/utils/vec3'

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
  // The region between S and S_d as a solid, covering the face's extent and
  // padded by L.
  slab(L: number): OccShape
  // The cell face lies on S.
  onSource(cf: OccShape): boolean
  // The cell face lies on S_d (the moved surface).
  onTarget(cf: OccShape): boolean
  // A face on S bounded by `wire`, a classification region (one inner
  // hole/boss loop of the picked face).
  regionFace(wire: OccShape): OccShape
  // The face whose IN region covers the picked face's outer-wire area: the
  // picked face itself for a curved kind (its own classifier, which reports the
  // inner loops as OUT), the rebuilt outer-wire face for a plane (the shipped
  // path, whose rebuilt interior includes the loop regions).
  outerRegion(): OccShape
  // Is `p` (a point on S, within the mesh deflection) inside `region`?
  inRegion(region: OccShape, p: Vec3): boolean
  // The handle anchor: a point ON the face plus the outward normal there.
  anchor(): FaceAnchor
  // The enclosure guard: throws MoveFaceRefusal when the neighbours do not
  // bound the picked face over `cell`'s on-source pieces.
  assertEnclosed(
    cell: OccShape,
    sourceFaces: OccShape[],
    outerRegion: OccShape,
    innerFaces: OccShape[],
    L: number,
  ): void
}

/** Analytic surface identity: axis distance, radius, apex and centre compare.
 *  The same 1e-6 the shipped planar on-plane test uses. */
const SURFACE_TOL = 1e-6
/** Unit direction parallelism (|cross| of two unit vectors). */
const DIR_TOL = 1e-9
/** The shipped planar on-plane distance (`onPickedPlane` before the refactor). */
const PLANE_TOL = 1e-6

/** The mesh deflection [[representativePoints]] triangulates a face with. A
 *  curved triangle's centroid sits off the surface by up to this much, which is
 *  why a curved region's point test goes through the surface's own parameter
 *  space rather than a 3D distance. */
export const MOVE_FACE_MESH_TOL = 0.05

/** The parameter-space tolerance of the curved region classifier. The point
 *  arrives already projected, so this only decides "on the wire" versus
 *  "inside" and can stay tight: the projection's own residual (up to the mesh
 *  deflection, stretched by tan(semi) on a cone's slant) is far below the
 *  piece's own size, and a point near a wire classifies ON either way. */
const UV_TOL = 1e-6

const norm = (v: Vec3): number => Math.hypot(v[0], v[1], v[2])

// ─── face readers ───

export function faceSurfaceName(oc: OccModule, scope: DisposeScope, face: OccShape): string {
  const t = scope.track(new oc.BRepAdaptor_Surface_2(face, true)).GetType().value
  const S = oc.GeomAbs_SurfaceType
  for (const [name, v] of Object.entries(S) as [string, { value: number }][]) {
    if (v.value === t) return name.replace(/^GeomAbs_/, '')
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
  const x0 = box.GetXmin(); const x1 = box.GetXmax()
  const y0 = box.GetYmin(); const y1 = box.GetYmax()
  const z0 = box.GetZmin(); const z1 = box.GetZmax()
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
    new oc.gp_Ax2_3(
      scope.track(new oc.gp_Pnt_3(origin[0], origin[1], origin[2])),
      scope.track(new oc.gp_Dir_4(dir[0], dir[1], dir[2])),
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
  algo.Build()
  return scope.track(algo.Shape())
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
  const handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
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
  classifier.Perform_2(face, pnt, tol)
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
      classifier.Perform_1(face, pnt, tol)
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

/** The local coordinates of `p` in a surface frame. */
function localOf(frame: SurfaceFrame, p: Vec3): Vec3 {
  const rel = sub(p, frame.origin)
  return [dot(rel, frame.x), dot(rel, frame.y), dot(rel, frame.z)]
}

const wrapU = (u: number): number => ((u % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)

// ─── surface identity ───

/** Two unit directions are parallel or antiparallel. */
function parallel(a: Vec3, b: Vec3): boolean {
  return norm(cross(a, b)) <= DIR_TOL
}

/** The two axis lines coincide (parallel directions and no perpendicular gap). */
function sameAxisLine(dirA: Vec3, originA: Vec3, dirB: Vec3, originB: Vec3): boolean {
  if (!parallel(dirA, dirB)) return false
  return norm(cross(sub(originB, originA), dirA)) <= SURFACE_TOL
}

function sameCylinder(a: OccAnalyticCylinder, b: OccAnalyticCylinder): boolean {
  if (Math.abs(a.Radius() - b.Radius()) > SURFACE_TOL) return false
  return sameAxisLine(takeAxisDir(a.Axis()), takeAx3(a.Position()).origin, takeAxisDir(b.Axis()), takeAx3(b.Position()).origin)
}

function sameSphere(a: OccAnalyticSphere, b: OccAnalyticSphere): boolean {
  if (Math.abs(a.Radius() - b.Radius()) > SURFACE_TOL) return false
  return norm(sub(takeAx3(a.Position()).origin, takeAx3(b.Position()).origin)) <= SURFACE_TOL
}

function sameTorus(a: OccAnalyticTorus, b: OccAnalyticTorus): boolean {
  if (Math.abs(a.MajorRadius() - b.MajorRadius()) > SURFACE_TOL) return false
  if (Math.abs(a.MinorRadius() - b.MinorRadius()) > SURFACE_TOL) return false
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
  if (Math.abs(a.SemiAngle() - b.SemiAngle()) > SURFACE_TOL) return false
  if (norm(sub(coneApex(a), coneApex(b))) > SURFACE_TOL) return false
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
    return Math.abs(dot(sub(faceCentroid(oc, scope, b), faceCentroid(oc, scope, a)), na)) <= SURFACE_TOL
  }
  if (ta === S.GeomAbs_Cylinder.value) return sameCylinder(scope.track(ad.Cylinder()), scope.track(bd.Cylinder()))
  if (ta === S.GeomAbs_Cone.value) return sameCone(scope.track(ad.Cone()), scope.track(bd.Cone()))
  if (ta === S.GeomAbs_Sphere.value) return sameSphere(scope.track(ad.Sphere()), scope.track(bd.Sphere()))
  if (ta === S.GeomAbs_Torus.value) return sameTorus(scope.track(ad.Torus()), scope.track(bd.Torus()))
  return false
}

// ─── regions ───

/** A face on `wire`'s plane (the outer-wire region or an inner hole/boss loop). */
function planeFromWire(oc: OccModule, scope: DisposeScope, wire: OccShape): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(wire, true))
  if (!builder.IsDone()) throw new MoveFaceRefusal('move_face: a face loop could not be rebuilt as a planar face')
  return scope.track(builder.Face())
}

/** A face on a curved analytic surface with `wire` as its boundary, the curved
 *  counterpart of [[planeFromWire]]. The gp_* surface must be the face's own
 *  (its frame fixes the seam, which the wire's pcurves are written against).
 *  The maker only bounds the face by the wire's UV box; the ShapeFix_Face pass
 *  trims it to the wire (probed: without it the face classifies as the whole
 *  cylinder). */
function curvedFaceFromWire(
  oc: OccModule,
  scope: DisposeScope,
  kind: 'cylinder' | 'cone' | 'sphere' | 'torus',
  surface: OccDisposable,
  wire: OccShape,
): OccShape {
  const maker = kind === 'cylinder'
    ? scope.track(new oc.BRepBuilderAPI_MakeFace_17(surface, wire, true))
    : kind === 'cone'
      ? scope.track(new oc.BRepBuilderAPI_MakeFace_18(surface, wire, true))
      : kind === 'sphere'
        ? scope.track(new oc.BRepBuilderAPI_MakeFace_19(surface, wire, true))
        : scope.track(new oc.BRepBuilderAPI_MakeFace_20(surface, wire, true))
  if (!maker.IsDone()) {
    throw new MoveFaceRefusal(`move_face: a ${kind} face loop could not be rebuilt on its surface`)
  }
  const raw = scope.track(maker.Face())
  try {
    const fixer = scope.track(new oc.ShapeFix_Face_2(raw))
    fixer.FixOrientation_1()
    fixer.Perform()
    return scope.track(fixer.Face())
  } finally {
    raw.delete()
  }
}

// ─── slabs ───

function makePrism(
  oc: OccModule,
  scope: DisposeScope,
  profile: OccShape,
  dir: Vec3,
  distance: number,
): OccShape {
  const vec = scope.track(new oc.gp_Vec_4(dir[0] * distance, dir[1] * distance, dir[2] * distance))
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(profile, vec, true, true))
  return scope.track(builder.Shape())
}

/** The solid ball of `radius` about `centre`. */
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
): OccShape {
  const base = add(origin, scale(dir, lo))
  const builder = scope.track(new oc.BRepPrimAPI_MakeCylinder_3(baseFrame(oc, scope, base, dir), radius, hi - lo))
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
  if (!(b - a > 1e-9)) return null
  const rLo = ref + a * sinSemi
  const rHi = ref + b * sinSemi
  if (rLo < -SURFACE_TOL || rHi < -SURFACE_TOL) return null
  const base = add(loc, scale(dir, a * cosSemi))
  const builder = scope.track(
    new oc.BRepPrimAPI_MakeCone_3(baseFrame(oc, scope, base, dir), Math.max(rLo, 0), Math.max(rHi, 0), (b - a) * cosSemi),
  )
  return scope.track(builder.Shape())
}

/** The region between two parallel cones of the same half-angle: the outer
 *  (larger ref radius) solid minus the inner one, each stopped at its own apex. */
function coneSlab(
  oc: OccModule,
  scope: DisposeScope,
  loc: Vec3,
  dir: Vec3,
  semi: number,
  refs: [number, number],
  vLo: number,
  vHi: number,
): OccShape {
  const [inner, outer] = refs[0] <= refs[1] ? refs : [refs[1], refs[0]]
  const outerShape = coneFrustum(oc, scope, loc, dir, semi, outer, vLo, vHi)
  if (outerShape === null) throw new MoveFaceRefusal('move_face: the cone slab is empty')
  const innerShape = coneFrustum(oc, scope, loc, dir, semi, inner, vLo, vHi)
  if (innerShape === null) return outerShape
  return cutShapes(oc, scope, outerShape, innerShape)
}

// ─── the enclosure guards ───

/** A picked cell reaching the slab's lateral wall (u or v at +-L) is not
 *  enclosed by the neighbours: an open shell the analyse did not catch. */
function isUnbounded(
  oc: OccModule,
  scope: DisposeScope,
  cell: OccShape,
  origin: Vec3,
  xd: Vec3,
  yd: Vec3,
  L: number,
): boolean {
  const eps = 1e-6 * L
  for (const f of canonicalFaces(oc, scope, cell) as OccShape[]) {
    const c = faceCentroid(oc, scope, f)
    const rel = sub(c, origin)
    if (Math.abs(dot(rel, xd)) >= L - eps || Math.abs(dot(rel, yd)) >= L - eps) return true
  }
  return false
}

/** Every representative point of the cell's on-source pieces must classify
 *  inside the picked region (the picked face or an inner loop the hole/boss
 *  rule moves); a point outside means the neighbours did not cut the face's
 *  region off from the rest of the surface. */
function assertCurvedEnclosed(
  oc: OccModule,
  scope: DisposeScope,
  inRegion: (region: OccShape, p: Vec3) => boolean,
  sourceFaces: OccShape[],
  outerRegion: OccShape,
  innerFaces: OccShape[],
): void {
  for (const sf of sourceFaces) {
    for (const p of representativePoints(oc, scope, sf)) {
      if (inRegion(outerRegion, p)) continue
      if (innerFaces.some((loop) => inRegion(loop, p))) continue
      throw new MoveFaceRefusal('move_face: the neighbours do not bound the moved face')
    }
  }
}

// ─── the per-kind descriptors ───

function planeSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const S = oc.GeomAbs_SurfaceType
  const plane = scope.track(adaptor.Plane())
  const n = faceNormal(oc, scope, face)
  const c0 = faceCentroid(oc, scope, face)
  const pTarget = add(c0, scale(n, d))
  // The slab's lateral frame: +-L in the plane's own u/v, the guard's walls.
  const position = scope.track(plane.Position())
  const origin = scope.track(position.Location())
  const pOrigin: Vec3 = [origin.X(), origin.Y(), origin.Z()]
  const xd = scope.track(position.XDirection())
  const yd = scope.track(position.YDirection())
  const pX: Vec3 = [xd.X(), xd.Y(), xd.Z()]
  const pY: Vec3 = [yd.X(), yd.Y(), yd.Z()]
  const onPlane = (cf: OccShape, through: Vec3): boolean => {
    const other = scope.track(new oc.BRepAdaptor_Surface_2(cf, true))
    if (other.GetType().value !== S.GeomAbs_Plane.value) return false
    return Math.abs(dot(sub(faceCentroid(oc, scope, cf), through), n)) <= PLANE_TOL
  }
  return {
    kind: 'plane',
    inRegion: (region, p) => pointInFace(oc, scope, region, p, PLANE_TOL),
    slab: (L) => makePrism(oc, scope, scope.track(new oc.BRepBuilderAPI_MakeFace_9(plane, -L, L, -L, L).Face()), n, d),
    onSource: (cf) => onPlane(cf, c0),
    onTarget: (cf) => onPlane(cf, pTarget),
    regionFace: (wire) => planeFromWire(oc, scope, wire),
    outerRegion: () => planeFromWire(oc, scope, scope.track(oc.BRepTools.OuterWire(face))),
    anchor: () => ({ point: c0, normal: n }),
    assertEnclosed: (cell, _sourceFaces, _outerRegion, _innerFaces, L) => {
      if (isUnbounded(oc, scope, cell, pOrigin, pX, pY, L)) {
        throw new MoveFaceRefusal('move_face: the neighbours do not bound the moved face')
      }
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
  const S = oc.GeomAbs_SurfaceType
  const cyl = scope.track(adaptor.Cylinder())
  const r = cyl.Radius()
  const dir = takeAxisDir(cyl.Axis())
  const srf = takeAx3(cyl.Position())
  const origin = srf.origin
  const range = axialRange(oc, scope, face, origin, dir)
  // Growing the radius means moving along the outward radial direction.
  const s = offsetSign(oc, scope, face, adaptor, (p) => radialFrom(p, origin, dir))
  const r2 = r + s * d
  const matches = (cf: OccShape, want: number): boolean => {
    const other = scope.track(new oc.BRepAdaptor_Surface_2(cf, true))
    if (other.GetType().value !== S.GeomAbs_Cylinder.value) return false
    const oc2 = scope.track(other.Cylinder())
    if (Math.abs(oc2.Radius() - want) > SURFACE_TOL) return false
    return sameAxisLine(takeAxisDir(oc2.Axis()), takeAx3(oc2.Position()).origin, dir, origin)
  }
  // v is the axial coordinate, u the angle about the Position frame's X axis.
  const uv = (p: Vec3): [number, number] => {
    const l = localOf(srf, p)
    return [wrapU(Math.atan2(l[1], l[0])), l[2]]
  }
  const inRegion = (region: OccShape, p: Vec3): boolean => pointInFaceUv(oc, scope, region, uv(p), UV_TOL, false)
  return {
    kind: 'cylinder',
    inRegion,
    slab: (L) => {
      const lo = range.lo - L
      const hi = range.hi + L
      const outerR = Math.max(r, r2)
      const innerR = Math.min(r, r2)
      const outer = solidCylinder(oc, scope, origin, dir, lo, hi, outerR)
      if (innerR <= SURFACE_TOL) return outer
      return cutShapes(oc, scope, outer, solidCylinder(oc, scope, origin, dir, lo, hi, innerR))
    },
    onSource: (cf) => matches(cf, r),
    onTarget: (cf) => matches(cf, r2),
    regionFace: (wire) => curvedFaceFromWire(oc, scope, 'cylinder', cyl, wire),
    outerRegion: () => face,
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    assertEnclosed: (_cell, sourceFaces, outerRegion, innerFaces, _L) =>
      assertCurvedEnclosed(oc, scope, inRegion, sourceFaces, outerRegion, innerFaces),
  }
}

function coneSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const S = oc.GeomAbs_SurfaceType
  const cone = scope.track(adaptor.Cone())
  const ref = cone.RefRadius()
  const semi = cone.SemiAngle()
  const srf = takeAx3(cone.Position())
  const loc = srf.origin
  const dir = srf.z
  const axisDir = takeAxisDir(cone.Axis())
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
  if (ref2 <= SURFACE_TOL) {
    throw new MoveFaceRefusal('move_face: the move takes the cone past its apex')
  }
  // The gp_Cone V parameter runs along +dir (z = V cos(semi)), so the face's
  // axial span maps straight onto it.
  const cos = Math.cos(semi)
  const vA = range.lo / cos
  const vB = range.hi / cos
  const matches = (cf: OccShape, wantRef: number): boolean => {
    const other = scope.track(new oc.BRepAdaptor_Surface_2(cf, true))
    if (other.GetType().value !== S.GeomAbs_Cone.value) return false
    const otherCone = scope.track(other.Cone())
    if (Math.abs(otherCone.SemiAngle() - semi) > SURFACE_TOL) return false
    const wantApex = add(loc, scale(dir, -wantRef / Math.tan(semi)))
    if (norm(sub(coneApex(otherCone), wantApex)) > SURFACE_TOL) return false
    return sameAxisLine(takeAxisDir(otherCone.Axis()), takeAx3(otherCone.Position()).origin, axisDir, loc)
  }
  // v is the slant parameter (the gp_Cone Value convention: z = v cos(semi)),
  // u the angle about the Position frame's X axis.
  const uv = (p: Vec3): [number, number] => {
    const l = localOf(srf, p)
    return [wrapU(Math.atan2(l[1], l[0])), l[2] / Math.cos(semi)]
  }
  const inRegion = (region: OccShape, p: Vec3): boolean => pointInFaceUv(oc, scope, region, uv(p), UV_TOL, false)
  return {
    kind: 'cone',
    inRegion,
    slab: (L) => coneSlab(oc, scope, loc, dir, semi, [ref, ref2], vA - L, vB + L),
    onSource: (cf) => matches(cf, ref),
    onTarget: (cf) => matches(cf, ref2),
    regionFace: (wire) => curvedFaceFromWire(oc, scope, 'cone', cone, wire),
    outerRegion: () => face,
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    assertEnclosed: (_cell, sourceFaces, outerRegion, innerFaces, _L) =>
      assertCurvedEnclosed(oc, scope, inRegion, sourceFaces, outerRegion, innerFaces),
  }
}

function sphereSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const S = oc.GeomAbs_SurfaceType
  const sph = scope.track(adaptor.Sphere())
  const r = sph.Radius()
  const srf = takeAx3(sph.Position())
  const centre = srf.origin
  // Growing the radius means moving away from the centre.
  const s = offsetSign(oc, scope, face, adaptor, (p) => sub(p, centre))
  const r2 = r + s * d
  const matches = (cf: OccShape, want: number): boolean => {
    const other = scope.track(new oc.BRepAdaptor_Surface_2(cf, true))
    if (other.GetType().value !== S.GeomAbs_Sphere.value) return false
    const otherSph = scope.track(other.Sphere())
    if (Math.abs(otherSph.Radius() - want) > SURFACE_TOL) return false
    return norm(sub(takeAx3(otherSph.Position()).origin, centre)) <= SURFACE_TOL
  }
  // v is the polar angle from the equator, u the angle about the frame's X.
  const uv = (p: Vec3): [number, number] => {
    const l = localOf(srf, p)
    const sinV = Math.max(-1, Math.min(1, l[2] / r))
    return [wrapU(Math.atan2(l[1], l[0])), Math.asin(sinV)]
  }
  const inRegion = (region: OccShape, p: Vec3): boolean => pointInFaceUv(oc, scope, region, uv(p), UV_TOL, false)
  return {
    kind: 'sphere',
    inRegion,
    slab: () => {
      const outer = ball(oc, scope, centre, Math.max(r, r2))
      const innerR = Math.min(r, r2)
      if (innerR <= SURFACE_TOL) return outer
      return cutShapes(oc, scope, outer, ball(oc, scope, centre, innerR))
    },
    onSource: (cf) => matches(cf, r),
    onTarget: (cf) => matches(cf, r2),
    regionFace: (wire) => curvedFaceFromWire(oc, scope, 'sphere', sph, wire),
    outerRegion: () => face,
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    assertEnclosed: (_cell, sourceFaces, outerRegion, innerFaces, _L) =>
      assertCurvedEnclosed(oc, scope, inRegion, sourceFaces, outerRegion, innerFaces),
  }
}

function torusSurface(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  d: number,
  adaptor: OccSurfaceAdaptor,
): MovedSurface {
  const S = oc.GeomAbs_SurfaceType
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
  const axisDir = takeAxisDir(tor.Axis())
  // d === 0 is the anchor read (faceNormalAndCentroid): a pre-existing spindle
  // torus must not refuse there.
  if (d !== 0 && minor2 > major + SURFACE_TOL) {
    throw new MoveFaceRefusal(
      `move_face: the move would take the torus tube past its major radius (minor ${minor2} > major ${major})`,
    )
  }
  const matches = (cf: OccShape, want: number): boolean => {
    const other = scope.track(new oc.BRepAdaptor_Surface_2(cf, true))
    if (other.GetType().value !== S.GeomAbs_Torus.value) return false
    const otherTor = scope.track(other.Torus())
    if (Math.abs(otherTor.MajorRadius() - major) > SURFACE_TOL) return false
    if (Math.abs(otherTor.MinorRadius() - want) > SURFACE_TOL) return false
    return sameAxisLine(takeAxisDir(otherTor.Axis()), takeAx3(otherTor.Position()).origin, axisDir, loc)
  }
  const frame = baseFrame(oc, scope, loc, dir)
  // u is the angle about the axis, v the tube angle measured from the outer
  // equator (the gp_Torus Value convention).
  const uv = (p: Vec3): [number, number] => {
    const l = localOf(srf, p)
    return [wrapU(Math.atan2(l[1], l[0])), Math.atan2(l[2], Math.hypot(l[0], l[1]) - major)]
  }
  const inRegion = (region: OccShape, p: Vec3): boolean => pointInFaceUv(oc, scope, region, uv(p), UV_TOL, true)
  return {
    kind: 'torus',
    inRegion,
    slab: () => {
      const outer = solidTorus(oc, scope, frame, major, Math.max(minor, minor2))
      const innerR = Math.min(minor, minor2)
      if (innerR <= SURFACE_TOL) return outer
      return cutShapes(oc, scope, outer, solidTorus(oc, scope, frame, major, innerR))
    },
    onSource: (cf) => matches(cf, minor),
    onTarget: (cf) => matches(cf, minor2),
    regionFace: (wire) => curvedFaceFromWire(oc, scope, 'torus', tor, wire),
    outerRegion: () => face,
    anchor: () => uvAnchor(oc, scope, face, adaptor),
    assertEnclosed: (_cell, sourceFaces, outerRegion, innerFaces, _L) =>
      assertCurvedEnclosed(oc, scope, inRegion, sourceFaces, outerRegion, innerFaces),
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
    `move_face: cannot move a ${faceSurfaceName(oc, scope, face)} face; move face offsets plane, cylinder, cone, sphere and torus surfaces only`,
  )
}
