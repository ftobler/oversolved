// PURE LOGIC -- no WASM, no Three.js, no React.
// The policy that maps measured solver responses to a circle-rim drag mode.
// Keeping the numbers here (and out of the solver call) is what makes the mode
// decision testable without WASM; the probe that produces the responses lives in
// kernel/features/sketch.ts.
import { describe, it, expect } from 'vitest'
import {
  resolveDragMode,
  TRANSLATE_RESPONSE_MIN,
  RADIUS_RESPONSE_MIN,
} from './circleDragMode'

describe('resolveDragMode', () => {
  it('a responsive centre gives translate', () => {
    expect(resolveDragMode({ translateX: 1, translateY: 1, radius: 1 })).toBe('translate')
    // A centre free along both axes at a realistic (regularized) fraction.
    expect(resolveDragMode({ translateX: 0.9, translateY: 0.8, radius: 0.1 })).toBe('translate')
  })

  it('zero translate response with a responsive radius gives radius', () => {
    expect(resolveDragMode({ translateX: 0, translateY: 0, radius: 1 })).toBe('radius')
    expect(resolveDragMode({ translateX: 0.1, translateY: 0.1, radius: 0.9 })).toBe('radius')
  })

  it('both responses below threshold give locked', () => {
    expect(resolveDragMode({ translateX: 0, translateY: 0, radius: 0 })).toBe('locked')
    expect(resolveDragMode({ translateX: 0.1, translateY: 0.1, radius: 0.1 })).toBe('locked')
  })

  it('a centre free along x only still gives translate (max of the two orthogonal responses wins)', () => {
    // A centre pinned on Y (on a horizontal constraint) but free on X must stay
    // in translate mode; a single along-axis probe would misclassify it.
    expect(resolveDragMode({ translateX: 1, translateY: 0, radius: 0 })).toBe('translate')
    expect(resolveDragMode({ translateX: 0, translateY: 1, radius: 0 })).toBe('translate')
  })

  it('thresholds are exclusive at the boundary', () => {
    // Exactly at the translate minimum is NOT mobile: it falls through to radius.
    expect(resolveDragMode({ translateX: TRANSLATE_RESPONSE_MIN, translateY: 0, radius: 0 })).toBe('locked')
    // Exactly at the radius minimum with a pinned centre is NOT mobile either.
    expect(resolveDragMode({ translateX: 0, translateY: 0, radius: RADIUS_RESPONSE_MIN })).toBe('locked')
    // One epsilon above crosses into the mobile band.
    expect(resolveDragMode({ translateX: TRANSLATE_RESPONSE_MIN + 1e-9, translateY: 0, radius: 0 })).toBe('translate')
    expect(resolveDragMode({ translateX: 0, translateY: 0, radius: RADIUS_RESPONSE_MIN + 1e-9 })).toBe('radius')
  })
})
