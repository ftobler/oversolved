import { describe, it, expect } from 'vitest'
import { INITIAL_CAMERA } from '@/components/Viewport/cameraConstants'

// The first-frame clip planes. Large models are fitToContent's problem (it
// resizes both planes); what matters here is that the near plane reaches behind
// the camera at all, and that the range stays narrow enough for the depth
// buffer -- Body3D's polygonOffsetUnits=1 is one resolution unit of this range,
// so a wide range shows up as small parts turning transparent.
describe('INITIAL_CAMERA clipping planes', () => {
  const standoff = Math.hypot(...INITIAL_CAMERA.position)

  it('keeps a valid ortho range', () => {
    expect(INITIAL_CAMERA.far).toBeGreaterThan(INITIAL_CAMERA.near)
  })

  it('reaches behind the camera plane, not just in front of it', () => {
    expect(INITIAL_CAMERA.near).toBeLessThan(-standoff)
  })

  it('keeps the depth range tight enough for the polygon offset', () => {
    expect(INITIAL_CAMERA.far - INITIAL_CAMERA.near).toBeLessThanOrEqual(2000)
  })
})
