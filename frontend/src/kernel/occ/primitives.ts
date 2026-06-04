/**
 * Port of `ocp_ops.py` (the make-a-body + tessellation slice): the thin OCC.js
 * adapter. Per the migration plan this is the ONLY module that touches OCC.js
 * types directly; everything above it (shapes.ts, tessellation.ts) calls these.
 *
 * Every function takes a [[DisposeScope]] and tracks its transient OCC objects
 * (points, dirs, builders, adaptors) in it. Functions that produce a shape the
 * caller keeps return it WITHOUT tracking it, so the caller decides its
 * lifetime (typically `HandleTable.register`); the scope still owns the builder
 * that made it. This mirrors the spike's proven ownership pattern.
 *
 * Overload suffixes and arities were verified against opencascade.js@1.1.1
 * (OCC 7.5); see the migration notes. Out-parameter APIs (BRepTools.UVBounds,
 * BRepGProp_Face.Normal) do not marshal in emscripten, so UV bounds come from
 * BRepAdaptor_Surface's First/Last parameter accessors and the normal from
 * BRepLProp_SLProps, both direct-return.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccOrientedShape } from './occTypes'

export type Vec3 = [number, number, number]

// --- primitive solids -----------------------------------------------------

export function makeBox(oc: OccModule, scope: DisposeScope, dx: number, dy: number, dz: number): OccShape {
  const builder = scope.track(new oc.BRepPrimAPI_MakeBox_1(dx, dy, dz))
  return builder.Shape()
}

export function makeCylinder(
  oc: OccModule,
  scope: DisposeScope,
  center: Vec3,
  axis: Vec3,
  radius: number,
  height: number,
): OccShape {
  // gp_Ax2(location, mainDirection) -- the 2-arg form, matching
  // ocp_make_cylinder; the X reference direction is chosen by OCC.
  const ax2 = scope.track(
    new oc.gp_Ax2_3(
      scope.track(new oc.gp_Pnt_3(center[0], center[1], center[2])),
      scope.track(new oc.gp_Dir_4(axis[0], axis[1], axis[2])),
    ),
  )
  const builder = scope.track(new oc.BRepPrimAPI_MakeCylinder_3(ax2, radius, height))
  return builder.Shape()
}

// --- profile -> face -> prism ---------------------------------------------

/** A straight edge between two world points (cadquery Edge.makeLine). */
export function makeLineEdge(oc: OccModule, scope: DisposeScope, start: Vec3, end: Vec3): OccShape {
  const a = scope.track(new oc.gp_Pnt_3(start[0], start[1], start[2]))
  const b = scope.track(new oc.gp_Pnt_3(end[0], end[1], end[2]))
  const builder = scope.track(new oc.BRepBuilderAPI_MakeEdge_3(a, b))
  return builder.Edge()
}

/** Assemble ordered edges into a wire (BRepBuilderAPI_MakeWire). */
export function makeWire(oc: OccModule, scope: DisposeScope, edges: OccShape[]): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeWire_1())
  for (const e of edges) builder.Add_1(e)
  return builder.Wire()
}

/**
 * Planar face from an outer wire (+ optional hole wires), with the same
 * ShapeFix_Face.FixOrientation pass as `ocp_make_face_from_wire` so the face
 * normal sign matches Python.
 */
export function makeFaceFromWire(
  oc: OccModule,
  scope: DisposeScope,
  outerWire: OccShape,
  holeWires: OccShape[] = [],
): OccShape {
  const builder = scope.track(new oc.BRepBuilderAPI_MakeFace_15(outerWire, true))
  const raw = builder.Face()
  void holeWires // hole wires need MakeFace.Add (a later shard); planar profiles only here
  const fixer = scope.track(new oc.ShapeFix_Face_2(raw))
  fixer.FixOrientation_1()
  fixer.Perform()
  return fixer.Face()
}

/** Linear extrusion of a face along direction * distance (ocp_make_prism, Copy=True). */
export function makePrism(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  direction: Vec3,
  distance: number,
): OccShape {
  if (distance === 0) throw new Error('extrude distance must be non-zero')
  const vec = scope.track(
    new oc.gp_Vec_4(direction[0] * distance, direction[1] * distance, direction[2] * distance),
  )
  const builder = scope.track(new oc.BRepPrimAPI_MakePrism_1(face, vec, true, true))
  return builder.Shape()
}

