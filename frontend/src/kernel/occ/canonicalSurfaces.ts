/**
 * Canonical-surface recognition for boolean results.
 *
 * OCCT's fillet builder (ChFi3d) emits rational-BSpline strips even when the
 * rolled surface is an exact cylinder (a constant-radius fillet along a
 * straight edge), and MakePrism over a BSpline boundary curve emits a
 * Geom_SurfaceOfLinearExtrusion.  ShapeUpgrade_UnifySameDomain only merges
 * faces whose underlying surfaces share the same ANALYTIC type, so an
 * add-extrude welded onto a filleted wall leaves the geometrically continuous
 * wall split at the weld plane (bugreports/extrude_discontinuous_*).
 *
 * This pass samples every non-analytic face of a boolean result, fits a
 * cylinder, clusters coincident fits, and rebuilds each fitted face on ONE
 * shared analytic gp_Cylinder per cluster.  The post-boolean UnifySameDomain
 * then folds the halves like any other cylinder pair.  Everything is gated
 * hard: a face that does not sit on a true cylinder within FIT_TOL, wraps too
 * far around for a safe seam, or has holes, is left untouched; if the rebuilt
 * solid fails the validity or volume check the original shape is returned.
 */

import type { DisposeScope } from './disposeScope'
import type {
  OccModule,
  OccShape,
  OccSubShape,
  OccOrientableShape,
  OccOrientedShape,
  OccSurfaceAdaptor,
} from './occTypes'

const FIT_SAMPLES = 7  // grid per direction -> 49 samples per face
const FIT_TOL = 1e-6  // max radial deviation for "this face IS a cylinder"
const CLUSTER_TOL = 1e-6  // axis distance / radius delta to share one cylinder
const MIN_SEAM_GAP = (20 * Math.PI) / 180  // free arc needed to place the U=0 seam

type V3 = [number, number, number]
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
const norm = (a: V3): number => Math.sqrt(dot(a, a))
const unit = (a: V3): V3 => mul(a, 1 / norm(a))

export interface CanonicalFaceSwap {
  from: OccSubShape
  to: OccSubShape
}

export interface CanonicalizedShape {
  shape: OccShape
  changed: boolean
  swaps: CanonicalFaceSwap[]
}

interface CylFit {
  face: OccShape
  d: V3  // unit axis direction
  c: V3  // a point on the axis
  r: number
  pts: V3[]  // the surface samples (reused for shared-seam placement)
  nMid: V3  // surface natural normal at mid-parameter (orientation alignment)
  pMid: V3  // surface point at mid-parameter
}

/** Points + natural normals sampled on a FIT_SAMPLES^2 parameter grid. */
function sampleFace(
  oc: OccModule,
  scope: DisposeScope,
  ad: OccSurfaceAdaptor,
): { pts: V3[]; normals: V3[]; nMid: V3 | null; pMid: V3 } {
  const u1 = ad.FirstUParameter()
  const u2 = ad.LastUParameter()
  const v1 = ad.FirstVParameter()
  const v2 = ad.LastVParameter()
  const pts: V3[] = []
  const normals: V3[] = []
  const p = scope.track(new oc.gp_Pnt_1())
  const du = scope.track(new oc.gp_Vec_1())
  const dv = scope.track(new oc.gp_Vec_1())
  const at = (u: number, v: number): { pt: V3; n: V3 | null } => {
    ad.D1(u, v, p, du, dv)
    const n = cross([du.X(), du.Y(), du.Z()], [dv.X(), dv.Y(), dv.Z()])
    const l = norm(n)
    return {
      pt: [p.X(), p.Y(), p.Z()],
      n: Number.isFinite(l) && l > 1e-12 ? unit(n) : null,
    }
  }
  for (let i = 0; i < FIT_SAMPLES; i++) {
    for (let j = 0; j < FIT_SAMPLES; j++) {
      const { pt, n } = at(u1 + ((u2 - u1) * i) / (FIT_SAMPLES - 1), v1 + ((v2 - v1) * j) / (FIT_SAMPLES - 1))
      if (pt.every(Number.isFinite)) pts.push(pt)
      if (n) normals.push(n)
    }
  }
  const mid = at((u1 + u2) / 2, (v1 + v2) / 2)
  return { pts, normals, nMid: mid.n, pMid: mid.pt }
}

