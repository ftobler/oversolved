// The part-editor hover path is pinned by hoverAfterColdLoadReveal.test.tsx
// against the live pipeline after a Suspense hide/reveal. The ASSEMBLY editor
// resolves hover a different way: AssemblyViewport.resolveHitsAt reads
// pipelineRef.current (NOT getLivePipeline()), and that ref stays fresh only
// because IdPickingDriver's onReady re-fires in a useEffect keyed on [pipeline]
// for every fresh pipeline identity a reveal mints.
//
// This integration test mounts the REAL IdPickingDriver (R3F's Canvas/useFrame
// are stubbed so no WebGL context is needed) wired exactly like the assembly
// editor's pipelineRef + resolveHitsAt, replays a hide/reveal cycle (unmount
// then remount), and proves the post-reveal hover resolves against the FRESH,
// non-disposed pipeline B via pipelineRef.current, never the disposed pre-reveal
// pipeline A. The onReady re-fire is the real one, so this also pins that
// pipelineRef is updated to B on the identity change.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import { useCallback } from 'react'
import type * as THREE from 'three'
import type { Mesh3D } from '@/types/cad'
import { IdPipeline, FACE_LAYER_NAME } from '@/picking'
import { setLivePipeline, getLivePipeline } from '@/picking/IdPipelineContext'
import { useFaceIdRegistration } from '@/picking/useFaceIdRegistration'
import IdPickingDriver from '@/picking/IdPickingDriver'

// R3F is stubbed so IdPickingDriver mounts without a real WebGL Canvas. The
// pipeline lifecycle and the onReady re-fire are real; only the GL frame loop
// and the drawing-buffer readback are faked (we spy on resolveAllSync instead).
vi.mock('@react-three/fiber', () => {
  const gl = { getDrawingBufferSize: () => ({ x: 64, y: 64 }) }
  return {
    // Render the driver's subtree so the real IdPickingDriver mounts without a
    // real WebGL Canvas.
    Canvas: ({ children }: { children: unknown }) => children,
    // The size gl/renderer the driver mints its pipeline from; the readback is
    // never exercised because we spy on resolveAllSync.
    useThree: () => ({ gl, size: { width: 64, height: 64 } }),
    useFrame: () => {},
  }
})

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

// Mirrors AssemblyViewport's pipelineRef + resolveHitsAt: the ref is written by
// IdPickingDriver's onReady, and a hover reads pipelineRef.current exactly as
// the assembly editor does (line 280 of AssemblyViewport.tsx). IdPickingDriver
// is the REAL driver, so the onReady re-fire on a fresh pipeline is exercised.
function Harness({ pipelineRef, onReady }: {
  pipelineRef: { current: IdPipeline | null }
  onReady: (p: IdPipeline) => void
}) {
  const handleReady = useCallback((p: IdPipeline) => {
    pipelineRef.current = p
    onReady(p)
  }, [pipelineRef, onReady])
  // Register a body into the live pipeline, mirroring AssemblyPickLayers so the
  // post-reveal geometry converges on the fresh pipeline (faceLayer.bodyCount).
  useFaceIdRegistration({ featureId: 'f', bodyId: 'b', mesh: faceMesh() })
  return <IdPickingDriver onReady={handleReady} />
}

// Stands in for AssemblyViewport.resolveHitsAt: it reads pipelineRef.current and
// resolves through that pipeline. The resolver itself is not under test (it is a
// useCallback inside AssemblyViewport); this harness exists to prove the ref stays
// fresh across a reveal, so a stale disposed pipeline can never answer the hover.
// The spy on resolveAllSync records which pipeline instance actually answered.
function hoverThroughRef(
  glRef: { current: THREE.WebGLRenderer | null },
  pipelineRef: { current: IdPipeline | null },
  clientX: number,
  clientY: number,
  layers: ReadonlySet<string>,
): unknown[] {
  const gl = glRef.current
  const pipeline = pipelineRef.current
  if (!gl || !pipeline) return []
  const canvas = gl.domElement
  const rect = canvas.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return []
  const cursor = {
    x: (clientX - rect.left) * (canvas.width / rect.width),
    y: (clientY - rect.top) * (canvas.height / rect.height),
  }
  return pipeline.resolveAllSync(gl, cursor, { allowedLayers: layers })
}

