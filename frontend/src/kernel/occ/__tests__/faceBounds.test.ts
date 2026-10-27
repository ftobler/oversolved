import { describe, it, expect } from 'vitest'
import { tightenAxis } from '../faceBounds'

describe('tightenAxis', () => {
  it('keeps an optimal bound that a sampled point can account for', () => {
    // A coarse mesh samples the cylinder's equator a little inside the true
    // radius; one edge of slack covers that and the exact read is kept.
    expect(tightenAxis([-10, 10], [-9.99, 9.99], null, 0.05)).toEqual([-10, 10])
  })

  it('replaces a bound the face cannot reach', () => {
    // A slab cut through a sphere removes the caps but leaves the surface's
    // parameter rectangle whole; the reads must fall back to face points.
    expect(tightenAxis([-7.945, 7.945], [-4, 4], [-4, 4], 1.2)).toEqual([-4, 4])
  })

  it('uses the boundary when it reaches farther than any node', () => {
    // Planar faces have exact edge boxes; their nodes may not sit on a corner.
    expect(tightenAxis([0, 40], [1, 39], [0, 40], 0.2)).toEqual([0, 40])
  })

  it('snaps tolerance padding back onto the face points', () => {
    // A planar face bounded by a spline edge reads 1e-7 past the plane.
    expect(tightenAxis([-1e-7, 13.0000001], [1, 13], [0, 13], 0.2)).toEqual([0, 13])
  })

  it('tightens each side independently', () => {
    // Only the positive side was trimmed away; the negative one is sampled.
    expect(tightenAxis([-7.945, 7.945], [-7.945, 4], null, 0.5)).toEqual([-7.945, 4])
  })

  it('falls back to the sampled extent when there is no boundary', () => {
    // A closed face (a full sphere) has no edges; only nodes are evidence.
    expect(tightenAxis([-7.945, 7.945], [-7.9, 7.9], null, 0.001)).toEqual([-7.9, 7.9])
  })
})