/**
 * Fit a cylinder to the face samples: the axis direction is the common
 * perpendicular of the surface normals, the circle a least-squares (Kasa) fit
 * in the plane across it.  Null when the face is not a cylinder within
 * FIT_TOL (planes fall out via the all-normals-parallel check).
 */
function fitCylinder(oc: OccModule, scope: DisposeScope, face: OccShape): CylFit | null {
  // restriction=true bounds the adaptor to the face's UV range; without it an
  // extrusion surface reports its NATURAL (infinite) V range and the samples
  // overflow.
  const ad = scope.track(new oc.BRepAdaptor_Surface_2(face, true))
  const { pts, normals, nMid, pMid } = sampleFace(oc, scope, ad)
  if (pts.length < 9 || normals.length < 4 || nMid === null) return null
  if (!pMid.every(Number.isFinite)) return null
  let d: V3 | null = null
  let best = 1e-6
  for (let i = 1; i < normals.length; i++) {
    const c = cross(normals[0], normals[i])
    const l = norm(c)
    if (l > best) {
      best = l
      d = mul(c, 1 / l)
    }
  }
  if (d === null) return null  // normals parallel: planar, not a cylinder
  for (const n of normals) if (Math.abs(dot(n, d)) > 1e-6) return null

  // Kasa circle fit of the samples projected along d.
  const e1 = unit(cross(Math.abs(d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], d))
  const e2 = cross(d, e1)
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, sxz = 0, syz = 0, sz = 0
  const q2: Array<[number, number]> = []
  for (const pt of pts) {
    const x = dot(pt, e1)
    const y = dot(pt, e2)
    q2.push([x, y])
    const z = x * x + y * y
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y
    sxz += x * z; syz += y * z; sz += z
  }
  const n = pts.length
  const M = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ]
  const rhs = [sxz, syz, sz]
  for (let col = 0; col < 3; col++) {  // Gaussian elimination with pivoting
    let piv = col
    for (let row = col + 1; row < 3; row++) if (Math.abs(M[row][col]) > Math.abs(M[piv][col])) piv = row
    ;[M[col], M[piv]] = [M[piv], M[col]]
    ;[rhs[col], rhs[piv]] = [rhs[piv], rhs[col]]
    if (Math.abs(M[col][col]) < 1e-14) return null
    for (let row = col + 1; row < 3; row++) {
      const f = M[row][col] / M[col][col]
      for (let k = col; k < 3; k++) M[row][k] -= f * M[col][k]
      rhs[row] -= f * rhs[col]
    }
  }
  const sol = [0, 0, 0]
  for (let row = 2; row >= 0; row--) {
    let acc = rhs[row]
    for (let k = row + 1; k < 3; k++) acc -= M[row][k] * sol[k]
    sol[row] = acc / M[row][row]
  }
  const cx = sol[0] / 2
  const cy = sol[1] / 2
  const r = Math.sqrt(sol[2] + cx * cx + cy * cy)
  if (!Number.isFinite(r) || r <= 0) return null
  // Accept-on-within so a NaN residual rejects instead of slipping through.
  for (const [x, y] of q2) if (!(Math.abs(Math.hypot(x - cx, y - cy) - r) <= FIT_TOL)) return null
  return { face, d, c: add(mul(e1, cx), mul(e2, cy)), r, pts, nMid, pMid }
}

/** Do two fits describe the same cylinder (coaxial, equal radius)? */
function sameCylinder(a: CylFit, b: CylFit): boolean {
  if (Math.abs(Math.abs(dot(a.d, b.d)) - 1) > 1e-9) return false
  if (Math.abs(a.r - b.r) > CLUSTER_TOL) return false
  return norm(cross(sub(b.c, a.c), a.d)) < CLUSTER_TOL
}

