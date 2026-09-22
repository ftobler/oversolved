import { describe, it, expect } from 'vitest'
import { IdRenderTarget } from '../IdRenderTarget'

// The target's size drives the pick readback window and every layer's
// onBeforeRender viewport, so the clamp and the no-op resize are load-bearing:
// a zero/negative size would make the GPU target unusable, and a same-size
// resize must not invalidate an otherwise clean buffer on every driver tick.
describe('IdRenderTarget', () => {
  it('clamps a sub-pixel constructor size up to 1', () => {
    const t = new IdRenderTarget(0, -5)
    expect(t.getWidth()).toBe(1)
    expect(t.getHeight()).toBe(1)
    t.dispose()
  })

  it('resize floors fractional sizes and clamps to at least 1', () => {
    const t = new IdRenderTarget(10, 10)
    t.resize(48.9, 0.2)
    expect(t.getWidth()).toBe(48)
    expect(t.getHeight()).toBe(1)
    t.dispose()
  })

  it('a resize to the same dimensions is a no-op that keeps the buffer clean', () => {
    const t = new IdRenderTarget(32, 24)
    t.markClean()
    t.resize(32, 24)
    expect(t.isDirty()).toBe(false)
    t.resize(32.9, 24.9)  // floors back to the same 32x24
    expect(t.isDirty()).toBe(false)
    expect(t.getWidth()).toBe(32)
    expect(t.getHeight()).toBe(24)
    t.dispose()
  })

  it('a resize that changes the size marks the target dirty', () => {
    const t = new IdRenderTarget(32, 24)
    t.markClean()
    t.resize(33, 24)
    expect(t.isDirty()).toBe(true)
    expect(t.getWidth()).toBe(33)
    expect(t.getHeight()).toBe(24)
    t.dispose()
  })

  it('markDirty and markClean toggle the dirty flag', () => {
    const t = new IdRenderTarget(8, 8)
    t.markClean()
    expect(t.isDirty()).toBe(false)
    t.markDirty()
    expect(t.isDirty()).toBe(true)
    t.dispose()
  })
})
