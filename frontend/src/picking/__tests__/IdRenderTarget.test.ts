import { describe, it, expect, vi } from 'vitest'
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

  it('adds a stencil only on request, and swaps the target without leaking the old one', () => {
    const t = new IdRenderTarget(16, 12)
    expect(t.hasStencil()).toBe(false)
    expect(t.target.stencilBuffer).toBe(false)
    const first = t.target
    const disposed = vi.fn()
    first.addEventListener('dispose', disposed)

    t.markClean()
    t.setStencil(true)
    expect(t.hasStencil()).toBe(true)
    expect(t.target.stencilBuffer).toBe(true)
    expect(t.target).not.toBe(first)
    expect(disposed).toHaveBeenCalledOnce()
    // The next pick has to render into the new attachment set.
    expect(t.isDirty()).toBe(true)
    expect([t.getWidth(), t.getHeight()]).toEqual([16, 12])

    t.setStencil(true)
    const stencilTarget = t.target
    t.setStencil(true)
    expect(t.target).toBe(stencilTarget)
    t.setStencil(false)
    expect(t.hasStencil()).toBe(false)
    expect(t.target.stencilBuffer).toBe(false)
    t.dispose()
  })

  it('keeps the stencil attachment across a resize', () => {
    const t = new IdRenderTarget(8, 8, true)
    t.resize(20, 10)
    expect(t.hasStencil()).toBe(true)
    expect(t.target.stencilBuffer).toBe(true)
    expect([t.getWidth(), t.getHeight()]).toEqual([20, 10])
    t.dispose()
  })
})