// --- tessellation primitive ------------------------------------------------

/**
 * BRepMesh_IncrementalMesh on a shape, matching cadquery's `Shape.mesh`:
 * `BRepMesh_IncrementalMesh(shape, tol, True, angTol)` -- isRelative=True,
 * parallel defaulting False. The relative flag scales deflection by the shape's
 * size, so meshing each face individually (as cadquery does) is what reproduces
 * Python's per-face triangulation; do not substitute a single solid-level mesh.
 */
export function meshShape(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  linearDeflection: number,
  angularDeflection: number,
): void {
  scope.track(new oc.BRepMesh_IncrementalMesh_2(shape, linearDeflection, true, angularDeflection, false))
}

export interface FaceTessellation {
  /** Per-face vertices in world coordinates (location transform applied). */
  vertices: Vec3[]
  /** Triangles as 0-based indices into `vertices`, winding fixed for orientation. */
  triangles: [number, number, number][]
}

/**
 * Replicate cadquery `Face.tessellate(linear, angular)` for a single face:
 * mesh it, read its `Poly_Triangulation`, transform nodes by the location, and
 * emit triangles with REVERSED-orientation winding flipped -- node-for-node, so
 * the assembled mesh matches Python's. Returns empty when the face has no
 * triangulation.
 */
export function tessellateFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
  linearDeflection: number,
  angularDeflection: number,
): FaceTessellation {
  meshShape(oc, scope, face, linearDeflection, angularDeflection)
  const loc = scope.track(new oc.TopLoc_Location_1())
  const handle = scope.track(oc.BRep_Tool.Triangulation(face, loc))
  if (handle.IsNull()) return { vertices: [], triangles: [] }
  const poly = handle.get()
  if (!poly) return { vertices: [], triangles: [] }

  const trsf = scope.track(loc.Transformation())
  const reverse = isReversed(oc, face)

  const vertices: Vec3[] = []
  const nbNodes = poly.NbNodes()
  for (let i = 1; i <= nbNodes; i++) {
    const n = scope.track(poly.Node(i).Transformed(trsf))
    vertices.push([n.X(), n.Y(), n.Z()])
  }

  const triangles: [number, number, number][] = []
  const nbTri = poly.NbTriangles()
  for (let i = 1; i <= nbTri; i++) {
    const t = poly.Triangle(i)
    const a = t.Value(1) - 1
    const b = t.Value(2) - 1
    const c = t.Value(3) - 1
    triangles.push(reverse ? [a, c, b] : [a, b, c])
  }
  return { vertices, triangles }
}

// --- face geometry readers -------------------------------------------------

export type SurfaceType = 'flatface' | 'cylinderface' | 'face'

export function faceCentroid(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  const c = props.CentreOfMass()
  return [c.X(), c.Y(), c.Z()]
}

export function faceArea(oc: OccModule, scope: DisposeScope, face: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.SurfaceProperties_1(face, props, false, false)
  return props.Mass()
}

export function faceSurfaceType(oc: OccModule, scope: DisposeScope, face: OccShape): SurfaceType {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const t = adaptor.GetType().value
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) return 'flatface'
  if (t === oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value) return 'cylinderface'
  return 'face'
}

function isReversed(oc: OccModule, face: OccShape): boolean {
  return (face as OccOrientedShape).Orientation_1().value === oc.TopAbs_Orientation.TopAbs_REVERSED.value
}

/**
 * Face normal at the UV-domain midpoint, oriented outward (flipped when the
 * face is REVERSED), matching `_compute_face_normal` + cadquery's
 * orientation-aware normal. Verified sign-for-sign against the Python box.
 */
export function faceNormal(oc: OccModule, scope: DisposeScope, face: OccShape): Vec3 {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const u = (adaptor.FirstUParameter() + adaptor.LastUParameter()) / 2
  const v = (adaptor.FirstVParameter() + adaptor.LastVParameter()) / 2
  const props = scope.track(new oc.BRepLProp_SLProps_1(adaptor, u, v, 1, 1e-9))
  const n = props.Normal()
  const sign = isReversed(oc, face) ? -1 : 1
  return [n.X() * sign, n.Y() * sign, n.Z() * sign]
}
