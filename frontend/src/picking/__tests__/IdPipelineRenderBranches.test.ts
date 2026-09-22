// The IdPipeline branches the layering and async-ordering suites do not reach:
// resize delegation, the per-layer z-policy depth-clear switch, onBeforeRender
// threading, the inert-layer skip, resolveAllSync guarding on a dirty target,
// the sub-read buffer growth check, and a dispose racing a scheduled async read.
import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { IdPipeline, SKETCH_VERTEX_LAYER_NAME } from '../IdPipeline'
import type { FaceIdLayer } from '../FaceIdLayer'
import { IdImage } from './pickCanvasHarness'

function registerFace(layer: FaceIdLayer, key: string): void {
  layer.registerBody({
    bodyKey: key,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    triangleToFace: new Uint32Array([0]),
    faceQueries: ['face@q'],
  })
}

function countingRenderer(): {
  renderer: THREE.WebGLRenderer
  clearDepthCalls: () => number
  rendered: THREE.Scene[]
} {
  let clearDepthCalls = 0
  const rendered: THREE.Scene[] = []
  const renderer = {
    getRenderTarget: () => null,
    setRenderTarget: () => {},
    autoClear: true,
    getClearColor: () => {},
    getClearAlpha: () => 0,
    setClearColor: () => {},
    clear: () => {},
    clearDepth: () => { clearDepthCalls++ },
    render: (scene: THREE.Scene) => { rendered.push(scene) },
  } as unknown as THREE.WebGLRenderer
  return { renderer, clearDepthCalls: () => clearDepthCalls, rendered }
}

describe('IdPipeline.resize', () => {
  it('resizes the target and re-marks it dirty so the next pick re-renders', () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    p.target.markClean()
    expect(p.isDirty()).toBe(false)

    p.resize(48, 24)

    expect(p.target.getWidth()).toBe(48)
    expect(p.target.getHeight()).toBe(24)
    expect(p.isDirty()).toBe(true)
    p.dispose()
  })
})

describe('IdPipeline.render z-policy', () => {
  it('clears depth only for a later clear-then-fresh layer and a no-depth layer', () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    registerFace(p.faceLayer, 'face')
    p.vertexLayer.registerBody({ bodyKey: 'v', vertices: [[0, 0, 0]], vertexQueries: ['vtx@q'] })
    registerFace(p.sketchSurfaceLayer, 'surface')
    p.sketchEntityLayer.registerBody({
      bodyKey: 'e',
      segmentPositions: new Float32Array([0, 0, 0, 1, 0, 0]),
      segmentToEdge: new Uint32Array([0]),
      edgeQueries: ['entity@q'],
    })
    p.originLayer.registerBody({ bodyKey: 'o', vertices: [[0, 0, 0]], vertexQueries: ['origin@q'] })

    const { renderer, clearDepthCalls, rendered } = countingRenderer()
    p.markDirty()
    p.render(renderer, new THREE.Camera())

    // face is first (its clear-then-fresh needs no explicit clear); the vertex
    // and sketch surface layers reuse the depth; sketchEntity is a later
    // clear-then-fresh and origin is no-depth, so exactly two clears.
    expect(clearDepthCalls()).toBe(2)
    expect(rendered).toHaveLength(5)
    expect(p.isDirty()).toBe(false)
    p.dispose()
  })

  it('threads its pixel ratio and target size into each layer onBeforeRender', () => {
    const p = new IdPipeline({ width: 32, height: 32, pixelRatio: 2 })
    p.vertexLayer.registerBody({ bodyKey: 'v', vertices: [[0, 0, 0]], vertexQueries: ['vtx@q'] })

    const { renderer } = countingRenderer()
    p.markDirty()
    p.render(renderer, new THREE.Camera())

    const mat = (p.vertexLayer.scene.children[0] as THREE.Mesh).material as THREE.ShaderMaterial
    expect(mat.uniforms.uViewportHeight.value).toBe(32)
    // A 3px cube at DPR 2 becomes an odd 5 device px, half extent 2.5.
    expect(mat.uniforms.uHalfPixels.value).toBe(2.5)
    p.dispose()
  })

  it('skips a layer that declares itself inert', () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    registerFace(p.faceLayer, 'face')
    p.faceLayer.inertWhen = () => true

    const { renderer, rendered } = countingRenderer()
    p.markDirty()
    p.render(renderer, new THREE.Camera())

    expect(rendered).not.toContain(p.faceLayer.scene)
    p.dispose()
  })
})

describe('IdPipeline.resolveAllSync', () => {
  it('returns no candidates for a dirty target without touching the renderer', () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    const renderer = new Proxy({}, {
      get() { throw new Error('renderer must not be read from a dirty target') },
    }) as unknown as THREE.WebGLRenderer
    expect(p.resolveAllSync(renderer, { x: 1, y: 1 })).toEqual([])
    p.dispose()
  })

  it('returns the candidates for a clean target', () => {
    const image = new IdImage(32, 32)
    const p = new IdPipeline({ width: 32, height: 32 })
    p.target.markClean()
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
    image.mark(16, 16, id)

    const hits = p.resolveAllSync(image.renderer(), { x: 16.5, y: 16.5 })
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({ id, layer: SKETCH_VERTEX_LAYER_NAME, entityKey: 'v' })
    p.dispose()
  })
})

describe('IdPipeline.readWindow buffer growth', () => {
  it('grows the sub-read scratch when the configured window exceeds the default cap', () => {
    const SIZE = 200
    const image = new IdImage(SIZE, SIZE)
    const p = new IdPipeline({ width: SIZE, height: SIZE, windowSize: 400 })
    p.target.markClean()
    const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'v')
    image.mark(SIZE / 2, SIZE / 2, id)

    const renderer = image.renderer()
    const spy = vi.spyOn(renderer, 'readRenderTargetPixels')
    expect(p.resolveSync(renderer, { x: SIZE / 2 + 0.5, y: SIZE / 2 + 0.5 })).not.toBeNull()

    // The read covers the whole 200x200 target (160000 bytes), past the
    // pre-sized default scratch, so the output view's backing buffer grew.
    const out = spy.mock.calls[0][5] as Uint8Array
    expect(out.buffer.byteLength).toBe(SIZE * SIZE * 4)
    p.dispose()
  })
})

describe('IdPipeline.dispose race', () => {
  it('a read scheduled before dispose does not run after it', async () => {
    const p = new IdPipeline({ width: 32, height: 32 })
    let reads = 0
    p.resolveSync = (() => {
      reads++
      return { id: 1, layer: 'face', entityKey: 'k', distancePx: 0 }
    }) as unknown as typeof p.resolveSync

    const renderer = {} as unknown as THREE.WebGLRenderer
    const promise = p.resolveAsync(renderer, { x: 1, y: 1 })
    // Let the first microtask promote the query and schedule the deferred read.
    await Promise.resolve()
    p.dispose()

    await expect(promise).resolves.toBeNull()
    expect(reads).toBe(0)
  })
})
