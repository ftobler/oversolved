import { describe, it, expect } from 'vitest'
import {
  mirrorAxisFromLineParams,
  mirrorAxisAngleDeg,
  mirrorPoint,
  mirrorVector,
  mirrorAngleDeg,
  mirrorArcAngles,
  mirrorEntityParams,
  canonicalVertexPositions,
  mirrorVertexKey,
  type MirrorAxis,
} from '@/utils/geometry/mirrorSketch'

// Pure reflection math behind the sketch mirror. These pin the hand-calculated
// cases (axis-aligned axes have closed-form answers) and the geometric invariants
// (midpoint on the axis, displacement perpendicular to it) for an arbitrary angle,
// because the arc/ellipse handedness rule is the part a later refactor can get
// subtly wrong: a directly mirrored arc pair names the complementary arc.

const X_AXIS: MirrorAxis = { x1: 0, y1: 0, x2: 5, y2: 0 }
const Y_AXIS: MirrorAxis = { x1: 0, y1: -5, x2: 0, y2: 5 }
const DIAG: MirrorAxis = { x1: 0, y1: 0, x2: 1, y2: 1 }
const OFFSET_V: MirrorAxis = { x1: 2, y1: -5, x2: 2, y2: 5 }

/** An axis at 30 deg through (1, 1), the arbitrary-angle fixture. */
const TILTED: MirrorAxis = { x1: 1, y1: 1, x2: 1 + Math.cos(Math.PI / 6), y2: 1 + Math.sin(Math.PI / 6) }

/** The two invariants a reflection must satisfy for every input: the segment
 *  joining P and P' is perpendicular to the axis, and its midpoint is on the axis.
 *  Tolerance fits rounded params (1e-6); raw mirrorPoint output agrees far closer. */
function expectValidReflection(p: [number, number], pMirror: [number, number], axis: MirrorAxis): void {
  const ux = axis.x2 - axis.x1
  const uy = axis.y2 - axis.y1
  const mid: [number, number] = [(p[0] + pMirror[0]) / 2, (p[1] + pMirror[1]) / 2]
  const dx = pMirror[0] - p[0]
  const dy = pMirror[1] - p[1]
  expect(dx * ux + dy * uy).toBeCloseTo(0, 4)
  const cross = (mid[0] - axis.x1) * uy - (mid[1] - axis.y1) * ux
  expect(cross).toBeCloseTo(0, 4)
}

describe('mirrorAxisFromLineParams', () => {
  it('accepts a finite non-degenerate line block', () => {
    expect(mirrorAxisFromLineParams([1, 2, 3, 4])).toEqual({ x1: 1, y1: 2, x2: 3, y2: 4 })
  })
  it('refuses a degenerate segment and a malformed or non-finite block', () => {
    expect(mirrorAxisFromLineParams([2, 3, 2, 3])).toBeNull()
    expect(mirrorAxisFromLineParams([0, 0, 1e-10, 0])).toBeNull()  // noise axis, not a direction
    expect(mirrorAxisFromLineParams([0, 0, 1])).toBeNull()
    expect(mirrorAxisFromLineParams([0, NaN, 1, 0])).toBeNull()
    expect(mirrorAxisFromLineParams([0, Infinity, 1, 0])).toBeNull()
  })
})

describe('mirrorPoint', () => {
  it('reflects closed-form answers across the axis-aligned and diagonal axes', () => {
    expect(mirrorPoint([2, 3], X_AXIS)).toEqual([2, -3])
    expect(mirrorPoint([2, 3], Y_AXIS)).toEqual([-2, 3])
    expect(mirrorPoint([2, 3], DIAG)).toEqual([3, 2])
    expect(mirrorPoint([5, 3], OFFSET_V)).toEqual([-1, 3])  // axis x=2: distance 3 flips to -3
  })
  it('reflects an arbitrary axis by its invariants', () => {
    for (const p of [[4, 2], [1, 1], [-3, 7], [0, 0]] as [number, number][]) {
      expectValidReflection(p, mirrorPoint(p, TILTED), TILTED)
    }
  })
  it('is an involution', () => {
    const once = mirrorPoint([4, 2], TILTED)
    const twice = mirrorPoint(once, TILTED)
    expect(twice[0]).toBeCloseTo(4, 9)
    expect(twice[1]).toBeCloseTo(2, 9)
  })
})

describe('mirrorAxisAngleDeg', () => {
  it('reports the axis direction angle', () => {
    expect(mirrorAxisAngleDeg(X_AXIS)).toBeCloseTo(0, 9)
    expect(mirrorAxisAngleDeg(DIAG)).toBeCloseTo(45, 9)
    expect(mirrorAxisAngleDeg({ x1: 0, y1: 0, x2: -1, y2: 0 })).toBeCloseTo(180, 9)
  })
})

