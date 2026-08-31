import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { IdPipeline, DEFAULT_WINDOW_SIZE, SKETCH_VERTEX_LAYER_NAME, SKETCH_ENTITY_LAYER_NAME } from '../IdPipeline'
import { idToRGB } from '../idEncoding'

/**
 * The pick window is specified in CSS pixels but the ID target is a
 * drawing-buffer (device pixel) image, so the window has to be scaled by the
 * device pixel ratio at read time. Without that scale the catch radius is
 * 8/DPR CSS pixels: at DPR 2 it lands INSIDE the 5 px sketch-point dot, and a
 * vertex the user is aiming straight at stops answering while the fat sketch
 * entity band under it keeps winning.
 *
 * The helper vertex layers mark exactly one device pixel each, so for them the
 * window is not a tolerance around a footprint -- it is the entire catch
 * radius, which is why this is the layer the DPR error shows up on first.
 */

// Paint one pixel of the (device-pixel) ID image with `id`.
function paint(image: Uint8Array, width: number, x: number, y: number, id: number): void {
  const [r, g, b] = idToRGB(id)
  const i = (y * width + x) * 4
  image[i] = r
  image[i + 1] = g
  image[i + 2] = b
  image[i + 3] = 255
}

/**
 * A renderer that serves `image` (a full-target RGBA buffer in render-target
 * coordinates, y up from the bottom) to readRenderTargetPixels, recording the
 * window size it was asked for.
 */
function makeReadingRenderer(image: Uint8Array, width: number) {
  const reads: { x: number; y: number; w: number; h: number }[] = []
  const renderer = {
    readRenderTargetPixels: (
      _t: unknown, x: number, y: number, w: number, h: number, out: Uint8Array,
    ) => {
      reads.push({ x, y, w, h })
      for (let row = 0; row < h; row++) {
        const src = ((y + row) * width + x) * 4
        out.set(image.subarray(src, src + w * 4), row * w * 4)
      }
    },
  } as unknown as THREE.WebGLRenderer
  return { renderer, reads }
}

