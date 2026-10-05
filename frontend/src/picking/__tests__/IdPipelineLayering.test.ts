import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { IdPipeline } from '../IdPipeline'
import { FACE_LAYER_NAME } from '../FaceIdLayer'
import { EDGE_LAYER_NAME } from '../EdgeIdLayer'
import { VERTEX_LAYER_NAME } from '../VertexIdLayer'

describe('IdPipeline layering', () => {
  it('mounts B-rep + helper layers in priority order', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    expect(layers.map(l => l.name)).toEqual([
      'planeFace',
      FACE_LAYER_NAME, EDGE_LAYER_NAME, VERTEX_LAYER_NAME,
      'sketchSurface', 'sketchEntity', 'originMarker', 'sketchVertex', 'dimensionLabel',
      'featureHandle', 'gizmoHandle',
    ])
    p.dispose()
  })

  it('declares the documented z-policy on each layer', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    const layers = p.getLayers()
    expect(layers[0].zPolicy).toBe('clear-then-fresh')  // planeFace (behind)
    expect(layers[1].zPolicy).toBe('clear-then-fresh')         // face
    expect(layers[2].zPolicy).toBe('depth-test-against-prev')  // edge: reuse face depth
    expect(layers[3].zPolicy).toBe('depth-test-against-prev')   // vertex: preserves face depth for sketch surface
    expect(layers[4].zPolicy).toBe('depth-test-against-prev')   // sketchSurface: occluded by real B-rep depth
    expect(layers[5].zPolicy).toBe('clear-then-fresh')          // sketchEntity
    expect(layers[6].zPolicy).toBe('no-depth')                  // originMarker
    expect(layers[7].zPolicy).toBe('no-depth')                  // sketchVertex
    expect(layers[8].zPolicy).toBe('no-depth')                  // dimensionLabel
    expect(layers[9].zPolicy).toBe('no-depth')                  // featureHandle
    expect(layers[10].zPolicy).toBe('no-depth')                 // gizmoHandle
    p.dispose()
  })

  it('addLayer keeps the array sorted by priority', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    // originMarker at 45, between sketchEntity and sketchVertex: it must beat
    // the plane and the sketch curves it sits on, and lose to a sketch point
    // that shares its position. See the note at its construction.
    expect(p.getLayers().map(l => l.priority)).toEqual([-10, 0, 10, 20, 30, 40, 45, 50, 70, 80, 90])
    p.dispose()
  })

  it('dispose tears down every layer', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    p.dispose()
    expect(p.faceLayer.bodyCount()).toBe(0)
    expect(p.edgeLayer.bodyCount()).toBe(0)
    expect(p.vertexLayer.bodyCount()).toBe(0)
    expect(p.planeLayer.bodyCount()).toBe(0)
    expect(p.sketchSurfaceLayer.bodyCount()).toBe(0)
    expect(p.sketchEntityLayer.bodyCount()).toBe(0)
    expect(p.sketchVertexLayer.bodyCount()).toBe(0)
    expect(p.originLayer.bodyCount()).toBe(0)
    expect(p.dimensionLabelLayer.bodyCount()).toBe(0)
    expect(p.featureHandleLayer.bodyCount()).toBe(0)
    expect(p.gizmoHandleLayer.bodyCount()).toBe(0)
  })

  // Minimal stand-in: only the surface render() touches. The viewport/scissor
  // API is deliberately absent so those restore paths are skipped.
  function fakeRenderer(failScene: THREE.Scene | null): THREE.WebGLRenderer {
    return {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      autoClear: true,
      getClearColor: () => {},
      getClearAlpha: () => 0,
      setClearColor: () => {},
      clear: () => {},
      clearDepth: () => {},
      render: (scene: THREE.Scene) => {
        if (scene === failScene) throw new Error('layer render exploded')
      },
    } as unknown as THREE.WebGLRenderer
  }

  function registerOneFace(p: IdPipeline, bodyKey: string): void {
    p.faceLayer.registerBody({
      bodyKey,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      triangleToFace: new Uint32Array([0]),
      faceQueries: ['face@q'],
    })
  }

  // A renderer that fails the given scene and counts clearDepth calls, so the
  // depth-clear decision for later layers can be asserted after a throw.
  function countingRenderer(failScene: THREE.Scene | null): {
    renderer: THREE.WebGLRenderer
    clearDepthCalls: () => number
  } {
    let clearDepthCalls = 0
    const renderer = {
      getRenderTarget: () => null,
      setRenderTarget: () => {},
      autoClear: true,
      getClearColor: () => {},
      getClearAlpha: () => 0,
      setClearColor: () => {},
      clear: () => {},
      clearDepth: () => { clearDepthCalls++ },
      render: (scene: THREE.Scene) => {
        if (scene === failScene) throw new Error('layer render exploded')
      },
    } as unknown as THREE.WebGLRenderer
    return { renderer, clearDepthCalls: () => clearDepthCalls }
  }

  it('resolveAsync on a disposed pipeline answers null', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    const renderer = {} as unknown as THREE.WebGLRenderer
    p.dispose()
    await expect(p.resolveAsync(renderer, { x: 1, y: 1 })).resolves.toBeNull()
  })

  it('resolveSync on a disposed pipeline returns null without touching the target', () => {
    // Precondition: a CLEAN target (a fresh one starts dirty, which would make
    // readWindow bail regardless of dispose). Render once so it is clean, then
    // dispose: the dispose() markDirty is what re-blocks readWindow before it
    // calls readRenderTargetPixels on the torn-down target.
    const p = new IdPipeline({ width: 32, height: 32 })
    registerOneFace(p, 'b1')
    p.markDirty()
    p.render(fakeRenderer(null), new THREE.Camera())
    expect(p.isDirty()).toBe(false)

    p.dispose()
    let touched = false
    const renderer = new Proxy({}, {
      get() { touched = true; return () => undefined },
    }) as unknown as THREE.WebGLRenderer
    expect(p.resolveSync(renderer, { x: 1, y: 1 })).toBeNull()
    // Without the dispose() markDirty the clean target lets readWindow through
    // to readRenderTargetPixels on the torn-down target: touched flips true.
    expect(touched).toBe(false)
    expect(p.isDirty()).toBe(true)
  })

  describe('layer render failure', () => {
    it('leaves the buffer dirty and warns with the failing layer name', () => {
      const p = new IdPipeline({ width: 32, height: 32 })
      registerOneFace(p, 'b1')
      p.markDirty()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        p.render(fakeRenderer(p.faceLayer.scene), new THREE.Camera())
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(FACE_LAYER_NAME), expect.anything())
        // Amputated buffer must not be treated as complete: stays dirty so
        // the next frame retries instead of resolving from partial pixels.
        expect(p.isDirty()).toBe(true)
      } finally {
        warn.mockRestore()
        p.dispose()
      }
    })

    it('marks clean again once a render completes without failures', () => {
      const p = new IdPipeline({ width: 32, height: 32 })
      registerOneFace(p, 'b1')
      p.markDirty()
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try {
        p.render(fakeRenderer(null), new THREE.Camera())
        expect(warn).not.toHaveBeenCalled()
        expect(p.isDirty()).toBe(false)
      } finally {
        warn.mockRestore()
        p.dispose()
      }
    })

    // H1: a layer that fails every frame must not disable all picking forever.
    it('latches the layer out after two consecutive failures and marks the buffer clean', () => {
      const p = new IdPipeline({ width: 32, height: 32 })
      registerOneFace(p, 'b1')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const camera = new THREE.Camera()
      try {
        // First failure: today's behaviour, buffer stays dirty for a retry.
        p.markDirty()
        p.render(fakeRenderer(p.faceLayer.scene), camera)
        expect(p.isDirty()).toBe(true)

        // Second consecutive failure: the layer latches out and the buffer is
        // allowed to go clean without it.
        p.markDirty()
        p.render(fakeRenderer(p.faceLayer.scene), camera)
        expect(p.isDirty()).toBe(false)
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('latched out'), expect.any(Error))

        // Subsequent renders skip the layer entirely: no more warns, and a
        // renderer that would throw on that scene is never handed it.
        warn.mockClear()
        const failingAgain = fakeRenderer(p.faceLayer.scene)
        p.markDirty()
        expect(() => p.render(failingAgain, camera)).not.toThrow()
        expect(p.isDirty()).toBe(false)
        expect(warn).not.toHaveBeenCalled()
      } finally {
        warn.mockRestore()
        p.dispose()
      }
    })

    it('a successful render resets the consecutive-failure count', () => {
      const p = new IdPipeline({ width: 32, height: 32 })
      registerOneFace(p, 'b1')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const camera = new THREE.Camera()
      try {
        p.markDirty()
        p.render(fakeRenderer(p.faceLayer.scene), camera)  // failure 1
        p.markDirty()
        p.render(fakeRenderer(null), camera)  // success resets
        expect(p.isDirty()).toBe(false)

        // A fresh failure is once again just failure 1: buffer stays dirty, no
        // latch.
        p.markDirty()
        p.render(fakeRenderer(p.faceLayer.scene), camera)
        expect(p.isDirty()).toBe(true)
        expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('latched out'))
      } finally {
        warn.mockRestore()
        p.dispose()
      }
    })

    // L4: a throw mid-render must not leave firstLayer stale, or the next
    // clear-then-fresh layer skips its depth clear and depth-tests against the
    // failed layer's partial buffer.
    it('the next clear-then-fresh layer still clears depth after a throwing first layer', () => {
      const p = new IdPipeline({ width: 32, height: 32 })
      registerOneFace(p, 'b1')  // faceLayer, clear-then-fresh, rendered first
      p.sketchEntityLayer.registerBody({
        bodyKey: 'sk1',
        segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
        segmentToEdge: new Uint32Array([0]),
        edgeQueries: ['entity@q'],
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { renderer, clearDepthCalls } = countingRenderer(p.faceLayer.scene)
      try {
        p.markDirty()
        p.render(renderer, new THREE.Camera())
        // sketchEntity is the next clear-then-fresh layer with content; it must
        // have issued its own clearDepth because the throwing face layer no
        // longer holds firstLayer true.
        expect(clearDepthCalls()).toBe(1)
      } finally {
        warn.mockRestore()
        p.dispose()
      }
    })
  })
})
