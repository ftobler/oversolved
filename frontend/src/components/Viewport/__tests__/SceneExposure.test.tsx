// The Brightness row writes the renderer's toneMappingExposure and asks for a
// frame, because on-demand rendering has no instance change to notice. The
// default must be exactly 1 so an upgrade does not change the image.
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { DEFAULT_VIEW_PREFERENCES } from '@/adapters/preferences'
import { applyExposure, useSceneExposure, type ExposureTarget } from '@/components/Viewport/SceneExposure'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'

describe('SceneExposure', () => {
  const gl: ExposureTarget = { toneMappingExposure: 1 }
  const invalidate = vi.fn()

  beforeEach(() => {
    gl.toneMappingExposure = 1
    invalidate.mockClear()
    useViewOptionsStore.setState({ ...DEFAULT_VIEW_PREFERENCES })
  })

  it('writes the brightness once the renderer is ready and asks for a frame', () => {
    useViewOptionsStore.setState({ brightness: 1.6 })
    const glRef = { current: null as ExposureTarget | null }
    const { rerender } = renderHook(
      ({ ready }) => useSceneExposure(glRef, { current: invalidate }, ready),
      { initialProps: { ready: 0 } },
    )
    // The ref is empty until onCreated runs: an effect must not write nowhere.
    expect(invalidate).not.toHaveBeenCalled()

    glRef.current = gl
    rerender({ ready: 1 })
    expect(gl.toneMappingExposure).toBe(1.6)
    expect(invalidate).toHaveBeenCalled()
  })

  it('defaults to today\'s look, exposure 1', () => {
    expect(useViewOptionsStore.getState().brightness).toBe(1)
    const glRef = { current: gl }
    renderHook(() => useSceneExposure(glRef, undefined, 1))
    expect(gl.toneMappingExposure).toBe(1)
  })

  it('follows a slider change and requests one frame per change', () => {
    const glRef = { current: gl }
    renderHook(() => useSceneExposure(glRef, { current: invalidate }, 1))
    invalidate.mockClear()

    act(() => { useViewOptionsStore.getState().setBrightness(0.5) })
    expect(gl.toneMappingExposure).toBe(0.5)
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('is a plain assignment so the store value is the authority', () => {
    // The store already clamps; applying a value must not clamp a second time
    // into a different number, or the slider and the image would disagree.
    applyExposure(gl, 2)
    expect(gl.toneMappingExposure).toBe(2)
    applyExposure(gl, 0.5)
    expect(gl.toneMappingExposure).toBe(0.5)
  })
})
