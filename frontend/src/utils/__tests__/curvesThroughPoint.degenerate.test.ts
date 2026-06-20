import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { curvesThroughPoint } from '@/utils/geometry/curvesThroughPoint'

// Degenerate-geometry guards in curvesThroughPoint: a zero-length line has no
// well-defined perpendicular and is skipped; a near-zero-radius arc collapses to
// a point, so its span check admits any angle (full 360 slack) rather than
// dividing by a vanishing radius.

describe('curvesThroughPoint degenerate inputs', () => {
  it('skips a zero-length line even when the point coincides with it', () => {
    const sketch: Sketch = {
      pointLine: { start: [2, 2], end: [2, 2] },  // no direction -> no perpendicular
      realLine: { start: [0, 2], end: [4, 2] },   // horizontal through (2, 2)
    }
    // The degenerate line is dropped; only the real line through the point matches.
    expect(curvesThroughPoint(sketch, [2, 2], 1e-6)).toEqual(['realLine'])
  })

  it('matches a near-zero-radius arc by radial distance, span check waived', () => {
    const tiny: Sketch = {
      dot: { center: [0, 0], radius: 1e-9, angle_start: 0, angle_end: 90, start: [0, 0], end: [0, 0] },
    }
    // radius < tol -> the point at the center is within tol, and the angular slack
    // is a full turn, so the contact counts regardless of its computed angle.
    expect(curvesThroughPoint(tiny, [0, 0], 1e-6)).toEqual(['dot'])
  })
})
