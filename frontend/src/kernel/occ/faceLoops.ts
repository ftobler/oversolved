/**
 * Given a solid and a sorted face index, returns the face's 2D boundary loops (outer + holes)
 * in the face's own plane parameter space, plus the plane frame -- the input the extrude /
 * revolve "from an existing planar face" path needs.
 *
 * opencascade.js@1.1.1 specifics (probed): the wire explorer is `BRepTools_WireExplorer_3(wire,
 * face)` (the `_2` form takes only the wire); the face PCurve is `BRepAdaptor_Curve2d_2(edge,
 * face)`; `BRepTools.OuterWire` is the static (no `_s` suffix in this build). Faces are picked
 * from the same `_face_sort_key` order Python uses (flat-before-curved, then normal, then
 * centroid), so the index matches the rest of the kernel.
 */

import type { DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccOrientedShape, OccSubShape } from './occTypes'
import type { Frame3D } from '../types3d'
import { faceCentroid, faceNormal, faceSurfaceType } from './primitives'
import { faceSortKey, compareFaceSortKeys } from './shapes'

const TWO_PI = 2 * Math.PI

function pymod(x: number, m: number): number {
  return ((x % m) + m) % m
}

/** Faces of a shape sorted by `_face_sort_key` (flat-before-curved, normal, centroid). */
function sortedFaces(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const items: { face: OccShape; key: number[] }[] = []
  for (; exp.More(); exp.Next()) {
    const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
    items.push({
      face,
      key: faceSortKey({
        centroid: faceCentroid(oc, scope, face),
        normal: faceNormal(oc, scope, face),
        surfaceType: faceSurfaceType(oc, scope, face),
      }),
    })
  }
  items.sort((a, b) => compareFaceSortKeys(a.key, b.key))
  return items.map((it) => it.face)
}

/** The face at sorted `faceIndex` of `shape` (mirrors `_extract_occ_face`). */
export function extractOccFace(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceIndex: number,
): OccShape {
  const faces = sortedFaces(oc, scope, shape)
  if (faceIndex >= faces.length) throw new Error(`face_index ${faceIndex} out of range`)
  return faces[faceIndex]
}

/** Frame3D of a planar face (mirrors `_compute_face_plane`); throws if non-planar. */
export function computeFacePlane(oc: OccModule, scope: DisposeScope, face: OccShape): Frame3D {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (adaptor.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) {
    throw new Error('Only flat faces can be used as extrude profiles')
  }
  const ax3 = adaptor.Plane().Position()
  const loc = ax3.Location()
  const xd = ax3.XDirection()
  const yd = ax3.YDirection()
  const nd = ax3.Direction()
  return {
    origin: [loc.X(), loc.Y(), loc.Z()],
    x_axis: [xd.X(), xd.Y(), xd.Z()],
    y_axis: [yd.X(), yd.Y(), yd.Z()],
    normal: [nd.X(), nd.Y(), nd.Z()],
  }
}

/** (outer wire, hole wires) of a face (mirrors `_collect_face_wires`). */
function collectFaceWires(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { outer: OccShape; holes: OccShape[] } {
  const outer = scope.track(oc.BRepTools.OuterWire(face))
  const holes: OccShape[] = []
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  for (; exp.More(); exp.Next()) {
    const w = scope.track(oc.TopoDS.Wire_1(exp.Current())) as OccSubShape
    // Dedup against the outer wire by topological identity (Python uses hash()).
    if (!(outer as OccSubShape).IsSame(w) && !holes.some((h) => (h as OccSubShape).IsSame(w))) {
      holes.push(w)
    }
  }
  return { outer, holes }
}

type EdgeDict = Record<string, unknown>

/** 2D edge dicts for a wire on a face (mirrors `_build_loop_from_wire`). */
function buildLoopFromWire(
  oc: OccModule,
  scope: DisposeScope,
  wire: OccShape,
  face: OccShape,
): EdgeDict[] {
  const loop: EdgeDict[] = []
  const reversed = oc.TopAbs_Orientation.TopAbs_REVERSED.value
  const circleType = oc.GeomAbs_CurveType.GeomAbs_Circle.value
  const we = scope.track(new oc.BRepTools_WireExplorer_3(wire, face))
  for (; we.More(); we.Next()) {
    const edge = we.Current()
    try {
      const c2d = scope.track(new oc.BRepAdaptor_Curve2d_2(edge, face))
      let first = c2d.FirstParameter()
      let last = c2d.LastParameter()
      // PCurve natural direction; a reversed edge traverses last->first, so swap.
      if ((edge as OccOrientedShape).Orientation_1().value === reversed) {
        const t = first
        first = last
        last = t
      }
      if (c2d.GetType().value === circleType) {
        const circ = scope.track(c2d.Circle())
        const center = circ.Location()
        const radius = circ.Radius()
        const cx = center.X()
        const cy = center.Y()
        const span = last - first
        const isFull = Math.abs(Math.abs(span) - TWO_PI) < 1e-6
        if (isFull) {
          loop.push({
            kind: 'arc',
            center: [cx, cy],
            radius,
            angle_start_deg: 0.0,
            angle_end_deg: 360.0,
            ccw: span >= 0,
          })
        } else {
          const pStart = c2d.Value(first)
          const pEnd = c2d.Value(last)
          const a0 = Math.atan2(pStart.Y() - cy, pStart.X() - cx)
          const a1 = Math.atan2(pEnd.Y() - cy, pEnd.X() - cx)
          const spanCcw = pymod(a1 - a0 + 2 * Math.PI, TWO_PI)
          loop.push({
            kind: 'arc',
            center: [cx, cy],
            radius,
            angle_start_deg: (a0 * 180) / Math.PI,
            angle_end_deg: (a1 * 180) / Math.PI,
            ccw: spanCcw < Math.PI,
          })
        }
      } else {
        const ps = c2d.Value(first)
        const pe = c2d.Value(last)
        loop.push({ kind: 'line', start: [ps.X(), ps.Y()], end: [pe.X(), pe.Y()] })
      }
    } catch {
      // Per-edge failure: drop it (matches Python's per-edge try/except).
    }
  }
  return loop
}

/**
 * 2D boundary loops + plane of a solid's face at sorted `faceIndex` (mirrors
 * `ocp_extract_face_loops`). Empty loops are dropped.
 */
export function extractFaceLoops(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
  faceIndex: number,
): { loops: EdgeDict[][]; plane: Frame3D; face: OccShape } {
  const face = extractOccFace(oc, scope, shape, faceIndex)
  const plane = computeFacePlane(oc, scope, face)
  const { outer, holes } = collectFaceWires(oc, scope, face)
  const loops = [outer, ...holes]
    .map((w) => buildLoopFromWire(oc, scope, w, face))
    .filter((loop) => loop.length > 0)
  return { loops, plane, face }
}
