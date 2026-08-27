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
      'sketchSurface', 'sketchEntity', 'sketchVertex', 'originMarker', 'dimensionLabel',
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
    expect(layers[6].zPolicy).toBe('no-depth')                  // sketchVertex
    expect(layers[7].zPolicy).toBe('no-depth')                  // originMarker
    expect(layers[8].zPolicy).toBe('no-depth')                  // dimensionLabel
    expect(layers[9].zPolicy).toBe('no-depth')                  // featureHandle
    expect(layers[10].zPolicy).toBe('no-depth')                 // gizmoHandle
    p.dispose()
  })

  it('addLayer keeps the array sorted by priority', () => {
    const p = new IdPipeline({ width: 100, height: 100 })
    expect(p.getLayers().map(l => l.priority)).toEqual([-10, 0, 10, 20, 30, 40, 50, 60, 70, 80, 90])
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

  it('resolveAsync on a disposed pipeline answers null', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    const renderer = {} as unknown as THREE.WebGLRenderer
    p.dispose()
    await expect(p.resolveAsync(renderer, { x: 1, y: 1 })).resolves.toBeNull()
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
  })
})
