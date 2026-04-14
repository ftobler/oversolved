// PURE LOGIC -- no Three.js, no React refs, no R3F hooks.
// This file must be importable in a plain vitest test without a DOM.
// See docs/viewport.md "Layer Contracts" and feature/feature_headless_viewport.md.

/** Apply an inverse quaternion rotation to a vector [x, y, z].
 *  Quaternion format is [x, y, z, w] (Three.js convention).
 *  For a unit quaternion, inverse equals conjugate: [-qx, -qy, -qz, qw].
 *  Equivalent to Three.js: v.applyQuaternion(q.invert()). */
export function applyQuaternionInverse(
  v: readonly [number, number, number],
  q: readonly [number, number, number, number],
): [number, number, number] {
  const [vx, vy, vz] = v
  const [qx, qy, qz, qw] = q

  // Intermediate products using q_inv = [-qx, -qy, -qz, qw]
  const ix = qw * vx - qy * vz + qz * vy
  const iy = qw * vy - qz * vx + qx * vz
  const iz = qw * vz - qx * vy + qy * vx
  const iw = qx * vx + qy * vy + qz * vz

  return [
    ix * qw + iw * qx + iy * qz - iz * qy,
    iy * qw + iw * qy + iz * qx - ix * qz,
    iz * qw + iw * qz + ix * qy - iy * qx,
  ]
}

/** Convert a world-space XYZ point to sketch-local 3D coordinates given a parent transform.
 *  Returns all three local axes so callers can check the z component for off-plane detection.
 *  parentQuat is in [x, y, z, w] format (Three.js convention). */
export function worldToSketchLocalPure(
  worldPt: readonly [number, number, number],
  parentPos: readonly [number, number, number],
  parentQuat: readonly [number, number, number, number],
): [number, number, number] {
  const translated: [number, number, number] = [
    worldPt[0] - parentPos[0],
    worldPt[1] - parentPos[1],
    worldPt[2] - parentPos[2],
  ]
  return applyQuaternionInverse(translated, parentQuat)
}
