import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { Mesh3D } from '@/types/cad'
import { IdPipeline, FACE_LAYER_NAME } from '@/picking'
import { setLivePipeline, getLivePipeline } from '@/picking/IdPipelineContext'
import { useIdPipelineLifecycle } from '@/picking/useIdPipelineLifecycle'
import { useFaceIdRegistration } from '@/picking/useFaceIdRegistration'
import { useIdBufferPointerDispatch } from '@/components/Viewport/idDispatch/useIdBufferPointerDispatch'
import { registerBodyCallbacks, resetBodyCallbacksForTest } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'

// The cold-load fix (e947f35c) minted a fresh IdPipeline per Suspense reveal so
// click selection resolves against a live pipeline. Hover rides the SAME
// getLivePipeline() contract (useIdBufferPointerDispatch.resolveHover), so a
// reveal must leave hover resolvable too. This integration test pins that:
// after a hide/reveal cycle a hover still resolves against the live (non-disposed)
// pipeline and drives hoveredSelectionId, and crucially never resolves against
// the now-disposed pre-reveal pipeline.

function makeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 64
  c.getBoundingClientRect = () => ({
    x: 0, y: 0, top: 0, left: 0, right: 64, bottom: 64, width: 64, height: 64, toJSON() { return {} },
  })
  return c
}

function faceMesh(): Mesh3D {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    faces: new Uint32Array([0, 1, 2]),
    triangle_to_face: [0],
    face_queries: ['f/face/0'],
  }
}

// A Suspense hide/reveal is, to the subtree, a cleanup-then-setup cycle. Mount the
// lifecycle (which mints + publishes a pipeline), useRegister a body, and wire the
// part-editor hover dispatch against the same live pipeline.
function Harness({ useRegister, dispatchProps }: {
  useRegister: () => void
  dispatchProps: { glRef: { current: import('three').WebGLRenderer | null }; consumedLayers: ReadonlySet<string> }
}) {
  useIdPipelineLifecycle(() => new IdPipeline({ width: 64, height: 64 }))
  useRegister()
  useIdBufferPointerDispatch(dispatchProps)
  return null
}

async function flushHoverFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    await Promise.resolve()
  })
}

describe('hover highlight after a cold-load / Suspense reveal', () => {
  let canvas: HTMLCanvasElement
  let glRef: { current: import('three').WebGLRenderer | null }

  beforeEach(() => {
    resetBodyCallbacksForTest()
    canvas = makeCanvas()
    glRef = { current: { domElement: canvas } as unknown as import('three').WebGLRenderer }
    useSketchEditorStore.setState({ activeTool: null, hoveredSelectionId: null, hoveredPickKey: null })
  })

  afterEach(() => {
    resetBodyCallbacksForTest()
    setLivePipeline(null)
  })

  it('resolves hover against the live pipeline after a hide/reveal, not the disposed one', async () => {
    const useRegister = () => {
      // The body's face query must be known to the hover adapter so a resolved
      // face hit actually drives hoveredSelectionId (mirrors Body3D registration).
      registerBodyCallbacks('f/b', {
        featureId: 'f', bodyId: 'b',
        mesh: faceMesh() as unknown as Mesh3D,
        edgeQueries: undefined, vertexQueries: undefined,
        updateFaceGeometryForIndex: () => {}, clearFaceGeometry: () => {},
      })
      useFaceIdRegistration({ featureId: 'f', bodyId: 'b', mesh: faceMesh() })
    }
    const dispatchProps = { glRef, consumedLayers: new Set([FACE_LAYER_NAME]) }

    // Cold mount: pipeline A is minted and published, the body registers into it.
    const view = render(<Harness useRegister={useRegister} dispatchProps={dispatchProps} />)
    const A = getLivePipeline() as IdPipeline
    expect(A.isDisposed()).toBe(false)
    expect(A.faceLayer.bodyCount()).toBe(1)

    const hitA = { id: 1, layer: FACE_LAYER_NAME, entityKey: 'f/face/0', distancePx: 0 }
    A.resolveAsync = vi.fn().mockImplementation(async () => hitA)

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 32, clientY: 32 }))
    })
    await flushHoverFrame()
    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('f/face/0')

    // The reveal: the boundary hides then re-shows the subtree. This is exactly
    // the cleanup-then-setup cycle that used to republish a disposed pipeline.
    act(() => { view.unmount() })
    expect(A.isDisposed()).toBe(true)
    expect(getLivePipeline()).toBeNull()

    // A re-published spy on A: if hover were still wired to the stale pipeline it
    // would call this after the reveal. It must not.
    A.resolveAsync = vi.fn()

    const view2 = render(<Harness useRegister={useRegister} dispatchProps={dispatchProps} />)
    const B = getLivePipeline() as IdPipeline
    expect(B).not.toBe(A)
    expect(B.isDisposed()).toBe(false)
    // Geometry converged on the fresh pipeline, so a real readback would find it.
    expect(B.faceLayer.bodyCount()).toBe(1)

    const hitB = { id: 2, layer: FACE_LAYER_NAME, entityKey: 'f/face/0', distancePx: 0 }
    B.resolveAsync = vi.fn().mockImplementation(async () => hitB)

    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 32, clientY: 32 }))
    })
    await flushHoverFrame()

    expect(useSketchEditorStore.getState().hoveredSelectionId).toBe('f/face/0')
    // Hover resolved against the live pipeline, never the disposed one.
    expect(B.resolveAsync).toHaveBeenCalled()
    expect(A.resolveAsync).not.toHaveBeenCalled()

    view2.unmount()
  })
})