describe('assembly hover after a cold-load / Suspense reveal', () => {
  let canvas: HTMLCanvasElement
  let glRef: { current: THREE.WebGLRenderer | null }
  let pipelineRef: { current: IdPipeline | null }
  let onReady: ReturnType<typeof vi.fn>

  beforeEach(() => {
    canvas = makeCanvas()
    glRef = { current: { domElement: canvas } as unknown as THREE.WebGLRenderer }
    pipelineRef = { current: null }
    onReady = vi.fn()
  })

  afterEach(() => {
    setLivePipeline(null)
  })

  it('resolves hover against the live pipeline ref after a hide/reveal, not the disposed one', () => {
    const layers = new Set([FACE_LAYER_NAME])

    // Cold mount: the driver mints + publishes pipeline A and onReady writes it
    // into pipelineRef. The body registers into A.
    const view = render(<Harness pipelineRef={pipelineRef} onReady={onReady} />)
    const A = getLivePipeline() as IdPipeline
    expect(A).not.toBeNull()
    expect(A.isDisposed()).toBe(false)
    expect(A.faceLayer.bodyCount()).toBe(1)
    // onReady fired with the cold pipeline and seeded the ref.
    expect(pipelineRef.current).toBe(A)
    expect(onReady).toHaveBeenCalledWith(A)

    const hitA = { id: 1, layer: FACE_LAYER_NAME, entityKey: 'f/face/0', distancePx: 0 }
    vi.spyOn(A, 'resolveAllSync').mockImplementation(() => [hitA])

    const beforeReveal = hoverThroughRef(glRef, pipelineRef, 32, 32, layers)
    expect(beforeReveal).toEqual([hitA])

    // The reveal: the Suspense boundary hides then re-shows the subtree, which
    // to the driver is a cleanup-then-setup cycle that mints a fresh pipeline.
    act(() => { view.unmount() })
    expect(A.isDisposed()).toBe(true)
    expect(getLivePipeline()).toBeNull()
    // Re-arming A's spy: if hover were still wired to the stale ref it would
    // call this after the reveal. It must not.
    vi.spyOn(A, 'resolveAllSync').mockImplementation(() => [])

    // Fresh mount: a new pipeline B is minted, published, and onReady re-fires
    // (the useEffect keyed on [pipeline]) to rewrite pipelineRef to B.
    const view2 = render(<Harness pipelineRef={pipelineRef} onReady={onReady} />)
    const B = getLivePipeline() as IdPipeline
    expect(B).not.toBe(A)
    expect(B.isDisposed()).toBe(false)
    expect(B.faceLayer.bodyCount()).toBe(1)
    // The onReady re-fire is what keeps the assembly ref live; pin it here.
    expect(pipelineRef.current).toBe(B)
    expect(onReady).toHaveBeenLastCalledWith(B)

    const hitB = { id: 2, layer: FACE_LAYER_NAME, entityKey: 'f/face/0', distancePx: 0 }
    vi.spyOn(B, 'resolveAllSync').mockImplementation(() => [hitB])

    // A real hover after the reveal resolves through pipelineRef.current.
    const afterReveal = hoverThroughRef(glRef, pipelineRef, 32, 32, layers)
    expect(afterReveal).toEqual([hitB])
    // Hover answered by the live pipeline, never the disposed pre-reveal one.
    expect(B.resolveAllSync).toHaveBeenCalled()
    expect(A.resolveAllSync).not.toHaveBeenCalled()

    view2.unmount()
  })
})
