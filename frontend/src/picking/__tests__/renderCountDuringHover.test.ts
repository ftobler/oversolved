import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { IdPipeline } from '../IdPipeline'

/**
 * Per id-buffer-perf.md acceptance:
 *   "simulate 100 pointermove events without camera movement.
 *    Assert ID buffer render count == 1."
 *
 * The driver's useFrame loop calls renderIfDirty() per frame; the pipeline
 * is dirty exactly once at startup, so the first frame paints and every
 * subsequent frame is a no-op until something invalidates. Hover queries
 * (resolveAsync) read the buffer but never dirty it. This test mirrors
 * that loop at API level without spinning up R3F.
 */
describe('renderCountDuringHover', () => {
  it('renders exactly once across 100 hover queries when nothing dirties', async () => {
    const p = new IdPipeline({ width: 64, height: 64 })
    const renderer = makeFakeRenderer()
    const camera = {} as unknown as THREE.Camera

    // Stub resolveSync so resolveAsync's fallback path doesn't try to
    // touch a real GL context.
    p.resolveSync = (() => null) as unknown as typeof p.resolveSync

    // Initial paint (the pipeline starts dirty).
    p.renderIfDirty(renderer, camera)
    expect(p.getRenderCount()).toBe(1)

    // 100 pointermove ticks: each fires an async hover query, then a
    // useFrame tick attempts to renderIfDirty. Camera doesn't move and
    // nothing else marks dirty, so the render count must not budge.
    for (let i = 0; i < 100; i++) {
      void p.resolveAsync(renderer, { x: i % 64, y: i % 64 })
      p.renderIfDirty(renderer, camera)
    }

    await new Promise(r => setTimeout(r, 0))
    expect(p.getRenderCount()).toBe(1)
    p.dispose()
  })

  it('one camera-equivalent dirty produces exactly one additional render', () => {
    const p = new IdPipeline({ width: 64, height: 64 })
    const renderer = makeFakeRenderer()
    const camera = {} as unknown as THREE.Camera

    p.renderIfDirty(renderer, camera)
    expect(p.getRenderCount()).toBe(1)

    p.markDirty('camera')
    p.renderIfDirty(renderer, camera)
    p.renderIfDirty(renderer, camera)
    p.renderIfDirty(renderer, camera)
    expect(p.getRenderCount()).toBe(2)
    p.dispose()
  })
})

function makeFakeRenderer(): THREE.WebGLRenderer {
  const fake = {
    getRenderTarget: () => null,
    setRenderTarget: () => undefined,
    getClearColor: (_c: THREE.Color) => undefined,
    getClearAlpha: () => 1,
    setClearColor: () => undefined,
    clear: () => undefined,
    clearDepth: () => undefined,
    render: () => undefined,
    autoClear: true,
    readRenderTargetPixels: () => undefined,
  }
  return fake as unknown as THREE.WebGLRenderer
}
