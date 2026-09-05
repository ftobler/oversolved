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

import { withTransientScope, type DisposeScope } from './disposeScope'
import type { OccModule, OccShape, OccOrientedShape, OccSubShape } from './occTypes'
import type { Frame3D } from '../types3d'
import { faceCentroid, faceSurfaceTypeAndNormal } from './primitives'
import { faceSortKey, compareFaceSortKeys } from './shapes'

const TWO_PI = 2 * Math.PI

/**
 * Faces of a shape sorted by `_face_sort_key` (flat-before-curved, normal,
 * centroid). The returned Face proxies are tracked on the caller's scope.
 *
 * Deliberately NOT memoized per shape handle: a Map<OccHandle, OccShape[]>
 * would cache proxies against a shape a later feature may replace, and the
 * cache would need invalidation on every HandleTable.release. A caller that
 * needs two indexes over one shape (a face pick's index resolution + loop
 * extraction) shares ONE call across both instead (M45).
 */
export function sortedFacesOf(oc: OccModule, scope: DisposeScope, shape: OccShape): OccShape[] {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
  const items: { face: OccShape; key: number[] }[] = []
  for (; exp.More(); exp.Next()) {
    const raw = scope.track(exp.Current())
    const face = scope.track(oc.TopoDS.Face_1(raw))
    // The face is returned, so it must outlive the loop. Its geometry readers
    // must not: they are the 20k-proxy half of M45, and the loop keeps only
    // numbers from them.
    const key = withTransientScope((s) => faceSortKey({
      centroid: faceCentroid(oc, s, face),
      ...faceSurfaceTypeAndNormal(oc, s, face),  // ONE adaptor, Change 0b
    }))
    items.push({ face, key })
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
  const faces = sortedFacesOf(oc, scope, shape)
  if (faceIndex >= faces.length) throw new Error(`face_index ${faceIndex} out of range`)
  return faces[faceIndex]
}

/** Frame3D of a planar face (mirrors `_compute_face_plane`); throws if non-planar. */
export function computeFacePlane(oc: OccModule, scope: DisposeScope, face: OccShape): Frame3D {
  const adaptor = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  if (adaptor.GetType().value !== oc.GeomAbs_SurfaceType.GeomAbs_Plane.value) {
    throw new Error('Only flat faces can be used as extrude profiles')
  }
  // adaptor.Plane() and every frame accessor return by-value gp_* proxies
  // owning WASM memory; the scope owns them for this read-only walk.
  const pln = scope.track(adaptor.Plane())
  const ax3 = scope.track(pln.Position())
  const loc = scope.track(ax3.Location())
  const xd = scope.track(ax3.XDirection())
  const yd = scope.track(ax3.YDirection())
  const nd = scope.track(ax3.Direction())
  return {
    origin: [loc.X(), loc.Y(), loc.Z()],
    x_axis: [xd.X(), xd.Y(), xd.Z()],
    y_axis: [yd.X(), yd.Y(), yd.Z()],
    normal: [nd.X(), nd.Y(), nd.Z()],
  }
}

/**
 * Frame3D suitable for a datum plane on a face: outward normal + centroid origin.
 * Unlike computeFacePlane (which returns the raw surface frame for pcurve loops),
 * this flips the normal when the face is REVERSED and uses the face centroid as
 * the origin so a sketch on this datum plane faces away from the solid.
 */
export function computeFaceDatumFrame(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): Frame3D {
  const raw = computeFacePlane(oc, scope, face)
  const reversed =
    (face as OccOrientedShape).Orientation_1().value ===
    oc.TopAbs_Orientation.TopAbs_REVERSED.value
  const centroid = faceCentroid(oc, scope, face)
  if (!reversed) {
    return { origin: centroid, x_axis: raw.x_axis, y_axis: raw.y_axis, normal: raw.normal }
  }
  return {
    origin: centroid,
    x_axis: raw.y_axis,
    y_axis: raw.x_axis,
    normal: raw.normal.map((n) => -n) as [number, number, number],
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
    const raw = scope.track(exp.Current())
    const w = scope.track(oc.TopoDS.Wire_1(raw)) as OccSubShape
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
  const lineType = oc.GeomAbs_CurveType.GeomAbs_Line.value
  const we = scope.track(new oc.BRepTools_WireExplorer_3(wire, face))
  for (; we.More(); we.Next()) {
    // Current() hands back a fresh edge proxy per step; the reads below end
    // inside the iteration, so it is dropped with it.
    const edge = scope.track(we.Current())
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
        const center = scope.track(circ.Location())
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
          const pStart = scope.track(c2d.Value(first))
          const pEnd = scope.track(c2d.Value(last))
          const a0 = Math.atan2(pStart.Y() - cy, pStart.X() - cx)
          const a1 = Math.atan2(pEnd.Y() - cy, pEnd.X() - cx)
          // Winding from the pcurve parameter span sign, same rule as the
          // full-circle branch above: a partial arc may legitimately sweep
          // more than half a turn, which no endpoint pair distinguishes.
          loop.push({
            kind: 'arc',
            center: [cx, cy],
            radius,
            angle_start_deg: (a0 * 180) / Math.PI,
            angle_end_deg: (a1 * 180) / Math.PI,
            ccw: span >= 0,
          })
        }
      } else if (c2d.GetType().value === lineType) {
        // Linear pcurves: single chord is exact.
        const ps = scope.track(c2d.Value(first))
        const pe = scope.track(c2d.Value(last))
        loop.push({ kind: 'line', start: [ps.X(), ps.Y()], end: [pe.X(), pe.Y()] })
      } else {
        // Non-circular, non-linear pcurves: tessellate into a polyline.
        // For a closed pcurve (full ellipse, etc.) Value(first) == Value(last),
        // so a chord alone collapses. Sample N interior points.
        const polySpan = last - first
        const isClosed = Math.abs(Math.abs(polySpan) - TWO_PI) < 1e-6
        const N_SAMPLES = 32
        const pts: ReturnType<typeof c2d.Value>[] = []
        if (isClosed) {
          for (let i = 0; i < N_SAMPLES; i++) {
            const u = first + (polySpan * i) / N_SAMPLES
            pts.push(scope.track(c2d.Value(u)))
          }
        } else {
          for (let i = 0; i <= N_SAMPLES; i++) {
            const u = first + (polySpan * i) / N_SAMPLES
            pts.push(scope.track(c2d.Value(u)))
          }
        }
        for (let i = 0; i < pts.length - 1; i++) {
          const a = pts[i]
          const b = pts[i + 1]
          loop.push({
            kind: 'line',
            start: [a.X(), a.Y()],
            end: [b.X(), b.Y()],
          })
        }
        if (isClosed && pts.length > 0) {
          const lastPt = pts[pts.length - 1]
          const firstPt = pts[0]
          loop.push({
            kind: 'line',
            start: [lastPt.X(), lastPt.Y()],
            end: [firstPt.X(), firstPt.Y()],
          })
        }
      }
    } catch {
      // Per-edge failure: drop it (matches Python's per-edge try/except).
    }
  }
  return loop
}

/**
 * 2D boundary loops + plane of ONE already-resolved face (mirrors
 * `ocp_extract_face_loops` minus the shape re-sort). Empty loops are dropped.
 * A caller that already holds the sorted face list indexes it once and hands
 * the face here, so a face pick does not traverse the shape twice (M45).
 */
export function faceLoopsOfFace(
  oc: OccModule,
  scope: DisposeScope,
  face: OccShape,
): { loops: EdgeDict[][]; plane: Frame3D; face: OccShape } {
  const plane = computeFacePlane(oc, scope, face)
  const { outer, holes } = collectFaceWires(oc, scope, face)
  const loops = [outer, ...holes]
    .map((w) => buildLoopFromWire(oc, scope, w, face))
    .filter((loop) => loop.length > 0)
  return { loops, plane, face }
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
  return faceLoopsOfFace(oc, scope, face)
}
