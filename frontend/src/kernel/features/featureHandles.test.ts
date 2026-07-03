import { describe, it, expect } from 'vitest'
import { linearHandle, angularHandle, offsetAlong, HANDLE_MIN_VALUE, type FeatureHandle } from './featureHandles'
import type { FeatureHandleData } from '@/types/cad'

// The kernel's FeatureHandle and the frontend's FeatureHandleData describe
// the same structured-clone payload crossing the worker boundary. Pin the
// shape so the kernel cannot drift from the frontend without a compile error.
// Only the worker -> main (FeatureHandle -> FeatureHandleData) direction is
// asserted: the reverse never crosses, and the kernel keeps its index
// signature for structured-clone tolerance.
describe('FeatureHandle -> FeatureHandleData contract', () => {
  it('a FeatureHandle is assignable to FeatureHandleData', () => {
    const h: FeatureHandle = linearHandle('distance', [0, 0, 0], [0, 0, 1], 1)!
    const d: FeatureHandleData = h
    expect(d.kind).toBe('linear')
  })
})

const close = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length)
  for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 9)
}

describe('offsetAlong', () => {
  it('offsets along the normalized direction', () => {
    close(offsetAlong([1, 2, 3], [0, 0, 2], 5)!, [1, 2, 8])
  })

  it('returns null for a degenerate direction', () => {
    expect(offsetAlong([0, 0, 0], [0, 0, 0], 5)).toBeNull()
  })
})

describe('linearHandle', () => {
  it('normalizes the direction and keeps the anchor as given', () => {
    const h = linearHandle('distance', [1, 1, 10], [0, 0, 3], 10)!
    expect(h.kind).toBe('linear')
    expect(h.field).toBe('distance')
    close(h.anchor, [1, 1, 10])
    close(h.direction, [0, 0, 1])
    expect(h.value).toBe(10)
    expect(h.unit_scale).toBe(1)
    expect(h.min).toBe(HANDLE_MIN_VALUE)
  })

  it('carries the symmetric half-travel unit scale', () => {
    const h = linearHandle('distance', [0, 0, 5], [0, 0, 1], 10, 0.5)!
    expect(h.unit_scale).toBe(0.5)
  })

  it('returns null for a degenerate direction', () => {
    expect(linearHandle('distance', [0, 0, 0], [0, 0, 0], 10)).toBeNull()
  })
})

describe('angularHandle', () => {
  // Axis = +Z through origin, profile reference at x=2. A 90 degree normal
  // revolve puts the grab point at y=2 with the tangent pointing along -X.
  it('sweeps the reference point to the end angle', () => {
    const h = angularHandle('angle', [0, 0, 0], [0, 0, 1], [2, 0, 5], 90, 'normal')!
    close(h.anchor, [0, 2, 5])
    close(h.direction, [-1, 0, 0])
    expect(h.value).toBe(90)
    expect(h.unit_scale).toBeCloseTo((2 * Math.PI) / 180, 12)
    expect(h.max).toBe(360)
  })

  it('reverse sweeps the other way and keeps drag-positive = value-positive', () => {
    const h = angularHandle('angle', [0, 0, 0], [0, 0, 1], [2, 0, 0], 90, 'reverse')!
    close(h.anchor, [0, -2, 0])
    // Increasing a reverse angle sweeps further clockwise; at (0,-2) that
    // motion points along -X, so pulling -X grows the stored angle.
    close(h.direction, [-1, 0, 0])
    expect(h.unit_scale).toBeCloseTo((2 * Math.PI) / 180, 12)
  })

  it('symmetric grabs the positive half-angle end at half scale', () => {
    const h = angularHandle('angle', [0, 0, 0], [0, 0, 1], [2, 0, 0], 180, 'symmetric')!
    close(h.anchor, [0, 2, 0])
    expect(h.unit_scale).toBeCloseTo((2 * Math.PI) / 360, 12)
  })

  it('returns null when the reference point sits on the axis', () => {
    expect(angularHandle('angle', [0, 0, 0], [0, 0, 1], [0, 0, 7], 90, 'normal')).toBeNull()
  })

  it('returns null for a degenerate axis', () => {
    expect(angularHandle('angle', [0, 0, 0], [0, 0, 0], [2, 0, 0], 90, 'normal')).toBeNull()
  })
})