/**
 * Seam angle for a cluster: the middle of the largest angular gap the member
 * samples leave free around the shared axis.  Null when the members wrap so
 * far around that no MIN_SEAM_GAP-wide gap remains.
 */
function seamAngleFor(cluster: CylFit[], e1: V3, e2: V3, c: V3): number | null {
  const angles: number[] = []
  for (const fit of cluster) {
    for (const pt of fit.pts) {
      const q = sub(pt, c)
      angles.push(Math.atan2(dot(q, e2), dot(q, e1)))
    }
  }
  angles.sort((a, b) => a - b)
  let gapStart = angles[angles.length - 1]
  let gap = angles[0] + 2 * Math.PI - gapStart
  for (let i = 1; i < angles.length; i++) {
    if (angles[i] - angles[i - 1] > gap) {
      gap = angles[i] - angles[i - 1]
      gapStart = angles[i - 1]
    }
  }
  if (!(gap >= MIN_SEAM_GAP)) return null  // accept-on-within: NaN gaps reject
  return gapStart + gap / 2
}

function countWires(oc: OccModule, scope: DisposeScope, face: OccShape): number {
  const E = oc.TopAbs_ShapeEnum
  const exp = scope.track(new oc.TopExp_Explorer_2(face, E.TopAbs_WIRE, E.TopAbs_SHAPE))
  let count = 0
  for (; exp.More(); exp.Next()) count++
  return count
}

/** Volume via BRepGProp (local copy of booleans.volumeOf to avoid an import cycle). */
function shapeVolume(oc: OccModule, scope: DisposeScope, shape: OccShape): number {
  const props = scope.track(new oc.GProp_GProps_1())
  oc.BRepGProp.VolumeProperties_1(shape, props, true, false, false)
  return props.Mass()
}

/**
 * Replace every non-analytic face of `shape` that sits on a true cylinder
 * with a face rebuilt on a shared analytic gp_Cylinder.  Returns the input
 * unchanged (`changed: false`) when nothing qualifies or any guard trips.
 * The returned swaps map raw faces to their canonical replacements so a
 * BrepDiff can be carried across; the `to` handles are tracked in `scope`.
 */
