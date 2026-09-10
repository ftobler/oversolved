// Locks the canonical frame rule. canonicalPerp is now its only owner: the Rust
// canonical_perp was deleted and the perp travels on the mate wire
// (MateGeometry.perp, mate_residuals.rs roll_frames), so a captured `angle`
// measures against the exact frame the solver reads.

import { describe, expect, it } from 'vitest'
import { canonicalPerp, rollAboutAxisDeg } from '@/utils/mateOrientation'
import { rotateVector, quatFromAxisAngle } from '@/utils/transform3d'
import type { Vec3 } from '@/utils/transform3d'

describe('canonicalPerp', () => {
  it('matches the canonical frame fixtures', () => {
    const cases: [Vec3, Vec3][] = [
      [[0, 0, 1], [0, 1, 0]],    // z crossed with x
      [[1, 0, 0], [0, 0, 1]],    // x crossed with y
      [[0, 1, 0], [0, 0, -1]],   // y crossed with x
      [[0.6, 0, 0.8], [-0.8, 0, 0.6]],  // tilted, crossed with y
    ]
    for (const [axis, want] of cases) {
      const p = canonicalPerp(axis)
      for (let c = 0; c < 3; c++) expect(p[c]).toBeCloseTo(want[c], 12)
    }
  })

  it('breaks ties between equally-aligned axes deterministically', () => {
    // The branch rule `ax <= ay && ax <= az ... else if ay <= az` is pinned
    // exactly where it is load-bearing: axes that tie two absolute components.
    const cases: [Vec3, Vec3][] = [
      [[1, 1, 2], [0, 0.8944271909999159, -0.4472135954999579]],        // x ties y, breaks to x
      [[2, 1, 1], [-0.4472135954999579, 0, 0.8944271909999159]],        // y ties z, breaks to y
      [[1, 1, 1], [0, 0.7071067811865476, -0.7071067811865476]],        // all tie, breaks to x
      // A near-tie pins that the comparison is on the f64, not rounded: x is a
      // hair over y, so this falls through to the y branch, unlike the exact
      // [1,1,2] tie above.
      [[1 + 1e-9, 1, 2], [-0.8944271908210305, 0, 0.44721359585772885]],
    ]
    for (const [axis, want] of cases) {
      const p = canonicalPerp(axis)
      for (let c = 0; c < 3; c++) expect(p[c]).toBeCloseTo(want[c], 12)
    }
  })

  it('is perpendicular and unit for arbitrary axes', () => {
    const axes: Vec3[] = [[0.3, -0.5, 0.8], [-1, 2, 0.5], [0, 0.001, 1]]
    for (const axis of axes) {
      const p = canonicalPerp(axis)
      const dot = p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]
      expect(dot).toBeCloseTo(0, 9)
      expect(Math.hypot(...p)).toBeCloseTo(1, 12)
    }
  })

  it('degrades a zero axis to a defined frame instead of NaN', () => {
    // normalize returns null for a zero axis, so the fallback axis is +Z and
    // the resulting perp is exactly +Y.
    expect(canonicalPerp([0, 0, 0])).toEqual([0, 1, 0])
  })
})

describe('rollAboutAxisDeg', () => {
  const z: Vec3 = [0, 0, 1]
  const x: Vec3 = [1, 0, 0]

  it('reads zero for identical frames', () => {
    expect(rollAboutAxisDeg(x, x, z)).toBeCloseTo(0, 9)
  })

  it('reads the rotation angle for a frame rolled about the axis', () => {
    const q = quatFromAxisAngle(z, (30 * Math.PI) / 180)
    const xb = rotateVector(q, x)
    expect(rollAboutAxisDeg(x, xb, z)).toBeCloseTo(30, 6)
    const qn = quatFromAxisAngle(z, (-135 * Math.PI) / 180)
    expect(rollAboutAxisDeg(x, rotateVector(qn, x), z)).toBeCloseTo(-135, 6)
  })

  it('reads 180 for an opposed reference (the face-to-face weld capture)', () => {
    // A part flipped 180° about X to mate face-to-face: its canonical y frame
    // vector lands opposed. atan2 keeps the closed end at +180, matching the
    // solver's wrap_to_pi range and the editor's ±180 entry limit.
    const q = quatFromAxisAngle(x, Math.PI)
    const y: Vec3 = [0, 1, 0]
    expect(rollAboutAxisDeg(y, rotateVector(q, y), z)).toBeCloseTo(180, 6)
  })
})
