// The viewer-debug flag owns the probe's lifetime in both panes. This pins the
// flag-to-attach/detach wiring itself, not just the store toggle and the hook in
// isolation: a regression that ignores the flag or leaves a wrapper installed
// would pass the pure tests but fail here.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useViewOptionsStore } from '@/stores/viewOptionsStore'
import { useShaderProbe, type ProbeProgram, type ShaderProbeRenderer } from '@/components/Viewport/shaderProbe'

const compiled = (name: string): ProbeProgram => ({ name, cacheKey: 'key-1' })

describe('useShaderProbe', () => {
  let original: ReturnType<typeof vi.fn>
  let gl: ShaderProbeRenderer
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    useViewOptionsStore.setState({ shaderProbe: false })
    original = vi.fn(() => {})
    gl = { info: { programs: [] }, render: original }
    log = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('leaves the renderer alone while the flag is off', () => {
    renderHook(() => useShaderProbe({ current: gl }, 1, 'part'))
    expect(gl.render).toBe(original)
  })

  it('waits for a ready renderer before attaching', () => {
    const glRef = { current: null as ShaderProbeRenderer | null }
    act(() => { useViewOptionsStore.getState().setShaderProbe(true) })
    const { rerender } = renderHook(
      ({ ready }) => useShaderProbe(glRef, ready, 'part'),
      { initialProps: { ready: 0 } },
    )
    expect(gl.render).toBe(original)

    glRef.current = gl
    rerender({ ready: 1 })
    expect(gl.render).not.toBe(original)
  })

  it('attaches on a flag toggle, logs through the wrapper, and detaches when turned off', () => {
    const glRef = { current: gl }
    const { unmount } = renderHook(() => useShaderProbe(glRef, 1, 'assembly'))
    expect(gl.render).toBe(original)

    act(() => { useViewOptionsStore.getState().setShaderProbe(true) })
    const wrapped = gl.render
    expect(wrapped).not.toBe(original)

    original.mockImplementationOnce(() => { gl.info.programs!.push(compiled('mesh')) })
    wrapped(null, null)
    expect(log).toHaveBeenCalledTimes(1)
    expect(String(log.mock.calls[0][0])).toContain('[shader-probe assembly]')

    act(() => { useViewOptionsStore.getState().setShaderProbe(false) })
    expect(gl.render).toBe(original)
    unmount()
  })

  it('detaches on unmount so a remount cannot stack wrappers', () => {
    act(() => { useViewOptionsStore.getState().setShaderProbe(true) })
    const { unmount } = renderHook(() => useShaderProbe({ current: gl }, 1, 'part'))
    expect(gl.render).not.toBe(original)

    unmount()
    expect(gl.render).toBe(original)
  })
})