export function canonicalizeCylinderFaces(
  oc: OccModule,
  scope: DisposeScope,
  shape: OccShape,
): CanonicalizedShape {
  const identity: CanonicalizedShape = { shape, changed: false, swaps: [] }
  try {
    const E = oc.TopAbs_ShapeEnum
    const planeType = oc.GeomAbs_SurfaceType.GeomAbs_Plane.value
    const cylType = oc.GeomAbs_SurfaceType.GeomAbs_Cylinder.value

    // 1. Fit every non-analytic face; bail early when there are none (the
    //    common case: booleans of analytic bodies).
    const fits: CylFit[] = []
    {
      const exp = scope.track(new oc.TopExp_Explorer_2(shape, E.TopAbs_FACE, E.TopAbs_SHAPE))
      for (; exp.More(); exp.Next()) {
        const face = scope.track(oc.TopoDS.Face_1(exp.Current()))
        const ad = scope.track(new oc.BRepAdaptor_Surface_2(face, false))
        const t = ad.GetType().value
        if (t === planeType || t === cylType) continue
        if (countWires(oc, scope, face) !== 1) continue  // holes: skip, MakeFace takes one wire
        const fit = fitCylinder(oc, scope, face)
        if (fit) fits.push(fit)
      }
    }
    if (fits.length === 0) return identity

    // 2. Cluster coincident fits so both weld halves land on ONE cylinder.
    const clusters: CylFit[][] = []
    for (const fit of fits) {
      const home = clusters.find((cl) => sameCylinder(cl[0], fit))
      if (home) home.push(fit)
      else clusters.push([fit])
    }

    // 3. Rebuild each fitted face on its cluster's shared analytic cylinder.
    const reshape = scope.track(new oc.BRepTools_ReShape())
    const swaps: CanonicalFaceSwap[] = []
    for (const cluster of clusters) {
      const g = cluster[0]
      const e1 = unit(cross(Math.abs(g.d[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], g.d))
      const e2 = cross(g.d, e1)
      const seam = seamAngleFor(cluster, e1, e2, g.c)
      if (seam === null) continue
      const xd = add(mul(e1, Math.cos(seam)), mul(e2, Math.sin(seam)))
      const frame = scope.track(new oc.gp_Ax3_3(
        scope.track(new oc.gp_Pnt_3(g.c[0], g.c[1], g.c[2])),
        scope.track(new oc.gp_Dir_4(g.d[0], g.d[1], g.d[2])),
        scope.track(new oc.gp_Dir_4(xd[0], xd[1], xd[2])),
      ))
      const cylinder = scope.track(new oc.gp_Cylinder_2(frame, g.r))
      for (const fit of cluster) {
        const E2 = oc.TopAbs_ShapeEnum
        const wexp = scope.track(new oc.TopExp_Explorer_2(fit.face, E2.TopAbs_WIRE, E2.TopAbs_SHAPE))
        const wire = scope.track(oc.TopoDS.Wire_1(wexp.Current()))
        const maker = scope.track(new oc.BRepBuilderAPI_MakeFace_17(cylinder, wire, true))
        if (!maker.IsDone()) continue
        let rebuilt = scope.track(maker.Face())
        // Keep the material side: the shell's outward normal is the old
        // surface's NATURAL normal composed with the face's orientation flag,
        // and ReShape inserts the replacement with the flag we record here.
        // So reverse when exactly one of {natural normal points inward,
        // face sits REVERSED in the shell} holds.
        const foot = add(g.c, mul(g.d, dot(sub(fit.pMid, g.c), g.d)))
        const radial = unit(sub(fit.pMid, foot))
        const naturalInward = dot(fit.nMid, radial) < 0
        const sitsReversed =
          (fit.face as OccOrientedShape).Orientation_1().value ===
          oc.TopAbs_Orientation.TopAbs_REVERSED.value
        if (naturalInward !== sitsReversed) {
          rebuilt = scope.track((rebuilt as OccOrientableShape).Reversed())
        }
        reshape.Replace(fit.face, rebuilt)
        swaps.push({ from: fit.face as OccSubShape, to: rebuilt as OccSubShape })
      }
    }
    if (swaps.length === 0) return identity

    // 4. Substitute, then heal: the rebuilt faces reuse the original wires, so
    //    the shared edges lack pcurves on the new cylinders until ShapeFix
    //    projects them.
    const substituted = scope.track(reshape.Apply(shape, E.TopAbs_FACE))
    const fixer = scope.track(new oc.ShapeFix_Shape_2(substituted))
    fixer.Perform(scope.track(new oc.Handle_Message_ProgressIndicator_1()))
    const healed = fixer.Shape()
    const reject = (): CanonicalizedShape => {
      scope.track(healed)  // rejected result would otherwise strand on the WASM heap
      return identity
    }

    // 5. Guards: an orientation slip would corrupt the solid, so require both
    //    BRepCheck validity and an unchanged volume before adopting the result.
    if (!scope.track(new oc.BRepCheck_Analyzer(healed, true)).IsValid_2()) return reject()
    const v0 = shapeVolume(oc, scope, shape)
    const v1 = shapeVolume(oc, scope, healed)
    if (!(Math.abs(v1 - v0) <= Math.max(1e-9, 1e-6 * Math.abs(v0)))) return reject()

    // 6. Re-base the swap targets through the fixer's substitution context:
    //    ShapeFix may re-make a face rather than update it in place, and the
    //    diff must reference sub-shapes of the HEALED shape.
    try {
      const context = scope.track(fixer.Context()).get()
      if (context) {
        for (const swap of swaps) {
          swap.to = scope.track(context.Apply(swap.to, E.TopAbs_SHAPE)) as OccSubShape
        }
      }
    } catch {
      // Best-effort: an unmapped swap degrades lineage on that face, not geometry.
    }

    return { shape: healed, changed: true, swaps }
  } catch {
    // Recognition is best-effort: the un-canonicalized boolean result is a
    // sound solid, it just keeps the seam UnifySameDomain cannot fold.
    return identity
  }
}
