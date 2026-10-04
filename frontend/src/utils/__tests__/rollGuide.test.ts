// Stage 3's roll-guide arrow. Pure geometry, no canvas: given an anchor pose and
// the mate's authored angle, it must trace an arc that actually reaches the
// angle it is asked to show, and degrade to nothing rather than NaN when the
// axis is degenerate.

import { describe, it, expect } from 'vitest'
import { buildRollGuide } from '@/utils/rollGuide'
import { dot, normalize, sub } from '@/utils/gizmoMath'
import type { Vec3 } from '@/utils/transform3d'

describe('buildRollGuide', () => {
  it('starts the arc at the zero-roll reference direction', () => {
    const guide = buildRollGuide([0, 0, 0], [0, 0, 1], 90, 2)
    expect(guide).not.toBeNull()
    const start = guide!.arc[0]
    const dist = Math.hypot(start[0], start[1], start[2])
    expect(dist).toBeCloseTo(2)
  })

  it('ends the arc at the requested angle, radius away from the point', () => {
    const point: Vec3 = [1, 2, 3]
    const guide = buildRollGuide(point, [0, 0, 1], 90, 2)!
    const tip = guide.tip
    const offset = sub(tip, point)
    expect(Math.hypot(offset[0], offset[1], offset[2])).toBeCloseTo(2)
    // 90 degrees from the start direction: the tip is orthogonal to it.
    const start = sub(guide.arc[0], point)
    expect(dot(normalize(start)!, normalize(offset)!)).toBeCloseTo(0, 5)
  })

  it('a zero angle collapses the arc to a single direction', () => {
    const guide = buildRollGuide([0, 0, 0], [0, 0, 1], 0, 1)!
    for (const p of guide.arc) {
      expect(p[0]).toBeCloseTo(guide.arc[0][0])
      expect(p[1]).toBeCloseTo(guide.arc[0][1])
      expect(p[2]).toBeCloseTo(guide.arc[0][2])
    }
  })

  it('a negative angle winds the other way', () => {
    const guide = buildRollGuide([0, 0, 0], [0, 0, 1], -90, 1)!
    const posGuide = buildRollGuide([0, 0, 0], [0, 0, 1], 90, 1)!
    expect(guide.tip[0]).toBeCloseTo(-posGuide.tip[0])
    expect(guide.tip[1]).toBeCloseTo(-posGuide.tip[1])
    expect(guide.tip[2]).toBeCloseTo(-posGuide.tip[2])
  })

  it('uses the part basis for zero roll so it matches the anchor triad', () => {
    // A part rotated 45 deg about Z: its X basis is (s, s, 0), so the derived
    // secondary arm is (-s, s, 0). The guide must start there, not at world +Y,
    // or it disagrees with the triad drawn at the same anchor.
    const s = Math.SQRT1_2
    const basis: Vec3[] = [[s, s, 0], [-s, s, 0], [0, 0, 1]]
    const guide = buildRollGuide([0, 0, 0], [0, 0, 1], 0, 1, basis)!
    expect(guide.arc[0][0]).toBeCloseTo(-s, 6)
    expect(guide.arc[0][1]).toBeCloseTo(s, 6)
    expect(guide.arc[0][2]).toBeCloseTo(0, 6)
  })

  it('a degenerate axis yields no guide rather than NaN points', () => {
    expect(buildRollGuide([0, 0, 0], [0, 0, 0], 45, 1)).toBeNull()
  })

  it('a non-finite angle yields no guide', () => {
    expect(buildRollGuide([0, 0, 0], [0, 0, 1], NaN, 1)).toBeNull()
  })
})
