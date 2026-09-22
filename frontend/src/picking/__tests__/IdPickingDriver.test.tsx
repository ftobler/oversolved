import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, act } from '@testing-library/react'
import * as THREE from 'three'

// Capture the frame callback and let the mocked useThree expose a renderer and
// size the test controls. The driver's whole job is this per-frame body, so the
// R3F seam has to be mocked to reach it without a Canvas.
const r3f = vi.hoisted(() => ({
  gl: null as unknown,
  size: { width: 800, height: 600 },
  frame: null as ((state: { camera: THREE.Camera }) => void) | null,
}))

vi.mock('@react-three/fiber', () => ({
  useThree: () => ({ gl: r3f.gl, size: r3f.size }),
  useFrame: (cb: (state: { camera: THREE.Camera }) => void) => { r3f.frame = cb },
}))

import IdPickingDriver from '../IdPickingDriver'
import { getLivePipeline, setLivePipeline } from '../IdPipelineContext'

function fakeGl(withDrawingBuffer: boolean): THREE.WebGLRenderer {
  const gl: Record<string, unknown> = {
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
    domElement: document.createElement('canvas'),
  }
  if (withDrawingBuffer) {
    gl.getDrawingBufferSize = (v: THREE.Vector2) => v.set(800, 600)
  }
  return gl as unknown as THREE.WebGLRenderer
}

function orthoCamera(): THREE.OrthographicCamera {
  const cam = new THREE.OrthographicCamera(-100, 100, 100, -100, -1000, 1000)
  cam.position.set(0, 0, 100)
  cam.updateMatrixWorld(true)
  cam.updateProjectionMatrix()
  return cam
}

describe('IdPickingDriver frame loop', () => {
  afterEach(() => { setLivePipeline(null) })

  // An OrbitControls wheel-zoom on an orthographic camera scales only the
  // projection matrix; a world-matrix-only snapshot missed it and left the ID
  // buffer stale. This pins that a projection-only change dirties and repaints,
  // and that an unchanged camera does not.
  it('an orthographic dolly marks the pipeline dirty and repaints exactly once', () => {
    r3f.gl = fakeGl(true)
    r3f.size = { width: 800, height: 600 }
    const camera = orthoCamera()
    render(<IdPickingDriver />)
    const pipeline = getLivePipeline()!
    expect(pipeline).not.toBeNull()

    act(() => { r3f.frame!({ camera }) })
    const afterFirst = pipeline.getRenderCount()
    expect(afterFirst).toBe(1)

    act(() => {
      camera.zoom = 2
      camera.updateProjectionMatrix()
      r3f.frame!({ camera })
    })
    expect(pipeline.getRenderCount()).toBe(afterFirst + 1)

    // The pose is now recorded: a frame with no camera movement must not repaint.
    act(() => { r3f.frame!({ camera }) })
    expect(pipeline.getRenderCount()).toBe(afterFirst + 1)
  })

  it('falls back to the CSS size when the renderer has no drawing-buffer query', () => {
    r3f.gl = fakeGl(false)
    r3f.size = { width: 640, height: 480 }
    render(<IdPickingDriver />)
    const pipeline = getLivePipeline()!

    expect(pipeline.target.getWidth()).toBe(640)
    expect(pipeline.target.getHeight()).toBe(480)
  })

  it('clamps an unmeasured (zero) canvas size to a 1x1 target', () => {
    // R3F reports 0 before the canvas has measured; a zero-size WebGLRenderTarget
    // is invalid, so the fallback must floor at one pixel.
    r3f.gl = fakeGl(false)
    r3f.size = { width: 0, height: 0 }
    render(<IdPickingDriver />)
    const pipeline = getLivePipeline()!

    expect(pipeline.target.getWidth()).toBe(1)
    expect(pipeline.target.getHeight()).toBe(1)
  })
})