describe('pick window scales with the device pixel ratio', () => {
  it('defaults to a 1:1 ratio, reading the CSS window verbatim', () => {
    const p = new IdPipeline({ width: 64, height: 64 })
    expect(p.getPixelRatio()).toBe(1)
    expect(p.getWindowSize()).toBe(DEFAULT_WINDOW_SIZE)
    expect(p.getEffectiveWindowSize()).toBe(DEFAULT_WINDOW_SIZE)
    p.dispose()
  })

  it('scales the read window by the ratio, keeping it odd so the cursor owns the centre pixel', () => {
    const p = new IdPipeline({ width: 64, height: 64 })
    // The 8 CSS px radius scales, then the odd edge is rebuilt from it.
    for (const [ratio, expected] of [[1, 17], [1.5, 25], [2, 33], [3, 49]] as const) {
      p.setPixelRatio(ratio)
      const size = p.getEffectiveWindowSize()
      expect(size).toBe(expected)
      expect(size % 2).toBe(1)
    }
    p.dispose()
  })

  it('rejects a non-finite or non-positive ratio and clamps an absurd one', () => {
    const p = new IdPipeline({ width: 64, height: 64 })
    for (const bad of [0, -2, NaN, Infinity]) {
      p.setPixelRatio(bad)
      expect(p.getPixelRatio()).toBe(1)
    }
    p.setPixelRatio(1000)
    expect(p.getPixelRatio()).toBe(8)
    p.dispose()
  })

  it('never scales the window BELOW the flat window it replaced', () => {
    // Under 100% browser zoom the ratio drops below 1. Honouring that literally
    // would read fewer device pixels than the window used to be before it
    // scaled at all, turning a HiDPI fix into a regression for anyone zoomed
    // out -- the same sub-1 ratio the rubber band already contends with.
    const p = new IdPipeline({ width: 64, height: 64 })
    for (const zoomedOut of [0.9, 0.8, 0.5, 0.25]) {
      p.setPixelRatio(zoomedOut)
      expect(p.getPixelRatio()).toBe(1)
      expect(p.getEffectiveWindowSize()).toBe(DEFAULT_WINDOW_SIZE)
    }
    p.dispose()
  })

  it('a non-finite window size falls back instead of poisoning the read', () => {
    // NaN survives every downstream check (`NaN <= 0` and `length < NaN` are
    // both false), so the resolver would answer an empty window rather than
    // failing. Guarded at the same seam the ratio is.
    const p = new IdPipeline({ width: 64, height: 64 })
    expect(p.getEffectiveWindowSize(NaN)).toBe(DEFAULT_WINDOW_SIZE)
    expect(p.getEffectiveWindowSize(Infinity)).toBe(DEFAULT_WINDOW_SIZE)
    p.dispose()
  })

  it('holds the CSS reach at 8 px in every direction once scaled', () => {
    // Ties the two halves together: the disc cutoff is measured in device
    // pixels, so only this says the RADIUS it enforces is a constant on-screen
    // distance. Without it a change to the scale's rounding could make the CSS
    // reach direction-dependent again with both suites still green.
    const p = new IdPipeline({ width: 512, height: 512 })
    for (const ratio of [1, 2, 3]) {
      p.setPixelRatio(ratio)
      const size = p.getEffectiveWindowSize()
      const deviceRadius = (size - 1) / 2
      expect(deviceRadius / ratio).toBe(8)
    }
    p.dispose()
  })

  it('an explicit CSS window size goes through the same scale', () => {
    const p = new IdPipeline({ width: 64, height: 64, windowSize: 9, pixelRatio: 2 })
    expect(p.getWindowSize()).toBe(9)
    expect(p.getEffectiveWindowSize()).toBe(17)   // 4 px radius * 2
    expect(p.getEffectiveWindowSize(5)).toBe(9)   // 2 px radius * 2
    p.dispose()
  })

  it('keeps a sketch vertex reachable at the same CSS distance on a 2x display', () => {
    // A 2x canvas: 128 device px wide for 64 CSS px. The cursor sits at CSS
    // (32, 32) -> device (64, 64); the sketch vertex is 6 CSS px away, i.e. 12
    // device px, well inside the 8 CSS px the user aims with and well outside
    // an unscaled 17-device-pixel window.
    const size = 128
    const p = new IdPipeline({ width: size, height: size, pixelRatio: 2 })
    const vertexId = p.registry.allocate(SKETCH_VERTEX_LAYER_NAME, 'vertex:S1:P1:xy')
    const entityId = p.registry.allocate(SKETCH_ENTITY_LAYER_NAME, 'entity:S1:L1')

    const image = new Uint8Array(size * size * 4)
    // Render-target coordinates are y-up: canvas y 64 is target row 63.
    paint(image, size, 64, 63, entityId)          // the line under the cursor
    paint(image, size, 64 + 12, 63, vertexId)     // the point, 12 device px away

    const { renderer, reads } = makeReadingRenderer(image, size)
    p.target.markClean()

    const hit = p.resolveSync(renderer, { x: 64, y: 64 })
    expect(reads[0].w).toBe(33)  // 8 CSS px radius * 2, rebuilt odd
    expect(hit?.layer).toBe(SKETCH_VERTEX_LAYER_NAME)
    expect(hit?.entityKey).toBe('vertex:S1:P1:xy')

    // The same buffer at ratio 1 is the regression: the window is 17 device px,
    // the vertex falls outside it, and the line answers instead.
    p.setPixelRatio(1)
    const unscaled = p.resolveSync(renderer, { x: 64, y: 64 })
    expect(unscaled?.layer).toBe(SKETCH_ENTITY_LAYER_NAME)
    p.dispose()
  })
})