describe('mirrorVector', () => {
  it('reflects a free offset without an anchor point', () => {
    expect(mirrorVector([1, 2], X_AXIS)).toEqual([1, -2])
    expect(mirrorVector([1, 2], DIAG)).toEqual([2, 1])
  })
})

describe('mirrorAngleDeg and mirrorArcAngles', () => {
  it('reflects a single angle as 2*alpha - angle', () => {
    expect(mirrorAngleDeg(30, 0)).toBeCloseTo(-30, 9)
    expect(mirrorAngleDeg(30, 45)).toBeCloseTo(60, 9)
  })

  it('mirrors an arc across the x-axis by swapping to the image-endpoint sweep', () => {
    // 30..120 across y=0: images are -30 and -120; the authored CCW form runs
    // from the image of the old END (-120 = 240) CCW to the image of the old
    // START (-30 = 330). A direct (30,120) -> (330,240) would name the
    // complementary 210-deg arc.
    expect(mirrorArcAngles(30, 120, 0)).toEqual([240, 330])
  })

  it('mirrors an arc across a 45 deg and a 90 deg axis', () => {
    expect(mirrorArcAngles(30, 120, 45)).toEqual([330, 420])
    expect(mirrorArcAngles(30, 120, 90)).toEqual([60, 150])
  })

  it('keeps a wrap-authored arc and a full-circle arc closed', () => {
    // (300, 60) sweeps 120 CCW across 0; across y=0 that is the same endpoint
    // pair mirrored: 60 -> 300, 300 -> 60, so the CCW form starts at 300.
    expect(mirrorArcAngles(300, 60, 0)).toEqual([300, 420])
    // 0..360 is a closed circle arc; its span must not collapse to zero.
    expect(mirrorArcAngles(0, 360, 30)).toEqual([60, 420])
  })

  it('preserves the sweep and mirrors both endpoints for an arbitrary axis', () => {
    const alpha = mirrorAxisAngleDeg(TILTED)
    for (const [a0, a1] of [[30, 120], [300, 60], [10, 190]] as [number, number][]) {
      const [b0, b1] = mirrorArcAngles(a0, a1, alpha)
      expect(((b1 - b0) % 360 + 360) % 360).toBeCloseTo(((a1 - a0) % 360 + 360) % 360, 9)
      const image0 = ((mirrorAngleDeg(a0, alpha) % 360) + 360) % 360
      const image1 = ((mirrorAngleDeg(a1, alpha) % 360) + 360) % 360
      expect(((b0 % 360) + 360) % 360).toBeCloseTo(image1, 9)  // new start = image of old end
      expect(((b1 % 360) + 360) % 360).toBeCloseTo(image0, 9)  // new end   = image of old start
    }
  })

  it('mirroring an arc twice returns the original endpoint positions', () => {
    const alpha = 30
    const [b0, b1] = mirrorArcAngles(300, 60, alpha)
    const [c0, c1] = mirrorArcAngles(b0, b1, alpha)
    expect(Math.cos(c0 * Math.PI / 180)).toBeCloseTo(Math.cos(300 * Math.PI / 180), 9)
    expect(Math.sin(c0 * Math.PI / 180)).toBeCloseTo(Math.sin(300 * Math.PI / 180), 9)
    expect(Math.cos(c1 * Math.PI / 180)).toBeCloseTo(Math.cos(60 * Math.PI / 180), 9)
    expect(Math.sin(c1 * Math.PI / 180)).toBeCloseTo(Math.sin(60 * Math.PI / 180), 9)
  })
})

