// PURE LOGIC -- no Three.js, no React. Importable in a plain vitest test.
// Computes the geometry for an angular dimension: arc vertex, radius, the two
// rays bounding the arc, the label position, and whether the label sits inside
// the angle wedge (arrows point outward) or outside it (arrows point inward and
// a dashed extension reaches the label).

export interface AngleDimGeometry {
  vx: number
  vy: number
  arcR: number
  a0deg: number  // ray bounding the arc on line A
  a1deg: number  // ray bounding the arc on line B
  arcSpan: number  // signed shorter span from a0 to a1 (+CCW, -CW)
  labelAngleDeg: number
  labelX: number
  labelY: number
  isInside: boolean
  extendFromStart: boolean
  // True when the chosen wedge subtends the supplement (180 - theta) rather than
  // theta itself. The two lines' four rays carve the plane into four quadrants:
  // two subtend theta (the stored constraint value) and two subtend 180 - theta.
  // Placing the label in a supplement quadrant must display, and edit against,
  // 180 - value, the actual angle drawn there.
  isSupplement: boolean
}

const RAD = Math.PI / 180

/** Signed shorter angular distance from a0 to a1 in degrees, in (-180, 180]. */
function shorterSpan(a0: number, a1: number): number {
  let s = (((a1 - a0) % 360) + 360) % 360
  if (s > 180) s -= 360
  return s
}

/** Unsigned angular distance between two angles in degrees, in [0, 180]. */
function angDiff(a: number, b: number): number {
  const d = (((a - b) % 360) + 360) % 360
  return Math.min(d, 360 - d)
}

/** The two lines cross at the vertex and emit four rays: dirA, dirB and their
 *  +180 twins. Those rays carve the plane into four wedges; adjacent rays always
 *  belong to different lines (the rays of two crossing lines interleave). Pick the
 *  wedge that brackets the `target` direction so the label can land in any of the
 *  four quadrants. `a0` is always the line-A ray and `a1` the line-B ray bounding
 *  the wedge, so the witness lines stay matched to their segments. `isSupplement`
 *  marks the two wedges that subtend 180 - theta instead of theta. */
function chooseWedge(
  dirA: number, dirB: number, target: number,
): { a0: number; a1: number; isSupplement: boolean } {
  const norm = (a: number) => (((a % 360) + 360) % 360)
  // Ray order matters: 0,2 are line A; 1,3 are line B. The matched theta wedges
  // are bounded by {0,1} and {2,3}; the other two adjacencies are supplements.
  const rays = [dirA, dirB, dirA + 180, dirB + 180]
  const t = norm(target)
  // lo = the ray at or immediately clockwise of the target (smallest CCW step
  // from ray to target).
  let loi = 0
  let loBest = Infinity
  for (let i = 0; i < 4; i++) {
    const d = norm(t - rays[i])
    if (d < loBest) { loBest = d; loi = i }
  }
  // hi = the next ray counter-clockwise from lo (smallest positive step), so the
  // target sits in the wedge (lo, hi) and lo != hi.
  let hii = 0
  let hiBest = Infinity
  for (let i = 0; i < 4; i++) {
    if (i === loi) continue
    const d = norm(rays[i] - rays[loi])
    if (d < hiBest) { hiBest = d; hii = i }
  }
  const isA = (i: number) => i === 0 || i === 2
  const a0 = isA(loi) ? rays[loi] : rays[hii]
  const a1 = isA(loi) ? rays[hii] : rays[loi]
  const [p0, p1] = loi < hii ? [loi, hii] : [hii, loi]
  const isTheta = (p0 === 0 && p1 === 1) || (p0 === 2 && p1 === 3)
  return { a0, a1, isSupplement: !isTheta }
}

/** Compute angular dimension geometry.
 *  p1,p2 = line A endpoints; p3,p4 = line B endpoints.
 *  pos (if present) is the label offset relative to the arc vertex. */
export function computeAngleDimension(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
  pos?: [number, number],
): AngleDimGeometry {
  const [ax1, ay1] = p1
  const [ax2, ay2] = p2
  const [bx1, by1] = p3
  const [bx2, by2] = p4

  const dax = ax2 - ax1, day = ay2 - ay1
  const dbx = bx2 - bx1, dby = by2 - by1

  // Vertex = intersection of the two infinite lines (Cramer's rule).
  // Parallel lines fall back to the midpoint of the nearest endpoints.
  const cross = dax * dby - day * dbx
  let vx: number, vy: number
  if (Math.abs(cross) > 1e-10) {
    const t = ((bx1 - ax1) * dby - (by1 - ay1) * dbx) / cross
    vx = ax1 + t * dax
    vy = ay1 + t * day
  } else {
    vx = (ax2 + bx1) / 2
    vy = (ay2 + by1) / 2
  }

  const dirA = Math.atan2(day, dax) / RAD
  const dirB = Math.atan2(dby, dbx) / RAD

  // Direction from the vertex toward each segment's midpoint. Used to aim the
  // default wedge at the drawn geometry even when the vertex is far away
  // (near-parallel lines), and to size the default radius.
  const midAx = (ax1 + ax2) / 2, midAy = (ay1 + ay2) / 2
  const midBx = (bx1 + bx2) / 2, midBy = (by1 + by2) / 2
  const geoRayA = Math.atan2(midAy - vy, midAx - vx) / RAD
  const geoRayB = Math.atan2(midBy - vy, midBx - vx) / RAD

  let a0deg: number, a1deg: number, arcR: number, labelAngleDeg: number, isSupplement: boolean
  if (pos) {
    // User-placed label: snap to whichever of the four wedges the label points
    // at, so it can be dragged into any quadrant around the crossing.
    const labelAngle = Math.atan2(pos[1], pos[0]) / RAD
    const w = chooseWedge(dirA, dirB, labelAngle)
    a0deg = w.a0
    a1deg = w.a1
    isSupplement = w.isSupplement
    arcR = Math.hypot(pos[0], pos[1]) || 1e-6
    labelAngleDeg = labelAngle
  } else {
    // Default: aim the wedge at the geometry; radius lands the arc near the
    // nearer midpoint.
    const geoTarget = geoRayA + shorterSpan(geoRayA, geoRayB) / 2
    const w = chooseWedge(dirA, dirB, geoTarget)
    a0deg = w.a0
    a1deg = w.a1
    isSupplement = w.isSupplement
    const dA = Math.hypot(midAx - vx, midAy - vy)
    const dB = Math.hypot(midBx - vx, midBy - vy)
    arcR = Math.min(dA, dB) || 1e-6
    labelAngleDeg = a0deg + shorterSpan(a0deg, a1deg) / 2
  }

  const arcSpan = shorterSpan(a0deg, a1deg)
  const labelRad = labelAngleDeg * RAD
  const labelX = vx + arcR * Math.cos(labelRad)
  const labelY = vy + arcR * Math.sin(labelRad)

  // Inside = label angle lies within the wedge [a0, a0+arcSpan].
  const rel = (((labelAngleDeg - a0deg) % 360) + 360) % 360
  const isInside = arcSpan >= 0 ? rel <= arcSpan : rel >= 360 + arcSpan

  const extendFromStart = !isInside && angDiff(labelAngleDeg, a0deg) < angDiff(labelAngleDeg, a1deg)

  return { vx, vy, arcR, a0deg, a1deg, arcSpan, labelAngleDeg, labelX, labelY, isInside, extendFromStart, isSupplement }
}
