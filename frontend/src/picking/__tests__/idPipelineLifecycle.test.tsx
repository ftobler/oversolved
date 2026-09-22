import { describe, it, expect, vi, afterEach } from 'vitest'
import { StrictMode, useEffect } from 'react'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'
import { IdPipeline } from '../IdPipeline'
import { setLivePipeline, getLivePipeline } from '../IdPipelineContext'
import { useIdPipelineLifecycle, type IdPipelineLifecycle } from '../useIdPipelineLifecycle'

function makeFactory() {
  return () => new IdPipeline({ width: 32, height: 32 })
}

function goodRenderer(): THREE.WebGLRenderer {
  return {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    autoClear: true,
    getClearColor: () => {},
    getClearAlpha: () => 0,
    setClearColor: () => {},
    clear: () => {},
    clearDepth: () => {},
    render: () => {},
    getViewport: () => new THREE.Vector4(),
    setViewport: () => {},
    getScissor: () => new THREE.Vector4(),
    setScissor: () => {},
    getScissorTest: () => false,
    setScissorTest: () => {},
    readRenderTargetPixels: () => {},
  } as unknown as THREE.WebGLRenderer
}

function throwingRenderer(): THREE.WebGLRenderer {
  // Throw inside IdPipeline.render's outer try (before the per-layer loop, which
  // swallows its own errors): a disposed GL target makes the GL setup calls
  // throw, and the error must escape render() to trip the lifecycle latch.
  const r = goodRenderer() as unknown as Record<string, unknown>
  r.clear = () => { throw new Error('render target is disposed') }
  return r as unknown as THREE.WebGLRenderer
}

// ─── R1: StrictMode as the hide/reveal stand-in ───

function Harness({ onPipeline }: { onPipeline?: (p: IdPipeline | null) => void }) {
  const { pipeline } = useIdPipelineLifecycle(makeFactory())
  useEffect(() => { onPipeline?.(pipeline) }, [pipeline, onPipeline])
  return null
}

// Holds only the latest lifecycle object: on mount the effect runs with the
// pre-effect render first (pipeline === null) and again after the state update,
// so reading `.current` after render gives the live pipeline.
function Capture({ capturedRef }: { capturedRef: { current: IdPipelineLifecycle | null } }) {
  const lc = useIdPipelineLifecycle(makeFactory())
  // eslint-disable-next-line react-hooks/exhaustive-deps -- effect intentionally captures the latest lifecycle on every render
  useEffect(() => { capturedRef.current = lc }, [lc])
  return null
}

// A Suspense hide/reveal is, to the subtree, a cleanup-then-setup cycle: React
// unmounts the hidden children (running effect cleanups) and remounts them when
// the boundary resolves. The tests below reproduce that faithfully and
// deterministically via unmount + remount, which is bit-for-bit the same
// lifecycle the production Suspense boundary performs.

describe('useIdPipelineLifecycle (F1)', () => {
  afterEach(() => { setLivePipeline(null) })

  it('publishes a live pipeline on mount', () => {
    render(<Harness />)
    const live = getLivePipeline()
    expect(live).not.toBeNull()
    expect(live!.isDisposed()).toBe(false)
  })

  it('unpublishes and disposes on unmount', () => {
    const { unmount } = render(<Harness />)
    const before = getLivePipeline()!
    expect(before).not.toBeNull()
    unmount()
    expect(getLivePipeline()).toBeNull()
    expect(before.isDisposed()).toBe(true)
  })

  it('never publishes a disposed pipeline after a StrictMode double mount', () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )
    const live = getLivePipeline()
    expect(live).not.toBeNull()
    // The cleanup-then-setup cycle must have minted a fresh, live instance.
    expect(live!.isDisposed()).toBe(false)
  })

  // ─── R2: hide (cleanup) then reveal (setup), exactly what Suspense does ───

  it('never publishes a disposed pipeline after a hide and reveal', () => {
    const captured: { current: IdPipelineLifecycle | null } = { current: null }
    const view = render(<Capture capturedRef={captured} />)
    const before = captured.current!.pipeline!
    expect(before.isDisposed()).toBe(false)
    // Hide: React unmounts the subtree, running the lifecycle cleanup (dispose).
    act(() => { view.unmount() })
    expect(before.isDisposed()).toBe(true)
    expect(getLivePipeline()).toBeNull()
    // Reveal: a fresh mount mints a brand new, live pipeline.
    render(<Capture capturedRef={captured} />)
    const after = captured.current!.pipeline!
    expect(after).not.toBe(before)
    expect(after.isDisposed()).toBe(false)
    expect(after).toBe(getLivePipeline())
  })

  it('mints a fresh pipeline per reveal and disposes the previous one', () => {
    const disposeSpy = vi.spyOn(IdPipeline.prototype, 'dispose')
    const captured: { current: IdPipelineLifecycle | null } = { current: null }
    try {
      const view = render(<Capture capturedRef={captured} />)
      const first = captured.current!.pipeline!
      // Hide + reveal.
      act(() => { view.unmount() })
      render(<Capture capturedRef={captured} />)
      const second = captured.current!.pipeline!

      expect(first).not.toBe(second)
      expect(first.isDisposed()).toBe(true)
      expect(second.isDisposed()).toBe(false)
      expect(second).toBe(getLivePipeline())
      // The previous pipeline was torn down rather than left live.
      expect(disposeSpy.mock.calls.length).toBe(1)
    } finally {
      disposeSpy.mockRestore()
    }
  })

  // ─── C2 guard: the render-failure latch re-arms with the pipeline ───

  it('re-arms the render-failure latch when the pipeline is recreated', () => {
    const captured: { current: IdPipelineLifecycle | null } = { current: null }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const camera = new THREE.Camera()
    try {
      const view = render(<Capture capturedRef={captured} />)
      const lc1 = captured.current!
      const p1 = lc1.pipeline!
      expect(p1.isDisposed()).toBe(false)

      // First render throws: the latch engages and disables p1.
      p1.markDirty()
      lc1.tryRender(throwingRenderer(), camera)
      expect(p1.getRenderCount()).toBe(0)
      // A second attempt is skipped by the latch.
      p1.markDirty()
      lc1.tryRender(throwingRenderer(), camera)
      expect(p1.getRenderCount()).toBe(0)

      // Hide + reveal: a fresh pipeline is minted with a clean latch.
      act(() => { view.unmount() })
      render(<Capture capturedRef={captured} />)
      const lc2 = captured.current!
      const p2 = lc2.pipeline!
      expect(p2).not.toBe(p1)
      expect(p2.isDisposed()).toBe(false)
      // The new pipeline's latch is clean, so it renders despite p1 having failed.
      p2.markDirty()
      lc2.tryRender(goodRenderer(), camera)
      expect(p2.getRenderCount()).toBe(1)
    } finally {
      warn.mockRestore()
    }
  })

  it('tryRender after the pipeline is torn down is a no-op', () => {
    const captured: { current: IdPipelineLifecycle | null } = { current: null }
    const view = render(<Capture capturedRef={captured} />)
    const lc = captured.current!
    expect(lc.pipeline).not.toBeNull()

    act(() => { view.unmount() })

    // pipelineRef is cleared by the cleanup, so tryRender must return before
    // touching the renderer at all.
    const renderer = new Proxy({}, {
      get() { throw new Error('renderer must not be read after teardown') },
    }) as unknown as THREE.WebGLRenderer
    expect(() => lc.tryRender(renderer, new THREE.Camera())).not.toThrow()
  })
})