describe('mirrorEntityParams', () => {
  it('mirrors every coordinate of every entity kind (x-axis)', () => {
    expect(mirrorEntityParams('line', [1, 2, 3, 4], X_AXIS)).toEqual([1, -2, 3, -4])
    expect(mirrorEntityParams('point', [1, 2], X_AXIS)).toEqual([1, -2])
    expect(mirrorEntityParams('circle', [1, 2, 5], X_AXIS)).toEqual([1, -2, 5])
    expect(mirrorEntityParams('arc', [0, 0, 5, 30, 120], X_AXIS)).toEqual([0, 0, 5, 240, 330])
    expect(mirrorEntityParams('ellipse', [1, 1, 3, 2, 30], X_AXIS)).toEqual([1, -1, 3, 2, -30])
    expect(mirrorEntityParams('spline', [0, 0, 1, 1, 2, 1, 3, 0], X_AXIS)).toEqual([0, 0, 1, -1, 2, -1, 3, 0])
    const fit = [0, 0, 5, 5, 10, 0, 1, 1, 9, -1]
    expect(mirrorEntityParams('fit_spline', fit, X_AXIS, 'both')).toEqual([0, 0, 5, -5, 10, 0, 1, -1, 9, 1])
  })

  it('mirrors an arbitrary-angle axis consistently with mirrorPoint for coordinate kinds', () => {
    const params = [1, 2, 3, 4]
    const out = mirrorEntityParams('line', params, TILTED)
    expect(out).not.toBeNull()
    expectValidReflection([1, 2], [out![0], out![1]], TILTED)
    expectValidReflection([3, 4], [out![2], out![3]], TILTED)
  })

  it('keeps a fit spline without handles mirrored point-for-point', () => {
    const out = mirrorEntityParams('fit_spline', [0, 1, 2, 3, 4, 5], X_AXIS)
    expect(out).toEqual([0, -1, 2, -3, 4, -5])
  })

  it('refuses malformed blocks, unknown kinds and non-finite input', () => {
    expect(mirrorEntityParams('line', [1, 2, 3], X_AXIS)).toBeNull()
    expect(mirrorEntityParams('arc', [0, 0, 5, 30], X_AXIS)).toBeNull()
    expect(mirrorEntityParams('blob', [1, 2], X_AXIS)).toBeNull()
    expect(mirrorEntityParams('point', [1, NaN], X_AXIS)).toBeNull()
    expect(mirrorEntityParams('point', [1, 2], { x1: 0, y1: 0, x2: 0, y2: 0 })).toBeNull()
    // A handles flag that disagrees with the block length is a malformed block.
    expect(mirrorEntityParams('fit_spline', [0, 1, 2, 3], X_AXIS, 'both')).toBeNull()
  })

  it('is deterministic and an involution on canonical positions', () => {
    const arc = [4, 5, 2, 300, 60]
    const once = mirrorEntityParams('arc', arc, TILTED)!
    const again = mirrorEntityParams('arc', arc, TILTED)!
    expect(again).toEqual(once)
    const twice = mirrorEntityParams('arc', once, TILTED)!
    const before = canonicalVertexPositions('arc', arc)!
    const back = canonicalVertexPositions('arc', twice)!
    for (const key of ['center', 'start', 'end']) {
      expect(back[key][0]).toBeCloseTo(before[key][0], 5)
      expect(back[key][1]).toBeCloseTo(before[key][1], 5)
    }
  })
})

describe('canonicalVertexPositions', () => {
  it('derives the arc angle endpoints alongside the center', () => {
    const v = canonicalVertexPositions('arc', [0, 0, 2, 0, 90])!
    expect(v.center).toEqual([0, 0])
    expect(v.start[0]).toBeCloseTo(2, 9)
    expect(v.end[1]).toBeCloseTo(2, 9)
  })
  it('derives the ellipse axis endpoints', () => {
    const v = canonicalVertexPositions('ellipse', [0, 0, 2, 1, 0])!
    expect(v.major1[0]).toBeCloseTo(2, 9)
    expect(v.minor1[1]).toBeCloseTo(1, 9)
  })
  it('names the fit points and handles of a fit spline', () => {
    const v = canonicalVertexPositions('fit_spline', [0, 0, 1, 1, 2, 0], undefined)!
    expect(Object.keys(v).sort()).toEqual(['end', 'fit1', 'start'])
  })
})

describe('mirrorVertexKey', () => {
  it('swaps arc start and end, the consequence of the angle formula', () => {
    const arc = [0, 0, 5, 30, 120]
    expect(mirrorVertexKey('arc', 'start', arc, X_AXIS)).toBe('end')
    expect(mirrorVertexKey('arc', 'end', arc, X_AXIS)).toBe('start')
    expect(mirrorVertexKey('arc', 'center', arc, X_AXIS)).toBe('center')
  })

  it('keeps line, spline and fit keys by position', () => {
    expect(mirrorVertexKey('line', 'start', [1, 2, 3, 4], TILTED)).toBe('start')
    expect(mirrorVertexKey('spline', 'c2', [0, 0, 1, 1, 2, 1, 3, 0], X_AXIS)).toBe('c2')
    expect(mirrorVertexKey('fit_spline', 'fit1', [0, 0, 5, 5, 10, 0], X_AXIS, undefined)).toBe('fit1')
    expect(mirrorVertexKey('point', 'xy', [1, 2], Y_AXIS)).toBe('xy')
  })

  it('maps ellipse axis endpoints by position (minor ends flip sides)', () => {
    const ellipse = [0, 0, 2, 1, 30]
    expect(mirrorVertexKey('ellipse', 'major1', ellipse, X_AXIS)).toBe('major1')
    expect(mirrorVertexKey('ellipse', 'minor1', ellipse, X_AXIS)).toBe('minor2')
  })

  it('refuses a key the kind does not carry', () => {
    expect(mirrorVertexKey('circle', 'start', [0, 0, 3], X_AXIS)).toBeNull()
    expect(mirrorVertexKey('line', 'bogus', [1, 2, 3, 4], X_AXIS)).toBeNull()
  })
})
