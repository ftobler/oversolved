import { describe, it, expect, vi } from 'vitest'
import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IdPipeline, SKETCH_VERTEX_LAYER_NAME } from '../IdPipeline'
import { FaceIdLayer } from '../FaceIdLayer'
import { IdImage } from './pickCanvasHarness'

/**
 * Wave 9: the hover hot path allocates once, not per frame. These pin the two
 * observable halves of that -- the cached layer-priority map handed to the
 * resolver, and the reused sub-read buffer inside readWindow -- plus a guard
 * that the four dead pick-size constants stay deleted.
 */

const SIZE = 64
const CURSOR = { x: 32.5, y: 32.5 }

function pipelineWithMark(key = 'v') {
  const image = new IdImage(SIZE, SIZE)
  const p = new IdPipeline({ width: SIZE, height: SIZE })
  p.target.markClean()
  const id = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, key)
  image.mark(32, 32, id)
  return { image, p }
}

describe('IdPipeline hot-path allocation', () => {
  it('hands the resolver one cached layer-priority object across resolves', () => {
    const { image, p } = pipelineWithMark()
    const decode = vi.spyOn(p.resolver, 'decode')
    const renderer = image.renderer()

    expect(p.resolveSync(renderer, CURSOR)).not.toBeNull()
    expect(p.resolveSync(renderer, CURSOR)).not.toBeNull()

    const first = decode.mock.calls[0][2]!.layerPriority
    const second = decode.mock.calls[1][2]!.layerPriority
    // Same object across resolves, and it is the pipeline's own cached map.
    expect(first).toBe(second)
    expect(first).toBe(p.getLayerPriority())
    p.dispose()
  })

  it('rebuilds the priority map only when a layer is added', () => {
    const p = new IdPipeline({ width: SIZE, height: SIZE })
    const before = p.getLayerPriority()
    expect(p.getLayerPriority()).toBe(before)  // repeat calls hit the cache
    const throwaway = new FaceIdLayer(p.registry, { name: 'throwaway', priority: 999 })
    p.addLayer(throwaway)  // any addLayer must drop the cache
    expect(p.getLayerPriority()).not.toBe(before)
    expect(p.getLayerPriority().throwaway).toBe(999)
    throwaway.dispose()
    p.dispose()
  })

  it('reuses one sub-read buffer instead of minting a Uint8Array per read', () => {
    const { image, p } = pipelineWithMark()
    const renderer = image.renderer()
    const spy = vi.spyOn(renderer, 'readRenderTargetPixels')

    expect(p.resolveSync(renderer, CURSOR)).not.toBeNull()
    p.resolveSync(renderer, { x: 20.5, y: 44.5 })

    expect(spy).toHaveBeenCalledTimes(2)
    const out0 = spy.mock.calls[0][5] as Uint8Array
    const out1 = spy.mock.calls[1][5] as Uint8Array
    // Two views over the same backing buffer: no fresh allocation on the second
    // read. The backing buffer is the pre-sized scratch, larger than the view.
    expect(out1.buffer).toBe(out0.buffer)
    expect(out0.buffer.byteLength).toBeGreaterThan(out0.byteLength)
    p.dispose()
  })

  it('resolves null when readRenderTargetPixels leaves the buffer untouched, even after a prior hit', () => {
    const { image, p } = pipelineWithMark()
    // A real read first, so the reused scratch holds a live entity's pixels.
    expect(p.resolveSync(image.renderer(), CURSOR)).not.toBeNull()
    // Now the framebuffer-absent / context-loss path: the read is a no-op. The
    // scratch must be re-zeroed each call, or the stale pixels decode a phantom.
    const noop = { readRenderTargetPixels: () => {} } as unknown as THREE.WebGLRenderer
    expect(p.resolveSync(noop, CURSOR)).toBeNull()
    p.dispose()
  })

  it('keeps the four dead pick-size constants deleted from the module and barrel', () => {
    const dead = [
      'SKETCH_ENTITY_FAT_PIXELS', 'SKETCH_VERTEX_FAT_PIXELS',
      'ORIGIN_FAT_PIXELS', 'DIMENSION_LABEL_FAT_PIXELS',
    ]
    for (const file of ['IdPipeline.ts', 'index.ts']) {
      const src = readFileSync(join(__dirname, '..', file), 'utf8')
      for (const name of dead) expect([file, src.includes(name)]).toEqual([file, false])
    }
  })
})
